import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  WS_METHODS,
  type GitActionRequest,
  type VcsStatusStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import {
  normalizeVcsRepositoryRoot,
  registerVcsRepositories,
  vcsRefsCacheStateAtom,
} from "./vcsRefInvalidation.ts";
import { createVcsEnvironmentAtoms } from "./vcs.ts";
import { createGitEnvironmentAtoms } from "./git.ts";

import {
  buildRepositoryScopeKey,
  chooseActiveRepository,
  getSourceControlWorkspaceUnavailableReason,
  isSourceControlActionConfirmRequired,
  isSourceControlMutationStepConfirmRequired,
  isCurrentSourceControlRequest,
  isSourceControlWorkspaceSupported,
  readSourceControlComposerSessionDraft,
  updateSourceControlComposerSessionDraft,
  type SourceControlRepository,
  createSourceControlWorkspaceEnvironmentAtoms,
  publishSourceControlStatus,
  sourceControlWorkspaceProgressAtom,
  sourceControlWorkspaceRevisionAtom,
  sourceControlWorkspaceStatusRefreshAtom,
} from "./sourceControlWorkspace.ts";

const environmentId = EnvironmentId.make("workspace-test");
const makeHarness = Effect.fn(function* (
  client: Readonly<Record<string, unknown>>,
  persistenceGate: Effect.Effect<void> = Effect.void,
) {
  const protocol = client as unknown as WsRpcProtocolClient;
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
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
  const removed: string[] = [];
  const cache = EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: (_id, cwd) =>
      Effect.sync(() => {
        removed.push(cwd);
      }).pipe(
        Effect.andThen(Effect.suspend(() => (removed.length > 1 ? persistenceGate : Effect.void))),
      ),
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry, { run, followStream } as EnvironmentRegistry["Service"]),
      Layer.succeed(EnvironmentCacheStore, cache),
    ),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  const capabilities = Atom.make<{ sourceControlWorkspace?: boolean } | undefined>({
    sourceControlWorkspace: true,
  });
  return {
    registry,
    runtime,
    removed,
    cache,
    capabilities,
    atoms: createSourceControlWorkspaceEnvironmentAtoms(runtime, {
      capabilities: (registry) => registry.get(capabilities),
    }),
  };
});

