import { assert, it, describe, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type {
  BackgroundScope,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { GitManagerError } from "@t3tools/contracts";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: "github",
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const remoteStatusWithPr: VcsStatusRemoteResult = {
  ...baseRemoteStatus,
  pr: {
    number: 2978,
    title: "[codex] Rewrite client connection architecture",
    url: "https://github.com/pingdotgg/t3code/pull/2978",
    baseRef: "main",
    headRef: "codex/connection-state-audit",
    state: "open",
  },
};

const baseStatus: VcsStatusResult = {
  ...baseLocalStatus,
  localRevision: "1",
  ...baseRemoteStatus,
};

function makeTestLayer(
  state: {
    currentLocalStatus: VcsStatusLocalResult;
    currentRemoteStatus: VcsStatusRemoteResult | null;
    localStatusCalls: number;
    remoteStatusCalls: number;
    localInvalidationCalls: number;
    remoteInvalidationCalls: number;
    remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
  },
  workflowOverrides: Partial<GitWorkflowService.GitWorkflowService["Service"]> = {},
) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(makeBackgroundPolicyLayer(() => true)),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () =>
          Effect.sync(() => {
            state.localStatusCalls += 1;
            return state.currentLocalStatus;
          }),
        remoteStatus: (_input, options) =>
          Effect.sync(() => {
            state.remoteStatusCalls += 1;
            state.remoteStatusRefreshUpstreamValues?.push(options?.refreshUpstream);
            return state.currentRemoteStatus;
          }),
        invalidateLocalStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
          }),
        invalidateRemoteStatus: () =>
          Effect.sync(() => {
            state.remoteInvalidationCalls += 1;
          }),
        invalidateStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
            state.remoteInvalidationCalls += 1;
          }),
        withRepositoryPermit: (_operation, _cwd, effect) => effect,
        withDetectedGitRepositoryPermit: (_operation, _cwd, effect) => effect,
        ...workflowOverrides,
      }),
    ),
  );
}

function makeBackgroundPolicyLayer(shouldRunScopeWork: (scope: BackgroundScope) => boolean) {
  return Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    reportHostPowerState: () => Effect.void,
    snapshot: Effect.succeed({
      hostPower: {
        source: "unknown",
        idle: "unknown",
        idleSeconds: null,
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        thermalState: "unknown",
        stale: true,
        updatedAt: TEST_EPOCH,
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: false,
      updatedAt: TEST_EPOCH,
    }),
    streamChanges: Stream.empty,
    hasDemand: () => Effect.succeed(true),
    shouldRunScopeWork: (scope) => Effect.sync(() => shouldRunScopeWork(scope)),
    shouldRunOpportunisticWork: Effect.succeed(true),
  });
}

