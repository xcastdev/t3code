import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  ProjectId,
  ProjectWorkEvidenceId,
  ProjectWorkEvidenceRead,
  ProjectWorkTaskId,
  type ProjectTeamGuidedIntent,
  type ProjectTeamRecord,
  type ProjectWorkEvidence,
} from "@t3tools/contracts";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import { gatewayRuntime } from "./ProjectTeamAuthorization.testFixtures.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import { ProjectWorkBriefingLive } from "./ProjectWorkBriefing.ts";
import { ProjectWorkGateway, ProjectWorkGatewayLive } from "./ProjectWorkGateway.ts";
import { ProjectWorkNarrativeLive } from "./ProjectWorkNarrative.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import { ProjectWorkSearchLive } from "./ProjectWorkSearch.ts";

const projectId = ProjectId.make("guided-report-project");
const parentTaskId = ProjectWorkTaskId.make("guided-report-parent");
const at = "2026-01-01T00:00:00.000Z";
const human = { kind: "human", id: "report-maintainer" } as const;
const source = { kind: "web", id: "report-client" } as const;
const summary = "The source analysis identifies the cause and retains its supporting artifact.";
const decodeEvidence = Schema.decodeUnknownEffect(Schema.Array(ProjectWorkEvidenceRead));

type Report = Extract<ProjectTeamGuidedIntent, { type: "project-team.assignment.report" }>;
const setup = Effect.fn("guidedReportsTest.setup")(function* (additionalCriterion = false) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* ProjectWorkRepository;
  const gateway = yield* ProjectWorkGateway;
  yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Report project','/workspace','[]',${at},${at})`;
  yield* gateway.write(
    {
      type: "project-work.task.create",
      projectId,
      taskId: parentTaskId,
      commandId: CommandId.make("capture"),
      title: "Investigate the cause",
      createdAt: at,
    },
    human,
    source,
  );
  const parentState = yield* readCurrentState(sql, projectId);
  yield* gateway.write(
    {
      type: "project-team.investigation.start",
      projectId,
      taskId: parentTaskId,
      commandId: CommandId.make("investigate"),
      expectedRevision: parentState.revision,
      expectedTaskRevision: parentState.tasks[0]!.revision,
      objective: "Find the cause without changing project code",
      outputDescriptions: [
        "Retain an explanation supported by project source",
        ...(additionalCriterion ? ["Identify a separate verification procedure"] : []),
      ],
    },
    human,
    source,
  );
  const state = yield* readCurrentState(sql, projectId);
  const task = state.tasks.find((entry) => entry.taskId !== parentTaskId)!;
  const assignment = state.foundationRecords!.find(
    (record): record is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
      record.kind === "task-membership" && record.taskId === task.taskId,
  )!;
  const scopeHash = projectTeamScopeHash(state, task.taskId);
  const criterionId = state.criteria.find(
    (criterion) => criterion.taskId === task.taskId,
  )!.criterionId;
  const report = Effect.fn("guidedReportsTest.report")(function* (overrides: Partial<Report> = {}) {
    const current = yield* readCurrentState(sql, projectId);
    return {
      type: "project-team.assignment.report" as const,
      projectId,
      taskId: task.taskId,
      commandId: CommandId.make("report"),
      expectedRevision: current.revision,
      expectedTaskRevision: current.tasks.find((entry) => entry.taskId === task.taskId)!.revision,
      assignmentId: assignment.recordId,
      expectedAssignmentRevision: assignment.revision,
      specRevision: 1,
      planRevision: 0,
      summary,
      evidenceIds: [],
      outputArtifactIds: [],
      outcome: "findings" as const,
      ...overrides,
    };
  });
  const artifact = Effect.fn("guidedReportsTest.artifact")(function* (
    overrides: Partial<ProjectWorkEvidence> = {},
    omit?: "detail" | "criterionId",
  ) {
    const candidate: ProjectWorkEvidence = {
      evidenceId: ProjectWorkEvidenceId.make("source-artifact"),
      taskId: task.taskId,
      criterionId,
      kind: "artifact",
      summary: "Source analysis",
      detail: "The retained source excerpt explains the observed failure.",
      scopeHash,
      recordedAt: at,
      revision: 0,
      ...overrides,
    };
    const { detail, criterionId: artifactCriterionId, ...rest } = candidate;
    const evidence = {
      ...rest,
      ...(omit === "detail" || detail === undefined ? {} : { detail }),
      ...(omit === "criterionId" || artifactCriterionId === undefined
        ? {}
        : { criterionId: artifactCriterionId }),
    };
    yield* gateway.write(
      {
        type: "project-work.evidence.add",
        projectId,
        commandId: CommandId.make(`add-${evidence.evidenceId}`),
        evidence,
        addedAt: at,
      },
      human,
      source,
    );
    return evidence;
  });
  return { sql, repo, gateway, task, assignment, scopeHash, criterionId, report, artifact };
});

