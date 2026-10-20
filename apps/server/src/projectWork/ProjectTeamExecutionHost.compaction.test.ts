import { makeProjectTeamContext } from "./ProjectTeamContext.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as Option from "effect/Option";
import { makeProjectTeamPiRuntime, ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { makeProjectTeamRuntime } from "./ProjectTeamRuntime.ts";
import { layerTest } from "../serverSettings.ts";
import { notifyCompactCallerChange } from "./ProjectTeamCompactCaller.ts";
import { ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
  SkillCatalogRevision,
  OrchestrationEvent,
  MessageId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  at,
  attribution,
  projectId,
  providerInstanceId,
  threadId,
  seed,
  scoped,
  restoreHistoricalBinding,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchJournalError,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamPiOperations } from "./ProjectTeamPiOperations.ts";
import { make as makeAccounting } from "./ProjectTeamModelAccounting.ts";
import { preallocatePiManagedProcess } from "../provider/pi/PiManagedProcess.ts";
import type { PiSessionTerminal } from "../provider/pi/PiSessionRuntime.ts";
import type { PiNativeReference } from "../provider/pi/PiWorkerProtocol.ts";

import { waitForProjectTeamRetainedCompaction } from "./ProjectTeamExecutionHost.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

const model = "inclusionai/ling-3.1-flash:free";
const defaultModel = model;
const now = Date.parse(at) + 100;
const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const native: PiNativeReference = {
  sessionId: "mailbox-native",
  sessionReference: "sessions/mailbox.jsonl",
  leafId: null,
  persisted: true,
};

// Disposable SQL and controlled custody receipts only: no worker is started.
const fixtureWithAssignment = Effect.fn("mailboxTest.fixture")(function* (
  assignment = "Investigate the original approved task",
  priorHistoryOrdinal?: number,
  subscription = false,
) {
  const model = subscription ? "gpt-6-luna" : defaultModel;
  const maximumTokens = subscription ? 64000 : 20000;
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
            new ProjectWorkPolicyError("invalid-state", "Keep original claim for mailbox journal"),
          );
        }
        return repository.execute(command);
      },
    }),
    Effect.result,
  );
  if (claim?.transition?.kind !== "claim") return yield* Effect.die("Missing original claim");
  const state = yield* readCurrentState(sql, projectId);
  const role = state.foundationRecords?.find((r) => r.kind === "role-revision");
  if (role?.kind !== "role-revision") return yield* Effect.die("Missing original role");
  yield* restoreHistoricalBinding({ ...role, model });
  const fs = yield* FileSystem.FileSystem;
  const worktree = yield* fs.makeTempDirectoryScoped();
  const nativeRoot = yield* fs.makeTempDirectoryScoped();
  const protectedRoot = yield* fs.makeTempDirectoryScoped();
  const binding = {
    ...claim.transition.binding,
    worktree,
    branch: "refs/heads/mailbox",
    model,
    configuration: {
      ...claim.transition.binding.configuration,
      maxTokens: maximumTokens,
      maxDurationMs: 300000,
      runtimeVersion: "0.99.1",
      instructionsHash: NodeCrypto.createHash("sha256").update(role.instructions).digest("hex"),
    },
  };
  const commit = Effect.fn("mailboxTest.commit")(function* (
    records: (typeof ProjectWorkFoundationCommitCommand.Type)["records"],
    commandId: string,
  ) {
    yield* repository.execute(
      decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId,
        expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
        attribution,
        committedAt: at,
        records,
      }),
    );
  });
  yield* commit(
    [
      {
        kind: "limits",
        projectId,
        recordId: "mailbox-limits",
        revision: 0,
        generation: 0,
        updatedAt: at,
        status: "configured",
        model,
        tokenLimit: maximumTokens,
        durationLimitMs: 300000,
        environmentModelCalls: 2,
        modelCalls: 2,
        projectWritableWorkers: 1,
        delegationDepth: 2,
        repairAllowance: 2,
      },
    ],
    "mailbox-limits",
  );
  const request = {
    dispatchId: "mailbox-dispatch",
    claim: {
      ...claim,
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      transition: { ...claim.transition, binding },
    },
    git: {
      effectId: "mailbox-dispatch",
      runId: binding.recordId,
      generation: binding.generation,
      primaryRoot: "/workspace",
      commonGitDirectory: "/workspace/.git",
      worktreePath: worktree,
      branchRef: binding.branch,
      baseRef: "refs/heads/main",
      baseOid: "a".repeat(40),
      ownershipToken: "mailbox-owner",
      policyHash: "b".repeat(64),
    },
    setupId: "mailbox-setup",
    initializeOperationId: "mailbox-initialize",
    assignmentOperationId: "mailbox-assignment",
    assignment,
  };
  yield* TestClock.setTime(now);
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 2,
    // Controlled stage-history sequencing only; no Git or worker is executed.
    verifyStage: (receipt, original) =>
      receipt.evidence.bindingId === original.intent.request.git.runId
        ? Effect.void
        : Effect.fail(new ProjectTeamDispatchJournalError({ reason: "Foreign controlled stage" })),
  });
  const reserved = yield* journal.reserve(request);
  let snapshot = yield* journal.claimEffect(reserved.fence);
  for (const stage of ["workspace-ready", "setup-complete"] as const)
    snapshot = yield* journal.readRetained(
      (yield* journal.advanceStage(snapshot.fence, {
        receiptId: `mailbox-${stage}`,
        stage,
        evidence: { bindingId: binding.recordId },
      })).fence.dispatchId,
    );
  const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
  const allocation = Effect.gen(function* () {
    return yield* preallocatePiManagedProcess({
      workspaceRoot: worktree,
      workspaceAccess: "readonly",
      nativeStateRoot: nativeRoot,
      protectedRoots: [protectedRoot],
      runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
      argv: ["/bin/true"],
      memoryBytes: 33554432,
      runtimeSeconds: 10,
    });
  });
  const identity = { providerInstanceId, threadId };
  const skillPlan = {
    providerInstanceId,
    desiredRevision: SkillCatalogRevision.make(0),
    applicationMode: "new_session_required" as const,
    skillKeys: [],
    payload: { kind: "pi-managed-skills", root: worktree, skills: [] },
  };
  const initRequest = {
    threadId,
    kind: "initialize" as const,
    operationId: request.initializeOperationId,
    skillPlan,
  };
  if (priorHistoryOrdinal !== undefined) {
    // Older-binding metadata supplies a global ordinal; it grants this fixture no authority.
    yield* sql`INSERT INTO project_team_pi_operation
      (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
      operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
      VALUES('older-binding-operation','environment',${projectId},'older-binding',0,${providerInstanceId},${threadId},
      'older-binding-worker',${priorHistoryOrdinal},'initialize',${"b".repeat(64)},'older-binding',${binding.taskId},
      1000,${now + 10000},'settled','{}')`;
  }
  const init = yield* operations.prepare(identity, initRequest, hash(initRequest), {
    allocation: yield* allocation,
    workerId: "mailbox-init-worker",
    operationId: initRequest.operationId,
    resourceHash: "a".repeat(64),
  });
  const activated = new Set<string>();
  const activate = Effect.fn("mailboxTest.activate")(function* (
    op: typeof init,
    ref: PiNativeReference,
  ) {
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
    yield* operations.persistence(op).claimActivation(op.allocation);
    yield* operations.persistence(op).beforeStart(owner);
    yield* operations.persistNative(op, ref);
    activated.add(op.operation.operationId);
  });
  const complete = Effect.fn("mailboxTest.complete")(function* (
    op: typeof init,
    ref: PiNativeReference,
    outcome: PiSessionTerminal["outcome"] = "success",
    accountingReceipts: PiSessionTerminal["accountingReceipts"] = [],
    publishCompact = true,
  ) {
    if (!activated.has(op.operation.operationId)) yield* activate(op, ref);
    else yield* operations.persistNative(op, ref);
    const terminal: PiSessionTerminal = {
      identity: { workerId: op.workerId, generation: op.authority.binding.generation },
      operation: op.operation,
      outcome,
      ownerCaptured: true,
      native: ref,
      drain: {
        unit: op.allocation.unit,
        invocation: "a".repeat(32),
        cgroup: `/sys/fs/cgroup/${op.allocation.unit}`,
        ownerPid: 123,
        memoryBytes: op.allocation.policy.memoryBytes,
        swapBytes: 0,
        oomGroup: 1,
        launcherPid: 124,
        childPid: 125,
        childExitCode: 0,
        kernel: "populated 0\nfrozen 0",
      },
      accountingReceipts,
    };
    yield* operations.persistTerminal(op, terminal);
    if (op.operation.operationKind === "compact" && outcome === "success" && publishCompact)
      yield* operations.publication(op, terminal, {
        resourceHash: "a".repeat(64),
        check: () => {},
      });
    return terminal;
  });
  yield* complete(init, native);
  for (const stage of ["session-bound", "assignment-intent"] as const)
    snapshot = yield* journal.readRetained(
      (yield* journal.advanceStage(snapshot.fence, {
        receiptId: `mailbox-${stage}`,
        stage,
        evidence: { bindingId: binding.recordId },
      })).fence.dispatchId,
    );
  const promptRequest = {
    threadId,
    kind: "prompt" as const,
    operationId: request.assignmentOperationId,
    prompt: request.assignment,
    modelSelection: { instanceId: providerInstanceId, model, options: [] },
    skillPlan,
    resumeCursor: native,
  };
  const prompt = yield* operations.prepare(identity, promptRequest, hash(promptRequest), {
    allocation: yield* allocation,
    workerId: "mailbox-prompt-worker",
    operationId: promptRequest.operationId,
    resourceHash: "a".repeat(64),
  });
  const reserveInput = Effect.fn("laterTest.reserveInput")(function* (
    op = prompt,
    usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  ) {
    yield* activate(op, native);
    const accounting = yield* makeAccounting({
      environmentId: "environment",
      routeId: subscription ? "openai-subscription-luna" : "command-code-ling-free",
      model,
      acceptedReportedModels: [model],
      ...(subscription
        ? {
            subscriptionTest: {
              projectId,
              rootTaskId: prompt.authority.binding.taskId,
              model: "gpt-6-luna" as const,
              maximumTokens: 64000 as const,
              maximumDurationMs: 300000 as const,
            },
          }
        : {}),
      resolveOperation: operations.resolveOperation,
    });
    const fields = {
      workerId: op.workerId,
      operationId: op.operation.operationId,
      generation: 0,
      requestId: 1,
      routeId: subscription ? "openai-subscription-luna" : "command-code-ling-free",
      provider: subscription ? ("openai-codex" as const) : ("command-code" as const),
      ...(subscription
        ? {
            accountingMode: "openai-subscription-monitored" as const,
            unknownMaximumTokens: 64000 as const,
          }
        : {}),
      model,
      maxInputTokens: Math.max(1000, usage.prompt_tokens),
      maxOutputTokens: Math.max(100, usage.completion_tokens),
      callCount: 1 as const,
      deadlineAtMs: op.deadlineAtMs,
    };
    const reservation = yield* accounting.reserve(op.principal, fields);
    const settle = Effect.gen(function* () {
      const settled = yield* accounting.settle({
        ...fields,
        reservationId: reservation.reservationId,
        outcome: "reported",
        transportDrained: true,
        chargedInputTokens: usage.prompt_tokens,
        chargedOutputTokens: usage.completion_tokens,
        reportedModel: model,
        reportedUsage: usage,
      });
      return {
        requestId: 1,
        reservationId: reservation.reservationId,
        accountingReceiptId: settled.accountingReceiptId,
        routeId: fields.routeId,
        provider: fields.provider,
        model,
        reportedModel: model,
        usage,
      };
    });
    return { ...reservation, settle };
  });
  const messages = Effect.gen(function* () {
    return (
      (yield* readCurrentState(sql, projectId)).foundationRecords?.filter(
        (r) => r.kind === "message",
      ) ?? []
    );
  });
  return {
    sql,
    repository,
    journal,
    operations,
    snapshot,
    request,
    binding,
    allocation,
    prompt,
    complete,
    activate,
    commit,
    reserveInput,
    messages,
  };
});

