// Kept identical to apps/web/src/components/work/workPresentation.ts until it moves into
// @t3tools/client-runtime/project-work.
import type {
  CommandId,
  ProjectId,
  ProjectTeamBindingAccounting,
  ProjectTeamIntegrationSource,
  ProjectTeamIntegrationSourceRef,
  ProjectTeamRecordRead,
  ProjectTeamSupervisionSummary,
  ProjectWorkDeliveryRecoveryRead,
  ProjectWorkDeliveryResult,
  ProjectWorkTaskId,
  ProjectTeamMemorySourceSelector,
  MemoryOwner,
  ProjectMemorySourceRead,
} from "@t3tools/contracts";

type Kind<K extends ProjectTeamRecordRead["kind"]> = Extract<
  ProjectTeamRecordRead,
  { readonly kind: K }
>;
export type WorkBindingRecord = Kind<"run-binding">;
export type WorkMessageRecord = Kind<"message">;
export type WorkQuestionRecord = Kind<"question">;
export type WorkFindingRecord = Kind<"review-finding">;
export type WorkApplicabilityRecord = Kind<"evidence-applicability">;
export type WorkMemberRecord = Kind<"member">;
export type WorkRoleRecord = Kind<"role-revision">;
export type WorkGate = Kind<"gate">;
export type WorkMembership = Kind<"task-membership">;
export type WorkPlan = Kind<"plan-revision">;

export type WorkTone = "secondary" | "success" | "warning" | "error" | "outline" | "info";

export function recordsOfKind<K extends ProjectTeamRecordRead["kind"]>(
  records: ReadonlyArray<ProjectTeamRecordRead>,
  kind: K,
): Kind<K>[] {
  return records.filter((record): record is Kind<K> => record.kind === kind);
}

const newestFirst = <T extends { readonly updatedAt: string; readonly recordId: string }>(
  a: T,
  b: T,
) => b.updatedAt.localeCompare(a.updatedAt) || a.recordId.localeCompare(b.recordId);

// ── Supervision ────────────────────────────────────────────────────────────

const BINDING_PHASES: Record<string, { label: string; tone: WorkTone; live: boolean }> = {
  reserved: { label: "Starting", tone: "info", live: true },
  running: { label: "Running", tone: "info", live: true },
  stopping: { label: "Stopping", tone: "warning", live: true },
  settled: { label: "Finished", tone: "secondary", live: false },
  revoked: { label: "Stopped", tone: "outline", live: false },
  quarantined: { label: "Needs recovery", tone: "error", live: false },
};

/** Unknown statuses from a newer server are shown as-is and never treated as live. */
export function bindingPhase(status: string) {
  return BINDING_PHASES[status] ?? { label: status, tone: "secondary" as const, live: false };
}

/** Usage is an observation; unknown or unavailable usage stays visibly unknown. */
export function accountingSummary(accounting: ProjectTeamBindingAccounting | undefined): {
  readonly text: string;
  readonly uncertain: boolean;
} | null {
  if (accounting === undefined) return null;
  if (accounting.availability === "not-admitted")
    return { text: "Not admitted yet", uncertain: false };
  if (accounting.availability === "unavailable")
    return {
      text: `Usage unavailable (${accounting.reason.replaceAll("-", " ")})`,
      uncertain: true,
    };
  const root = accounting.root;
  const stopped = root.policy?.stoppedReason;
  const unknown = root.unknownChargedTokens > 0 || stopped === "unknown-usage";
  return {
    text:
      `${root.chargedTokens.toLocaleString()} of ${root.maximumTokens.toLocaleString()} tokens` +
      (unknown ? " · some usage unknown" : "") +
      (stopped === "threshold-reached" ? " · stopped at threshold" : ""),
    uncertain: unknown,
  };
}

export interface WorkSupervisionCounts {
  readonly open: number;
  readonly active: number;
  readonly blocked: number;
  readonly review: number;
  readonly done: number;
  readonly unknown: number;
}

export function supervisionCounts(
  summary: Extract<ProjectTeamSupervisionSummary, { availability: "available" }>,
): WorkSupervisionCounts {
  const c = summary.taskCounts;
  return {
    open: c.draft + c.specified + c.ready,
    active: c["in-progress"],
    blocked: c.blocked + c.failed,
    review: c["in-review"],
    done: c.completed + c.canceled,
    unknown: c.unknown,
  };
}

export const SUPERVISION_UNAVAILABLE: Record<string, string> = {
  missing: "This project isn't on the environment any more.",
  deleted: "This project was deleted.",
  archived: "This project is archived.",
  tombstoned: "This project was removed.",
  unsupported: "This environment can't summarize Work for this project.",
};

