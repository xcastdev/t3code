import {
  EnvironmentAuthorizationError,
  ProjectTeamRecord,
  ProjectWorkTask,
  ProjectWorkCriterion,
  canonicalProjectWorkPayload,
  ProjectWorkAttempt,
  ProjectWorkWriteIntent,
  type CommandId,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkTaskId,
  type ProjectWorkTaskContext,
  type ProjectWorkCriterionId,
  type ProjectWorkEvidenceId,
} from "@t3tools/contracts";
import type { ProjectWorkFoundationSnapshot } from "@t3tools/client-runtime/project-work";
import * as Schema from "effect/Schema";

/** A captured draft request keeps one command identity across transport retries. */
export function createMobileWorkRequest(input: {
  readonly commandId: CommandId;
  readonly taskId: ProjectWorkTaskId;
  readonly projectId: ProjectId;
  readonly expectedRevision: number;
  readonly title: string;
  readonly createdAt: string;
}) {
  return decodeWrite({ type: "project-work.task.create", ...input, deliverableKind: "code" });
}

export interface MobileWorkScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly taskId: ProjectWorkTaskId;
}
export interface MobileWorkCurrent extends MobileWorkScope {
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly foundationSupported: boolean;
  readonly guidedSupported: boolean;
  readonly fresh: boolean;
  readonly context: ProjectWorkTaskContext | null;
  readonly foundation: ProjectWorkFoundationSnapshot;
}
type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;
type Plan = Extract<ProjectTeamRecord, { kind: "plan-revision" }>;
const knownRecord = Schema.is(ProjectTeamRecord);
const knownTask = Schema.is(ProjectWorkTask);
const knownCriterion = Schema.is(ProjectWorkCriterion);
const knownAttempt = Schema.is(ProjectWorkAttempt);
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const only = <T>(items: ReadonlyArray<T>): T | null => (items.length === 1 ? items[0]! : null);
const waiverDefinition = (context: ProjectWorkTaskContext) =>
  canonicalProjectWorkPayload({
    specification: context.task.specification,
    criteria: context.criteria
      .map(({ criterionId, description, required, waiver }) => ({
        criterionId,
        description,
        required,
        waiver,
      }))
      .sort((a, b) => (a.criterionId < b.criterionId ? -1 : a.criterionId > b.criterionId ? 1 : 0)),
  });

