import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectTeamCredential,
  ProjectTeamReviewFinding,
  ProjectTeamReviewFindingIntent,
  ProjectWorkActor,
  ProjectWorkAttribution,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectTeamAuthority, ProjectTeamPrincipal } from "./ProjectTeamAuthorization.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamReviewTargets } from "./ProjectTeamReviewTargets.ts";
import { makeProjectTeamReviewFreshness } from "./ProjectTeamReviewFreshness.ts";
import {
  evaluateReviewFindingTransition,
  evaluateReviewSessionEligibility,
} from "./ProjectTeamReview.ts";
import { assertProjectTeamSemanticWork } from "./ProjectTeamPolicy.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";

export class ProjectTeamReviewFindingsError extends Schema.TaggedError<ProjectTeamReviewFindingsError>()(
  "ProjectTeamReviewFindingsError",
  { reason: Schema.String },
) {}
const isFindingsError = Schema.is(ProjectTeamReviewFindingsError);
const deny = (reason: string) => new ProjectTeamReviewFindingsError({ reason });
const strict = { onExcessProperty: "error" } as const;
const Principal = Schema.Struct({
  actor: ProjectWorkActor,
  managed: Schema.optionalKey(ProjectTeamCredential),
});
const decodePrincipal = Schema.decodeUnknownSync(Principal, strict);
const decodeIntent = Schema.decodeUnknownSync(ProjectTeamReviewFindingIntent, strict);
const decodeAttribution = Schema.decodeUnknownSync(ProjectWorkAttribution, strict);
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamReviewFinding, strict);
const decodeCommand = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand, strict);
const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const exact = <A>(input: unknown, decode: (input: unknown) => A) => {
  const copy: unknown = structuredClone(input);
  const decoded = decode(copy);
  if (canonical(copy) !== canonical(decoded)) throw deny("Input changed during decoding");
  return decoded;
};

/** Compile only within the authenticated caller's transaction; this never captures a new target. */
export const makeProjectTeamReviewFindings = <E, R>(
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
        return yield* deny("Finding compilation requires its original caller transaction");
    });
    const compileInside = Effect.fn("ProjectTeamReviewFindings.compileInside")(function* (
      principal: ProjectTeamPrincipal,
      intent: ProjectTeamReviewFindingIntent,
      attribution: ProjectWorkAttribution,
      duplicate: boolean,
    ) {
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
        intent.projectId !== binding.projectId ||
        intent.taskId !== binding.taskId ||
        !task ||
        (!duplicate && intent.expectedRevision !== state.revision) ||
        intent.expectedTaskRevision !== task.revision ||
        intent.specRevision !== binding.specRevision ||
        intent.planRevision !== binding.planRevision ||
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
      const criteria = state.criteria
        .filter((c) => c.taskId === target.taskId)
        .map((c) => c.criterionId);
      if (
        intent.criterionIds.some(
          (id) => !manifest.criteria.some((criterion) => criterion.criterionId === id),
        )
      )
        return yield* deny("Finding criteria are outside the original review target");
      const recordId = `review-finding:${hash(["project-team.review-finding.v1", target.projectId, target.taskId, intent.findingId])}`;
      const matches = records.filter(
        (r) =>
          r.recordId === recordId ||
          (r.kind === "review-finding" &&
            r.taskId === target.taskId &&
            r.findingId === intent.findingId),
      );
      if (
        matches.length > 1 ||
        (matches[0] && (matches[0].kind !== "review-finding" || matches[0].recordId !== recordId))
      )
        return yield* deny("Finding identity conflicts with retained history");
      const current = matches[0]?.kind === "review-finding" ? decodeRecord(matches[0]) : undefined;
      if (current && canonical(current.target) !== canonical(target))
        return yield* deny("Original finding target changed");
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
      const proposed = decodeRecord({
        kind: "review-finding",
        projectId: target.projectId,
        taskId: target.taskId,
        recordId,
        revision: intent.revision,
        generation: 0,
        updatedAt: attribution.recordedAt,
        findingId: intent.findingId,
        severity: intent.severity,
        criterionIds: intent.criterionIds,
        detail: intent.detail,
        status: intent.status,
        resolutionArtifactIds: intent.resolutionArtifactIds,
        target,
        originReviewer: current?.originReviewer ?? provenance,
        reportedBy: provenance,
      });
      const decision = evaluateReviewFindingTransition({
        target,
        ...(current ? { currentFinding: current } : {}),
        proposedFinding: proposed,
        currentCriterionIds: criteria,
        retainedResolutionEvidence: [],
      });
      if (decision.status === "rejected")
        return yield* deny(`Finding transition denied: ${decision.reason}`);
      return decodeCommand({
        type: "project-work.foundation.commit",
        commandId: intent.commandId,
        projectId: intent.projectId,
        expectedRevision: intent.expectedRevision,
        attribution,
        committedAt: attribution.recordedAt,
        records: [decision.status === "duplicate" ? current! : proposed],
      });
    });
    const compile = Effect.fn("ProjectTeamReviewFindings.compile")(function* (
      principal: ProjectTeamPrincipal,
      intent: ProjectTeamReviewFindingIntent,
      attribution: ProjectWorkAttribution,
      duplicate: boolean,
    ) {
      yield* requireTransaction;
      // Bind only the checked client; preserve the caller's actual transaction connection.
      return yield* compileInside(principal, intent, attribution, duplicate).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    });
    return {
      compile: (
        principal: ProjectTeamPrincipal,
        intent: ProjectTeamReviewFindingIntent,
        attribution: ProjectWorkAttribution,
        duplicate: boolean,
      ) => {
        try {
          const owned = [
            exact(principal, decodePrincipal),
            exact(intent, decodeIntent),
            exact(attribution, decodeAttribution),
          ] as const;
          if (typeof duplicate !== "boolean") return Effect.fail(deny("Invalid duplicate marker"));
          return compile(...owned, duplicate).pipe(
            Effect.mapError((error) =>
              isFindingsError(error)
                ? error
                : deny("Finding authority, target, or retained proof is unavailable"),
            ),
          );
        } catch {
          return Effect.fail(deny("Invalid finding input"));
        }
      },
    };
  });
