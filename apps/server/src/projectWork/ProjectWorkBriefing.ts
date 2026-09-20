import {
  ProjectWorkKnowledgeId,
  ProjectWorkTaskId,
  type ProjectWorkBriefing as ProjectWorkBriefingRecord,
  type ProjectWorkBriefingKind,
  type ProjectWorkKnowledge,
  type ProjectWorkTask,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ProjectWorkQuery,
  type ProjectWorkQueryShape,
  type ProjectWorkSnapshot,
} from "./ProjectWorkQuery.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export interface ProjectWorkBriefingInput {
  readonly projectId: string;
  readonly kind: ProjectWorkBriefingKind;
  /** Supplying this makes pure/test callers deterministic. */
  readonly generatedAt?: string;
  readonly maxTasks?: number;
  readonly maxKnowledge?: number;
  readonly maxCharacters?: number;
}

export type ProjectWorkBriefingRequest = ProjectWorkBriefingInput;

export interface ProjectWorkBriefingBounds {
  readonly maxTasks: number;
  readonly maxKnowledge: number;
  readonly maxCharacters: number;
}

export const PROJECT_WORK_BRIEFING_BOUNDS: Readonly<
  Record<ProjectWorkBriefingKind, ProjectWorkBriefingBounds>
> = {
  compact: { maxTasks: 8, maxKnowledge: 4, maxCharacters: 2_000 },
  standard: { maxTasks: 24, maxKnowledge: 12, maxCharacters: 8_000 },
  detailed: { maxTasks: 100, maxKnowledge: 50, maxCharacters: 32_000 },
};

const MAX_BRIEFING_TASKS = 100;
const MAX_BRIEFING_KNOWLEDGE = 50;
const MAX_BRIEFING_CHARACTERS = 32_000;

const bounded = (value: number | undefined, fallback: number, maximum: number): number =>
  Math.min(maximum, Math.max(0, Math.floor(value ?? fallback)));

const limitsFor = (input: ProjectWorkBriefingInput): ProjectWorkBriefingBounds => {
  const defaults = PROJECT_WORK_BRIEFING_BOUNDS[input.kind];
  return {
    maxTasks: bounded(input.maxTasks, defaults.maxTasks, MAX_BRIEFING_TASKS),
    maxKnowledge: bounded(input.maxKnowledge, defaults.maxKnowledge, MAX_BRIEFING_KNOWLEDGE),
    maxCharacters: bounded(input.maxCharacters, defaults.maxCharacters, MAX_BRIEFING_CHARACTERS),
  };
};

const taskStateRank: Record<string, number> = {
  "in-progress": 0,
  blocked: 1,
  failed: 2,
  "in-review": 3,
  ready: 4,
  specified: 5,
  draft: 6,
  completed: 7,
  canceled: 8,
};

const compareDescendingTime = (left: string, right: string): number => right.localeCompare(left);

const sortTasks = (snapshot: ProjectWorkSnapshot): ReadonlyArray<ProjectWorkTask> => {
  const activeAttention = new Set(
    snapshot.attention
      .filter((attention) => attention.resolvedAt === undefined)
      .map((attention) => String(attention.taskId)),
  );
  return [...snapshot.tasks].sort((left, right) => {
    const attentionDelta =
      Number(activeAttention.has(String(right.taskId))) -
      Number(activeAttention.has(String(left.taskId)));
    if (attentionDelta !== 0) return attentionDelta;
    const stateDelta = (taskStateRank[left.state] ?? 99) - (taskStateRank[right.state] ?? 99);
    if (stateDelta !== 0) return stateDelta;
    const timeDelta = compareDescendingTime(left.updatedAt, right.updatedAt);
    return timeDelta !== 0 ? timeDelta : String(left.taskId).localeCompare(String(right.taskId));
  });
};

const sortKnowledge = (snapshot: ProjectWorkSnapshot): ReadonlyArray<ProjectWorkKnowledge> =>
  [...snapshot.knowledge].sort((left, right) => {
    const timeDelta = compareDescendingTime(left.updatedAt, right.updatedAt);
    return timeDelta !== 0
      ? timeDelta
      : String(left.knowledgeId).localeCompare(String(right.knowledgeId));
  });

const oneLine = (value: string): string => value.replaceAll(/\s+/gu, " ").trim();

const taskLine = (
  task: ProjectWorkTask,
  snapshot: ProjectWorkSnapshot,
  kind: ProjectWorkBriefingKind,
): string => {
  const taskId = String(task.taskId);
  const criteria = snapshot.criteria.filter((criterion) => String(criterion.taskId) === taskId);
  const unresolvedCriteria = criteria.filter(
    (criterion) => criterion.required && criterion.status === "unsatisfied",
  ).length;
  const blocker = snapshot.blockers.find(
    (entry) => String(entry.taskId) === taskId && entry.resolvedAt === undefined,
  );
  const attempt = snapshot.attempts.find(
    (entry) =>
      String(entry.taskId) === taskId && (entry.state === "leased" || entry.state === "running"),
  );
  const attention = snapshot.attention.find(
    (entry) => String(entry.taskId) === taskId && entry.resolvedAt === undefined,
  );
  let line = `- [${task.state}] ${oneLine(task.title)}`;
  if (task.summary) line += ` — ${oneLine(task.summary)}`;
  if (attention) line += ` (attention: ${attention.reason})`;
  if (kind !== "compact" && unresolvedCriteria > 0)
    line += `; ${unresolvedCriteria} required criterion${unresolvedCriteria === 1 ? "" : "s"} pending`;
  if (kind !== "compact" && blocker) line += `; blocked by ${oneLine(blocker.reason)}`;
  if (kind === "detailed" && attempt) line += `; attempt ${attempt.state}`;
  return line;
};

