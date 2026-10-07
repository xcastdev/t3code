import {
  canonicalProjectWorkPayload,
  ProjectTeamEffect,
  ProjectWorkPublicationRequest,
  ProjectWorkPublicationOutcome,
  ThreadId,
  type ProjectId,
  type PullRequestAction,
  type ProjectWorkPublicationRequest as PublicationRequest,
  type ProjectWorkPublicationOutcome as PublicationOutcome,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectTeamAuthorization } from "./ProjectTeamAuthorization.ts";
import {
  capturePublicationRequest,
  publicationRequestHash,
} from "./github/ProjectWorkGitHubOutbox.ts";

export interface Input {
  readonly projectId: ProjectId;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly action: PullRequestAction;
}
export class ProjectWorkPullRequestActionGuardError extends Schema.TaggedError<ProjectWorkPullRequestActionGuardError>()(
  "ProjectWorkPullRequestActionGuardError",
  { reason: Schema.Literals(["managed-merge-unavailable", "history-unavailable"]) },
) {}
export class ProjectWorkPullRequestActionGuard extends Context.Service<
  ProjectWorkPullRequestActionGuard,
  {
    readonly check: (input: Input) => Effect.Effect<void, ProjectWorkPullRequestActionGuardError>;
    readonly inspect?: (input: Input) => Effect.Effect<
      {
        readonly managed: boolean;
        readonly publication?: {
          readonly request: PublicationRequest;
          readonly outcome: Extract<PublicationOutcome, { kind: "confirmed" }>;
        };
      },
      ProjectWorkPullRequestActionGuardError
    >;
  }
>()("t3/projectWork/ProjectWorkPullRequestActionGuard") {}
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEffect = Schema.decodeUnknownEffect(ProjectTeamEffect, { onExcessProperty: "error" });
const decodeOutcome = Schema.decodeUnknownEffect(ProjectWorkPublicationOutcome, {
  onExcessProperty: "error",
});
const isRequest = Schema.is(ProjectWorkPublicationRequest);
const isGuardError = Schema.is(ProjectWorkPullRequestActionGuardError);
const historyUnavailable = () =>
  new ProjectWorkPullRequestActionGuardError({ reason: "history-unavailable" });
const managedUnavailable = () =>
  new ProjectWorkPullRequestActionGuardError({ reason: "managed-merge-unavailable" });
interface PublicationRow {
  readonly recordId: string;
  readonly operationId: string | null;
  readonly projectId: string;
  readonly status: string;
  readonly payload: string | null;
}

