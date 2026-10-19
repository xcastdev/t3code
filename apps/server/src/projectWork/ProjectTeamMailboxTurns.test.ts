import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamMessage,
  ProjectId,
  SkillCatalogRevision,
  OrchestrationEvent,
  CommandId,
  MessageId,
  ProjectWorkTaskId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
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
  createManagedAssignment,
  decodeRecord,
  gatewayRuntime,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectTeamAuthorization, managedActorId } from "./ProjectTeamAuthorization.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
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

import { ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import {
  continueProjectTeamMailboxTurn,
  readProjectTeamOwnedOperationHistory,
} from "./ProjectTeamExecutionHost.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeProjectTeamRuntime } from "./ProjectTeamRuntime.ts";
import { makeProjectTeamContext } from "./ProjectTeamContext.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { layerTest, ServerSettingsService } from "../serverSettings.ts";
import type { PiProductionRuntimeHooks } from "../provider/pi/PiProductionRuntime.ts";

const model = "inclusionai/ling-3.1-flash:free";
const now = Date.parse(at) + 100;
const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const expectCommitFailure = (exit: Exit.Exit<unknown, unknown>) => {
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;
  expect(exit.cause.reasons).toMatchObject([
    {
      _tag: "Die",
      defect: {
        _tag: "SqlError",
        reason: { operation: "execute", cause: { message: "FOREIGN KEY constraint failed" } },
      },
    },
  ]);
};
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const decodeMessage = Schema.decodeUnknownEffect(ProjectTeamMessage);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
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
) {
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
      maxTokens: 20000,
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
        tokenLimit: 20000,
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
  const addMessage = Effect.fn("mailboxTest.addMessage")(function* (
    id: string,
    body = "Review the captured task",
    overrides: Partial<typeof ProjectTeamMessage.Type> = {},
  ) {
    const message = yield* decodeMessage({
      kind: "message",
      projectId,
      recordId: id,
      revision: 0,
      generation: 0,
      updatedAt: at,
      status: "queued",
      commandId: `create:${id}`,
      senderId: "member",
      recipientId: binding.memberId,
      taskId: binding.taskId,
      body,
      evidenceIds: [],
      deliveryGeneration: 0,
      deliveryCursor: 0,
      ...overrides,
    });
    yield* commit([message], `create:${id}`);
    return message;
  });
  const reserveInput = Effect.fn("laterTest.reserveInput")(function* (
    op = prompt,
    usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  ) {
    yield* activate(op, native);
    const accounting = yield* makeAccounting({
      environmentId: "environment",
      routeId: "command-code-ling-free",
      model,
      acceptedReportedModels: [model],
      resolveOperation: operations.resolveOperation,
    });
    const fields = {
      workerId: op.workerId,
      operationId: op.operation.operationId,
      generation: 0,
      requestId: 1,
      routeId: "command-code-ling-free",
      provider: "command-code" as const,
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
    addMessage,
    complete,
    activate,
    commit,
    reserveInput,
    messages,
  };
});
import {
  makeProjectTeamMailboxTurns,
  makeProjectTeamMailboxTurnDecisionReader,
} from "./ProjectTeamMailboxTurns.ts";

export const laterFixture = Effect.gen(function* () {
  const f = yield* fixtureWithAssignment();
  yield* f.complete(f.prompt, { ...native, leafId: "assignment-leaf" });
  const observed = yield* f.journal.advanceStage(f.snapshot.fence, {
    receiptId: "mailbox-observed",
    stage: "assignment-observed",
    evidence: { bindingId: f.binding.recordId },
  });
  const snapshot = yield* f.journal.readRetained(observed.fence.dispatchId);
  const turns = yield* makeProjectTeamMailboxTurns({
    environmentId: "environment",
    lookupInTransaction: f.operations.lookupInTransaction,
  });
  return { ...f, snapshot, turns };
});

it.effect(
  "Host cleanup includes two original operations and 128 later prompts, but rejects excess",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterFixture;
        // Metadata fixtures exercise the production scan against migrated SQLite. They do not
        // establish valid process receipts or stand in for a fully executed mailbox chain.
        yield* f.sql`WITH RECURSIVE later(n) AS (
        SELECT 2 UNION ALL SELECT n+1 FROM later WHERE n<129
      ) INSERT INTO project_team_pi_operation
        (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,
         thread_id,worker_id,operation_ordinal,operation_kind,request_hash,root_binding_id,
         root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
        SELECT 'cleanup-later-'||n,environment_id,project_id,binding_id,generation,
          provider_instance_id,thread_id,'cleanup-worker-'||n,n,'prompt',request_hash,
          root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,'settled',intent_json
        FROM project_team_pi_operation,later WHERE operation_id=${f.prompt.operation.operationId}`;
        const insertOutside = (
          id: string,
          environment: string,
          binding: string,
          generation: number,
        ) =>
          f.sql`INSERT INTO project_team_pi_operation
          (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,
           thread_id,worker_id,operation_ordinal,operation_kind,request_hash,root_binding_id,
           root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
          SELECT ${id},${environment},project_id,${binding},${generation},provider_instance_id,
            ${id},${id},130,'prompt',request_hash,root_binding_id,root_task_id,maximum_tokens,
            deadline_at_ms,'settled',intent_json FROM project_team_pi_operation
          WHERE operation_id=${f.prompt.operation.operationId}`;
        yield* insertOutside("cleanup-other-environment", "other", f.binding.recordId, 0);
        yield* insertOutside("cleanup-other-binding", "environment", "other", 0);
        yield* insertOutside("cleanup-other-generation", "environment", f.binding.recordId, 1);
        const rows = yield* readProjectTeamOwnedOperationHistory(f.sql, "environment", f.snapshot);
        expect(rows).toHaveLength(130);
        expect(rows.at(-1)?.operation_id).toBe("cleanup-later-129");
        expect(rows.every((row) => row.status === "settled")).toBe(true);
        yield* insertOutside("cleanup-excess", "environment", f.binding.recordId, 0);
        const excess = yield* readProjectTeamOwnedOperationHistory(
          f.sql,
          "environment",
          f.snapshot,
        ).pipe(Effect.result);
        expect(excess._tag).toBe("Failure");
        if (excess._tag === "Failure") {
          expect(excess.failure).toBeInstanceOf(ProjectTeamDispatchJournalError);
          expect(excess.failure).toMatchObject({
            reason: "Owned operation history exceeds its cleanup bound",
          });
        }
      }),
    ),
);
it.effect(
  "successive qualified boundaries deliver two queued messages with the original budget and latest cursor",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterFixture;
        yield* f.addMessage("first-successive", "First queued message");
        yield* f.addMessage("second-successive", "Second queued message");
        const first = yield* f.turns.claim(f.snapshot);
        if (first._tag !== "Selected") return yield* Effect.die("Expected first selected turn");
        const firstRequest = first.decision.request;
        const firstOperation = yield* f.operations.prepare(
          { providerInstanceId, threadId },
          firstRequest,
          hash(firstRequest),
          {
            allocation: yield* f.allocation,
            workerId: "first-successive-worker",
            operationId: firstRequest.operationId,
            resourceHash: first.decision.resourceHash,
          },
        );
        yield* f.turns.seal({
          operationId: firstRequest.operationId,
          baseSystemText: "First required context",
        });
        const firstInput = yield* f.reserveInput(firstOperation);
        yield* f.turns.bindInput({
          operationId: firstRequest.operationId,
          reservationId: firstInput.reservationId,
          encodedRequestSha256: "a".repeat(64),
        });
        const firstCursor = { ...native, leafId: "first-successive-leaf" };
        yield* f.complete(firstOperation, firstCursor, "success", [yield* firstInput.settle]);
        expect((yield* f.turns.reflect({ operationId: firstRequest.operationId }))._tag).toBe(
          "Delivered",
        );
        const second = yield* f.turns.claim(f.snapshot, {
          afterOperationId: firstRequest.operationId,
        });
        expect(second._tag).toBe("Selected");
        if (second._tag !== "Selected") return yield* Effect.die("Expected second selected turn");
        expect(second.decision.message.recordId).toBe("second-successive");
        expect(second.decision.request.operationId).not.toBe(firstRequest.operationId);
        expect(second.decision.commandId).not.toBe(first.decision.commandId);
        expect(second.decision.request.resumeCursor).toEqual(firstCursor);
        expect(second.decision.rootBudget).toEqual(first.decision.rootBudget);
        expect(second.decision.attemptLimits).toEqual(first.decision.attemptLimits);
        const secondRequest = second.decision.request;
        const secondOperation = yield* f.operations.prepare(
          { providerInstanceId, threadId },
          secondRequest,
          hash(secondRequest),
          {
            allocation: yield* f.allocation,
            workerId: "second-successive-worker",
            operationId: secondRequest.operationId,
            resourceHash: second.decision.resourceHash,
          },
        );
        expect(secondOperation.ordinal).toBe(firstOperation.ordinal + 1);
        expect(secondOperation.maximumTokens).toBe(firstOperation.maximumTokens);
        expect(secondOperation.deadlineAtMs).toBe(firstOperation.deadlineAtMs);
        expect(
          (yield* f.operations
            .lookup(
              { providerInstanceId, threadId },
              firstRequest,
              hash(firstRequest),
              first.decision.resourceHash,
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* f.turns.reflect({ operationId: firstRequest.operationId }))._tag).toBe(
          "Retained",
        );
        const restarted = yield* makeProjectTeamMailboxTurns({
          environmentId: "environment",
          lookupInTransaction: f.operations.lookupInTransaction,
        });
        expect(
          (yield* restarted.claim(f.snapshot, { afterOperationId: firstRequest.operationId }))
            .decision,
        ).toEqual(second.decision);
        yield* f.turns.seal({
          operationId: secondRequest.operationId,
          baseSystemText: "Second required context",
        });
        const secondInput = yield* f.reserveInput(secondOperation);
        yield* f.turns.bindInput({
          operationId: secondRequest.operationId,
          reservationId: secondInput.reservationId,
          encodedRequestSha256: "b".repeat(64),
        });
        yield* f.complete(
          secondOperation,
          { ...native, leafId: "second-successive-leaf" },
          "success",
          [yield* secondInput.settle],
        );
        expect((yield* f.turns.reflect({ operationId: secondRequest.operationId }))._tag).toBe(
          "Delivered",
        );
        expect((yield* f.messages).map((message) => [message.recordId, message.status])).toEqual([
          ["first-successive", "delivered"],
          ["second-successive", "delivered"],
        ]);
        const end = yield* f.turns.claim(f.snapshot, {
          afterOperationId: secondRequest.operationId,
        });
        expect(end._tag).toBe("None");
        yield* f.addMessage("late-successive", "Arrived after the final empty decision");
        expect(
          yield* f.turns.claim(f.snapshot, { afterOperationId: secondRequest.operationId }),
        ).toEqual(end);
        expect(
          (yield* f.messages).find((message) => message.recordId === "late-successive")?.status,
        ).toBe("queued");
      }),
    ),
);
it.effect("freezes an empty first successful boundary and never absorbs a late message", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* laterFixture;
      const first = yield* f.turns.claim(f.snapshot);
      expect(first._tag).toBe("None");
      yield* f.addMessage("late", "Arrived after the empty boundary");
      const restarted = yield* makeProjectTeamMailboxTurns({
        environmentId: "environment",
        lookupInTransaction: f.operations.lookupInTransaction,
      });
      expect(yield* restarted.claim(f.snapshot)).toEqual(first);
      expect((yield* f.messages).map((m) => m.status)).toEqual(["queued"]);
    }),
  ),
);

