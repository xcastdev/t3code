import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  ProviderInstanceId,
  ThreadId,
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
describe("review finding foundation invariants", () => {
  const criterionId = ProjectWorkCriterionId.make("review-criterion");
  const provenance = {
    reviewTaskId: ProjectWorkTaskId.make("review-child"),
    bindingId: "review-binding",
    generation: 2,
    memberId: "reviewer",
    providerInstanceId: ProviderInstanceId.make("pi"),
    threadId: ThreadId.make("review-thread"),
    sessionId: "fresh-session",
    initializeOperationId: "review-initialize",
    dispatchId: "review-dispatch",
    targetSha256: "a".repeat(64),
  };
  const finding: Extract<ProjectTeamRecord, { kind: "review-finding" }> = {
    ...fields,
    recordId: "finding-ledger",
    kind: "review-finding",
    taskId,
    findingId: "retry-loses-report",
    severity: "high",
    criterionIds: [criterionId],
    detail: "A repeated report loses its original result.",
    status: "open",
    resolutionArtifactIds: [],
    target: {
      projectId,
      taskId,
      specRevision: 1,
      planRevision: 1,
      baseSha: "base",
      headSha: "head",
    },
    originReviewer: provenance,
    reportedBy: provenance,
  };
  const state = () => {
    const current = initial();
    return applyProjectWorkEvents(
      current,
      decideProjectWorkCommand(current, {
        type: "project-work.criterion.upsert",
        projectId,
        taskId,
        commandId: CommandId.make("review-criterion"),
        criterion: {
          criterionId,
          taskId,
          description: "Report survives retry",
          required: true,
          status: "unsatisfied",
          satisfiedByEvidenceIds: [],
          revision: 0,
          updatedAt: at,
        },
        updatedAt: at,
      }),
    );
  };
  it("retains exact duplicate findings without advancing the event log", () => {
    const current = { ...state(), foundationRecords: [finding] };
    expect(
      decideProjectWorkCommand(current, {
        type: "project-work.foundation.commit",
        projectId,
        commandId: CommandId.make("repeat-finding"),
        expectedRevision: current.revision,
        records: [finding],
        attribution: human,
        committedAt: at,
      }),
    ).toEqual([]);
    expect(() =>
      validateProjectTeamRecord(current, { ...finding, detail: "Changed at same revision" }, human),
    ).toThrow();
  });
  it("preserves the original target and reviewer while allowing exact next-revision detail", () => {
    const current = { ...state(), foundationRecords: [finding] };
    expect(
      validateProjectTeamRecord(current, { ...finding, revision: 1, detail: "More detail" }, human)
        .revision,
    ).toBe(1);
    for (const changed of [
      { ...finding, revision: 1, target: { ...finding.target, headSha: "replacement" } },
      { ...finding, revision: 1, originReviewer: { ...provenance, memberId: "replacement" } },
      { ...finding, revision: 1, generation: 1 },
    ])
      expect(() => validateProjectTeamRecord(current, changed, human)).toThrow();
  });
  it("rejects foreign criteria, duplicate finding identities and unproved resolution", () => {
    const current = state();
    expect(validateProjectTeamRecord(current, finding, human)).toEqual(finding);
    for (const changed of [
      { ...finding, criterionIds: [ProjectWorkCriterionId.make("foreign")] },
      { ...finding, status: "resolved" as const, resolutionArtifactIds: ["bare-artifact"] },
      { ...finding, generation: 1 },
    ])
      expect(() => validateProjectTeamRecord(current, changed, human)).toThrow();
    expect(() =>
      validateProjectTeamRecord(
        { ...current, foundationRecords: [finding] },
        { ...finding, recordId: "other-ledger" },
        human,
      ),
    ).toThrow();
  });
});
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