// ── Inbox: messages and questions ──────────────────────────────────────────

export type WorkMessageAction = "acknowledge" | "resolve";

/** Acknowledging keeps a message open; resolving closes it. Uncertain delivery is never closed blind. */
export function messageActions(message: WorkMessageRecord): ReadonlyArray<WorkMessageAction> {
  switch (message.status) {
    case "queued":
    case "delivered":
      return ["acknowledge", "resolve"];
    case "acknowledged":
      return ["resolve"];
    default:
      return [];
  }
}

export function openMessages(records: ReadonlyArray<ProjectTeamRecordRead>) {
  return recordsOfKind(records, "message")
    .filter((message) => message.status !== "resolved" && message.status !== "canceled")
    .sort(newestFirst);
}

interface Revisioned {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly expectedRevision: number;
}
interface TaskRevisioned extends Revisioned {
  readonly taskId: ProjectWorkTaskId;
  readonly expectedTaskRevision: number;
  readonly specRevision: number;
  readonly planRevision: number;
}

export function makeMessageAttentionIntent(
  base: Revisioned,
  message: WorkMessageRecord,
  action: WorkMessageAction,
) {
  return {
    type: "project-team.message.attention" as const,
    ...base,
    messageId: message.recordId,
    expectedMessageRevision: message.revision,
    action,
  };
}

export function makeQuestionAnswerIntent(
  base: TaskRevisioned,
  question: WorkQuestionRecord,
  gate: WorkGate | null,
  answer: string,
) {
  return {
    type: "project-team.question.answer" as const,
    ...base,
    questionId: question.recordId,
    expectedQuestionRevision: question.revision,
    expectedGateRevision: gate?.revision ?? question.targetRevision,
    answer: answer.trim(),
  };
}

export function makeQuestionRequestIntent(
  base: TaskRevisioned,
  input: { questionId: string; gate: WorkGate; body: string; choices: ReadonlyArray<string> },
) {
  return {
    type: "project-team.question.request" as const,
    ...base,
    questionId: input.questionId,
    targetGateId: input.gate.recordId,
    expectedGateRevision: input.gate.revision,
    body: input.body.trim(),
    choices: input.choices.map((choice) => choice.trim()).filter((choice) => choice.length > 0),
  };
}

export function makeMessageSendIntent(
  base: TaskRevisioned,
  input: {
    messageId: string;
    recipientId: string;
    membership: WorkMembership;
    body: string;
    replyTo?: string;
  },
) {
  return {
    type: "project-team.message.send" as const,
    ...base,
    messageId: input.messageId,
    recipientId: input.recipientId,
    recipientTaskId: base.taskId,
    expectedRecipientMembershipRevision: input.membership.revision,
    body: input.body.trim(),
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    evidenceIds: [],
  };
}

// ── Starting assigned work ─────────────────────────────────────────────────

const ROLE_FOR_DELIVERABLE: Record<string, WorkRoleRecord["role"]> = {
  plan: "planner",
  review: "reviewer",
  code: "implementer",
  research: "investigator",
};

export interface WorkStartPlan {
  readonly gate: WorkGate;
  readonly providerInstanceId: string;
  readonly role: WorkRoleRecord["role"] | null;
  /** Assignment and investigation grants only run under the role they were created for. */
  readonly exactRole: boolean;
  /** A requested successor is the only member the server will start. */
  readonly successorId: string | null;
}

/**
 * Starting is separate from approval: it needs an approved assignment grant,
 * no live worker, and a configured provider. Returns why not, or the plan.
 */
export function startAvailability(input: {
  readonly membership: WorkMembership | null;
  readonly records: ReadonlyArray<ProjectTeamRecordRead>;
  readonly terminal: boolean;
}): { readonly plan: WorkStartPlan } | { readonly reason: string } {
  const { membership } = input;
  if (membership === null || membership.executionKind !== "managed")
    return { reason: "Only managed team tasks are started by a worker." };
  if (input.terminal) return { reason: "This task is finished." };
  if (membership.controlState !== undefined && membership.controlState !== "active")
    return { reason: `This task is ${membership.controlState}. Resume it first.` };
  const grantId = membership.assignment?.authorizationGateId;
  const gate =
    grantId === undefined
      ? undefined
      : recordsOfKind(input.records, "gate").find((record) => record.recordId === grantId);
  if (gate === undefined)
    return { reason: "Nothing is authorized to start yet. Propose the work below first." };
  if (gate.status === "consumed") return { reason: "This assignment was already started." };
  if (gate.status !== "approved") return { reason: "Approve the assignment before starting it." };
  if (recordsOfKind(input.records, "run-binding").some((b) => bindingPhase(b.status).live))
    return { reason: "A worker is already running this task." };
  const providerInstanceId = membership.rootConstraints?.providerInstanceId;
  if (providerInstanceId === undefined)
    return { reason: "The team provider isn't recorded for this task. Configure the team first." };
  return {
    plan: {
      gate,
      providerInstanceId,
      role: ROLE_FOR_DELIVERABLE[membership.deliverableKind] ?? null,
      exactRole:
        gate.gate === "assignment" ||
        gate.gate === "investigation" ||
        (gate.gate === "repair" &&
          (gate.assignmentAuthorization !== undefined ||
            membership.deliverableKind === "research")),
      successorId: membership.requestedSuccessorMemberId ?? null,
    },
  };
}

