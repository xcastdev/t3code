import {
  canonicalProjectWorkPayload,
  ProjectTeamEffect,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkTaskId,
  ThreadId,
  CommandId,
  ProjectWorkAttemptId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import {
  seed,
  restoreHistoricalBinding,
  providerInstanceId,
  threadId,
  at,
  projectId,
  attribution,
  createManagedAssignment,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import { preallocatePiManagedProcess } from "../provider/pi/PiManagedProcess.ts";
import { makeProjectTeamPiOperations } from "./ProjectTeamPiOperations.ts";
import { makeProjectTaskResources } from "./ProjectTaskResources.ts";
import { make as makeAccounting } from "./ProjectTeamModelAccounting.ts";
import type { ProjectTeamPiSubscriptionTestSelection } from "./ProjectTeamModelAccounting.ts";
import { PiManagedRuntimeError } from "../provider/pi/PiManagedRuntime.ts";
import type { PiSessionTerminal } from "../provider/pi/PiSessionRuntime.ts";
import { inspectPiSubscriptionConfiguration } from "../provider/pi/PiSubscriptionConfiguration.ts";

const decodeSetup = Schema.decodeUnknownEffect(ProjectTeamEffect);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parseJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const model = "inclusionai/ling-3.1-flash:free";
const time = Date.parse(at) + 100;
const isoTime = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const decodeFixtureObject = Schema.decodeUnknownEffect(Schema.JsonObject);
const fileTest = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const live = Layer.mergeAll(
        Authorization.layer,
        ProjectWorkRepositoryLive,
        ProjectWorkProjectionLive,
        ProjectWorkQueryLive,
      ).pipe(Layer.provideMerge(makeSqlitePersistenceLive(`${directory}/runtime.sqlite`)));
      return yield* body.pipe(Effect.provide(live));
    }),
  ).pipe(Effect.provide(NodeServices.layer));
const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(time);
  const f = yield* seed("investigator", "reserved", {
    nativeSessionId: null,
    roleTools: [],
    toolIds: [],
  });
  const fs = yield* FileSystem.FileSystem;
  const worktree = yield* fs.makeTempDirectoryScoped();
  const protectedRoot = yield* fs.makeTempDirectoryScoped();
  const nativeRoot = yield* fs.makeTempDirectoryScoped();
  const role = { ...f.role, model, instructions: "Investigate the assigned task" };
  yield* restoreHistoricalBinding(role);
  const binding = {
    ...f.binding,
    worktree,
    model,
    configuration: {
      ...f.binding.configuration,
      instructionsHash: NodeCrypto.createHash("sha256").update(role.instructions).digest("hex"),
      maxTokens: 20000,
      maxDurationMs: 300000,
      runtimeVersion: "0.99.1",
    },
  };
  yield* restoreHistoricalBinding(binding);
  const allocation = yield* preallocatePiManagedProcess({
    workspaceRoot: worktree,
    workspaceAccess: "readonly",
    nativeStateRoot: nativeRoot,
    protectedRoots: [protectedRoot],
    runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
    argv: ["/bin/true"],
    memoryBytes: 33554432,
    runtimeSeconds: 10,
  });
  const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
  const identity = { providerInstanceId, threadId };
  const prepare = (id = "initialize") =>
    operations.prepare(identity, { threadId, kind: "initialize" }, "request", {
      allocation,
      workerId: "worker",
      operationId: id,
    });
  return { ...f, binding, role, allocation, operations, identity, prepare };
});
const rejected = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => expect(result._tag).toBe("Failure")),
  );

const journalFixture = (selectedModel: string = model) =>
  Effect.gen(function* () {
    const repository = yield* ProjectWorkRepository;
    const sql = yield* SqlClient.SqlClient;
    let claim: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    yield* seed("investigator", "reserved", {
      nativeSessionId: null,
      roleTools: [],
      toolIds: [],
      issueCredential: false,
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...repository,
        execute: (command) => {
          if (
            command.type === "project-work.foundation.commit" &&
            command.transition?.kind === "claim"
          ) {
            claim = command;
            return Effect.fail(
              new ProjectWorkPolicyError("invalid-state", "Retain journal fixture claim"),
            );
          }
          return repository.execute(command);
        },
      }),
      Effect.result,
    );
    if (!claim || claim.transition?.kind !== "claim")
      return yield* Effect.die("Missing journal fixture claim");
    const state = yield* readCurrentState(sql, projectId);
    const role = state.foundationRecords?.find((r) => r.kind === "role-revision");
    if (role?.kind !== "role-revision") return yield* Effect.die("Missing journal role");
    yield* restoreHistoricalBinding({ ...role, model: selectedModel });
    const fs = yield* FileSystem.FileSystem;
    const worktree = yield* fs.makeTempDirectoryScoped();
    const nativeRoot = yield* fs.makeTempDirectoryScoped();
    const protectedRoot = yield* fs.makeTempDirectoryScoped();
    const binding = {
      ...claim.transition.binding,
      worktree,
      branch: "refs/heads/assigned",
      model: selectedModel,
      configuration: {
        ...claim.transition.binding.configuration,
        maxTokens: 20000,
        maxDurationMs: 300000,
        runtimeVersion: "0.99.1",
      },
    };
    const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
    yield* repository.execute(
      yield* decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "journal-limits",
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        attribution,
        committedAt: at,
        records: [
          {
            kind: "limits",
            projectId,
            recordId: "limits",
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "configured",
            model: selectedModel,
            tokenLimit: 20000,
            durationLimitMs: 300000,
            environmentModelCalls: 2,
            modelCalls: 2,
            projectWritableWorkers: 1,
            delegationDepth: 2,
            repairAllowance: 2,
          },
        ],
      }),
    );
    const request = {
      dispatchId: "journal-dispatch",
      claim: {
        ...claim,
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        transition: {
          ...claim.transition,
          binding,
          claim: { ...claim.transition.claim, leasedUntil: isoTime(time + 10000) },
        },
      },
      git: {
        effectId: "journal-dispatch",
        runId: binding.recordId,
        generation: binding.generation,
        primaryRoot: "/workspace",
        commonGitDirectory: "/workspace/.git",
        worktreePath: worktree,
        branchRef: binding.branch,
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: "owner",
        policyHash: "b".repeat(64),
      },
      setupId: "journal-setup",
      initializeOperationId: "journal-initialize",
      assignmentOperationId: "journal-assignment",
      assignment: "Investigate the approved task",
    };
    yield* TestClock.setTime(time);
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 2,
    });
    const admitted = yield* journal.reserve(request);
    const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
    const allocation = yield* preallocatePiManagedProcess({
      workspaceRoot: worktree,
      workspaceAccess: "readonly",
      nativeStateRoot: nativeRoot,
      protectedRoots: [protectedRoot],
      runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
      argv: ["/bin/true"],
      memoryBytes: 33554432,
      runtimeSeconds: 10,
    });
    const identity = { providerInstanceId, threadId };
    return {
      sql,
      journal,
      admitted,
      operations,
      allocation,
      identity,
      repository,
      request,
      binding,
      role: { ...role, model: selectedModel },
    };
  });