const knowledgeLine = (knowledge: ProjectWorkKnowledge, kind: ProjectWorkBriefingKind): string => {
  const body = oneLine(knowledge.body);
  if (kind === "detailed")
    return `- ${oneLine(knowledge.title)} — ${body} (source: ${knowledge.sourceKind}/${knowledge.sourceId})`;
  return `- ${oneLine(knowledge.title)} — ${body}`;
};

const appendWithinLimit = (lines: Array<string>, value: string, maxCharacters: number): boolean => {
  const candidate = [...lines, value].join("\n");
  if (candidate.length > maxCharacters) return false;
  lines.push(value);
  return true;
};

const clipTo = (value: string, maxCharacters: number): string => {
  if (maxCharacters <= 0) return "";
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, Math.max(0, maxCharacters - 1))}…`;
};

/**
 * Build a briefing from a bounded read snapshot. This function has no
 * narrative dependency: generated prose is an optional later decoration and
 * can never make the structured context unavailable.
 */
export const buildProjectWorkBriefing = (
  snapshot: ProjectWorkSnapshot,
  input: ProjectWorkBriefingInput,
): ProjectWorkBriefingRecord => {
  const limits = limitsFor(input);
  const tasks = sortTasks(snapshot);
  const knowledge = sortKnowledge(snapshot);
  const omittedReasons: Array<string> = [];
  const includedTaskIds: Array<ProjectWorkTaskId> = [];
  const includedKnowledgeIds: Array<ProjectWorkKnowledgeId> = [];
  const lines: Array<string> = [
    `Project work (${input.kind}); source revision ${snapshot.revision}`,
  ];

  const taskHeader = input.kind === "compact" ? "Tasks" : "Tasks and current constraints";
  if (!appendWithinLimit(lines, taskHeader, limits.maxCharacters))
    omittedReasons.push("character-bound");
  for (const task of tasks.slice(0, limits.maxTasks)) {
    if (!appendWithinLimit(lines, taskLine(task, snapshot, input.kind), limits.maxCharacters)) {
      omittedReasons.push("character-bound");
      break;
    }
    includedTaskIds.push(task.taskId);
  }
  if (tasks.length > limits.maxTasks) omittedReasons.push("task-bound");

  if (knowledge.length > 0) {
    if (!appendWithinLimit(lines, "Knowledge", limits.maxCharacters))
      omittedReasons.push("character-bound");
    for (const entry of knowledge.slice(0, limits.maxKnowledge)) {
      if (!appendWithinLimit(lines, knowledgeLine(entry, input.kind), limits.maxCharacters)) {
        omittedReasons.push("character-bound");
        break;
      }
      includedKnowledgeIds.push(entry.knowledgeId);
    }
    if (knowledge.length > limits.maxKnowledge) omittedReasons.push("knowledge-bound");
  }
  const text = clipTo(lines.join("\n"), limits.maxCharacters);
  // The service boundary supplies current time; pure callers should pass a
  // timestamp explicitly when they need byte-for-byte reproducibility.
  // @effect-diagnostics-next-line globalDate:off
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return {
    projectId: input.projectId as ProjectWorkBriefingRecord["projectId"],
    kind: input.kind,
    generatedAt,
    sourceRevision: snapshot.revision,
    text,
    includedTaskIds,
    includedKnowledgeIds,
    omittedReasons: [...new Set(omittedReasons)],
  };
};

export interface ProjectWorkBriefingShape {
  readonly generate: (
    input: ProjectWorkBriefingInput,
  ) => Effect.Effect<ProjectWorkBriefingRecord, ProjectionRepositoryError>;
  readonly create: ProjectWorkBriefingShape["generate"];
  readonly brief: ProjectWorkBriefingShape["generate"];
  readonly fromSnapshot: (
    snapshot: ProjectWorkSnapshot,
    input: ProjectWorkBriefingInput,
  ) => ProjectWorkBriefingRecord;
}

export class ProjectWorkBriefing extends Context.Service<
  ProjectWorkBriefing,
  ProjectWorkBriefingShape
>()("t3/projectWork/ProjectWorkBriefing") {}

const makeProjectWorkBriefing = Effect.gen(function* () {
  const query = yield* ProjectWorkQuery;
  const generate: ProjectWorkBriefingShape["generate"] = (input) =>
    query
      // Keep one trusted sentinel through rendering so an exact boundary and
      // a truncated result remain distinguishable, including maxKnowledge=0.
      .briefingSnapshot(input.projectId, limitsFor(input).maxKnowledge + 1)
      .pipe(Effect.map((snapshot) => buildProjectWorkBriefing(snapshot, input)));
  return {
    generate,
    create: generate,
    brief: generate,
    fromSnapshot: buildProjectWorkBriefing,
  } satisfies ProjectWorkBriefingShape;
});

export const ProjectWorkBriefingLive = Layer.effect(ProjectWorkBriefing, makeProjectWorkBriefing);

/** Convenience alias for callers that already own a query service. */
export const makeProjectWorkBriefingFromQuery = (
  query: Pick<ProjectWorkQueryShape, "snapshot">,
): ProjectWorkBriefingShape => {
  const generate = (input: ProjectWorkBriefingInput) =>
    query
      .snapshot(input.projectId)
      .pipe(Effect.map((snapshot) => buildProjectWorkBriefing(snapshot, input)));
  return { generate, create: generate, brief: generate, fromSnapshot: buildProjectWorkBriefing };
};