/** Roles that write code only run in an isolated worktree. */
export const roleNeedsWorktree = (role: WorkRoleRecord["role"]) =>
  role === "implementer" || role === "integrator";

export interface WorkStartCandidate {
  readonly member: WorkMemberRecord;
  readonly role: WorkRoleRecord;
  readonly preferred: boolean;
  /** Why the server would refuse this member for this grant; null when it can start it. */
  readonly ineligible: string | null;
}

/** Every active member, with the ones that can't run this grant marked and listed last. */
export function startCandidates(
  members: ReadonlyArray<WorkMemberRecord>,
  roles: ReadonlyArray<WorkRoleRecord>,
  plan: Pick<WorkStartPlan, "role" | "exactRole" | "successorId">,
): WorkStartCandidate[] {
  return members
    .filter((member) => member.status === "active")
    .flatMap((member): WorkStartCandidate[] => {
      const revision = roles.find((entry) => entry.recordId === member.roleRevisionId);
      if (revision === undefined || revision.status !== "available") return [];
      const ineligible =
        plan.successorId !== null && member.recordId !== plan.successorId
          ? "Another member was requested to take over this task."
          : plan.exactRole && plan.role !== null && revision.role !== plan.role
            ? `This assignment needs a ${plan.role}.`
            : null;
      return [{ member, role: revision, preferred: revision.role === plan.role, ineligible }];
    })
    .sort(
      (a, b) =>
        Number(a.ineligible !== null) - Number(b.ineligible !== null) ||
        Number(b.preferred) - Number(a.preferred),
    );
}

/** Why Start can't be confirmed for this choice, re-checked whenever member or workspace changes. */
export function startChoiceProblem(
  candidate: WorkStartCandidate | null,
  workspace: { readonly type: "root" } | { readonly type: "worktree"; readonly baseRef: string },
): string | null {
  if (candidate === null) return "Choose a team member.";
  if (candidate.ineligible !== null) return candidate.ineligible;
  if (workspace.type === "root" && roleNeedsWorktree(candidate.role.role))
    return `A ${candidate.role.role} works in its own worktree, not the project checkout.`;
  if (workspace.type === "worktree" && workspace.baseRef.trim() === "")
    return "Name the branch the worktree starts from.";
  return null;
}

// ── Proposing work ─────────────────────────────────────────────────────────

export type WorkProposalKind =
  | "execution"
  | "planning"
  | "review"
  | "implementation"
  | "investigation";

export const PROPOSAL_LABEL: Record<WorkProposalKind, string> = {
  execution: "Authorize this task",
  planning: "Assign planning",
  review: "Assign a review",
  implementation: "Assign implementation",
  investigation: "Investigate",
};

const granted = (gate: WorkGate | null) =>
  gate !== null && (gate.status === "approved" || gate.status === "consumed");

export interface WorkProposalModel {
  readonly terminal: boolean;
  readonly controlState: string;
  readonly membership: WorkMembership | null;
  readonly specGate: WorkGate | null;
  readonly plan: WorkPlan | null;
  readonly planCurrent: boolean;
  readonly planGate: WorkGate | null;
  readonly hasSpecification: boolean;
}

/**
 * What a human can propose next from the current approvals. Proposing records
 * an authorization for one worker; it never starts one.
 */
