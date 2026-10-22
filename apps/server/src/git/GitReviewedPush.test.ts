import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GitRunStackedActionInput,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeGitVcsDriverCore } from "../vcs/GitVcsDriverCore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitIndexOperations from "./GitIndexOperations.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";

const testLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-reviewed-push-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const decodeInput = Schema.decodeUnknownSync(GitRunStackedActionInput);

it.live.each([0, 1])(
  "retries only the retained branch and commit after another checkout (push exit %s)",
  (pushExit) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const index = yield* GitIndexOperations.make;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reviewed-push-" });
      const run = (args: readonly string[]) =>
        git.execute({ operation: "test.reviewedPush", cwd, args });
      for (const args of [
        ["init", "-b", "main"],
        ["config", "user.name", "Test"],
        ["config", "user.email", "test@example.invalid"],
        ["config", "commit.gpgSign", "false"],
      ])
        yield* run(args);
      yield* fs.makeDirectory(`${cwd}/hooks`);
      yield* run(["config", "core.hooksPath", `${cwd}/hooks`]);
      yield* fs.writeFileString(`${cwd}/a.txt`, "initial\n");
      yield* run(["add", "a.txt"]);
      yield* run(["commit", "-m", "initial"]);
      const base = (yield* run(["rev-parse", "HEAD"])).stdout.trim();
      yield* run(["branch", "external"]);
      yield* fs.writeFileString(`${cwd}/a.txt`, "retained\n");
      yield* run(["add", "a.txt"]);
      const reviewed = yield* index.indexStatus({ cwd });
      const retained = yield* index.commitStaged({
        cwd,
        expected: reviewed.fingerprint,
        message: "retained commit",
        push: true,
      });
      assert.equal(retained.push, "failed");
      for (const [branch, remote] of [
        ["main", "origin"],
        ["external", "other"],
      ] as const) {
        yield* run(["remote", "add", remote, `https://example.invalid/${remote}.git`]);
        yield* run(["config", `branch.${branch}.remote`, remote]);
        yield* run(["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
        yield* run(["update-ref", `refs/remotes/${remote}/${branch}`, base]);
      }
      yield* run(["symbolic-ref", "HEAD", "refs/heads/external"]);
      yield* fs.writeFileString(`${cwd}/external.txt`, "external work\n");
      yield* run(["add", "external.txt"]);
      yield* run(["commit", "-m", "external commit"]);
      yield* fs.writeFileString(`${cwd}/external.txt`, "uncommitted external work\n");
      const external = yield* index.indexStatus({ cwd });
      const commitCount = (yield* run(["rev-list", "--all", "--count"])).stdout;
      const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const pushes: Array<readonly string[]> = [];
      const guardedSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (
            !ChildProcess.isStandardCommand(command) ||
            !command.args.some((arg) => ["push", "fetch", "ls-remote"].includes(arg))
          )
            return yield* nativeSpawner.spawn(command);
          if (command.args.includes("push")) pushes.push(command.args);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(pushExit)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const adapter = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, guardedSpawner),
      );
      const vcs = yield* GitVcsDriver.makeVcsDriver;
      const repository = yield* vcs.detectRepository(cwd);
      if (repository === null) throw new Error("Expected the disposable repository");
      const handle = { kind: "git" as const, repository, driver: vcs };
      const registry = VcsDriverRegistry.VcsDriverRegistry.of({
        resolve: () => Effect.succeed(handle),
        detect: () => Effect.succeed(handle),
        get: () => Effect.succeed(vcs),
      });
      const legacyPush = Effect.fn("test.legacyPush")(function* (): Effect.fn.Return<
        GitRunStackedActionResult,
        import("@t3tools/contracts").GitCommandError
      > {
        const push = yield* adapter.pushCurrentBranch(cwd, null);
        return {
          action: "push",
          branch: { status: "skipped_not_requested" },
          commit: { status: "skipped_not_requested" },
          push,
          pr: { status: "skipped_not_requested" },
          toast: { title: "Pushed", cta: { kind: "none" } },
        };
      });
      const workflow = yield* GitWorkflowService.make.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, adapter),
        Effect.provideService(VcsDriverRegistry.VcsDriverRegistry, registry),
        Effect.provide(
          Layer.mock(GitManager.GitManager)({
            runStackedAction: legacyPush,
            invalidateStatus: () => Effect.void,
          }),
        ),
      );
      const events: GitActionProgressEvent[] = [];
      const input = decodeInput({
        cwd,
        actionId: "retry-main",
        action: "push",
        reviewedPush: { branchRef: retained.branchRef, commitSha: retained.commitSha },
      });
      const outcome = yield* workflow
        .runStackedAction(input, {
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        })
        .pipe(Effect.result);
      assert.equal(pushes.length, 1);
      assert.include(pushes[0]!, "origin");
      assert.include(pushes[0]!, `${retained.commitSha}:refs/heads/main`);
      assert.include(pushes[0]!, `--force-with-lease=refs/heads/main:${base}`);
      assert.deepEqual((yield* index.indexStatus({ cwd })).fingerprint, external.fingerprint);
      assert.equal((yield* run(["rev-list", "--all", "--count"])).stdout, commitCount);
      if (pushExit === 0) {
        assert.equal(outcome._tag, "Success");
        if (outcome._tag === "Success") {
          assert.equal(outcome.success.push.branch, "main");
          assert.equal(outcome.success.commit.status, "skipped_not_requested");
        }
        assert.equal(events.at(-1)?.kind, "action_finished");
      } else {
        assert.equal(outcome._tag, "Failure");
        assert.equal(events.at(-1)?.kind, "action_failed");
      }
      const invalid = yield* workflow
        .runStackedAction({ ...input, action: "commit", commitMessage: "must not recommit" })
        .pipe(Effect.result);
      assert.equal(invalid._tag, "Failure");
      assert.equal(pushes.length, 1);
      assert.equal((yield* run(["rev-list", "--all", "--count"])).stdout, commitCount);
      const ordinary = yield* workflow
        .runStackedAction(decodeInput({ cwd, actionId: "ordinary-external", action: "push" }))
        .pipe(Effect.result);
      assert.equal(ordinary._tag, pushExit === 0 ? "Success" : "Failure");
      assert.include(pushes[1]!, "HEAD:refs/heads/external");
      const externalCommit = external.fingerprint.headCommit;
      if (externalCommit === null) throw new Error("Expected the external branch commit");
      yield* run(["update-ref", "refs/heads/main", externalCommit]);
      const stale = yield* workflow.runStackedAction(input).pipe(Effect.result);
      assert.equal(stale._tag, "Failure");
      assert.equal(pushes.length, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
