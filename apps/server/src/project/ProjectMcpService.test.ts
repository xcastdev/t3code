import {
  CommandId,
  McpServerId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

import * as ProjectMcpService from "./ProjectMcpService.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const codexInstance = ProviderInstanceId.make("codex");
const openCodeInstance = ProviderInstanceId.make("opencode");
const disabledCursorInstance = ProviderInstanceId.make("cursor-disabled");
const unavailableInstance = ProviderInstanceId.make("fork-provider");

const unavailableProvider = {
  instanceId: unavailableInstance,
  driver: ProviderDriverKind.make("fork-driver"),
  displayName: "Fork provider",
  enabled: false,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-09-02T00:00:00.000Z",
  message: "Provider driver is unavailable.",
  availability: "unavailable",
  unavailableReason: "Provider driver is unavailable.",
  models: [],
  slashCommands: [],
  skills: [],
} as const satisfies ServerProvider;

const codexInput = {
  name: "Docs",
  url: "https://docs.example.test/mcp",
  enabled: true,
  providerInstanceIds: [codexInstance],
};

const projectBInput = {
  name: "Project B Docs",
  url: "https://project-b.example.test/mcp",
  enabled: true,
  providerInstanceIds: [codexInstance],
};

const disabledInput = {
  name: "Disabled",
  url: "https://disabled.example.test/mcp",
  enabled: false,
  providerInstanceIds: [codexInstance],
};

const mcpHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const providerInstanceRegistry = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: () => Effect.die("Unused in ProjectMcpService tests"),
  listInstances: Effect.succeed([
    {
      instanceId: codexInstance,
      enabled: true,
      adapter: {
        capabilities: { remoteHttpMcp: "next-session", managedPreviewMcp: "next-session" },
      },
    },
    {
      instanceId: openCodeInstance,
      enabled: true,
      adapter: {
        capabilities: { remoteHttpMcp: "unsupported", managedPreviewMcp: "next-session" },
      },
    },
    {
      instanceId: disabledCursorInstance,
      enabled: false,
      adapter: {
        capabilities: { remoteHttpMcp: "next-session", managedPreviewMcp: "next-session" },
      },
    },
  ]),
  listUnavailable: Effect.succeed([unavailableProvider]),
  streamChanges: Effect.never,
  subscribeChanges: Effect.die("Unused in ProjectMcpService tests"),
} as never);

const testLayer = ProjectMcpService.layer.pipe(
  Layer.provideMerge(OrchestrationEngineLive),
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(ThreadPlanProgress.layer),
  Layer.provideMerge(providerInstanceRegistry),
  Layer.provideMerge(Layer.succeed(HttpServer.HttpServer, mcpHttpServer)),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const makeRestartTestLayer = (persistenceLayer: ReturnType<typeof makeSqlitePersistenceLive>) =>
  ProjectMcpService.layer.pipe(
    Layer.provideMerge(OrchestrationEngineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(providerInstanceRegistry),
    Layer.provideMerge(Layer.succeed(HttpServer.HttpServer, mcpHttpServer)),
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-restart-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const createProject = (projectId: ProjectId, commandId: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(commandId),
      projectId,
      title: projectId,
      workspaceRoot: `/tmp/${projectId}`,
      createdAt: "2026-09-02T20:00:00.000Z",
    });
  });