const compactRequest = (id = "compact-caller") => ({
  threadId,
  requestId: MessageId.make(id),
  modelSelection: { instanceId: providerInstanceId, model, options: [] },
});
const identity = { providerInstanceId, threadId };
const observe = Effect.fn("compactTest.observe")(function* (
  f: Effect.Success<ReturnType<typeof fixtureWithAssignment>>,
  outcome: PiSessionTerminal["outcome"] = "success",
) {
  const input = yield* f.reserveInput();
  yield* f.complete(f.prompt, { ...native, leafId: "assignment-terminal" }, outcome, [
    yield* input.settle,
  ]);
  const observed = yield* f.journal.advanceStage(f.snapshot.fence, {
    receiptId: "caller-observed",
    stage: "assignment-observed",
    evidence: { bindingId: f.binding.recordId },
  });
  return yield* f.journal.readRetained(observed.fence.dispatchId);
});

it.effect(
  "reserves an active predecessor before idle, survives observation and never renews duplicates",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const request = compactRequest();
        const before =
          yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`;
        const first = yield* f.operations.reserveCompaction(identity, request);
        expect(first.created).toBe(true);
        expect(first.predecessorOperationId).toBe(f.prompt.operation.operationId);
        const restarted = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
        expect(yield* restarted.reserveCompaction(identity, request)).toEqual({
          ...first,
          created: false,
        });
        expect(
          yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`,
        ).toEqual(before);
        const snapshot = yield* observe(f);
        expect((yield* f.journal.claimCleanup(snapshot.fence))._tag).toBe("WaitingForCompact");
        expect(yield* restarted.assertCompactionReady(identity, request)).toEqual({
          ...first,
          created: false,
        });
        yield* restarted.abandonCompaction(identity, request);
        expect((yield* f.journal.claimCleanup(snapshot.fence))._tag).toBe("Claimed");
        expect(
          (yield* restarted.reserveCompaction(identity, request).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);

for (const order of ["cleanup-first", "caller-first"] as const)
  it.effect(`serializes ${order} without rejected allocations or charges`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const snapshot = yield* observe(f);
        const operations =
          yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`;
        const processes = yield* f.sql`SELECT * FROM project_team_pi_process ORDER BY operation_id`;
        const charges = yield* f.sql`SELECT * FROM project_team_model_request`;
        const request = compactRequest();
        if (order === "cleanup-first") {
          expect((yield* f.journal.claimCleanup(snapshot.fence))._tag).toBe("Claimed");
          expect(
            (yield* f.operations.reserveCompaction(identity, request).pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(yield* f.sql`SELECT * FROM project_team_compact_caller`).toEqual([]);
        } else {
          yield* f.operations.reserveCompaction(identity, request);
          expect((yield* f.journal.claimCleanup(snapshot.fence))._tag).toBe("WaitingForCompact");
          expect(
            (yield* f.operations
              .reserveCompaction(identity, compactRequest("competing"))
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            (yield* f.operations
              .reserveCompaction(identity, {
                ...request,
                modelSelection: { ...request.modelSelection, model: "changed" },
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect((yield* f.sql`SELECT status FROM project_team_compact_caller`)[0]).toEqual({
            status: "pending",
          });
          yield* f.operations.abandonCompaction(identity, request);
        }
        expect(
          yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`,
        ).toEqual(operations);
        expect(yield* f.sql`SELECT * FROM project_team_pi_process ORDER BY operation_id`).toEqual(
          processes,
        );
        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(charges);
      }),
    ),
  );