/** Capability flags describe UI support. The server still authorizes every command. */
function reviewWork(current: MobileWorkCurrent, controls = false) {
  const { context, foundation } = current;
  let reason: string | null = null;
  if (!current.connected) reason = "Reconnect to make changes. Cached work may be out of date.";
  else if (!current.enabled) reason = "Project Work is disabled in this environment's settings.";
  else if (!current.foundationSupported || !current.guidedSupported)
    reason = "This server does not support guided Work actions. Update the server to use them.";
  else if (
    !current.fresh ||
    !foundation.complete ||
    foundation.error !== null ||
    context === null ||
    foundation.revision !== context.revision
  )
    reason = "Refresh the complete current project work before making changes.";
  else if (
    context.projectId !== current.projectId ||
    context.task.projectId !== current.projectId ||
    context.task.taskId !== current.taskId ||
    context.policy.taskId !== current.taskId
  )
    reason = "This task does not belong to the selected project.";
  else if (
    new Set(foundation.records.map((record) => record.recordId)).size !==
      foundation.records.length ||
    !knownTask(context.task) ||
    [context.activeAttempt, context.reclaimableAttempt].some(
      (attempt) =>
        attempt !== undefined && (!knownAttempt(attempt) || attempt.taskId !== current.taskId),
    ) ||
    !foundation.records.every(knownRecord) ||
    foundation.records.some((record) => record.projectId !== current.projectId) ||
    !context.criteria.every(knownCriterion) ||
    context.criteria.some((criterion) => criterion.taskId !== current.taskId) ||
    new Set(context.criteria.map((criterion) => criterion.criterionId)).size !==
      context.criteria.length
  )
    reason = "This task contains a workflow state this client cannot change.";
  else if (
    context.task.specification !== undefined &&
    (context.task.specification.revision !== context.task.specRevision ||
      context.task.specification.criterionIds.some(
        (id) => !context.criteria.some((criterion) => criterion.criterionId === id),
      ))
  )
    reason = "Load the complete current specification before making changes.";
  const records = foundation.records
    .filter(knownRecord)
    .filter((record) => "taskId" in record && record.taskId === current.taskId);
  const membership = only(records.filter((record) => record.kind === "task-membership"));
  if (reason === null && (membership?.status !== "active" || membership.executionKind === "legacy"))
    reason = "Guided actions are unavailable for this task.";
  if (
    reason === null &&
    ((!controls && (context?.task.state === "completed" || context?.task.state === "canceled")) ||
      (!controls && membership?.controlState !== undefined && membership.controlState !== "active"))
  )
    reason = "This task is stopped. Review its recorded state before continuing.";
  const plan = only(
    records.filter(
      (record): record is Plan =>
        record.kind === "plan-revision" &&
        record.status === "proposed" &&
        record.specRevision === context?.task.specRevision,
    ),
  );
  const gates = records.filter(
    (record): record is Gate =>
      record.kind === "gate" &&
      (record.status === "pending" || record.status === "proposed") &&
      record.specRevision === context?.task.specRevision,
  );
  const specificationGate =
    context?.task.specification === undefined
      ? null
      : only(gates.filter((gate) => gate.gate === "specification" && gate.planRevision === 0));
  const planGate =
    plan === null
      ? null
      : only(
          gates.filter(
            (gate) =>
              gate.gate === "plan" &&
              gate.planRevision === plan.planRevision &&
              gate.contentHash === plan.contentHash,
          ),
        );
  const canInvestigate =
    reason === null &&
    context?.task.activeAttemptId === undefined &&
    context?.activeAttempt === undefined &&
    !records.some((record) => record.kind === "run-binding" && record.status !== "settled");
  const approvedSpecification = only(
    records.filter(
      (record): record is Gate =>
        record.kind === "gate" &&
        record.gate === "specification" &&
        record.specRevision === context?.task.specRevision &&
        record.planRevision === 0 &&
        record.status !== "invalidated",
    ),
  );
  const approvedPlan = only(
    records.filter(
      (record): record is Gate =>
        record.kind === "gate" &&
        record.gate === "plan" &&
        record.specRevision === context?.task.specRevision &&
        record.planRevision === plan?.planRevision &&
        record.contentHash === plan?.contentHash &&
        record.status !== "invalidated",
    ),
  );
  const canReview =
    reason === null &&
    context?.task.specification !== undefined &&
    plan !== null &&
    approvedSpecification?.status === "approved" &&
    approvedSpecification.attribution.actor.kind === "human" &&
    approvedPlan?.status === "approved" &&
    approvedPlan.attribution.actor.kind === "human" &&
    new Set(foundation.records.map((record) => record.recordId)).size ===
      foundation.records.length &&
    !records.some(
      (record) =>
        record.kind === "repair-episode" &&
        (record.status === "exhausted" ||
          (record.status === "active" && record.pendingSemanticRepair !== false)),
    );
  return {
    reason,
    membership,
    records,
    specificationGate: reason === null ? specificationGate : null,
    planGate: reason === null ? planGate : null,
    plan,
    canInvestigate,
    canReview,
    approvedSpecification,
    approvedPlan,
    gates: records.filter((record): record is Gate => record.kind === "gate"),
  };
}

export function reviewMobileWork(current: MobileWorkCurrent) {
  return reviewWork(current);
}

function reviewRequestTarget(current: MobileWorkCurrent) {
  const review = reviewMobileWork(current);
  return canonicalProjectWorkPayload({
    revision: current.context?.revision,
    taskRevision: current.context?.task.revision,
    specification: current.context ? waiverDefinition(current.context) : null,
    plan: review.plan,
    specificationGate: review.approvedSpecification,
    planGate: review.approvedPlan,
  });
}

