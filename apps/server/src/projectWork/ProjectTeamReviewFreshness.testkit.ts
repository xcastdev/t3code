import { reviewDigest } from "./ProjectTeamReviewState.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The isolated Git fixture uses synchronous filesystem and subprocess setup before the service runs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The isolated Git fixture uses synchronous filesystem and subprocess setup before the service runs.
import * as NodePath from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The isolated Git fixture uses synchronous filesystem and subprocess setup before the service runs.
import * as NodeChildProcess from "node:child_process";
import {
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  ProjectTeamRunBinding,
  ProjectTeamTaskMembership,
  ProjectVerificationJobManifest,
  type ProjectWorkAttribution,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Runner from "../processRunner.ts";
import * as Verification from "./ProjectWorkVerification.ts";
import * as Review from "./ProjectTeamReviewFreshness.ts";
import { emptyProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import {
  projectTeamPlanHash,
  projectTeamSpecificationHash,
  projectTeamScopeHash,
} from "./ProjectTeamPolicy.ts";

export const at = "2026-10-01T00:00:00.000Z";
export const projectId = ProjectId.make("review-project");
export const taskId = ProjectWorkTaskId.make("source-task");
export const reviewTaskId = ProjectWorkTaskId.make("review-task");
export const environmentId = EnvironmentId.make("environment");
const decodeSyncProjectTeamTaskMembership = Schema.decodeSync(ProjectTeamTaskMembership);
const decodeUnknownSyncProjectTeamRunBinding = Schema.decodeUnknownSync(ProjectTeamRunBinding);
const decodeUnknownSyncProjectVerificationJobManifest = Schema.decodeUnknownSync(
  ProjectVerificationJobManifest,
);
export function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-review-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "source");
  NodeFS.writeFileSync(NodePath.join(directory, "code"), "before\n");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "code");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source");
  const head = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const state = emptyProjectWorkReducerState(projectId);
  const attribution: ProjectWorkAttribution = {
    actor: { kind: "agent", id: "review-thread" },
    source: { kind: "mcp", id: "review-session" },
    recordedAt: at,
  };
  state.tasks.push(
    ...[taskId, reviewTaskId].map((id) => ({
      taskId: id,
      projectId,
      title: id,
      state: "ready" as const,
      watchers: [],
      revision: 0,
      specRevision: 0,
      createdAt: at,
      updatedAt: at,
      attribution,
    })),
  );
  state.criteria.push({
    criterionId: ProjectWorkCriterionId.make("criterion"),
    taskId,
    description: "The code meets its requirement",
    required: true,
    status: "unsatisfied",
    revision: 0,
    updatedAt: at,
    satisfiedByEvidenceIds: [],
  });
  const plan = {
    kind: "plan-revision" as const,
    recordId: "plan",
    projectId,
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "proposed" as const,
    taskId,
    specRevision: 0,
    planRevision: 0,
    content: "Plan",
    contentHash: "plan",
    dependencyTaskIds: [],
  };
  state.foundationRecords!.push(plan);
  const common = {
    kind: "run-binding",
    projectId,
    revision: 0,
    generation: 1,
    updatedAt: at,
    environmentId,
    model: "test-model",
    roleRevisionId: "role",
    configuration: {
      instructionsHash: "instructions",
      toolIds: [],
      skillIds: [],
      runtimeVersion: "test",
      maxTokens: 1000,
      maxDurationMs: 1000,
      paidFallback: false,
    },
    workspaceState: "ready",
    workspaceKind: "root",
    worktree: directory,
    branch: "source",
    leaseGeneration: 1,
    specRevision: 0,
    planRevision: 0,
  };
  const source = decodeUnknownSyncProjectTeamRunBinding({
    ...common,
    recordId: "source-binding",
    taskId,
    attemptId: "source-attempt",
    memberId: "implementer",
    threadId: "source-thread",
    status: "settled",
    providerInstanceId: "codex",
    runId: "source-run",
    runAttemptId: "source-run-attempt",
    nodeId: "source-node",
    sessionId: "source-session",
    scopeHash: projectTeamScopeHash(state, taskId, plan),
  });
  const reviewer = decodeUnknownSyncProjectTeamRunBinding({
    ...common,
    recordId: "review-binding",
    taskId: reviewTaskId,
    attemptId: "review-attempt",
    memberId: "reviewer",
    threadId: "review-thread",
    status: "reserved",
    providerInstanceId: "codex",
  });
  const assignment = decodeSyncProjectTeamTaskMembership({
    kind: "task-membership",
    recordId: "review-assignment",
    projectId,
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "active",
    taskId: reviewTaskId,
    parentTaskId: taskId,
    executionKind: "managed",
    deliverableKind: "review",
  });
  const sourceAssignment = {
    ...assignment,
    recordId: "source-assignment",
    taskId,
    deliverableKind: "code" as const,
  };
  state.foundationRecords!.push(source, reviewer, assignment, sourceAssignment);
  const manifest = decodeUnknownSyncProjectVerificationJobManifest({
    version: 1,
    jobId: "job",
    environmentId,
    projectId,
    taskId,
    specRevision: 0,
    specificationHash: projectTeamSpecificationHash(state, taskId),
    planRevision: 0,
    planHash: projectTeamPlanHash(plan),
    criteria: [{ criterionId: "criterion", revision: 0 }],
    runId: source.runId,
    runAttemptId: source.runAttemptId,
    nodeId: source.nodeId,
    checkpointScopeId: "scope",
    dispatchId: "dispatch",
    bindingId: source.recordId,
    generation: 1,
    workspaceReceiptHash: "a".repeat(64),
    command: {
      executable: "/bin/true",
      argv: [],
      environment: "clean",
      limits: { maxDurationMs: 1000, maxOutputBytes: 1000 },
    },
    target: {
      repository: directory,
      worktree: directory,
      branchRef: "refs/heads/source",
      baseSha: head,
      headSha: head,
      testedCommit: head,
      testedTree: tree,
      workspaceState: "clean-committed",
    },
    executable: {
      target: "/bin/true",
      sha256: "a".repeat(64),
      runtimeClosureSha256: "b".repeat(64),
    },
  });
  const receipt: Verification.VerificationReceipt = {
    manifest,
    manifestHash: reviewDigest(manifest),
    stage: "applied",
    claimId: "verification-attempt",
    result: {
      outcome: "success",
      exitCode: 0,
      stdout: "verified",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sha256: "c".repeat(64),
    },
  };
  const verification = Verification.ProjectWorkVerification.of({
    read: () => Effect.succeedSome(receipt),
    capture: () => Effect.die("unused"),
    prepare: () => Effect.die("unused"),
    execute: () => Effect.die("unused"),
  });
  const database = Persistence.layerMemory;
  const layer = Review.layer.pipe(
    Layer.provide(Layer.succeed(Verification.ProjectWorkVerification, verification)),
    Layer.provide(
      Layer.succeed(
        Environment.ServerEnvironment,
        Environment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(environmentId),
          getDescriptor: Effect.die("unused"),
        }),
      ),
    ),
    Layer.provide(Runner.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provideMerge(database),
  );
  return {
    state,
    reviewer,
    source,
    assignment,
    sourceAssignment,
    manifest,
    receipt,
    attribution,
    layer,
    git,
    directory,
    [Symbol.dispose]() {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}
export const table = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS t3_workflow_v2_team_reviews(environment_id TEXT NOT NULL,project_id TEXT NOT NULL,review_binding_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,proposal_json TEXT,completion_json TEXT,PRIMARY KEY(environment_id,project_id,review_binding_id))`;
  yield* sql`INSERT INTO t3_workflow_v2_team_dispatches(dispatch_id,project_id,task_id,binding_id,thread_id,generation,fingerprint,request_json,assignment,result_json,stage,created_at,updated_at) VALUES('review-dispatch',${projectId},${reviewTaskId},'review-binding','review-thread',1,'unused','{}','unused','{}','observed',${at},${at})`;
  return sql;
});
