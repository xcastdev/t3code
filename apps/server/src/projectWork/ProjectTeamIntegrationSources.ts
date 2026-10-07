import {
  canonicalProjectWorkPayload,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectTeamIntegrationSource,
  ProjectTeamIntegrationSourceRef,
  ProjectTeamIntegrationSourceRefs,
  ProjectTeamIntegrationSources,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export { staleIntegrationTaskIds } from "./ProjectTeamIntegrationSourceState.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { makeProjectTeamCompletedReviewReader } from "./ProjectTeamReviewCompleted.ts";
import { makeProjectWorkVerificationResultReader } from "./ProjectWorkVerificationExecutionJournal.ts";

const strict = { onExcessProperty: "error" } as const;
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Options = Schema.Struct({ environmentId: EnvironmentId });
const Owner = { projectId: ProjectId, integrationTaskId: ProjectWorkTaskId };
const CompileInput = Schema.Struct({ ...Owner, refs: ProjectTeamIntegrationSourceRefs });
const CurrentInput = Schema.Struct({ ...Owner, sources: ProjectTeamIntegrationSources });
const PageInput = Schema.Struct({
  ...Owner,
  offset: Safe,
  limit: Safe.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
});
const decodeOptions = Schema.decodeUnknownSync(Options, strict);
const decodeCompile = Schema.decodeUnknownSync(CompileInput, strict);
const decodeCurrent = Schema.decodeUnknownSync(CurrentInput, strict);
const decodePage = Schema.decodeUnknownSync(PageInput, strict);
const decodeRef = Schema.decodeUnknownSync(ProjectTeamIntegrationSourceRef, strict);
const decodeSources = Schema.decodeUnknownSync(ProjectTeamIntegrationSources, strict);
const canonical = canonicalProjectWorkPayload;
import {
  makeProjectTeamReviewedWorkReader,
  ProjectTeamIntegrationSourcesError,
} from "./ProjectTeamReviewedWorkReader.ts";
export { ProjectTeamIntegrationSourcesError } from "./ProjectTeamReviewedWorkReader.ts";
const isSourceError = Schema.is(Schema.suspend(() => ProjectTeamIntegrationSourcesError));
const deny = (reason: string, code: ProjectTeamIntegrationSourcesError["code"] = "ineligible") =>
  new ProjectTeamIntegrationSourcesError({ code, reason });
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      isSourceError(error)
        ? error
        : deny("Integration source history is unavailable", "unavailable"),
    ),
  );
function capture<A>(decode: (input: unknown) => A, input: unknown): A {
  const copy: unknown = structuredClone(input);
  const value = decode(copy);
  if (canonical(value) !== canonical(copy))
    throw deny("Integration source identity changed during decoding", "invalid");
  return value;
}