/** Lifecycle return paths use the same current-owner checks while stopped approvals stay denied. */
export function reviewMobileTaskControl(current: MobileWorkCurrent) {
  const review = reviewWork(current, true);
  const counts = new Map<string, number>();
  for (const record of current.foundation.records)
    counts.set(record.recordId, (counts.get(record.recordId) ?? 0) + 1);
  const members = current.foundation.records
    .filter(knownRecord)
    .filter((record) => record.kind === "member")
    .filter(
      (record) => record.projectId === current.projectId && counts.get(record.recordId) === 1,
    );
  const terminal =
    current.context?.task.state === "completed" || current.context?.task.state === "canceled";
  const recipients =
    review.reason === null && !terminal
      ? members.filter((member) => member.status === "active")
      : [];
  const requested = review.membership?.requestedSuccessorMemberId;
  const successor = members.find((member) => member.recordId === requested);
  const undrainedAttempt =
    current.context?.reclaimableAttempt !== undefined &&
    !review.records.some(
      (record) =>
        record.kind === "run-binding" &&
        record.attemptId === current.context?.reclaimableAttempt?.attemptId &&
        record.status === "settled",
    );
  const writer =
    undrainedAttempt ||
    current.context?.activeAttempt !== undefined ||
    current.context?.task.activeAttemptId !== undefined ||
    review.records.some((record) => record.kind === "run-binding" && record.status !== "settled");
  const repair =
    current.context?.task.state === "failed" ||
    current.context?.task.state === "blocked" ||
    review.records.some(
      (record) =>
        record.kind === "repair-episode" &&
        (record.status === "exhausted" ||
          (record.status === "active" && record.pendingSemanticRepair !== false)),
    );
  const stopped =
    review.membership?.controlState === "paused" || review.membership?.controlState === "deferred";
  const ownership = requested === undefined || successor?.status === "active";
  const resumeReason =
    review.reason ??
    (terminal
      ? "Reopen a terminal task before resuming work."
      : !stopped
        ? "Resume is available for paused or deferred work."
        : !ownership
          ? "Resolve the requested successor before resuming."
          : writer
            ? "Wait for the prior worker to authoritatively drain."
            : repair
              ? "Resolve the recorded failure or repair before resuming."
              : null);
  return {
    ...review,
    members,
    recipients,
    successor,
    resumeReason,
    canResume: resumeReason === null,
    canReassign: review.reason === null && !terminal,
    canPause: review.reason === null && !terminal && !stopped,
    canCancel: review.reason === null && !terminal,
    canReopen: review.reason === null && terminal && !writer && !repair,
  };
}

export type MobileWorkAction =
  | { readonly kind: "investigate" }
  | { readonly kind: "review" }
  | { readonly kind: "implement" }
  | { readonly kind: "waiver"; readonly action: "waive" | "revoke" }
  | {
      readonly kind: "control";
      readonly action: "reassign" | "resume" | "pause" | "cancel" | "reopen";
    }
  | { readonly kind: "gate"; readonly gateId: string; readonly response: "approved" | "rejected" };
