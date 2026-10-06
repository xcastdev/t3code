import {
  canonicalProjectWorkPayload,
  GitCommandError,
  ProjectId,
  ProjectTeamCredential,
  ProjectVerificationCommandSelection,
  ProjectVerificationJobManifest,
  ProjectWorkActor,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ManagedGit from "../git/ManagedGitExecution.ts";
import type { ProjectTeamPrincipal } from "./ProjectTeamAuthorization.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamWorkspaceReceipt,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";
import { projectTeamPlanHash, projectTeamSpecificationHash } from "./ProjectTeamPolicy.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { makeProjectWorkVerificationJobs } from "./ProjectWorkVerificationJobs.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import { withProjectWorkVerificationExecutable } from "./ProjectWorkVerificationExecutable.ts";

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Revision = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const ProjectWorkVerificationPreparationSelection = Schema.Struct({
  jobId: Id,
  projectId: ProjectId.check(Schema.isMaxLength(256)),
  taskId: ProjectWorkTaskId.check(Schema.isMaxLength(256)),
  expectedRevision: Revision,
  expectedTaskRevision: Revision,
  specRevision: Revision,
  planRevision: Revision,
  bindingId: Id,
  expectedBindingRevision: Revision,
  generation: Revision,
  criterionIds: Schema.Array(ProjectWorkCriterionId.check(Schema.isMaxLength(256))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
  command: ProjectVerificationCommandSelection,
});
type Selection = typeof ProjectWorkVerificationPreparationSelection.Type;
type Binding = Extract<ProjectTeamRecord, { kind: "run-binding" }>;
type Receipt = { readonly manifest: ProjectVerificationJobManifest; readonly sha256: string };
type Workspace = {
  readonly receipt: typeof ProjectTeamWorkspaceReceipt.Type;
  readonly cwd: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly testedCommit: string;
  readonly testedTree: string;
};
type Original = {
  readonly snapshot: ProjectTeamDispatchSnapshot;
  readonly receipt: typeof ProjectTeamWorkspaceReceipt.Type;
};
type Fingerprint = {
  readonly executableTarget: string;
  readonly sha256: string;
  readonly runtimeClosureSha256: string;
};

export class ProjectWorkVerificationPreparationError extends Schema.TaggedError<ProjectWorkVerificationPreparationError>()(
  "ProjectWorkVerificationPreparationError",
  { reason: Schema.String },
) {}
const decodeEnvironmentId = Schema.decodeUnknownEffect(Id);
const isPreparationError = Schema.is(ProjectWorkVerificationPreparationError);
const deny = (reason: string) => new ProjectWorkVerificationPreparationError({ reason });
interface Options {
  readonly environmentId: string;
  readonly maximumEnvironmentModelCalls: number;
  readonly assertHumanCurrent: (
    principal: ProjectTeamPrincipal,
    projectId: Selection["projectId"],
  ) => Effect.Effect<void, ProjectWorkVerificationPreparationError>;
  readonly captureWorkspace: (
    original: Original,
    use: (workspace: Workspace) => Effect.Effect<Receipt, ProjectWorkVerificationPreparationError>,
    revalidate: Effect.Effect<void, ProjectWorkVerificationPreparationError>,
  ) => Effect.Effect<Receipt, ProjectWorkVerificationPreparationError>;
  readonly captureExecutable: (
    binding: Binding,
    command: Selection["command"],
    use: (
      fingerprint: Fingerprint,
    ) => Effect.Effect<Receipt, ProjectWorkVerificationPreparationError>,
    revalidate: Effect.Effect<void, ProjectWorkVerificationPreparationError>,
  ) => Effect.Effect<Receipt, ProjectWorkVerificationPreparationError>;
  readonly retainPrepared: (
    manifest: ProjectVerificationJobManifest,
  ) => Effect.Effect<Receipt, ProjectWorkVerificationPreparationError>;
}
const strict = { onExcessProperty: "error" as const };
const decodeSelection = Schema.decodeUnknownSync(
  ProjectWorkVerificationPreparationSelection,
  strict,
);
const decodePrincipal = Schema.decodeUnknownSync(
  Schema.Struct({ actor: ProjectWorkActor, managed: Schema.optionalKey(ProjectTeamCredential) }),
  strict,
);
const decodeManifest = Schema.decodeUnknownSync(ProjectVerificationJobManifest, strict);
const decodeWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamWorkspaceReceipt),
  strict,
);
const decodeWorkspaceRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      dispatch_id: Id,
      environment_id: Id,
      binding_id: Id,
      generation: Revision,
      claim_generation: Revision,
      assignment_json: Schema.String,
      receipt_json: Schema.String,
    }),
  ).check(Schema.isMaxLength(1)),
  strict,
);
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
const same = (left: unknown, right: unknown) =>
  canonicalProjectWorkPayload(left) === canonicalProjectWorkPayload(right);
const freeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
function capture<A>(decode: (input: unknown) => A, input: unknown) {
  const owned: unknown = structuredClone(input);
  const decoded = decode(owned);
  if (!same(owned, decoded)) throw deny("Preparation input must match its exact decoded values");
  return freeze(decoded);
}

/** Root supplies scoped physical captures and current human permission. Retention
 * alone creates no gate, approval, process or qualification. */
export function makeProjectWorkVerificationPreparation(supplied: Options) {
  const options = Object.freeze({ ...supplied });
  return Effect.gen(function* () {
    yield* decodeEnvironmentId(options.environmentId);
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* makeProjectTeamDispatchJournal(options);
    const assertTransactionOwner = Effect.gen(function* () {
      const current = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isSome(current) && current.value !== sql)
        return yield* deny("Preparation must use its captured SQL client");
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* deny("Preparation cannot capture caller-owned uncommitted work");
    });
    const inspect = Effect.fn("ProjectWorkVerificationPreparation.inspect")(function* (
      selection: Selection,
      principal: ProjectTeamPrincipal,
    ) {
      yield* assertTransactionOwner;
      if (principal.actor.kind !== "human" || principal.managed !== undefined)
        return yield* deny("Only an authenticated human can prepare verification");
      yield* options.assertHumanCurrent(principal, selection.projectId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const state = yield* readCurrentState(sql, selection.projectId);
          const task = state.tasks.find((row) => row.taskId === selection.taskId);
          if (
            state.revision !== selection.expectedRevision ||
            !task ||
            task.projectId !== selection.projectId ||
            task.revision !== selection.expectedTaskRevision ||
            task.specRevision !== selection.specRevision ||
            !task.specification ||
            task.specification.revision !== selection.specRevision ||
            task.state === "draft" ||
            task.state === "canceled" ||
            task.state === "completed"
          )
            return yield* deny("Task, approval or specification changed");
          const records = state.foundationRecords ?? [];
          const bindings = records.filter(
            (row): row is Binding =>
              row.kind === "run-binding" && row.recordId === selection.bindingId,
          );
          const binding = bindings[0];
          if (
            bindings.length !== 1 ||
            !binding ||
            binding.projectId !== selection.projectId ||
            binding.environmentId !== options.environmentId ||
            binding.taskId !== selection.taskId ||
            binding.status !== "settled" ||
            binding.revision !== selection.expectedBindingRevision ||
            binding.generation !== selection.generation ||
            binding.leaseGeneration !== selection.generation ||
            binding.specRevision !== selection.specRevision ||
            binding.planRevision !== selection.planRevision
          )
            return yield* deny("Selected settled implementation changed");
          const roles = records.filter(
            (row) => row.kind === "role-revision" && row.recordId === binding.roleRevisionId,
          );
          if (
            roles.length !== 1 ||
            roles[0]?.kind !== "role-revision" ||
            roles[0].role !== "implementer"
          )
            return yield* deny("Original implementation role is missing or ambiguous");
          const plans = records.filter(
            (row) =>
              row.kind === "plan-revision" &&
              row.taskId === selection.taskId &&
              row.status === "proposed",
          );
          const selectedPlans = plans.filter(
            (row) =>
              row.kind === "plan-revision" &&
              row.specRevision === selection.specRevision &&
              row.planRevision === selection.planRevision,
          );
          const plan = selectedPlans[0];
          if (
            selectedPlans.length !== 1 ||
            plan?.kind !== "plan-revision" ||
            plans.some(
              (row) => row.kind === "plan-revision" && row.planRevision > selection.planRevision,
            ) ||
            plan.contentHash !== projectTeamPlanHash(plan)
          )
            return yield* deny("Approved implementation plan changed");
          const specificationHash = projectTeamSpecificationHash(state, selection.taskId);
          for (const [kind, contentHash, planRevision] of [
            ["specification", specificationHash, 0],
            ["plan", plan.contentHash, selection.planRevision],
          ] as const) {
            const gates = records.filter(
              (row) =>
                row.kind === "gate" &&
                row.taskId === selection.taskId &&
                row.gate === kind &&
                row.specRevision === selection.specRevision &&
                row.planRevision === planRevision &&
                row.contentHash === contentHash &&
                (row.status === "approved" || row.status === "consumed"),
            );
            if (
              gates.length !== 1 ||
              gates[0]?.kind !== "gate" ||
              gates[0].attribution.actor.kind !== "human"
            )
              return yield* deny("Human specification or plan approval changed");
          }
          const criteria = selection.criterionIds.map((criterionId) =>
            state.criteria.filter(
              (row) => row.criterionId === criterionId && row.taskId === selection.taskId,
            ),
          );
          if (criteria.some((rows) => rows.length !== 1))
            return yield* deny("Selected verification criteria changed");
          const rows = yield* sql<{
            dispatch_id: string;
            stage: string;
          }>`SELECT dispatch_id,stage FROM project_team_dispatch
        WHERE environment_id=${options.environmentId} AND project_id=${selection.projectId} AND task_id=${selection.taskId}
        AND binding_id=${selection.bindingId} AND generation=${selection.generation} LIMIT 2`;
          if (rows.length !== 1 || rows[0]?.stage !== "settled")
            return yield* deny("Original settled dispatch is missing or ambiguous");
          const snapshot = yield* journal.readRetained(rows[0].dispatch_id);
          const transition = snapshot.intent.compiledClaim.transition;
          if (snapshot.fence.stage !== "settled" || transition?.kind !== "claim")
            return yield* deny("Original implementation dispatch changed");
          const original = transition.binding;
          for (const key of [
            "recordId",
            "projectId",
            "taskId",
            "attemptId",
            "generation",
            "leaseGeneration",
            "memberId",
            "roleRevisionId",
            "providerInstanceId",
            "threadId",
            "environmentId",
            "model",
            "configuration",
            "worktree",
            "branch",
            "specRevision",
            "planRevision",
          ] as const)
            if (!same(original[key], binding[key]))
              return yield* deny("Retained implementation identity changed");
          const workspaceRows =
            yield* sql`SELECT dispatch_id,environment_id,binding_id,generation,claim_generation,
        CASE WHEN length(CAST(assignment_json AS BLOB)) <= 262144 THEN assignment_json END AS assignment_json,
        CASE WHEN length(CAST(receipt_json AS BLOB)) <= 262144 THEN receipt_json END AS receipt_json
        FROM project_team_workspace_receipt WHERE dispatch_id=${snapshot.fence.dispatchId} LIMIT 2`;
          const decoded = yield* decodeWorkspaceRows(workspaceRows);
          const row = decoded[0];
          const assignment = snapshot.intent.request.git;
          if (
            !row ||
            row.dispatch_id !== snapshot.fence.dispatchId ||
            row.environment_id !== options.environmentId ||
            row.binding_id !== binding.recordId ||
            row.generation !== binding.generation ||
            row.claim_generation !== snapshot.fence.claimGeneration ||
            row.assignment_json !== canonicalProjectWorkPayload(assignment)
          )
            return yield* deny("Original workspace receipt changed");
          const receipt = yield* decodeWorkspace(row.receipt_json);
          if (
            !same(receipt.assignment, assignment) ||
            row.receipt_json !== canonicalProjectWorkPayload(receipt)
          )
            return yield* deny("Original workspace receipt contradicts the retained assignment");
          return freeze({
            binding: structuredClone(binding),
            snapshot,
            receipt,
            specificationHash,
            planHash: plan.contentHash,
            criteria: criteria.map((rows) => ({
              criterionId: rows[0]!.criterionId,
              revision: rows[0]!.revision,
            })),
          });
        }),
      );
    });
    const prepare = (input: Selection, caller: ProjectTeamPrincipal) => {
      let selection: Selection;
      let principal: ProjectTeamPrincipal;
      try {
        selection = capture(decodeSelection, input);
        principal = capture(decodePrincipal, caller);
      } catch {
        return Effect.fail(deny("Invalid verification preparation input"));
      }
      return Effect.gen(function* () {
        const original = yield* inspect(selection, principal);
        const revalidate = inspect(selection, principal).pipe(
          Effect.flatMap((current) =>
            same(current, original)
              ? Effect.void
              : Effect.fail(deny("Verification preparation target changed")),
          ),
          Effect.mapError(() => deny("Verification preparation could not be revalidated")),
        );
        const prepared = yield* options.captureWorkspace(
          original,
          (workspace) =>
            Effect.gen(function* () {
              yield* revalidate;
              if (
                !same(workspace.receipt, original.receipt) ||
                workspace.cwd !== original.receipt.assignment.worktreePath ||
                workspace.baseSha !== original.receipt.assignment.baseOid
              )
                return yield* deny("Host workspace capture belongs to a different implementation");
              return yield* options.captureExecutable(
                original.binding,
                selection.command,
                (fingerprint) =>
                  Effect.gen(function* () {
                    yield* revalidate;
                    const manifest = yield* Effect.try({
                      try: () =>
                        capture(decodeManifest, {
                          version: 1,
                          jobId: selection.jobId,
                          environmentId: options.environmentId,
                          projectId: selection.projectId,
                          taskId: selection.taskId,
                          specRevision: selection.specRevision,
                          specificationHash: original.specificationHash,
                          planRevision: selection.planRevision,
                          planHash: original.planHash,
                          criteria: original.criteria,
                          dispatchId: original.snapshot.fence.dispatchId,
                          bindingId: original.binding.recordId,
                          generation: original.binding.generation,
                          workspaceReceiptHash: hash(original.receipt),
                          command: selection.command,
                          target: {
                            repository: original.receipt.assignment.primaryRoot,
                            worktree: workspace.cwd,
                            branchRef: original.receipt.assignment.branchRef,
                            baseSha: workspace.baseSha,
                            headSha: workspace.headSha,
                            testedCommit: workspace.testedCommit,
                            testedTree: workspace.testedTree,
                            workspaceState: "clean-committed",
                          },
                          executable: {
                            target: fingerprint.executableTarget,
                            sha256: fingerprint.sha256,
                            runtimeClosureSha256: fingerprint.runtimeClosureSha256,
                          },
                        }),
                      catch: () =>
                        deny("Host capture does not form an exact verification manifest"),
                    });
                    const retained = yield* options.retainPrepared(manifest);
                    if (!same(retained.manifest, manifest) || retained.sha256 !== hash(manifest))
                      return yield* deny("Prepared retention returned a different manifest");
                    yield* revalidate;
                    return freeze({ manifest, sha256: retained.sha256 });
                  }),
                revalidate,
              );
            }),
          revalidate,
        );
        yield* revalidate;
        return prepared;
      });
    };
    return { prepare };
  });
}

