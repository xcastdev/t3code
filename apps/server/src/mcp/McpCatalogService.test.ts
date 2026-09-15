import {
  EnvironmentId,
  McpDefinitionId,
  McpCatalogStaleRevisionError,
  McpCatalogStaleSessionError,
  McpCatalogSessionId,
  McpServerId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as McpCatalogService from "./McpCatalogService.ts";

const provider = ProviderInstanceId.make("codex");
const transport = {
  type: "streamable-http" as const,
  url: "https://weather.example.test/mcp",
  headers: [],
  authorization: { type: "none" as const },
};

const serviceLayer = McpCatalogService.layer;

it.effect("captures defaults and keeps session state isolated until reset", () =>
  Effect.gen(function* () {
    const service = yield* McpCatalogService.McpCatalogService;
    const global = yield* service.createGlobal({
      scope: "global",
      scopeId: "environment-1",
      expectedRevision: 0,
      definition: {
        name: "Weather",
        transport,
        enabled: true,
        providerInstanceIds: [provider],
      },
      logicalServerId: McpServerId.make("weather"),
    });
    const session = yield* service.materializeSession({
      threadId: ThreadId.make("thread-1"),
      projectId: "project-1",
      providerInstanceId: provider,
    });

    yield* service.updateGlobal({
      scope: "global",
      scopeId: "environment-1",
      expectedRevision: 1,
      logicalServerId: global.logicalServerId,
      definition: {
        name: "Forecast",
        transport,
        enabled: true,
        providerInstanceIds: [provider],
      },
    });
    expect((yield* service.listSession(session.catalogSessionId)).desired[0]?.name).toBe("Weather");
    expect((yield* service.listGlobal())[0]?.name).toBe("Forecast");

    const reset = yield* service.resetSession({
      threadId: ThreadId.make("thread-1"),
      mcpCatalogSessionId: session.catalogSessionId,
      expectedRevision: 0,
    });
    expect(reset.desired[0]?.name).toBe("Forecast");

    const stale = yield* service
      .resetSession({
        threadId: ThreadId.make("thread-1"),
        mcpCatalogSessionId: McpCatalogSessionId.make("wrong-session"),
        expectedRevision: reset.desiredRevision,
      })
      .pipe(Effect.flip);
    expect(stale).toBeInstanceOf(McpCatalogStaleSessionError);
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("rejects stale scope revisions before mutating", () =>
  Effect.gen(function* () {
    const service = yield* McpCatalogService.McpCatalogService;
    const error = yield* service
      .createGlobal({
        scope: "global",
        scopeId: "environment-1",
        expectedRevision: 1,
        definition: {
          name: "Weather",
          transport,
          enabled: true,
          providerInstanceIds: [provider],
        },
      })
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(McpCatalogStaleRevisionError);
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("hydrates saved definitions and sessions once across websocket clients", () =>
  Effect.gen(function* () {
    const service = yield* McpCatalogService.McpCatalogService;
    const definition = {
      definitionId: McpDefinitionId.make("definition-weather"),
      logicalServerId: McpServerId.make("weather"),
      scope: "global" as const,
      scopeId: "environment-1",
      name: "Weather",
      transport,
      enabled: true,
      providerInstanceIds: [provider],
      revision: 2,
    };
    const snapshot = {
      catalogSessionId: McpCatalogSessionId.make("catalog-session-1"),
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: provider,
      baseline: [definition],
      desired: [definition],
      applied: [],
      desiredRevision: 0,
      appliedRevision: 0,
    };

    yield* service.hydrate({
      threads: [{ id: ThreadId.make("thread-1"), projectId: ProjectId.make("project-1") }],
      mcpCatalog: {
        environmentId: EnvironmentId.make("environment-1"),
        globalRevision: 2,
        globalDefinitions: [definition],
        projectRevisions: [{ projectId: ProjectId.make("project-1"), revision: 0 }],
        projectDefinitions: [],
        projectOverrides: [],
        sessions: [snapshot],
      },
    });
    expect((yield* service.listGlobal())[0]?.name).toBe("Weather");
    expect((yield* service.listProject("project-1", provider))[0]?.logicalServerId).toBe(
      McpServerId.make("weather"),
    );
    expect((yield* service.listSession(snapshot.catalogSessionId)).threadId).toBe(
      ThreadId.make("thread-1"),
    );

    yield* service.createGlobal({
      scope: "global",
      scopeId: "environment-1",
      expectedRevision: 2,
      definition: {
        name: "Search",
        transport,
        enabled: true,
        providerInstanceIds: [provider],
      },
    });
    yield* service.hydrate({
      threads: [],
      mcpCatalog: {
        environmentId: EnvironmentId.make("environment-1"),
        globalRevision: 2,
        globalDefinitions: [definition],
        projectRevisions: [],
        projectDefinitions: [],
        projectOverrides: [],
        sessions: [],
      },
    });
    expect((yield* service.listGlobal()).map((item) => item.name)).toEqual(["Weather"]);
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("materialization is idempotent and generated session definition ids are unique", () =>
  Effect.gen(function* () {
    const service = yield* McpCatalogService.McpCatalogService;
    const catalogSessionId = McpCatalogSessionId.make("catalog-session-1");
    const first = yield* service.materializeSession({
      threadId: ThreadId.make("thread-1"),
      projectId: "project-1",
      providerInstanceId: provider,
      mcpCatalogSessionId: catalogSessionId,
    });
    const added = yield* service.addSession({
      scope: "session",
      scopeId: String(catalogSessionId),
      expectedRevision: 0,
      mcpCatalogSessionId: catalogSessionId,
      threadId: ThreadId.make("thread-1"),
      definition: {
        name: "Weather",
        transport,
        enabled: true,
        providerInstanceIds: [provider],
      },
    });
    const second = yield* service.addSession({
      scope: "session",
      scopeId: String(catalogSessionId),
      expectedRevision: 1,
      mcpCatalogSessionId: catalogSessionId,
      threadId: ThreadId.make("thread-1"),
      definition: {
        name: "Search",
        transport,
        enabled: true,
        providerInstanceIds: [provider],
      },
    });
    expect(first.desired).toHaveLength(0);
    expect(new Set(second.desired.map((entry) => entry.definitionId)).size).toBe(2);
    expect(new Set(second.desired.map((entry) => entry.logicalServerId)).size).toBe(2);

    const rematerialized = yield* service.materializeSession({
      threadId: ThreadId.make("thread-1"),
      projectId: "project-1",
      providerInstanceId: provider,
      mcpCatalogSessionId: catalogSessionId,
    });
    expect(rematerialized.desired.map((entry) => entry.name)).toEqual(["Weather", "Search"]);
    expect(rematerialized.desiredRevision).toBe(2);
    expect(added.desired[0]?.definitionId).not.toBe(second.desired[1]?.definitionId);
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("disposed sessions reject later mutations", () =>
  Effect.gen(function* () {
    const service = yield* McpCatalogService.McpCatalogService;
    const snapshot = yield* service.materializeSession({
      threadId: ThreadId.make("thread-1"),
      projectId: "project-1",
      providerInstanceId: provider,
      mcpCatalogSessionId: McpCatalogSessionId.make("catalog-session-1"),
    });
    yield* service.disposeSession({
      threadId: ThreadId.make("thread-1"),
      mcpCatalogSessionId: snapshot.catalogSessionId,
    });
    const error = yield* service
      .addSession({
        scope: "session",
        scopeId: String(snapshot.catalogSessionId),
        expectedRevision: 0,
        mcpCatalogSessionId: snapshot.catalogSessionId,
        threadId: ThreadId.make("thread-1"),
        definition: {
          name: "Weather",
          transport,
          enabled: true,
          providerInstanceIds: [provider],
        },
      })
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(McpCatalogStaleSessionError);
  }).pipe(Effect.provide(serviceLayer)),
);
