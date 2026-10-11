import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import { resolveProjectScripts, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeProjectTeamDispatchJournal } from "../projectWork/ProjectTeamDispatchJournal.ts";
import {
  acquirePiManagedProcess,
  preallocatePiManagedProcess,
  reconcilePiManagedProcess,
  type PiManagedLaunch,
} from "../provider/pi/PiManagedProcess.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  makeProjectManagedSetup,
  ProjectManagedSetupError,
  type ProjectManagedSetupInput,
  type ProjectManagedSetupReceipt,
  type ProjectManagedSetupSelection,
} from "./ProjectManagedSetup.ts";
import { makeProjectManagedSetupJournal } from "./ProjectManagedSetupJournal.ts";

type Dispatch = Effect.Success<ReturnType<typeof makeProjectTeamDispatchJournal>>;
type Snapshot = Effect.Success<ReturnType<Dispatch["inspect"]>>;

interface Options {
  readonly environmentId: string;
  readonly maximumEnvironmentModelCalls: number;
  readonly launchPolicy: { readonly memoryBytes: number; readonly runtimeSeconds: number };
  readonly runtimeFiles: PiManagedLaunch["runtimeFiles"];
  readonly protectedRoots: readonly string[];
  readonly protectedWorkspaceEntries: readonly string[];
  readonly revalidateRuntimeAssets: Effect.Effect<void, ProjectManagedSetupError, Scope.Scope>;
  readonly assertWorkspace: (
    input: ProjectManagedSetupInput,
    snapshot: Snapshot,
  ) => Effect.Effect<void, ProjectManagedSetupError, Scope.Scope>;
}

const policy = Schema.Struct({
  memoryBytes: Schema.Int.check(Schema.isBetween({ minimum: 16777216, maximum: 2147483648 })),
  runtimeSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
});
const failure = (reason: string) => new ProjectManagedSetupError({ reason });