// These service tests use disposable migrated SQLite; no worker is launched.
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectWorkEvidenceId, type ProjectTeamGuidedIntent } from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { gatewayRuntime } from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
const reportFixture = (applicability: "current" | "stale" = "current") =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Guided report fixture','/fixture','[]',${at},${at})`;
    const repository = yield* ProjectWorkRepository;
    const gateway = yield* ProjectWorkGateway;
    yield* repository.execute({
      type: "project-work.task.create",
      projectId,
      taskId,
      commandId: CommandId.make("report-capture"),
      title: "Report task",
      createdAt: at,
    });
    let state = yield* readCurrentState(sql, projectId);
    yield* gateway.write(
      {
        type: "project-team.investigation.start",
        projectId,
        taskId,
        commandId: CommandId.make("report-investigate"),
        expectedRevision: state.revision,
        expectedTaskRevision: 0,
        objective: "Read and retain findings",
        outputDescriptions: ["Retained findings"],
      },
      human.actor,
      human.source,
      { actor: human.actor },
    );
    state = yield* readCurrentState(sql, projectId);
    const child = state.tasks.find((t) => t.taskId !== taskId)!;
    const membership = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
        r.kind === "task-membership" && r.taskId === child.taskId,
    )!;
    const outputId = ProjectWorkEvidenceId.make("retained-output");
    const scopeHash = projectTeamScopeHash(state, child.taskId);
    yield* repository.execute({
      type: "project-work.evidence.add",
      projectId,
      commandId: CommandId.make("report-artifact"),
      addedAt: at,
      attribution: human,
      evidence: {
        evidenceId: outputId,
        taskId: child.taskId,
        kind: "artifact",
        summary: "Retained finding",
        detail: "The source and finding are retained for this assignment",
        scopeHash: applicability === "current" ? scopeHash : "old-scope",
        recordedAt: at,
        revision: 0,
        attribution: human,
      },
    });
    state = yield* readCurrentState(sql, projectId);
    const intent: Extract<ProjectTeamGuidedIntent, { type: "project-team.assignment.report" }> = {
      type: "project-team.assignment.report",
      projectId,
      taskId: child.taskId,
      commandId: CommandId.make("typed-report"),
      expectedRevision: state.revision,
      expectedTaskRevision: child.revision,
      assignmentId: membership.recordId,
      expectedAssignmentRevision: membership.revision,
      specRevision: 1,
      planRevision: 0,
      summary: "These retained outputs explain the finding",
      evidenceIds: [],
      outputArtifactIds: [outputId],
      outcome: "findings",
    };
    return { sql, repository, gateway, state, intent, outputId, scopeHash };
  });
