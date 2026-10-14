import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamMessage,
  CommandId,
  ProjectWorkTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
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
  scoped,
  restoreHistoricalBinding,
  createManagedAssignment,
  decodeRecord,
  gatewayRuntime,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectTeamAuthorization, managedActorId } from "./ProjectTeamAuthorization.ts";
import { ProjectWorkQuery } from "./ProjectWorkQuery.ts";
import { ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
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
import { makeProjectTeamMailboxConsumption } from "./ProjectTeamMailboxConsumption.ts";

const model = "inclusionai/ling-3.1-flash:free";
const now = Date.parse(at) + 100;
const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const decodeMessage = Schema.decodeUnknownEffect(ProjectTeamMessage);
const encodePaddingJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ padding: Schema.String })),
);
const native: PiNativeReference = {
  sessionId: "mailbox-native",
  sessionReference: "sessions/mailbox.jsonl",
  leafId: null,
  persisted: true,
};

// Disposable SQL and controlled custody receipts only: no worker is started.
const fixtureWithAssignment = Effect.fn("mailboxTest.fixture")(function* (
  assignment = "Investigate the original approved task",
  retainRoleReceipt = false,
  selectedModel = model,
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
  yield* restoreHistoricalBinding({ ...role, model: selectedModel });
  if (retainRoleReceipt) {
    const restored = yield* readCurrentState(sql, projectId);
    const currentRole = restored.foundationRecords?.find(
      (r) => r.kind === "role-revision" && r.recordId === role.recordId,
    );
    if (currentRole?.kind !== "role-revision")
      return yield* Effect.die("Missing restored readonly role");
    // Retain the current role before preparing the immutable operation authority.
    yield* repository.execute(
      decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "mailbox-original-role-receipt",
        expectedRevision: restored.revision,
        attribution,
        committedAt: at,
        records: [{ ...currentRole, revision: currentRole.revision + 1 }],
      }),
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const worktree = yield* fs.makeTempDirectoryScoped();
  const nativeRoot = yield* fs.makeTempDirectoryScoped();
  const protectedRoot = yield* fs.makeTempDirectoryScoped();
  const maximumTokens = selectedModel === "gpt-6-luna" ? 64_000 : 20_000;
  const binding = {
    ...claim.transition.binding,
    worktree,
    branch: "refs/heads/mailbox",
    model: selectedModel,
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
        model: selectedModel,
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
    const subscription = selectedModel === "gpt-6-luna";
    const routeId = subscription ? "openai-subscription-luna" : "command-code-ling-free";
    const provider = subscription ? ("openai-codex" as const) : ("command-code" as const);
    const accounting = yield* makeAccounting({
      environmentId: "environment",
      routeId,
      model: selectedModel,
      acceptedReportedModels: [selectedModel],
      ...(subscription
        ? {
            subscriptionTest: {
              projectId,
              rootTaskId: binding.taskId,
              model: "gpt-6-luna" as const,
              maximumTokens: 64_000 as const,
              maximumDurationMs: 300_000 as const,
            },
          }
        : {}),
      resolveOperation: operations.resolveOperation,
    });
    const fields = {
      workerId: prompt.workerId,
      operationId: prompt.operation.operationId,
      generation: 0,
      requestId: 1,
      routeId,
      provider,
      model: selectedModel,
      maxInputTokens: subscription ? 16_384 : 1000,
      maxOutputTokens: subscription ? 2_048 : 100,
      callCount: 1 as const,
      deadlineAtMs: prompt.deadlineAtMs,
      ...(subscription
        ? {
            accountingMode: "openai-subscription-monitored" as const,
            unknownMaximumTokens: 64_000 as const,
          }
        : {}),
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
        reportedModel: selectedModel,
        reportedUsage: usage,
      });
      return {
        requestId: 1,
        reservationId: reservation.reservationId,
        accountingReceiptId: settled.accountingReceiptId,
        routeId: fields.routeId,
        provider: fields.provider,
        model: selectedModel,
        reportedModel: selectedModel,
        usage,
      };
    });
    const stopSubscriptionGrant = Effect.gen(function* () {
      if (!subscription) return yield* Effect.die("Only subscription reservations have a grant");
      return yield* accounting.settle({
        ...fields,
        reservationId: reservation.reservationId,
        transportDrained: true,
        outcome: "unknown",
        chargedInputTokens: 16_384,
        chargedOutputTokens: 64_000,
      });
    });
    return { ...reservation, settle, stopSubscriptionGrant };
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
const fixture = fixtureWithAssignment();

