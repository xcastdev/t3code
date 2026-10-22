import {
  WS_METHODS,
  ThreadHistoryRpcError,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as History from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  type AtomCommand,
  squashAtomCommandFailure,
  followStreamInEnvironment,
} from "./runtime.ts";
import type {
  HistoryOperationPersistence,
  HistoryOperationRecord,
  HistoryOperationTarget,
} from "./threadHistoryStorage.ts";

export interface HistorySelection {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly archiveId: string;
  readonly connectionEpoch: string;
}

export function captureHistorySelection(selection: HistorySelection): HistorySelection {
  return { ...selection };
}

export function historySelectionIsCurrent(selected: HistorySelection, current: HistorySelection) {
  return (
    selected.environmentId === current.environmentId &&
    selected.threadId === current.threadId &&
    selected.archiveId === current.archiveId &&
    selected.connectionEpoch === current.connectionEpoch
  );
}

export function prepareHistoryMutation<
  I extends typeof History.ThreadHistoryArchiveIdentity.Type,
>(options: {
  readonly selected: HistorySelection;
  readonly current: HistorySelection;
  readonly input: I;
}): { readonly environmentId: EnvironmentId; readonly input: I } | null {
  if (
    !historySelectionIsCurrent(options.selected, options.current) ||
    options.input.threadId !== options.selected.threadId ||
    options.input.archiveId !== options.selected.archiveId
  )
    return null;
  return {
    environmentId: options.selected.environmentId,
    input: options.input,
  };
}

export function historyArchiveAvailability(
  archive: typeof History.ThreadHistoryArchiveHeader.Type,
) {
  switch (archive.state) {
    case "preparing":
      return "preparing";
    case "ready":
    case "completed":
      return "available";
    case "executing":
      return "uncertain";
    case "releasing":
      return "releasing";
    case "released":
      return "released";
  }
}

export function prepareHistoryRecoveryMutation(options: {
  readonly selected: HistorySelection;
  readonly current: HistorySelection;
  readonly input: History.ThreadHistoryRecoverInput;
  readonly retainedOperation: History.ThreadHistoryRecoverInput | null;
  readonly uncertain: boolean;
}) {
  if (
    options.uncertain &&
    (options.retainedOperation === null || options.retainedOperation.mode !== options.input.mode)
  )
    return null;
  return prepareHistoryMutation({
    selected: options.selected,
    current: options.current,
    input: options.uncertain ? options.retainedOperation! : options.input,
  });
}

export function prepareHistoryFileRetry(options: {
  readonly selected: HistorySelection;
  readonly current: HistorySelection;
  readonly retainedOperation: typeof History.ThreadHistoryRestoreFilesInput.Type | null;
  readonly status: typeof History.ThreadHistoryFileRestoreStatusResult.Type | null;
}) {
  if (
    options.retainedOperation === null ||
    options.status === null ||
    options.status.threadId !== options.selected.threadId ||
    !["not-started", "preparing", "ready"].includes(options.status.state)
  )
    return null;
  return prepareHistoryMutation({
    selected: options.selected,
    current: options.current,
    input: options.retainedOperation,
  });
}

export function historyFileOutcomeIsUncertain(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return true;
  if ("_tag" in error && error._tag === "EnvironmentAuthorizationError") return false;
  if (
    "reason" in error &&
    typeof error.reason === "string" &&
    ["forbidden", "shared-workspace", "busy", "invalid-target"].includes(error.reason)
  )
    return false;
  return true;
}

export type HistoryMutationState = {
  readonly pending: number;
  readonly filesUncertain: boolean;
  readonly fileOperation: typeof History.ThreadHistoryRestoreFilesInput.Type | null;
  readonly recoveryOperation: History.ThreadHistoryRecoverInput | null;
  readonly recoveryUncertain: boolean;
  readonly hydration: "unloaded" | "loading" | "ready" | "failed";
  readonly fileConnectionEpoch: string | null;
  readonly recoveryConnectionEpoch: string | null;
};

class HistoryOperationStorageError extends Error {
  readonly _tag = "HistoryOperationStorageError";
  constructor() {
    super(
      "The original recovery request could not be loaded or saved on this device. Check local storage before trying again.",
    );
  }
}