/** Root lends one approved attempt's immutable assets and registered Git fence; it owns their lifetime. */
export const makeProjectManagedSetupRuntime = Effect.fn("makeProjectManagedSetupRuntime")(
  function* (supplied: Options) {
    // Capture callbacks and plain policy before the first yield. Later caller mutation cannot
    // redirect a retained setup or extend the original attempt's resource policy.
    const options = {
      environmentId: supplied.environmentId,
      maximumEnvironmentModelCalls: supplied.maximumEnvironmentModelCalls,
      launchPolicy: Object.freeze({ ...supplied.launchPolicy }),
      runtimeFiles: Object.freeze(supplied.runtimeFiles.map((file) => Object.freeze({ ...file }))),
      protectedRoots: Object.freeze([...supplied.protectedRoots]),
      protectedWorkspaceEntries: Object.freeze([...supplied.protectedWorkspaceEntries]),
      revalidateRuntimeAssets: supplied.revalidateRuntimeAssets,
      assertWorkspace: supplied.assertWorkspace,
    };
    yield* Schema.decodeEffect(policy)(options.launchPolicy).pipe(
      Effect.mapError(() => failure("Setup requires bounded immutable launch resources")),
    );
    if (
      options.protectedWorkspaceEntries.length === 0 ||
      !options.runtimeFiles.some((file) => file.target === "/bin/bash")
    )
      return yield* failure("Setup requires staged Bash and registered protected Git entries");

    const query = yield* ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;
    const dispatch = yield* makeProjectTeamDispatchJournal(options);
    // Native finalizers use the execute/reconcile caller's scope. Check callbacks
    // close over Root services; their local resources end after each selection check.
    // Context.Reference defaults are not entries in Effect.context(). Materialize
    // them now so an execute caller cannot replace the clock or manager identity.
    const clock = yield* Clock.Clock;
    const platform = yield* HostProcessPlatform;
    const uid = yield* HostProcessUserId;
    const captured = (yield* Effect.context<
      | Effect.Services<ReturnType<typeof preallocatePiManagedProcess>>
      | Effect.Services<ReturnType<typeof acquirePiManagedProcess>>
      | Effect.Services<ReturnType<typeof reconcilePiManagedProcess>>
      | Effect.Services<ReturnType<typeof makeProjectManagedSetupJournal>>
    >()).pipe(
      Context.add(Clock.Clock, clock),
      Context.add(HostProcessPlatform, platform),
      Context.add(HostProcessUserId, uid),
    );
    const services = captured.pipe(Context.omit(Scope.Scope));

    const resolveSelection = Effect.fn("ProjectManagedSetupRuntime.resolveSelection")(
      function* (input: ProjectManagedSetupInput) {
        const snapshot = yield* dispatch
          .inspect(input.dispatchId)
          .pipe(Effect.mapError(() => failure("Setup dispatch is no longer current")));
        const project = yield* query
          .getProjectShellById(snapshot.intent.compiledClaim.projectId)
          .pipe(Effect.mapError(() => failure("Current setup project cannot be read")));
        if (
          Option.isNone(project) ||
          project.value.workspaceRoot !== snapshot.intent.request.git.primaryRoot
        )
          return yield* failure("Setup project is missing or its root changed");
        const currentSettings = yield* settings.getSettings.pipe(
          Effect.mapError(() => failure("Current setup settings cannot be read")),
        );
        const scripts = resolveProjectScripts(currentSettings, project.value);
        const script = setupProjectScript(scripts);
        yield* options.assertWorkspace(input, snapshot);
        yield* options.revalidateRuntimeAssets;
        if (!script) return { kind: "none" } satisfies ProjectManagedSetupSelection;
        return {
          kind: "script",
          scriptId: script.id,
          scriptRevision: NodeCrypto.createHash("sha256")
            .update(canonicalProjectWorkPayload({ script, scripts }))
            .digest("hex"),
          cwd: input.worktreePath,
          launch: {
            workspaceRoot: input.worktreePath,
            workspaceAccess: "readwrite",
            protectedWorkspaceEntries: options.protectedWorkspaceEntries,
            protectedRoots: options.protectedRoots,
            runtimeFiles: options.runtimeFiles,
            argv: ["/bin/bash", "-c", script.command],
            ...options.launchPolicy,
          },
        } satisfies ProjectManagedSetupSelection;
      },
      Effect.scoped,
      Effect.provide(services),
    );

    const journal = yield* makeProjectManagedSetupJournal({
      ...options,
      validateSelection: Effect.fn("ProjectManagedSetupRuntime.validateSelection")(
        function* (input, selected) {
          const current = yield* resolveSelection(input);
          if (
            selected !== null &&
            canonicalProjectWorkPayload(current) !== canonicalProjectWorkPayload(selected)
          )
            return yield* failure("Frozen setup selection no longer matches current configuration");
        },
      ),
    });
    const setup = makeProjectManagedSetup({
      ...journal,
      resolveSelection,
      preallocate: (launch) => preallocatePiManagedProcess(launch).pipe(Effect.provide(services)),
      acquire: (launch, persistence) =>
        acquirePiManagedProcess(launch, persistence).pipe(Effect.provide(services)),
      reconcileProcess: (recovery, options) =>
        reconcilePiManagedProcess(recovery, options).pipe(Effect.provide(services)),
    });
    return {
      verify: (input: ProjectManagedSetupInput, receipt: ProjectManagedSetupReceipt) =>
        Effect.gen(function* () {
          const retained = yield* journal.read(input);
          if (
            !retained ||
            retained.uncertain ||
            !retained.receipt ||
            (receipt.outcome !== "skipped" && receipt.outcome !== "succeeded") ||
            canonicalProjectWorkPayload(retained.receipt) !== canonicalProjectWorkPayload(receipt)
          )
            return yield* failure("Setup evidence is not certain retained completion");
          const current = yield* resolveSelection(input);
          if (
            canonicalProjectWorkPayload(current) !== canonicalProjectWorkPayload(receipt.selection)
          )
            return yield* failure("Frozen setup selection no longer matches current configuration");
        }).pipe(Effect.provide(services)),
      execute: (input: ProjectManagedSetupInput) =>
        setup.execute(input).pipe(Effect.provide(services)),
      reconcile: (input: ProjectManagedSetupInput) =>
        setup.reconcile(input).pipe(Effect.provide(services)),
    };
  },
);