it.effect("uses the actual journal root budget while the operation keeps its shorter lease", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* journalFixture();
      const op = yield* f.operations.prepare(
        f.identity,
        { threadId, kind: "initialize" },
        "journal-request",
        {
          allocation: f.allocation,
          workerId: "journal-worker",
          operationId: "journal-initialize",
        },
      );
      expect(op.maximumTokens).toBe(20000);
      expect(op.deadlineAtMs).toBe(time + 10000);
      expect(
        yield* f.sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget`,
      ).toEqual([
        { maximum_tokens: 20000, deadline_at_ms: f.admitted.intent.limits.rootDeadlineAtMs },
      ]);
    }),
  ),
);

for (const scenario of [
  { outcome: "unknown", promptNative: "persisted" },
  { outcome: "reported", promptNative: "persisted" },
  { outcome: "unknown", promptNative: "missing" },
  { outcome: "reported", promptNative: "missing" },
] as const)
  it.effect(
    `joined failure proof follows original subscription accounting: ${scenario.outcome}, ${scenario.promptNative} native`,
    () =>
      fileTest(
        Effect.gen(function* () {
          const { outcome } = scenario;
          const f = yield* journalFixture("gpt-6-luna");
          const fs = yield* FileSystem.FileSystem;
          const executable = yield* fs.realPath("/usr/bin/true");
          const allocationFor = () =>
            preallocatePiManagedProcess({
              workspaceRoot: f.binding.worktree,
              workspaceAccess: "readonly",
              nativeStateRoot: f.allocation.launch.nativeStateRoot,
              protectedRoots: f.allocation.launch.protectedRoots,
              runtimeFiles: [{ source: executable, target: "/bin/true" }],
              argv: ["/bin/true"],
              memoryBytes: 33554432,
              runtimeSeconds: 10,
            });
          const ownerFor = (allocation: typeof f.allocation) => ({
            type: "owner" as const,
            unit: allocation.unit,
            nonce: allocation.nonce,
            invocation: "a".repeat(32),
            cgroup: `/sys/fs/cgroup/${allocation.unit}`,
            pid: 123,
            memoryBytes: allocation.policy.memoryBytes,
            swapBytes: 0 as const,
            oomGroup: 1 as const,
          });
          const drainFor = (owner: ReturnType<typeof ownerFor>) => ({
            unit: owner.unit,
            invocation: owner.invocation,
            cgroup: owner.cgroup,
            ownerPid: owner.pid,
            memoryBytes: owner.memoryBytes,
            swapBytes: 0 as const,
            oomGroup: 1 as const,
            launcherPid: 124,
            childPid: 125,
            childExitCode: 0,
            kernel: "populated 0\nfrozen 0",
          });
          const initializeAllocation = yield* allocationFor();
          const initialize = yield* f.operations.prepare(
            f.identity,
            { threadId, kind: "initialize" },
            "joined-failure-initialize",
            {
              allocation: initializeAllocation,
              workerId: "joined-failure-worker",
              operationId: f.request.initializeOperationId,
            },
          );
          const initializeOwner = ownerFor(initializeAllocation);
          const initializeDrain = drainFor(initializeOwner);
          yield* f.operations.persistence(initialize).claimActivation(initializeAllocation);
          yield* f.operations.persistence(initialize).beforeStart(initializeOwner);
          yield* f.operations.persistNative(initialize, nativeReference);
          yield* f.operations.persistTerminal(initialize, {
            identity: { workerId: initialize.workerId, generation: 0 },
            operation: initialize.operation,
            outcome: "success",
            ownerCaptured: true,
            native: nativeReference,
            drain: initializeDrain,
            accountingReceipts: [],
          });
          const request = {
            threadId,
            kind: "prompt" as const,
            operationId: f.request.assignmentOperationId,
            prompt: f.request.assignment,
          };
          const requestHash = NodeCrypto.createHash("sha256")
            .update(canonicalProjectWorkPayload(request))
            .digest("hex");
          const promptAllocation = yield* allocationFor();
          const prompt = yield* f.operations.prepare(f.identity, request, requestHash, {
            allocation: promptAllocation,
            workerId: "joined-failure-worker",
            operationId: request.operationId,
            resourceHash: "a".repeat(64),
          });
          const promptOwner = ownerFor(promptAllocation);
          const promptDrain = drainFor(promptOwner);
          yield* f.operations.persistence(prompt).claimActivation(promptAllocation);
          yield* f.operations.persistence(prompt).beforeStart(promptOwner);
          if (scenario.promptNative === "persisted" || outcome === "reported")
            yield* f.operations.persistNative(prompt, nativeReference);
          const configuration = yield* inspectPiSubscriptionConfiguration({
            agentDirectory: f.allocation.launch.nativeStateRoot,
            runtimeVersion: "0.99.1",
            nodeVersion: "22.19.0",
            selectedModel: { provider: "openai-codex", model: "gpt-6-luna" },
            limits: { maxInputTokens: 16_384, maxOutputTokens: 2_048, deadlineMs: 300_000 },
            reasoningEffort: "high",
            serviceTier: "default",
          });
          const subscriptionTest: ProjectTeamPiSubscriptionTestSelection = {
            projectId: f.binding.projectId,
            rootTaskId: f.admitted.intent.limits.rootTaskId,
            model: configuration.model,
            maximumTokens: 64_000,
            maximumDurationMs: 300_000,
          };
          const accounting = yield* makeAccounting({
            environmentId: "environment",
            routeId: "openai-subscription-luna",
            model: configuration.model,
            acceptedReportedModels: [configuration.model],
            subscriptionTest,
            resolveOperation: f.operations.resolveOperation,
          });
          const reservation = {
            workerId: prompt.workerId,
            operationId: prompt.operation.operationId,
            generation: 0,
            requestId: 1,
            routeId: "openai-subscription-luna",
            provider: "openai-codex" as const,
            model: configuration.model,
            maxInputTokens: configuration.maxInputTokens,
            maxOutputTokens: configuration.maxOutputTokens,
            callCount: 1 as const,
            deadlineAtMs: prompt.deadlineAtMs,
            accountingMode: "openai-subscription-monitored" as const,
            unknownMaximumTokens: 64_000 as const,
          };
          const foreignAccounting = yield* makeAccounting({
            environmentId: "environment",
            routeId: "openai-subscription-luna",
            model: configuration.model,
            acceptedReportedModels: [configuration.model],
            subscriptionTest: {
              ...subscriptionTest,
              rootTaskId: "foreign-subscription-root",
            },
            resolveOperation: f.operations.resolveOperation,
          });
          expect(
            (yield* foreignAccounting.reserve(prompt.principal, reservation).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          expect(yield* f.sql`SELECT * FROM project_team_pi_subscription_grant`).toHaveLength(0);
          expect(yield* f.sql`SELECT * FROM project_team_model_request`).toHaveLength(0);
          const reserved = yield* accounting.reserve(prompt.principal, reservation);
          const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
          const settled = yield* accounting.settle({
            ...reservation,
            reservationId: reserved.reservationId,
            outcome,
            transportDrained: outcome === "reported",
            chargedInputTokens: outcome === "reported" ? 10 : reservation.maxInputTokens,
            chargedOutputTokens: outcome === "reported" ? 20 : 64_000,
            ...(outcome === "reported"
              ? { reportedModel: configuration.model, reportedUsage: usage }
              : {}),
            accountingMode: "openai-subscription-monitored",
            unknownMaximumTokens: 64_000,
          });
          const failedTerminal = {
            identity: { workerId: prompt.workerId, generation: 0 },
            operation: prompt.operation,
            outcome: outcome === "reported" ? ("success" as const) : ("canceled" as const),
            ownerCaptured: true,
            native:
              scenario.promptNative === "persisted" || outcome === "reported"
                ? nativeReference
                : null,
            drain:
              scenario.promptNative === "missing" && outcome === "unknown"
                ? { ...promptDrain, kernel: "removed" }
                : promptDrain,
            accountingReceipts:
              outcome === "reported"
                ? [
                    {
                      requestId: reservation.requestId,
                      routeId: reservation.routeId,
                      provider: reservation.provider,
                      model: reservation.model,
                      reportedModel: configuration.model,
                      usage,
                      reservationId: reserved.reservationId,
                      accountingReceiptId: settled.accountingReceiptId,
                    },
                  ]
                : [],
          } satisfies PiSessionTerminal;
          yield* f.operations.persistTerminal(prompt, failedTerminal);
          if (outcome === "reported" && scenario.promptNative === "missing") {
            // The successful terminal is first persisted through the real producer, then its
            // native receipts are removed to prove the reader refuses the incomplete record.
            yield* f.sql`UPDATE project_team_pi_operation SET native_json=NULL,terminal_json=${encodeJson(
              {
                ...failedTerminal,
                native: null,
              },
            )} WHERE operation_id=${prompt.operation.operationId}`;
            expect(
              (yield* f.sql
                .withTransaction(f.operations.readJoinedQuarantinedFailureInTransaction(f.admitted))
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            return;
          }
          const proof = yield* f.sql.withTransaction(
            f.operations.readJoinedQuarantinedFailureInTransaction(f.admitted),
          );
          if (outcome === "reported") {
            expect(proof).toBeUndefined();
            expect(
              yield* f.sql`SELECT stopped_at_ms,stop_reason FROM project_team_pi_subscription_grant`,
            ).toEqual([{ stopped_at_ms: null, stop_reason: null }]);
            expect(
              yield* f.sql`SELECT status,capacity_state,charged_input_tokens,charged_output_tokens FROM project_team_model_request`,
            ).toEqual([
              {
                status: "reported",
                capacity_state: "released",
                charged_input_tokens: 10,
                charged_output_tokens: 20,
              },
            ]);
            return;
          }
          expect(proof).toMatchObject({ operationId: prompt.operation.operationId });
          expect(proof?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
          if (scenario.promptNative === "missing") {
            const tamperedTerminals = [
              { ...failedTerminal, ownerCaptured: false },
              { ...failedTerminal, drain: null },
              {
                ...failedTerminal,
                identity: { ...failedTerminal.identity, workerId: "foreign-worker" },
              },
              {
                ...failedTerminal,
                identity: { ...failedTerminal.identity, generation: 1 },
              },
              {
                ...failedTerminal,
                operation: { ...failedTerminal.operation, operationId: "foreign-operation" },
              },
              {
                ...failedTerminal,
                operation: { ...failedTerminal.operation, operationKind: "compact" as const },
              },
            ];
            for (const terminal of tamperedTerminals) {
              yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${encodeJson(terminal)}
              WHERE operation_id=${prompt.operation.operationId}`;
              expect(
                (yield* f.sql
                  .withTransaction(
                    f.operations.readJoinedQuarantinedFailureInTransaction(f.admitted),
                  )
                  .pipe(Effect.result))._tag,
              ).toBe("Failure");
            }
            yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${encodeJson(failedTerminal)}
            WHERE operation_id=${prompt.operation.operationId}`;
            const foreignRoot = {
              ...f.admitted,
              intent: {
                ...f.admitted.intent,
                limits: {
                  ...f.admitted.intent.limits,
                  rootTaskId: ProjectWorkTaskId.make("foreign-root-task"),
                },
              },
            };
            expect(
              (yield* f.sql
                .withTransaction(
                  f.operations.readJoinedQuarantinedFailureInTransaction(foreignRoot),
                )
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect(
              (yield* f.sql`UPDATE project_team_model_request SET root_task_id='foreign-root-task'
              WHERE operation_id=${prompt.operation.operationId}`.pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect(
              yield* f.sql`SELECT root_task_id FROM project_team_model_request
              WHERE operation_id=${prompt.operation.operationId}`,
            ).toEqual([{ root_task_id: f.admitted.intent.limits.rootTaskId }]);
            yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${encodeJson({
              ...failedTerminal,
              accountingReceipts: [{}],
            })} WHERE operation_id=${prompt.operation.operationId}`;
            expect(
              (yield* f.sql
                .withTransaction(f.operations.readJoinedQuarantinedFailureInTransaction(f.admitted))
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${encodeJson(failedTerminal)}
            WHERE operation_id=${prompt.operation.operationId}`;
          }
          const originalBudget = yield* f.sql`SELECT maximum_tokens,deadline_at_ms
        FROM project_team_model_budget`;
          const originalGrant = yield* f.sql`SELECT * FROM project_team_pi_subscription_grant`;
          const originalCapacity =
            yield* f.sql`SELECT status,capacity_state,charged_input_tokens,charged_output_tokens
        FROM project_team_model_request`;
          expect(originalGrant).toHaveLength(1);
          expect(originalGrant[0]).toMatchObject({
            environment_id: "environment",
            project_id: f.binding.projectId,
            root_task_id: f.admitted.intent.limits.rootTaskId,
            model: configuration.model,
            route_id: "openai-subscription-luna",
            maximum_tokens: 64_000,
            maximum_duration_ms: 300_000,
            stopped_at_ms: time,
            stop_reason: "unknown-usage",
          });
          expect(
            (yield* f.sql`UPDATE project_team_pi_subscription_grant SET model='foreign-model'
            WHERE environment_id='environment' AND project_id=${f.binding.projectId}
            AND root_task_id=${f.admitted.intent.limits.rootTaskId}`.pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(originalBudget).toEqual([
            {
              maximum_tokens: f.admitted.intent.limits.maximumTokens,
              deadline_at_ms: f.admitted.intent.limits.rootDeadlineAtMs,
            },
          ]);
          expect(originalCapacity).toEqual([
            {
              status: "unknown",
              capacity_state: "quarantine",
              charged_input_tokens: configuration.maxInputTokens,
              charged_output_tokens: 64_000,
            },
          ]);
          yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens='malformed'
        WHERE environment_id='environment' AND project_id=${f.binding.projectId}
        AND root_task_id=${f.admitted.intent.limits.rootTaskId}`;
          const malformedCeiling = f.operations.readJoinedQuarantinedFailureInTransaction(
            f.admitted,
          );
          expect((yield* f.sql.withTransaction(malformedCeiling).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=${originalBudget[0]!.maximum_tokens}`;
          yield* f.sql`UPDATE project_team_model_budget SET deadline_at_ms='malformed'
        WHERE environment_id='environment' AND project_id=${f.binding.projectId}
        AND root_task_id=${f.admitted.intent.limits.rootTaskId}`;
          const malformedDeadline = f.operations.readJoinedQuarantinedFailureInTransaction(
            f.admitted,
          );
          expect((yield* f.sql.withTransaction(malformedDeadline).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          yield* f.sql`UPDATE project_team_model_budget SET deadline_at_ms=${originalBudget[0]!.deadline_at_ms}`;
          const foreign = f.operations.readJoinedQuarantinedFailureInTransaction({
            ...f.admitted,
            fence: { ...f.admitted.fence, dispatchId: "foreign-dispatch" },
          });
          expect((yield* f.sql.withTransaction(foreign).pipe(Effect.result))._tag).toBe("Failure");
          yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${encodeJson({
            ...failedTerminal,
            native: { ...nativeReference, leafId: "foreign-native" },
          })} WHERE operation_id=${prompt.operation.operationId}`;
          const forged = f.operations.readJoinedQuarantinedFailureInTransaction(f.admitted);
          expect((yield* f.sql.withTransaction(forged).pipe(Effect.result))._tag).toBe("Failure");
          yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${encodeJson({
            ...failedTerminal,
            outcome: "success",
          })} WHERE operation_id=${prompt.operation.operationId}`;
          expect(
            (yield* f.sql
              .withTransaction(f.operations.readJoinedQuarantinedFailureInTransaction(f.admitted))
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            yield* f.sql`SELECT status,capacity_state,charged_input_tokens,charged_output_tokens
          FROM project_team_model_request`,
          ).toEqual(originalCapacity);
        }),
      ),
  );

const journalChild = Effect.gen(function* () {
  const f = yield* journalFixture();
  const rootOperation = yield* f.operations.prepare(
    f.identity,
    { threadId, kind: "initialize" },
    "root",
    {
      allocation: f.allocation,
      workerId: "root-worker",
      operationId: "journal-initialize",
    },
  );
  yield* f.operations.persistNative(rootOperation, nativeReference);
  let claim: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  const childThreadId = ThreadId.make("journal-child-thread");
  const childTaskId = ProjectWorkTaskId.make("journal-child-task");
  yield* createManagedAssignment({
    taskId: childTaskId,
    recordId: "journal-child",
    attemptId: "journal-child-attempt",
    commandId: "journal-child-dispatch",
    providerInstanceId,
    threadId: childThreadId,
    role: f.role,
    status: "reserved",
    parentRunId: f.binding.recordId,
    configuration: { ...f.binding.configuration, maxTokens: 1000, maxDurationMs: 1000 },
    leasedUntil: isoTime(time + 5000),
  }).pipe(
    Effect.provideService(ProjectWorkRepository, {
      ...f.repository,
      execute: (command) => {
        if (
          command.type === "project-work.foundation.commit" &&
          command.transition?.kind === "claim"
        ) {
          claim = command;
          return Effect.fail(new ProjectWorkPolicyError("invalid-state", "Retain child claim"));
        }
        return f.repository.execute(command);
      },
    }),
    Effect.result,
  );
  if (!claim || claim.transition?.kind !== "claim") return yield* Effect.die("Missing child claim");
  const state = yield* readCurrentState(f.sql, projectId);
  const membership = state.foundationRecords?.find(
    (r) => r.kind === "task-membership" && r.taskId === childTaskId,
  );
  if (membership?.kind !== "task-membership") return yield* Effect.die("Missing child membership");
  yield* restoreHistoricalBinding({
    ...membership,
    revision: membership.revision + 1,
    parentTaskId: f.binding.taskId,
  });
  const fs = yield* FileSystem.FileSystem;
  const worktree = yield* fs.makeTempDirectoryScoped();
  const binding = { ...claim.transition.binding, worktree, branch: "refs/heads/child" };
  const request = {
    ...f.request,
    dispatchId: "journal-child-dispatch",
    claim: {
      ...claim,
      expectedRevision: (yield* readCurrentState(f.sql, projectId)).revision,
      transition: { ...claim.transition, binding },
    },
    git: {
      ...f.request.git,
      effectId: "journal-child-dispatch",
      runId: binding.recordId,
      worktreePath: worktree,
      branchRef: binding.branch,
    },
    setupId: "child-setup",
    initializeOperationId: "child-initialize",
    assignmentOperationId: "child-assignment",
  };
  const admitted = yield* f.journal.reserve(request);
  const launch = f.allocation.launch;
  const allocation = yield* preallocatePiManagedProcess({
    workspaceRoot: worktree,
    workspaceAccess: "readonly",
    nativeStateRoot: yield* fs.makeTempDirectoryScoped(),
    protectedRoots: launch.protectedRoots,
    runtimeFiles: launch.runtimeFiles.map((file) => ({ source: file.source, target: file.target })),
    argv: launch.argv,
    memoryBytes: launch.memoryBytes,
    runtimeSeconds: launch.runtimeSeconds,
  });
  const identity = { providerInstanceId, threadId: childThreadId };
  const op = yield* f.operations.prepare(
    identity,
    { threadId: childThreadId, kind: "initialize" },
    "child-request",
    {
      allocation,
      workerId: "child-worker",
      operationId: request.initializeOperationId,
    },
  );
  return { ...f, child: { admitted, allocation, identity, op } };
});

it.effect("retained root budget and caps cannot be removed or rewritten through SQL", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* journalChild;
      const budget =
        yield* f.sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget`;
      const intents =
        yield* f.sql`SELECT dispatch_id,intent_json FROM project_team_dispatch ORDER BY dispatch_id`;
      expect(
        (yield* f.sql
          .withTransaction(
            f.sql`UPDATE project_team_dispatch SET intent_json=json_set(intent_json,'$.rootCaps.modelCalls',128) WHERE dispatch_id=${f.request.dispatchId}`,
          )
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.sql
          .withTransaction(f.sql`DELETE FROM project_team_model_budget`)
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect(
        yield* f.sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget`,
      ).toEqual(budget);
      expect(
        yield* f.sql`SELECT dispatch_id,intent_json FROM project_team_dispatch ORDER BY dispatch_id`,
      ).toEqual(intents);
      yield* f.operations.authorize(f.child.op);
      expect(
        yield* f.sql`SELECT operation_id FROM project_team_pi_operation ORDER BY operation_id`,
      ).toEqual([{ operation_id: "child-initialize" }, { operation_id: "journal-initialize" }]);
      expect(yield* f.sql`SELECT reservation_id FROM project_team_model_request`).toEqual([]);
    }),
  ),
);

it.effect(
  "charges a smaller actual journal child to the immutable root and enforces its operation caps",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* journalChild;
        const op = f.child.op;
        expect(op.maximumTokens).toBe(1000);
        expect(op.deadlineAtMs).toBe(Date.parse(at) + 1000);
        yield* f.operations.persistence(op).claimActivation(f.child.allocation);
        yield* f.operations.persistence(op).beforeStart({
          type: "owner",
          unit: f.child.allocation.unit,
          nonce: f.child.allocation.nonce,
          invocation: "a".repeat(32),
          cgroup: `/sys/fs/cgroup/${f.child.allocation.unit}`,
          pid: 123,
          memoryBytes: 33554432,
          swapBytes: 0,
          oomGroup: 1,
        });
        yield* f.operations.persistNative(op, { ...nativeReference, sessionId: "child-native" });
        const accounting = yield* makeAccounting({
          environmentId: "environment",
          routeId: "command-code-ling-free",
          model,
          acceptedReportedModels: [model],
          resolveOperation: f.operations.resolveOperation,
        });
        const request = {
          workerId: op.workerId,
          operationId: op.operation.operationId,
          generation: 0,
          requestId: 1,
          routeId: "command-code-ling-free",
          provider: "command-code" as const,
          model,
          maxInputTokens: 100,
          maxOutputTokens: 100,
          callCount: 1 as const,
          deadlineAtMs: time + 800,
        };
        const first = yield* accounting.reserve(op.principal, request);
        expect((yield* accounting.reserve(op.principal, request)).status).toBe("existing");
        yield* rejected(
          accounting.reserve(op.principal, { ...request, requestId: 2, maxInputTokens: 901 }),
        );
        yield* rejected(
          accounting.reserve(op.principal, { ...request, requestId: 2, deadlineAtMs: time + 901 }),
        );
        yield* accounting.settle({
          ...request,
          reservationId: first.reservationId,
          outcome: "unknown",
          transportDrained: true,
          chargedInputTokens: 100,
          chargedOutputTokens: 100,
        });
        expect(
          yield* f.sql`SELECT root_task_id,maximum_tokens,deadline_at_ms FROM project_team_model_budget`,
        ).toEqual([
          {
            root_task_id: f.binding.taskId,
            maximum_tokens: 20000,
            deadline_at_ms: f.admitted.intent.limits.rootDeadlineAtMs,
          },
        ]);
        expect(
          yield* f.sql`SELECT root_task_id,run_id,status,charged_input_tokens,charged_output_tokens FROM project_team_model_request`,
        ).toEqual([
          {
            root_task_id: f.binding.taskId,
            run_id: "journal-child",
            status: "unknown",
            charged_input_tokens: 100,
            charged_output_tokens: 100,
          },
        ]);
      }),
    ),
);

for (const mode of [
  "root-tokens",
  "root-deadline",
  "operation-tokens",
  "operation-deadline",
  "legacy-intent",
  "task-cycle",
  "task-orphan",
  "run-cycle",
  "run-orphan",
  "role-changed",
  "journal-intent",
  "journal-history",
  "root-revoked",
  "root-settled",
] as const)
  it.effect(`denies changed actual journal budget or ancestry without resetting it: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* journalChild;
        const op = f.child.op;
        const budget = yield* f.sql`SELECT * FROM project_team_model_budget`;
        switch (mode) {
          case "root-revoked":
          case "root-settled":
            yield* restoreHistoricalBinding({
              ...f.binding,
              revision: f.binding.revision + 1,
              status: mode === "root-revoked" ? "revoked" : "settled",
            });
            break;
          case "root-tokens":
            yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=maximum_tokens+1`;
            break;
          case "root-deadline":
            yield* f.sql`UPDATE project_team_model_budget SET deadline_at_ms=deadline_at_ms+1`;
            break;
          case "operation-tokens":
            yield* f.sql`UPDATE project_team_pi_operation SET maximum_tokens=maximum_tokens+1 WHERE operation_id=${op.operation.operationId}`;
            break;
          case "operation-deadline":
            yield* f.sql`UPDATE project_team_pi_operation SET deadline_at_ms=deadline_at_ms+1 WHERE operation_id=${op.operation.operationId}`;
            break;
          case "legacy-intent":
            yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_remove(intent_json,'$.rootBudget','$.operationLimits') WHERE operation_id=${op.operation.operationId}`;
            break;
          case "task-cycle":
          case "task-orphan": {
            const state = yield* readCurrentState(f.sql, projectId);
            const membership = state.foundationRecords?.find(
              (r) => r.kind === "task-membership" && r.taskId === op.authority.binding.taskId,
            );
            if (membership?.kind !== "task-membership")
              return yield* Effect.die("Missing membership");
            yield* restoreHistoricalBinding({
              ...membership,
              revision: membership.revision + 1,
              parentTaskId:
                mode === "task-cycle" ? membership.taskId : ProjectWorkTaskId.make("missing-task"),
            });
            break;
          }
          case "run-cycle":
          case "run-orphan":
            yield* restoreHistoricalBinding({
              ...op.authority.binding,
              revision: op.authority.binding.revision + 1,
              parentRunId: mode === "run-cycle" ? op.authority.binding.recordId : "missing-run",
            });
            break;
          case "role-changed":
            yield* restoreHistoricalBinding({
              ...f.role,
              revision: f.role.revision + 1,
              instructions: "Changed instructions",
            });
            break;
          case "journal-intent": {
            const rows = yield* f.sql<
              Record<string, unknown>
            >`SELECT * FROM project_team_dispatch WHERE binding_id=${op.authority.binding.recordId}`;
            const intent = parseJson(String(rows[0]!.intent_json));
            const changed = yield* decodeFixtureObject(intent);
            const request = yield* decodeFixtureObject(changed.request);
            yield* f.sql`DELETE FROM project_team_dispatch WHERE binding_id=${op.authority.binding.recordId}`;
            yield* f.sql`INSERT INTO project_team_dispatch ${f.sql.insert({ ...rows[0], intent_json: encodeJson({ ...changed, request: { ...request, initializeOperationId: "different" } }) })}`;
            break;
          }
          case "journal-history":
            yield* f.sql`INSERT INTO project_team_dispatch_receipt VALUES ('fabricated','journal-child-dispatch',1,0,'workspace-ready','{}',${at})`;
            break;
        }
        yield* rejected(f.operations.authorize(op));
        yield* rejected(f.operations.persistence(op).claimActivation(f.child.allocation));
        const after = yield* f.sql`SELECT * FROM project_team_model_budget`;
        if (mode === "root-tokens" || mode === "root-deadline") expect(after).not.toEqual(budget);
        else expect(after).toEqual(budget);
        expect(yield* f.sql`SELECT reservation_id FROM project_team_model_request`).toEqual([]);
        expect(
          yield* f.sql`SELECT status FROM project_team_pi_process WHERE operation_id=${op.operation.operationId}`,
        ).toEqual([{ status: "allocated" }]);
      }),
    ),
  );

it.effect(
  "retains cleanup of legacy operation intent while denying forward use and unanchored budgets",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const op = yield* f.prepare();
        yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_remove(intent_json,'$.rootBudget','$.operationLimits')`;
        yield* rejected(f.operations.authorize(op));
        expect(
          yield* f.operations.persistTerminal(op, {
            identity: { workerId: op.workerId, generation: 0 },
            operation: op.operation,
            outcome: "canceled",
            ownerCaptured: false,
            native: null,
            drain: null,
            accountingReceipts: [],
          }),
        ).toBe("drained");
        const restarted = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
        yield* rejected(
          restarted.prepare(f.identity, { threadId, kind: "initialize" }, "replacement", {
            allocation: f.allocation,
            workerId: "next-worker",
            operationId: "replacement",
          }),
        );
        expect(yield* f.sql`SELECT operation_id,status FROM project_team_pi_operation`).toEqual([
          { operation_id: op.operation.operationId, status: "settled" },
        ]);
        expect((yield* f.sql`SELECT * FROM project_team_model_budget`).length).toBe(1);
      }),
    ),
);

it.effect(
  "a narrower actual journal replacement consumes the original root remainder after unknown usage",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* journalFixture();
        yield* f.journal.claimEffect(f.admitted.fence);
        const op = yield* f.operations.prepare(
          f.identity,
          { threadId, kind: "initialize" },
          "root",
          {
            allocation: f.allocation,
            workerId: "root-worker",
            operationId: "journal-initialize",
          },
        );
        const owner = {
          type: "owner" as const,
          unit: f.allocation.unit,
          nonce: f.allocation.nonce,
          invocation: "a".repeat(32),
          cgroup: `/sys/fs/cgroup/${f.allocation.unit}`,
          pid: 123,
          memoryBytes: 33554432,
          swapBytes: 0 as const,
          oomGroup: 1 as const,
        };
        yield* f.operations.persistence(op).claimActivation(f.allocation);
        yield* f.operations.persistence(op).beforeStart(owner);
        yield* f.operations.persistNative(op, nativeReference);
        const accounting = yield* makeAccounting({
          environmentId: "environment",
          routeId: "command-code-ling-free",
          model,
          acceptedReportedModels: [model],
          resolveOperation: f.operations.resolveOperation,
        });
        const request = {
          workerId: op.workerId,
          operationId: op.operation.operationId,
          generation: 0,
          requestId: 1,
          routeId: "command-code-ling-free",
          provider: "command-code" as const,
          model,
          maxInputTokens: 19700,
          maxOutputTokens: 100,
          callCount: 1 as const,
          deadlineAtMs: time + 9000,
        };
        const first = yield* accounting.reserve(op.principal, request);
        yield* accounting.settle({
          ...request,
          reservationId: first.reservationId,
          outcome: "unknown",
          transportDrained: true,
          chargedInputTokens: request.maxInputTokens,
          chargedOutputTokens: request.maxOutputTokens,
        });
        // Synthetic owner/drain receipts isolate SQL budget semantics; no native worker is launched.
        yield* f.operations.persistTerminal(op, {
          identity: { workerId: op.workerId, generation: 0 },
          operation: op.operation,
          outcome: "failed",
          ownerCaptured: true,
          native: nativeReference,
          accountingReceipts: [],
          drain: {
            unit: owner.unit,
            invocation: owner.invocation,
            cgroup: owner.cgroup,
            ownerPid: owner.pid,
            memoryBytes: owner.memoryBytes,
            swapBytes: 0,
            oomGroup: 1,
            launcherPid: 124,
            childPid: 125,
            childExitCode: 0,
            kernel: "populated 0\nfrozen 0",
          },
        });
        const nextTime = time + 10001;
        yield* TestClock.setTime(nextTime);
        yield* f.repository.execute({
          type: "project-work.attempt.expire",
          projectId,
          taskId: f.binding.taskId,
          commandId: CommandId.make("expire-original"),
          attemptId: f.binding.attemptId,
          reason: "Fixture lease expired",
          expiredAt: isoTime(nextTime),
        });
        let state = yield* readCurrentState(f.sql, projectId);
        const previous = state.foundationRecords?.find(
          (r) => r.kind === "run-binding" && r.recordId === f.binding.recordId,
        );
        if (previous?.kind !== "run-binding") return yield* Effect.die("Missing previous binding");
        yield* restoreHistoricalBinding({
          ...previous,
          revision: previous.revision + 1,
          status: "settled",
        });
        state = yield* readCurrentState(f.sql, projectId);
        const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
        for (const action of ["resolve-failure", "resume"] as const) {
          state = yield* readCurrentState(f.sql, projectId);
          const commandId = `replacement-${action}`;
          yield* f.repository.execute(
            yield* decodeCommit({
              type: "project-work.foundation.commit",
              projectId,
              commandId,
              expectedRevision: state.revision,
              attribution: {
                actor: { kind: "human", id: "fixture-human" },
                source: { kind: "web", id: "fixture-browser" },
                recordedAt: isoTime(nextTime),
              },
              records: [],
              committedAt: isoTime(nextTime),
              guided: {
                intent: {
                  type: "project-team.task.control",
                  projectId,
                  taskId: f.binding.taskId,
                  commandId,
                  expectedRevision: state.revision,
                  expectedTaskRevision: state.tasks.find((t) => t.taskId === f.binding.taskId)!
                    .revision,
                  control: { action, reason: "Resume after synthetic SQL drain" },
                },
              },
            }),
          );
        }
        state = yield* readCurrentState(f.sql, projectId);
        const membership = state.foundationRecords?.find(
          (r) => r.kind === "task-membership" && r.taskId === f.binding.taskId,
        );
        const grant = state.foundationRecords?.find(
          (r) =>
            r.kind === "gate" &&
            r.recordId ===
              (membership?.kind === "task-membership"
                ? membership.assignment?.authorizationGateId
                : ""),
        );
        if (grant?.kind !== "gate") return yield* Effect.die("Missing resumed grant");
        const transition = f.request.claim.transition;
        if (transition?.kind !== "claim") return yield* Effect.die("Missing original transition");
        const newThread = ThreadId.make("replacement-thread");
        const fs = yield* FileSystem.FileSystem;
        const worktree = yield* fs.makeTempDirectoryScoped();
        const replacement = {
          ...transition.binding,
          recordId: "replacement-binding",
          attemptId: ProjectWorkAttemptId.make("replacement-attempt"),
          threadId: newThread,
          generation: 1,
          leaseGeneration: 1,
          authorizationGateId: grant.recordId,
          updatedAt: isoTime(nextTime),
          worktree,
          branch: "refs/heads/replacement",
          configuration: {
            ...transition.binding.configuration,
            maxTokens: 1000,
            maxDurationMs: 1000,
          },
        };
        const dispatch = {
          ...f.request,
          dispatchId: "replacement-dispatch",
          setupId: "replacement-setup",
          initializeOperationId: "replacement-initialize",
          assignmentOperationId: "replacement-assignment",
          claim: {
            ...f.request.claim,
            commandId: CommandId.make("replacement-dispatch"),
            committedAt: isoTime(nextTime),
            expectedRevision: state.revision,
            transition: {
              ...transition,
              binding: replacement,
              expectedTaskRevision: state.tasks.find((t) => t.taskId === replacement.taskId)!
                .revision,
              authorizationGateId: grant.recordId,
              expectedGateRevision: grant.revision,
              claim: {
                ...transition.claim,
                commandId: CommandId.make("replacement-dispatch"),
                attemptId: replacement.attemptId,
                leaseToken: "replacement-lease",
                leasedUntil: isoTime(nextTime + 1000),
                claimedAt: isoTime(nextTime),
              },
            },
          },
          git: {
            ...f.request.git,
            effectId: "replacement-dispatch",
            runId: replacement.recordId,
            generation: 1,
            worktreePath: worktree,
            branchRef: replacement.branch,
          },
        };
        const admitted = yield* f.journal.reserve(dispatch);
        expect(admitted.intent.limits.maximumTokens).toBe(20000);
        expect(admitted.intent.limits.attemptMaximumTokens).toBe(1000);
        const launch = f.allocation.launch;
        const allocation = yield* preallocatePiManagedProcess({
          workspaceRoot: worktree,
          workspaceAccess: "readonly",
          nativeStateRoot: yield* fs.makeTempDirectoryScoped(),
          protectedRoots: launch.protectedRoots,
          runtimeFiles: launch.runtimeFiles.map((file) => ({
            source: file.source,
            target: file.target,
          })),
          argv: launch.argv,
          memoryBytes: launch.memoryBytes,
          runtimeSeconds: launch.runtimeSeconds,
        });
        const next = yield* f.operations.prepare(
          { providerInstanceId, threadId: newThread },
          { threadId: newThread, kind: "initialize" },
          "replacement",
          {
            allocation,
            workerId: "replacement-worker",
            operationId: "replacement-initialize",
          },
        );
        yield* f.operations.persistence(next).claimActivation(allocation);
        yield* f.operations.persistence(next).beforeStart({
          ...owner,
          unit: allocation.unit,
          nonce: allocation.nonce,
          cgroup: `/sys/fs/cgroup/${allocation.unit}`,
        });
        yield* f.operations.persistNative(next, {
          ...nativeReference,
          sessionId: "replacement-native",
        });
        const bounded = {
          ...request,
          workerId: next.workerId,
          operationId: next.operation.operationId,
          generation: 1,
          maxInputTokens: 100,
          deadlineAtMs: nextTime + 900,
        };
        const last = yield* accounting.reserve(next.principal, bounded);
        yield* accounting.settle({
          ...bounded,
          reservationId: last.reservationId,
          outcome: "unknown",
          transportDrained: true,
          chargedInputTokens: 100,
          chargedOutputTokens: 100,
        });
        yield* rejected(accounting.reserve(next.principal, { ...bounded, requestId: 2 }));
        expect(
          yield* f.sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget`,
        ).toEqual([
          { maximum_tokens: 20000, deadline_at_ms: f.admitted.intent.limits.rootDeadlineAtMs },
        ]);
        expect(
          yield* f.sql`SELECT SUM(charged_input_tokens+charged_output_tokens) AS charged,COUNT(*) AS requests FROM project_team_model_request`,
        ).toEqual([{ charged: 20000, requests: 2 }]);
      }),
    ),
);

