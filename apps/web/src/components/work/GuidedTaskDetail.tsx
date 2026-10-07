import { sha256 } from "@noble/hashes/sha2";
import {
  CommandId,
  ProjectTeamRecord,
  ProjectTeamIntegrationSourceRefs,
  ProjectWorkCriterionId,
  ProjectWorkCriterion,
  ProjectWorkTask,
  ProjectWorkAttemptState,
  ProjectWorkWriteIntent,
  canonicalProjectWorkPayload,
  type EnvironmentId,
  type ProjectId,
  type ProjectTeamGuidedIntent,
  type ProjectTeamWriteIntent,
  type ProjectTeamRecordRead,
  type ProjectWorkTaskContext,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { IntegrationSources } from "./IntegrationSources";
import { WorkCard } from "./WorkDataNotice";
import {
  beginGuidedTaskSubmission,
  compareGuidedTaskDraft,
  createGuidedTaskDraftState,
  discardGuidedTaskDraft,
  editGuidedTaskDraft,
  rebaseGuidedTaskDraft,
  recordGuidedTaskDraftOutcome,
  retryGuidedTaskSubmission,
  type GuidedTaskDraft,
  type GuidedTaskDraftKey,
  type GuidedTaskDraftOutcome,
  type GuidedTaskDraftSubmission,
} from "./guidedTaskDraft";
import { projectWorkCommandFailure } from "./workCommandFailure";

interface GuidedTaskDetailProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly taskContext: ProjectWorkTaskContext | null;
  readonly foundationRecords: ReadonlyArray<ProjectTeamRecordRead>;
  readonly foundationRevision: number | null;
  readonly foundationComplete: boolean;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly onWrite: (intent: ProjectWorkWriteIntent) => Promise<void>;
  readonly onRefresh: () => void;
}

type Intent =
  | ProjectTeamGuidedIntent
  | Extract<ProjectTeamWriteIntent, { type: "project-team.gate.respond" }>;
type Kind = Intent["type"];
type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;
type Plan = Extract<ProjectTeamRecord, { kind: "plan-revision" }>;
const decodeIntegrationSourceRefs = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProjectTeamIntegrationSourceRefs),
);
const decodeIntent = Schema.decodeUnknownSync(Schema.fromJsonString(ProjectWorkWriteIntent));
const descriptionJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const encodeDescriptions = Schema.encodeSync(descriptionJson);
const decodeDescriptions = Schema.decodeUnknownSync(descriptionJson);
const criterionFields = (fields: Readonly<Record<string, string>>) =>
  decodeDescriptions(fields.criteria ?? "{}");
