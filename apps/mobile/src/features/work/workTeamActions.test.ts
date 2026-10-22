import { prepareProjectWorkHumanMutation } from "@t3tools/client-runtime/project-work";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  type ProjectTeamRecordRead,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  deliveryAvailability,
  makeAssignmentStartIntent,
  makeExecutionStartIntent,
  makeInvestigationStartIntent,
  makeMemoryPromoteIntent,
  makeMessageSendIntent,
  makeQuestionAnswerIntent,
  makeQuestionRequestIntent,
  openMessages,
  scannedPageState,
  type WorkGate,
  type WorkMembership,
  type WorkPlan,
  type WorkQuestionRecord,
} from "./workPresentation";

const projectId = ProjectId.make("project");
const taskId = ProjectWorkTaskId.make("task");
const at = "2026-10-21T00:00:00.000Z";
const current = {
  environmentId: EnvironmentId.make("env"),
  projectId,
  taskId,
  checkoutPath: "/checkout",
  revision: 5,
  taskRevision: 2,
};
const base = {
  commandId: CommandId.make("command"),
  projectId,
  taskId,
  expectedRevision: 5,
  expectedTaskRevision: 2,
  specRevision: 1,
  planRevision: 1,
};
const record = <T>(value: Record<string, unknown>) =>
  ({ recordId: "r", projectId, revision: 3, generation: 0, updatedAt: at, ...value }) as T;
const gate = record<WorkGate>({ kind: "gate", recordId: "gate", status: "pending", revision: 4 });

it("asks, answers and messages through intents the shared guard accepts at the reviewed revision", () => {
  const question = record<WorkQuestionRecord>({
    kind: "question",
    recordId: "question",
    status: "pending",
    targetGateId: "gate",
    targetRevision: 1,
  });
  const intents = [
    makeQuestionRequestIntent(base, {
      questionId: "q2",
      gate,
      body: " Why? ",
      choices: [" a ", ""],
    }),
    makeQuestionAnswerIntent(base, question, gate, " Yes "),
    makeMessageSendIntent(base, {
      messageId: "m",
      recipientId: "member",
      membership: record<WorkMembership>({ kind: "task-membership", revision: 6 }),
      body: "Use the new API",
    }),
  ];
  for (const intent of intents) {
    expect(prepareProjectWorkHumanMutation({ selected: current, current, intent })).toEqual(intent);
    expect(
      prepareProjectWorkHumanMutation({
        selected: current,
        current: { ...current, revision: 6 },
        intent,
      }),
    ).toBeNull();
  }
  expect(intents[0]).toMatchObject({ body: "Why?", choices: ["a"], expectedGateRevision: 4 });
  // The answer binds the gate's current revision, not the one the question was asked at.
  expect(intents[1]).toMatchObject({ answer: "Yes", expectedGateRevision: 4 });
});

it("lists only messages that still need a human, newest first", () => {
  const message = (recordId: string, status: string, updatedAt: string) =>
    record<ProjectTeamRecordRead>({ kind: "message", recordId, status, updatedAt });
  const open = openMessages([
    message("old", "delivered", "2026-10-20T00:00:00.000Z"),
    message("done", "resolved", "2026-10-21T00:00:00.000Z"),
    message("new", "uncertain", "2026-10-21T01:00:00.000Z"),
  ]);
  expect(open.map((entry) => entry.recordId)).toEqual(["new", "old"]);
});

it("proposes work and promotes facts through schema-valid intents bound to the reviewed revision", () => {
  const { specRevision: _spec, planRevision: _plan, ...guided } = base;
  const specGate = record<WorkGate>({
    kind: "gate",
    recordId: "spec",
    status: "approved",
    revision: 2,
  });
  const planGate = record<WorkGate>({
    kind: "gate",
    recordId: "plangate",
    status: "approved",
    revision: 3,
  });
  const plan = record<WorkPlan>({
    kind: "plan-revision",
    recordId: "plan",
    planRevision: 2,
    revision: 4,
  });
  const intents = [
    makeExecutionStartIntent(guided, { specRevision: 1, specGate, plan, planGate }),
    makeAssignmentStartIntent(guided, {
      kind: "implementation",
      objective: " Build it ",
      outputs: ["Parser accepts empty input"],
      specRevision: 1,
      specGate,
      plan,
      planGate,
      criterionIds: ["c1"],
    }),
    makeAssignmentStartIntent(guided, {
      kind: "planning",
      objective: "Plan it",
      outputs: ["A plan", "ignored"],
      specRevision: 1,
      specGate,
      plan: null,
      planGate: null,
      criterionIds: [],
    }),
    makeInvestigationStartIntent(guided, { objective: "Why?", outputs: ["Findings"] }),
    makeMemoryPromoteIntent(
      base,
      { observationId: "obs", revision: 2, sourceRevision: 7 },
      { knowledgeId: "k", title: " Fact " },
    ),
  ];
  for (const intent of intents) {
    expect(prepareProjectWorkHumanMutation({ selected: current, current, intent })).toEqual(intent);
    expect(
      prepareProjectWorkHumanMutation({
        selected: current,
        current: { ...current, taskRevision: 3 },
        intent,
      }),
    ).toBeNull();
  }
  // Implementation inherits the approved plan; planning has none and one plan output.
  expect(intents[1]).toMatchObject({
    parentPlan: { recordId: "plan", planRevision: 2, gateId: "plangate", expectedGateRevision: 3 },
    parentCriterionIds: ["c1"],
  });
  expect(intents[2]).not.toHaveProperty("parentPlan");
  expect(intents[2]).toMatchObject({ outputDescriptions: ["A plan"] });
  // Promotion names the observation, never its source record.
  expect(intents[4]).toMatchObject({
    observationId: "obs",
    expectedObservationRevision: 2,
    expectedSourceRevision: 7,
  });
});

it("keeps retained delivery and shared-source continuations reachable", () => {
  // An uncertain write outlives its reviewed source; only new previews need one.
  const stale = deliveryAvailability({ source: "missing", recovery: { items: [{}] } });
  expect(stale.showTracks).toBe(true);
  expect(stale.prepareBlocked).not.toBeNull();
  expect(deliveryAvailability({ source: "missing", recovery: { items: [] } }).showTracks).toBe(
    false,
  );
  expect(deliveryAvailability({ source: "current", recovery: { items: [] } }).prepareBlocked).toBe(
    null,
  );
  expect(scannedPageState({ items: [], nextCursor: "c" }, false)).toBe("empty-scanned");
  expect(scannedPageState({ items: [] }, false)).toBe("hidden");
});
