import {
  canonicalProjectWorkPayload,
  CommandId,
  ProjectTeamRecord,
  type ProjectId,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import { readProjectWorkPublicationHistory } from "@t3tools/shared/projectWorkPublicationHistory";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Fragment } from "effect/unstable/sql/Statement";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectTeamAuthorization } from "./ProjectTeamAuthorization.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { PROJECT_TEAM_TABLES } from "./ProjectTeamsPersistence.ts";
import * as NodeCrypto from "node:crypto";

export interface PullRequestObservationInput {
  readonly projectId: ProjectId;
  readonly provider: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}
export interface PullRequestObservation {
  readonly input: PullRequestObservationInput;
}
export interface FreshPullRequest {
  readonly number: number;
  readonly url: string;
  readonly baseRevision?: string | undefined;
  readonly headRevision?: string | undefined;
}
export class EvidenceInvalidationError extends Schema.TaggedError<EvidenceInvalidationError>()(
  "EvidenceInvalidationError",
  {
    reason: Schema.Literals(["unavailable", "changed"]),
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}
export class ProjectWorkEvidenceInvalidation extends Context.Service<
  ProjectWorkEvidenceInvalidation,
  {
    readonly capture: (
      input: PullRequestObservationInput,
    ) => Effect.Effect<PullRequestObservation | undefined, EvidenceInvalidationError>;
    readonly invalidate: (
      observation: PullRequestObservation,
      fresh: FreshPullRequest,
    ) => Effect.Effect<number, EvidenceInvalidationError>;
  }
>()("t3/projectWork/ProjectWorkEvidenceInvalidation") {}

interface Row {
  readonly recordId: string;
  readonly projectId: string;
  readonly status: string;
  readonly revision: number;
  readonly generation: number;
  readonly updatedAt: string;
  readonly taskId: string | null;
  readonly uniqueKey: string | null;
  readonly payload: string | null;
}
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRecord = Schema.decodeUnknownEffect(ProjectTeamRecord, { onExcessProperty: "error" });
const isError = Schema.is(EvidenceInvalidationError);
const isOid = Schema.is(Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)));
const unavailable = () => new EvidenceInvalidationError({ reason: "unavailable" });
const changed = () => new EvidenceInvalidationError({ reason: "changed" });
const canonical = canonicalProjectWorkPayload;

