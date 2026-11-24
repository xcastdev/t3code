import { assert, it } from "@effect/vitest";
import {
  AssistantId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Environment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        const project = Option.getOrNull(yield* projects.get(projectId));
        assert.deepStrictEqual(project?.defaultModelSelection, modelSelection);
        // Events from before tracked folders have no list.
        assert.deepStrictEqual(project?.trackedFolders, []);
      }),
    );

    it.effect("keeps pin and archive times and tracked folders across later updates", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project-organized");
        const at = "2026-03-24T00:00:00.000Z";
        const event = { aggregateKind: "project", aggregateId: projectId, occurredAt: at } as const;
        const meta = { commandId: null, causationEventId: null, correlationId: null, metadata: {} };
        const trackedFolders = [{ path: "/tmp/project-shared", name: "Shared" }];
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 1,
          eventId: EventId.make("event-organized-created"),
          type: "project.created",
          payload: {
            projectId,
            title: "Organized",
            workspaceRoot: "/tmp/project-organized",
            defaultModelSelection: null,
            scripts: [],
            createdAt: at,
            updatedAt: at,
          },
        });
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 2,
          eventId: EventId.make("event-organized-pinned"),
          type: "project.meta-updated",
          payload: { projectId, pinnedAt: at, archivedAt: at, trackedFolders, updatedAt: at },
        });
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 3,
          eventId: EventId.make("event-organized-renamed"),
          type: "project.meta-updated",
          payload: { projectId, title: "Renamed", updatedAt: at },
        });
        const project = Option.getOrNull(yield* projects.get(projectId));
        assert.strictEqual(project?.pinnedAt, at);
        assert.strictEqual(project?.archivedAt, at);
        assert.deepStrictEqual(project?.trackedFolders, trackedFolders);
      }),
    );

    it.effect("marks a project's title as custom only once it is renamed", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project-renamed");
        const event = {
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        } as const;
        const hasCustomTitle = () =>
          projects
            .getShell(projectId)
            .pipe(Effect.map((shell) => Option.getOrNull(shell)?.hasCustomTitle));
        yield* projects.apply({
          ...event,
          sequence: 1,
          eventId: EventId.make("event-renamed-created"),
          type: "project.created",
          payload: {
            projectId,
            title: "repo",
            workspaceRoot: "/tmp/repo",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });
        assert.strictEqual(yield* hasCustomTitle(), false);
        yield* projects.apply({
          ...event,
          sequence: 2,
          eventId: EventId.make("event-renamed-title"),
          type: "project.meta-updated",
          payload: { projectId, title: "custom repo", updatedAt: "2026-03-24T00:00:02.000Z" },
        });
        assert.strictEqual(yield* hasCustomTitle(), true);
        yield* projects.apply({
          ...event,
          sequence: 3,
          eventId: EventId.make("migration:39:project:project-renamed:baseline"),
          type: "project.created",
          payload: {
            projectId,
            title: "repo",
            workspaceRoot: "/tmp/repo",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:03.000Z",
          },
        });
        assert.strictEqual(yield* hasCustomTitle(), true);
        assert.strictEqual(
          Option.getOrNull(yield* projects.getShell(projectId))?.title,
          "custom repo",
        );
      }),
    );
  },
);

const environmentId = EnvironmentId.make("project-shell-environment");
const shellLayer = ProjectStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("unused"),
    }),
  ),
);

it.layer(shellLayer)("assistant project shells", (it) => {
  it.effect(
    "projects carry their current environment's retained owner, including archived assistants",
    () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const ordinary = ProjectId.make("ordinary-shell-project");
        const owned = ProjectId.make("owned-shell-project");
        const archived = ProjectId.make("archived-shell-project");
        const foreign = ProjectId.make("foreign-shell-project");
        for (const projectId of [ordinary, owned, archived, foreign]) {
          yield* projects.apply({
            sequence: 1,
            eventId: EventId.make(`created-${projectId}`),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: "2026-03-24T00:00:00.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId,
              title: "Assistant workspace: same title for every project",
              workspaceRoot: `/tmp/${projectId}`,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-03-24T00:00:00.000Z",
              updatedAt: "2026-03-24T00:00:00.000Z",
            },
          });
        }
        // Ownership must not depend on the assistant roster's 100-row pagination limit.
        yield* sql`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<105)
        INSERT INTO t3_workflow_v2_assistants
        SELECT ${environmentId},'a-'||value,'unrelated-project-'||value,'unrelated-thread-'||value,
          0,0,'active','ready',NULL,'unrelated-command-'||value,'{}' FROM n`;
        for (const [ownerEnvironment, projectId, assistantId, lifecycle] of [
          [environmentId, owned, "z-owned", "active"],
          [environmentId, archived, "z-archived", "archived"],
          ["other-environment", foreign, "z-foreign", "active"],
          ["other-environment", owned, "z-foreign-collision", "active"],
        ] as const) {
          yield* sql`INSERT INTO t3_workflow_v2_assistants VALUES(
          ${ownerEnvironment},${assistantId},${projectId},${`thread-${assistantId}`},
          0,0,${lifecycle},'ready',NULL,${`command-${assistantId}`},'{}')`;
        }

        const shells = yield* projects.listShells({
          projectIds: [ordinary, owned, archived, foreign],
        });
        assert.strictEqual(shells.length, 4);
        const byId = new Map(shells.map((shell) => [shell.id, shell]));
        assert.strictEqual(byId.get(ordinary)?.assistantId, undefined);
        assert.strictEqual(byId.get(foreign)?.assistantId, undefined);
        assert.strictEqual(byId.get(owned)?.assistantId, AssistantId.make("z-owned"));
        assert.strictEqual(byId.get(archived)?.assistantId, AssistantId.make("z-archived"));
        assert.strictEqual(
          Option.getOrNull(yield* projects.getShell(owned))?.assistantId,
          AssistantId.make("z-owned"),
        );
        assert.strictEqual(
          Option.getOrNull(yield* projects.getShell(archived))?.assistantId,
          AssistantId.make("z-archived"),
        );
        assert.deepStrictEqual(yield* projects.listShells({ projectIds: [] }), []);
      }),
  );
});
