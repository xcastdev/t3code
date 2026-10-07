import {
  canonicalProjectWorkPayload,
  ProjectTeamReviewFinding,
  ProjectTeamReviewFindingProvenance,
  ProjectTeamReviewResolutionProof,
  ProjectWorkCriterion,
  ProjectWorkAttribution,
  ProjectWorkEvidence,
  ProjectWorkWriteResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import {
  makeProjectTeamReviewTargets,
  ProjectTeamReviewTarget,
} from "./ProjectTeamReviewTargets.ts";
import { makeProjectWorkVerificationResultReader } from "./ProjectWorkVerificationExecutionJournal.ts";
import {
  REVIEW_FINDING_RESOLUTION_MAX_EVENTS,
  REVIEW_FINDING_RESOLUTION_MAX_FINDING_BYTES,
  REVIEW_FINDING_RESOLUTION_MAX_EVENT_BYTES,
  readReviewFindingResolutionEvidence,
  reviewFindingResolutionHash,
} from "./ProjectTeamReviewResolutionRecords.ts";

const canonical = canonicalProjectWorkPayload;
const hash = reviewFindingResolutionHash;
const strict = { onExcessProperty: "error" } as const;
const Id = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter((v) => !v.includes("\0")),
);
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Options = Schema.Struct({ environmentId: Id });
const Qualify = Schema.Struct({
  originalFinding: Schema.optionalKey(ProjectTeamReviewFinding),
  proposedFinding: ProjectTeamReviewFinding,
  qualifiedReviewTarget: ProjectTeamReviewTarget,
  provenance: ProjectTeamReviewFindingProvenance,
});
const Read = Schema.Struct({
  findingRecordId: Id,
  expectedFindingRevision: Safe,
  expectedFindingSha256: Digest,
});
const decodeOptions = Schema.decodeUnknownSync(Options, strict);
const decodeQualify = Schema.decodeUnknownSync(Qualify, strict);
const decodeRead = Schema.decodeUnknownSync(Read, strict);
const decodeProof = Schema.decodeUnknownSync(ProjectTeamReviewResolutionProof, strict);
const EventId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter((v) => !v.includes("\0")),
);
const EventBase = { eventId: EventId, projectId: Id, revision: Safe, occurredAt: Schema.String };
const Event = Schema.Union([
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("project-work.foundation.recorded"),
    record: ProjectTeamReviewFinding,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("project-work.evidence.added"),
    evidence: ProjectWorkEvidence,
    addedAt: Schema.String,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("project-work.criterion.upserted"),
    taskId: Id,
    criterion: ProjectWorkCriterion,
    updatedAt: Schema.String,
  }),
]);
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(Event), strict);
const decodePriorEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ...EventBase,
      type: Schema.Literal("project-work.foundation.recorded"),
      record: ProjectTeamReviewFinding,
    }),
  ),
  strict,
);
const decodeStoredFinding = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamReviewFinding),
  strict,
);
const decodeStoredAttribution = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkAttribution),
  strict,
);
const decodeWrite = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkWriteResult),
  strict,
);
const decodeEventIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(EventId).check(Schema.isMaxLength(REVIEW_FINDING_RESOLUTION_MAX_EVENTS)),
  ),
  strict,
);
const decodeIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Id).check(Schema.isMaxLength(REVIEW_FINDING_RESOLUTION_MAX_EVENTS)),
  ),
  strict,
);
export class ProjectTeamReviewResolutionError extends Schema.TaggedError<ProjectTeamReviewResolutionError>()(
  "ProjectTeamReviewResolutionError",
  { reason: Schema.String },
) {}
const deny = (reason: string) => new ProjectTeamReviewResolutionError({ reason });
function capture<A>(value: unknown, decode: (input: unknown) => A): A {
  const owned: unknown = structuredClone(value);
  const result = decode(owned);
  if (canonical(owned) !== canonical(result))
    throw deny("Resolution input changed during decoding");
  return result;
}
const approvalContent = (gate: ProjectTeamReviewTarget["verificationGate"]) => {
  const {
    status: _status,
    revision: _revision,
    updatedAt: _at,
    consumedByRunId: _run,
    consumedByCommandId: _command,
    ...content
  } = gate;
  return content;
};