export function proposalAvailability(
  model: WorkProposalModel,
  records: ReadonlyArray<ProjectTeamRecordRead>,
): Record<WorkProposalKind, string | null> {
  const closed = model.terminal
    ? "This task is finished. Reopen it first."
    : model.controlState !== "active"
      ? `This task is ${model.controlState}. Resume it first.`
      : model.membership !== null && model.membership.executionKind !== "managed"
        ? "This task is done by a person, not a worker."
        : null;
  const spec = !model.hasSpecification
    ? "Propose and approve a specification first."
    : granted(model.specGate)
      ? null
      : "Approve the current specification first.";
  const plan =
    model.plan === null
      ? "Propose and approve a plan first."
      : !model.planCurrent
        ? "The plan was written for an older scope. Propose it again."
        : granted(model.planGate)
          ? null
          : "Approve the current plan first.";
  const grantId = model.membership?.assignment?.authorizationGateId;
  const grant =
    grantId === undefined
      ? undefined
      : recordsOfKind(records, "gate").find((gate) => gate.recordId === grantId);
  // Only a settled binding proves the previous writer drained.
  const live = recordsOfKind(records, "run-binding").some(
    (binding) => binding.status !== "settled",
  );
  const execution =
    closed ??
    spec ??
    plan ??
    (grant?.status === "approved"
      ? "Already authorized. Start a worker below."
      : live
        ? "A worker hasn't finished on this task yet."
        : null);
  return {
    execution,
    planning: closed ?? spec ?? (model.plan !== null ? "This task already has a plan." : null),
    review: closed ?? spec ?? plan,
    implementation: closed ?? spec ?? plan,
    investigation: closed,
  };
}

/** Each output becomes a criterion of the new task; blank lines are dropped. */
export const proposalOutputs = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 16);

interface GuidedRevisioned extends Revisioned {
  readonly taskId: ProjectWorkTaskId;
  readonly expectedTaskRevision: number;
}

export function makeExecutionStartIntent(
  base: GuidedRevisioned,
  model: {
    readonly specRevision: number;
    readonly specGate: WorkGate;
    readonly plan: WorkPlan;
    readonly planGate: WorkGate;
  },
) {
  return {
    type: "project-team.execution.start" as const,
    ...base,
    specRevision: model.specRevision,
    planRevision: model.plan.planRevision,
    specGateId: model.specGate.recordId,
    expectedSpecGateRevision: model.specGate.revision,
    planId: model.plan.recordId,
    expectedPlanRecordRevision: model.plan.revision,
    planGateId: model.planGate.recordId,
    expectedPlanGateRevision: model.planGate.revision,
  };
}

export function makeAssignmentStartIntent(
  base: GuidedRevisioned,
  input: {
    readonly kind: "planning" | "review" | "implementation";
    readonly objective: string;
    readonly outputs: ReadonlyArray<string>;
    readonly specRevision: number;
    readonly specGate: WorkGate;
    readonly plan: WorkPlan | null;
    readonly planGate: WorkGate | null;
    readonly criterionIds: ReadonlyArray<string>;
  },
) {
  const parentPlan =
    input.kind === "planning" || input.plan === null || input.planGate === null
      ? undefined
      : {
          recordId: input.plan.recordId,
          expectedRecordRevision: input.plan.revision,
          planRevision: input.plan.planRevision,
          gateId: input.planGate.recordId,
          expectedGateRevision: input.planGate.revision,
        };
  return {
    type: "project-team.assignment.start" as const,
    ...base,
    assignmentKind: input.kind,
    objective: input.objective.trim(),
    outputDescriptions:
      input.kind === "planning" ? [input.outputs[0] ?? "A plan for review"] : [...input.outputs],
    specRevision: input.specRevision,
    specificationGateId: input.specGate.recordId,
    expectedSpecificationGateRevision: input.specGate.revision,
    ...(input.kind === "implementation" ? { parentCriterionIds: [...input.criterionIds] } : {}),
    ...(parentPlan === undefined ? {} : { parentPlan }),
  };
}

export function makeInvestigationStartIntent(
  base: GuidedRevisioned,
  input: { readonly objective: string; readonly outputs: ReadonlyArray<string> },
) {
  return {
    type: "project-team.investigation.start" as const,
    ...base,
    objective: input.objective.trim(),
    outputDescriptions: [...input.outputs],
  };
}

export function makeDispatchIntent(
  base: Omit<TaskRevisioned, "specRevision" | "planRevision">,
  input: {
    plan: WorkStartPlan;
    member: WorkMemberRecord;
    role: WorkRoleRecord;
    workspace: { type: "root" } | { type: "worktree"; baseRef: string };
  },
) {
  return {
    type: "project-team.dispatch" as const,
    ...base,
    memberId: input.member.recordId,
    expectedMemberRevision: input.member.revision,
    authorizationGateId: input.plan.gate.recordId,
    expectedGateRevision: input.plan.gate.revision,
    modelSelection: { instanceId: input.plan.providerInstanceId, model: input.role.model },
    workspace: input.workspace,
  };
}