describe("workspace command boundary", () => {
  it("keeps transient composer instructions and the selected action scoped to a repository session", () => {
    const rootA = "workspace-composer-a";
    const rootB = "workspace-composer-b";
    updateSourceControlComposerSessionDraft(rootA, {
      message: "A message",
      instructions: "use imperative mood",
      action: "amend",
    });
    updateSourceControlComposerSessionDraft(rootB, {
      message: "B message",
      instructions: "",
      action: "commit-push",
    });

    expect(readSourceControlComposerSessionDraft(rootA)).toEqual({
      message: "A message",
      instructions: "use imperative mood",
      action: "amend",
    });
    expect(readSourceControlComposerSessionDraft(rootB)).toEqual({
      message: "B message",
      instructions: "",
      action: "commit-push",
    });
  });
  it.effect("legacy additive exports cannot bypass workspace negotiation or confirmation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const { runtime, registry, capabilities } = yield* makeHarness({
          [WS_METHODS.gitDiscoverRepositories]: () =>
            Effect.sync(() => {
              calls.push("discovery");
              return { projectRoot: "/workspace", repositories: [], truncated: false };
            }),
          [WS_METHODS.gitRunAction]: (input: GitActionRequest) =>
            Effect.sync(() => {
              calls.push(input.action);
              return { action: input.action, completed: [input.action] };
            }),
        });
        registry.set(capabilities, undefined);
        const legacy = createVcsEnvironmentAtoms(runtime, {
          capabilities: (registry) => registry.get(capabilities),
        });
        const denied = yield* Effect.promise(() =>
          legacy.discoverRepositories.run(registry, {
            environmentId,
            input: { cwd: "/workspace" },
          }),
        );
        expect(AsyncResult.isFailure(denied) && Cause.squash(denied.cause)).toMatchObject({
          _tag: "SourceControlWorkspaceUnavailableError",
        });
        registry.set(capabilities, { sourceControlWorkspace: true });
        const confirm = yield* Effect.promise(() =>
          legacy.runGitAction.run(registry, {
            environmentId,
            input: { cwd: "/workspace", action: "amend", confirm: false },
          }),
        );
        expect(AsyncResult.isFailure(confirm) && Cause.squash(confirm.cause)).toMatchObject({
          status: "confirmation-required",
        });
        expect(calls).toEqual([]);
      }),
    ),
  );
  it.effect("invalidates prepare-PR refs after a failure following a partial branch change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, registry, removed } = yield* makeHarness({
          [WS_METHODS.gitPreparePullRequestThread]: () =>
            Effect.fail(
              new EnvironmentRpcUnavailableError({
                environmentId,
                message: "worktree creation failed after materializing branch",
              }),
            ),
        });
        const result = yield* Effect.promise(() =>
          createGitEnvironmentAtoms(runtime).preparePullRequestThread.run(registry, {
            environmentId,
            input: { cwd: "/workspace/", reference: "42", mode: "worktree" },
          }),
        );
        expect(AsyncResult.isFailure(result)).toBe(true);
        expect(removed).toEqual(["/workspace"]);
        expect(
          registry.get(
            sourceControlWorkspaceRevisionAtom({ environmentId, repositoryRoot: "/workspace" }),
          ),
        ).toBe(1);
        expect(
          registry.get(
            sourceControlWorkspaceRevisionAtom({
              environmentId,
              repositoryRoot: "/workspace/nested",
            }),
          ),
        ).toBe(0);
      }),
    ),
  );
  it.effect("uses one canonical query and RPC scope for equivalent repository roots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const roots: string[] = [];
        const { atoms, registry, runtime } = yield* makeHarness({
          [WS_METHODS.gitCommitGraphPage]: ({ cwd }: { cwd: string }) =>
            Effect.sync(() => {
              roots.push(cwd);
              return { commits: [], nextCursor: null };
            }),
        });
        const root = { environmentId, input: { cwd: "/workspace" } };
        const alias = { environmentId, input: { cwd: "/workspace/" } };
        expect(atoms.status(alias)).toBe(atoms.status(root));
        expect(atoms.listRefs(alias)).toBe(atoms.listRefs(root));
        const legacy = createVcsEnvironmentAtoms(runtime);
        expect(legacy.status(alias)).toBe(legacy.status(root));
        expect(legacy.listRefs(alias)).toBe(legacy.listRefs(root));
        yield* Effect.promise(() =>
          atoms.commitGraphPage.run(registry, {
            environmentId,
            input: { cwd: "/workspace/", cursor: null },
          }),
        );
        expect(roots).toEqual(["/workspace"]);
      }),
    ),
  );
  it.effect("named adapters cannot bypass confirmation, and cancellation has no side effects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: GitActionRequest[] = [];
        const { atoms, registry, removed } = yield* makeHarness({
          [WS_METHODS.gitRunAction]: (input: GitActionRequest) =>
            Effect.sync(() => {
              calls.push(input);
              return { action: input.action, completed: [input.action] };
            }),
        });
        const input = {
          cwd: "/workspace",
          action: "branch",
          confirm: false,
          branchOperation: "create",
          refName: "feature",
        } as const;
        const first = yield* Effect.promise(() =>
          atoms.runAction.run(registry, { environmentId, input }),
        );
        expect(AsyncResult.isFailure(first) && Cause.squash(first.cause)).toMatchObject({
          _tag: "SourceControlMutationNotExecutedError",
          status: "confirmation-required",
        });
        const cancelled = yield* Effect.promise(() =>
          atoms.executeMutation.run(registry, {
            environmentId,
            input: {
              cwd: "/workspace",
              confirmation: "cancelled",
              steps: [{ command: "runAction", input: { action: "branch" } }],
            },
          }),
        );
        expect(AsyncResult.isSuccess(cancelled) && cancelled.value).toMatchObject({
          status: "cancelled",
          completed: [],
        });
        expect(calls).toEqual([]);
        expect(removed).toEqual([]);
        const approved = yield* Effect.promise(() =>
          atoms.runAction.run(registry, { environmentId, input: { ...input, confirm: true } }),
        );
        expect(AsyncResult.isSuccess(approved) && approved.value).toEqual({
          action: "branch",
          completed: ["branch"],
        });
        expect(calls).toEqual([{ ...input, confirm: true }]);
        expect(removed).toEqual(["/workspace"]);
      }),
    ),
  );
  it.effect(
    "sends safe workflow leaves immediately but holds a compound commit at the workspace boundary",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: GitActionRequest[] = [];
          const { atoms, registry } = yield* makeHarness({
            [WS_METHODS.gitRunAction]: (input: GitActionRequest) =>
              Effect.sync(() => {
                calls.push(input);
                return { action: input.action, completed: [input.action] };
              }),
          });
          for (const input of [
            { cwd: "/workspace", action: "discard", changeOperation: "stage", confirm: false },
            { cwd: "/workspace", action: "stash", stashOperation: "view", confirm: false },
            { cwd: "/workspace", action: "fetch", fetchOperation: "prune", confirm: false },
          ] as const) {
            const result = yield* Effect.promise(() =>
              atoms.runAction.run(registry, { environmentId, input }),
            );
            expect(AsyncResult.isSuccess(result)).toBe(true);
          }
          const compound = {
            cwd: "/workspace",
            action: "commit",
            message: "publish this",
            compoundOperation: "commit-sync",
            confirm: false,
          } as const;
          const held = yield* Effect.promise(() =>
            atoms.runAction.run(registry, { environmentId, input: compound }),
          );
          expect(AsyncResult.isFailure(held) && Cause.squash(held.cause)).toMatchObject({
            _tag: "SourceControlMutationNotExecutedError",
            status: "confirmation-required",
          });
          const approved = yield* Effect.promise(() =>
            atoms.runAction.run(registry, { environmentId, input: { ...compound, confirm: true } }),
          );
          expect(AsyncResult.isSuccess(approved)).toBe(true);
          expect(calls).toEqual([
            { action: "discard", changeOperation: "stage", cwd: "/workspace", confirm: false },
            { action: "stash", stashOperation: "view", cwd: "/workspace", confirm: false },
            { action: "fetch", fetchOperation: "prune", cwd: "/workspace", confirm: false },
            { ...compound, confirm: true },
          ]);
        }),
      ),
  );
  it.effect("stops a compound action when the server returns a partial receipt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const { atoms, registry } = yield* makeHarness({
          [WS_METHODS.gitRunAction]: (input: GitActionRequest) =>
            Effect.sync(() => {
              calls.push(input.action);
              return { action: input.action, completed: ["fetch"], failedStep: "pull" };
            }),
        });
        const result = yield* Effect.promise(() =>
          atoms.executeMutation.run(registry, {
            environmentId,
            input: {
              cwd: "/workspace",
              confirmation: "approved",
              steps: [
                { command: "runAction", input: { action: "sync" } },
                { command: "runAction", input: { action: "push" } },
              ],
            },
          }),
        );
        expect(AsyncResult.isSuccess(result) && result.value).toMatchObject({
          status: "executed",
          completed: ["fetch"],
          failedStep: "pull",
        });
        expect(calls).toEqual(["sync"]);
        expect(
          registry.get(
            sourceControlWorkspaceProgressAtom({ environmentId, repositoryRoot: "/workspace" }),
          ),
        ).toMatchObject({ isRunning: false, failedStep: "pull", completed: ["fetch"] });
      }),
    ),
  );
  it.effect(
    "preserves submodule invalidation through child and equivalent parent discovery until parent discovery removes it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const discovered = [
            { rootPath: "/workspace", isSubmodule: false },
            { rootPath: "/workspace/modules/sub", isSubmodule: true },
            { rootPath: "/workspace/nested", isSubmodule: false },
          ].map((repo) => ({
            ...repo,
            worktreePath: repo.rootPath,
            commonDir: `${repo.rootPath}/.git`,
            provider: null,
          }));
          const subscriptions = new Map<string, number>();
          let parentDiscoveryCount = 0;
          const { atoms, registry, removed } = yield* makeHarness({
            [WS_METHODS.gitDiscoverRepositories]: ({ cwd }: { readonly cwd: string }) =>
              Effect.succeed({
                projectRoot: cwd === "/workspace/src" ? "/workspace" : cwd,
                repositories:
                  cwd === "/workspace/modules/sub"
                    ? [{ ...discovered[1]!, isSubmodule: false }]
                    : cwd === "/workspace/src" || ++parentDiscoveryCount === 1
                      ? discovered
                      : [discovered[0]!, discovered[2]!],
                truncated: false,
              }),
            [WS_METHODS.gitCommitIndex]: () => Effect.succeed({ commitSha: "submodule-commit" }),
            [WS_METHODS.subscribeVcsStatus]: ({ cwd }: { cwd: string }) =>
              Stream.suspend(() => {
                const count = (subscriptions.get(cwd) ?? 0) + 1;
                subscriptions.set(cwd, count);
                return Stream.make({
                  _tag: "snapshot",
                  local: {
                    isRepo: true,
                    hasPrimaryRemote: false,
                    isDefaultRef: true,
                    refName: "main",
                    hasWorkingTreeChanges: count > 1,
                    workingTree: { files: [], insertions: 0, deletions: 0 },
                  },
                  remote: null,
                });
              }),
          });
          yield* Effect.promise(() =>
            atoms.discoverRepositories.run(registry, {
              environmentId,
              input: { cwd: "/workspace" },
            }),
          );
          yield* Effect.promise(() =>
            atoms.discoverRepositories.run(registry, {
              environmentId,
              input: { cwd: "/workspace/modules/sub" },
            }),
          );
          yield* Effect.promise(() =>
            atoms.discoverRepositories.run(registry, {
              environmentId,
              input: { cwd: "/workspace/src" },
            }),
          );
          const parent = { environmentId, repositoryRoot: "/workspace" };
          const nested = { environmentId, repositoryRoot: "/workspace/nested" };
          const status = atoms.status({ environmentId, input: { cwd: "/workspace" } });
          const nestedStatus = atoms.status({ environmentId, input: { cwd: "/workspace/nested" } });
          yield* AtomRegistry.mount(registry, status);
          yield* AtomRegistry.mount(registry, nestedStatus);
          yield* AtomRegistry.getResult(registry, status);
          yield* AtomRegistry.getResult(registry, nestedStatus);
          const beforeParent = registry.get(sourceControlWorkspaceRevisionAtom(parent));
          const beforeNested = registry.get(sourceControlWorkspaceRevisionAtom(nested));
          const removedBeforeChildCommit = removed.length;
          yield* Effect.promise(() =>
            atoms.commitIndex.run(registry, {
              environmentId,
              input: { cwd: "/workspace/modules/sub/", message: "sub change" },
            }),
          );
          expect(registry.get(sourceControlWorkspaceRevisionAtom(parent))).toBeGreaterThan(
            beforeParent,
          );
          yield* AtomRegistry.toStream(registry, status).pipe(
            Stream.filter(
              (result) =>
                AsyncResult.isSuccess(result) && result.value?.hasWorkingTreeChanges === true,
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          expect(subscriptions.get("/workspace")).toBe(2);
          expect(registry.get(sourceControlWorkspaceRevisionAtom(nested))).toBe(beforeNested);
          expect(subscriptions.get("/workspace/nested")).toBe(1);
          expect(removed.slice(removedBeforeChildCommit)).toContain("/workspace/modules/sub");
          expect(removed.slice(removedBeforeChildCommit)).toContain("/workspace");
          const afterParent = registry.get(sourceControlWorkspaceRevisionAtom(parent));
          yield* Effect.promise(() =>
            atoms.commitIndex.run(registry, {
              environmentId,
              input: { cwd: "/workspace/nested", message: "unrelated change" },
            }),
          );
          expect(registry.get(sourceControlWorkspaceRevisionAtom(parent))).toBe(afterParent);
          yield* Effect.promise(() =>
            atoms.discoverRepositories.run(registry, {
              environmentId,
              input: { cwd: "/workspace" },
            }),
          );
          const afterAuthoritativeDiscovery = registry.get(
            sourceControlWorkspaceRevisionAtom(parent),
          );
          const removedBeforeStaleChild = removed.length;
          yield* Effect.promise(() =>
            atoms.commitIndex.run(registry, {
              environmentId,
              input: { cwd: "/workspace/modules/sub", message: "stale sub change" },
            }),
          );
          expect(registry.get(sourceControlWorkspaceRevisionAtom(parent))).toBe(
            afterAuthoritativeDiscovery,
          );
          expect(removed.slice(removedBeforeStaleChild)).toEqual(["/workspace/modules/sub"]);
        }),
      ),
  );
  for (const surface of ["workspace", "legacy"] as const) {
    it.effect(
      `publishes scoped revisions for external ${surface} snapshots and status changes`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const local = {
              isRepo: true,
              hasPrimaryRemote: false,
              isDefaultRef: true,
              refName: "main",
              headCommit: "before",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            };
            const events = yield* SubscriptionRef.make<VcsStatusStreamEvent>({
              _tag: "snapshot",
              local,
              remote: null,
            });
            const { atoms, runtime, registry, removed } = yield* makeHarness({
              [WS_METHODS.subscribeVcsStatus]: () => SubscriptionRef.changes(events),
            });
            const status = (
              surface === "workspace" ? atoms : createVcsEnvironmentAtoms(runtime)
            ).status({ environmentId, input: { cwd: "/workspace/" } });
            yield* AtomRegistry.mount(registry, status);
            yield* AtomRegistry.getResult(registry, status);
            expect(
              registry.get(
                sourceControlWorkspaceRevisionAtom({ environmentId, repositoryRoot: "/workspace" }),
              ),
            ).toBe(1);
            yield* SubscriptionRef.set(events, {
              _tag: "localUpdated",
              local: { ...local, headCommit: "after", hasWorkingTreeChanges: true },
            });
            yield* AtomRegistry.toStream(registry, status).pipe(
              Stream.filter(
                (result) => AsyncResult.isSuccess(result) && result.value?.headCommit === "after",
              ),
              Stream.take(1),
              Stream.runDrain,
            );
            expect(
              registry.get(
                sourceControlWorkspaceRevisionAtom({ environmentId, repositoryRoot: "/workspace" }),
              ),
            ).toBe(2);
            expect(
              registry.get(
                sourceControlWorkspaceRevisionAtom({
                  environmentId,
                  repositoryRoot: "/workspace/nested",
                }),
              ),
            ).toBe(0);
            expect(
              registry.get(
                sourceControlWorkspaceRevisionAtom({
                  environmentId: EnvironmentId.make("other"),
                  repositoryRoot: "/workspace",
                }),
              ),
            ).toBe(0);
            expect(removed).toEqual(["/workspace", "/workspace"]);
          }),
        ),
    );
  }
  it.effect("gates actual discovery, comparison, graph and amend commands at execution time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const { atoms, registry, capabilities } = yield* makeHarness({
          [WS_METHODS.gitDiscoverRepositories]: () =>
            Effect.sync(() => {
              calls.push("discovery");
              return { projectRoot: "/workspace", repositories: [], truncated: false };
            }),
          [WS_METHODS.gitCompareRepositoryFile]: () =>
            Effect.sync(() => {
              calls.push("comparison");
              return {};
            }),
          [WS_METHODS.gitCommitGraphPage]: () =>
            Effect.sync(() => {
              calls.push("graph");
              return {};
            }),
          [WS_METHODS.gitRunAction]: () =>
            Effect.sync(() => {
              calls.push("amend");
              return { action: "amend", completed: ["amend"] };
            }),
        });
        for (const capability of [undefined, {}, { sourceControlWorkspace: false }]) {
          registry.set(capabilities, capability);
          const results = yield* Effect.promise(() =>
            Promise.all([
              atoms.discoverRepositories.run(registry, {
                environmentId,
                input: { cwd: "/workspace/" },
              }),
              atoms.compareRepositoryFile.run(registry, {
                environmentId,
                input: {
                  cwd: "/workspace",
                  comparison: "working-tree",
                  oldPath: "a",
                  newPath: "a",
                },
              }),
              atoms.commitGraphPage.run(registry, {
                environmentId,
                input: { cwd: "/workspace", cursor: null },
              }),
              atoms.runAction.run(registry, {
                environmentId,
                input: { cwd: "/workspace", action: "amend", confirm: true },
              }),
            ]),
          );
          for (const result of results) {
            expect(result._tag === "Failure" && Cause.squash<unknown>(result.cause)).toMatchObject({
              _tag: "SourceControlWorkspaceUnavailableError",
              reason: "source-control-workspace-not-advertised",
            });
          }
        }
        expect(calls).toEqual([]);
        registry.set(capabilities, { sourceControlWorkspace: true });
        const result = yield* Effect.promise(() =>
          atoms.discoverRepositories.run(registry, {
            environmentId,
            input: { cwd: "/workspace/" },
          }),
        );
        expect(AsyncResult.isSuccess(result)).toBe(true);
        expect(calls).toEqual(["discovery"]);
      }),
    ),
  );
  it.effect("preserves absolute repository roots when dispatching workspace RPCs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatchedRoots: string[] = [];
        const { atoms, registry } = yield* makeHarness({
          [WS_METHODS.gitCommitGraphPage]: ({ cwd }: { readonly cwd: string }) =>
            Effect.sync(() => {
              dispatchedRoots.push(cwd);
              return { commits: [], nextCursor: null };
            }),
        });
        const roots = [
          ["/", "/"],
          ["/workspace///", "/workspace"],
          ["C:\\", "C:/"],
          ["\\\\server\\share\\", "//server/share/"],
        ] as const;

        for (const [input, expected] of roots) {
          expect(normalizeVcsRepositoryRoot(input)).toBe(expected);
          const result = yield* Effect.promise(() =>
            atoms.commitGraphPage.run(registry, {
              environmentId,
              input: { cwd: input, cursor: null },
            }),
          );
          expect(AsyncResult.isSuccess(result)).toBe(true);
        }
        expect(dispatchedRoots).toEqual(roots.map(([, expected]) => expected));
      }),
    ),
  );
  it.effect("routes named index mutations through the shared progress owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { atoms, registry, removed } = yield* makeHarness({
          [WS_METHODS.gitCommitIndex]: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ commitSha: "abc123" }),
            ),
        });
        const pending = yield* Effect.promise(() =>
          atoms.commitIndex.run(registry, {
            environmentId,
            input: { cwd: "/workspace/", message: "change" },
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect(
          registry.get(
            sourceControlWorkspaceProgressAtom({ environmentId, repositoryRoot: "/workspace" }),
          ),
        ).toMatchObject({ isRunning: true, currentStep: "commit" });
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(pending);
        expect(AsyncResult.isSuccess(result) && result.value).toEqual({ commitSha: "abc123" });
        expect(removed).toEqual(["/workspace"]);
      }),
    ),
  );
  it.effect("executes an approved worktree request through the shared mutation adapter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: unknown[] = [];
        const { atoms, registry } = yield* makeHarness({
          [WS_METHODS.vcsCreateWorktree]: (input: unknown) =>
            Effect.sync(() => {
              calls.push(input);
              return { worktree: { path: "/tmp/feature", refName: "feature/worktree" } };
            }),
        });
        const result = yield* Effect.promise(() =>
          atoms.createWorktree.run(registry, {
            environmentId,
            input: {
              cwd: "/workspace",
              refName: "main",
              newRefName: "feature/worktree",
              path: "/tmp/feature",
              confirmation: "approved",
            },
          }),
        );
        expect(AsyncResult.isSuccess(result) && result.value).toEqual({
          worktree: { path: "/tmp/feature", refName: "feature/worktree" },
        });
        expect(calls).toHaveLength(1);
      }),
    ),
  );
  it.effect("requires approval for index amends through named and direct mutation commands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<{
          readonly cwd: string;
          readonly message: string;
          readonly amend?: boolean;
        }> = [];
        const { atoms, registry, removed } = yield* makeHarness({
          [WS_METHODS.gitCommitIndex]: (input: {
            readonly cwd: string;
            readonly message: string;
            readonly amend?: boolean;
          }) =>
            Effect.sync(() => {
              calls.push(input);
              return { commitSha: "abc123" };
            }),
        });

        const named = yield* Effect.promise(() =>
          atoms.commitIndex.run(registry, {
            environmentId,
            input: { cwd: "/workspace", message: "", amend: true },
          }),
        );
        expect(AsyncResult.isFailure(named) && Cause.squash(named.cause)).toMatchObject({
          _tag: "SourceControlMutationNotExecutedError",
          status: "confirmation-required",
        });
        const direct = yield* Effect.promise(() =>
          atoms.executeMutation.run(registry, {
            environmentId,
            input: {
              cwd: "/workspace",
              steps: [{ command: "commitIndex", input: { message: "", amend: true } }],
            },
          }),
        );
        expect(AsyncResult.isSuccess(direct) && direct.value).toMatchObject({
          status: "confirmation-required",
          completed: [],
        });
        expect(calls).toEqual([]);
        expect(removed).toEqual([]);

        const approvedNamed = yield* Effect.promise(() =>
          atoms.commitIndex.run(registry, {
            environmentId,
            input: { cwd: "/workspace/", message: "", amend: true, confirmation: "approved" },
          }),
        );
        expect(AsyncResult.isSuccess(approvedNamed) && approvedNamed.value).toEqual({
          commitSha: "abc123",
        });
        const approvedDirect = yield* Effect.promise(() =>
          atoms.executeMutation.run(registry, {
            environmentId,
            input: {
              cwd: "/workspace",
              confirmation: "approved",
              steps: [{ command: "commitIndex", input: { message: "", amend: true } }],
            },
          }),
        );
        expect(AsyncResult.isSuccess(approvedDirect) && approvedDirect.value).toMatchObject({
          status: "executed",
          completed: ["amend"],
        });
        const plainCommit = yield* Effect.promise(() =>
          atoms.commitIndex.run(registry, {
            environmentId,
            input: { cwd: "/workspace", message: "plain" },
          }),
        );
        expect(AsyncResult.isSuccess(plainCommit) && plainCommit.value).toEqual({
          commitSha: "abc123",
        });
        expect(calls).toEqual([
          { cwd: "/workspace", message: "", amend: true },
          { cwd: "/workspace", message: "", amend: true },
          { cwd: "/workspace", message: "plain" },
        ]);
      }),
    ),
  );
  it.effect(
    "tracks compound progress in one repository and settles partial failure without pushing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const calls: string[] = [];
          const { atoms, registry, removed } = yield* makeHarness({
            [WS_METHODS.gitRunAction]: (input: GitActionRequest) =>
              Effect.gen(function* () {
                calls.push(input.action);
                if (input.action === "commit") {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
                if (input.action === "pull")
                  return yield* Effect.fail(
                    new EnvironmentRpcUnavailableError({
                      environmentId,
                      message: "offline after fetch",
                    }),
                  );
                return { action: input.action, completed: [input.action] };
              }),
          });
          const scope = { environmentId, repositoryRoot: "/workspace" };
          const other = { environmentId, repositoryRoot: "/workspace/nested" };
          const action = yield* Effect.promise(() =>
            atoms.executeMutation.run(registry, {
              environmentId,
              input: {
                cwd: "/workspace/",
                confirmation: "approved",
                steps: [
                  { command: "runAction", input: { action: "commit", message: "change" } },
                  { command: "runAction", input: { action: "pull" } },
                  { command: "runAction", input: { action: "push" } },
                ],
              },
            }),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          expect(registry.get(sourceControlWorkspaceProgressAtom(scope))).toMatchObject({
            isRunning: true,
            currentStep: "commit",
          });
          expect(registry.get(sourceControlWorkspaceProgressAtom(other))).toMatchObject({
            isRunning: false,
          });
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(action);
          expect(AsyncResult.isSuccess(result) && result.value).toMatchObject({
            status: "executed",
            completed: ["commit"],
            failedStep: "pull",
          });
          expect(calls).toEqual(["commit", "pull"]);
          expect(registry.get(sourceControlWorkspaceProgressAtom(scope))).toMatchObject({
            isRunning: false,
            completed: ["commit"],
            failedStep: "pull",
          });
          expect(registry.get(sourceControlWorkspaceRevisionAtom(scope))).toBe(1);
          expect(registry.get(sourceControlWorkspaceRevisionAtom(other))).toBe(0);
          expect(
            registry.get(vcsRefsCacheStateAtom({ environmentId, cwd: "/workspace" })).revision,
          ).toBe(1);
          expect(removed).toEqual(["/workspace"]);
        }),
      ),
  );
  it.effect(
    "requires a branch confirmation but forwards each safe typed leaf without confirmation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: GitActionRequest[] = [];
          const { atoms, registry } = yield* makeHarness({
            [WS_METHODS.gitRunAction]: (input: GitActionRequest) =>
              Effect.sync(() => {
                calls.push(input);
                return { action: input.action, completed: [input.action] };
              }),
          });
          const branch = yield* Effect.promise(() =>
            atoms.executeMutation.run(registry, {
              environmentId,
              input: {
                cwd: "/workspace/",
                steps: [
                  {
                    command: "runAction",
                    input: { action: "branch", branchOperation: "create", refName: "feature" },
                  },
                ],
              },
            }),
          );
          expect(AsyncResult.isSuccess(branch) && branch.value).toMatchObject({
            status: "confirmation-required",
            completed: [],
          });
          expect(calls).toEqual([]);
          for (const input of [
            { action: "fetch" },
            { action: "discard", changeOperation: "stage" },
            { action: "discard", changeOperation: "unstage" },
            { action: "stash", stashOperation: "view" },
          ] as const) {
            const result = yield* Effect.promise(() =>
              atoms.executeMutation.run(registry, {
                environmentId,
                input: {
                  cwd: "/workspace/",
                  steps: [{ command: "runAction", input }],
                },
              }),
            );
            expect(AsyncResult.isSuccess(result) && result.value).toMatchObject({
              status: "executed",
            });
          }
          expect(calls).toEqual([
            { cwd: "/workspace", action: "fetch", confirm: false },
            { cwd: "/workspace", action: "discard", changeOperation: "stage", confirm: false },
            { cwd: "/workspace", action: "discard", changeOperation: "unstage", confirm: false },
            { cwd: "/workspace", action: "stash", stashOperation: "view", confirm: false },
          ]);
        }),
      ),
  );
  it.effect(
    "retains a durable continuation across a failed retry and clears it only after that retry succeeds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let attempt = 0;
          const { atoms, registry } = yield* makeHarness({
            [WS_METHODS.gitRunAction]: () => {
              attempt += 1;
              if (attempt === 1) {
                return Effect.succeed({
                  action: "commit" as const,
                  completed: ["commit"],
                  commitSha: "abc123",
                  failedStep: "push",
                  continuation: {
                    action: "push" as const,
                    remoteName: "upstream",
                    refName: "feature/retry",
                    strategy: "rebase" as const,
                  },
                });
              }
              if (attempt === 2) {
                return Effect.fail(
                  new EnvironmentRpcUnavailableError({ environmentId, message: "offline" }),
                );
              }
              return Effect.succeed({ action: "push" as const, completed: ["push"] });
            },
          });
          const scope = { environmentId, repositoryRoot: "/workspace" };
          const run = (input: Omit<GitActionRequest, "cwd" | "confirm">) =>
            Effect.promise(() =>
              atoms.executeMutation.run(registry, {
                environmentId,
                input: {
                  cwd: "/workspace",
                  confirmation: "approved",
                  steps: [{ command: "runAction", input }],
                },
              }),
            );

          yield* run({ action: "commit", compoundOperation: "commit-push", message: "change" });
          expect(registry.get(sourceControlWorkspaceProgressAtom(scope))).toMatchObject({
            commitSha: "abc123",
            continuation: {
              action: "push",
              remoteName: "upstream",
              refName: "feature/retry",
              strategy: "rebase",
            },
          });
          yield* run({
            action: "push",
            remoteName: "upstream",
            refName: "feature/retry",
            strategy: "rebase",
          });
          expect(registry.get(sourceControlWorkspaceProgressAtom(scope))).toMatchObject({
            commitSha: "abc123",
            continuation: {
              action: "push",
              remoteName: "upstream",
              refName: "feature/retry",
              strategy: "rebase",
            },
            failedStep: "push",
          });
          yield* run({
            action: "push",
            remoteName: "upstream",
            refName: "feature/retry",
            strategy: "rebase",
          });
          const settled = registry.get(sourceControlWorkspaceProgressAtom(scope));
          expect(settled).toMatchObject({ isRunning: false });
          expect(settled).not.toHaveProperty("continuation");
          expect(settled).not.toHaveProperty("receipt");
          expect(settled).not.toHaveProperty("commitSha");
        }),
      ),
  );
  it.effect(
    "merges compound continuations, ignores unrelated pushes, and dismisses by repository scope",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let attempt = 0;
          const { atoms, registry } = yield* makeHarness({
            [WS_METHODS.gitRunAction]: () => {
              attempt += 1;
              if (attempt === 1)
                return Effect.succeed({
                  action: "commit" as const,
                  completed: ["commit"],
                  commitSha: "abc123",
                  failedStep: "pull",
                  continuation: {
                    action: "sync" as const,
                    remoteName: "fork",
                    refName: "feature",
                    pullRemoteName: "origin",
                    pullRefName: "main",
                    strategy: "rebase" as const,
                  },
                });
              if (attempt === 2)
                return Effect.succeed({
                  action: "sync" as const,
                  completed: ["pull"],
                  failedStep: "push",
                  continuation: {
                    action: "push" as const,
                    remoteName: "fork",
                    refName: "feature",
                    pullRemoteName: "origin",
                    pullRefName: "main",
                    strategy: "rebase" as const,
                  },
                });
              if (attempt === 4) {
                return Effect.fail(
                  new EnvironmentRpcUnavailableError({ environmentId, message: "offline" }),
                );
              }
              return Effect.succeed({ action: "push" as const, completed: ["push"] });
            },
          });
          const scope = { environmentId, repositoryRoot: "/workspace" };
          const run = (input: Omit<GitActionRequest, "cwd" | "confirm">) =>
            Effect.promise(() =>
              atoms.executeMutation.run(registry, {
                environmentId,
                input: {
                  cwd: "/workspace",
                  confirmation: "approved",
                  steps: [{ command: "runAction", input }],
                },
              }),
            );
          yield* run({
            action: "commit",
            compoundOperation: "commit-sync",
            message: "change",
            remoteName: "fork",
            refName: "feature",
            pullRemoteName: "origin",
            pullRefName: "main",
            strategy: "rebase",
          });
          yield* run({
            action: "sync",
            remoteName: "fork",
            refName: "feature",
            pullRemoteName: "origin",
            pullRefName: "main",
            strategy: "rebase",
          });
          expect(registry.get(sourceControlWorkspaceProgressAtom(scope))).toMatchObject({
            commitSha: "abc123",
            completed: ["commit", "pull"],
            failedStep: "push",
            receipt: { action: "commit" },
          });
          yield* run({ action: "push", remoteName: "other", refName: "other" });
          expect(registry.get(sourceControlWorkspaceProgressAtom(scope))).toMatchObject({
            commitSha: "abc123",
            completed: ["commit", "pull"],
            failedStep: "push",
            continuation: { remoteName: "fork", refName: "feature" },
          });
          yield* run({ action: "push", remoteName: "other-failure", refName: "other-failure" });
          expect(registry.get(sourceControlWorkspaceProgressAtom(scope))).toMatchObject({
            commitSha: "abc123",
            completed: ["commit", "pull"],
            failedStep: "push",
            continuation: { remoteName: "fork", refName: "feature" },
          });
          yield* run({
            action: "push",
            remoteName: "fork",
            refName: "feature",
            pullRemoteName: "origin",
            pullRefName: "main",
            strategy: "rebase",
          });
          expect(registry.get(sourceControlWorkspaceProgressAtom(scope))).not.toHaveProperty(
            "continuation",
          );
          const dismissed = yield* Effect.promise(() =>
            atoms.dismissProgress.run(registry, { environmentId, input: { cwd: "/workspace" } }),
          );
          expect(AsyncResult.isSuccess(dismissed)).toBe(true);
          expect(registry.get(sourceControlWorkspaceProgressAtom(scope))).toEqual({
            isRunning: false,
            currentStep: null,
            completed: [],
          });
        }),
      ),
  );
});

