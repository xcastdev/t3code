import {
  EnvironmentId,
  ProjectId,
  ProjectTeamMember,
  ProjectTeamMessage,
  ProjectTeamRunBinding,
  ProjectTeamTaskMembership,
  ProjectWorkAttemptId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
  type ProjectWorkTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyMessageReceipt, planMessageDelivery } from "./ProjectTeamMailboxPolicy.ts";

type Message = typeof ProjectTeamMessage.Type;
type Member = typeof ProjectTeamMember.Type;
type Run = typeof ProjectTeamRunBinding.Type;
type Membership = typeof ProjectTeamTaskMembership.Type;
const projectId = ProjectId.make("project-a");
const otherProject = ProjectId.make("project-b");
const taskId = ProjectWorkTaskId.make("task-a");
const attemptId = ProjectWorkAttemptId.make("attempt-a");
const now = "2026-10-01T00:00:00.000Z";
const later = "2026-10-01T00:01:00.000Z";
const fields = { projectId, revision: 0, generation: 0, updatedAt: now };
const message = (overrides: Partial<Message> = {}): Message => ({
  ...fields,
  recordId: "message-a",
  kind: "message",
  status: "queued",
  commandId: "send-a",
  senderId: "sender",
  recipientId: "recipient",
  taskId,
  body: "Please inspect the attached finding",
  evidenceIds: ["finding-a"],
  deliveryGeneration: 0,
  deliveryCursor: 0,
  ...overrides,
});
const member = (overrides: Partial<Member> = {}): Member => ({
  ...fields,
  recordId: "recipient",
  kind: "member",
  status: "active",
  name: "Recipient",
  coordinator: false,
  roleRevisionId: "role-a",
  ...overrides,
});
const run = (overrides: Partial<Run> = {}): Run => ({
  ...fields,
  recordId: "run-a",
  generation: 7,
  kind: "run-binding",
  status: "running",
  taskId,
  attemptId,
  memberId: "recipient",
  roleRevisionId: "role-a",
  providerInstanceId: ProviderInstanceId.make("pi-a"),
  threadId: ThreadId.make("thread-a"),
  environmentId: EnvironmentId.make("environment-a"),
  model: "model-a",
  configuration: {
    instructionsHash: "instructions-a",
    toolIds: [],
    skillIds: [],
    runtimeVersion: "0.99.1",
    maxTokens: 100,
    maxDurationMs: 1_000,
    paidFallback: false,
  },
  worktree: "/sandbox/worktree-a",
  branch: "worker-a",
  leaseGeneration: 7,
  specRevision: 1,
  planRevision: 1,
  ...overrides,
});
const membership = (overrides: Partial<Membership> = {}): Membership => ({
  ...fields,
  recordId: "membership-a",
  kind: "task-membership",
  status: "active",
  taskId,
  missionId: "mission-a",
  executionKind: "managed",
  deliverableKind: "research",
  controlState: "active",
  ...overrides,
});
const task = (overrides: Partial<ProjectWorkTask> = {}): ProjectWorkTask => ({
  projectId,
  taskId,
  title: "Inspect finding",
  state: "in-progress",
  revision: 1,
  specRevision: 1,
  activeAttemptId: attemptId,
  watchers: [],
  createdAt: now,
  updatedAt: now,
  ...overrides,
});
const current = () => ({
  member: member(),
  runBinding: run(),
  taskMembership: membership(),
  task: task(),
});
const candidate = () => ({ ...current(), safeTurnBoundary: true });
const target = {
  projectId,
  messageId: "message-a",
  messageRevision: 0,
  runBindingRecordId: "run-a",
  attemptId,
  bindingGeneration: 7,
  leaseGeneration: 7,
  deliveryGeneration: 7,
  deliveryCursor: 1,
};
const receipt = () => ({
  ...target,
  expectedMessageRevision: 0,
  status: "delivered" as const,
  at: later,
});
const apply = (
  entry: Message,
  status: "delivered" | "acknowledged" | "resolved" | "uncertain",
  at = later,
) => {
  const result = applyMessageReceipt({
    message: entry,
    current: current(),
    recordedTarget: target,
    receipt: { ...receipt(), status, at, expectedMessageRevision: entry.revision },
  });
  if (!result.accepted) throw new Error(result.reason);
  return result.message;
};