it.effect(
  "delivers an authenticated produced message through the original sealed assignment exactly once",
  () =>
    Effect.gen(function* () {
      const f = yield* fixtureWithAssignment("Investigate the original approved task", true);
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
        recordId: "produced-sender-role",
        roleId: "produced-sender-role",
        role: "implementer",
        roleRevision: originalRole.roleRevision + 1,
        revision: 0,
        tools: ["project-work.write"],
      });
      if (role.kind !== "role-revision")
        return yield* Effect.die("Invalid separately configured sender role");
      yield* f.commit(
        [
          role,
          decodeRecord({
            kind: "member",
            projectId,
            recordId: "produced-sender",
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "active",
            name: "Actual sender",
            coordinator: false,
            roleRevisionId: role.recordId,
          }),
        ],
        "produced-sender-configuration",
      );
      const sender = yield* createManagedAssignment({
        taskId: ProjectWorkTaskId.make("produced-sender-task"),
        recordId: "produced-sender-binding",
        attemptId: "produced-sender-attempt",
        commandId: "produced-sender-claim",
        providerInstanceId,
        threadId: ThreadId.make("produced-sender-thread"),
        role,
        memberId: "produced-sender",
        status: "running",
        sessionId: "produced-sender-session",
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
          commandId: "produced-message-mission",
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
              recordId: "produced-message-mission",
              revision: 0,
              generation: 0,
              updatedAt: at,
              status: "active",
              title: "Original mailbox coordination",
              objective: "Inform the actual assigned recipient",
              requiredTaskIds: [sender.taskId, f.binding.taskId],
            },
            ...memberships.map((r) => ({
              ...r,
              revision: r.revision + 1,
              missionId: "produced-message-mission",
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
      if (!issued) return yield* Effect.die("Missing produced-message sender credential");
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
        return yield* Effect.die("Missing actual mailbox recipient membership");
      const request = {
        type: "project-team.message.send" as const,
        commandId: CommandId.make("produced-assignment-message"),
        projectId,
        taskId: sender.taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: task.revision,
        specRevision: task.specRevision,
        planRevision: sender.planRevision,
        messageId: "produced-assignment-message",
        recipientId: f.binding.memberId,
        recipientTaskId: f.binding.taskId,
        expectedRecipientMembershipRevision: membership.revision,
        body: "Actual authenticated sender findings",
        evidenceIds: [],
      };
      const gateway = yield* ProjectWorkGateway;
      const source = { kind: "mcp" as const, id: "produced-mailbox-tool" };
      const receipt = yield* gateway.write(request, principal.actor, source, principal);
      expect((yield* f.messages)[0]).toMatchObject({
        senderId: sender.memberId,
        taskId: f.binding.taskId,
        status: "queued",
        deliveryCursor: 0,
      });
      const sealed = yield* f.mailbox.sealInitialAssignment({
        operationId: f.request.assignmentOperationId,
        baseSystemText: "Original required assignment",
      });
      expect(sealed.systemText).toContain(request.body);
      const input = yield* f.reserveInput;
      yield* f.mailbox.bindRequestInput({
        operationId: f.request.assignmentOperationId,
        reservationId: input.reservationId,
        encodedRequestSha256: "b".repeat(64),
      });
      yield* f.complete(f.prompt, { ...native, leafId: "produced-message-leaf" }, "success", [
        yield* input.settle,
      ]);
      expect((yield* f.mailbox.reflectAssignment(f.snapshot)).status).toBe("delivered");
      expect((yield* f.messages)[0]).toMatchObject({
        status: "delivered",
        revision: 1,
        deliveryCursor: 1,
      });
      const delivered = yield* readCurrentState(f.sql, projectId);
      expect(yield* gateway.write(request, principal.actor, source, principal)).toEqual(receipt);
      const restarted = yield* makeProjectTeamMailboxConsumption({ environmentId: "environment" });
      expect((yield* restarted.reflectAssignment(f.snapshot)).status).toBe("unchanged");
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(delivered);
      expect(originalRole.tools).toEqual([]);
      expect(f.binding.configuration.toolIds).toEqual([]);
    }).pipe(Effect.provide(ProjectWorkProjectionLive.pipe(Layer.provideMerge(gatewayRuntime)))),
);

it.effect(
  "seals only original queued messages before assignment transport without marking delivery",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.addMessage("first", "First exact message");
        const sealed = yield* f.mailbox.sealInitialAssignment({
          operationId: f.request.assignmentOperationId,
          baseSystemText: "Original system instructions",
        });
        expect(sealed.systemText).toContain("First exact message");
        expect(sealed.systemTextSha256).toBe(
          NodeCrypto.createHash("sha256").update(sealed.systemText).digest("hex"),
        );
        yield* f.addMessage("later", "Later message remains queued");
        expect(
          yield* f.mailbox.sealInitialAssignment({
            operationId: f.request.assignmentOperationId,
            baseSystemText: "Original system instructions",
          }),
        ).toEqual(sealed);
        expect(sealed.systemText).not.toContain("Later message");
        expect((yield* f.messages).map((m) => m.status)).toEqual(["queued", "queued"]);
        expect(
          (yield* f.mailbox
            .sealInitialAssignment({
              operationId: f.request.initializeOperationId,
              baseSystemText: "Original system instructions",
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect("binds a real reserved original input exactly without granting message delivery", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.addMessage("first");
      yield* f.mailbox.sealInitialAssignment({
        operationId: f.request.assignmentOperationId,
        baseSystemText: "Original instructions",
      });
      const reserved = yield* f.reserveInput;
      const input = {
        operationId: f.request.assignmentOperationId,
        reservationId: reserved.reservationId,
        encodedRequestSha256: "b".repeat(64),
      };
      const bound = yield* f.mailbox.bindRequestInput(input);
      expect(bound).toEqual({
        reservationId: reserved.reservationId,
        encodedRequestSha256: "b".repeat(64),
      });
      expect(yield* f.mailbox.bindRequestInput(input)).toEqual(bound);
      expect(
        (yield* f.mailbox
          .bindRequestInput({ ...input, encodedRequestSha256: "c".repeat(64) })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.mailbox
          .bindRequestInput({ ...input, reservationId: "invented" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.complete(f.prompt, { ...native, leafId: "done" }, "success", [
        yield* reserved.settle,
      ]);
      expect((yield* f.messages).map((m) => [m.status, m.deliveryCursor])).toEqual([["queued", 0]]);
    }),
  ),
);

it.effect(
  "binds and delivers a genuinely granted subscription assignment through its durable receipt",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment(undefined, false, "gpt-6-luna");
        yield* f.addMessage("subscription-message");
        const sealed = yield* f.mailbox.sealInitialAssignment({
          operationId: f.request.assignmentOperationId,
          baseSystemText: "Original subscription instructions",
        });
        const reserved = yield* f.reserveInput;
        expect(
          yield* f.sql`SELECT provider,accounting_mode,unknown_maximum_tokens
          FROM project_team_model_request WHERE reservation_id=${reserved.reservationId}`,
        ).toEqual([
          {
            provider: "openai-codex",
            accounting_mode: "openai-subscription-monitored",
            unknown_maximum_tokens: 64_000,
          },
        ]);
        const bound = yield* f.mailbox.bindRequestInput({
          operationId: f.request.assignmentOperationId,
          reservationId: reserved.reservationId,
          encodedRequestSha256: "d".repeat(64),
        });
        expect(bound).toEqual({
          reservationId: reserved.reservationId,
          encodedRequestSha256: "d".repeat(64),
        });
        expect(sealed.systemText).toContain("Original subscription instructions");
        expect(sealed.systemText).toContain("Review the captured task");
        yield* f.complete(f.prompt, { ...native, leafId: "subscription-delivered" }, "success", [
          yield* reserved.settle,
        ]);
        const delivered = yield* f.mailbox.reflectAssignment(f.snapshot);
        expect(delivered.status).toBe("delivered");
        if (delivered.status !== "delivered")
          return yield* Effect.die("Granted subscription assignment was not delivered");
        expect(delivered.receipt.terminal.accountingReceipts[0]).toMatchObject({
          reservationId: reserved.reservationId,
          routeId: "openai-subscription-luna",
          provider: "openai-codex",
          model: "gpt-6-luna",
        });
        expect((yield* f.messages)[0]).toMatchObject({ status: "delivered", deliveryCursor: 1 });
      }),
    ),
);

it.effect("rejects a subscription reservation owned by a foreign run", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixtureWithAssignment(undefined, false, "gpt-6-luna");
      yield* f.mailbox.sealInitialAssignment({
        operationId: f.request.assignmentOperationId,
        baseSystemText: "Original subscription instructions",
      });
      const reserved = yield* f.reserveInput;
      yield* f.sql`UPDATE project_team_model_request SET run_id=${"foreign-run"}
        WHERE reservation_id=${reserved.reservationId}`;
      expect(
        (yield* f.mailbox
          .bindRequestInput({
            operationId: f.request.assignmentOperationId,
            reservationId: reserved.reservationId,
            encodedRequestSha256: "e".repeat(64),
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* f.sql`SELECT reservation_id FROM project_team_mailbox_input`).toEqual([]);
    }),
  ),
);

it.effect("rejects a subscription reservation after its durable grant has stopped", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixtureWithAssignment(undefined, false, "gpt-6-luna");
      yield* f.mailbox.sealInitialAssignment({
        operationId: f.request.assignmentOperationId,
        baseSystemText: "Original subscription instructions",
      });
      const reserved = yield* f.reserveInput;
      expect(
        yield* f.sql`SELECT root_task_id FROM project_team_pi_subscription_grant`,
      ).toHaveLength(1);
      yield* reserved.stopSubscriptionGrant;
      expect(
        yield* f.sql`SELECT stopped_at_ms,stop_reason FROM project_team_pi_subscription_grant`,
      ).toEqual([{ stopped_at_ms: now, stop_reason: "unknown-usage" }]);
      expect(
        (yield* f.mailbox
          .bindRequestInput({
            operationId: f.request.assignmentOperationId,
            reservationId: reserved.reservationId,
            encodedRequestSha256: "f".repeat(64),
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* f.sql`SELECT reservation_id FROM project_team_mailbox_input`).toEqual([]);
    }),
  ),
);

it.effect(
  "keeps a genuinely standalone prompt unsealed without relaxing direct assignment sealing",
  () =>
    scoped(
      Effect.gen(function* () {
        yield* seed("investigator", "running", { issueCredential: false });
        const sql = yield* SqlClient.SqlClient;
        const state = yield* readCurrentState(sql, projectId);
        const role = state.foundationRecords?.find((r) => r.kind === "role-revision");
        const binding = state.foundationRecords?.find((r) => r.kind === "run-binding");
        if (role?.kind !== "role-revision" || binding?.kind !== "run-binding")
          return yield* Effect.die("Missing standalone owner");
        const fs = yield* FileSystem.FileSystem;
        const worktree = yield* fs.makeTempDirectoryScoped();
        const nativeRoot = yield* fs.makeTempDirectoryScoped();
        const protectedRoot = yield* fs.makeTempDirectoryScoped();
        yield* restoreHistoricalBinding({ ...role, model, revision: role.revision + 1 });
        yield* restoreHistoricalBinding({
          ...binding,
          revision: binding.revision + 1,
          model,
          worktree,
          configuration: {
            ...binding.configuration,
            runtimeVersion: "0.99.1",
            instructionsHash: NodeCrypto.createHash("sha256")
              .update(role.instructions)
              .digest("hex"),
          },
        });
        yield* TestClock.setTime(now);
        const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
        const request = {
          threadId,
          kind: "prompt" as const,
          operationId: "standalone-prompt",
          prompt: "Ordinary standalone work",
        };
        const allocate = Effect.gen(function* () {
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
        const initRequest = {
          threadId,
          kind: "initialize" as const,
          operationId: "standalone-initialize",
        };
        const init = yield* operations.prepare(
          { providerInstanceId, threadId },
          initRequest,
          hash(initRequest),
          {
            allocation: yield* allocate,
            workerId: "standalone-init-worker",
            operationId: initRequest.operationId,
            resourceHash: "a".repeat(64),
          },
        );
        const owner = {
          type: "owner" as const,
          unit: init.allocation.unit,
          nonce: init.allocation.nonce,
          invocation: "a".repeat(32),
          cgroup: `/sys/fs/cgroup/${init.allocation.unit}`,
          pid: 123,
          memoryBytes: init.allocation.policy.memoryBytes,
          swapBytes: 0,
          oomGroup: 1,
        };
        if (!binding.sessionId)
          return yield* Effect.die("Standalone owner has no original native session");
        const ref = { ...native, sessionId: binding.sessionId };
        yield* operations.persistence(init).claimActivation(init.allocation);
        yield* operations.persistence(init).beforeStart(owner);
        yield* operations.persistNative(init, ref);
        yield* operations.persistTerminal(init, {
          identity: { workerId: init.workerId, generation: init.authority.binding.generation },
          operation: init.operation,
          outcome: "success",
          ownerCaptured: true,
          native: ref,
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
          accountingReceipts: [],
        });
        yield* operations.prepare({ providerInstanceId, threadId }, request, hash(request), {
          allocation: yield* allocate,
          workerId: "standalone-worker",
          operationId: request.operationId,
          resourceHash: "a".repeat(64),
        });
        const mailbox = yield* makeProjectTeamMailboxConsumption({ environmentId: "environment" });
        expect(
          yield* mailbox.sealAssignmentContext({
            operationId: request.operationId,
            baseSystemText: "Standalone context",
          }),
        ).toBeUndefined();
        expect(
          (yield* mailbox
            .sealInitialAssignment({
              operationId: request.operationId,
              baseSystemText: "Standalone context",
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* sql`SELECT operation_id FROM project_team_mailbox_batch`).length).toBe(0);
      }),
    ),
);

it.effect(
  "SQLite refuses deletion and immutable mutation of valid sealed batches and bound requests",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.addMessage("first");
        const sealed = yield* f.mailbox.sealInitialAssignment({
          operationId: f.request.assignmentOperationId,
          baseSystemText: "Original instructions",
        });
        const reserved = yield* f.reserveInput;
        const input = {
          operationId: f.request.assignmentOperationId,
          reservationId: reserved.reservationId,
          encodedRequestSha256: "b".repeat(64),
        };
        const bound = yield* f.mailbox.bindRequestInput(input);
        const attempts = [
          f.sql`DELETE FROM project_team_mailbox_batch WHERE operation_id=${input.operationId}`,
          f.sql`UPDATE project_team_mailbox_batch SET manifest_sha256=${"c".repeat(64)} WHERE operation_id=${input.operationId}`,
          f.sql`UPDATE project_team_mailbox_batch SET revision=2,status='delivered' WHERE operation_id=${input.operationId}`,
          f.sql`UPDATE project_team_mailbox_batch SET revision=1,status='sealed' WHERE operation_id=${input.operationId}`,
          f.sql`DELETE FROM project_team_mailbox_input WHERE reservation_id=${input.reservationId}`,
          f.sql`UPDATE project_team_mailbox_input SET encoded_request_sha256=${"c".repeat(64)} WHERE reservation_id=${input.reservationId}`,
        ];
        for (const attempt of attempts)
          expect((yield* attempt.pipe(Effect.result))._tag).toBe("Failure");
        expect(
          yield* f.mailbox.sealInitialAssignment({
            operationId: input.operationId,
            baseSystemText: "Original instructions",
          }),
        ).toEqual(sealed);
        expect(yield* f.mailbox.bindRequestInput(input)).toEqual(bound);
      }),
    ),
);

it.effect(
  "defers messages exceeding the combined assignment budget while retaining smaller original messages",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixtureWithAssignment("A".repeat(100000));
        yield* f.addMessage("1-large", "Too large for combined context".repeat(100));
        yield* f.addMessage("2-small", "Fits original context");
        const sealed = yield* f.mailbox.sealInitialAssignment({
          operationId: f.request.assignmentOperationId,
          baseSystemText: "S".repeat(30000),
        });
        expect(sealed.systemText).toContain("Fits original context");
        expect(sealed.systemText).not.toContain("Too large for combined context");
        expect(
          Buffer.byteLength(sealed.systemText) + Buffer.byteLength(f.request.assignment),
        ).toBeLessThanOrEqual(131072);
        expect((yield* f.messages).map((m) => m.status)).toEqual(["queued", "queued"]);
      }),
    ),
);

it.effect(
  "reflects only fully accounted original consumption atomically and replays the exact commit after revision drift and revocation",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.addMessage("first", "Original retained message");
        yield* f.mailbox.sealInitialAssignment({
          operationId: f.request.assignmentOperationId,
          baseSystemText: "Original instructions",
        });
        expect((yield* f.mailbox.reflectAssignment(f.snapshot)).status).toBe("pending");
        const reserved = yield* f.reserveInput;
        yield* f.mailbox.bindRequestInput({
          operationId: f.request.assignmentOperationId,
          reservationId: reserved.reservationId,
          encodedRequestSha256: "b".repeat(64),
        });
        yield* f.addMessage("later", "Queued after the original seal");
        yield* f.complete(f.prompt, { ...native, leafId: "done" }, "success", [
          yield* reserved.settle,
        ]);
        const before = yield* f.sql<{ n: number }>`SELECT COUNT(*) AS n FROM project_work_events`;
        const observed = yield* f.mailbox.reflectAssignment(f.snapshot);
        expect(observed.status).toBe("delivered");
        if (observed.status !== "delivered")
          return yield* Effect.die("Original consumption was not committed");
        expect(observed.receipt.operation.operationId).toBe(f.request.assignmentOperationId);
        expect(observed.receipt.terminal.accountingReceipts[0]?.reservationId).toBe(
          reserved.reservationId,
        );
        expect(
          (yield* f.messages)
            .toSorted((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
            .map((m) => [m.recordId, m.status, m.revision, m.deliveryCursor]),
        ).toEqual([
          ["first", "delivered", 1, 1],
          ["later", "queued", 0, 0],
        ]);
        expect(
          (yield* f.sql<{ n: number }>`SELECT COUNT(*) AS n FROM project_work_events`)[0]?.n,
        ).toBe(before[0]!.n + 1);
        const saved =
          yield* f.sql`SELECT command_json,outcome_json FROM project_team_mailbox_reflection`;
        yield* f.addMessage("another", "Unrelated later project revision");
        const recreated = yield* makeProjectTeamMailboxConsumption({
          environmentId: "environment",
        });
        const events = yield* f.sql`SELECT event_id FROM project_work_events`;
        const receipts = yield* f.sql`SELECT command_id FROM project_work_command_receipts`;
        expect((yield* recreated.reflectAssignment(f.snapshot)).status).toBe("unchanged");
        expect(
          yield* f.sql`SELECT command_json,outcome_json FROM project_team_mailbox_reflection`,
        ).toEqual(saved);
        expect(yield* f.sql`SELECT event_id FROM project_work_events`).toEqual(events);
        expect(yield* f.sql`SELECT command_id FROM project_work_command_receipts`).toEqual(
          receipts,
        );
        const current = yield* f.operations.current({ providerInstanceId, threadId });
        let historical = yield* f.journal.readRetained(f.snapshot.fence.dispatchId);
        for (const stage of ["stopping", "settled"] as const)
          historical = yield* f.journal.readRetained(
            (yield* f.journal.advanceStage(historical.fence, {
              receiptId: `historical-${stage}`,
              stage,
              evidence: { bindingId: f.binding.recordId },
            })).fence.dispatchId,
          );
        expect((yield* recreated.reflectAssignment(historical)).status).toBe("unchanged");
        expect(yield* f.sql`SELECT event_id FROM project_work_events`).toEqual(events);
        expect(yield* f.sql`SELECT command_id FROM project_work_command_receipts`).toEqual(
          receipts,
        );
        yield* restoreHistoricalBinding({
          ...current.binding,
          status: "revoked",
          revision: current.binding.revision + 1,
        });
        const revokedEvents = yield* f.sql`SELECT event_id FROM project_work_events`;
        const revokedReceipts = yield* f.sql`SELECT command_id FROM project_work_command_receipts`;
        expect((yield* recreated.reflectAssignment(historical)).status).toBe("unchanged");
        expect(yield* f.sql`SELECT event_id FROM project_work_events`).toEqual(revokedEvents);
        expect(yield* f.sql`SELECT command_id FROM project_work_command_receipts`).toEqual(
          revokedReceipts,
        );
        expect((yield* f.messages).find((m) => m.recordId === "first")?.status).toBe("delivered");
        for (const attempt of [
          f.sql`DELETE FROM project_team_mailbox_reflection`,
          f.sql`UPDATE project_team_mailbox_reflection SET observation_sha256=${"c".repeat(64)}`,
        ])
          expect((yield* attempt.pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
);

for (const stage of ["stopping", "quarantine", "settled"] as const) {
  for (const action of ["seal", "bind", "reflect"] as const) {
    it.effect(
      `denies new ${action} when original dispatch is ${stage} despite its still-running binding`,
      () =>
        scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.addMessage("first");
            if (action !== "seal")
              yield* f.mailbox.sealInitialAssignment({
                operationId: f.request.assignmentOperationId,
                baseSystemText: "Original instructions",
              });
            const reservation = action === "bind" ? yield* f.reserveInput : undefined;
            yield* f.sql`UPDATE project_team_dispatch SET stage=${stage},revision=revision+1 WHERE dispatch_id=${f.snapshot.fence.dispatchId}`;
            const outcome =
              action === "seal"
                ? yield* f.mailbox
                    .sealInitialAssignment({
                      operationId: f.request.assignmentOperationId,
                      baseSystemText: "Original instructions",
                    })
                    .pipe(Effect.result)
                : action === "bind" && reservation
                  ? yield* f.mailbox
                      .bindRequestInput({
                        operationId: f.request.assignmentOperationId,
                        reservationId: reservation.reservationId,
                        encodedRequestSha256: "b".repeat(64),
                      })
                      .pipe(Effect.result)
                  : yield* f.mailbox
                      .reflectAssignment(yield* f.journal.readRetained(f.snapshot.fence.dispatchId))
                      .pipe(Effect.result);
            expect(outcome._tag).toBe("Failure");
            expect((yield* f.messages).map((m) => [m.status, m.deliveryCursor])).toEqual([
              ["queued", 0],
            ]);
          }),
        ),
    );
  }
}

const consumedFixture = Effect.gen(function* () {
  const f = yield* fixture;
  yield* f.addMessage("first", "Original retained message");
  yield* f.mailbox.sealInitialAssignment({
    operationId: f.request.assignmentOperationId,
    baseSystemText: "Original instructions",
  });
  const reservation = yield* f.reserveInput;
  yield* f.mailbox.bindRequestInput({
    operationId: f.request.assignmentOperationId,
    reservationId: reservation.reservationId,
    encodedRequestSha256: "b".repeat(64),
  });
  yield* f.complete(f.prompt, { ...native, leafId: "done" }, "success", [
    yield* reservation.settle,
  ]);
  return f;
});
it.effect("rolls back all qualification when the actual message projection write is ignored", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* consumedFixture;
      const events = yield* f.sql`SELECT event_id FROM project_work_events`;
      const receipts = yield* f.sql`SELECT command_id FROM project_work_command_receipts`;
      yield* f.sql`CREATE TRIGGER ignore_mailbox_message BEFORE UPDATE ON project_team_message WHEN OLD.record_id='first' BEGIN SELECT RAISE(IGNORE); END`;
      expect((yield* f.mailbox.reflectAssignment(f.snapshot).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* f.sql`SELECT event_id FROM project_work_events`).toEqual(events);
      expect(yield* f.sql`SELECT command_id FROM project_work_command_receipts`).toEqual(receipts);
      expect((yield* f.sql`SELECT operation_id FROM project_team_mailbox_reflection`).length).toBe(
        0,
      );
      yield* f.sql`DROP TRIGGER ignore_mailbox_message`;
      expect((yield* f.mailbox.reflectAssignment(f.snapshot)).status).toBe("delivered");
    }),
  ),
);
it.effect(
  "rolls back uncertainty when the original private dispatch fence changes during reflection",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.addMessage("first");
        yield* f.mailbox.sealInitialAssignment({
          operationId: f.request.assignmentOperationId,
          baseSystemText: "Original instructions",
        });
        yield* f.complete(f.prompt, { ...native, leafId: "done" }, "quarantine");
        const events = yield* f.sql`SELECT event_id FROM project_work_events`;
        yield* f.sql`CREATE TRIGGER stop_mailbox_dispatch AFTER INSERT ON project_work_events WHEN NEW.command_id LIKE 'mailbox-uncertain:%'
    BEGIN UPDATE project_team_dispatch SET stage='stopping',revision=revision+1 WHERE dispatch_id='mailbox-dispatch'; END`;
        expect((yield* f.mailbox.reflectAssignment(f.snapshot).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* f.sql`SELECT event_id FROM project_work_events`).toEqual(events);
        expect(
          (yield* f.sql`SELECT operation_id FROM project_team_mailbox_reflection`).length,
        ).toBe(0);
        yield* f.sql`DROP TRIGGER stop_mailbox_dispatch`;
        expect((yield* f.mailbox.reflectAssignment(f.snapshot)).status).toBe("uncertain");
      }),
    ),
);

