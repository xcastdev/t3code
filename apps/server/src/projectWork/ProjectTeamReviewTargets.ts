import {
  canonicalProjectWorkPayload,
  ProjectTeamGate,
  ProjectTeamRunBinding,
  ProjectTeamRoleRevision,
  ProjectVerificationJobManifest,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import { makeProjectWorkVerificationJobs } from "./ProjectWorkVerificationJobs.ts";
import { makeProjectWorkVerificationGate } from "./ProjectWorkVerificationGate.ts";

const Id = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => !value.includes("\0")),
);
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Options = Schema.Struct({
  environmentId: Id,
  maximumEnvironmentModelCalls: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 128 })),
});
export const ProjectTeamReviewTarget = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: Id,
  dispatchId: Id,
  dispatchIntentHash: Digest,
  reviewer: Schema.Struct({
    taskId: Id,
    bindingId: Id,
    generation: Safe,
    initializeOperationId: Id,
  }),
  assignment: Schema.Struct({
    gateId: Id,
    parentTaskId: Id,
    specRevision: Safe,
    planRevision: Safe,
  }),
  verificationGate: ProjectTeamGate,
  prepared: Schema.Struct({
    manifest: ProjectVerificationJobManifest,
    sha256: Digest,
    taskRevision: Safe,
    bindingRevision: Safe,
  }),
});
export type ProjectTeamReviewTarget = typeof ProjectTeamReviewTarget.Type;
export class ProjectTeamReviewTargetError extends Schema.TaggedError<ProjectTeamReviewTargetError>()(
  "ProjectTeamReviewTargetError",
  { reason: Schema.String },
) {}
const deny = (reason: string) => new ProjectTeamReviewTargetError({ reason });
const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const decode = Schema.decodeUnknownSync(ProjectTeamReviewTarget, { onExcessProperty: "error" });
const PreparedIdentity = Schema.Struct({
  request: Schema.JsonObject,
  binding: ProjectTeamRunBinding,
  role: ProjectTeamRoleRevision,
  allocation: Schema.JsonObject,
  rootBudget: Schema.optionalKey(Schema.JsonObject),
  operationLimits: Schema.optionalKey(Schema.JsonObject),
  resourceHash: Schema.optionalKey(Digest),
});
const decodePreparedIdentity = Schema.decodeUnknownSync(Schema.fromJsonString(PreparedIdentity), {
  onExcessProperty: "error",
});
const decodeStoredTarget = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProjectTeamReviewTarget),
  { onExcessProperty: "error" },
);
const decodeOptions = Schema.decodeUnknownSync(Options, { onExcessProperty: "error" });
const isTargetError = Schema.is(ProjectTeamReviewTargetError);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const clone = <A>(value: A): A => structuredClone(value);