export interface MobileWorkActionState {
  readonly waiver: {
    readonly criterionId: ProjectWorkCriterionId;
    readonly criterionRevision: number;
    readonly specRevision: number;
    readonly revision: number;
    readonly taskRevision: number;
    readonly specification: string;
    readonly plan: string;
    readonly specificationHash: string | null;
    readonly scopeHash: string | null;
  } | null;
  readonly waiverReason: string;
  readonly waiverEvidenceIds: ReadonlyArray<ProjectWorkEvidenceId>;
  readonly reason: string;
  readonly recipient: { readonly id: string; readonly revision: number } | null;
  readonly objective: string;
  readonly implementationObjective: string;
  readonly implementationOutputs: string;
  readonly implementationTarget: string | null;
  readonly implementationCriterionIds: ReadonlyArray<ProjectWorkCriterionId>;
  readonly reviewObjective: string;
  readonly reviewOutputs: string;
  readonly reviewTarget: string | null;
  readonly outputs: string;
  readonly status: "idle" | "preparing" | "sending" | "uncertain" | "stale" | "denied" | "accepted";
  readonly notice: string | null;
  readonly pending: ProjectWorkWriteIntent | null;
}
// Only validated public domain fields establish an authoritative write rejection.
const knownPublicRejection = Schema.is(
  Schema.Union([
    Schema.Struct(EnvironmentAuthorizationError.fields),
    Schema.Struct({ _tag: Schema.Literal("ProjectTeamAuthorizationError"), reason: Schema.String }),
    Schema.Struct({
      _tag: Schema.Literal("ProjectWorkAuthorizationError"),
      reason: Schema.Literals([
        "spoofed-attribution",
        "agent-approval-required",
        "invalid-approval",
        "project-work-disabled",
        "unknown-project",
        "project-archived",
        "project-tombstoned",
      ]),
    }),
    Schema.Struct({
      _tag: Schema.Literal("ProjectWorkContentRejectedError"),
      matches: Schema.Array(Schema.Struct({ path: Schema.String, kind: Schema.String })),
    }),
    Schema.Struct({
      _tag: Schema.Literal("ProjectWorkPolicyError"),
      code: Schema.Literals([
        "unknown-task",
        "unknown-criterion",
        "unknown-evidence",
        "unknown-relationship",
        "unknown-blocker",
        "stale-revision",
        "invalid-state",
        "invalid-specification",
        "invalid-relationship",
        "active-attempt",
        "unresolved-dependency",
        "unsatisfied-criterion",
        "protected-specification",
        "approval-required",
        "authority-required",
        "duplicate-record",
        "deferred-command",
      ]),
      message: Schema.String,
    }),
  ]),
);
const changedTeamTarget = new Set([
  "Project revision changed",
  "Task or specification revision changed",
  "Plan revision changed",
  "Gate target changed",
  "Specification approval target changed",
  "Plan approval target changed",
  "Gate response is no longer eligible",
  "Gate response changed since receipt",
  "Guided project or task revision changed",
  "Guided receipt target changed",
  "Question target changed",
]);
export function publicWorkRejection(error: unknown) {
  if (!knownPublicRejection(error)) return null;
  if (
    (error._tag === "ProjectTeamAuthorizationError" && changedTeamTarget.has(error.reason)) ||
    (error._tag === "ProjectWorkPolicyError" && error.code === "stale-revision")
  )
    return { status: "stale" as const, notice: null };
  const reason =
    error._tag === "ProjectWorkContentRejectedError"
      ? "Content contains a secret; edit your draft before resending"
      : error._tag === "ProjectWorkPolicyError" || error._tag === "EnvironmentAuthorizationError"
        ? error.message
        : error.reason;
  return {
    status: "denied" as const,
    notice: `The server denied this action: ${reason}. Your draft is kept.`,
  };
}

