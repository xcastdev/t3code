import { CommandId, McpServerId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
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

const providerInstanceRegistry = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: () => Effect.die("Unused in ProjectMcpService tests"),
  listInstances: Effect.succeed([{ instanceId: codexInstance }]),
  listUnavailable: Effect.succeed([]),
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
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-test-" })),
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

it.layer(testLayer)("ProjectMcpService", (it) => {
  it.effect("resolves only enabled entries for the selected project and provider", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      yield* createProject(projectA, "create-project-a");
      yield* createProject(projectB, "create-project-b");
      const codexEntry = yield* service.create({ projectId: projectA, ...codexInput });
      yield* service.create({ projectId: projectA, ...disabledInput });
      yield* service.create({ projectId: projectB, ...projectBInput });

      expect(yield* service.resolveForSession(projectA, codexInstance)).toEqual([codexEntry]);
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
      expect(unknown).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );

  it.effect("rejects unsafe URLs, case-folded duplicate names, and a fifty-first record", () =>
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

      for (let index = 1; index < 50; index += 1) {
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
      expect(limit).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
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
