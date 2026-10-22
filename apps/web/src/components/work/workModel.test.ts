import {
  ProjectTeamRecordRead,
  ProjectWorkAction,
  ProjectWorkTaskContext,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkTask, gateResponses, guidedControls } from "./workModel";

const at = "2026-10-01T00:00:00.000Z";
const later = "2026-10-02T00:00:00.000Z";
const hash = (digit: string) => digit.repeat(64);
const decodeContext = Schema.decodeUnknownSync(ProjectWorkTaskContext);
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecordRead);

function context(task: Record<string, unknown> = {}, revision = 10) {
  return decodeContext({
    projectId: "project-1",
    revision,
    task: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Ship it",
      state: "specified",
      watchers: [],
      revision: 3,
      specRevision: 2,
      specification: {
        objective: "Do the thing",
        scopeIn: "This",
        scopeOut: "That",
        criterionIds: ["criterion-1"],
        revision: 2,
        protected: false,
      },
      createdAt: at,
      updatedAt: at,
      ...task,
    },
    criteria: [],
    evidence: [],
    relationships: [],
    blockers: [],
    comments: [],
    children: { criteria: [], evidence: [], relationships: [], blockers: [], comments: [] },
    policy: {
      taskId: "task-1",
      readiness: { ready: false, reasons: [] },
      claimability: { claimable: false },
      actions: Object.fromEntries(
        ProjectWorkAction.literals.map((action) => [action, { available: true }]),
      ),
      attention: [],
    },
  });
}

const base = { projectId: "project-1", generation: 0, updatedAt: at, taskId: "task-1" };
const membership = (fields: Record<string, unknown> = {}) =>
  decodeRecord({
    ...base,
    recordId: "membership-1",
    revision: 0,
    kind: "task-membership",
    status: "active",
    executionKind: "human",
    deliverableKind: "research",
    controlState: "active",
    ...fields,
  });
const gate = (fields: Record<string, unknown>) =>
  decodeRecord({
    ...base,
    revision: 1,
    kind: "gate",
    status: "pending",
    gate: "specification",
    specRevision: 2,
    planRevision: 0,
    contentHash: hash("a"),
    attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
    evidenceIds: [],
    ...fields,
  });
const plan = (fields: Record<string, unknown> = {}) =>
  decodeRecord({
    ...base,
    recordId: "plan-1",
    revision: 0,
    kind: "plan-revision",
    status: "proposed",
    specRevision: 2,
    planRevision: 1,
    content: "Steps",
    contentHash: hash("p"),
    dependencyTaskIds: [],
    ...fields,
  });

describe("deriveWorkTask", () => {
  it("binds an approved guided scope to its exact gate hash", () => {
    const model = deriveWorkTask({
      context: context(),
      records: [membership(), gate({ recordId: "gate-1", status: "approved" })],
      recordsRevision: 10,
    });
    expect(model.guided).toBe(true);
    expect(model.steps[0]).toMatchObject({ state: "approved", revision: 2, hash: hash("a") });
    expect(model.specificationHash).toBe(hash("a"));
    expect(model.blockedReason).toBeNull();
  });

  it("keeps a voided approval visible after the scope changes", () => {
    const model = deriveWorkTask({
      context: context({ specRevision: 3, specification: { ...specification(3) } }),
      records: [
        membership(),
        gate({ recordId: "gate-old", status: "invalidated", specRevision: 2, updatedAt: later }),
        gate({ recordId: "gate-new", status: "pending", specRevision: 3, contentHash: hash("b") }),
      ],
      recordsRevision: 10,
    });
    expect(model.steps[0]).toMatchObject({ state: "pending", revision: 3, hash: hash("b") });
    expect(model.invalidated.map((entry) => entry.recordId)).toEqual(["gate-old"]);
  });

  it("asks for approval again when a changed scope has no new request", () => {
    const model = deriveWorkTask({
      context: context({ specRevision: 3, specification: specification(3) }),
      records: [membership(), gate({ recordId: "gate-old", status: "invalidated" })],
      recordsRevision: 10,
    });
    expect(model.steps[0]?.state).toBe("stale");
    expect(model.specificationHash).toBeNull();
  });

  it("marks a plan written for an older scope as out of date", () => {
    const model = deriveWorkTask({
      context: context({ specRevision: 3, specification: specification(3) }),
      records: [membership(), plan({ specRevision: 2 })],
      recordsRevision: 10,
    });
    expect(model.planCurrent).toBe(false);
    expect(model.steps[1]).toMatchObject({ id: "plan", state: "stale", revision: 1 });
  });

  it("blocks guided writes when current approval records are ambiguous or behind", () => {
    const ambiguous = deriveWorkTask({
      context: context(),
      records: [membership(), gate({ recordId: "gate-1" }), gate({ recordId: "gate-2" })],
      recordsRevision: 10,
    });
    expect(ambiguous.specGate).toBeNull();
    expect(ambiguous.blockedReason).not.toBeNull();
    const behind = deriveWorkTask({
      context: context(),
      records: [membership(), gate({ recordId: "gate-1" })],
      recordsRevision: 9,
    });
    expect(behind.blockedReason).not.toBeNull();
  });

  it("treats an ordinary approval of an earlier revision as stale", () => {
    const model = deriveWorkTask({
      context: context({
        specRevision: 3,
        specification: specification(3),
        approval: {
          approvalId: "approval-1",
          taskId: "task-1",
          specRevision: 2,
          approvedAt: at,
          attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
        },
      }),
      records: [],
      recordsRevision: null,
    });
    expect(model.guided).toBe(false);
    expect(model.steps).toHaveLength(1);
    expect(model.steps[0]?.state).toBe("stale");
  });
});

describe("guided reverse controls", () => {
  const modelWith = (fields: Record<string, unknown>, task: Record<string, unknown> = {}) =>
    deriveWorkTask({ context: context(task), records: [membership(fields)], recordsRevision: 10 });

  it("offers resume for paused work and reopen for canceled work", () => {
    expect(guidedControls(modelWith({}))).toEqual(["pause", "defer", "cancel"]);
    expect(guidedControls(modelWith({ controlState: "paused" }))).toEqual(["resume", "cancel"]);
    expect(guidedControls(modelWith({}, { state: "canceled" }))).toEqual(["reopen"]);
  });

  it("lets a human revoke a recorded decision but not a consumed one", () => {
    expect(gateResponses(null)).toEqual([]);
    const responses = (status: string) =>
      gateResponses(
        deriveWorkTask({
          context: context(),
          records: [membership(), gate({ recordId: "gate-1", status })],
          recordsRevision: 10,
        }).specGate,
      );
    expect(responses("pending")).toEqual(["approved", "rejected"]);
    expect(responses("approved")).toEqual(["invalidated"]);
    expect(responses("rejected")).toEqual(["invalidated"]);
    expect(responses("consumed")).toEqual([]);
  });
});

function specification(revision: number) {
  return {
    objective: "Do the thing",
    scopeIn: "This",
    scopeOut: "That",
    criterionIds: ["criterion-1"],
    revision,
    protected: false,
  };
}
