import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

describe("GitWorkflowService", () => {
  it.effect("routes Git index operations through the Git driver", () => {
    const stageFiles = vi.fn(() => Effect.succeed(undefined));
    const unstageFiles = vi.fn(() => Effect.succeed(undefined));
    const getWorkingTreeDiff = vi.fn(() => Effect.succeed({ diff: "diff", truncated: false }));
    const commitIndex = vi.fn(() => Effect.succeed({ commitSha: "abc123" }));
    const pullCurrentBranch = vi.fn(() =>
      Effect.succeed({
        status: "skipped_up_to_date" as const,
        refName: "main",
        upstreamRef: null,
      }),
    );
    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () =>
            Effect.succeed({
              kind: "git",
              repository: {
                kind: "git",
                rootPath: "/repo",
                metadataPath: "/repo/.git",
              },
            } as VcsDriverRegistry.VcsDriverHandle),
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          stageFiles,
          unstageFiles,
          getWorkingTreeDiff,
          commitIndex,
          pullCurrentBranch,
        }),
      ),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.stageFiles({ cwd: "/repo", paths: ["a.txt"] });
      yield* workflow.unstageFiles({ cwd: "/repo", paths: ["a.txt"] });
      const diff = yield* workflow.getWorkingTreeDiff({
        cwd: "/repo",
        path: "a.txt",
        comparison: "head",
      });
      const commit = yield* workflow.commitIndex({ cwd: "/repo", message: "commit a" });
      const pull = yield* workflow.pullCurrentBranch("/repo");

      expect(diff).toEqual({ diff: "diff", truncated: false });
      expect(commit).toEqual({ commitSha: "abc123" });
      expect(pull).toEqual({
        status: "skipped_up_to_date",
        refName: "main",
        upstreamRef: null,
      });
      expect(stageFiles).toHaveBeenCalledWith({ cwd: "/repo", paths: ["a.txt"] });
      expect(unstageFiles).toHaveBeenCalledWith({ cwd: "/repo", paths: ["a.txt"] });
      expect(getWorkingTreeDiff).toHaveBeenCalledWith({
        cwd: "/repo",
        path: "a.txt",
        comparison: "head",
      });
      expect(commitIndex).toHaveBeenCalledWith({ cwd: "/repo", message: "commit a" });
      expect(pullCurrentBranch).toHaveBeenCalledWith("/repo");
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("serializes index and ref mutations by resolved repository identity", () =>
    Effect.gen(function* () {
      const stageStarted = yield* Deferred.make<void>();
      const releaseStage = yield* Deferred.make<void>();
      const queuedCallsResolved = yield* Deferred.make<void>();
      let stageActive = false;
      let resolveCalls = 0;
      const overlappingMutations: string[] = [];
      const recordMutation = (name: string) =>
        Effect.sync(() => {
          if (stageActive) overlappingMutations.push(name);
        });
      const testLayer = GitWorkflowService.layer.pipe(
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            resolve: ({ cwd }) =>
              Effect.sync(() => {
                resolveCalls += 1;
                return resolveCalls;
              }).pipe(
                Effect.tap((count) =>
                  count === 7 ? Deferred.succeed(queuedCallsResolved, undefined) : Effect.void,
                ),
                Effect.as({
                  kind: "git",
                  repository: {
                    kind: "git",
                    rootPath: "/repo",
                    metadataPath: cwd === "/repo" ? ".git" : "../.git",
                  },
                } as VcsDriverRegistry.VcsDriverHandle),
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            stageFiles: () =>
              Effect.gen(function* () {
                stageActive = true;
                yield* Deferred.succeed(stageStarted, undefined);
                yield* Deferred.await(releaseStage);
                stageActive = false;
              }),
            unstageFiles: () => recordMutation("unstage"),
            commitIndex: () => recordMutation("commit").pipe(Effect.as({ commitSha: "abc123" })),
            pullCurrentBranch: () =>
              recordMutation("pull").pipe(
                Effect.as({
                  status: "skipped_up_to_date" as const,
                  refName: "main",
                  upstreamRef: null,
                }),
              ),
            createRef: (input) =>
              recordMutation("create-and-switch").pipe(Effect.as({ refName: input.refName })),
            switchRef: (input) =>
              recordMutation("switch").pipe(Effect.as({ refName: input.refName })),
          }),
        ),
        Layer.provide(Layer.mock(GitManager.GitManager)({})),
      );

      yield* Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const stageFiber = yield* workflow
          .stageFiles({ cwd: "/repo", paths: ["a.txt"] })
          .pipe(Effect.forkChild);
        yield* Deferred.await(stageStarted);
        const queuedFibers = yield* Effect.forEach(
          [
            workflow.unstageFiles({ cwd: "/repo/nested", paths: ["a.txt"] }),
            workflow.commitIndex({ cwd: "/repo/nested", message: "commit" }),
            workflow.createRef({
              cwd: "/repo/nested",
              refName: "feature/new",
              switchRef: true,
            }),
            workflow.switchRef({ cwd: "/repo/nested", refName: "feature/test" }),
            workflow.pullCurrentBranch("/repo/nested"),
            workflow.withRepositoryPermit(
              "GitWorkflowService.refreshLocalStatus",
              "/repo/nested",
              recordMutation("refresh"),
            ),
          ],
          (effect) => effect.pipe(Effect.forkChild),
        );
        yield* Deferred.await(queuedCallsResolved);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseStage, undefined);
        yield* Fiber.join(stageFiber);
        yield* Effect.forEach(queuedFibers, Fiber.join);

        assert.deepStrictEqual(overlappingMutations, []);
      }).pipe(Effect.provide(testLayer));
    }),
  );

  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });
});
