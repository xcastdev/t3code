import * as NodeCrypto from "node:crypto";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { coreLayer } from "../projectWork/ProjectWorkRuntime.ts";
import { ProjectWorkStream } from "../projectWork/ProjectWorkStream.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import {
  ProjectWorkEventBus,
  type ProjectWorkCommittedEvent,
} from "../projectWork/ProjectWorkEventBus.ts";
import { it as effectIt } from "@effect/vitest";
import {
  PROJECT_TEAM_TABLES,
  readProjectTeamPage,
} from "../projectWork/ProjectTeamsPersistence.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "../projectWork/ProjectWorkRepository.ts";
import {
  ProjectWorkProjection,
  ProjectWorkProjectionLive,
} from "../projectWork/ProjectWorkProjection.ts";
import {
  CommandId,
  ProjectId,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamRecord,
  ProjectWorkTaskId,
  ProjectWorkAttemptId,
  ProjectWorkCommentId,
  EnvironmentId,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import { bindIssueRepositoryProject } from "../projectWork/ProjectIssueRepositoryState.ts";
import * as ContentGuard from "../projectWork/ProjectWorkContentGuard.ts";
import * as TeamAuthorization from "../projectWork/ProjectTeamAuthorization.ts";
import {
  makeProjectMemoryService,
  projectMemoryHash,
} from "../projectWork/memory/ProjectMemoryService.ts";
import { seed as seedAssignment } from "../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import { MemoryIndexManifest, type MemoryBackend } from "../projectWork/memory/MemoryBackend.ts";
import { makeProjectMemoryIndexReactor } from "../projectWork/memory/ProjectMemoryIndexReactor.ts";
import {
  makeProjectMemoryOutcome,
  readProjectMemoryCompletedDeletionInTransaction,
} from "../projectWork/memory/ProjectMemoryOutcome.ts";
import { ProjectMemoryJobOwner } from "../projectWork/memory/ProjectMemoryModelAccounting.ts";
import { readProjectMemoryObservations } from "../projectWork/memory/ProjectMemoryRetrieval.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";

import {
  ProjectLifecycle,
  ProjectLifecycleError,
  ProjectLifecycleLive,
  relocationDecision,
} from "./ProjectLifecycle.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeTeamRecordEffect = Schema.decodeUnknownEffect(ProjectTeamRecord);
const decodeCommitEffect = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const decodeMemoryOwner = Schema.decodeUnknownEffect(ProjectMemoryJobOwner);
const bindRepository = (
  sql: SqlClient.SqlClient,
  projectId: string,
  repositoryNodeId: string,
  accountNodeId: string,
) =>
  bindIssueRepositoryProject(sql, {
    key: { host: "github.com", repositoryNodeId },
    projectId,
    accountNodeId,
    repositoryName: "owner/repo",
    credentialEpoch: "lifecycle-verified-epoch",
    since: "2026-01-01T00:00:00Z",
    expectedBindingRevision: null,
  });

const lifecycleLayer = ProjectLifecycleLive.pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(FileSystem.layerNoop({})),
);

