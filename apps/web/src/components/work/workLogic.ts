// Kept identical to apps/mobile/src/features/work/workLogic.ts until it moves into
// @t3tools/client-runtime/project-work (see the P4a UI API notes).
import {
  PROJECT_TEAM_DEFAULT_LIMITS,
  ProjectTeamConfigurationIntent,
  ProjectWorkCriterion,
  projectWorkPayloadFingerprint,
  projectWorkProtectedRevisionFingerprintPayload,
  type CommandId,
  type ProjectId,
  type ProjectTeamRecordRead,
  type ProjectWorkApprovalId,
  type ProjectWorkAttribution,
  type ProjectWorkCommand,
  type ProjectWorkKnowledgeId,
  type ProjectWorkKnowledgeRead,
  type ProjectWorkRelationshipRead,
  type ProjectWorkTaskContext,
  type ProjectWorkTaskId,
} from "@t3tools/contracts";
import {
  projectWorkSelectionIsCurrent,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { WorkApprovalStep } from "./workModel";

/** Read status order: the worst page decides what a combined view may claim. */
export type WorkReadStatus = "ready" | "stale" | "loading" | "disconnected";
const STATUS_RANK: Record<WorkReadStatus, number> = {
  ready: 0,
  stale: 1,
  loading: 2,
  disconnected: 3,
};
export const worseReadStatus = (a: WorkReadStatus, b: WorkReadStatus): WorkReadStatus =>
  STATUS_RANK[b] > STATUS_RANK[a] ? b : a;

export interface WorkPageSnapshot {
  readonly status: WorkReadStatus;
  readonly failed: boolean;
  readonly page: {
    readonly revision: number;
    readonly hasMore: boolean;
    readonly nextOffset: number | null;
    readonly items: ReadonlyArray<{ readonly value: unknown }>;
  } | null;
}

export interface WorkRecordSet {
  readonly records: ReadonlyArray<unknown>;
  readonly revision: number | null;
  /** Every page loaded at one revision, with nothing beyond the bound. */
  readonly complete: boolean;
  /** More pages exist than a client may load; never treat this set as the whole truth. */
  readonly truncated: boolean;
  readonly status: WorkReadStatus;
  readonly failed: boolean;
}

/**
 * Folds an ordered page chain into one record set. A set is complete only when
 * every page shares one revision and the last page says nothing follows.
 */
export function combineWorkPages(
  pages: ReadonlyArray<WorkPageSnapshot>,
  maxPages: number,
): WorkRecordSet {
  let status: WorkReadStatus = "ready";
  let failed = false;
  let revision: number | null = null;
  let consistent = true;
  let missing = pages.length === 0;
  let ended = false;
  const records: unknown[] = [];
  for (const snapshot of pages) {
    status = worseReadStatus(status, snapshot.status);
    failed ||= snapshot.failed;
    if (snapshot.page === null) {
      missing = true;
      break;
    }
    if (revision === null) revision = snapshot.page.revision;
    else if (snapshot.page.revision !== revision) consistent = false;
    for (const item of snapshot.page.items) records.push(item.value);
    if (!snapshot.page.hasMore) {
      ended = true;
      break;
    }
  }
  const truncated = !missing && !ended && pages.length >= maxPages;
  return {
    records,
    revision: consistent ? revision : null,
    complete: !missing && consistent && ended,
    truncated,
    status: consistent ? status : worseReadStatus(status, "stale"),
    failed,
  };
}

/**
 * While a newer revision streams in page by page, a chain that is merely
 * incomplete keeps showing the last whole set, marked stale. The current
 * chain's failure is carried over so its error and Retry stay visible.
 */
export function retainCompleteWorkSet(
  previous: WorkRecordSet | null,
  next: WorkRecordSet,
): WorkRecordSet {
  if (next.complete || next.truncated || !previous?.complete) return next;
  return {
    ...previous,
    status: next.status === "ready" ? "stale" : next.status,
    failed: next.failed,
  };
}

/** Knowledge replaced by a newer entry stays as history; only a current leaf may be revised. */
export interface KnowledgeLineage {
  readonly supersededBy: ReadonlyMap<ProjectWorkKnowledgeId, ProjectWorkKnowledgeRead>;
  readonly byId: ReadonlyMap<ProjectWorkKnowledgeId, ProjectWorkKnowledgeRead>;
}
export function knowledgeLineage(
  entries: ReadonlyArray<ProjectWorkKnowledgeRead>,
): KnowledgeLineage {
  const byId = new Map(entries.map((entry) => [entry.knowledgeId, entry] as const));
  const supersededBy = new Map<ProjectWorkKnowledgeId, ProjectWorkKnowledgeRead>();
  for (const entry of entries) {
    if (entry.supersedesKnowledgeId === undefined) continue;
    const earlier = supersededBy.get(entry.supersedesKnowledgeId);
    // Two replacements of one entry are a branch; keep the newest visible as its successor.
    if (earlier === undefined || earlier.createdAt < entry.createdAt)
      supersededBy.set(entry.supersedesKnowledgeId, entry);
  }
  return { supersededBy, byId };
}

const RELATIONSHIP_LABELS: Record<string, readonly [outgoing: string, incoming: string]> = {
  "depends-on": ["Depends on", "Needed by"],
  blocks: ["Blocks", "Blocked by"],
  duplicates: ["Duplicates", "Duplicated by"],
  "relates-to": ["Related to", "Related to"],
  continues: ["Continues", "Continued by"],
  supersedes: ["Supersedes", "Superseded by"],
};
export const RELATIONSHIP_KINDS = Object.keys(RELATIONSHIP_LABELS) as ReadonlyArray<
  "depends-on" | "blocks" | "duplicates" | "relates-to" | "continues" | "supersedes"
>;
export const relationshipKindLabel = (kind: string) => RELATIONSHIP_LABELS[kind]?.[0] ?? kind;

/** How one relationship reads from the task being viewed, and which task it points at. */
export function relationshipFromTask(
  relationship: ProjectWorkRelationshipRead,
  taskId: ProjectWorkTaskId,
): { readonly label: string; readonly otherTaskId: ProjectWorkTaskId } {
  const outgoing = relationship.fromTaskId === taskId;
  const labels = RELATIONSHIP_LABELS[relationship.kind];
  return {
    label: labels ? labels[outgoing ? 0 : 1] : `${relationship.kind} (${outgoing ? "to" : "from"})`,
    otherTaskId: outgoing ? relationship.toTaskId : relationship.fromTaskId,
  };
}

/** Bounded window arithmetic for Next/Previous over an offset-paged collection. */
export function pageWindow(offset: number, shown: number, pageSize: number, hasMore: boolean) {
  return {
    from: shown === 0 ? offset : offset + 1,
    to: offset + shown,
    previousOffset: offset > 0 ? Math.max(0, offset - pageSize) : null,
    nextOffset: hasMore ? offset + pageSize : null,
  };
}

export const TEAM_ROLES = [
  "coordinator",
  "investigator",
  "planner",
  "implementer",
  "reviewer",
  "integrator",
] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const MEMORY_ACCESS = ["none", "project", "shared"] as const;

type ConfigurationIntent = ProjectTeamConfigurationIntent;
export type TeamConfigurationValues = Omit<
  ConfigurationIntent,
  "type" | "commandId" | "projectId" | "expectedRevision" | "expectedConfigurationGeneration"
>;
export type TeamProfile = TeamConfigurationValues["profiles"][number];
export type TeamModelPolicy = TeamConfigurationValues["modelPolicies"][number];
type Limits = Extract<ProjectTeamRecordRead, { readonly kind: "limits" }>;
type Role = Extract<ProjectTeamRecordRead, { readonly kind: "role-revision" }>;
type Member = Extract<ProjectTeamRecordRead, { readonly kind: "member" }>;
const isLimits = (record: ProjectTeamRecordRead): record is Limits => record.kind === "limits";
const isRole = (record: ProjectTeamRecordRead): record is Role => record.kind === "role-revision";
export const isMemberRecord = (record: ProjectTeamRecordRead): record is Member =>
  record.kind === "member";

export const DEFAULT_MODEL_POLICY: Omit<TeamModelPolicy, "model"> = {
  tokenLimit: 200_000,
  durationLimitMs: 30 * 60_000,
  modelCalls: 2,
};

export type RecordedTeamConfiguration =
  | { readonly kind: "none"; readonly generation: number }
  | {
      readonly kind: "configured";
      readonly generation: number;
      readonly values: TeamConfigurationValues;
    }
  | { readonly kind: "unreadable"; readonly generation: number; readonly reason: string };

/**
 * Reads the configuration generation exactly as the server counts it, then the
 * one recorded configuration at that generation. Anything inconsistent stays
 * read-only instead of guessing which record is current.
 */
export function recordedTeamConfiguration(
  records: ReadonlyArray<ProjectTeamRecordRead>,
): RecordedTeamConfiguration {
  const installed = records
    .filter(isLimits)
    .filter(
      (record) => record.providerInstanceId !== undefined && record.profileRecordIds !== undefined,
    );
  const generation = installed.reduce((value, record) => Math.max(value, record.generation), 0);
  if (installed.length === 0) return { kind: "none", generation };
  const unreadable = (reason: string) => ({ kind: "unreadable" as const, generation, reason });
  const policies = installed.filter((record) => record.generation === generation);
  const first = policies[0];
  if (first === undefined) return unreadable("No limits match the current generation.");
  const ids = first.profileRecordIds ?? [];
  const status = first.status;
  if (status !== "configured" && status !== "disabled")
    return unreadable("The team status is from a newer server.");
  const sameShape = (policy: Limits) =>
    policy.status === first.status &&
    policy.providerInstanceId === first.providerInstanceId &&
    JSON.stringify([...(policy.profileRecordIds ?? [])].sort()) === JSON.stringify([...ids].sort());
  if (ids.length !== 6 || new Set(ids).size !== 6 || !policies.every(sameShape))
    return unreadable("The recorded limits disagree about the current profiles.");
  const profiles: TeamProfile[] = [];
  for (const id of ids) {
    const role = records.find((record) => record.recordId === id);
    if (role === undefined || !isRole(role) || role.generation !== generation)
      return unreadable("A recorded role profile is missing.");
    if (
      !TEAM_ROLES.includes(role.role as TeamRole) ||
      !MEMORY_ACCESS.includes(role.memoryAccess as never)
    )
      return unreadable("A role profile is from a newer server.");
    profiles.push({
      role: role.role as TeamRole,
      instructions: role.instructions,
      skills: role.skills,
      tools: role.tools,
      model: role.model,
      memoryAccess: role.memoryAccess as (typeof MEMORY_ACCESS)[number],
      delegationDepth: role.delegationDepth,
    });
  }
  const values: TeamConfigurationValues = {
    enabled: status === "configured",
    providerInstanceId: first.providerInstanceId!,
    projectPriority: first.projectPriority ?? 0,
    taskPriorities: first.taskPriorities ?? [],
    profiles: TEAM_ROLES.map((role) => profiles.find((profile) => profile.role === role)!),
    modelPolicies: policies.map(({ model, tokenLimit, durationLimitMs, modelCalls }) => ({
      model,
      tokenLimit,
      durationLimitMs,
      modelCalls,
    })),
    environmentModelCalls: first.environmentModelCalls,
    projectWritableWorkers: first.projectWritableWorkers,
    delegationDepth: first.delegationDepth,
    repairAllowance: first.repairAllowance,
  };
  return { kind: "configured", generation, values };
}

export function emptyTeamConfiguration(): TeamConfigurationValues {
  return {
    enabled: false,
    providerInstanceId: "" as TeamConfigurationValues["providerInstanceId"],
    projectPriority: 0,
    taskPriorities: [],
    profiles: TEAM_ROLES.map((role) => ({
      role,
      instructions: "",
      skills: [],
      tools: [],
      model: "",
      memoryAccess: "project" as const,
      delegationDepth: 0,
    })),
    modelPolicies: [],
    ...PROJECT_TEAM_DEFAULT_LIMITS,
  };
}

/** One policy per selected model, keeping limits already entered for that model. */
export function syncModelPolicies(values: TeamConfigurationValues): TeamConfigurationValues {
  const models = [...new Set(values.profiles.map((profile) => profile.model).filter(Boolean))];
  return {
    ...values,
    modelPolicies: models.map(
      (model) =>
        values.modelPolicies.find((policy) => policy.model === model) ?? {
          model,
          ...DEFAULT_MODEL_POLICY,
        },
    ),
  };
}

const decodeConfiguration = Schema.decodeUnknownOption(ProjectTeamConfigurationIntent);

/** Turning off an enabled team with exactly the recorded profiles, provider and limits. */
export function isRecordedTeamDisable(
  values: TeamConfigurationValues,
  recorded: TeamConfigurationValues | null,
): boolean {
  return (
    recorded !== null &&
    recorded.enabled &&
    !values.enabled &&
    JSON.stringify(values) === JSON.stringify({ ...recorded, enabled: false })
  );
}

/**
 * The exact wire intent, or the reason it can't be sent. `availableModels` is
 * the chosen provider's live catalog, or null when that provider isn't enabled
 * here. Disabling the recorded team skips the catalog: the server accepts the
 * recorded configuration as is, and the way out must not depend on a provider
 * or model that has since disappeared. Anything that could run again is checked.
 */
export function buildTeamConfigurationIntent(input: {
  readonly values: TeamConfigurationValues;
  /** The configured values the draft was opened from, or null for a new team. */
  readonly recorded: TeamConfigurationValues | null;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly expectedRevision: number;
  readonly expectedConfigurationGeneration: number;
  readonly availableModels: ReadonlySet<string> | null;
}): { readonly intent: ConfigurationIntent } | { readonly reason: string } {
  const { values, availableModels } = input;
  if (!values.providerInstanceId) return { reason: "Choose a provider." };
  if (values.profiles.some((profile) => !profile.model))
    return { reason: "Choose a model for every role." };
  if (!isRecordedTeamDisable(values, input.recorded)) {
    if (availableModels === null)
      return { reason: "This provider isn't available on this environment. Choose another." };
    if (values.profiles.some((profile) => !availableModels.has(profile.model)))
      return {
        reason: "A selected model isn't offered by this provider. Choose an available one.",
      };
  }
  const decoded = decodeConfiguration({
    ...values,
    type: "project-team.configure",
    commandId: input.commandId,
    projectId: input.projectId,
    expectedRevision: input.expectedRevision,
    expectedConfigurationGeneration: input.expectedConfigurationGeneration,
  });
  return Option.isSome(decoded)
    ? { intent: decoded.value }
    : { reason: "Some limits are out of range. Check the numbers and try again." };
}

/**
 * Attaching an issue to an existing task is reviewed as one snapshot: the
 * issue and the task read at the same project revision. Re-reviewing replaces
 * the whole snapshot, so the command never mixes an older project revision
 * with a newer task revision.
 */
export interface ExistingTaskRefineReview {
  readonly selected: ProjectWorkSelection & { readonly taskId: ProjectWorkTaskId };
  readonly issueRevision: number;
}

/** The current issue and task, or null while the two reads disagree on the project revision. */
export function existingTaskRefineSnapshot(
  task: ExistingTaskRefineReview["selected"] | null,
  issue: { readonly revision: number; readonly projectRevision: number },
): ExistingTaskRefineReview | null {
  return task !== null && task.revision === issue.projectRevision
    ? { selected: task, issueRevision: issue.revision }
    : null;
}

export function existingTaskRefineChanged(
  reviewed: ExistingTaskRefineReview,
  current: ExistingTaskRefineReview,
): boolean {
  return (
    !projectWorkSelectionIsCurrent(reviewed.selected, current.selected) ||
    reviewed.issueRevision !== current.issueRevision
  );
}

/** The revision-bound fields of an existing-task refinement, all from one review. */
export function existingTaskRefineFields(reviewed: ExistingTaskRefineReview) {
  return {
    expectedRevision: reviewed.selected.revision,
    expectedIssueRevision: reviewed.issueRevision,
    target: {
      kind: "existing-task" as const,
      taskId: reviewed.selected.taskId,
      expectedTaskRevision: reviewed.selected.taskRevision,
    },
  };
}

const decodeCriterion = Schema.decodeUnknownOption(ProjectWorkCriterion);
type ProtectedRevisionCommand = Extract<
  ProjectWorkCommand,
  { readonly type: "project-work.task.revise-protected-specification" }
>;

/**
 * The complete protected revision a human approves: the new text, the
 * current criteria exactly as recorded, and a fingerprint over the whole
 * payload. Results are listed explicitly; none exist while execution is off.
 */
export function buildProtectedRevision(input: {
  readonly context: ProjectWorkTaskContext;
  readonly expectedRevision: number;
  readonly commandId: CommandId;
  readonly approvalId: ProjectWorkApprovalId;
  readonly objective: string;
  readonly scopeIn: string;
  readonly scopeOut: string;
  readonly revisedAt: string;
  readonly attribution: ProjectWorkAttribution;
}): { readonly command: ProtectedRevisionCommand } | { readonly reason: string } {
  const { context } = input;
  const spec = context.task.specification;
  if (spec === undefined || !spec.protected) return { reason: "This scope isn't protected." };
  const snapshots = [];
  for (const criterionId of spec.criterionIds) {
    const criterion = context.criteria.find((entry) => entry.criterionId === criterionId);
    const decoded = criterion === undefined ? Option.none() : decodeCriterion(criterion);
    if (Option.isNone(decoded))
      return { reason: "Some acceptance criteria couldn't be read exactly. Reload the task." };
    snapshots.push(decoded.value);
  }
  const specification = {
    ...spec,
    objective: input.objective,
    scopeIn: input.scopeIn,
    scopeOut: input.scopeOut,
    revision: context.task.specRevision + 1,
    protected: true,
  };
  const command: ProtectedRevisionCommand = {
    type: "project-work.task.revise-protected-specification",
    commandId: input.commandId,
    projectId: context.projectId,
    expectedRevision: input.expectedRevision,
    taskId: context.task.taskId,
    specification,
    criterionSnapshots: snapshots,
    affectedResultIds: [],
    approval: {
      approvalId: input.approvalId,
      taskId: context.task.taskId,
      specRevision: specification.revision,
      payloadFingerprint: "pending",
      approvedAt: input.revisedAt,
      attribution: input.attribution,
    },
    revisedAt: input.revisedAt,
    attribution: input.attribution,
  };
  return {
    command: {
      ...command,
      approval: {
        ...command.approval,
        payloadFingerprint: projectWorkPayloadFingerprint(
          projectWorkProtectedRevisionFingerprintPayload(command),
        ),
      },
    },
  };
}

export type WorkDecisionResponse = "approved" | "rejected" | "invalidated";

/** What a person reviewed when they opened a decision; the confirmation shows only this. */
export interface WorkDecisionSnapshot {
  readonly step: WorkApprovalStep["id"];
  readonly label: string;
  readonly response: WorkDecisionResponse;
  readonly selected: ProjectWorkSelection;
  readonly revision: number | null;
  readonly hash: string | null;
  readonly gateId: string | null;
  readonly gateRevision: number | null;
}

export const decisionSnapshot = (
  step: WorkApprovalStep,
  response: WorkDecisionResponse,
  selected: ProjectWorkSelection,
): WorkDecisionSnapshot => ({
  step: step.id,
  label: step.label,
  response,
  selected,
  revision: step.revision,
  hash: step.hash,
  gateId: step.gate?.recordId ?? null,
  gateRevision: step.gate?.revision ?? null,
});

/** The reviewed step no longer matches what is recorded now, so confirming would mislabel it. */
export function decisionChanged(
  snapshot: WorkDecisionSnapshot,
  step: WorkApprovalStep | undefined,
  current: ProjectWorkSelection,
): boolean {
  return (
    step === undefined ||
    !projectWorkSelectionIsCurrent(snapshot.selected, current) ||
    step.revision !== snapshot.revision ||
    step.hash !== snapshot.hash ||
    (step.gate?.recordId ?? null) !== snapshot.gateId ||
    (step.gate?.revision ?? null) !== snapshot.gateRevision
  );
}
