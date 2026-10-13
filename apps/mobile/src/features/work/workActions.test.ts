import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectTeamRecordRead,
  ProjectWorkAction,
  ProjectWorkTaskContext,
  ProjectWorkWriteIntent,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { combineProjectWorkFoundationPages } from "@t3tools/client-runtime/project-work";
import { createWorkActionSession, reviewMobileWork } from "./workActions";
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, input: string) =>
    NodeCrypto.createHash("sha256").update(input).digest("hex"),
}));

const projectId = ProjectId.make("project-a");
const environmentId = EnvironmentId.make("environment-a");
const at = "2026-10-03T10:00:00.000Z";
const decodeContext = Schema.decodeUnknownSync(ProjectWorkTaskContext);
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecordRead);
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const actions = Object.fromEntries(
  ProjectWorkAction.literals.map((action) => [action, { available: true }]),
);
const context = decodeContext({
  projectId,
  revision: 10,
  task: {
    taskId: "task-a",
    projectId,
    title: "Repair reconnect",
    state: "specified",
    watchers: [],
    revision: 4,
    specRevision: 2,
    specification: {
      objective: "Keep work",
      scopeIn: "Reconnect",
      scopeOut: "Auth",
      criterionIds: ["criterion"],
      revision: 2,
      protected: false,
    },
    createdAt: at,
    updatedAt: at,
  },
  criteria: [
    {
      criterionId: "criterion",
      taskId: "task-a",
      description: "Retain history",
      required: true,
      status: "unsatisfied",
      satisfiedByEvidenceIds: [],
      revision: 1,
      updatedAt: at,
    },
  ],
  evidence: [],
  relationships: [],
  blockers: [],
  comments: [],
  children: { criteria: [], evidence: [], relationships: [], blockers: [], comments: [] },
  policy: {
    taskId: "task-a",
    readiness: { ready: false, reasons: [] },
    claimability: { claimable: false },
    actions,
    attention: [],
  },
});
const fields = { projectId, revision: 1, generation: 0, updatedAt: at };
const records = [
  {
    ...fields,
    recordId: "membership",
    kind: "task-membership",
    status: "active",
    taskId: "task-a",
    executionKind: "managed",
    deliverableKind: "code",
    controlState: "active",
  },
  {
    ...fields,
    recordId: "spec",
    kind: "gate",
    status: "pending",
    taskId: "task-a",
    gate: "specification",
    specRevision: 2,
    planRevision: 0,
    contentHash: "spec-hash",
    evidenceIds: [],
    attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
  },
  {
    ...fields,
    recordId: "plan",
    kind: "plan-revision",
    status: "proposed",
    taskId: "task-a",
    specRevision: 2,
    planRevision: 3,
    content: "Repair then verify",
    contentHash: "plan-hash",
    dependencyTaskIds: [],
  },
  {
    ...fields,
    recordId: "plan-gate",
    kind: "gate",
    status: "pending",
    taskId: "task-a",
    gate: "plan",
    specRevision: 2,
    planRevision: 3,
    contentHash: "plan-hash",
    evidenceIds: [],
    attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
  },
].map((record) => decodeRecord(record));
const foundation = combineProjectWorkFoundationPages({
  projectId,
  pages: [{ value: { projectId, revision: 10, items: records } }],
});
const current = () => ({
  environmentId,
  projectId,
  taskId: context.task.taskId,
  connected: true,
  enabled: true,
  foundationSupported: true,
  guidedSupported: true,
  fresh: true,
  context,
  foundation,
});

