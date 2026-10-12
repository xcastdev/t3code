import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  EnvironmentId,
  ProjectId,
  ProjectTeamRecord,
  ProjectWorkTaskId,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { canonicalGitMutationKey } from "../git/ManagedGitExecution.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { piLocalToolDefinitions } from "../provider/pi/PiLocalTools.ts";
import { PiDriverConfiguration } from "../provider/pi/PiManagedRuntime.ts";
import { resolvePiManagedSkillSelection } from "../provider/pi/PiManagedSkillSelection.ts";
import { PiModelCatalogue } from "../provider/pi/PiModelCatalogue.ts";
import { piProjectWorkToolCapabilities } from "../provider/pi/PiProjectWorkTools.ts";
import { ManagedSkillRepository } from "../skills/ManagedSkillRepository.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import type { ProjectTeamConfiguredAdmissionFacts } from "./ProjectTeamConfiguredAdmission.ts";
import { projectTeamConfigurationGeneration } from "./ProjectTeamConfiguration.ts";
import type { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { projectTeamDerivedRecordId, projectTeamAssignmentRole } from "./ProjectTeamPolicy.ts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { deliveryDependencyIds } from "./ProjectTeamDeliveryAcceptanceState.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";

const nativeFs = process.getBuiltinModule("fs");
const safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const positive = safe.check(Schema.isGreaterThan(0));
const absolute = Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^\/[^\0\r\n]*$/u));
const rootCaps = Schema.Struct({
  maximumDelegationDepth: safe.check(Schema.isLessThanOrEqualTo(8)),
  repairAllowance: safe.check(Schema.isLessThanOrEqualTo(16)),
  environmentModelCalls: positive.check(Schema.isLessThanOrEqualTo(128)),
  projectWritableWorkers: safe.check(Schema.isLessThanOrEqualTo(64)),
  modelCalls: positive.check(Schema.isLessThanOrEqualTo(128)),
});
const runtimeFacts = Schema.Struct({
  runtimeVersion: Schema.Literal("0.99.1"),
  maxInputTokens: positive.check(Schema.isLessThanOrEqualTo(1_000_000)),
  maxOutputTokens: positive.check(Schema.isLessThanOrEqualTo(65_536)),
});
const budgetRows = Schema.Array(
  Schema.Struct({ maximumTokens: positive, deadlineAtMs: positive }),
).check(Schema.isMaxLength(1));
const catalogueRow = Schema.Struct({
  source: Schema.String,
  fetchedAt: Schema.String,
  payload: Schema.String.check(Schema.makeFilter((value) => Buffer.byteLength(value) <= 262144)),
});
const decodeCatalogueRows = Schema.decodeUnknownEffect(
  Schema.Array(catalogueRow).check(Schema.isMaxLength(1)),
);
const decodeCatalogueJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEnvironmentId = Schema.decodeUnknownEffect(EnvironmentId);
const decodeEnvironmentCalls = Schema.decodeUnknownEffect(
  positive.check(Schema.isLessThanOrEqualTo(128)),
);
const decodeAbsolute = Schema.decodeUnknownEffect(absolute);
const decodeProtectedRoots = Schema.decodeUnknownEffect(
  Schema.Array(absolute).check(Schema.isMaxLength(64)),
);
const decodeBudgetRows = Schema.decodeUnknownEffect(budgetRows);
const decodeRootCaps = Schema.decodeUnknownEffect(rootCaps);
const decodeRuntimeFacts = Schema.decodeUnknownEffect(runtimeFacts);
const decodeInstanceConfiguration = Schema.decodeUnknownEffect(
  Schema.Struct({ enabled: Schema.Boolean, configuration: PiDriverConfiguration }),
);
const decodeDriverConfiguration = Schema.decodeUnknownEffect(PiDriverConfiguration);
const decodePrimaryRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ root: absolute })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1),
  ),
);
const validRecord = Schema.is(ProjectTeamRecord);
const validSafe = Schema.is(safe);
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
class AdmissionLoan extends Context.Service<AdmissionLoan, { readonly token: symbol }>()(
  "t3/projectWork/ProjectTeamAdmissionFacts/AdmissionLoan",
) {}
const initialRoles = [
  "coordinator",
  "investigator",
  "planner",
  "implementer",
  "reviewer",
  "integrator",
] as const;
type RecordOf<K extends ProjectTeamRecord["kind"]> = Extract<ProjectTeamRecord, { kind: K }>;
type Input = { readonly state: ProjectWorkReducerState; readonly taskId: ProjectWorkTaskId };

export class ProjectTeamAdmissionFactsError extends Schema.TaggedError<ProjectTeamAdmissionFactsError>()(
  "ProjectTeamAdmissionFactsError",
  { reason: Schema.String },
) {}
const isFactsError = Schema.is(ProjectTeamAdmissionFactsError);
const denied = (reason: string) => new ProjectTeamAdmissionFactsError({ reason });
function reject(reason: string): never {
  throw denied(reason);
}
const equal = (left: unknown, right: unknown) =>
  canonicalProjectWorkPayload(left) === canonicalProjectWorkPayload(right);

