import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as PlatformError from "effect/PlatformError";

import {
  EnvironmentId,
  GitCommandError,
  type VcsStatusResult,
  VcsRepositoryDetectionError,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

import { pullStrategyArgs, requiresGitActionConfirmation } from "./GitWorkflowService.ts";
import { ServerConfig } from "../config.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../../../../packages/client-runtime/src/connection/model.ts";
import { EnvironmentRegistry } from "../../../../packages/client-runtime/src/connection/registry.ts";
import { EnvironmentSupervisor } from "../../../../packages/client-runtime/src/connection/supervisor.ts";
import { EnvironmentCacheStore } from "../../../../packages/client-runtime/src/platform/persistence.ts";
import type { WsRpcProtocolClient } from "../../../../packages/client-runtime/src/rpc/protocol.ts";
import type { RpcSession } from "../../../../packages/client-runtime/src/rpc/session.ts";
import {
  createSourceControlWorkspaceEnvironmentAtoms,
  sourceControlWorkspaceRevisionAtom,
} from "../../../../packages/client-runtime/src/state/sourceControlWorkspace.ts";

const RealGitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-workflow-real-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const clientEnvironmentId = EnvironmentId.make("real-submodule-client-test");

const makeClientWorkspaceHarness = Effect.fn(function* (client: Readonly<Record<string, unknown>>) {
  const protocol = client as unknown as WsRpcProtocolClient;
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: clientEnvironmentId,
      label: "test",
      httpBaseUrl: "http://test",
      wsBaseUrl: "ws://test",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
      generation: 1,
    }),
    session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
      Option.some({
        client: protocol,
        initialConfig: Effect.never,
        subscribeServerConfig: protocol.subscribeServerConfig,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      }),
    ),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
    Stream.provideService(stream, EnvironmentSupervisor, supervisor);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry, { run, followStream } as EnvironmentRegistry["Service"]),
      Layer.succeed(
        EnvironmentCacheStore,
        EnvironmentCacheStore.of({
          loadShell: () => Effect.succeed(Option.none()),
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeed(Option.none()),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeed(Option.none()),
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeed(Option.none()),
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        }),
      ),
    ),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  const capabilities = Atom.make<{ sourceControlWorkspace?: boolean }>({
    sourceControlWorkspace: true,
  });
  return {
    registry,
    atoms: createSourceControlWorkspaceEnvironmentAtoms(runtime, {
      capabilities: (currentRegistry) => currentRegistry.get(capabilities),
    }),
  };
});

const makeRealGitWorkflowLayer = (
  driver: GitVcsDriver.GitVcsDriver["Service"],
  vcsDriver: VcsDriverRegistry.VcsDriverHandle["driver"],
  gitManager: Partial<GitManager.GitManager["Service"]> = {},
) =>
  GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.succeed(
        VcsDriverRegistry.VcsDriverRegistry,
        VcsDriverRegistry.VcsDriverRegistry.of({
          get: () => Effect.succeed(vcsDriver),
          detect: ({ cwd }) =>
            vcsDriver
              .detectRepository(cwd)
              .pipe(
                Effect.map((repository) =>
                  repository === null
                    ? null
                    : { kind: "git" as const, repository, driver: vcsDriver },
                ),
              ),
          resolve: ({ cwd }) =>
            vcsDriver
              .detectRepository(cwd)
              .pipe(
                Effect.flatMap((repository) =>
                  repository === null
                    ? Effect.die(`Expected real Git repository at ${cwd}`)
                    : Effect.succeed({ kind: "git" as const, repository, driver: vcsDriver }),
                ),
              ),
        }),
      ),
    ),
    Layer.provide(Layer.succeed(GitVcsDriver.GitVcsDriver, driver)),
    Layer.provide(Layer.mock(GitManager.GitManager)(gitManager)),
  );

const makeRealGitDir = (): Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-workflow-real-" });
  });

const realGit = (
  driver: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
  args: readonly string[],
) =>
  driver
    .execute({ operation: "GitWorkflowService.real-test", cwd, args })
    .pipe(Effect.map((result) => result.stdout.trim()));