it.effect(
  "selects exactly one queued message and restart retains the original prompt instead of newer mail",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterFixture;
        yield* f.addMessage("first", "Check the exact approved criterion");
        yield* f.addMessage("second", "Do not absorb this message");
        const selected = yield* f.turns.claim(f.snapshot);
        expect(selected._tag).toBe("Selected");
        if (selected._tag !== "Selected") return yield* Effect.die("Expected selected message");
        expect(selected.decision.message.recordId).toBe("first");
        expect(selected.decision.target.deliveryCursor).toBe(1);
        expect(selected.decision.request.resumeCursor).toEqual({
          ...native,
          leafId: "assignment-leaf",
        });
        expect(selected.decision.request.prompt).toContain("Check the exact approved criterion");
        expect(selected.decision.request.prompt).not.toContain("Do not absorb this message");
        yield* f.addMessage("earlier-sorting-late", "Do not silently retarget");
        const restarted = yield* makeProjectTeamMailboxTurns({
          environmentId: "environment",
          lookupInTransaction: f.operations.lookupInTransaction,
        });
        expect(yield* restarted.claim(f.snapshot)).toEqual(selected);
        expect((yield* f.messages).every((message) => message.status === "queued")).toBe(true);
      }),
    ),
);

it.effect("admits only the retained later prompt with the original root and attempt budget", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* laterFixture;
      yield* f.addMessage("next", "Read the unchanged approved scope");
      const selected = yield* f.turns.claim(f.snapshot);
      if (selected._tag !== "Selected") return yield* Effect.die("Expected selected message");
      const request = selected.decision.request;
      const identity = { providerInstanceId, threadId };
      const prepare = Effect.fn("laterTest.prepare")(function* (changed: typeof request) {
        return yield* f.operations.prepare(identity, changed, hash(changed), {
          allocation: yield* f.allocation,
          workerId: "later-worker",
          operationId: request.operationId,
          resourceHash: selected.decision.resourceHash,
        });
      });
      expect(
        (yield* prepare({
          ...request,
          prompt: "Foreign request with otherwise correct identity",
        }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      const later = yield* prepare(request);
      expect(later.operation.operationId).toBe(request.operationId);
      expect(later.ordinal).toBeGreaterThan(f.prompt.ordinal);
      expect(later.deadlineAtMs).toBe(f.prompt.deadlineAtMs);
      expect(later.maximumTokens).toBe(f.prompt.maximumTokens);
      expect((yield* prepare(request).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* f.messages)[0]?.status).toBe("queued");
    }),
  ),
);

it.effect(
  "returns required original context only for the exact current selected later request",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterFixture;
        yield* f.addMessage("next", "Preserve this recipient and scope");
        const selected = yield* f.turns.claim(f.snapshot);
        if (selected._tag !== "Selected") return yield* Effect.die("Expected selected message");
        const input = {
          projectId,
          bindingId: f.binding.recordId,
          generation: f.binding.generation,
          providerInstanceId,
          request: selected.decision.request,
        };
        const read = yield* f.turns.readForOperation(input);
        expect(read._tag).toBe("LaterTurn");
        if (read._tag !== "LaterTurn") return yield* Effect.die("Expected later context");
        expect(read.original).toEqual(f.snapshot);
        expect(read.decision.request).toEqual(selected.decision.request);
        for (const changed of [
          { ...input, request: { ...input.request, prompt: "Changed body" } },
          { ...input, generation: 1 },
          { ...input, projectId: ProjectId.make("foreign-project") },
        ])
          expect((yield* f.turns.readForOperation(changed).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
        const member = (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
          (r) => r.kind === "member" && r.recordId === selected.decision.message.senderId,
        );
        if (member?.kind !== "member") return yield* Effect.die("Missing sender");
        yield* f.commit(
          [{ ...member, revision: member.revision + 1, status: "paused" }],
          "remove-sender",
        );
        expect((yield* f.turns.readForOperation(input).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* f.messages)[0]?.status).toBe("queued");
      }),
    ),
);