// Read-only commands use the managed Git policy; no inherited Git routing or lazy fetch.
const hardened = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "credential.helper=",
  "core.askPass=",
  "core.pager=",
  "diff.external=",
  "core.attributesFile=/dev/null",
  "core.excludesFile=/dev/null",
  "core.sshCommand=/usr/bin/false",
  "protocol.allow=never",
  "submodule.recurse=false",
  "fetch.recurseSubmodules=false",
  "push.recurseSubmodules=no",
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  "maintenance.auto=false",
  "gc.auto=0",
  "core.untrackedCache=false",
].flatMap((setting) => ["-c", setting]);
const gitEnvironment = () => ({
  ...Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.startsWith("GIT_"))
      .map((key) => [key, undefined]),
  ),
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "",
  PAGER: "",
  GIT_ATTR_NOSYSTEM: "1",
});

/** Root captures actual services once. Reads propose identities, never allocate durable ownership. */
export const makeProjectTeamAdmissionFacts = Effect.fn("makeProjectTeamAdmissionFacts")(
  function* (options: {
    readonly environmentId: string;
    readonly managedWorktreesRoot: string;
    readonly protectedRoots: readonly string[];
    readonly maximumEnvironmentModelCalls: number;
    readonly journal: Pick<
      Effect.Success<ReturnType<typeof makeProjectTeamDispatchJournal>>,
      "readRetained"
    >;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* ServerSettingsService;
    const registry = yield* ProviderInstanceRegistry;
    const pi = yield* ProjectTeamPiRuntime;
    const catalogue = yield* PiModelCatalogue;
    const skills = yield* ManagedSkillRepository;
    const workflow = yield* GitWorkflowService;
    const git = yield* GitVcsDriver;
    const path = yield* Path.Path;
    const clock = yield* Clock.Clock;
    const environmentId = yield* decodeEnvironmentId(options.environmentId);
    const environmentCalls = yield* decodeEnvironmentCalls(options.maximumEnvironmentModelCalls);
    const journal = options.journal;
    const managedRoot = yield* decodeAbsolute(options.managedWorktreesRoot);
    const protectedRoots = yield* decodeProtectedRoots(options.protectedRoots);
    const inside = (parent: string, child: string) =>
      child === parent || child.startsWith(parent + path.sep);
    const overlap = (left: string, right: string) => inside(left, right) || inside(right, left);
    const physical = (value: string, allowMissing = false) => {
      if (!Schema.is(absolute)(value) || path.normalize(value) !== value || value === path.sep)
        reject("Canonical non-root paths are required");
      const identities = [];
      let current = path.sep;
      let missing = false;
      for (const segment of value.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const stat = nativeFs.lstatSync(current, { bigint: true, throwIfNoEntry: false });
        if (stat === undefined) {
          if (!allowMissing) reject("Physical path is unavailable");
          missing = true;
          continue;
        }
        if (
          missing ||
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          nativeFs.realpathSync(current) !== current
        )
          reject("Physical path is aliased or not a directory");
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
    const rootIdentity = yield* Effect.try({
      try: () => physical(managedRoot),
      catch: () => denied("Managed worktree root is not physically available"),
    });
    const verifyRoots = () => {
      if (!equal(rootIdentity, physical(managedRoot)))
        reject("Managed worktree root identity changed");
      const owned = nativeFs.lstatSync(managedRoot, { bigint: true });
      if (owned.uid !== BigInt(process.getuid?.() ?? -1) || (owned.mode & 0o077n) !== 0n)
        reject("Managed worktree root must be private to this server");
      return protectedRoots.map((root) => physical(root, true));
    };
    yield* Effect.try({
      try: verifyRoots,
      catch: () => denied("Managed or protected roots are unavailable"),
    });
    const command = Effect.fn("ProjectTeamAdmissionFacts.git")(function* (
      cwd: string,
      args: readonly string[],
    ) {
      yield* Effect.try({
        try: () => {
          const executable = nativeFs.lstatSync("/usr/bin/git", { bigint: true });
          if (
            !executable.isFile() ||
            executable.uid !== 0n ||
            (executable.mode & 0o022n) !== 0n ||
            nativeFs.realpathSync("/usr/bin/git") !== "/usr/bin/git"
          )
            reject("Trusted Git executable is unavailable");
        },
        catch: () => denied("Trusted Git executable is unavailable"),
      });
      const output = yield* git.execute({
        operation: "ProjectTeamAdmissionFacts",
        cwd,
        args: [...hardened, ...args],
        env: gitEnvironment(),
        timeoutMs: 5000,
        maxOutputBytes: 262144,
      });
      if (output.exitCode !== 0 || output.stdoutTruncated || output.stderrTruncated)
        return yield* denied("Git identity measurement is incomplete");
      return output.stdout.trim();
    });
    const select = (input: Input) => {
      const state = input.state;
      if (!validSafe(state.revision) || state.revision === Number.MAX_SAFE_INTEGER)
        reject("Invalid project revision");
      const records = state.foundationRecords ?? [];
      if (
        new Set(records.map((record) => record.recordId)).size !== records.length ||
        records.some((record) => !validRecord(record) || record.projectId !== state.projectId)
      )
        reject("Invalid or ambiguous current configuration");
      const memberships = records.filter(
        (r): r is RecordOf<"task-membership"> => r.kind === "task-membership",
      );
      const membership = memberships.filter((r) => r.taskId === input.taskId);
      if (
        membership.length !== 1 ||
        membership[0]?.status !== "active" ||
        membership[0].executionKind !== "managed" ||
        membership[0].assignment === undefined
      )
        reject("Current managed assignment is required");
      const currentMembership = membership[0]!;
      const lineage = new Set<ProjectWorkTaskId>();
      let rootTaskId = input.taskId;
      for (;;) {
        if (lineage.has(rootTaskId) || lineage.size >= 9) reject("Task ancestry is invalid");
        lineage.add(rootTaskId);
        const tasks = state.tasks.filter(
          (task) => task.taskId === rootTaskId && task.projectId === state.projectId,
        );
        const current = memberships.filter((r) => r.taskId === rootTaskId);
        if (
          tasks.length !== 1 ||
          current.length !== 1 ||
          current[0]?.status !== "active" ||
          current[0].executionKind === "legacy" ||
          (current[0].controlState !== undefined && current[0].controlState !== "active")
        )
          reject("Current task lineage is unavailable");
        if (current[0].parentTaskId === undefined) break;
        rootTaskId = current[0].parentTaskId;
      }
      const generation = projectTeamConfigurationGeneration(state);
      const policies = records.filter(
        (r): r is RecordOf<"limits"> => r.kind === "limits" && r.status === "configured",
      );
      const policy = policies[0];
      if (
        !policy ||
        policies.length > 6 ||
        !Schema.is(positive)(generation) ||
        policy.providerInstanceId === undefined ||
        policy.profileRecordIds?.length !== 6 ||
        new Set(policy.profileRecordIds).size !== 6
      )
        reject("Complete current human-installed configuration is required");
      const instanceId = ProviderInstanceId.make(policy.providerInstanceId!);
      if (
        policies.some(
          (r) =>
            r.generation !== generation ||
            r.providerInstanceId !== instanceId ||
            !equal([...(r.profileRecordIds ?? [])].sort(), [...policy.profileRecordIds!].sort()) ||
            r.environmentModelCalls > environmentCalls,
        )
      )
        reject("Configured provider, profile lineage or environment capacity changed");
      const roles = policy.profileRecordIds!.map((id) => {
        const matches = records.filter(
          (r): r is RecordOf<"role-revision"> => r.kind === "role-revision" && r.recordId === id,
        );
        const role = matches[0];
        if (
          matches.length !== 1 ||
          !role ||
          role.status !== "available" ||
          role.generation !== generation ||
          policies.filter((p) => p.model === role.model).length !== 1
        )
          reject("Configured role is unavailable");
        return role!;
      });
      if (initialRoles.some((name) => roles.filter((role) => role.role === name).length !== 1))
        reject("Six configured roles are required");
      const members = roles.map((role) => {
        const matches = records.filter(
          (r): r is RecordOf<"member"> =>
            r.kind === "member" && r.roleRevisionId === role.recordId && r.status !== "retired",
        );
        const member = matches[0];
        if (
          matches.length !== 1 ||
          !member ||
          member.status !== "active" ||
          member.generation !== generation ||
          member.coordinator !== (role.role === "coordinator")
        )
          reject("Configured active member is unavailable");
        return member!;
      });
      const integrationPlan = records
        .filter(
          (record): record is RecordOf<"plan-revision"> =>
            record.kind === "plan-revision" &&
            record.taskId === input.taskId &&
            record.status === "proposed",
        )
        .sort((left, right) => right.planRevision - left.planRevision)[0];
      const name = projectTeamAssignmentRole(currentMembership.deliverableKind, integrationPlan);
      const member =
        currentMembership.requestedSuccessorMemberId === undefined
          ? members[roles.findIndex((role) => role.role === name)]
          : members.find((m) => m.recordId === currentMembership.requestedSuccessorMemberId);
      const role = roles.find((r) => r.recordId === member?.roleRevisionId);
      if (
        !role ||
        (name === "implementer"
          ? role.role !== "implementer" && role.role !== "integrator"
          : role.role !== name)
      )
        reject("Assignment successor does not match the configured role");
      const prior = records.filter(
        (r): r is RecordOf<"run-binding"> => r.kind === "run-binding" && r.taskId === input.taskId,
      );
      const highest = prior.reduce((n, r) => Math.max(n, r.generation), -1);
      if (highest >= Number.MAX_SAFE_INTEGER) reject("Assignment generation is exhausted");
      return { instanceId, role: role!, rootTaskId, generation: highest + 1, memberships };
    };
    const readRootAnchor = Effect.fn("ProjectTeamAdmissionFacts.rootAnchor")(function* (
      input: Input,
      selected: ReturnType<typeof select>,
    ) {
      const budget = yield* decodeBudgetRows(
        yield* sql`
      SELECT maximum_tokens AS "maximumTokens", deadline_at_ms AS "deadlineAtMs" FROM project_team_model_budget
      WHERE environment_id=${environmentId} AND project_id=${input.state.projectId} AND root_task_id=${selected.rootTaskId}`,
      );
      const anchors = yield* sql<{
        dispatchId: string;
      }>`SELECT dispatch_id AS "dispatchId" FROM project_team_dispatch
      WHERE environment_id=${environmentId} AND project_id=${input.state.projectId} AND root_task_id=${selected.rootTaskId}
      ORDER BY created_at,dispatch_id LIMIT 1`;
      if (budget.length === 0 && anchors.length === 0) {
        const belongs = (taskId: ProjectWorkTaskId) => {
          const seen = new Set<ProjectWorkTaskId>();
          let current = taskId;
          for (;;) {
            if (current === selected.rootTaskId) return true;
            if (seen.has(current) || seen.size >= 9) return false;
            seen.add(current);
            const entries = selected.memberships.filter((r) => r.taskId === current);
            if (entries.length !== 1 || entries[0]?.parentTaskId === undefined) return false;
            current = entries[0].parentTaskId;
          }
        };
        if (
          (input.state.foundationRecords ?? []).some(
            (r) => r.kind === "run-binding" && belongs(r.taskId),
          ) ||
          input.state.attempts.some((attempt) => belongs(attempt.taskId))
        )
          return yield* denied("Existing lineage has no original retained root proof");
        return { _tag: "NewRoot" } as const;
      }
      if (budget.length !== 1 || anchors.length !== 1 || anchors[0] === undefined)
        return yield* denied("Original root budget requires reconciliation");
      const original = yield* journal.readRetained(anchors[0].dispatchId);
      const intent = original.intent;
      if (
        intent.compiledClaim.projectId !== input.state.projectId ||
        intent.limits.rootTaskId !== selected.rootTaskId ||
        intent.limits.maximumTokens !== budget[0]!.maximumTokens ||
        intent.limits.rootDeadlineAtMs !== budget[0]!.deadlineAtMs ||
        intent.compiledClaim.transition?.kind !== "claim" ||
        intent.compiledClaim.transition.binding.environmentId !== environmentId
      )
        return yield* denied("Original retained root budget identity changed");
      const caps = yield* decodeRootCaps(intent.rootCaps);
      const mismatches = yield* sql`SELECT dispatch_id FROM project_team_dispatch
      WHERE environment_id=${environmentId} AND project_id=${input.state.projectId} AND root_task_id=${selected.rootTaskId}
      AND (root_maximum_tokens <> ${budget[0]!.maximumTokens} OR root_deadline_at_ms <> ${budget[0]!.deadlineAtMs}
        OR json_extract(intent_json,'$.rootCaps.maximumDelegationDepth') IS NOT ${caps.maximumDelegationDepth}
        OR json_extract(intent_json,'$.rootCaps.repairAllowance') IS NOT ${caps.repairAllowance}
        OR json_extract(intent_json,'$.rootCaps.environmentModelCalls') IS NOT ${caps.environmentModelCalls}
        OR json_extract(intent_json,'$.rootCaps.projectWritableWorkers') IS NOT ${caps.projectWritableWorkers}
        OR json_extract(intent_json,'$.rootCaps.modelCalls') IS NOT ${caps.modelCalls}) LIMIT 1`;
      if (mismatches.length > 0) return yield* denied("Retained lineage changed its original caps");
      return {
        _tag: "RetainedRoot",
        budget: { rootTaskId: selected.rootTaskId, ...budget[0]! },
        caps,
      } as const;
    });
    const readCatalogueRow = Effect.fn("ProjectTeamAdmissionFacts.catalogueRow")(function* () {
      const rows = yield* decodeCatalogueRows(
        yield* sql`SELECT source,fetched_at AS "fetchedAt",
      CASE WHEN length(CAST(payload_json AS BLOB)) <= 262144 THEN payload_json ELSE NULL END AS payload
      FROM project_team_pi_catalogue WHERE source='https://api.commandcode.ai/provider/v1/models' LIMIT 2`,
      );
      if (rows.length !== 1 || rows[0] === undefined)
        return yield* denied("Fresh owned catalogue metadata is unavailable");
      return { row: rows[0], value: yield* decodeCatalogueJson(rows[0].payload) };
    });
    const metadata = (common: string, baseRef: string) => {
      for (const relative of [
        "commondir",
        "config.worktree",
        "shallow",
        "objects/info/alternates",
        "objects/info/http-alternates",
      ])
        if (
          nativeFs.lstatSync(path.join(common, relative), { throwIfNoEntry: false }) !== undefined
        )
          reject("Git metadata uses unsupported foreign storage");
      return ["config", "HEAD", "packed-refs", baseRef].map((relative) => {
        const filename = path.join(common, relative);
        // Packing refs can remove optional loose-ref directories; existing ancestors stay physical.
        physical(path.dirname(filename), relative !== "config" && relative !== "HEAD");
        const stat = nativeFs.lstatSync(filename, { bigint: true, throwIfNoEntry: false });
        if (stat === undefined) {
          if (relative === "config" || relative === "HEAD")
            reject("Required Git metadata is unavailable");
          return { filename, absent: true };
        }
        if (!stat.isFile() || stat.nlink !== 1n || stat.size > 262144n)
          reject("Git metadata file is aliased or exceeds its bound");
        const fd = nativeFs.openSync(
          filename,
          nativeFs.constants.O_RDONLY |
            nativeFs.constants.O_NOFOLLOW |
            nativeFs.constants.O_NONBLOCK,
        );
        try {
          const before = nativeFs.fstatSync(fd, { bigint: true });
          const buffer = Buffer.alloc(262145);
          let length = 0;
          while (length < buffer.length) {
            const count = nativeFs.readSync(fd, buffer, length, buffer.length - length, null);
            if (count === 0) break;
            length += count;
          }
          if (length > 262144) reject("Git metadata exceeds its read bound");
          const bytes = buffer.subarray(0, length);
          const after = nativeFs.fstatSync(fd, { bigint: true });
          const current = nativeFs.lstatSync(filename, { bigint: true });
          const identity = (value: typeof stat) => ({
            dev: String(value.dev),
            ino: String(value.ino),
            mode: String(value.mode),
            size: String(value.size),
            mtime: String(value.mtimeNs),
            ctime: String(value.ctimeNs),
          });
          if (
            !equal(identity(stat), identity(before)) ||
            !equal(identity(before), identity(after)) ||
            !equal(identity(after), identity(current))
          )
            reject("Git metadata changed during inspection");
          return {
            filename,
            ...identity(after),
            hash: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          };
        } finally {
          nativeFs.closeSync(fd);
        }
      });
    };
    const assertDelivered = Effect.fn("ProjectTeamAdmissionFacts.assertDelivered")(function* (
      actual: ProjectWorkReducerState,
      taskId: ProjectWorkTaskId,
    ) {
      const dependencies = yield* Effect.try({
        try: () => deliveryDependencyIds(actual, taskId),
        catch: () => denied("Dependency lineage changed"),
      });
      if (dependencies.length > 0) {
        const owner = yield* Effect.serviceOption(ProjectWorkRepository),
          client = yield* Effect.serviceOption(SqlClient.SqlClient);
        if (Option.isNone(owner) || (Option.isSome(client) && client.value !== sql))
          return yield* denied("Delivery repository or SQL changed");
        const { makeProjectTeamDeliveryAcceptance } = yield* Effect.promise(
          () => import("./ProjectTeamDeliveryAcceptance.ts"),
        );
        const acceptance = yield* makeProjectTeamDeliveryAcceptance({ environmentId }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectWorkRepository, owner.value),
          Effect.provideService(ServerSettingsService, settings),
          Effect.mapError(() => denied("Delivery history unavailable")),
        );
        yield* acceptance
          .assertTaskDependencies({ projectId: ProjectId.make(actual.projectId), taskId: taskId })
          .pipe(Effect.mapError(() => denied("Delivered dependency history changed")));
      }
    });
    /** Root invokes revalidation in the captured SQL transaction before admission writes.
     * The handle belongs to this callback only and expires with the actual runtime loan. */
    const withCurrent = <A, E, R>(
      callerInput: Input,
      run: (
        facts: ProjectTeamConfiguredAdmissionFacts,
        revalidateCurrent: Effect.Effect<void, ProjectTeamAdmissionFactsError>,
        /** Resources only: the journal separately validates its post-write authority. */
        revalidateResources: Effect.Effect<void, ProjectTeamAdmissionFactsError>,
      ) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        let callbackExit: Exit.Exit<A, E> | undefined;
        const attempt = yield* Effect.gen(function* () {
          const input: Input = {
            state: structuredClone(callerInput.state),
            taskId: callerInput.taskId,
          };
          const token = Symbol("admission facts loan");
          const selected = yield* Effect.try({
            try: () => select(input),
            catch: (error) =>
              isFactsError(error) ? error : denied("Current configuration is invalid"),
          });
          const beforeCapture = yield* readCurrentState(sql, input.state.projectId);
          if (!equal(beforeCapture, input.state))
            return yield* denied("Current reducer snapshot changed");
          yield* assertDelivered(beforeCapture, input.taskId);
          const fresh = yield* catalogue.readFresh;
          if (fresh === undefined)
            return yield* denied("Fresh owned catalogue metadata is unavailable");
          return yield* pi.withInstance(selected.instanceId, (borrowed) =>
            Effect.gen(function* () {
              const instance = yield* registry.getInstance(selected.instanceId);
              if (!instance || !instance.enabled || instance.driverKind !== "piAgent")
                return yield* denied("Current enabled Pi driver is unavailable");
              let active = true;
              let originalRootAnchor: ProjectTeamConfiguredAdmissionFacts["rootAnchor"] | undefined;
              const measure = Effect.fn("ProjectTeamAdmissionFacts.measure")(function* (
                validateAuthority = true,
              ) {
                if (!active) return yield* denied("Admission facts loan ended");
                yield* borrowed.assertCurrent;
                yield* borrowed.assets.revalidate;
                const ambient = Context.getOption(
                  yield* Effect.context<never>(),
                  SqlClient.SqlClient,
                );
                if (Option.isSome(ambient) && ambient.value !== sql)
                  return yield* denied("Admission resources belong to another SQL client");
                const actual = validateAuthority
                  ? yield* readCurrentState(sql, input.state.projectId)
                  : undefined;
                if (validateAuthority && !equal(actual, input.state))
                  return yield* denied("Current reducer snapshot changed");
                if (actual !== undefined) yield* assertDelivered(actual, input.taskId);
                const configured = (yield* settings.getSettings).providerInstances[
                  selected.instanceId
                ];
                if (
                  !configured ||
                  configured.driver !== "piAgent" ||
                  !resolveProviderInstanceEnabled(configured) ||
                  (yield* registry.getInstance(selected.instanceId)) !== instance
                )
                  return yield* denied("Current provider instance changed or is disabled");
                const measuredConfiguration = yield* decodeInstanceConfiguration(
                  borrowed.assets.instanceConfiguration,
                );
                const decodedConfiguration = yield* decodeDriverConfiguration(
                  configured.config ?? {},
                );
                if (
                  !measuredConfiguration.enabled ||
                  !equal(measuredConfiguration.configuration, decodedConfiguration)
                )
                  return yield* denied(
                    "Configured Pi instance differs from the actual runtime epoch",
                  );
                const measuredRuntime = yield* decodeRuntimeFacts(borrowed.assets.runtimeFacts);
                const stored = yield* readCatalogueRow();
                const now = clock.currentTimeMillisUnsafe();
                const at = DateTime.make(fresh.fetchedAt);
                if (
                  !equal(stored.value, fresh) ||
                  stored.row.source !== fresh.source ||
                  stored.row.fetchedAt !== fresh.fetchedAt ||
                  Option.isNone(at) ||
                  now < DateTime.toEpochMillis(at.value) ||
                  now - DateTime.toEpochMillis(at.value) >= 86_400_000
                )
                  return yield* denied("Measured catalogue changed or expired");
                const entry = fresh.selectedEntry;
                if (
                  selected.role.model !== entry.id ||
                  measuredRuntime.maxInputTokens + measuredRuntime.maxOutputTokens >
                    entry.context_length ||
                  (entry.max_output_tokens !== undefined &&
                    measuredRuntime.maxOutputTokens > entry.max_output_tokens)
                )
                  return yield* denied(
                    "Actual runtime token limits exceed selected model metadata",
                  );
                const rows = yield* sql<{
                  root: unknown;
                }>`SELECT workspace_root AS root FROM projection_projects WHERE project_id=${input.state.projectId} LIMIT 2`;
                const primary = yield* decodePrimaryRows(rows);
                const primaryRoot = primary[0]!.root;
                const paths = yield* Effect.try({
                  try: () => ({ primary: physical(primaryRoot), protected: verifyRoots() }),
                  catch: () => denied("Canonical project or managed roots changed"),
                });
                if (
                  overlap(primaryRoot, managedRoot) ||
                  protectedRoots.some((root) => overlap(root, managedRoot))
                )
                  return yield* denied("Managed root overlaps primary or protected storage");
                const discovery = yield* workflow.discoverRepositories({
                  cwd: primaryRoot,
                  maxRepositories: 1,
                });
                const descriptors = discovery.repositories.filter(
                  (repository) =>
                    repository.rootPath === primaryRoot &&
                    repository.worktreePath === primaryRoot &&
                    !repository.isSubmodule &&
                    repository.unavailableReason === undefined,
                );
                if (discovery.projectRoot !== primaryRoot || descriptors.length !== 1)
                  return yield* denied("Project is not the exact primary repository");
                const commonGitDirectory = yield* command(primaryRoot, [
                  "rev-parse",
                  "--path-format=absolute",
                  "--git-common-dir",
                ]);
                const top = yield* command(primaryRoot, ["rev-parse", "--show-toplevel"]);
                const common = yield* Effect.try({
                  try: () => physical(commonGitDirectory),
                  catch: () => denied("Canonical common Git storage is unavailable"),
                });
                const key = yield* canonicalGitMutationKey(descriptors[0]!.commonDir, primaryRoot);
                if (
                  top !== primaryRoot ||
                  commonGitDirectory !== path.join(primaryRoot, ".git") ||
                  key !== `git\0${commonGitDirectory}` ||
                  overlap(commonGitDirectory, managedRoot)
                )
                  return yield* denied("Primary repository/common Git identity differs");
                const worktrees = yield* command(primaryRoot, [
                  "worktree",
                  "list",
                  "--porcelain",
                  "-z",
                ]);
                if (worktrees.split("\0")[0] !== `worktree ${primaryRoot}`)
                  return yield* denied("Project is not the registered primary Git worktree");
                const baseRef = yield* command(primaryRoot, ["symbolic-ref", "--quiet", "HEAD"]);
                if (!baseRef.startsWith("refs/heads/"))
                  return yield* denied("A current local base ref is required");
                yield* command(primaryRoot, ["check-ref-format", baseRef]);
                const baseOid = yield* command(primaryRoot, [
                  "rev-parse",
                  "--verify",
                  `${baseRef}^{commit}`,
                ]);
                if (
                  !/^[a-f0-9]{40}$/u.test(baseOid) ||
                  (yield* command(primaryRoot, ["rev-parse", "--verify", "HEAD^{commit}"])) !==
                    baseOid
                )
                  return yield* denied("Current exact base commit is unavailable");
                const gitMetadata = yield* Effect.try({
                  try: () => metadata(commonGitDirectory, baseRef),
                  catch: () => denied("Git metadata identity is unsupported"),
                });
                const parsedConfiguration = yield* command(primaryRoot, [
                  "config",
                  "--no-includes",
                  "--null",
                  "--list",
                  "--file",
                  path.join(commonGitDirectory, "config"),
                ]);
                for (const record of parsedConfiguration.split("\0").filter(Boolean)) {
                  const split = record.indexOf("\n");
                  const key = record.slice(0, split).toLowerCase();
                  const value = record.slice(split + 1);
                  if (
                    split < 0 ||
                    !/^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|safecrlf|eol)|user\.(?:name|email)|init\.defaultbranch|remote\.[^.]+\.(?:url|fetch)|branch\..+\.(?:remote|merge))$/u.test(
                      key,
                    ) ||
                    (key === "core.repositoryformatversion" && value !== "0") ||
                    (key === "core.bare" && value !== "false")
                  )
                    return yield* denied("Git configuration is outside the managed policy");
                }
                const writable =
                  selected.role.role === "implementer" || selected.role.role === "integrator";
                if (
                  !writable &&
                  selected.role.role !== "investigator" &&
                  selected.role.role !== "reviewer" &&
                  selected.role.role !== "planner"
                )
                  return yield* denied("Assigned role has no supported workspace policy");
                const namespace = projectTeamDerivedRecordId(
                  input.state.projectId,
                  "managed-worktrees",
                );
                const assignment = projectTeamDerivedRecordId(
                  canonicalProjectWorkPayload({
                    projectId: input.state.projectId,
                    taskId: input.taskId,
                  }),
                  `workspace:${selected.generation}`,
                );
                const worktreePath = path.join(managedRoot, namespace, assignment);
                const branchRef = `refs/heads/t3-managed/${encodeURIComponent(namespace)}/${encodeURIComponent(assignment)}`;
                const candidate = yield* Effect.try({
                  try: () => physical(worktreePath, true),
                  catch: () => denied("Assigned worktree path is aliased or unavailable"),
                });
                if (
                  !inside(managedRoot, worktreePath) ||
                  worktreePath === managedRoot ||
                  !candidate.missing ||
                  overlap(worktreePath, primaryRoot) ||
                  overlap(worktreePath, commonGitDirectory) ||
                  protectedRoots.some((root) => overlap(root, worktreePath))
                )
                  return yield* denied("Assignment must be a fresh separate managed path");
                const selection = yield* resolvePiManagedSkillSelection({
                  projectRoot: primaryRoot,
                  selectedSkillIds: selected.role.skills,
                  roleSkillIds: selected.role.skills,
                }).pipe(Effect.provideService(ManagedSkillRepository, skills));
                const supportedToolIds = [
                  ...piLocalToolDefinitions.map((tool) => tool.capabilityId),
                  ...piProjectWorkToolCapabilities,
                ];
                if (
                  !writable &&
                  selected.role.tools.some((tool) =>
                    ["pi.write", "pi.edit", "pi.bash"].includes(tool),
                  )
                )
                  return yield* denied("Read-only role has a writable local tool");
                if (
                  selected.role.tools.some(
                    (tool) => !supportedToolIds.some((supported) => supported === tool),
                  )
                )
                  return yield* denied("Configured tool capability is unavailable");
                const rootAnchor = validateAuthority
                  ? yield* readRootAnchor(input, selected)
                  : originalRootAnchor;
                if (rootAnchor === undefined)
                  return yield* denied("Original resource loan is missing");
                const gitFacts = {
                  primaryRoot,
                  commonGitDirectory,
                  worktreePath,
                  branchRef,
                  baseRef,
                  baseOid,
                  writable,
                  policyHash: digest({
                    environmentId,
                    managedRoot,
                    protectedRoots: [...protectedRoots].sort(),
                    primary: paths.primary,
                    common,
                    candidate,
                    gitMetadata,
                    baseRef,
                    baseOid,
                    branchRef,
                    writable,
                  }),
                };
                const facts: ProjectTeamConfiguredAdmissionFacts = Object.freeze({
                  environmentId,
                  provider: Object.freeze({
                    instanceId: selected.instanceId,
                    driverKind: instance.driverKind,
                    enabled: instance.enabled,
                    ...measuredRuntime,
                    catalogue: fresh,
                  }),
                  supportedToolIds: Object.freeze(supportedToolIds),
                  ownedSkillIds: Object.freeze(selection.map((skill) => skill.skillId)),
                  git: Object.freeze(gitFacts),
                  rootAnchor:
                    rootAnchor._tag === "NewRoot"
                      ? Object.freeze(rootAnchor)
                      : Object.freeze({
                          ...rootAnchor,
                          budget: Object.freeze(rootAnchor.budget),
                          caps: Object.freeze(rootAnchor.caps),
                        }),
                });
                const finalSelection = yield* resolvePiManagedSkillSelection({
                  projectRoot: primaryRoot,
                  selectedSkillIds: selected.role.skills,
                  roleSkillIds: selected.role.skills,
                }).pipe(Effect.provideService(ManagedSkillRepository, skills));
                if (!equal(finalSelection, selection))
                  return yield* denied("Selected owned skills changed before publication");
                if (
                  (yield* command(primaryRoot, ["rev-parse", "--verify", "HEAD^{commit}"])) !==
                    baseOid ||
                  (yield* command(primaryRoot, ["symbolic-ref", "--quiet", "HEAD"])) !== baseRef
                )
                  return yield* denied("Current Git base changed before publication");
                yield* borrowed.assets.revalidate;
                yield* borrowed.assertCurrent;
                if (
                  (validateAuthority &&
                    !equal(yield* readCurrentState(sql, input.state.projectId), input.state)) ||
                  !equal(
                    (yield* settings.getSettings).providerInstances[selected.instanceId],
                    configured,
                  ) ||
                  (yield* registry.getInstance(selected.instanceId)) !== instance
                )
                  return yield* denied("Admission authority changed before publication");
                const finalCatalogue = yield* readCatalogueRow();
                const finalNow = clock.currentTimeMillisUnsafe();
                if (
                  !equal(finalCatalogue.row, stored.row) ||
                  Option.isNone(at) ||
                  finalNow < DateTime.toEpochMillis(at.value) ||
                  finalNow - DateTime.toEpochMillis(at.value) >= 86_400_000
                )
                  return yield* denied("Catalogue identity changed before publication");
                yield* Effect.try({
                  try: () => {
                    if (
                      !equal(paths.primary, physical(primaryRoot)) ||
                      !equal(common, physical(commonGitDirectory)) ||
                      !equal(candidate, physical(worktreePath, true)) ||
                      !equal(paths.protected, verifyRoots()) ||
                      !equal(gitMetadata, metadata(commonGitDirectory, baseRef))
                    )
                      reject("Physical Git or workspace policy changed before publication");
                  },
                  catch: () =>
                    denied("Physical Git or workspace policy changed before publication"),
                });
                return {
                  facts,
                  proof: digest({
                    facts,
                    providerConfiguration: configured,
                    skills: selection,
                    catalogue: stored.row,
                    protected: paths.protected,
                  }),
                };
              });
              const initial = yield* measure();
              originalRootAnchor = initial.facts.rootAnchor;
              const revalidate = (validateAuthority: boolean) =>
                Effect.gen(function* () {
                  const loan = Context.getOption(yield* Effect.context<never>(), AdmissionLoan);
                  if (Option.isNone(loan) || loan.value.token !== token)
                    return yield* denied("Admission revalidation belongs to another callback");
                  const current = yield* measure(validateAuthority);
                  if (current.proof !== initial.proof)
                    return yield* denied("Measured admission resources changed");
                }).pipe(
                  Effect.mapError((error) =>
                    isFactsError(error)
                      ? error
                      : denied("Admission resources could not be revalidated"),
                  ),
                );
              return yield* run(initial.facts, revalidate(true), revalidate(false)).pipe(
                Effect.exit,
                Effect.tap((exit) =>
                  Effect.sync(() => {
                    callbackExit = exit;
                  }),
                ),
                Effect.provideService(AdmissionLoan, { token }),
                Effect.ensuring(
                  Effect.sync(() => {
                    active = false;
                  }),
                ),
              );
            }),
          );
        }).pipe(
          Effect.mapError((error) =>
            isFactsError(error) ? error : denied("Actual admission resources are unavailable"),
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
    const read = Effect.fn("ProjectTeamAdmissionFacts.read")(function* (input: Input) {
      return yield* withCurrent(input, (facts) =>
        Effect.succeed({ _tag: "Facts" as const, facts }),
      ).pipe(
        Effect.catch((error) => Effect.succeed({ _tag: "Blocked" as const, reason: error.reason })),
      );
    });
    return { read, withCurrent };
  },
);