// ── Review, verification and evidence ──────────────────────────────────────

export type WorkFreshness = "current" | "stale" | "uncertain";

/** A decision only covers the scope and plan revisions it named. */
export function gateFreshness(
  gate: Pick<WorkGate, "specRevision" | "planRevision" | "status">,
  current: { readonly specRevision: number; readonly planRevision: number | null },
): WorkFreshness {
  if (gate.status === "invalidated") return "stale";
  if (current.planRevision === null) return "uncertain";
  return gate.specRevision === current.specRevision && gate.planRevision === current.planRevision
    ? "current"
    : "stale";
}

export const FRESHNESS_LABEL: Record<WorkFreshness, string> = {
  current: "Current",
  stale: "Out of date",
  uncertain: "Can't confirm",
};
export const FRESHNESS_TONE: Record<WorkFreshness, WorkTone> = {
  current: "success",
  stale: "warning",
  uncertain: "secondary",
};

const DELIVERY_GATES = new Set(["verification", "publication", "merge"]);
export function deliveryGates(records: ReadonlyArray<ProjectTeamRecordRead>) {
  return recordsOfKind(records, "gate")
    .filter((gate) => DELIVERY_GATES.has(gate.gate))
    .sort(newestFirst);
}

export function findingFreshness(
  finding: WorkFindingRecord,
  current: { readonly specRevision: number; readonly planRevision: number | null },
): WorkFreshness {
  return gateFreshness({ ...finding.target, status: finding.status }, current);
}

/** Open findings on the current revisions block delivery; stale ones need a fresh review. */
export function reviewSummary(
  findings: ReadonlyArray<WorkFindingRecord>,
  current: { readonly specRevision: number; readonly planRevision: number | null },
) {
  let open = 0;
  let stale = 0;
  let resolved = 0;
  for (const finding of findings) {
    if (finding.status === "resolved") resolved++;
    else if (findingFreshness(finding, current) === "current") open++;
    else stale++;
  }
  return { open, stale, resolved };
}

export function makeVerificationProposal(
  base: TaskRevisioned,
  input: {
    jobId: string;
    binding: WorkBindingRecord;
    criterionIds: ReadonlyArray<string>;
    executable: string;
    argv: ReadonlyArray<string>;
    maxDurationMs: number;
    maxOutputBytes: number;
  },
) {
  return {
    type: "project-team.verification.propose" as const,
    ...base,
    jobId: input.jobId,
    bindingId: input.binding.recordId,
    expectedBindingRevision: input.binding.revision,
    generation: input.binding.generation,
    criterionIds: [...input.criterionIds],
    command: {
      executable: input.executable.trim(),
      argv: [...input.argv],
      limits: { maxDurationMs: input.maxDurationMs, maxOutputBytes: input.maxOutputBytes },
      environment: "clean" as const,
    },
  };
}

/** Whitespace-separated arguments with simple double quotes; nothing is run by a shell. */
export function splitArguments(value: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/gu;
  for (const match of value.matchAll(pattern)) out.push(match[1] ?? match[2] ?? "");
  return out;
}

// ── Integration source selection ───────────────────────────────────────────

/** The exact reviewed source a delivery or plan names; any drift makes the server refuse it. */
export function integrationSourceRefOf(
  source: ProjectTeamIntegrationSource,
): ProjectTeamIntegrationSourceRef {
  return {
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
  };
}

/** A plan's frozen inputs, in order. Re-proposing keeps them unless the user changes them. */
export function planIntegrationRefs(plan: WorkPlan | null): ProjectTeamIntegrationSourceRef[] {
  return plan?.integrationSources?.sources.map((source) => integrationSourceRefOf(source)) ?? [];
}

/** Order is part of what reviewers approve, so selection keeps the user's order. */
export function toggleIntegrationSource(
  selected: ReadonlyArray<ProjectTeamIntegrationSourceRef>,
  ref: ProjectTeamIntegrationSourceRef,
): ProjectTeamIntegrationSourceRef[] {
  return selected.some((entry) => entry.taskId === ref.taskId)
    ? selected.filter((entry) => entry.taskId !== ref.taskId)
    : [...selected, ref].slice(0, 64);
}

