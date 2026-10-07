import { EnvironmentId, canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import {
  makeProjectTeamDispatchJournal,
  readCompletedReviewCommand,
  ProjectTeamDispatchJournalError,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamReviewCompletionProposals } from "./ProjectTeamReviewCompletionProposals.ts";
import { makeProjectTeamSessionReceipts } from "./ProjectTeamSessionReceipts.ts";
import { projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";
const strict = { onExcessProperty: "error" } as const;
const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const fingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
const deny = (reason: string) => new ProjectTeamDispatchJournalError({ reason });
const CompletedReviewOptions = Schema.Struct({ environmentId: EnvironmentId });
const CompletedReviewInput = Schema.Struct({ dispatchId: Id, expectedProposalSha256: Digest });
const decodeCompletedReviewOptions = Schema.decodeUnknownSync(CompletedReviewOptions, strict);
const decodeCompletedReviewInput = Schema.decodeUnknownSync(CompletedReviewInput, strict);

/** Historical original settlement only; no claim, stage verifier or native callback is exposed. */
export const makeProjectTeamCompletedReviewReader = (
  supplied: typeof CompletedReviewOptions.Encoded,
) => {
  let captured: typeof CompletedReviewOptions.Type | undefined;
  try {
    captured = decodeCompletedReviewOptions(structuredClone(supplied));
  } catch {
    /* Deny inside the single returned effect. */
  }
  return Effect.gen(function* () {
    if (captured === undefined) return yield* deny("Invalid completed review environment");
    const environmentId = captured.environmentId;
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    // The historical path never consults dispatch admission limits or exposes a forward method.
    const history = yield* makeProjectTeamDispatchJournal({
      environmentId,
      maximumEnvironmentModelCalls: 1,
    });
    const proposals = yield* makeProjectTeamReviewCompletionProposals(() =>
      Effect.succeed(undefined),
    );
    const sessions = yield* makeProjectTeamSessionReceipts({
      environmentId,
      maximumEnvironmentModelCalls: 1,
    });
    const readInside = Effect.fn("ProjectTeamCompletedReviewReader.readInside")(function* (
      input: typeof CompletedReviewInput.Type,
    ) {
      const suppliedSql = yield* Effect.serviceOption(SqlClient.SqlClient);
      const suppliedRepository = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(suppliedSql) ||
        suppliedSql.value !== sql ||
        Option.isNone(suppliedRepository) ||
        suppliedRepository.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Completed review reads require their original caller transaction");
      const retained = yield* history.readHistoricalInTransaction(input.dispatchId);
      const snapshot = retained.snapshot;
      const transition = snapshot.intent.compiledClaim.transition;
      if (
        snapshot.fence.stage !== "settled" ||
        snapshot.fence.claimGeneration < 1 ||
        transition?.kind !== "claim"
      )
        return yield* deny("Review dispatch has no original joined settlement");
      const binding = transition.binding;
      const state = yield* readCurrentState(sql, binding.projectId);
      const roles =
        state.foundationRecords?.filter(
          (r) => r.kind === "role-revision" && r.recordId === binding.roleRevisionId,
        ) ?? [];
      if (roles.length !== 1 || roles[0]?.kind !== "role-revision" || roles[0].role !== "reviewer")
        return yield* deny("Original completed assignment is not a reviewer");
      const joined = retained.receipts.filter((r) => r.stage === "settled");
      if (joined.length !== 1 || !joined[0])
        return yield* deny("Original joined receipt is missing or ambiguous");
      const join = joined[0];
      const rows = yield* sql<{
        command_id: string;
      }>`SELECT command_id FROM project_team_review_completion_proposal
        WHERE environment_id=${environmentId} AND dispatch_id=${input.dispatchId} AND sha256=${input.expectedProposalSha256} LIMIT 2`;
      if (rows.length !== 1 || !rows[0])
        return yield* deny("Original completed review proposal is missing or ambiguous");
      const proposal = yield* proposals.readRetained({
        environmentId,
        projectId: binding.projectId,
        commandId: rows[0].command_id,
      });
      if (
        !proposal ||
        proposal.sha256 !== input.expectedProposalSha256 ||
        proposal.manifest.provenance.dispatchId !== input.dispatchId
      )
        return yield* deny("Original review proposal changed");
      const manifest = proposal.manifest;
      const reportIntent = manifest.report;
      if (reportIntent.type !== "project-team.assignment.report")
        return yield* deny("Retained completed review report kind changed");
      const assignment = yield* sessions.readAssignment(snapshot);
      if (
        !assignment ||
        assignment.operation.operationId !== manifest.operation.operationId ||
        assignment.requestHash !== manifest.assignmentRequestHash
      )
        return yield* deny("Original completed reviewer operation changed");
      const observed = join.evidence.operations;
      const owners = Array.isArray(observed)
        ? observed.filter(
            (value) =>
              value !== null &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              value.operationId === assignment.operation.operationId,
          )
        : [];
      const owner = owners[0];
      if (
        owners.length !== 1 ||
        !owner ||
        typeof owner !== "object" ||
        Array.isArray(owner) ||
        fingerprint(owner.owner) !== fingerprint(assignment.owner) ||
        join.evidence.version !== 1 ||
        join.evidence.dispatchId !== input.dispatchId ||
        join.evidence.bindingId !== binding.recordId ||
        join.evidence.generation !== binding.generation ||
        join.evidence.claimGeneration !== snapshot.fence.claimGeneration
      )
        return yield* deny("Original completed reviewer join ownership changed");
      const drain = owner.reconciliation;
      if (
        !drain ||
        typeof drain !== "object" ||
        Array.isArray(drain) ||
        drain.state !== "drained" ||
        drain.unit !== assignment.owner.unit ||
        drain.invocation !== assignment.owner.invocation ||
        drain.cgroup !== assignment.owner.cgroup ||
        typeof drain.kernel !== "string" ||
        (drain.kernel !== "removed" &&
          (!/^populated 0$/mu.test(drain.kernel) || /^populated 1$/mu.test(drain.kernel)))
      )
        return yield* deny("Original completed reviewer join drain changed");
      const commandId = projectTeamDerivedRecordId(join.receiptId, "joined-domain");
      const audit = yield* readCompletedReviewCommand({
        sql,
        projectId: binding.projectId,
        commandId,
        dispatchId: input.dispatchId,
        joinedReceiptId: join.receiptId,
        state,
        required: true,
        parentCriteria: [],
      });
      if (!audit) return yield* deny("Original review command is missing");
      const completed = audit.events.filter(
        (event) => event.type === "project-work.task.completed",
      );
      const reports = audit.events.filter(
        (event) =>
          event.type === "project-work.evidence.added" &&
          event.evidence.evidenceId === manifest.reportEvidenceId,
      );
      const comments = audit.events.filter(
        (event) =>
          event.type === "project-work.comment.added" &&
          event.comment.commentId === manifest.reportCommentId,
      );
      const settled = audit.events.filter(
        (event) =>
          event.type === "project-work.foundation.recorded" &&
          event.record.kind === "run-binding" &&
          event.record.recordId === binding.recordId &&
          event.record.status === "settled",
      );
      const completedTask = completed[0];
      const report = reports[0];
      const comment = comments[0];
      if (
        completed.length !== 1 ||
        completedTask?.type !== "project-work.task.completed" ||
        completedTask.taskId !== binding.taskId ||
        completedTask.attemptId !== binding.attemptId ||
        settled.length !== 1 ||
        reports.length !== 1 ||
        report?.type !== "project-work.evidence.added" ||
        report.evidence.taskId !== binding.taskId ||
        report.evidence.kind !== "observation" ||
        report.evidence.summary !== reportIntent.summary ||
        report.evidence.detail !== reportIntent.summary ||
        fingerprint(report.evidence.attribution) !== fingerprint(manifest.attribution) ||
        fingerprint(report.evidence.outputArtifactIds) !==
          fingerprint(reportIntent.outputArtifactIds) ||
        comments.length !== 1 ||
        comment?.type !== "project-work.comment.added" ||
        comment.comment.taskId !== binding.taskId ||
        comment.comment.body !== reportIntent.summary ||
        fingerprint(comment.comment.attribution) !== fingerprint(manifest.attribution)
      )
        return yield* deny("Joined command did not accept this exact completed review");
      for (const output of manifest.outputs) {
        const matches = audit.events.filter(
          (event) =>
            event.type === "project-work.evidence.added" &&
            event.evidence.evidenceId === output.evidenceId,
        );
        const event = matches[0];
        if (
          matches.length !== 1 ||
          event?.type !== "project-work.evidence.added" ||
          event.evidence.taskId !== binding.taskId ||
          event.evidence.criterionId !== output.criterionId ||
          !event.evidence.detail?.trim() ||
          fingerprint({
            criterionId: event.evidence.criterionId,
            kind: event.evidence.kind,
            summary: event.evidence.summary,
            detail: event.evidence.detail,
          }) !== output.sha256 ||
          fingerprint(event.evidence.attribution) !== fingerprint(manifest.attribution)
        )
          return yield* deny("Original completed review outputs changed");
      }
      return {
        snapshot,
        joined: join,
        proposal,
        commandId,
        commandFingerprint: audit.commandFingerprint,
        assignment,
      };
    });
    return {
      readInTransaction: (input: typeof CompletedReviewInput.Type) => {
        let owned: typeof CompletedReviewInput.Type | undefined;
        try {
          owned = decodeCompletedReviewInput(structuredClone(input));
        } catch {
          /* Deny without beginning a read. */
        }
        return Effect.gen(function* () {
          if (owned === undefined) return yield* deny("Invalid completed review identity");
          return yield* readInside(owned);
        });
      },
    };
  });
};