const makeStorage = (environmentId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const targets = yield* makeProjectTeamReviewTargets({
      environmentId,
      maximumEnvironmentModelCalls: 128,
    });
    const results = yield* makeProjectWorkVerificationResultReader({ environmentId });
    const caller = Effect.gen(function* () {
      const supplied = yield* Effect.serviceOption(SqlClient.SqlClient);
      const suppliedRepository = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(supplied) ||
        supplied.value !== sql ||
        Option.isNone(suppliedRepository) ||
        suppliedRepository.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny(
          "Resolution requires its original SQL, repository and caller transaction",
        );
    });
    const verify = Effect.fn("ReviewResolution.verify")(function* (
      target: ProjectTeamReviewTarget,
      finding: ProjectTeamReviewFinding,
    ) {
      const prepared = target.prepared;
      const manifest = prepared.manifest;
      const retained = yield* results.readInTransaction({
        jobId: manifest.jobId,
        expectedManifestHash: prepared.sha256,
      });
      if (
        retained._tag !== "Terminal" ||
        retained.result.outcome !== "success" ||
        retained.result.exitCode !== 0
      )
        return yield* deny("Resolution requires an intact successful terminal verification result");
      const { snapshot, result } = retained;
      const approval = snapshot.intent.gate;
      const reviewApproval = target.verificationGate;
      if (
        canonical(snapshot.intent.receipt) !== canonical({ manifest, sha256: prepared.sha256 }) ||
        approval.status !== "approved" ||
        approval.attribution.actor.kind !== "human" ||
        approval.recordId !== reviewApproval.recordId ||
        canonical(approvalContent(approval)) !== canonical(approvalContent(reviewApproval)) ||
        (reviewApproval.status === "consumed" &&
          (reviewApproval.revision !== approval.revision + 1 ||
            reviewApproval.consumedByRunId !== snapshot.attemptId ||
            !reviewApproval.consumedByCommandId)) ||
        (reviewApproval.status === "approved" && canonical(reviewApproval) !== canonical(approval))
      )
        return yield* deny("Resolution verification approval or prepared target changed");
      const artifacts = finding.resolutionArtifactIds.map((id) =>
        [result.stdout, result.stderr].find((a) => a.artifactId === id),
      );
      if (
        artifacts.length < 1 ||
        artifacts.length > 2 ||
        new Set(finding.resolutionArtifactIds).size !== artifacts.length ||
        artifacts.some((a) => a === undefined)
      )
        return yield* deny("Resolution artifacts are not the exact retained verification outputs");
      return {
        retained,
        artifacts: artifacts.flatMap((a) =>
          a ? [{ artifactId: a.artifactId, sha256: a.sha256, byteCount: a.byteCount }] : [],
        ),
      };
    });
    return { sql, repository, targets, caller, verify };
  });