const initRealGitRepo = (driver: GitVcsDriver.GitVcsDriver["Service"], cwd: string) =>
  Effect.gen(function* () {
    yield* driver.initRepo({ cwd });
    yield* realGit(driver, cwd, ["config", "user.email", "test@example.com"]);
    yield* realGit(driver, cwd, ["config", "user.name", "Test"]);
    const files = yield* FileSystem.FileSystem;
    yield* files.writeFileString(`${cwd}/README.md`, "initial\n");
    yield* realGit(driver, cwd, ["add", "README.md"]);
    yield* realGit(driver, cwd, ["commit", "-m", "initial"]);
  });

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
  it.effect("rejects a stale reviewed pull-request checkout before it reaches GitManager", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const vcsDriver = yield* GitVcsDriver.makeVcsDriver;
        const preparePullRequestThread = vi.fn(() => Effect.die("must not prepare"));
        yield* Effect.gen(function* () {
          const cwd = yield* makeRealGitDir();
          yield* initRealGitRepo(driver, cwd);
          const workflow = yield* GitWorkflowService.GitWorkflowService;
          const error = yield* workflow
            .preparePullRequestThread({
              cwd,
              reference: "#7",
              mode: "local",
              precondition: {
                expectedHeadCommit: "f".repeat(40),
                expectedIndexTree: "e".repeat(40),
                expectedRefName: "main",
              },
            })
            .pipe(Effect.flip);
          if (error._tag !== "GitCommandError") {
            throw new Error(`Expected GitCommandError, received ${error._tag}`);
          }
          assert.equal(error.code, "stale_git_state");
          assert.equal(preparePullRequestThread.mock.calls.length, 0);
        }).pipe(
          Effect.provide(makeRealGitWorkflowLayer(driver, vcsDriver, { preparePullRequestThread })),
        );
      }),
    ).pipe(Effect.provide(RealGitLayer)),
  );
  it.effect(
    "refreshes a mounted real parent after a selected child client commit changes its gitlink",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const parentDirectory = yield* makeRealGitDir();
          const childSourceDirectory = yield* makeRealGitDir();
          yield* initRealGitRepo(driver, parentDirectory);
          yield* initRealGitRepo(driver, childSourceDirectory);
          yield* realGit(driver, parentDirectory, [
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            childSourceDirectory,
            "vendor/child",
          ]);
          yield* realGit(driver, parentDirectory, ["commit", "-am", "add child gitlink"]);
          const childDirectory = `${parentDirectory}/vendor/child`;
          type ParentStatusGeneration = {
            readonly childHead: string;
            readonly status: VcsStatusResult;
          };
          let awaitingParentStatusGeneration: Deferred.Deferred<ParentStatusGeneration> | undefined;
          const { atoms, registry } = yield* makeClientWorkspaceHarness({
            [WS_METHODS.gitDiscoverRepositories]: (input: { readonly cwd: string }) =>
              driver.discoverRepositories(input),
            [WS_METHODS.vcsStageFiles]: (input: {
              readonly cwd: string;
              readonly paths: readonly string[];
            }) => driver.stageFiles(input),
            [WS_METHODS.gitCommitIndex]: (input: {
              readonly cwd: string;
              readonly message: string;
            }) => driver.commitIndex(input),
            [WS_METHODS.subscribeVcsStatus]: ({ cwd }: { readonly cwd: string }) =>
              Stream.unwrap(
                driver.status({ cwd }).pipe(
                  Effect.flatMap((local) => {
                    const event = { _tag: "snapshot" as const, local, remote: null };
                    if (cwd !== parentDirectory) return Effect.succeed(Stream.make(event));
                    return realGit(driver, childDirectory, ["rev-parse", "HEAD"]).pipe(
                      Effect.map((childHead) => {
                        const generation = { childHead, status: local };
                        // The marker follows the real status event, so the client has consumed and
                        // published its revision before this test can observe the generation.
                        const markConsumed = Stream.fromEffect(
                          Effect.sync(() => awaitingParentStatusGeneration).pipe(
                            Effect.flatMap((awaiting) =>
                              awaiting === undefined
                                ? Effect.void
                                : Deferred.succeed(awaiting, generation).pipe(Effect.asVoid),
                            ),
                          ),
                        ).pipe(Stream.drain);
                        return Stream.concat(Stream.make(event), markConsumed);
                      }),
                    );
                  }),
                ),
              ),
          });
          const discovered = yield* Effect.promise(() =>
            atoms.discoverRepositories.run(registry, {
              environmentId: clientEnvironmentId,
              input: { cwd: parentDirectory },
            }),
          );
          assert.isTrue(AsyncResult.isSuccess(discovered));
          if (AsyncResult.isFailure(discovered)) {
            return yield* Effect.die("Expected real parent/child repository discovery to succeed.");
          }
          assert.isTrue(
            discovered.value.repositories.some(
              (repository) => repository.rootPath === childDirectory && repository.isSubmodule,
            ),
          );
          const parentStatus = atoms.status({
            environmentId: clientEnvironmentId,
            input: { cwd: parentDirectory },
          });
          yield* AtomRegistry.mount(registry, parentStatus);
          yield* AtomRegistry.getResult(registry, parentStatus);

          const parentScope = {
            environmentId: clientEnvironmentId,
            repositoryRoot: parentDirectory,
          };
          const parentHead = yield* realGit(driver, parentDirectory, ["rev-parse", "HEAD"]);
          const parentIndexTree = yield* realGit(driver, parentDirectory, ["write-tree"]);
          const childHead = yield* realGit(driver, childDirectory, ["rev-parse", "HEAD"]);
          const files = yield* FileSystem.FileSystem;
          yield* files.writeFileString(`${childDirectory}/README.md`, "child-only change\n");
          const parentRevisionBeforeStage = registry.get(
            sourceControlWorkspaceRevisionAtom(parentScope),
          );
          const stagedParentStatusGeneration = yield* Deferred.make<ParentStatusGeneration>();
          awaitingParentStatusGeneration = stagedParentStatusGeneration;
          const staged = yield* Effect.promise(() =>
            atoms.stageFiles.run(registry, {
              environmentId: clientEnvironmentId,
              input: { cwd: childDirectory, paths: ["README.md"] },
            }),
          );
          assert.isTrue(AsyncResult.isSuccess(staged));
          const stagedParentStatus = yield* Deferred.await(stagedParentStatusGeneration);
          awaitingParentStatusGeneration = undefined;
          const parentRevisionAfterStage = registry.get(
            sourceControlWorkspaceRevisionAtom(parentScope),
          );
          assert.isAbove(parentRevisionAfterStage, parentRevisionBeforeStage);
          assert.equal(stagedParentStatus.childHead, childHead);
          assert.equal(
            stagedParentStatus.status.workingTree.files.find((file) => file.path === "vendor/child")
              ?.indexStatus,
            "unstaged",
          );
          const parentRevisionBeforeCommit = parentRevisionAfterStage;
          const committedParentStatusGeneration = yield* Deferred.make<ParentStatusGeneration>();
          awaitingParentStatusGeneration = committedParentStatusGeneration;
          const committed = yield* Effect.promise(() =>
            atoms.commitIndex.run(registry, {
              environmentId: clientEnvironmentId,
              input: { cwd: childDirectory, message: "child only" },
            }),
          );
          assert.isTrue(AsyncResult.isSuccess(committed));
          if (AsyncResult.isFailure(committed)) {
            return yield* Effect.die("Expected real child client commit to succeed.");
          }

          const committedParentStatus = yield* Deferred.await(committedParentStatusGeneration);
          awaitingParentStatusGeneration = undefined;
          assert.isAbove(
            registry.get(sourceControlWorkspaceRevisionAtom(parentScope)),
            parentRevisionBeforeCommit,
          );
          assert.equal(committedParentStatus.childHead, committed.value.commitSha);
          assert.notEqual(committedParentStatus.status, stagedParentStatus.status);
          assert.equal(
            committedParentStatus.status.workingTree.files.find(
              (file) => file.path === "vendor/child",
            )?.indexStatus,
            "unstaged",
          );
          assert.equal(
            yield* realGit(driver, childDirectory, ["rev-parse", "HEAD"]),
            committed.value.commitSha,
          );
          assert.notEqual(committed.value.commitSha, childHead);
          assert.equal(yield* realGit(driver, parentDirectory, ["rev-parse", "HEAD"]), parentHead);
          assert.equal(yield* realGit(driver, parentDirectory, ["write-tree"]), parentIndexTree);
          assert.equal(
            yield* realGit(driver, parentDirectory, ["diff", "--cached", "--name-only"]),
            "",
          );
        }).pipe(Effect.provide(RealGitLayer)),
      ),
  );

  it.effect("continues and aborts a real cherry-pick conflict through the workflow service", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const vcsDriver = yield* GitVcsDriver.makeVcsDriver;
        yield* Effect.gen(function* () {
          const cwd = yield* makeRealGitDir();
          const files = yield* FileSystem.FileSystem;
          yield* initRealGitRepo(driver, cwd);
          yield* realGit(driver, cwd, ["config", "core.editor", "true"]);
          const main = yield* realGit(driver, cwd, ["branch", "--show-current"]);
          yield* realGit(driver, cwd, ["checkout", "-b", "topic"]);
          yield* files.writeFileString(`${cwd}/README.md`, "topic\n");
          yield* realGit(driver, cwd, ["commit", "-am", "topic"]);
          const topicCommit = yield* realGit(driver, cwd, ["rev-parse", "HEAD"]);
          yield* realGit(driver, cwd, ["checkout", main]);
          yield* files.writeFileString(`${cwd}/README.md`, "main\n");
          yield* realGit(driver, cwd, ["commit", "-am", "main"]);
          const mainHead = yield* realGit(driver, cwd, ["rev-parse", "HEAD"]);
          const workflow = yield* GitWorkflowService.GitWorkflowService;

          const conflicted = yield* Effect.exit(
            workflow.runAction({
              cwd,
              action: "cherry-pick",
              targetRef: topicCommit,
              confirm: true,
            }),
          );
          assert.isTrue(Exit.isFailure(conflicted));
          yield* files.writeFileString(`${cwd}/README.md`, "resolved\n");
          yield* realGit(driver, cwd, ["add", "README.md"]);
          const continued = yield* workflow.runAction({
            cwd,
            action: "conflict",
            conflictOperation: "continue",
            confirm: true,
          });
          assert.deepStrictEqual(continued.completed, ["conflict-continue"]);
          assert.equal(yield* files.readFileString(`${cwd}/README.md`), "resolved\n");
          assert.notEqual(yield* realGit(driver, cwd, ["rev-parse", "HEAD"]), mainHead);

          yield* realGit(driver, cwd, ["reset", "--hard", mainHead]);
          const conflictedAgain = yield* Effect.exit(
            workflow.runAction({
              cwd,
              action: "cherry-pick",
              targetRef: topicCommit,
              confirm: true,
            }),
          );
          assert.isTrue(Exit.isFailure(conflictedAgain));
          const aborted = yield* workflow.runAction({
            cwd,
            action: "conflict",
            conflictOperation: "abort",
            confirm: true,
          });
          assert.deepStrictEqual(aborted.completed, ["conflict-abort"]);
          assert.equal(yield* realGit(driver, cwd, ["rev-parse", "HEAD"]), mainHead);
          assert.equal(yield* files.readFileString(`${cwd}/README.md`), "main\n");
        }).pipe(Effect.provide(makeRealGitWorkflowLayer(driver, vcsDriver)));
      }).pipe(Effect.provide(RealGitLayer)),
    ),
  );

  it.effect(
    "uses merge reset to preserve dirty work and requires confirmation before hard reset discards it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const vcsDriver = yield* GitVcsDriver.makeVcsDriver;
          yield* Effect.gen(function* () {
            const cwd = yield* makeRealGitDir();
            const files = yield* FileSystem.FileSystem;
            yield* initRealGitRepo(driver, cwd);
            const head = yield* realGit(driver, cwd, ["rev-parse", "HEAD"]);
            const workflow = yield* GitWorkflowService.GitWorkflowService;
            yield* files.writeFileString(`${cwd}/README.md`, "dirty\n");
            const preserved = yield* workflow.runAction({
              cwd,
              action: "reset",
              targetRef: head,
              strategy: "merge",
              confirm: true,
            });
            assert.deepStrictEqual(preserved.completed, ["reset"]);
            assert.equal(yield* files.readFileString(`${cwd}/README.md`), "dirty\n");
            const unconfirmed = yield* Effect.exit(
              workflow.runAction({
                cwd,
                action: "reset",
                targetRef: head,
                strategy: "hard",
                confirm: false,
              }),
            );
            assert.isTrue(Exit.isFailure(unconfirmed));
            assert.equal(yield* files.readFileString(`${cwd}/README.md`), "dirty\n");
            const discarded = yield* workflow.runAction({
              cwd,
              action: "reset",
              targetRef: head,
              strategy: "hard",
              confirm: true,
            });
            assert.deepStrictEqual(discarded.completed, ["reset"]);
            assert.equal(yield* files.readFileString(`${cwd}/README.md`), "initial\n");
          }).pipe(Effect.provide(makeRealGitWorkflowLayer(driver, vcsDriver)));
        }).pipe(Effect.provide(RealGitLayer)),
      ),
  );

  it.effect(
    "returns real compound commit receipts after push and pull failures without rolling back the commit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const vcsDriver = yield* GitVcsDriver.makeVcsDriver;
          yield* Effect.gen(function* () {
            const cwd = yield* makeRealGitDir();
            const remote = yield* makeRealGitDir();
            const files = yield* FileSystem.FileSystem;
            yield* initRealGitRepo(driver, cwd);
            yield* realGit(driver, remote, ["init", "--bare"]);
            const branch = yield* realGit(driver, cwd, ["branch", "--show-current"]);
            yield* realGit(driver, cwd, ["remote", "add", "origin", remote]);
            yield* realGit(driver, cwd, ["push", "-u", "origin", branch]);
            const workflow = yield* GitWorkflowService.GitWorkflowService;

            yield* files.writeFileString(`${cwd}/README.md`, "pushed\n");
            yield* realGit(driver, cwd, ["add", "README.md"]);
            const pushed = yield* workflow.runAction({
              cwd,
              action: "commit",
              message: "pushed",
              compoundOperation: "commit-push",
              confirm: true,
            });
            assert.deepStrictEqual(pushed.completed, ["commit", "push"]);
            assert.equal(
              yield* realGit(driver, remote, ["rev-parse", `refs/heads/${branch}`]),
              yield* realGit(driver, cwd, ["rev-parse", "HEAD"]),
            );

            yield* files.writeFileString(`${cwd}/README.md`, "push failure\n");
            yield* realGit(driver, cwd, ["add", "README.md"]);
            const pushFailed = yield* workflow.runAction({
              cwd,
              action: "commit",
              message: "push failure",
              compoundOperation: "commit-push",
              remoteName: "missing",
              confirm: true,
            });
            assert.deepStrictEqual(pushFailed.completed, ["commit"]);
            assert.equal(pushFailed.failedStep, "push");
            assert.deepStrictEqual(pushFailed.continuation, {
              action: "push",
              sourceRef: branch,
              remoteName: "missing",
            });
            assert.equal(yield* realGit(driver, cwd, ["log", "-1", "--format=%s"]), "push failure");

            // A retry is approved for the branch that produced the partial
            // receipt. Switching branches must not publish the new checkout.
            yield* realGit(driver, cwd, ["checkout", "-b", "other-branch"]);
            const staleRetry = yield* Effect.exit(
              workflow.runAction({
                cwd,
                action: "push",
                sourceRef: branch,
                remoteName: "origin",
                refName: branch,
                confirm: true,
              }),
            );
            assert.isTrue(Exit.isFailure(staleRetry));
            if (Exit.isFailure(staleRetry)) {
              assert.equal(
                (Cause.squash(staleRetry.cause) as GitCommandError).code,
                "stale_git_state",
              );
            }
            yield* realGit(driver, cwd, ["checkout", branch]);

            yield* files.writeFileString(`${cwd}/README.md`, "pull failure\n");
            yield* realGit(driver, cwd, ["add", "README.md"]);
            yield* realGit(driver, cwd, ["remote", "set-url", "origin", `${cwd}/missing-origin`]);
            const pullFailed = yield* workflow.runAction({
              cwd,
              action: "commit",
              message: "pull failure",
              compoundOperation: "commit-sync",
              confirm: true,
            });
            assert.deepStrictEqual(pullFailed.completed, ["commit"]);
            assert.equal(pullFailed.failedStep, "pull");
            assert.deepStrictEqual(pullFailed.continuation, { action: "sync", sourceRef: branch });
            assert.equal(yield* realGit(driver, cwd, ["log", "-1", "--format=%s"]), "pull failure");
          }).pipe(Effect.provide(makeRealGitWorkflowLayer(driver, vcsDriver)));
        }).pipe(Effect.provide(RealGitLayer)),
      ),
  );

  it.effect(
    "does not publish an unreviewed checkout when a queued push carries its reviewed state",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const vcsDriver = yield* GitVcsDriver.makeVcsDriver;
          yield* Effect.gen(function* () {
            const cwd = yield* makeRealGitDir();
            const remote = yield* makeRealGitDir();
            const files = yield* FileSystem.FileSystem;
            yield* initRealGitRepo(driver, cwd);
            yield* realGit(driver, remote, ["init", "--bare"]);
            const reviewed = yield* realGit(driver, cwd, ["branch", "--show-current"]);
            yield* realGit(driver, cwd, ["remote", "add", "origin", remote]);
            const workflow = yield* GitWorkflowService.GitWorkflowService;
            const reviewedHead = yield* realGit(driver, cwd, ["rev-parse", "HEAD"]);
            const reviewedIndex = yield* realGit(driver, cwd, ["write-tree"]);

            yield* realGit(driver, cwd, ["checkout", "-b", "unreviewed"]);
            yield* files.writeFileString(`${cwd}/README.md`, "unreviewed\n");
            yield* realGit(driver, cwd, ["commit", "-am", "unreviewed"]);
            const unreviewedHead = yield* realGit(driver, cwd, ["rev-parse", "HEAD"]);

            // Publication calls this same direct-Git verifier from inside the
            // repository permit, before it can create a provider repository.
            const staleValidation = yield* Effect.exit(
              workflow.withRepositoryPermit(
                "GitWorkflowService.real-test.publication-preflight",
                cwd,
                workflow.validateMutationPrecondition({
                  cwd,
                  precondition: {
                    expectedHeadCommit: reviewedHead,
                    expectedIndexTree: reviewedIndex,
                    expectedRefName: reviewed,
                  },
                }),
              ),
            );
            assert.isTrue(Exit.isFailure(staleValidation));
            if (Exit.isFailure(staleValidation)) {
              assert.equal(
                (Cause.squash(staleValidation.cause) as GitCommandError).code,
                "stale_git_state",
              );
            }

            const stale = yield* Effect.exit(
              workflow.runAction({
                cwd,
                action: "push",
                remoteName: "origin",
                refName: "reviewed-target",
                confirm: true,
                precondition: {
                  expectedHeadCommit: reviewedHead,
                  expectedIndexTree: reviewedIndex,
                  expectedRefName: reviewed,
                },
              }),
            );
            assert.isTrue(Exit.isFailure(stale));
            if (Exit.isFailure(stale)) {
              assert.equal((Cause.squash(stale.cause) as GitCommandError).code, "stale_git_state");
            }
            const remoteTarget = yield* driver.execute({
              operation: "GitWorkflowService.real-test.reviewed-target",
              cwd: remote,
              args: ["show-ref", "--verify", "--quiet", "refs/heads/reviewed-target"],
              allowNonZeroExit: true,
            });
            assert.notEqual(remoteTarget.exitCode, 0);
            assert.notEqual(unreviewedHead, reviewedHead);
          }).pipe(Effect.provide(makeRealGitWorkflowLayer(driver, vcsDriver)));
        }).pipe(Effect.provide(RealGitLayer)),
      ),
  );

  it.effect(
    "runs Stage and Unstage All against a real repository without changing worktree bytes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const vcsDriver = yield* GitVcsDriver.makeVcsDriver;
          yield* Effect.gen(function* () {
            const cwd = yield* makeRealGitDir();
            const files = yield* FileSystem.FileSystem;
            yield* initRealGitRepo(driver, cwd);
            yield* files.writeFileString(`${cwd}/README.md`, "kept in worktree\n");
            const workflow = yield* GitWorkflowService.GitWorkflowService;
            const staged = yield* workflow.runAction({
              cwd,
              action: "discard",
              changeOperation: "stage",
              confirm: false,
            });
            assert.deepStrictEqual(staged.completed, ["stage"]);
            assert.include(
              yield* realGit(driver, cwd, ["diff", "--cached", "--name-only"]),
              "README.md",
            );
            const unstaged = yield* workflow.runAction({
              cwd,
              action: "discard",
              changeOperation: "unstage",
              confirm: false,
            });
            assert.deepStrictEqual(unstaged.completed, ["unstage"]);
            assert.equal(yield* files.readFileString(`${cwd}/README.md`), "kept in worktree\n");
            assert.equal(yield* realGit(driver, cwd, ["diff", "--cached", "--name-only"]), "");
            assert.include(yield* realGit(driver, cwd, ["diff", "--name-only"]), "README.md");
            const stashed = yield* workflow.runAction({
              cwd,
              action: "stash",
              stashOperation: "push",
              message: "real view fixture",
              confirm: true,
            });
            assert.deepStrictEqual(stashed.completed, ["stash"]);
            const headBeforeView = yield* realGit(driver, cwd, ["rev-parse", "HEAD"]);
            const viewed = yield* workflow.runAction({
              cwd,
              action: "stash",
              stashOperation: "view",
              confirm: false,
            });
            assert.include(viewed.output ?? "", "stash@{0}");
            assert.equal(yield* realGit(driver, cwd, ["rev-parse", "HEAD"]), headBeforeView);

            const remote = yield* makeRealGitDir();
            yield* realGit(driver, remote, ["init", "--bare"]);
            const localBranch = yield* realGit(driver, cwd, ["branch", "--show-current"]);
            yield* realGit(driver, cwd, ["remote", "add", "origin", remote]);
            yield* realGit(driver, cwd, ["push", "origin", "HEAD:refs/heads/delete-me"]);
            const deleted = yield* workflow.runAction({
              cwd,
              action: "branch",
              branchOperation: "delete-remote",
              remoteName: "origin",
              refName: "delete-me",
              confirm: true,
            });
            assert.deepStrictEqual(deleted.completed, ["delete-remote-branch"]);
            const missingRemoteRef = yield* driver.execute({
              operation: "GitWorkflowService.real-test.remote-ref",
              cwd: remote,
              args: ["show-ref", "--verify", "--quiet", "refs/heads/delete-me"],
              allowNonZeroExit: true,
            });
            assert.notEqual(missingRemoteRef.exitCode, 0);
            assert.equal(yield* realGit(driver, cwd, ["branch", "--show-current"]), localBranch);
          }).pipe(Effect.provide(makeRealGitWorkflowLayer(driver, vcsDriver)));
        }).pipe(Effect.provide(RealGitLayer)),
      ),
  );

  it.effect("pulls the reviewed Pull From remote and ref without requiring an upstream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const vcsDriver = yield* GitVcsDriver.makeVcsDriver;
        yield* Effect.gen(function* () {
          const cwd = yield* makeRealGitDir();
          const remote = yield* makeRealGitDir();
          const files = yield* FileSystem.FileSystem;
          yield* initRealGitRepo(driver, cwd);
          yield* realGit(driver, remote, ["init", "--bare"]);
          const main = yield* realGit(driver, cwd, ["branch", "--show-current"]);
          yield* realGit(driver, cwd, ["remote", "add", "reviewed", remote]);
          yield* realGit(driver, cwd, ["checkout", "-b", "topic"]);
          yield* files.writeFileString(`${cwd}/README.md`, "topic\n");
          yield* realGit(driver, cwd, ["add", "README.md"]);
          yield* realGit(driver, cwd, ["commit", "-m", "topic"]);
          const topicHead = yield* realGit(driver, cwd, ["rev-parse", "HEAD"]);
          yield* realGit(driver, cwd, ["push", "reviewed", "topic"]);
          yield* realGit(driver, cwd, ["checkout", main]);

          const workflow = yield* GitWorkflowService.GitWorkflowService;
          const result = yield* workflow.runAction({
            cwd,
            action: "pull",
            pullOperation: "from",
            remoteName: "reviewed",
            refName: "topic",
            confirm: true,
          });

          assert.deepStrictEqual(result.completed, ["pull"]);
          assert.equal(yield* realGit(driver, cwd, ["rev-parse", "HEAD"]), topicHead);
        }).pipe(Effect.provide(makeRealGitWorkflowLayer(driver, vcsDriver)));
      }).pipe(Effect.provide(RealGitLayer)),
    ),
  );
  it("passes the selected pull strategy while leaving configured Git strategy intact by default", () => {
    expect(pullStrategyArgs("rebase")).toEqual(["pull", "--rebase"]);
    expect(pullStrategyArgs("ff-only")).toEqual(["pull", "--ff-only"]);
    expect(pullStrategyArgs(undefined)).toEqual(["pull"]);
  });

  it("continues or aborts the active cherry-pick/revert instead of guessing merge", () => {
    expect(
      GitWorkflowService.resolveConflictContinuationOperation({
        conflictOperation: "continue",
        cherryPickHeadPresent: true,
        revertHeadPresent: false,
      }),
    ).toBe("cherry-pick");
    expect(
      GitWorkflowService.resolveConflictContinuationOperation({
        conflictOperation: "abort",
        cherryPickHeadPresent: false,
        revertHeadPresent: true,
      }),
    ).toBe("revert");
  });

  it("keeps destructive all-file mutations confirmed while Unstage All remains non-destructive", () => {
    assert.isFalse(
      requiresGitActionConfirmation({ action: "discard", changeOperation: "unstage" }),
    );
    assert.isTrue(requiresGitActionConfirmation({ action: "discard", changeOperation: "discard" }));
    assert.isTrue(requiresGitActionConfirmation({ action: "branch" }));
    assert.isFalse(requiresGitActionConfirmation({ action: "stash", stashOperation: "view" }));
    assert.isTrue(
      requiresGitActionConfirmation({ action: "commit", compoundOperation: "commit-push" }),
    );
  });

  it("does not treat pull fast-forward mode as a reset mode", () => {
    // A reset must opt into its destructive mode by name. Reusing the pull
    // selector here previously made the harmless-looking ff-only choice run
    // `git reset --hard`.
    expect(GitWorkflowService.resetStrategyArgs(undefined)).toEqual(["--merge"]);
    expect(GitWorkflowService.resetStrategyArgs("merge")).toEqual(["--merge"]);
    expect(GitWorkflowService.resetStrategyArgs("hard")).toEqual(["--hard"]);
  });

  it("rejects incomplete fixed-leaf input instead of using Git defaults", () => {
    expect(
      GitWorkflowService.validateGitActionInput({
        cwd: "/repo",
        action: "branch",
        branchOperation: "create-from",
        refName: "feature",
        confirm: true,
      }),
    ).toBe("Create Branch From requires a source ref.");
    expect(
      GitWorkflowService.validateGitActionInput({
        cwd: "/repo",
        action: "pull",
        pullOperation: "from",
        remoteName: "origin",
        confirm: true,
      }),
    ).toBe("Pull From requires both a remote and a ref.");
    expect(
      GitWorkflowService.validateGitActionInput({
        cwd: "/repo",
        action: "push",
        pushOperation: "to",
        refName: "feature",
        confirm: true,
      }),
    ).toBe("Push To requires both a remote and a destination ref.");
  });

  it.effect("reports a non-Git VCS repository as not a Git repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const isRepository = yield* workflow.isRepository("/jj-repo");

      assert.equal(isRepository, false);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () =>
            Effect.succeed({
              kind: "jj",
              repository: {
                kind: "jj",
                rootPath: "/jj-repo",
                metadataPath: "/jj-repo/.jj",
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
    ),
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