describe("VcsStatusBroadcaster", () => {
  it.effect("reuses the cached VCS status across repeated reads", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      const first = yield* broadcaster.getStatus({ cwd: "/repo" });
      const second = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(first, baseStatus);
      assert.deepStrictEqual(second, baseStatus);
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("does not request remote status for a non-repository", () => {
    const state = {
      currentLocalStatus: {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      } satisfies VcsStatusLocalResult,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const status = yield* broadcaster.getStatus({ cwd: "/not-a-repo" });

      assert.equal(status.isRepo, false);
      assert.equal(status.hasUpstream, false);
      assert.equal(state.remoteStatusCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("refreshes the cached snapshot after explicit invalidation", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/updated-status",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 2,
      };
      const refreshed = yield* broadcaster.refreshStatus("/repo");
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshed, {
        ...state.currentLocalStatus,
        localRevision: "2",
        ...state.currentRemoteStatus,
      });
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        localRevision: "2",
        ...state.currentRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 1);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("returns fresh remote state for nested refreshes from the canonical root", () => {
    const state = {
      currentLocalStatus: { ...baseLocalStatus, repositoryRoot: "/repo" },
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const remoteCwds: Array<string> = [];

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      state.currentRemoteStatus = { ...baseRemoteStatus, aheadCount: 7 };

      const refreshed = yield* broadcaster.refreshStatus("/repo/nested");
      const root = yield* broadcaster.getStatus({ cwd: "/repo" });
      const nested = yield* broadcaster.getStatus({ cwd: "/repo/nested" });

      assert.equal(refreshed.aheadCount, 7);
      assert.equal(root.aheadCount, 7);
      assert.equal(nested.aheadCount, 7);
      assert.deepStrictEqual(remoteCwds, ["/repo", "/repo"]);
    }).pipe(
      Effect.provide(
        makeTestLayer(state, {
          remoteStatus: (input, options) =>
            Effect.sync(() => {
              remoteCwds.push(input.cwd);
              state.remoteStatusCalls += 1;
              if (options?.refreshUpstream !== false) return state.currentRemoteStatus;
              return state.currentRemoteStatus;
            }),
        }),
      ),
    );
  });

  it.effect("keeps a newer local mutation after a delayed full refresh", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    return Effect.gen(function* () {
      const localRefreshLoaded = yield* Deferred.make<void>();
      const remoteRefreshStarted = yield* Deferred.make<void>();
      const releaseRemoteRefresh = yield* Deferred.make<void>();

      const layer = makeTestLayer(state, {
        localStatus: () =>
          Effect.gen(function* () {
            state.localStatusCalls += 1;
            if (state.localStatusCalls === 2) {
              yield* Deferred.succeed(localRefreshLoaded, undefined);
            }
            return state.currentLocalStatus;
          }),
        remoteStatus: () =>
          Effect.gen(function* () {
            state.remoteStatusCalls += 1;
            if (state.remoteStatusCalls === 2) {
              yield* Deferred.succeed(remoteRefreshStarted, undefined);
              yield* Deferred.await(releaseRemoteRefresh);
            }
            return state.currentRemoteStatus;
          }),
      });
      // The broadcaster is already constructed by the layer supplied to this
      // effect, so the interleaving uses a dedicated instance below.
      const controlledBroadcaster = yield* Effect.provide(
        VcsStatusBroadcaster.VcsStatusBroadcaster,
        layer,
      );
      yield* controlledBroadcaster.getStatus({ cwd: "/repo" });
      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/old-refresh" };

      const fullRefresh = yield* controlledBroadcaster
        .refreshStatus("/repo")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(localRefreshLoaded);
      yield* Deferred.await(remoteRefreshStarted);

      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/newer-mutation" };
      const newerLocal = yield* controlledBroadcaster.refreshLocalStatus("/repo");
      yield* Deferred.succeed(releaseRemoteRefresh, undefined);
      const refreshed = yield* Fiber.join(fullRefresh);
      const cached = yield* controlledBroadcaster.getStatus({ cwd: "/repo" });

      assert.equal(newerLocal.refName, "feature/newer-mutation");
      assert.equal(refreshed.refName, "feature/newer-mutation");
      assert.equal(cached.refName, "feature/newer-mutation");
      assert.equal(refreshed.localRevision, newerLocal.localRevision);
      assert.equal(cached.localRevision, newerLocal.localRevision);
    }).pipe(Effect.scoped);
  });

  it.effect("returns the latest local state after a delayed initial remote read", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const localStarted = yield* Deferred.make<void>();
      const remoteStarted = yield* Deferred.make<void>();
      const releaseRemote = yield* Deferred.make<void>();
      const layer = makeTestLayer(state, {
        localStatus: () =>
          Effect.gen(function* () {
            state.localStatusCalls += 1;
            if (state.localStatusCalls === 1) {
              yield* Deferred.succeed(localStarted, undefined);
            }
            return state.currentLocalStatus;
          }),
        remoteStatus: () =>
          Effect.gen(function* () {
            state.remoteStatusCalls += 1;
            if (state.remoteStatusCalls === 1) {
              yield* Deferred.succeed(remoteStarted, undefined);
              yield* Deferred.await(releaseRemote);
            }
            return state.currentRemoteStatus;
          }),
      });
      const broadcaster = yield* Effect.provide(VcsStatusBroadcaster.VcsStatusBroadcaster, layer);
      const initialRead = yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
      yield* Deferred.await(localStarted);
      yield* Deferred.await(remoteStarted);

      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/latest" };
      const latestLocal = yield* broadcaster.refreshLocalStatus("/repo");
      yield* Deferred.succeed(releaseRemote, undefined);
      const result = yield* Fiber.join(initialRead);

      assert.equal(latestLocal.refName, "feature/latest");
      assert.equal(result.refName, "feature/latest");
      assert.equal(result.localRevision, latestLocal.localRevision);
    }).pipe(Effect.scoped);
  });

  it.effect("does not let an older remote refresh overwrite a newer one", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const olderRefreshStarted = yield* Deferred.make<void>();
      const releaseOlderRefresh = yield* Deferred.make<void>();
      const layer = makeTestLayer(state, {
        remoteStatus: () =>
          Effect.gen(function* () {
            state.remoteStatusCalls += 1;
            if (state.remoteStatusCalls === 2) {
              yield* Deferred.succeed(olderRefreshStarted, undefined);
              yield* Deferred.await(releaseOlderRefresh);
              return { ...baseRemoteStatus, aheadCount: 1 };
            }
            if (state.remoteStatusCalls === 3) {
              return { ...baseRemoteStatus, aheadCount: 2 };
            }
            return state.currentRemoteStatus;
          }),
      });
      const broadcaster = yield* Effect.provide(VcsStatusBroadcaster.VcsStatusBroadcaster, layer);
      yield* broadcaster.getStatus({ cwd: "/repo" });

      const older = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(olderRefreshStarted);
      const newer = yield* broadcaster.refreshStatus("/repo");
      yield* Deferred.succeed(releaseOlderRefresh, undefined);
      yield* Fiber.join(older);

      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(newer.aheadCount, 2);
      assert.equal(cached.aheadCount, 2);
    }).pipe(Effect.scoped);
  });

  it.effect(
    "orders overlapping nested and root remote refreshes on one canonical generation",
    () => {
      const state = {
        currentLocalStatus: { ...baseLocalStatus, repositoryRoot: "/repo" },
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      return Effect.gen(function* () {
        const olderRefreshStarted = yield* Deferred.make<void>();
        const releaseOlderRefresh = yield* Deferred.make<void>();
        const layer = makeTestLayer(state, {
          remoteStatus: (input) =>
            Effect.gen(function* () {
              state.remoteStatusCalls += 1;
              if (state.remoteStatusCalls === 2) {
                assert.equal(input.cwd, "/repo");
                yield* Deferred.succeed(olderRefreshStarted, undefined);
                yield* Deferred.await(releaseOlderRefresh);
                return { ...baseRemoteStatus, aheadCount: 1 };
              }
              if (state.remoteStatusCalls === 3) {
                assert.equal(input.cwd, "/repo");
                return { ...baseRemoteStatus, aheadCount: 2 };
              }
              return state.currentRemoteStatus;
            }),
        });
        const broadcaster = yield* Effect.provide(VcsStatusBroadcaster.VcsStatusBroadcaster, layer);
        yield* broadcaster.getStatus({ cwd: "/repo" });

        const older = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
        yield* Deferred.await(olderRefreshStarted);
        const newer = yield* broadcaster.refreshStatus("/repo/nested");
        yield* Deferred.succeed(releaseOlderRefresh, undefined);
        yield* Fiber.join(older);

        const root = yield* broadcaster.getStatus({ cwd: "/repo" });
        const nested = yield* broadcaster.getStatus({ cwd: "/repo/nested" });
        assert.equal(newer.aheadCount, 2);
        assert.equal(root.aheadCount, 2);
        assert.equal(nested.aheadCount, 2);
      }).pipe(Effect.scoped);
    },
  );

  it.effect(
    "refreshStatus forwards no-fetch options and publishes local and remote separately",
    () => {
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const remoteStatus = vi.fn(((_input, _options) =>
        Effect.sync(() => {
          state.remoteStatusCalls += 1;
          return state.currentRemoteStatus;
        })) satisfies GitWorkflowService.GitWorkflowService["Service"]["remoteStatus"]);

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: "/repo" });
        const initialSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
        const refreshedLocal = yield* Deferred.make<VcsStatusStreamEvent>();
        const refreshedRemote = yield* Deferred.make<VcsStatusStreamEvent>();
        yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
          if (event._tag === "snapshot")
            return Deferred.succeed(initialSnapshot, event).pipe(Effect.ignore);
          if (event._tag === "localUpdated")
            return Deferred.succeed(refreshedLocal, event).pipe(Effect.ignore);
          if (event._tag === "remoteUpdated")
            return Deferred.succeed(refreshedRemote, event).pipe(Effect.ignore);
          return Effect.void;
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(initialSnapshot);

        state.currentLocalStatus = {
          ...baseLocalStatus,
          refName: "feature/no-fetch-refresh",
          hasWorkingTreeChanges: true,
        };
        state.currentRemoteStatus = {
          ...baseRemoteStatus,
          aheadCount: 1,
        };

        yield* broadcaster.refreshStatus("/repo", { refreshUpstream: false });
        const localEvent = yield* Deferred.await(refreshedLocal);
        const remoteEvent = yield* Deferred.await(refreshedRemote);

        assert.deepStrictEqual(localEvent, {
          _tag: "localUpdated",
          local: {
            ...state.currentLocalStatus,
            localRevision: "2",
          },
        } satisfies VcsStatusStreamEvent);
        assert.deepStrictEqual(remoteEvent, {
          _tag: "remoteUpdated",
          remote: state.currentRemoteStatus,
        } satisfies VcsStatusStreamEvent);
        assert.deepEqual(remoteStatus.mock.calls.at(-1), [
          { cwd: "/repo" },
          { refreshUpstream: false },
        ]);
        assert.equal(state.localInvalidationCalls, 1);
        assert.equal(state.remoteInvalidationCalls, 0);
      }).pipe(Effect.provide(makeTestLayer(state, { remoteStatus })));
    },
  );

  it.effect("keeps the cached snapshot unchanged when a refresh branch fails", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      failRemoteStatus: false,
    };
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.suspend(() => {
              state.remoteStatusCalls += 1;
              return state.failRemoteStatus
                ? Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test",
                      cwd: "/repo",
                      detail: "remote status failed",
                    }),
                  )
                : Effect.succeed(state.currentRemoteStatus);
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          invalidateStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
              state.remoteInvalidationCalls += 1;
            }),
          withRepositoryPermit: (_operation, _cwd, effect) => effect,
          withDetectedGitRepositoryPermit: (_operation, _cwd, effect) => effect,
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/partial-refresh",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 3,
      };
      state.failRemoteStatus = true;

      const refreshExit = yield* broadcaster.refreshStatus("/repo").pipe(Effect.exit);
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.isTrue(Exit.isFailure(refreshExit));
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        localRevision: "2",
        ...baseRemoteStatus,
      });
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("refreshes only the cached local snapshot when requested", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/local-only-refresh",
        hasWorkingTreeChanges: true,
      };

      const refreshedLocal = yield* broadcaster.refreshLocalStatus("/repo");
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshedLocal, {
        ...state.currentLocalStatus,
        localRevision: "2",
      });
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        localRevision: "2",
        ...baseRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("advances the local revision for every accepted local refresh", () => {
    const unchangedLocalStatus: VcsStatusLocalResult = {
      ...baseLocalStatus,
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          {
            path: "src/unchanged.ts",
            insertions: 1,
            deletions: 1,
            indexStatus: "both",
          },
        ],
        insertions: 1,
        deletions: 1,
      },
    };
    const state = {
      currentLocalStatus: unchangedLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initialSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const localUpdates = yield* Ref.make<ReadonlyArray<VcsStatusStreamEvent>>([]);
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
        if (event._tag === "snapshot") {
          return Deferred.succeed(initialSnapshot, event).pipe(Effect.ignore);
        }
        if (event._tag === "localUpdated") {
          return Ref.update(localUpdates, (events) => [...events, event]);
        }
        return Effect.void;
      }).pipe(Effect.forkScoped);

      const initial = yield* Deferred.await(initialSnapshot);
      const firstRefresh = yield* broadcaster.refreshLocalStatus("/repo");
      const secondRefresh = yield* broadcaster.refreshLocalStatus("/repo");
      yield* Effect.yieldNow;

      if (initial._tag !== "snapshot") throw new Error("Expected an initial status snapshot.");
      assert.equal(initial.local.localRevision, "1");
      assert.equal(firstRefresh.localRevision, "2");
      assert.equal(secondRefresh.localRevision, "3");
      assert.deepStrictEqual(
        [firstRefresh, secondRefresh].map((status) =>
          status.workingTree.files.map(({ path, indexStatus }) => ({ path, indexStatus })),
        ),
        [
          [{ path: "src/unchanged.ts", indexStatus: "both" }],
          [{ path: "src/unchanged.ts", indexStatus: "both" }],
        ],
      );
      assert.deepStrictEqual(
        (yield* Ref.get(localUpdates)).map((event) =>
          event._tag === "localUpdated" ? event.local.localRevision : null,
        ),
        ["2", "3"],
      );
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("advances the local revision when only pending merge heads change", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const updateDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
        if (event._tag === "snapshot")
          return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
        if (event._tag === "localUpdated")
          return Deferred.succeed(updateDeferred, event).pipe(Effect.ignore);
        return Effect.void;
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(snapshotDeferred);
      state.currentLocalStatus = { ...baseLocalStatus, pendingMergeHeads: ["merge-head-1"] };
      const refreshed = yield* broadcaster.refreshLocalStatus("/repo");
      const update = yield* Deferred.await(updateDeferred);

      assert.equal(refreshed.localRevision, "2");
      assert.equal(update._tag, "localUpdated");
      if (update._tag === "localUpdated") {
        assert.deepStrictEqual(update.local.pendingMergeHeads, ["merge-head-1"]);
      }
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("normalizes symlinked CWDs before cache lookup and workflow calls", () => {
    const seenCwds: string[] = [];
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: (input) =>
            Effect.sync(() => {
              seenCwds.push(input.cwd);
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: (input) =>
            Effect.sync(() => {
              seenCwds.push(input.cwd);
              state.remoteStatusCalls += 1;
              return state.currentRemoteStatus;
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          withRepositoryPermit: (_operation, _cwd, effect) => effect,
          withDetectedGitRepositoryPermit: (_operation, _cwd, effect) => effect,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const realDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-real-",
      });
      const linkParent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-link-",
      });
      const linkDir = path.join(linkParent, "repo-link");
      yield* fileSystem.symlink(realDir, linkDir);
      const realPath = yield* fileSystem.realPath(realDir);

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: linkDir });
      yield* broadcaster.getStatus({ cwd: realDir });

      assert.deepStrictEqual(seenCwds, [realPath, realPath]);
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("shares local revisions for nested CWDs in one repository", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repositoryRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-root-",
      });
      const nestedCwd = path.join(repositoryRoot, "nested");
      yield* fileSystem.makeDirectory(nestedCwd);
      state.currentLocalStatus = {
        ...baseLocalStatus,
        repositoryRoot,
      };

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const updateDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: repositoryRoot }), (event) => {
        if (event._tag === "snapshot") {
          return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
        }
        if (event._tag === "localUpdated") {
          return Deferred.succeed(updateDeferred, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkScoped);

      const snapshot = yield* Deferred.await(snapshotDeferred);
      yield* broadcaster.refreshLocalStatus(nestedCwd);
      const update = yield* Deferred.await(updateDeferred);

      assert.equal(snapshot._tag, "snapshot");
      assert.equal(update._tag, "localUpdated");
      if (snapshot._tag !== "snapshot" || update._tag !== "localUpdated") {
        throw new Error("Expected local status events.");
      }
      assert.equal(snapshot.local.localRevision, "1");
      assert.equal(update.local.localRevision, "2");
      assert.equal(update.local.repositoryRoot, repositoryRoot);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("reuses a canonical repository cache for alias-first status reads", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repositoryRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-alias-",
      });
      const nestedCwd = path.join(repositoryRoot, "nested");
      yield* fileSystem.makeDirectory(nestedCwd);
      const linkParent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-alias-link-",
      });
      const symlinkCwd = path.join(linkParent, "repo-link");
      yield* fileSystem.symlink(repositoryRoot, symlinkCwd);
      state.currentLocalStatus = { ...baseLocalStatus, repositoryRoot };

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const nested = yield* broadcaster.getStatus({ cwd: nestedCwd });
      const root = yield* broadcaster.getStatus({ cwd: repositoryRoot });
      const symlink = yield* broadcaster.getStatus({ cwd: symlinkCwd });

      assert.equal(nested.localRevision, "1");
      assert.equal(root.localRevision, "1");
      assert.equal(symlink.localRevision, "1");
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("keeps concurrent alias reads on one canonical local revision", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const repositoryRoot = "/repo";
      const nestedCwd = "/repo/nested";
      state.currentLocalStatus = { ...baseLocalStatus, repositoryRoot };

      const localCallsStarted = yield* Deferred.make<void>();
      const releaseLocalCalls = yield* Deferred.make<void>();
      const remoteCallsStarted = yield* Deferred.make<void>();
      const releaseRemoteCalls = yield* Deferred.make<void>();
      const workflow = {
        localStatus: () =>
          Effect.gen(function* () {
            state.localStatusCalls += 1;
            if (state.localStatusCalls === 2) {
              yield* Deferred.succeed(localCallsStarted, undefined);
            }
            yield* Deferred.await(releaseLocalCalls);
            return state.currentLocalStatus;
          }),
        remoteStatus: () =>
          Effect.gen(function* () {
            state.remoteStatusCalls += 1;
            if (state.remoteStatusCalls === 2) {
              yield* Deferred.succeed(remoteCallsStarted, undefined);
            }
            yield* Deferred.await(releaseRemoteCalls);
            return state.currentRemoteStatus;
          }),
      } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>;
      const broadcaster = yield* Effect.provide(
        VcsStatusBroadcaster.VcsStatusBroadcaster,
        makeTestLayer(state, workflow),
      );
      const reads = Effect.all(
        [broadcaster.getStatus({ cwd: nestedCwd }), broadcaster.getStatus({ cwd: repositoryRoot })],
        { concurrency: "unbounded" },
      );
      const readsFiber = yield* reads.pipe(Effect.forkScoped);

      yield* Deferred.await(localCallsStarted);
      yield* Deferred.succeed(releaseLocalCalls, undefined);
      yield* Deferred.await(remoteCallsStarted);
      yield* Deferred.succeed(releaseRemoteCalls, undefined);
      const [nested, root] = yield* Fiber.join(readsFiber);

      assert.equal(nested.localRevision, "1");
      assert.equal(root.localRevision, "1");
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 2);
    }).pipe(Effect.scoped);
  });

  it.effect("streams a local snapshot first and remote updates later", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
        if (event._tag === "snapshot") {
          return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
        }
        if (event._tag === "remoteUpdated") {
          return Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkScoped);

      const snapshot = yield* Deferred.await(snapshotDeferred);
      yield* broadcaster.refreshStatus("/repo");
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(snapshot, {
        _tag: "snapshot",
        local: {
          ...baseLocalStatus,
          localRevision: "1",
        },
        remote: null,
      } satisfies VcsStatusStreamEvent);
      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: baseRemoteStatus,
      } satisfies VcsStatusStreamEvent);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("loads remote status once when periodic refreshes are disabled", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
        ),
        (event) => {
          if (event._tag === "snapshot") {
            return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "remoteUpdated") {
            return Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore);
          }
          return Effect.void;
        },
      ).pipe(Effect.forkIn(scope));

      const snapshot = yield* Deferred.await(snapshotDeferred);
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(snapshot, {
        _tag: "snapshot",
        local: {
          ...baseLocalStatus,
          localRevision: "1",
        },
        remote: null,
      } satisfies VcsStatusStreamEvent);
      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: remoteStatusWithPr,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
      assert.deepStrictEqual(state.remoteStatusRefreshUpstreamValues, [false]);

      yield* TestClock.adjust(Duration.minutes(2));
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(makeTestLayer(state), TestClock.layer())));
  });

  it.effect("retries the initial remote load when periodic refreshes are disabled", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
    };
    const privateCwd = "/private/user/workspace/repo";
    const nestedCause = new Error("private nested VCS failure");
    const messages: Array<ReadonlyArray<unknown>> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(message as ReadonlyArray<unknown>);
    });
    let firstRemoteAttemptDeferred: Deferred.Deferred<void> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: (_input, options) =>
            Effect.suspend(() => {
              state.remoteStatusCalls += 1;
              state.remoteStatusRefreshUpstreamValues.push(options?.refreshUpstream);
              if (state.remoteStatusCalls === 1) {
                return Effect.fail(
                  new GitManagerError({
                    operation: "VcsStatusBroadcaster.test",
                    cwd: privateCwd,
                    detail: "private initial remote status failure",
                    cause: nestedCause,
                  }),
                ).pipe(
                  Effect.ensuring(
                    firstRemoteAttemptDeferred
                      ? Deferred.succeed(firstRemoteAttemptDeferred, undefined).pipe(Effect.ignore)
                      : Effect.void,
                  ),
                );
              }
              return Effect.succeed(remoteStatusWithPr);
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          withRepositoryPermit: (_operation, _cwd, effect) => effect,
          withDetectedGitRepositoryPermit: (_operation, _cwd, effect) => effect,
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      firstRemoteAttemptDeferred = yield* Deferred.make<void>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: privateCwd },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
        ),
        (event) =>
          event._tag === "remoteUpdated"
            ? Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(firstRemoteAttemptDeferred);
      yield* Effect.yieldNow;
      assert.equal(state.remoteStatusCalls, 1);
      assert.deepStrictEqual(
        messages.find((message) => message[0] === "VCS remote status refresh failed"),
        [
          "VCS remote status refresh failed",
          {
            cwdLength: privateCwd.length,
            reasonCount: 1,
            failureCount: 1,
            failureTags: ["GitManagerError"],
            failureOperations: ["VcsStatusBroadcaster.test"],
            defectCount: 0,
            defectTags: [],
            interruptionCount: 0,
            consecutiveFailures: 1,
            nextDelayMs: 30_000,
          },
        ],
      );

      yield* TestClock.adjust(Duration.seconds(30));
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: remoteStatusWithPr,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 0);
      assert.deepStrictEqual(state.remoteStatusRefreshUpstreamValues, [false, false]);

      yield* Scope.close(scope, Exit.void);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          testLayer,
          TestClock.layer(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("delays automatic refresh when a cached remote snapshot is available", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.minutes(1)) },
        ),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(snapshotDeferred);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);

      yield* TestClock.adjust(Duration.seconds(59));
      assert.equal(state.remoteStatusCalls, 1);

      yield* TestClock.adjust(Duration.seconds(1));
      yield* Effect.yieldNow;
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 1);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(makeTestLayer(state), TestClock.layer())));
  });

  it("backs off remote refresh failures exponentially and honors larger configured intervals", () => {
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(1, Duration.seconds(1))),
      30_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(2, Duration.seconds(1))),
      60_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(3, Duration.seconds(1))),
      120_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(1, Duration.minutes(5))),
      300_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(20, Duration.seconds(1))),
      900_000,
    );
  });

  it("summarizes refresh causes without exposing nested failure details", () => {
    const nestedCause = new Error("private nested failure detail");
    const failure = new GitManagerError({
      operation: "VcsStatusBroadcaster.remoteStatus",
      cwd: "/private/user/workspace/repo",
      detail: "private Git failure detail",
      cause: nestedCause,
    });
    const cause = Cause.combine(Cause.fail(failure), Cause.die(new TypeError("private defect")));

    assert.deepStrictEqual(VcsStatusBroadcaster.remoteRefreshFailureDiagnostics(cause), {
      reasonCount: 2,
      failureCount: 1,
      failureTags: ["GitManagerError"],
      failureOperations: ["VcsStatusBroadcaster.remoteStatus"],
      defectCount: 1,
      defectTags: ["TypeError"],
      interruptionCount: 0,
    });
  });

  it.effect("does not start automatic remote refreshes without foreground client demand", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => false)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
              return state.currentRemoteStatus;
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          withRepositoryPermit: (_operation, _cwd, effect) => effect,
          withDetectedGitRepositoryPermit: (_operation, _cwd, effect) => effect,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshot = yield* Stream.runHead(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)) },
        ),
      );

      assert.isTrue(Option.isSome(snapshot));
      assert.equal(state.remoteStatusCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("stops the remote poller after the last stream subscriber disconnects", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    let remoteInterruptedDeferred: Deferred.Deferred<void, never> | null = null;
    let remoteStartedDeferred: Deferred.Deferred<void, never> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
            }).pipe(
              Effect.andThen(
                remoteStartedDeferred
                  ? Deferred.succeed(remoteStartedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.andThen(Effect.never as Effect.Effect<VcsStatusRemoteResult | null, never>),
              Effect.onInterrupt(() =>
                remoteInterruptedDeferred
                  ? Deferred.succeed(remoteInterruptedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          withRepositoryPermit: (_operation, _cwd, effect) => effect,
          withDetectedGitRepositoryPermit: (_operation, _cwd, effect) => effect,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const remoteInterrupted = yield* Deferred.make<void>();
      const remoteStarted = yield* Deferred.make<void>();
      remoteInterruptedDeferred = remoteInterrupted;
      remoteStartedDeferred = remoteStarted;

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const firstSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const secondSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(firstSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(firstScope));
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(secondSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(secondScope));

      yield* Deferred.await(firstSnapshot);
      yield* Deferred.await(secondSnapshot);
      yield* Deferred.await(remoteStarted);

      assert.equal(state.remoteStatusCalls, 1);

      yield* Scope.close(firstScope, Exit.void);
      assert.isTrue(Option.isNone(yield* Deferred.poll(remoteInterrupted)));

      yield* Scope.close(secondScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(remoteInterrupted);
      assert.isTrue(Option.isSome(yield* Deferred.poll(remoteInterrupted)));
    }).pipe(Effect.provide(testLayer));
  });
});