describe("planMessageDelivery", () => {
  it("proposes a fenced delivery at a safe boundary without changing the queued message", () => {
    const queued = message();
    expect(
      planMessageDelivery({ projectId, messages: [queued], candidates: [candidate()] }),
    ).toEqual({ accepted: true, deliveries: [{ message: queued, target }], deferred: [] });
    expect(queued).toEqual(message());
  });

  it("uses stable record order regardless of caller array order", () => {
    const a = message();
    const b = message({ recordId: "message-b", commandId: "send-b", deliveryCursor: 4 });
    const inputs = [b, a];
    const result = planMessageDelivery({ projectId, messages: inputs, candidates: [candidate()] });
    expect(result.accepted && result.deliveries.map((entry) => entry.target.messageId)).toEqual([
      "message-a",
      "message-b",
    ]);
    expect(
      result.accepted && result.deliveries.map((entry) => entry.target.deliveryCursor),
    ).toEqual([1, 5]);
    expect(inputs).toEqual([b, a]);
  });

  it("permits mission scope only through the current run's active task membership", () => {
    const { taskId: _taskId, ...unscoped } = message();
    const missionMessage = { ...unscoped, missionId: "mission-a" };
    expect(
      planMessageDelivery({ projectId, messages: [missionMessage], candidates: [candidate()] }),
    ).toMatchObject({ accepted: true, deliveries: [{ target }], deferred: [] });
    for (const entry of [unscoped, { ...missionMessage, missionId: "mission-other" }]) {
      expect(
        planMessageDelivery({ projectId, messages: [entry], candidates: [candidate()] }),
      ).toMatchObject({ accepted: true, deliveries: [], deferred: [{ messageId: "message-a" }] });
    }
  });

  it.each([
    message({ projectId: otherProject }),
    message({ recipientId: "someone-else" }),
    message({ taskId: ProjectWorkTaskId.make("task-other") }),
    message({ missionId: "mission-other" }),
  ])("does not cross a message's project, recipient, task, or mission", (entry) => {
    expect(
      planMessageDelivery({ projectId, messages: [entry], candidates: [candidate()] }),
    ).toMatchObject({ accepted: true, deliveries: [], deferred: [{ messageId: "message-a" }] });
  });

  it.each([
    { ...candidate(), member: member({ projectId: otherProject }) },
    { ...candidate(), member: member({ recordId: "someone-else" }) },
    { ...candidate(), runBinding: run({ projectId: otherProject }) },
    { ...candidate(), runBinding: run({ memberId: "someone-else" }) },
    { ...candidate(), runBinding: run({ taskId: ProjectWorkTaskId.make("task-other") }) },
    { ...candidate(), taskMembership: membership({ projectId: otherProject }) },
    {
      ...candidate(),
      taskMembership: membership({ taskId: ProjectWorkTaskId.make("task-other") }),
    },
    { ...candidate(), task: task({ projectId: otherProject }) },
    { ...candidate(), task: task({ taskId: ProjectWorkTaskId.make("task-other") }) },
    { ...candidate(), task: task({ activeAttemptId: ProjectWorkAttemptId.make("attempt-old") }) },
  ])("does not accept a mismatched current candidate record", (entry) => {
    expect(
      planMessageDelivery({ projectId, messages: [message()], candidates: [entry] }),
    ).toMatchObject({ accepted: true, deliveries: [], deferred: [{ messageId: "message-a" }] });
  });

  it.each([
    { ...candidate(), safeTurnBoundary: false },
    { ...candidate(), member: member({ status: "paused" }) },
    { ...candidate(), member: member({ status: "retired" }) },
    ...(["reserved", "stopping", "settled", "revoked", "quarantined"] as const).map((status) => ({
      ...candidate(),
      runBinding: run({ status }),
    })),
    { ...candidate(), taskMembership: membership({ status: "removed" }) },
    { ...candidate(), taskMembership: membership({ executionKind: "legacy" }) },
    { ...candidate(), taskMembership: membership({ executionKind: "human" }) },
    ...(["deferred", "paused", "canceling", "canceled"] as const).map((controlState) => ({
      ...candidate(),
      taskMembership: membership({ controlState }),
    })),
    ...(["ready", "blocked", "completed", "failed", "canceled"] as const).map((state) => ({
      ...candidate(),
      task: task({ state }),
    })),
  ])("defers unsafe, inactive, stopped, or canceled recipients", (entry) => {
    expect(
      planMessageDelivery({ projectId, messages: [message()], candidates: [entry] }),
    ).toMatchObject({ accepted: true, deliveries: [], deferred: [{ messageId: "message-a" }] });
  });

  it("denies ambiguous current targets rather than choosing an array entry", () => {
    const replacement = { ...candidate(), runBinding: run({ recordId: "run-b" }) };
    for (const entries of [
      [candidate(), replacement],
      [replacement, candidate()],
    ]) {
      expect(
        planMessageDelivery({ projectId, messages: [message()], candidates: entries }),
      ).toMatchObject({
        accepted: true,
        deliveries: [],
        deferred: [{ reason: "ambiguous-target" }],
      });
    }
  });

  it.each(["delivered", "acknowledged", "resolved", "uncertain", "canceled"] as const)(
    "never automatically redelivers %s messages",
    (status) => {
      expect(
        planMessageDelivery({
          projectId,
          messages: [message({ status })],
          candidates: [candidate()],
        }),
      ).toMatchObject({ accepted: true, deliveries: [], deferred: [{ messageId: "message-a" }] });
    },
  );

  it("accepts the bounded page and denies overflow rather than truncating", () => {
    const entries = Array.from({ length: 128 }, (_, i) =>
      message({ recordId: `message-${i}`, commandId: `send-${i}` }),
    );
    const result = planMessageDelivery({ projectId, messages: entries, candidates: [candidate()] });
    expect(result.accepted && result.deliveries.length).toBe(128);
    expect(
      planMessageDelivery({ projectId, messages: [...entries, message()], candidates: [] }),
    ).toEqual({
      accepted: false,
      reason: "invalid-input",
    });
    expect(
      planMessageDelivery({
        projectId,
        messages: [],
        candidates: Array.from({ length: 129 }, candidate),
      }),
    ).toEqual({
      accepted: false,
      reason: "invalid-input",
    });
    const candidates = [
      candidate(),
      ...Array.from({ length: 127 }, (_, index) => {
        const memberId = `other-member-${index}`;
        return {
          ...candidate(),
          member: member({ recordId: memberId }),
          runBinding: run({ memberId }),
        };
      }),
    ];
    expect(planMessageDelivery({ projectId, messages: [message()], candidates })).toMatchObject({
      accepted: true,
      deliveries: [{ target }],
      deferred: [],
    });
  });

  it("rejects oversized input before inspecting any candidate or message record", () => {
    const messages = Array.from({ length: 129 }, () => message());
    const candidates = Array.from({ length: 129 }, () => candidate());
    for (const entries of [messages, candidates]) {
      Object.defineProperty(entries, 0, {
        get: () => {
          throw new Error("oversized record inspected");
        },
      });
    }
    expect(planMessageDelivery({ projectId, messages, candidates: [] })).toEqual({
      accepted: false,
      reason: "invalid-input",
    });
    expect(planMessageDelivery({ projectId, messages: [], candidates })).toEqual({
      accepted: false,
      reason: "invalid-input",
    });
  });

  it.each([
    message({ revision: -1 }),
    message({ deliveryCursor: NaN }),
    message({ body: "x".repeat(32_001) }),
    message({ senderId: "" }),
  ])("denies invalid schemas before planning", (entry) => {
    expect(
      planMessageDelivery({ projectId, messages: [entry], candidates: [candidate()] }),
    ).toEqual({
      accepted: false,
      reason: "invalid-input",
    });
  });

  it("rejects duplicate message identity and cursor/revision exhaustion", () => {
    expect(
      planMessageDelivery({
        projectId,
        messages: [message(), message()],
        candidates: [candidate()],
      }),
    ).toEqual({
      accepted: false,
      reason: "ambiguous-message",
    });
    for (const entry of [
      message({ deliveryCursor: Number.MAX_SAFE_INTEGER }),
      message({ revision: Number.MAX_SAFE_INTEGER }),
    ]) {
      expect(
        planMessageDelivery({ projectId, messages: [entry], candidates: [candidate()] }),
      ).toMatchObject({
        accepted: true,
        deliveries: [],
        deferred: [{ reason: "counter-exhausted" }],
      });
    }
  });
});

