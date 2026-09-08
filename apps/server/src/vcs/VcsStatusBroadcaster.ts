import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";

const DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const MAX_FAILURE_DIAGNOSTIC_VALUES = 8;
const MAX_FAILURE_DIAGNOSTIC_VALUE_LENGTH = 128;

function boundedDiagnosticValue(value: string): string {
  return value.slice(0, MAX_FAILURE_DIAGNOSTIC_VALUE_LENGTH);
}

function diagnosticValueTag(value: unknown): string {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "_tag" in value &&
      typeof value._tag === "string"
    ) {
      return boundedDiagnosticValue(value._tag);
    }
    if (value instanceof Error) {
      return boundedDiagnosticValue(value.name);
    }
    return typeof value;
  } catch {
    return "Uninspectable";
  }
}

function diagnosticFailureOperation(value: unknown): string | undefined {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "operation" in value &&
      typeof value.operation === "string"
    ) {
      return boundedDiagnosticValue(value.operation);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function addUniqueDiagnosticValue(values: Array<string>, value: string | undefined): void {
  if (
    value !== undefined &&
    values.length < MAX_FAILURE_DIAGNOSTIC_VALUES &&
    !values.includes(value)
  ) {
    values.push(value);
  }
}

export function remoteRefreshFailureDiagnostics(cause: Cause.Cause<unknown>) {
  const failureTags: Array<string> = [];
  const failureOperations: Array<string> = [];
  const defectTags: Array<string> = [];
  let failureCount = 0;
  let defectCount = 0;
  let interruptionCount = 0;

  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      failureCount += 1;
      addUniqueDiagnosticValue(failureTags, diagnosticValueTag(reason.error));
      addUniqueDiagnosticValue(failureOperations, diagnosticFailureOperation(reason.error));
      continue;
    }
    if (Cause.isDieReason(reason)) {
      defectCount += 1;
      addUniqueDiagnosticValue(defectTags, diagnosticValueTag(reason.defect));
      continue;
    }
    interruptionCount += 1;
  }

  return {
    reasonCount: cause.reasons.length,
    failureCount,
    failureTags,
    failureOperations,
    defectCount,
    defectTags,
    interruptionCount,
  };
}

interface VcsStatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
}

interface CachedValue<T> {
  readonly fingerprint: string;
  readonly value: T;
}

interface CachedVcsStatus {
  readonly localRevision: number;
  readonly remoteGeneration: number;
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote: CachedValue<VcsStatusRemoteResult | null> | null;
}

const EMPTY_CACHED_VCS_STATUS: CachedVcsStatus = {
  localRevision: 0,
  remoteGeneration: 0,
  local: null,
  remote: null,
};

const NON_REPOSITORY_LOCAL_STATUS: VcsStatusLocalResult = {
  isRepo: false,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
  readonly demandCwds: Ref.Ref<ReadonlyMap<string, number>>;
}

interface StreamStatusOptions {
  readonly automaticRemoteRefreshInterval?: Effect.Effect<Duration.Duration, never>;
}

export function remoteRefreshFailureDelay(
  consecutiveFailures: number,
  configuredInterval: Duration.Duration,
) {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs =
    Duration.toMillis(VCS_STATUS_REFRESH_FAILURE_BASE_DELAY) * Math.pow(2, exponent);
  const cappedBackoff = Duration.min(
    Duration.millis(backoffMs),
    VCS_STATUS_REFRESH_FAILURE_MAX_DELAY,
  );
  return Duration.max(configuredInterval, cappedBackoff);
}