const nativeReference = {
  sessionId: "native",
  sessionReference: "sessions/native.jsonl",
  leafId: "leaf",
  persisted: true,
};
const settledRead = Effect.gen(function* () {
  const f = yield* fixture;
  const op = yield* f.operations.prepare(f.identity, { threadId, kind: "initialize" }, "read", {
    allocation: f.allocation,
    workerId: "worker",
    operationId: "read",
    resourceHash: "a".repeat(64),
  });
  yield* f.operations.persistNative(op, nativeReference);
  // This settled SQL fixture exercises read identity, not operating-system drain.
  yield* f.sql`UPDATE project_team_pi_operation SET status='settled'`;
  const expected = yield* f.operations.nativeFor(f.identity);
  return { ...f, op, expected };
});
const typedDenial = <A, R>(effect: Effect.Effect<A, PiManagedRuntimeError, R>, code?: string) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(PiManagedRuntimeError);
        if (code) expect(result.failure.code).toBe(code);
      }
    }),
  );

for (const mode of [
  "unchanged",
  "legacy-unchanged",
  "operation-id",
  "leaf",
  "path",
  "persisted",
  "resource-hash",
  "new-head",
  "binding-session",
  "generation",
  "malformed-native",
  "excess-native",
  "malformed-intent",
  "malformed-expected",
  "excess-expected",
  "malformed-expected-hash",
  "prepared",
  "starting",
  "running",
  "quarantine",
] as const) {
  it.effect(`admits only the exact durable native read: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* settledRead;
        let expected = f.expected;
        switch (mode) {
          case "legacy-unchanged":
            yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_remove(intent_json, '$.resourceHash')`;
            expected = { ...expected, resourceHash: null };
            break;
          case "operation-id":
            expected = { ...expected, operationId: "different" };
            break;
          case "leaf":
          case "path":
          case "persisted": {
            const native = {
              ...nativeReference,
              ...(mode === "leaf"
                ? { leafId: "new-leaf" }
                : mode === "path"
                  ? { sessionReference: "sessions/new.jsonl" }
                  : { persisted: false }),
            };
            yield* f.sql`UPDATE project_team_pi_operation SET native_json=${encodeJson(native)}`;
            break;
          }
          case "resource-hash":
            yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json, '$.resourceHash', ${"b".repeat(64)})`;
            break;
          case "new-head":
            yield* f.sql`INSERT INTO project_team_pi_operation SELECT 'new-head',environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,1,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json,native_json,terminal_json FROM project_team_pi_operation`;
            break;
          case "binding-session":
          case "generation": {
            const binding = (yield* f.operations.current(f.identity)).binding;
            yield* restoreHistoricalBinding({
              ...binding,
              revision: binding.revision + 1,
              ...(mode === "binding-session"
                ? { sessionId: "replacement" }
                : { generation: binding.generation + 1 }),
            });
            break;
          }
          case "malformed-native":
            yield* f.sql`UPDATE project_team_pi_operation SET native_json='{'`;
            break;
          case "excess-native":
            yield* f.sql`UPDATE project_team_pi_operation SET native_json=${encodeJson({ ...nativeReference, extra: true })}`;
            break;
          case "malformed-intent":
            yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json, '$.resourceHash', 'malformed')`;
            break;
          case "malformed-expected":
            expected = {
              ...expected,
              native: { ...expected.native, sessionReference: "../outside.jsonl" },
            };
            break;
          case "malformed-expected-hash":
            expected = { ...expected, resourceHash: "invalid" };
            break;
          case "excess-expected": {
            const native = { ...expected.native, extra: true };
            expected = { ...expected, native };
            break;
          }
          case "prepared":
          case "starting":
          case "running":
          case "quarantine":
            yield* f.sql`UPDATE project_team_pi_operation SET status=${mode}`;
            break;
        }
        let calls = 0;
        const admission = f.operations.admitCurrent(
          f.identity,
          (authority) => {
            calls++;
            return authority.binding.sessionId;
          },
          expected,
        );
        if (mode === "unchanged" || mode === "legacy-unchanged") {
          expect(yield* admission).toBe(nativeReference.sessionId);
          expect(calls).toBe(1);
        } else {
          yield* typedDenial(admission);
          expect(calls).toBe(0);
          if (
            mode === "malformed-native" ||
            mode === "excess-native" ||
            mode === "malformed-intent"
          )
            yield* typedDenial(f.operations.nativeFor(f.identity), "uncertain");
        }
      }),
    ),
  );
}

