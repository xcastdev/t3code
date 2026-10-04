import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectTeamRecordRead,
  ProjectWorkAction,
  ProjectWorkTaskId,
  ProjectWorkTaskContext,
  ProjectWorkWriteIntent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { combineProjectWorkFoundationPages } from "@t3tools/client-runtime/project-work";
import { type MobileWorkCurrent } from "./workActions";
import {
  createQuestionActionSession,
  mobileTeamView,
  reviewMobileQuestion,
} from "./workTeamActions";

const projectId = ProjectId.make("project-a");
const environmentId = EnvironmentId.make("environment-a");
const at = "2026-10-03T10:00:00.000Z";
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecordRead);
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const context = Schema.decodeUnknownSync(ProjectWorkTaskContext)({
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
    createdAt: at,
    updatedAt: at,
  },
  criteria: [],
  evidence: [],
  relationships: [],
  blockers: [],
  comments: [],
  children: { criteria: [], evidence: [], relationships: [], blockers: [], comments: [] },
  policy: {
    taskId: "task-a",
    readiness: { ready: false, reasons: [] },
    claimability: { claimable: false },
    actions: Object.fromEntries(
      ProjectWorkAction.literals.map((action) => [action, { available: true }]),
    ),
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
    recordId: "gate",
    kind: "gate",
    status: "pending",
    taskId: "task-a",
    gate: "investigation",
    specRevision: 2,
    planRevision: 0,
    contentHash: "hash",
    evidenceIds: [],
    attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
  },
  {
    ...fields,
    recordId: "question",
    kind: "question",
    status: "pending",
    taskId: "task-a",
    senderId: "member",
    targetGateId: "gate",
    targetRevision: 1,
    body: "Which repair should continue?",
    choices: ["Repair reconnect", "Investigate first"],
    seenAt: at,
  },
  {
    ...fields,
    recordId: "member",
    kind: "member",
    status: "active",
    name: "Coordinator",
    coordinator: true,
    roleRevisionId: "role",
  },
  {
    ...fields,
    recordId: "role",
    kind: "role-revision",
    status: "available",
    roleId: "coordinator",
    roleRevision: 2,
    role: "coordinator",
    instructions: "Coordinate",
    skills: [],
    tools: [],
    model: "current-model",
    memoryAccess: "project",
    delegationDepth: 2,
  },
  {
    ...fields,
    recordId: "old-role",
    kind: "role-revision",
    status: "retired",
    roleId: "investigator",
    roleRevision: 1,
    role: "investigator",
    instructions: "Investigate",
    skills: [],
    tools: [],
    model: "prior-model",
    memoryAccess: "project",
    delegationDepth: 0,
  },
  {
    ...fields,
    recordId: "run",
    kind: "run-binding",
    status: "stopping",
    taskId: "task-a",
    attemptId: "attempt",
    memberId: "member",
    roleRevisionId: "old-role",
    providerInstanceId: "pi",
    threadId: "worker-thread",
    environmentId,
    model: "frozen-model",
    configuration: {
      instructionsHash: "hash",
      toolIds: [],
      skillIds: [],
      runtimeVersion: "1",
      maxTokens: 10,
      maxDurationMs: 10,
      paidFallback: false,
    },
    worktree: "/disposable/worktree",
    branch: "worker",
    leaseGeneration: 1,
    specRevision: 2,
    planRevision: 0,
  },
].map((record) => decodeRecord(record));
const foundation = combineProjectWorkFoundationPages({
  projectId,
  pages: [{ value: { projectId, revision: 10, items: records } }],
});
const initial = (): MobileWorkCurrent => ({
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
function fixture(send?: (input: ProjectWorkWriteIntent) => Promise<void>) {
  let value = initial();
  const sent: ProjectWorkWriteIntent[] = [];
  const session = createQuestionActionSession(
    { environmentId, projectId, taskId: context.task.taskId, questionId: "question" },
    () => value,
    async (input) => {
      sent.push(decodeWrite(input));
      await send?.(input);
    },
    () => CommandId.make(`command-${sent.length + 1}`),
  );
  session.edit("Repair reconnect");
  return {
    session,
    sent,
    get value() {
      return value;
    },
    update(next: MobileWorkCurrent) {
      value = next;
    },
    record(id: string, patch: object) {
      value = {
        ...value,
        foundation: {
          ...value.foundation,
          records: value.foundation.records.map((record) =>
            record.recordId === id ? decodeRecord({ ...record, ...patch }) : record,
          ),
        },
      };
    },
  };
}

describe("mobile team and human question supervision", () => {
  it("shows the member's current profile and each run's frozen role/model separately", () => {
    const view = mobileTeamView(foundation, initial());
    expect(view.members[0]?.role?.model).toBe("current-model");
    expect(view.members[0]?.runs[0]?.role?.role).toBe("investigator");
    expect(view.members[0]?.runs[0]?.run).toMatchObject({
      model: "frozen-model",
      status: "stopping",
      taskId: "task-a",
      threadId: "worker-thread",
      worktree: "/disposable/worktree",
    });
    expect(view.questions[0]).toMatchObject({ status: "pending", seenAt: at });
  });

  it("keeps future states, orphan runs and other-environment bindings visible", () => {
    const f = fixture();
    f.record("member", { status: "future-status" });
    f.record("run", { memberId: "missing", environmentId: "environment-b", status: "future-run" });
    f.record("question", { status: "future-question" });
    const view = mobileTeamView(f.value.foundation, f.value);
    expect(view.members[0]?.member.status).toBe("future-status");
    expect(view.orphanRuns[0]?.status).toBe("future-run");
    expect(view.questions[0]?.status).toBe("future-question");
    expect(view.unsupported).toHaveLength(3);
    expect(reviewMobileQuestion(f.value, "question").reason).not.toBeNull();
  });

  it("sends the actual typed answer with project/task/question/gate revision fences", async () => {
    const f = fixture();
    expect(reviewMobileQuestion(f.value, "question").reason).toBeNull();
    await f.session.submit();
    expect(f.sent[0]).toEqual({
      commandId: "command-1",
      type: "project-team.question.answer",
      projectId,
      taskId: "task-a",
      expectedRevision: 10,
      expectedTaskRevision: 4,
      specRevision: 2,
      planRevision: 0,
      questionId: "question",
      expectedQuestionRevision: 1,
      expectedGateRevision: 1,
      answer: "Repair reconnect",
    });
    expect(f.session.state.status).toBe("accepted");
    f.session.review();
    await f.session.submit();
    expect(f.sent).toHaveLength(1);
  });

  it.each(["approved", "consumed"])(
    "allows a pending question bound to a current %s gate",
    async (status) => {
      const f = fixture();
      f.record("gate", { status });
      await f.session.submit();
      expect(f.sent[0]).toMatchObject({
        type: "project-team.question.answer",
        expectedGateRevision: 1,
      });
    },
  );

  it.each(["connected", "enabled", "foundationSupported", "guidedSupported", "fresh"] as const)(
    "rechecks live %s before answering and retrying",
    async (flag) => {
      const f = fixture(async () => {
        throw new Error("Lost");
      });
      f.update({ ...f.value, [flag]: false });
      await f.session.submit();
      expect(f.sent).toHaveLength(0);
      f.update({ ...f.value, [flag]: true });
      await f.session.submit();
      f.update({ ...f.value, [flag]: false });
      await f.session.retry();
      expect(f.sent).toHaveLength(1);
      expect(f.session.state.status).toBe("uncertain");
    },
  );

  it.each([
    ["question", { revision: 2 }],
    ["question", { targetRevision: 2 }],
    ["question", { targetGateId: "other" }],
    ["question", { taskId: "task-b" }],
    ["question", { status: "answered", answer: "Investigate first" }],
    ["question", { status: "canceled" }],
    ["question", { status: "future" }],
    ["gate", { revision: 2 }],
    ["gate", { taskId: "task-b" }],
    ["gate", { specRevision: 3 }],
    ["gate", { status: "invalidated" }],
    ["gate", { status: "future" }],
    ["gate", { contentHash: "other" }],
  ] as const)("does not silently retarget after %s changes %j", async (id, patch) => {
    const f = fixture();
    f.record(id, patch);
    await f.session.submit();
    expect(f.sent).toEqual([]);
    expect(f.session.state.draft).toBe("Repair reconnect");
  });

  it("requires complete, known, coherent scope for every action", async () => {
    const values = [
      { ...initial(), foundation: { ...foundation, complete: false } },
      { ...initial(), foundation: { ...foundation, error: "invalid-page" as const } },
      { ...initial(), foundation: { ...foundation, revision: 11 } },
      {
        ...initial(),
        foundation: {
          ...foundation,
          records: [
            ...records,
            decodeRecord({
              ...fields,
              recordId: "future",
              kind: "future-record",
              status: "ready",
              payload: "New workflow",
            }),
          ],
        },
      },
      { ...initial(), foundation: { ...foundation, records: [...records, records[2]!] } },
      {
        ...initial(),
        context: { ...context, task: { ...context.task, projectId: ProjectId.make("other") } },
      },
    ];
    for (const value of values) {
      const f = fixture();
      f.update(value);
      await f.session.submit();
      expect(f.sent).toEqual([]);
    }
  });

  it("rejects a stale plan even when the question and gate revisions agree", async () => {
    const f = fixture();
    f.record("gate", { gate: "plan", planRevision: 1 });
    const next = decodeRecord({
      ...fields,
      kind: "plan-revision",
      recordId: "new-plan",
      status: "proposed",
      taskId: "task-a",
      specRevision: 2,
      planRevision: 2,
      content: "New plan",
      contentHash: "new",
      dependencyTaskIds: [],
    });
    f.update({
      ...f.value,
      foundation: { ...f.value.foundation, records: [...f.value.foundation.records, next] },
    });
    expect(reviewMobileQuestion(f.value, "question").reason).toContain("older plan");
    await f.session.submit();
    expect(f.sent).toEqual([]);
  });

  it("keeps drafts after public denial and permits explicit corrected resubmission", async () => {
    let calls = 0;
    const f = fixture(async () => {
      if (++calls === 1)
        throw {
          _tag: "ProjectWorkContentRejectedError",
          matches: [{ path: "$.answer", kind: "known-secret" }],
        };
    });
    await f.session.submit();
    expect(f.session.state.status).toBe("denied");
    expect(f.session.state.draft).toBe("Repair reconnect");
    f.session.edit("Investigate first");
    await f.session.submit();
    expect(f.sent).toHaveLength(1);
    f.session.review();
    await f.session.submit();
    expect(f.sent[1]).toMatchObject({ commandId: "command-2", answer: "Investigate first" });
  });

  it.each(["Question target changed", "Gate target changed", "Project revision changed"])(
    "preserves draft and requires refresh after conflict %s",
    async (reason) => {
      const f = fixture(async () => {
        throw { _tag: "ProjectTeamAuthorizationError", reason };
      });
      await f.session.submit();
      expect(f.session.state.status).toBe("stale");
      f.session.review();
      await f.session.submit();
      expect(f.sent).toHaveLength(1);
      f.update({
        ...f.value,
        context: { ...context, revision: 11 },
        foundation: { ...f.value.foundation, revision: 11 },
      });
      f.session.review();
      await f.session.submit();
      expect(f.sent[1]).toMatchObject({
        commandId: "command-2",
        expectedRevision: 11,
        answer: "Repair reconnect",
      });
    },
  );

  it.each([
    new Error("lost"),
    {
      _tag: "PersistenceSqlError",
      cause: { _tag: "ProjectTeamAuthorizationError", reason: "Question target changed" },
    },
    { _tag: "FutureError", reason: "Question target changed" },
  ])("keeps unknown outcomes uncertain and retries the exact original object", async (error) => {
    const observed: ProjectWorkWriteIntent[] = [];
    const f = fixture(async (input) => {
      observed.push(input);
      if (observed.length === 1) throw error;
    });
    await f.session.submit();
    f.session.edit("Investigate first");
    f.session.review();
    await f.session.submit();
    expect(f.sent).toHaveLength(1);
    expect(f.session.state.draft).toBe("Repair reconnect");
    await f.session.retry();
    expect(observed[1]).toBe(observed[0]);
    expect(f.session.state.status).toBe("accepted");
  });

  it("replays a lost success visible after reconnect without making a different answer", async () => {
    let calls = 0;
    const f = fixture(async () => {
      if (++calls === 1) throw new Error("Lost success");
    });
    await f.session.submit();
    f.record("question", { status: "answered", revision: 2, answer: "Repair reconnect" });
    f.update({
      ...f.value,
      context: { ...context, revision: 11 },
      foundation: { ...f.value.foundation, revision: 11 },
    });
    await f.session.retry();
    expect(f.sent[1]).toEqual(f.sent[0]);
    expect(f.session.state.status).toBe("accepted");
  });

  it.each([
    ["question", { revision: 2 }],
    ["question", { status: "answered", revision: 2, answer: "Investigate first" }],
    ["question", { status: "canceled" }],
    ["gate", { revision: 2 }],
    ["gate", { contentHash: "changed" }],
  ] as const)(
    "retains uncertain identity but refuses replay after %s changes %j",
    async (id, patch) => {
      const f = fixture(async () => {
        throw new Error("Lost");
      });
      await f.session.submit();
      const original = f.session.state.pending;
      f.record(id, patch);
      await f.session.retry();
      expect(f.sent).toHaveLength(1);
      expect(f.session.state.pending).toBe(original);
    },
  );

  it.each(["environment", "project", "task", "unmount"])(
    "never answers or retries after %s changes",
    async (change) => {
      const f = fixture(async () => {
        throw new Error("Lost");
      });
      await f.session.submit();
      if (change === "unmount") f.session.dispose();
      if (change === "environment")
        f.update({ ...f.value, environmentId: EnvironmentId.make("environment-b") });
      if (change === "project") f.update({ ...f.value, projectId: ProjectId.make("project-b") });
      if (change === "task") f.update({ ...f.value, taskId: ProjectWorkTaskId.make("task-b") });
      await f.session.retry();
      expect(f.sent).toHaveLength(1);
    },
  );

  it("does not send competing commands while the first response is held", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(async () => {
      await held;
    });
    const first = f.session.submit();
    await f.session.submit();
    await f.session.retry();
    expect(f.sent).toHaveLength(1);
    release?.();
    await first;
  });

  it("joins a held answer after unmount without notifying the disposed view or sending again", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let notifications = 0;
    const sent: ProjectWorkWriteIntent[] = [];
    const session = createQuestionActionSession(
      { ...initial(), questionId: "question" },
      initial,
      async (intent) => {
        sent.push(intent);
        await held;
      },
      () => CommandId.make("held-answer"),
      () => {
        notifications += 1;
      },
    );
    session.edit("Repair reconnect");
    const first = session.submit();
    const before = notifications;
    session.dispose();
    release?.();
    await first;
    await session.submit();
    await session.retry();
    expect(notifications).toBe(before);
    expect(sent).toHaveLength(1);
  });

  it("accepts only recorded choices or schema-bounded free text", async () => {
    const f = fixture();
    f.session.edit("Not an option");
    await f.session.submit();
    expect(f.sent).toEqual([]);
    f.record("question", { choices: [] });
    f.session.review();
    f.session.edit(" ");
    await f.session.submit();
    f.session.edit("a".repeat(4001));
    await f.session.submit();
    expect(f.sent).toEqual([]);
    f.session.edit("  Explain the narrow repair  ");
    await f.session.submit();
    expect(f.sent[0]).toMatchObject({ answer: "Explain the narrow repair" });
  });
});
