import {
  ProviderInstanceId,
  ThreadId,
  type McpServerId,
  type ResolvedProjectMcpServer,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as ProjectMcpProxyRegistry from "./ProjectMcpProxyRegistry.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly projectMcpServers?: ReadonlyArray<ResolvedProjectMcpServer>;
  readonly resolveProjectMcpSecret?: (
    serverId: McpServerId,
    credentialId: string,
  ) => string | undefined;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  /**
   * Records a sign of life for every credential bound to `threadId`. Provider
   * turns call this so that a session which is plainly alive keeps its
   * credential even when it goes a long time without touching an MCP tool.
   */
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly lastAliveAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * How long a credential outlives the last sign of life from its provider
 * session.
 *
 * Liveness is refreshed both by MCP traffic and by `touch` on every provider
 * turn, so a session that is still doing work never expires no matter how long
 * it goes between browser tool calls. This window therefore only bounds
 * credentials whose session died without a clean stop — the normal paths
 * (`stopSession`, `stopAll`) revoke eagerly and do not wait for it.
 *
 * The bound matters because `/mcp` is mounted outside the environment auth
 * stack and is reachable on whatever host the server binds to, so this token is
 * the only thing guarding the preview toolkit on a remote-reachable server.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
};

export const getMcpEndpoint = (httpServer: HttpServer.HttpServer["Service"]): string =>
  httpServer.address._tag === "TcpAddress"
    ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const projectProxy = yield* Effect.serviceOption(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry);
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const expiryFibers = new Map<string, Fiber.Fiber<void, never>>();
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint = getMcpEndpoint(httpServer);

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneDead = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(
      Array.from(records).filter(
        ([, record]) => timestamp - record.lastAliveAt <= livenessWindowMs,
      ),
    );
    return next.size === records.size ? records : next;
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const projectEndpoints =
        request.projectMcpServers &&
        request.projectMcpServers.length > 0 &&
        projectProxy._tag === "Some"
          ? yield* projectProxy.value.registerSession({
              providerSessionId,
              threadId: request.threadId,
              servers: request.projectMcpServers,
              ...(request.resolveProjectMcpSecret === undefined
                ? {}
                : { resolveSecret: request.resolveProjectMcpSecret }),
            })
          : [];
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        threadId: ThreadId.make(request.threadId),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        capabilities: new Set<McpInvocationContext.McpCapability>([
          "preview",
          ...(projectEndpoints.length > 0 ? ["project" as const] : []),
        ]),
        issuedAt,
      };
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(pruneDead(records, issuedAt));
        next.set(tokenHash, { tokenHash, scope, lastAliveAt: issuedAt });
        return { records: next };
      });
      yield* scheduleExpiry(providerSessionId);
      return {
        config: {
          environmentId,
          threadId: scope.threadId,
          providerSessionId,
          providerInstanceId: scope.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          ...(projectEndpoints.length > 0
            ? {
                projectServers: projectEndpoints.map((projectEndpoint) => ({
                  id: projectEndpoint.id,
                  name: projectEndpoint.name,
                  endpoint: projectEndpoint.endpoint,
                  authorizationHeader: `Bearer ${rawToken}`,
                })),
              }
            : {}),
        },
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      const resolved = yield* SynchronizedRef.modify(
        state,
        ({
          records,
        }): readonly [
          {
            readonly scope: McpInvocationContext.McpInvocationScope | undefined;
            readonly expired: string[];
          },
          RegistryState,
        ] => {
          const current = pruneDead(records, timestamp);
          const record = current.get(tokenHash);
          const expired = Array.from(records.values())
            .filter((candidate) => !current.has(candidate.tokenHash))
            .map((candidate) => candidate.scope.providerSessionId);
          if (!record) return [{ scope: undefined, expired }, { records: current }] as const;
          const next = new Map(current);
          next.set(tokenHash, { ...record, lastAliveAt: timestamp });
          return [{ scope: record.scope, expired }, { records: next }] as const;
        },
      );
      if (projectProxy._tag === "Some") {
        yield* Effect.forEach(
          resolved.expired,
          (providerSessionId) => projectProxy.value.revokeProviderSession(providerSessionId),
          { discard: true },
        );
      }
      if (resolved.scope !== undefined) {
        yield* scheduleExpiry(resolved.scope.providerSessionId);
      }
      return resolved.scope;
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      const touchedProviderSessionIds = yield* SynchronizedRef.modify(state, ({ records }) => {
        const current = pruneDead(records, timestamp);
        const next = new Map(current);
        const touched = new Set<string>();
        for (const [tokenHash, record] of current) {
          if (record.scope.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
            touched.add(record.scope.providerSessionId);
          }
        }
        return [touched, { records: next }] as const;
      });
      yield* Effect.forEach(touchedProviderSessionIds, scheduleExpiry, { discard: true });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.modify(state, ({ records }) => {
      const revoked = Array.from(records.values())
        .filter(predicate)
        .map((record) => record.scope.providerSessionId);
      return [
        revoked,
        { records: new Map(Array.from(records).filter(([, record]) => !predicate(record))) },
      ] as const;
    });

  const cancelExpiry = (providerSessionId: string) => {
    const fiber = expiryFibers.get(providerSessionId);
    expiryFibers.delete(providerSessionId);
    return fiber === undefined ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.asVoid);
  };

  const cleanupProjectSessions = (providerSessionIds: ReadonlyArray<string>) =>
    projectProxy._tag === "Some"
      ? Effect.forEach(new Set(providerSessionIds), projectProxy.value.revokeProviderSession, {
          discard: true,
        })
      : Effect.void;

  const revokeAndCleanup = (predicate: (record: CredentialRecord) => boolean) =>
    revokeWhere(predicate).pipe(
      Effect.flatMap((providerSessionIds) =>
        Effect.forEach(new Set(providerSessionIds), cancelExpiry, { discard: true }).pipe(
          Effect.andThen(cleanupProjectSessions(providerSessionIds)),
        ),
      ),
    );

  const expireProviderSession = (providerSessionId: string) =>
    revokeWhere((record) => record.scope.providerSessionId === providerSessionId).pipe(
      Effect.flatMap(cleanupProjectSessions),
      Effect.ensuring(
        Effect.sync(() => {
          expiryFibers.delete(providerSessionId);
        }),
      ),
      Effect.ignore,
    );

  const scheduleExpiry = (providerSessionId: string) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkDetach(
        Effect.sleep(Duration.millis(livenessWindowMs)).pipe(
          Effect.andThen(expireProviderSession(providerSessionId)),
        ),
      );
      const previous = expiryFibers.get(providerSessionId);
      expiryFibers.set(providerSessionId, fiber);
      if (previous !== undefined) yield* Fiber.interrupt(previous);
    });

  return McpSessionRegistry.of({
    issue,
    resolve,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeAndCleanup((record) => record.scope.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeAndCleanup((record) => record.scope.threadId === threadId);
    }),
    revokeAll: revokeAndCleanup(() => true),
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
    registry.revokeAll.pipe(
      Effect.ignore,
      Effect.andThen(
        Effect.sync(() => {
          if (activeMcpSessionRegistry === registry) {
            activeMcpSessionRegistry = undefined;
          }
        }),
      ),
    ),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

/**
 * Refreshes the liveness of a thread's MCP credential. Called on every provider
 * turn so an active session is never mistaken for an abandoned one.
 */
export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
