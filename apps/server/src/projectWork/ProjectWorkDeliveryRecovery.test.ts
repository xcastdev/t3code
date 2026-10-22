import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  CommandId,
  ProjectWorkDeliveryRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { readDeliveryRecovery, retainDeliveryPreview } from "./ProjectWorkDeliveryGateway.ts";
import * as Gateway from "./ProjectWorkDeliveryGateway.ts";
import * as Sources from "./ProjectTeamIntegrationSources.ts";
import * as Host from "./ProjectWorkPublicationHost.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Engine from "../orchestration-v2/Orchestrator.ts";
import * as Repository from "./ProjectWorkRepository.ts";
import * as Journal from "./ProjectWorkPublicationJournal.ts";
import { operation, confirmation } from "./ProjectWorkPublication.testkit.ts";
import {
  layer,
  seed,
  env,
  projectId,
  taskId,
  human,
  at,
} from "./memory/ProjectMemoryService.test-utils.ts";

const decodeRequest = Schema.decodeUnknownEffect(ProjectWorkDeliveryRequest);
const testLayer = Journal.layer.pipe(Layer.provideMerge(layer));
it.effect(
  "recovers exact public requests and confirmed merge receipts from SQL without exposing private decisions",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const original = operation("merge");
      const retained = {
        ...original,
        decision: {
          ...original.decision,
          request: {
            ...original.decision.request,
            target: { ...original.decision.request.target, projectId, taskId },
          },
        },
      };
      const journal = yield* Journal.ProjectWorkPublicationJournal;
      yield* journal.retain(retained);
      yield* journal.claim(retained);
      const request: ProjectWorkDeliveryRequest = {
        operation: "preview",
        input: {
          commandId: CommandId.make("preview"),
          expectedRevision: 1,
          projectId,
          taskId,
          sourceRef: { ...retained.decision.sourceRef, taskId },
          baseRef: "main",
          kind: "merge",
          publicationOperationId: "publish",
          mergeMethod: "squash",
        },
      };
      yield* sql`INSERT INTO t3_workflow_v2_delivery_previews(project_id,task_id,command_id,request_json,gate_id,base_ref) VALUES(${projectId},${taskId},'preview',${JSON.stringify(request)},'gate','main')`;
      const first = yield* readDeliveryRecovery(sql, env, { projectId, taskId, limit: 1 });
      assert.equal(first.items[0]!.result.stage, "claimed");
      assert.deepEqual(first.items[0]!.request, {
        operation: "merge",
        input: { operationId: "merge", publicationOperationId: "publish", gateId: "gate" },
      });
      assert.isDefined(first.nextCursor);
      const second = yield* readDeliveryRecovery(sql, env, {
        projectId,
        taskId,
        limit: 1,
        cursor: first.nextCursor!,
      });
      assert.deepEqual(second.items[0]!.request, request);
      yield* journal.save({ ...retained, stage: "confirmed", merge: confirmation });
      const recovered = yield* readDeliveryRecovery(sql, env, { projectId, taskId, limit: 32 });
      assert.equal(
        recovered.items[0]!.result.receiptHash,
        Journal.publicationHash({ ...retained, stage: "confirmed", merge: confirmation }),
      );
      assert.equal(recovered.environmentId, env);
      const publicJson = JSON.stringify(recovered);
      for (const forbidden of [
        "credentialFingerprint",
        "accountId",
        "viewer",
        "/owned/workspace",
        "principal",
        "decisionHash",
      ])
        assert.equal(publicJson.includes(forbidden), false);
      yield* decodeRequest(recovered.items[0]!.request);
      assert.equal(
        (yield* Effect.result(readDeliveryRecovery(sql, env, { projectId, taskId, limit: 33 })))
          ._tag,
        "Failure",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "preview retention rolls back with its gate transaction and duplicate receipts preserve the original request",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* Repository.ProjectWorkRepository;
      const state = yield* Repository.readCurrentState(sql, projectId);
      const commandId = CommandId.make("atomic-preview");
      const input = {
        commandId,
        projectId,
        taskId,
        expectedRevision: state.revision,
        sourceRef: { ...operation().decision.sourceRef, taskId },
        baseRef: "main",
        kind: "create-pr" as const,
      };
      const command = {
        type: "project-work.foundation.commit" as const,
        commandId,
        projectId,
        expectedRevision: state.revision,
        attribution: human,
        committedAt: at,
        records: [],
      };
      const rejected = yield* Effect.result(
        repository.executeAuthorized(command, () =>
          retainDeliveryPreview(sql, input, "preview-gate", "main").pipe(
            Effect.andThen(Effect.fail(new Journal.PublicationError({ reason: "stale" }))),
          ),
        ),
      );
      assert.equal(rejected._tag, "Failure");
      assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_delivery_previews`).length, 0);
      const gate = {
        ...operation().decision.gate,
        recordId: "preview-gate",
        projectId,
        taskId,
        gate: "publication" as const,
        status: "proposed" as const,
        revision: 0,
        attribution: human,
      };
      let callbacks = 0;
      const commit = () =>
        repository.executeAuthorized(command, () =>
          Effect.gen(function* () {
            callbacks++;
            yield* retainDeliveryPreview(sql, input, "preview-gate", "main");
            return { ...command, records: [gate] };
          }),
        );
      yield* commit();
      yield* commit();
      assert.equal(callbacks, 1);
      const page = yield* readDeliveryRecovery(sql, env, { projectId, taskId, limit: 32 });
      assert.deepEqual(page.items[0]!.request, { operation: "preview", input });
      const current = yield* Repository.readCurrentState(sql, projectId);
      assert.equal(
        current.foundationRecords?.some((r) => r.recordId === "preview-gate"),
        true,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "real preview endpoint recovers lost responses before stale revision or host reads and rechecks both human scopes",
  () => {
    let captures = 0;
    let qualifications = 0;
    const unused = () => Effect.die("unused preview dependency");
    const stream = Stream.die("unused preview stream");
    const fixture = operation().decision;
    const source = { ...fixture.source, taskId };
    const endpointLayer = Gateway.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Sources.ProjectTeamIntegrationSources, {
            qualify: () => {
              qualifications++;
              return Effect.succeed(source);
            },
            compile: unused,
            assertCurrent: unused,
            coverage: unused,
            read: unused,
          }),
          Layer.succeed(Host.ProjectWorkPublicationHost, {
            capture: () => {
              captures++;
              return Effect.succeed({
                cwd: fixture.cwd,
                providerId: fixture.providerId,
                account: fixture.account,
                repository: fixture.request.repository,
                headRepositoryNodeId: "repository",
                headSelector: "feature",
                baseRef: "main",
              });
            },
            assertCurrent: unused,
            create: unused,
            reconcilePublication: unused,
            supportsExactMerge: unused,
            mergeExact: unused,
            reconcileMerge: unused,
          }),
          Layer.succeed(Environment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(env),
            getDescriptor: Effect.die("unused descriptor"),
          }),
          Layer.succeed(Engine.OrchestratorV2, {
            stopExactRun: unused,
            stopOwnedRun: unused,
            resumeQueuedRuns: Effect.die("unused"),
            recoverDelegatedTasks: Effect.die("unused"),
            recoverDelegatedTask: unused,
            delegatedTaskResultPending: unused,
            restartContinuationPending: unused,
            awaitRestartContinuation: unused,
            dispatch: unused,
            autoArmLimitRecovery: unused,
            searchThreadStream: () => stream,
            searchThread: unused,
            getThreadHistoryPage: unused,
            getTimelinePage: unused,
            getMessageCount: unused,
            getTurnItem: unused,
            getThreadRecords: unused,
            getThreadProjection: unused,
            getCheckpointContext: unused,
            getThreadSnapshot: unused,
            getThreadSnapshotWindow: unused,
            getShellSnapshot: unused,
            readShellSnapshot: unused,
            getThreadShell: unused,
            getThreadEventSequence: unused,
            streamStoredEvents: stream,
            streamStoredEventsFrom: () => stream,
            streamDomainEvents: stream,
          }),
        ),
      ),
      Layer.provideMerge(Authorization.layer.pipe(Layer.provideMerge(AuthSessions.layer))),
      Layer.provideMerge(testLayer),
    );
    return Effect.gen(function* () {
      yield* seed();
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const createSession = (
        sessionId: string,
        scopes: ReadonlyArray<
          typeof AuthOrchestrationOperateScope | typeof AuthSourceControlWriteScope
        >,
      ) =>
        sessions.create({
          sessionId: AuthSessionId.make(sessionId),
          subject: "person",
          scopes: [...scopes],
          method: "browser-session-cookie",
          client: {
            label: null,
            ipAddress: null,
            userAgent: null,
            deviceType: "unknown",
            os: null,
            browser: null,
          },
          issuedAt: DateTime.makeUnsafe(at),
          expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
        });
      yield* createSession("session", [AuthOrchestrationOperateScope, AuthSourceControlWriteScope]);
      const sql = yield* SqlClient.SqlClient;
      const state = yield* Repository.readCurrentState(sql, projectId);
      const gateway = yield* Gateway.ProjectWorkDeliveryGateway;
      const input = {
        commandId: CommandId.make("endpoint-preview"),
        projectId,
        taskId,
        expectedRevision: state.revision,
        sourceRef: { ...fixture.sourceRef, taskId },
        baseRef: "main",
        kind: "create-pr" as const,
      };
      const first = yield* gateway.preview(input, human);
      const recovered = yield* readDeliveryRecovery(sql, env, { projectId, taskId, limit: 32 });
      const original = recovered.items[0]!.request;
      if (original.operation !== "preview") throw new Error("Expected retained preview");
      assert.deepEqual(yield* gateway.preview(original.input, human), first);
      const concurrent = yield* Effect.all(
        [gateway.preview(input, human), gateway.preview(input, human)],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(concurrent, [first, first]);
      assert.equal(
        (yield* Effect.result(gateway.preview({ ...input, baseRef: "changed" }, human)))._tag,
        "Failure",
      );
      assert.equal(captures, 1);
      assert.equal(qualifications, 2);
      assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_delivery_previews`).length, 1);
      yield* createSession("only-operate", [AuthOrchestrationOperateScope]);
      yield* createSession("only-source", [AuthSourceControlWriteScope]);
      for (const id of ["only-operate", "only-source"])
        assert.equal(
          (yield* Effect.result(gateway.preview(input, { ...human, source: { kind: "web", id } })))
            ._tag,
          "Failure",
        );
      yield* sessions.revoke({
        sessionId: AuthSessionId.make("session"),
        revokedAt: DateTime.makeUnsafe(at),
      });
      assert.equal((yield* Effect.result(gateway.preview(input, human)))._tag, "Failure");
      assert.equal(captures, 1);
    }).pipe(Effect.provide(endpointLayer));
  },
);