effectIt.effect(
  "guided artifact reports retain references once and reject stale replay atomically",
  () =>
    Effect.gen(function* () {
      const { sql, gateway, state, intent, outputId, scopeHash } = yield* reportFixture();
      const write = () => gateway.write(intent, human.actor, human.source, { actor: human.actor });
      const first = yield* write();
      expect((yield* write()).receipt).toEqual(first.receipt);
      const after = yield* readCurrentState(sql, projectId);
      expect(after.revision).toBe(first.revision);
      expect(after.evidence.filter((e) => e.outputArtifactIds?.includes(outputId))).toHaveLength(1);
      expect(after.evidence.find((e) => e.outputArtifactIds?.includes(outputId))).toMatchObject({
        taskId: intent.taskId,
        summary: intent.summary,
        scopeHash,
        attribution: expect.objectContaining({ actor: human.actor }),
      });
      expect(after.comments?.filter((c) => c.body === intent.summary)).toHaveLength(1);
      expect(
        yield* sql`SELECT command_id FROM project_work_command_receipts WHERE command_id=${intent.commandId}`,
      ).toHaveLength(1);
      const criterion = after.criteria.find((c) => c.taskId === intent.taskId)!;
      const target = after.tasks.find((t) => t.taskId === intent.taskId)!;
      yield* gateway.write(
        {
          type: "project-team.specification.propose",
          projectId,
          taskId: intent.taskId,
          commandId: CommandId.make("changed-report-scope"),
          expectedRevision: after.revision,
          expectedTaskRevision: target.revision,
          expectedSpecRevision: 1,
          specification: {
            ...target.specification!,
            objective: "Changed investigation scope",
            revision: 2,
          },
          criterionSnapshots: [{ ...criterion, status: "unsatisfied", satisfiedByEvidenceIds: [] }],
        },
        human.actor,
        human.source,
        { actor: human.actor },
      );
      const changed = yield* readCurrentState(sql, projectId);
      const retry = yield* write().pipe(Effect.result);
      expect(retry._tag).toBe("Failure");
      expect(yield* readCurrentState(sql, projectId)).toEqual(changed);
      expect(state.evidence).toHaveLength(1);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);
effectIt.effect(
  "stale guided artifact report rolls back all evidence, comments and command receipts",
  () =>
    Effect.gen(function* () {
      const { sql, gateway, state, intent } = yield* reportFixture("stale");
      const result = yield* gateway
        .write(intent, human.actor, human.source, { actor: human.actor })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* readCurrentState(sql, projectId)).toEqual(state);
      expect(
        yield* sql`SELECT command_id FROM project_work_command_receipts WHERE command_id=${intent.commandId}`,
      ).toHaveLength(0);
      expect(
        yield* sql`SELECT event_id FROM project_work_events WHERE command_id=${intent.commandId}`,
      ).toHaveLength(0);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

effectIt.effect(
  "report evidence failure rolls back its whole SQL transaction and can retry once",
  () =>
    Effect.gen(function* () {
      const { sql, gateway, state, intent, outputId } = yield* reportFixture();
      yield* sql.unsafe(
        `CREATE TRIGGER fail_retained_report BEFORE INSERT ON project_work_evidence WHEN NEW.evidence_id <> '${outputId}' BEGIN SELECT RAISE(ABORT,'report evidence rollback'); END`,
      );
      const write = () => gateway.write(intent, human.actor, human.source, { actor: human.actor });
      expect((yield* write().pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* readCurrentState(sql, projectId)).toEqual(state);
      expect(
        yield* sql`SELECT command_id FROM project_work_command_receipts WHERE command_id=${intent.commandId}`,
      ).toHaveLength(0);
      expect(
        yield* sql`SELECT event_id FROM project_work_events WHERE command_id=${intent.commandId}`,
      ).toHaveLength(0);
      yield* sql.unsafe("DROP TRIGGER fail_retained_report");
      const first = yield* write();
      expect(first.receipt.status).toBe("accepted");
      expect((yield* write()).receipt).toEqual(first.receipt);
      expect(
        (yield* readCurrentState(sql, projectId)).evidence.filter((e) =>
          e.outputArtifactIds?.includes(outputId),
        ),
      ).toHaveLength(1);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it("pending semantic repair cannot be erased or cleared without exactly one canonical debit", () => {
  const episode: Extract<ProjectTeamRecord, { kind: "repair-episode" }> = {
    ...fields,
    kind: "repair-episode",
    status: "active",
    taskId,
    rootTaskId: taskId,
    failureFingerprint: "retained-cause",
    relevantRevision: "current-tree",
    allowance: 2,
    semanticRepairs: 0,
    transportRetries: 1,
    timeoutCount: 0,
    attemptIds: [],
    pendingSemanticRepair: true,
  };
  const state = { ...initial(), foundationRecords: [episode] };
  expect(() =>
    validateProjectTeamRecord(
      state,
      { ...episode, revision: 1, pendingSemanticRepair: false },
      human,
    ),
  ).toThrow("canonical debit");
  expect(() =>
    validateProjectTeamRecord(
      state,
      {
        ...episode,
        revision: 1,
        pendingSemanticRepair: false,
        semanticRepairs: 1,
        lastSemanticRevision: "stale-tree",
      },
      human,
    ),
  ).toThrow("canonical debit");
  const { pendingSemanticRepair: _marker, ...missing } = episode;
  expect(() => validateProjectTeamRecord(state, { ...missing, revision: 1 }, human)).toThrow(
    "cannot be discarded",
  );
  expect(
    validateProjectTeamRecord(
      state,
      {
        ...episode,
        revision: 1,
        pendingSemanticRepair: false,
        semanticRepairs: 1,
        lastSemanticRevision: episode.relevantRevision,
      },
      human,
    ),
  ).toMatchObject({ pendingSemanticRepair: false, semanticRepairs: 1, transportRetries: 1 });
});