describe("applyMessageReceipt", () => {
  it("keeps delivery, consumption acknowledgment, and resolution as distinct transitions", () => {
    const queued = message();
    const delivered = apply(queued, "delivered");
    expect(delivered).toEqual({
      ...queued,
      status: "delivered",
      revision: 1,
      deliveryGeneration: 7,
      deliveryCursor: 1,
      updatedAt: later,
    });
    expect(delivered.acknowledgedAt).toBeUndefined();
    expect(delivered.resolvedAt).toBeUndefined();
    const acknowledged = apply(delivered, "acknowledged");
    expect(acknowledged).toEqual({
      ...delivered,
      status: "acknowledged",
      revision: 2,
      acknowledgedAt: later,
    });
    expect(acknowledged.resolvedAt).toBeUndefined();
    expect(apply(acknowledged, "resolved")).toEqual({
      ...acknowledged,
      status: "resolved",
      revision: 3,
      resolvedAt: later,
    });
    expect(queued).toEqual(message());
  });

  it.each(["delivered", "acknowledged", "resolved", "uncertain"] as const)(
    "returns the same record for an exact latest duplicate %s receipt",
    (status) => {
      let prior = message();
      if (status === "acknowledged" || status === "resolved") prior = apply(prior, "delivered");
      if (status === "resolved") prior = apply(prior, "acknowledged");
      const entry = apply(prior, status);
      const result = applyMessageReceipt({
        message: entry,
        current: current(),
        recordedTarget: target,
        receipt: { ...receipt(), status, expectedMessageRevision: prior.revision },
      });
      expect(result).toEqual({ accepted: true, changed: false, message: entry });
      expect(result.accepted && result.message).toBe(entry);
    },
  );

  it("rejects historic receipts after a newer phase rather than inventing receipt history", () => {
    const resolved = apply(apply(apply(message(), "delivered"), "acknowledged"), "resolved");
    for (const status of ["delivered", "acknowledged"] as const) {
      expect(
        applyMessageReceipt({
          message: resolved,
          current: current(),
          recordedTarget: target,
          receipt: {
            ...receipt(),
            status,
            expectedMessageRevision: status === "delivered" ? 0 : 1,
          },
        }),
      ).toMatchObject({ accepted: false });
    }
    for (const expectedMessageRevision of [0, 1, 3, 4]) {
      expect(
        applyMessageReceipt({
          message: resolved,
          current: current(),
          recordedTarget: target,
          receipt: { ...receipt(), status: "resolved", expectedMessageRevision },
        }),
      ).toMatchObject({ accepted: false });
    }
  });

  it("does not confuse a same-status receipt with a different timestamp for a duplicate", () => {
    expect(
      applyMessageReceipt({
        message: apply(message(), "delivered"),
        current: current(),
        recordedTarget: target,
        receipt: { ...receipt(), at: now },
      }),
    ).toMatchObject({ accepted: false });
  });

  it.each([
    { ...receipt(), projectId: otherProject },
    { ...receipt(), messageId: "other-message" },
    { ...receipt(), runBindingRecordId: "old-run" },
    { ...receipt(), attemptId: ProjectWorkAttemptId.make("old-attempt") },
    { ...receipt(), bindingGeneration: 1 },
    { ...receipt(), leaseGeneration: 6 },
    { ...receipt(), deliveryGeneration: 6 },
    { ...receipt(), deliveryCursor: 2 },
    { ...receipt(), expectedMessageRevision: 1 },
  ])("rejects stale receipt identity, revision, generation, or cursor", (entry) => {
    expect(
      applyMessageReceipt({
        message: message(),
        current: current(),
        recordedTarget: target,
        receipt: entry,
      }),
    ).toMatchObject({ accepted: false });
  });

  it("requires a trusted durable target and its original enqueue revision", () => {
    for (const recordedTarget of [
      undefined,
      { ...target, messageRevision: 1 },
      { ...target, deliveryCursor: 2 },
    ]) {
      expect(
        applyMessageReceipt({
          message: message(),
          current: current(),
          recordedTarget,
          receipt: receipt(),
        }),
      ).toMatchObject({ accepted: false });
    }
    expect(
      applyMessageReceipt({
        message: message(),
        current: current(),
        recordedTarget: { ...target, deliveryCursor: 2 },
        receipt: { ...receipt(), deliveryCursor: 2 },
      }),
    ).toMatchObject({ accepted: false });
  });

  it.each([
    {
      ...current(),
      runBinding: run({
        recordId: "replacement",
        attemptId: ProjectWorkAttemptId.make("replacement-attempt"),
      }),
      task: task({ activeAttemptId: ProjectWorkAttemptId.make("replacement-attempt") }),
    },
    { ...current(), runBinding: run({ generation: 1 }) },
    { ...current(), runBinding: run({ leaseGeneration: 8 }) },
    { ...current(), runBinding: run({ status: "revoked" }) },
    { ...current(), member: member({ status: "paused" }) },
    { ...current(), taskMembership: membership({ controlState: "canceled" }) },
    { ...current(), task: task({ state: "canceled" }) },
  ])("does not apply an old ACK to replacement, inactive, or canceled work", (entry) => {
    const delivered = apply(message(), "delivered");
    expect(
      applyMessageReceipt({
        message: delivered,
        current: entry,
        recordedTarget: target,
        receipt: { ...receipt(), status: "acknowledged", expectedMessageRevision: 1 },
      }),
    ).toMatchObject({ accepted: false });
    const acknowledged = apply(delivered, "acknowledged");
    expect(
      applyMessageReceipt({
        message: acknowledged,
        current: entry,
        recordedTarget: target,
        receipt: { ...receipt(), status: "resolved", expectedMessageRevision: 2 },
      }),
    ).toMatchObject({ accepted: false });
  });

  it.each(["acknowledged", "resolved"] as const)("rejects out-of-order %s", (status) => {
    expect(
      applyMessageReceipt({
        message: message(),
        current: current(),
        recordedTarget: target,
        receipt: { ...receipt(), status },
      }),
    ).toMatchObject({ accepted: false });
  });

  it("preserves uncertain delivery identity and requires delivery reconciliation before acknowledgment", () => {
    const uncertain = apply(message(), "uncertain");
    expect(uncertain).toEqual({
      ...message(),
      status: "uncertain",
      revision: 1,
      updatedAt: later,
      deliveryCursor: 1,
      deliveryGeneration: 7,
    });
    for (const status of ["acknowledged", "resolved"] as const) {
      expect(
        applyMessageReceipt({
          message: uncertain,
          current: current(),
          recordedTarget: target,
          receipt: { ...receipt(), status, expectedMessageRevision: 1 },
        }),
      ).toMatchObject({ accepted: false });
    }
  });

  it.each(["resolved", "canceled"] as const)("cannot redeliver %s", (status) => {
    const entry = message({ status, deliveryGeneration: 7, deliveryCursor: 1, revision: 3 });
    expect(
      applyMessageReceipt({
        message: entry,
        current: current(),
        recordedTarget: target,
        receipt: { ...receipt(), expectedMessageRevision: 3 },
      }),
    ).toMatchObject({ accepted: false });
  });

  it("rejects message cursor/generation mismatches, invalid schemas, and overflow", () => {
    const delivered = apply(message(), "delivered");
    for (const entry of [
      { ...delivered, deliveryCursor: 2 },
      { ...delivered, deliveryGeneration: 6 },
      { ...delivered, revision: Number.MAX_SAFE_INTEGER },
      { ...delivered, revision: -1 },
    ]) {
      expect(
        applyMessageReceipt({
          message: entry,
          current: current(),
          recordedTarget: target,
          receipt: {
            ...receipt(),
            status: "acknowledged",
            expectedMessageRevision: entry.revision,
          },
        }),
      ).toMatchObject({ accepted: false });
    }
    for (const entry of [
      { ...receipt(), expectedMessageRevision: NaN },
      { ...receipt(), deliveryCursor: -1 },
    ]) {
      expect(
        applyMessageReceipt({
          message: message(),
          current: current(),
          recordedTarget: target,
          receipt: entry,
        }),
      ).toMatchObject({ accepted: false });
    }
  });
});

it("reconciles uncertain delivery only for the same current original target", () => {
  const uncertain = apply(message(), "uncertain");
  const input = {
    message: uncertain,
    current: current(),
    recordedTarget: target,
    receipt: { ...receipt(), expectedMessageRevision: uncertain.revision },
  };
  expect(applyMessageReceipt(input)).toMatchObject({
    accepted: true,
    changed: true,
    message: { status: "delivered", revision: 2, deliveryCursor: 1 },
  });
  expect(
    applyMessageReceipt({
      ...input,
      current: { ...current(), runBinding: run({ generation: 8 }) },
    }),
  ).toMatchObject({ accepted: false });
  expect(
    applyMessageReceipt({ ...input, receipt: { ...input.receipt, deliveryCursor: 2 } }),
  ).toMatchObject({ accepted: false });
});