for (const timing of ["before-pull", "after-pull"] as const)
  it.effect(`release ${timing} wakes Host without domain events, including restarted owner`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const snapshot = yield* observe(f);
        const request = compactRequest();
        yield* f.operations.reserveCompaction(identity, request);
        const events = yield* PubSub.unbounded<typeof OrchestrationEvent.Type>();
        const waiting = yield* Deferred.make<void>();
        const host = yield* waitForProjectTeamRetainedCompaction({
          environmentId: "environment",
          snapshot,
          assertCurrent: f.journal.inspect(snapshot.fence.dispatchId).pipe(
            Effect.asVoid,
            Effect.mapError(
              () => new ProjectTeamDispatchJournalError({ reason: "Authority unavailable" }),
            ),
          ),
          claimCleanup: f.journal.claimCleanup(snapshot.fence).pipe(
            Effect.mapError(
              () => new ProjectTeamDispatchJournalError({ reason: "Cleanup unavailable" }),
            ),
            Effect.tap((result) =>
              result._tag === "WaitingForCompact"
                ? Deferred.succeed(waiting, undefined).pipe(
                    Effect.andThen(
                      timing === "before-pull"
                        ? f.operations
                            .abandonCompaction(identity, request)
                            .pipe(
                              Effect.mapError(
                                () =>
                                  new ProjectTeamDispatchJournalError({ reason: "Release failed" }),
                              ),
                            )
                        : Effect.void,
                    ),
                  )
                : Effect.void,
            ),
          ),
        }).pipe(
          Effect.provide(
            Layer.merge(
              ProjectWorkEventBusLive,
              Layer.mock(OrchestrationEngineService)({
                subscribeDomainEvents: PubSub.subscribe(events).pipe(
                  Effect.map(Stream.fromSubscription),
                ),
              }),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(waiting);
        const restarted = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
        if (timing === "after-pull") yield* restarted.abandonCompaction(identity, request);
        yield* Fiber.join(host);
        expect(
          (yield* f.sql`SELECT cleanup_claim_revision FROM project_team_dispatch`)[0]
            ?.cleanup_claim_revision,
        ).toBe(snapshot.fence.revision);
      }),
    ),
  );

it.effect("deadline releases pending caller and cannot renew the same identity", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixtureWithAssignment();
      const request = compactRequest();
      const caller = yield* f.operations.reserveCompaction(identity, request);
      yield* TestClock.setTime(caller.deadlineAtMs);
      expect(
        (yield* f.operations.reserveCompaction(identity, request).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* f.sql`SELECT status,deadline_at_ms FROM project_team_compact_caller`).toEqual([
        { status: "released", deadline_at_ms: caller.deadlineAtMs },
      ]);
    }),
  ),
);

it.effect(
  "active predecessor cannot qualify readiness and its creating scope releases without charging",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const request = compactRequest();
        yield* f.operations.reserveCompaction(identity, request);
        expect(
          (yield* f.operations.assertCompactionReady(identity, request).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
          { status: "pending" },
        ]);
        yield* f.operations.abandonCompaction(identity, request);
        expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
          { status: "released" },
        ]);
        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
        expect(
          (yield* f.operations.reserveCompaction(identity, request).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect(
  "consumes with operation/process atomically, rolls back failures, and replays only with current authority",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const request = compactRequest();
        yield* f.operations.reserveCompaction(identity, request);
        yield* observe(f);
        const boundary = yield* f.operations.readCompaction(identity, {
          ...request,
          kind: "compact",
        });
        const input = { ...request, kind: "compact" as const, operationId: boundary.operationId };
        const allocation = yield* f.allocation;
        const allocated = {
          allocation,
          workerId: "compact-worker",
          operationId: boundary.operationId,
          resourceHash: "a".repeat(64),
          compactContext: { provenanceSha256: "b".repeat(64), textSha256: "c".repeat(64) },
        };
        let injected = false;
        const failingSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            if (statement.compile()[0].includes("SET status='consumed'")) {
              injected = true;
              return statement.pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProjectTeamDispatchJournalError({ reason: "Injected consume failure" }),
                  ),
                ),
              );
            }
            return statement;
          },
        });
        const failing = yield* makeProjectTeamPiOperations({ environmentId: "environment" }).pipe(
          Effect.provideService(SqlClient.SqlClient, failingSql),
        );
        expect(
          (yield* failing
            .prepare(identity, input, hash(input), allocated)
            .pipe(Effect.provideService(SqlClient.SqlClient, failingSql), Effect.result))._tag,
        ).toBe("Failure");
        expect(injected).toBe(true);
        expect(
          yield* f.sql`SELECT operation_id FROM project_team_pi_operation WHERE operation_kind='compact'`,
        ).toEqual([]);
        expect(
          yield* f.sql`SELECT operation_id FROM project_team_pi_process WHERE operation_id=${boundary.operationId}`,
        ).toEqual([]);
        expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
          { status: "pending" },
        ]);
        const compact = yield* f.operations.prepare(identity, input, hash(input), allocated);
        expect(yield* f.sql`SELECT status,operation_id FROM project_team_compact_caller`).toEqual([
          { status: "consumed", operation_id: boundary.operationId },
        ]);
        yield* f.operations.abandonCompaction(identity, request);
        expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
          { status: "consumed" },
        ]);
        const accounting = yield* f.reserveInput(compact);
        yield* f.complete(compact, { ...native, leafId: "compacted" }, "success", [
          yield* accounting.settle,
        ]);
        const restarted = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
        expect((yield* restarted.readCompaction(identity, input)).operationId).toBe(
          boundary.operationId,
        );
        expect(
          (yield* restarted
            .readCompaction(identity, {
              ...input,
              modelSelection: {
                ...input.modelSelection,
                options: [{ id: "changed", value: true }],
              },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        // Revoke the credential through the durable run binding, without changing saved replay receipts.
        yield* restoreHistoricalBinding({
          ...compact.authority.binding,
          status: "stopping",
          revision: compact.authority.binding.revision + 1,
        });
        expect((yield* restarted.readCompaction(identity, input).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      }),
    ),
);

it.effect(
  "terminal before observation waits outside SQL and wakes on the exact committed Host observation",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const request = compactRequest();
        yield* f.operations.reserveCompaction(identity, request);
        const input = yield* f.reserveInput();
        yield* f.complete(
          f.prompt,
          { ...native, leafId: "terminal-before-observation" },
          "success",
          [yield* input.settle],
        );
        const read = yield* Deferred.make<void>();
        const observingSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            return statement.compile()[0].includes("SELECT * FROM project_team_compact_caller")
              ? statement.pipe(Effect.tap(() => Deferred.succeed(read, undefined)))
              : statement;
          },
        });
        const restarted = yield* makeProjectTeamPiOperations({ environmentId: "environment" }).pipe(
          Effect.provideService(SqlClient.SqlClient, observingSql),
        );
        const ready = yield* restarted
          .assertCompactionReady(identity, request)
          .pipe(Effect.provideService(SqlClient.SqlClient, observingSql), Effect.forkChild);
        yield* Deferred.await(read);
        // This independent transaction completes while readiness is waiting: no SQL loan is retained.
        expect(
          yield* f.sql.withTransaction(
            f.sql`SELECT operation_id FROM project_team_pi_operation WHERE operation_kind='compact'`,
          ),
        ).toEqual([]);
        expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
          { status: "pending" },
        ]);
        const observed = yield* f.journal.advanceStage(f.snapshot.fence, {
          receiptId: "terminal-before-observation",
          stage: "assignment-observed",
          evidence: { bindingId: f.binding.recordId },
        });
        const result = yield* Fiber.join(ready);
        expect(result.dispatchId).toBe(observed.fence.dispatchId);
        expect(result.predecessorOperationId).toBe(f.prompt.operation.operationId);
        expect(
          yield* f.sql`SELECT operation_id FROM project_team_pi_operation WHERE operation_kind='compact'`,
        ).toEqual([]);
      }),
    ),
);

