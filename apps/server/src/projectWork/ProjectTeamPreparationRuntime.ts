import {
  canonicalProjectWorkPayload,
  resolveProviderInstanceEnabled,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PiDriverConfiguration } from "../provider/pi/PiManagedRuntime.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchJournalError,
  ProjectTeamWorkspaceReceipt,
  ProjectTeamWorkspaceEvidence,
  type ProjectTeamDispatchSnapshot,
  type ProjectTeamDispatchStageReceipt,
} from "./ProjectTeamDispatchJournal.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";
import { makeProjectTeamThreads } from "./ProjectTeamThreads.ts";
import { makeProjectTeamWorkspace } from "./ProjectTeamWorkspace.ts";

interface CurrentLoan {
  readonly modelSelection: ModelSelection;
  readonly assertCurrent: (
    expected: ProjectTeamDispatchSnapshot,
  ) => Effect.Effect<void, ProjectTeamDispatchJournalError, Scope.Scope>;
  readonly assertResources: Effect.Effect<void, ProjectTeamDispatchJournalError, Scope.Scope>;
}
interface Options {
  readonly environmentId: string;
  readonly maximumEnvironmentModelCalls: number;
  readonly launchPolicy: { readonly memoryBytes: number; readonly runtimeSeconds: number };
  readonly protectedRoots: readonly string[];
  readonly withCurrent: <A, E, R>(
    snapshot: ProjectTeamDispatchSnapshot,
    run: (loan: CurrentLoan) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProjectTeamDispatchJournalError, R | Scope.Scope>;
}
class PreparationLoan extends Context.Service<PreparationLoan, { readonly token: object }>()(
  "t3/projectWork/ProjectTeamPreparationRuntime/PreparationLoan",
) {}
export class ProjectTeamPreparationRuntimeError extends Schema.TaggedError<ProjectTeamPreparationRuntimeError>()(
  "ProjectTeamPreparationRuntimeError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
const isPreparationError = Schema.is(ProjectTeamPreparationRuntimeError);
const denied = (reason: string) => new ProjectTeamPreparationRuntimeError({ reason });
const journalDenied = (reason: string) => new ProjectTeamDispatchJournalError({ reason });
const same = (left: unknown, right: unknown) =>
  canonicalProjectWorkPayload(left) === canonicalProjectWorkPayload(right);
const freeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const copy = <A>(value: A) => freeze(structuredClone(value));
const decodeConfiguration = Schema.decodeUnknownEffect(PiDriverConfiguration);
const decodeActualConfiguration = Schema.decodeUnknownEffect(
  Schema.Struct({ enabled: Schema.Boolean, configuration: PiDriverConfiguration }),
);
const decodeWorkspaceEvidence = Schema.decodeUnknownEffect(ProjectTeamWorkspaceEvidence, {
  onExcessProperty: "error",
});
const decodeSetupEvidence = Schema.decodeUnknownEffect(
  Schema.Struct({ workspace: ProjectTeamWorkspaceReceipt, setup: Schema.JsonObject }),
  { onExcessProperty: "error" },
);
const decodeJsonObject = Schema.decodeUnknownEffect(Schema.JsonObject);

/** Prepares the original physical assignment. Root retains session, accounting and recovery ownership. */
export const makeProjectTeamPreparationRuntime = Effect.fn("makeProjectTeamPreparationRuntime")(
  function* (supplied: Options) {
    const options = Object.freeze({
      ...supplied,
      launchPolicy: copy(supplied.launchPolicy),
      protectedRoots: copy(supplied.protectedRoots),
    });
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* ServerSettingsService;
    const pi = yield* ProjectTeamPiRuntime;
    const clock = yield* Clock.Clock;
    const captured = (yield* Effect.context<
      | Effect.Services<ReturnType<typeof makeProjectTeamWorkspace>>
      | Effect.Services<ReturnType<typeof makeProjectTeamThreads>>
    >()).pipe(Context.add(Clock.Clock, clock), Context.omit(Scope.Scope));
    const inspection = yield* makeProjectTeamDispatchJournal(options);
    const activeLoans = new WeakSet<object>();
    const serial = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();
    const prepare = Effect.fn("ProjectTeamPreparationRuntime.prepare")(
      function* (dispatchId: string) {
        const ambient = Context.getOption(yield* Effect.context<never>(), SqlClient.SqlClient);
        if (Option.isSome(ambient) && ambient.value !== sql)
          return yield* denied("Preparation belongs to another SQL client");
        const entry = yield* Effect.sync(() => {
          let entry = serial.get(dispatchId);
          if (!entry) {
            entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
            serial.set(dispatchId, entry);
          }
          entry.users++;
          return entry;
        });
        return yield* entry.semaphore
          .withPermits(1)(
            Effect.gen(function* () {
              const initial = copy(yield* inspection.inspect(dispatchId));
              if (
                !["reserved", "workspace-ready", "setup-complete"].includes(initial.fence.stage) ||
                initial.fence.claimGeneration > 1 ||
                (initial.fence.stage !== "reserved" && initial.fence.claimGeneration !== 1)
              )
                return yield* denied("Dispatch requires Root recovery or session execution");
              const transition = initial.intent.compiledClaim.transition;
              if (transition?.kind !== "claim")
                return yield* denied("Original compiled assignment is missing");
              let callbackOpen = true;
              let entered = false;
              return yield* options
                .withCurrent(initial, (suppliedLoan) =>
                  Effect.suspend(() => {
                    if (!callbackOpen || entered)
                      return Effect.fail(
                        denied("Original preparation callback ended or was replayed"),
                      );
                    entered = true;
                    const token = Object.freeze({});
                    const loan = Object.freeze({
                      modelSelection: copy(suppliedLoan.modelSelection),
                      assertCurrent: suppliedLoan.assertCurrent,
                      assertResources: suppliedLoan.assertResources,
                    });
                    activeLoans.add(token);
                    return pi
                      .withInstance(transition.binding.providerInstanceId, (instance) =>
                        Effect.gen(function* () {
                          const callbackScope = yield* Scope.Scope;
                          const callbackContext = yield* Effect.context<never>();
                          const callbackSql = Context.getOption(
                            callbackContext,
                            SqlClient.SqlClient,
                          );
                          if (Option.isSome(callbackSql) && callbackSql.value !== sql)
                            return yield* denied(
                              "Preparation callback belongs to another SQL client",
                            );
                          const ownerContext = captured.pipe(
                            Context.merge(callbackContext),
                            Context.add(SqlClient.SqlClient, sql),
                            Context.add(ServerSettingsService, settings),
                            Context.add(ProjectTeamPiRuntime, pi),
                            Context.add(Clock.Clock, clock),
                            Context.add(PreparationLoan, { token }),
                            Context.omit(Scope.Scope),
                          );
                          const resources = Effect.gen(function* () {
                            const ambientSql = Context.getOption(
                              yield* Effect.context<never>(),
                              SqlClient.SqlClient,
                            );
                            if (Option.isSome(ambientSql) && ambientSql.value !== sql)
                              return yield* journalDenied(
                                "Preparation resources belong to another SQL client",
                              );
                            const registered = yield* Effect.serviceOption(PreparationLoan);
                            if (
                              !callbackOpen ||
                              !activeLoans.has(token) ||
                              Option.isNone(registered) ||
                              registered.value.token !== token
                            )
                              return yield* journalDenied(
                                "Original preparation loan is no longer live",
                              );
                            yield* instance.assertCurrent;
                            yield* instance.assets.revalidate;
                            yield* loan.assertResources;
                            const current = yield* settings.getSettings;
                            const configured =
                              current.providerInstances[transition.binding.providerInstanceId];
                            if (
                              !current.projectWorkEnabled ||
                              !current.projectTeamExecutionEnabled ||
                              !configured ||
                              configured.driver !== "piAgent" ||
                              !resolveProviderInstanceEnabled(configured)
                            )
                              return yield* journalDenied(
                                "Current Pi execution is disabled or unavailable",
                              );
                            const actual = yield* decodeActualConfiguration(
                              instance.assets.instanceConfiguration,
                            );
                            if (
                              !actual.enabled ||
                              !same(
                                actual.configuration,
                                yield* decodeConfiguration(configured.config ?? {}),
                              ) ||
                              loan.modelSelection.instanceId !==
                                transition.binding.providerInstanceId ||
                              loan.modelSelection.model !== transition.binding.model
                            )
                              return yield* journalDenied(
                                "Current Pi configuration differs from its original runtime",
                              );
                            yield* instance.assertCurrent;
                          }).pipe(
                            Effect.mapError(() =>
                              journalDenied("Original preparation resources changed"),
                            ),
                          );
                          const current = Effect.fn("ProjectTeamPreparationRuntime.current")(
                            function* (snapshot: ProjectTeamDispatchSnapshot) {
                              if (!same(snapshot.intent, initial.intent))
                                return yield* journalDenied(
                                  "Original preparation assignment changed",
                                );
                              yield* resources;
                              yield* loan.assertCurrent(snapshot);
                              const retained = yield* inspection.inspect(
                                dispatchId,
                                snapshot.fence.claimGeneration > 0
                                  ? { requireClaim: true }
                                  : undefined,
                              );
                              if (!same(retained, snapshot))
                                return yield* journalDenied("Original preparation fence changed");
                              yield* loan.assertCurrent(snapshot);
                              yield* resources;
                            },
                            Effect.mapError(() =>
                              journalDenied("Original preparation fence could not be verified"),
                            ),
                            Effect.provideService(Scope.Scope, callbackScope),
                          );
                          // Workspace captures this callback context, including its private token.
                          const body = Effect.gen(function* () {
                            const workspaceService = yield* makeProjectTeamWorkspace({
                              ...options,
                              assertCurrent: current,
                            });
                            const verifyStage = Effect.fn(
                              "ProjectTeamPreparationRuntime.verifyStage",
                            )(
                              function* (
                                receipt: ProjectTeamDispatchStageReceipt,
                                snapshot: ProjectTeamDispatchSnapshot,
                              ) {
                                yield* current(snapshot);
                                const retained = yield* workspaceService.readWorkspace(snapshot);
                                if (!retained)
                                  return yield* journalDenied(
                                    "Original physical workspace receipt is missing",
                                  );
                                const evidence = yield* receipt.stage === "workspace-ready"
                                  ? decodeWorkspaceEvidence(receipt.evidence)
                                  : receipt.stage === "setup-complete"
                                    ? decodeSetupEvidence(receipt.evidence)
                                    : Effect.fail(
                                        journalDenied("Preparation cannot advance a session stage"),
                                      );
                                if (
                                  receipt.receiptId !==
                                    projectTeamDerivedRecordId(
                                      dispatchId,
                                      `stage:${receipt.stage}`,
                                    ) ||
                                  !same(evidence.workspace, retained)
                                )
                                  return yield* journalDenied(
                                    "Stage evidence differs from the original workspace",
                                  );
                                const setup =
                                  "setup" in evidence
                                    ? yield* workspaceService.readSetup(snapshot)
                                    : undefined;
                                if ("setup" in evidence && (!setup || !same(setup, evidence.setup)))
                                  return yield* journalDenied(
                                    "Stage evidence differs from original setup completion",
                                  );
                                yield* workspaceService.verifyRetained(
                                  snapshot,
                                  retained,
                                  setup ?? undefined,
                                );
                                yield* current(snapshot);
                              },
                              Effect.mapError(() =>
                                journalDenied("Original physical stage evidence changed"),
                              ),
                              Effect.provideService(Scope.Scope, callbackScope),
                            );
                            const journal = yield* makeProjectTeamDispatchJournal({
                              ...options,
                              verifyStage,
                              verifyStageFinal: verifyStage,
                              verifyClaimFinal: current,
                            });
                            const threads = yield* makeProjectTeamThreads({
                              assertCurrent: (snapshot, selected) =>
                                same(selected, loan.modelSelection)
                                  ? current(snapshot)
                                  : Effect.fail(journalDenied("Original thread selection changed")),
                            });
                            let snapshot = initial;
                            yield* current(snapshot);
                            const fresh = snapshot.fence.claimGeneration === 0;
                            if (fresh) {
                              snapshot = copy(yield* journal.claimEffect(snapshot.fence));
                            }
                            yield* current(snapshot);
                            let workspace = yield* workspaceService.readWorkspace(snapshot);
                            if (snapshot.fence.stage === "reserved") {
                              if (!fresh && !workspace)
                                return yield* denied(
                                  "Claimed dispatch has no original physical receipt; Root recovery is required",
                                );
                              const advanced = yield* workspaceService.withWorkspace(
                                snapshot,
                                (evidence) =>
                                  Effect.gen(function* () {
                                    workspace = evidence.workspace;
                                    yield* current(snapshot);
                                    return yield* journal.advanceStage(snapshot.fence, {
                                      receiptId: projectTeamDerivedRecordId(
                                        dispatchId,
                                        "stage:workspace-ready",
                                      ),
                                      stage: "workspace-ready",
                                      evidence: yield* decodeJsonObject(evidence),
                                    });
                                  }),
                              );
                              snapshot = copy({ fence: advanced.fence, intent: advanced.intent });
                            }
                            if (!workspace)
                              return yield* denied(
                                "Original physical workspace receipt is missing",
                              );
                            const history = yield* journal.readStageReceipts(dispatchId);
                            const workspaceStage = history.find(
                              (receipt) => receipt.stage === "workspace-ready",
                            );
                            if (
                              !workspaceStage ||
                              workspaceStage.receiptId !==
                                projectTeamDerivedRecordId(dispatchId, "stage:workspace-ready") ||
                              !same(workspaceStage.evidence, { workspace })
                            )
                              return yield* denied("Original workspace stage history changed");
                            yield* current(snapshot);
                            yield* workspaceService.verifyRetained(snapshot, workspace);
                            let setup;
                            if (snapshot.fence.stage === "workspace-ready") {
                              setup = yield* workspaceService.setup(snapshot, workspace);
                              yield* current(snapshot);
                              const advanced = yield* journal.advanceStage(snapshot.fence, {
                                receiptId: projectTeamDerivedRecordId(
                                  dispatchId,
                                  "stage:setup-complete",
                                ),
                                stage: "setup-complete",
                                evidence: yield* decodeJsonObject({ workspace, setup }),
                              });
                              snapshot = copy({ fence: advanced.fence, intent: advanced.intent });
                            } else {
                              const setupStage = history.find(
                                (receipt) => receipt.stage === "setup-complete",
                              );
                              if (
                                !setupStage ||
                                setupStage.receiptId !==
                                  projectTeamDerivedRecordId(dispatchId, "stage:setup-complete")
                              )
                                return yield* denied("Original setup completion stage is missing");
                              const evidence = yield* decodeSetupEvidence(setupStage.evidence);
                              if (!same(evidence.workspace, workspace))
                                return yield* denied(
                                  "Setup history belongs to a different workspace",
                                );
                              setup = yield* workspaceService.readSetup(snapshot);
                              if (!setup || !same(setup, evidence.setup))
                                return yield* denied(
                                  "Original setup completion differs from retained history",
                                );
                              yield* workspaceService.verifyRetained(snapshot, workspace, setup);
                            }
                            if (!setup || snapshot.fence.stage !== "setup-complete")
                              return yield* denied(
                                "Original preparation did not reach setup completion",
                              );
                            yield* workspaceService.verifyRetained(snapshot, workspace, setup);
                            yield* current(snapshot);
                            const thread = yield* threads.ensure(snapshot, loan.modelSelection);
                            yield* workspaceService.verifyRetained(snapshot, workspace, setup);
                            yield* current(snapshot);
                            return copy({ snapshot, workspace, setup, thread });
                          });
                          return yield* body.pipe(Effect.provide(ownerContext));
                        }),
                      )
                      .pipe(Effect.ensuring(Effect.sync(() => activeLoans.delete(token))));
                  }),
                )
                .pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      callbackOpen = false;
                    }),
                  ),
                );
            }).pipe(Effect.provide(captured)),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (--entry.users === 0 && serial.get(dispatchId) === entry)
                  serial.delete(dispatchId);
              }),
            ),
          );
      },
      Effect.mapError((cause) =>
        isPreparationError(cause)
          ? cause
          : new ProjectTeamPreparationRuntimeError({
              reason: "Preparation failed; original ownership is retained for Root recovery",
              cause,
            }),
      ),
    );
    return { prepare };
  },
);