const repositories: readonly SourceControlRepository[] = [
  {
    rootPath: "/workspace",
    worktreePath: "/workspace",
    commonDir: "/workspace/.git",
    isSubmodule: false,
    provider: null,
  },
  {
    rootPath: "/workspace/packages/plugin",
    worktreePath: "/workspace/packages/plugin",
    commonDir: "/workspace/packages/plugin/.git",
    isSubmodule: false,
    provider: null,
  },
];

it.effect("publishes a new scoped revision before persisted status becomes observable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releasePersistence = yield* Deferred.make<void>();
      const persistenceEntered = yield* Deferred.make<void>();
      const before = {
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: true,
        refName: "main",
        headCommit: "before",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      };
      const events = yield* SubscriptionRef.make<VcsStatusStreamEvent>({
        _tag: "snapshot",
        local: before,
        remote: null,
      });
      const { atoms, registry } = yield* makeHarness(
        { [WS_METHODS.subscribeVcsStatus]: () => SubscriptionRef.changes(events) },
        Deferred.succeed(persistenceEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releasePersistence)),
        ),
      );
      const status = atoms.status({ environmentId, input: { cwd: "/workspace" } });
      const revision = sourceControlWorkspaceRevisionAtom({
        environmentId,
        repositoryRoot: "/workspace",
      });
      yield* AtomRegistry.mount(registry, status);
      yield* AtomRegistry.getResult(registry, status);
      yield* SubscriptionRef.set(events, {
        _tag: "localUpdated",
        local: { ...before, headCommit: "after" },
      });
      yield* Deferred.await(persistenceEntered);
      // The UI can observe this tuple between the mutation broadcast and the
      // async cache write. Live secondary tabs must therefore key work by the
      // delivered status tuple as well as this revision.
      expect(registry.get(revision)).toBe(2);
      const intermediate = registry.get(status);
      expect(AsyncResult.isSuccess(intermediate) && intermediate.value?.headCommit).toBe("before");
      yield* Deferred.succeed(releasePersistence, undefined);
      yield* AtomRegistry.toStream(registry, status).pipe(
        Stream.filter(
          (result) => AsyncResult.isSuccess(result) && result.value?.headCommit === "after",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      expect(registry.get(revision)).toBe(2);
    }),
  ),
);

