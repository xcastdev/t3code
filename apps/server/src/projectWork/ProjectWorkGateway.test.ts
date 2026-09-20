import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkApprovalId,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  projectWorkPayloadFingerprint,
  projectWorkProtectedRevisionIntentFingerprintPayload,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectWorkBriefing from "./ProjectWorkBriefing.ts";
import * as ProjectWorkGateway from "./ProjectWorkGateway.ts";
import * as ProjectWorkNarrative from "./ProjectWorkNarrative.ts";
import * as ProjectWorkProjection from "./ProjectWorkProjection.ts";
import * as ProjectWorkQuery from "./ProjectWorkQuery.ts";
import * as ProjectWorkRepository from "./ProjectWorkRepository.ts";
import * as ProjectWorkSearch from "./ProjectWorkSearch.ts";
import * as ServerSettings from "../serverSettings.ts";

const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const containsObjectKey = (value: unknown, target: string): boolean => {
  if (Array.isArray(value)) return value.some((entry) => containsObjectKey(entry, target));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) => key === target || containsObjectKey(entry, target),
  );
};

const projectId = ProjectId.make("gateway-project");
const taskId = ProjectWorkTaskId.make("gateway-task");
const at = "2026-01-01T00:00:00.000Z";

const auth = EnvironmentAuth.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-project-work-gateway-",
    }),
  ),
);
const projectServices = Layer.mergeAll(
  ProjectWorkRepository.ProjectWorkRepositoryLive,
  ProjectWorkProjection.ProjectWorkProjectionLive,
  ProjectWorkQuery.ProjectWorkQueryLive,
  ProjectWorkSearch.ProjectWorkSearchLive,
  ProjectWorkNarrative.ProjectWorkNarrativeLive,
  ProjectWorkBriefing.ProjectWorkBriefingLive.pipe(
    Layer.provide(ProjectWorkQuery.ProjectWorkQueryLive),
  ),
);

const makeGatewayLayer = (settings: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  Layer.mergeAll(
    ProjectWorkGateway.ProjectWorkGatewayLive.pipe(
      Layer.provideMerge(projectServices),
      Layer.provideMerge(auth),
    ),
  ).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettings.layerTest({ projectWorkEnabled: true, ...settings })),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("gateway-environment")),
      }),
    ),
  );

const gatewayLayer = makeGatewayLayer();

const layer = it.layer(NodeServices.layer);