/** Owns one scoped draft and exact command across conflict, disconnect and retry. */
export function createWorkActionSession(
  scope: MobileWorkScope,
  current: () => MobileWorkCurrent,
  send: (intent: ProjectWorkWriteIntent) => Promise<void>,
  id: () => CommandId,
  changed: () => void = () => {},
) {
  let readCurrent = current;
  let alive = true;
  let blockedRevision: number | null = null;
  let state: MobileWorkActionState = {
    waiver: null,
    waiverReason: "",
    waiverEvidenceIds: [],
    reason: "",
    recipient: null,
    objective: "",
    implementationObjective: "Implement the selected approved criteria.",
    implementationOutputs: "Implementation and focused validation",
    implementationTarget: null,
    implementationCriterionIds: [],
    reviewObjective: "Independently review the approved work and its verification evidence.",
    reviewOutputs: "Independent review findings",
    reviewTarget: null,
    outputs: "Findings, sources, and open questions",
    status: "idle",
    notice: null,
    pending: null,
  };
  const update = (patch: Partial<MobileWorkActionState>) => {
    state = { ...state, ...patch };
    if (alive) changed();
  };
  const available = (control = false) => {
    const value = readCurrent();
    if (
      !alive ||
      value.environmentId !== scope.environmentId ||
      value.projectId !== scope.projectId ||
      value.taskId !== scope.taskId
    )
      return null;
    if ((control ? reviewMobileTaskControl(value) : reviewMobileWork(value)).reason !== null)
      return null;
    return value;
  };
  const execute = async (intent: ProjectWorkWriteIntent) => {
    update({ status: "sending", pending: intent, notice: null });
    try {
      await send(intent);
      blockedRevision = intent.expectedRevision ?? null;
      update({
        status: "accepted",
        pending: null,
        notice: "Recorded. Refresh work to see the current state.",
      });
    } catch (error) {
      const rejection = publicWorkRejection(error);
      const status = rejection?.status ?? "uncertain";
      if (status === "stale") blockedRevision = intent.expectedRevision ?? null;
      update({
        status,
        notice:
          status === "stale"
            ? "Work changed on another client. Your draft is kept. Refresh and review it before sending a new command."
            : status === "denied"
              ? (rejection?.notice ?? "The server denied this action. Your draft is kept.")
              : "The response was lost. The action may have been recorded. Retry the exact command or refresh to inspect its result.",
      });
    }
  };
  return {
    get state() {
      return state;
    },
    canSubmit(revision: number | null) {
      return alive && state.status === "idle" && revision !== null && revision !== blockedRevision;
    },
    setCurrent(read: () => MobileWorkCurrent) {
      readCurrent = read;
    },
    edit(objective: string, outputs: string) {
      if (state.status !== "sending" && state.status !== "uncertain")
        update({ objective, outputs });
    },
    editReview(objective: string, outputs: string) {
      const value = available();
      if (state.status !== "idle" || value === null) return;
      update({
        reviewObjective: objective,
        reviewOutputs: outputs,
        reviewTarget: state.reviewTarget ?? reviewRequestTarget(value),
      });
    },
    editImplementation(objective: string, outputs: string) {
      const value = available();
      if (state.status !== "idle" || value === null) return;
      update({
        implementationObjective: objective,
        implementationOutputs: outputs,
        implementationTarget: state.implementationTarget ?? reviewRequestTarget(value),
      });
    },
    toggleImplementationCriterion(criterionId: ProjectWorkCriterionId) {
      const value = available();
      if (state.status !== "idle" || value === null || !reviewMobileWork(value).canReview) return;
      if (!value.context?.task.specification?.criterionIds.includes(criterionId)) return;
      const target = reviewRequestTarget(value);
      if (state.implementationTarget !== null && state.implementationTarget !== target) {
        update({
          status: "stale",
          notice: "The implementation targets changed. Refresh and review them again.",
        });
        return;
      }
      const selected = state.implementationCriterionIds.includes(criterionId);
      if (!selected && state.implementationCriterionIds.length >= 64) return;
      update({
        implementationTarget: target,
        implementationCriterionIds: selected
          ? state.implementationCriterionIds.filter((id) => id !== criterionId)
          : [...state.implementationCriterionIds, criterionId],
      });
    },
    editControl(reason: string) {
      if (state.status !== "sending" && state.status !== "uncertain") update({ reason });
    },
    async selectWaiverCriterion(criterionId: ProjectWorkCriterionId) {
      const value = available(true);
      const context = value?.context;
      const criterion = context?.criteria.find((entry) => entry.criterionId === criterionId);
      if (
        state.status !== "idle" ||
        value === null ||
        !context ||
        !criterion ||
        context.task.specification === undefined ||
        context.task.specification.protected
      )
        return;
      const plan = reviewMobileTaskControl(value).plan;
      const planSignature = canonicalProjectWorkPayload(plan);
      const planPayload =
        plan === null
          ? null
          : canonicalProjectWorkPayload({
              content: plan.content,
              dependencyTaskIds: [...plan.dependencyTaskIds].sort(),
              ...(plan.integrationSources === undefined
                ? {}
                : { integrationSources: plan.integrationSources }),
            });
      const planTarget =
        plan === null
          ? undefined
          : {
              planRevision: plan.planRevision,
              dependencyTaskIds: [...plan.dependencyTaskIds].sort(),
            };
      const selection = {
        criterionId,
        criterionRevision: criterion.revision,
        specRevision: context.task.specRevision,
        revision: context.revision,
        taskRevision: context.task.revision,
        specification: waiverDefinition(context),
        plan: planSignature,
        specificationHash: null,
        scopeHash: null,
      };
      update({
        status: "preparing",
        waiver: selection,
        waiverReason: "",
        waiverEvidenceIds: [],
        notice: null,
      });
      try {
        const { CryptoDigestAlgorithm, digestStringAsync } = await import("expo-crypto");
        const specificationHash = await digestStringAsync(
          CryptoDigestAlgorithm.SHA256,
          selection.specification,
        );
        const contentHash =
          planPayload === null
            ? undefined
            : await digestStringAsync(CryptoDigestAlgorithm.SHA256, planPayload);
        const scopeHash = await digestStringAsync(
          CryptoDigestAlgorithm.SHA256,
          canonicalProjectWorkPayload({
            specificationHash,
            plan: planTarget === undefined ? undefined : { ...planTarget, contentHash },
          }),
        );
        const after = available(true);
        if (
          !after?.context ||
          after.context.revision !== selection.revision ||
          after.context.task.revision !== selection.taskRevision ||
          waiverDefinition(after.context) !== selection.specification ||
          after.context.criteria.find((entry) => entry.criterionId === criterionId)?.revision !==
            selection.criterionRevision ||
          canonicalProjectWorkPayload(reviewMobileTaskControl(after).plan) !== planSignature
        ) {
          if (alive)
            update({
              status: "stale",
              notice: "The selected criterion or connection changed. Refresh and review it again.",
            });
          return;
        }
        update({ status: "idle", waiver: { ...selection, specificationHash, scopeHash } });
      } catch {
        if (alive)
          update({
            status: "denied",
            notice: "The current criterion definition could not be prepared. Refresh work.",
          });
      }
    },
    editWaiver(reason: string) {
      if (state.status === "idle") update({ waiverReason: reason });
    },
    toggleWaiverEvidence(evidenceId: ProjectWorkEvidenceId) {
      const value = available(true);
      if (
        state.status !== "idle" ||
        !state.waiver ||
        !value?.context?.evidence.some(
          (evidence) =>
            evidence.evidenceId === evidenceId &&
            evidence.taskId === scope.taskId &&
            evidence.scopeHash === state.waiver?.scopeHash &&
            (evidence.criterionId === undefined ||
              evidence.criterionId === state.waiver?.criterionId),
        ) ||
        value.foundation.records
          .filter(knownRecord)
          .some(
            (record) =>
              record.kind === "evidence-applicability" &&
              record.evidenceId === evidenceId &&
              record.status !== "current",
          )
      )
        return;
      const selected = state.waiverEvidenceIds.includes(evidenceId);
      if (!selected && state.waiverEvidenceIds.length >= 64) return;
      update({
        waiverEvidenceIds: selected
          ? state.waiverEvidenceIds.filter((id) => id !== evidenceId)
          : [...state.waiverEvidenceIds, evidenceId],
      });
    },
    cancelWaiver() {
      if (state.status === "idle")
        update({ waiver: null, waiverReason: "", waiverEvidenceIds: [], notice: null });
    },
    selectRecipient(memberId: string, revision: number) {
      const value = available(true);
      if (
        state.status !== "sending" &&
        state.status !== "uncertain" &&
        value &&
        reviewMobileTaskControl(value).recipients.some(
          (member) => member.recordId === memberId && member.revision === revision,
        )
      )
        update({ recipient: { id: memberId, revision } });
    },
    async submit(action: MobileWorkAction) {
      if (state.status !== "idle") return;
      const value = available(action.kind === "control" || action.kind === "waiver");
      if (value === null || value.context === null || value.context.revision === blockedRevision) {
        update({ notice: "Load current work in this environment and project before sending." });
        return;
      }
      const review = reviewMobileWork(value);
      const base = {
        commandId: id(),
        projectId: scope.projectId,
        taskId: scope.taskId,
        expectedRevision: value.context.revision,
        expectedTaskRevision: value.context.task.revision,
      };
      let intent: ProjectWorkWriteIntent;
      try {
        if (action.kind === "waiver") {
          const captured = state.waiver;
          const criterion = value.context.criteria.find(
            (entry) => entry.criterionId === captured?.criterionId,
          );
          if (
            value.context.task.state === "completed" ||
            value.context.task.state === "canceled" ||
            !captured ||
            captured.specificationHash === null ||
            captured.scopeHash === null ||
            !criterion ||
            value.context.task.specification?.protected ||
            captured.revision !== value.context.revision ||
            captured.taskRevision !== value.context.task.revision ||
            captured.criterionRevision !== criterion.revision ||
            captured.specRevision !== value.context.task.specRevision ||
            captured.specification !== waiverDefinition(value.context) ||
            captured.plan !== canonicalProjectWorkPayload(reviewMobileTaskControl(value).plan) ||
            (action.action === "waive" && !state.waiverReason.trim()) ||
            (action.action === "revoke" &&
              (criterion.status !== "waived" || criterion.waiver === undefined))
          ) {
            update({
              notice: "Select and review the current criterion before changing its waiver.",
            });
            return;
          }
          const waiverAction =
            action.action === "revoke"
              ? { kind: "revoke" as const }
              : {
                  kind: "waive" as const,
                  reason: state.waiverReason,
                  evidenceIds: [...state.waiverEvidenceIds],
                };
          intent = decodeWrite({
            ...base,
            type: "project-team.criterion.waiver",
            criterionId: captured.criterionId,
            expectedCriterionRevision: captured.criterionRevision,
            expectedSpecRevision: captured.specRevision,
            expectedSpecificationHash: captured.specificationHash,
            action: waiverAction,
          });
        } else if (action.kind === "control") {
          const control = reviewMobileTaskControl(value);
          const recipient = state.recipient;
          if (
            !state.reason.trim() ||
            (action.action === "pause" && !control.canPause) ||
            (action.action === "cancel" && !control.canCancel) ||
            (action.action === "reopen" && !control.canReopen) ||
            (action.action === "resume" && !control.canResume) ||
            (action.action === "reassign" &&
              (!recipient ||
                !control.recipients.some(
                  (member) =>
                    member.recordId === recipient.id && member.revision === recipient.revision,
                )))
          ) {
            update({
              notice: "Review the reason, recipient, and current task controls before sending.",
            });
            return;
          }
          intent = decodeWrite({
            ...base,
            type: "project-team.task.control",
            control:
              action.action === "reassign" && recipient
                ? {
                    action: "reassign",
                    reason: state.reason,
                    recipientMemberId: recipient.id,
                    expectedMemberRevision: recipient.revision,
                  }
                : { action: action.action, reason: state.reason },
          });
        } else if (action.kind === "review" || action.kind === "implement") {
          const implementation = action.kind === "implement";
          const criterionIds = [...state.implementationCriterionIds];
          const capturedTarget = implementation ? state.implementationTarget : state.reviewTarget;
          const target = reviewRequestTarget(value);
          if (
            !review.canReview ||
            !review.plan ||
            !review.approvedSpecification ||
            !review.approvedPlan ||
            (capturedTarget !== null && capturedTarget !== target) ||
            (implementation &&
              (criterionIds.length < 1 ||
                criterionIds.length > 64 ||
                new Set(criterionIds).size !== criterionIds.length ||
                criterionIds.some(
                  (id) => !value.context?.task.specification?.criterionIds.includes(id),
                )))
          ) {
            update({
              status: "stale",
              notice: implementation
                ? "Review the current human-approved specification and plan and select one to 64 criteria before requesting implementation."
                : "Review the current human-approved specification and plan before requesting review.",
            });
            return;
          }
          const objective = implementation ? state.implementationObjective : state.reviewObjective;
          const outputs = implementation ? state.implementationOutputs : state.reviewOutputs;
          update({
            status: "preparing",
            ...(implementation ? { implementationTarget: target } : { reviewTarget: target }),
            notice: null,
          });
          const { CryptoDigestAlgorithm, digestStringAsync } = await import("expo-crypto");
          const specificationHash = await digestStringAsync(
            CryptoDigestAlgorithm.SHA256,
            waiverDefinition(value.context),
          );
          const planHash = await digestStringAsync(
            CryptoDigestAlgorithm.SHA256,
            canonicalProjectWorkPayload({
              content: review.plan.content,
              dependencyTaskIds: [...review.plan.dependencyTaskIds].sort(),
              ...(review.plan.integrationSources === undefined
                ? {}
                : { integrationSources: review.plan.integrationSources }),
            }),
          );
          const after = available();
          if (
            !after ||
            reviewRequestTarget(after) !== target ||
            !reviewMobileWork(after).canReview ||
            (implementation &&
              (canonicalProjectWorkPayload(state.implementationCriterionIds) !==
                canonicalProjectWorkPayload(criterionIds) ||
                criterionIds.some(
                  (id) => !after.context?.task.specification?.criterionIds.includes(id),
                ))) ||
            specificationHash !== review.approvedSpecification.contentHash ||
            planHash !== review.plan.contentHash
          ) {
            if (alive)
              update({
                status: "stale",
                notice: "The approved assignment targets changed. Refresh and review them again.",
              });
            return;
          }
          intent = decodeWrite({
            ...base,
            type: "project-team.assignment.start",
            assignmentKind: implementation ? "implementation" : "review",
            ...(implementation ? { parentCriterionIds: criterionIds } : {}),
            objective,
            outputDescriptions: outputs
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            specRevision: value.context.task.specRevision,
            specificationGateId: review.approvedSpecification.recordId,
            expectedSpecificationGateRevision: review.approvedSpecification.revision,
            parentPlan: {
              recordId: review.plan.recordId,
              expectedRecordRevision: review.plan.revision,
              planRevision: review.plan.planRevision,
              gateId: review.approvedPlan.recordId,
              expectedGateRevision: review.approvedPlan.revision,
            },
          });
        } else if (action.kind === "investigate") {
          if (!review.canInvestigate) {
            update({
              notice: "Investigation is unavailable while this task has an active worker.",
            });
            return;
          }
          intent = decodeWrite({
            ...base,
            type: "project-team.investigation.start",
            objective: state.objective,
            outputDescriptions: state.outputs
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
          });
        } else {
          const gate = [review.specificationGate, review.planGate].find(
            (entry) => entry?.recordId === action.gateId,
          );
          if (!gate) {
            update({ notice: "This approval is no longer current. Refresh work." });
            return;
          }
          intent = decodeWrite({
            ...base,
            type: "project-team.gate.respond",
            specRevision: gate.specRevision,
            planRevision: gate.planRevision,
            gateId: gate.recordId,
            expectedGateRevision: gate.revision,
            response: action.response,
          });
        }
      } catch {
        update({
          ...(action.kind === "waiver" || action.kind === "review" || action.kind === "implement"
            ? { status: "denied" as const }
            : {}),
          notice:
            action.kind === "waiver"
              ? "The criterion waiver could not be prepared. Review its reason and current definition."
              : "Enter an objective and one to sixteen outputs within the server's text limits.",
        });
        return;
      }
      await execute(intent);
    },
    async retry() {
      if (state.status !== "uncertain" || state.pending === null) return;
      if (
        available(
          state.pending.type === "project-team.task.control" ||
            state.pending.type === "project-team.criterion.waiver",
        ) === null
      ) {
        update({
          notice:
            "Reconnect and refresh this task in its original environment and project to retry.",
        });
        return;
      }
      await execute(state.pending);
    },
    reset() {
      if (
        state.status !== "preparing" &&
        state.status !== "sending" &&
        state.status !== "uncertain"
      )
        update({
          status: "idle",
          pending: null,
          notice: null,
          waiver: null,
          reviewTarget: null,
          implementationTarget: null,
          implementationCriterionIds: [],
          waiverReason: "",
          waiverEvidenceIds: [],
        });
    },
    activate() {
      alive = true;
    },
    dispose() {
      alive = false;
    },
  };
}