it.effect("does not refresh related status subscriptions for streamed status snapshots", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, removed, cache } = yield* makeHarness({});
      const parent = { environmentId, repositoryRoot: "/workspace" };
      const child = { environmentId, repositoryRoot: "/workspace/modules/sub" };
      registerVcsRepositories(registry, environmentId, "/workspace", [
        {
          rootPath: parent.repositoryRoot,
          worktreePath: parent.repositoryRoot,
          commonDir: "/workspace/.git",
          isSubmodule: false,
          provider: null,
        },
        {
          rootPath: child.repositoryRoot,
          worktreePath: child.repositoryRoot,
          commonDir: "/workspace/modules/sub/.git",
          isSubmodule: true,
          provider: null,
        },
      ]);

      yield* publishSourceControlStatus(
        { environmentId, input: { cwd: child.repositoryRoot } },
        registry,
      ).pipe(Effect.provideService(EnvironmentCacheStore, cache));

      expect(registry.get(sourceControlWorkspaceRevisionAtom(parent))).toBe(1);
      expect(registry.get(sourceControlWorkspaceRevisionAtom(child))).toBe(1);
      expect(registry.get(sourceControlWorkspaceStatusRefreshAtom(parent))).toBe(0);
      expect(registry.get(sourceControlWorkspaceStatusRefreshAtom(child))).toBe(0);
      expect(removed).toEqual([child.repositoryRoot, parent.repositoryRoot]);
    }),
  ),
);