export class VcsStatusBroadcaster extends Context.Service<
  VcsStatusBroadcaster,
  {
    readonly getStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshLocalStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly refreshStatus: (
      cwd: string,
      options?: { readonly refreshUpstream?: boolean },
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly streamStatus: (
      input: VcsStatusInput,
      options?: StreamStatusOptions,
    ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
  }
>()("t3/vcs/VcsStatusBroadcaster") {}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

function fingerprintLocalStatus(local: VcsStatusLocalResult): string {
  const { localRevision: _localRevision, ...withoutRevision } = local;
  return fingerprintStatusPart(withoutRevision);
}

const normalizeCwd = (cwd: string) =>
  Effect.service(FileSystem.FileSystem).pipe(
    Effect.flatMap((fs) => fs.realPath(cwd)),
    Effect.orElseSucceed(() => cwd),
  );

export const make = Effect.gen(function* () {
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const fs = yield* FileSystem.FileSystem;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<VcsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());
  const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);
  const withDetectedRepositoryPermit = <A, E, R>(
    operation: string,
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A | null, E | GitManagerServiceError, R> =>
    workflow.withDetectedGitRepositoryPermit
      ? workflow.withDetectedGitRepositoryPermit(operation, cwd, effect)
      : workflow.withRepositoryPermit(operation, cwd, effect);

  const statusCacheKeyForLocal = Effect.fn("VcsStatusBroadcaster.statusCacheKeyForLocal")(
    function* (requestedCwd: string, local: VcsStatusLocalResult) {
      if (local.repositoryRoot === undefined) {
        return requestedCwd;
      }
      return yield* withFileSystem(normalizeCwd(local.repositoryRoot));
    },
  );

  const removeStatusCacheAlias = Effect.fn("VcsStatusBroadcaster.removeStatusCacheAlias")(
    function* (requestedCwd: string, canonicalCwd: string) {
      if (requestedCwd === canonicalCwd) {
        return;
      }
      yield* Ref.update(cacheRef, (cache) => {
        if (!cache.has(requestedCwd)) {
          return cache;
        }
        const nextCache = new Map(cache);
        nextCache.delete(requestedCwd);
        return nextCache;
      });
    },
  );

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
  });

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (
      cwd: string,
      local: VcsStatusLocalResult,
      options?: { publish?: boolean; onlyIfChanged?: boolean },
    ) {
      const [nextLocal, shouldPublish] = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? EMPTY_CACHED_VCS_STATUS;
        if (
          options?.onlyIfChanged &&
          previous.local &&
          fingerprintLocalStatus(previous.local.value) === fingerprintLocalStatus(local)
        ) {
          return [[previous.local, false as boolean] as const, cache] as const;
        }
        const localRevision = previous.localRevision + 1;
        const value = {
          ...local,
          localRevision: String(localRevision),
        };
        const nextLocal = {
          fingerprint: fingerprintStatusPart(value),
          value,
        } satisfies CachedValue<VcsStatusLocalResult>;
        const nextCache = new Map(cache);
        nextCache.set(cwd, {
          ...previous,
          localRevision,
          local: nextLocal,
        });
        return [
          [nextLocal, previous.local?.fingerprint !== nextLocal.fingerprint] as const,
          nextCache,
        ] as const;
      });

      if (options?.publish && shouldPublish) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: {
            _tag: "localUpdated",
            local: nextLocal.value,
          },
        });
      }

      return nextLocal.value;
    },
  );

  const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
    function* (
      cwd: string,
      remote: VcsStatusRemoteResult | null,
      options?: { publish?: boolean; generation?: number },
    ) {
      const nextRemote = {
        fingerprint: fingerprintStatusPart(remote),
        value: remote,
      } satisfies CachedValue<VcsStatusRemoteResult | null>;
      const [publishedRemote, shouldPublish] = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? EMPTY_CACHED_VCS_STATUS;
        if (options?.generation !== undefined && options.generation < previous.remoteGeneration) {
          return [[previous.remote?.value ?? remote, false as boolean] as const, cache] as const;
        }
        const nextCache = new Map(cache);
        nextCache.set(cwd, {
          ...previous,
          remote: nextRemote,
        });
        return [
          [remote, previous.remote?.fingerprint !== nextRemote.fingerprint] as const,
          nextCache,
        ] as const;
      });

      if (options?.publish && shouldPublish) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: {
            _tag: "remoteUpdated",
            remote: publishedRemote,
          },
        });
      }

      return publishedRemote;
    },
  );

  const allocateRemoteGeneration = Effect.fn("VcsStatusBroadcaster.allocateRemoteGeneration")(
    function* (cwd: string) {
      return yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? EMPTY_CACHED_VCS_STATUS;
        const generation = previous.remoteGeneration + 1;
        const nextCache = new Map(cache);
        nextCache.set(cwd, { ...previous, remoteGeneration: generation });
        return [generation, nextCache] as const;
      });
    },
  );

  const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
    cwd: string,
  ) {
    const loaded = yield* withDetectedRepositoryPermit(
      "VcsStatusBroadcaster.loadLocalStatus",
      cwd,
      Effect.gen(function* () {
        const local = yield* workflow.localStatus({ cwd });
        const canonicalCwd = yield* statusCacheKeyForLocal(cwd, local);
        const cached = yield* getCachedStatus(canonicalCwd);
        if (
          cached?.local &&
          fingerprintLocalStatus(cached.local.value) === fingerprintLocalStatus(local)
        ) {
          yield* removeStatusCacheAlias(cwd, canonicalCwd);
          return cached.local.value;
        }
        yield* removeStatusCacheAlias(cwd, canonicalCwd);
        return yield* updateCachedLocalStatus(canonicalCwd, local, { onlyIfChanged: true });
      }),
    );
    if (loaded !== null) return loaded;
    return yield* updateCachedLocalStatus(cwd, NON_REPOSITORY_LOCAL_STATUS, {
      onlyIfChanged: true,
    });
  });

  const getOrLoadLocalStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(function* (
    cwd: string,
  ) {
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      return cached.local.value;
    }
    return yield* loadLocalStatus(cwd);
  });

  const getStatus: VcsStatusBroadcaster["Service"]["getStatus"] = Effect.fn(
    "VcsStatusBroadcaster.getStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local && cached.remote) {
      const canonicalCwd = yield* statusCacheKeyForLocal(cwd, cached.local.value);
      if (canonicalCwd === cwd) {
        if (!cached.local.value.isRepo) {
          return mergeGitStatusParts(cached.local.value, null);
        }
        return mergeGitStatusParts(cached.local.value, cached.remote.value);
      }
      const canonicalCached = yield* getCachedStatus(canonicalCwd);
      if (canonicalCached?.local && canonicalCached.remote) {
        if (!canonicalCached.local.value.isRepo) {
          return mergeGitStatusParts(canonicalCached.local.value, null);
        }
        return mergeGitStatusParts(canonicalCached.local.value, canonicalCached.remote.value);
      }
    }

    const local = cached?.local?.value ?? (yield* loadLocalStatus(cwd));
    if (!local.isRepo) {
      return mergeGitStatusParts(local, null);
    }
    const canonicalCwd = yield* statusCacheKeyForLocal(cwd, local);
    const canonicalCached = yield* getCachedStatus(canonicalCwd);
    if (
      canonicalCached?.local &&
      canonicalCached.remote &&
      fingerprintLocalStatus(canonicalCached.local.value) === fingerprintLocalStatus(local)
    ) {
      yield* removeStatusCacheAlias(cwd, canonicalCwd);
      return mergeGitStatusParts(canonicalCached.local.value, canonicalCached.remote.value);
    }
    const remote =
      canonicalCached?.remote?.value ??
      cached?.remote?.value ??
      (yield* refreshRemoteStatus(canonicalCwd, undefined, false));
    const latestAtCwd = yield* getCachedStatus(cwd);
    const latestLocal = latestAtCwd?.local?.value ?? local;
    const latestCanonicalCwd = yield* statusCacheKeyForLocal(cwd, latestLocal);
    yield* removeStatusCacheAlias(cwd, latestCanonicalCwd);
    const latestCached = yield* getCachedStatus(latestCanonicalCwd);
    return mergeGitStatusParts(
      latestCached?.local?.value ?? latestLocal,
      latestCached?.remote?.value ?? remote,
    );
  });

  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string, invalidation: "local" | "none" = "local") {
      const refreshed = yield* withDetectedRepositoryPermit(
        "VcsStatusBroadcaster.refreshLocalStatus",
        cwd,
        Effect.gen(function* () {
          if (invalidation === "local") {
            yield* workflow.invalidateLocalStatus(cwd);
          }
          const local = yield* workflow.localStatus({ cwd });
          const canonicalCwd = yield* statusCacheKeyForLocal(cwd, local);
          yield* removeStatusCacheAlias(cwd, canonicalCwd);
          return yield* updateCachedLocalStatus(canonicalCwd, local, { publish: true });
        }),
      );
      if (refreshed !== null) return refreshed;
      return yield* updateCachedLocalStatus(cwd, NON_REPOSITORY_LOCAL_STATUS, { publish: true });
    },
  );

  const refreshLocalStatus: VcsStatusBroadcaster["Service"]["refreshLocalStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshLocalStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    return yield* refreshLocalStatusCore(cwd);
  });

  const refreshRemoteStatus = Effect.fn("VcsStatusBroadcaster.refreshRemoteStatus")(function* (
    cwd: string,
    options?: { readonly refreshUpstream?: boolean },
    shouldInvalidateRemote = true,
  ) {
    const cached = yield* getCachedStatus(cwd);
    const canonicalCwd = cached?.local
      ? yield* statusCacheKeyForLocal(cwd, cached.local.value)
      : cwd;
    const generation = yield* allocateRemoteGeneration(canonicalCwd);
    if (shouldInvalidateRemote && options?.refreshUpstream !== false) {
      yield* workflow.invalidateRemoteStatus(cwd);
    }
    const remote = yield* withDetectedRepositoryPermit(
      "VcsStatusBroadcaster.refreshRemoteStatus",
      cwd,
      workflow.remoteStatus({ cwd }, options),
    );
    return yield* updateCachedRemoteStatus(canonicalCwd, remote, {
      publish: true,
      generation,
    });
  });

  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshStatus",
  )(function* (rawCwd, options) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    const fullRefresh = options?.refreshUpstream !== false;
    if (fullRefresh) {
      // Invalidate before either branch starts so a remote read cannot win
      // the race and return the pre-refresh cached upstream result. The local
      // read and publication remain serialized by refreshLocalStatusCore.
      yield* workflow.invalidateStatus(cwd);
    }
    const [local, remote] = yield* Effect.all(
      [
        refreshLocalStatusCore(cwd, fullRefresh ? "none" : "local"),
        refreshRemoteStatus(cwd, options, false),
      ],
      { concurrency: "unbounded" },
    );
    const canonicalCwd = yield* statusCacheKeyForLocal(cwd, local);
    yield* removeStatusCacheAlias(cwd, canonicalCwd);
    const latestCached = yield* getCachedStatus(canonicalCwd);
    return mergeGitStatusParts(
      latestCached?.local?.value ?? local,
      latestCached?.remote?.value ?? remote,
    );
  });

  const makeRemoteRefreshLoop = (
    cwd: string,
    demandCwdsRef: Ref.Ref<ReadonlyMap<string, number>>,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    refreshImmediately: boolean,
  ) => {
    return Effect.gen(function* () {
      const consecutiveFailuresRef = yield* Ref.make(0);
      const needsInitialRefreshRef = yield* Ref.make(refreshImmediately);
      const refreshRemoteStatusIfEnabled = Effect.gen(function* () {
        const configuredInterval = yield* automaticRemoteRefreshInterval;
        const activeInterval = Duration.isZero(configuredInterval)
          ? DEFAULT_VCS_STATUS_REFRESH_INTERVAL
          : configuredInterval;
        const needsInitialRefresh = yield* Ref.get(needsInitialRefreshRef);
        if (Duration.isZero(configuredInterval) && !needsInitialRefresh) {
          return activeInterval;
        }

        const demandCwds = yield* Ref.get(demandCwdsRef);
        const shouldRun =
          needsInitialRefresh ||
          (yield* Effect.all(
            [...demandCwds.keys()].map((demandCwd) =>
              backgroundPolicy.shouldRunScopeWork({
                type: "vcs-status",
                cwd: demandCwd,
              }),
            ),
            { concurrency: "unbounded" },
          )).some(Boolean);
        if (!shouldRun) {
          return activeInterval;
        }

        const exit = yield* refreshRemoteStatus(cwd, {
          refreshUpstream: !Duration.isZero(configuredInterval),
        }).pipe(Effect.exit);
        if (Exit.isSuccess(exit)) {
          yield* Ref.set(needsInitialRefreshRef, false);
          yield* Ref.set(consecutiveFailuresRef, 0);
          return activeInterval;
        }

        const interruptionReasons = exit.cause.reasons.filter(Cause.isInterruptReason);
        if (interruptionReasons.length > 0) {
          return yield* Effect.failCause(Cause.fromReasons<never>(interruptionReasons));
        }

        const consecutiveFailures = yield* Ref.updateAndGet(
          consecutiveFailuresRef,
          (count) => count + 1,
        );
        const nextDelay = remoteRefreshFailureDelay(consecutiveFailures, activeInterval);
        yield* Effect.logWarning("VCS remote status refresh failed", {
          cwdLength: cwd.length,
          ...remoteRefreshFailureDiagnostics(exit.cause),
          consecutiveFailures,
          nextDelayMs: Duration.toMillis(nextDelay),
        });
        return nextDelay;
      });

      if (!refreshImmediately) {
        const configuredInterval = yield* automaticRemoteRefreshInterval;
        yield* Effect.sleep(
          Duration.isZero(configuredInterval)
            ? DEFAULT_VCS_STATUS_REFRESH_INTERVAL
            : configuredInterval,
        );
      }

      return yield* refreshRemoteStatusIfEnabled.pipe(
        Effect.repeat(
          Schedule.identity<Duration.Duration>().pipe(
            Schedule.addDelay(({ output: delay }) => Effect.succeed(delay)),
          ),
        ),
        Effect.asVoid,
      );
    });
  };

  const retainRemotePoller = Effect.fn("VcsStatusBroadcaster.retainRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    refreshImmediately: boolean,
  ) {
    yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (existing) {
        return Ref.update(existing.demandCwds, (demandCwds) => {
          const next = new Map(demandCwds);
          next.set(demandCwd, (next.get(demandCwd) ?? 0) + 1);
          return next;
        }).pipe(
          Effect.map(() => {
            const nextPollers = new Map(activePollers);
            nextPollers.set(cwd, {
              ...existing,
              subscriberCount: existing.subscriberCount + 1,
            });
            return [undefined, nextPollers] as const;
          }),
        );
      }

      return Ref.make<ReadonlyMap<string, number>>(new Map([[demandCwd, 1]])).pipe(
        Effect.flatMap((demandCwds) =>
          makeRemoteRefreshLoop(
            cwd,
            demandCwds,
            automaticRemoteRefreshInterval,
            refreshImmediately,
          ).pipe(
            Effect.forkIn(broadcasterScope),
            Effect.map((fiber) => {
              const nextPollers = new Map(activePollers);
              nextPollers.set(cwd, {
                fiber,
                subscriberCount: 1,
                demandCwds,
              });
              return [undefined, nextPollers] as const;
            }),
          ),
        ),
      );
    });
  });

  const releaseRemotePoller = Effect.fn("VcsStatusBroadcaster.releaseRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
  ) {
    const pollerToInterrupt = yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (!existing) {
        return Effect.succeed([null, activePollers] as const);
      }

      if (existing.subscriberCount > 1) {
        return Ref.update(existing.demandCwds, (demandCwds) => {
          const nextDemandCwds = new Map(demandCwds);
          const count = nextDemandCwds.get(demandCwd) ?? 0;
          if (count <= 1) {
            nextDemandCwds.delete(demandCwd);
          } else {
            nextDemandCwds.set(demandCwd, count - 1);
          }
          return nextDemandCwds;
        }).pipe(
          Effect.as([
            null,
            new Map(activePollers).set(cwd, {
              ...existing,
              subscriberCount: existing.subscriberCount - 1,
            }),
          ] as const),
        );
      }

      return Effect.succeed([
        existing.fiber,
        new Map([...activePollers].filter(([activeCwd]) => activeCwd !== cwd)),
      ] as const);
    });

    if (pollerToInterrupt) {
      yield* Fiber.interrupt(pollerToInterrupt).pipe(Effect.ignore);
    }
  });

  const streamStatus: VcsStatusBroadcaster["Service"]["streamStatus"] = (input, options) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const subscription = yield* PubSub.subscribe(changesPubSub);
        const initialLocal = yield* getOrLoadLocalStatus(cwd);
        const repositoryCwd = yield* statusCacheKeyForLocal(cwd, initialLocal);
        const cachedStatus = yield* getCachedStatus(repositoryCwd);
        const initialRemote = cachedStatus?.remote?.value ?? null;
        yield* retainRemotePoller(
          repositoryCwd,
          input.cwd,
          options?.automaticRemoteRefreshInterval ??
            Effect.succeed(DEFAULT_VCS_STATUS_REFRESH_INTERVAL),
          cachedStatus?.remote === null || cachedStatus?.remote === undefined,
        );

        const release = releaseRemotePoller(repositoryCwd, input.cwd).pipe(
          Effect.ignore,
          Effect.asVoid,
        );

        return Stream.concat(
          Stream.make({
            _tag: "snapshot" as const,
            local: initialLocal,
            remote: initialRemote,
          }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.cwd === repositoryCwd),
            Stream.map((event) => event.event),
          ),
        ).pipe(Stream.ensuring(release));
      }),
    );

  return VcsStatusBroadcaster.of({
    getStatus,
    refreshLocalStatus,
    refreshStatus,
    streamStatus,
  });
});

export const layer = Layer.effect(VcsStatusBroadcaster, make);
