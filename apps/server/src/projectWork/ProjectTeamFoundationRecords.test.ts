import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  emptyProjectWorkReducerState,
} from "./ProjectWorkDecider.ts";
import { validateProjectTeamRecord } from "./ProjectTeamFoundationRecords.ts";

const projectId = ProjectId.make("foundation-guided");
const taskId = ProjectWorkTaskId.make("foundation-task");
const at = "2026-01-01T00:00:00.000Z";
const human = {
  actor: { kind: "human" as const, id: "maintainer" },
  source: { kind: "web" as const, id: "device" },
  recordedAt: at,
};
const fields = { recordId: "record", projectId, revision: 0, generation: 0, updatedAt: at };
const initial = () => {
  const empty = emptyProjectWorkReducerState(projectId);
  return applyProjectWorkEvents(
    empty,
    decideProjectWorkCommand(empty, {
      type: "project-work.task.create",
      projectId,
      taskId,
      commandId: CommandId.make("capture"),
      title: "Task",
      createdAt: at,
    }),
  );
};
const gate: Extract<ProjectTeamRecord, { kind: "gate" }> = {
  ...fields,
  recordId: "gate",
  kind: "gate",
  status: "approved",
  taskId,
  gate: "investigation",
  specRevision: 1,
  planRevision: 0,
  contentHash: "frozen-scope",
  evidenceIds: [],
  attribution: human,
};
describe("guided foundation invariants", () => {
  it("consumed and invalidated grants cannot become fresh approval", () => {
    for (const status of ["consumed", "invalidated"] as const) {
      const old = {
        ...gate,
        status,
        ...(status === "consumed"
          ? { consumedByRunId: "run", consumedByCommandId: CommandId.make("consume") }
          : {}),
      };
      const state = { ...initial(), foundationRecords: [old] };
      expect(() =>
        validateProjectTeamRecord(state, { ...old, status: "approved", revision: 1 }, human),
      ).toThrow(/cannot be reapproved/);
    }
  });
  it("consumption requires exact ownership and retains the approving Human", () => {
    const state = { ...initial(), foundationRecords: [gate] };
    expect(() =>
      validateProjectTeamRecord(state, { ...gate, status: "consumed", revision: 1 }, human),
    ).toThrow(/exact run and command/);
    const consumed = {
      ...gate,
      status: "consumed" as const,
      revision: 1,
      consumedByRunId: "run",
      consumedByCommandId: CommandId.make("consume"),
    };
    const system = {
      actor: { kind: "system" as const, id: "scheduler" },
      source: { kind: "system" as const, id: "scheduler" },
      recordedAt: at,
    };
    expect(() => validateProjectTeamRecord(state, consumed, system)).toThrow(/human attribution/);
    expect(
      validateProjectTeamRecord(state, consumed, system, { runId: "run", commandId: "consume" }),
    ).toMatchObject({ attribution: human });
    expect(() =>
      validateProjectTeamRecord(
        { ...state, foundationRecords: [consumed] },
        { ...consumed, revision: 2, consumedByRunId: "replacement" },
        human,
      ),
    ).toThrow(/ownership is immutable/);
  });
  it("task classification and lineage survive removal", () => {
    const membership: Extract<ProjectTeamRecord, { kind: "task-membership" }> = {
      ...fields,
      kind: "task-membership",
      status: "active",
      taskId,
      executionKind: "managed",
      deliverableKind: "research",
    };
    const state = { ...initial(), foundationRecords: [membership] };
    expect(
      validateProjectTeamRecord(state, { ...membership, status: "removed", revision: 1 }, human),
    ).toMatchObject({ executionKind: "managed", status: "removed" });
    expect(() =>
      validateProjectTeamRecord(
        state,
        { ...membership, executionKind: "legacy", revision: 1 },
        human,
      ),
    ).toThrow(/classification and lineage/);
    expect(() =>
      validateProjectTeamRecord(state, { ...membership, recordId: "second" }, human),
    ).toThrow(/durable membership/);
  });
  it("canonical repair counters and identity cannot reset even after resolution", () => {
    const episode: Extract<ProjectTeamRecord, { kind: "repair-episode" }> = {
      ...fields,
      kind: "repair-episode",
      status: "exhausted",
      taskId,
      rootTaskId: taskId,
      failureFingerprint: "cause",
      relevantRevision: "head",
      allowance: 2,
      semanticRepairs: 2,
      transportRetries: 3,
      timeoutCount: 1,
      attemptIds: [],
    };
    const state = { ...initial(), foundationRecords: [episode] };
    expect(() =>
      validateProjectTeamRecord(state, { ...episode, semanticRepairs: 0, revision: 1 }, human),
    ).toThrow(/cannot reset/);
    expect(() =>
      validateProjectTeamRecord(
        state,
        { ...episode, failureFingerprint: "different-cause", revision: 1 },
        human,
      ),
    ).toThrow(/cannot reset/);
    expect(() =>
      validateProjectTeamRecord(
        { ...state, foundationRecords: [{ ...episode, status: "resolved" }] },
        { ...episode, recordId: "new-id", semanticRepairs: 0, status: "active" },
        human,
      ),
    ).toThrow(/persistent repair episode/);
  });
  it("stale evidence retains original tested payload and cannot be blessed", () => {
    const evidence: Extract<ProjectTeamRecord, { kind: "evidence-applicability" }> = {
      ...fields,
      kind: "evidence-applicability",
      status: "stale",
      taskId,
      evidenceId: "evidence",
      specRevision: 1,
      planRevision: 1,
      repository: "example/repo",
      worktree: "/fixture/worktree",
      testedTree: "original-tree",
      baseSha: "original-base",
      headSha: "original-head",
      command: "vp test run focused.test.ts",
      exitCode: 0,
      artifactId: "retained-output",
      environmentSummary: "Fixture",
      integration: false,
    };
    const state = { ...initial(), foundationRecords: [evidence] };
    expect(() =>
      validateProjectTeamRecord(state, { ...evidence, testedTree: "new-tree", revision: 1 }, human),
    ).toThrow(/original tested revision/);
    expect(() =>
      validateProjectTeamRecord(state, { ...evidence, status: "current", revision: 1 }, human),
    ).toThrow(/cannot be blessed/);
  });
});