for (const reason of ["cancel", "revoke", "deadline"] as const)
  it.effect(`releases a durable pending caller when observation wait ends by ${reason}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const request = compactRequest();
        const reservation = yield* f.operations.reserveCompaction(identity, request);
        const input = yield* f.reserveInput();
        yield* f.complete(f.prompt, { ...native, leafId: "waiting-terminal" }, "success", [
          yield* input.settle,
        ]);
        const read = yield* Deferred.make<void>();
        const observingSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            return statement.compile()[0].includes("SELECT * FROM project_team_compact_caller")
              ? statement.pipe(Effect.tap(() => Deferred.succeed(read, undefined)))
              : statement;
          },
        });
        const operations = yield* makeProjectTeamPiOperations({
          environmentId: "environment",
        }).pipe(Effect.provideService(SqlClient.SqlClient, observingSql));
        const fiber = yield* operations.assertCompactionReady(identity, request).pipe(
          // This scope created the admission; readiness alone owns no cancellation cleanup.
          Effect.onError(() =>
            reason === "cancel" && reservation.created
              ? operations.abandonCompaction(identity, request).pipe(Effect.ignore)
              : Effect.void,
          ),
          Effect.provideService(SqlClient.SqlClient, observingSql),
          Effect.forkChild,
        );
        yield* Deferred.await(read);
        yield* f.sql`SELECT * FROM project_team_compact_caller`;
        if (reason === "cancel") yield* Fiber.interrupt(fiber);
        else if (reason === "deadline") {
          yield* TestClock.setTime(reservation.deadlineAtMs);
          yield* Fiber.await(fiber);
        } else {
          yield* restoreHistoricalBinding({
            ...f.prompt.authority.binding,
            status: "stopping",
            revision: f.prompt.authority.binding.revision + 1,
          });
          // A committed control/stage hint carries no authority; readiness must reread SQL.
          yield* notifyCompactCallerChange;
          yield* Fiber.await(fiber);
        }
        expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
          { status: "released" },
        ]);
        expect(
          yield* f.sql`SELECT operation_id FROM project_team_pi_operation WHERE operation_kind='compact'`,
        ).toEqual([]);
      }),
    ),
  );

it.effect(
  "installs real callbacks without borrowing runtime assets and releases readiness when runtime stops",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const request = compactRequest();
        const pi = yield* makeProjectTeamPiRuntime();
        const read = yield* Deferred.make<void>();
        const observingSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            return statement.compile()[0].includes("SELECT * FROM project_team_compact_caller")
              ? statement.pipe(Effect.tap(() => Deferred.succeed(read, undefined)))
              : statement;
          },
        });
        const runtime = yield* makeProjectTeamRuntime({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 2,
        }).pipe(
          Effect.provideService(ProjectTeamPiRuntime, pi),
          Effect.provideService(SqlClient.SqlClient, observingSql),
        );
        const reserved = yield* pi
          .reserveCompaction(providerInstanceId, request)
          .pipe(Effect.provideService(SqlClient.SqlClient, observingSql));
        expect(reserved.created).toBe(true);
        const input = yield* f.reserveInput();
        yield* f.complete(f.prompt, { ...native, leafId: "runtime-stop-terminal" }, "success", [
          yield* input.settle,
        ]);
        const ready = yield* pi
          .assertCompactionReady(providerInstanceId, request)
          .pipe(Effect.provideService(SqlClient.SqlClient, observingSql), Effect.forkChild);
        yield* Deferred.await(read);
        yield* f.sql`SELECT * FROM project_team_compact_caller`;
        yield* runtime.stop;
        expect((yield* Fiber.await(ready))._tag).toBe("Failure");
        expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
          { status: "released" },
        ]);
        expect(
          (yield* pi
            .reserveCompaction(providerInstanceId, request)
            .pipe(Effect.provideService(SqlClient.SqlClient, observingSql), Effect.result))._tag,
        ).toBe("Failure");
      }).pipe(
        Effect.provide(layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true })),
        Effect.scoped,
      ),
    ),
);

it.effect("failed predecessor releases its pending caller in the terminal commit", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixtureWithAssignment();
      const request = compactRequest();
      yield* f.operations.reserveCompaction(identity, request);
      yield* f.complete(f.prompt, native, "failed");
      expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
        { status: "released" },
      ]);
      expect(
        (yield* f.operations
          .reserveCompaction(identity, compactRequest("after-failure"))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
    }),
  ),
);

it.effect(
  "rejects a replaced predecessor rather than moving a pending caller to the new head",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const request = compactRequest();
        const caller = yield* f.operations.reserveCompaction(identity, request);
        yield* observe(f);
        // Metadata only: an unexpected newer head is sufficient to reject; it supplies no execution proof.
        yield* f.sql`INSERT INTO project_team_pi_operation
    (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
     operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
    SELECT 'unexpected-head',environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,'unexpected-worker',
      operation_ordinal+1,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json
    FROM project_team_pi_operation WHERE operation_id=${caller.predecessorOperationId}`;
        expect(
          (yield* f.operations.assertCompactionReady(identity, request).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          yield* f.sql`SELECT status,predecessor_operation_id FROM project_team_compact_caller`,
        ).toEqual([
          { status: "released", predecessor_operation_id: caller.predecessorOperationId },
        ]);
        expect(
          yield* f.sql`SELECT * FROM project_team_pi_operation WHERE operation_kind='compact'`,
        ).toEqual([]);
      }),
    ),
);

for (const timing of ["after-idle-before-wait", "after-backend-wait"] as const)
  for (const ownerOutcome of ["prepare", "abandon"] as const)
    it.effect(`duplicate cancellation ${timing} preserves creator ${ownerOutcome} ownership`, () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixtureWithAssignment();
          const request = compactRequest();
          const creator = yield* f.operations.reserveCompaction(identity, request);
          expect(creator.created).toBe(true);
          const entered = yield* Deferred.make<void>();
          const releaseRead = yield* Deferred.make<void>();
          let armed = false;
          const observingSql = new Proxy(f.sql, {
            apply(target, _receiver, args) {
              const statement = target(args[0], ...args.slice(1));
              if (
                armed &&
                timing === "after-idle-before-wait" &&
                statement.compile()[0].includes("FROM project_team_review_target t JOIN")
              )
                return statement.pipe(
                  Effect.tap(() =>
                    Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseRead)),
                    ),
                  ),
                );
              return statement;
            },
            get(target, property, receiver) {
              if (property === "withTransaction")
                return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                  Effect.gen(function* () {
                    const nested = Option.isSome(
                      yield* Effect.serviceOption(target.transactionService),
                    );
                    const result = yield* target.withTransaction(effect);
                    if (armed && !nested && timing === "after-backend-wait")
                      yield* Deferred.succeed(entered, undefined);
                    return result;
                  });
              return Reflect.get(target, property, receiver);
            },
          });
          const pi = yield* makeProjectTeamPiRuntime();
          yield* makeProjectTeamRuntime({
            environmentId: "environment",
            maximumEnvironmentModelCalls: 2,
          }).pipe(
            Effect.provideService(ProjectTeamPiRuntime, pi),
            Effect.provideService(SqlClient.SqlClient, observingSql),
          );
          const duplicate = yield* pi
            .reserveCompaction(providerInstanceId, request)
            .pipe(Effect.provideService(SqlClient.SqlClient, observingSql));
          expect(duplicate).toEqual({ ...creator, created: false });
          const input = yield* f.reserveInput();
          yield* f.complete(
            f.prompt,
            { ...native, leafId: "duplicate-idle-predecessor" },
            "success",
            [yield* input.settle],
          );
          const creatorReady = yield* f.operations
            .assertCompactionReady(identity, request)
            .pipe(Effect.forkChild);
          armed = true;
          const duplicateReady = yield* pi
            .assertCompactionReady(providerInstanceId, request)
            .pipe(Effect.provideService(SqlClient.SqlClient, observingSql), Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(duplicateReady);
          expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
            { status: "pending" },
          ]);
          expect(
            yield* f.sql`SELECT operation_id FROM project_team_pi_operation WHERE operation_kind='compact'`,
          ).toEqual([]);
          const observed = yield* f.journal.advanceStage(f.snapshot.fence, {
            receiptId: "duplicate-observed",
            stage: "assignment-observed",
            evidence: { bindingId: f.binding.recordId },
          });
          expect(yield* Fiber.join(creatorReady)).toEqual({ ...creator, created: false });
          expect((yield* f.journal.claimCleanup(observed.fence))._tag).toBe("WaitingForCompact");
          if (ownerOutcome === "abandon") {
            yield* f.operations.abandonCompaction(identity, request);
            expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
              { status: "released" },
            ]);
          } else {
            const boundary = yield* f.operations.readCompaction(identity, {
              ...request,
              kind: "compact",
            });
            const compactRequest = {
              ...request,
              kind: "compact" as const,
              operationId: boundary.operationId,
            };
            const compact = yield* f.operations.prepare(
              identity,
              compactRequest,
              hash(compactRequest),
              {
                allocation: yield* f.allocation,
                workerId: "creator-compact-worker",
                operationId: boundary.operationId,
                resourceHash: "a".repeat(64),
                compactContext: { provenanceSha256: "b".repeat(64), textSha256: "c".repeat(64) },
              },
            );
            expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
              { status: "consumed" },
            ]);
            expect((yield* f.journal.claimCleanup(observed.fence))._tag).toBe("WaitingForCompact");
            const compactInput = yield* f.reserveInput(compact);
            yield* f.complete(
              compact,
              { ...native, leafId: "creator-compact-terminal" },
              "success",
              [yield* compactInput.settle],
            );
          }
          expect((yield* f.journal.claimCleanup(observed.fence))._tag).toBe("Claimed");
        }).pipe(
          Effect.provide(
            layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true }),
          ),
          Effect.scoped,
        ),
      ),
    );

it.effect(
  "two unavailable discovery reads cannot release a duplicate's original creator admission",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const request = compactRequest();
        const creator = yield* f.operations.reserveCompaction(identity, request);
        expect(creator.created).toBe(true);
        let remainingFailures = 0;
        let injected = 0;
        const observingSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            if (
              remainingFailures > 0 &&
              statement
                .compile()[0]
                .includes("SELECT DISTINCT project_id AS projectId FROM project_team_run_binding")
            ) {
              remainingFailures--;
              injected++;
              // Exercise the real driver failure and Authorization discovery error mapping.
              return target`SELECT project_id FROM injected_compact_discovery_unavailable`;
            }
            return statement;
          },
        });
        const pi = yield* makeProjectTeamPiRuntime();
        yield* makeProjectTeamRuntime({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 2,
        }).pipe(
          Effect.provide(Authorization.layer),
          Effect.provideService(ProjectTeamPiRuntime, pi),
          Effect.provideService(SqlClient.SqlClient, observingSql),
        );
        expect(
          yield* pi
            .reserveCompaction(providerInstanceId, request)
            .pipe(Effect.provideService(SqlClient.SqlClient, observingSql)),
        ).toEqual({ ...creator, created: false });
        const input = yield* f.reserveInput();
        yield* f.complete(
          f.prompt,
          { ...native, leafId: "discovery-recovered-predecessor" },
          "success",
          [yield* input.settle],
        );
        const before = {
          callers: yield* f.sql`SELECT * FROM project_team_compact_caller`,
          operations: yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_id`,
          processes: yield* f.sql`SELECT * FROM project_team_pi_process ORDER BY operation_id`,
          charges: yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
          budgets: yield* f.sql`SELECT * FROM project_team_model_budget`,
        };
        remainingFailures = 2;
        expect(
          (yield* pi
            .assertCompactionReady(providerInstanceId, request)
            .pipe(Effect.provideService(SqlClient.SqlClient, observingSql), Effect.result))._tag,
        ).toBe("Failure");
        expect(injected).toBe(2);
        expect(remainingFailures).toBe(0);
        expect({
          callers: yield* f.sql`SELECT * FROM project_team_compact_caller`,
          operations: yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_id`,
          processes: yield* f.sql`SELECT * FROM project_team_pi_process ORDER BY operation_id`,
          charges: yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
          budgets: yield* f.sql`SELECT * FROM project_team_model_budget`,
        }).toEqual(before);
        const ready = yield* pi
          .assertCompactionReady(providerInstanceId, request)
          .pipe(Effect.provideService(SqlClient.SqlClient, observingSql), Effect.forkChild);
        const observed = yield* f.journal.advanceStage(f.snapshot.fence, {
          receiptId: "recovered-discovery-observed",
          stage: "assignment-observed",
          evidence: { bindingId: f.binding.recordId },
        });
        expect(yield* Fiber.join(ready)).toEqual({ ...creator, created: false });
        expect((yield* f.journal.claimCleanup(observed.fence))._tag).toBe("WaitingForCompact");
        const boundary = yield* f.operations.readCompaction(identity, {
          ...request,
          kind: "compact",
        });
        const preparedRequest = {
          ...request,
          kind: "compact" as const,
          operationId: boundary.operationId,
        };
        const compact = yield* f.operations.prepare(
          identity,
          preparedRequest,
          hash(preparedRequest),
          {
            allocation: yield* f.allocation,
            workerId: "discovery-recovered-compact",
            operationId: boundary.operationId,
            resourceHash: "a".repeat(64),
            compactContext: { provenanceSha256: "b".repeat(64), textSha256: "c".repeat(64) },
          },
        );
        expect(compact.deadlineAtMs).toBe(f.prompt.deadlineAtMs);
        expect(compact.maximumTokens).toBe(f.prompt.maximumTokens);
        expect((yield* f.journal.claimCleanup(observed.fence))._tag).toBe("WaitingForCompact");
        const compactInput = yield* f.reserveInput(compact);
        yield* f.complete(
          compact,
          { ...native, leafId: "discovery-recovered-compact-terminal" },
          "success",
          [yield* compactInput.settle],
        );
        expect((yield* f.journal.claimCleanup(observed.fence))._tag).toBe("Claimed");
      }).pipe(
        Effect.provide(layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true })),
        Effect.scoped,
      ),
    ),
);

for (const corruption of [
  "role-status",
  "binding-status",
  "member-status",
  "duplicate-role",
  "duplicate-binding",
  "duplicate-member",
  "foreign-role",
  "foreign-binding",
  "foreign-member",
  "foreign-member-role",
] as const)
  it.effect(`unvalidated ${corruption} cannot invalidate the original compact caller`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const request = compactRequest();
        const creator = yield* f.operations.reserveCompaction(identity, request);
        const pi = yield* makeProjectTeamPiRuntime();
        yield* makeProjectTeamRuntime({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 2,
        }).pipe(Effect.provideService(ProjectTeamPiRuntime, pi));
        expect(yield* pi.reserveCompaction(providerInstanceId, request)).toEqual({
          ...creator,
          created: false,
        });
        const input = yield* f.reserveInput();
        yield* f.complete(
          f.prompt,
          { ...native, leafId: "cached-corruption-predecessor" },
          "success",
          [yield* input.settle],
        );
        const saved = yield* f.sql<{
          state_json: string;
        }>`SELECT state_json FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        const records = (yield* readCurrentState(f.sql, projectId)).foundationRecords ?? [];
        const kind = corruption.includes("binding")
          ? "run-binding"
          : corruption.includes("member")
            ? "member"
            : "role-revision";
        const index = records.findIndex((record) => record.kind === kind);
        expect(index).toBeGreaterThanOrEqual(0);
        const recordPath = `$.foundationRecords[${index}]`;
        if (corruption.startsWith("duplicate-")) {
          const status =
            kind === "run-binding" ? "stopping" : kind === "member" ? "paused" : "retired";
          yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,${recordPath + ".status"},${status}) WHERE project_id=${projectId}`;
          yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_insert(state_json,'$.foundationRecords[#]',json_extract(state_json,${recordPath})) WHERE project_id=${projectId}`;
        } else if (corruption.startsWith("foreign-")) {
          const field = corruption === "foreign-member-role" ? ".roleRevisionId" : ".projectId";
          const status =
            kind === "run-binding" ? "stopping" : kind === "member" ? "paused" : "retired";
          yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,${recordPath + field},'foreign-owner',${recordPath + ".status"},${status}) WHERE project_id=${projectId}`;
        } else
          yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,${recordPath + ".status"},'corrupt-status') WHERE project_id=${projectId}`;
        expect(
          (yield* pi.assertCompactionReady(providerInstanceId, request).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
          { status: "pending" },
        ]);
        expect(
          yield* f.sql`SELECT operation_id FROM project_team_pi_operation WHERE operation_kind='compact'`,
        ).toEqual([]);
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=${saved[0]!.state_json} WHERE project_id=${projectId}`;
        const observed = yield* f.journal.advanceStage(f.snapshot.fence, {
          receiptId: "restored-cache-observed",
          stage: "assignment-observed",
          evidence: { bindingId: f.binding.recordId },
        });
        expect(yield* pi.assertCompactionReady(providerInstanceId, request)).toEqual({
          ...creator,
          created: false,
        });
        expect((yield* f.journal.claimCleanup(observed.fence))._tag).toBe("WaitingForCompact");
        yield* f.operations.abandonCompaction(identity, request);
        expect((yield* f.journal.claimCleanup(observed.fence))._tag).toBe("Claimed");
      }).pipe(
        Effect.provide(layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true })),
        Effect.scoped,
      ),
    ),
  );

for (const kind of ["role-revision", "member"] as const)
  it.effect(`validated ${kind} revocation releases the exact caller`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const request = compactRequest();
        yield* f.operations.reserveCompaction(identity, request);
        const record = (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
          (record) => record.kind === kind,
        );
        if (record?.kind === "role-revision")
          yield* restoreHistoricalBinding({
            ...record,
            status: "retired",
            revision: record.revision + 1,
          });
        else if (record?.kind === "member")
          yield* restoreHistoricalBinding({
            ...record,
            status: "paused",
            revision: record.revision + 1,
          });
        else return yield* Effect.die("Missing revocation control record");
        expect(
          (yield* f.operations.assertCompactionReady(identity, request).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
          { status: "released" },
        ]);
      }),
    ),
  );

const budgetPreflightFixture = Effect.fn("budgetPreflightFixture")(function* () {
  const f = yield* fixtureWithAssignment(undefined, undefined, true);
  const request = {
    threadId,
    requestId: MessageId.make("subscription-preflight"),
    modelSelection: { instanceId: providerInstanceId, model: "gpt-6-luna", options: [] },
  };
  const reservation = yield* f.operations.reserveCompaction(identity, request);
  const snapshot = yield* observe(f);
  const context = yield* makeProjectTeamContext({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 2,
  });
  const required = yield* context.readRequired(snapshot);
  const boundary = yield* f.operations.readCompaction(identity, {
    ...request,
    kind: "compact",
  });
  const supplied = {
    ...request,
    kind: "compact" as const,
    operationId: boundary.operationId,
  };
  const authority = yield* f.operations.current(identity);
  return { f, request, reservation, snapshot, required, supplied, authority };
});

it.effect(
  "subscription compact budget preflight qualifies the admitted predecessor before allocation",
  () =>
    scoped(
      Effect.gen(function* () {
        const { f, reservation, snapshot, required, supplied, authority } =
          yield* budgetPreflightFixture();
        const before = {
          operations: yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_id`,
          processes: yield* f.sql`SELECT * FROM project_team_pi_process ORDER BY operation_id`,
          callers: yield* f.sql`SELECT * FROM project_team_compact_caller`,
          charges: yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
          budgets: yield* f.sql`SELECT * FROM project_team_model_budget`,
        };
        const budget = yield* f.operations.readRootBudget(
          authority,
          { operationId: supplied.operationId, operationKind: "compact" },
          supplied,
          "a".repeat(64),
          {
            provenanceSha256: hash(required.provenance),
            sourceRevision: required.provenance.sourceRevision,
            textSha256: NodeCrypto.createHash("sha256").update(required.text).digest("hex"),
          },
        );
        expect(budget).toEqual({
          rootTaskId: snapshot.intent.limits.rootTaskId,
          maximumTokens: 64000,
          deadlineAtMs: snapshot.intent.limits.rootDeadlineAtMs,
        });
        expect(reservation.deadlineAtMs).toBeLessThanOrEqual(budget.deadlineAtMs);
        expect({
          operations: yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_id`,
          processes: yield* f.sql`SELECT * FROM project_team_pi_process ORDER BY operation_id`,
          callers: yield* f.sql`SELECT * FROM project_team_compact_caller`,
          charges: yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
          budgets: yield* f.sql`SELECT * FROM project_team_model_budget`,
        }).toEqual(before);
      }),
    ),
);

for (const change of [
  "missing-context",
  "tampered-context",
  "stale-context",
  "operation",
  "request",
  "resource",
  "receipt",
  "abandoned",
  "revoked",
  "deadline",
  "root-tokens",
  "root-deadline",
] as const)
  it.effect(
    `subscription compact budget preflight refuses ${change} without allocation or charge`,
    () =>
      scoped(
        Effect.gen(function* () {
          const { f, request, reservation, supplied, authority, required } =
            yield* budgetPreflightFixture();
          const context = {
            provenanceSha256: hash(required.provenance),
            textSha256: NodeCrypto.createHash("sha256").update(required.text).digest("hex"),
            sourceRevision: required.provenance.sourceRevision,
          };
          if (change === "receipt")
            yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=json_set(terminal_json,'$.native.leafId','stale-predecessor-leaf') WHERE operation_id=${reservation.predecessorOperationId}`;
          if (change === "abandoned") yield* f.operations.abandonCompaction(identity, request);
          if (change === "revoked")
            yield* restoreHistoricalBinding({
              ...authority.binding,
              status: "stopping",
              revision: authority.binding.revision + 1,
            });
          if (change === "deadline") yield* TestClock.setTime(reservation.deadlineAtMs);
          if (change === "root-tokens")
            yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=maximum_tokens+1`;
          if (change === "root-deadline")
            yield* f.sql`UPDATE project_team_model_budget SET deadline_at_ms=deadline_at_ms+1`;
          if (change === "stale-context")
            yield* f.commit(
              [
                {
                  kind: "message",
                  projectId,
                  recordId: "changed-budget-context",
                  revision: 0,
                  generation: 0,
                  updatedAt: at,
                  status: "queued",
                  commandId: "changed-budget-context",
                  senderId: "member",
                  recipientId: f.binding.memberId,
                  taskId: f.binding.taskId,
                  body: "New required current communication",
                  evidenceIds: [],
                  deliveryGeneration: 0,
                  deliveryCursor: 0,
                },
              ],
              "changed-budget-context",
            );
          const before = {
            operations: yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_id`,
            processes: yield* f.sql`SELECT * FROM project_team_pi_process ORDER BY operation_id`,
            callers: yield* f.sql`SELECT * FROM project_team_compact_caller`,
            charges: yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
            budgets: yield* f.sql`SELECT * FROM project_team_model_budget`,
          };
          expect(
            (yield* f.operations
              .readRootBudget(
                authority,
                {
                  operationId: change === "operation" ? "foreign-operation" : supplied.operationId,
                  operationKind: "compact",
                },
                change === "request"
                  ? { ...supplied, requestId: MessageId.make("foreign-request") }
                  : supplied,
                (change === "resource" ? "d" : "a").repeat(64),
                change === "missing-context"
                  ? undefined
                  : change === "tampered-context"
                    ? { ...context, provenanceSha256: "invalid" }
                    : context,
              )
              .pipe(Effect.exit))._tag,
          ).toBe("Failure");
          expect({
            operations: yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_id`,
            processes: yield* f.sql`SELECT * FROM project_team_pi_process ORDER BY operation_id`,
            callers: yield* f.sql`SELECT * FROM project_team_compact_caller`,
            charges: yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
            budgets: yield* f.sql`SELECT * FROM project_team_model_budget`,
          }).toEqual(before);
        }),
      ),
  );

const pendingPublicationFixture = Effect.fn("compactTest.pendingPublication")(function* () {
  const f = yield* fixtureWithAssignment();
  const request = compactRequest();
  yield* f.operations.reserveCompaction(identity, request);
  const snapshot = yield* observe(f);
  const boundary = yield* f.operations.readCompaction(identity, { ...request, kind: "compact" });
  const input = { ...request, kind: "compact" as const, operationId: boundary.operationId };
  const compact = yield* f.operations.prepare(identity, input, hash(input), {
    allocation: yield* f.allocation,
    workerId: "publication-compact",
    operationId: boundary.operationId,
    resourceHash: "a".repeat(64),
    compactContext: { provenanceSha256: "b".repeat(64), textSha256: "c".repeat(64) },
  });
  const accounting = yield* f.reserveInput(compact);
  const terminal = yield* f.complete(
    compact,
    { ...native, leafId: "publication-head" },
    "success",
    [yield* accounting.settle],
    false,
  );
  return { ...f, compact, terminal, snapshot, input };
});

for (const order of ["cleanup-first", "publication-first", "interrupted-postcommit"] as const)
  it.effect(`compact first publication serializes ${order} and wakes Host only after commit`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* pendingPublicationFixture();
        const before = yield* f.sql`SELECT * FROM project_team_model_request`;
        const events = yield* PubSub.unbounded<typeof OrchestrationEvent.Type>();
        const waiting = yield* Deferred.make<void>();
        const observingSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            return statement.compile()[0].includes("SELECT operation_id,status,operation_kind")
              ? statement.pipe(Effect.tap(() => Deferred.succeed(waiting, undefined)))
              : statement;
          },
        });
        const committed = yield* Deferred.make<void>();
        const returnCommit = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(returnCommit, undefined));
        const publicationSql = new Proxy(f.sql, {
          get(target, property, receiver) {
            if (property !== "withTransaction") return Reflect.get(target, property, receiver);
            return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.gen(function* () {
                const nested = Option.isSome(
                  yield* Effect.serviceOption(target.transactionService),
                );
                const result = yield* target.withTransaction(effect);
                if (order === "interrupted-postcommit" && !nested) {
                  yield* Deferred.succeed(committed, undefined);
                  yield* Deferred.await(returnCommit);
                }
                return result;
              });
          },
        });
        const publishingOperations = yield* makeProjectTeamPiOperations({
          environmentId: "environment",
        }).pipe(Effect.provideService(SqlClient.SqlClient, publicationSql));
        const publish = publishingOperations
          .publication(f.compact, f.terminal, {
            resourceHash: "a".repeat(64),
            check: () => {},
          })
          .pipe(Effect.provideService(SqlClient.SqlClient, publicationSql));
        if (order === "publication-first") yield* publish;
        const host = yield* waitForProjectTeamRetainedCompaction({
          environmentId: "environment",
          snapshot: f.snapshot,
          assertCurrent: f.journal.inspect(f.snapshot.fence.dispatchId).pipe(
            Effect.asVoid,
            Effect.provideService(SqlClient.SqlClient, f.sql),
            Effect.mapError(
              () => new ProjectTeamDispatchJournalError({ reason: "Current authority failed" }),
            ),
          ),
          claimCleanup: f.journal.claimCleanup(f.snapshot.fence).pipe(
            Effect.provideService(SqlClient.SqlClient, f.sql),
            Effect.mapError(
              () => new ProjectTeamDispatchJournalError({ reason: "Cleanup failed" }),
            ),
            Effect.tap((result) =>
              result._tag === "WaitingForCompact"
                ? Deferred.succeed(waiting, undefined)
                : Effect.void,
            ),
          ),
        }).pipe(
          Effect.provide(
            Layer.merge(
              ProjectWorkEventBusLive,
              Layer.mock(OrchestrationEngineService)({
                subscribeDomainEvents: PubSub.subscribe(events).pipe(
                  Effect.map(Stream.fromSubscription),
                ),
              }),
            ),
          ),
          Effect.provideService(SqlClient.SqlClient, observingSql),
          Effect.forkChild,
        );
        if (order !== "publication-first") {
          yield* Deferred.await(waiting);
          // Read status itself does not claim; this separate durable CAS must also refuse cleanup.
          expect((yield* f.journal.claimCleanup(f.snapshot.fence))._tag).toBe("WaitingForCompact");
          // Host does not call claimCleanup while its durable operation read is running.
          if (order === "interrupted-postcommit") {
            const publication = yield* publish.pipe(Effect.forkChild);
            yield* Deferred.await(committed);
            // The durable write has committed; interruption must not erase its queued wake.
            yield* Effect.sync(() => publication.interruptUnsafe());
            yield* Deferred.succeed(returnCommit, undefined);
            expect((yield* Fiber.await(publication))._tag).toBe("Failure");
          } else yield* publish;
        }
        yield* Fiber.join(host);
        expect(
          yield* f.sql`SELECT status FROM project_team_pi_operation WHERE operation_kind='compact'`,
        ).toEqual([{ status: "settled" }]);
        expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
          { status: "consumed" },
        ]);
        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(before);
        expect(
          (yield* f.operations
            .publication(f.compact, f.terminal, {
              resourceHash: "a".repeat(64),
              check: () => {},
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
  );

for (const mode of [
  "after-write",
  "after-write-expired",
  "owner",
  "caller-fence",
  "revoked",
  "expired",
  "resource",
  "terminal",
  "native",
  "drain",
  "caller",
] as const)
  it.effect(
    `compact publication ${mode} failure retains durable ownership without relaunch or charge`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* pendingPublicationFixture();
          const counts =
            yield* f.sql`SELECT operation_id FROM project_team_pi_operation ORDER BY operation_id`;
          const charges = yield* f.sql`SELECT * FROM project_team_model_request`;
          if (mode === "revoked")
            yield* restoreHistoricalBinding({
              ...f.compact.authority.binding,
              status: "revoked",
              revision: f.compact.authority.binding.revision + 1,
            });
          if (mode === "expired") yield* TestClock.setTime(f.compact.deadlineAtMs);
          if (mode === "native")
            yield* f.sql`UPDATE project_team_pi_operation
        SET native_json=json_set(native_json,'$.leafId','foreign') WHERE operation_id=${f.compact.operation.operationId}`;
          if (mode === "owner")
            yield* f.sql`UPDATE project_team_pi_process
            SET owner_json=json_set(owner_json,'$.pid',999) WHERE operation_id=${f.compact.operation.operationId}`;
          if (mode === "drain")
            yield* f.sql`UPDATE project_team_pi_process SET drain_json=NULL
        WHERE operation_id=${f.compact.operation.operationId}`;
          if (mode === "caller") yield* f.sql`DELETE FROM project_team_compact_caller`;
          let wrote = false;
          const failingSql = new Proxy(f.sql, {
            apply(target, _receiver, args) {
              const statement = target(args[0], ...args.slice(1));
              if (
                mode === "after-write-expired" &&
                statement.compile()[0].includes("SET status='settled'")
              )
                return statement.pipe(Effect.tap(() => TestClock.setTime(f.compact.deadlineAtMs)));
              return mode === "after-write" &&
                statement.compile()[0].includes("SET status='settled'")
                ? statement.pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        wrote = true;
                      }),
                    ),
                    Effect.andThen(
                      Effect.fail(
                        new ProjectTeamDispatchJournalError({ reason: "After publication write" }),
                      ),
                    ),
                  )
                : statement;
            },
          });
          const operations = yield* makeProjectTeamPiOperations({
            environmentId: "environment",
          }).pipe(Effect.provideService(SqlClient.SqlClient, failingSql));
          const result = yield* operations
            .publication(
              f.compact,
              mode === "terminal" ? { ...f.terminal, accountingReceipts: [] } : f.terminal,
              {
                resourceHash: (mode === "resource" ? "f" : "a").repeat(64),
                check: () => {
                  if (mode === "caller-fence") throw Error("Captured owner canceled");
                },
              },
            )
            .pipe(Effect.provideService(SqlClient.SqlClient, failingSql), Effect.result);
          expect(result._tag).toBe("Failure");
          expect(wrote).toBe(mode === "after-write");
          expect(
            yield* f.sql`SELECT status FROM project_team_pi_operation WHERE operation_kind='compact'`,
          ).toEqual([{ status: "running" }]);
          const restarted = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
          expect((yield* restarted.nativeFor(identity).pipe(Effect.result))._tag).toBe("Failure");
          expect(
            (yield* restarted.readCompaction(identity, f.input).pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            (yield* restarted.persistTerminal(f.compact, f.terminal).pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect((yield* restarted.authorize(f.compact).pipe(Effect.result))._tag).toBe("Failure");
          expect(
            yield* f.sql`SELECT operation_id FROM project_team_pi_operation ORDER BY operation_id`,
          ).toEqual(counts);
          expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(charges);
        }),
      ),
  );