it.effect("keeps the real aggregate status and refs cache warm when a file comparison opens", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let statusSubscriptions = 0;
      let refsQueries = 0;
      let fileComparisons = 0;
      const initialStatus = {
        isRepo: true,
        sourceControlProvider: undefined,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "feature",
        headCommit: "a".repeat(40),
        hasWorkingTreeChanges: true,
        workingTree: { files: [], insertions: 1, deletions: 0, snapshotId: "worktree-1" },
      };
      const { atoms, registry } = yield* makeHarness({
        [WS_METHODS.subscribeVcsStatus]: () => {
          statusSubscriptions += 1;
          return Stream.succeed({ _tag: "snapshot" as const, local: initialStatus, remote: null });
        },
        [WS_METHODS.vcsListRefs]: () =>
          Effect.sync(() => {
            refsQueries += 1;
            return {
              refs: [
                { name: "feature", current: true, isDefault: false, worktreePath: "/workspace" },
              ],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 1,
            };
          }),
        [WS_METHODS.gitCompareRepositoryFile]: () =>
          Effect.sync(() => {
            fileComparisons += 1;
            return {
              oldContents: "aggregate cache before",
              newContents: "file comparison after",
              binary: false,
              available: true,
            };
          }),
      });
      const target = { environmentId, input: { cwd: "/workspace" } };
      const aggregateStatus = atoms.status(target);
      const aggregateRefs = atoms.listRefs(target);
      // These are the real reactive atoms that the aggregate panel owns—not
      // a replaced query hook or fabricated cache. Mounting the file detail
      // below must not subscribe/query either repository-wide atom again.
      yield* AtomRegistry.mount(registry, aggregateStatus);
      yield* AtomRegistry.mount(registry, aggregateRefs);
      yield* AtomRegistry.getResult(registry, aggregateStatus);
      yield* AtomRegistry.getResult(registry, aggregateRefs);
      const aggregateRequests = { statusSubscriptions, refsQueries };
      expect(aggregateRequests.statusSubscriptions).toBe(1);
      // The real refs atom may settle its first query in two scheduler turns;
      // record that warm-cache baseline rather than asserting a scheduler
      // implementation detail.
      expect(aggregateRequests.refsQueries).toBeGreaterThan(0);
      expect(fileComparisons).toBe(0);

      const comparison = yield* Effect.promise(() =>
        atoms.compareRepositoryFile.run(registry, {
          environmentId,
          input: {
            cwd: "/workspace",
            comparison: "working-tree",
            oldPath: "src/file.ts",
            newPath: "src/file.ts",
            descriptor: {
              version: 1,
              environmentId: "workspace-test",
              repositoryRoot: "/workspace",
              kind: "working-tree",
              oldPath: "src/file.ts",
              newPath: "src/file.ts",
              baseRevision: "a".repeat(40),
              headRevision: null,
              liveSnapshotId: "worktree-1",
              turnId: null,
              checkpointId: null,
              pullRequestId: null,
              mergeParent: null,
            },
          },
        }),
      );
      expect(AsyncResult.isSuccess(comparison)).toBe(true);
      // A file comparison is its own RPC, but it reuses the mounted aggregate
      // query/cache rather than starting another status or refs request.
      expect({ statusSubscriptions, refsQueries }).toEqual(aggregateRequests);
      expect(fileComparisons).toBe(1);
    }),
  ),
);

