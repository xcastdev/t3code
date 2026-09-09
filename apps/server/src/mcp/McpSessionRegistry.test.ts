import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, McpServerId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as ProjectMcpProxyRegistry from "./ProjectMcpProxyRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const projectTransport = {
  type: "streamable-http" as const,
  url: "https://fixture.example.test/mcp",
  headers: [],
  authorization: { type: "none" as const },
};
const projectServer = {
  id: McpServerId.make("mcp-rollback-fixture"),
  name: "rollback fixture",
  transport: projectTransport,
};

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("revokes one provider session without revoking its thread peers", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("thread-provider-session-revoke");
    const first = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const second = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const firstToken = first.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const secondToken = second.config.authorizationHeader.replace(/^Bearer\s+/, "");

    yield* registry.revokeProviderSession(second.config.providerSessionId);

    expect(yield* registry.resolve(firstToken)).toBeDefined();
    expect(yield* registry.resolve(secondToken)).toBeUndefined();
  }),
);

it.effect("can issue a project-only credential without preview capability", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-project-only"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      includePreview: false,
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const scope = yield* registry.resolve(token);

    expect(scope?.capabilities.has("preview")).toBe(false);
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("revokes an idle credential at its deadline without a request poll", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.__testing
      .make({ livenessWindowMs: 100 })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-clock-expiry"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    yield* TestClock.adjust(Duration.millis(101));
    yield* Effect.yieldNow;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("extends a credential deadline when successful MCP traffic resolves it", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.__testing
      .make({ livenessWindowMs: 100 })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-clock-traffic"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    yield* TestClock.adjust(Duration.millis(80));
    expect(yield* registry.resolve(token)).toBeDefined();

    yield* TestClock.adjust(Duration.millis(21));
    yield* Effect.yieldNow;
    expect(yield* registry.resolve(token)).toBeDefined();

    yield* TestClock.adjust(Duration.millis(101));
    yield* Effect.yieldNow;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("cleans project sessions pruned by unrelated liveness activity", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    let closed = 0;
    const serverId = "pruned-project-server" as never;
    const transport = {
      type: "streamable-http" as const,
      url: "https://fixture.example.test/mcp",
      headers: [],
      authorization: { type: "none" as const },
    };
    const proxy = yield* ProjectMcpProxyRegistry.__testing.make({
      endpointBase: "http://127.0.0.1:43123/mcp",
      connect: async () => ({
        client: {
          connect: async () => undefined,
          close: async () => undefined,
          ping: async () => ({}),
        },
        transport,
        protocolEra: "modern" as const,
        negotiatedProtocolVersion: "2026-07-28",
        discoverResult: {
          protocolVersion: "2026-07-28",
          supportedVersions: ["2026-07-28"],
          capabilities: {},
          serverInfo: { name: "fixture", version: "1" },
        },
        close: async () => {
          closed += 1;
        },
      }),
    });
    const registry = yield* makeRegistry(() => timestamp).pipe(
      Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, proxy),
    );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-pruned"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      projectMcpServers: [
        {
          id: serverId,
          name: "fixture",
          transport,
        },
      ],
    });
    const endpoint = issued.config.projectServers?.[0];
    if (!endpoint) throw new Error("expected a project MCP endpoint");
    const endpointHandle = endpoint.endpoint.pathname.split("/").at(-1);
    if (!endpointHandle) throw new Error("expected an endpoint handle");
    const response = yield* proxy.handle(
      issued.config.providerSessionId,
      endpointHandle,
      new Request(String(endpoint.endpoint)),
    );
    yield* Effect.promise(() => response.text());

    timestamp += 101;
    yield* registry.touch(ThreadId.make("unrelated-thread"));
    yield* registry.revokeAll;

    expect(closed).toBe(1);
    expect(yield* proxy.resolve(issued.config.providerSessionId, endpointHandle)).toBeUndefined();
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(yield* registry.resolve(token)).toBeUndefined();
    yield* proxy.revokeAll;
  }),
);

it.effect("rolls back a proxy session when issuance is interrupted after registration", () =>
  Effect.gen(function* () {
    const realProxy = yield* ProjectMcpProxyRegistry.__testing.make({
      endpointBase: "http://127.0.0.1:43123/mcp",
      connect: async () => ({
        client: {
          connect: async () => undefined,
          close: async () => undefined,
          ping: async () => ({}),
        },
        transport: projectTransport,
        protocolEra: "modern" as const,
        negotiatedProtocolVersion: "2026-07-28",
        discoverResult: {
          protocolVersion: "2026-07-28",
          supportedVersions: ["2026-07-28"],
          capabilities: {},
          serverInfo: { name: "fixture", version: "1" },
        },
        close: async () => undefined,
      }),
    });
    const registered = yield* Deferred.make<void>();
    let capturedProviderSessionId: string | undefined;
    let capturedEndpointHandle: string | undefined;
    const blockingProxy = ProjectMcpProxyRegistry.ProjectMcpProxyRegistry.of({
      ...realProxy,
      registerSession: (input) =>
        realProxy.registerSession(input).pipe(
          Effect.tap((endpoints) =>
            Effect.sync(() => {
              capturedProviderSessionId = input.providerSessionId;
              capturedEndpointHandle = endpoints[0]!.endpointHandle;
            }).pipe(Effect.andThen(Deferred.succeed(registered, undefined))),
          ),
          Effect.andThen(Effect.never),
        ),
    });
    const registry = yield* makeRegistry(() => 1_000).pipe(
      Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, blockingProxy),
    );
    const issueFiber = yield* Effect.forkChild(
      registry.issue({
        threadId: ThreadId.make("thread-interrupted"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        projectMcpServers: [projectServer],
        resolveProjectMcpSecret: () => "synthetic-secret",
      }),
    );
    yield* Deferred.await(registered);
    yield* Fiber.interrupt(issueFiber);

    if (!capturedProviderSessionId || !capturedEndpointHandle)
      throw new Error("proxy registration was not captured");
    expect(
      yield* realProxy.resolve(capturedProviderSessionId, capturedEndpointHandle),
    ).toBeUndefined();
    yield* realProxy.revokeAll;
  }),
);

it.effect("keeps a successful project issuance until its provider session is revoked", () =>
  Effect.gen(function* () {
    const proxy = yield* ProjectMcpProxyRegistry.__testing.make({
      endpointBase: "http://127.0.0.1:43123/mcp",
      connect: async () => ({
        client: {
          connect: async () => undefined,
          close: async () => undefined,
          ping: async () => ({}),
        },
        transport: projectTransport,
        protocolEra: "modern" as const,
        negotiatedProtocolVersion: "2026-07-28",
        discoverResult: {
          protocolVersion: "2026-07-28",
          supportedVersions: ["2026-07-28"],
          capabilities: {},
          serverInfo: { name: "fixture", version: "1" },
        },
        close: async () => undefined,
      }),
    });
    const registry = yield* makeRegistry(() => 1_000).pipe(
      Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, proxy),
    );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-success"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      projectMcpServers: [projectServer],
    });
    const endpoint = issued.config.projectServers?.[0];
    if (!endpoint) throw new Error("expected a project endpoint");
    const endpointHandle = endpoint.endpoint.pathname.split("/").at(-1);
    if (!endpointHandle) throw new Error("expected an endpoint handle");
    expect(yield* proxy.resolve(issued.config.providerSessionId, endpointHandle)).toBeDefined();

    yield* registry.revokeProviderSession(issued.config.providerSessionId);
    expect(yield* proxy.resolve(issued.config.providerSessionId, endpointHandle)).toBeUndefined();
  }),
);
