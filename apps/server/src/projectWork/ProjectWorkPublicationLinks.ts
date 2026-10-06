import {
  canonicalProjectWorkPayload,
  CommandId,
  ProjectTeamEffect,
  ProjectTeamRunBinding,
  ProjectWorkPublicationRequest,
  ProjectWorkPublicationOutcome,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { linkCreatedPullRequest } from "../git/linkCreatedPullRequest.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import {
  capturePublicationRequest,
  publicationRequestHash,
} from "./github/ProjectWorkGitHubOutbox.ts";

export class PublicationLinkError extends Schema.TaggedError<PublicationLinkError>()(
  "PublicationLinkError",
  {
    reason: Schema.Literals(["invalid-record", "persistence", "inherited-transaction"]),
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}
export type LinkResult =
  | { readonly status: "attempted" }
  | {
      readonly status: "skipped";
      readonly reason:
        | "missing-operation"
        | "not-confirmed"
        | "no-thread"
        | "missing-thread"
        | "missing-project"
        | "unbound-thread";
    };
export interface RecoveryCounts {
  readonly observed: number;
  readonly attempted: number;
  readonly skipped: number;
  readonly failed: number;
}
export class ProjectWorkPublicationLinks extends Context.Service<
  ProjectWorkPublicationLinks,
  {
    readonly link: (operationId: string) => Effect.Effect<LinkResult, PublicationLinkError>;
    readonly recoverAll: () => Effect.Effect<RecoveryCounts, PublicationLinkError>;
  }
>()("t3/projectWork/ProjectWorkPublicationLinks") {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEffect = Schema.decodeUnknownEffect(ProjectTeamEffect, { onExcessProperty: "error" });
const decodeOutcome = Schema.decodeUnknownEffect(ProjectWorkPublicationOutcome, {
  onExcessProperty: "error",
});
const isBinding = Schema.is(ProjectTeamRunBinding);
const isRequest = Schema.is(ProjectWorkPublicationRequest);
const isLinkError = Schema.is(PublicationLinkError);
const invalid = () => new PublicationLinkError({ reason: "invalid-record" });
const skipped = (reason: Extract<LinkResult, { status: "skipped" }>["reason"]): LinkResult => ({
  status: "skipped",
  reason,
});

/** Links retained publication history only; no execution, review, or merge authority is granted. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const outsideTransaction = Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* new PublicationLinkError({ reason: "inherited-transaction" });
  });
  const link = Effect.fn("ProjectWorkPublicationLinks.link")(function* (operationId: string) {
    yield* outsideTransaction;
    if (operationId.length === 0 || operationId.length > 256 || operationId.trim() !== operationId)
      return yield* invalid();
    const rows = yield* sql<{
      recordId: string;
      projectId: string;
      status: string;
      payload: string | null;
    }>`
      SELECT record_id AS recordId,project_id AS projectId,status,
        CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json ELSE NULL END AS payload
      FROM project_team_effect WHERE unique_key=${operationId} LIMIT 1`;
    const row = rows[0];
    if (row === undefined) return skipped("missing-operation");
    if (row.payload === null) return yield* invalid();
    const rawEffect = yield* decodeJson(row.payload);
    const effect = yield* decodeEffect(rawEffect);
    if (
      canonicalProjectWorkPayload(rawEffect) !== canonicalProjectWorkPayload(effect) ||
      effect.recordId !== row.recordId ||
      effect.projectId !== row.projectId ||
      effect.status !== row.status ||
      effect.effectId !== operationId ||
      effect.recordId !== operationId
    )
      return yield* invalid();
    if (effect.effectKind !== "publication" || effect.status !== "succeeded")
      return skipped("not-confirmed");
    const summary = effect.payload.summary;
    if (
      summary === undefined ||
      summary.length > 32000 ||
      effect.outcome === undefined ||
      effect.outcome.length > 4000
    )
      return yield* invalid();
    const rawRequest = yield* decodeJson(summary);
    const request = isRequest(rawRequest) ? capturePublicationRequest(rawRequest) : undefined;
    if (
      request === undefined ||
      canonicalProjectWorkPayload(request) !== summary ||
      request.operationId !== operationId ||
      request.target.projectId !== effect.projectId ||
      request.target.taskId !== effect.taskId ||
      effect.targetId !== `${request.repository.host}/${request.repository.nameWithOwner}` ||
      effect.payload.expectedRevision !== request.expectedTaskRevision ||
      canonicalProjectWorkPayload(effect.payload.recordIds) !==
        canonicalProjectWorkPayload(request.authorizationRecordIds)
    )
      return yield* invalid();
    const receipt = yield* decodeOutcome(yield* decodeJson(effect.outcome));
    if (
      canonicalProjectWorkPayload(receipt) !== effect.outcome ||
      receipt.kind !== "confirmed" ||
      receipt.operationId !== operationId ||
      receipt.requestHash !== publicationRequestHash(request) ||
      receipt.claimGeneration !== effect.claimGeneration ||
      receipt.claimGeneration === 0 ||
      receipt.marker !== request.marker ||
      canonicalProjectWorkPayload(receipt.repository) !==
        canonicalProjectWorkPayload(request.repository) ||
      receipt.pullRequest.baseSha !== request.target.baseSha ||
      receipt.pullRequest.headSha !== request.target.headSha ||
      receipt.pullRequest.baseRef !== request.target.baseRef ||
      receipt.pullRequest.headRef !== request.target.headRef ||
      receipt.pullRequest.headRepositoryNodeId !== request.target.headRepositoryNodeId ||
      receipt.pullRequest.url !==
        `https://${request.repository.host}/${request.repository.nameWithOwner}/pull/${receipt.pullRequest.number}`
    )
      return yield* invalid();
    const threadId = request.threadId;
    if (threadId === undefined) return skipped("no-thread");
    const thread = yield* query.getThreadShellById(threadId);
    if (Option.isNone(thread) || thread.value.projectId !== request.target.projectId)
      return skipped("missing-thread");
    const project = yield* query.getProjectShellById(request.target.projectId);
    if (Option.isNone(project)) return skipped("missing-project");
    const lifecycle = yield* sql<{ state: string }>`SELECT state FROM project_lifecycle
      WHERE project_id=${request.target.projectId} LIMIT 1`;
    if (lifecycle[0] !== undefined && lifecycle[0].state !== "active")
      return skipped("missing-project");
    const state = yield* readCurrentState(sql, request.target.projectId);
    const bindings = (state.foundationRecords ?? []).filter(
      (entry) => entry.kind === "run-binding" && entry.threadId === threadId,
    );
    const binding = bindings[0];
    if (
      !state.tasks.some((task) => task.taskId === request.target.taskId) ||
      bindings.length !== 1 ||
      !isBinding(binding) ||
      binding.projectId !== request.target.projectId ||
      binding.taskId !== request.target.taskId ||
      binding.specRevision !== request.target.specRevision ||
      binding.planRevision !== request.target.planRevision ||
      binding.scopeHash !== request.target.scopeHash ||
      (binding.status !== "running" &&
        binding.status !== "stopping" &&
        binding.status !== "settled")
    )
      return skipped("unbound-thread");
    const commandId = CommandId.make(
      `publication-link:${NodeCrypto.createHash("sha256")
        .update(canonicalProjectWorkPayload({ effect, threadId, pullRequest: receipt.pullRequest }))
        .digest("hex")}`,
    );
    yield* linkCreatedPullRequest({
      threadId,
      result: {
        pr: {
          status: "opened_existing",
          number: receipt.pullRequest.number,
          url: receipt.pullRequest.url,
        },
      },
      commandId: Effect.succeed(commandId),
    }).pipe(
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(ProjectionSnapshotQuery, query),
    );
    // The ordinary helper deliberately swallows dispatch failures; invocation is not a link receipt.
    return { status: "attempted" } as const;
  });
  const protect = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isLinkError(cause) ? cause : new PublicationLinkError({ reason: "persistence", cause }),
      ),
    );
  const recoverAll = Effect.fn("ProjectWorkPublicationLinks.recoverAll")(function* () {
    yield* outsideTransaction;
    const counts = { observed: 0, attempted: 0, skipped: 0, failed: 0 };
    let cursor = "";
    while (true) {
      const rows = yield* sql<{ recordId: string; operationId: string | null }>`
        SELECT record_id AS recordId,unique_key AS operationId FROM project_team_effect
        WHERE record_id>${cursor} AND status='succeeded'
          AND CASE WHEN length(CAST(payload_json AS BLOB))>262144 OR NOT json_valid(payload_json)
            THEN 1 ELSE json_extract(payload_json,'$.effectKind')='publication' END
        ORDER BY record_id LIMIT 128`;
      for (const row of rows) {
        cursor = row.recordId;
        counts.observed++;
        if (row.operationId === null) {
          counts.failed++;
          continue;
        }
        const result = yield* protect(link(row.operationId)).pipe(Effect.result);
        if (result._tag === "Failure") counts.failed++;
        else counts[result.success.status]++;
      }
      if (rows.length < 128) return counts;
    }
  });
  return ProjectWorkPublicationLinks.of({
    link: (id) => protect(link(id)),
    recoverAll: () => protect(recoverAll()),
  });
});