/** The context reader owns the transaction and its final COMMIT exposure boundary. */
export function makeProjectTeamReviewTargets(input: typeof Options.Type) {
  let capturedOptions: typeof Options.Type | undefined;
  try {
    capturedOptions = decodeOptions(clone(input));
  } catch {
    capturedOptions = undefined;
  }
  return Effect.gen(function* () {
    if (capturedOptions === undefined) return yield* deny("Invalid review environment");
    const options = capturedOptions;
    const sql = yield* SqlClient.SqlClient;
    const jobs = yield* makeProjectWorkVerificationJobs({ environmentId: options.environmentId });
    const gates = yield* makeProjectWorkVerificationGate(options);
    const journal = yield* makeProjectTeamDispatchJournal(options);
    const transaction = Effect.gen(function* () {
      if (
        (yield* SqlClient.SqlClient) !== sql ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Review targets require their original context transaction");
    });
    const resolve = Effect.fn("ProjectTeamReviewTargets.resolve")(function* (
      snapshot: ProjectTeamDispatchSnapshot,
    ) {
      yield* transaction;
      const original = yield* journal.inspect(snapshot.fence.dispatchId, { requireClaim: true });
      if (!same(original, snapshot)) return yield* deny("Original review dispatch changed");
      const claim = original.intent.compiledClaim.transition;
      if (claim?.kind !== "claim" || claim.binding.environmentId !== options.environmentId)
        return yield* deny("Original reviewer assignment is missing");
      const binding = claim.binding;
      const state = yield* readCurrentState(sql, binding.projectId);
      const records = state.foundationRecords ?? [];
      const roles = records.filter((r) => r.recordId === binding.roleRevisionId);
      if (roles.length !== 1 || roles[0]?.kind !== "role-revision" || roles[0].role !== "reviewer")
        return yield* deny("Original reviewer role is missing");
      const grants = records.filter((r) => r.recordId === binding.authorizationGateId);
      const grant = grants[0];
      const proof = grant?.kind === "gate" ? grant.assignmentAuthorization : undefined;
      if (
        grants.length !== 1 ||
        grant?.kind !== "gate" ||
        grant.gate !== "assignment" ||
        grant.status !== "consumed" ||
        grant.attribution.actor.kind !== "human" ||
        grant.consumedByRunId !== binding.recordId ||
        proof?.assignmentKind !== "review" ||
        proof.parentPlan === undefined
      )
        return yield* deny("Original consumed human review assignment is missing");
      return { original, binding, state, grant, proof, parentPlan: proof.parentPlan };
    });
    const read = Effect.fn("ProjectTeamReviewTargets.read")(function* (
      snapshot: ProjectTeamDispatchSnapshot,
    ) {
      const owner = yield* resolve(snapshot);
      const rows =
        yield* sql`SELECT environment_id,dispatch_id,project_id,binding_id,generation,dispatch_intent_hash,sha256,CASE WHEN length(CAST(manifest_json AS BLOB))<=131072 THEN manifest_json ELSE NULL END AS manifest_json FROM project_team_review_target WHERE environment_id=${options.environmentId} AND (dispatch_id=${snapshot.fence.dispatchId} OR (binding_id=${owner.binding.recordId} AND generation=${owner.binding.generation})) LIMIT 2`;
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) return yield* deny("Review target ownership is ambiguous");
      const row = rows[0]!;
      const retainedJson = row.manifest_json;
      if (typeof retainedJson !== "string" || Buffer.byteLength(retainedJson) > 131072)
        return yield* deny("Retained review target exceeds its bound");
      const target = yield* Effect.try({
        try: () => decodeStoredTarget(retainedJson),
        catch: () => deny("Retained review target is malformed"),
      });
      if (
        row.environment_id !== options.environmentId ||
        row.dispatch_id !== target.dispatchId ||
        row.project_id !== owner.binding.projectId ||
        row.binding_id !== target.reviewer.bindingId ||
        row.generation !== target.reviewer.generation ||
        row.dispatch_intent_hash !== target.dispatchIntentHash ||
        row.sha256 !== hash(target) ||
        row.manifest_json !== canonical(target)
      )
        return yield* deny("Retained review target owner or hash changed");
      yield* validate(owner, target);
      return target;
    });
    const validate = Effect.fn("ProjectTeamReviewTargets.validate")(function* (
      owner: Effect.Success<ReturnType<typeof resolve>>,
      target: ProjectTeamReviewTarget,
    ) {
      const { original, binding, state, grant, proof, parentPlan } = owner;
      if (
        target.environmentId !== options.environmentId ||
        target.dispatchId !== original.fence.dispatchId ||
        target.dispatchIntentHash !== hash(original.intent) ||
        target.reviewer.taskId !== binding.taskId ||
        target.reviewer.bindingId !== binding.recordId ||
        target.reviewer.generation !== binding.generation ||
        target.reviewer.initializeOperationId !== original.intent.request.initializeOperationId ||
        target.assignment.gateId !== grant.recordId ||
        target.assignment.parentTaskId !== proof.parentTaskId ||
        target.assignment.specRevision !== proof.parentSpecRevision ||
        target.assignment.planRevision !== parentPlan.planRevision
      )
        return yield* deny("Retained review assignment changed");
      const matches =
        state.foundationRecords?.filter((r) => r.recordId === target.verificationGate.recordId) ??
        [];
      const current = matches[0];
      const prior = target.verificationGate;
      if (
        matches.length !== 1 ||
        current?.kind !== "gate" ||
        current.gate !== "verification" ||
        current.attribution.actor.kind !== "human" ||
        (current.status !== "approved" && current.status !== "consumed")
      )
        return yield* deny("Original human verification approval changed");
      if (prior.status === "consumed" && (!prior.consumedByRunId || !prior.consumedByCommandId))
        return yield* deny("Original consumed approval lacks exact consumption identity");
      if (!same(current, prior)) {
        const {
          status: _s,
          revision: _r,
          updatedAt: _u,
          consumedByRunId: _run,
          consumedByCommandId: _cmd,
          ...unchanged
        } = current;
        const {
          status: _ps,
          revision: _pr,
          updatedAt: _pu,
          consumedByRunId: _prun,
          consumedByCommandId: _pcmd,
          ...originalContent
        } = prior;
        if (
          prior.status !== "approved" ||
          current.status !== "consumed" ||
          current.revision !== prior.revision + 1 ||
          !current.consumedByRunId ||
          !current.consumedByCommandId ||
          !same(unchanged, originalContent)
        )
          return yield* deny("Original verification approval was replaced");
      }
      const manifest = target.prepared.manifest;
      if (
        prior.taskId !== proof.parentTaskId ||
        prior.specRevision !== proof.parentSpecRevision ||
        prior.planRevision !== parentPlan.planRevision ||
        prior.verificationJobId !== manifest.jobId ||
        prior.contentHash !== target.prepared.sha256 ||
        manifest.taskId !== proof.parentTaskId ||
        manifest.specRevision !== proof.parentSpecRevision ||
        manifest.planRevision !== parentPlan.planRevision
      )
        return yield* deny("Original verification job does not match inherited review scope");
      const stored = yield* jobs.readPreparedInTransaction(manifest.jobId);
      if (!stored) return yield* deny("Original prepared verification job is missing");
      if (!same(stored, { manifest, sha256: target.prepared.sha256 }))
        return yield* deny("Original prepared verification job changed");
      yield* gates.assertCurrent(
        state,
        stored,
        {
          jobId: manifest.jobId,
          projectId: manifest.projectId,
          taskId: manifest.taskId,
          expectedRevision: state.revision,
          expectedTaskRevision: target.prepared.taskRevision,
          specRevision: manifest.specRevision,
          planRevision: manifest.planRevision,
          bindingId: manifest.bindingId,
          expectedBindingRevision: target.prepared.bindingRevision,
          generation: manifest.generation,
          criterionIds: manifest.criteria.map((r) => r.criterionId),
          command: manifest.command,
        },
        true,
      );
    });
    const capture = Effect.fn("ProjectTeamReviewTargets.capture")(function* (
      snapshot: ProjectTeamDispatchSnapshot,
    ) {
      const existing = yield* read(snapshot);
      if (existing) return existing;
      const owner = yield* resolve(snapshot);
      const { original, binding, state, grant, proof, parentPlan } = owner;
      const operations =
        yield* sql`SELECT * FROM project_team_pi_operation WHERE operation_id=${original.intent.request.initializeOperationId} OR (environment_id=${options.environmentId} AND (binding_id=${binding.recordId} OR (provider_instance_id=${binding.providerInstanceId} AND thread_id=${binding.threadId}))) LIMIT 2`;
      if (operations.length > 1) return yield* deny("Reviewer initialization history is ambiguous");
      const op = operations[0];
      if (
        op &&
        (op.operation_id !== original.intent.request.initializeOperationId ||
          op.environment_id !== options.environmentId ||
          op.project_id !== binding.projectId ||
          op.binding_id !== binding.recordId ||
          op.generation !== binding.generation ||
          op.provider_instance_id !== binding.providerInstanceId ||
          op.thread_id !== binding.threadId ||
          op.operation_kind !== "initialize" ||
          op.operation_ordinal !== 0 ||
          op.status !== "prepared" ||
          op.native_json !== null ||
          op.terminal_json !== null)
      )
        return yield* deny("An entered reviewer cannot acquire a target after initialization");
      if (op) {
        const preparedJson = op.intent_json;
        if (typeof preparedJson !== "string" || Buffer.byteLength(preparedJson) > 1048576)
          return yield* deny("Prepared reviewer identity exceeds its bound");
        const preparedIdentity = yield* Effect.try({
          try: () => decodePreparedIdentity(preparedJson),
          catch: () => deny("Prepared reviewer identity is malformed"),
        });
        const currentBindings =
          state.foundationRecords?.filter((r) => r.recordId === binding.recordId) ?? [];
        const currentRoles =
          state.foundationRecords?.filter((r) => r.recordId === binding.roleRevisionId) ?? [];
        const processes =
          yield* sql`SELECT unit,status,owner_json,drain_json,CASE WHEN length(CAST(allocation_json AS BLOB))<=262144 THEN allocation_json ELSE NULL END AS allocation_json FROM project_team_pi_process WHERE operation_id=${original.intent.request.initializeOperationId} LIMIT 2`;
        const process = processes[0];
        if (
          preparedIdentity.request.kind !== "initialize" ||
          preparedIdentity.request.operationId !== original.intent.request.initializeOperationId ||
          preparedIdentity.request.threadId !== binding.threadId ||
          op.request_hash !== hash(preparedIdentity.request) ||
          currentBindings.length !== 1 ||
          currentRoles.length !== 1 ||
          !same(preparedIdentity.binding, currentBindings[0]) ||
          !same(preparedIdentity.role, currentRoles[0]) ||
          op.intent_json !== canonical(preparedIdentity) ||
          processes.length !== 1 ||
          !process ||
          process.status !== "allocated" ||
          process.owner_json !== null ||
          process.drain_json !== null ||
          process.unit !== preparedIdentity.allocation.unit ||
          process.allocation_json !== canonical(preparedIdentity.allocation)
        )
          return yield* deny("Original prepared allocation is missing, replaced or has entered");
      }
      const approvals =
        state.foundationRecords?.filter(
          (r) =>
            r.kind === "gate" &&
            r.gate === "verification" &&
            r.taskId === proof.parentTaskId &&
            r.specRevision === proof.parentSpecRevision &&
            r.planRevision === parentPlan.planRevision &&
            (r.status === "approved" || r.status === "consumed") &&
            r.attribution.actor.kind === "human",
        ) ?? [];
      const approval = approvals[0];
      if (approvals.length !== 1 || approval?.kind !== "gate" || !approval.verificationJobId)
        return yield* deny(
          "The original review parent requires one exact human verification approval",
        );
      const prepared = yield* jobs.readPreparedInTransaction(approval.verificationJobId);
      if (!prepared) return yield* deny("Original prepared verification job is missing");
      const tasks = state.tasks.filter((t) => t.taskId === proof.parentTaskId);
      const implementations =
        state.foundationRecords?.filter((r) => r.recordId === prepared.manifest.bindingId) ?? [];
      const implementation = implementations[0];
      if (
        tasks.length !== 1 ||
        implementations.length !== 1 ||
        implementation?.kind !== "run-binding"
      )
        return yield* deny("Original implementation is missing or ambiguous");
      const target = yield* Effect.try({
        try: () =>
          decode({
            version: 1,
            environmentId: options.environmentId,
            dispatchId: original.fence.dispatchId,
            dispatchIntentHash: hash(original.intent),
            reviewer: {
              taskId: binding.taskId,
              bindingId: binding.recordId,
              generation: binding.generation,
              initializeOperationId: original.intent.request.initializeOperationId,
            },
            assignment: {
              gateId: grant.recordId,
              parentTaskId: proof.parentTaskId,
              specRevision: proof.parentSpecRevision,
              planRevision: parentPlan.planRevision,
            },
            verificationGate: approval,
            prepared: {
              ...prepared,
              taskRevision: tasks[0]!.revision,
              bindingRevision: implementation.revision,
            },
          }),
        catch: () => deny("Invalid original review target"),
      });
      yield* validate(owner, target);
      const json = canonical(target);
      if (Buffer.byteLength(json) > 131072)
        return yield* deny("Review target exceeds its retained UTF8 bound");
      yield* sql`INSERT INTO project_team_review_target (environment_id,dispatch_id,project_id,binding_id,generation,dispatch_intent_hash,manifest_json,sha256) VALUES (${options.environmentId},${target.dispatchId},${binding.projectId},${binding.recordId},${binding.generation},${target.dispatchIntentHash},${json},${hash(target)})`;
      const retained = yield* read(snapshot);
      if (!retained || !same(retained, target))
        return yield* deny("Original review target was not retained exactly");
      return retained;
    });
    const mapFailure = (error: unknown) =>
      isTargetError(error) ? error : deny("Review target authority or storage is unavailable");
    const captureInitial = (snapshot: ProjectTeamDispatchSnapshot) => {
      let owned: ProjectTeamDispatchSnapshot;
      try {
        owned = clone(snapshot);
      } catch {
        return Effect.fail(deny("Invalid original review snapshot"));
      }
      return capture(owned).pipe(Effect.mapError(mapFailure));
    };
    const readForDispatch = (snapshot: ProjectTeamDispatchSnapshot) => {
      let owned: ProjectTeamDispatchSnapshot;
      try {
        owned = clone(snapshot);
      } catch {
        return Effect.fail(deny("Invalid original review snapshot"));
      }
      return Effect.gen(function* () {
        const target = yield* read(owned);
        if (!target) return yield* deny("The original review target is missing");
        return target;
      }).pipe(Effect.mapError(mapFailure));
    };
    return { captureInitial, readForDispatch };
  });
}