describe("source control workspace controller", () => {
  it("requires an advertised workspace capability before using additive RPCs", () => {
    expect(isSourceControlWorkspaceSupported(undefined)).toBe(false);
    expect(isSourceControlWorkspaceSupported({ sourceControlWorkspace: false })).toBe(false);
    expect(isSourceControlWorkspaceSupported({ sourceControlWorkspace: true })).toBe(true);
  });

  it("names the unavailable capability reason when a server does not advertise it", () => {
    expect(getSourceControlWorkspaceUnavailableReason(undefined)).toBe(
      "source-control-workspace-not-advertised",
    );
    expect(getSourceControlWorkspaceUnavailableReason({ sourceControlWorkspace: false })).toBe(
      "source-control-workspace-not-advertised",
    );
    expect(getSourceControlWorkspaceUnavailableReason({ sourceControlWorkspace: true })).toBeNull();
  });
  it("scopes state by environment and canonical repository root", () => {
    expect(buildRepositoryScopeKey("env-a", repositories[0]!)).toBe("env-a:/workspace");
    expect(buildRepositoryScopeKey("env-b", repositories[0]!)).toBe("env-b:/workspace");
  });

  it("falls back to the project root when a persisted repository disappears", () => {
    expect(chooseActiveRepository(repositories, "/missing", "/workspace")?.rootPath).toBe(
      "/workspace",
    );
    expect(
      chooseActiveRepository(repositories, "/workspace/packages/plugin", "/workspace")?.rootPath,
    ).toBe("/workspace/packages/plugin");
  });

  it("requires confirmation only for mutating actions outside the safe matrix", () => {
    expect(isSourceControlActionConfirmRequired("commit")).toBe(false);
    expect(isSourceControlActionConfirmRequired("stage")).toBe(false);
    expect(isSourceControlActionConfirmRequired("fetch")).toBe(false);
    expect(isSourceControlActionConfirmRequired("view")).toBe(false);
    expect(isSourceControlActionConfirmRequired("amend")).toBe(true);
    expect(isSourceControlActionConfirmRequired("sync")).toBe(true);
    expect(isSourceControlActionConfirmRequired("reset")).toBe(true);
  });

  it("classifies run-action confirmation from the typed leaf rather than its broad action", () => {
    expect(
      isSourceControlMutationStepConfirmRequired({
        command: "runAction",
        input: { action: "discard", changeOperation: "stage" },
      }),
    ).toBe(false);
    expect(
      isSourceControlMutationStepConfirmRequired({
        command: "runAction",
        input: { action: "discard", changeOperation: "unstage" },
      }),
    ).toBe(false);
    expect(
      isSourceControlMutationStepConfirmRequired({
        command: "runAction",
        input: { action: "stash", stashOperation: "view" },
      }),
    ).toBe(false);
    expect(
      isSourceControlMutationStepConfirmRequired({
        command: "runAction",
        input: { action: "commit", compoundOperation: "commit-sync" },
      }),
    ).toBe(true);
  });

  it("rejects late results after the repository request changes", () => {
    expect(isCurrentSourceControlRequest(3, 3)).toBe(true);
    expect(isCurrentSourceControlRequest(2, 3)).toBe(false);
  });
});
