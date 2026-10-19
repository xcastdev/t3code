import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  restoreHistoricalBinding,
  decodeRecord,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchJournalError,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamPiOperations } from "./ProjectTeamPiOperations.ts";
import { make as makeAccounting } from "./ProjectTeamModelAccounting.ts";
import { preallocatePiManagedProcess } from "../provider/pi/PiManagedProcess.ts";
import type { PiSessionTerminal } from "../provider/pi/PiSessionRuntime.ts";
import type { PiNativeReference } from "../provider/pi/PiWorkerProtocol.ts";
import { makeProjectTeamMailboxConsumption } from "./ProjectTeamMailboxConsumption.ts";

const model = "inclusionai/ling-3.1-flash:free";
const now = Date.parse(at) + 100;
const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const decodeMessage = Schema.decodeUnknownEffect(ProjectTeamMessage);
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
  yield* restoreHistoricalBinding({ ...role, model: model });
  const fs = yield* FileSystem.FileSystem;
  const worktree = yield* fs.makeTempDirectoryScoped();
  const nativeRoot = yield* fs.makeTempDirectoryScoped();
  const protectedRoot = yield* fs.makeTempDirectoryScoped();
  const maximumTokens = 20_000;
  const binding = {
    ...claim.transition.binding,
    worktree,
    branch: "refs/heads/mailbox",
    model: model,
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
        model: model,
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
  const initRequest = {
    threadId,
    kind: "initialize" as const,
    operationId: request.initializeOperationId,
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
    resumeCursor: native,
  };
  const prompt = yield* operations.prepare(identity, promptRequest, hash(promptRequest), {
    allocation: yield* allocation,
    workerId: "mailbox-prompt-worker",
    operationId: promptRequest.operationId,
    resourceHash: "a".repeat(64),
  });
  const mailbox = yield* makeProjectTeamMailboxConsumption({ environmentId: "environment" });
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
  const reserveInput = Effect.gen(function* () {
    yield* activate(prompt, native);
    const accounting = yield* makeAccounting({
      environmentId: "environment",
      routeId: "command-code-ling-free",
      model,
      acceptedReportedModels: [model],
      resolveOperation: operations.resolveOperation,
    });
    const fields = {
      workerId: prompt.workerId,
      operationId: prompt.operation.operationId,
      generation: 0,
      requestId: 1,
      routeId: "command-code-ling-free",
      provider: "command-code" as const,
      model,
      maxInputTokens: 1000,
      maxOutputTokens: 100,
      callCount: 1 as const,
      deadlineAtMs: prompt.deadlineAtMs,
    };
    const reservation = yield* accounting.reserve(prompt.principal, fields);
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
        model: model,
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
    mailbox,
    journal,
    operations,
    snapshot,
    request,
    binding,
    prompt,
    addMessage,
    complete,
    activate,
    commit,
    reserveInput,
    messages,
  };
});

it.effect(
  "file-backed reopen retains pending question and resumes delivery without repeating its operation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "team-mailbox-restart-" });
      const services = () =>
        Layer.mergeAll(
          Authorization.layer,
          ProjectWorkRepositoryLive,
          ProjectWorkProjectionLive,
        ).pipe(
          Layer.provideMerge(
            Layer.fresh(NodeSqliteClient.layer({ filename: `${directory}/state.sqlite` })),
          ),
        );
      const retained = yield* Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixtureWithAssignment();
          const state = yield* readCurrentState(f.sql, projectId);
          const gate = state.foundationRecords?.find((r) => r.kind === "gate" && r.gate === "plan");
          if (gate?.kind !== "gate") return yield* Effect.die("Missing original question gate");
          const question = decodeRecord({
            kind: "question",
            projectId,
            recordId: "restart-question",
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "pending",
            taskId: f.binding.taskId,
            senderId: f.binding.memberId,
            targetGateId: gate.recordId,
            targetRevision: gate.revision,
            body: "Which bounded option?",
            choices: ["A", "B"],
          });
          yield* f.commit([question], "restart-question");
          yield* f.addMessage("restart-message", "Preserve this exact finding");
          const sealInput = {
            operationId: f.request.assignmentOperationId,
            baseSystemText: "Original instructions",
          };
          const sealed = yield* f.mailbox.sealInitialAssignment(sealInput);
          const input = yield* f.reserveInput;
          const bindInput = {
            operationId: f.request.assignmentOperationId,
            reservationId: input.reservationId,
            encodedRequestSha256: "b".repeat(64),
          };
          yield* f.mailbox.bindRequestInput(bindInput);
          yield* f.complete(f.prompt, { ...native, leafId: "restart-leaf" }, "success", [
            yield* input.settle,
          ]);
          // Crash boundary: the owned operation is terminal, but its message receipt is not reflected.
          expect((yield* f.messages)[0]).toMatchObject({ status: "queued", deliveryCursor: 0 });
          const operations =
            yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`;
          expect(operations).toHaveLength(2);
          expect(operations.every((row) => row.status === "settled")).toBe(true);
          return { question, sealed, bindInput, snapshot: f.snapshot, operations };
        }).pipe(Effect.provide(services())),
      );
      // The previous SQL scope has closed before a fresh connection opens the same file.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const projection = yield* ProjectWorkProjection;
          yield* projection.rebuild(projectId);
          const mailbox = yield* makeProjectTeamMailboxConsumption({
            environmentId: "environment",
          });
          expect(
            (yield* readCurrentState(sql, projectId)).foundationRecords?.find(
              (r) => r.recordId === retained.question.recordId,
            ),
          ).toEqual(retained.question);
          expect(
            (yield* readCurrentState(sql, projectId)).foundationRecords?.find(
              (r) => r.recordId === "restart-message",
            ),
          ).toMatchObject({ status: "queued", deliveryCursor: 0 });
          expect(retained.sealed.systemText).toContain("Preserve this exact finding");
          expect(yield* mailbox.bindRequestInput(retained.bindInput)).toEqual({
            reservationId: retained.bindInput.reservationId,
            encodedRequestSha256: retained.bindInput.encodedRequestSha256,
          });
          expect((yield* mailbox.reflectAssignment(retained.snapshot)).status).toBe("delivered");
          const delivered = yield* readCurrentState(sql, projectId);
          expect(
            delivered.foundationRecords?.find((r) => r.recordId === "restart-message"),
          ).toMatchObject({ status: "delivered", deliveryCursor: 1, revision: 1 });
          expect((yield* mailbox.reflectAssignment(retained.snapshot)).status).toBe("unchanged");
          yield* projection.rebuild(projectId);
          expect(yield* readCurrentState(sql, projectId)).toEqual(delivered);
          expect(
            delivered.foundationRecords?.find((r) => r.recordId === retained.question.recordId),
          ).toEqual(retained.question);
          expect(
            yield* sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`,
          ).toEqual(retained.operations);
        }).pipe(Effect.provide(services())),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
