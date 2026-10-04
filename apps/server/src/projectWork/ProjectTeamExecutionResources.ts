import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  resolveProviderInstanceEnabled,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { PiDriverConfiguration } from "../provider/pi/PiManagedRuntime.ts";
import { resolvePiManagedSkillSelection } from "../provider/pi/PiManagedSkillSelection.ts";
import { PiModelCatalogue } from "../provider/pi/PiModelCatalogue.ts";
import { ManagedSkillRepository } from "../skills/ManagedSkillRepository.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchJournalError,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";

const fs = process.getBuiltinModule("fs");
const same = (left: unknown, right: unknown) =>
  canonicalProjectWorkPayload(left) === canonicalProjectWorkPayload(right);
const deny = (reason: string) => new ProjectTeamDispatchJournalError({ reason });
const unavailable = (reason: string, cause: unknown) => Object.assign(deny(reason), { cause });
const decodeConfiguration = Schema.decodeUnknownEffect(PiDriverConfiguration);
const isJournalError = Schema.is(ProjectTeamDispatchJournalError);
const decodeActualConfiguration = Schema.decodeUnknownEffect(
  Schema.Struct({ enabled: Schema.Boolean, configuration: PiDriverConfiguration }),
);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRuntime = Schema.decodeUnknownEffect(
  Schema.Struct({
    runtimeVersion: Schema.Literal("0.99.1"),
    maxInputTokens: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
    maxOutputTokens: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 })),
  }),
);

interface Options {
  readonly environmentId: string;
  readonly maximumEnvironmentModelCalls: number;
  readonly managedWorktreesRoot: string;
  readonly protectedRoots: readonly string[];
}

