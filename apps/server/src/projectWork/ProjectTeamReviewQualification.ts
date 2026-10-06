import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectTeamCredential,
  ProjectWorkActor,
  ProjectWorkAttribution,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectTeamAuthority, ProjectTeamPrincipal } from "./ProjectTeamAuthorization.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamReviewTargets } from "./ProjectTeamReviewTargets.ts";
import { makeProjectTeamReviewFreshness } from "./ProjectTeamReviewFreshness.ts";
import { evaluateReviewSessionEligibility } from "./ProjectTeamReview.ts";
import { assertProjectTeamSemanticWork } from "./ProjectTeamPolicy.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";

export class ProjectTeamReviewQualificationError extends Schema.TaggedError<ProjectTeamReviewQualificationError>()(
  "ProjectTeamReviewQualificationError",
  { reason: Schema.String },
) {}
const deny = (reason: string) => new ProjectTeamReviewQualificationError({ reason });
const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const strict = { onExcessProperty: "error" } as const;
const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter((v) => v === v.trim()),
);
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Input = Schema.Struct({
  principal: Schema.Struct({
    actor: ProjectWorkActor,
    managed: Schema.optionalKey(ProjectTeamCredential),
  }),
  attribution: ProjectWorkAttribution,
  projectId: Id,
  reviewTaskId: Id,
  specRevision: Safe,
  planRevision: Safe,
  expectedTaskRevision: Safe,
  expectedProjectRevision: Schema.optionalKey(Safe),
  duplicate: Schema.Boolean,
});
const decodeInput = Schema.decodeUnknownSync(Input, strict);
export type ProjectTeamReviewQualificationInput = typeof Input.Type;