export function createThreadHistoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: { readonly operationPersistence?: HistoryOperationPersistence } = {},
) {
  const epochs = new WeakMap<object, string>();
  let nextEpoch = 0;
  const connection = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        followStreamInEnvironment(
          environmentId,
          Stream.unwrap(
            Effect.map(EnvironmentSupervisor, (supervisor) =>
              SubscriptionRef.changes(supervisor.state).pipe(
                Stream.zipLatest(SubscriptionRef.changes(supervisor.session)),
                Stream.map(([state, session]) => {
                  if (state.phase !== "connected" || Option.isNone(session))
                    return { connected: false, epoch: null };
                  let epoch = epochs.get(session.value);
                  if (epoch === undefined) {
                    epoch = String(++nextEpoch);
                    epochs.set(session.value, epoch);
                  }
                  return { connected: true, epoch };
                }),
              ),
            ),
          ),
        ),
      )
      .pipe(Atom.setIdleTTL(0)),
  );
  const revisions = Atom.family((_key: string) => Atom.make(0).pipe(Atom.keepAlive));
  const signal = (target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }) =>
    revisions(JSON.stringify([target.environmentId, target.threadId]));
  const refresh = (
    registry: AtomRegistry.AtomRegistry,
    target: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    },
  ) => registry.update(signal(target), (revision) => revision + 1);
  const refreshTrigger = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId };
  }) =>
    signal({
      environmentId: target.environmentId,
      threadId: target.input.threadId,
    });
  const onSettled = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly threadId: ThreadId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      refresh(registry, {
        environmentId: target.environmentId,
        threadId: target.input.threadId,
      }),
    );
  const mutationStates = Atom.family((_key: string) =>
    Atom.make<HistoryMutationState>({
      pending: 0,
      filesUncertain: false,
      fileOperation: null,
      recoveryOperation: null,
      recoveryUncertain: false,
      hydration: "unloaded",
      fileConnectionEpoch: null,
      recoveryConnectionEpoch: null,
    }).pipe(Atom.keepAlive),
  );
  const mutationState = (target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly archiveId: string;
  }) => mutationStates(JSON.stringify([target.environmentId, target.threadId, target.archiveId]));
  const loads = new WeakMap<AtomRegistry.AtomRegistry, Map<string, Promise<boolean>>>();
  const hydrate = (
    registry: AtomRegistry.AtomRegistry,
    target: HistoryOperationTarget,
  ): Promise<boolean> => {
    const state = mutationState(target);
    if (registry.get(state).hydration === "ready") return Promise.resolve(true);
    let pending = loads.get(registry);
    if (pending === undefined) {
      pending = new Map();
      loads.set(registry, pending);
    }
    const key = JSON.stringify([target.environmentId, target.threadId, target.archiveId]);
    const existing = pending.get(key);
    if (existing !== undefined) return existing;
    registry.update(state, (value) => ({
      ...value,
      hydration: "loading" as const,
    }));
    const loading = (async () => {
      try {
        if (options.operationPersistence === undefined)
          throw new Error("History operation storage is unavailable.");
        const retained = await options.operationPersistence.load(target);
        registry.update(state, (value) => ({
          ...value,
          hydration: "ready" as const,
          fileOperation: retained.file?.input ?? null,
          fileConnectionEpoch: retained.file?.connectionEpoch ?? null,
          filesUncertain: retained.file !== null,
          recoveryOperation: retained.recovery?.input ?? null,
          recoveryConnectionEpoch: retained.recovery?.connectionEpoch ?? null,
          recoveryUncertain: retained.recovery !== null,
        }));
        return true;
      } catch {
        registry.update(state, (value) => ({
          ...value,
          hydration: "failed" as const,
        }));
        return false;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, loading);
    return loading;
  };
  const retainedFrom = (value: HistoryMutationState): HistoryOperationRecord => ({
    file:
      value.fileOperation === null
        ? null
        : {
            input: value.fileOperation,
            connectionEpoch: value.fileConnectionEpoch ?? "",
          },
    recovery:
      value.recoveryOperation === null
        ? null
        : {
            input: value.recoveryOperation,
            connectionEpoch: value.recoveryConnectionEpoch ?? "",
          },
  });
  const storageFailure = <A>() =>
    AsyncResult.failure<A, HistoryOperationStorageError>(
      Cause.fail(new HistoryOperationStorageError()),
    );
  const connectionEpochFor = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    new Promise<string | null>((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      unsubscribe = registry.subscribe(
        connection(environmentId),
        (result) => {
          if (result._tag === "Initial") return;
          settled = true;
          unsubscribe();
          resolve(result._tag === "Success" && result.value.connected ? result.value.epoch : null);
        },
        { immediate: true },
      );
      if (settled) unsubscribe();
    });
  const tracked = <I extends typeof History.ThreadHistoryArchiveIdentity.Type, A, F>(
    command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, F>,
    fileInput?: (input: I) => typeof History.ThreadHistoryRestoreFilesInput.Type,
    recoveryInput?: (input: I) => History.ThreadHistoryRecoverInput,
    blockUncertain = false,
  ) => ({
    run: async (
      registry: AtomRegistry.AtomRegistry,
      target: { readonly environmentId: EnvironmentId; readonly input: I },
    ) => {
      const scope = {
        environmentId: target.environmentId,
        ...target.input,
      };
      if (!(await hydrate(registry, scope))) return storageFailure<A>();
      const state = mutationState(scope);
      const current = registry.get(state);
      const nextFile = fileInput?.(target.input);
      const sameFile =
        nextFile !== undefined &&
        current.fileOperation !== null &&
        nextFile.commandId === current.fileOperation.commandId &&
        nextFile.checkpointId === current.fileOperation.checkpointId;
      const nextRecovery = recoveryInput?.(target.input);
      const retainedRecovery = current.recoveryOperation;
      const sameRecovery =
        nextRecovery !== undefined &&
        retainedRecovery !== null &&
        nextRecovery.commandId === retainedRecovery.commandId &&
        nextRecovery.messageId === retainedRecovery.messageId &&
        nextRecovery.mode === retainedRecovery.mode &&
        nextRecovery.targetThreadId === retainedRecovery.targetThreadId;
      if (
        current.pending > 0 ||
        (nextFile !== undefined && current.filesUncertain && !sameFile) ||
        (nextRecovery !== undefined && current.recoveryUncertain && !sameRecovery) ||
        (blockUncertain && (current.filesUncertain || current.recoveryUncertain))
      ) {
        return AsyncResult.failure<A, F | ThreadHistoryRpcError>(
          Cause.fail(
            new ThreadHistoryRpcError({
              reason: current.pending === 0 ? "reconciliation-required" : "busy",
            }),
          ),
        );
      }
      registry.update(state, (value) => ({
        ...value,
        pending: value.pending + 1,
      }));
      try {
        if (fileInput !== undefined || nextRecovery !== undefined) {
          const epoch = await connectionEpochFor(registry, target.environmentId);
          if (epoch === null) {
            return AsyncResult.failure<A, ThreadHistoryRpcError>(
              Cause.fail(new ThreadHistoryRpcError({ reason: "unavailable" })),
            );
          }
          registry.update(state, (value) => ({
            ...value,
            ...(fileInput === undefined
              ? {}
              : {
                  fileOperation: fileInput(target.input),
                  fileConnectionEpoch: value.fileConnectionEpoch ?? epoch,
                }),
            ...(nextRecovery === undefined
              ? {}
              : {
                  recoveryOperation: nextRecovery,
                  recoveryConnectionEpoch: value.recoveryConnectionEpoch ?? epoch,
                }),
          }));
          // The identifiers must survive a crash before the transport can apply a side effect.
          await options.operationPersistence!.save(scope, retainedFrom(registry.get(state)));
          registry.update(state, (value) => ({
            ...value,
            filesUncertain: fileInput !== undefined || value.filesUncertain,
            recoveryUncertain: nextRecovery !== undefined || value.recoveryUncertain,
          }));
        }
        const result = await command.run(registry, target);
        const definiteRefusal =
          result._tag === "Failure" &&
          !historyFileOutcomeIsUncertain(squashAtomCommandFailure(result));
        const resolveFile =
          fileInput !== undefined &&
          (result._tag === "Success" || (definiteRefusal && !current.filesUncertain));
        const resolveRecovery =
          nextRecovery !== undefined &&
          (result._tag === "Success" || (definiteRefusal && !current.recoveryUncertain));
        if (resolveFile || resolveRecovery) {
          const resolved = {
            ...registry.get(state),
            ...(resolveFile
              ? {
                  fileOperation: null,
                  fileConnectionEpoch: null,
                  filesUncertain: false,
                }
              : {}),
            ...(resolveRecovery
              ? {
                  recoveryOperation: null,
                  recoveryConnectionEpoch: null,
                  recoveryUncertain: false,
                }
              : {}),
          };
          await options.operationPersistence!.save(scope, retainedFrom(resolved));
          registry.set(state, resolved);
        }
        return result;
      } catch {
        return storageFailure<A>();
      } finally {
        registry.update(state, (value) => ({
          ...value,
          pending: value.pending - 1,
        }));
      }
    },
  });
  const recover = createEnvironmentRpcCommand(runtime, {
    label: "environment-command:thread-history:recover",
    tag: WS_METHODS.threadHistoryRecover,
    onSettled,
  });
  const restoreFiles = createEnvironmentRpcCommand(runtime, {
    label: "environment-command:thread-history:restore-files",
    tag: WS_METHODS.threadHistoryRestoreFiles,
    onSettled,
  });
  const release = createEnvironmentRpcCommand(runtime, {
    label: "environment-command:thread-history:release",
    tag: WS_METHODS.threadHistoryRelease,
    onSettled,
  });
  const reconcile = createEnvironmentRpcCommand(runtime, {
    label: "environment-command:thread-history:reconcile",
    tag: WS_METHODS.threadHistoryReconcile,
    onSettled,
  });
  const inspectFileRestore = createEnvironmentRpcCommand(runtime, {
    label: "environment-command:thread-history:inspect-file-restore",
    tag: WS_METHODS.threadHistoryFileRestoreStatus,
  });
  return {
    connection,
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-history:list",
      tag: WS_METHODS.threadHistoryList,
      idleTtlMs: 0,
      refreshTrigger,
    }),
    inspectFileRestore: {
      ...inspectFileRestore,
      run: async (
        registry: AtomRegistry.AtomRegistry,
        target: Parameters<typeof inspectFileRestore.run>[1],
      ) => {
        const scope = { environmentId: target.environmentId, ...target.input };
        const state = mutationState(scope);
        if (registry.get(state).pending > 0)
          return AsyncResult.failure(Cause.fail(new ThreadHistoryRpcError({ reason: "busy" })));
        // Both retained lanes share one durable record, so inspection owns the mutation fence too.
        registry.update(state, (value) => ({
          ...value,
          pending: value.pending + 1,
        }));
        try {
          if (!(await hydrate(registry, scope)))
            return storageFailure<typeof History.ThreadHistoryFileRestoreStatusResult.Type>();
          const result = await inspectFileRestore.run(registry, target);
          const current = registry.get(state);
          if (
            result._tag === "Success" &&
            result.value.state === "completed" &&
            current.fileOperation?.commandId === target.input.commandId &&
            current.fileOperation.checkpointId === target.input.checkpointId
          ) {
            const resolved = {
              ...current,
              fileOperation: null,
              fileConnectionEpoch: null,
              filesUncertain: false,
            };
            await options.operationPersistence!.save(scope, retainedFrom(resolved));
            registry.set(state, resolved);
          }
          return result;
        } catch {
          return storageFailure<typeof History.ThreadHistoryFileRestoreStatusResult.Type>();
        } finally {
          registry.update(state, (value) => ({
            ...value,
            pending: value.pending - 1,
          }));
        }
      },
    },
    fileRestoreStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-history:file-restore-status",
      tag: WS_METHODS.threadHistoryFileRestoreStatus,
      idleTtlMs: 0,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-history:detail",
      tag: WS_METHODS.threadHistoryDetail,
      idleTtlMs: 0,
      refreshTrigger,
    }),
    recover: { ...recover, ...tracked(recover, undefined, (input) => input) },
    restoreFiles: {
      ...restoreFiles,
      ...tracked(restoreFiles, (input) => input),
    },
    release: { ...release, ...tracked(release, undefined, undefined, true) },
    reconcile: { ...reconcile, ...tracked(reconcile) },
    mutationState,
    hydrate,
    refresh,
  };
}