/** Borrows current driver resources for an already retained assignment. Workspace owns Git effects. */
export const makeProjectTeamExecutionResources = Effect.fn("makeProjectTeamExecutionResources")(
  function* (supplied: Options) {
    const options = Object.freeze({
      ...supplied,
      protectedRoots: Object.freeze([...supplied.protectedRoots]),
    });
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* ServerSettingsService;
    const registry = yield* ProviderInstanceRegistry;
    const pi = yield* ProjectTeamPiRuntime;
    const catalogue = yield* PiModelCatalogue;
    const skills = yield* ManagedSkillRepository;
    const path = yield* Path.Path;
    const clock = yield* Clock.Clock;
    const context = (yield* Effect.context<never>()).pipe(Context.omit(Scope.Scope));
    const journal = yield* makeProjectTeamDispatchJournal(options);
    const inside = (parent: string, child: string) =>
      child === parent || child.startsWith(parent + path.sep);
    const overlap = (left: string, right: string) => inside(left, right) || inside(right, left);
    const physical = (value: string, allowMissing = false) => {
      if (
        !path.isAbsolute(value) ||
        path.normalize(value) !== value ||
        value === path.sep ||
        value.length > 4096 ||
        /[\0\r\n]/u.test(value)
      )
        throw deny("Canonical resource roots are required");
      let current = path.sep;
      let missing = false;
      const identities = [];
      for (const segment of value.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const stat = fs.lstatSync(current, { bigint: true, throwIfNoEntry: false });
        if (!stat) {
          if (!allowMissing) throw deny("Original resource root is unavailable");
          missing = true;
          continue;
        }
        if (
          missing ||
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          fs.realpathSync(current) !== current
        )
          throw deny("Original resource root is aliased or not a directory");
        identities.push({
          path: current,
          dev: String(stat.dev),
          ino: String(stat.ino),
          mode: String(stat.mode),
          uid: String(stat.uid),
        });
      }
      return { path: value, missing, identities };
    };
    const roots = () => {
      if (options.protectedRoots.length > 64) throw deny("Protected resource roots exceed bounds");
      const managed = physical(options.managedWorktreesRoot);
      const stat = fs.lstatSync(options.managedWorktreesRoot, { bigint: true });
      if (stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o077n) !== 0n)
        throw deny("Managed resource root must be private to this server");
      return { managed, protected: options.protectedRoots.map((root) => physical(root, true)) };
    };
    const originalRoots = yield* Effect.try({
      try: roots,
      catch: () => deny("Original resource roots are unavailable"),
    });
    const assertClient = Effect.contextWith((ambient: Context.Context<never>) => {
      const current = Context.getOption(ambient, SqlClient.SqlClient);
      return Option.isSome(current) && current.value !== sql
        ? Effect.fail(deny("Execution resources belong to another SQL client"))
        : Effect.void;
    });
    const withCurrent = <A, E, R>(
      caller: ProjectTeamDispatchSnapshot,
      run: (loan: {
        readonly modelSelection: ModelSelection;
        readonly assertResources: Effect.Effect<void, ProjectTeamDispatchJournalError, Scope.Scope>;
        readonly assertCurrent: (
          expected: ProjectTeamDispatchSnapshot,
        ) => Effect.Effect<void, ProjectTeamDispatchJournalError, Scope.Scope>;
      }) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | ProjectTeamDispatchJournalError, R | Scope.Scope> =>
      Effect.gen(function* () {
        let callbackExit: Exit.Exit<A, E> | undefined;
        const attempt = yield* assertClient
          .pipe(
            Effect.andThen(
              Effect.gen(function* () {
                // The catalogue service refuses enclosing SQL transactions. Capture its validated value here;
                // final journal callbacks compare the original bounded SQL bytes without refreshing it.
                const original = structuredClone(caller);
                const claim = original.intent.compiledClaim.transition;
                if (
                  claim?.kind !== "claim" ||
                  claim.binding.environmentId !== options.environmentId
                )
                  return yield* deny("Original execution assignment is unavailable");
                const binding = claim.binding;
                const retained = yield* journal.inspect(
                  original.fence.dispatchId,
                  original.fence.claimGeneration > 0 ? { requireClaim: true } : undefined,
                );
                if (!same(retained, original))
                  return yield* deny("Original execution fence changed");
                const available = yield* catalogue.readFresh;
                if (!available || available.selectedEntry.id !== binding.model)
                  return yield* deny("Original supported model catalogue is unavailable");
                const fresh = structuredClone(available);
                const instance = yield* registry.getInstance(binding.providerInstanceId);
                if (!instance || !instance.enabled || instance.driverKind !== "piAgent")
                  return yield* deny("Original enabled Pi driver is unavailable");
                let active = true;
                return yield* pi.withInstance(binding.providerInstanceId, (borrowed) =>
                  Effect.gen(function* () {
                    const read = Effect.fn("ProjectTeamExecutionResources.read")(
                      function* () {
                        yield* Scope.Scope;
                        yield* assertClient;
                        if (!active) return yield* deny("Original execution resource loan ended");
                        yield* borrowed.assertCurrent;
                        yield* borrowed.assets.revalidate;
                        const current = yield* settings.getSettings;
                        const configured = current.providerInstances[binding.providerInstanceId];
                        if (
                          !current.projectWorkEnabled ||
                          !current.projectTeamExecutionEnabled ||
                          !configured ||
                          configured.driver !== "piAgent" ||
                          !resolveProviderInstanceEnabled(configured) ||
                          (yield* registry.getInstance(binding.providerInstanceId)) !== instance
                        )
                          return yield* deny("Original Pi execution is disabled or replaced");
                        const actual = yield* decodeActualConfiguration(
                          borrowed.assets.instanceConfiguration,
                        );
                        if (
                          !actual.enabled ||
                          !same(
                            actual.configuration,
                            yield* decodeConfiguration(configured.config ?? {}),
                          )
                        )
                          return yield* deny(
                            "Current Pi configuration differs from its actual runtime",
                          );
                        const runtime = yield* decodeRuntime(borrowed.assets.runtimeFacts);
                        if (
                          binding.configuration.runtimeVersion !== runtime.runtimeVersion ||
                          runtime.maxInputTokens + runtime.maxOutputTokens >
                            fresh.selectedEntry.context_length ||
                          (fresh.selectedEntry.max_output_tokens !== undefined &&
                            runtime.maxOutputTokens > fresh.selectedEntry.max_output_tokens)
                        )
                          return yield* deny("Actual runtime exceeds original model metadata");
                        const rows = yield* sql<{
                          source: string;
                          fetched_at: string;
                          payload: string | null;
                        }>`
            SELECT source,fetched_at,CASE WHEN length(CAST(payload_json AS BLOB)) <= 262144
            THEN payload_json ELSE NULL END AS payload FROM project_team_pi_catalogue
            WHERE source=${fresh.source} LIMIT 2`;
                        const row = rows[0];
                        if (
                          rows.length !== 1 ||
                          !row ||
                          row.source !== fresh.source ||
                          row.fetched_at !== fresh.fetchedAt ||
                          row.payload === null ||
                          !same(yield* decodeJson(row.payload), fresh)
                        )
                          return yield* deny("Original model catalogue changed");
                        const primaryRows = yield* sql<{
                          root: string;
                        }>`SELECT workspace_root AS root
            FROM projection_projects WHERE project_id=${binding.projectId} LIMIT 2`;
                        const primaryRoot = original.intent.request.git.primaryRoot;
                        const worktree = binding.worktree;
                        if (
                          !worktree ||
                          !path.isAbsolute(worktree) ||
                          path.normalize(worktree) !== worktree ||
                          worktree !== original.intent.request.git.worktreePath ||
                          binding.branch !== original.intent.request.git.branchRef
                        )
                          return yield* deny("Original managed workspace identity changed");
                        if (
                          primaryRows.length !== 1 ||
                          primaryRows[0]?.root !== primaryRoot ||
                          overlap(primaryRoot, options.managedWorktreesRoot) ||
                          !inside(options.managedWorktreesRoot, worktree) ||
                          worktree === options.managedWorktreesRoot ||
                          options.protectedRoots.some(
                            (root) =>
                              overlap(root, options.managedWorktreesRoot) ||
                              overlap(root, worktree),
                          )
                        )
                          return yield* deny(
                            "Original project and managed resource topology changed",
                          );
                        const state = yield* readCurrentState(sql, binding.projectId);
                        const roles = (state.foundationRecords ?? []).filter(
                          (record) =>
                            record.kind === "role-revision" &&
                            record.recordId === binding.roleRevisionId,
                        );
                        const role = roles[0];
                        if (
                          roles.length !== 1 ||
                          role?.kind !== "role-revision" ||
                          role.status !== "available" ||
                          role.model !== binding.model ||
                          NodeCrypto.createHash("sha256")
                            .update(role.instructions)
                            .digest("hex") !== binding.configuration.instructionsHash ||
                          !same(role.tools, binding.configuration.toolIds) ||
                          !same(role.skills, binding.configuration.skillIds)
                        )
                          return yield* deny("Original role resources changed");
                        const selected = yield* resolvePiManagedSkillSelection({
                          projectRoot: primaryRoot,
                          selectedSkillIds: binding.configuration.skillIds,
                          roleSkillIds: role.skills,
                        }).pipe(Effect.provideService(ManagedSkillRepository, skills));
                        yield* borrowed.assets.revalidate;
                        const finalSettings = yield* settings.getSettings;
                        if (
                          !finalSettings.projectWorkEnabled ||
                          !finalSettings.projectTeamExecutionEnabled ||
                          !same(
                            finalSettings.providerInstances[binding.providerInstanceId],
                            configured,
                          ) ||
                          (yield* registry.getInstance(binding.providerInstanceId)) !== instance
                        )
                          return yield* deny(
                            "Original Pi execution changed during resource verification",
                          );
                        const physicalRoots = yield* Effect.try({
                          try: () => ({ roots: roots(), primary: physical(primaryRoot) }),
                          catch: () => deny("Original resource roots changed"),
                        });
                        if (!same(physicalRoots.roots, originalRoots))
                          return yield* deny("Original managed or protected roots changed");
                        yield* borrowed.assertCurrent;
                        const now = clock.currentTimeMillisUnsafe();
                        const fetchedAt = Date.parse(fresh.fetchedAt);
                        if (
                          !active ||
                          now < fetchedAt ||
                          now - fetchedAt >= 86_400_000 ||
                          now >=
                            Math.min(
                              original.intent.limits.deadlineAtMs,
                              original.intent.limits.rootDeadlineAtMs,
                            )
                        )
                          return yield* deny("Original resource loan or model metadata expired");
                        return {
                          configured,
                          runtime,
                          selected,
                          primary: physicalRoots.primary,
                          catalogue: row,
                        };
                      },
                      Effect.mapError((cause) =>
                        unavailable("Original execution resources could not be verified", cause),
                      ),
                    );
                    const baseline = structuredClone(yield* read());
                    const assertResources = read().pipe(
                      Effect.flatMap((current) =>
                        same(current, baseline)
                          ? Effect.void
                          : Effect.fail(deny("Original execution resource identity changed")),
                      ),
                    );
                    const assertCurrent = Effect.fn("ProjectTeamExecutionResources.assertCurrent")(
                      function* (expected: ProjectTeamDispatchSnapshot) {
                        if (!same(expected.intent, original.intent))
                          return yield* deny("Original execution assignment changed");
                        const current = yield* journal.inspect(
                          expected.fence.dispatchId,
                          expected.fence.claimGeneration > 0 ? { requireClaim: true } : undefined,
                        );
                        if (!same(current, expected))
                          return yield* deny("Original execution fence changed");
                        yield* assertResources;
                      },
                      Effect.mapError((error) =>
                        isJournalError(error)
                          ? error
                          : unavailable("Original execution fence could not be verified", error),
                      ),
                    );
                    const modelSelection: ModelSelection = Object.freeze({
                      instanceId: binding.providerInstanceId,
                      model: binding.model,
                      options: Object.freeze([]),
                    });
                    yield* assertCurrent(original);
                    return yield* Effect.suspend(() =>
                      run(Object.freeze({ modelSelection, assertCurrent, assertResources })),
                    ).pipe(
                      Effect.exit,
                      Effect.tap((exit) =>
                        Effect.sync(() => {
                          callbackExit = exit;
                        }),
                      ),
                    );
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        active = false;
                      }),
                    ),
                  ),
                );
              }).pipe(Effect.provide(context)),
            ),
          )
          .pipe(
            Effect.mapError((error) =>
              isJournalError(error)
                ? error
                : unavailable("Actual execution resources are unavailable", error),
            ),
            Effect.exit,
          );
        if (Exit.isFailure(attempt))
          return yield* Effect.failCause(
            callbackExit !== undefined && Exit.isFailure(callbackExit)
              ? Cause.combine(callbackExit.cause, attempt.cause)
              : attempt.cause,
          );
        if (Exit.isFailure(attempt.value)) return yield* Effect.failCause(attempt.value.cause);
        return attempt.value.value;
      });
    return { withCurrent };
  },
);