const snapshot = Effect.fn("guidedReportsTest.snapshot")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* ProjectWorkRepository;
  return {
    state: yield* readCurrentState(sql, projectId),
    history: yield* repo.replay(projectId),
    receipts: yield* sql`SELECT * FROM project_work_command_receipts
      WHERE project_id=${projectId} ORDER BY command_id`,
    events: yield* sql`SELECT * FROM project_work_events
      WHERE project_id=${projectId} ORDER BY sequence`,
  };
});
const retainedReport = Effect.fn("guidedReportsTest.retainedReport")(function* (
  report: Report,
  scopeHash: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const state = yield* readCurrentState(sql, projectId);
  const reports = state.evidence.filter(
    (evidence) => evidence.taskId === report.taskId && evidence.summary === report.summary,
  );
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({
    kind: "observation",
    summary: report.summary,
    detail: report.summary,
    scopeHash,
    outputArtifactIds: report.outputArtifactIds,
    attribution: { actor: human, source },
  });
  expect(reports[0]?.criterionId).toBeUndefined();
  const gateway = yield* ProjectWorkGateway;
  const publicEvidence = yield* decodeEvidence(
    yield* gateway.read({ projectId, taskId: report.taskId, operation: "evidence" }),
  );
  expect(publicEvidence.find((evidence) => evidence.evidenceId === reports[0]!.evidenceId)).toEqual(
    reports[0],
  );
  return reports[0]!;
});
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Layer.fresh(ProjectWorkProjectionLive.pipe(Layer.provideMerge(gatewayRuntime)))),
  );

for (const invalid of [
  "stale-scope",
  "wrong-task",
  "missing-detail",
  "wrong-kind",
  "missing-id",
] as const)
  it.effect(`rejects ${invalid} report artifact references without changing durable state`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        const artifact =
          invalid === "missing-id"
            ? undefined
            : yield* f.artifact(
                {
                  ...(invalid === "stale-scope" ? { scopeHash: "0".repeat(64) } : {}),
                  ...(invalid === "wrong-task" ? { taskId: parentTaskId } : {}),
                  ...(invalid === "wrong-kind" ? { kind: "observation" } : {}),
                },
                invalid === "missing-detail"
                  ? "detail"
                  : invalid === "wrong-task"
                    ? "criterionId"
                    : undefined,
              );
        const report = yield* f.report({ outputArtifactIds: [artifact?.evidenceId ?? "missing"] });
        const before = yield* snapshot();
        expect((yield* f.gateway.write(report, human, source).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* snapshot()).toEqual(before);
      }),
    ),
  );

it.effect("retains exact report links through receipt replay and projection rebuild", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* setup();
      const artifact = yield* f.artifact();
      const report = yield* f.report({ outputArtifactIds: [artifact.evidenceId] });
      const first = yield* f.gateway.write(report, human, source);
      const retained = yield* retainedReport(report, f.scopeHash);
      const before = yield* snapshot();
      const projection = yield* ProjectWorkProjection;
      yield* projection.rebuild(projectId);
      expect(yield* snapshot()).toEqual(before);
      expect(yield* retainedReport(report, f.scopeHash)).toEqual(retained);
      expect(yield* f.gateway.write(report, human, source)).toEqual(first);
      expect(yield* snapshot()).toEqual(before);
      expect(
        yield* f.sql`SELECT * FROM project_work_command_receipts
        WHERE project_id=${projectId} AND command_id=${report.commandId}`,
      ).toHaveLength(1);
      expect(
        (yield* f.repo.replay(projectId)).filter(
          (event) =>
            event.type === "project-work.evidence.added" &&
            event.evidence.evidenceId === retained.evidenceId,
        ),
      ).toHaveLength(1);
    }),
  ),
);