/** Uses original Git ownership and already published assets. It never prepares
 * a runtime, creates a worktree, or runs the selected verification command. */
export const makeProjectWorkVerificationPreparationRoot = Effect.fn(
  "makeProjectWorkVerificationPreparationRoot",
)(function* (options: Omit<Options, "captureWorkspace" | "captureExecutable" | "retainPrepared">) {
  const jobs = yield* makeProjectWorkVerificationJobs({ environmentId: options.environmentId });
  const workflow = yield* GitWorkflowService;
  const pi = yield* ProjectTeamPiRuntime;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const provideHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessPlatform, platform),
    );
  const translate = (reason: string) => (error: unknown) =>
    isPreparationError(error) ? error : deny(reason);
  return yield* makeProjectWorkVerificationPreparation({
    ...options,
    retainPrepared: (manifest) =>
      jobs
        .retainPrepared(manifest)
        .pipe(Effect.mapError(translate("Prepared verification retention failed"))),
    captureWorkspace: (original, use, revalidate) =>
      workflow
        .withRepositoryPermit(
          "verification.capture",
          original.receipt.assignment.primaryRoot,
          Effect.gen(function* () {
            const assignment = original.snapshot.intent.request.git;
            const changed = () =>
              new GitCommandError({
                operation: "ProjectWorkVerificationPreparation",
                command: "/usr/bin/git",
                cwd: assignment.worktreePath,
                detail: "Verification preparation permission or ownership is unavailable",
              });
            const context = yield* ManagedGit.make({
              assignment,
              priorReceipt: original.receipt,
              revalidate: revalidate.pipe(Effect.mapError(changed)),
              persistWorkspace: () => Effect.fail(changed()),
            });
            return yield* ManagedGit.withManagedVerificationTarget(context, use);
          }).pipe(Effect.scoped, provideHost),
        )
        .pipe(Effect.mapError(translate("Host verification workspace capture failed"))),
    captureExecutable: (binding, command, use, revalidate) =>
      pi
        .withInstance(binding.providerInstanceId, (instance) =>
          revalidate.pipe(
            Effect.andThen(instance.assertCurrent),
            Effect.andThen(
              withProjectWorkVerificationExecutable(
                instance.assets,
                command.executable,
                (fingerprint) =>
                  revalidate.pipe(
                    Effect.andThen(instance.assertCurrent),
                    Effect.andThen(Effect.suspend(() => use(fingerprint))),
                  ),
              ),
            ),
            Effect.tap(() => instance.assertCurrent),
            Effect.tap(() => revalidate),
          ),
        )
        .pipe(
          provideHost,
          Effect.mapError(translate("Published verification executable capture failed")),
        ),
  });
});