export const layer = Layer.effect(
  ProjectWorkPullRequestActionGuard,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const authority = yield* ProjectTeamAuthorization;
    const inspect = Effect.fn("ProjectWorkPullRequestActionGuard.inspect")(
      function* (raw: Input) {
        const input = Object.freeze({ ...raw });
        if (input.action !== "merge" && input.action !== "enable-auto-merge")
          return { managed: false };
        let managed = false;
        let publication:
          | {
              request: PublicationRequest;
              outcome: Extract<PublicationOutcome, { kind: "confirmed" }>;
            }
          | undefined;
        const host = input.host.toLowerCase();
        const repository = input.repository.toLowerCase();
        if (
          !host ||
          host.trim() !== host ||
          !repository ||
          repository.trim() !== repository ||
          !Number.isSafeInteger(input.number) ||
          input.number < 1
        )
          return yield* historyUnavailable();
        let cursor: string | undefined;
        while (true) {
          const rows = yield* sql<{
            threadId: string;
          }>`SELECT thread_id AS threadId FROM projection_thread_pull_requests
        WHERE host=${host} AND repository=${repository} AND number=${input.number}
          AND ${cursor === undefined ? sql`1=1` : sql`thread_id>${cursor}`}
        ORDER BY thread_id LIMIT 128`;
          for (const row of rows) {
            cursor = row.threadId;
            const threadId = yield* decodeThreadId(row.threadId);
            if (threadId !== row.threadId) return yield* historyUnavailable();
            if (yield* authority.hasManagedThread(threadId)) managed = true;
          }
          if (rows.length < 128) break;
        }
        cursor = undefined;
        while (true) {
          // A malformed potential publication cannot establish foreign ownership. Known
          // non-publication effects are excluded; no repository-wide denial comes from them.
          const rows: ReadonlyArray<PublicationRow> = yield* sql<PublicationRow>`
        SELECT record_id AS recordId,unique_key AS operationId,project_id AS projectId,status,
          CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json ELSE NULL END AS payload
        FROM project_team_effect WHERE ${cursor === undefined ? sql`1=1` : sql`record_id>${cursor}`}
          AND CASE WHEN length(CAST(payload_json AS BLOB))>262144 THEN 1
            WHEN NOT json_valid(payload_json) THEN 1
            WHEN json_extract(payload_json,'$.effectKind') IN ('dispatch','setup','mailbox-wake','memory-index','memory-delete','stop') THEN 0
            ELSE 1 END
        ORDER BY record_id LIMIT 128`;
          for (const row of rows) {
            cursor = row.recordId;
            if (row.payload === null) return yield* historyUnavailable();
            const rawEffect = yield* decodeJson(row.payload);
            const effect = yield* decodeEffect(rawEffect);
            if (
              canonicalProjectWorkPayload(rawEffect) !== canonicalProjectWorkPayload(effect) ||
              effect.effectKind !== "publication" ||
              effect.recordId !== row.recordId ||
              effect.effectId !== row.operationId ||
              effect.effectId !== effect.recordId ||
              effect.projectId !== row.projectId ||
              effect.status !== row.status ||
              effect.payload.summary === undefined ||
              effect.payload.summary.length > 32000
            )
              return yield* historyUnavailable();
            const rawRequest = yield* decodeJson(effect.payload.summary);
            const request = isRequest(rawRequest)
              ? capturePublicationRequest(rawRequest)
              : undefined;
            if (
              request === undefined ||
              canonicalProjectWorkPayload(request) !== effect.payload.summary ||
              request.operationId !== effect.effectId ||
              request.target.projectId !== effect.projectId ||
              request.target.taskId !== effect.taskId ||
              effect.targetId !==
                `${request.repository.host}/${request.repository.nameWithOwner}` ||
              effect.payload.expectedRevision !== request.expectedTaskRevision ||
              canonicalProjectWorkPayload(effect.payload.recordIds) !==
                canonicalProjectWorkPayload(request.authorizationRecordIds)
            )
              return yield* historyUnavailable();
            const sameRepository =
              host === request.repository.host.toLowerCase() &&
              repository === request.repository.nameWithOwner.toLowerCase();
            if (effect.outcome === undefined) {
              if (
                effect.status === "succeeded" ||
                effect.status === "uncertain" ||
                (effect.status === "pending" && effect.claimGeneration !== 0)
              )
                return yield* historyUnavailable();
              // Claim-before-write proves an unsent cancellation cannot have produced a PR.
              const unsent =
                effect.claimGeneration === 0 &&
                (effect.status === "pending" || effect.status === "canceled");
              if (sameRepository && !unsent) return yield* historyUnavailable();
              continue;
            }
            if (effect.outcome.length > 4000) return yield* historyUnavailable();
            const outcome = yield* decodeOutcome(yield* decodeJson(effect.outcome));
            if (
              canonicalProjectWorkPayload(outcome) !== effect.outcome ||
              outcome.operationId !== effect.effectId ||
              outcome.requestHash !== publicationRequestHash(request) ||
              outcome.claimGeneration !== effect.claimGeneration ||
              outcome.claimGeneration === 0
            )
              return yield* historyUnavailable();
            if (outcome.kind === "uncertain") {
              if (effect.status !== "uncertain") return yield* historyUnavailable();
              // This write may have created a PR whose number is still unknown. Reconcile
              // the exact repository before allowing any merge there; an unsent intent is different.
              if (sameRepository) return yield* historyUnavailable();
              continue;
            }
            const pr = outcome.pullRequest;
            const target = request.target;
            if (
              effect.status !== "succeeded" ||
              outcome.marker !== request.marker ||
              canonicalProjectWorkPayload(outcome.repository) !==
                canonicalProjectWorkPayload(request.repository) ||
              pr.baseSha !== target.baseSha ||
              pr.headSha !== target.headSha ||
              pr.baseRef !== target.baseRef ||
              pr.headRef !== target.headRef ||
              pr.headRepositoryNodeId !== target.headRepositoryNodeId ||
              pr.url !==
                `https://${request.repository.host}/${request.repository.nameWithOwner}/pull/${pr.number}`
            )
              return yield* historyUnavailable();
            if (sameRepository && pr.number === input.number) {
              if (publication !== undefined) return yield* historyUnavailable();
              managed = true;
              publication = { request, outcome };
            }
          }
          if (rows.length < 128) break;
        }
        return { managed, ...(publication === undefined ? {} : { publication }) };
      },
      Effect.mapError((error) => (isGuardError(error) ? error : historyUnavailable())),
    );
    return ProjectWorkPullRequestActionGuard.of({
      inspect,
      check: (input) =>
        inspect(input).pipe(
          Effect.flatMap((result) =>
            result.managed ? Effect.fail(managedUnavailable()) : Effect.void,
          ),
        ),
    });
  }),
);