export function moveIntegrationSource(
  selected: ReadonlyArray<ProjectTeamIntegrationSourceRef>,
  index: number,
  delta: -1 | 1,
): ProjectTeamIntegrationSourceRef[] {
  const target = index + delta;
  if (index < 0 || index >= selected.length || target < 0 || target >= selected.length)
    return [...selected];
  const next = [...selected];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Plan dependencies without a selected reviewed source are coverage gaps. */
export function integrationCoverage(
  selected: ReadonlyArray<ProjectTeamIntegrationSourceRef>,
  dependencyTaskIds: ReadonlyArray<string>,
) {
  const chosen = new Set<string>(selected.map((entry) => entry.taskId));
  const dependencies = new Set(dependencyTaskIds);
  return {
    missing: dependencyTaskIds.filter((taskId) => !chosen.has(taskId)),
    extra: selected.filter((entry) => !dependencies.has(entry.taskId)).length,
  };
}

// ── Delivery ───────────────────────────────────────────────────────────────

export const DELIVERY_STAGE: Record<
  ProjectWorkDeliveryResult["stage"],
  { label: string; tone: WorkTone; detail: string }
> = {
  proposed: {
    label: "Waiting for approval",
    tone: "warning",
    detail: "Approve the exact preview below before anything is published.",
  },
  approved: { label: "Approved", tone: "info", detail: "Approved. Nothing is published yet." },
  claimed: { label: "In progress", tone: "info", detail: "The host is writing this change." },
  uncertain: {
    label: "Outcome unknown",
    tone: "error",
    detail:
      "The host may or may not have applied this. Check again to reconcile before trying anything new.",
  },
  confirmed: { label: "Confirmed", tone: "success", detail: "The host confirmed this change." },
};

export type WorkRecoveryItem = ProjectWorkDeliveryRecoveryRead["items"][number];

/**
 * - `none` / `superseded`: nothing was written, so preparing again is safe.
 * - `awaiting-approval` / `ready`: a preview waits on, or holds, its gate.
 * - `used-elsewhere`: the gate was consumed without a recorded operation here.
 * - `reconcile`: an operation was sent; only its exact original request may be resent.
 */
export type WorkDeliveryPhase =
  | "none"
  | "superseded"
  | "awaiting-approval"
  | "ready"
  | "used-elsewhere"
  | "reconcile"
  | "confirmed";

export interface WorkDeliveryTrack {
  readonly preview: WorkRecoveryItem | null;
  readonly operation: WorkRecoveryItem | null;
  readonly phase: WorkDeliveryPhase;
}

const DEAD_GATE = new Set(["rejected", "invalidated"]);

function previewPhase(gate: WorkGate | undefined): WorkDeliveryPhase {
  if (gate === undefined) return "awaiting-approval";
  if (DEAD_GATE.has(gate.status)) return "superseded";
  if (gate.status === "consumed") return "used-elsewhere";
  return gate.status === "approved" ? "ready" : "awaiting-approval";
}

function track(
  previews: ReadonlyArray<WorkRecoveryItem>,
  operations: ReadonlyArray<WorkRecoveryItem>,
  gates: ReadonlyArray<WorkGate>,
): WorkDeliveryTrack {
  const gateOf = (item: WorkRecoveryItem) => gates.find((gate) => gate.recordId === item.gateId);
  // A confirmed write wins; otherwise any sent write must be reconciled before anything new.
  const operation =
    operations.find((item) => item.result.stage === "confirmed") ?? operations[0] ?? null;
  if (operation !== null)
    return {
      operation,
      preview:
        previews.find((item) => item.result.operationId === operation.result.operationId) ?? null,
      phase: operation.result.stage === "confirmed" ? "confirmed" : "reconcile",
    };
  // Recovery rows are keyed by ID, not time; the newest gate decides which preview is live.
  const ranked = [...previews].sort((a, b) => {
    const ga = gateOf(a);
    const gb = gateOf(b);
    return (
      Number(ga !== undefined && DEAD_GATE.has(ga.status)) -
        Number(gb !== undefined && DEAD_GATE.has(gb.status)) ||
      (gb?.updatedAt ?? "").localeCompare(ga?.updatedAt ?? "")
    );
  });
  const preview = ranked[0] ?? null;
  return {
    preview,
    operation: null,
    phase: preview === null ? "none" : previewPhase(gateOf(preview)),
  };
}

/** Rebuilds pull request and merge progress from the task's retained delivery rows. */
export function deliveryProgress(
  items: ReadonlyArray<WorkRecoveryItem>,
  gates: ReadonlyArray<WorkGate>,
): { readonly publication: WorkDeliveryTrack; readonly merge: WorkDeliveryTrack } {
  const previews = items.filter((item) => item.request.operation === "preview");
  const publication = track(
    previews.filter(
      (item) => item.request.operation === "preview" && item.request.input.kind === "create-pr",
    ),
    items.filter((item) => item.request.operation === "publish"),
    gates,
  );
  const publicationId =
    publication.phase === "confirmed" ? publication.operation!.result.operationId : null;
  const forPublication = (item: WorkRecoveryItem) =>
    publicationId !== null &&
    (item.request.operation === "merge" ||
      (item.request.operation === "preview" && item.request.input.kind === "merge")) &&
    item.request.input.publicationOperationId === publicationId;
  const merge = track(
    previews.filter(forPublication),
    items.filter((item) => item.request.operation === "merge" && forPublication(item)),
    gates,
  );
  return { publication, merge };
}

/** Preparing again is only offered when no write was sent under the previous preview. */
export const canPrepareDelivery = (phase: WorkDeliveryPhase) =>
  phase === "none" || phase === "superseded";

/** Whether this task's current reviewed result is known yet. */
export type WorkDeliverySource = "checking" | "missing" | "current";

/**
 * Retained delivery rows belong to the task, so they stay visible and reconcilable after
 * the reviewed source drifts (the server reconciles claimed requests before re-checking
 * authority). Only preparing a new preview needs a current reviewed source.
 */
export function deliveryAvailability(input: {
  readonly source: WorkDeliverySource;
  readonly recovery: {
    readonly items: ReadonlyArray<unknown>;
    readonly nextCursor?: string | undefined;
  } | null;
}): { readonly showTracks: boolean; readonly prepareBlocked: string | null } {
  const { source, recovery } = input;
  const retained =
    recovery !== null && (recovery.items.length > 0 || recovery.nextCursor !== undefined);
  return {
    showTracks: source === "current" || retained,
    prepareBlocked:
      recovery === null
        ? "Loading this task's delivery history…"
        : recovery.nextCursor !== undefined
          ? "This task has more recorded delivery steps than can be shown here, so nothing new is prepared."
          : source === "checking"
            ? "Nothing new is prepared until this task's current reviewed result is found."
            : source === "missing"
              ? "Nothing new can be prepared until this task has a current reviewed result. Recorded steps stay available."
              : null,
  };
}

export const DELIVERY_PHASE_DETAIL: Record<WorkDeliveryPhase, string> = {
  none: "Preparing records exactly what would be sent. Nothing is pushed yet.",
  superseded: "That approval was rejected or no longer holds. Prepare again to request a new one.",
  "awaiting-approval": "Approve the prepared step under Review and checks, then continue here.",
  ready: "Approved. Nothing is sent until you continue.",
  "used-elsewhere":
    "That approval was already used, but this task has no record of the result yet. Refresh before trying again.",
  reconcile:
    "Sent, but not confirmed. Check again resends the exact original request so the same operation is reconciled.",
  confirmed: "The host confirmed this change.",
};

// ── Memory ─────────────────────────────────────────────────────────────────

export const MEMORY_STATUS: Record<string, { label: string; detail: string } | undefined> = {
  disabled: {
    label: "Memory is off",
    detail: "Stored memory is still listed, but nothing new is processed.",
  },
  degraded: {
    label: "Memory search is limited",
    detail: "Indexing is unavailable. Results come from stored text only.",
  },
};

export const MEMORY_SOURCE_STATUS: Record<string, { label: string; tone: WorkTone }> = {
  waiting: { label: "Not processed", tone: "secondary" },
  processing: { label: "Processing", tone: "info" },
  uncertain: { label: "Outcome unknown", tone: "error" },
  indexed: { label: "Remembered", tone: "success" },
  "no-facts": { label: "Nothing to remember", tone: "outline" },
};

export function memorySelector(source: ProjectMemorySourceRead) {
  return {
    owner: source.owner,
    ownerRevision: source.ownerRevision,
    sourceRecordId: source.recordId,
    expectedSourceRecordRevision: source.revision,
    sourceRevision: source.sourceRevision,
    sourceGeneration: source.generation,
    contentHash: source.contentHash,
  };
}

/** A confirmation covers the exact source revision the user opened it on. */
export function sameMemorySelector(
  a: ProjectTeamMemorySourceSelector,
  b: ProjectTeamMemorySourceSelector,
): boolean {
  return (
    JSON.stringify(a.owner) === JSON.stringify(b.owner) &&
    a.ownerRevision === b.ownerRevision &&
    a.sourceRecordId === b.sourceRecordId &&
    a.expectedSourceRecordRevision === b.expectedSourceRecordRevision &&
    a.sourceRevision === b.sourceRevision &&
    a.sourceGeneration === b.sourceGeneration &&
    a.contentHash === b.contentHash
  );
}

/**
 * A chosen shared source stays usable only while the visible grant list either
 * doesn't include it or lists it unchanged; a changed grant needs choosing again.
 */
export function sharedSourceSelection(
  chosen: ProjectTeamMemorySourceSelector | undefined,
  listed: ReadonlyArray<{ readonly selection: ProjectTeamMemorySourceSelector }>,
): "none" | "current" | "changed" {
  if (chosen === undefined) return "none";
  const match = listed.find((item) => item.selection.sourceRecordId === chosen.sourceRecordId);
  return match === undefined || sameMemorySelector(match.selection, chosen) ? "current" : "changed";
}

/**
 * Shared-source pages are cut after scanning grants, before dropping retracted or
 * superseded sources, so an empty page with a continuation still has more to check.
 */
export function scannedPageState(
  page: { readonly items: ReadonlyArray<unknown>; readonly nextCursor?: string | undefined },
  hasPrevious: boolean,
): "hidden" | "items" | "empty-scanned" | "end" {
  if (page.items.length > 0) return "items";
  if (page.nextCursor !== undefined) return "empty-scanned";
  return hasPrevious ? "end" : "hidden";
}

export function makeMemoryPromoteIntent(
  base: TaskRevisioned,
  observation: {
    readonly observationId: string;
    readonly revision: number;
    readonly sourceRevision: number;
  },
  input: { readonly knowledgeId: string; readonly title: string },
) {
  return {
    type: "project-team.memory.promote" as const,
    ...base,
    observationId: observation.observationId,
    expectedObservationRevision: observation.revision,
    expectedSourceRevision: observation.sourceRevision,
    knowledgeId: input.knowledgeId,
    title: input.title.trim(),
  };
}

export function makeMemoryRetractIntent(base: Revisioned, source: ProjectMemorySourceRead) {
  return { type: "project-team.memory.retract" as const, ...base, ...memorySelector(source) };
}

/** Replacing with an empty list is the way back from sharing. */
export function makeMemorySharesIntent(
  base: Revisioned,
  source: ProjectMemorySourceRead,
  recipients: ReadonlyArray<{ owner: MemoryOwner; revision: number }>,
) {
  return {
    type: "project-team.memory.shares.replace" as const,
    ...base,
    ...memorySelector(source),
    recipients: [...recipients],
  };
}

export function memoryShareRecipients(input: string, projectId: ProjectId) {
  const ids = [
    ...new Set(
      input
        .split(/[\s,]+/u)
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value !== projectId),
    ),
  ].slice(0, 32);
  return ids.map((id) => ({
    owner: { kind: "project" as const, projectId: id as ProjectId },
    revision: 0,
  }));
}