it.effect("restores explicit MCP transports after the service restarts", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstServiceLayer = Layer.fresh(makeRestartTestLayer(persistenceLayer));
    const secondServiceLayer = Layer.fresh(makeRestartTestLayer(persistenceLayer));
    const projectId = ProjectId.make("restart-explicit-transport-project");
    const transport = {
      type: "stdio" as const,
      command: "node",
      args: ["server.js"],
      cwd: "/workspace",
      env: [],
    };

    const server = yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      yield* createProject(projectId, "create-restart-explicit-transport-project");
      return yield* service.create({
        projectId,
        name: "Restarted stdio",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport,
      });
    }).pipe(Effect.provide(firstServiceLayer));

    const restored = yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      return {
        catalog: yield* service.list(projectId),
        resolved: yield* service.resolveForSession(projectId, codexInstance),
      };
    }).pipe(Effect.provide(secondServiceLayer));

    expect(restored.catalog.external).toEqual([server]);
    expect(restored.resolved).toEqual([
      {
        id: server.id,
        name: server.name,
        transport,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-restart-" }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.layer(testLayer)("ProjectMcpService", (it) => {
  it.effect("returns the managed preview descriptor without persisting it as an external row", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("managed-preview-project");
      yield* createProject(projectId, "managed-preview-project");
      const external = yield* service.create({ projectId, ...codexInput });

      const catalog = yield* service.list(projectId);

      expect(catalog.external).toEqual([external]);
      expect(catalog.managed).toEqual([
        {
          id: McpServerId.make("t3-code"),
          name: "t3-code",
          url: "http://127.0.0.1:43123/mcp",
          providerInstanceIds: [
            codexInstance,
            openCodeInstance,
            disabledCursorInstance,
            unavailableInstance,
          ],
        },
      ]);
      expect(catalog.applications).toEqual([
        { serverId: external.id, providerInstanceId: codexInstance, mode: "next-session" },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: codexInstance,
          mode: "next-session",
        },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: openCodeInstance,
          mode: "next-session",
        },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: disabledCursorInstance,
          mode: "unavailable",
        },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: unavailableInstance,
          mode: "unavailable",
        },
      ]);
      expect(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM projection_project_mcp_servers
          WHERE project_id = ${projectId}
        `,
      ).toEqual([{ count: 1 }]);
    }),
  );

  it.effect("derives application modes from live provider capabilities", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const projectId = ProjectId.make("application-modes-project");
      yield* createProject(projectId, "application-modes-project");
      const entry = yield* service.create({
        projectId,
        ...codexInput,
        providerInstanceIds: [codexInstance, openCodeInstance, disabledCursorInstance],
      });

      expect((yield* service.list(projectId)).applications).toEqual([
        { serverId: entry.id, providerInstanceId: codexInstance, mode: "next-session" },
        { serverId: entry.id, providerInstanceId: openCodeInstance, mode: "unsupported" },
        { serverId: entry.id, providerInstanceId: disabledCursorInstance, mode: "unavailable" },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: codexInstance,
          mode: "next-session",
        },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: openCodeInstance,
          mode: "next-session",
        },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: disabledCursorInstance,
          mode: "unavailable",
        },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: unavailableInstance,
          mode: "unavailable",
        },
      ]);
    }),
  );

  it.effect("accepts configured unavailable provider instances but rejects truly absent IDs", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const shadowProject = ProjectId.make("shadow-provider-project");
      const absentProviderId = ProviderInstanceId.make("absent-provider");
      yield* createProject(shadowProject, "shadow-provider-project");

      const entry = yield* service.create({
        projectId: shadowProject,
        ...codexInput,
        providerInstanceIds: [unavailableInstance],
      });
      const catalog = yield* service.list(shadowProject);

      expect(catalog.external).toEqual([entry]);
      expect(
        catalog.applications.find(
          (application) =>
            application.serverId === entry.id &&
            application.providerInstanceId === unavailableInstance,
        ),
      ).toEqual({
        serverId: entry.id,
        providerInstanceId: unavailableInstance,
        mode: "unavailable",
      });

      const error = yield* service
        .create({
          projectId: shadowProject,
          ...codexInput,
          name: "Absent",
          providerInstanceIds: [absentProviderId],
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ProjectMcpProviderNotFoundError",
        providerInstanceId: absentProviderId,
      });
    }),
  );

  it.effect("resolves only enabled entries for the selected project and provider", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      yield* createProject(projectA, "create-project-a");
      yield* createProject(projectB, "create-project-b");
      const codexEntry = yield* service.create({ projectId: projectA, ...codexInput });
      yield* service.create({ projectId: projectA, ...disabledInput });
      yield* service.create({ projectId: projectB, ...projectBInput });

      expect(yield* service.resolveForSession(projectA, codexInstance)).toEqual([
        {
          id: codexEntry.id,
          name: codexEntry.name,
          transport: { type: "streamable-http", url: codexEntry.url!, headers: [] },
        },
      ]);
    }),
  );

  it.effect("persists and resolves an explicit stdio server without a URL", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const projectId = ProjectId.make("stdio-project");
      yield* createProject(projectId, "create-stdio-project");

      const server = yield* service.create({
        projectId,
        name: "Filesystem",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: [],
        },
      });

      expect(yield* service.resolveForSession(projectId, codexInstance)).toEqual([
        {
          id: server.id,
          name: "Filesystem",
          transport: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: [],
          },
        },
      ]);
    }),
  );

  it.effect("deletes an external entry without affecting another project", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const deleteProjectA = ProjectId.make("delete-project-a");
      const deleteProjectB = ProjectId.make("delete-project-b");
      yield* createProject(deleteProjectA, "delete-project-a");
      yield* createProject(deleteProjectB, "delete-project-b");
      const projectAEntry = yield* service.create({ projectId: deleteProjectA, ...codexInput });
      const projectBEntry = yield* service.create({ projectId: deleteProjectB, ...projectBInput });

      yield* service.remove({ projectId: deleteProjectA, id: projectAEntry.id });

      expect((yield* service.list(deleteProjectA)).external).toEqual([]);
      expect(yield* service.resolveForSession(deleteProjectA, codexInstance)).toEqual([]);
      expect((yield* service.list(deleteProjectB)).external).toEqual([projectBEntry]);
    }),
  );

  it.effect("rejects a create that reuses a server ID from another project", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const firstProject = ProjectId.make("duplicate-id-project-a");
      const secondProject = ProjectId.make("duplicate-id-project-b");
      yield* createProject(firstProject, "duplicate-id-project-a");
      yield* createProject(secondProject, "duplicate-id-project-b");
      const server = yield* service.create({ projectId: firstProject, ...codexInput });

      const exit = yield* Effect.exit(
        engine.dispatch({
          type: "project.mcp-server.create",
          commandId: CommandId.make("duplicate-mcp-server-id"),
          projectId: secondProject,
          server: { ...server, name: "Other project docs" },
          createdAt: "2026-09-02T20:00:00.000Z",
        }),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "OrchestrationCommandInvariantError",
          commandType: "project.mcp-server.create",
          detail: `MCP server ID '${server.id}' is already in use.`,
        });
      }
    }),
  );

  it.effect("preserves a typed name conflict cause when the decider catches a race", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const raceProject = ProjectId.make("name-race-project");
      yield* createProject(raceProject, "name-race-project");
      yield* service.create({ projectId: raceProject, ...codexInput });

      const error = yield* engine
        .dispatch({
          type: "project.mcp-server.create",
          commandId: CommandId.make("name-race-command"),
          projectId: raceProject,
          server: {
            id: McpServerId.make("name-race-server"),
            ...codexInput,
            name: "docs",
          },
          createdAt: "2026-09-02T20:00:00.000Z",
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        cause: { _tag: "ProjectMcpNameConflictError", name: "docs" },
      });
    }),
  );

  it.effect("removes persisted MCP rows when their project is deleted", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const deletedProject = ProjectId.make("deleted-mcp-project");
      yield* createProject(deletedProject, "deleted-mcp-project");
      yield* service.create({ projectId: deletedProject, ...codexInput });

      yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make("delete-mcp-project"),
        projectId: deletedProject,
      });

      expect(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM projection_project_mcp_servers
          WHERE project_id = ${deletedProject}
        `,
      ).toEqual([{ count: 0 }]);
    }),
  );

  it.effect("keeps empty selections and stale provider IDs while rejecting newly unknown IDs", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const staleProviderId = ProviderInstanceId.make("retired");
      const staleProject = ProjectId.make("stale-project-a");
      yield* createProject(staleProject, "stale-project-a");
      const unattached = yield* service.create({
        projectId: staleProject,
        name: "Unattached",
        url: "https://unattached.example.test/mcp",
        enabled: true,
        providerInstanceIds: [],
      });
      yield* engine.dispatch({
        type: "project.mcp-server.create",
        commandId: CommandId.make("stale-provider-entry"),
        projectId: staleProject,
        server: {
          id: McpServerId.make("mcp-stale"),
          name: "Stale",
          url: "https://stale.example.test/mcp",
          enabled: true,
          providerInstanceIds: [staleProviderId],
        },
        createdAt: "2026-09-02T20:00:00.000Z",
      });

      const persisted = (yield* service.list(staleProject)).external;
      expect(persisted.find((entry) => entry.id === unattached.id)?.providerInstanceIds).toEqual(
        [],
      );
      expect(
        persisted.find((entry) => entry.id === McpServerId.make("mcp-stale"))?.providerInstanceIds,
      ).toEqual([staleProviderId]);
      expect(
        (yield* service.list(staleProject)).applications.find(
          (application) => application.serverId === McpServerId.make("mcp-stale"),
        )?.mode,
      ).toBe("unavailable");
      yield* service.update({
        projectId: staleProject,
        id: McpServerId.make("mcp-stale"),
        name: "Stale renamed",
        url: "https://stale.example.test/mcp",
        enabled: true,
        providerInstanceIds: [staleProviderId],
      });
      const unknown = yield* service
        .create({
          projectId: staleProject,
          name: "Unknown provider",
          url: "https://unknown.example.test/mcp",
          enabled: true,
          providerInstanceIds: [staleProviderId],
        })
        .pipe(Effect.flip);
      expect(unknown).toMatchObject({
        _tag: "ProjectMcpProviderNotFoundError",
        providerInstanceId: staleProviderId,
      });
    }),
  );

  it.effect("rejects unsafe URLs and case-folded duplicate names", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const validationProject = ProjectId.make("validation-project-a");
      yield* createProject(validationProject, "validation-project-a");
      yield* service.create({ projectId: validationProject, ...codexInput });

      const duplicate = yield* service
        .create({ projectId: validationProject, ...codexInput, name: "docs" })
        .pipe(Effect.flip);
      expect(duplicate).toMatchObject({ _tag: "ProjectMcpNameConflictError" });
      const unsafeUrl = yield* service
        .create({
          projectId: validationProject,
          name: "Unsafe",
          url: "http://example.test/mcp?token=secret",
          enabled: true,
          providerInstanceIds: [],
        })
        .pipe(Effect.flip);
      expect(unsafeUrl).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );

  it.effect("returns a typed error when the project MCP limit is exhausted", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const validationProject = ProjectId.make("limit-project-a");
      yield* createProject(validationProject, "limit-project-a");

      for (let index = 0; index < 50; index += 1) {
        yield* service.create({
          projectId: validationProject,
          name: `Server ${index}`,
          url: `https://server-${index}.example.test/mcp`,
          enabled: true,
          providerInstanceIds: [],
        });
      }
      const limit = yield* service
        .create({
          projectId: validationProject,
          name: "Overflow",
          url: "https://overflow.example.test/mcp",
          enabled: true,
          providerInstanceIds: [],
        })
        .pipe(Effect.flip);
      expect(limit).toMatchObject({ _tag: "ProjectMcpServerLimitExceededError", limit: 50 });
    }),
  );

  it.effect("returns typed errors for missing update and remove targets", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const missingProject = ProjectId.make("missing-target-project");
      const missingId = McpServerId.make("missing-server");
      yield* createProject(missingProject, "missing-target-project");

      const updateError = yield* service
        .update({
          projectId: missingProject,
          id: missingId,
          ...codexInput,
        })
        .pipe(Effect.flip);
      const removeError = yield* service
        .remove({ projectId: missingProject, id: missingId })
        .pipe(Effect.flip);

      expect(updateError).toMatchObject({ _tag: "ProjectMcpServerNotFoundError", id: missingId });
      expect(removeError).toMatchObject({ _tag: "ProjectMcpServerNotFoundError", id: missingId });
    }),
  );

  it.effect("rebuilds the MCP projection from events with the same rows as live projection", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const sql = yield* SqlClient.SqlClient;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const replayProject = ProjectId.make("replay-project-a");
      yield* createProject(replayProject, "replay-project-a");
      const entry = yield* service.create({ projectId: replayProject, ...codexInput });
      yield* service.update({
        projectId: replayProject,
        id: entry.id,
        name: "Docs v2",
        url: entry.url,
        enabled: false,
        providerInstanceIds: [],
      });
      const live = yield* sql`
        SELECT server_id, project_id, name, url, enabled, provider_instance_ids_json
        FROM projection_project_mcp_servers
        ORDER BY server_id
      `;

      yield* sql`DELETE FROM projection_project_mcp_servers`;
      yield* sql`DELETE FROM projection_state WHERE projector = 'projection.project-mcp-servers'`;
      yield* pipeline.bootstrap;
      const replayed = yield* sql`
        SELECT server_id, project_id, name, url, enabled, provider_instance_ids_json
        FROM projection_project_mcp_servers
        ORDER BY server_id
      `;

      expect(replayed).toEqual(live);
    }),
  );
});