describe("ProjectLifecycle", () => {
  effectIt.effect(
    "deletes a no-memory project without imposing memory authority history limits",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const lifecycle = yield* ProjectLifecycle;
        const projectId = ProjectId.make("no-memory-long-history");
        const at = "2026-01-01T00:00:00.000Z";
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${projectId},'Ordinary project','/workspace/ordinary','[]',${at},${at})`;
        // Metadata-only nonmemory history stresses the presence fast path. These
        // rows confer no task or cleanup authority and are never replayed here.
        yield* sql`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n<8193)
        INSERT INTO project_work_events (event_id,project_id,event_type,occurred_at,command_id,payload_json)
        SELECT 'ordinary-history-'||n,${projectId},'project-work.task.created',${at},'ordinary-history-'||n,${encodeJson({ kind: "unrelated-history" })}
        FROM history`;
        expect(
          yield* sql`SELECT COUNT(*) AS count FROM project_work_events WHERE project_id=${projectId}`,
        ).toEqual([{ count: 8193 }]);
        const result = yield* lifecycle.permanentDelete({
          projectId,
          commandId: CommandId.make("ordinary-delete"),
          workspaceRoot: "/workspace/ordinary",
          confirmation: "permanent-local-delete",
        });
        expect(result.project.state).toBe("tombstoned");
        expect(
          yield* sql`SELECT event_id FROM project_work_events WHERE project_id=${projectId}`,
        ).toEqual([]);
      }).pipe(Effect.provide(lifecycleLayer)),
  );
  effectIt.effect(
    "requires recorded memory cleanup before permanent deletion through the lifecycle route",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* ProjectWorkRepository;
        const lifecycle = yield* ProjectLifecycle;
        const contentGuard = yield* ContentGuard.ProjectWorkContentGuard;
        const authorization = yield* TeamAuthorization.ProjectTeamAuthorization;
        const projectId = ProjectId.make("memory-delete-lifecycle");
        const taskId = ProjectWorkTaskId.make("memory-delete-task");
        const at = "2026-01-01T00:00:00.000Z";
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${projectId},'Retained memory','/workspace/memory','[]',${at},${at})`;
        yield* repository.execute({
          type: "project-work.task.create",
          commandId: CommandId.make("memory-delete-task-create"),
          projectId,
          taskId,
          title: "Retained cleanup task",
          createdAt: at,
        });
        yield* repository.execute({
          type: "project-work.comment.add",
          commandId: CommandId.make("memory-delete-comment"),
          projectId,
          comment: {
            commentId: ProjectWorkCommentId.make("memory-delete-comment"),
            projectId,
            taskId,
            body: "Retain this finding until its recorded cleanup completes.",
            revision: 0,
            createdAt: at,
          },
          addedAt: at,
          attribution: {
            actor: { kind: "human", id: "memory-human" },
            source: { kind: "web", id: "memory-panel" },
            recordedAt: at,
          },
        });
        const memory = makeProjectMemoryService({
          sql,
          repository,
          contentGuard,
          authorization,
          environmentId: "deletion-environment",
        });
        const source = yield* memory.captureRetained(projectId, {
          kind: "comment",
          retainedId: "memory-delete-comment",
        });
        expect(source.status).toBe("current");
        expect(
          yield* sql`SELECT status,owner_json AS owner,receipt_json AS receipt
        FROM project_team_memory_job WHERE project_id=${projectId}`,
        ).toEqual([{ status: "pending", owner: null, receipt: null }]);
        const before = yield* readCurrentState(sql, projectId);
        const beforeProject =
          yield* sql`SELECT * FROM projection_projects WHERE project_id=${projectId}`;
        const result = yield* lifecycle
          .permanentDelete({
            projectId,
            commandId: CommandId.make("delete-before-memory-cleanup"),
            workspaceRoot: "/workspace/memory",
            confirmation: "permanent-local-delete",
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            _tag: "ProjectLifecycleError",
            reason: "memory-cleanup-required",
            projectId,
          });
        expect(yield* sql`SELECT * FROM projection_projects WHERE project_id=${projectId}`).toEqual(
          beforeProject,
        );
        expect(yield* readCurrentState(sql, projectId)).toEqual(before);
        expect(
          yield* sql`SELECT * FROM project_lifecycle_operations WHERE project_id=${projectId}`,
        ).toEqual([]);
      }).pipe(
        Effect.provide(
          ProjectLifecycleLive.pipe(
            Layer.provideMerge(ProjectWorkRepositoryLive),
            Layer.provideMerge(TeamAuthorization.layer),
            Layer.provideMerge(ContentGuard.layer),
            Layer.provideMerge(
              Layer.succeed(ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("deletion-environment")),
              }),
            ),
            Layer.provideMerge(NodeSqliteClient.layerMemory()),
            Layer.provideMerge(FileSystem.layerNoop({})),
          ),
        ),
      ),
  );
  effectIt.effect(
    "deletes a memory-bearing project only after every exact source cleanup receipt completes",
    () =>
      Effect.gen(function* () {
        // Real migrated SQLite, repository, reactor, outcome verifier and lifecycle.
        // Frozen operation history and model/backend ports are controlled fixtures;
        // this does not launch a managed worker or certify Mem0 storage behavior.
        const f = yield* seedAssignment("investigator", "running", { issueCredential: false });
        const { sql, repo: repository, binding, role } = f;
        const projectId = binding.projectId;
        const environmentId = binding.environmentId;
        const at = "2026-01-01T00:00:00.000Z";
        const lifecycle = yield* ProjectLifecycle;
        const contentGuard = yield* ContentGuard.ProjectWorkContentGuard;
        const authorization = yield* TeamAuthorization.ProjectTeamAuthorization;
        const dependencies = { sql, repository, contentGuard, authorization, environmentId };
        const vector = Array.from({ length: 2048 }, () => 0.125);
        const service = makeProjectMemoryService({
          ...dependencies,
          models: {
            extract: () =>
              Effect.succeed([
                { key: "provenance", body: "Source provenance persists.", quote: "provenance" },
                { key: "cleanup", body: "Cleanup requires receipts.", quote: "receipts" },
              ]),
            embed: ({ bodies }) => Effect.succeed(bodies.map(() => vector)),
          },
        });
        const indexed = new Map<string, typeof MemoryIndexManifest.Type>();
        const cleanupEntered = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        const backend: MemoryBackend = {
          health: () =>
            Effect.succeed({
              engine: "mem0",
              engineVersion: "2.2.1",
              qdrantVersion: "1.19.1",
              embeddingDimensions: 2048,
            }),
          index: (_, manifest) =>
            Effect.sync(() => {
              indexed.set(manifest.extractionId, manifest);
              return {
                writtenObservationIds: manifest.observations.map((entry) => entry.observationId),
              };
            }),
          reconcile: (_, manifest) =>
            Effect.sync(() => {
              const saved = indexed.get(manifest.extractionId);
              const missingObservationIds = manifest.observations
                .filter(
                  (entry) =>
                    !saved?.observations.some((item) => item.observationId === entry.observationId),
                )
                .map((entry) => entry.observationId);
              return {
                complete: missingObservationIds.length === 0,
                missingObservationIds,
                invalidObservationIds: [],
                unexpectedBackendIds: [],
              };
            }),
          search: (_, scope) =>
            Effect.succeed({
              candidates: [...indexed.values()]
                .filter(
                  (manifest) =>
                    manifest.projectId === scope.projectId &&
                    manifest.environmentId === scope.environmentId,
                )
                .flatMap((manifest) =>
                  manifest.observations.map((observation) => ({
                    environmentId: manifest.environmentId,
                    projectId: manifest.projectId,
                    sourceRecordId: manifest.sourceRecordId,
                    sourceRevision: manifest.sourceRevision,
                    sourceGeneration: manifest.sourceGeneration,
                    extractionId: manifest.extractionId,
                    observationId: observation.observationId,
                    score: 1,
                  })),
                ),
            }),
          deleteSource: (_, source) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(cleanupEntered, undefined);
              yield* Deferred.await(releaseCleanup);
              for (const [id, manifest] of indexed)
                if (
                  manifest.environmentId === source.environmentId &&
                  manifest.projectId === source.projectId &&
                  manifest.sourceRecordId === source.sourceRecordId
                )
                  indexed.delete(id);
              return { cleanupComplete: true as const };
            }),
          deleteProject: () =>
            Effect.die("Per-source receipts must cover cleanup without project-wide deletion"),
        };
        const reactor = makeProjectMemoryIndexReactor({
          ...dependencies,
          service,
          backend,
          outcomes: makeProjectMemoryOutcome(dependencies),
        });
        const capture = Effect.fn("lifecycle.test.capture")(function* (
          ownerProjectId: ProjectId,
          taskId: ProjectWorkTaskId,
          id: string,
        ) {
          yield* repository.execute({
            type: "project-work.comment.add",
            commandId: CommandId.make(id),
            projectId: ownerProjectId,
            comment: {
              commentId: ProjectWorkCommentId.make(id),
              projectId: ownerProjectId,
              taskId,
              body: "Source provenance persists; cleanup requires receipts.",
              revision: 0,
              createdAt: at,
            },
            addedAt: at,
            attribution: {
              actor: { kind: "human", id: "memory-human" },
              source: { kind: "web", id: "memory-panel" },
              recordedAt: at,
            },
          });
          const source = yield* service.captureRetained(ownerProjectId, {
            kind: "comment",
            retainedId: id,
          });
          const state = yield* readCurrentState(sql, ownerProjectId);
          const effect = state.foundationRecords?.find(
            (record) =>
              record.kind === "effect" &&
              record.effectKind === "memory-index" &&
              record.targetId === source.recordId,
          );
          if (effect?.kind !== "effect") return yield* Effect.die("Missing index intent");
          expect((yield* reactor.consume(ownerProjectId, effect.recordId)).status).toBe(
            "reflected",
          );
          return source;
        });
        const sources = [
          yield* capture(projectId, binding.taskId, "cleanup-first"),
          yield* capture(projectId, binding.taskId, "cleanup-second"),
        ];
        const otherProjectId = ProjectId.make("unrelated-memory-project");
        const otherTaskId = ProjectWorkTaskId.make("unrelated-memory-task");
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${otherProjectId},'Unrelated','/workspace/unrelated','[]',${at},${at})`;
        yield* repository.execute({
          type: "project-work.task.create",
          commandId: CommandId.make("unrelated-task"),
          projectId: otherProjectId,
          taskId: otherTaskId,
          title: "Unrelated task",
          createdAt: at,
        });
        yield* capture(otherProjectId, otherTaskId, "unrelated-comment");
        const search = (id: ProjectId) =>
          backend.search("lifecycle-proof", { environmentId, projectId: id, vector, limit: 100 });
        const originalHits = (yield* search(projectId)).candidates;
        expect(originalHits).toHaveLength(4);
        expect(
          (yield* readProjectMemoryObservations(sql, projectId, "provenance receipts")).records,
        ).toHaveLength(4);
        const unrelatedSnapshot = Effect.gen(function* () {
          return {
            state: yield* readCurrentState(sql, otherProjectId),
            project:
              yield* sql`SELECT * FROM projection_projects WHERE project_id=${otherProjectId}`,
            jobs: yield* sql`SELECT * FROM project_team_memory_job WHERE project_id=${otherProjectId} ORDER BY effect_id`,
            manifests:
              yield* sql`SELECT * FROM project_team_memory_manifest WHERE project_id=${otherProjectId} ORDER BY extraction_id`,
            outcomes:
              yield* sql`SELECT * FROM project_team_memory_outcome WHERE project_id=${otherProjectId} ORDER BY effect_id`,
            hits: yield* search(otherProjectId),
            retrieval: yield* readProjectMemoryObservations(
              sql,
              otherProjectId,
              "provenance receipts",
            ),
          };
        });
        const unrelatedBefore = yield* unrelatedSnapshot;
        expect(unrelatedBefore.retrieval.records).toHaveLength(2);
        for (const source of sources) yield* service.retract(projectId, source.recordId);
        const state = yield* readCurrentState(sql, projectId);
        const deletes =
          state.foundationRecords
            ?.filter((record) => record.kind === "effect")
            .filter((record) => record.effectKind === "memory-delete") ?? [];
        expect(deletes).toHaveLength(2);
        const deleteInput = {
          projectId,
          commandId: CommandId.make("delete-after-exact-memory-cleanup"),
          workspaceRoot: "/workspace",
          confirmation: "permanent-local-delete" as const,
        };
        const assertBlocked = Effect.gen(function* () {
          const before = yield* readCurrentState(sql, projectId);
          expect(yield* lifecycle.permanentDelete(deleteInput).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { reason: "memory-cleanup-required" },
          });
          expect(yield* readCurrentState(sql, projectId)).toEqual(before);
          expect((yield* lifecycle.get(projectId))?.state).toBe("active");
          expect(
            yield* sql`SELECT * FROM project_lifecycle_operations WHERE project_id=${projectId}`,
          ).toEqual([]);
        });
        // Seed frozen historical operation authority, then persist each admission
        // event and command receipt through the actual repository. No live runtime.
        const allocation = {
          version: 1,
          unit: "cleanup-unit",
          nonce: "cleanup-nonce",
          policy: { memoryBytes: 16777216, runtimeSeconds: 1 },
          launch: {
            workspaceRoot: "/fixture/unexecuted",
            workspace: { path: "/fixture/unexecuted", dev: 0, ino: 0 },
            protectedRoots: [],
            protectedWorkspaceEntries: [],
            runtimeFiles: [],
            argv: [],
            memoryBytes: 16777216,
            runtimeSeconds: 1,
          },
        };
        const operation = {
          version: 1,
          environmentId,
          projectId,
          taskId: binding.taskId,
          bindingId: binding.recordId,
          generation: binding.generation,
          providerInstanceId: binding.providerInstanceId,
          threadId: binding.threadId,
          operationId: "cleanup-operation",
          workerId: "cleanup-worker",
          ordinal: 0,
          attemptId: binding.attemptId,
          rootBindingId: binding.recordId,
          rootTaskId: binding.taskId,
          rootMaximumTokens: 1000,
          rootDeadlineAtMs: 1000,
          attemptMaximumTokens: binding.configuration.maxTokens,
          attemptDeadlineAtMs: 1000,
          operationMaximumTokens: 1000,
          operationDeadlineAtMs: 1000,
          leaseDeadlineAtMs: 1000,
          roleSha256: projectMemoryHash(role),
          configurationSha256: projectMemoryHash(binding.configuration),
          requestSha256: "0".repeat(64),
          allocation,
        };
        const intent = {
          binding,
          role,
          allocation,
          rootBudget: { rootTaskId: binding.taskId, maximumTokens: 1000, deadlineAtMs: 1000 },
          operationLimits: { maximumTokens: 1000, deadlineAtMs: 1000 },
        };
        yield* sql`INSERT INTO project_team_pi_operation VALUES (${operation.operationId},${environmentId},${projectId},${binding.recordId},${binding.generation},${binding.providerInstanceId},${binding.threadId},${operation.workerId},0,'prompt',${operation.requestSha256},${binding.recordId},${binding.taskId},1000,1000,'settled',${canonicalProjectWorkPayload(intent)},NULL,NULL)`;
        for (const effect of deletes) {
          const source = (yield* readCurrentState(sql, projectId)).foundationRecords?.find(
            (entry) => entry.recordId === effect.targetId,
          );
          if (source?.kind !== "memory-source") return yield* Effect.die("Missing cleanup source");
          const current = yield* readCurrentState(sql, projectId);
          const task = current.tasks.find((entry) => entry.taskId === binding.taskId)!;
          const request = {
            type: "project-team.memory.process",
            commandId: `admit-${effect.recordId}`,
            projectId,
            taskId: binding.taskId,
            expectedRevision: current.revision,
            expectedTaskRevision: task.revision,
            specRevision: task.specRevision,
            planRevision: binding.planRevision,
            selection: {
              kind: "comment",
              retainedId: source.sourceId,
              retainedRevision: source.sourceRevision,
              sourceRecordId: source.recordId,
              expectedSourceRecordRevision: source.revision,
              sourceRevision: source.sourceRevision,
              sourceGeneration: source.generation,
              contentHash: source.contentHash,
              effectId: effect.recordId,
              expectedEffectRevision: effect.revision,
              expectedClaimGeneration: 0,
            },
          };
          const attribution = {
            actor: { kind: "agent", id: operation.workerId },
            source: { kind: "mcp", id: operation.workerId },
            recordedAt: at,
          };
          const fingerprint =
            "project-team-intent:" +
            NodeCrypto.createHash("sha256")
              .update(
                canonicalProjectWorkPayload({
                  intent: request,
                  actor: attribution.actor,
                  source: attribution.source,
                  managed: {
                    projectId,
                    bindingId: binding.recordId,
                    generation: binding.generation,
                    providerInstanceId: binding.providerInstanceId,
                    threadId: binding.threadId,
                  },
                }),
              )
              .digest("hex");
          const owner = yield* decodeMemoryOwner({
            version: 1,
            operation,
            request,
            selection: request.selection,
            commandId: request.commandId,
            intentFingerprint: fingerprint,
            actorId: operation.workerId,
            sourceKind: "mcp",
            sourceId: operation.workerId,
            admittedAt: at,
            admittedEffect: { ...effect, revision: effect.revision + 1, updatedAt: at },
          });
          const command = yield* decodeCommitEffect({
            type: "project-work.foundation.commit",
            commandId: request.commandId,
            projectId,
            expectedRevision: current.revision,
            attribution,
            records: [owner.admittedEffect],
            committedAt: at,
          });
          yield* repository.executeAuthorized(
            command,
            () => Effect.succeed(command),
            undefined,
            fingerprint,
          );
          yield* sql`UPDATE project_team_memory_job SET owner_json=${canonicalProjectWorkPayload(owner)} WHERE effect_id=${effect.recordId}`;
        }
        yield* assertBlocked;
        const first = deletes[0]!;
        const cleanup = yield* reactor.consume(projectId, first.recordId).pipe(Effect.forkChild);
        yield* Deferred.await(cleanupEntered);
        expect((yield* reactor.load(first.recordId))?.status).toBe("claimed");
        expect((yield* search(projectId)).candidates).toEqual(originalHits);
        yield* assertBlocked;
        yield* Deferred.succeed(releaseCleanup, undefined);
        expect((yield* Fiber.join(cleanup)).status).toBe("reflected");
        expect((yield* search(projectId)).candidates).toHaveLength(2);
        yield* assertBlocked;
        expect((yield* reactor.consume(projectId, deletes[1]!.recordId)).status).toBe("reflected");
        for (const effect of deletes) {
          const proof = yield* sql.withTransaction(
            readProjectMemoryCompletedDeletionInTransaction(sql, environmentId, effect.recordId),
          );
          expect(proof.receipt).toMatchObject({
            kind: "delete-source-complete",
            effectId: effect.recordId,
            sourceId: effect.targetId,
            observationIds: [],
          });
        }
        expect((yield* search(projectId)).candidates).toEqual([]);
        const deleted = yield* lifecycle.permanentDelete(deleteInput);
        expect(deleted.project.state).toBe("tombstoned");
        expect(yield* lifecycle.permanentDelete(deleteInput)).toEqual(deleted);
        expect((yield* readCurrentState(sql, projectId)).foundationRecords).toEqual([]);
        for (const table of [
          ...PROJECT_TEAM_TABLES,
          "project_work_search_fts",
          "project_work_comments",
          "project_work_events",
        ])
          expect(yield* sql`SELECT * FROM ${sql(table)} WHERE project_id=${projectId}`).toEqual([]);
        expect(
          (yield* readProjectMemoryObservations(sql, projectId, "provenance receipts")).records,
        ).toEqual([]);
        expect(
          (yield* readProjectMemoryObservations(
            sql,
            projectId,
            "provenance receipts",
            originalHits.map((hit) => hit.observationId),
          )).records,
        ).toEqual([]);
        expect(yield* unrelatedSnapshot).toEqual(unrelatedBefore);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ProjectLifecycleLive.pipe(
            Layer.provideMerge(ProjectWorkRepositoryLive),
            Layer.provideMerge(ProjectWorkProjectionLive),
            Layer.provideMerge(TeamAuthorization.layer),
            Layer.provideMerge(ContentGuard.layer),
            Layer.provideMerge(
              Layer.succeed(ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
              }),
            ),
            Layer.provideMerge(NodeSqliteClient.layerMemory()),
            Layer.provideMerge(FileSystem.layerNoop({})),
          ),
        ),
      ),
  );
  effectIt.effect(
    "purges ordinary foundation data, transfers a shared cursor and fences stale writes and rebuilds",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const lifecycle = yield* ProjectLifecycle;
        const repo = yield* ProjectWorkRepository;
        const projection = yield* ProjectWorkProjection;
        const at = "2026-01-01T00:00:00.000Z";
        const projectId = ProjectId.make("foundation-deleted");
        const survivor = ProjectId.make("foundation-survivor");
        const third = ProjectId.make("foundation-third");
        for (const id of [
          projectId,
          survivor,
          third,
          "foundation-archived",
          "foundation-detached",
          "foundation-other-repo",
        ]) {
          yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${id}, 'Project', '/workspace', '[]', ${at}, ${at})`;
        }
        yield* sql`INSERT INTO project_lifecycle (project_id, state, workspace_root, revision, changed_at) VALUES ('foundation-archived', 'archived', '/workspace', 1, ${at})`;
        for (const id of [projectId, survivor, third])
          yield* bindRepository(sql, id, "repo", "same-account");
        const attribution = {
          actor: { kind: "system", id: "foundation" },
          source: { kind: "system", id: "foundation" },
          recordedAt: at,
        };
        const mission = yield* decodeTeamRecordEffect({
          kind: "mission",
          recordId: "deleted-mission",
          projectId,
          status: "draft",
          revision: 0,
          generation: 0,
          updatedAt: at,
          title: "Mission",
          objective: "Scope",
          requiredTaskIds: [],
        });
        const command = yield* decodeCommitEffect({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "deleted-foundation",
          expectedRevision: 0,
          attribution,
          committedAt: at,
          records: [mission],
        });
        yield* repo.execute(command);
        // Retained memory requires genuine recorded cleanup; this fixture
        // exercises ordinary purge/cursor semantics without fabricating it.
        for (const table of PROJECT_TEAM_TABLES.filter(
          (name) =>
            name !== "project_team_mission" &&
            name !== "project_team_intake_cursor" &&
            name !== "project_team_memory_source" &&
            name !== "project_team_memory_extraction" &&
            name !== "project_team_memory_observation",
        )) {
          yield* sql`INSERT INTO ${sql(table)} (record_id, project_id, status, revision, generation, updated_at, payload_json) VALUES (${table + "-deleted"}, ${projectId}, 'held', 0, 0, ${at}, '{}')`;
        }
        const cursor = yield* decodeTeamRecordEffect({
          kind: "intake-cursor",
          recordId: "shared-cursor",
          projectId,
          status: "ready",
          revision: 0,
          generation: 0,
          updatedAt: at,
          host: "github.com",
          repositoryNodeId: "repo",
          accountId: "same-account",
          cursor: "page-two",
          etag: "same-etag",
          overlapSince: at,
          lastSuccessfulPageAt: at,
        });
        yield* repo.execute({
          ...command,
          commandId: CommandId.make("cursor-create"),
          expectedRevision: 1,
          records: [cursor],
        });
        const progressed = { ...cursor, revision: 1, generation: 1, cursor: "page-three" };
        yield* repo.execute({
          ...command,
          commandId: CommandId.make("cursor-progress"),
          expectedRevision: 2,
          records: [progressed],
        });
        for (const [id, status, repositoryNodeId] of [
          [survivor, "open", "repo"],
          [third, "open", "repo"],
          ["foundation-archived", "open", "repo"],
          ["foundation-detached", "detached", "repo"],
          ["foundation-other-repo", "open", "other"],
        ]) {
          const issue = {
            kind: "issue",
            recordId: "issue-" + id,
            projectId: id,
            status,
            revision: 0,
            generation: 0,
            updatedAt: at,
            identity: {
              host: "github.com",
              repositoryNodeId,
              issueNodeId: "issue-" + id,
              number: 1,
            },
            repositoryName: "owner/repo",
            title: "Issue",
            body: "Scope",
            sourceRevision: "revision",
            observedAt: at,
          };
          if (id === survivor || id === third) {
            yield* repo.execute(
              yield* decodeCommitEffect({
                ...command,
                projectId: id,
                commandId: "survivor-issue-" + id,
                expectedRevision: 0,
                records: [issue],
              }),
            );
          } else {
            yield* sql`INSERT INTO project_team_issue (record_id, project_id, status, revision, generation, updated_at, payload_json) VALUES (${issue.recordId}, ${id}, ${status}, 0, 0, ${at}, ${encodeJson(issue)})`;
          }
        }
        const input = {
          commandId: CommandId.make("delete-foundation"),
          projectId,
          workspaceRoot: "/workspace",
          confirmation: "permanent-local-delete" as const,
        };
        yield* lifecycle.permanentDelete(input);
        for (const table of PROJECT_TEAM_TABLES)
          expect(
            (yield* sql`SELECT record_id FROM ${sql(table)} WHERE project_id = ${projectId}`)
              .length,
          ).toBe(0);
        expect(
          (yield* readProjectTeamPage(sql, { projectId: survivor, kinds: ["intake-cursor"] }))
            .items,
        ).toEqual([{ ...progressed, projectId: survivor }]);
        const transferEvents = yield* repo.replay(survivor);
        expect(transferEvents.at(-1)).toMatchObject({
          type: "project-work.foundation.recorded",
          revision: 2,
          record: { ...progressed, projectId: survivor },
        });
        yield* projection.rebuild(survivor);
        const update = { ...progressed, projectId: survivor, revision: 2, cursor: "page-four" };
        const continued = yield* repo.execute({
          ...command,
          projectId: survivor,
          commandId: CommandId.make("survivor-continue"),
          expectedRevision: 2,
          records: [update],
        });
        expect(continued.revision).toBe(3);
        for (const [index, rejected] of [
          { ...update, revision: 0, generation: 0 },
          { ...update, revision: 3, generation: 0 },
          { ...update, recordId: "replacement-cursor", revision: 0 },
        ].entries()) {
          expect(
            (yield* repo
              .execute({
                ...command,
                projectId: survivor,
                commandId: CommandId.make("survivor-reset-" + index),
                expectedRevision: 3,
                records: [rejected],
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        expect(
          (yield* readProjectTeamPage(sql, { projectId: survivor, kinds: ["intake-cursor"] }))
            .items,
        ).toEqual([update]);
        expect((yield* readProjectTeamPage(sql, { projectId })).items).toEqual([]);
        for (const stale of [
          command,
          { ...command, commandId: CommandId.make("stale-effect"), records: [cursor] },
        ])
          expect((yield* repo.execute(stale).pipe(Effect.result))._tag).toBe("Failure");
        expect(
          (yield* repo
            .execute({
              type: "project-work.task.claim",
              commandId: CommandId.make("stale-claim"),
              projectId,
              taskId: ProjectWorkTaskId.make("deleted-task"),
              attemptId: ProjectWorkAttemptId.make("deleted-attempt"),
              leaseToken: "opaque",
              leasedUntil: at,
              claimedAt: at,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* projection.rebuild(projectId);
        expect(
          (yield* sql`SELECT * FROM project_work_events WHERE project_id = ${projectId}`).length,
        ).toBe(0);
        expect(
          (yield* sql`SELECT * FROM project_work_projection_state WHERE projector = ${"project-work:" + projectId}`)
            .length,
        ).toBe(0);
        expect((yield* readProjectTeamPage(sql, { projectId })).items).toEqual([]);
        expect(yield* lifecycle.permanentDelete(input)).toMatchObject({
          project: { state: "tombstoned" },
        });
        yield* lifecycle.permanentDelete({
          ...input,
          projectId: survivor,
          commandId: CommandId.make("delete-last-owner"),
        });
        expect(
          (yield* readProjectTeamPage(sql, { projectId: third, kinds: ["intake-cursor"] })).items,
        ).toEqual([{ ...update, projectId: third }]);
        const thirdNext = { ...update, projectId: third, revision: 3, cursor: "page-five" };
        const thirdResult = yield* repo.execute({
          ...command,
          projectId: third,
          commandId: CommandId.make("third-continue"),
          expectedRevision: 2,
          records: [thirdNext],
        });
        expect(thirdResult.revision).toBe(3);
        yield* lifecycle.permanentDelete({
          ...input,
          projectId: third,
          commandId: CommandId.make("delete-final-owner"),
        });
        expect((yield* sql`SELECT * FROM project_team_intake_cursor`).length).toBe(0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(ProjectWorkRepositoryLive, ProjectWorkProjectionLive).pipe(
            Layer.provideMerge(lifecycleLayer),
          ),
        ),
      ),
  );

  effectIt.effect(
    "reopens transferred cursor authority and rolls back late deletion failures without publishing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-transfer-" });
          const published: Array<ProjectWorkCommittedEvent> = [];
          const bus = Layer.effect(
            ProjectWorkEventBus,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return ProjectWorkEventBus.of({
                subscribe: Effect.succeed(Stream.empty),
                publish: Effect.fn("test.publishTransferredCursor")(function* (events) {
                  for (const entry of events) {
                    expect(
                      (yield* sql`SELECT sequence FROM project_work_events WHERE event_id = ${entry.event.eventId}`)
                        .length,
                    ).toBe(1);
                    expect(entry.cursor).toBeGreaterThan(0);
                  }
                  published.push(...events);
                }, Effect.orDie),
              });
            }),
          );
          const database = () =>
            Layer.mergeAll(
              ProjectWorkRepositoryLive,
              ProjectWorkProjectionLive,
              ProjectLifecycleLive,
            ).pipe(
              Layer.provideMerge(bus),
              Layer.provideMerge(
                Layer.fresh(
                  NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") }),
                ),
              ),
            );
          const at = "2026-01-01T00:00:00.000Z";
          const owner = ProjectId.make("disk-owner");
          const survivor = ProjectId.make("disk-survivor");
          const attribution = {
            actor: { kind: "system", id: "foundation" },
            source: { kind: "system", id: "foundation" },
            recordedAt: at,
          };
          const cursor = yield* decodeTeamRecordEffect({
            kind: "intake-cursor",
            recordId: "disk-cursor",
            projectId: owner,
            status: "ready",
            revision: 0,
            generation: 0,
            updatedAt: at,
            host: "github.com",
            repositoryNodeId: "disk-repo",
            accountId: "disk-account",
            cursor: "page-two",
            etag: "disk-etag",
            overlapSince: at,
            lastSuccessfulPageAt: at,
          });
          const issue = yield* decodeTeamRecordEffect({
            kind: "issue",
            recordId: "disk-issue",
            projectId: survivor,
            status: "open",
            revision: 0,
            generation: 0,
            updatedAt: at,
            identity: {
              host: "github.com",
              repositoryNodeId: "disk-repo",
              issueNodeId: "disk-issue",
              number: 1,
            },
            repositoryName: "owner/repo",
            title: "Issue",
            body: "Scope",
            sourceRevision: "one",
            observedAt: at,
          });
          const commit = (
            projectId: ProjectId,
            commandId: string,
            expectedRevision: number,
            records: ReadonlyArray<typeof cursor>,
          ) =>
            decodeCommitEffect({
              type: "project-work.foundation.commit",
              projectId,
              commandId,
              expectedRevision,
              records,
              attribution,
              committedAt: at,
            });
          const progressed = { ...cursor, revision: 1, generation: 1, cursor: "page-three" };
          const input = {
            projectId: owner,
            commandId: CommandId.make("disk-issue-create"),
            workspaceRoot: "/workspace",
            confirmation: "permanent-local-delete" as const,
          };
          yield* Effect.gen(function* () {
            yield* runMigrations();
            const sql = yield* SqlClient.SqlClient;
            const repo = yield* ProjectWorkRepository;
            for (const id of [owner, survivor])
              yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${id}, 'Project', '/workspace', '[]', ${at}, ${at})`;
            for (const id of [owner, survivor])
              yield* bindRepository(sql, id, "disk-repo", "disk-account");
            yield* repo.execute(yield* commit(owner, "disk-cursor-create", 0, [cursor]));
            yield* repo.execute(yield* commit(owner, "disk-cursor-progress", 1, [progressed]));
            yield* repo.execute(yield* commit(survivor, "disk-issue-create", 0, [issue]));
            for (let i = 0; i < 12; i++)
              yield* repo.execute(
                yield* commit(ProjectId.make("unrelated-project"), "disk-extra-" + i, i, [
                  yield* decodeTeamRecordEffect({
                    kind: "mission",
                    recordId: "disk-extra-" + i,
                    projectId: "unrelated-project",
                    status: "draft",
                    revision: 0,
                    generation: 0,
                    updatedAt: at,
                    title: "Unrelated",
                    objective: "Scope",
                    requiredTaskIds: [],
                  }),
                ]),
              );
          }).pipe(Effect.provide(database()));
          published.length = 0;
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const lifecycle = yield* ProjectLifecycle;
            const repo = yield* ProjectWorkRepository;
            yield* sql`CREATE TRIGGER fail_delete_receipt BEFORE INSERT ON project_lifecycle_operations BEGIN SELECT RAISE(ABORT, 'late failure'); END`;
            const deletion = lifecycle.permanentDelete(input);
            expect((yield* deletion.pipe(Effect.result))._tag).toBe("Failure");
            expect(published).toEqual([]);
            expect(
              (yield* readProjectTeamPage(sql, { projectId: owner, kinds: ["intake-cursor"] }))
                .items,
            ).toEqual([progressed]);
            expect((yield* repo.replay(survivor)).length).toBe(1);
            expect(
              (yield* sql`SELECT * FROM project_work_command_receipts WHERE project_id = ${survivor} AND actor_id = 'project-lifecycle'`)
                .length,
            ).toBe(0);
            expect(
              (yield* sql`SELECT * FROM project_lifecycle WHERE project_id = ${owner}`).length,
            ).toBe(0);
            yield* sql`DROP TRIGGER fail_delete_receipt`;
            yield* deletion;
            expect(published).toHaveLength(1);
            const sequence = (yield* sql<{
              sequence: number;
            }>`SELECT sequence FROM project_work_events WHERE event_id = ${published[0]!.event.eventId}`)[0]!
              .sequence;
            expect(sequence).toBeGreaterThan(12);
            expect(
              (yield* sql<{
                last: number;
              }>`SELECT last_applied_sequence AS last FROM project_work_projection_state WHERE projector = ${"project-work:" + survivor}`)[0]
                ?.last,
            ).toBe(sequence);
            const duplicateIssue = yield* repo.execute(
              yield* commit(survivor, "disk-issue-create", 0, [issue]),
            );
            expect(duplicateIssue.duplicate).toBe(true);
            expect(duplicateIssue.events).toHaveLength(1);
            expect(duplicateIssue.events[0]?.type).toBe("project-work.foundation.recorded");
            expect(duplicateIssue.events[0]).toMatchObject({ record: issue });
            expect(published[0]?.event).toMatchObject({
              projectId: survivor,
              revision: 2,
              record: { ...progressed, projectId: survivor },
            });
            yield* deletion;
            expect(published).toHaveLength(1);
            for (const table of ["project_team_effect", "project_team_reservation"])
              expect((yield* sql`SELECT * FROM ${sql(table)}`).length).toBe(0);
          }).pipe(Effect.provide(database()));
          yield* Effect.gen(function* () {
            const repo = yield* ProjectWorkRepository;
            const sql = yield* SqlClient.SqlClient;
            const projection = yield* ProjectWorkProjection;
            const lifecycle = yield* ProjectLifecycle;
            expect((yield* projection.state(survivor)).revision).toBe(2);
            expect(
              (yield* readProjectTeamPage(sql, { projectId: survivor, kinds: ["intake-cursor"] }))
                .items,
            ).toEqual([{ ...progressed, projectId: survivor }]);
            yield* sql`UPDATE project_work_reducer_checkpoints SET state_json = '{}' WHERE project_id = ${survivor}`;
            yield* projection.rebuild(survivor);
            expect((yield* projection.state(survivor)).foundationRecords).toContainEqual({
              ...progressed,
              projectId: survivor,
            });
            yield* sql`UPDATE project_work_reducer_checkpoints SET state_json = '{}' WHERE project_id = ${survivor}`;
            const next = { ...progressed, projectId: survivor, revision: 2, cursor: "page-four" };
            yield* repo.execute(yield* commit(survivor, "disk-normal-next", 2, [next]));
            for (const [i, bad] of [
              { ...next, revision: 0, generation: 0 },
              { ...next, revision: 3, generation: 0 },
              { ...next, recordId: "disk-duplicate", revision: 0 },
              { ...next, revision: 3, accountId: "different" },
            ].entries())
              expect(
                (yield* repo
                  .execute(yield* commit(survivor, "disk-reject-" + i, 3, [bad]))
                  .pipe(Effect.result))._tag,
              ).toBe("Failure");
            expect((yield* repo.replay(survivor)).length).toBe(3);
            expect(
              (yield* readProjectTeamPage(sql, { projectId: survivor, kinds: ["intake-cursor"] }))
                .items,
            ).toEqual([next]);
            yield* lifecycle.permanentDelete({
              ...input,
              projectId: survivor,
              commandId: CommandId.make("disk-last-owner"),
            });
            expect((yield* sql`SELECT * FROM project_team_intake_cursor`).length).toBe(0);
          }).pipe(Effect.provide(database()));
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  effectIt.effect("publishes cursor transfer through the shared runtime stream after commit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* ProjectWorkRepository;
        const lifecycle = yield* ProjectLifecycle;
        const streamService = yield* ProjectWorkStream;
        const sql = yield* SqlClient.SqlClient;
        const at = "2026-01-01T00:00:00.000Z";
        const owner = ProjectId.make("stream-owner");
        const survivor = ProjectId.make("stream-survivor");
        for (const id of [owner, survivor])
          yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${id}, 'Project', '/workspace', '[]', ${at}, ${at})`;
        for (const id of [owner, survivor])
          yield* bindRepository(sql, id, "stream-repo", "stream-account");
        const cursor = yield* decodeTeamRecordEffect({
          kind: "intake-cursor",
          recordId: "stream-cursor",
          projectId: owner,
          status: "ready",
          revision: 0,
          generation: 0,
          updatedAt: at,
          host: "github.com",
          repositoryNodeId: "stream-repo",
          accountId: "stream-account",
          cursor: "page-two",
          overlapSince: at,
        });
        const issue = yield* decodeTeamRecordEffect({
          kind: "issue",
          recordId: "stream-issue",
          projectId: survivor,
          status: "open",
          revision: 0,
          generation: 0,
          updatedAt: at,
          identity: {
            host: "github.com",
            repositoryNodeId: "stream-repo",
            issueNodeId: "stream-issue",
            number: 1,
          },
          repositoryName: "owner/repo",
          title: "Issue",
          body: "Scope",
          sourceRevision: "one",
          observedAt: at,
        });
        for (const r of [cursor, issue])
          yield* repo.execute(
            yield* decodeCommitEffect({
              type: "project-work.foundation.commit",
              projectId: r.projectId,
              commandId: r.recordId,
              expectedRevision: 0,
              records: [r],
              attribution: {
                actor: { kind: "system", id: "foundation" },
                source: { kind: "system", id: "foundation" },
                recordedAt: at,
              },
              committedAt: at,
            }),
          );
        const head = (yield* sql<{
          sequence: number;
        }>`SELECT MAX(sequence) AS sequence FROM project_work_events WHERE project_id = ${survivor}`)[0]!
          .sequence;
        const stream = yield* streamService.stream({ projectId: survivor, afterCursor: head });
        yield* lifecycle.permanentDelete({
          projectId: owner,
          commandId: CommandId.make("stream-delete"),
          workspaceRoot: "/workspace",
          confirmation: "permanent-local-delete",
        });
        const items = yield* Stream.runCollect(stream.pipe(Stream.take(1)));
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          kind: "delta",
          delta: { projectId: survivor, revision: 2, recordId: "stream-cursor" },
        });
        expect(
          (yield* readProjectTeamPage(sql, { projectId: survivor, kinds: ["intake-cursor"] }))
            .items,
        ).toEqual([{ ...cursor, projectId: survivor }]);
      }).pipe(
        Effect.provide(
          ProjectLifecycleLive.pipe(
            Layer.provideMerge(coreLayer),
            Layer.provideMerge(NodeSqliteClient.layerMemory()),
            Layer.provideMerge(FileSystem.layerNoop({})),
          ),
        ),
      ),
    ),
  );

  it("requires a real directory and rejects a repository identity mismatch", () => {
    expect(
      relocationDecision({
        currentWorkspaceRoot: "/workspace/old",
        candidateWorkspaceRoot: "/workspace/new",
        candidateExists: false,
        candidateIsDirectory: false,
      }),
    ).toEqual({ allowed: false, reason: "missing-path" });
    expect(
      relocationDecision({
        currentWorkspaceRoot: "/workspace/old",
        candidateWorkspaceRoot: "/workspace/new",
        candidateExists: true,
        candidateIsDirectory: true,
        expectedRepositoryKey: "github:owner/repo",
        actualRepositoryKey: "github:other/repo",
      }),
    ).toEqual({ allowed: false, reason: "repository-mismatch" });
  });

  it("allows an explicit move while preserving the project identity", () => {
    expect(
      relocationDecision({
        currentWorkspaceRoot: "/workspace/old",
        candidateWorkspaceRoot: "/workspace/new",
        candidateExists: true,
        candidateIsDirectory: true,
        expectedRepositoryKey: "github:owner/repo",
        actualRepositoryKey: "github:owner/repo",
      }),
    ).toEqual({ allowed: true });
  });

  it("does not turn a relink into a no-op or silently accept the same path", () => {
    expect(
      relocationDecision({
        currentWorkspaceRoot: "/workspace/project/",
        candidateWorkspaceRoot: "/workspace/project",
        candidateExists: true,
        candidateIsDirectory: true,
      }),
    ).toEqual({ allowed: false, reason: "same-path" });
  });

  effectIt.effect(
    "keeps a tombstone while purging local work rows and makes deletion retries idempotent",
    () =>
      Effect.gen(function* () {
        const projectId = ProjectId.make("deleted-project");
        const commandId = CommandId.make("delete-command");
        const result = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const lifecycle = yield* ProjectLifecycle;
          yield* runMigrations();
          yield* runForkMigrations(13);
          yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES
            (${String(projectId)}, 'Deleted project', '/workspace/deleted', '[]',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `;
          yield* sql`
          INSERT INTO project_work_events
            (event_id, project_id, event_type, occurred_at, command_id, payload_json)
          VALUES
            ('event-delete-1', ${String(projectId)}, 'project-work.task.created',
              '2026-01-01T00:00:00.000Z', 'command-work-1', '{}')
        `;
          yield* sql`
          INSERT INTO project_work_reducer_checkpoints
            (project_id, last_sequence, state_json, updated_at)
          VALUES (${String(projectId)}, 1, '{}', '2026-01-01T00:00:00.000Z')
        `;

          const first = yield* lifecycle.permanentDelete({
            commandId,
            projectId,
            workspaceRoot: "/workspace/deleted",
            confirmation: "permanent-local-delete",
          });
          const eventRows = yield* sql`
          SELECT event_id FROM project_work_events WHERE project_id = ${String(projectId)}
        `;
          const checkpointRows = yield* sql`
          SELECT project_id FROM project_work_reducer_checkpoints
          WHERE project_id = ${String(projectId)}
        `;
          const tombstoneRows = yield* sql<{
            readonly state: string;
            readonly tombstoneJson: string;
          }>`
          SELECT state, tombstone_json AS tombstoneJson
          FROM project_lifecycle WHERE project_id = ${String(projectId)}
        `;
          const retry = yield* lifecycle.permanentDelete({
            commandId,
            projectId,
            workspaceRoot: "/workspace/deleted",
            confirmation: "permanent-local-delete",
          });
          const blocked = yield* Effect.result(
            lifecycle.permanentDelete({
              commandId: CommandId.make("delete-command-2"),
              projectId,
              workspaceRoot: "/workspace/deleted",
              confirmation: "permanent-local-delete",
            }),
          );

          return { first, retry, eventRows, checkpointRows, tombstoneRows, blocked };
        }).pipe(Effect.provide(lifecycleLayer));

        expect(result.eventRows).toEqual([]);
        expect(result.checkpointRows).toEqual([]);
        expect(result.tombstoneRows[0]?.state).toBe("tombstoned");
        expect(result.tombstoneRows[0]?.tombstoneJson).toContain("permanent-local-delete");
        expect(result.retry).toEqual(result.first);
        expect(result.blocked._tag).toBe("Failure");
        if (result.blocked._tag === "Failure") {
          const failure = result.blocked.failure;
          expect(Schema.is(ProjectLifecycleError)(failure)).toBe(true);
          if (Schema.is(ProjectLifecycleError)(failure)) {
            expect(failure.reason).toBe("tombstoned");
          }
        }
        expect(result.first.externalDataPreserved).toBe(true);
        expect(result.first.filesDeleted).toBe(false);
      }),
  );

  effectIt.effect(
    "treats a legacy projection deletion as an effective tombstone without rewriting durable coordinates",
    () =>
      Effect.gen(function* () {
        const projectId = ProjectId.make("effective-tombstone-project");
        const result = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const lifecycle = yield* ProjectLifecycle;
          yield* runMigrations();
          yield* runForkMigrations(12);
          yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
          VALUES (${String(projectId)}, 'Deleted projection', '/workspace/projection', '[]',
            '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z',
            '2026-01-03T00:00:00.000Z')
        `;
          yield* sql`
          INSERT INTO project_lifecycle
            (project_id, state, workspace_root, repository_key, revision, changed_at)
          VALUES (${String(projectId)}, 'active', '/workspace/durable', 'github:owner/repo', 4,
            '2026-01-02T00:00:00.000Z')
        `;

          const project = yield* lifecycle.get(projectId);
          const rows = yield* sql<Record<string, unknown>>`
          SELECT state, workspace_root AS workspaceRoot, repository_key AS repositoryKey
          FROM project_lifecycle WHERE project_id = ${String(projectId)}
        `;
          return { project, row: rows[0] };
        }).pipe(Effect.provide(lifecycleLayer));

        expect(result.project).toMatchObject({
          state: "tombstoned",
          workspaceRoot: "/workspace/durable",
          repositoryKey: "github:owner/repo",
          revision: 4,
        });
        expect(result.row).toEqual({
          state: "active",
          workspaceRoot: "/workspace/durable",
          repositoryKey: "github:owner/repo",
        });
      }),
  );

  effectIt.effect(
    "permanently deletes archived and legacy-deleted projects before fencing new tombstoned commands",
    () =>
      Effect.gen(function* () {
        const archivedProjectId = ProjectId.make("archived-delete-project");
        const legacyProjectId = ProjectId.make("legacy-delete-project");
        const result = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const lifecycle = yield* ProjectLifecycle;
          yield* runMigrations();
          yield* runForkMigrations(12);
          yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
          VALUES
            (${String(archivedProjectId)}, 'Archived', '/workspace/archived-delete', '[]',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
            (${String(legacyProjectId)}, 'Legacy deleted', '/workspace/legacy-delete', '[]',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
              '2026-01-02T00:00:00.000Z')
        `;
          yield* sql`
          INSERT INTO project_lifecycle
            (project_id, state, workspace_root, revision, changed_at)
          VALUES (${String(archivedProjectId)}, 'archived', '/workspace/archived-delete', 1,
            '2026-01-02T00:00:00.000Z')
        `;

          const archived = yield* lifecycle.permanentDelete({
            commandId: CommandId.make("archived-delete-command"),
            projectId: archivedProjectId,
            workspaceRoot: "/workspace/archived-delete",
            confirmation: "permanent-local-delete",
          });
          const legacyInput = {
            commandId: CommandId.make("legacy-delete-command"),
            projectId: legacyProjectId,
            workspaceRoot: "/workspace/legacy-delete",
            confirmation: "permanent-local-delete" as const,
          };
          const legacy = yield* lifecycle.permanentDelete(legacyInput);
          const replay = yield* lifecycle.permanentDelete(legacyInput);
          const fenced = yield* Effect.result(
            lifecycle.permanentDelete({
              ...legacyInput,
              commandId: CommandId.make("legacy-delete-command-2"),
            }),
          );
          return { archived, legacy, replay, fenced };
        }).pipe(Effect.provide(lifecycleLayer));

        expect(result.archived.tombstone?.reason).toBe("permanent-local-delete");
        expect(result.legacy.tombstone?.reason).toBe("legacy-project-delete");
        expect(result.replay).toEqual(result.legacy);
        expect(result.fenced._tag).toBe("Failure");
        if (
          result.fenced._tag === "Failure" &&
          Schema.is(ProjectLifecycleError)(result.fenced.failure)
        ) {
          expect(result.fenced.failure.reason).toBe("tombstoned");
        }
      }),
  );

  effectIt.effect("round-trips archive and restore through the durable lifecycle row", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("archived-project");
      const result = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const lifecycle = yield* ProjectLifecycle;
        yield* runMigrations();
        yield* runForkMigrations(12);
        yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES
            (${String(projectId)}, 'Archived project', '/workspace/archived', '[]',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `;
        const archived = yield* lifecycle.archive({
          commandId: CommandId.make("archive-command"),
          projectId,
          workspaceRoot: "/workspace/archived",
        });
        const restored = yield* lifecycle.restore({
          commandId: CommandId.make("restore-command"),
          projectId,
          workspaceRoot: "/workspace/archived",
        });
        const state = yield* lifecycle.get(projectId);
        return { archived, restored, state };
      }).pipe(Effect.provide(lifecycleLayer));

      expect(result.archived.project.state).toBe("archived");
      expect(result.restored.project.state).toBe("active");
      expect(result.state?.state).toBe("active");
    }),
  );

  effectIt.effect("rejects reuse of a lifecycle command id for a different request", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("lifecycle-conflict-project");
      const commandId = CommandId.make("lifecycle-conflict-command");
      const result = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const lifecycle = yield* ProjectLifecycle;
        yield* runMigrations();
        yield* runForkMigrations(12);
        yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES (${String(projectId)}, 'Conflict project', '/workspace/conflict', '[]',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `;
        yield* lifecycle.archive({ commandId, projectId, workspaceRoot: "/workspace/conflict" });
        return yield* Effect.result(
          lifecycle.restore({ commandId, projectId, workspaceRoot: "/workspace/conflict" }),
        );
      }).pipe(Effect.provide(lifecycleLayer));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(Schema.is(ProjectLifecycleError)(result.failure)).toBe(true);
        if (Schema.is(ProjectLifecycleError)(result.failure)) {
          expect(result.failure.reason).toBe("operation-conflict");
        }
      }
    }),
  );
});