it.effect("seals a separate later context and binds only the actual owned model reservation", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* laterFixture;
      yield* f.addMessage("next", "Exact later message body");
      const selected = yield* f.turns.claim(f.snapshot);
      if (selected._tag !== "Selected") return yield* Effect.die("Expected selected message");
      const request = selected.decision.request;
      const later = yield* f.operations.prepare(
        { providerInstanceId, threadId },
        request,
        hash(request),
        {
          allocation: yield* f.allocation,
          workerId: "later-worker",
          operationId: request.operationId,
          resourceHash: selected.decision.resourceHash,
        },
      );
      const seal = yield* f.turns.seal({
        operationId: request.operationId,
        baseSystemText: "Current required scope",
      });
      expect(seal.systemText).toContain("Current required scope");
      expect(seal.systemText).toContain("Exact later message body");
      expect(seal.systemText).not.toContain(f.request.assignment);
      expect(
        yield* f.turns.seal({
          operationId: request.operationId,
          baseSystemText: "Current required scope",
        }),
      ).toEqual(seal);
      expect(
        (yield* f.turns
          .seal({ operationId: request.operationId, baseSystemText: "Changed required scope" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const input = yield* f.reserveInput(later);
      expect(
        (yield* f.turns
          .bindInput({
            operationId: request.operationId,
            reservationId: "foreign-reservation",
            encodedRequestSha256: "b".repeat(64),
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const bound = yield* f.turns.bindInput({
        operationId: request.operationId,
        reservationId: input.reservationId,
        encodedRequestSha256: "b".repeat(64),
      });
      expect(bound.reservationId).toBe(input.reservationId);
      expect(bound.systemTextSha256).toBe(seal.systemTextSha256);
      expect(
        (yield* f.turns
          .bindInput({
            operationId: request.operationId,
            reservationId: input.reservationId,
            encodedRequestSha256: "c".repeat(64),
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* f.messages)[0]?.status).toBe("queued");
    }),
  ),
);

it.effect("reflects only a drained accounted later prompt and replays the committed delivery", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* laterFixture;
      yield* f.addMessage("next", "Consume exactly once");
      const selected = yield* f.turns.claim(f.snapshot);
      if (selected._tag !== "Selected") return yield* Effect.die("Expected selected message");
      const request = selected.decision.request;
      const later = yield* f.operations.prepare(
        { providerInstanceId, threadId },
        request,
        hash(request),
        {
          allocation: yield* f.allocation,
          workerId: "later-worker",
          operationId: request.operationId,
          resourceHash: selected.decision.resourceHash,
        },
      );
      yield* f.turns.seal({
        operationId: request.operationId,
        baseSystemText: "Original required scope",
      });
      const input = yield* f.reserveInput(later);
      yield* f.turns.bindInput({
        operationId: request.operationId,
        reservationId: input.reservationId,
        encodedRequestSha256: "b".repeat(64),
      });
      expect((yield* f.turns.reflect({ operationId: request.operationId }))._tag).toBe("Pending");
      expect((yield* f.messages)[0]?.status).toBe("queued");
      yield* f.complete(later, native, "success", [yield* input.settle]);
      const delivered = yield* f.turns.reflect({ operationId: request.operationId });
      expect(delivered._tag).toBe("Delivered");
      expect((yield* f.messages)[0]).toMatchObject({
        status: "delivered",
        revision: 1,
        deliveryCursor: 1,
      });
      const state = yield* readCurrentState(f.sql, projectId);
      const restarted = yield* makeProjectTeamMailboxTurns({
        environmentId: "environment",
        lookupInTransaction: f.operations.lookupInTransaction,
      });
      const replay = yield* restarted.reflect({ operationId: request.operationId });
      expect(replay._tag).toBe("Retained");
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(state);
      expect((yield* restarted.claim(f.snapshot))._tag).toBe("Retained");
      expect(state.tasks.find((t) => t.taskId === f.binding.taskId)?.state).toBe("in-progress");
    }),
  ),
);

it.effect(
  "delivers an authenticated produced message in a later safe turn and retains exact send retries",
  () =>
    Effect.gen(function* () {
      const f = yield* laterFixture;
      const before = yield* readCurrentState(f.sql, projectId);
      expect(
        before.foundationRecords?.find((r) => r.recordId === f.binding.recordId),
      ).toMatchObject({ status: "running", sessionId: native.sessionId });
      const originalRole = before.foundationRecords?.find(
        (r) => r.kind === "role-revision" && r.recordId === f.binding.roleRevisionId,
      );
      if (originalRole?.kind !== "role-revision")
        return yield* Effect.die("Missing original readonly recipient role");
      const role = decodeRecord({
        ...originalRole,
        recordId: "later-sender-role",
        roleId: "later-sender-role",
        role: "implementer",
        roleRevision: originalRole.roleRevision + 1,
        revision: 0,
        tools: ["project-work.write"],
      });
      if (role.kind !== "role-revision")
        return yield* Effect.die("Invalid separately configured later sender role");
      yield* f.commit(
        [
          { ...originalRole, revision: originalRole.revision + 1 },
          role,
          decodeRecord({
            kind: "member",
            projectId,
            recordId: "later-sender",
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "active",
            name: "Actual later sender",
            coordinator: false,
            roleRevisionId: role.recordId,
          }),
        ],
        "later-sender-configuration",
      );
      const sender = yield* createManagedAssignment({
        taskId: ProjectWorkTaskId.make("later-sender-task"),
        recordId: "later-sender-binding",
        attemptId: "later-sender-attempt",
        commandId: "later-sender-claim",
        providerInstanceId,
        threadId: ThreadId.make("later-sender-thread"),
        role,
        memberId: "later-sender",
        status: "running",
        sessionId: "later-sender-session",
        configuration: { ...f.binding.configuration, toolIds: ["project-work.write"] },
      });
      const assigned = yield* readCurrentState(f.sql, projectId);
      const memberships =
        assigned.foundationRecords?.filter(
          (r) =>
            r.kind === "task-membership" &&
            (r.taskId === sender.taskId || r.taskId === f.binding.taskId),
        ) ?? [];
      expect(memberships).toHaveLength(2);
      yield* f.repository.execute(
        decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "later-produced-mission",
          expectedRevision: assigned.revision,
          attribution: {
            actor: { kind: "human", id: "mailbox-human" },
            source: { kind: "web", id: "mailbox-browser" },
            recordedAt: at,
          },
          committedAt: at,
          records: [
            {
              kind: "mission",
              projectId,
              recordId: "later-produced-mission",
              revision: 0,
              generation: 0,
              updatedAt: at,
              status: "active",
              title: "Safe mailbox coordination",
              objective: "Inform the existing running teammate",
              requiredTaskIds: [sender.taskId, f.binding.taskId],
            },
            ...memberships.map((r) => ({
              ...r,
              revision: r.revision + 1,
              missionId: "later-produced-mission",
            })),
          ],
        }),
      );
      const auth = yield* ProjectTeamAuthorization;
      const issued = yield* auth.issueCredential({
        providerInstanceId,
        threadId: sender.threadId,
        bindingId: sender.recordId,
      });
      if (!issued) return yield* Effect.die("Missing later-message sender credential");
      const principal = {
        actor: { kind: "agent" as const, id: managedActorId(issued.credential) },
        managed: issued.credential,
      };
      const state = yield* readCurrentState(f.sql, projectId);
      const task = state.tasks.find((t) => t.taskId === sender.taskId)!;
      const membership = state.foundationRecords?.find(
        (r) => r.kind === "task-membership" && r.taskId === f.binding.taskId,
      );
      if (membership?.kind !== "task-membership")
        return yield* Effect.die("Missing actual later recipient membership");
      const intent = {
        type: "project-team.message.send" as const,
        commandId: CommandId.make("later-produced-message"),
        projectId,
        taskId: sender.taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: task.revision,
        specRevision: task.specRevision,
        planRevision: sender.planRevision,
        messageId: "later-produced-message",
        recipientId: f.binding.memberId,
        recipientTaskId: f.binding.taskId,
        expectedRecipientMembershipRevision: membership.revision,
        body: "Actual authenticated later findings",
        evidenceIds: [],
      };
      const gateway = yield* ProjectWorkGateway;
      const source = { kind: "mcp" as const, id: "produced-later-tool" };
      const receipt = yield* gateway.write(intent, principal.actor, source, principal);
      const selected = yield* f.turns.claim(f.snapshot);
      if (selected._tag !== "Selected")
        return yield* Effect.die("Expected actual produced message selection");
      const request = selected.decision.request;
      expect(request.prompt).toContain(intent.body);
      const later = yield* f.operations.prepare(
        { providerInstanceId, threadId },
        request,
        hash(request),
        {
          allocation: yield* f.allocation,
          workerId: "produced-later-worker",
          operationId: request.operationId,
          resourceHash: selected.decision.resourceHash,
        },
      );
      const sealed = yield* f.turns.seal({
        operationId: request.operationId,
        baseSystemText: "Original required scope",
      });
      expect(sealed.systemText).toContain(intent.body);
      const input = yield* f.reserveInput(later);
      yield* f.turns.bindInput({
        operationId: request.operationId,
        reservationId: input.reservationId,
        encodedRequestSha256: "b".repeat(64),
      });
      expect((yield* f.turns.reflect({ operationId: request.operationId }))._tag).toBe("Pending");
      yield* f.complete(later, { ...native, leafId: "produced-later-leaf" }, "success", [
        yield* input.settle,
      ]);
      expect((yield* f.turns.reflect({ operationId: request.operationId }))._tag).toBe("Delivered");
      expect((yield* f.messages)[0]).toMatchObject({
        status: "delivered",
        revision: 1,
        deliveryCursor: 1,
        senderId: sender.memberId,
        taskId: f.binding.taskId,
      });
      const delivered = yield* readCurrentState(f.sql, projectId);
      expect(yield* gateway.write(intent, principal.actor, source, principal)).toEqual(receipt);
      const restarted = yield* makeProjectTeamMailboxTurns({
        environmentId: "environment",
        lookupInTransaction: f.operations.lookupInTransaction,
      });
      expect((yield* restarted.reflect({ operationId: request.operationId }))._tag).toBe(
        "Retained",
      );
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(delivered);
      expect(originalRole.tools).toEqual([]);
      expect(f.binding.configuration.toolIds).toEqual([]);
    }).pipe(Effect.provide(ProjectWorkProjectionLive.pipe(Layer.provideMerge(gatewayRuntime)))),
);

const laterExecutionFixtureFor = (
  usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
) =>
  Effect.gen(function* () {
    const f = yield* laterFixture;
    yield* f.addMessage("next", "Exactly retained later input");
    const selected = yield* f.turns.claim(f.snapshot);
    if (selected._tag !== "Selected") return yield* Effect.die("Expected selected message");
    const request = selected.decision.request;
    const later = yield* f.operations.prepare(
      { providerInstanceId, threadId },
      request,
      hash(request),
      {
        allocation: yield* f.allocation,
        workerId: "later-worker",
        operationId: request.operationId,
        resourceHash: selected.decision.resourceHash,
      },
    );
    const seal = yield* f.turns.seal({
      operationId: request.operationId,
      baseSystemText: "Current required context",
    });
    const input = yield* f.reserveInput(later, usage);
    yield* f.turns.bindInput({
      operationId: request.operationId,
      reservationId: input.reservationId,
      encodedRequestSha256: "b".repeat(64),
    });
    return { ...f, later, seal, input, decision: selected.decision };
  });

export const laterExecutionFixture = laterExecutionFixtureFor();

it.effect(
  "retains uncertainty without replacement and permits revoked-owner cleanup without delivering",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterExecutionFixture;
        yield* f.complete(f.later, native, "failed", [yield* f.input.settle]);
        expect((yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag).toBe(
          "Uncertain",
        );
        expect((yield* f.messages)[0]).toMatchObject({ status: "uncertain", deliveryCursor: 1 });
        expect((yield* f.turns.claim(f.snapshot))._tag).toBe("Uncertain");
        const state = yield* readCurrentState(f.sql, projectId);
        const member = state.foundationRecords?.find(
          (r) => r.kind === "member" && r.recordId === f.binding.memberId,
        );
        if (member?.kind !== "member") return yield* Effect.die("Missing member");
        yield* f.commit(
          [{ ...member, revision: member.revision + 1, status: "paused" }],
          "pause-owner",
        );
        expect((yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag).toBe(
          "Uncertain",
        );
        expect((yield* f.messages)[0]?.status).toBe("uncertain");
      }),
    ),
);

it.effect(
  "successful transport with a revoked recipient stays queued and storage failures propagate",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterExecutionFixture;
        yield* f.complete(f.later, native, "success", [yield* f.input.settle]);
        const state = yield* readCurrentState(f.sql, projectId);
        const member = state.foundationRecords?.find(
          (r) => r.kind === "member" && r.recordId === f.binding.memberId,
        );
        if (member?.kind !== "member") return yield* Effect.die("Missing member");
        yield* f.commit(
          [{ ...member, revision: member.revision + 1, status: "paused" }],
          "pause-owner",
        );
        expect((yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag).toBe(
          "Uncertain",
        );
        expect((yield* f.messages)[0]?.status).toBe("queued");
        yield* f.sql`ALTER TABLE project_team_mailbox_reflection RENAME TO unavailable_mailbox_reflection`;
        expect(
          (yield* f.turns
            .reflect({ operationId: f.decision.request.operationId })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect(
  "failed owning COMMIT and ignored message or batch writes expose no later delivery; exact retry works",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterExecutionFixture;
        yield* f.complete(f.later, native, "success", [yield* f.input.settle]);
        const before = yield* readCurrentState(f.sql, projectId);
        for (const table of ["project_team_message", "project_team_mailbox_batch"]) {
          yield* f.sql`CREATE TRIGGER ignored_turn_write BEFORE UPDATE ON ${f.sql(table)} BEGIN SELECT RAISE(IGNORE); END`;
          expect(
            (yield* f.turns
              .reflect({ operationId: f.decision.request.operationId })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure");
          expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
          yield* f.sql`DROP TRIGGER ignored_turn_write`;
        }
        yield* f.sql`PRAGMA foreign_keys=ON`;
        yield* f.sql`CREATE TABLE turn_commit_parent(id TEXT PRIMARY KEY)`;
        yield* f.sql`CREATE TABLE turn_commit_child(id TEXT REFERENCES turn_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* f.sql`CREATE TRIGGER fail_turn_commit AFTER UPDATE ON project_team_mailbox_batch WHEN NEW.status='delivered' BEGIN INSERT INTO turn_commit_child VALUES('missing'); END`;
        let escaped = false;
        expectCommitFailure(
          yield* f.turns.reflect({ operationId: f.decision.request.operationId }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                escaped = true;
              }),
            ),
            Effect.exit,
          ),
        );
        expect(escaped).toBe(false);
        expect(
          (yield* f.turns
            .reflect({ operationId: f.decision.request.operationId })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect((yield* f.turns.claim(f.snapshot)).decision).toEqual(f.decision);
        expect(yield* f.sql.withTransaction(readCurrentState(f.sql, projectId))).toEqual(before);
        expect(yield* f.sql`SELECT * FROM turn_commit_child`).toEqual([]);
        yield* f.sql`DROP TRIGGER fail_turn_commit`;
        expect((yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag).toBe(
          "Delivered",
        );
        const delivered = yield* readCurrentState(f.sql, projectId);
        expect((yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag).toBe(
          "Retained",
        );
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(delivered);
      }),
    ),
);

it.effect(
  "resolves stable managed compaction at an accounted assignment boundary without renewing limits",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const input = yield* f.reserveInput();
        const accountingReceipt = yield* input.settle;
        const terminal = yield* f.complete(
          f.prompt,
          { ...native, leafId: "compact-assignment-leaf" },
          "success",
          [accountingReceipt],
        );
        expect(terminal.outcome).toBe("success");
        expect(terminal.accountingReceipts).toEqual([accountingReceipt]);
        expect(terminal.drain?.kernel).toBe("populated 0\nfrozen 0");
        const observed = yield* f.journal.advanceStage(f.snapshot.fence, {
          receiptId: "compact-assignment-observed",
          stage: "assignment-observed",
          evidence: { bindingId: f.binding.recordId },
        });
        const original = yield* f.journal.readRetained(observed.fence.dispatchId);
        expect(original.fence.stage).toBe("assignment-observed");
        const retainedNative = yield* f.operations.nativeFor({ providerInstanceId, threadId });
        expect(retainedNative.operationId).toBe(f.prompt.operation.operationId);
        expect(retainedNative.native).toEqual(terminal.native);
        const budgets = yield* f.sql`SELECT maximum_tokens, deadline_at_ms
          FROM project_team_model_budget WHERE project_id=${projectId}`;
        const operationRows =
          yield* f.sql`SELECT operation_id, maximum_tokens, deadline_at_ms, status
          FROM project_team_pi_operation WHERE project_id=${projectId} ORDER BY operation_ordinal`;
        let resolve: NonNullable<PiProductionRuntimeHooks["resolveOperationId"]> | undefined;
        const pi = Layer.mock(ProjectTeamPiRuntime)({
          installOperationResolver: (callback) =>
            Effect.sync(() => {
              resolve = callback;
            }),
        });
        const runtime = yield* makeProjectTeamRuntime({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 2,
        }).pipe(Effect.provide(pi));
        if (!resolve) return yield* Effect.die("Resolver was not installed");
        const compactRequest = {
          threadId,
          kind: "compact" as const,
          requestId: MessageId.make("managed-compact-one"),
          modelSelection: { instanceId: providerInstanceId, model, options: [] },
        };
        const operationId = yield* resolve(providerInstanceId, compactRequest);
        expect(typeof operationId).toBe("string");
        expect(operationId).not.toBe(f.prompt.operation.operationId);
        expect(yield* resolve(providerInstanceId, compactRequest)).toBe(operationId);
        yield* runtime.stop;
        yield* makeProjectTeamRuntime({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 2,
        }).pipe(Effect.provide(pi));
        if (!resolve) return yield* Effect.die("Restarted resolver was not installed");
        expect(yield* resolve(providerInstanceId, compactRequest)).toBe(operationId);
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({ projectTeamExecutionEnabled: false });
        expect((yield* resolve(providerInstanceId, compactRequest).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          yield* f.sql`SELECT maximum_tokens, deadline_at_ms
          FROM project_team_model_budget WHERE project_id=${projectId}`,
        ).toEqual(budgets);
        expect(
          yield* f.sql`SELECT operation_id, maximum_tokens, deadline_at_ms, status
          FROM project_team_pi_operation WHERE project_id=${projectId} ORDER BY operation_ordinal`,
        ).toEqual(operationRows);
        expect((yield* f.journal.readRetained(original.fence.dispatchId)).intent.limits).toEqual(
          original.intent.limits,
        );
      }).pipe(
        Effect.provide(layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true })),
        Effect.scoped,
      ),
    ),
);

it.effect(
  "accounted compact receipts preserve cumulative limits and resume a new mailbox decision at the compact native anchor",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        const originalInput = yield* f.reserveInput();
        yield* f.complete(f.prompt, { ...native, leafId: "compact-original" }, "success", [
          yield* originalInput.settle,
        ]);
        const observed = yield* f.journal.advanceStage(f.snapshot.fence, {
          receiptId: "compact-original-observed",
          stage: "assignment-observed",
          evidence: { bindingId: f.binding.recordId },
        });
        const original = yield* f.journal.readRetained(observed.fence.dispatchId);
        const context = yield* makeProjectTeamContext({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 2,
        });
        const budget =
          yield* f.sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget WHERE project_id=${projectId}`;
        let latest = { ...native, leafId: "compact-original" };
        let finalOperationId = "";
        let firstCompact:
          | { request: Parameters<typeof f.operations.lookup>[1]; terminal: PiSessionTerminal }
          | undefined;
        for (const index of [1, 2]) {
          const current = yield* context.readRequired(original);
          const supplied = {
            threadId,
            kind: "compact" as const,
            requestId: MessageId.make(`sql-compact-${index}`),
            modelSelection: { instanceId: providerInstanceId, model, options: [] },
          };
          const boundary = yield* f.operations.readCompaction(
            { providerInstanceId, threadId },
            supplied,
          );
          const request = { ...supplied, operationId: boundary.operationId };
          const rowsBefore = yield* f.sql`SELECT operation_id FROM project_team_pi_operation`;
          expect(
            (yield* f.operations
              .prepare({ providerInstanceId, threadId }, request, hash(request), {
                allocation: yield* f.allocation,
                workerId: `compact-no-context-${index}`,
                operationId: request.operationId,
                resourceHash: "a".repeat(64),
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual(
            rowsBefore,
          );
          const compact = yield* f.operations.prepare(
            { providerInstanceId, threadId },
            request,
            hash(request),
            {
              allocation: yield* f.allocation,
              workerId: `compact-worker-${index}`,
              operationId: request.operationId,
              resourceHash: "a".repeat(64),
              compactContext: {
                provenanceSha256: hash(current.provenance),
                textSha256: NodeCrypto.createHash("sha256").update(current.text).digest("hex"),
              },
            },
          );
          expect(compact.maximumTokens).toBe(f.prompt.maximumTokens);
          expect(compact.deadlineAtMs).toBe(f.prompt.deadlineAtMs);
          const intentRows = yield* f.sql<{
            intent_json: string;
          }>`SELECT intent_json FROM project_team_pi_operation WHERE operation_id=${request.operationId}`;
          expect(intentRows[0]?.intent_json).toContain(hash(current.provenance));
          const allocated =
            yield* f.sql`SELECT operation_id,status FROM project_team_pi_operation ORDER BY operation_ordinal`;
          expect(
            (yield* f.operations
              .readCompaction(
                { providerInstanceId, threadId },
                {
                  ...supplied,
                  requestId: MessageId.make(`compact-while-prepared-${index}`),
                },
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            yield* f.sql`SELECT operation_id,status FROM project_team_pi_operation ORDER BY operation_ordinal`,
          ).toEqual(allocated);
          const input = yield* f.reserveInput(compact);
          latest = { ...native, leafId: `compact-leaf-${index}` };
          const terminal = yield* f.complete(compact, latest, "success", [yield* input.settle]);
          if (index === 1) firstCompact = { request, terminal };
          const replay = yield* f.operations.lookup(
            { providerInstanceId, threadId },
            request,
            hash(request),
            "a".repeat(64),
          );
          expect(replay?.terminal).toEqual(terminal);
          const recreated = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
          expect(
            (yield* recreated.readCompaction({ providerInstanceId, threadId }, supplied))
              .operationId,
          ).toBe(request.operationId);
          expect(
            (yield* recreated.lookup(
              { providerInstanceId, threadId },
              request,
              hash(request),
              "a".repeat(64),
            ))?.terminal,
          ).toEqual(terminal);
          expect(
            yield* f.sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget WHERE project_id=${projectId}`,
          ).toEqual(budget);
          finalOperationId = request.operationId;
        }
        if (!firstCompact) return yield* Effect.die("Missing original compact receipt");
        const retainedRequest = firstCompact.request;
        const retainedTerminal = firstCompact.terminal;
        const oldBoundary = yield* f.operations.readCompaction(
          { providerInstanceId, threadId },
          retainedRequest,
        );
        expect(oldBoundary.operationId).toBe(retainedRequest.operationId);
        const oldReplay = yield* f.operations.lookup(
          { providerInstanceId, threadId },
          retainedRequest,
          hash(retainedRequest),
          "a".repeat(64),
        );
        expect(oldReplay?.terminal).toEqual(retainedTerminal);
        expect(oldReplay?.replayHead?.operation.operationId).toBe(finalOperationId);
        expect(oldReplay?.replayHead?.native).toEqual(latest);
        const consumed = yield* f.sql<{
          tokens: number;
        }>`SELECT SUM(charged_input_tokens+charged_output_tokens) AS tokens
      FROM project_team_model_request WHERE project_id=${projectId} AND status='reported'`;
        expect(consumed[0]?.tokens).toBe(36);
        yield* f.addMessage("after-compact", "Continue only within the original task");
        const turns = yield* makeProjectTeamMailboxTurns({
          environmentId: "environment",
          lookupInTransaction: f.operations.lookupInTransaction,
        });
        const selected = yield* turns.claim(original);
        if (selected._tag !== "Selected")
          return yield* Effect.die("Expected a newly selected mailbox message");
        expect(selected.decision.request.resumeCursor).toEqual(latest);
        expect(selected.decision.compactAnchor?.operationId).toBe(finalOperationId);
        expect(selected.decision.originalAssignmentOperationId).toBe(
          f.prompt.operation.operationId,
        );
        expect(selected.decision.target.deliveryCursor).toBe(1);
        const later = yield* f.operations.prepare(
          { providerInstanceId, threadId },
          selected.decision.request,
          selected.decision.requestSha256,
          {
            allocation: yield* f.allocation,
            workerId: "post-compact-message-worker",
            operationId: selected.decision.request.operationId,
            resourceHash: selected.decision.resourceHash,
          },
        );
        expect(later.maximumTokens).toBe(f.prompt.maximumTokens);
        expect((yield* f.messages)[0]?.status).toBe("queued");
        const retained = yield* turns.readForOperation({
          projectId,
          bindingId: f.binding.recordId,
          generation: f.binding.generation,
          providerInstanceId,
          request: selected.decision.request,
        });
        if (retained._tag !== "LaterTurn")
          return yield* Effect.die("Expected retained later context");
        expect(retained.decision).toEqual(selected.decision);
        expect(retained.original).toEqual(original);
        yield* turns.seal({
          operationId: later.operation.operationId,
          baseSystemText: "Current required context after compaction",
        });
        const laterInput = yield* f.reserveInput(later);
        yield* turns.bindInput({
          operationId: later.operation.operationId,
          reservationId: laterInput.reservationId,
          encodedRequestSha256: "d".repeat(64),
        });
        yield* f.complete(later, { ...native, leafId: "post-compact-delivered" }, "success", [
          yield* laterInput.settle,
        ]);
        expect((yield* turns.reflect({ operationId: later.operation.operationId }))._tag).toBe(
          "Delivered",
        );
        expect((yield* f.messages)[0]?.status).toBe("delivered");
        const supplied = {
          threadId,
          kind: "compact" as const,
          requestId: MessageId.make("compact-after-message"),
        };
        const boundary = yield* f.operations.readCompaction(
          { providerInstanceId, threadId },
          supplied,
        );
        const request = { ...supplied, operationId: boundary.operationId };
        const compact = yield* f.operations.prepare(
          { providerInstanceId, threadId },
          request,
          hash(request),
          {
            allocation: yield* f.allocation,
            workerId: "successor-compact-worker",
            operationId: request.operationId,
            resourceHash: "a".repeat(64),
            compactContext: { provenanceSha256: "b".repeat(64), textSha256: "c".repeat(64) },
          },
        );
        const compactInput = yield* f.reserveInput(compact);
        yield* f.complete(compact, { ...native, leafId: "successor-compact-leaf" }, "success", [
          yield* compactInput.settle,
        ]);
        yield* f.addMessage(
          "second-after-compact",
          "An ordinary successor still consumes only its selected message",
        );
        const next = yield* turns.claim(original, {
          afterOperationId: later.operation.operationId,
        });
        if (next._tag !== "Selected")
          return yield* Effect.die("Expected ordinary successor after compaction");
        expect(next.decision.request.resumeCursor).toEqual({
          ...native,
          leafId: "successor-compact-leaf",
        });
        expect(next.decision.compactAnchor?.operationId).toBe(compact.operation.operationId);
        expect(next.decision.target.deliveryCursor).toBe(1);
        const rowsBeforeOldReplay =
          yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`;
        const chargesBeforeOldReplay = yield* f.sql`SELECT * FROM project_team_model_request`;
        const recreated = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
        expect(
          (yield* recreated.readCompaction({ providerInstanceId, threadId }, retainedRequest))
            .operationId,
        ).toBe(retainedRequest.operationId);
        const throughMessage = yield* recreated.lookup(
          { providerInstanceId, threadId },
          retainedRequest,
          hash(retainedRequest),
          "a".repeat(64),
        );
        expect(throughMessage?.terminal).toEqual(retainedTerminal);
        expect(throughMessage?.replayHead?.operation.operationId).toBe(
          compact.operation.operationId,
        );
        expect(throughMessage?.replayHead?.native.leafId).toBe("successor-compact-leaf");
        expect(
          yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`,
        ).toEqual(rowsBeforeOldReplay);
        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(
          chargesBeforeOldReplay,
        );
        yield* f.sql`UPDATE project_team_pi_operation SET status='quarantine' WHERE operation_id=${compact.operation.operationId}`;
        expect(
          (yield* recreated
            .readCompaction({ providerInstanceId, threadId }, retainedRequest)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* f.sql`UPDATE project_team_pi_operation SET status='settled' WHERE operation_id=${compact.operation.operationId}`;
        expect((yield* f.messages).map((message) => [message.recordId, message.status])).toEqual([
          ["after-compact", "delivered"],
          ["second-after-compact", "queued"],
        ]);
      }).pipe(
        Effect.provide(layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true })),
      ),
    ),
);

it.effect(
  "compact preserves retained replay at the binding cleanup bound and prevents a 131st operation",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment(undefined, 1000);
        const input = yield* f.reserveInput();
        yield* f.complete(f.prompt, { ...native, leafId: "capacity-original" }, "success", [
          yield* input.settle,
        ]);
        const observed = yield* f.journal.advanceStage(f.snapshot.fence, {
          receiptId: "capacity-original-observed",
          stage: "assignment-observed",
          evidence: { bindingId: f.binding.recordId },
        });
        const original = yield* f.journal.readRetained(observed.fence.dispatchId);
        const supplied = {
          threadId,
          kind: "compact" as const,
          requestId: MessageId.make("capacity-retained-compact"),
        };
        const before = yield* f.sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM project_team_pi_operation
      WHERE environment_id='environment' AND binding_id=${f.binding.recordId} AND generation=${f.binding.generation}`;
        expect(before[0]?.count).toBe(2);
        expect(
          yield* f.sql`SELECT binding_id,operation_ordinal FROM project_team_pi_operation WHERE operation_id='older-binding-operation'`,
        ).toEqual([{ binding_id: "older-binding", operation_ordinal: 1000 }]);
        const boundary = yield* f.operations.readCompaction(
          { providerInstanceId, threadId },
          supplied,
        );
        expect(boundary.predecessor.ordinal).toBeGreaterThan(130);
        const request = { ...supplied, operationId: boundary.operationId };
        const compact = yield* f.operations.prepare(
          { providerInstanceId, threadId },
          request,
          hash(request),
          {
            allocation: yield* f.allocation,
            workerId: "capacity-compact-worker",
            operationId: request.operationId,
            resourceHash: "a".repeat(64),
            compactContext: { provenanceSha256: "b".repeat(64), textSha256: "c".repeat(64) },
          },
        );
        const compactInput = yield* f.reserveInput(compact);
        const terminal = yield* f.complete(
          compact,
          { ...native, leafId: "capacity-compact" },
          "success",
          [yield* compactInput.settle],
        );
        const next = {
          threadId,
          kind: "compact" as const,
          requestId: MessageId.make("capacity-new-compact"),
        };
        const nextId = (yield* f.operations.readCompaction({ providerInstanceId, threadId }, next))
          .operationId;
        // Metadata occupants test cleanup capacity only; their copied bodies are never execution authority.
        yield* f.sql`WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n<127)
      INSERT INTO project_team_pi_operation
      (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
      operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,
      intent_json,native_json,terminal_json)
      SELECT 'capacity-metadata-'||n,environment_id,project_id,binding_id,generation,provider_instance_id,
      'capacity-metadata-thread-'||n,'capacity-metadata-worker-'||n,0,operation_kind,request_hash,root_binding_id,
      root_task_id,maximum_tokens,deadline_at_ms,'settled',intent_json,native_json,terminal_json
      FROM project_team_pi_operation,slots WHERE operation_id=${f.request.initializeOperationId}`;
        const count = yield* f.sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM project_team_pi_operation
      WHERE environment_id='environment' AND binding_id=${f.binding.recordId} AND generation=${f.binding.generation}`;
        expect(count[0]?.count).toBe(130);
        expect(
          (yield* f.operations.readCompaction({ providerInstanceId, threadId }, supplied))
            .operationId,
        ).toBe(request.operationId);
        expect(
          (yield* f.operations.lookup(
            { providerInstanceId, threadId },
            request,
            hash(request),
            "a".repeat(64),
          ))?.terminal,
        ).toEqual(terminal);
        const rows =
          yield* f.sql`SELECT operation_id,status FROM project_team_pi_operation ORDER BY operation_id`;
        expect(
          yield* f.operations
            .readCompaction({ providerInstanceId, threadId }, next)
            .pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { detail: "Pi owned operation history has reached its cleanup bound" },
        });
        const nextRequest = { ...next, operationId: nextId };
        expect(
          yield* f.operations
            .prepare({ providerInstanceId, threadId }, nextRequest, hash(nextRequest), {
              allocation: yield* f.allocation,
              workerId: "capacity-rejected-worker",
              operationId: nextId,
              resourceHash: "a".repeat(64),
              compactContext: { provenanceSha256: "b".repeat(64), textSha256: "c".repeat(64) },
            })
            .pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { detail: "Pi owned operation history has reached its cleanup bound" },
        });
        yield* f.addMessage(
          "capacity-later-message",
          "This message must not acquire a 131st owner",
        );
        const turns = yield* makeProjectTeamMailboxTurns({
          environmentId: "environment",
          lookupInTransaction: f.operations.lookupInTransaction,
        });
        const selected = yield* turns.claim(original);
        if (selected._tag !== "Selected")
          return yield* Effect.die("Expected actual selected mailbox decision");
        expect(
          yield* f.operations
            .prepare(
              { providerInstanceId, threadId },
              selected.decision.request,
              selected.decision.requestSha256,
              {
                allocation: yield* f.allocation,
                workerId: "capacity-later-worker",
                operationId: selected.decision.request.operationId,
                resourceHash: selected.decision.resourceHash,
              },
            )
            .pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { detail: "Pi owned operation history has reached its cleanup bound" },
        });
        expect(
          yield* f.sql`SELECT operation_id,status FROM project_team_pi_operation ORDER BY operation_id`,
        ).toEqual(rows);
        expect((yield* f.messages)[0]?.status).toBe("queued");
      }).pipe(
        Effect.provide(layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true })),
      ),
    ),
);

it.effect("compact cannot reopen an immutable empty mailbox boundary", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* laterFixture;
      const empty = yield* f.turns.claim(f.snapshot);
      expect(empty._tag).toBe("None");
      const supplied = {
        threadId,
        kind: "compact" as const,
        requestId: MessageId.make("compact-after-empty"),
      };
      const boundary = yield* f.operations.readCompaction(
        { providerInstanceId, threadId },
        supplied,
      );
      const request = { ...supplied, operationId: boundary.operationId };
      const operation = yield* f.operations.prepare(
        { providerInstanceId, threadId },
        request,
        hash(request),
        {
          allocation: yield* f.allocation,
          workerId: "empty-compact-worker",
          operationId: request.operationId,
          resourceHash: "a".repeat(64),
          compactContext: { provenanceSha256: "b".repeat(64), textSha256: "c".repeat(64) },
        },
      );
      const input = yield* f.reserveInput(operation);
      yield* f.complete(operation, { ...native, leafId: "compact-after-empty-leaf" }, "success", [
        yield* input.settle,
      ]);
      yield* f.addMessage("still-idle", "This does not gain idle wake authority");
      expect(yield* f.turns.claim(f.snapshot)).toEqual(empty);
      expect((yield* f.messages)[0]?.status).toBe("queued");
    }),
  ),
);

for (const outcome of ["failed", "canceled", "quarantine"] as const)
  it.effect(`compact denies a ${outcome} predecessor without allocating a new operation`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment();
        yield* f.complete(f.prompt, { ...native, leafId: "non-successful-assignment" }, outcome);
        const observed = yield* f.journal.advanceStage(f.snapshot.fence, {
          receiptId: "failed-compact-observed",
          stage: "assignment-observed",
          evidence: { bindingId: f.binding.recordId },
        });
        expect(observed.fence.stage).toBe("assignment-observed");
        const before =
          yield* f.sql`SELECT operation_id,status FROM project_team_pi_operation ORDER BY operation_ordinal`;
        expect(
          (yield* f.operations
            .readCompaction(
              { providerInstanceId, threadId },
              {
                kind: "compact",
                threadId,
                requestId: MessageId.make(`denied-compact-${outcome}`),
              },
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          yield* f.sql`SELECT operation_id,status FROM project_team_pi_operation ORDER BY operation_ordinal`,
        ).toEqual(before);
      }),
    ),
  );

it.effect(
  "actual installed resolver admits one retained later request and revocation or altered input denies it",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterFixture;
        yield* f.addMessage("next", "Installed resolver selects this message");
        const selected = yield* f.turns.claim(f.snapshot);
        if (selected._tag !== "Selected") return yield* Effect.die("Expected selected message");
        let resolve: NonNullable<PiProductionRuntimeHooks["resolveOperationId"]> | undefined;
        const runtime = yield* makeProjectTeamRuntime({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 2,
        }).pipe(
          Effect.provide(
            Layer.mock(ProjectTeamPiRuntime)({
              installOperationResolver: (callback) =>
                Effect.sync(() => {
                  resolve = callback;
                }),
            }),
          ),
        );
        if (!resolve) return yield* Effect.die("Resolver was not installed");
        const request = selected.decision.request;
        // Actual PiAdapter.sendTurn shape: no ID, workspace/runtime hints or resume cursor.
        const ordinaryRequest = {
          threadId: request.threadId,
          kind: "prompt" as const,
          prompt: request.prompt,
          ...(request.modelSelection === undefined
            ? {}
            : { modelSelection: request.modelSelection }),
          ...(request.skillPlan === undefined ? {} : { skillPlan: request.skillPlan }),
        };
        expect(yield* resolve(providerInstanceId, ordinaryRequest)).toBe(request.operationId);
        for (const changed of [
          { ...ordinaryRequest, prompt: "Changed user input" },
          { ...ordinaryRequest, operationId: "foreign-operation" },
          { ...ordinaryRequest, cwd: "/foreign-workspace" },
          { ...ordinaryRequest, runtimeMode: "full-access" as const },
          { ...ordinaryRequest, resumeCursor: native },
        ])
          expect((yield* resolve(providerInstanceId, changed).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({ projectTeamExecutionEnabled: false });
        expect((yield* resolve(providerInstanceId, ordinaryRequest).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
        expect(yield* resolve(providerInstanceId, ordinaryRequest)).toBe(request.operationId);
        yield* runtime.stop;
        expect((yield* resolve(providerInstanceId, ordinaryRequest).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect((yield* f.messages)[0]?.status).toBe("queued");
      }).pipe(
        Effect.provide(layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true })),
        Effect.scoped,
      ),
    ),
);

it.effect(
  "production-used Host continuation subscribes first, sends two exact turns, waits for actual SQL delivery, and never resends",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterFixture;
        yield* f.addMessage("next", "First later turn through the Host");
        yield* f.addMessage("other", "Second later turn through the Host");
        const commands: OrchestrationCommand[] = [];
        const firstSent = yield* Deferred.make<OrchestrationCommand>();
        const secondSent = yield* Deferred.make<OrchestrationCommand>();
        let resolve: NonNullable<PiProductionRuntimeHooks["resolveOperationId"]> | undefined;
        yield* makeProjectTeamRuntime({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 2,
        }).pipe(
          Effect.provide(
            Layer.mock(ProjectTeamPiRuntime)({
              installOperationResolver: (callback) =>
                Effect.sync(() => {
                  resolve = callback;
                }),
            }),
          ),
        );
        if (!resolve) return yield* Effect.die("Resolver was not installed");
        const events = yield* PubSub.unbounded<typeof OrchestrationEvent.Type>();
        let subscribed = false;
        const engine = Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: PubSub.subscribe(events).pipe(
            Effect.map((subscription) => {
              subscribed = true;
              return Stream.fromSubscription(subscription);
            }),
          ),
          dispatch: (command) =>
            Effect.gen(function* () {
              expect(subscribed).toBe(true);
              commands.push(command);
              yield* Deferred.succeed(commands.length === 1 ? firstSent : secondSent, command);
              return { sequence: 1 };
            }),
        });
        const run = continueProjectTeamMailboxTurn({
          original: f.snapshot,
          turns: f.turns,
          assertCurrent: Effect.void,
        }).pipe(Effect.provide(engine), Effect.provide(ProjectWorkEventBusLive));
        const fiber = yield* run.pipe(Effect.forkChild);
        let afterOperationId: string | undefined;
        let cursor = { ...native, leafId: "assignment-leaf" };
        const commandIds: string[] = [];
        for (const [index, sent] of [firstSent, secondSent].entries()) {
          const command = yield* Deferred.await(sent);
          const selected = yield* f.turns.claim(
            f.snapshot,
            afterOperationId === undefined ? undefined : { afterOperationId },
          );
          if (selected._tag !== "Selected" || command.type !== "thread.turn.start")
            return yield* Effect.die("Expected selected turn command");
          expect(command.commandId).toBe(selected.decision.commandId);
          expect(command.message.messageId).toBe(selected.decision.userMessageId);
          expect(command.message.text).toBe(selected.decision.request.prompt);
          expect(command.message.displayText).toBe(
            "Team message\n\n" + selected.decision.message.body,
          );
          expect((yield* f.messages).filter((m) => m.status === "delivered")).toHaveLength(index);
          const request = selected.decision.request;
          expect(request.resumeCursor).toEqual(cursor);
          expect(request.prompt).toContain(index === 0 ? "First later turn" : "Second later turn");
          expect(request.prompt).not.toContain(
            index === 0 ? "Second later turn" : "First later turn",
          );
          const adapterRequest = {
            threadId: request.threadId,
            kind: "prompt" as const,
            prompt: request.prompt,
            ...(request.modelSelection === undefined
              ? {}
              : { modelSelection: request.modelSelection }),
            ...(request.skillPlan === undefined ? {} : { skillPlan: request.skillPlan }),
          };
          expect(yield* resolve(providerInstanceId, adapterRequest)).toBe(request.operationId);
          expect(
            (yield* resolve(providerInstanceId, { ...adapterRequest, resumeCursor: native }).pipe(
              Effect.result,
            ))._tag,
          ).toBe("Failure");
          commandIds.push(command.commandId);
          const later = yield* f.operations.prepare(
            { providerInstanceId, threadId },
            request,
            hash(request),
            {
              allocation: yield* f.allocation,
              workerId: `later-worker-${index}`,
              operationId: request.operationId,
              resourceHash: selected.decision.resourceHash,
            },
          );
          yield* f.turns.seal({
            operationId: request.operationId,
            baseSystemText: "Required task context",
          });
          const input = yield* f.reserveInput(later);
          yield* f.turns.bindInput({
            operationId: request.operationId,
            reservationId: input.reservationId,
            encodedRequestSha256: "b".repeat(64),
          });
          cursor = { ...native, leafId: `host-later-leaf-${index}` };
          yield* f.complete(later, cursor, "success", [yield* input.settle]);
          afterOperationId = request.operationId;
          const event = yield* decodeOrchestrationEvent({
            type: "thread.session-set",
            sequence: index + 1,
            eventId: `later-observed:${index}`,
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: at,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              threadId,
              session: {
                threadId,
                status: "ready",
                providerName: "pi",
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: at,
              },
            },
          });
          yield* PubSub.publish(events, event);
        }
        yield* Fiber.join(fiber);
        expect(new Set(commandIds).size).toBe(2);
        expect(
          (yield* f.messages)
            .sort((a, b) => a.recordId.localeCompare(b.recordId))
            .map((m) => [m.recordId, m.status]),
        ).toEqual([
          ["next", "delivered"],
          ["other", "delivered"],
        ]);
        yield* f.addMessage("late-host", "No idle continuation after the empty boundary");
        yield* run;
        expect(commands).toHaveLength(2);
        expect(
          (yield* f.messages).find((message) => message.recordId === "late-host")?.status,
        ).toBe("queued");
      }).pipe(
        Effect.provide(layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true })),
        Effect.scoped,
      ),
    ),
);

it.effect(
  "boundary capture and transaction-affine reads fail closed after COMMIT failure and never select replacement mail",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterFixture;
        yield* f.addMessage("first", "Freeze this one");
        const before = yield* readCurrentState(f.sql, projectId);
        yield* f.sql`PRAGMA foreign_keys=ON`;
        yield* f.sql`CREATE TABLE turn_boundary_parent(id TEXT PRIMARY KEY)`;
        yield* f.sql`CREATE TABLE turn_boundary_child(id TEXT REFERENCES turn_boundary_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* f.sql`CREATE TRIGGER fail_turn_boundary AFTER INSERT ON project_team_mailbox_turn BEGIN INSERT INTO turn_boundary_child VALUES('missing'); END`;
        let escaped = false;
        expectCommitFailure(
          yield* f.turns.claim(f.snapshot).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                escaped = true;
              }),
            ),
            Effect.exit,
          ),
        );
        expect(escaped).toBe(false);
        const reader = yield* makeProjectTeamMailboxTurnDecisionReader({
          environmentId: "environment",
        });
        expect(
          (yield* reader
            .readInTransaction({ dispatchId: f.snapshot.fence.dispatchId })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect((yield* f.turns.claim(f.snapshot).pipe(Effect.exit))._tag).toBe("Failure");
        expect(
          yield* f.sql.withTransaction(
            reader.readInTransaction({ dispatchId: f.snapshot.fence.dispatchId }),
          ),
        ).toBeUndefined();
        expect(yield* f.sql`SELECT operation_id FROM project_team_mailbox_turn`).toEqual([]);
        expect(yield* f.sql`SELECT * FROM turn_boundary_child`).toEqual([]);
        expect(yield* f.sql.withTransaction(readCurrentState(f.sql, projectId))).toEqual(before);
        yield* f.sql`DROP TRIGGER fail_turn_boundary`;
        const selected = yield* f.turns.claim(f.snapshot);
        if (selected._tag !== "Selected") return yield* Effect.die("Expected selected message");
        expect(
          yield* f.sql.withTransaction(
            reader.readInTransaction({ operationId: selected.decision.request.operationId }),
          ),
        ).toEqual(selected.decision);
        expect(
          (yield* f.sql.withTransaction(f.turns.claim(f.snapshot)).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        yield* f.addMessage("earlier", "New mail cannot replace the original");
        expect((yield* f.turns.claim(f.snapshot)).decision).toEqual(selected.decision);
        expect((yield* f.messages).every((m) => m.status === "queued")).toBe(true);
      }),
    ),
);

it.effect(
  "historical replay preserves delivery after owner retirement but rejects changed retained input",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterExecutionFixture;
        yield* f.complete(f.later, native, "success", [yield* f.input.settle]);
        expect((yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag).toBe(
          "Delivered",
        );
        const state = yield* readCurrentState(f.sql, projectId);
        const member = state.foundationRecords?.find(
          (r) => r.kind === "member" && r.recordId === f.binding.memberId,
        );
        if (member?.kind !== "member") return yield* Effect.die("Missing member");
        yield* f.commit(
          [{ ...member, revision: member.revision + 1, status: "paused" }],
          "pause-historical-owner",
        );
        expect((yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag).toBe(
          "Retained",
        );
        yield* f.sql`DROP TRIGGER IF EXISTS project_team_mailbox_input_immutable`;
        yield* f.sql`UPDATE project_team_mailbox_input SET encoded_request_sha256=${"c".repeat(64)} WHERE operation_id=${f.decision.request.operationId}`;
        expect(
          (yield* f.turns
            .reflect({ operationId: f.decision.request.operationId })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect(
  "synchronous selected input capture, strict owner decoder and original budget fence cannot be retargeted",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterFixture;
        yield* f.addMessage("next", "Strict captured owner");
        const supplied = { ...f.snapshot, fence: { ...f.snapshot.fence } };
        const claim = f.turns.claim(supplied);
        supplied.fence.dispatchId = "foreign-dispatch";
        const selected = yield* claim;
        if (selected._tag !== "Selected") return yield* Effect.die("Expected selected message");
        expect(selected.decision.dispatchId).toBe(f.snapshot.fence.dispatchId);
        const locator = { operationId: selected.decision.request.operationId };
        const reader = yield* makeProjectTeamMailboxTurnDecisionReader({
          environmentId: "environment",
        });
        const read = reader.readInTransaction(locator);
        locator.operationId = "foreign-operation";
        expect(yield* f.sql.withTransaction(read)).toEqual(selected.decision);
        yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=maximum_tokens+1`;
        expect((yield* f.turns.claim(f.snapshot).pipe(Effect.exit))._tag).toBe("Failure");
        yield* f.sql`DROP TRIGGER project_team_mailbox_turn_immutable`;
        const foreign = {
          ...selected.decision,
          target: { ...selected.decision.target, projectId: ProjectId.make("foreign-project") },
        };
        yield* f.sql`UPDATE project_team_mailbox_turn SET decision_json=${canonical(foreign)},decision_sha256=${hash(foreign)}`;
        expect(
          (yield* f.sql
            .withTransaction(reader.readInTransaction({ dispatchId: f.snapshot.fence.dispatchId }))
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect(
  "later system text is bounded and cannot falsely seal or consume an oversized context",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterFixture;
        yield* f.addMessage("next", "Retained body");
        const selected = yield* f.turns.claim(f.snapshot);
        if (selected._tag !== "Selected") return yield* Effect.die("Expected selected message");
        const request = selected.decision.request;
        yield* f.operations.prepare({ providerInstanceId, threadId }, request, hash(request), {
          allocation: yield* f.allocation,
          workerId: "later-worker",
          operationId: request.operationId,
          resourceHash: selected.decision.resourceHash,
        });
        expect(
          (yield* f.turns
            .seal({ operationId: request.operationId, baseSystemText: "a".repeat(65536) })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(
          yield* f.sql`SELECT operation_id FROM project_team_mailbox_batch WHERE operation_id=${request.operationId}`,
        ).toEqual([]);
        expect((yield* f.messages)[0]?.status).toBe("queued");
        expect((yield* f.turns.reflect({ operationId: request.operationId }))._tag).toBe("Pending");
      }),
    ),
);

it.effect(
  "paused active ownership returns uncertainty for cleanup without delivery or suppressing storage failure",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterExecutionFixture;
        const state = yield* readCurrentState(f.sql, projectId);
        const member = state.foundationRecords?.find(
          (r) => r.kind === "member" && r.recordId === f.binding.memberId,
        );
        if (member?.kind !== "member") return yield* Effect.die("Missing member");
        yield* f.commit(
          [{ ...member, revision: member.revision + 1, status: "paused" }],
          "pause-active-owner",
        );
        expect((yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag).toBe(
          "Uncertain",
        );
        expect((yield* f.messages)[0]?.status).toBe("queued");
        expect(
          yield* f.sql`SELECT operation_id FROM project_team_mailbox_reflection WHERE operation_id=${f.decision.request.operationId}`,
        ).toEqual([]);
        expect(
          yield* f.sql`SELECT status FROM project_team_pi_operation WHERE operation_id=${f.decision.request.operationId}`,
        ).toEqual([{ status: "running" }]);
        yield* f.sql`ALTER TABLE project_team_run_binding RENAME TO unavailable_turn_binding`;
        expect(
          (yield* f.turns
            .reflect({ operationId: f.decision.request.operationId })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
    ),
);

for (const state of ["active", "failed", "unreflected", "foreign"] as const) {
  it.effect(`successor admission rejects an ${state} predecessor without replacement`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterExecutionFixture;
        yield* f.addMessage("second", "Must remain queued without a qualified predecessor");
        if (state === "failed" || state === "unreflected")
          yield* f.complete(f.later, native, state === "failed" ? "failed" : "success", [
            yield* f.input.settle,
          ]);
        if (state === "failed")
          expect(
            (yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag,
          ).toBe("Uncertain");
        const boundary = {
          afterOperationId:
            state === "foreign" ? "foreign-operation" : f.decision.request.operationId,
        };
        expect((yield* f.turns.claim(f.snapshot, boundary).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* f.sql`SELECT operation_id FROM project_team_mailbox_successor`).toEqual([]);
        expect((yield* f.messages).find((message) => message.recordId === "second")?.status).toBe(
          "queued",
        );
        if (state === "unreflected") {
          expect(
            (yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag,
          ).toBe("Delivered");
          expect((yield* f.turns.claim(f.snapshot, boundary))._tag).toBe("Selected");
        }
      }),
    ),
  );
}

for (const change of ["owner", "sender", "scope", "deadline", "budget"] as const) {
  it.effect(`successor admission preserves the original ${change} fence`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* change === "budget"
          ? laterExecutionFixtureFor({
              prompt_tokens: 10000,
              completion_tokens: 10000,
              total_tokens: 20000,
            })
          : laterExecutionFixture;
        yield* f.complete(f.later, native, "success", [yield* f.input.settle]);
        expect((yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag).toBe(
          "Delivered",
        );
        if (change === "sender") {
          const records = (yield* readCurrentState(f.sql, projectId)).foundationRecords ?? [];
          const owner = records.find(
            (record) => record.kind === "member" && record.recordId === f.binding.memberId,
          );
          if (owner?.kind !== "member") return yield* Effect.die("Missing member");
          yield* f.commit(
            [{ ...owner, recordId: "second-sender", revision: 0, name: "Other sender" }],
            "second-sender",
          );
        }
        yield* f.addMessage(
          "second",
          "Only current authority may select this",
          change === "sender" ? { senderId: "second-sender" } : {},
        );
        if (change === "owner" || change === "sender") {
          const id = change === "sender" ? "second-sender" : f.binding.memberId;
          const member = (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
            (record) => record.kind === "member" && record.recordId === id,
          );
          if (member?.kind !== "member") return yield* Effect.die("Missing member");
          yield* f.commit(
            [{ ...member, revision: member.revision + 1, status: "paused" }],
            `pause-${change}`,
          );
        }
        if (change === "scope") {
          const membership = (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
            (record) => record.kind === "task-membership" && record.taskId === f.binding.taskId,
          );
          if (membership?.kind !== "task-membership")
            return yield* Effect.die("Missing task scope");
          yield* f.commit(
            [{ ...membership, revision: membership.revision + 1, status: "removed" }],
            "remove-recipient-scope",
          );
        }
        if (change === "deadline") yield* TestClock.setTime(f.later.deadlineAtMs + 1);
        const outcome = yield* f.turns
          .claim(f.snapshot, { afterOperationId: f.decision.request.operationId })
          .pipe(Effect.result);
        // An inactive sender is excluded from selection, leaving an immutable empty boundary.
        expect(outcome._tag).toBe(change === "sender" ? "Success" : "Failure");
        if (change === "sender" && outcome._tag === "Success")
          expect(outcome.success._tag).toBe("None");
        expect((yield* f.messages).find((message) => message.recordId === "second")?.status).toBe(
          "queued",
        );
        expect(
          yield* f.sql`SELECT operation_id FROM project_team_mailbox_successor WHERE operation_id IS NOT NULL`,
        ).toEqual([]);
      }),
    ),
  );
}

it.effect(
  "successor COMMIT failure exposes no decision and retries retain the exact selected successor",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterExecutionFixture;
        yield* f.complete(f.later, native, "success", [yield* f.input.settle]);
        expect((yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag).toBe(
          "Delivered",
        );
        yield* f.addMessage("second", "Retain this exact successor");
        const before = yield* readCurrentState(f.sql, projectId);
        const turnsBefore = yield* f.sql`SELECT * FROM project_team_mailbox_turn`;
        yield* f.sql`PRAGMA foreign_keys=ON`;
        yield* f.sql`CREATE TABLE successor_parent(id TEXT PRIMARY KEY)`;
        yield* f.sql`CREATE TABLE successor_child(id TEXT REFERENCES successor_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* f.sql`CREATE TRIGGER fail_successor_commit AFTER INSERT ON project_team_mailbox_successor BEGIN INSERT INTO successor_child VALUES('missing'); END`;
        const supplied = { afterOperationId: f.decision.request.operationId };
        let escaped = false;
        expectCommitFailure(
          yield* f.turns.claim(f.snapshot, supplied).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                escaped = true;
              }),
            ),
            Effect.exit,
          ),
        );
        expect(escaped).toBe(false);
        const reader = yield* makeProjectTeamMailboxTurnDecisionReader({
          environmentId: "environment",
        });
        expect(
          yield* f.sql.withTransaction(
            reader.readInTransaction({ dispatchId: f.snapshot.fence.dispatchId, ...supplied }),
          ),
        ).toBeUndefined();
        expect(yield* f.sql`SELECT * FROM successor_child`).toEqual([]);
        expect(yield* f.sql`SELECT operation_id FROM project_team_mailbox_successor`).toEqual([]);
        expect(yield* f.sql.withTransaction(readCurrentState(f.sql, projectId))).toEqual(before);
        expect(yield* f.sql`SELECT * FROM project_team_mailbox_turn`).toEqual(turnsBefore);
        yield* f.sql`DROP TRIGGER fail_successor_commit`;
        const capture = f.turns.claim(f.snapshot, supplied);
        supplied.afterOperationId = "foreign-operation";
        const selected = yield* capture;
        if (selected._tag !== "Selected") return yield* Effect.die("Expected selected successor");
        const restarted = yield* makeProjectTeamMailboxTurns({
          environmentId: "environment",
          lookupInTransaction: f.operations.lookupInTransaction,
        });
        const locator = { afterOperationId: f.decision.request.operationId };
        const retries = yield* Effect.all(
          [f.turns.claim(f.snapshot, locator), restarted.claim(f.snapshot, locator)],
          { concurrency: 2 },
        );
        expect(retries.map((retry) => retry.decision)).toEqual([
          selected.decision,
          selected.decision,
        ]);
        expect(yield* f.sql`SELECT operation_id FROM project_team_mailbox_successor`).toEqual([
          { operation_id: selected.decision.request.operationId },
        ]);
        expect(
          yield* f.sql.withTransaction(
            reader.readHeadInTransaction({ dispatchId: f.snapshot.fence.dispatchId }),
          ),
        ).toEqual(selected.decision);
        expect((yield* f.messages).find((message) => message.recordId === "second")?.status).toBe(
          "queued",
        );
      }),
    ),
);