it.effect("admits a native read before a queued durable stop and denies its successor", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* settledRead;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const stopStarted = yield* Deferred.make<void>();
      let holdRead = true;
      const observedSql = new Proxy(f.sql, {
        apply(target, _receiver, args) {
          const statement = target(args[0], ...args.slice(1));
          if (
            !holdRead ||
            !statement.compile()[0].includes("ORDER BY operation_ordinal DESC LIMIT 1")
          )
            return statement;
          return statement.pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                holdRead = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }),
            ),
          );
        },
      });
      const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" }).pipe(
        Effect.provideService(SqlClient.SqlClient, observedSql),
      );
      let calls = 0;
      const admission = () =>
        operations
          .admitCurrent(
            f.identity,
            () => {
              calls++;
              return "read";
            },
            f.expected,
          )
          .pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
      const pending = yield* admission().pipe(Effect.forkChild);
      yield* Effect.raceFirst(
        Deferred.await(entered),
        Fiber.join(pending).pipe(
          Effect.flatMap(() => Effect.die("Native read did not reach its final SQL receipt")),
        ),
      );
      let committed = false;
      const stop = yield* Deferred.succeed(stopStarted, undefined).pipe(
        Effect.andThen(
          restoreHistoricalBinding({
            ...f.expected.authority.binding,
            revision: f.expected.authority.binding.revision + 1,
            status: "stopping",
          }),
        ),
        Effect.tap(
          Effect.sync(() => {
            committed = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(stopStarted);
      expect(committed).toBe(false);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toBe("read");
      yield* Fiber.join(stop);
      expect(committed).toBe(true);
      expect(calls).toBe(1);
      yield* typedDenial(admission());
      expect(calls).toBe(1);
    }),
  ),
);

