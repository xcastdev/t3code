import {
  ProjectTeamRecord,
  ProjectWorkWriteIntent,
  type CommandId,
  type ProjectTeamRecordRead,
} from "@t3tools/contracts";
import type { ProjectWorkFoundationSnapshot } from "@t3tools/client-runtime/project-work";
import * as Schema from "effect/Schema";
import {
  publicWorkRejection,
  reviewMobileWork,
  type MobileWorkCurrent,
  type MobileWorkScope,
} from "./workActions";

type Question = Extract<ProjectTeamRecordRead, { kind: "question" }>;
type Gate = Extract<ProjectTeamRecordRead, { kind: "gate" }>;
const knownRecord = Schema.is(ProjectTeamRecord);
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const only = <T>(rows: ReadonlyArray<T>) => (rows.length === 1 ? rows[0]! : null);

/** Present additive read states without using them to authorize commands. */
export function mobileTeamView(
  foundation: ProjectWorkFoundationSnapshot,
  scope: Pick<MobileWorkScope, "environmentId" | "projectId">,
) {
  const records = foundation.records.filter((record) => record.projectId === scope.projectId);
  const members = records.filter(
    (record): record is Extract<ProjectTeamRecordRead, { kind: "member" }> =>
      record.kind === "member" && "name" in record,
  );
  const roles = records.filter(
    (record): record is Extract<ProjectTeamRecordRead, { kind: "role-revision" }> =>
      record.kind === "role-revision" && "roleId" in record,
  );
  const runs = records.filter(
    (record): record is Extract<ProjectTeamRecordRead, { kind: "run-binding" }> =>
      record.kind === "run-binding" && "threadId" in record,
  );
  const questions = records.filter(
    (record): record is Question => record.kind === "question" && "targetGateId" in record,
  );
  const roleById = new Map(roles.map((role) => [role.recordId, role]));
  const memberIds = new Set(members.map((member) => member.recordId));
  const memberRuns = new Map<string, typeof runs>();
  for (const run of runs) {
    const assigned = memberRuns.get(run.memberId);
    if (assigned === undefined) memberRuns.set(run.memberId, [run]);
    else assigned.push(run);
  }
  return {
    members: members.map((member) => ({
      member,
      role: roleById.get(member.roleRevisionId) ?? null,
      runs: (memberRuns.get(member.recordId) ?? []).map((run) => ({
        run,
        role: roleById.get(run.roleRevisionId) ?? null,
        local: run.environmentId === scope.environmentId,
      })),
    })),
    orphanRuns: runs.filter((run) => !memberIds.has(run.memberId)),
    runs,
    questions,
    unsupported: records.filter((record) => !knownRecord(record)),
  };
}

export function reviewMobileQuestion(current: MobileWorkCurrent, questionId: string) {
  let reason = reviewMobileWork(current).reason;
  const question = only(
    current.foundation.records.filter(
      (record): record is Question =>
        record.kind === "question" && "targetGateId" in record && record.recordId === questionId,
    ),
  );
  const gate = only(
    current.foundation.records.filter(
      (record): record is Gate =>
        record.kind === "gate" && "taskId" in record && record.recordId === question?.targetGateId,
    ),
  );
  if (
    reason === null &&
    (question === null ||
      gate === null ||
      question.taskId !== current.taskId ||
      gate.taskId !== current.taskId ||
      question.status !== "pending" ||
      gate.revision !== question.targetRevision ||
      gate.specRevision !== current.context?.task.specRevision ||
      (gate.status !== "pending" &&
        gate.status !== "proposed" &&
        gate.status !== "approved" &&
        gate.status !== "consumed"))
  )
    reason = "This question no longer targets a current gate. Refresh and review it.";
  if (reason === null && gate !== null && gate.gate !== "specification") {
    const plans = current.foundation.records.filter(
      (record): record is Extract<ProjectTeamRecordRead, { kind: "plan-revision" }> =>
        record.kind === "plan-revision" &&
        "taskId" in record &&
        record.taskId === current.taskId &&
        record.status === "proposed",
    );
    if (
      plans.some((plan) => plan.planRevision > gate.planRevision) ||
      (gate.planRevision > 0 &&
        !plans.some(
          (plan) =>
            plan.planRevision === gate.planRevision && plan.specRevision === gate.specRevision,
        ))
    )
      reason = "This question targets an older plan. Refresh and review it.";
  }
  if (reason === null && gate?.gate === "specification" && gate.planRevision !== 0)
    reason = "This question has an unsupported specification target.";
  return { reason, question, gate };
}

export interface MobileQuestionScope extends MobileWorkScope {
  readonly questionId: string;
}
type QuestionIntent = Extract<ProjectWorkWriteIntent, { type: "project-team.question.answer" }>;
export interface MobileQuestionState {
  readonly draft: string;
  readonly status: "idle" | "sending" | "uncertain" | "stale" | "denied" | "accepted";
  readonly notice: string | null;
  readonly pending: QuestionIntent | null;
}
const targetIdentity = (review: ReturnType<typeof reviewMobileQuestion>) =>
  review.question === null || review.gate === null
    ? null
    : JSON.stringify([
        review.question.recordId,
        review.question.revision,
        review.question.targetGateId,
        review.question.targetRevision,
        review.gate.revision,
        review.gate.specRevision,
        review.gate.planRevision,
        review.gate.contentHash,
      ]);