describe("mobile human work", () => {
  it("captures a selected waiver definition before sending its exact mobile request", async () => {
    const sent: ProjectWorkWriteIntent[] = [];
    const session = createWorkActionSession(
      { environmentId, projectId, taskId: context.task.taskId },
      current,
      async (input) => {
        sent.push(decodeWrite(input));
      },
      () => CommandId.make("mobile-waiver"),
    );
    await session.selectWaiverCriterion(context.criteria[0]!.criterionId);
    session.editWaiver("Accept a documented exception");
    await session.submit({ kind: "waiver", action: "waive" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "project-team.criterion.waiver",
      expectedRevision: 10,
      expectedTaskRevision: 4,
      criterionId: context.criteria[0]!.criterionId,
      expectedCriterionRevision: 1,
      expectedSpecRevision: 2,
      expectedSpecificationHash: NodeCrypto.createHash("sha256")
        .update(
          canonicalProjectWorkPayload({
            specification: context.task.specification,
            criteria: context.criteria.map(({ criterionId, description, required, waiver }) => ({
              criterionId,
              description,
              required,
              waiver,
            })),
          }),
        )
        .digest("hex"),
      action: { kind: "waive", reason: "Accept a documented exception", evidenceIds: [] },
    });
  });

  it("keeps the exact uncertain waiver request after later criterion revision changes", async () => {
    let latest = current();
    const sent: ProjectWorkWriteIntent[] = [];
    const session = createWorkActionSession(
      { environmentId, projectId, taskId: context.task.taskId },
      () => latest,
      async (input) => {
        sent.push(input);
        throw Error("Lost response");
      },
      () => CommandId.make("uncertain-waiver"),
    );
    await session.selectWaiverCriterion(context.criteria[0]!.criterionId);
    session.editWaiver("Keep the original exception");
    await session.submit({ kind: "waiver", action: "waive" });
    expect(session.state.status).toBe("uncertain");
    latest = {
      ...latest,
      context: decodeContext({
        ...context,
        criteria: context.criteria.map((criterion) => ({
          ...criterion,
          revision: criterion.revision + 1,
        })),
      }),
    };
    session.editWaiver("Replace the original reason");
    await session.retry();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it("denies waiver sends after selected targets, owner or connection change and cancel sends nothing", async () => {
    for (const change of ["criterion", "specification", "owner", "disconnect", "cancel"] as const) {
      let latest = current();
      const sent: ProjectWorkWriteIntent[] = [];
      const session = createWorkActionSession(
        { environmentId, projectId, taskId: context.task.taskId },
        () => latest,
        async (input) => {
          sent.push(input);
        },
        () => CommandId.make("denied-waiver"),
      );
      await session.selectWaiverCriterion(context.criteria[0]!.criterionId);
      session.editWaiver("Accept this exception");
      if (change === "criterion")
        latest = {
          ...latest,
          context: decodeContext({
            ...context,
            criteria: context.criteria.map((criterion) => ({
              ...criterion,
              revision: criterion.revision + 1,
            })),
          }),
        };
      if (change === "specification")
        latest = {
          ...latest,
          context: decodeContext({
            ...context,
            criteria: context.criteria.map((criterion) => ({
              ...criterion,
              description: "Changed definition",
            })),
          }),
        };
      if (change === "owner")
        latest = { ...latest, environmentId: EnvironmentId.make("other-environment") };
      if (change === "disconnect") latest = { ...latest, connected: false };
      if (change === "cancel") session.cancelWaiver();
      await session.submit({ kind: "waiver", action: "waive" });
      expect(sent).toEqual([]);
    }
  });

  it("denies a changed owner while criterion hashing yields without rebasing the selection", async () => {
    let latest = current();
    const sent: ProjectWorkWriteIntent[] = [];
    const session = createWorkActionSession(
      { environmentId, projectId, taskId: context.task.taskId },
      () => latest,
      async (input) => {
        sent.push(input);
      },
      () => CommandId.make("hash-owner"),
    );
    const preparing = session.selectWaiverCriterion(context.criteria[0]!.criterionId);
    expect(session.state.status).toBe("preparing");
    latest = { ...latest, environmentId: EnvironmentId.make("other-environment") };
    await preparing;
    expect(session.state.status).toBe("stale");
    await session.submit({ kind: "waiver", action: "waive" });
    expect(sent).toEqual([]);
  });

  it("sends reassignment with the reviewed member revision and reason", async () => {
    const member = decodeRecord({
      ...fields,
      recordId: "successor",
      kind: "member",
      status: "active",
      revision: 7,
      name: "Next worker",
      coordinator: true,
      roleRevisionId: "any-role",
    });
    const value = {
      ...current(),
      foundation: combineProjectWorkFoundationPages({
        projectId,
        pages: [{ value: { projectId, revision: 10, items: [...records, member] } }],
      }),
    };
    const sent: ProjectWorkWriteIntent[] = [];
    const session = createWorkActionSession(
      { environmentId, projectId, taskId: context.task.taskId },
      () => value,
      async (input) => {
        sent.push(decodeWrite(input));
      },
      () => CommandId.make("reassignment"),
    );
    session.selectRecipient("successor", 7);
    session.editControl("Continue with the available teammate");
    await session.submit({ kind: "control", action: "reassign" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "project-team.task.control",
      expectedRevision: 10,
      expectedTaskRevision: 4,
      control: {
        action: "reassign",
        reason: "Continue with the available teammate",
        recipientMemberId: "successor",
        expectedMemberRevision: 7,
      },
    });
  });

  it("keeps stopped investigation and approval denied while lifecycle Resume is separate", async () => {
    const paused = records.map((record) =>
      record.kind === "task-membership"
        ? decodeRecord({ ...record, controlState: "paused" })
        : record,
    );
    const value = {
      ...current(),
      foundation: combineProjectWorkFoundationPages({
        projectId,
        pages: [{ value: { projectId, revision: 10, items: paused } }],
      }),
    };
    const sent: ProjectWorkWriteIntent[] = [];
    const session = createWorkActionSession(
      { environmentId, projectId, taskId: context.task.taskId },
      () => value,
      async (input) => {
        sent.push(decodeWrite(input));
      },
      () => CommandId.make("resume"),
    );
    session.edit("Research paused work", "Findings");
    await session.submit({ kind: "investigate" });
    await session.submit({ kind: "gate", gateId: "spec", response: "approved" });
    expect(sent).toEqual([]);
    expect(reviewMobileWork(value).specificationGate).toBeNull();
    session.editControl("Resume after inspection");
    await session.submit({ kind: "control", action: "resume" });
    expect(sent[0]).toMatchObject({
      type: "project-team.task.control",
      control: { action: "resume" },
    });
  });

  it("reviews the exact current specification and proposed plan", () => {
    const review = reviewMobileWork(current());
    expect(review.reason).toBeNull();
    expect(review.specificationGate?.recordId).toBe("spec");
    expect(review.planGate?.recordId).toBe("plan-gate");
    expect(review.plan?.content).toBe("Repair then verify");
  });

  it("requires a complete coherent project snapshot", () => {
    const first = {
      projectId,
      revision: 10,
      items: records.slice(0, 2),
      nextCursor: "opaque cursor",
    };
    const partial = combineProjectWorkFoundationPages({ projectId, pages: [{ value: first }] });
    expect(reviewMobileWork({ ...current(), foundation: partial }).reason).not.toBeNull();
    const changed = combineProjectWorkFoundationPages({
      projectId,
      pages: [
        { value: first },
        { cursor: "opaque cursor", value: { projectId, revision: 11, items: records.slice(2) } },
      ],
    });
    expect(reviewMobileWork({ ...current(), foundation: changed }).reason).not.toBeNull();
    expect(
      reviewMobileWork({ ...current(), context: { ...context, revision: 11 } }).reason,
    ).not.toBeNull();
  });

  it.each(["connected", "enabled", "foundationSupported", "guidedSupported", "fresh"] as const)(
    "refuses writes when %s is unavailable",
    async (flag) => {
      const sent: ProjectWorkWriteIntent[] = [];
      const session = createWorkActionSession(
        { environmentId, projectId, taskId: context.task.taskId },
        () => ({ ...current(), [flag]: false }),
        async (input) => {
          sent.push(input);
        },
        () => CommandId.make("command"),
      );
      await session.submit({ kind: "gate", gateId: "spec", response: "approved" });
      expect(sent).toEqual([]);
      expect(session.state.notice).not.toBeNull();
    },
  );

  it("sends schema-valid exact revision approval and rejection", async () => {
    const sent: ProjectWorkWriteIntent[] = [];
    let latest = current();
    const session = createWorkActionSession(
      { environmentId, projectId, taskId: context.task.taskId },
      () => latest,
      async (input) => {
        sent.push(decodeWrite(input));
      },
      () => CommandId.make("command"),
    );
    await session.submit({ kind: "gate", gateId: "spec", response: "approved" });
    expect(sent[0]).toMatchObject({
      type: "project-team.gate.respond",
      projectId,
      taskId: "task-a",
      expectedRevision: 10,
      expectedTaskRevision: 4,
      expectedGateRevision: 1,
      gateId: "spec",
      specRevision: 2,
      planRevision: 0,
      response: "approved",
    });
    await session.submit({ kind: "gate", gateId: "plan-gate", response: "rejected" });
    expect(sent).toHaveLength(1);
    latest = {
      ...latest,
      context: { ...context, revision: 11 },
      foundation: { ...foundation, revision: 11 },
    };
    session.reset();
    await session.submit({ kind: "gate", gateId: "plan-gate", response: "rejected" });
    expect(sent[1]).toMatchObject({ gateId: "plan-gate", planRevision: 3, response: "rejected" });
  });

  it("retains investigation drafts after conflicts and requires an explicit reset", async () => {
    let latest = current();
    const sent: ProjectWorkWriteIntent[] = [];
    const session = createWorkActionSession(
      { environmentId, projectId, taskId: context.task.taskId },
      () => latest,
      async (input) => {
        sent.push(input);
        throw {
          _tag: "ProjectWorkPolicyError",
          code: "stale-revision",
          message: "Changed elsewhere",
        };
      },
      () => CommandId.make("command"),
    );
    session.edit("Read reconnect history", "Findings\nOpen questions");
    await session.submit({ kind: "investigate" });
    expect(session.state).toMatchObject({
      objective: "Read reconnect history",
      outputs: "Findings\nOpen questions",
      status: "stale",
    });
    session.reset();
    await session.submit({ kind: "investigate" });
    expect(sent).toHaveLength(1);
    latest = {
      ...latest,
      context: { ...context, revision: 11 },
      foundation: { ...foundation, revision: 11 },
    };
    await session.retry();
    expect(sent).toHaveLength(1);
    session.reset();
    await session.submit({ kind: "investigate" });
    expect(sent[1]).toMatchObject({
      expectedRevision: 11,
      objective: "Read reconnect history",
      outputDescriptions: ["Findings", "Open questions"],
    });
  });

  it("retries the identical uncertain command without permitting competing sends", async () => {
    const sent: ProjectWorkWriteIntent[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = createWorkActionSession(
      { environmentId, projectId, taskId: context.task.taskId },
      current,
      async (input) => {
        sent.push(input);
        if (sent.length === 1) {
          await held;
          throw new Error("Connection lost");
        }
      },
      () => CommandId.make("command"),
    );
    session.edit("Inspect safely", "Findings");
    const first = session.submit({ kind: "investigate" });
    await session.submit({ kind: "gate", gateId: "spec", response: "approved" });
    expect(sent).toHaveLength(1);
    release?.();
    await first;
    session.edit("Changed draft", "Other outputs");
    expect(session.state.objective).toBe("Inspect safely");
    session.reset();
    expect(session.state.status).toBe("uncertain");
    expect(session.state.pending).toBe(sent[0]);
    await session.retry();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(session.state.status).toBe("accepted");
  });

  it.each([
    "Project revision changed",
    "Task or specification revision changed",
    "Plan revision changed",
    "Gate target changed",
    "Specification approval target changed",
    "Plan approval target changed",
    "Gate response is no longer eligible",
    "Gate response changed since receipt",
    "Guided project or task revision changed",
    "Guided receipt target changed",
  ])("recovers from public authoritative rejection: %s", async (reason) => {
    let latest = current();
    const sent: ProjectWorkWriteIntent[] = [];
    const session = createWorkActionSession(
      { environmentId, projectId, taskId: context.task.taskId },
      () => latest,
      async (input) => {
        sent.push(decodeWrite(input));
        if (sent.length === 1) throw { _tag: "ProjectTeamAuthorizationError", reason };
      },
      () => CommandId.make(`command-${sent.length + 1}`),
    );
    session.edit("Read reconnect history", "Findings\nOpen questions");
    await session.submit({ kind: "gate", gateId: "spec", response: "rejected" });
    expect(session.state).toMatchObject({
      status: "stale",
      objective: "Read reconnect history",
      outputs: "Findings\nOpen questions",
      pending: sent[0],
    });
    await session.retry();
    expect(sent).toHaveLength(1);
    session.reset();
    expect(session.canSubmit(10)).toBe(false);
    await session.submit({ kind: "investigate" });
    expect(sent).toHaveLength(1);
    latest = {
      ...latest,
      context: { ...context, revision: 11 },
      foundation: { ...foundation, revision: 11 },
    };
    session.reset();
    await session.submit({ kind: "investigate" });
    expect(session.state.status).toBe("accepted");
    expect(sent[1]).toMatchObject({
      commandId: "command-2",
      expectedRevision: 11,
      objective: "Read reconnect history",
      outputDescriptions: ["Findings", "Open questions"],
    });
    expect(sent[1]).not.toBe(sent[0]);
  });

  it.each([
    {
      _tag: "EnvironmentAuthorizationError",
      message: "The authenticated token is missing required scope: orchestration:operate.",
      requiredScope: "orchestration:operate",
    },
    {
      _tag: "ProjectTeamAuthorizationError",
      reason: "Only a human can respond to gates, answer or promote memory",
    },
    { _tag: "ProjectWorkAuthorizationError", reason: "project-work-disabled" },
    {
      _tag: "ProjectWorkContentRejectedError",
      matches: [{ path: "$.objective", kind: "known-secret" }],
    },
    {
      _tag: "ProjectWorkPolicyError",
      code: "invalid-state",
      message: "Investigation is unavailable in this state.",
    },
  ])("allows draft correction after public $_tag rejection", async (rejection) => {
    const sent: ProjectWorkWriteIntent[] = [];
    const session = createWorkActionSession(
      { environmentId, projectId, taskId: context.task.taskId },
      current,
      async (input) => {
        sent.push(input);
        if (sent.length === 1) throw rejection;
      },
      () => CommandId.make(`command-${sent.length + 1}`),
    );
    session.edit("Inspect original", "Original findings");
    await session.submit({ kind: "investigate" });
    expect(session.state).toMatchObject({
      status: "denied",
      objective: "Inspect original",
      outputs: "Original findings",
    });
    expect(session.state.notice).not.toBeNull();
    if (rejection._tag === "EnvironmentAuthorizationError")
      expect(session.state.notice).toContain(rejection.message);
    expect(session.state.pending).toBe(sent[0]);
    session.edit("Inspect corrected", "Corrected findings");
    await session.submit({ kind: "investigate" });
    await session.retry();
    expect(sent).toHaveLength(1);
    session.reset();
    await session.submit({ kind: "investigate" });
    expect(sent[1]).toMatchObject({
      commandId: "command-2",
      expectedRevision: 10,
      objective: "Inspect corrected",
      outputDescriptions: ["Corrected findings"],
    });
    expect(session.state.status).toBe("accepted");
  });

  it.each([
    {
      _tag: "EnvironmentAuthorizationError",
      message: "Unknown required scope",
      requiredScope: "future:scope",
    },
    { _tag: "EnvironmentAuthorizationError", requiredScope: "orchestration:operate" },
    {
      _tag: "EnvironmentAuthorizationError",
      message: false,
      requiredScope: "orchestration:operate",
    },
    {
      _tag: "FutureEnvironmentAuthorizationError",
      message: "Unknown authorization error",
      requiredScope: "orchestration:operate",
    },
    {
      _tag: "PersistenceSqlError",
      operation: "ProjectWorkGateway.write",
      detail: "SQL failed",
      cause: {
        _tag: "EnvironmentAuthorizationError",
        message: "The authenticated token is missing required scope: orchestration:operate.",
        requiredScope: "orchestration:operate",
      },
    },
    {
      _tag: "PersistenceSqlError",
      operation: "ProjectWorkRepository.executeAuthorized",
      detail: "Request failed",
      cause: { _tag: "ProjectTeamAuthorizationError", reason: "Project revision changed" },
    },
    {
      _tag: "PersistenceSqlError",
      operation: "ProjectWorkGateway.write",
      detail: "SQL failed",
      code: "stale-revision",
    },
    { code: "ECONNRESET", message: "Connection lost" },
    { code: "stale-revision", message: "Unrecognized rejection shape" },
    { _tag: "UnknownNetworkError", code: "invalid-state", reason: "Project revision changed" },
    { _tag: "ProjectWorkPolicyError", code: "future-code", message: "Unknown policy" },
    { _tag: "ProjectTeamAuthorizationError", reason: null },
    { _tag: "ProjectWorkContentRejectedError", matches: "invalid" },
    { reason: "Project revision changed" },
    'Expected JSON value\n  at ["cause"][0]["error"]: Project revision changed',
  ])("keeps unknown/SQL/network failure %j uncertain with exact replay", async (failure) => {
    const sent: ProjectWorkWriteIntent[] = [];
    const session = createWorkActionSession(
      { environmentId, projectId, taskId: context.task.taskId },
      current,
      async (input) => {
        sent.push(input);
        if (sent.length === 1) throw failure;
      },
      () => CommandId.make("command"),
    );
    session.edit("Inspect original", "Original findings");
    await session.submit({ kind: "investigate" });
    session.edit("Competing correction", "Competing findings");
    session.reset();
    await session.submit({ kind: "gate", gateId: "spec", response: "approved" });
    expect(sent).toHaveLength(1);
    expect(session.state).toMatchObject({
      status: "uncertain",
      objective: "Inspect original",
      outputs: "Original findings",
    });
    expect(session.state.pending).toBe(sent[0]);
    await session.retry();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(session.state.status).toBe("accepted");
  });

  it("requires a new aggregate revision after an accepted response", async () => {
    const sent: ProjectWorkWriteIntent[] = [];
    const session = createWorkActionSession(
      { environmentId, projectId, taskId: context.task.taskId },
      current,
      async (input) => {
        sent.push(input);
      },
      () => CommandId.make("command"),
    );
    await session.submit({ kind: "gate", gateId: "spec", response: "approved" });
    session.reset();
    expect(session.canSubmit(10)).toBe(false);
    await session.submit({ kind: "investigate" });
    expect(sent).toHaveLength(1);
  });

  it("keeps the exact pending identity after live capability or connection loss", async () => {
    for (const flag of [
      "connected",
      "enabled",
      "foundationSupported",
      "guidedSupported",
      "fresh",
    ] as const) {
      let latest = current();
      const sent: ProjectWorkWriteIntent[] = [];
      const session = createWorkActionSession(
        { environmentId, projectId, taskId: context.task.taskId },
        () => latest,
        async (input) => {
          sent.push(input);
          throw new Error("Lost response");
        },
        () => CommandId.make("command"),
      );
      session.edit("Inspect", "Findings");
      await session.submit({ kind: "investigate" });
      latest = { ...latest, [flag]: false };
      await session.retry();
      expect(sent).toHaveLength(1);
      expect(session.state.pending).toBe(sent[0]);
      expect(session.state.objective).toBe("Inspect");
    }
  });

  it("does not offer investigation with an unresolved active attempt identity", () => {
    const changed = decodeContext({
      ...context,
      task: { ...context.task, activeAttemptId: "attempt" },
    });
    expect(reviewMobileWork({ ...current(), context: changed }).canInvestigate).toBe(false);
    const unknown = decodeContext({
      ...context,
      activeAttempt: {
        attemptId: "attempt",
        taskId: "task-a",
        state: "future-state",
        checkpointIds: [],
        revision: 1,
      },
    });
    expect(reviewMobileWork({ ...current(), context: unknown }).reason).not.toBeNull();
  });

  it("does not retry into another environment/project/task or after navigation", async () => {
    for (const target of [
      { environmentId: EnvironmentId.make("environment-b") },
      { projectId: ProjectId.make("project-b") },
      { taskId: context.task.taskId + "other" },
      {},
    ]) {
      let latest = current();
      const sent: ProjectWorkWriteIntent[] = [];
      const session = createWorkActionSession(
        { environmentId, projectId, taskId: context.task.taskId },
        () => latest,
        async (input) => {
          sent.push(input);
          throw new Error("Lost");
        },
        () => CommandId.make("command"),
      );
      session.edit("Inspect", "Findings");
      await session.submit({ kind: "investigate" });
      if ("taskId" in target)
        latest = {
          ...latest,
          taskId: context.task.taskId,
          context: {
            ...context,
            task: {
              ...context.task,
              taskId: decodeContext({
                ...context,
                task: { ...context.task, taskId: target.taskId },
              }).task.taskId,
            },
          },
        };
      else latest = { ...latest, ...target };
      if (Object.keys(target).length === 0) session.dispose();
      await session.retry();
      expect(sent).toHaveLength(1);
    }
  });

  it("keeps invalidated, rejected, duplicate and future gates read-only", () => {
    for (const replacement of [
      { status: "invalidated" },
      { status: "rejected" },
      { specRevision: 3 },
    ]) {
      const changed = records.map((record) =>
        record.recordId === "spec" ? decodeRecord({ ...record, ...replacement }) : record,
      );
      expect(
        reviewMobileWork({ ...current(), foundation: { ...foundation, records: changed } })
          .specificationGate,
      ).toBeNull();
    }
    expect(
      reviewMobileWork({
        ...current(),
        foundation: {
          ...foundation,
          records: [...records, decodeRecord({ ...records[1], recordId: "spec-duplicate" })],
        },
      }).specificationGate,
    ).toBeNull();
  });
});

function approvedReviewCurrent() {
  const value = current();
  const hash = (value: unknown) =>
    NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
  const specificationHash = hash({
    specification: context.task.specification,
    criteria: context.criteria
      .map(({ criterionId, description, required, waiver }) => ({
        criterionId,
        description,
        required,
        waiver,
      }))
      .sort((a, b) => (a.criterionId < b.criterionId ? -1 : a.criterionId > b.criterionId ? 1 : 0)),
  });
  const planHash = hash({ content: "Repair then verify", dependencyTaskIds: [] });
  const approved = records.map((record) =>
    decodeRecord({
      ...record,
      ...(record.kind === "plan-revision" ? { contentHash: planHash } : {}),
      ...(record.kind === "gate" && "gate" in record
        ? {
            status: "approved",
            contentHash: record.gate === "specification" ? specificationHash : planHash,
          }
        : {}),
    }),
  );
  return {
    ...value,
    foundation: combineProjectWorkFoundationPages({
      projectId,
      pages: [{ value: { projectId, revision: 10, items: approved } }],
    }),
  };
}
it("mobile independent review freezes approved targets and retries the exact uncertain request", async () => {
  const value = approvedReviewCurrent();
  const sent: ProjectWorkWriteIntent[] = [];
  const session = createWorkActionSession(
    { environmentId, projectId, taskId: context.task.taskId },
    () => value,
    async (input) => {
      sent.push(decodeWrite(input));
      if (sent.length === 1) throw Error("lost response");
    },
    () => CommandId.make("review-command"),
  );
  session.editReview("Inspect the exact task code", "Findings\nValidation gaps");
  await session.submit({ kind: "review" });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "project-team.assignment.start",
    assignmentKind: "review",
    specRevision: 2,
    specificationGateId: "spec",
    expectedSpecificationGateRevision: 1,
    parentPlan: {
      recordId: "plan",
      expectedRecordRevision: 1,
      planRevision: 3,
      gateId: "plan-gate",
      expectedGateRevision: 1,
    },
    objective: "Inspect the exact task code",
    outputDescriptions: ["Findings", "Validation gaps"],
  });
  expect(session.state.status).toBe("uncertain");
  session.editReview("Changed objective", "Changed outputs");
  await session.submit({ kind: "review" });
  expect(sent).toHaveLength(1);
  await session.retry();
  expect(sent[1]).toEqual(sent[0]);
});
it("mobile independent review refuses changed targets and pending approvals without retargeting its draft", async () => {
  let value = approvedReviewCurrent();
  const send = vi.fn(async (_intent: ProjectWorkWriteIntent) => {});
  const session = createWorkActionSession(
    { environmentId, projectId, taskId: context.task.taskId },
    () => value,
    send,
    () => CommandId.make("review-command"),
  );
  session.editReview("Inspect old approved targets", "Findings");
  value = {
    ...value,
    foundation: combineProjectWorkFoundationPages({
      projectId,
      pages: [
        {
          value: {
            projectId,
            revision: 10,
            items: value.foundation.records.map((record) =>
              decodeRecord({
                ...record,
                ...(record.kind === "gate" && "gate" in record && record.gate === "plan"
                  ? { revision: 2 }
                  : {}),
              }),
            ),
          },
        },
      ],
    }),
  };
  await session.submit({ kind: "review" });
  expect(send).not.toHaveBeenCalled();
  expect(session.state.reviewObjective).toBe("Inspect old approved targets");
  expect(reviewMobileWork(current()).canReview).toBe(false);
});
