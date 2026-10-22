import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { McpProviderSessions, layer } from "./McpProviderSessions.ts";
import type { McpProviderSessionConfig } from "./mcpSession.ts";

it.effect("catalog receipts preserve actual revision and reject late native acknowledgements", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions;
    const first: McpProviderSessionConfig = {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      providerSessionId: "issued",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1/mcp",
      catalogEndpoint: "http://127.0.0.1/mcp/catalog/issued",
      catalogRevision: 1,
      nativeRuntimeId: "runtime",
      authorizationHeader: "Bearer private",
      browserToolsAvailable: false,
    };
    yield* sessions.set(first);
    yield* sessions.acknowledgeCatalogEndpoint(first);
    const second = { ...first, catalogRevision: 2 };
    yield* sessions.set(second);
    expect((yield* sessions.readCatalogEndpointReceipt(first.threadId))?.catalogRevision).toBe(1);
    yield* sessions.acknowledgeCatalogEndpoint(second);
    yield* sessions.acknowledgeCatalogEndpoint(first);
    expect((yield* sessions.readCatalogEndpointReceipt(first.threadId))?.catalogRevision).toBe(2);
    yield* sessions.set({ ...second, nativeRuntimeId: "replacement" });
    expect(yield* sessions.readCatalogEndpointReceipt(first.threadId)).toBeUndefined();
    yield* sessions.acknowledgeCatalogEndpoint(second);
    expect(yield* sessions.readCatalogEndpointReceipt(first.threadId)).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "native installation generations prevent old close and late ACK from clearing a successor",
  () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions;
      const config: McpProviderSessionConfig = {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        providerSessionId: "issued",
        providerInstanceId: ProviderInstanceId.make("claude"),
        endpoint: "http://127.0.0.1/mcp",
        catalogEndpoint: "http://127.0.0.1/mcp/catalog/issued",
        catalogRevision: 1,
        nativeRuntimeId: "runtime",
        authorizationHeader: "Bearer private",
        browserToolsAvailable: false,
      };
      yield* sessions.set(config);
      const first = yield* sessions.beginCatalogEndpointInstallation(config);
      yield* first.acknowledge;
      const second = yield* sessions.beginCatalogEndpointInstallation(config);
      expect(yield* sessions.readCatalogEndpointReceipt(config.threadId)).toBeUndefined();
      yield* first.acknowledge;
      expect(yield* sessions.readCatalogEndpointReceipt(config.threadId)).toBeUndefined();
      yield* second.acknowledge;
      yield* first.invalidate;
      expect(yield* sessions.readCatalogEndpointReceipt(config.threadId)).toEqual(config);
      yield* second.invalidate;
      expect(yield* sessions.readCatalogEndpointReceipt(config.threadId)).toBeUndefined();
    }).pipe(Effect.provide(layer)),
);