/** A scoped answer draft owns its original target and exact uncertain command. */
export function createQuestionActionSession(
  scope: MobileQuestionScope,
  current: () => MobileWorkCurrent,
  send: (intent: ProjectWorkWriteIntent) => Promise<void>,
  id: () => CommandId,
  changed: () => void = () => {},
) {
  let alive = true;
  let readCurrent = current;
  const initial = reviewMobileQuestion(current(), scope.questionId);
  let target = targetIdentity(initial);
  let targetGateId = initial.question?.targetGateId;
  let targetGateContentHash = initial.gate?.contentHash;
  let blockedRevision: number | null = null;
  let state: MobileQuestionState = { draft: "", status: "idle", notice: null, pending: null };
  const update = (patch: Partial<MobileQuestionState>) => {
    state = { ...state, ...patch };
    if (alive) changed();
  };
  const available = () => {
    const value = readCurrent();
    return alive &&
      value.environmentId === scope.environmentId &&
      value.projectId === scope.projectId &&
      value.taskId === scope.taskId &&
      reviewMobileWork(value).reason === null
      ? value
      : null;
  };
  const execute = async (intent: QuestionIntent) => {
    update({ status: "sending", pending: intent, notice: null });
    try {
      await send(intent);
      blockedRevision = intent.expectedRevision;
      update({
        status: "accepted",
        pending: null,
        notice: "Answer recorded. Refresh to see its result and eligible work.",
      });
    } catch (error) {
      const rejection = publicWorkRejection(error);
      const status = rejection?.status ?? "uncertain";
      if (status === "stale") blockedRevision = intent.expectedRevision;
      update({
        status,
        notice:
          status === "stale"
            ? "This request changed on another client. Your answer is kept. Refresh and review the current question before sending again."
            : (rejection?.notice ??
              "The response was lost. Your answer may be recorded. Retry the exact command after reconnecting or refresh to inspect the result."),
      });
    }
  };
  return {
    get state() {
      return state;
    },
    setCurrent(read: () => MobileWorkCurrent) {
      readCurrent = read;
    },
    edit(draft: string) {
      if (state.status !== "sending" && state.status !== "uncertain") update({ draft });
    },
    async submit() {
      if (state.status !== "idle") return;
      const value = available();
      if (value === null || value.context === null) {
        update({ notice: "Reconnect and refresh this question in its original project." });
        return;
      }
      const review = reviewMobileQuestion(value, scope.questionId);
      if (
        review.reason !== null ||
        review.question === null ||
        review.gate === null ||
        target === null ||
        targetIdentity(review) !== target ||
        value.context.revision === blockedRevision
      ) {
        update({ notice: "The question target changed. Refresh and review before answering." });
        return;
      }
      const answer = state.draft.trim();
      if (review.question.choices.length > 0 && !review.question.choices.includes(answer)) {
        update({ notice: "Choose one of this question's recorded options." });
        return;
      }
      let intent: QuestionIntent;
      try {
        const decoded = decodeWrite({
          commandId: id(),
          projectId: scope.projectId,
          taskId: scope.taskId,
          type: "project-team.question.answer",
          expectedRevision: value.context.revision,
          expectedTaskRevision: value.context.task.revision,
          specRevision: review.gate.specRevision,
          planRevision: review.gate.planRevision,
          questionId: scope.questionId,
          expectedQuestionRevision: review.question.revision,
          expectedGateRevision: review.gate.revision,
          answer,
        });
        if (decoded.type !== "project-team.question.answer") return;
        intent = decoded;
      } catch {
        update({ notice: "Enter an answer between 1 and 4,000 characters." });
        return;
      }
      await execute(intent);
    },
    async retry() {
      if (state.status !== "uncertain" || state.pending === null) return;
      const value = available();
      if (value === null || value.context === null) {
        update({
          notice: "Reconnect and refresh the original project to retry this exact answer.",
        });
        return;
      }
      const review = reviewMobileQuestion(value, scope.questionId);
      const pending = state.pending;
      const question = review.question;
      const gate = review.gate;
      // A lost success may already be visible. Replay only that original answer.
      if (
        question === null ||
        gate === null ||
        question.taskId !== scope.taskId ||
        question.targetGateId !== targetGateId ||
        question.targetRevision !== pending.expectedGateRevision ||
        gate.taskId !== scope.taskId ||
        gate.revision !== pending.expectedGateRevision ||
        gate.specRevision !== pending.specRevision ||
        gate.planRevision !== pending.planRevision ||
        gate.contentHash !== targetGateContentHash ||
        value.context.task.revision !== pending.expectedTaskRevision ||
        value.context.task.specRevision !== pending.specRevision ||
        (question.status === "pending" && review.reason !== null) ||
        !(
          (question.status === "pending" &&
            question.revision === pending.expectedQuestionRevision) ||
          (question.status === "answered" &&
            question.revision === pending.expectedQuestionRevision + 1 &&
            question.answer === pending.answer)
        )
      ) {
        update({ notice: "The original request changed. Refresh to inspect the recorded answer." });
        return;
      }
      await execute(pending);
    },
    review() {
      if (state.status === "sending" || state.status === "uncertain") return;
      const value = available();
      if (value === null) return;
      const next = reviewMobileQuestion(value, scope.questionId);
      if (next.reason !== null || value.context?.revision === blockedRevision) return;
      target = targetIdentity(next);
      targetGateId = next.question?.targetGateId;
      targetGateContentHash = next.gate?.contentHash;
      update({ status: "idle", pending: null, notice: null });
    },
    activate() {
      alive = true;
    },
    dispose() {
      alive = false;
    },
  };
}