/** Reuse the original retained reviewer proof; never capture or refresh a review target. */
export const makeProjectTeamReviewQualification = <E, R>(
  resolveAuthority: (
    principal: ProjectTeamPrincipal,
  ) => Effect.Effect<ProjectTeamAuthority | undefined, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const requireTransaction = Effect.gen(function* () {
      const supplied = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (
        Option.isNone(supplied) ||
        supplied.value !== sql ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Reviewer qualification requires its original caller transaction");
    });
    const qualifyInside = Effect.fn("ProjectTeamReviewQualification.qualifyInside")(function* (
      input: ProjectTeamReviewQualificationInput,
    ) {
      const { principal, attribution } = input;
      const authority = yield* resolveAuthority(principal);
      if (
        !authority ||
        !principal.managed ||
        principal.actor.kind !== "agent" ||
        canonical(attribution.actor) !== canonical(principal.actor)
      )
        return yield* deny("A current authenticated managed reviewer is required");
      const { binding, role, state } = authority;
      if (
        role.role !== "reviewer" ||
        !role.tools.includes("project-work.report") ||
        !binding.configuration.toolIds.includes("project-work.report")
      )
        return yield* deny("The original reviewer lacks report capability");
      yield* Effect.try({
        try: () => assertProjectTeamSemanticWork(state, binding, role),
        catch: () => deny("Reviewer semantic assignment changed"),
      });
      const task = state.tasks.find((t) => t.taskId === binding.taskId);
      if (
        input.projectId !== binding.projectId ||
        input.reviewTaskId !== binding.taskId ||
        !task ||
        (!input.duplicate &&
          input.expectedProjectRevision !== undefined &&
          input.expectedProjectRevision !== state.revision) ||
        input.expectedTaskRevision !== task.revision ||
        input.specRevision !== binding.specRevision ||
        input.planRevision !== binding.planRevision ||
        !binding.sessionId
      )
        return yield* deny("Reviewer task or revisions changed");
      const environmentId = binding.environmentId;
      // 128 is the retained readers' decoding ceiling, not a reservation or budget grant.
      const readers = yield* Effect.gen(function* () {
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId,
          maximumEnvironmentModelCalls: 128,
        });
        const targets = yield* makeProjectTeamReviewTargets({
          environmentId,
          maximumEnvironmentModelCalls: 128,
        });
        const freshness = yield* makeProjectTeamReviewFreshness({ environmentId });
        return { journal, targets, freshness };
      }).pipe(Effect.provideService(ProjectWorkRepository, repository));
      const dispatches = yield* sql<{
        dispatchId: string;
      }>`SELECT dispatch_id AS dispatchId FROM project_team_dispatch WHERE environment_id=${environmentId} AND binding_id=${binding.recordId} AND generation=${binding.generation} LIMIT 2`;
      if (dispatches.length !== 1)
        return yield* deny("Original reviewer dispatch is missing or ambiguous");
      const original = yield* readers.journal.inspect(dispatches[0]!.dispatchId, {
        requireClaim: true,
      });
      const retained = yield* readers.targets.readForDispatch(original);
      const fresh = yield* readers.freshness.readForSessionInTransaction({
        projectId: binding.projectId,
        taskId: binding.taskId,
        bindingId: binding.recordId,
        generation: binding.generation,
        providerInstanceId: binding.providerInstanceId,
        threadId: binding.threadId,
        sessionId: binding.sessionId,
        specRevision: binding.specRevision,
        planRevision: binding.planRevision,
      });
      if (
        fresh.operationId !== original.intent.request.initializeOperationId ||
        fresh.operationId !== retained.reviewer.initializeOperationId ||
        retained.reviewer.bindingId !== binding.recordId ||
        retained.reviewer.generation !== binding.generation
      )
        return yield* deny("Original reviewer initialization changed");
      const manifest = retained.prepared.manifest;
      const target = {
        projectId: manifest.projectId,
        taskId: manifest.taskId,
        specRevision: manifest.specRevision,
        planRevision: manifest.planRevision,
        baseSha: manifest.target.baseSha,
        headSha: manifest.target.headSha,
      };
      const identity = {
        memberId: binding.memberId,
        runId: binding.recordId,
        threadId: binding.threadId,
        providerInstanceId: binding.providerInstanceId,
        sessionId: fresh.native.sessionId,
      };
      const records = state.foundationRecords ?? [];
      const history = records.filter((r) => r.kind === "run-binding" && r.taskId === target.taskId);
      for (const prior of history) {
        if (prior.kind !== "run-binding") continue;
        const roles = records.filter((r) => r.recordId === prior.roleRevisionId);
        if (roles.length !== 1 || roles[0]?.kind !== "role-revision")
          return yield* deny("Historical implementation role is missing or ambiguous");
      }
      const implementers = history.filter(
        (r) =>
          r.kind === "run-binding" &&
          records.some(
            (role) =>
              role.kind === "role-revision" &&
              role.recordId === r.roleRevisionId &&
              (role.role === "implementer" || role.role === "integrator"),
          ),
      );
      if (implementers.length > 256)
        return yield* deny("Implementation history exceeds the independence bound");
      for (const prior of implementers) {
        if (prior.kind !== "run-binding") continue;
        if (
          prior.memberId === identity.memberId ||
          prior.recordId === identity.runId ||
          prior.threadId === identity.threadId ||
          (prior.sessionId !== undefined &&
            prior.providerInstanceId === identity.providerInstanceId &&
            prior.sessionId === identity.sessionId)
        )
          return yield* deny("Reviewer overlaps retained implementation history");
      }
      const eligibility = evaluateReviewSessionEligibility({
        target,
        reviewer: { target, identity },
        implementers: implementers.flatMap((r) =>
          r.kind === "run-binding" && r.sessionId !== undefined
            ? [
                {
                  memberId: r.memberId,
                  runId: r.recordId,
                  threadId: r.threadId,
                  providerInstanceId: r.providerInstanceId,
                  sessionId: r.sessionId,
                },
              ]
            : [],
        ),
        sessionObservation: {
          identity,
          fresh: true,
          resumed: false,
          conversationHistoryPresent: false,
        },
      });
      if (eligibility.status !== "eligible")
        return yield* deny(`Reviewer independence denied: ${eligibility.reason}`);
      const provenance = {
        reviewTaskId: binding.taskId,
        bindingId: binding.recordId,
        generation: binding.generation,
        memberId: binding.memberId,
        providerInstanceId: binding.providerInstanceId,
        threadId: binding.threadId,
        sessionId: fresh.native.sessionId,
        initializeOperationId: fresh.operationId,
        dispatchId: original.fence.dispatchId,
        targetSha256: hash(retained),
      };
      return { authority, original, retained, fresh, target, identity, provenance };
    });
    const qualify = Effect.fn("ProjectTeamReviewQualification.qualify")(function* (
      input: ProjectTeamReviewQualificationInput,
    ) {
      yield* requireTransaction;
      return yield* qualifyInside(input).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    });
    return {
      qualify: (input: ProjectTeamReviewQualificationInput) => {
        try {
          const copy: unknown = structuredClone(input);
          const owned = decodeInput(copy);
          if (canonical(copy) !== canonical(owned))
            return Effect.fail(deny("Qualification input changed during decoding"));
          return qualify(owned);
        } catch {
          return Effect.fail(deny("Invalid reviewer qualification input"));
        }
      },
    };
  });