it("new base/head evidence invalidates retained old proof and merge approval without rewriting it", () => {
  const evidence: Extract<ProjectTeamRecord, { kind: "evidence-applicability" }> = {
    ...fields,
    recordId: "old-proof",
    kind: "evidence-applicability",
    status: "current",
    taskId,
    evidenceId: "old-output",
    specRevision: 1,
    planRevision: 1,
    repository: "example/repo",
    worktree: "/fixture/worktree",
    testedTree: "original-tree",
    baseSha: "original-base",
    headSha: "original-head",
    command: "fixture test",
    exitCode: 0,
    artifactId: "retained-output",
    environmentSummary: "Fixture",
    integration: false,
  };
  const merge: Extract<ProjectTeamRecord, { kind: "gate" }> = {
    ...gate,
    recordId: "merge",
    gate: "merge",
    repository: "example/repo",
    pullRequestNumber: 1,
    headSha: "original-head",
    targetBranch: "main",
    mergeMethod: "squash",
    evidenceIds: [evidence.recordId],
  };
  const state = { ...initial(), foundationRecords: [evidence, merge] };
  const next = applyProjectWorkEvents(
    state,
    decideProjectWorkCommand(state, {
      type: "project-work.foundation.commit",
      projectId,
      commandId: CommandId.make("new-proof"),
      expectedRevision: state.revision,
      attribution: human,
      committedAt: at,
      records: [
        {
          ...evidence,
          recordId: "new-proof",
          evidenceId: "new-output",
          baseSha: "new-base",
          headSha: "new-head",
          testedTree: "new-tree",
        },
      ],
    }),
  );
  expect(next.foundationRecords!.find((r) => r.recordId === evidence.recordId)).toMatchObject({
    ...evidence,
    status: "stale",
    revision: 1,
  });
  expect(next.foundationRecords!.find((r) => r.recordId === merge.recordId)).toMatchObject({
    status: "invalidated",
    revision: 1,
  });
  expect(next.foundationRecords!.find((r) => r.recordId === "new-proof")).toMatchObject({
    status: "current",
    baseSha: "new-base",
    headSha: "new-head",
  });
});
