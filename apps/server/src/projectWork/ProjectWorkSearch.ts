import { ProjectWorkTaskId, type ProjectWorkRelationship } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

/** FTS rows intentionally have a small, stable vocabulary. Unknown values are
 * still returned to callers so a newer server can add record kinds safely. */
export type ProjectWorkSearchRecordKind =
  | "task"
  | "criterion"
  | "evidence"
  | "blocker"
  | "knowledge"
  | "decision"
  | "comment"
  | "activity"
  | (string & {});

export interface ProjectWorkSearchInput {
  readonly projectId: string;
  readonly query: string;
  readonly recordKinds?: ReadonlyArray<string>;
  /** Alias retained for callers that describe kinds as record types. */
  readonly kinds?: ReadonlyArray<string>;
  readonly state?: string;
  readonly taskId?: string;
  readonly sourceKind?: string;
  readonly includeActivity?: boolean;
  readonly afterRevision?: number;
  readonly beforeRevision?: number;
  readonly limit?: number;
  readonly offset?: number;
  readonly snippetCharacters?: number;
}

export interface ProjectWorkSearchProvenance {
  readonly [key: string]: unknown;
}

export interface ProjectWorkSearchResultItem {
  readonly projectId: string;
  readonly recordKind: ProjectWorkSearchRecordKind;
  /** Alias for clients that use the contract's delta terminology. */
  readonly kind: ProjectWorkSearchRecordKind;
  readonly recordId: string;
  readonly title: string;
  readonly snippet: string;
  readonly provenance: ProjectWorkSearchProvenance;
  readonly revision: number;
}

export interface ProjectWorkSearchResult {
  readonly projectId: string;
  readonly query: string;
  readonly items: ReadonlyArray<ProjectWorkSearchResultItem>;
  /** Alias for APIs which call the returned rows results. */
  readonly results: ReadonlyArray<ProjectWorkSearchResultItem>;
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly nextOffset?: number;
}

export type ProjectWorkSearchRequest = ProjectWorkSearchInput;
export type ProjectWorkSearchHit = ProjectWorkSearchResultItem;
export type ProjectWorkSearchPage = ProjectWorkSearchResult;

export interface ProjectWorkRelationshipTraversalInput {
  readonly projectId: string;
  readonly taskId: ProjectWorkTaskId | string;
  readonly depth?: number;
  readonly direction?: "outgoing" | "incoming" | "both";
  readonly kinds?: ReadonlyArray<string>;
  readonly limit?: number;
}

export interface ProjectWorkRelationshipTraversal {
  readonly projectId: string;
  readonly rootTaskId: ProjectWorkTaskId;
  readonly taskIds: ReadonlyArray<ProjectWorkTaskId>;
  readonly relationships: ReadonlyArray<ProjectWorkRelationship>;
  readonly depth: number;
  readonly truncated: boolean;
}

export const PROJECT_WORK_SEARCH_MAX_LIMIT = 100;
export const PROJECT_WORK_SEARCH_MAX_QUERY_LENGTH = 256;
export const PROJECT_WORK_SEARCH_MAX_SNIPPET_CHARACTERS = 1_024;
export const PROJECT_WORK_SEARCH_MAX_RELATIONSHIPS = 5_000;
export const PROJECT_WORK_SEARCH_MAX_TRAVERSAL_DEPTH = 8;

const json = (value: unknown): string => JSON.stringify(value);

const parseJson = (value: unknown): ProjectWorkSearchProvenance => {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as ProjectWorkSearchProvenance)
      : {};
  } catch {
    return {};
  }
};

const boundedInt = (value: number | undefined, fallback: number, maximum: number): number =>
  Math.min(maximum, Math.max(0, Math.floor(value ?? fallback)));

const bounds = (input: Pick<ProjectWorkSearchInput, "limit" | "offset" | "snippetCharacters">) => ({
  limit: boundedInt(input.limit, 25, PROJECT_WORK_SEARCH_MAX_LIMIT),
  offset: boundedInt(input.offset, 0, Number.MAX_SAFE_INTEGER),
  snippetCharacters: Math.min(
    PROJECT_WORK_SEARCH_MAX_SNIPPET_CHARACTERS,
    Math.max(32, Math.floor(input.snippetCharacters ?? 320)),
  ),
});

const clip = (text: string, characters: number): string => {
  const normalized = text.replaceAll(/\s+/gu, " ").trim();
  return normalized.length <= characters ? normalized : `${normalized.slice(0, characters - 1)}…`;
};

/**
 * Convert user input into a literal FTS5 expression. Supporting only quoted
 * terms keeps MATCH from becoming an SQL/FTS expression injection surface and
 * gives predictable AND semantics for multi-word searches.
 */