/** SQL-qualified reviewed commits; only the owned Git consumer can establish current physical source identity. */
export const makeProjectTeamIntegrationSources = (input: typeof Options.Encoded) => {
  let captured: typeof Options.Type | undefined;
  try {
    captured = capture(decodeOptions, input);
  } catch {
    /* Deny in the single returned effect. */
  }
  return Effect.gen(function* () {
    if (!captured) return yield* deny("Invalid integration source environment", "invalid");
    const environmentId = captured.environmentId;
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const reviews = yield* makeProjectTeamCompletedReviewReader({ environmentId });
    const results = yield* makeProjectWorkVerificationResultReader({ environmentId });
    const caller = Effect.gen(function* () {
      const client = yield* Effect.serviceOption(SqlClient.SqlClient);
      const supplied = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(client) ||
        client.value !== sql ||
        Option.isNone(supplied) ||
        supplied.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny(
          "Integration sources require their original SQL, repository and caller transaction",
          "invalid",
        );
    });
    const owner = Effect.fn("ProjectTeamIntegrationSources.owner")(function* (input: {
      readonly projectId: ProjectId;
      readonly integrationTaskId: ProjectWorkTaskId;
    }) {
      yield* caller;
      const state = yield* readCurrentState(sql, input.projectId);
      const tasks = state.tasks.filter(
        (task) => task.taskId === input.integrationTaskId && task.projectId === input.projectId,
      );
      const memberships =
        state.foundationRecords?.filter(
          (record) =>
            record.kind === "task-membership" && record.taskId === input.integrationTaskId,
        ) ?? [];
      if (
        tasks.length !== 1 ||
        tasks[0]?.state === "completed" ||
        tasks[0]?.state === "canceled" ||
        tasks[0]?.state === "failed" ||
        memberships.length !== 1 ||
        memberships[0]?.kind !== "task-membership" ||
        memberships[0].executionKind !== "managed" ||
        memberships[0].deliverableKind !== "code"
      )
        return yield* deny("Integration selection requires its own current managed code task");
      return state;
    });
    const reviewed = yield* makeProjectTeamReviewedWorkReader({ environmentId });
    const compile = Effect.fn("ProjectTeamIntegrationSources.compile")(function* (
      input: typeof CompileInput.Type,
    ) {
      yield* owner(input);
      return yield* reviewed.withCurrentInTransaction({ projectId: input.projectId }, (read) =>
        Effect.gen(function* () {
          if (input.refs.some((ref) => ref.taskId === input.integrationTaskId))
            return yield* deny("An integration task cannot select itself");
          const selected = yield* Effect.forEach(input.refs, (ref) => read(ref));
          return yield* Effect.try({
            try: () =>
              decodeSources({
                version: 1,
                environmentId,
                sources: selected.map((entry) => entry.source),
              }),
            catch: () => deny("Frozen integration sources exceed their bounds", "invalid"),
          });
        }),
      );
    });
    const page = Effect.fn("ProjectTeamIntegrationSources.candidates")(function* (
      input: typeof PageInput.Type,
    ) {
      const state = yield* owner(input);
      return yield* reviewed.withCurrentInTransaction({ projectId: input.projectId }, (read) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            dispatch_id: string;
            sha256: string;
            review_task_id: string;
          }>`SELECT dispatch_id,sha256,review_task_id FROM project_team_review_completion_proposal
        WHERE environment_id=${environmentId} AND project_id=${input.projectId} AND parent_task_id<>${input.integrationTaskId}
        ORDER BY parent_task_id,dispatch_id,command_id LIMIT ${input.limit + 1} OFFSET ${input.offset}`;
          const candidates: Array<{
            ref: ProjectTeamIntegrationSourceRef;
            source: ProjectTeamIntegrationSource;
            taskTitle: string;
          }> = [];
          for (const row of rows.slice(0, input.limit)) {
            if (
              !state.tasks.some(
                (task) => task.taskId === row.review_task_id && task.state === "completed",
              )
            )
              continue;
            const review = yield* reviews.readInTransaction({
              dispatchId: row.dispatch_id,
              expectedProposalSha256: row.sha256,
            });
            const retained = yield* results.readInTransaction({
              jobId: review.proposal.manifest.prepared.jobId,
              expectedManifestHash: review.proposal.manifest.prepared.sha256,
            });
            if (retained._tag !== "Terminal" || retained.result.outcome !== "success") continue;
            const job = retained.snapshot.intent.receipt.manifest;
            const bindings =
              state.foundationRecords?.filter(
                (record) => record.kind === "run-binding" && record.recordId === job.bindingId,
              ) ?? [];
            if (bindings.length !== 1 || bindings[0]?.kind !== "run-binding") continue;
            const binding = bindings[0];
            const ref = yield* Effect.try({
              try: () =>
                decodeRef({
                  taskId: job.taskId,
                  bindingId: job.bindingId,
                  expectedBindingRevision: binding.revision,
                  generation: job.generation,
                  reviewDispatchId: row.dispatch_id,
                  expectedReviewProposalSha256: row.sha256,
                  verificationJobId: job.jobId,
                  expectedManifestHash: retained.snapshot.intent.receipt.sha256,
                  expectedBranchRef: job.target.branchRef,
                  expectedBaseSha: job.target.baseSha,
                  expectedHeadSha: job.target.headSha,
                  expectedTestedTree: job.target.testedTree,
                }),
              catch: () => deny("Candidate source references exceed their bounds", "invalid"),
            });
            const eligible = yield* read(ref).pipe(Effect.result);
            if (eligible._tag === "Failure") {
              if (isSourceError(eligible.failure) && eligible.failure.code === "ineligible")
                continue;
              return yield* Effect.fail(eligible.failure);
            }
            if (!candidates.some((candidate) => candidate.ref.taskId === ref.taskId))
              candidates.push({ ref, ...eligible.success });
          }
          const scanned = Math.min(input.limit, rows.length);
          if (!Number.isSafeInteger(input.offset + scanned))
            return yield* deny("Integration source continuation is exhausted", "invalid");
          return {
            candidates,
            nextOffset: input.offset + scanned,
            hasMore: rows.length > input.limit,
          };
        }),
      );
    });
    return {
      candidatesInTransaction(input: typeof PageInput.Type) {
        let owned: typeof PageInput.Type | undefined;
        try {
          owned = capture(decodePage, input);
        } catch {}
        return boundary(
          Effect.gen(function* () {
            if (!owned) return yield* deny("Invalid source page", "invalid");
            return yield* page(owned);
          }),
        );
      },
      compileInTransaction(input: typeof CompileInput.Type) {
        let owned: typeof CompileInput.Type | undefined;
        try {
          owned = capture(decodeCompile, input);
        } catch {}
        return boundary(
          Effect.gen(function* () {
            if (!owned) return yield* deny("Invalid source selection", "invalid");
            return yield* compile(owned);
          }),
        );
      },
      assertCurrentInTransaction(input: typeof CurrentInput.Type) {
        let owned: typeof CurrentInput.Type | undefined;
        try {
          owned = capture(decodeCurrent, input);
        } catch {}
        return boundary(
          Effect.gen(function* () {
            if (!owned || owned.sources.environmentId !== environmentId)
              return yield* deny("Invalid retained source owner", "invalid");
            const refs = yield* Effect.try({
              try: () =>
                owned.sources.sources.map((source) =>
                  decodeRef({
                    taskId: source.taskId,
                    bindingId: source.bindingId,
                    expectedBindingRevision: source.bindingRevision,
                    generation: source.generation,
                    reviewDispatchId: source.reviewDispatchId,
                    expectedReviewProposalSha256: source.reviewProposalSha256,
                    verificationJobId: source.jobId,
                    expectedManifestHash: source.manifestHash,
                    expectedBranchRef: source.branchRef,
                    expectedBaseSha: source.baseSha,
                    expectedHeadSha: source.headSha,
                    expectedTestedTree: source.testedTree,
                  }),
                ),
              catch: () => deny("Stored source references exceed their bounds", "invalid"),
            });
            const current = yield* compile({
              projectId: owned.projectId,
              integrationTaskId: owned.integrationTaskId,
              refs,
            });
            if (canonical(current) !== canonical(owned.sources))
              return yield* deny("Retained integration sources changed");
          }),
        );
      },
    };
  });
};
