import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { NetworkStatus } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  CheckpointId,
  CommandId,
  MessageId,
  ThreadHistoryRpcError,
  WS_METHODS,
  type AuthSessionState,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import {
  captureHistorySelection,
  historySelectionIsCurrent,
  prepareHistoryMutation,
  historyArchiveAvailability,
  historyFileOutcomeIsUncertain,
  createThreadHistoryEnvironmentAtoms,
  prepareHistoryRecoveryMutation,
  prepareHistoryFileRetry,
} from "./threadHistory.ts";
import { makeHistoryOperationPersistence } from "./threadHistoryStorage.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.initial()),
);

const selection = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  archiveId: "archive",
  connectionEpoch: "connection-1",
};

it("fences reviewed history actions after any scope or connection replacement", () => {
  const selected = captureHistorySelection(selection);
  const input = { threadId: selected.threadId, archiveId: selected.archiveId };
  expect(prepareHistoryMutation({ selected, current: selection, input })).toEqual({
    environmentId: selection.environmentId,
    input,
  });
  for (const current of [
    { ...selection, environmentId: EnvironmentId.make("other") },
    { ...selection, threadId: ThreadId.make("other") },
    { ...selection, archiveId: "other" },
    { ...selection, connectionEpoch: "connection-2" },
  ]) {
    expect(historySelectionIsCurrent(selected, current)).toBe(false);
    expect(prepareHistoryMutation({ selected, current, input })).toBeNull();
  }
  expect(
    prepareHistoryMutation({
      selected,
      current: selection,
      input: { ...input, archiveId: "foreign" },
    }),
  ).toBeNull();
  expect(
    prepareHistoryMutation({
      selected,
      current: selection,
      input: { ...input, threadId: ThreadId.make("foreign") },
    }),
  ).toBeNull();
});

it("keeps interrupted operations uncertain and preparation unavailable", () => {
  const header = {
    archive_id: "archive",
    thread_id: selection.threadId,
    reason: "rollback",
    created_at: "2026-10-21",
    operation_json: null,
  };
  expect(historyArchiveAvailability({ ...header, state: "preparing" })).toBe("preparing");
  expect(historyArchiveAvailability({ ...header, state: "executing" })).toBe("uncertain");
  expect(historyArchiveAvailability({ ...header, state: "ready" })).toBe("available");
  expect(historyArchiveAvailability({ ...header, state: "completed" })).toBe("available");
  expect(historyArchiveAvailability({ ...header, state: "releasing" })).toBe("releasing");
  expect(historyArchiveAvailability({ ...header, state: "released" })).toBe("released");
});

it("distinguishes known refusals from uncertain file effects", () => {
  expect(historyFileOutcomeIsUncertain({ _tag: "EnvironmentAuthorizationError" })).toBe(false);
  for (const reason of ["forbidden", "shared-workspace", "busy", "invalid-target"])
    expect(historyFileOutcomeIsUncertain({ reason })).toBe(false);
  for (const error of [
    new Error("disconnected"),
    { reason: "execution" },
    { reason: "reconciliation-required" },
  ])
    expect(historyFileOutcomeIsUncertain(error)).toBe(true);
});