/** Host-only proof of an explicit independent reviewer judgment; the caller owns current qualification. */
export function makeProjectTeamReviewResolution(input: typeof Options.Type) {
  let options: typeof Options.Type | undefined;
  try {
    options = capture(input, decodeOptions);
  } catch {
    options = undefined;
  }
  return Effect.gen(function* () {
    if (!options) return yield* deny("Invalid resolution environment");
    const environmentId = options.environmentId;
    const storage = yield* makeStorage(environmentId);
    const qualifyInside = Effect.fn("ReviewResolution.qualifyInside")(function* (
      input: typeof Qualify.Type,
    ) {
      yield* storage.caller;
      const { proposedFinding: finding, originalFinding: prior, provenance } = input;
      const target = yield* storage.targets.readHistoricalAssociation({ provenance });
      if (
        canonical(target) !== canonical(input.qualifiedReviewTarget) ||
        hash(target) !== provenance.targetSha256 ||
        canonical(finding.reportedBy) !== canonical(provenance) ||
        finding.status !== "resolved" ||
        finding.projectId !== target.prepared.manifest.projectId ||
        finding.taskId !== target.assignment.parentTaskId ||
        finding.target.specRevision !== target.assignment.specRevision ||
        finding.target.planRevision !== target.assignment.planRevision ||
        (prior
          ? finding.recordId !== prior.recordId ||
            finding.revision !== prior.revision + 1 ||
            canonical(finding.target) !== canonical(prior.target) ||
            canonical(finding.originReviewer) !== canonical(prior.originReviewer)
          : finding.revision !== 0 || canonical(finding.originReviewer) !== canonical(provenance))
      )
        return yield* deny(
          "Resolution judgment does not match its qualified reviewer and original finding",
        );
      const { retained, artifacts } = yield* storage.verify(target, finding);
      return yield* Effect.try({
        try: () =>
          decodeProof({
            version: 1,
            environmentId,
            ...(prior ? { prior: { revision: prior.revision, sha256: hash(prior) } } : {}),
            target: {
              projectId: finding.projectId,
              taskId: finding.taskId,
              specRevision: target.prepared.manifest.specRevision,
              planRevision: target.prepared.manifest.planRevision,
              baseSha: target.prepared.manifest.target.baseSha,
              headSha: target.prepared.manifest.target.headSha,
            },
            reviewTargetSha256: hash(target),
            jobId: target.prepared.manifest.jobId,
            manifestHash: target.prepared.sha256,
            attemptId: retained.snapshot.attemptId,
            resultHash: retained.metadata.resultHash,
            artifacts,
          }),
        catch: () => deny("Resolution proof exceeds its strict bound"),
      });
    });
    return {
      qualifyInTransaction(input: typeof Qualify.Type) {
        let owned: typeof Qualify.Type | undefined;
        try {
          owned = capture(input, decodeQualify);
        } catch {
          owned = undefined;
        }
        return Effect.gen(function* () {
          if (!owned) return yield* deny("Invalid resolution judgment");
          return yield* qualifyInside(owned);
        });
      },
    };
  });
}