export const toProjectWorkFtsQuery = (query: string): string => {
  const trimmed = query.trim().slice(0, PROJECT_WORK_SEARCH_MAX_QUERY_LENGTH);
  if (trimmed === "*") return "*";
  // FTS5's unicode61 tokenizer treats punctuation as a boundary. Extracting
  // the same Unicode word tokens keeps paths such as src/server.ts searchable
  // without joining the path into a token that cannot occur in the index.
  const terms = (trimmed.match(/[\p{Letter}\p{Mark}\p{Number}]+/gu) ?? []).slice(0, 32);
  return terms.length === 0
    ? ""
    : terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
};

const normalizeKinds = (input: ProjectWorkSearchInput): ReadonlyArray<string> =>
  [
    ...new Set((input.recordKinds ?? input.kinds ?? []).map((kind) => kind.trim()).filter(Boolean)),
  ].slice(0, 32);

const readRelationships = (
  rows: ReadonlyArray<Record<string, unknown>>,
): Array<ProjectWorkRelationship> =>
  rows.map(
    (row) =>
      ({
        relationshipId: String(row.relationshipId),
        projectId: String(row.projectId),
        fromTaskId: ProjectWorkTaskId.make(String(row.fromTaskId)),
        toTaskId: ProjectWorkTaskId.make(String(row.toTaskId)),
        kind: String(row.kind),
        revision: Number(row.revision),
        createdAt: String(row.createdAt),
        ...(row.attributionJson == null ? {} : { attribution: parseJson(row.attributionJson) }),
      }) as unknown as ProjectWorkRelationship,
  );