layer("ProjectWorkGateway", (it) => {
  it.effect("keeps reads available while disabled and restores writes after re-enable", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${String(projectId)}, 'Gateway project', '/workspace/gateway', '[]', ${at}, ${at})
      `;
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const settings = yield* ServerSettings.ServerSettingsService;
      expect(yield* gateway.read({ projectId, operation: "tasks" })).toEqual([]);
      const command = {
        type: "project-work.task.create" as const,
        commandId: CommandId.make("gateway-enable-create"),
        projectId,
        taskId,
        title: "Enabled task",
        createdAt: at,
      };
      const disabled = yield* Effect.result(
        gateway.write(
          command,
          { kind: "human", id: "user:reviewer" },
          { kind: "web", id: "user:reviewer" },
        ),
      );
      expect(disabled._tag).toBe("Failure");
      yield* settings.updateSettings({ projectWorkEnabled: true });
      const enabled = yield* gateway.write(
        command,
        { kind: "human", id: "user:reviewer" },
        { kind: "web", id: "user:reviewer" },
      );
      expect(enabled.receipt.status).toBe("accepted");
    }).pipe(Effect.provide(makeGatewayLayer({ projectWorkEnabled: false }))),
  );

  it.effect("attributes writes and returns an event receipt", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${String(projectId)}, 'Gateway project', '/workspace/gateway', '[]', ${at}, ${at})
      `;
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const command = {
        type: "project-work.task.create" as const,
        commandId: CommandId.make("gateway-create"),
        projectId,
        taskId,
        title: "Gateway task",
        createdAt: at,
      };
      const first = yield* gateway.write(
        command,
        { kind: "human", id: "user:reviewer" },
        { kind: "web", id: "user:reviewer" },
      );
      yield* gateway.write(
        {
          type: "project-work.task.create",
          commandId: CommandId.make("gateway-create-later"),
          projectId,
          taskId: ProjectWorkTaskId.make("gateway-task-later"),
          title: "Later task",
          createdAt: at,
        },
        { kind: "human", id: "user:reviewer" },
        { kind: "web", id: "user:reviewer" },
      );
      const duplicate = yield* gateway.write(
        command,
        { kind: "human", id: "user:reviewer" },
        { kind: "web", id: "user:reviewer" },
      );

      expect(first.receipt.status).toBe("accepted");
      expect(first.receipt.eventCount).toBe(1);
      expect(first.delta.eventIds).toHaveLength(1);
      expect(first.delta.changedFields).toEqual(["tasks"]);
      expect(duplicate).toEqual(first);
      expect("state" in first).toBe(false);
      expect("events" in first).toBe(false);

      expect(
        yield* gateway.read({
          projectId,
          operation: "tasks",
          limit: 1,
          envelope: true,
        }),
      ).toMatchObject({
        projectId,
        revision: 2,
        offset: 0,
        limit: 1,
        hasMore: true,
        items: [{ taskId }],
      });
      const context = (yield* gateway.read({
        projectId,
        operation: "task-context",
        taskId,
      })) as Record<string, unknown>;
      expect(context).toMatchObject({
        projectId,
        revision: 2,
        task: { taskId },
        criteria: [],
        evidence: [],
        policy: { taskId },
      });
      expect(containsObjectKey(context, "leaseToken")).toBe(false);
      const taskOnlySearch = (yield* gateway.read({
        projectId,
        operation: "search",
        query: "Gateway",
        recordKinds: ["task"],
      })) as { items: ReadonlyArray<{ recordKind: string }> };
      expect(taskOnlySearch.items.every((item) => item.recordKind === "task")).toBe(true);

      expect(yield* gateway.read({ projectId, operation: "export-json" })).toMatchObject({
        format: "json",
        environmentId: "gateway-environment",
      });
    }).pipe(Effect.provide(gatewayLayer)),
  );

  it.effect("uses a private 1,001st row to report the public 1,000-row boundary", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const sql = yield* SqlClient.SqlClient;
      const boundaryProjectId = ProjectId.make("gateway-boundary-project");
      yield* sql`
        WITH RECURSIVE generated(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM generated WHERE value < 1001
        )
        INSERT INTO project_work_tasks
          (task_id, project_id, title, state, watchers_json, revision, spec_revision,
            created_at, updated_at)
        SELECT printf('boundary-task-%04d', value), ${boundaryProjectId},
          printf('Boundary task %04d', value), 'draft', '[]', value, 0,
          ${at}, ${at}
        FROM generated
      `;
      yield* sql`
        INSERT INTO project_work_events
          (event_id, project_id, event_type, occurred_at, command_id, payload_json)
        VALUES ('boundary-event', ${boundaryProjectId}, 'project-work.task.created', ${at},
          'boundary-command', ${encodeUnknownJson({ revision: 1001 })})
      `;

      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const first = (yield* gateway.read({
        projectId: boundaryProjectId,
        operation: "tasks",
        limit: 1_000,
        envelope: true,
      })) as {
        items: ReadonlyArray<unknown>;
        limit: number;
        hasMore: boolean;
        revision: number;
      };
      expect(first.items).toHaveLength(1_000);
      expect(first.limit).toBe(1_000);
      expect(first.hasMore).toBe(true);
      expect(first.revision).toBe(1_001);

      const last = (yield* gateway.read({
        projectId: boundaryProjectId,
        operation: "tasks",
        limit: 1_000,
        offset: 1,
        envelope: true,
      })) as { items: ReadonlyArray<unknown>; hasMore: boolean };
      expect(last.items).toHaveLength(1_000);
      expect(last.hasMore).toBe(false);

      const exported = (yield* gateway.read({
        projectId: boundaryProjectId,
        operation: "export-json",
        includeHistory: true,
      })) as {
        tasks: ReadonlyArray<unknown>;
        history: ReadonlyArray<unknown>;
        projectRevision: number;
      };
      expect(exported.tasks).toHaveLength(1_001);
      expect(exported.history).toHaveLength(1);
      expect(exported.projectRevision).toBe(1_001);
    }).pipe(Effect.provide(gatewayLayer)),
  );

  it.effect("derives task policy from complete endpoint-filtered inputs", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const sql = yield* SqlClient.SqlClient;
      const contextProjectId = ProjectId.make("gateway-context-boundary-project");
      const contextTaskId = ProjectWorkTaskId.make("context-task");
      const dependencyTaskId = ProjectWorkTaskId.make("context-dependency");
      yield* sql`
        INSERT INTO project_work_tasks
          (task_id, project_id, title, state, specification_json, watchers_json, revision,
            spec_revision, created_at, updated_at)
        VALUES
          (${contextTaskId}, ${contextProjectId}, 'Context task', 'ready',
            ${encodeUnknownJson({ revision: 1, protected: false, criterionIds: ["context-criterion-1001"] })},
            '[]', 1, 1, ${at}, ${at}),
          (${dependencyTaskId}, ${contextProjectId}, 'Pending dependency', 'draft', NULL,
            '[]', 1, 0, ${at}, ${at}),
          ('unrelated-a', ${contextProjectId}, 'Unrelated A', 'completed', NULL,
            '[]', 1, 0, ${at}, ${at}),
          ('unrelated-b', ${contextProjectId}, 'Unrelated B', 'completed', NULL,
            '[]', 1, 0, ${at}, ${at})
      `;
      yield* sql`
        WITH RECURSIVE generated(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM generated WHERE value < 1001
        )
        INSERT INTO project_work_criteria
          (criterion_id, project_id, task_id, description, required, status,
            satisfied_by_evidence_ids_json, revision, updated_at)
        SELECT printf('context-criterion-%04d', value), ${contextProjectId}, ${contextTaskId},
          printf('Criterion %04d', value), 1, 'unsatisfied', '[]', value, ${at}
        FROM generated
      `;
      yield* sql`
        WITH RECURSIVE generated(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM generated WHERE value < 1001
        )
        INSERT INTO project_work_relationships
          (relationship_id, project_id, from_task_id, to_task_id, kind, revision, created_at)
        SELECT printf('unrelated-relationship-%04d', value), ${contextProjectId},
          'unrelated-a', 'unrelated-b', 'relates-to', value,
          '2026-01-02T00:00:00.000Z'
        FROM generated
      `;
      yield* sql`
        INSERT INTO project_work_relationships
          (relationship_id, project_id, from_task_id, to_task_id, kind, revision, created_at)
        VALUES ('context-dependency-relationship', ${contextProjectId}, ${contextTaskId},
          ${dependencyTaskId}, 'depends-on', 1002, ${at})
      `;
      yield* sql`
        INSERT INTO project_work_events
          (event_id, project_id, event_type, occurred_at, command_id, payload_json)
        VALUES ('context-boundary-event', ${contextProjectId}, 'project-work.relationship.linked',
          ${at}, 'context-boundary-command', ${encodeUnknownJson({ revision: 1002 })})
      `;

      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const context = (yield* gateway.read({
        projectId: contextProjectId,
        operation: "task-context",
        taskId: contextTaskId,
      })) as {
        criteria: ReadonlyArray<{ criterionId: string }>;
        relationships: ReadonlyArray<{ relationshipId: string }>;
        policy: {
          readiness: { ready: boolean; reasons: ReadonlyArray<string> };
        };
      };
      expect(context.criteria).toHaveLength(100);
      expect(context.relationships).toEqual([
        expect.objectContaining({
          relationshipId: "context-dependency-relationship",
        }),
      ]);
      expect(context.policy.readiness).toEqual({
        ready: false,
        reasons: ["unresolved-dependency"],
      });
    }).pipe(Effect.provide(gatewayLayer)),
  );

  it.effect("keeps a collection and revision coherent across a concurrent write", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectWorkQuery.ProjectWorkQuery;
      const concurrentProjectId = ProjectId.make("gateway-concurrent-read-project");
      yield* sql`
        INSERT INTO project_work_tasks
          (task_id, project_id, title, state, watchers_json, revision, spec_revision,
            created_at, updated_at)
        VALUES ('concurrent-task-1', ${concurrentProjectId}, 'First task', 'draft', '[]',
          1, 0, ${at}, ${at})
      `;
      yield* sql`
        INSERT INTO project_work_events
          (event_id, project_id, event_type, occurred_at, command_id, payload_json)
        VALUES ('concurrent-event-1', ${concurrentProjectId}, 'project-work.task.created',
          ${at}, 'concurrent-command-1', ${encodeUnknownJson({ revision: 1 })})
      `;
      const collectionRead = yield* Deferred.make<void>();
      const continueRead = yield* Deferred.make<void>();
      const reader = yield* query
        .withProjectRevision(
          String(concurrentProjectId),
          query.listTasks({ projectId: String(concurrentProjectId) }).pipe(
            Effect.tap(() => Deferred.succeed(collectionRead, undefined)),
            Effect.tap(() => Deferred.await(continueRead)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(collectionRead);
      const writer = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO project_work_tasks
                (task_id, project_id, title, state, watchers_json, revision, spec_revision,
                  created_at, updated_at)
              VALUES ('concurrent-task-2', ${concurrentProjectId}, 'Second task', 'draft', '[]',
                2, 0, ${at}, ${at})
            `;
            yield* sql`
              INSERT INTO project_work_events
                (event_id, project_id, event_type, occurred_at, command_id, payload_json)
              VALUES ('concurrent-event-2', ${concurrentProjectId},
                'project-work.task.created', ${at}, 'concurrent-command-2',
                ${encodeUnknownJson({ revision: 2 })})
            `;
          }),
        )
        .pipe(Effect.forkChild);
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow);
      yield* Deferred.succeed(continueRead, undefined);
      const result = yield* Fiber.join(reader);
      yield* Fiber.join(writer);
      expect(result.value).toHaveLength(result.revision);
      expect(result.revision === 1 || result.revision === 2).toBe(true);
    }).pipe(Effect.provide(gatewayLayer)),
  );

  const projectNarrativeSelection = createModelSelection(
    ProviderInstanceId.make("codex"),
    "project-narrative-model",
    [{ id: "reasoningEffort", value: "high" }],
  );

  it.effect("looks up narrative with the effective project text-generation selection", () =>
    Effect.gen(function* () {
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const briefingService = yield* ProjectWorkBriefing.ProjectWorkBriefing;
      const narrativeService = yield* ProjectWorkNarrative.ProjectWorkNarrative;
      const briefing = yield* briefingService.generate({
        projectId,
        kind: "standard",
      });
      const environmentSelection = createModelSelection(
        ProviderInstanceId.make("codex"),
        "environment-narrative-model",
      );
      yield* narrativeService.generate({
        projectId,
        kind: briefing.kind,
        briefing,
        modelSelection: projectNarrativeSelection,
        generator: () => Effect.succeed("project-specific narrative"),
      });
      yield* narrativeService.generate({
        projectId,
        kind: briefing.kind,
        briefing,
        modelSelection: environmentSelection,
        generator: () => Effect.succeed("environment narrative"),
      });

      const result = yield* gateway.read({
        projectId,
        operation: "narrative",
        kind: "standard",
      });
      expect(result).toMatchObject({
        narrative: "project-specific narrative",
        narrativeModel: "project-narrative-model",
      });
    }).pipe(
      Effect.provide(
        makeGatewayLayer({
          textGenerationModelSelection: createModelSelection(
            ProviderInstanceId.make("codex"),
            "environment-narrative-model",
          ),
          projectSettingsOverrides: {
            [String(projectId)]: {
              textGenerationModelSelection: projectNarrativeSelection,
            },
          },
        }),
      ),
    ),
  );

  it.effect("rejects sensitive intents from agents without human approval", () =>
    Effect.gen(function* () {
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const result = yield* gateway
        .write(
          {
            type: "project-work.task.cancel",
            commandId: CommandId.make("gateway-cancel"),
            projectId,
            taskId,
            reason: "not approved",
            canceledAt: at,
          },
          { kind: "agent", id: "agent:mcp:provider:session" },
          { kind: "mcp", id: "session" },
        )
        .pipe(
          Effect.as("accepted" as const),
          Effect.catch(() => Effect.succeed("rejected" as const)),
        );
      expect(result).toBe("rejected");
    }).pipe(Effect.provide(gatewayLayer)),
  );

  it.effect("accepts an approved agent protected revision with server attribution", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${String(projectId)}, 'Gateway project', '/workspace/gateway', '[]', ${at}, ${at})
      `;
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const authService = yield* EnvironmentAuth.EnvironmentAuth;
      const criterionId = ProjectWorkCriterionId.make("gateway-protected-criterion");
      const protectedTaskId = ProjectWorkTaskId.make("gateway-protected-task");
      const humanActor = { kind: "human" as const, id: "user:reviewer" };
      const webSource = { kind: "web" as const, id: "reviewer" };
      yield* gateway.write(
        {
          type: "project-work.task.create",
          commandId: CommandId.make("gateway-protected-create"),
          projectId,
          taskId: protectedTaskId,
          title: "Protected task",
          createdAt: at,
        },
        humanActor,
        webSource,
      );
      yield* gateway.write(
        {
          type: "project-work.criterion.upsert",
          commandId: CommandId.make("gateway-protected-criterion"),
          projectId,
          taskId: protectedTaskId,
          criterion: {
            criterionId,
            taskId: protectedTaskId,
            description: "Must ship",
            required: true,
            status: "unsatisfied",
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: at,
          },
          updatedAt: at,
        },
        humanActor,
        webSource,
      );
      const specification = {
        objective: "Ship it",
        scopeIn: "The feature",
        scopeOut: "Everything else",
        criterionIds: [criterionId],
        revision: 1,
        protected: false,
      } as const;
      yield* gateway.write(
        {
          type: "project-work.task.specify",
          commandId: CommandId.make("gateway-protected-specify"),
          projectId,
          taskId: protectedTaskId,
          specification,
          updatedAt: at,
        },
        humanActor,
        webSource,
      );
      yield* gateway.write(
        {
          type: "project-work.task.protect-specification",
          commandId: CommandId.make("gateway-protected-protect"),
          projectId,
          taskId: protectedTaskId,
          specRevision: 1,
          protectedAt: at,
        },
        humanActor,
        webSource,
      );

      const revisedAt = "2026-01-01T00:01:00.000Z";
      const revisedSpecification = {
        ...specification,
        objective: "Ship the protected feature",
        revision: 2,
        protected: true,
      };
      const agentAttribution = {
        actor: { kind: "agent" as const, id: "agent:mcp:codex:session" },
        source: { kind: "mcp" as const, id: "session" },
        recordedAt: revisedAt,
      };
      const approvalSkeleton = {
        approvalId: ProjectWorkApprovalId.make("approval-skeleton"),
        taskId: protectedTaskId,
        specRevision: 2,
        payloadFingerprint: "pending",
        approvedAt: at,
        attribution: {
          actor: { kind: "human" as const, id: "user:reviewer" },
          source: { kind: "web" as const, id: "reviewer" },
          recordedAt: at,
        },
      };
      const intentCommand = {
        type: "project-work.task.revise-protected-specification" as const,
        commandId: CommandId.make("gateway-protected-revise"),
        projectId,
        taskId: protectedTaskId,
        specification: revisedSpecification,
        criterionSnapshots: [
          {
            criterionId,
            taskId: protectedTaskId,
            description: "Must ship",
            required: true,
            status: "unsatisfied" as const,
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: at,
          },
        ],
        affectedResultIds: [],
        approval: approvalSkeleton,
        approvalToken: "approval-token",
        revisedAt,
        attribution: agentAttribution,
      };
      const payloadFingerprint = projectWorkPayloadFingerprint(
        projectWorkProtectedRevisionIntentFingerprintPayload(intentCommand),
      );
      const grant = yield* authService.issueProjectWorkApproval({
        projectId: String(projectId),
        taskId: String(protectedTaskId),
        specRevision: 2,
        payloadFingerprint,
        agentId: "agent:mcp:codex:session",
        approvedBy: { kind: "user", id: "user:reviewer" },
      });
      const result = yield* gateway.write(
        {
          ...intentCommand,
          approvalToken: grant.token,
          approval: grant.approval,
        },
        { kind: "agent", id: "agent:mcp:codex:session" },
        { kind: "mcp", id: "session" },
      );
      expect(result.receipt.status).toBe("accepted");
      expect(result.delta.changedFields).toEqual(["tasks"]);
      const duplicate = yield* gateway.write(
        {
          ...intentCommand,
          approvalToken: grant.token,
          approval: grant.approval,
        },
        { kind: "agent", id: "agent:mcp:codex:session" },
        { kind: "mcp", id: "session" },
      );
      expect(duplicate).toEqual(result);
      expect("state" in result).toBe(false);
      expect("events" in result).toBe(false);
      const receipts = yield* sql<Record<string, unknown>>`
        SELECT result_json AS resultJson FROM project_work_command_receipts
        WHERE project_id = ${String(projectId)} AND command_id = ${"gateway-protected-revise"}
      `;
      expect(receipts[0]?.resultJson).not.toContain("state");
      expect(decodeUnknownJson(String(receipts[0]?.resultJson))).toMatchObject({
        receipt: { status: "accepted", eventCount: 1 },
        delta: {
          projectId: String(projectId),
          revision: result.receipt.revision,
        },
      });
    }).pipe(Effect.provide(gatewayLayer)),
  );

  it.effect(
    "recomputes a human protected revision fingerprint after attribution normalization",
    () =>
      Effect.gen(function* () {
        const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
        const humanActor = { kind: "human" as const, id: "user:reviewer" };
        const webSource = { kind: "web" as const, id: "reviewer" };
        const humanProjectId = ProjectId.make("gateway-human-protected-project");
        const humanTaskId = ProjectWorkTaskId.make("gateway-human-protected-task");
        const criterionId = ProjectWorkCriterionId.make("gateway-human-protected-criterion");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES (${String(humanProjectId)}, 'Human project', '/workspace/human', '[]', ${at}, ${at})
        `;
        yield* gateway.write(
          {
            type: "project-work.task.create",
            commandId: CommandId.make("gateway-human-protected-create"),
            projectId: humanProjectId,
            taskId: humanTaskId,
            title: "Human protected task",
            createdAt: at,
          },
          humanActor,
          webSource,
        );
        const criterion = {
          criterionId,
          taskId: humanTaskId,
          description: "Must ship",
          required: true,
          status: "unsatisfied" as const,
          satisfiedByEvidenceIds: [],
          revision: 0,
          updatedAt: at,
        };
        yield* gateway.write(
          {
            type: "project-work.criterion.upsert",
            commandId: CommandId.make("gateway-human-protected-criterion"),
            projectId: humanProjectId,
            taskId: humanTaskId,
            criterion,
            updatedAt: at,
          },
          humanActor,
          webSource,
        );
        const specification = {
          objective: "Ship it",
          scopeIn: "The feature",
          scopeOut: "Everything else",
          criterionIds: [criterionId],
          revision: 1,
          protected: false,
        } as const;
        yield* gateway.write(
          {
            type: "project-work.task.specify",
            commandId: CommandId.make("gateway-human-protected-specify"),
            projectId: humanProjectId,
            taskId: humanTaskId,
            specification,
            updatedAt: at,
          },
          humanActor,
          webSource,
        );
        yield* gateway.write(
          {
            type: "project-work.task.protect-specification",
            commandId: CommandId.make("gateway-human-protected-protect"),
            projectId: humanProjectId,
            taskId: humanTaskId,
            specRevision: 1,
            protectedAt: at,
          },
          humanActor,
          webSource,
        );
        const revisedSpecification = {
          ...specification,
          objective: "Ship the protected feature",
          revision: 2,
          protected: true,
        } as const;
        const command = {
          type: "project-work.task.revise-protected-specification" as const,
          commandId: CommandId.make("gateway-human-protected-revise"),
          projectId: humanProjectId,
          taskId: humanTaskId,
          specification: revisedSpecification,
          criterionSnapshots: [criterion],
          affectedResultIds: [],
          approval: {
            approvalId: ProjectWorkApprovalId.make("gateway-human-protected-approval"),
            taskId: humanTaskId,
            specRevision: 2,
            payloadFingerprint: "pending",
            approvedAt: at,
            attribution: {
              actor: humanActor,
              source: webSource,
              recordedAt: at,
            },
          },
          revisedAt: "2026-01-01T00:01:00.000Z",
          attribution: {
            actor: humanActor,
            source: webSource,
            recordedAt: at,
          },
        };
        const result = yield* gateway.write(
          {
            ...command,
            approval: {
              ...command.approval,
              payloadFingerprint: projectWorkPayloadFingerprint(
                projectWorkProtectedRevisionIntentFingerprintPayload(command),
              ),
            },
          },
          humanActor,
          webSource,
        );
        expect(result.receipt.status).toBe("accepted");
        expect(result.delta.revision).toBe(result.receipt.revision);
        yield* gateway.write(
          {
            type: "project-work.task.create",
            commandId: CommandId.make("gateway-human-protected-later"),
            projectId: humanProjectId,
            taskId: ProjectWorkTaskId.make("gateway-human-protected-later-task"),
            title: "Later human task",
            createdAt: at,
          },
          humanActor,
          webSource,
        );
        const duplicate = yield* gateway.write(
          {
            ...command,
            approval: {
              ...command.approval,
              payloadFingerprint: projectWorkPayloadFingerprint(
                projectWorkProtectedRevisionIntentFingerprintPayload(command),
              ),
            },
          },
          humanActor,
          webSource,
        );
        expect(duplicate).toEqual(result);
      }).pipe(Effect.provide(gatewayLayer)),
  );
});