for (const mode of ["unchanged", "stop-first", "expired", "expires-in-callback"] as const) {
  it.effect(`orders durable native read against the captured transaction and clock: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* settledRead;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const queued = yield* Deferred.make<void>();
        const clock = yield* Clock.Clock;
        let clockOffset: number | undefined;
        const operations = yield* makeProjectTeamPiOperations({
          environmentId: "environment",
        }).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillisUnsafe: () => clockOffset ?? clock.currentTimeMillisUnsafe(),
          }),
        );
        let calls = 0;
        const hold = yield* f.sql
          .withTransaction(
            Effect.gen(function* () {
              if (mode === "stop-first") {
                yield* restoreHistoricalBinding({
                  ...f.expected.authority.binding,
                  revision: f.expected.authority.binding.revision + 1,
                  status: "stopping",
                });
              }
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const pending = yield* Deferred.succeed(queued, undefined).pipe(
          Effect.andThen(
            operations.admitCurrent(
              f.identity,
              () => {
                calls++;
                if (mode === "expires-in-callback") {
                  // Clock services expose the same unsafe clock used by the synchronous admission fence.
                  clockOffset = f.op.deadlineAtMs + 1000;
                }
                return "read";
              },
              f.expected,
            ),
          ),
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(queued);
        if (mode === "expired") yield* TestClock.setTime(f.op.deadlineAtMs + 1000);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(hold);
        const result = yield* Fiber.join(pending);
        expect(result._tag).toBe(mode === "unchanged" ? "Success" : "Failure");
        expect(calls).toBe(mode === "unchanged" || mode === "expires-in-callback" ? 1 : 0);
      }),
    ),
  );
}

const terminalFixtureFor = (stable = false, removedStage = false) =>
  Effect.gen(function* () {
    let f = yield* fixture;
    if (removedStage) {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const source = directory + "/historical-stage.txt";
      yield* fs.writeFileString(source, "historical descriptor asset");
      const original = f.allocation.launch;
      const allocation = yield* preallocatePiManagedProcess({
        workspaceRoot: original.workspaceRoot,
        workspaceAccess: original.workspaceAccess,
        nativeStateRoot: original.nativeStateRoot,
        protectedRoots: original.protectedRoots,
        runtimeFiles: [
          ...original.runtimeFiles.map((file) => ({ source: file.source, target: file.target })),
          { source, target: "/runtime/historical-stage.txt" },
        ],
        argv: original.argv,
        memoryBytes: original.memoryBytes,
        runtimeSeconds: original.runtimeSeconds,
      });
      f = { ...f, allocation };
      yield* fs.remove(source);
    }
    const request = {
      threadId,
      kind: "initialize" as const,
      ...(stable ? { operationId: "stable-initialize" } : {}),
    };
    const requestHash = stable
      ? NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(request)).digest("hex")
      : "request";
    const resourceHash = "a".repeat(64);
    const op = stable
      ? yield* f.operations.prepare(f.identity, request, requestHash, {
          allocation: f.allocation,
          workerId: "worker",
          operationId: request.operationId!,
          resourceHash,
        })
      : yield* f.prepare();
    // Captured owner and drain metadata are synthetic SQL fixtures, not native process proof.
    const owner = {
      type: "owner" as const,
      unit: f.allocation.unit,
      nonce: f.allocation.nonce,
      invocation: "a".repeat(32),
      cgroup: `/sys/fs/cgroup/${f.allocation.unit}`,
      pid: 123,
      memoryBytes: f.allocation.policy.memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
    };
    const drain = {
      unit: owner.unit,
      invocation: owner.invocation,
      cgroup: owner.cgroup,
      ownerPid: owner.pid,
      memoryBytes: owner.memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
      launcherPid: 124,
      childPid: 125,
      childExitCode: 0,
      kernel: "populated 0\nfrozen 0",
    };
    const activate = Effect.gen(function* () {
      yield* f.operations.persistence(op).claimActivation(f.allocation);
      yield* f.operations.persistence(op).beforeStart(owner);
      yield* f.operations.persistNative(op, nativeReference);
    });
    const terminal = (
      outcome: PiSessionTerminal["outcome"],
      drained = false,
    ): PiSessionTerminal => ({
      identity: { workerId: op.workerId, generation: 0 },
      operation: op.operation,
      outcome,
      ownerCaptured: drained,
      native: drained ? nativeReference : null,
      drain: drained ? drain : null,
      accountingReceipts: [],
    });
    return { ...f, op, owner, drain, activate, terminal, request, requestHash, resourceHash };
  });

it.effect(
  "transaction-affine lookup validates the original receipt without opening another transaction",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* terminalFixtureFor(true);
        yield* f.activate;
        const terminal = f.terminal("success", true);
        yield* f.operations.persistTerminal(f.op, terminal);
        const read = () =>
          f.operations.lookupInTransaction(f.identity, f.request, f.requestHash, f.resourceHash);
        yield* typedDenial(read());
        const receipt = yield* f.sql.withTransaction(read());
        expect(receipt?.terminal).toEqual(terminal);
        yield* f.sql.withTransaction(
          typedDenial(f.operations.lookup(f.identity, f.request, f.requestHash, f.resourceHash)),
        );
        yield* f.sql`UPDATE project_team_pi_process SET drain_json=json_set(drain_json,'$.childExitCode',1)`;
        yield* f.sql.withTransaction(typedDenial(read()));
      }),
    ),
);

it.effect(
  "latest-only stable lookup denies a predecessor after successor allocation and honest cancellation",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* terminalFixtureFor(true);
        yield* f.activate;
        const terminal = f.terminal("success", true);
        yield* f.operations.persistTerminal(f.op, terminal);
        const read = () =>
          f.operations.lookup(f.identity, f.request, f.requestHash, f.resourceHash);
        expect((yield* read())?.terminal).toEqual(terminal);
        const original = f.allocation.launch;
        const allocation = yield* preallocatePiManagedProcess({
          workspaceRoot: original.workspaceRoot,
          workspaceAccess: original.workspaceAccess,
          nativeStateRoot: original.nativeStateRoot,
          protectedRoots: original.protectedRoots,
          runtimeFiles: original.runtimeFiles.map((file) => ({
            source: file.source,
            target: file.target,
          })),
          argv: original.argv,
          memoryBytes: original.memoryBytes,
          runtimeSeconds: original.runtimeSeconds,
        });
        const request = {
          threadId,
          kind: "prompt" as const,
          operationId: "stable-successor",
          prompt: "Same assignment",
          resumeCursor: nativeReference,
        };
        const requestHash = NodeCrypto.createHash("sha256")
          .update(canonicalProjectWorkPayload(request))
          .digest("hex");
        const successor = yield* f.operations.prepare(f.identity, request, requestHash, {
          allocation,
          workerId: "successor-worker",
          operationId: request.operationId,
          resourceHash: f.resourceHash,
        });
        expect(successor.ordinal).toBe(f.op.ordinal + 1);
        expect(successor.deadlineAtMs).toBe(f.op.deadlineAtMs);
        expect(successor.maximumTokens).toBe(f.op.maximumTokens);
        yield* typedDenial(read(), "conflict");
        yield* f.sql.withTransaction(
          typedDenial(
            f.operations.lookupInTransaction(f.identity, f.request, f.requestHash, f.resourceHash),
            "conflict",
          ),
        );
        const canceled: PiSessionTerminal = {
          identity: {
            workerId: successor.workerId,
            generation: successor.authority.binding.generation,
          },
          operation: successor.operation,
          outcome: "canceled",
          ownerCaptured: false,
          native: null,
          drain: null,
          accountingReceipts: [],
        };
        yield* f.operations.persistTerminal(successor, canceled);
        yield* typedDenial(read(), "conflict");
        expect(
          yield* f.sql`SELECT status FROM project_team_pi_operation WHERE operation_id=${f.op.operation.operationId}`,
        ).toEqual([{ status: "settled" }]);
        expect(
          yield* f.sql`SELECT status FROM project_team_pi_operation WHERE operation_id=${request.operationId}`,
        ).toEqual([{ status: "settled" }]);
      }),
    ),
);

const terminalFixture = terminalFixtureFor();

for (const mode of [
  "allocated-canceled",
  "allocated-failed",
  "allocated-quarantine",
  "allocated-success",
  "claimed-canceled",
  "captured-failed",
  "captured-canceled",
  "drained-failed",
  "drained-canceled",
  "drained-success",
  "drained-quarantine",
  "wrong-drain",
] as const) {
  it.effect(`returns the committed SQL drain disposition: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* terminalFixture;
        const allocated = mode.startsWith("allocated");
        if (mode === "claimed-canceled")
          yield* f.operations.persistence(f.op).claimActivation(f.allocation);
        else if (!allocated) yield* f.activate;
        const outcome = mode.endsWith("success")
          ? "success"
          : mode.endsWith("quarantine")
            ? "quarantine"
            : mode.endsWith("canceled")
              ? "canceled"
              : "failed";
        const terminal = f.terminal(outcome, mode.startsWith("drained") || mode === "wrong-drain");
        const effect = f.operations.persistTerminal(
          f.op,
          mode === "wrong-drain"
            ? { ...terminal, drain: { ...f.drain, invocation: "b".repeat(32) } }
            : terminal,
        );
        if (mode === "allocated-success" || mode === "wrong-drain") {
          yield* typedDenial(effect, "uncertain");
          expect(
            (yield* f.sql<{
              status: string;
              terminal_json: string | null;
            }>`SELECT status,terminal_json FROM project_team_pi_operation`)[0],
          ).toEqual({ status: allocated ? "prepared" : "running", terminal_json: null });
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_process`)[0]
              ?.status,
          ).toBe(allocated ? "allocated" : "captured");
        } else {
          const expected =
            mode.endsWith("quarantine") || mode.startsWith("claimed") || mode.startsWith("captured")
              ? "uncertain"
              : "drained";
          expect(yield* effect).toBe(expected);
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]
              ?.status,
          ).toBe(expected === "uncertain" ? "quarantine" : "settled");
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_process`)[0]
              ?.status,
          ).toBe(expected === "uncertain" ? "quarantine" : "drained");
          yield* typedDenial(f.operations.persistTerminal(f.op, terminal), "conflict");
        }
      }),
    ),
  );
}

for (const mode of [
  "pending",
  "reported",
  "failed",
  "unknown",
  "success-missing",
  "success-reported",
  "success-pending",
  "wrong-receipt",
] as const) {
  it.effect(`retains or drains native state after durable model accounting: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* terminalFixture;
        yield* f.activate;
        const accounting = yield* makeAccounting({
          environmentId: "environment",
          routeId: "command-code-ling-free",
          model,
          acceptedReportedModels: [model],
          resolveOperation: f.operations.resolveOperation,
        });
        const request = {
          workerId: f.op.workerId,
          operationId: f.op.operation.operationId,
          generation: 0,
          requestId: 1,
          routeId: "command-code-ling-free",
          provider: "command-code" as const,
          model,
          maxInputTokens: 100,
          maxOutputTokens: 100,
          callCount: 1 as const,
          deadlineAtMs: time + 10000,
        };
        const reservation = yield* accounting.reserve(f.op.principal, request);
        const receipts: PiSessionTerminal["accountingReceipts"][number][] = [];
        if (mode !== "pending" && mode !== "success-pending") {
          const reported = mode !== "failed" && mode !== "unknown";
          const receipt = yield* accounting.settle({
            ...request,
            reservationId: reservation.reservationId,
            outcome: reported ? "reported" : mode,
            ...(reported ? { transportDrained: true } : {}),
            chargedInputTokens: reported ? 10 : 100,
            chargedOutputTokens: reported ? 20 : 100,
            ...(reported
              ? {
                  reportedModel: model,
                  reportedUsage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
                }
              : {}),
          });
          if (reported && mode !== "success-missing")
            receipts.push({
              requestId: request.requestId,
              routeId: request.routeId,
              provider: request.provider,
              model: request.model,
              reportedModel: model,
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
              reservationId: reservation.reservationId,
              accountingReceiptId:
                mode === "wrong-receipt" ? "different" : receipt.accountingReceiptId,
            });
        }
        const terminal = {
          ...f.terminal(mode.startsWith("success") ? "success" : "failed", true),
          accountingReceipts: receipts,
        };
        const effect = f.operations.persistTerminal(f.op, terminal);
        if (mode === "success-missing" || mode === "success-pending" || mode === "wrong-receipt") {
          yield* typedDenial(effect, "uncertain");
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]
              ?.status,
          ).toBe("running");
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_process`)[0]
              ?.status,
          ).toBe("captured");
        } else {
          const disposition = mode === "pending" ? "uncertain" : "drained";
          expect(yield* effect).toBe(disposition);
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]
              ?.status,
          ).toBe(disposition === "uncertain" ? "quarantine" : "settled");
          expect(
            (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_process`)[0]
              ?.status,
          ).toBe(disposition === "uncertain" ? "quarantine" : "drained");
        }
      }),
    ),
  );
}

it.effect(
  "retains selected resource identity in durable intent and reconstructs it after restart",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const resourceHash = "a".repeat(64);
        const op = yield* f.operations.prepare(
          f.identity,
          { threadId, kind: "initialize" },
          "skills",
          {
            allocation: f.allocation,
            workerId: "worker",
            operationId: "skills",
            resourceHash,
          },
        );
        const rows = yield* f.sql<{
          intent_json: string;
        }>`SELECT intent_json FROM project_team_pi_operation`;
        expect(parseJson(rows[0]!.intent_json)).toHaveProperty("resourceHash", resourceHash);
        const native = {
          sessionId: "native",
          sessionReference: "sessions/native.jsonl",
          leafId: null,
          persisted: false,
        };
        yield* f.operations.persistNative(op, native);
        // Synthetic settled SQL fixture proves reconstruction only, not operating-system drain.
        yield* f.sql`UPDATE project_team_pi_operation SET status='settled'`;
        const restarted = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
        expect((yield* restarted.nativeFor(f.identity)).resourceHash).toBe(resourceHash);
        yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json, '$.resourceHash', 'malformed')`;
        yield* rejected(restarted.nativeFor(f.identity));
      }),
    ),
);

it.effect(
  "rejects malformed resource identities before committing operation or process ownership",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const resourceHash of ["", "a".repeat(63), "z".repeat(64)]) {
          yield* rejected(
            f.operations.prepare(f.identity, { threadId, kind: "initialize" }, "skills", {
              allocation: f.allocation,
              workerId: "worker",
              operationId: "skills",
              resourceHash,
            }),
          );
        }
        expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
        expect((yield* f.sql`SELECT * FROM project_team_pi_process`).length).toBe(0);
      }),
    ),
);

it.effect(
  "commits exact launch intent and unique ordinal before activation and denies replay",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const op = yield* f.prepare();
        expect(op.ordinal).toBe(0);
        const process = yield* f.sql<{
          status: string;
          allocation_json: string;
        }>`SELECT * FROM project_team_pi_process`;
        expect(process[0]?.status).toBe("allocated");
        expect(parseJson(process[0]!.allocation_json)).toEqual(f.allocation);
        yield* rejected(f.prepare("duplicate"));
        const persistence = f.operations.persistence(op);
        yield* persistence.claimActivation(f.allocation);
        yield* rejected(persistence.claimActivation(f.allocation));
        expect(
          (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]
            ?.status,
        ).toBe("starting");
      }),
    ),
);
it.effect(
  "binds actual native identity through event repository and retains uncertain worker fence",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const op = yield* f.prepare();
        yield* f.operations.persistence(op).claimActivation(f.allocation);
        const native = {
          sessionId: "native",
          sessionReference: "sessions/native.jsonl",
          leafId: null,
          persisted: false,
        };
        const committed = yield* f.operations.persistNative(op, native);
        const authority = yield* f.operations.current(f.identity);
        expect(committed).toEqual(authority);
        expect(authority.binding.revision).toBe(op.authority.binding.revision + 1);
        expect(authority.binding.status).toBe("running");
        expect(authority.binding.sessionId).toBe("native");
        expect(
          (yield* f.repo.replay(f.binding.projectId)).some(
            (entry) =>
              entry.type === "project-work.foundation.recorded" &&
              entry.record.kind === "run-binding" &&
              entry.record.sessionId === "native",
          ),
        ).toBe(true);
        yield* rejected(f.operations.persistNative(op, { ...native, sessionId: "different" }));
        yield* f.operations.persistTerminal(op, {
          identity: { workerId: op.workerId, generation: 0 },
          operation: op.operation,
          outcome: "quarantine",
          ownerCaptured: false,
          native,
          drain: null,
          accountingReceipts: [],
        });
        yield* rejected(f.prepare("replacement"));
        yield* rejected(f.operations.nativeFor(f.identity));
        const fresh = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
        yield* rejected(
          fresh.prepare(f.identity, { threadId, kind: "initialize" }, "request", {
            allocation: f.allocation,
            workerId: "replacement",
            operationId: "restart",
          }),
        );
      }),
    ),
);
it.effect(
  "canceled unactivated intent releases ownership but preserves increasing chronology",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const op = yield* f.prepare();
        yield* f.operations.persistTerminal(op, {
          identity: { workerId: op.workerId, generation: 0 },
          operation: op.operation,
          outcome: "canceled",
          ownerCaptured: false,
          native: null,
          drain: null,
          accountingReceipts: [],
        });
        const nextAllocation = {
          ...f.allocation,
          unit: "t3-pi-managed-next.service",
          nonce: "next",
        };
        const replacement = yield* f.operations.prepare(
          f.identity,
          { threadId, kind: "initialize" },
          "new-request",
          { allocation: nextAllocation, operationId: "next", workerId: "next" },
        );
        expect(replacement.ordinal).toBe(1);
      }),
    ),
);
it.effect("rejects stale approval before ownership allocation", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const gate = (yield* f.operations.current(f.identity, true)).state.foundationRecords!.find(
        (entry) => entry.kind === "gate" && entry.recordId === f.binding.specificationGateId,
      )!;
      if (gate.kind !== "gate") return yield* Effect.die("Fixture gate unavailable");
      yield* restoreHistoricalBinding({
        ...gate,
        status: "invalidated",
        revision: gate.revision + 1,
      });
      yield* rejected(f.prepare());
      expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
    }),
  ),
);
it.effect("rejects nested transactions and foreign SQL clients before success", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* rejected(f.sql.withTransaction(f.prepare()));
      const foreign = makeSqlitePersistenceLive(":memory:");
      yield* rejected(f.prepare().pipe(Effect.provide(foreign)));
      expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
    }),
  ),
);
it.effect(
  "durable accounting reads operation/root budget transactionally and settles after revocation",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const op = yield* f.prepare();
        const persistence = f.operations.persistence(op);
        yield* persistence.claimActivation(f.allocation);
        yield* persistence.beforeStart({
          type: "owner",
          unit: f.allocation.unit,
          nonce: f.allocation.nonce,
          invocation: "a".repeat(32),
          cgroup: `/sys/fs/cgroup/${f.allocation.unit}`,
          pid: 123,
          memoryBytes: 33554432,
          swapBytes: 0,
          oomGroup: 1,
        });
        yield* f.operations.persistNative(op, {
          sessionId: "native",
          sessionReference: "sessions/native.jsonl",
          leafId: null,
          persisted: false,
        });
        const accounting = yield* makeAccounting({
          environmentId: "environment",
          routeId: "command-code-ling-free",
          model,
          acceptedReportedModels: [model],
          resolveOperation: f.operations.resolveOperation,
        });
        const request = {
          workerId: op.workerId,
          operationId: op.operation.operationId,
          generation: 0,
          requestId: 1,
          routeId: "command-code-ling-free",
          provider: "command-code" as const,
          model,
          maxInputTokens: 100,
          maxOutputTokens: 100,
          callCount: 1 as const,
          deadlineAtMs: time + 10000,
        };
        const receipt = yield* accounting.reserve(op.principal, request);
        expect(receipt.status).toBe("reserved");
        expect((yield* accounting.reserve(op.principal, request)).status).toBe("existing");
        const running = (yield* f.operations.current(f.identity)).binding;
        yield* restoreHistoricalBinding({
          ...running,
          revision: running.revision + 1,
          configuration: { ...running.configuration, runtimeVersion: "changed-after-intent" },
        });
        yield* rejected(accounting.reserve(op.principal, { ...request, requestId: 2 }));
        expect((yield* f.sql`SELECT * FROM project_team_model_request`).length).toBe(1);
        yield* restoreHistoricalBinding({
          ...running,
          status: "revoked",
          revision: running.revision + 2,
        });
        yield* rejected(accounting.reserve(op.principal, { ...request, requestId: 2 }));
        const settlement = yield* accounting.settle({
          ...request,
          reservationId: receipt.reservationId,
          outcome: "unknown",
          chargedInputTokens: 100,
          chargedOutputTokens: 100,
        });
        expect(settlement.accountingReceiptId.length).toBeGreaterThan(0);
        expect(
          (yield* f.sql<{ status: string }>`SELECT status FROM project_team_model_request`)[0]
            ?.status,
        ).toBe("unknown");
      }),
    ),
);