for (const outcome of ["failed", "canceled", "quarantine"] as const) {
  it.effect(
    `retains actual terminal ${outcome} as uncertainty with exact replay and no acknowledgement or task advancement`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.addMessage("first");
          yield* f.mailbox.sealInitialAssignment({
            operationId: f.request.assignmentOperationId,
            baseSystemText: "Original instructions",
          });
          yield* f.complete(f.prompt, { ...native, leafId: "done" }, outcome);
          const tasks = (yield* readCurrentState(f.sql, projectId)).tasks;
          expect((yield* f.mailbox.reflectAssignment(f.snapshot)).status).toBe("uncertain");
          const messages = yield* f.messages;
          expect(
            messages.map((m) => [
              m.status,
              m.revision,
              m.deliveryCursor,
              m.acknowledgedAt,
              m.resolvedAt,
            ]),
          ).toEqual([["uncertain", 1, 1, undefined, undefined]]);
          const events = yield* f.sql`SELECT event_id FROM project_work_events`;
          const commands = yield* f.sql`SELECT command_id FROM project_work_command_receipts`;
          const recreated = yield* makeProjectTeamMailboxConsumption({
            environmentId: "environment",
          });
          expect((yield* recreated.reflectAssignment(f.snapshot)).status).toBe("uncertain");
          expect(yield* f.sql`SELECT event_id FROM project_work_events`).toEqual(events);
          expect(yield* f.sql`SELECT command_id FROM project_work_command_receipts`).toEqual(
            commands,
          );
          expect((yield* readCurrentState(f.sql, projectId)).tasks).toEqual(tasks);
          const owner = yield* f.operations.current({ providerInstanceId, threadId });
          yield* restoreHistoricalBinding({
            ...owner.binding,
            status: "revoked",
            revision: owner.binding.revision + 1,
          });
          expect((yield* recreated.reflectAssignment(f.snapshot).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect(yield* f.messages).toEqual(messages);
        }),
      ),
  );
}
it.effect("denies new successful consumption after original ownership is revoked", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* consumedFixture;
      const owner = yield* f.operations.current({ providerInstanceId, threadId });
      yield* restoreHistoricalBinding({
        ...owner.binding,
        status: "revoked",
        revision: owner.binding.revision + 1,
      });
      expect((yield* f.mailbox.reflectAssignment(f.snapshot).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* f.messages).map((m) => [m.status, m.deliveryCursor])).toEqual([["queued", 0]]);
      expect(yield* f.sql`SELECT operation_id FROM project_team_mailbox_reflection`).toEqual([]);
    }),
  ),
);
it.effect(
  "captures all request identities synchronously and denies foreign or inherited SQL ownership",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.addMessage("first");
        const input = {
          operationId: f.request.assignmentOperationId,
          baseSystemText: "Captured original text",
        };
        const sealing = f.mailbox.sealAssignmentContext(input);
        input.operationId = f.request.initializeOperationId;
        input.baseSystemText = "Mutated caller text";
        const sealed = yield* sealing;
        expect(sealed?.systemText).toContain("Captured original text");
        expect(sealed?.systemText).not.toContain("Mutated caller text");
        const reservation = yield* f.reserveInput;
        const binding = {
          operationId: f.request.assignmentOperationId,
          reservationId: reservation.reservationId,
          encodedRequestSha256: "b".repeat(64),
        };
        const bindingEffect = f.mailbox.bindRequestInput(binding);
        binding.reservationId = "mutated";
        binding.encodedRequestSha256 = "c".repeat(64);
        expect((yield* bindingEffect).encodedRequestSha256).toBe("b".repeat(64));
        const actions = [
          f.mailbox
            .sealInitialAssignment({
              operationId: f.request.assignmentOperationId,
              baseSystemText: "Captured original text",
            })
            .pipe(Effect.asVoid),
          f.mailbox
            .sealAssignmentContext({
              operationId: f.request.assignmentOperationId,
              baseSystemText: "Captured original text",
            })
            .pipe(Effect.asVoid),
          f.mailbox
            .bindRequestInput({
              operationId: f.request.assignmentOperationId,
              reservationId: reservation.reservationId,
              encodedRequestSha256: "b".repeat(64),
            })
            .pipe(Effect.asVoid),
          f.mailbox.reflectAssignment(f.snapshot).pipe(Effect.asVoid),
        ];
        for (const action of actions) {
          expect((yield* f.sql.withTransaction(action.pipe(Effect.result)))._tag).toBe("Failure");
          expect(
            (yield* action.pipe(
              Effect.provideService(SqlClient.SqlClient, { ...f.sql }),
              Effect.result,
            ))._tag,
          ).toBe("Failure");
          expect(
            (yield* action.pipe(
              Effect.updateContext((context: Context.Context<never>) =>
                Context.omit(SqlClient.SqlClient)(context),
              ),
              Effect.result,
            ))._tag,
          ).toBe("Failure");
        }
        yield* f.complete(f.prompt, { ...native, leafId: "done" }, "success", [
          yield* reservation.settle,
        ]);
        const snapshot = { fence: { ...f.snapshot.fence }, intent: { ...f.snapshot.intent } };
        const reflection = f.mailbox.reflectAssignment(snapshot);
        snapshot.fence.revision += 1;
        expect((yield* reflection).status).toBe("delivered");
      }),
    ),
);
it.effect(
  "seals no more than 64 original messages and never absorbs later messages into an empty seal",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const empty = yield* f.mailbox.sealInitialAssignment({
          operationId: f.request.assignmentOperationId,
          baseSystemText: "Empty original context",
        });
        yield* f.addMessage("later");
        expect(
          yield* f.mailbox.sealInitialAssignment({
            operationId: f.request.assignmentOperationId,
            baseSystemText: "Empty original context",
          }),
        ).toEqual(empty);
        expect(empty.systemText).toBe("Empty original context");
        const reservation = yield* f.reserveInput;
        yield* f.mailbox.bindRequestInput({
          operationId: f.request.assignmentOperationId,
          reservationId: reservation.reservationId,
          encodedRequestSha256: "b".repeat(64),
        });
        yield* f.complete(f.prompt, { ...native, leafId: "done" }, "success", [
          yield* reservation.settle,
        ]);
        const events = yield* f.sql`SELECT event_id FROM project_work_events`;
        expect((yield* f.mailbox.reflectAssignment(f.snapshot)).status).toBe("delivered");
        expect((yield* f.mailbox.reflectAssignment(f.snapshot)).status).toBe("unchanged");
        expect(yield* f.sql`SELECT event_id FROM project_work_events`).toEqual(events);
        expect((yield* f.messages).map((m) => m.status)).toEqual(["queued"]);
      }),
    ),
);
it.effect("defers the 65th original message without dropping any queued record", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let i = 0; i < 65; i++)
        yield* f.addMessage(`message-${String(i).padStart(2, "0")}`, `Literal message ${i}`);
      const sealed = yield* f.mailbox.sealInitialAssignment({
        operationId: f.request.assignmentOperationId,
        baseSystemText: "Original context",
      });
      expect(sealed.systemText).toContain('"messageId":"message-63"');
      expect(sealed.systemText).not.toContain('"messageId":"message-64"');
      const reservation = yield* f.reserveInput;
      yield* f.mailbox.bindRequestInput({
        operationId: f.request.assignmentOperationId,
        reservationId: reservation.reservationId,
        encodedRequestSha256: "b".repeat(64),
      });
      yield* f.complete(f.prompt, { ...native, leafId: "done" }, "success", [
        yield* reservation.settle,
      ]);
      expect((yield* f.mailbox.reflectAssignment(f.snapshot)).status).toBe("delivered");
      const messages = yield* f.messages;
      expect(messages.filter((m) => m.status === "delivered")).toHaveLength(64);
      expect(messages.filter((m) => m.status === "queued").map((m) => m.recordId)).toEqual([
        "message-64",
      ]);
    }),
  ),
);
it.effect("rejects excess fields and byte overflow before any custody write", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const input of [
        { operationId: f.request.assignmentOperationId, baseSystemText: "x".repeat(65537) },
        {
          operationId: f.request.assignmentOperationId,
          baseSystemText: "ok",
          recipientId: f.binding.memberId,
        },
      ])
        expect((yield* f.mailbox.sealInitialAssignment(input).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      expect((yield* f.mailbox.reflectAssignment(f.snapshot).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* f.sql`SELECT operation_id FROM project_team_mailbox_batch`).toEqual([]);
    }),
  ),
);
for (const corrupt of ["missing", "system-hash"] as const) {
  it.effect(`denies fully successful native consumption with ${corrupt} retained input`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* consumedFixture;
        const events = yield* f.sql`SELECT event_id FROM project_work_events`;
        if (corrupt === "missing") {
          yield* f.sql`DROP TRIGGER project_team_mailbox_input_retained`;
          yield* f.sql`DELETE FROM project_team_mailbox_input`;
        } else {
          yield* f.sql`DROP TRIGGER project_team_mailbox_input_immutable`;
          yield* f.sql`UPDATE project_team_mailbox_input SET system_text_sha256=${"c".repeat(64)}`;
        }
        expect((yield* f.mailbox.reflectAssignment(f.snapshot).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* f.sql`SELECT event_id FROM project_work_events`).toEqual(events);
        expect((yield* f.messages).map((m) => m.status)).toEqual(["queued"]);
      }),
    ),
  );
}
it.effect(
  "rolls back reflection when the batch compare-and-swap is ignored and exact retry succeeds",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* consumedFixture;
        const events = yield* f.sql`SELECT event_id FROM project_work_events`;
        const receipts = yield* f.sql`SELECT command_id FROM project_work_command_receipts`;
        yield* f.sql`CREATE TRIGGER ignore_mailbox_batch BEFORE UPDATE ON project_team_mailbox_batch BEGIN SELECT RAISE(IGNORE); END`;
        expect((yield* f.mailbox.reflectAssignment(f.snapshot).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* f.sql`SELECT event_id FROM project_work_events`).toEqual(events);
        expect(yield* f.sql`SELECT command_id FROM project_work_command_receipts`).toEqual(
          receipts,
        );
        expect(yield* f.sql`SELECT operation_id FROM project_team_mailbox_reflection`).toEqual([]);
        yield* f.sql`DROP TRIGGER ignore_mailbox_batch`;
        expect((yield* f.mailbox.reflectAssignment(f.snapshot)).status).toBe("delivered");
      }),
    ),
);
it.effect("failed owning COMMIT automatically rolls back reflection and exact retry works", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* consumedFixture;
      const query = yield* ProjectWorkQuery;
      const before = yield* query.listFoundationRecords({ projectId, kinds: ["message"] });
      const beforeMessages = yield* f.messages;
      const beforeExport = yield* query.exportSnapshot(projectId, false, true);
      const beforeEvents =
        yield* f.sql`SELECT event_id,command_id FROM project_work_events ORDER BY event_id`;
      const beforeReceipts =
        yield* f.sql`SELECT command_id FROM project_work_command_receipts ORDER BY command_id`;
      yield* f.sql`PRAGMA foreign_keys=ON`;
      yield* f.sql`CREATE TABLE mailbox_commit_parent(id TEXT PRIMARY KEY)`;
      yield* f.sql`CREATE TABLE mailbox_commit_child(id TEXT REFERENCES mailbox_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      yield* f.sql`CREATE TRIGGER fail_mailbox_commit AFTER UPDATE ON project_team_mailbox_batch WHEN NEW.status='delivered' BEGIN INSERT INTO mailbox_commit_child VALUES('missing'); END`;
      let escaped = false;
      const failedReflection = f.mailbox.reflectAssignment(f.snapshot).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            escaped = true;
          }),
        ),
        Effect.exit,
      );
      expect((yield* failedReflection)._tag).toBe("Failure");
      expect(escaped).toBe(false);
      expect(yield* f.sql`SELECT status FROM project_team_mailbox_batch`).toEqual([
        { status: "sealed" },
      ]);
      expect(yield* f.sql`SELECT operation_id FROM project_team_mailbox_reflection`).toEqual([]);
      expect(
        yield* f.sql`SELECT event_id,command_id FROM project_work_events ORDER BY event_id`,
      ).toEqual(beforeEvents);
      expect(
        yield* f.sql`SELECT command_id FROM project_work_command_receipts ORDER BY command_id`,
      ).toEqual(beforeReceipts);
      expect(yield* f.messages).toEqual(beforeMessages);
      expect(yield* query.listFoundationRecords({ projectId, kinds: ["message"] })).toEqual(before);
      expect(yield* query.exportSnapshot(projectId, false, true)).toEqual(beforeExport);
      expect((yield* f.mailbox.reflectAssignment(f.snapshot).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(yield* f.sql`SELECT status FROM project_team_mailbox_batch`).toEqual([
        { status: "sealed" },
      ]);
      yield* f.sql`DROP TRIGGER fail_mailbox_commit`;
      expect((yield* f.mailbox.reflectAssignment(f.snapshot)).status).toBe("delivered");
      expect(
        (yield* f.messages).map((message) => [message.status, message.deliveryCursor]),
      ).toEqual([["delivered", 1]]);
    }),
  ),
);

for (const corrupt of ["canonical", "hash", "oversize"] as const) {
  it.effect(`denies ${corrupt} sealed batch corruption before any delivery write`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* consumedFixture;
        const rows = yield* f.sql<{
          manifest_json: string;
        }>`SELECT manifest_json FROM project_team_mailbox_batch`;
        const original = rows[0]?.manifest_json;
        if (!original) return yield* Effect.die("Missing valid original batch");
        yield* f.sql`DROP TRIGGER project_team_mailbox_batch_transition`;
        if (corrupt === "hash")
          yield* f.sql`UPDATE project_team_mailbox_batch SET manifest_sha256=${"c".repeat(64)}`;
        else {
          const replacement =
            corrupt === "canonical"
              ? ` ${original}`
              : yield* encodePaddingJson({ padding: "x".repeat(262145) });
          if (corrupt === "oversize") yield* f.sql`PRAGMA ignore_check_constraints=ON`;
          yield* f.sql`UPDATE project_team_mailbox_batch SET manifest_json=${replacement},manifest_sha256=${NodeCrypto.createHash("sha256").update(replacement).digest("hex")}`;
        }
        const events = yield* f.sql`SELECT event_id FROM project_work_events`;
        expect((yield* f.mailbox.reflectAssignment(f.snapshot).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        expect(yield* f.sql`SELECT event_id FROM project_work_events`).toEqual(events);
        expect(yield* f.sql`SELECT operation_id FROM project_team_mailbox_reflection`).toEqual([]);
        expect((yield* f.messages).map((m) => m.status)).toEqual(["queued"]);
      }),
    ),
  );
}
