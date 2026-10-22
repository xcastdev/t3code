// @effect-diagnostics-next-line nodeBuiltinImport:off -- Disposable verification fixtures use real Git without provider processes.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixtures own and remove their temporary directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Canonical temporary paths are part of the target capture.
import * as NodePath from "node:path";
import {
  CheckpointScopeId,
  EnvironmentId,
  NodeId,
  ProjectId,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";
import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Verification from "./ProjectWorkVerification.ts";
import { verificationError } from "./ProjectWorkVerificationError.ts";

export const output: ProcessRunOutput = {
  code: ExitCode(0),
  timedOut: false,
  stdout: "verified",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};
export const setup = Effect.fn("VerificationFixture.setup")(function* (
  run: (
    input: ProcessRunInput,
  ) => Effect.Effect<ProcessRunOutput, never, SqlClient.SqlClient> = () => Effect.succeed(output),
  beforeGit: (input: ProcessRunInput) => Effect.Effect<void> = () => Effect.void,
) {
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-verification-"))),
    (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );
  const repo = NodePath.join(root, "repo");
  NodeFS.mkdirSync(repo);
  const git = (args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    ).trim();
  git(["init", "--initial-branch=main"]);
  NodeFS.writeFileSync(NodePath.join(repo, "source"), "original");
  git(["add", "source"]);
  git(["commit", "-m", "fixture"]);
  const executable = NodePath.join(root, "verify");
  NodeFS.writeFileSync(executable, "fixture executable", { mode: 0o700 });
  const input: Verification.VerificationManifestInput = {
    version: 1,
    jobId: "verification-job",
    environmentId: EnvironmentId.make("env"),
    projectId: ProjectId.make("project"),
    taskId: ProjectWorkTaskId.make("task"),
    specRevision: 1,
    specificationHash: "1".repeat(64),
    planRevision: 1,
    planHash: "2".repeat(64),
    criteria: [{ criterionId: ProjectWorkCriterionId.make("criterion"), revision: 1 }],
    runId: RunId.make("run"),
    runAttemptId: RunAttemptId.make("attempt"),
    nodeId: NodeId.make("node"),
    checkpointScopeId: CheckpointScopeId.make("scope"),
    dispatchId: "dispatch",
    bindingId: "binding",
    generation: 1,
    workspaceReceiptHash: "3".repeat(64),
    command: {
      executable,
      argv: ["--exact", "a b"],
      environment: "clean",
      limits: { maxDurationMs: 1000, maxOutputBytes: 4096 },
    },
    target: {
      repository: repo,
      worktree: repo,
      branchRef: "refs/heads/main",
      baseSha: git(["rev-parse", "HEAD"]),
      headSha: git(["rev-parse", "HEAD"]),
      testedCommit: git(["rev-parse", "HEAD"]),
      testedTree: git(["rev-parse", "HEAD^{tree}"]),
      workspaceState: "clean-committed",
    },
  };
  const runnerLayer = Layer.effect(
    ProcessRunner,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return ProcessRunner.of({
        run: (request) =>
          request.command === "git"
            ? Effect.gen(function* () {
                yield* beforeGit(request);
                if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
                  return yield* Effect.die(new Error("Verification must not spawn Git inside SQL"));
                return yield* Effect.try({
                  try: () => ({ ...output, stdout: git(request.args) }),
                  catch: () => verificationError("changed-target"),
                }).pipe(Effect.orDie);
              })
            : run(request).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      });
    }),
  );
  const layer = Verification.layer.pipe(
    Layer.provideMerge(runnerLayer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return {
    input,
    root,
    repo,
    executable,
    git,
    layer,
    replace: () => {
      const replacement = NodePath.join(root, "replacement");
      NodeFS.writeFileSync(replacement, "replacement executable", { mode: 0o700 });
      NodeFS.renameSync(replacement, executable);
    },
    changeHead: () => {
      NodeFS.writeFileSync(NodePath.join(repo, "source"), "changed");
      git(["add", "source"]);
      git(["commit", "-m", "changed"]);
    },
  };
});
export const ensureTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS t3_workflow_v2_verification_jobs (project_id TEXT NOT NULL, job_id TEXT NOT NULL, manifest_hash TEXT NOT NULL, manifest_json TEXT NOT NULL, runtime_files_json TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('prepared','claimed','finished','applied')), claim_id TEXT, result_json TEXT, PRIMARY KEY(project_id,job_id))`;
});