it.effect("rejects an expired frozen run budget before intent", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* TestClock.setTime(Date.parse(at) + 300001);
      yield* rejected(f.prepare());
      expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
    }),
  ),
);
it.effect("keeps unfinished setup uncertain before allocation", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const setup = yield* decodeSetup({
        recordId: "setup-effect",
        projectId: f.binding.projectId,
        revision: 0,
        generation: 0,
        updatedAt: at,
        kind: "effect",
        status: "uncertain",
        effectId: "setup-effect",
        effectKind: "setup",
        runId: f.binding.recordId,
        targetId: f.binding.recordId,
        payload: { recordIds: [f.binding.recordId], expectedRevision: 0 },
        claimGeneration: 0,
        availableAt: at,
      });
      yield* restoreHistoricalBinding(setup);
      yield* rejected(f.prepare());
      expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(0);
    }),
  ),
);

for (const mode of ["control", "before-prepare", "before-final-commit", "after-commit"] as const) {
  it.effect(`native binding commit fence ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const real = yield* Authorization.ProjectTeamAuthorization;
        const projection = yield* ProjectWorkProjection;
        const restore = (record: Parameters<typeof restoreHistoricalBinding>[0]) =>
          restoreHistoricalBinding(record).pipe(
            Effect.provideService(ProjectWorkProjection, projection),
            Effect.provideService(SqlClient.SqlClient, f.sql),
            Effect.orDie,
          );
        let armed = false,
          reads = 0,
          changed = false,
          inTransaction = false;
        const wrapped = Authorization.ProjectTeamAuthorization.of({
          ...real,
          issueCredential: (...args) =>
            Effect.gen(function* () {
              const authority = yield* real.issueCredential(...args);
              if (armed) {
                reads++;
                const inside = Option.isSome(yield* Effect.serviceOption(f.sql.transactionService));
                if (
                  !changed &&
                  authority &&
                  ((mode === "before-prepare" && reads === 1 && inside) ||
                    (mode === "before-final-commit" && reads === 2 && inside) ||
                    (mode === "after-commit" && reads === 3 && !inside))
                ) {
                  inTransaction = inside;
                  yield* restore({
                    ...authority.binding,
                    revision: authority.binding.revision + 1,
                    sessionId: "foreign-native-replacement",
                  });
                  changed = true;
                  return yield* real.issueCredential(...args);
                }
              }
              return authority;
            }),
        });
        const ops = yield* makeProjectTeamPiOperations({ environmentId: "environment" }).pipe(
          Effect.provideService(Authorization.ProjectTeamAuthorization, wrapped),
        );
        const op = yield* ops.prepare(
          f.identity,
          { threadId: f.identity.threadId, kind: "initialize" },
          "request",
          { allocation: f.allocation, workerId: "worker", operationId: "native-fence" },
        );
        const native = {
          sessionId: "original-native",
          sessionReference: "sessions/original-native.jsonl",
          leafId: null,
          persisted: false,
        };
        armed = true;
        const outcome = yield* ops.persistNative(op, native).pipe(Effect.result);
        armed = false;
        const current = yield* real.issueCredential(f.identity);
        const rows = yield* f.sql<{
          native_json: string | null;
          status: string;
        }>`SELECT native_json,status FROM project_team_pi_operation WHERE operation_id='native-fence'`;
        const journal = yield* f.repo.replay(f.binding.projectId);
        const fs = yield* FileSystem.FileSystem;
        if (process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE)
          yield* fs.writeFileString(
            process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE + "/native-commit-" + mode + ".json",
            encodeJson({
              mode,
              outcome,
              reads,
              changed,
              inTransaction,
              binding: current?.binding,
              rows,
              events: journal.filter(
                (e) =>
                  e.type === "project-work.foundation.recorded" && e.record.kind === "run-binding",
              ),
            }),
          );
        expect(changed).toBe(mode !== "control");
        expect(inTransaction).toBe(mode === "before-prepare" || mode === "before-final-commit");
        if (mode === "before-prepare" || mode === "before-final-commit") {
          expect(rows[0]?.native_json).toBeNull();
          expect(current?.binding.status).toBe("reserved");
          expect(current?.binding.sessionId).toBeUndefined();
        } else {
          expect(parseJson(rows[0]!.native_json!)).toEqual(native);
          expect(current?.binding.sessionId).toBe(
            mode === "control" ? native.sessionId : "foreign-native-replacement",
          );
        }
        expect(outcome._tag).toBe(mode === "control" ? "Success" : "Failure");
      }),
    ),
  );
}

for (const mode of [
  "completed",
  "prepared",
  "starting",
  "running",
  "quarantine",
  "failed",
  "request",
  "hash",
  "kind",
  "resource",
  "binding",
  "generation",
  "scalar",
  "allocation",
  "owner",
  "drain",
  "native",
  "terminal",
  "deadline",
  "retired",
] as const) {
  it.effect(`stable Pi identity never repeats external work: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* terminalFixtureFor(true);
        if (mode !== "prepared") yield* f.activate;
        if (!["prepared", "starting", "running", "quarantine"].includes(mode))
          yield* f.operations.persistTerminal(
            f.op,
            f.terminal(mode === "failed" ? "failed" : "success", true),
          );
        if (["starting", "quarantine"].includes(mode))
          yield* f.sql`UPDATE project_team_pi_operation SET status=${mode}`;
        let request: typeof f.request & { readonly cwd?: string } = f.request;
        let hash = f.requestHash;
        let resource = f.resourceHash;
        if (mode === "request") request = { ...request, cwd: "changed" };
        if (mode === "hash") hash = "b".repeat(64);
        if (mode === "kind")
          yield* f.sql`UPDATE project_team_pi_operation SET operation_kind='compact'`;
        if (mode === "resource") resource = "b".repeat(64);
        if (mode === "scalar")
          yield* f.sql`UPDATE project_team_pi_operation SET project_id='other'`;
        if (mode === "allocation")
          yield* f.sql`UPDATE project_team_pi_process SET allocation_json=json_set(allocation_json,'$.nonce','other')`;
        if (mode === "owner")
          yield* f.sql`UPDATE project_team_pi_process SET owner_json=json_set(owner_json,'$.nonce','other')`;
        if (mode === "drain")
          yield* f.sql`UPDATE project_team_pi_process SET drain_json=json_set(drain_json,'$.childExitCode',1)`;
        if (mode === "native")
          yield* f.sql`UPDATE project_team_pi_operation SET native_json=json_set(native_json,'$.leafId','other')`;
        if (mode === "terminal")
          yield* f.sql`UPDATE project_team_pi_operation SET terminal_json='{'`;
        if (["binding", "generation", "retired"].includes(mode)) {
          const binding = (yield* f.operations.current(f.identity)).binding;
          yield* restoreHistoricalBinding({
            ...binding,
            revision: binding.revision + 1,
            ...(mode === "binding"
              ? { branch: "other" }
              : mode === "generation"
                ? { generation: 1 }
                : { status: "settled" as const }),
          });
        }
        if (mode === "deadline") yield* TestClock.setTime(f.op.deadlineAtMs);
        const effect = f.operations.lookup(f.identity, request, hash, resource);
        if (mode === "completed") {
          const receipt = yield* effect;
          expect(receipt?.terminal).toEqual(f.terminal("success", true));
          expect(receipt?.operation).toEqual(f.op.operation);
          // Reconstructing the private service models response loss and a server restart.
          const restarted = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
          expect((yield* restarted.lookup(f.identity, request, hash, resource))?.terminal).toEqual(
            receipt?.terminal,
          );
        } else yield* typedDenial(effect);
        expect((yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).length).toBe(1);
        expect((yield* f.sql`SELECT unit FROM project_team_pi_process`).length).toBe(1);
        expect((yield* f.sql`SELECT reservation_id FROM project_team_model_request`).length).toBe(
          0,
        );
      }),
    ),
  );
}