// ── Portfolio ──────────────────────────────────────────────────────────────

export const PORTFOLIO_PAGE = 8;

export interface WorkPortfolioEntry {
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly checkoutPath: string;
}

/**
 * Scratch and assistant-owned backing workspaces are not Work projects and the
 * server denies their Work reads, so they are dropped before paging rather than
 * mounting a failed row in a page slot.
 */
export function portfolioEntries<
  P extends {
    readonly environmentId: string;
    readonly id: string;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly isScratch?: true;
    readonly assistantId?: string | null | undefined;
  },
>(
  projects: ReadonlyArray<P>,
): Array<{
  readonly environmentId: P["environmentId"];
  readonly projectId: P["id"];
  readonly title: string;
  readonly checkoutPath: string;
}> {
  return projects
    .filter((project) => project.isScratch !== true && !project.assistantId)
    .map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
      title: project.title,
      checkoutPath: project.workspaceRoot,
    }));
}

/**
 * Stable order and one fixed window: only the current page of projects mounts
 * a summary read. Moving pages replaces the window rather than growing it.
 */
export function portfolioPage<T extends WorkPortfolioEntry>(
  entries: ReadonlyArray<T>,
  page: number,
): {
  readonly shown: T[];
  readonly page: number;
  readonly pageCount: number;
  readonly first: number;
  readonly total: number;
} {
  // Hermes lacks toSorted; sort a copy so callers' arrays are untouched.
  const sorted = [...entries].sort(
    (a, b) =>
      a.title.localeCompare(b.title) ||
      a.environmentId.localeCompare(b.environmentId) ||
      a.checkoutPath.localeCompare(b.checkoutPath),
  );
  const pageCount = Math.max(1, Math.ceil(sorted.length / PORTFOLIO_PAGE));
  const current = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  const first = current * PORTFOLIO_PAGE;
  return {
    shown: sorted.slice(first, first + PORTFOLIO_PAGE),
    page: current,
    pageCount,
    first,
    total: sorted.length,
  };
}