/** Historical audit only: retained resolution receipts confer no forward review or execution authority. */
export function makeProjectTeamReviewResolutionReader(input: typeof Options.Type) {
  let options: typeof Options.Type | undefined;
  try {
    options = capture(input, decodeOptions);
  } catch {
    options = undefined;
  }
  return Effect.gen(function* () {
    if (!options) return yield* deny("Invalid resolution reader environment");
    const environmentId = options.environmentId;
    const storage = yield* makeStorage(environmentId);
    const { sql } = storage;
    const readInside = Effect.fn("ReviewResolution.readInside")(function* (
      input: typeof Read.Type,
    ) {
      yield* storage.caller;
      const rows = yield* sql<{
        project_id: string;
        payload_json: string;
      }>`SELECT project_id,CASE WHEN length(CAST(payload_json AS BLOB))<=${REVIEW_FINDING_RESOLUTION_MAX_FINDING_BYTES} THEN payload_json ELSE NULL END AS payload_json FROM project_team_review_finding WHERE record_id=${input.findingRecordId} LIMIT 2`;
      if (rows.length === 0) return undefined;
      if (rows.length !== 1 || !rows[0] || typeof rows[0].payload_json !== "string")
        return yield* deny("Retained finding is missing, ambiguous or oversized");
      const storedFinding = yield* decodeStoredFinding(rows[0].payload_json);
      const state = yield* readCurrentState(sql, rows[0].project_id);
      const matches =
        state.foundationRecords?.filter((r) => r.recordId === input.findingRecordId) ?? [];
      const finding = matches[0];
      if (
        matches.length !== 1 ||
        finding?.kind !== "review-finding" ||
        finding.revision !== input.expectedFindingRevision ||
        hash(finding) !== input.expectedFindingSha256 ||
        canonical(storedFinding) !== canonical(finding)
      )
        return yield* deny("Retained resolution finding projection changed");
      if (finding.status === "open") return undefined;
      const association = readReviewFindingResolutionEvidence({ state, finding });
      if (!association)
        return yield* deny("Resolved finding has no unique retained producer receipt");
      const { evidence, detail } = association;
      const proof = detail.proof;
      if (proof.environmentId !== environmentId)
        return yield* deny("Resolution belongs to another environment");
      const commands =
        yield* sql`SELECT actor_kind,actor_id,source_kind,source_id,payload_fingerprint,created_at,CASE WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json ELSE NULL END AS result_json,CASE WHEN length(CAST(event_ids_json AS BLOB))<=1048576 THEN event_ids_json ELSE NULL END AS event_ids_json FROM project_work_command_receipts WHERE project_id=${finding.projectId} AND command_id=${detail.commandId} LIMIT 2`;
      const command = commands[0];
      if (
        commands.length !== 1 ||
        !command ||
        typeof command.result_json !== "string" ||
        Buffer.byteLength(command.result_json) > 262144 ||
        typeof command.event_ids_json !== "string" ||
        Buffer.byteLength(command.event_ids_json) > 1048576
      )
        return yield* deny("Original resolution command receipt is missing or oversized");
      const retainedRows =
        yield* sql`SELECT event_id,project_id,event_type,command_id,CASE WHEN length(CAST(payload_json AS BLOB))<=${REVIEW_FINDING_RESOLUTION_MAX_EVENT_BYTES} THEN payload_json ELSE NULL END AS payload_json FROM project_work_events WHERE project_id=${finding.projectId} AND command_id=${detail.commandId} ORDER BY sequence LIMIT ${REVIEW_FINDING_RESOLUTION_MAX_EVENTS + 1}`;
      if (retainedRows.length < 2 || retainedRows.length > REVIEW_FINDING_RESOLUTION_MAX_EVENTS)
        return yield* deny("Original resolution event count is invalid");
      const events = yield* Effect.forEach(
        retainedRows,
        Effect.fn("ReviewResolution.decodeRetainedEvent")(function* (row) {
          if (typeof row.payload_json !== "string")
            return yield* deny("Original resolution event is oversized");
          return yield* decodeEvent(row.payload_json);
        }),
      );
      const result = yield* decodeWrite(command.result_json);
      const ids = yield* decodeEventIds(command.event_ids_json);
      const first = events[0]!;
      const second = events[1]!;
      const last = events.at(-1)!;
      const actor = detail.reportAttribution.actor;
      const source = detail.reportAttribution.source;
      if (
        command.actor_kind !== actor.kind ||
        command.actor_id !== actor.id ||
        command.source_kind !== source.kind ||
        command.source_id !== source.id ||
        actor.kind !== "agent" ||
        source.kind !== "mcp" ||
        source.id !== "project-work.report" ||
        actor.id !==
          `agent:mcp:${finding.reportedBy.providerInstanceId}:${finding.reportedBy.threadId}`
      )
        return yield* deny("Resolution command reporter attribution changed");
      if (
        typeof command.payload_fingerprint !== "string" ||
        !/^project-team-intent:[a-f0-9]{64}$/u.test(command.payload_fingerprint)
      )
        return yield* deny("Resolution command fingerprint is invalid");
      if (
        command.created_at !== finding.updatedAt ||
        detail.reportAttribution.recordedAt !== finding.updatedAt
      )
        return yield* deny("Resolution command timestamp changed");
      if (
        first.type !== "project-work.foundation.recorded" ||
        canonical(first.record) !== canonical(finding) ||
        second.type !== "project-work.evidence.added" ||
        canonical(second.evidence) !== canonical(evidence) ||
        second.addedAt !== finding.updatedAt ||
        events.slice(2).some((e) => e.type !== "project-work.criterion.upserted")
      )
        return yield* deny("Resolution primary finding and evidence events changed");
      if (
        events.some(
          (event, i) =>
            event.projectId !== finding.projectId ||
            event.revision !== first.revision + i ||
            event.occurredAt !== finding.updatedAt ||
            retainedRows[i]?.event_id !== event.eventId ||
            retainedRows[i]?.event_type !== event.type ||
            retainedRows[i]?.command_id !== detail.commandId,
        )
      )
        return yield* deny("Resolution event metadata or order changed");
      if (
        new Set(ids).size !== ids.length ||
        canonical(ids) !== canonical(events.map((e) => e.eventId))
      )
        return yield* deny("Resolution command event identifiers changed");
      if (
        result.projectId !== finding.projectId ||
        result.revision !== last.revision ||
        result.receipt.projectId !== finding.projectId ||
        result.receipt.commandId !== detail.commandId ||
        result.receipt.status !== "accepted" ||
        result.receipt.revision !== last.revision ||
        result.receipt.eventCount !== events.length ||
        result.delta.projectId !== finding.projectId ||
        result.delta.revision !== last.revision ||
        canonical(result.delta.eventIds) !== canonical(ids.slice(0, 64)) ||
        canonical(result.delta.changedFields) !==
          canonical(["foundationRecords", "evidence", "criteria", "tasks"])
      )
        return yield* deny("Resolution command result or delta changed");
      const evidenceRows =
        yield* sql`SELECT * FROM project_work_evidence WHERE evidence_id=${evidence.evidenceId} LIMIT 2`;
      const physical = evidenceRows[0];
      if (
        !physical ||
        typeof physical.attribution_json !== "string" ||
        typeof physical.output_artifact_ids_json !== "string"
      )
        return yield* deny("Resolution evidence metadata is missing");
      const physicalAttribution = yield* decodeStoredAttribution(physical.attribution_json);
      const physicalArtifacts = yield* decodeIds(physical.output_artifact_ids_json);
      if (
        evidenceRows.length !== 1 ||
        !physical ||
        physical.project_id !== finding.projectId ||
        physical.task_id !== finding.taskId ||
        physical.detail !== evidence.detail ||
        physical.revision !== evidence.revision ||
        physical.kind !== evidence.kind ||
        physical.summary !== evidence.summary ||
        physical.recorded_at !== evidence.recordedAt ||
        physical.criterion_id !== null ||
        physical.uri !== null ||
        physical.scope_hash !== null ||
        canonical(physicalAttribution) !== canonical(evidence.attribution) ||
        canonical(physicalArtifacts) !== canonical(evidence.outputArtifactIds)
      )
        return yield* deny("Resolution evidence projection changed");
      if (proof.prior) {
        const priors =
          yield* sql`SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=${REVIEW_FINDING_RESOLUTION_MAX_EVENT_BYTES} THEN payload_json ELSE NULL END AS payload_json FROM project_work_events WHERE project_id=${finding.projectId} AND event_type='project-work.foundation.recorded' AND json_extract(payload_json,'$.record.recordId')=${finding.recordId} AND sequence<(SELECT sequence FROM project_work_events WHERE event_id=${first.eventId}) ORDER BY sequence DESC LIMIT 1`;
        const priorRow = priors[0];
        if (!priorRow || typeof priorRow.payload_json !== "string")
          return yield* deny("Resolution prior finding is missing or oversized");
        const original = yield* decodePriorEvent(priorRow.payload_json);
        if (
          original.record.revision !== proof.prior.revision ||
          hash(original.record) !== proof.prior.sha256 ||
          canonical(original.record.target) !== canonical(finding.target) ||
          canonical(original.record.originReviewer) !== canonical(finding.originReviewer)
        )
          return yield* deny("Resolution prior finding changed");
      } else if (finding.revision !== 0)
        return yield* deny("Resolution lacks its original finding revision");
      const target = yield* storage.targets.readHistoricalAssociation({
        provenance: finding.reportedBy,
      });
      if (
        hash(target) !== proof.reviewTargetSha256 ||
        target.prepared.manifest.jobId !== proof.jobId ||
        target.prepared.sha256 !== proof.manifestHash ||
        canonical(proof.target) !==
          canonical({
            projectId: finding.projectId,
            taskId: finding.taskId,
            specRevision: target.prepared.manifest.specRevision,
            planRevision: target.prepared.manifest.planRevision,
            baseSha: target.prepared.manifest.target.baseSha,
            headSha: target.prepared.manifest.target.headSha,
          })
      )
        return yield* deny("Resolution reporter target changed");
      const { retained, artifacts } = yield* storage.verify(target, finding);
      if (
        retained.snapshot.attemptId !== proof.attemptId ||
        retained.metadata.resultHash !== proof.resultHash ||
        canonical(artifacts) !== canonical(proof.artifacts)
      )
        return yield* deny("Resolution result or raw artifact identities changed");
      return { finding, evidence, detail, target };
    });
    return {
      readInTransaction(input: typeof Read.Type) {
        let owned: typeof Read.Type | undefined;
        try {
          owned = capture(input, decodeRead);
        } catch {
          owned = undefined;
        }
        return Effect.gen(function* () {
          if (!owned) return yield* deny("Invalid historical resolution request");
          return yield* readInside(owned);
        });
      },
    };
  });
}
