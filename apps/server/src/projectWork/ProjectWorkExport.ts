import {
  type EnvironmentId,
  ProjectWorkExport as ProjectWorkJsonExport,
  ProjectWorkMarkdownExport,
  type ProjectWorkTaskRead,
  ProjectWorkAttemptRead,
  ProjectWorkCriterionRead,
  ProjectWorkDecisionRead,
  ProjectWorkEvidenceRead,
  ProjectWorkKnowledgeRead,
  ProjectWorkRelationshipRead,
  ProjectWorkBlockerRead,
  ProjectWorkCommentRead,
  ProjectWorkAttentionRead,
  ProjectWorkCheckpointRead,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProjectWorkContentGuard from "./ProjectWorkContentGuard.ts";
import type { ProjectWorkSnapshot } from "./ProjectWorkQuery.ts";

export interface ProjectWorkExportOptions {
  readonly environmentId: EnvironmentId | string;
  readonly exportedAt?: string;
  readonly knownSecrets?: ReadonlyArray<string>;
  readonly history?: ReadonlyArray<unknown>;
}

const now = (): string => {
  // @effect-diagnostics-next-line globalDate:off
  return new Date().toISOString();
};

const withoutLeaseToken = <A extends object>(value: A): Omit<A, "leaseToken"> => {
  const { leaseToken: _leaseToken, ...read } = value as A & { readonly leaseToken?: unknown };
  return read;
};

const toReadSnapshot = (snapshot: ProjectWorkSnapshot) => ({
  tasks: snapshot.tasks as ReadonlyArray<ProjectWorkTaskRead>,
  attempts: snapshot.attempts.map(withoutLeaseToken) as ReadonlyArray<ProjectWorkAttemptRead>,
  criteria: snapshot.criteria as ReadonlyArray<ProjectWorkCriterionRead>,
  evidence: snapshot.evidence as ReadonlyArray<ProjectWorkEvidenceRead>,
  relationships: snapshot.relationships as ReadonlyArray<ProjectWorkRelationshipRead>,
  blockers: snapshot.blockers as ReadonlyArray<ProjectWorkBlockerRead>,
  knowledge: snapshot.knowledge as ReadonlyArray<ProjectWorkKnowledgeRead>,
  decisions: snapshot.decisions as ReadonlyArray<ProjectWorkDecisionRead>,
  comments: snapshot.comments as ReadonlyArray<ProjectWorkCommentRead>,
  attention: snapshot.attention as ReadonlyArray<ProjectWorkAttentionRead>,
  checkpoints: snapshot.checkpoints as ReadonlyArray<ProjectWorkCheckpointRead>,
});

export const buildProjectWorkJsonExport = (
  snapshot: ProjectWorkSnapshot,
  options: ProjectWorkExportOptions,
): ProjectWorkJsonExport => {
  const source = toReadSnapshot(snapshot);
  const redacted = ProjectWorkContentGuard.redactProjectWorkExportContent(
    {
      ...source,
      ...(options.history === undefined ? {} : { history: options.history }),
    },
    options.knownSecrets,
  );
  const value = redacted.value as typeof source & { readonly history?: ReadonlyArray<unknown> };
  const candidate = {
    schemaVersion: 1,
    format: "json",
    environmentId: options.environmentId as EnvironmentId,
    projectId: snapshot.projectId as ProjectWorkJsonExport["projectId"],
    exportedAt: options.exportedAt ?? now(),
    projectRevision: snapshot.revision,
    tasks: value.tasks,
    attempts: value.attempts,
    criteria: value.criteria,
    evidence: value.evidence,
    relationships: value.relationships,
    blockers: value.blockers,
    checkpoints: value.checkpoints,
    attention: value.attention,
    knowledge: value.knowledge,
    decisions: value.decisions,
    comments: value.comments,
    ...(value.history === undefined ? {} : { history: value.history }),
    redactions: redacted.redactions,
  };
  return Schema.decodeUnknownSync(ProjectWorkJsonExport)(candidate);
};

const renderList = (
  title: string,
  values: ReadonlyArray<{
    readonly title?: string;
    readonly body?: string;
    readonly details?: string;
    readonly state?: string;
  }>,
) =>
  values.length === 0
    ? `## ${title}\n\n_None._\n`
    : `## ${title}\n\n${values
        .map((value) => {
          const label = value.title ?? "Untitled";
          const state = value.state === undefined ? "" : ` (${value.state})`;
          const details = value.body ?? value.details;
          return details === undefined || details.length === 0
            ? `- ${label}${state}`
            : `- ${label}${state}\n  ${details.replaceAll("\n", "\n  ")}`;
        })
        .join("\n")}\n`;

const renderRecordList = (
  title: string,
  values: ReadonlyArray<{
    readonly label: string;
    readonly body?: string;
    readonly details?: string;
    readonly state?: string;
  }>,
) =>
  renderList(
    title,
    values.map(({ label, ...value }) => ({ title: label, ...value })),
  );

export const buildProjectWorkMarkdownExport = (
  snapshot: ProjectWorkSnapshot,
  options: Omit<ProjectWorkExportOptions, "environmentId"> & {
    readonly projectTitle?: string;
  } = {},
): ProjectWorkMarkdownExport => {
  const source = toReadSnapshot(snapshot);
  const body = [
    `# ${options.projectTitle ?? "Project work"}`,
    "",
    "> WARNING: This is a non-authoritative Markdown export. It is a human-readable snapshot and cannot be imported as project state.",
    `> Project revision: ${snapshot.revision}`,
    "",
    renderRecordList(
      "Tasks",
      source.tasks.map((task) => ({
        label: task.title,
        ...(task.summary === undefined ? {} : { body: task.summary }),
        state: task.state,
      })),
    ),
    renderRecordList(
      "Attempts",
      source.attempts.map((attempt) => ({
        label: String(attempt.attemptId),
        state: attempt.state,
        body: `Task ${String(attempt.taskId)}`,
      })),
    ),
    renderRecordList(
      "Criteria",
      source.criteria.map((criterion) => ({
        label: criterion.description,
        state: criterion.status,
      })),
    ),
    renderRecordList(
      "Evidence",
      source.evidence.map((evidence) => ({
        label: evidence.summary,
        ...(evidence.detail === undefined ? {} : { body: evidence.detail }),
        state: evidence.kind,
      })),
    ),
    renderRecordList(
      "Relationships",
      source.relationships.map((relationship) => ({
        label: `${String(relationship.fromTaskId)} → ${String(relationship.toTaskId)}`,
        state: relationship.kind,
      })),
    ),
    renderRecordList(
      "Blockers",
      source.blockers.map((blocker) => ({
        label: blocker.reason,
        body: `Resolver: ${blocker.resolver}`,
        state: blocker.attention ? "attention" : "resolved",
      })),
    ),
    renderRecordList(
      "Attention",
      snapshot.attention.map((attention) => ({
        label: `${String(attention.taskId)}: ${attention.reason}`,
        ...(attention.detail === undefined ? {} : { body: attention.detail }),
        state: attention.resolvedAt === undefined ? "active" : "resolved",
      })),
    ),
    renderRecordList(
      "Knowledge",
      source.knowledge.map((knowledge) => ({
        label: knowledge.title,
        body: knowledge.body,
        state: knowledge.sourceKind,
      })),
    ),
    renderRecordList(
      "Decisions",
      source.decisions.map((decision) => ({
        label: decision.title,
        body: decision.body,
        state: decision.state,
      })),
    ),
    renderRecordList(
      "Comments",
      source.comments.map((comment) => ({
        label: String(comment.commentId),
        body: comment.body,
      })),
    ),
  ].join("\n");
  const redacted = ProjectWorkContentGuard.redactProjectWorkContent(body, options.knownSecrets);
  return Schema.decodeUnknownSync(ProjectWorkMarkdownExport)({
    format: "markdown",
    projectId: snapshot.projectId as ProjectWorkMarkdownExport["projectId"],
    generatedAt: options.exportedAt ?? now(),
    authoritative: false,
    contents: String(redacted.value).includes(ProjectWorkContentGuard.PROJECT_WORK_REDACTION_MARKER)
      ? `${String(redacted.value)}\n\n> Redactions: ${redacted.redactions.join(", ")}`
      : String(redacted.value),
  });
};

export interface ProjectWorkExportShape {
  readonly json: (
    snapshot: ProjectWorkSnapshot,
    options: ProjectWorkExportOptions,
  ) => Effect.Effect<ProjectWorkJsonExport>;
  readonly markdown: (
    snapshot: ProjectWorkSnapshot,
    options?: Omit<ProjectWorkExportOptions, "environmentId"> & { readonly projectTitle?: string },
  ) => Effect.Effect<ProjectWorkMarkdownExport>;
}

export class ProjectWorkExport extends Context.Service<ProjectWorkExport, ProjectWorkExportShape>()(
  "t3/projectWork/ProjectWorkExport",
) {}

export const layer = Layer.effect(
  ProjectWorkExport,
  Effect.gen(function* () {
    const contentGuard = yield* Effect.serviceOption(
      ProjectWorkContentGuard.ProjectWorkContentGuard,
    );
    return {
      json: (snapshot, options) =>
        Effect.gen(function* () {
          const knownSecrets =
            contentGuard._tag === "Some" ? yield* contentGuard.value.knownSecrets : [];
          return buildProjectWorkJsonExport(snapshot, {
            ...options,
            knownSecrets: [...(options.knownSecrets ?? []), ...knownSecrets],
          });
        }),
      markdown: (snapshot, options = {}) =>
        Effect.gen(function* () {
          const knownSecrets =
            contentGuard._tag === "Some" ? yield* contentGuard.value.knownSecrets : [];
          return buildProjectWorkMarkdownExport(snapshot, {
            ...options,
            knownSecrets: [...(options.knownSecrets ?? []), ...knownSecrets],
          });
        }),
    } satisfies ProjectWorkExportShape;
  }),
);