for (const mode of [
  "reported",
  "lost-receipt",
  "changed-settlement",
  "changed-reservation",
  "changed-charge",
  "changed-root",
  "pending",
  "budget",
  "transport-missing",
  "transport-false",
  "release-proof-missing",
  "capacity-held",
  "capacity-quarantine",
  "capacity-legacy",
  "settlement-unknown",
  "settlement-corrupt",
  "receipt-empty",
  "receipt-oversize",
  "receipt-boundary",
] as const) {
  it.effect(`stable Pi replay preserves original accounting: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* terminalFixtureFor(true);
        yield* f.activate;
        const accounting = yield* makeAccounting({
          environmentId: "environment",
          routeId: "command-code-ling-free",
          model,
          acceptedReportedModels: [model],
          resolveOperation: f.operations.resolveOperation,
        });
        const reservation = {
          workerId: f.op.workerId,
          operationId: f.op.operation.operationId,
          generation: 0,
          requestId: 1,
          routeId: "command-code-ling-free",
          provider: "command-code" as const,
          model,
          maxInputTokens: 100,
          maxOutputTokens: 100,
          callCount: 1 as const,
          deadlineAtMs: time + 10000,
        };
        const reserved = yield* accounting.reserve(f.op.principal, reservation);
        const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
        const settled = yield* accounting.settle({
          ...reservation,
          reservationId: reserved.reservationId,
          outcome: "reported",
          ...(mode === "transport-missing" ? {} : { transportDrained: mode !== "transport-false" }),
          chargedInputTokens: 10,
          chargedOutputTokens: 20,
          reportedModel: model,
          reportedUsage: usage,
        });
        const terminal = {
          ...f.terminal("success", true),
          accountingReceipts: [
            {
              requestId: 1,
              routeId: reservation.routeId,
              provider: reservation.provider,
              model,
              reportedModel: model,
              usage,
              reservationId: reserved.reservationId,
              accountingReceiptId: settled.accountingReceiptId,
            },
          ],
        };
        if (mode === "transport-missing" || mode === "transport-false") {
          const before = yield* f.sql`SELECT * FROM project_team_model_request`;
          expect(before[0]).toMatchObject({ status: "reported", capacity_state: "quarantine" });
          yield* typedDenial(f.operations.persistTerminal(f.op, terminal), "uncertain");
          yield* typedDenial(
            f.operations.lookup(f.identity, f.request, f.requestHash, f.resourceHash),
            "uncertain",
          );
          expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(before);
          expect(yield* f.sql`SELECT status FROM project_team_pi_operation`).toEqual([
            { status: "running" },
          ]);
          return;
        }
        yield* f.operations.persistTerminal(f.op, terminal);
        if (mode.startsWith("receipt-")) {
          const snapshot = Effect.fn("snapshotPiReplayDatabase")(function* () {
            const tables = yield* f.sql<{
              name: string;
            }>`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`;
            return yield* Effect.forEach(tables, (table) =>
              f.sql
                .unsafe(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`)
                .pipe(Effect.map((rows) => ({ table: table.name, rows }))),
            );
          });
          const changed =
            mode === "receipt-empty" ? "" : "x".repeat(mode === "receipt-boundary" ? 256 : 257);
          for (const id of [settled.accountingReceiptId, changed, settled.accountingReceiptId]) {
            const retained = {
              ...terminal,
              accountingReceipts: terminal.accountingReceipts.map((receipt) => ({
                ...receipt,
                accountingReceiptId: id,
              })),
            };
            yield* f.sql`UPDATE project_team_model_request SET accounting_receipt_id=${id}`;
            yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${encodeJson(retained)} WHERE operation_id=${f.op.operation.operationId}`;
            const before = yield* snapshot();
            const restarted = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
            const replay = restarted.lookup(f.identity, f.request, f.requestHash, f.resourceHash);
            if (id.length >= 1 && id.length <= 256) {
              expect((yield* replay)?.terminal).toEqual(retained);
              expect((yield* replay)?.terminal).toEqual(retained);
            } else {
              yield* typedDenial(replay, "uncertain");
              yield* typedDenial(replay, "uncertain");
            }
            expect(yield* snapshot()).toEqual(before);
          }
          return;
        }
        if (mode === "lost-receipt")
          yield* f.sql`UPDATE project_team_model_request SET accounting_receipt_id=NULL`;
        if (mode === "changed-settlement")
          yield* f.sql`UPDATE project_team_model_request SET settlement_json=json_set(settlement_json,'$.reportedUsage.total_tokens',99)`;
        if (mode === "changed-reservation")
          yield* f.sql`UPDATE project_team_model_request SET reservation_json=json_set(reservation_json,'$.requestId',2)`;
        if (mode === "changed-charge")
          yield* f.sql`UPDATE project_team_model_request SET charged_input_tokens=99`;
        if (mode === "changed-root")
          yield* f.sql`UPDATE project_team_model_request SET run_id='other'`;
        if (mode === "pending") yield* f.sql`UPDATE project_team_model_request SET status='held'`;
        if (mode === "budget")
          yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=maximum_tokens+1`;
        if (mode === "release-proof-missing")
          yield* f.sql`UPDATE project_team_model_request SET settlement_json=json_remove(settlement_json,'$.transportDrained')`;
        if (mode.startsWith("capacity-"))
          yield* f.sql`UPDATE project_team_model_request SET capacity_state=${mode.slice("capacity-".length)}`;
        if (mode === "settlement-unknown")
          yield* f.sql`UPDATE project_team_model_request SET status='unknown'`;
        if (mode === "settlement-corrupt")
          yield* f.sql`UPDATE project_team_model_request SET settlement_json='{'`;
        const before = yield* f.sql`SELECT * FROM project_team_model_request`;
        const replay = f.operations.lookup(f.identity, f.request, f.requestHash, f.resourceHash);
        if (mode === "reported") {
          expect((yield* replay)?.terminal).toEqual(terminal);
          expect((yield* replay)?.terminal).toEqual(terminal);
        } else yield* typedDenial(replay, "uncertain");
        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(before);
      }),
    ),
  );
}
for (const mode of [
  "reported",
  "exact-budget",
  "aggregate-budget",
  "duplicate-receipt",
  "duplicate-reservation",
  "duplicate-request",
  "unsafe-reservation-sum",
  "missing-request",
] as const) {
  it.effect(`stable Pi replay checks released sequential accounting: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* terminalFixtureFor(true);
        yield* f.activate;
        const accounting = yield* makeAccounting({
          environmentId: "environment",
          routeId: "command-code-ling-free",
          model,
          acceptedReportedModels: [model],
          resolveOperation: f.operations.resolveOperation,
        });
        const receipts: PiSessionTerminal["accountingReceipts"][number][] = [];
        for (let requestId = 1; requestId <= (mode === "exact-budget" ? 2 : 3); requestId++) {
          const reservation = {
            workerId: f.op.workerId,
            operationId: f.op.operation.operationId,
            generation: 0,
            requestId,
            routeId: "command-code-ling-free",
            provider: "command-code" as const,
            model,
            maxInputTokens: mode === "exact-budget" ? 5000 : 6000,
            maxOutputTokens: mode === "exact-budget" ? 5000 : 6000,
            callCount: 1 as const,
            deadlineAtMs: time + 10000,
          };
          const reserved = yield* accounting.reserve(f.op.principal, reservation);
          const tokens = mode === "exact-budget" ? 5000 : 1000;
          const usage = {
            prompt_tokens: tokens,
            completion_tokens: tokens,
            total_tokens: tokens * 2,
          };
          const settled = yield* accounting.settle({
            ...reservation,
            reservationId: reserved.reservationId,
            outcome: "reported",
            transportDrained: true,
            chargedInputTokens: tokens,
            chargedOutputTokens: tokens,
            reportedModel: model,
            reportedUsage: usage,
          });
          receipts.push({
            requestId,
            routeId: reservation.routeId,
            provider: reservation.provider,
            model,
            reportedModel: model,
            usage,
            reservationId: reserved.reservationId,
            accountingReceiptId: settled.accountingReceiptId,
          });
        }
        const terminal = { ...f.terminal("success", true), accountingReceipts: receipts };
        yield* f.operations.persistTerminal(f.op, terminal);
        // Corrupt retained SQL after actual producer settlement; no transport or kernel was run.
        if (mode === "aggregate-budget") {
          yield* f.sql`UPDATE project_team_model_request SET charged_input_tokens=4000,charged_output_tokens=4000,settlement_json=json_set(settlement_json,'$.chargedInputTokens',4000,'$.chargedOutputTokens',4000,'$.reportedUsage.prompt_tokens',4000,'$.reportedUsage.completion_tokens',4000,'$.reportedUsage.total_tokens',8000)`;
          for (let i = 0; i < receipts.length; i++)
            receipts[i] = {
              ...receipts[i]!,
              usage: { prompt_tokens: 4000, completion_tokens: 4000, total_tokens: 8000 },
            };
        }
        if (mode === "duplicate-receipt") {
          yield* f.sql`UPDATE project_team_model_request SET accounting_receipt_id=${receipts[0]!.accountingReceiptId}`;
          for (let i = 1; i < receipts.length; i++)
            receipts[i] = {
              ...receipts[i]!,
              accountingReceiptId: receipts[0]!.accountingReceiptId,
            };
        }
        if (mode === "duplicate-reservation") receipts[1] = receipts[0]!;
        if (mode === "duplicate-request")
          receipts[1] = { ...receipts[1]!, requestId: receipts[0]!.requestId };
        if (mode === "unsafe-reservation-sum")
          yield* f.sql`UPDATE project_team_model_request SET maximum_input_tokens=${Number.MAX_SAFE_INTEGER},maximum_output_tokens=${Number.MAX_SAFE_INTEGER}`;
        if (mode === "missing-request")
          yield* f.sql`DELETE FROM project_team_model_request WHERE reservation_id=${receipts[0]!.reservationId}`;
        yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${encodeJson(terminal)} WHERE operation_id=${f.op.operation.operationId}`;
        const before = yield* f.sql`SELECT * FROM project_team_model_request ORDER BY request_id`;
        const budgets = yield* f.sql`SELECT * FROM project_team_model_budget`;
        const restarted = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
        const replay = restarted.lookup(f.identity, f.request, f.requestHash, f.resourceHash);
        if (mode === "reported" || mode === "exact-budget") {
          expect((yield* replay)?.terminal).toEqual(terminal);
          expect((yield* replay)?.terminal).toEqual(terminal);
        } else yield* typedDenial(replay, "uncertain");
        expect(yield* f.sql`SELECT * FROM project_team_model_request ORDER BY request_id`).toEqual(
          before,
        );
        expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(budgets);
      }),
    ),
  );
}
it.effect("a stable lookup miss cannot admit two competing preparations", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const request = { threadId, kind: "initialize" as const, operationId: "competing-root-id" };
      const hash = NodeCrypto.createHash("sha256")
        .update(canonicalProjectWorkPayload(request))
        .digest("hex");
      const resourceHash = "a".repeat(64);
      expect(yield* f.operations.lookup(f.identity, request, hash, resourceHash)).toBeUndefined();
      const prepare = (workerId: string) =>
        f.operations
          .prepare(f.identity, request, hash, {
            allocation: f.allocation,
            operationId: request.operationId,
            workerId,
            resourceHash,
          })
          .pipe(Effect.result);
      const results = yield* Effect.all([prepare("first"), prepare("second")], {
        concurrency: "unbounded",
      });
      expect(results.filter((entry) => entry._tag === "Success")).toHaveLength(1);
      expect(results.filter((entry) => entry._tag === "Failure")).toHaveLength(1);
      yield* typedDenial(f.operations.lookup(f.identity, request, hash, resourceHash), "conflict");
      expect((yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).length).toBe(1);
      expect((yield* f.sql`SELECT unit FROM project_team_pi_process`).length).toBe(1);
    }),
  ),
);

for (const mode of [
  "unchanged",
  "removed-stage-file",
  "removed",
  "trailing-newline",
  "missing-full-launch",
  "missing-native-state",
  "unknown-launch-field",
  "negative-identity",
  "invalid-runtime-bound",
  "contradictory-kernel",
  "duplicate-kernel",
  "unknown-kernel",
  "malformed-kernel",
  "populated-kernel",
] as const) {
  it.effect(`replay review repair rejects malformed retained allocation and drain: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* terminalFixtureFor(true, mode === "removed-stage-file");
        yield* f.activate;
        yield* f.operations.persistTerminal(f.op, f.terminal("success", true));
        if (mode === "missing-full-launch") {
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_remove(intent_json,'$.allocation.launch.argv','$.allocation.launch.protectedRoots','$.allocation.launch.runtimeFiles')`;
          yield* f.sql`UPDATE project_team_pi_process SET allocation_json=json_remove(allocation_json,'$.launch.argv','$.launch.protectedRoots','$.launch.runtimeFiles')`;
        }
        if (mode === "missing-native-state") {
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_remove(intent_json,'$.allocation.launch.nativeState')`;
          yield* f.sql`UPDATE project_team_pi_process SET allocation_json=json_remove(allocation_json,'$.launch.nativeState')`;
        }
        if (mode === "unknown-launch-field") {
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.allocation.launch.unknown',1)`;
          yield* f.sql`UPDATE project_team_pi_process SET allocation_json=json_set(allocation_json,'$.launch.unknown',1)`;
        }
        if (mode === "negative-identity") {
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.allocation.launch.workspace.dev',-1)`;
          yield* f.sql`UPDATE project_team_pi_process SET allocation_json=json_set(allocation_json,'$.launch.workspace.dev',-1)`;
        }
        if (mode === "invalid-runtime-bound") {
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.allocation.policy.runtimeSeconds',999999999,'$.allocation.launch.runtimeSeconds',999999999)`;
          yield* f.sql`UPDATE project_team_pi_process SET allocation_json=json_set(allocation_json,'$.policy.runtimeSeconds',999999999,'$.launch.runtimeSeconds',999999999)`;
        }
        const kernel =
          mode === "removed"
            ? "removed"
            : mode === "trailing-newline"
              ? "populated 0\nfrozen 0\n"
              : mode === "contradictory-kernel"
                ? "populated 0\npopulated 1\nfrozen 0"
                : mode === "duplicate-kernel"
                  ? "populated 0\npopulated 0\nfrozen 0"
                  : mode === "unknown-kernel"
                    ? "populated 0\nunknown 0"
                    : mode === "malformed-kernel"
                      ? "populated 0\nfrozen banana"
                      : mode === "populated-kernel"
                        ? "populated 1\nfrozen 0"
                        : undefined;
        if (kernel !== undefined) {
          yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=json_set(terminal_json,'$.drain.kernel',${kernel})`;
          yield* f.sql`UPDATE project_team_pi_process SET drain_json=json_set(drain_json,'$.kernel',${kernel})`;
        }
        const replay = f.operations.lookup(f.identity, f.request, f.requestHash, f.resourceHash);
        if (["unchanged", "removed-stage-file", "removed", "trailing-newline"].includes(mode))
          expect((yield* replay)?.terminal).toEqual({
            ...f.terminal("success", true),
            ...(kernel === undefined ? {} : { drain: { ...f.drain, kernel } }),
          });
        else yield* typedDenial(replay, "uncertain");
      }),
    ),
  );
}

for (const mode of [
  "unchanged",
  "missing-caps",
  "wrong-prior-binding",
  "over-root-tokens",
  "over-root-time",
  "over-all-token-caps",
  "over-all-time-caps",
  "wrong-root-binding",
  "wrong-role",
  "wrong-request",
  "wrong-allocation",
] as const) {
  it.effect(`standalone root anchor validates the complete original proof: ${mode}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.prepare();
        yield* f.operations.persistTerminal(first, {
          identity: { workerId: first.workerId, generation: 0 },
          operation: first.operation,
          outcome: "canceled",
          ownerCaptured: false,
          native: null,
          drain: null,
          accountingReceipts: [],
        });
        if (mode === "missing-caps")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_remove(intent_json,'$.operationLimits')`;
        if (mode === "wrong-prior-binding")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.binding.recordId','foreign')`;
        if (mode === "over-root-tokens" || mode === "over-all-token-caps") {
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.rootBudget.maximumTokens',20001)`;
          yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=20001`;
          if (mode === "over-all-token-caps")
            yield* f.sql`UPDATE project_team_pi_operation SET maximum_tokens=20001,intent_json=json_set(intent_json,'$.operationLimits.maximumTokens',20001)`;
        }
        if (mode === "over-root-time" || mode === "over-all-time-caps") {
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.rootBudget.deadlineAtMs',deadline_at_ms+1000)`;
          yield* f.sql`UPDATE project_team_model_budget SET deadline_at_ms=deadline_at_ms+1000`;
          if (mode === "over-all-time-caps")
            yield* f.sql`UPDATE project_team_pi_operation SET deadline_at_ms=deadline_at_ms+1000,intent_json=json_set(intent_json,'$.operationLimits.deadlineAtMs',deadline_at_ms+1000)`;
        }
        if (mode === "wrong-root-binding")
          yield* f.sql`UPDATE project_team_pi_operation SET root_binding_id='foreign'`;
        if (mode === "wrong-role")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.role.instructions','Changed original role')`;
        if (mode === "wrong-request")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.request.threadId','foreign')`;
        if (mode === "wrong-allocation")
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.allocation.nonce','foreign')`;
        const before = yield* f.sql`SELECT * FROM project_team_model_budget`;
        const nextAllocation = {
          ...f.allocation,
          unit: `t3-pi-managed-anchor-${mode}.service`,
          nonce: `anchor-${mode}`,
        };
        const next = yield* f.operations
          .prepare(f.identity, { threadId, kind: "initialize" }, `anchor-${mode}`, {
            allocation: nextAllocation,
            workerId: `anchor-${mode}`,
            operationId: `anchor-${mode}`,
          })
          .pipe(Effect.result);
        expect(next._tag).toBe(mode === "unchanged" ? "Success" : "Failure");
        expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(before);
        expect((yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).length).toBe(
          mode === "unchanged" ? 2 : 1,
        );
        expect(yield* f.sql`SELECT status FROM project_team_pi_process ORDER BY rowid`).toEqual(
          mode === "unchanged"
            ? [{ status: "drained" }, { status: "allocated" }]
            : [{ status: "drained" }],
        );
      }),
    ),
  );
}