/** Observes a fresh host read; only existing qualification can be removed. */
export const layer = Layer.effect(
  ProjectWorkEvidenceInvalidation,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const authority = yield* ProjectTeamAuthorization;
    const settings = yield* ServerSettingsService;
    const enabled = settings.getSettings.pipe(
      Effect.map((value) => value.projectWorkEnabled && value.projectTeamExecutionEnabled),
    );
    const readRows = Effect.fn("ProjectWorkEvidenceInvalidation.readRows")(function* (
      table: string,
      projectId: ProjectId,
      filter: Fragment,
      limit: number,
    ) {
      const rows =
        yield* sql<Row>`SELECT record_id AS recordId,project_id AS projectId,status,revision,generation,
      updated_at AS updatedAt,task_id AS taskId,unique_key AS uniqueKey,
      CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json ELSE NULL END AS payload
      FROM ${sql(table)} WHERE project_id=${projectId} AND ${filter} ORDER BY record_id LIMIT ${limit + 1}`;
      if (rows.length > limit) return yield* unavailable();
      return yield* Effect.forEach(
        rows,
        Effect.fn(function* (row) {
          if (row.payload === null) return yield* unavailable();
          const raw = yield* decodeJson(row.payload);
          const record = yield* decodeRecord(raw);
          if (
            canonical(raw) !== canonical(record) ||
            record.projectId !== row.projectId ||
            record.recordId !== row.recordId ||
            record.status !== row.status ||
            record.revision !== row.revision ||
            record.generation !== row.generation ||
            record.updatedAt !== row.updatedAt ||
            ("taskId" in record ? (record.taskId ?? null) : null) !== row.taskId ||
            (record.kind === "effect" && record.effectId !== row.uniqueKey) ||
            table !== `project_team_${record.kind.replaceAll("-", "_")}`
          )
            return yield* unavailable();
          return record;
        }),
      );
    });
    const read = Effect.fn("ProjectWorkEvidenceInvalidation.read")(function* (
      input: PullRequestObservationInput,
    ) {
      if (!(yield* enabled)) return undefined;
      const projects = yield* sql`SELECT project_id FROM projection_projects
      WHERE project_id=${input.projectId} AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM project_lifecycle WHERE project_id=${input.projectId} AND state!='active') LIMIT 1`;
      if (projects.length !== 1) return undefined;
      const publications = yield* readRows(
        "project_team_effect",
        input.projectId,
        sql`
      CASE WHEN length(CAST(payload_json AS BLOB))>262144 OR NOT json_valid(payload_json) THEN 1
        WHEN json_extract(payload_json,'$.effectKind')!='publication' THEN 0
        WHEN json_extract(payload_json,'$.targetId')!=${`${input.host}/${input.repository}`} THEN 0
        WHEN COALESCE(json_valid(json_extract(payload_json,'$.outcome')),0)=0 THEN 1
        ELSE json_extract(json_extract(payload_json,'$.outcome'),'$.pullRequest.number')=${input.number} END`,
        128,
      );
      const matching = [];
      for (const publication of publications) {
        if (publication.kind !== "effect") return yield* unavailable();
        const receipt = readProjectWorkPublicationHistory(publication);
        if (
          !receipt ||
          receipt.repository.host !== input.host ||
          receipt.repository.nameWithOwner !== input.repository ||
          receipt.pullRequest.number !== input.number
        )
          return yield* unavailable();
        matching.push(publication);
      }
      // Repeated receipts for one PR are deliberately unavailable until ownership is unambiguous.
      if (matching.length !== 1 || matching[0]?.taskId === undefined) return undefined;
      const publication = matching[0];
      const taskId = publication.taskId;
      const limits = yield* readRows("project_team_limits", input.projectId, sql`1=1`, 2);
      const memberships = yield* readRows(
        "project_team_task_membership",
        input.projectId,
        sql`task_id=${taskId}`,
        2,
      );
      if (
        limits.length !== 1 ||
        limits[0]?.kind !== "limits" ||
        limits[0].status !== "configured" ||
        memberships.length !== 1 ||
        memberships[0]?.kind !== "task-membership" ||
        memberships[0].status !== "active" ||
        memberships[0].executionKind !== "managed"
      )
        return undefined;
      const evidence = yield* readRows(
        "project_team_evidence_applicability",
        input.projectId,
        sql`task_id=${taskId}`,
        64,
      );
      const gates = yield* readRows(
        "project_team_gate",
        input.projectId,
        sql`task_id=${taskId}`,
        64,
      );
      if (evidence.length + gates.length > 64) return yield* unavailable();
      const identities = [publication, ...limits, ...memberships, ...evidence, ...gates];
      const ids = identities.map((record) => record.recordId);
      if (new Set(ids).size !== ids.length) return yield* unavailable();
      const owners = yield* sql<{ recordId: string; projectId: string; kind: string }>`
      SELECT * FROM (${sql.join(" UNION ALL ")(
        PROJECT_TEAM_TABLES.map(
          (table) =>
            sql`SELECT record_id AS recordId,project_id AS projectId,${table.slice("project_team_".length).replaceAll("_", "-")} AS kind
          FROM ${sql(table)} WHERE record_id IN ${sql.in(ids)}`,
        ),
      )}) LIMIT ${ids.length + 1}`;
      if (
        owners.length !== ids.length ||
        identities.some(
          (record) =>
            owners.filter(
              (owner) =>
                owner.recordId === record.recordId &&
                owner.projectId === record.projectId &&
                owner.kind === record.kind,
            ).length !== 1,
        )
      )
        return yield* unavailable();
      const revisions = yield* sql<{
        revision: number;
      }>`SELECT COALESCE(MAX(CAST(json_extract(payload_json,'$.revision') AS INTEGER)),0) AS revision
      FROM project_work_events WHERE project_id=${input.projectId}`;
      return {
        input,
        revision: revisions[0]?.revision ?? 0,
        taskId,
        publication,
        limits,
        memberships,
        evidence,
        gates,
      };
    });
    type Snapshot = NonNullable<Effect.Success<ReturnType<typeof read>>>;
    const captures = new WeakMap<PullRequestObservation, Snapshot>();
    const protect = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isError(cause) ? cause : new EvidenceInvalidationError({ reason: "unavailable", cause }),
        ),
      );
    const capture = Effect.fn("ProjectWorkEvidenceInvalidation.capture")(function* (
      raw: PullRequestObservationInput,
    ) {
      const input = Object.freeze({ ...raw });
      if (
        input.provider !== "github" ||
        !input.host ||
        input.host.trim() !== input.host ||
        !input.repository ||
        input.repository.trim() !== input.repository ||
        !Number.isSafeInteger(input.number) ||
        input.number < 1
      )
        return undefined;
      const snapshot = yield* sql.withTransaction(read(input));
      if (!snapshot) return undefined;
      const observation = Object.freeze({ input });
      captures.set(observation, snapshot);
      return observation;
    });
    const invalidate = Effect.fn("ProjectWorkEvidenceInvalidation.invalidate")(function* (
      observation: PullRequestObservation,
      raw: FreshPullRequest,
    ) {
      const snapshot = captures.get(observation);
      const fresh = Object.freeze({ ...raw });
      if (
        !snapshot ||
        fresh.number !== snapshot.input.number ||
        fresh.url !==
          `https://${snapshot.input.host}/${snapshot.input.repository}/pull/${snapshot.input.number}` ||
        fresh.baseRevision === undefined ||
        fresh.headRevision === undefined ||
        !isOid(fresh.baseRevision) ||
        !isOid(fresh.headRevision)
      )
        return 0;
      const stale = snapshot.evidence.filter(
        (record): record is Extract<ProjectTeamRecord, { kind: "evidence-applicability" }> =>
          record.kind === "evidence-applicability" &&
          record.status === "current" &&
          record.repository === snapshot.input.repository &&
          (record.baseSha !== fresh.baseRevision || record.headSha !== fresh.headRevision),
      );
      const gates = snapshot.gates.filter(
        (record): record is Extract<ProjectTeamRecord, { kind: "gate" }> =>
          record.kind === "gate" &&
          record.gate === "merge" &&
          record.status !== "invalidated" &&
          record.repository === snapshot.input.repository &&
          record.pullRequestNumber === snapshot.input.number &&
          (stale.length > 0 || record.headSha !== fresh.headRevision),
      );
      if (stale.length + gates.length === 0) return 0;
      const results = yield* repository.executeAtomic(
        Effect.gen(function* () {
          const current = yield* read(snapshot.input);
          if (!current || canonical(current) !== canonical(snapshot)) return yield* changed();
          const state = yield* readCurrentState(sql, snapshot.input.projectId);
          const retained = [
            ...snapshot.limits,
            ...snapshot.memberships,
            ...snapshot.evidence,
            ...snapshot.gates,
          ];
          if (
            state.revision !== snapshot.revision ||
            !state.tasks.some((task) => task.taskId === snapshot.taskId) ||
            retained.some(
              (record) =>
                !state.foundationRecords?.some((entry) => canonical(entry) === canonical(record)),
            )
          )
            return yield* changed();
          const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          const attribution = {
            actor: { kind: "system" as const, id: "project-work-pr-observer" },
            source: { kind: "system" as const, id: "project-work-pr-observer" },
            recordedAt: now,
          };
          const records = [
            ...stale.map((record) => ({
              ...record,
              status: "stale" as const,
              revision: record.revision + 1,
              updatedAt: now,
            })),
            ...gates.map((record) => ({
              ...record,
              status: "invalidated" as const,
              revision: record.revision + 1,
              updatedAt: now,
            })),
          ];
          const command: ProjectWorkCommand = {
            type: "project-work.foundation.commit",
            projectId: snapshot.input.projectId,
            commandId: CommandId.make(
              `pr-evidence:${NodeCrypto.createHash("sha256").update(canonical({ snapshot, fresh })).digest("hex")}`,
            ),
            expectedRevision: snapshot.revision,
            records,
            attribution,
            committedAt: now,
          };
          yield* authority.write({ actor: attribution.actor }, command);
          return [command];
        }),
        Effect.gen(function* () {
          if (!(yield* enabled)) return yield* changed();
        }),
      );
      return results.reduce((count, result) => count + result.events.length, 0);
    });
    return ProjectWorkEvidenceInvalidation.of({
      capture: (input) => protect(capture(input)),
      invalidate: (observation, fresh) => protect(invalidate(observation, fresh)),
    });
  }),
);