it.effect("rolls back a report receipt failure before retrying the exact command once", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* setup();
      const artifact = yield* f.artifact();
      const report = yield* f.report({ outputArtifactIds: [artifact.evidenceId] });
      const before = yield* snapshot();
      yield* f.sql`CREATE TRIGGER reject_report_receipt BEFORE INSERT ON project_work_command_receipts
        WHEN NEW.project_id='guided-report-project' AND NEW.command_id='report'
        BEGIN SELECT RAISE(ABORT,'report receipt rollback'); END`;
      expect((yield* f.gateway.write(report, human, source).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* snapshot()).toEqual(before);
      yield* f.sql`DROP TRIGGER reject_report_receipt`;
      const accepted = yield* f.gateway.write(report, human, source);
      yield* retainedReport(report, f.scopeHash);
      const after = yield* snapshot();
      expect(after.state.revision).toBe(accepted.receipt.revision);
      expect(accepted.receipt.revision).toBe(before.state.revision + accepted.receipt.eventCount);
      expect(yield* f.gateway.write(report, human, source)).toEqual(accepted);
      expect(yield* snapshot()).toEqual(after);
    }),
  ),
);

for (const output of [
  "summary-only",
  "unassigned-artifact",
  "wrong-criterion",
  "criterion-evidence",
] as const)
  it.effect(`requires criterion evidence to complete research with ${output}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* setup(output === "wrong-criterion");
        const current = yield* readCurrentState(f.sql, projectId);
        const artifact =
          output === "summary-only"
            ? undefined
            : yield* f.artifact(
                output === "wrong-criterion"
                  ? {
                      criterionId: current.criteria.find(
                        (criterion) =>
                          criterion.taskId === f.task.taskId &&
                          criterion.criterionId !== f.criterionId,
                      )!.criterionId,
                    }
                  : {},
                output === "unassigned-artifact" ? "criterionId" : undefined,
              );
        const report = yield* f.report({
          outcome: "complete",
          evidenceIds: artifact === undefined ? [] : [artifact.evidenceId],
          outputArtifactIds: artifact === undefined ? [] : [artifact.evidenceId],
        });
        const before = yield* snapshot();
        const result = yield* f.gateway.write(report, human, source).pipe(Effect.result);
        if (output !== "criterion-evidence") {
          expect(result._tag).toBe("Failure");
          expect(yield* snapshot()).toEqual(before);
        } else {
          expect(result._tag).toBe("Success");
          const after = yield* readCurrentState(f.sql, projectId);
          expect(after.tasks.find((task) => task.taskId === f.task.taskId)).toMatchObject({
            state: "completed",
          });
          expect(
            after.criteria.find((criterion) => criterion.criterionId === f.criterionId),
          ).toMatchObject({ status: "satisfied" });
          expect(
            after.evidence.find((evidence) => evidence.evidenceId === artifact!.evidenceId),
          ).toMatchObject({
            criterionId: f.criterionId,
            scopeHash: f.scopeHash,
            detail: artifact!.detail,
          });
          expect(after.attempts).toHaveLength(0);
          expect(after.foundationRecords?.some((record) => record.kind === "run-binding")).toBe(
            false,
          );
          yield* retainedReport(report, f.scopeHash);
        }
      }),
    ),
  );

const fileGateway = (dbPath: string) => {
  const services = Layer.mergeAll(
    Authorization.layer,
    ProjectWorkRepositoryLive,
    ProjectWorkProjectionLive,
    ProjectWorkQueryLive,
    ProjectWorkSearchLive,
    ProjectWorkNarrativeLive,
    ProjectWorkBriefingLive.pipe(Layer.provide(ProjectWorkQueryLive)),
  );
  return ProjectWorkGatewayLive.pipe(
    Layer.provideMerge(services),
    Layer.provide(Layer.mock(EnvironmentAuth)({})),
    Layer.provideMerge(ServerSettings.layerTest({ projectWorkEnabled: true })),
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
    Layer.provideMerge(NodeServices.layer),
  );
};
it.effect("reopens actual SQLite and preserves linked report evidence and its single receipt", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-guided-report-restart-" });
    const dbPath = path.join(directory, "state.sqlite");
    const saved = yield* Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        const artifact = yield* f.artifact();
        const report = yield* f.report({ outputArtifactIds: [artifact.evidenceId] });
        const result = yield* f.gateway.write(report, human, source);
        const retained = yield* retainedReport(report, f.scopeHash);
        return { report, result, retained, scopeHash: f.scopeHash, snapshot: yield* snapshot() };
      }).pipe(Effect.provide(Layer.fresh(fileGateway(dbPath)))),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* ProjectWorkGateway;
        const projection = yield* ProjectWorkProjection;
        expect(yield* snapshot()).toEqual(saved.snapshot);
        yield* projection.rebuild(projectId);
        expect(yield* retainedReport(saved.report, saved.scopeHash)).toEqual(saved.retained);
        expect(yield* gateway.write(saved.report, human, source)).toEqual(saved.result);
        expect(yield* snapshot()).toEqual(saved.snapshot);
      }).pipe(Effect.provide(Layer.fresh(fileGateway(dbPath)))),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
