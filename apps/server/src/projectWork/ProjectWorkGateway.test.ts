import * as NodeCrypto from "node:crypto";
import { ProjectLifecycle, ProjectLifecycleLive } from "../project/ProjectLifecycle.ts";
import {
  ProjectTeamRecord,
  ProjectTeamRecordRead,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkWriteResult,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkApprovalId,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
  ProjectWorkAttemptId,
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
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as TeamAuthorization from "./ProjectTeamAuthorization.ts";
import {
  seed as seedTeam,
  decodeRecord as decodeTeamFixture,
  createManagedAssignment,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { projectTeamSpecificationHash } from "./ProjectTeamPolicy.ts";
import * as ProjectWorkBriefing from "./ProjectWorkBriefing.ts";
import * as ProjectWorkGateway from "./ProjectWorkGateway.ts";
import * as ProjectWorkNarrative from "./ProjectWorkNarrative.ts";
import * as ProjectWorkProjection from "./ProjectWorkProjection.ts";
import * as ProjectWorkQuery from "./ProjectWorkQuery.ts";
import * as ProjectWorkRepository from "./ProjectWorkRepository.ts";
import * as ProjectWorkSearch from "./ProjectWorkSearch.ts";
import * as ServerSettings from "../serverSettings.ts";
import { bindIssueRepositoryProject } from "./ProjectIssueRepositoryState.ts";

const decodeWriteResult = Schema.decodeUnknownEffect(ProjectWorkWriteResult);
const decodeFoundationCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const decodeFoundationPage = Schema.decodeUnknownEffect(
  Schema.Struct({ items: Schema.Array(ProjectTeamRecordRead) }),
);
const decodeTeamRecord = Schema.decodeUnknownEffect(ProjectTeamRecord);

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
  TeamAuthorization.layer,
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
  it.effect("denies internal foundation writes while negotiating new reads and V2 export", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${String(projectId)}, 'Gateway project', '/workspace/gateway', '[]', ${at}, ${at})`;
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const repo = yield* ProjectWorkRepository.ProjectWorkRepository;
      const mission = yield* decodeTeamRecord({
        kind: "mission",
        recordId: "gateway-mission",
        projectId,
        revision: 0,
        generation: 0,
        updatedAt: at,
        status: "draft",
        title: "Mission",
        objective: "Bounded",
        requiredTaskIds: [],
      });
      const command = yield* decodeFoundationCommit({
        type: "project-work.foundation.commit",
        commandId: "gateway-foundation",
        projectId,
        expectedRevision: 0,
        attribution: {
          actor: { kind: "system", id: "foundation" },
          source: { kind: "system", id: "foundation" },
          recordedAt: at,
        },
        records: [mission],
        committedAt: at,
      });
      for (const actor of [
        { kind: "human", id: "human" },
        { kind: "agent", id: "agent" },
      ] as const) {
        expect(
          (yield* gateway.write(command, actor, { kind: "web", id: actor.id }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      }
      expect(
        (yield* sql`SELECT * FROM project_work_events WHERE project_id = ${projectId}`).length,
      ).toBe(0);
      yield* repo.execute(command);
      yield* repo.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("gateway-legacy"),
        projectId,
        taskId,
        title: "Ordinary",
        createdAt: at,
      });
      expect(
        yield* gateway.read({ projectId, operation: "foundation-records", limit: 1 }),
      ).toMatchObject({
        projectId,
        revision: 2,
        items: [{ kind: "mission", recordId: "gateway-mission" }],
      });
      const v1 = yield* gateway.read({ projectId, operation: "export-json", includeHistory: true });
      expect(v1).toMatchObject({ schemaVersion: 1, tasks: [{ taskId }] });
      expect(v1).not.toHaveProperty("foundationRecords");
      expect(encodeUnknownJson(v1)).not.toContain("project-work.foundation.recorded");
      const v2 = yield* gateway.read({
        projectId,
        operation: "export-json",
        includeHistory: true,
        exportVersion: 2,
      });
      expect(v2).toMatchObject({
        schemaVersion: 2,
        tasks: [{ taskId }],
        foundationRecords: [{ recordId: "gateway-mission" }],
      });
      expect(encodeUnknownJson(v2)).toContain("project-work.foundation.recorded");
    }).pipe(Effect.provide(gatewayLayer)),
  );

  it.effect(
    "preserves all known foundation variants and numeric budgets while removing credentials",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
        const attribution = {
          actor: { kind: "system", id: "foundation" },
          source: { kind: "system", id: "foundation" },
          recordedAt: at,
        };
        const variants = [
          {
            kind: "mission",
            status: "draft",
            title: "Mission",
            objective: "Scope",
            requiredTaskIds: [],
          },
          {
            kind: "task-membership",
            status: "active",
            taskId,
            executionKind: "managed",
            deliverableKind: "code",
          },
          {
            kind: "role-revision",
            status: "available",
            roleId: "role",
            roleRevision: 0,
            role: "implementer",
            instructions: "Work",
            skills: [],
            tools: [],
            model: "ling",
            memoryAccess: "project",
            delegationDepth: 2,
          },
          {
            kind: "member",
            status: "active",
            name: "Worker",
            coordinator: false,
            roleRevisionId: "role",
          },
          {
            kind: "plan-revision",
            status: "proposed",
            taskId,
            specRevision: 0,
            planRevision: 0,
            content: "Plan",
            contentHash: "hash",
            dependencyTaskIds: [],
          },
          {
            kind: "gate",
            status: "pending",
            taskId,
            gate: "plan",
            specRevision: 0,
            planRevision: 0,
            contentHash: "hash",
            attribution,
            evidenceIds: [],
          },
          {
            kind: "run-binding",
            status: "running",
            taskId,
            attemptId: "attempt",
            memberId: "member",
            roleRevisionId: "role",
            providerInstanceId: "pi",
            threadId: "thread",
            environmentId: "environment",
            model: "ling",
            configuration: {
              instructionsHash: "hash",
              toolIds: [],
              skillIds: [],
              runtimeVersion: "0.99.1",
              maxTokens: 1000,
              maxDurationMs: 1000,
              paidFallback: false,
            },
            worktree: "/workspace",
            branch: "branch",
            leaseGeneration: 0,
            specRevision: 0,
            planRevision: 0,
          },
          {
            kind: "message",
            status: "delivered",
            commandId: "command",
            senderId: "sender",
            recipientId: "recipient",
            taskId,
            body: "Finding",
            evidenceIds: [],
            deliveryGeneration: 0,
            deliveryCursor: 1,
          },
          {
            kind: "question",
            status: "pending",
            taskId,
            senderId: "sender",
            targetGateId: "gate",
            targetRevision: 0,
            body: "Which?",
            choices: [],
          },
          {
            kind: "evidence-applicability",
            status: "current",
            taskId,
            evidenceId: "evidence",
            specRevision: 0,
            planRevision: 0,
            repository: "repo",
            worktree: "/workspace",
            testedTree: "tree",
            baseSha: "base",
            headSha: "head",
            command: "test",
            exitCode: 0,
            artifactId: "artifact",
            environmentSummary: "Linux",
            integration: false,
          },
          {
            kind: "repair-episode",
            status: "active",
            taskId,
            failureFingerprint: "failure",
            relevantRevision: "tree",
            allowance: 2,
            semanticRepairs: 0,
            transportRetries: 0,
            timeoutCount: 0,
            attemptIds: [],
          },
          {
            kind: "limits",
            status: "configured",
            environmentModelCalls: 2,
            projectWritableWorkers: 1,
            modelCalls: 2,
            delegationDepth: 2,
            repairAllowance: 2,
            model: "ling",
            tokenLimit: 1000,
            durationLimitMs: 1000,
          },
          {
            kind: "reservation",
            status: "held",
            environmentId: "environment",
            scope: "environment",
            resourceKey: "model",
            slot: 0,
            runId: "run",
            taskId,
            attemptId: "attempt",
            maximumTokens: 1000,
            consumedTokens: 321,
          },
          {
            kind: "effect",
            status: "pending",
            effectId: "effect",
            effectKind: "publication",
            targetId: "issue",
            payload: { recordIds: [], expectedRevision: 0 },
            claimGeneration: 0,
            availableAt: at,
          },
          {
            kind: "issue",
            status: "open",
            identity: {
              host: "github.com",
              repositoryNodeId: "repo",
              issueNodeId: "issue",
              number: 1,
            },
            repositoryName: "owner/repo",
            title: "Issue",
            body: "Scope",
            sourceRevision: "revision",
            observedAt: at,
          },
          {
            kind: "intake-cursor",
            status: "ready",
            host: "github.com",
            repositoryNodeId: "repo",
            accountId: "account",
            overlapSince: at,
          },
          {
            kind: "memory-source",
            status: "current",
            sourceKind: "finding",
            sourceId: "artifact",
            sourceRevision: 1,
            content: "Finding",
            contentHash: "hash",
            attribution,
            sharedWithProjectIds: [],
          },
          {
            kind: "memory-extraction",
            status: "extracted",
            engine: "mem0",
            engineVersion: "2.2.1",
            sourceId: "source",
            sourceRevision: 1,
            sourceGeneration: 0,
            extractionModel: "ling",
            embeddingModel: "nvidia",
            embeddingDimensions: 2048,
            expectedObservationIds: ["observation"],
            completedObservationIds: [],
            extractionHash: "hash",
          },
          {
            kind: "memory-observation",
            status: "current",
            sourceId: "source",
            sourceRevision: 1,
            sourceGeneration: 0,
            extractionId: "extraction",
            observationKey: "one",
            body: "Finding",
            provenance: attribution,
          },
        ];
        const expected = [];
        for (const variant of variants) {
          const record = yield* decodeTeamRecord({
            ...variant,
            recordId: "public-" + variant.kind,
            projectId,
            revision: 0,
            generation: 0,
            updatedAt: at,
          });
          expected.push(record);
          const payload = encodeUnknownJson({
            ...record,
            credentials: { password: "private-value" },
            apiKey: "private-key",
            authToken: "private-token",
            extra: { tokenLimit: "credential-shaped-string", secret: "private-secret" },
          });
          yield* sql`INSERT INTO ${sql("project_team_" + record.kind.replaceAll("-", "_"))} (record_id, project_id, status, revision, generation, updated_at, payload_json) VALUES (${record.recordId}, ${projectId}, ${record.status}, 0, 0, ${at}, ${payload})`;
        }
        const publicPage = yield* gateway.read({
          projectId,
          operation: "foundation-records",
          limit: 128,
        });
        const page = yield* decodeFoundationPage(publicPage);
        expect(page.items).toHaveLength(19);
        for (const record of expected)
          expect(page.items.find((entry) => entry.recordId === record.recordId)).toEqual(record);
        const encoded = encodeUnknownJson(publicPage);
        for (const secret of [
          "private-value",
          "private-key",
          "private-token",
          "private-secret",
          "credential-shaped-string",
        ])
          expect(encoded).not.toContain(secret);
        const credential = "ghp_" + "0123456789abcdef".repeat(3);
        const mission = expected.find((entry) => entry.kind === "mission")!;
        yield* sql`UPDATE project_team_mission SET payload_json = ${encodeUnknownJson({ ...mission, objective: "Legacy secret " + credential })} WHERE record_id = ${mission.recordId}`;
        const redactedPage = yield* gateway.read({
          projectId,
          operation: "foundation-records",
          recordKinds: ["mission"],
        });
        expect(encodeUnknownJson(redactedPage)).not.toContain(credential);
        expect(redactedPage).toMatchObject({
          items: [{ objective: "Legacy secret [REDACTED_SECRET]" }],
        });
      }).pipe(Effect.provide(gatewayLayer)),
  );

  it.effect("does not expose deleted foundation records through the public gateway", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const repo = yield* ProjectWorkRepository.ProjectWorkRepository;
      const lifecycle = yield* ProjectLifecycle;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Project', '/workspace', '[]', ${at}, ${at})`;
      const attribution = {
        actor: { kind: "system", id: "foundation" },
        source: { kind: "system", id: "foundation" },
        recordedAt: at,
      };
      const mission = yield* decodeTeamRecord({
        kind: "mission",
        recordId: "gateway-deleted-mission",
        projectId,
        status: "draft",
        revision: 0,
        generation: 0,
        updatedAt: at,
        title: "Mission",
        objective: "Scope",
        requiredTaskIds: [],
      });
      const command = yield* decodeFoundationCommit({
        type: "project-work.foundation.commit",
        commandId: "gateway-deleted-command",
        projectId,
        expectedRevision: 0,
        attribution,
        records: [mission],
        committedAt: at,
      });
      yield* repo.execute(command);
      expect(yield* gateway.read({ projectId, operation: "foundation-records" })).toMatchObject({
        items: [mission],
      });
      yield* lifecycle.permanentDelete({
        projectId,
        commandId: CommandId.make("gateway-delete"),
        workspaceRoot: "/workspace",
        confirmation: "permanent-local-delete",
      });
      expect(yield* gateway.read({ projectId, operation: "foundation-records" })).toMatchObject({
        revision: 0,
        items: [],
      });
      expect((yield* repo.execute(command).pipe(Effect.result))._tag).toBe("Failure");
      yield* (yield* ProjectWorkProjection.ProjectWorkProjection).rebuild(String(projectId));
      expect(yield* gateway.read({ projectId, operation: "foundation-records" })).toMatchObject({
        items: [],
      });
    }).pipe(Effect.provide(ProjectLifecycleLive.pipe(Layer.provideMerge(gatewayLayer)))),
  );

  for (const timing of [
    "after",
    "repository-after",
    "before",
    "receipt-only",
    "legacy-event",
  ] as const) {
    it.effect(
      `rejects cursor transfer command ID collisions ${timing} deletion through the public gateway`,
      () =>
        Effect.gen(function* () {
          yield* runMigrations();
          const sql = yield* SqlClient.SqlClient;
          const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
          const repo = yield* ProjectWorkRepository.ProjectWorkRepository;
          const lifecycle = yield* ProjectLifecycle;
          const owner = ProjectId.make("collision-owner-" + timing);
          const survivor = ProjectId.make("collision-survivor-" + timing);
          const deleteId = CommandId.make("collision-delete-" + timing);
          const cursorId = "collision-cursor-" + timing;
          const transferId =
            "project-delete-transfer:" +
            NodeCrypto.createHash("sha256")
              .update(encodeUnknownJson([owner, deleteId, survivor, cursorId]))
              .digest("hex");
          for (const id of [owner, survivor])
            yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${id}, 'Project', '/workspace', '[]', ${at}, ${at})`;
          // Persisted bindings, rather than imported issue projections, own intake.
          yield* bindIssueRepositoryProject(sql, {
            key: { host: "github.com", repositoryNodeId: "collision-repo-" + timing },
            projectId: survivor,
            accountNodeId: "same-account",
            repositoryName: "owner/repo",
            credentialEpoch: "collision-verified-epoch",
            since: "2026-01-01T00:00:00Z",
            expectedBindingRevision: null,
          });
          const cursor = yield* decodeTeamRecord({
            kind: "intake-cursor",
            recordId: cursorId,
            projectId: owner,
            status: "ready",
            revision: 0,
            generation: 0,
            updatedAt: at,
            host: "github.com",
            repositoryNodeId: "collision-repo-" + timing,
            accountId: "same-account",
            cursor: "page-three",
            etag: "same-etag",
            overlapSince: at,
          });
          const issue = yield* decodeTeamRecord({
            kind: "issue",
            recordId: "collision-issue-" + timing,
            projectId: survivor,
            status: "open",
            revision: 0,
            generation: 0,
            updatedAt: at,
            identity: {
              host: "github.com",
              repositoryNodeId: "collision-repo-" + timing,
              issueNodeId: "collision-issue-" + timing,
              number: 1,
            },
            repositoryName: "owner/repo",
            title: "Issue",
            body: "Scope",
            sourceRevision: "one",
            observedAt: at,
          });
          const attribution = {
            actor: { kind: "system", id: "foundation" },
            source: { kind: "system", id: "foundation" },
            recordedAt: at,
          };
          for (const r of [cursor, issue])
            yield* repo.execute(
              yield* decodeFoundationCommit({
                type: "project-work.foundation.commit",
                projectId: r.projectId,
                commandId: r.recordId,
                expectedRevision: 0,
                attribution,
                records: [r],
                committedAt: at,
              }),
            );
          const caller = {
            type: "project-work.task.create" as const,
            commandId: CommandId.make(transferId),
            projectId: survivor,
            taskId: ProjectWorkTaskId.make("caller-task-" + timing),
            title: "Caller intent",
            createdAt: at,
          };
          const actor = { kind: "human" as const, id: "collision-human" };
          const source = { kind: "web" as const, id: actor.id };
          if (timing !== "after" && timing !== "repository-after") {
            const created = yield* gateway.write(caller, actor, source);
            expect(created.receipt.eventCount).toBe(1);
            if (timing === "receipt-only")
              yield* sql`DELETE FROM project_work_events WHERE project_id = ${survivor} AND command_id = ${transferId}`;
            if (timing === "legacy-event")
              yield* sql`DELETE FROM project_work_command_receipts WHERE project_id = ${survivor} AND command_id = ${transferId}`;
          }
          const deletion = lifecycle.permanentDelete({
            projectId: owner,
            commandId: deleteId,
            workspaceRoot: "/workspace",
            confirmation: "permanent-local-delete",
          });
          if (timing === "after" || timing === "repository-after") {
            yield* deletion;
            const receiptRows = yield* sql<{
              payloadFingerprint: string;
              actorKind: string;
              actorId: string;
              sourceKind: string;
              sourceId: string;
              resultJson: string;
            }>`SELECT payload_fingerprint AS payloadFingerprint, actor_kind AS actorKind, actor_id AS actorId, source_kind AS sourceKind, source_id AS sourceId, result_json AS resultJson FROM project_work_command_receipts WHERE project_id = ${survivor} AND command_id = ${transferId}`;
            expect(receiptRows).toHaveLength(1);
            expect(receiptRows[0]).toMatchObject({
              actorKind: "system",
              actorId: "project-lifecycle",
              sourceKind: "system",
              sourceId: transferId.slice("project-delete-transfer:".length),
            });
            expect(receiptRows[0]!.payloadFingerprint).not.toBe(
              projectWorkPayloadFingerprint(caller),
            );
            const internalResult = yield* decodeWriteResult(
              decodeUnknownJson(receiptRows[0]!.resultJson),
            );
            expect(internalResult).toMatchObject({
              projectId: survivor,
              revision: 2,
              receipt: { commandId: transferId, eventCount: 1, revision: 2 },
              delta: { revision: 2, changedFields: ["foundationRecords"] },
            });
            expect(internalResult.delta.eventIds).toEqual(
              (yield* repo.replay(survivor)).slice(-1).map((event) => event.eventId),
            );
            if (timing === "repository-after")
              expect((yield* repo.execute(caller).pipe(Effect.result))._tag).toBe("Failure");
            for (const kind of ["human", "agent"] as const) {
              expect(
                (yield* gateway
                  .write(
                    caller,
                    { kind, id: "collision-" + kind },
                    { kind: "web", id: "collision-" + kind },
                  )
                  .pipe(Effect.result))._tag,
              ).toBe("Failure");
            }
            let authorized = 0;
            expect(
              (yield* repo
                .executeAuthorized(caller, () => {
                  authorized++;
                  return Effect.succeed(caller);
                })
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect(authorized).toBe(0);
            expect(
              (yield* sql`SELECT * FROM project_work_tasks WHERE task_id = ${caller.taskId}`)
                .length,
            ).toBe(0);
            expect(
              (yield* sql`SELECT * FROM project_work_events WHERE project_id = ${survivor} AND command_id = ${transferId}`)
                .length,
            ).toBe(1);
            yield* deletion;
            expect(
              (yield* sql`SELECT * FROM project_work_events WHERE project_id = ${survivor} AND command_id = ${transferId}`)
                .length,
            ).toBe(1);
          } else {
            expect((yield* deletion.pipe(Effect.result))._tag).toBe("Failure");
            expect(
              yield* gateway.read({
                projectId: owner,
                operation: "foundation-records",
                recordKinds: ["intake-cursor"],
              }),
            ).toMatchObject({ items: [cursor] });
            expect(
              (yield* sql`SELECT * FROM project_lifecycle WHERE project_id = ${owner}`).length,
            ).toBe(0);
            expect((yield* repo.replay(owner)).length).toBe(1);
            expect((yield* repo.replay(survivor)).length).toBe(timing === "receipt-only" ? 1 : 2);
            if (timing === "receipt-only") return;
            if (timing === "before") {
              expect(
                yield* gateway
                  .write(caller, { kind: "human", id: "other-human" }, source)
                  .pipe(Effect.result),
              ).toMatchObject({ _tag: "Failure" });
            }
            const duplicate = yield* gateway.write(caller, actor, source);
            expect(duplicate.receipt.eventCount).toBe(1);
            expect(duplicate.delta.eventIds).toHaveLength(1);
            expect(
              (yield* sql`SELECT * FROM project_work_events WHERE project_id = ${survivor} AND command_id = ${transferId}`)
                .length,
            ).toBe(1);
          }
        }).pipe(Effect.provide(ProjectLifecycleLive.pipe(Layer.provideMerge(gatewayLayer)))),
    );
  }

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

it.effect(
  "attributes typed gate responses and answers, rejects forged actor and two-device revision races",
  () =>
    Effect.gen(function* () {
      const f = yield* seedTeam();
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const projectId = f.principal.managed.projectId;
      const taskId = (yield* f.auth.resolve(f.principal))!.binding.taskId;
      const gate = decodeTeamFixture({
        kind: "gate",
        projectId,
        recordId: "gate",
        revision: 0,
        generation: 0,
        updatedAt: at,
        status: "pending",
        taskId,
        gate: "specification",
        specRevision: 1,
        planRevision: 0,
        contentHash: projectTeamSpecificationHash(
          (yield* f.auth.resolve(f.principal))!.state,
          taskId,
        ),
        attribution: {
          actor: { kind: "human", id: "owner" },
          source: { kind: "web", id: "owner" },
          recordedAt: at,
        },
        evidenceIds: [],
      });
      yield* f.change(gate);
      const state = (yield* f.auth.resolve(f.principal))!.state;
      const input = {
        type: "project-team.gate.respond" as const,
        commandId: CommandId.make("gate-response"),
        projectId,
        taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks[0]!.revision,
        specRevision: 1,
        planRevision: 0,
        gateId: "gate",
        expectedGateRevision: 0,
        response: "approved" as const,
      };
      expect(
        (yield* gateway
          .write(input, f.principal.actor, { kind: "mcp", id: "agent" }, f.principal)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const actor = { kind: "human" as const, id: "owner" };
      const source = { kind: "web" as const, id: "owner" };
      const race = yield* Effect.all(
        [
          gateway.write(input, actor, source).pipe(Effect.result),
          gateway
            .write({ ...input, commandId: CommandId.make("other-device-answer") }, actor, {
              kind: "mobile",
              id: "owner",
            })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(race.filter((result) => result._tag === "Success")).toHaveLength(1);
      const winner =
        race[0]!._tag === "Success"
          ? { input, source }
          : {
              input: { ...input, commandId: CommandId.make("other-device-answer") },
              source: { kind: "mobile" as const, id: "owner" },
            };
      const { gateId, ...reorderedInput } = winner.input;
      const replay = yield* gateway.write({ gateId, ...reorderedInput }, actor, winner.source);
      expect(replay.receipt.eventCount).toBe(1);
      expect(
        (yield* gateway
          .write(winner.input, { kind: "human", id: "wrong-actor" }, winner.source)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const question = decodeTeamFixture({
        kind: "question",
        projectId,
        recordId: "question",
        revision: 0,
        generation: 0,
        updatedAt: at,
        status: "pending",
        taskId,
        senderId: "member",
        targetGateId: "gate",
        targetRevision: 1,
        body: "Continue?",
        choices: ["yes", "no"],
      });
      yield* f.change(question);
      const current = (yield* f.auth.resolve(f.principal))!.state;
      const answer = {
        type: "project-team.question.answer" as const,
        commandId: CommandId.make("answer-question"),
        projectId,
        taskId,
        expectedRevision: current.revision,
        expectedTaskRevision: current.tasks[0]!.revision,
        specRevision: 1,
        planRevision: 0,
        questionId: "question",
        expectedQuestionRevision: 0,
        expectedGateRevision: 1,
        answer: "yes",
      };
      const answered = yield* gateway.write(answer, actor, source);
      expect((yield* gateway.write(answer, actor, source)).receipt).toEqual(answered.receipt);
      expect(
        (yield* gateway
          .write(
            { ...answer, commandId: CommandId.make("different-answer"), answer: "no" },
            actor,
            source,
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const context = yield* gateway.read(
        { projectId, taskId, operation: "task-context" },
        f.principal,
      );
      expect(context).toMatchObject({
        task: { taskId },
        criteria: expect.any(Array),
        evidence: expect.any(Array),
      });
      expect(containsObjectKey(context, "knowledge")).toBe(false);
      expect(containsObjectKey(context, "memory-source")).toBe(false);
      expect(
        (yield* gateway
          .read(
            { projectId, operation: "foundation-records", recordKinds: ["memory-source"] },
            f.principal,
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(gatewayLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect(
  "records delegation intent without dispatch and binds typed receipts to target, actor and current run",
  () =>
    Effect.gen(function* () {
      const f = yield* seedTeam("coordinator");
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      yield* f.change(
        decodeTeamFixture({
          ...f.member,
          recordId: "recipient",
          name: "Recipient",
          coordinator: false,
        }),
      );
      const getInput = Effect.gen(function* () {
        const state = (yield* f.auth.resolve(f.principal))!.state;
        return {
          type: "project-team.delegation.request" as const,
          projectId: f.principal.managed.projectId,
          taskId: state.tasks[0]!.taskId,
          commandId: CommandId.make("delegation"),
          expectedRevision: state.revision,
          expectedTaskRevision: state.tasks[0]!.revision,
          specRevision: 1,
          planRevision: 1,
          requestId: "request",
          recipientId: "recipient",
          objective: "Investigate assigned scope",
        };
      });
      const input = yield* getInput;
      const source = { kind: "mcp" as const, id: "caller", uri: "mcp://old-session" };
      expect(
        (yield* gateway
          .write(
            {
              ...input,
              commandId: CommandId.make("secret-request"),
              objective: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
            },
            f.principal.actor,
            source,
            f.principal,
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const written = yield* gateway.write(input, f.principal.actor, source, f.principal);
      expect(
        (yield* gateway.write(
          input,
          f.principal.actor,
          { ...source, uri: "mcp://renewed-session" },
          f.principal,
        )).receipt,
      ).toEqual(written.receipt);
      const state = (yield* f.auth.resolve(f.principal))!.state;
      expect(state.foundationRecords?.find((r) => r.recordId === "request")).toMatchObject({
        kind: "message",
        status: "queued",
        senderId: "member",
        recipientId: "recipient",
        body: input.objective,
      });
      expect(state.foundationRecords?.some((r) => r.kind === "effect")).toBe(false);
      expect(
        (yield* gateway
          .write(
            {
              type: "project-work.task.create",
              commandId: input.commandId,
              projectId: input.projectId,
              taskId: ProjectWorkTaskId.make("lost-task"),
              title: "Must not falsely replay",
              createdAt: at,
            },
            { kind: "human", id: "owner" },
            { kind: "web", id: "owner" },
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const message = state.foundationRecords!.find((r) => r.recordId === "request")!;
      yield* f.change(decodeTeamFixture({ ...message, revision: 1, status: "delivered" }));
      expect(
        (yield* gateway.write(input, f.principal.actor, source, f.principal).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      yield* f.change(
        decodeTeamFixture({ ...f.binding, revision: f.binding.revision + 1, status: "revoked" }),
      );
      expect(
        (yield* gateway.write(input, f.principal.actor, source, f.principal).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(Layer.fresh(gatewayLayer).pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect(
  "promotes immutable sourced memory to attributed knowledge and denies stale provenance replay",
  () =>
    Effect.gen(function* () {
      const f = yield* seedTeam();
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const projectId = f.principal.managed.projectId;
      const attribution = {
        actor: { kind: "system", id: "memory" },
        source: { kind: "system", id: "memory" },
        recordedAt: at,
      };
      const common = { projectId, revision: 0, generation: 0, updatedAt: at };
      const source = decodeTeamFixture({
        ...common,
        kind: "memory-source",
        recordId: "source",
        status: "current",
        sourceKind: "finding",
        sourceId: "finding",
        sourceRevision: 0,
        content: "Finding",
        contentHash: "hash",
        attribution,
        sharedWithProjectIds: [],
      });
      yield* f.change(source);
      const extraction = decodeTeamFixture({
        ...common,
        kind: "memory-extraction",
        recordId: "extraction",
        status: "extracted",
        engine: "mem0",
        engineVersion: "2.2.1",
        sourceId: "source",
        sourceRevision: 0,
        sourceGeneration: 0,
        extractionModel: "test",
        extractionHash: "frozen-hash",
        embeddingModel: "test",
        embeddingDimensions: 2048,
        expectedObservationIds: ["observation"],
        completedObservationIds: ["observation"],
      });
      yield* f.change(extraction);
      const observation = decodeTeamFixture({
        ...common,
        kind: "memory-observation",
        recordId: "observation",
        status: "current",
        sourceId: "source",
        sourceRevision: 0,
        sourceGeneration: 0,
        extractionId: "extraction",
        observationKey: "finding",
        body: "Finding",
        provenance: attribution,
      });
      yield* f.change(observation);
      const state = (yield* f.auth.resolve(f.principal))!.state;
      const input = {
        type: "project-team.memory.promote" as const,
        projectId,
        taskId: state.tasks[0]!.taskId,
        commandId: CommandId.make("memory-promotion"),
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks[0]!.revision,
        specRevision: 1,
        planRevision: 1,
        observationId: "observation",
        expectedObservationRevision: 0,
        expectedSourceRevision: 0,
        knowledgeId: "accepted-finding",
        title: "Accepted finding",
      };
      expect(
        (yield* gateway
          .write(input, f.principal.actor, { kind: "mcp", id: "caller" }, f.principal)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const actor = { kind: "human" as const, id: "reviewer" };
      const transport = { kind: "mobile" as const, id: "reviewer" };
      const receipt = yield* gateway.write(input, actor, transport);
      expect((yield* gateway.write(input, actor, transport)).receipt).toEqual(receipt.receipt);
      const current = (yield* f.auth.resolve(f.principal))!.state;
      expect(current.knowledge?.find((k) => k.knowledgeId === "accepted-finding")).toMatchObject({
        body: "Finding",
        sourceId: "observation",
        attribution: { actor, source: transport },
      });
      expect(current.foundationRecords?.find((r) => r.recordId === "observation")).toEqual(
        observation,
      );
      yield* f.change(
        decodeTeamFixture({
          ...source,
          revision: 1,
          generation: 1,
          content: "Changed",
          contentHash: "new-hash",
        }),
      );
      expect((yield* gateway.write(input, actor, transport).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }).pipe(Effect.provide(Layer.fresh(gatewayLayer).pipe(Layer.provideMerge(NodeServices.layer)))),
);

for (const missing of ["roleTools", "toolIds"] as const)
  it.effect(`denies delegation when the frozen ${missing} grant is absent`, () =>
    Effect.gen(function* () {
      const f = yield* seedTeam("coordinator", "running", {
        [missing]: ["project-work.read-project"],
      });
      yield* f.change(
        decodeTeamFixture({
          ...f.member,
          recordId: "recipient",
          name: "Recipient",
          coordinator: false,
        }),
      );
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const state = (yield* f.auth.resolve(f.principal))!.state;
      const input = {
        type: "project-team.delegation.request" as const,
        commandId: CommandId.make("denied-delegate"),
        projectId: f.principal.managed.projectId,
        taskId: state.tasks[0]!.taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks[0]!.revision,
        specRevision: 1,
        planRevision: 1,
        requestId: "request",
        recipientId: "recipient",
        objective: "Investigate",
      };
      expect(
        (yield* gateway
          .write(input, f.principal.actor, { kind: "mcp", id: "caller" }, f.principal)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* f.auth.resolve(f.principal))!.state.revision).toBe(state.revision);
    }).pipe(Effect.provide(Layer.fresh(gatewayLayer).pipe(Layer.provideMerge(NodeServices.layer)))),
  );

it.effect(
  "prevents managed criteria, lease and completion policy mutations while allowing an exact-lease checkpoint",
  () =>
    Effect.gen(function* () {
      const f = yield* seedTeam("implementer");
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const state = (yield* f.auth.resolve(f.principal))!.state;
      const projectId = f.principal.managed.projectId;
      const taskId = state.tasks[0]!.taskId;
      const attemptId = ProjectWorkAttemptId.make("attempt");
      const source = { kind: "mcp" as const, id: "caller" };
      const commands = [
        {
          type: "project-work.criterion.upsert" as const,
          commandId: CommandId.make("scope-bypass"),
          projectId,
          taskId,
          criterion: {
            ...state.criteria[0]!,
            description: "Weakened approved criterion",
            revision: 1,
          },
          updatedAt: at,
        },
        {
          type: "project-work.attempt.renew" as const,
          commandId: CommandId.make("lease-bypass"),
          projectId,
          taskId,
          attemptId,
          leaseToken: "binding-lease",
          leasedUntil: "2035-01-01T00:00:00.000Z",
          renewedAt: at,
        },
        {
          type: "project-work.task.complete" as const,
          commandId: CommandId.make("completion-bypass"),
          projectId,
          taskId,
          attemptId,
          leaseToken: "binding-lease",
          satisfiedCriterionIds: [],
          completedAt: at,
        },
      ];
      for (const command of commands)
        expect(
          (yield* gateway
            .write(command, f.principal.actor, source, f.principal)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      expect((yield* f.auth.resolve(f.principal))!.state.revision).toBe(state.revision);
      const checkpoint = {
        type: "project-work.attempt.checkpoint" as const,
        commandId: CommandId.make("checkpoint"),
        projectId,
        taskId,
        attemptId,
        leaseToken: "binding-lease",
        checkpointId: "checkpoint",
        capturedAt: at,
      };
      expect(
        (yield* gateway
          .write(
            { ...checkpoint, commandId: CommandId.make("bad-lease"), leaseToken: "forged" },
            f.principal.actor,
            source,
            f.principal,
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* gateway.write(checkpoint, f.principal.actor, source, f.principal)).receipt.status,
      ).toBe("accepted");
      expect(
        (yield* gateway.write(checkpoint, f.principal.actor, source, f.principal)).receipt.status,
      ).toBe("accepted");
    }).pipe(Effect.provide(Layer.fresh(gatewayLayer).pipe(Layer.provideMerge(NodeServices.layer)))),
);

for (const invalidation of ["expired", "reassigned"] as const)
  it.effect(`denies delegation through an undrained ${invalidation} ancestor`, () =>
    Effect.gen(function* () {
      const f = yield* seedTeam("coordinator");
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const projectId = f.principal.managed.projectId;
      const taskId = ProjectWorkTaskId.make("child-task");
      const attemptId = ProjectWorkAttemptId.make("child-attempt");
      yield* f.change(
        decodeTeamFixture({
          ...f.member,
          recordId: "child-member",
          name: "Child",
          coordinator: false,
        }),
      );
      yield* f.change(
        decodeTeamFixture({
          ...f.member,
          recordId: "recipient",
          name: "Recipient",
          coordinator: false,
        }),
      );
      const child = yield* createManagedAssignment({
        taskId,
        attemptId,
        recordId: "child-binding",
        commandId: "child-claim",
        memberId: "child-member",
        parentRunId: f.binding.recordId,
        providerInstanceId: f.binding.providerInstanceId,
        threadId: ThreadId.make("child-thread"),
        role: f.role,
        configuration: f.binding.configuration,
        sessionId: "native-child",
        status: "running",
        leasedUntil: "2035-01-01T00:00:00.000Z",
      });
      const managed = (yield* f.auth.issueCredential({
        providerInstanceId: child.providerInstanceId,
        threadId: child.threadId,
      }))!.credential;
      const principal = {
        actor: { kind: "agent" as const, id: TeamAuthorization.managedActorId(managed) },
        managed,
      };
      let state = (yield* f.auth.resolve(principal))!.state;
      const input = {
        type: "project-team.delegation.request" as const,
        commandId: CommandId.make("valid-chain"),
        projectId,
        taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks.find((t) => t.taskId === taskId)!.revision,
        specRevision: 1,
        planRevision: 1,
        requestId: "request",
        recipientId: "recipient",
        objective: "Bounded descendant request",
      };
      expect(
        (yield* gateway.write(input, principal.actor, { kind: "mcp", id: "child" }, principal))
          .receipt.status,
      ).toBe("accepted");
      if (invalidation === "expired")
        yield* TestClock.setTime(Date.parse("2031-01-01T00:00:00.000Z"));
      else {
        const parentState = (yield* f.auth.resolve(f.principal))!.state;
        const parentTask = parentState.tasks.find((t) => t.taskId === f.binding.taskId)!;
        yield* gateway.write(
          {
            type: "project-team.task.control",
            projectId,
            taskId: parentTask.taskId,
            commandId: CommandId.make("parent-reassign"),
            expectedRevision: parentState.revision,
            expectedTaskRevision: parentTask.revision,
            control: {
              action: "reassign",
              recipientMemberId: "recipient",
              expectedMemberRevision: 0,
              reason: "Assign parent scope to another member",
            },
          },
          { kind: "human", id: "owner" },
          { kind: "web", id: "owner" },
        );
        const reassigned = (yield* f.auth.resolve(principal))!.state;
        expect(
          reassigned.foundationRecords?.find((r) => r.recordId === f.binding.recordId),
        ).toMatchObject({ status: "stopping" });
        expect(reassigned.attempts).toEqual(parentState.attempts);
        expect(
          reassigned.foundationRecords?.find(
            (r) => r.kind === "task-membership" && r.taskId === parentTask.taskId,
          ),
        ).toMatchObject({ controlState: "paused", requestedSuccessorMemberId: "recipient" });
      }
      state = (yield* f.auth.resolve(principal))!.state;
      const rejected = {
        ...input,
        commandId: CommandId.make("invalid-chain"),
        requestId: "invalid-request",
        expectedRevision: state.revision,
      };
      expect(
        (yield* gateway
          .write(rejected, principal.actor, { kind: "mcp", id: "child" }, principal)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* f.auth.resolve(principal))!.state.revision).toBe(state.revision);
    }).pipe(Effect.provide(Layer.fresh(gatewayLayer).pipe(Layer.provideMerge(NodeServices.layer)))),
  );

import { ThreadId, type ProjectTeamCredential } from "@t3tools/contracts";

const seedDelegationChain = Effect.fn("authorizationTest.seedDelegationChain")(function* (
  rootLimit: number,
  middleLimit: number,
  leafLimit: number,
  missingGrant?: "roleTools" | "toolIds",
) {
  const f = yield* seedTeam("coordinator", "running", {
    delegationDepth: rootLimit,
    ...(missingGrant === undefined ? {} : { [missingGrant]: ["project-work.read-project"] }),
  });
  const projectId = f.principal.managed.projectId;
  let parentRunId = f.binding.recordId;
  let credential: ProjectTeamCredential = f.principal.managed;
  for (const n of [1, 2]) {
    const taskId = ProjectWorkTaskId.make(`descendant-task-${n}`);
    const attemptId = ProjectWorkAttemptId.make(`descendant-attempt-${n}`);
    const roleId = `descendant-role-${n}`;
    const role = decodeTeamFixture({
      ...f.role,
      recordId: roleId,
      roleId,
      delegationDepth: n === 1 ? middleLimit : leafLimit,
      tools: ["project-work.delegate"],
    });
    if (role.kind !== "role-revision") return yield* Effect.die("Invalid descendant role");
    yield* f.change(role);
    const memberId = `descendant-member-${n}`;
    yield* f.change(
      decodeTeamFixture({
        ...f.member,
        recordId: memberId,
        coordinator: false,
        roleRevisionId: roleId,
      }),
    );
    const threadId = ThreadId.make(`descendant-thread-${n}`);
    const binding = yield* createManagedAssignment({
      recordId: `descendant-binding-${n}`,
      commandId: `descendant-claim-${n}`,
      taskId,
      attemptId,
      memberId,
      role,
      parentRunId,
      providerInstanceId: f.binding.providerInstanceId,
      threadId,
      sessionId: `native-descendant-${n}`,
      status: "running",
      configuration: {
        instructionsHash: "hash",
        toolIds: ["project-work.delegate"],
        skillIds: [],
        runtimeVersion: "test",
        maxTokens: 1000,
        maxDurationMs: 1000,
        paidFallback: false,
      },
    });
    parentRunId = binding.recordId;
    credential = (yield* f.auth.issueCredential({
      providerInstanceId: credential.providerInstanceId,
      threadId,
    }))!.credential;
  }
  yield* f.change(
    decodeTeamFixture({ ...f.member, recordId: "depth-recipient", coordinator: false }),
  );
  const principal = {
    actor: { kind: "agent" as const, id: TeamAuthorization.managedActorId(credential) },
    managed: credential,
  };
  const state = (yield* f.auth.resolve(principal))!.state;
  const taskId = (yield* f.auth.resolve(principal))!.binding.taskId;
  const input = {
    type: "project-team.delegation.request" as const,
    projectId,
    taskId,
    commandId: CommandId.make("depth-request"),
    expectedRevision: state.revision,
    expectedTaskRevision: state.tasks.find((t) => t.taskId === taskId)!.revision,
    specRevision: 1,
    planRevision: 1,
    requestId: "depth-request",
    recipientId: "depth-recipient",
    objective: "Bounded descendant delegation",
  };
  return { f, principal, input };
});

for (const scenario of [
  { name: "root is stricter", root: 2, middle: 8, leaf: 8, allowed: false },
  { name: "leaf is stricter", root: 8, middle: 8, leaf: 2, allowed: false },
  { name: "intermediate is stricter", root: 8, middle: 2, leaf: 8, allowed: false },
  { name: "all frozen budgets permit the child", root: 8, middle: 8, leaf: 8, allowed: true },
])
  it.effect(`checks every frozen delegation budget when ${scenario.name}`, () =>
    Effect.gen(function* () {
      const { f, principal, input } = yield* seedDelegationChain(
        scenario.root,
        scenario.middle,
        scenario.leaf,
      );
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      const source = { kind: "mcp" as const, id: "descendant" };
      const result = yield* gateway
        .write(input, principal.actor, source, principal)
        .pipe(Effect.result);
      expect(result._tag).toBe(scenario.allowed ? "Success" : "Failure");
      const state = (yield* f.auth.resolve(principal))!.state;
      expect(state.foundationRecords?.some((r) => r.recordId === input.requestId)).toBe(
        scenario.allowed,
      );
      expect(state.foundationRecords?.some((r) => r.kind === "effect")).toBe(false);
      if (result._tag === "Success") {
        yield* f.change(
          decodeTeamFixture({
            ...f.role,
            recordId: "current-member-role",
            roleId: "current-member-role",
            delegationDepth: 0,
          }),
        );
        yield* f.change(
          decodeTeamFixture({ ...f.member, revision: 1, roleRevisionId: "current-member-role" }),
        );
        expect((yield* gateway.write(input, principal.actor, source, principal)).receipt).toEqual(
          result.success.receipt,
        );
        yield* f.change(decodeTeamFixture({ ...f.role, revision: 1, status: "retired" }));
        expect(
          (yield* gateway.write(input, principal.actor, source, principal).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      }
    }).pipe(Effect.provide(Layer.fresh(gatewayLayer).pipe(Layer.provideMerge(NodeServices.layer)))),
  );

for (const missing of ["roleTools", "toolIds"] as const)
  it.effect(`checks ancestor frozen ${missing} before descendant delegation`, () =>
    Effect.gen(function* () {
      const { principal, input } = yield* seedDelegationChain(8, 8, 8, missing);
      const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
      expect(
        (yield* gateway
          .write(input, principal.actor, { kind: "mcp", id: "descendant" }, principal)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(Layer.fresh(gatewayLayer).pipe(Layer.provideMerge(NodeServices.layer)))),
  );

const encodeDelegationCheckpoint = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
it.effect("rejects a recovered delegation ancestry cycle without writing a message", () =>
  Effect.gen(function* () {
    const { f, principal, input } = yield* seedDelegationChain(8, 8, 8);
    const state = (yield* f.auth.resolve(principal))!.state;
    const recovered = {
      ...state,
      foundationRecords: state.foundationRecords?.map((record) =>
        record.recordId === f.binding.recordId
          ? { ...record, parentRunId: "descendant-binding-2" }
          : record,
      ),
    };
    yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=${encodeDelegationCheckpoint(recovered)} WHERE project_id=${input.projectId}`;
    const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
    expect(
      (yield* gateway
        .write(
          { ...input, expectedRevision: state.revision },
          principal.actor,
          { kind: "mcp", id: "descendant" },
          principal,
        )
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      (yield* f.auth.resolve(principal))!.state.foundationRecords?.some(
        (r) => r.recordId === input.requestId,
      ),
    ).toBe(false);
  }).pipe(Effect.provide(Layer.fresh(gatewayLayer).pipe(Layer.provideMerge(NodeServices.layer)))),
);
