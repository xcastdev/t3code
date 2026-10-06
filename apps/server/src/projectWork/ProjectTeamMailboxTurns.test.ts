import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamMessage,
  ProjectId,
  SkillCatalogRevision,
  OrchestrationEvent,
  type OrchestrationCommand,
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

import { continueProjectTeamMailboxTurn } from "./ProjectTeamExecutionHost.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeProjectTeamRuntime } from "./ProjectTeamRuntime.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { layerTest, ServerSettingsService } from "../serverSettings.ts";
import type { PiProductionRuntimeHooks } from "../provider/pi/PiProductionRuntime.ts";

const model = "inclusionai/ling-3.1-flash:free";
const now = Date.parse(at) + 100;
const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
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
  const reserveInput = Effect.fn("laterTest.reserveInput")(function* (op = prompt) {
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
      maxInputTokens: 1000,
      maxOutputTokens: 100,
      callCount: 1 as const,
      deadlineAtMs: op.deadlineAtMs,
    };
    const reservation = yield* accounting.reserve(op.principal, fields);
    const settle = Effect.gen(function* () {
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      const settled = yield* accounting.settle({
        ...fields,
        reservationId: reservation.reservationId,
        outcome: "reported",
        transportDrained: true,
        chargedInputTokens: 10,
        chargedOutputTokens: 2,
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

export const laterExecutionFixture = Effect.gen(function* () {
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
  const input = yield* f.reserveInput(later);
  yield* f.turns.bindInput({
    operationId: request.operationId,
    reservationId: input.reservationId,
    encodedRequestSha256: "b".repeat(64),
  });
  return { ...f, later, seal, input, decision: selected.decision };
});

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
        expect(
          (yield* f.turns.reflect({ operationId: f.decision.request.operationId }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                escaped = true;
              }),
            ),
            Effect.exit,
          ))._tag,
        ).toBe("Failure");
        expect(escaped).toBe(false);
        expect(
          (yield* f.turns
            .reflect({ operationId: f.decision.request.operationId })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect((yield* f.turns.claim(f.snapshot).pipe(Effect.exit))._tag).toBe("Failure");
        // Disposable test connection only: release the physically failed COMMIT loan.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* f.sql.reserve;
            yield* connection.executeUnprepared("ROLLBACK", [], undefined);
          }),
        );
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
        yield* f.sql`DROP TRIGGER fail_turn_commit`;
        expect((yield* f.turns.reflect({ operationId: f.decision.request.operationId }))._tag).toBe(
          "Delivered",
        );
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
  "production-used Host continuation subscribes first, sends one exact turn, waits for actual SQL delivery, and never resends",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterFixture;
        yield* f.addMessage("next", "One later turn through the Host");
        yield* f.addMessage("other", "Remain queued for a future leaf");
        const commands: OrchestrationCommand[] = [];
        const sent = yield* Deferred.make<OrchestrationCommand>();
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
              yield* Deferred.succeed(sent, command);
              return { sequence: 1 };
            }),
        });
        const run = continueProjectTeamMailboxTurn({
          original: f.snapshot,
          turns: f.turns,
          assertCurrent: Effect.void,
        }).pipe(Effect.provide(engine));
        const fiber = yield* run.pipe(Effect.forkChild);
        const command = yield* Deferred.await(sent);
        const selected = yield* f.turns.claim(f.snapshot);
        if (selected._tag !== "Selected" || command.type !== "thread.turn.start")
          return yield* Effect.die("Expected selected turn command");
        expect(command.commandId).toBe(selected.decision.commandId);
        expect(command.message.messageId).toBe(selected.decision.userMessageId);
        expect(command.message.text).toBe(selected.decision.request.prompt);
        expect(command.message.displayText).toBe(
          "Team message\n\n" + selected.decision.message.body,
        );
        expect((yield* f.messages).every((m) => m.status === "queued")).toBe(true);
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
          baseSystemText: "Required task context",
        });
        const input = yield* f.reserveInput(later);
        yield* f.turns.bindInput({
          operationId: request.operationId,
          reservationId: input.reservationId,
          encodedRequestSha256: "b".repeat(64),
        });
        yield* f.complete(later, native, "success", [yield* input.settle]);
        const event = yield* decodeOrchestrationEvent({
          type: "thread.session-set",
          sequence: 1,
          eventId: "later-observed",
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
        yield* Fiber.join(fiber);
        expect(
          (yield* f.messages)
            .sort((a, b) => a.recordId.localeCompare(b.recordId))
            .map((m) => [m.recordId, m.status]),
        ).toEqual([
          ["next", "delivered"],
          ["other", "queued"],
        ]);
        yield* run;
        expect(commands).toHaveLength(1);
      }),
    ),
);

it.effect(
  "boundary capture and transaction-affine reads fail closed after COMMIT failure and never select replacement mail",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* laterFixture;
        yield* f.addMessage("first", "Freeze this one");
        yield* f.sql`PRAGMA foreign_keys=ON`;
        yield* f.sql`CREATE TABLE turn_boundary_parent(id TEXT PRIMARY KEY)`;
        yield* f.sql`CREATE TABLE turn_boundary_child(id TEXT REFERENCES turn_boundary_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* f.sql`CREATE TRIGGER fail_turn_boundary AFTER INSERT ON project_team_mailbox_turn BEGIN INSERT INTO turn_boundary_child VALUES('missing'); END`;
        let escaped = false;
        expect(
          (yield* f.turns.claim(f.snapshot).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                escaped = true;
              }),
            ),
            Effect.exit,
          ))._tag,
        ).toBe("Failure");
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
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* f.sql.reserve;
            yield* connection.executeUnprepared("ROLLBACK", [], undefined);
          }),
        );
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
