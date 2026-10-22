import { assert, it } from "@effect/vitest";
import { EventId, type Project, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Projects from "../project/ProjectService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import { emptyProjection, threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import * as Repository from "./AssistantRepository.ts";
import * as Provisioning from "./AssistantProvisioning.ts";
import { input, repository } from "./AssistantTestHelpers.ts";

const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(Repository.AssistantRecord));

it.effect(
  "rolls forward a lost launch result with the same identities and only explicitly repairs retained targets",
  () =>
    Effect.gen(function* () {
      let project: Project | null = null;
      let projection: OrchestrationV2ThreadProjection | null = null;
      let launchCalls = 0;
      let folderCalls = 0;
      let failLaunch = true;
      let archivedReceipt = false;
      const external = Layer.mergeAll(
        Layer.mock(Folders.ManagedProjectFolders)({
          namedProjectsRoot: "/owned",
          validateAssistantRepository: () => Effect.void,
          ensureAssistantRepository: () =>
            Effect.sync(() => {
              folderCalls++;
              return { workspaceRoot: "/owned/assistant" };
            }),
        }),
        Layer.mock(Projects.ProjectService)({
          getById: () => Effect.sync(() => Option.fromNullishOr(project)),
          create: (request) =>
            Effect.sync(() => {
              project = {
                id: request.projectId,
                title: request.title,
                workspaceRoot: request.workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-10-21T00:00:00.000Z",
                updatedAt: "2026-10-21T00:00:00.000Z",
                deletedAt: null,
              };
              return project;
            }),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () =>
            Effect.sync(() => (projection ? threadShellFromProjection(projection) : null)),
        }),
        Layer.mock(Launch.ThreadLaunchService)({
          launch: (request) =>
            Effect.gen(function* () {
              launchCalls++;
              assert.isUndefined(request.initialMessage);
              assert.isDefined(request.threadId);
              if (failLaunch) {
                failLaunch = false;
                return yield* new Launch.ThreadLaunchError({
                  operation: "create-thread",
                  commandId: request.commandId,
                  projectId: request.projectId,
                  cause: "lost launch result",
                });
              }
              const now = DateTime.makeUnsafe("2026-10-21T00:00:00.000Z");
              const threadId = request.threadId!;
              projection = emptyProjection({
                id: EventId.make("created"),
                type: "thread.created",
                threadId,
                occurredAt: now,
                payload: {
                  id: threadId,
                  createdBy: "system",
                  creationSource: "server",
                  projectId: request.projectId,
                  title: request.title,
                  providerInstanceId: request.modelSelection.instanceId,
                  modelSelection: request.modelSelection,
                  runtimeMode: request.runtimeMode,
                  interactionMode: request.interactionMode,
                  branch: null,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: {
                    parentThreadId: null,
                    relationshipToParent: null,
                    rootThreadId: threadId,
                  },
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                  archivedAt: archivedReceipt ? now : null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: null,
                },
              });
              return { threadId, projection, resumed: false };
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const repo = yield* Repository.AssistantRepository;
        const provision = yield* Provisioning.AssistantProvisioning;
        const record = yield* repo.create(input);
        assert.equal((yield* provision.ensure(record).pipe(Effect.result))._tag, "Failure");
        assert.equal(
          (yield* repo.get(record.detail.summary)).detail.summary.provisioningState,
          "failed",
        );
        const ready = yield* provision.ensure(record);
        assert.equal(ready.detail.summary.provisioningState, "ready");
        assert.equal(launchCalls, 2);
        assert.equal(folderCalls, 1);
        assert.deepStrictEqual(ready.detail.summary.binding, record.detail.summary.binding);
        const retainedProject = project;
        project = null;
        const paused = yield* provision.reconcile(ready);
        assert.equal(paused.detail.summary.provisioningState, "needs-repair");
        assert.equal((yield* provision.ensure(paused).pipe(Effect.result))._tag, "Failure");
        assert.equal(launchCalls, 2);
        assert.equal(
          (yield* provision.reconcile(paused, { repair: true })).detail.summary.provisioningState,
          "needs-repair",
        );
        project = retainedProject;
        assert.equal(
          (yield* provision.reconcile(paused)).detail.summary.provisioningState,
          "needs-repair",
        );
        assert.equal(
          (yield* provision.reconcile(paused, { repair: true })).detail.summary.provisioningState,
          "ready",
        );
        assert.equal((yield* repo.get(record.detail.summary)).ownerRevision, 0);
        const sql = yield* SqlClient.SqlClient;
        const originalProjection = projection!;
        for (const mutation of [
          "archived",
          "worktree",
          "deleted-project",
          "rebound-project",
        ] as const) {
          const partial: Repository.AssistantRecord = {
            ...ready,
            provisioningStage: "thread",
            detail: {
              ...ready.detail,
              summary: { ...ready.detail.summary, provisioningState: "provisioning" },
              provisioning: {
                state: "provisioning",
                stage: "thread",
                binding: ready.detail.summary.binding,
              },
            },
          };
          const payload = yield* encodeRecord(partial);
          yield* sql`UPDATE t3_workflow_v2_assistants SET provisioning_state='provisioning',payload_json=${payload}`;
          if (mutation === "archived")
            projection = {
              ...originalProjection,
              thread: {
                ...originalProjection.thread,
                archivedAt: DateTime.makeUnsafe("2026-10-22T00:00:00.000Z"),
              },
            };
          if (mutation === "worktree")
            projection = {
              ...originalProjection,
              thread: { ...originalProjection.thread, worktreePath: "/other/checkout" },
            };
          if (mutation === "deleted-project")
            project = { ...retainedProject!, deletedAt: "2026-10-22T00:00:00.000Z" };
          if (mutation === "rebound-project")
            project = { ...retainedProject!, workspaceRoot: "/other/root" };
          assert.equal((yield* provision.ensure(partial).pipe(Effect.result))._tag, "Failure");
          const current = yield* repo.get(record.detail.summary);
          assert.equal(current.detail.summary.provisioningState, "needs-repair");
          assert.equal(current.provisioningStage, "thread");
          assert.equal(launchCalls, 2);
          assert.equal(folderCalls, 1);
          projection = originalProjection;
          project = retainedProject;
          yield* provision.reconcile(current, { repair: true });
        }
        // A project-stage crash can recover an accepted launch receipt; an archived
        // receipt must still pause even if the pre-launch shell lookup was empty.
        const partial: Repository.AssistantRecord = {
          ...ready,
          provisioningStage: "project",
          detail: {
            ...ready.detail,
            summary: { ...ready.detail.summary, provisioningState: "provisioning" },
            provisioning: {
              state: "provisioning",
              stage: "project",
              binding: ready.detail.summary.binding,
            },
          },
        };
        const payload = yield* encodeRecord(partial);
        yield* sql`UPDATE t3_workflow_v2_assistants SET provisioning_state='provisioning',payload_json=${payload}`;
        projection = null;
        archivedReceipt = true;
        assert.equal((yield* provision.ensure(partial).pipe(Effect.result))._tag, "Failure");
        assert.equal(
          (yield* repo.get(record.detail.summary)).detail.summary.provisioningState,
          "needs-repair",
        );
        assert.equal(launchCalls, 3);
        assert.equal(folderCalls, 1);
      }).pipe(
        Effect.provide(
          Provisioning.layer.pipe(Layer.provideMerge(external), Layer.provideMerge(repository)),
        ),
      );
    }),
);