for (const tampered of [false, true]) {
  it.effect(
    `standalone root anchor retains the original deadline after native update: ${tampered}`,
    () =>
      fileTest(
        Effect.gen(function* () {
          const f = yield* fixture;
          const first = yield* f.prepare();
          yield* f.operations.persistNative(first, nativeReference);
          yield* f.operations.persistTerminal(first, {
            identity: { workerId: first.workerId, generation: 0 },
            operation: first.operation,
            outcome: "canceled",
            ownerCaptured: false,
            native: null,
            drain: null,
            accountingReceipts: [],
          });
          if (tampered) {
            yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.rootBudget.deadlineAtMs',deadline_at_ms+1000)`;
            yield* f.sql`UPDATE project_team_model_budget SET deadline_at_ms=deadline_at_ms+1000`;
          }
          yield* TestClock.setTime(first.deadlineAtMs + 1);
          const before = yield* f.sql`SELECT * FROM project_team_model_budget`;
          yield* rejected(
            f.operations.prepare(f.identity, { threadId, kind: "initialize" }, "late", {
              allocation: {
                ...f.allocation,
                unit: "t3-pi-managed-anchor-late.service",
                nonce: "late",
              },
              operationId: "late",
              workerId: "late",
            }),
          );
          expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(before);
          expect((yield* f.sql`SELECT * FROM project_team_pi_operation`).length).toBe(1);
          expect(yield* f.sql`SELECT status FROM project_team_pi_process ORDER BY rowid`).toEqual([
            { status: "drained" },
          ]);
        }),
      ),
  );
}

const activateStandalone = (
  f: Effect.Success<typeof fixture>,
  op: Parameters<typeof f.operations.persistence>[0],
) =>
  Effect.gen(function* () {
    const owner = {
      type: "owner" as const,
      unit: op.allocation.unit,
      nonce: op.allocation.nonce,
      invocation: "a".repeat(32),
      cgroup: `/sys/fs/cgroup/${op.allocation.unit}`,
      pid: 123,
      memoryBytes: op.allocation.policy.memoryBytes,
      swapBytes: 0 as const,
      oomGroup: 1 as const,
    };
    yield* f.operations.persistence(op).claimActivation(op.allocation);
    yield* f.operations.persistence(op).beforeStart(owner);
    yield* f.operations.persistNative(op, nativeReference);
    return owner;
  });
for (const tampered of [false, true]) {
  it.effect(`standalone root anchor keeps exhausted cumulative charges: ${tampered}`, () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.prepare();
        const owner = yield* activateStandalone(f, first);
        const accounting = yield* makeAccounting({
          environmentId: "environment",
          routeId: "command-code-ling-free",
          model,
          acceptedReportedModels: [model],
          resolveOperation: f.operations.resolveOperation,
        });
        const request = {
          workerId: first.workerId,
          operationId: first.operation.operationId,
          generation: 0,
          requestId: 1,
          routeId: "command-code-ling-free",
          provider: "command-code" as const,
          model,
          maxInputTokens: 19900,
          maxOutputTokens: 100,
          callCount: 1 as const,
          deadlineAtMs: time + 10000,
        };
        const receipt = yield* accounting.reserve(first.principal, request);
        yield* accounting.settle({
          ...request,
          reservationId: receipt.reservationId,
          outcome: "unknown",
          transportDrained: true,
          chargedInputTokens: 19900,
          chargedOutputTokens: 100,
        });
        yield* f.operations.persistTerminal(first, {
          identity: { workerId: first.workerId, generation: 0 },
          operation: first.operation,
          outcome: "failed",
          ownerCaptured: true,
          native: nativeReference,
          accountingReceipts: [],
          drain: {
            unit: owner.unit,
            invocation: owner.invocation,
            cgroup: owner.cgroup,
            ownerPid: owner.pid,
            memoryBytes: owner.memoryBytes,
            swapBytes: 0,
            oomGroup: 1,
            launcherPid: 124,
            childPid: 125,
            childExitCode: 0,
            kernel: "removed",
          },
        });
        if (tampered) {
          yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.rootBudget.maximumTokens',20002)`;
          yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=20002`;
        }
        const before = yield* f.sql`SELECT * FROM project_team_model_budget`;
        const next = yield* f.operations
          .prepare(f.identity, { threadId, kind: "initialize" }, "more", {
            allocation: {
              ...f.allocation,
              unit: "t3-pi-managed-22222222-2222-4222-8222-222222222222.service",
              nonce: "22222222-2222-4222-8222-222222222222",
            },
            operationId: "more",
            workerId: "more",
          })
          .pipe(Effect.result);
        if (tampered) expect(next._tag).toBe("Failure");
        else {
          if (next._tag !== "Success") return yield* Effect.die("Intact Root proof unavailable");
          yield* activateStandalone(f, next.success);
          yield* rejected(
            accounting.reserve(next.success.principal, {
              ...request,
              workerId: "more",
              operationId: "more",
              maxInputTokens: 1,
              maxOutputTokens: 1,
            }),
          );
        }
        expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(before);
        expect(
          yield* f.sql`SELECT status,charged_input_tokens,charged_output_tokens FROM project_team_model_request`,
        ).toEqual([{ status: "unknown", charged_input_tokens: 19900, charged_output_tokens: 100 }]);
        expect((yield* f.sql`SELECT * FROM project_team_pi_process`).length).toBe(tampered ? 1 : 2);
      }),
    ),
  );
}

it.effect("standalone root anchor validates existing-operation authorization and reservation", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.prepare();
      yield* activateStandalone(f, first);
      const accounting = yield* makeAccounting({
        environmentId: "environment",
        routeId: "command-code-ling-free",
        model,
        acceptedReportedModels: [model],
        resolveOperation: f.operations.resolveOperation,
      });
      const request = {
        workerId: first.workerId,
        operationId: first.operation.operationId,
        generation: 0,
        requestId: 1,
        routeId: "command-code-ling-free",
        provider: "command-code" as const,
        model,
        maxInputTokens: 19900,
        maxOutputTokens: 100,
        callCount: 1 as const,
        deadlineAtMs: time + 10000,
      };
      const receipt = yield* accounting.reserve(first.principal, request);
      yield* accounting.settle({
        ...request,
        reservationId: receipt.reservationId,
        outcome: "unknown",
        transportDrained: true,
        chargedInputTokens: 19900,
        chargedOutputTokens: 100,
      });
      yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json,'$.rootBudget.maximumTokens',20002)`;
      yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=20002`;
      yield* rejected(
        accounting.reserve(first.principal, {
          ...request,
          requestId: 2,
          maxInputTokens: 1,
          maxOutputTokens: 1,
        }),
      );
      yield* rejected(f.operations.authorize(first));
      expect(
        yield* f.sql`SELECT status,charged_input_tokens,charged_output_tokens FROM project_team_model_request`,
      ).toEqual([{ status: "unknown", charged_input_tokens: 19900, charged_output_tokens: 100 }]);
    }),
  ),
);

it.effect(
  "task resources consume worker activation and preserve original root and operation deadlines",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* journalFixture();
        const op = yield* f.operations.prepare(
          f.identity,
          { threadId, kind: "initialize" },
          "resource-worker",
          {
            allocation: f.allocation,
            workerId: "resource-worker",
            operationId: "journal-initialize",
          },
        );
        yield* f.operations.persistence(op).claimActivation(f.allocation);
        expect(
          yield* f.sql`SELECT task_id,deadline_at_ms,memory_bytes FROM project_task_resource_budget`,
        ).toEqual([
          {
            task_id: f.binding.taskId,
            deadline_at_ms: f.admitted.intent.limits.rootDeadlineAtMs,
            memory_bytes: 2147483648,
          },
        ]);
        expect(
          yield* f.sql`SELECT deadline_at_ms,memory_bytes,owner_json,drain_json FROM project_task_resource_child`,
        ).toEqual([
          {
            deadline_at_ms: op.deadlineAtMs,
            memory_bytes: f.allocation.policy.memoryBytes,
            owner_json: null,
            drain_json: null,
          },
        ]);
        const owner = {
          type: "owner" as const,
          unit: f.allocation.unit,
          nonce: f.allocation.nonce,
          invocation: "a".repeat(32),
          cgroup: `/sys/fs/cgroup/controlled/${f.allocation.unit}`,
          pid: 123,
          memoryBytes: f.allocation.policy.memoryBytes,
          swapBytes: 0,
          oomGroup: 1,
        };
        yield* f.operations.persistence(op).beforeStart(owner);
        const drain = {
          unit: owner.unit,
          invocation: owner.invocation,
          cgroup: owner.cgroup,
          ownerPid: owner.pid,
          memoryBytes: owner.memoryBytes,
          swapBytes: 0,
          oomGroup: 1,
          launcherPid: 124,
          childPid: 125,
          childExitCode: 0,
          kernel: "removed",
        };
        const persistence = f.operations.persistence(op);
        if (!persistence.afterDrain) return yield* Effect.die("Missing consumed resource drain");
        yield* rejected(persistence.afterDrain({ ...drain, kernel: "populated 1" }));
        yield* TestClock.setTime(op.deadlineAtMs + 1);
        yield* persistence.afterDrain(drain);
        const resumed = yield* makeProjectTaskResources("environment");
        yield* f.sql.withTransaction(
          resumed.pi(op.operation.operationId, op.allocation).drain({
            state: "drained",
            unit: owner.unit,
            invocation: owner.invocation,
            cgroup: owner.cgroup,
            kernel: "removed",
          }),
        );
        expect(yield* f.sql`SELECT drain_json FROM project_task_resource_child`).toEqual([
          { drain_json: canonicalProjectWorkPayload(drain) },
        ]);
        yield* rejected(f.operations.persistence(op).claimActivation(f.allocation));
      }),
    ),
);

it.effect("task resources deny worker activation after its current task authority is deleted", () =>
  fileTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const op = yield* f.prepare();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at,tombstone_json)
      VALUES(${projectId},'tombstoned',${f.binding.worktree},1,${at},'{}')`;
      yield* rejected(f.operations.persistence(op).claimActivation(f.allocation));
      expect(yield* sql`SELECT unit FROM project_task_resource_child`).toEqual([]);
    }),
  ),
);

it.effect(
  "legacy native cleanup settles exact captured Pi ownership without a resource grant",
  () =>
    fileTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        const op = yield* f.prepare();
        const owner = {
          type: "owner" as const,
          unit: op.allocation.unit,
          nonce: op.allocation.nonce,
          invocation: "a".repeat(32),
          cgroup: `/sys/fs/cgroup/${op.allocation.unit}`,
          pid: 123,
          memoryBytes: op.allocation.policy.memoryBytes,
          swapBytes: 0,
          oomGroup: 1,
        };
        const drain = {
          unit: owner.unit,
          invocation: owner.invocation,
          cgroup: owner.cgroup,
          ownerPid: owner.pid,
          memoryBytes: owner.memoryBytes,
          swapBytes: 0,
          oomGroup: 1,
          launcherPid: 124,
          childPid: 125,
          childExitCode: 1,
          kernel: "removed",
        };
        yield* sql`UPDATE project_team_pi_process SET status='captured',owner_json=${canonicalProjectWorkPayload(owner)} WHERE operation_id=${op.operation.operationId}`;
        yield* sql`UPDATE project_team_pi_operation SET status='running' WHERE operation_id=${op.operation.operationId}`;
        const persistence = f.operations.persistence(op);
        if (!persistence.afterDrain) return yield* Effect.die("Missing Pi cleanup callback");
        yield* TestClock.setTime(op.deadlineAtMs + 1);
        yield* rejected(persistence.beforeStart(owner));
        yield* rejected(persistence.claimActivation(op.allocation));
        yield* rejected(persistence.afterDrain({ ...drain, invocation: "b".repeat(32) }));
        yield* persistence.afterDrain(drain);
        const resources = yield* makeProjectTaskResources("environment");
        yield* sql.withTransaction(
          resources.pi(op.operation.operationId, op.allocation).cleanupDrain({
            state: "drained",
            unit: owner.unit,
            invocation: owner.invocation,
            cgroup: owner.cgroup,
            kernel: "removed",
          }),
        );
        yield* f.operations.persistTerminal(op, {
          identity: { workerId: op.workerId, generation: op.authority.binding.generation },
          operation: op.operation,
          outcome: "failed",
          ownerCaptured: true,
          native: null,
          accountingReceipts: [],
          drain,
        });
        expect(yield* sql`SELECT status,drain_json FROM project_team_pi_process`).toEqual([
          { status: "drained", drain_json: canonicalProjectWorkPayload(drain) },
        ]);
        expect(yield* sql`SELECT task_id FROM project_task_resource_budget`).toEqual([]);
        expect(yield* sql`SELECT unit FROM project_task_resource_child`).toEqual([]);
      }),
    ),
);
