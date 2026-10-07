import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectTeamCredential,
  ProjectTeamReviewFinding,
  ProjectTeamReviewFindingIntent,
  type ProjectTeamReviewResolutionProof,
  ProjectWorkActor,
  ProjectWorkAttribution,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectTeamAuthority, ProjectTeamPrincipal } from "./ProjectTeamAuthorization.ts";
import { evaluateReviewFindingTransition } from "./ProjectTeamReview.ts";
import {
  makeProjectTeamReviewResolution,
  makeProjectTeamReviewResolutionReader,
} from "./ProjectTeamReviewResolution.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { makeProjectTeamReviewQualification } from "./ProjectTeamReviewQualification.ts";

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
    const qualification = yield* makeProjectTeamReviewQualification(resolveAuthority);
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
      const { authority, retained, target, provenance } = yield* qualification.qualify({
        principal,
        attribution,
        projectId: intent.projectId,
        reviewTaskId: intent.taskId,
        specRevision: intent.specRevision,
        planRevision: intent.planRevision,
        expectedTaskRevision: intent.expectedTaskRevision,
        expectedProjectRevision: intent.expectedRevision,
        duplicate,
      });
      const { state } = authority;
      const manifest = retained.prepared.manifest;
      const records = state.foundationRecords ?? [];
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
      if (
        current &&
        intent.status !== "resolved" &&
        canonical(current.target) !== canonical(target)
      )
        return yield* deny("Original finding target changed");
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
        target: current?.target ?? target,
        originReviewer: current?.originReviewer ?? provenance,
        reportedBy: provenance,
      });
      let resolutionProof: ProjectTeamReviewResolutionProof | undefined;
      if (proposed.status === "resolved") {
        if (current?.status === "resolved" && current.revision === proposed.revision) {
          const reader = yield* makeProjectTeamReviewResolutionReader({
            environmentId: retained.environmentId,
          }).pipe(Effect.provideService(ProjectWorkRepository, repository));
          const association = yield* reader.readInTransaction({
            findingRecordId: current.recordId,
            expectedFindingRevision: current.revision,
            expectedFindingSha256: hash(current),
          });
          if (!association || canonical(current.reportedBy) !== canonical(provenance))
            return yield* deny(
              "Resolution replay requires its original qualified reporter and retained receipt",
            );
          resolutionProof = association.detail.proof;
        } else {
          const resolutions = yield* makeProjectTeamReviewResolution({
            environmentId: retained.environmentId,
          }).pipe(Effect.provideService(ProjectWorkRepository, repository));
          resolutionProof = yield* resolutions.qualifyInTransaction({
            ...(current ? { originalFinding: current } : {}),
            proposedFinding: proposed,
            qualifiedReviewTarget: retained,
            provenance,
          });
        }
      }
      const proof = resolutionProof;
      const decision = evaluateReviewFindingTransition({
        target,
        ...(current ? { currentFinding: current } : {}),
        proposedFinding: proposed,
        currentCriterionIds: criteria,
        retainedResolutionEvidence: proof
          ? proof.artifacts.map((a) => ({
              artifactId: a.artifactId,
              target: proof.target,
              findings: [{ findingId: proposed.findingId, revision: proposed.revision }],
            }))
          : [],
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
        records: resolutionProof ? [] : [decision.status === "duplicate" ? current! : proposed],
        ...(resolutionProof
          ? {
              transition: {
                kind: "review.resolve",
                finding: decision.status === "duplicate" ? current! : proposed,
                proof: resolutionProof,
              },
            }
          : {}),
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