const refreshSearchIndex = (sql: SqlClient.SqlClient, projectId: string) =>
  Effect.gen(function* () {
    // This is also useful for databases upgraded from the P2 migration before
    // the projection writer started maintaining FTS. Normal command/rebuild
    // paths already refresh this table in ProjectWorkProjection.
    yield* sql`DELETE FROM project_work_search_fts WHERE project_id = ${projectId}`;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'task', task_id, title,
        COALESCE(summary, '') || CASE WHEN specification_json IS NULL THEN '' ELSE ' ' || specification_json END,
        CASE WHEN attribution_json IS NULL
          THEN json_object('taskId', task_id, 'state', state)
          ELSE json_set(json(attribution_json), '$.taskId', task_id, '$.state', state)
        END,
        revision
      FROM project_work_tasks WHERE project_id = ${projectId}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'criterion', criterion_id, 'Criterion ' || criterion_id, description,
        json_object('taskId', task_id), revision
      FROM project_work_criteria WHERE project_id = ${projectId}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'evidence', evidence_id, kind, summary || CASE WHEN detail IS NULL THEN '' ELSE ' ' || detail END,
        CASE WHEN attribution_json IS NULL
          THEN json_object('taskId', task_id, 'criterionId', criterion_id)
          ELSE json_set(json(attribution_json), '$.taskId', task_id, '$.criterionId', criterion_id)
        END,
        revision
      FROM project_work_evidence WHERE project_id = ${projectId}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'blocker', blocker_id, resolver, reason,
        CASE WHEN attribution_json IS NULL
          THEN json_object('taskId', task_id, 'attention', attention)
          ELSE json_set(json(attribution_json), '$.taskId', task_id, '$.attention', attention)
        END,
        revision
      FROM project_work_blockers WHERE project_id = ${projectId}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'knowledge', knowledge_id, title, body,
        CASE WHEN attribution_json IS NULL
          THEN json_object('sourceKind', source_kind, 'sourceId', source_id)
          ELSE json_set(json(attribution_json), '$.sourceKind', source_kind, '$.sourceId', source_id)
        END,
        revision
      FROM project_work_knowledge WHERE project_id = ${projectId}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'decision', decision_id, title, body,
        CASE WHEN attribution_json IS NULL
          THEN json_object('state', state)
          ELSE json_set(json(attribution_json), '$.state', state)
        END,
        revision
      FROM project_work_decisions WHERE project_id = ${projectId}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'comment', comment_id, 'Comment', body,
        CASE WHEN attribution_json IS NULL
          THEN json_object('taskId', task_id)
          ELSE json_set(json(attribution_json), '$.taskId', task_id)
        END,
        revision
      FROM project_work_comments WHERE project_id = ${projectId}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'activity', activity_id, kind, summary || CASE WHEN detail IS NULL THEN '' ELSE ' ' || detail END,
        CASE WHEN attribution_json IS NULL
          THEN json_object('taskId', task_id, 'attemptId', attempt_id)
          ELSE json_set(json_set(json(attribution_json), '$.taskId', task_id), '$.attemptId', attempt_id)
        END,
        revision
      FROM project_work_activity WHERE project_id = ${projectId}
    `;
  });

export interface ProjectWorkSearchShape {
  readonly search: (
    input: ProjectWorkSearchInput,
  ) => Effect.Effect<ProjectWorkSearchResult, ProjectionRepositoryError>;
  readonly searchProjectWork: ProjectWorkSearchShape["search"];
  readonly rebuild: (projectId: string) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly rebuildIndex: ProjectWorkSearchShape["rebuild"];
  readonly traverseRelationships: (
    input: ProjectWorkRelationshipTraversalInput,
  ) => Effect.Effect<ProjectWorkRelationshipTraversal, ProjectionRepositoryError>;
  readonly relatedTasks: ProjectWorkSearchShape["traverseRelationships"];
}

export class ProjectWorkSearch extends Context.Service<ProjectWorkSearch, ProjectWorkSearchShape>()(
  "t3/projectWork/ProjectWorkSearch",
) {}

const makeProjectWorkSearch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = <A>(effect: Effect.Effect<ReadonlyArray<A>, SqlError>) =>
    effect.pipe(
      Effect.mapError((cause) => toPersistenceSqlError("ProjectWorkSearch.query")(cause)),
    );

  const rebuild: ProjectWorkSearchShape["rebuild"] = (projectId) =>
    sql
      .withTransaction(refreshSearchIndex(sql, projectId))
      .pipe(Effect.mapError(toPersistenceSqlError("ProjectWorkSearch.rebuild")));

  const search: ProjectWorkSearchShape["search"] = (input) => {
    const page = bounds(input);
    const ftsQuery = toProjectWorkFtsQuery(input.query);
    if (ftsQuery.length === 0)
      return Effect.succeed({
        projectId: input.projectId,
        query: input.query,
        items: [],
        results: [],
        total: 0,
        limit: page.limit,
        offset: page.offset,
        hasMore: false,
      });
    const kinds = normalizeKinds(input);
    const matchClause =
      ftsQuery === "*" ? sql`` : sql`AND project_work_search_fts MATCH ${ftsQuery}`;
    const filters = sql`
      WHERE project_id = ${input.projectId}
        ${matchClause}
        ${kinds.length === 0 ? sql`` : sql`AND record_kind IN (SELECT value FROM json_each(${json(kinds)}))`}
        ${input.includeActivity === true ? sql`` : sql`AND record_kind <> 'activity'`}
        ${input.state === undefined ? sql`` : sql`AND json_extract(provenance_json, '$.state') = ${input.state}`}
        ${input.taskId === undefined ? sql`` : sql`AND json_extract(provenance_json, '$.taskId') = ${input.taskId}`}
        ${input.sourceKind === undefined ? sql`` : sql`AND json_extract(provenance_json, '$.sourceKind') = ${input.sourceKind}`}
        ${input.afterRevision === undefined ? sql`` : sql`AND revision > ${Math.max(0, Math.floor(input.afterRevision))}`}
        ${input.beforeRevision === undefined ? sql`` : sql`AND revision < ${Math.max(0, Math.floor(input.beforeRevision))}`}
    `;
    return Effect.gen(function* () {
      const countRows = yield* query(
        sql<Record<string, unknown>>`
          SELECT COUNT(*) AS totalMatched
          FROM project_work_search_fts
          ${filters}
        `,
      );
      const rows = yield* query(
        sql<Record<string, unknown>>`
          SELECT project_id AS projectId, record_kind AS recordKind, record_id AS recordId,
            title, body, provenance_json AS provenanceJson, revision,
            ${
              ftsQuery === "*"
                ? sql`body`
                : sql`snippet(project_work_search_fts, -1, '[', ']', '…', 16)`
            } AS matchedSnippet
          FROM project_work_search_fts
          ${filters}
          ORDER BY ${ftsQuery === "*" ? sql`revision DESC` : sql`rank ASC, revision DESC`},
            record_kind ASC, record_id ASC
          LIMIT ${page.limit} OFFSET ${page.offset}
        `,
      );
      const total = Number(countRows[0]?.totalMatched ?? 0);
      return {
        rows,
        total,
      };
    }).pipe(
      Effect.map(({ rows, total }) => {
        const items = rows.map((row) => {
          const recordKind = String(row.recordKind) as ProjectWorkSearchRecordKind;
          return {
            projectId: String(row.projectId),
            recordKind,
            kind: recordKind,
            recordId: String(row.recordId),
            title: clip(String(row.title ?? ""), page.snippetCharacters),
            snippet: clip(String(row.matchedSnippet ?? row.body ?? ""), page.snippetCharacters),
            provenance: parseJson(row.provenanceJson),
            revision: Number(row.revision),
          } satisfies ProjectWorkSearchResultItem;
        });
        return {
          projectId: input.projectId,
          query: input.query,
          items,
          results: items,
          total,
          limit: page.limit,
          offset: page.offset,
          hasMore: page.offset + items.length < total,
          ...(page.offset + items.length < total ? { nextOffset: page.offset + items.length } : {}),
        } satisfies ProjectWorkSearchResult;
      }),
    );
  };

  const traverseRelationships: ProjectWorkSearchShape["traverseRelationships"] = (input) => {
    const depth = boundedInt(input.depth, 1, PROJECT_WORK_SEARCH_MAX_TRAVERSAL_DEPTH);
    const limit = boundedInt(input.limit, 100, PROJECT_WORK_SEARCH_MAX_RELATIONSHIPS);
    const direction = input.direction ?? "both";
    const kinds = [
      ...new Set((input.kinds ?? []).map((kind) => kind.trim()).filter(Boolean)),
    ].slice(0, 32);
    return query(
      sql<Record<string, unknown>>`
        SELECT relationship_id AS relationshipId, project_id AS projectId,
          from_task_id AS fromTaskId, to_task_id AS toTaskId, kind,
          revision, created_at AS createdAt, attribution_json AS attributionJson
        FROM project_work_relationships
        WHERE project_id = ${input.projectId}
          ${kinds.length === 0 ? sql`` : sql`AND kind IN (SELECT value FROM json_each(${json(kinds)}))`}
        ORDER BY from_task_id ASC, to_task_id ASC, kind ASC, relationship_id ASC
        LIMIT ${PROJECT_WORK_SEARCH_MAX_RELATIONSHIPS}
      `,
    ).pipe(
      Effect.map((rows) => {
        const relationships = readRelationships(rows);
        const root = String(input.taskId);
        const seen = new Set<string>([root]);
        const taskIds: Array<ProjectWorkTaskId> = [ProjectWorkTaskId.make(root)];
        let frontier = new Set<string>([root]);
        const selected: Array<ProjectWorkRelationship> = [];
        const selectedIds = new Set<string>();
        let truncated = rows.length >= PROJECT_WORK_SEARCH_MAX_RELATIONSHIPS;
        for (let level = 0; level < depth && frontier.size > 0; level += 1) {
          const next = new Set<string>();
          const candidates = relationships
            .map((relationship) => {
              const from = String(relationship.fromTaskId);
              const to = String(relationship.toTaskId);
              const outgoing = direction === "outgoing" || direction === "both";
              const incoming = direction === "incoming" || direction === "both";
              const touches = (outgoing && frontier.has(from)) || (incoming && frontier.has(to));
              if (!touches) return undefined;
              const candidate = outgoing && frontier.has(from) ? to : from;
              return { relationship, candidate, priority: frontier.has(from) ? 0 : 1 };
            })
            .filter(
              (
                entry,
              ): entry is {
                relationship: ProjectWorkRelationship;
                candidate: string;
                priority: number;
              } => entry !== undefined,
            )
            .sort(
              (left, right) =>
                left.priority - right.priority ||
                left.candidate.localeCompare(right.candidate) ||
                String(left.relationship.relationshipId).localeCompare(
                  String(right.relationship.relationshipId),
                ),
            );
          for (const { relationship, candidate } of candidates) {
            const relationshipId = String(relationship.relationshipId);
            if (!selectedIds.has(relationshipId)) {
              selectedIds.add(relationshipId);
              if (selected.length < limit) selected.push(relationship);
              else truncated = true;
            }
            if (!seen.has(candidate)) {
              seen.add(candidate);
              next.add(candidate);
              if (taskIds.length < limit + 1) taskIds.push(ProjectWorkTaskId.make(candidate));
              else truncated = true;
            }
          }
          frontier = next;
        }
        return {
          projectId: input.projectId,
          rootTaskId: ProjectWorkTaskId.make(root),
          taskIds,
          relationships: selected,
          depth,
          truncated,
        } satisfies ProjectWorkRelationshipTraversal;
      }),
    );
  };

  return {
    search,
    searchProjectWork: search,
    rebuild,
    rebuildIndex: rebuild,
    traverseRelationships,
    relatedTasks: traverseRelationships,
  } satisfies ProjectWorkSearchShape;
});

export const ProjectWorkSearchLive = Layer.effect(ProjectWorkSearch, makeProjectWorkSearch);

/** Useful for fixture setup and migration repair without constructing a service. */
export const rebuildProjectWorkSearchIndex = (sql: SqlClient.SqlClient, projectId: string) =>
  refreshSearchIndex(sql, projectId);