const knownRecord = Schema.is(ProjectTeamRecord);
const knownTask = Schema.is(ProjectWorkTask);
const knownCriterion = Schema.is(ProjectWorkCriterion);
const knownAttemptState = Schema.is(ProjectWorkAttemptState);
const digest = (value: unknown) =>
  [...sha256(new TextEncoder().encode(canonicalProjectWorkPayload(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const one = <T,>(items: ReadonlyArray<T>) => (items.length === 1 ? items[0] : undefined);
const controls = ["defer", "reopen", "pause", "resume", "cancel", "reassign"] as const;

/** Ownership changes remount local drafts and fence callbacks from the previous task. */
export function GuidedTaskDetail(props: GuidedTaskDetailProps) {
  return (
    <GuidedTaskSession
      key={JSON.stringify([
        props.environmentId,
        props.projectId,
        props.taskContext?.projectId,
        props.taskContext?.task.projectId,
        props.taskContext?.task.taskId,
      ])}
      {...props}
    />
  );
}

function GuidedTaskSession(props: GuidedTaskDetailProps) {
  const { taskContext: context, projectId, environmentId, onWrite, onRefresh } = props;
  const [drafts, setDrafts] = useState(createGuidedTaskDraftState);
  const state = useRef(drafts);
  const liveProps = useRef(props);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    liveProps.current = props;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentCallback = () => mounted.current && liveProps.current === props;
  const lifetime = useRef(0);
  const [workerPage, setWorkerPage] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [acceptedRevision, setAcceptedRevision] = useState<number | null>(null);
  const [controlAction, setControlAction] = useState<(typeof controls)[number]>("defer");
  const [recipient, setRecipient] = useState<{
    readonly id: string;
    readonly revision: number;
  } | null>(null);
  const [newCriterionId] = useState(() => ProjectWorkCriterionId.make(randomUUID()));
  useEffect(
    () => () => {
      lifetime.current += 1;
    },
    [],
  );

  const records = props.foundationRecords.filter(knownRecord);
  const task = context?.task;
  const owned = context?.projectId === projectId && task?.projectId === projectId;
  const complete = props.foundationComplete && props.foundationRevision === context?.revision;
  const taskRecords = records.filter(
    (record) =>
      record.projectId === projectId && "taskId" in record && record.taskId === task?.taskId,
  );
  const recordCounts = new Map<string, number>();
  for (const record of props.foundationRecords)
    recordCounts.set(record.recordId, (recordCounts.get(record.recordId) ?? 0) + 1);
  const workers = owned
    ? taskRecords.filter(
        (record) =>
          record.kind === "run-binding" &&
          record.projectId === projectId &&
          record.environmentId === environmentId &&
          recordCounts.get(record.recordId) === 1,
      )
    : [];
  const workerPages = Math.max(1, Math.ceil(workers.length / 10));
  const visibleWorkerPage = Math.min(workerPage, workerPages - 1);
  const membership = one(taskRecords.filter((record) => record.kind === "task-membership"));
  const plans = taskRecords.filter(
    (record): record is Plan => record.kind === "plan-revision" && record.status === "proposed",
  );
  const plan = one(plans);
  const gates = taskRecords.filter((record): record is Gate => record.kind === "gate");
  // Investigation is task-level; attach an issue reference only when its source is unambiguous.
  const issue = one(taskRecords.filter((record) => record.kind === "issue"));
  const criteria = context?.criteria ?? [];
  const known =
    task !== undefined &&
    (context?.activeAttempt === undefined ||
      (context.activeAttempt.taskId === task.taskId &&
        knownAttemptState(context.activeAttempt.state))) &&
    knownTask(task) &&
    criteria.every(knownCriterion) &&
    records.length === props.foundationRecords.length &&
    records.every((record) => record.projectId === projectId) &&
    new Set(records.map((record) => record.recordId)).size === records.length &&
    criteria.every((criterion) => criterion.taskId === task.taskId) &&
    new Set(criteria.map((criterion) => criterion.criterionId)).size === criteria.length;
  const members = records
    .filter((record) => record.kind === "member")
    .filter((record) => record.projectId === projectId && recordCounts.get(record.recordId) === 1);
  const recipients =
    owned && complete && known ? members.filter((member) => member.status === "active") : [];
  const selectedMember = recipients.find(
    (member) => member.recordId === recipient?.id && member.revision === recipient.revision,
  );
  const requestedSuccessor = membership?.requestedSuccessorMemberId;
  const successor = members.find((member) => member.recordId === requestedSuccessor);
  const specificationComplete =
    task?.specification === undefined ||
    (task.specification.revision === task.specRevision &&
      task.specification.criterionIds.every((id) =>
        criteria.some((criterion) => criterion.criterionId === id),
      ));
  const baselineReady =
    owned &&
    complete &&
    known &&
    specificationComplete &&
    membership?.status === "active" &&
    membership.executionKind !== "legacy" &&
    plans.length <= 1;
  const access = props.connected && props.enabled && props.supported;
  const unsettled = drafts.entries.some(
    (draft) => draft.pending?.status === "sending" || draft.pending?.status === "uncertain",
  );
  const canWrite = access && baselineReady && !unsettled && acceptedRevision !== context?.revision;
  const terminal = task?.state === "completed" || task?.state === "canceled";
  const stopped = membership?.controlState !== undefined && membership.controlState !== "active";
  const writer =
    taskRecords.some((record) => record.kind === "run-binding" && record.status !== "settled") ||
    context?.activeAttempt !== undefined;
  const specificationHash = digest({
    specification: task?.specification,
    criteria: criteria
      .map(({ criterionId, description, required, waiver }) => ({
        criterionId,
        description,
        required,
        waiver,
      }))
      .sort((a, b) => (a.criterionId < b.criterionId ? -1 : a.criterionId > b.criterionId ? 1 : 0)),
  });
  const planHash =
    plan &&
    digest({
      content: plan.content,
      dependencyTaskIds: [...plan.dependencyTaskIds].sort(),
      ...(plan.integrationSources === undefined
        ? {}
        : { integrationSources: plan.integrationSources }),
    });
  const specGate = one(
    gates.filter(
      (gate) =>
        gate.gate === "specification" &&
        gate.specRevision === task?.specRevision &&
        gate.planRevision === 0 &&
        gate.contentHash === specificationHash &&
        gate.status !== "invalidated",
    ),
  );
  const planGate = one(
    gates.filter(
      (gate) =>
        gate.gate === "plan" &&
        gate.specRevision === task?.specRevision &&
        gate.planRevision === plan?.planRevision &&
        gate.contentHash === planHash &&
        gate.status !== "invalidated",
    ),
  );
  const scopeHash = digest({
    specificationHash,
    plan: plan && {
      planRevision: plan.planRevision,
      contentHash: planHash,
      dependencyTaskIds: [...plan.dependencyTaskIds].sort(),
    },
  });
  const executionGranted = gates.some(
    (gate) =>
      gate.gate === "execution" &&
      gate.contentHash === scopeHash &&
      (gate.status === "approved" || gate.status === "consumed"),
  );
  const repair = taskRecords.some(
    (record) =>
      record.kind === "repair-episode" &&
      (record.status === "exhausted" ||
        (record.status === "active" && record.pendingSemanticRepair !== false)),
  );

  const update = (next: typeof drafts) => {
    state.current = next;
    setDrafts(next);
  };
  const draftFor = (kind: Kind) => drafts.entries.find((draft) => draft.key.kind === kind);
  const draftDescriptions = criterionFields(
    draftFor("project-team.specification.propose")?.fields ?? {},
  );
  const keyFor = (kind: Kind): GuidedTaskDraftKey | null =>
    task ? { environmentId, projectId, taskId: task.taskId, kind } : null;
  const base = task &&
    context && {
      commandId: CommandId.make(randomUUID()),
      projectId,
      taskId: task.taskId,
      expectedRevision: context.revision,
      expectedTaskRevision: task.revision,
    };
  const original = (draft?: GuidedTaskDraft) => draft && decodeIntent(draft.originalIntentJson);

  function build(
    kind: Kind,
    fields: Readonly<Record<string, string>> = {},
    draft?: GuidedTaskDraft,
  ): Intent | null {
    if (!base || !task || !context) return null;
    const source = original(draft);
    const descriptions = criterionFields(fields);
    switch (kind) {
      case "project-team.investigation.start":
        return {
          ...base,
          type: kind,
          objective: fields.objective ?? task.summary ?? task.title,
          outputDescriptions: (fields.outputs ?? "Findings, sources, and unresolved decisions")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          ...(issue?.kind === "issue"
            ? { issueRecordId: issue.recordId, expectedIssueRevision: issue.revision }
            : {}),
        };
      case "project-team.specification.propose": {
        const retained =
          source?.type === kind
            ? [
                ...criteria,
                ...source.criterionSnapshots.filter(
                  (criterion) =>
                    !criteria.some((current) => current.criterionId === criterion.criterionId),
                ),
              ]
            : criteria;
        const snapshots = retained.map((criterion) => ({
          criterionId: criterion.criterionId,
          taskId: task.taskId,
          description: descriptions[`criterion:${criterion.criterionId}`] ?? criterion.description,
          required: criterion.required,
          status: "unsatisfied" as const,
          satisfiedByEvidenceIds: [],
          revision: criterion.revision,
          updatedAt: criterion.updatedAt,
        }));
        for (const [field, description] of Object.entries(descriptions)) {
          if (
            field.startsWith("new-criterion:") &&
            !snapshots.some((criterion) => criterion.criterionId === field.slice(14))
          )
            snapshots.push({
              criterionId: ProjectWorkCriterionId.make(field.slice(14)),
              taskId: task.taskId,
              description,
              required: true,
              status: "unsatisfied",
              satisfiedByEvidenceIds: [],
              revision: 0,
              updatedAt: task.updatedAt,
            });
        }
        if (snapshots.length === 0)
          snapshots.push({
            criterionId: newCriterionId,
            taskId: task.taskId,
            description:
              descriptions[`criterion:${newCriterionId}`] ?? "Describe the acceptance criterion",
            required: true,
            status: "unsatisfied",
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: task.updatedAt,
          });
        return {
          ...base,
          type: kind,
          expectedSpecRevision: task.specRevision,
          specification: {
            objective: fields.objective ?? task.specification?.objective ?? task.title,
            scopeIn: fields.scopeIn ?? task.specification?.scopeIn ?? "Describe the included scope",
            scopeOut:
              fields.scopeOut ?? task.specification?.scopeOut ?? "Describe the excluded scope",
            criterionIds: snapshots.map((criterion) => criterion.criterionId),
            revision: task.specRevision + 1,
            protected: false,
          },
          criterionSnapshots: snapshots,
        };
      }
      case "project-team.plan.propose":
        return task.specification
          ? {
              ...base,
              type: kind,
              specRevision: task.specRevision,
              content:
                fields.content ??
                plan?.content ??
                "Describe the implementation and validation plan",
              dependencyTaskIds: plan?.dependencyTaskIds ?? [],
              ...(selectedSources(fields).length === 0
                ? {}
                : { integrationSourceRefs: selectedSources(fields) }),
              ...(plan
                ? { previousPlanId: plan.recordId, expectedPreviousPlanRevision: plan.revision }
                : {}),
            }
          : null;
      case "project-team.gate.respond": {
        const gate = fields.gate === "plan" ? planGate : specGate;
        if (!gate || (gate.status !== "pending" && gate.status !== "proposed")) return null;
        return {
          ...base,
          type: kind,
          specRevision: gate.specRevision,
          planRevision: gate.planRevision,
          gateId: gate.recordId,
          expectedGateRevision: gate.revision,
          response: fields.response === "rejected" ? "rejected" : "approved",
        };
      }
      case "project-team.execution.start":
        return plan &&
          plan.specRevision === task.specRevision &&
          planGate?.status === "approved" &&
          specGate?.status === "approved" &&
          planGate.attribution.actor.kind === "human" &&
          specGate.attribution.actor.kind === "human" &&
          !terminal &&
          !stopped &&
          !writer &&
          !executionGranted &&
          !repair
          ? {
              ...base,
              type: kind,
              specRevision: task.specRevision,
              planRevision: plan.planRevision,
              specGateId: specGate.recordId,
              expectedSpecGateRevision: specGate.revision,
              planId: plan.recordId,
              expectedPlanRecordRevision: plan.revision,
              planGateId: planGate.recordId,
              expectedPlanGateRevision: planGate.revision,
            }
          : null;
      case "project-team.task.control":
        if (
          (controlAction === "resume" || controlAction === "reopen") &&
          (writer || repair || (requestedSuccessor !== undefined && successor?.status !== "active"))
        )
          return null;
        if ((controlAction === "pause" || controlAction === "defer") && terminal) return null;
        if (controlAction === "reassign") {
          if (!recipient || !selectedMember || terminal) return null;
          return {
            ...base,
            type: kind,
            control: {
              action: "reassign",
              reason: fields.reason ?? "Describe why this work should change state",
              recipientMemberId: recipient.id,
              expectedMemberRevision: recipient.revision,
            },
          };
        }
        return {
          ...base,
          type: kind,
          control: {
            action: controlAction,
            reason: fields.reason ?? "Describe why this work should change state",
          },
        };
      default:
        return null;
    }
  }

  const retainedSources = () =>
    plan?.integrationSources?.sources.map((source) => ({
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
    })) ?? [];
  function selectedSources(fields: Readonly<Record<string, string>>) {
    const value = fields.integrationSourceRefs;
    if (value === undefined) return retainedSources();
    if (value === "[]") return [];
    return decodeIntegrationSourceRefs(value);
  }

  function defaultFields(kind: Kind): Readonly<Record<string, string>> {
    if (!task) return {};
    if (kind === "project-team.specification.propose")
      return {
        objective: task.specification?.objective ?? task.title,
        scopeIn: task.specification?.scopeIn ?? "",
        scopeOut: task.specification?.scopeOut ?? "",
        criteria: encodeDescriptions(
          Object.fromEntries(
            (criteria.length ? criteria : [{ criterionId: newCriterionId, description: "" }]).map(
              (criterion) => [`criterion:${criterion.criterionId}`, criterion.description],
            ),
          ),
        ),
      };
    if (kind === "project-team.plan.propose")
      return {
        content: plan?.content ?? "",
        integrationSourceRefs: JSON.stringify(retainedSources()),
      };
    if (kind === "project-team.task.control") return { reason: "" };
    return {};
  }

  function edit(kind: Kind, patch: Readonly<Record<string, string>>) {
    const key = keyFor(kind);
    const current = build(kind);
    if (!key || !current || draftFor(kind)?.pending) return;
    const defaults = defaultFields(kind);
    const descriptions = Object.fromEntries(
      Object.entries(patch).filter(
        ([name]) => name.startsWith("criterion:") || name.startsWith("new-criterion:"),
      ),
    );
    const next = editGuidedTaskDraft(state.current, key, current, {
      ...(!draftFor(kind) ? defaults : {}),
      ...Object.fromEntries(Object.entries(patch).filter(([name]) => !(name in descriptions))),
      ...(Object.keys(descriptions).length
        ? {
            criteria: encodeDescriptions({
              ...criterionFields(draftFor(kind)?.fields ?? defaults),
              ...descriptions,
            }),
          }
        : {}),
    });
    if (next.ok) update(next.state);
    else
      setNotice(
        "This draft exceeds the retained draft limit. Shorten the content before continuing.",
      );
  }

  async function send(submission: GuidedTaskDraftSubmission) {
    if (!currentCallback() || !access || !baselineReady) return;
    const owner = lifetime.current;
    let outcome: GuidedTaskDraftOutcome = "success";
    let message: string | null = null;
    try {
      await onWrite(decodeIntent(submission.intentJson));
    } catch (error) {
      const failure = projectWorkCommandFailure(error);
      const code: unknown =
        error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
      outcome = failure.staleRevision
        ? "stale"
        : code === "authority-required" ||
            code === "unauthorized" ||
            code === "permission-denied" ||
            code === "invalid-state" ||
            code === "invalid-input"
          ? "denied"
          : code === "unsupported" || code === "unavailable"
            ? "unavailable"
            : "uncertain";
      message = failure.message;
    }
    if (owner !== lifetime.current) return;
    const next = recordGuidedTaskDraftOutcome(state.current, submission, outcome);
    if (!next.ok) return;
    update(next.state);
    setNotice(message);
    if (outcome === "success") {
      const intent = decodeIntent(submission.intentJson);
      setAcceptedRevision(intent.expectedRevision ?? null);
      onRefresh();
    }
  }

  function submit(kind: Kind, patch: Readonly<Record<string, string>> = {}) {
    if (
      !currentCallback() ||
      !canWrite ||
      state.current.entries.some(
        (draft) => draft.pending?.status === "sending" || draft.pending?.status === "uncertain",
      )
    )
      return;
    const key = keyFor(kind);
    const existing = draftFor(kind);
    const fields = { ...defaultFields(kind), ...existing?.fields, ...patch };
    if (
      kind === "project-team.specification.propose" &&
      (!fields.objective?.trim() ||
        !fields.scopeIn?.trim() ||
        !fields.scopeOut?.trim() ||
        Object.entries(criterionFields(fields)).some(
          ([name, text]) =>
            (name.startsWith("criterion:") || name.startsWith("new-criterion:")) && !text.trim(),
        ))
    ) {
      setNotice("Complete the objective, included scope, excluded scope, and acceptance criteria.");
      return;
    }
    if (kind === "project-team.plan.propose" && !fields.content?.trim()) {
      setNotice("Describe the implementation and validation plan.");
      return;
    }
    const intent = build(kind, fields, existing);
    if (!key || !intent) return;
    let current = state.current;
    if (!existing) {
      const next = editGuidedTaskDraft(current, key, intent, fields);
      if (!next.ok) {
        setNotice("The draft is invalid or too large. Review the required fields.");
        return;
      }
      current = next.state;
    }
    const next = beginGuidedTaskSubmission(current, key, intent);
    if (!next.ok) {
      update(current);
      setNotice("Review the required fields and current revisions before submitting.");
      return;
    }
    update(next.state);
    setNotice(null);
    void send(next.submission);
  }

  function status(kind: Kind) {
    const draft = draftFor(kind);
    if (!draft) return null;
    const current = build(kind, draft.fields, draft);
    const comparison = current && compareGuidedTaskDraft(drafts, draft.key, current);
    const changed = draft.needsReview || comparison?.targetsChanged || !current;
    return (
      <div className="mt-3 space-y-2 text-sm" role="status">
        {draft.pending?.status === "sending" ? <p>Saving this exact request…</p> : null}
        {draft.pending?.status === "uncertain" ? (
          <>
            <p>The outcome is unknown. Resolve this exact request before sending another change.</p>
            <Button
              size="sm"
              variant="outline"
              disabled={!access}
              onClick={() => {
                const next = retryGuidedTaskSubmission(state.current, draft.key);
                if (next.ok && "submission" in next) {
                  update(next.state);
                  void send(next.submission);
                }
              }}
            >
              Retry exact request
            </Button>
          </>
        ) : null}
        {(changed ||
          draft.pending?.status === "denied" ||
          draft.pending?.status === "unavailable") &&
        draft.pending?.status !== "sending" &&
        draft.pending?.status !== "uncertain" ? (
          <>
            <p>
              Saved draft targets changed. Compare the current content above before keeping your
              edits.
            </p>
            <p className="text-xs text-muted-foreground">
              Draft project revision {decodeIntent(draft.originalIntentJson).expectedRevision};
              current project revision {context?.revision}.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={!access || !baselineReady || !current}
              onClick={() => {
                if (!current) return;
                const next = rebaseGuidedTaskDraft(state.current, draft.key, current);
                if (next.ok) {
                  update(next.state);
                  setNotice(null);
                }
              }}
            >
              Keep edits against reviewed revisions
            </Button>
          </>
        ) : null}
        {draft.pending?.status === "denied" || draft.pending?.status === "unavailable" ? (
          <p>
            This request was refused. Refresh and review the current targets before trying again.
          </p>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={draft.pending?.status === "sending" || draft.pending?.status === "uncertain"}
          onClick={() => {
            const next = discardGuidedTaskDraft(state.current, draft.key);
            if (next.ok) update(next.state);
          }}
        >
          Discard local draft
        </Button>
      </div>
    );
  }

  const blockedDraft = (kind: Kind) => {
    const draft = draftFor(kind);
    if (!draft) return false;
    const current = build(kind, draft.fields, draft);
    return Boolean(
      draft.pending ||
      draft.needsReview ||
      !current ||
      compareGuidedTaskDraft(drafts, draft.key, current)?.targetsChanged,
    );
  };
  const field = (kind: Kind, name: string, label: string, fallback: string, maxLength = 4000) => (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      <Textarea
        aria-label={label}
        maxLength={maxLength}
        value={
          (name.startsWith("criterion:") || name.startsWith("new-criterion:")
            ? draftDescriptions[name]
            : draftFor(kind)?.fields[name]) ?? fallback
        }
        disabled={Boolean(draftFor(kind)?.pending)}
        onChange={(event) => edit(kind, { [name]: event.target.value })}
      />
    </label>
  );

  if (!task)
    return (
      <WorkCard>
        <p className="text-sm text-muted-foreground">
          Select a task to review its findings, specification, and plan.
        </p>
      </WorkCard>
    );
  const specKind = "project-team.specification.propose";
  const specDraft = draftFor(specKind);
  const specSource = original(specDraft);
  const draftCriteria = specSource?.type === specKind ? specSource.criterionSnapshots : criteria;
  const extraCriteria = Object.keys(draftDescriptions).filter((field) =>
    field.startsWith("new-criterion:"),
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">{task.title}</h2>
          <p className="text-xs text-muted-foreground">
            {task.state} · Project revision {context?.revision} · Specification {task.specRevision}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh}>
          Refresh task
        </Button>
      </div>
      {!access || !baselineReady ? (
        <p role="status" className="text-sm text-warning-foreground">
          {!props.connected
            ? "Showing saved work while disconnected. Reconnect before making changes."
            : !props.enabled
              ? "Project work writes are disabled."
              : !props.supported
                ? "This environment does not support guided task writes."
                : !owned
                  ? "This task belongs to another project."
                  : !complete
                    ? "Waiting for a complete foundation read at the task's project revision."
                    : "Some records are missing, ambiguous, or unsupported. Refresh before making changes."}
        </p>
      ) : null}
      {acceptedRevision === context?.revision ? (
        <p role="status" className="text-sm text-muted-foreground">
          Request accepted. Refreshing the saved task before the next change.
        </p>
      ) : null}
      {notice ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {notice}
        </p>
      ) : null}
      <WorkCard>
        <h3 className="mb-3 font-medium">Recorded workers</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          {props.connected && complete
            ? "Recorded worker history"
            : "Cached or incomplete worker history"}
        </p>
        {workers.slice(visibleWorkerPage * 10, (visibleWorkerPage + 1) * 10).map((run) => {
          if (run.kind !== "run-binding") return null;
          const role = one(
            records.filter(
              (record) =>
                record.kind === "role-revision" &&
                record.projectId === projectId &&
                record.recordId === run.roleRevisionId &&
                recordCounts.get(record.recordId) === 1,
            ),
          );
          return (
            <div key={run.recordId} className="mb-3 space-y-1 text-sm">
              <p>
                {role?.kind === "role-revision" ? role.role : "Role unavailable"} · {run.model} ·{" "}
                {run.status}
              </p>
              <p className="text-xs text-muted-foreground">
                Run {run.recordId} · Attempt {run.attemptId}
              </p>
              <p className="text-xs text-muted-foreground">
                Specification {run.specRevision} · plan {run.planRevision}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {run.worktree} · {run.branch}
              </p>
              <a
                className="text-primary underline"
                href={`/${encodeURIComponent(environmentId)}/${encodeURIComponent(run.threadId)}`}
              >
                Worker thread {run.threadId}
              </a>
            </div>
          );
        })}
        {workers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No workers recorded for this task.</p>
        ) : null}
        {workerPages > 1 ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={visibleWorkerPage === 0}
              onClick={() => setWorkerPage(visibleWorkerPage - 1)}
            >
              Previous workers
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={visibleWorkerPage + 1 === workerPages}
              onClick={() => setWorkerPage(visibleWorkerPage + 1)}
            >
              Next workers
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {visibleWorkerPage + 1} of {workerPages}
            </span>
          </div>
        ) : null}
      </WorkCard>
      <WorkCard>
        <h3 className="mb-3 font-medium">Internal findings</h3>
        {context?.comments.map((comment) => (
          <p key={comment.commentId} className="mb-2 whitespace-pre-wrap break-words text-sm">
            {comment.body}
          </p>
        ))}
        {context?.children.comments.map((comment) => (
          <p key={comment.commentId} className="mb-2 whitespace-pre-wrap break-words text-sm">
            {comment.body}
          </p>
        ))}
        {[...(context?.evidence ?? []), ...(context?.children.evidence ?? [])].map((evidence) => (
          <details key={evidence.evidenceId} className="mb-2 text-sm">
            <summary>{evidence.summary}</summary>
            <p className="whitespace-pre-wrap break-words">{evidence.detail ?? evidence.summary}</p>
            <p className="text-xs text-muted-foreground">
              Task {evidence.taskId} · Evidence {evidence.evidenceId}
            </p>
          </details>
        ))}
        {!context?.comments.length &&
        !context?.children.comments.length &&
        !context?.evidence.length &&
        !context?.children.evidence.length ? (
          <p className="mb-3 text-sm text-muted-foreground">No findings have been recorded yet.</p>
        ) : null}
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium">Investigate this task</summary>
          <div className="mt-3 space-y-3">
            {field(
              "project-team.investigation.start",
              "objective",
              "Investigation objective",
              task.summary ?? task.title,
              32000,
            )}
            {field(
              "project-team.investigation.start",
              "outputs",
              "Expected findings (one per line)",
              "Findings, sources, and unresolved decisions",
              64000,
            )}
            <p className="text-xs text-muted-foreground">
              Starts linked research. Implementation still requires specification and plan approval.
            </p>
            <Button
              size="sm"
              disabled={
                !canWrite ||
                terminal ||
                stopped ||
                repair ||
                blockedDraft("project-team.investigation.start")
              }
              onClick={() => submit("project-team.investigation.start")}
            >
              Start investigation
            </Button>
            {status("project-team.investigation.start")}
          </div>
        </details>
      </WorkCard>
      <WorkCard>
        <h3 className="mb-3 font-medium">Specification revision {task.specRevision}</h3>
        {task.specification ? (
          <div className="mb-4 space-y-2 whitespace-pre-wrap break-words text-sm">
            <p>{task.specification.objective}</p>
            <p>Included: {task.specification.scopeIn}</p>
            <p>Excluded: {task.specification.scopeOut}</p>
            <ul className="list-disc pl-5">
              {criteria.map((criterion) => (
                <li key={criterion.criterionId}>
                  {criterion.description} · {criterion.status}
                  {criterion.required ? " · required" : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mb-3 text-sm text-muted-foreground">No specification proposed yet.</p>
        )}
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Propose a revised specification
          </summary>
          <div className="mt-3 space-y-3">
            {field(
              specKind,
              "objective",
              "Specification objective",
              task.specification?.objective ?? task.title,
            )}
            {field(specKind, "scopeIn", "Included scope", task.specification?.scopeIn ?? "")}
            {field(specKind, "scopeOut", "Excluded scope", task.specification?.scopeOut ?? "")}
            {(draftCriteria.length
              ? draftCriteria
              : [{ criterionId: newCriterionId, description: "" }]
            ).map((criterion, index) => (
              <div key={criterion.criterionId}>
                {field(
                  specKind,
                  `criterion:${criterion.criterionId}`,
                  `Acceptance criterion ${index + 1}`,
                  criterion.description,
                )}
              </div>
            ))}
            {extraCriteria.map((name, index) => (
              <div key={name}>{field(specKind, name, `Additional criterion ${index + 1}`, "")}</div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(specDraft?.pending)}
              onClick={() => edit(specKind, { [`new-criterion:${randomUUID()}`]: "" })}
            >
              Add acceptance criterion
            </Button>
            <p className="text-xs text-muted-foreground">
              Proposing resets criterion satisfaction and invalidates approvals and execution for
              the previous scope.
            </p>
            <Button
              size="sm"
              disabled={!canWrite || terminal || blockedDraft(specKind)}
              onClick={() => submit(specKind)}
            >
              Propose specification
            </Button>
            {status(specKind)}
          </div>
        </details>
      </WorkCard>
      <WorkCard>
        <h3 className="mb-3 font-medium">
          Proposed plan{plan ? ` revision ${plan.planRevision}` : ""}
        </h3>
        {plan ? (
          <>
            <p className="whitespace-pre-wrap break-words text-sm">{plan.content}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Specification {plan.specRevision} · Record revision {plan.revision}
              {plan.dependencyTaskIds.length
                ? ` · Dependencies: ${plan.dependencyTaskIds.join(", ")}`
                : ""}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No current plan proposed.</p>
        )}
        {plan?.integrationSources && (
          <div className="mt-3 space-y-2 text-xs">
            <p className="font-medium">Frozen integration sources for this plan</p>
            <ol className="space-y-2">
              {plan.integrationSources.sources.map((source, index) => (
                <li key={source.taskId} className="rounded border border-border p-2">
                  <p>
                    {index + 1}. Task {source.taskId}
                  </p>
                  <p className="break-all font-mono">{source.branchRef}</p>
                  <p className="break-all font-mono">Commit {source.headSha}</p>
                  <p className="break-all font-mono text-muted-foreground">Base {source.baseSha}</p>
                </li>
              ))}
            </ol>
            <p className="text-muted-foreground">
              Plan approval includes these exact reviewed commits in this order.
            </p>
          </div>
        )}
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium">Propose a plan</summary>
          <div className="mt-3 space-y-3">
            {field(
              "project-team.plan.propose",
              "content",
              "Implementation and validation plan",
              plan?.content ?? "",
              32000,
            )}
            <IntegrationSources
              environmentId={environmentId}
              projectId={projectId}
              taskId={task.taskId}
              revision={context!.revision}
              taskRevision={task.revision}
              disabled={
                !canWrite ||
                terminal ||
                membership?.deliverableKind !== "code" ||
                !task.specification ||
                Boolean(draftFor("project-team.plan.propose")?.pending)
              }
              selected={selectedSources(draftFor("project-team.plan.propose")?.fields ?? {})}
              onChange={(selected) =>
                edit("project-team.plan.propose", {
                  integrationSourceRefs: JSON.stringify(selected),
                })
              }
            />
            <Button
              size="sm"
              disabled={
                !canWrite ||
                terminal ||
                !task.specification ||
                blockedDraft("project-team.plan.propose")
              }
              onClick={() => submit("project-team.plan.propose")}
            >
              Propose plan
            </Button>
            {status("project-team.plan.propose")}
          </div>
        </details>
      </WorkCard>
      <WorkCard>
        <h3 className="mb-3 font-medium">Approvals and execution</h3>
        {gates.length ? (
          gates.map((gate) => (
            <div
              key={gate.recordId}
              className="mb-3 space-y-1 border-b border-border/60 pb-3 text-sm"
            >
              <p>
                {gate.gate} · {gate.status} · specification {gate.specRevision} · plan{" "}
                {gate.planRevision}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                Gate {gate.recordId} · revision {gate.revision} · content {gate.contentHash}
              </p>
              {gate.status === "invalidated" ? (
                <p className="text-warning-foreground">
                  This approval no longer authorizes execution. Review the current specification and
                  plan.
                </p>
              ) : null}
              {(gate.recordId === specGate?.recordId || gate.recordId === planGate?.recordId) &&
              (gate.status === "pending" || gate.status === "proposed") ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={!canWrite || blockedDraft("project-team.gate.respond")}
                    onClick={() =>
                      submit("project-team.gate.respond", { gate: gate.gate, response: "approved" })
                    }
                  >
                    Approve {gate.gate} revision{" "}
                    {gate.gate === "plan" ? gate.planRevision : gate.specRevision}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canWrite || blockedDraft("project-team.gate.respond")}
                    onClick={() =>
                      submit("project-team.gate.respond", { gate: gate.gate, response: "rejected" })
                    }
                  >
                    Reject {gate.gate} revision{" "}
                    {gate.gate === "plan" ? gate.planRevision : gate.specRevision}
                  </Button>
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <p className="mb-3 text-sm text-muted-foreground">No approval gates recorded.</p>
        )}
        {status("project-team.gate.respond")}
        <p className="mb-3 text-sm text-muted-foreground">
          {executionGranted
            ? "Execution is already authorized for this scope."
            : "Execution requires the current specification and plan to be approved, with prior workers stopped."}
        </p>
        <Button
          size="sm"
          disabled={
            !canWrite ||
            !build("project-team.execution.start") ||
            blockedDraft("project-team.execution.start")
          }
          onClick={() => submit("project-team.execution.start")}
        >
          Start execution
        </Button>
        {status("project-team.execution.start")}
      </WorkCard>
      <WorkCard>
        <h3 className="mb-3 font-medium">
          Task controls{membership?.controlState ? ` · ${membership.controlState}` : ""}
        </h3>
        <div className="space-y-3">
          <label className="block text-sm">
            Action
            <select
              aria-label="Task control action"
              className="ml-2 rounded border border-border bg-background px-2 py-1"
              value={controlAction}
              disabled={Boolean(draftFor("project-team.task.control")?.pending)}
              onChange={(event) => {
                const action = controls.find((item) => item === event.target.value);
                if (action) setControlAction(action);
              }}
            >
              {controls.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </label>
          {requestedSuccessor ? (
            <p>
              Requested successor: {successor?.name ?? requestedSuccessor} · {requestedSuccessor}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Reassignment requests a successor and pauses owned work. Resume is separate and rechecks
            ownership, drains, and approvals on the server.
          </p>
          {controlAction === "reassign" ? (
            <label className="block text-sm">
              Recipient
              <select
                aria-label="Reassignment recipient"
                value={recipient ? JSON.stringify([recipient.id, recipient.revision]) : ""}
                disabled={
                  !access ||
                  !baselineReady ||
                  Boolean(draftFor("project-team.task.control")?.pending)
                }
                onChange={(event) => {
                  const member = recipients.find(
                    (entry) =>
                      JSON.stringify([entry.recordId, entry.revision]) === event.target.value,
                  );
                  setRecipient(member ? { id: member.recordId, revision: member.revision } : null);
                }}
              >
                <option value="">Select a current active member</option>
                {recipients.map((member) => (
                  <option
                    key={member.recordId}
                    value={JSON.stringify([member.recordId, member.revision])}
                  >
                    {member.name} · {member.recordId} · revision {member.revision}
                  </option>
                ))}
              </select>
              {recipient && !selectedMember ? (
                <p>
                  Recipient changed or is unavailable. Select and review a current member before
                  sending.
                </p>
              ) : null}
            </label>
          ) : null}
          {field("project-team.task.control", "reason", "Control reason", "")}
          <Button
            size="sm"
            variant="outline"
            disabled={
              !canWrite ||
              blockedDraft("project-team.task.control") ||
              !draftFor("project-team.task.control")?.fields.reason?.trim() ||
              ((controlAction === "defer" ||
                controlAction === "pause" ||
                controlAction === "reassign") &&
                terminal) ||
              (controlAction === "reassign" && !selectedMember) ||
              ((controlAction === "resume" || controlAction === "reopen") &&
                (writer ||
                  repair ||
                  (requestedSuccessor !== undefined && successor?.status !== "active")))
            }
            onClick={() => submit("project-team.task.control")}
          >
            Apply {controlAction}
          </Button>
          {status("project-team.task.control")}
        </div>
      </WorkCard>
    </div>
  );
}