it.effect(
  "tracks file effects until exact authoritative inspection and checks grants before transport",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environmentId = selection.environmentId;
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const inspectionSaving = yield* Deferred.make<void>();
        const finishInspectionSave = Promise.withResolvers<void>();
        let pauseRemoval = false;
        let writes = 0;
        let recoveries = 0;
        let completeOriginalRetry = false;
        let fileStatusState: "completed" | "not-started" = "completed";
        const storage = new Map<string, string>();
        const operationPersistence = makeHistoryOperationPersistence({
          clientSessionId: "test-client",
          storage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => {
              storage.set(key, value);
            },
            removeItem: async (key) => {
              if (pauseRemoval) {
                Deferred.doneUnsafe(inspectionSaving, Exit.void);
                await finishInspectionSave.promise;
              }
              storage.delete(key);
            },
          },
        });
        const session: RpcSession = {
          client: {
            [WS_METHODS.threadHistoryRecover]: (input: { threadId: ThreadId; archiveId: string }) =>
              Effect.suspend(() => {
                recoveries++;
                expect(storage.size).toBe(1);
                return recoveries === 1
                  ? Effect.fail(new ThreadHistoryRpcError({ reason: "execution" }))
                  : Effect.succeed({
                      threadId: input.threadId,
                      archiveId: input.archiveId,
                      continuity: "context-only" as const,
                      partial: true,
                      filesRestored: false as const,
                    });
              }),
            [WS_METHODS.threadHistoryRestoreFiles]: () =>
              Effect.gen(function* () {
                writes++;
                expect(storage.size).toBe(1);
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(finish);
                if (completeOriginalRetry)
                  return {
                    threadId: selection.threadId,
                    archiveId: "operation",
                    state: "completed" as const,
                  };
                return yield* new ThreadHistoryRpcError({
                  reason: "execution",
                });
              }),
            [WS_METHODS.threadHistoryFileRestoreStatus]: (input: { threadId: ThreadId }) =>
              Effect.succeed({
                threadId: input.threadId,
                archiveId: "operation",
                state: fileStatusState,
              }),
          } as unknown as RpcSession["client"],
          initialConfig: Effect.die("unused fixture config"),
          subscribeServerConfig: () => Stream.never,
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const supervisor = EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "History",
            httpBaseUrl: "https://history.test",
            wsBaseUrl: "wss://history.test",
          }),
          session: yield* SubscriptionRef.make(Option.some(session)),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          }),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const run: EnvironmentRegistry["Service"]["run"] = (_id, program) =>
          Effect.provideService(program, EnvironmentSupervisor, supervisor);
        const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor);
        const environments = EnvironmentRegistry.of({
          entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map(),
          ),
          networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
          start: Effect.void,
          register: () => Effect.die("unused register"),
          registerPlatform: () => Effect.void,
          reconcilePlatform: () => Effect.void,
          remove: () => Effect.void,
          removeRoute: () => Effect.void,
          reorderRoutes: () => Effect.void,
          removeRelayEnvironments: () => Effect.void,
          retryNow: () => Effect.void,
          setEnabled: () => Effect.void,
          setCompatibility: () => Effect.void,
          state: () => SubscriptionRef.get(supervisor.state),
          stateChanges: () => SubscriptionRef.changes(supervisor.state),
          run,
          followStream,
          runStream: followStream,
        });
        const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environments));
        let atoms = createThreadHistoryEnvironmentAtoms(runtime, {
          operationPersistence,
        });
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const auth = {
          authenticated: true as const,
          auth: {
            policy: "remote-reachable" as const,
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: [AuthOrchestrationOperateScope],
          permissions: [AuthOrchestrationOperateScope],
        };
        registry.set(
          sessions(environmentId),
          AsyncResult.success({ ...auth, scopes: [], permissions: [] }),
        );
        const target = {
          environmentId,
          input: {
            threadId: selection.threadId,
            archiveId: selection.archiveId,
            commandId: CommandId.make("file-command"),
            checkpointId: CheckpointId.make("checkpoint"),
          },
        };
        const denied = yield* Effect.promise(() => atoms.restoreFiles.run(registry, target));
        expect(denied._tag).toBe("Failure");
        expect(writes).toBe(0);
        expect(registry.get(atoms.mutationState(selection)).filesUncertain).toBe(false);
        registry.set(sessions(environmentId), AsyncResult.success(auth));
        for (const command of [atoms.recover, atoms.restoreFiles, atoms.release, atoms.reconcile])
          expect(registry.get(command.permissionAtom(environmentId))).toBe(true);
        const pending = atoms.restoreFiles.run(registry, target);
        yield* Deferred.await(started);
        expect(registry.get(atoms.mutationState(selection))).toMatchObject({
          pending: 1,
          fileOperation: target.input,
        });
        const replacement = {
          ...target,
          input: {
            ...target.input,
            commandId: CommandId.make("replacement-command"),
            checkpointId: CheckpointId.make("replacement-checkpoint"),
          },
        };
        const concurrent = atoms.restoreFiles.run(registry, replacement);
        yield* Deferred.succeed(finish, undefined);
        const concurrentResult = yield* Effect.promise(() => concurrent);
        expect(concurrentResult._tag).toBe("Failure");
        expect(writes).toBe(1);
        expect(registry.get(atoms.mutationState(selection)).fileOperation).toEqual(target.input);
        expect((yield* Effect.promise(() => pending))._tag).toBe("Failure");
        expect(registry.get(atoms.mutationState(selection))).toMatchObject({
          pending: 0,
          filesUncertain: true,
          fileOperation: target.input,
        });
        atoms = createThreadHistoryEnvironmentAtoms(runtime, {
          operationPersistence,
        });
        expect(registry.get(atoms.mutationState(selection)).hydration).toBe("unloaded");
        expect(yield* Effect.promise(() => atoms.hydrate(registry, selection))).toBe(true);
        expect(registry.get(atoms.mutationState(selection))).toMatchObject({
          hydration: "ready",
          filesUncertain: true,
          fileOperation: target.input,
        });
        registry.set(
          sessions(environmentId),
          AsyncResult.success({ ...auth, scopes: [], permissions: [] }),
        );
        const replacementDenied = yield* Effect.promise(() =>
          atoms.restoreFiles.run(registry, replacement),
        );
        expect(replacementDenied._tag).toBe("Failure");
        expect(writes).toBe(1);
        expect(registry.get(atoms.mutationState(selection))).toMatchObject({
          pending: 0,
          filesUncertain: true,
          fileOperation: target.input,
        });
        yield* Effect.promise(() => atoms.inspectFileRestore.run(registry, replacement));
        expect(registry.get(atoms.mutationState(selection)).filesUncertain).toBe(true);
        registry.set(sessions(environmentId), AsyncResult.success(auth));
        pauseRemoval = true;
        const inspection = atoms.inspectFileRestore.run(registry, target);
        yield* Deferred.await(inspectionSaving);
        const inspectionPending = registry.get(atoms.mutationState(selection)).pending;
        const overlappingRecovery = yield* Effect.promise(() =>
          atoms.recover.run(registry, {
            environmentId,
            input: {
              threadId: selection.threadId,
              archiveId: selection.archiveId,
              commandId: CommandId.make("overlapping-command"),
              messageId: MessageId.make("overlapping-message"),
              mode: "fork",
              targetThreadId: ThreadId.make("overlapping-fork"),
            },
          }),
        );
        finishInspectionSave.resolve();
        const inspected = yield* Effect.promise(() => inspection);
        pauseRemoval = false;
        expect(inspectionPending).toBe(1);
        expect(overlappingRecovery._tag).toBe("Failure");
        expect(recoveries).toBe(0);
        expect(registry.get(atoms.mutationState(selection)).pending).toBe(0);
        expect(inspected._tag).toBe("Success");
        expect(registry.get(atoms.mutationState(selection)).filesUncertain).toBe(false);
        expect(storage.size).toBe(0);
        registry.set(sessions(environmentId), AsyncResult.success(auth));
        const recovery = {
          environmentId,
          input: {
            threadId: selection.threadId,
            archiveId: selection.archiveId,
            commandId: CommandId.make("recover-command"),
            messageId: MessageId.make("recover-message"),
            mode: "fork" as const,
            targetThreadId: ThreadId.make("exact-fork-target"),
          },
        };
        expect((yield* Effect.promise(() => atoms.recover.run(registry, recovery)))._tag).toBe(
          "Failure",
        );
        const secondFile = {
          ...target,
          input: {
            ...target.input,
            commandId: CommandId.make("second-file-command"),
          },
        };
        expect(
          (yield* Effect.promise(() => atoms.restoreFiles.run(registry, secondFile)))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.promise(() => atoms.inspectFileRestore.run(registry, secondFile)))._tag,
        ).toBe("Success");
        expect(registry.get(atoms.mutationState(selection))).toMatchObject({
          pending: 0,
          filesUncertain: false,
          recoveryUncertain: true,
          recoveryOperation: recovery.input,
        });
        const retainedOtherLane = yield* Effect.promise(() => operationPersistence.load(selection));
        expect(retainedOtherLane.file).toBeNull();
        expect(retainedOtherLane.recovery?.input).toEqual(recovery.input);
        atoms = createThreadHistoryEnvironmentAtoms(runtime, {
          operationPersistence,
        });
        yield* Effect.promise(() => atoms.hydrate(registry, selection));
        expect(registry.get(atoms.mutationState(selection))).toMatchObject({
          recoveryUncertain: true,
          recoveryOperation: recovery.input,
        });
        const replacementRecovery = {
          ...recovery,
          input: {
            ...recovery.input,
            commandId: CommandId.make("other-command"),
            messageId: MessageId.make("other-message"),
            targetThreadId: ThreadId.make("other-fork"),
          },
        };
        expect(
          prepareHistoryRecoveryMutation({
            selected: selection,
            current: selection,
            input: replacementRecovery.input,
            retainedOperation: recovery.input,
            uncertain: true,
          }),
        ).toEqual(recovery);
        expect(
          (yield* Effect.promise(() => atoms.recover.run(registry, replacementRecovery)))._tag,
        ).toBe("Failure");
        expect(recoveries).toBe(1);
        registry.set(
          sessions(environmentId),
          AsyncResult.success({ ...auth, scopes: [], permissions: [] }),
        );
        expect((yield* Effect.promise(() => atoms.recover.run(registry, recovery)))._tag).toBe(
          "Failure",
        );
        expect(registry.get(atoms.mutationState(selection)).recoveryOperation).toEqual(
          recovery.input,
        );
        expect(recoveries).toBe(1);
        registry.set(sessions(environmentId), AsyncResult.success(auth));
        expect((yield* Effect.promise(() => atoms.recover.run(registry, recovery)))._tag).toBe(
          "Success",
        );
        expect(recoveries).toBe(2);
        const failedPersistence = createThreadHistoryEnvironmentAtoms(runtime, {
          operationPersistence: {
            load: async () => ({ file: null, recovery: null }),
            save: async () => {
              throw new Error("storage unavailable");
            },
          },
        });
        expect(
          (yield* Effect.promise(() => failedPersistence.restoreFiles.run(registry, target)))._tag,
        ).toBe("Failure");
        expect(writes).toBe(2);
        const malformedPersistence = createThreadHistoryEnvironmentAtoms(runtime, {
          operationPersistence: {
            load: async () => {
              throw new Error("corrupt retained request");
            },
            save: async () => {
              throw new Error("must not write");
            },
          },
        });
        expect(
          (yield* Effect.promise(() => malformedPersistence.recover.run(registry, recovery)))._tag,
        ).toBe("Failure");
        expect(registry.get(malformedPersistence.mutationState(selection)).hydration).toBe(
          "failed",
        );
        expect(recoveries).toBe(2);
        expect(registry.get(atoms.mutationState(selection))).toMatchObject({
          recoveryUncertain: false,
          recoveryOperation: null,
        });
        expect(storage.size).toBe(0);
        const lostBeforePreparation = {
          ...target,
          input: {
            ...target.input,
            commandId: CommandId.make("lost-before-server-preparation"),
          },
        };
        expect(
          (yield* Effect.promise(() => atoms.restoreFiles.run(registry, lostBeforePreparation)))
            ._tag,
        ).toBe("Failure");
        atoms = createThreadHistoryEnvironmentAtoms(runtime, {
          operationPersistence,
        });
        yield* Effect.promise(() => atoms.hydrate(registry, selection));
        fileStatusState = "not-started";
        const missingStatus = yield* Effect.promise(() =>
          atoms.inspectFileRestore.run(registry, lostBeforePreparation),
        );
        if (missingStatus._tag !== "Success")
          return yield* Effect.die(
            "Missing-operation inspection must return its authoritative status.",
          );
        expect(
          prepareHistoryFileRetry({
            selected: selection,
            current: selection,
            retainedOperation: lostBeforePreparation.input,
            status: missingStatus.value,
          }),
        ).toEqual(lostBeforePreparation);
        expect(registry.get(atoms.mutationState(selection))).toMatchObject({
          filesUncertain: true,
          fileOperation: lostBeforePreparation.input,
        });
        expect(storage.size).toBe(1);
        expect(
          (yield* Effect.promise(() => atoms.restoreFiles.run(registry, replacement)))._tag,
        ).toBe("Failure");
        registry.set(
          sessions(environmentId),
          AsyncResult.success({ ...auth, scopes: [], permissions: [] }),
        );
        expect(
          (yield* Effect.promise(() => atoms.restoreFiles.run(registry, lostBeforePreparation)))
            ._tag,
        ).toBe("Failure");
        expect(registry.get(atoms.mutationState(selection)).fileOperation).toEqual(
          lostBeforePreparation.input,
        );
        expect(writes).toBe(3);
        registry.set(sessions(environmentId), AsyncResult.success(auth));
        completeOriginalRetry = true;
        expect(
          (yield* Effect.promise(() => atoms.restoreFiles.run(registry, lostBeforePreparation)))
            ._tag,
        ).toBe("Success");
        expect(writes).toBe(4);
        expect(storage.size).toBe(0);
        expect(registry.get(atoms.mutationState(selection))).toMatchObject({
          filesUncertain: false,
          fileOperation: null,
          pending: 0,
        });
      }),
    ),
);
