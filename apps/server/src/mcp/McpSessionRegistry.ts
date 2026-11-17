import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /** False omits the preview capability wherever the token is honored. Defaults to full access. */
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly subagent?: boolean;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpNativeRuntimeBinding {
  readonly providerSessionId: string;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeId: string;
}

export interface McpSessionRegistryShape {
  readonly bindNativeRuntime: (identity: McpNativeRuntimeBinding) => Effect.Effect<void>;
  readonly resolveNativeRuntime: (
    providerSessionId: string,
  ) => Effect.Effect<McpNativeRuntimeBinding | undefined>;
  readonly onRevoke: (
    listener: (providerSessionId: string) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface AliveMark {
  readonly wallMs: number;
  readonly monotonicMs: number;
}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly lastAlive: AliveMark;
  /** Set when a request finds the token idle; only `touch` clears it, whatever the clocks do. */
  readonly expired: boolean;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  /** Drives both the wall and monotonic readings. */
  readonly now?: () => number;
}

/**
 * `/mcp` is outside environment auth, so idle tokens stop authenticating.
 * Keep expired records until explicit revocation: a trusted provider turn can
 * refresh the token its subprocess still holds; MCP requests cannot.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

// The larger elapsed reading wins: stepping the wall clock back cannot extend a token,
// and wall time that passes while the host sleeps still counts.
const idleMs = (since: AliveMark, now: AliveMark): number =>
  Math.max(now.wallMs - since.wallMs, now.monotonicMs - since.monotonicMs);

const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const pendingBindings = new Map<string, symbol>();
  const nativeRuntimes = new Map<string, McpNativeRuntimeBinding>();
  const revokeListeners = new Set<(providerSessionId: string) => Effect.Effect<void>>();
  const { now } = options;
  const currentAliveMark: Effect.Effect<AliveMark> = now
    ? Effect.sync(() => {
        const timestamp = now();
        return { wallMs: timestamp, monotonicMs: timestamp };
      })
    : Effect.all({
        wallMs: Clock.currentTimeMillis,
        monotonicMs: Clock.monotonicTimeNanos.pipe(
          Effect.map((nanos) => Number(nanos / 1_000_000n)),
        ),
      });
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAlive = yield* currentAliveMark;
      const providerSessionId = yield* random.uuidV4();
      const rawToken = yield* random.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const browserToolsAvailable = request.browserToolsAvailable ?? true;
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: providerSessionId,
        thread: {
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
          subagent: request.subagent === true,
        },
        client: undefined,
        capabilities: new Set<McpInvocationContext.McpCapability>([
          "orchestration",
          "worktree",
          "pull-requests",
          "terminal",
          "issues",
          ...(request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : [])),
        ]),
        issuedAt: issuedAlive.wallMs,
      };
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        next.set(tokenHash, { tokenHash, scope, lastAlive: issuedAlive, expired: false });
        return { records: next };
      });
      return {
        config: {
          environmentId,
          threadId: scope.thread.threadId,
          providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint,
          catalogEndpoint: `${endpoint}/catalog/${providerSessionId}`,
          authorizationHeader: `Bearer ${rawToken}`,
          browserToolsAvailable: scope.capabilities.has("preview"),
          capabilities: scope.capabilities,
        },
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const alive = yield* currentAliveMark;
      return yield* SynchronizedRef.modify(state, ({ records }) => {
        const record = records.get(tokenHash);
        if (!record || record.expired) return [undefined, { records }] as const;
        if (idleMs(record.lastAlive, alive) > livenessWindowMs) {
          const next = new Map(records);
          next.set(tokenHash, { ...record, expired: true });
          return [undefined, { records: next }] as const;
        }
        const next = new Map(records);
        next.set(tokenHash, { ...record, lastAlive: alive });
        return [record.scope, { records: next }] as const;
      });
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const alive = yield* currentAliveMark;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        for (const [tokenHash, record] of records) {
          if (record.scope.thread.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAlive: alive, expired: false });
          }
        }
        return { records: next };
      });
    },
  );

  const revokeWhere = Effect.fn("McpSessionRegistry.revokeWhere")(function* (
    predicate: (record: CredentialRecord) => boolean,
  ) {
    const revoked = yield* SynchronizedRef.modify(state, ({ records }) => {
      const identities = [...records.values()]
        .filter(predicate)
        .map((record) => record.scope.thread.providerSessionId);
      return [
        identities,
        { records: new Map([...records].filter(([, record]) => !predicate(record))) },
      ] as const;
    });
    for (const identity of revoked) {
      nativeRuntimes.delete(identity);
      pendingBindings.delete(identity);
    }
    for (const identity of revoked)
      for (const listener of revokeListeners) yield* listener(identity);
  });

  return McpSessionRegistry.of({
    bindNativeRuntime: Effect.fn("McpSessionRegistry.bindNativeRuntime")(function* (binding) {
      const records = (yield* SynchronizedRef.get(state)).records;
      const record = [...records.values()].find(
        (candidate) => candidate.scope.thread.providerSessionId === binding.providerSessionId,
      );
      if (
        !record ||
        record.scope.thread.threadId !== binding.threadId ||
        record.scope.thread.providerInstanceId !== binding.providerInstanceId
      )
        return;
      const attempt = Symbol();
      pendingBindings.set(binding.providerSessionId, attempt);
      try {
        const previous = nativeRuntimes.get(binding.providerSessionId);
        if (previous && previous.runtimeId !== binding.runtimeId) {
          nativeRuntimes.delete(binding.providerSessionId);
          for (const listener of revokeListeners) yield* listener(binding.providerSessionId);
        }
        const current = (yield* SynchronizedRef.get(state)).records;
        if (
          pendingBindings.get(binding.providerSessionId) !== attempt ||
          ![...current.values()].some(
            (candidate) => candidate.scope.thread.providerSessionId === binding.providerSessionId,
          )
        )
          return;
        nativeRuntimes.set(binding.providerSessionId, binding);
      } finally {
        if (pendingBindings.get(binding.providerSessionId) === attempt)
          pendingBindings.delete(binding.providerSessionId);
      }
    }),
    resolveNativeRuntime: Effect.fn("McpSessionRegistry.resolveNativeRuntime")((identity) =>
      Effect.sync(() => nativeRuntimes.get(identity)),
    ),
    onRevoke: Effect.fn("McpSessionRegistry.onRevoke")((listener) =>
      Effect.sync(() => {
        revokeListeners.add(listener);
        return () => {
          revokeListeners.delete(listener);
        };
      }),
    ),
    issue,
    resolve,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.thread.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.thread.threadId === threadId);
    }),
    revokeAll: revokeWhere(() => true),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const __testing = {
  make: makeWithOptions,
};
