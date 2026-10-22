import {
  prepareProjectWorkRecoveredDelivery,
  projectWorkSelectionIsCurrent,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import type {
  ProjectMemorySourceRead,
  ProjectTeamIntegrationSourceRef,
  ProjectTeamMemorySourceSelector,
  ProjectTeamRecordRead,
  ProjectWorkCriterionId,
  ProjectWorkDeliveryRequest,
} from "@t3tools/contracts";
import { asProjectTeamRecord } from "@t3tools/client-runtime/project-work";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { uuidv4 } from "../../lib/uuid";
import { WorkBlock, WorkFormActions, WorkInput, WorkReadNotice, WorkText } from "./WorkParts";
import type { Surface } from "./WorkTaskScreen";
import { newCommandId, useWorkRead, useWorkReview } from "./useWork";
import { useWorkRecords, workRecordsBlockedReason } from "./useWorkRecords";
import { gateResponses, shortHash, workStateLabel } from "./workModel";
import {
  bindingPhase,
  canPrepareDelivery,
  DELIVERY_PHASE_DETAIL,
  DELIVERY_STAGE,
  deliveryAvailability,
  deliveryProgress,
  integrationCoverage,
  moveIntegrationSource,
  planIntegrationRefs,
  toggleIntegrationSource,
  type WorkDeliverySource,
  type WorkRecoveryItem,
  deliveryGates,
  findingFreshness,
  FRESHNESS_LABEL,
  gateFreshness,
  makeDispatchIntent,
  makeMemoryRetractIntent,
  makeMemorySharesIntent,
  makeMessageAttentionIntent,
  makeMessageSendIntent,
  makeQuestionAnswerIntent,
  makeQuestionRequestIntent,
  makeVerificationProposal,
  MEMORY_SOURCE_STATUS,
  MEMORY_STATUS,
  memoryShareRecipients,
  messageActions,
  openMessages,
  recordsOfKind,
  reviewSummary,
  splitArguments,
  makeAssignmentStartIntent,
  makeExecutionStartIntent,
  makeInvestigationStartIntent,
  makeMemoryPromoteIntent,
  memorySelector,
  PROPOSAL_LABEL,
  proposalAvailability,
  proposalOutputs,
  roleNeedsWorktree,
  sameMemorySelector,
  scannedPageState,
  sharedSourceSelection,
  startAvailability,
  startCandidates,
  startChoiceProblem,
  type WorkProposalKind,
  type WorkGate,
  type WorkMessageAction,
  type WorkQuestionRecord,
} from "./workPresentation";

const MEMORY_PAGE = 16;
const newestFirst = <T extends { readonly updatedAt: string }>(a: T, b: T) =>
  b.updatedAt.localeCompare(a.updatedAt);

function taskFields(surface: Surface, selected: ProjectWorkSelection) {
  return {
    commandId: newCommandId(),
    projectId: surface.scope.projectId,
    taskId: surface.context.task.taskId,
    expectedRevision: selected.revision,
    expectedTaskRevision: selected.taskRevision,
  };
}
function teamFields(surface: Surface, selected: ProjectWorkSelection) {
  return {
    ...taskFields(surface, selected),
    specRevision: surface.context.task.specRevision,
    planRevision: surface.model.plan?.planRevision ?? 0,
  };
}
const projectFields = (surface: Surface) => ({
  commandId: newCommandId(),
  projectId: surface.scope.projectId,
  expectedRevision: surface.current.revision,
});
const teamRecordsOf = (values: ReadonlyArray<unknown>) =>
  values.flatMap((value): ProjectTeamRecordRead[] => {
    const record = asProjectTeamRecord(value);
    return record === null ? [] : [record];
  });

/** Approval and starting stay separate: this reports whether a worker has started. */
export function executionState(surface: Surface) {
  const live = recordsOfKind(surface.records, "run-binding").find(
    (binding) => bindingPhase(binding.status).live,
  );
  if (live !== undefined)
    return { label: bindingPhase(live.status).label, detail: "A worker is on this task." };
  const start = startAvailability({
    membership: surface.model.membership,
    records: surface.records,
    terminal: surface.model.terminal,
  });
  return "plan" in start
    ? { label: "Ready to start", detail: "Approved. Nothing runs until you start a worker." }
    : { label: "Not started", detail: start.reason };
}

// ── Workers, questions, messages ───────────────────────────────────────────

export function TaskWorkers({ surface }: { surface: Surface }) {
  if (!surface.model.guided) return null;
  const bindings = recordsOfKind(surface.records, "run-binding").sort(newestFirst).slice(0, 8);
  return (
    <ListSection title="Workers">
      {bindings.length === 0 ? (
        <WorkBlock>
          <WorkText muted>No worker has run this task yet.</WorkText>
        </WorkBlock>
      ) : (
        bindings.map((binding) => (
          <WorkBlock key={binding.recordId}>
            <WorkText>
              {bindingPhase(binding.status).label} · {binding.model}
            </WorkText>
            <WorkText muted>
              {binding.workspaceState === "pending"
                ? "Preparing a workspace"
                : (binding.branch ?? binding.worktree ?? "Project checkout")}
            </WorkText>
            {binding.status === "quarantined" ? (
              <WorkText muted>
                Work can't confirm what this worker did last. Resume or reassign to recover.
              </WorkText>
            ) : null}
          </WorkBlock>
        ))
      )}
      <ProposeWork surface={surface} />
      <StartWorker surface={surface} />
      <Questions surface={surface} />
      <Messages surface={surface} />
    </ListSection>
  );
}

function StartWorker({ surface }: { surface: Surface }) {
  const { scope, writer, model } = surface;
  const availability = startAvailability({
    membership: model.membership,
    records: surface.records,
    terminal: model.terminal,
  });
  const members = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "foundation-records",
    recordKind: "member",
  });
  const roles = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "foundation-records",
    recordKind: "role-revision",
  });
  const review = useWorkReview(surface.current);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [baseRef, setBaseRef] = useState("");
  const [root, setRoot] = useState(false);
  const key = "start";
  if ("reason" in availability)
    return (
      <ListActionRow
        label="Start worker"
        description={availability.reason}
        disabled
        onPress={() => {}}
      />
    );
  const plan = availability.plan;
  const candidates = startCandidates(
    recordsOfKind(teamRecordsOf(members.records), "member"),
    recordsOfKind(teamRecordsOf(roles.records), "role-revision"),
    plan,
  );
  const chosen = candidates.find((entry) => entry.member.recordId === memberId) ?? null;
  const problem = startChoiceProblem(
    chosen,
    root ? { type: "root" } : { type: "worktree", baseRef },
  );
  const blocked =
    model.blockedReason ??
    surface.blocked ??
    workRecordsBlockedReason(members, "team members") ??
    workRecordsBlockedReason(roles, "team roles");
  if (review.selected === null)
    return (
      <ListActionRow
        label="Start worker…"
        description={blocked ?? "The assignment is approved. Starting it is a separate step."}
        disabled={blocked !== null || writer.pendingKey !== null}
        onPress={() => {
          setMemberId(
            candidates.find((entry) => entry.ineligible === null && entry.preferred)?.member
              .recordId ??
              candidates.find((entry) => entry.ineligible === null)?.member.recordId ??
              null,
          );
          setRoot(false);
          review.open();
        }}
      />
    );
  const send = async () => {
    if (review.selected === null || chosen === null || problem !== null) return;
    const sent = await writer.submit(
      key,
      review.selected,
      surface.current,
      makeDispatchIntent(taskFields(surface, review.selected), {
        plan,
        member: chosen.member,
        role: chosen.role,
        workspace: root ? { type: "root" } : { type: "worktree", baseRef: baseRef.trim() },
      }),
    );
    if (sent) review.close();
  };
  return (
    <View>
      {candidates.map((entry) => (
        <ListChoiceRow
          key={entry.member.recordId}
          label={entry.member.name}
          description={entry.ineligible ?? `${entry.role.role} · ${entry.role.model}`}
          selected={entry.member.recordId === memberId}
          disabled={entry.ineligible !== null}
          onPress={() => setMemberId(entry.member.recordId)}
        />
      ))}
      <ListChoiceRow label="New worktree" selected={!root} onPress={() => setRoot(false)} />
      <ListChoiceRow
        label="Project checkout"
        {...(chosen !== null && roleNeedsWorktree(chosen.role.role)
          ? { description: `A ${chosen.role.role} works in its own worktree.` }
          : {})}
        disabled={chosen !== null && roleNeedsWorktree(chosen.role.role)}
        selected={root}
        onPress={() => setRoot(true)}
      />
      <WorkBlock>
        {!root ? (
          <WorkInput label="Base branch" value={baseRef} onChange={setBaseRef} maxLength={256} />
        ) : null}
        <WorkText muted>
          Runs one worker on {plan.providerInstanceId} for this assignment, within the team's
          limits.
        </WorkText>
        {problem !== null ? <WorkText muted>{problem}</WorkText> : null}
        <WorkFormActions
          submitLabel="Confirm start"
          pending={writer.pendingKey === key}
          disabled={problem !== null || blocked !== null}
          onSubmit={() => void send()}
          onCancel={review.close}
          failure={writer.failureFor(key)}
          changed={review.changed}
          onReview={review.rebase}
        />
      </WorkBlock>
    </View>
  );
}

const PROPOSAL_KINDS: ReadonlyArray<WorkProposalKind> = [
  "execution",
  "planning",
  "implementation",
  "review",
  "investigation",
];

/**
 * Human proposals that authorize one worker for this task or a new child task.
 * Recording one never starts a worker; Start worker is the separate next step.
 */
function ProposeWork({ surface }: { surface: Surface }) {
  const { model, context, writer } = surface;
  const review = useWorkReview(surface.current);
  const [kind, setKind] = useState<WorkProposalKind | null>(null);
  const [objective, setObjective] = useState("");
  const [outputs, setOutputs] = useState("");
  const [criterionIds, setCriterionIds] = useState<ReadonlyArray<string>>([]);
  const key = "propose";
  const availability = proposalAvailability(
    {
      terminal: model.terminal,
      controlState: model.controlState,
      membership: model.membership,
      specGate: model.specGate,
      plan: model.plan,
      planCurrent: model.planCurrent,
      planGate: model.planGate,
      hasSpecification: context.task.specification !== undefined,
    },
    surface.records,
  );
  const blocked = model.blockedReason ?? surface.blocked;
  const specCriteria = context.criteria.filter((criterion) =>
    context.task.specification?.criterionIds.includes(criterion.criterionId),
  );
  const close = () => {
    review.close();
    setKind(null);
  };
  if (review.selected === null || kind === null) {
    const available = PROPOSAL_KINDS.filter((entry) => availability[entry] === null);
    if (available.length === 0)
      return (
        <ListActionRow
          label="Propose work"
          description={availability.execution ?? "Nothing can be proposed right now."}
          disabled
          onPress={() => {}}
        />
      );
    return (
      <>
        {available.map((entry) => (
          <ListActionRow
            key={entry}
            label={`${PROPOSAL_LABEL[entry]}…`}
            description={blocked ?? "Records what may run. Starting a worker is separate."}
            disabled={blocked !== null || writer.pendingKey !== null}
            onPress={() => {
              setKind(entry);
              setObjective(context.task.summary ?? context.task.title);
              setOutputs("");
              setCriterionIds(specCriteria.map((criterion) => criterion.criterionId));
              review.open();
            }}
          />
        ))}
      </>
    );
  }
  // An implementation's outputs are the parent criteria it was chosen to deliver.
  const outputList =
    kind === "implementation"
      ? specCriteria
          .filter((criterion) => criterionIds.includes(criterion.criterionId))
          .map((criterion) => criterion.description)
      : proposalOutputs(outputs);
  const problem =
    availability[kind] ??
    (kind === "execution"
      ? null
      : objective.trim() === ""
        ? "Describe the objective."
        : kind === "implementation"
          ? criterionIds.length === 0
            ? "Choose at least one criterion to implement."
            : null
          : outputList.length === 0
            ? "List at least one expected output."
            : null);
  const send = async () => {
    const selected = review.selected;
    if (selected === null || problem !== null) return;
    const base = taskFields(surface, selected);
    const { specGate, plan, planGate } = model;
    const intent =
      kind === "investigation"
        ? makeInvestigationStartIntent(base, { objective, outputs: outputList })
        : kind === "execution"
          ? specGate !== null && plan !== null && planGate !== null
            ? makeExecutionStartIntent(base, {
                specRevision: context.task.specRevision,
                specGate,
                plan,
                planGate,
              })
            : null
          : specGate !== null
            ? makeAssignmentStartIntent(base, {
                kind,
                objective,
                outputs: outputList,
                specRevision: context.task.specRevision,
                specGate,
                plan,
                planGate,
                criterionIds,
              })
            : null;
    if (intent === null) return;
    if (await writer.submit(key, selected, surface.current, intent)) close();
  };
  return (
    <View>
      <WorkBlock>
        <WorkText>{PROPOSAL_LABEL[kind]}</WorkText>
        {kind === "execution" ? (
          <WorkText muted>
            Authorizes one worker to deliver this task under the approved scope and plan.
          </WorkText>
        ) : (
          <WorkInput label="Objective" value={objective} onChange={setObjective} multiline />
        )}
      </WorkBlock>
      {kind === "implementation"
        ? specCriteria.map((criterion) => {
            const on = criterionIds.includes(criterion.criterionId);
            return (
              <ListChoiceRow
                key={criterion.criterionId}
                label={criterion.description}
                selected={on}
                onPress={() =>
                  setCriterionIds(
                    on
                      ? criterionIds.filter((entry) => entry !== criterion.criterionId)
                      : [...criterionIds, criterion.criterionId],
                  )
                }
              />
            );
          })
        : null}
      <WorkBlock>
        {kind !== "execution" && kind !== "implementation" ? (
          <WorkInput
            label={kind === "planning" ? "Expected plan" : "Expected outputs, one per line"}
            value={outputs}
            onChange={setOutputs}
            multiline
          />
        ) : null}
        {problem !== null ? <WorkText muted>{problem}</WorkText> : null}
        <WorkFormActions
          submitLabel="Record proposal"
          pending={writer.pendingKey === key}
          disabled={problem !== null || blocked !== null}
          onSubmit={() => void send()}
          onCancel={close}
          failure={writer.failureFor(key)}
          changed={review.changed}
          onReview={review.rebase}
        />
      </WorkBlock>
    </View>
  );
}

function Questions({ surface }: { surface: Surface }) {
  const questions = recordsOfKind(surface.records, "question").sort(newestFirst);
  return (
    <>
      {questions
        .filter((question) => question.status === "pending")
        .map((question) => (
          <QuestionRow key={question.recordId} surface={surface} question={question} />
        ))}
      <AskQuestion surface={surface} />
    </>
  );
}

function QuestionRow({ surface, question }: { surface: Surface; question: WorkQuestionRecord }) {
  const { writer } = surface;
  const [answer, setAnswer] = useState("");
  const key = `question:${question.recordId}`;
  const gate =
    recordsOfKind(surface.records, "gate").find((g) => g.recordId === question.targetGateId) ??
    null;
  const blocked = surface.model.blockedReason ?? surface.blocked;
  const send = async (value: string) => {
    const sent = await writer.submit(
      key,
      surface.current,
      surface.current,
      makeQuestionAnswerIntent(teamFields(surface, surface.current), question, gate, value),
    );
    if (sent) setAnswer("");
  };
  return (
    <WorkBlock>
      <WorkText>{question.body}</WorkText>
      <WorkText muted>Waiting for you · from {question.senderId}</WorkText>
      {question.choices.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {question.choices.map((choice) => (
            <Button
              key={choice}
              label={choice}
              tone="secondary"
              disabled={blocked !== null || writer.pendingKey !== null}
              onPress={() => void send(choice)}
            />
          ))}
        </View>
      ) : null}
      <WorkInput label="Answer" value={answer} onChange={setAnswer} />
      {writer.failureFor(key) ? <Notice tone="danger" message={writer.failureFor(key)!} /> : null}
      <View className="flex-row">
        <Button
          label="Answer"
          loading={writer.pendingKey === key}
          disabled={answer.trim() === "" || blocked !== null || writer.pendingKey !== null}
          onPress={() => void send(answer)}
        />
      </View>
    </WorkBlock>
  );
}

function AskQuestion({ surface }: { surface: Surface }) {
  const { writer, model } = surface;
  const review = useWorkReview(surface.current);
  const [body, setBody] = useState("");
  const key = "question:request";
  const gate =
    [model.planGate, model.specGate].find(
      (entry) => entry !== null && (entry.status === "pending" || entry.status === "proposed"),
    ) ?? null;
  const blocked = model.blockedReason ?? surface.blocked;
  if (gate === null) return null;
  if (review.selected === null)
    return (
      <ListActionRow
        label="Ask the team…"
        {...(blocked ? { description: blocked } : {})}
        disabled={blocked !== null || writer.pendingKey !== null}
        onPress={review.open}
      />
    );
  const send = async () => {
    if (review.selected === null) return;
    const sent = await writer.submit(
      key,
      review.selected,
      surface.current,
      makeQuestionRequestIntent(teamFields(surface, review.selected), {
        questionId: uuidv4(),
        gate,
        body,
        choices: [],
      }),
    );
    if (sent) {
      setBody("");
      review.close();
    }
  };
  return (
    <WorkBlock>
      <WorkInput
        label="Question for the team"
        value={body}
        onChange={setBody}
        multiline
        maxLength={32000}
      />
      <WorkFormActions
        submitLabel="Send question"
        pending={writer.pendingKey === key}
        disabled={body.trim() === "" || blocked !== null}
        onSubmit={() => void send()}
        onCancel={review.close}
        failure={writer.failureFor(key)}
        changed={review.changed}
        onReview={review.rebase}
      />
    </WorkBlock>
  );
}

const MESSAGE_LABEL: Record<WorkMessageAction, string> = {
  acknowledge: "Mark seen",
  resolve: "Resolve",
};

function Messages({ surface }: { surface: Surface }) {
  const { writer, model } = surface;
  const [body, setBody] = useState("");
  const blocked = model.blockedReason ?? surface.blocked;
  const live = recordsOfKind(surface.records, "run-binding").find(
    (b) => bindingPhase(b.status).live,
  );
  const key = "message:send";
  const messages = openMessages(surface.records).slice(0, 8);
  const send = async () => {
    if (live === undefined || model.membership === null) return;
    const sent = await writer.submit(
      key,
      surface.current,
      surface.current,
      makeMessageSendIntent(teamFields(surface, surface.current), {
        messageId: uuidv4(),
        recipientId: live.memberId,
        membership: model.membership,
        body,
      }),
    );
    if (sent) setBody("");
  };
  return (
    <>
      {messages.map((message) => (
        <WorkBlock key={message.recordId}>
          <WorkText>{message.body}</WorkText>
          <WorkText muted>
            {message.senderId}
            {message.status === "uncertain" ? " · delivery unknown" : ""}
          </WorkText>
          <View className="flex-row flex-wrap gap-2">
            {messageActions(message).map((action) => (
              <Button
                key={action}
                label={MESSAGE_LABEL[action]}
                tone="secondary"
                disabled={blocked !== null || writer.pendingKey !== null}
                onPress={() =>
                  void writer.submit(
                    `message:${message.recordId}`,
                    surface.current,
                    surface.current,
                    makeMessageAttentionIntent(projectFields(surface), message, action),
                  )
                }
              />
            ))}
          </View>
        </WorkBlock>
      ))}
      {live !== undefined && model.membership !== null ? (
        <WorkBlock>
          <WorkInput
            label="Message the worker"
            value={body}
            onChange={setBody}
            multiline
            maxLength={32000}
          />
          {writer.failureFor(key) ? (
            <Notice tone="danger" message={writer.failureFor(key)!} />
          ) : null}
          <View className="flex-row">
            <Button
              label="Send message"
              loading={writer.pendingKey === key}
              disabled={body.trim() === "" || blocked !== null || writer.pendingKey !== null}
              onPress={() => void send()}
            />
          </View>
        </WorkBlock>
      ) : null}
    </>
  );
}

// ── Review and checks ──────────────────────────────────────────────────────

const GATE_LABEL: Record<string, string> = {
  verification: "Run checks",
  publication: "Open pull request",
  merge: "Merge",
};
const RESPONSE_LABEL = { approved: "Approve", rejected: "Reject", invalidated: "Revoke" } as const;

export function TaskReview({ surface }: { surface: Surface }) {
  const { model, context } = surface;
  if (!model.guided) return null;
  const current = {
    specRevision: context.task.specRevision,
    planRevision: model.plan?.planRevision ?? null,
  };
  const gates = deliveryGates(surface.records);
  const findings = recordsOfKind(surface.records, "review-finding").sort(newestFirst);
  const evidence = recordsOfKind(surface.records, "evidence-applicability").sort(newestFirst);
  const summary = reviewSummary(findings, current);
  return (
    <ListSection
      title="Review and checks"
      footer={
        findings.length > 0
          ? `${summary.open} open · ${summary.stale} on an older revision · ${summary.resolved} resolved`
          : "Results bind to one exact revision. Newer scope makes them out of date."
      }
    >
      {gates.length + findings.length + evidence.length === 0 ? (
        <WorkBlock>
          <WorkText muted>No checks or review yet.</WorkText>
        </WorkBlock>
      ) : null}
      {gates.map((gate) => (
        <GateRow key={gate.recordId} surface={surface} gate={gate} current={current} />
      ))}
      {findings.slice(0, 12).map((finding) => (
        <WorkBlock key={finding.recordId}>
          <WorkText>{finding.detail}</WorkText>
          <WorkText muted>
            {finding.status === "resolved"
              ? `Resolved with ${finding.resolutionArtifactIds.length} recorded artifacts`
              : `Finding · ${FRESHNESS_LABEL[findingFreshness(finding, current)]}`}
          </WorkText>
        </WorkBlock>
      ))}
      {evidence.slice(0, 6).map((entry) => (
        <WorkBlock key={entry.recordId}>
          <WorkText>
            {entry.status === "current"
              ? entry.exitCode === 0
                ? "Passed"
                : `Failed (exit ${entry.exitCode})`
              : `${workStateLabel(entry.status)} · doesn't count now`}
          </WorkText>
          <WorkText muted>{entry.command}</WorkText>
        </WorkBlock>
      ))}
      <ProposeCheck surface={surface} />
    </ListSection>
  );
}

function GateRow({
  surface,
  gate,
  current,
}: {
  surface: Surface;
  gate: WorkGate;
  current: { specRevision: number; planRevision: number | null };
}) {
  const { writer } = surface;
  const [confirming, setConfirming] = useState<keyof typeof RESPONSE_LABEL | null>(null);
  const [showJob, setShowJob] = useState(false);
  const review = useWorkReview(surface.current);
  const freshness = gateFreshness(gate, current);
  const responses = gateResponses(gate).filter(
    (r) => freshness === "current" || r === "invalidated",
  );
  const blocked = surface.model.blockedReason ?? surface.blocked;
  const key = `gate:${gate.recordId}`;
  const respond = async () => {
    if (confirming === null || review.selected === null) return;
    const sent = await writer.submit(key, review.selected, surface.current, {
      ...taskFields(surface, review.selected),
      type: "project-team.gate.respond",
      specRevision: gate.specRevision,
      planRevision: gate.planRevision,
      gateId: gate.recordId,
      expectedGateRevision: gate.revision,
      response: confirming,
    });
    if (sent) {
      setConfirming(null);
      review.close();
    }
  };
  return (
    <View>
      <WorkBlock>
        <WorkText>
          {GATE_LABEL[gate.gate] ?? workStateLabel(gate.gate)} · {workStateLabel(gate.status)} ·{" "}
          {FRESHNESS_LABEL[freshness]}
        </WorkText>
        <WorkText muted>
          {[
            gate.repository,
            gate.pullRequestNumber !== undefined ? `#${gate.pullRequestNumber}` : null,
            gate.targetBranch ? `→ ${gate.targetBranch}` : null,
            `content ${shortHash(gate.contentHash)}`,
          ]
            .filter(Boolean)
            .join(" ")}
        </WorkText>
        {gate.headSha !== undefined || gate.mergeMethod !== undefined ? (
          <WorkText muted>
            {[
              gate.headSha !== undefined ? `head ${gate.headSha.slice(0, 12)}` : null,
              gate.mergeMethod !== undefined ? `${gate.mergeMethod} merge` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </WorkText>
        ) : null}
        {freshness === "stale" && gate.status !== "invalidated" ? (
          <WorkText muted>
            The scope or plan changed after this was proposed, so it can't be approved.
          </WorkText>
        ) : null}
      </WorkBlock>
      {gate.verificationJobId !== undefined ? (
        <ListActionRow
          label={showJob ? "Hide exact command" : "Show exact command"}
          onPress={() => setShowJob(!showJob)}
        />
      ) : null}
      {showJob && gate.verificationJobId !== undefined ? (
        <VerificationJob surface={surface} jobId={gate.verificationJobId} gate={gate} />
      ) : null}
      {confirming === null ? (
        responses.map((response) => (
          <ListActionRow
            key={response}
            label={RESPONSE_LABEL[response]}
            tone={response === "approved" ? "default" : "danger"}
            {...(blocked ? { description: blocked } : {})}
            disabled={blocked !== null || writer.pendingKey !== null}
            onPress={() => {
              setConfirming(response);
              review.open();
            }}
          />
        ))
      ) : (
        <WorkBlock>
          <WorkText muted>
            {confirming === "approved"
              ? gate.gate === "verification"
                ? "This runs exactly the command shown, once, on the recorded commit."
                : gate.gate === "merge"
                  ? `This allows merging pull request ${gate.pullRequestNumber !== undefined ? `#${gate.pullRequestNumber}` : "(number not recorded)"} at head ${gate.headSha?.slice(0, 12) ?? "(not recorded)"} into ${gate.targetBranch ?? "its target"} by ${gate.mergeMethod ?? "the recorded method"}. You still merge it yourself.`
                  : gate.gate === "publication"
                    ? `This allows publishing head ${gate.headSha?.slice(0, 12) ?? "(not recorded)"} to ${gate.repository ?? "the repository"} → ${gate.targetBranch ?? "its target"}. You still publish it yourself.`
                    : "This allows that one step. You still publish or merge it yourself."
              : "This records your decision only."}
          </WorkText>
          <WorkFormActions
            submitLabel={`Confirm ${RESPONSE_LABEL[confirming].toLowerCase()}`}
            pending={writer.pendingKey === key}
            disabled={blocked !== null}
            onSubmit={() => void respond()}
            onCancel={() => {
              setConfirming(null);
              review.close();
            }}
            failure={writer.failureFor(key)}
            changed={review.changed}
            onReview={review.rebase}
          />
        </WorkBlock>
      )}
    </View>
  );
}

function VerificationJob({
  surface,
  jobId,
  gate,
}: {
  surface: Surface;
  jobId: string;
  gate: WorkGate;
}) {
  const view = useWorkRead(surface.scope.environmentId, {
    projectId: surface.scope.projectId,
    operation: "verification-job",
    taskId: surface.context.task.taskId,
    verificationJobId: jobId,
  });
  const job = view.special?.operation === "verification-job" ? view.special.value : null;
  if (job === null) return <WorkReadNotice view={view} subject="the check" />;
  const manifest = job.manifest;
  return (
    <WorkBlock>
      <WorkText>{[manifest.command.executable, ...manifest.command.argv].join(" ")}</WorkText>
      <WorkText muted>
        {manifest.target.branchRef} · {manifest.target.testedCommit.slice(0, 12)} ·{" "}
        {manifest.criteria.length} criteria
      </WorkText>
      {job.sha256 !== gate.contentHash ? (
        <Notice
          tone="danger"
          message="This command doesn't match what the gate recorded. Don't approve it."
        />
      ) : null}
    </WorkBlock>
  );
}

function ProposeCheck({ surface }: { surface: Surface }) {
  const { writer, context, model } = surface;
  const review = useWorkReview(surface.current);
  const [criteria, setCriteria] = useState<ReadonlyArray<ProjectWorkCriterionId>>([]);
  const [executable, setExecutable] = useState("");
  const [args, setArgs] = useState("");
  const key = "verification:propose";
  const binding = recordsOfKind(surface.records, "run-binding")
    .filter((entry) => entry.status === "settled" || bindingPhase(entry.status).live)
    .sort(newestFirst)[0];
  const blocked = model.blockedReason ?? surface.blocked;
  if (binding === undefined || model.plan === null) return null;
  if (review.selected === null)
    return (
      <ListActionRow
        label="Propose a check…"
        {...(blocked ? { description: blocked } : {})}
        disabled={blocked !== null || writer.pendingKey !== null}
        onPress={review.open}
      />
    );
  const send = async () => {
    if (review.selected === null) return;
    const sent = await writer.submit(
      key,
      review.selected,
      surface.current,
      makeVerificationProposal(teamFields(surface, review.selected), {
        jobId: uuidv4(),
        binding,
        criterionIds: criteria,
        executable,
        argv: splitArguments(args),
        maxDurationMs: 600_000,
        maxOutputBytes: 262_144,
      }),
    );
    if (sent) review.close();
  };
  return (
    <View>
      {context.criteria.map((criterion) => (
        <ListChoiceRow
          key={criterion.criterionId}
          label={criterion.description}
          selected={criteria.includes(criterion.criterionId)}
          onPress={() =>
            setCriteria(
              criteria.includes(criterion.criterionId)
                ? criteria.filter((id) => id !== criterion.criterionId)
                : [...criteria, criterion.criterionId],
            )
          }
        />
      ))}
      <WorkBlock>
        <WorkInput label="Program (absolute path)" value={executable} onChange={setExecutable} />
        <WorkInput label="Arguments" value={args} onChange={setArgs} />
        <WorkText muted>Nothing runs until you approve the exact command it captures.</WorkText>
        <WorkFormActions
          submitLabel="Propose check"
          pending={writer.pendingKey === key}
          disabled={criteria.length === 0 || !executable.trim().startsWith("/") || blocked !== null}
          onSubmit={() => void send()}
          onCancel={review.close}
          failure={writer.failureFor(key)}
          changed={review.changed}
          onReview={review.rebase}
        />
      </WorkBlock>
    </View>
  );
}

// ── Delivery ───────────────────────────────────────────────────────────────

type Preview = Extract<ProjectWorkDeliveryRequest, { operation: "preview" }>;
const RECOVERY_LIMIT = 32;
const SOURCE_PAGE = 16;
const MERGE_METHODS = [
  ["squash", "Squash"],
  ["merge", "Merge commit"],
  ["rebase", "Rebase"],
] as const;

/**
 * Ordered integration inputs, then pull request and merge as separate,
 * explicitly approved steps. Progress is rebuilt from the task's retained
 * delivery rows, so leaving or reloading never loses an operation.
 */
export function TaskDelivery({ surface }: { surface: Surface }) {
  const { model } = surface;
  if (
    !model.guided ||
    model.membership?.executionKind !== "managed" ||
    model.membership.deliverableKind !== "code"
  )
    return null;
  return <DeliveryContent surface={surface} />;
}

function DeliveryContent({ surface }: { surface: Surface }) {
  const { scope, context } = surface;
  const taskId = context.task.taskId;
  const [offset, setOffset] = useState(0);
  // Own-source search pages independently of the candidate list's offset.
  const [ownCursor, setOwnCursor] = useState<string | undefined>(undefined);
  const sourcesView = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "integration-sources",
    taskId,
    limit: SOURCE_PAGE,
    offset,
    ...(ownCursor === undefined ? {} : { ownSourceCursor: ownCursor }),
  });
  const page =
    sourcesView.special?.operation === "integration-sources" ? sourcesView.special.value : null;
  const own = page?.ownSource ?? null;
  return (
    <>
      <IntegrationInputs
        surface={surface}
        page={page}
        offset={offset}
        onOffset={setOffset}
        view={sourcesView}
      />
      {page === null ? (
        <ListSection title="Reviewed result">
          <WorkReadNotice view={sourcesView} subject="the reviewed result" />
        </ListSection>
      ) : own === null && page.ownSourceNextCursor !== undefined ? (
        <ListSection title="Reviewed result">
          <WorkBlock>
            <WorkText muted>
              No current reviewed result among the latest reviews checked. Older reviews may still
              qualify.
            </WorkText>
          </WorkBlock>
          <ListActionRow
            label="Search more reviewed work"
            onPress={() => setOwnCursor(page.ownSourceNextCursor)}
          />
        </ListSection>
      ) : null}
      <Delivery
        key={`${scope.environmentId}:${scope.checkoutPath}:${taskId}`}
        surface={surface}
        source={
          own !== null
            ? "current"
            : page === null || page.ownSourceNextCursor !== undefined
              ? "checking"
              : "missing"
        }
        sourceRef={own?.ref ?? null}
        branch={own?.source.branchRef ?? null}
      />
    </>
  );
}

type SourcePage = NonNullable<
  Extract<
    NonNullable<ReturnType<typeof useWorkRead>["special"]>,
    { operation: "integration-sources" }
  >["value"]
>;

/** Reviewed results from other tasks, chosen in the order the plan should integrate them. */
function IntegrationInputs({
  surface,
  page,
  offset,
  onOffset,
  view,
}: {
  surface: Surface;
  page: SourcePage | null;
  offset: number;
  onOffset: (offset: number) => void;
  view: ReturnType<typeof useWorkRead>;
}) {
  const { context, model, writer } = surface;
  const plan = model.plan;
  const review = useWorkReview(surface.current);
  const [selected, setSelected] = useState<ProjectTeamIntegrationSourceRef[]>(() =>
    planIntegrationRefs(plan),
  );
  const coverage = integrationCoverage(selected, plan?.dependencyTaskIds ?? []);
  const blocked = model.blockedReason ?? surface.blocked;
  const key = "integration:plan";
  if (plan === null) return null;
  const propose = async () => {
    if (review.selected === null || selected.length === 0) return;
    const sent = await writer.submit(key, review.selected, surface.current, {
      ...taskFields(surface, review.selected),
      type: "project-team.plan.propose",
      specRevision: context.task.specRevision,
      content: plan.content,
      dependencyTaskIds: plan.dependencyTaskIds,
      integrationSourceRefs: selected,
      previousPlanId: plan.recordId,
      expectedPreviousPlanRevision: plan.revision,
    });
    if (sent) review.close();
  };
  if (review.selected === null)
    return (
      <ListSection title="Integration inputs">
        <WorkBlock>
          <WorkText muted>
            {selected.length === 0
              ? "The plan names no reviewed inputs."
              : `${selected.length} reviewed ${selected.length === 1 ? "input" : "inputs"} in order: ${selected.map((ref) => ref.taskId).join(" → ")}`}
          </WorkText>
        </WorkBlock>
        <ListActionRow
          label="Choose reviewed inputs…"
          {...(blocked ? { description: blocked } : {})}
          disabled={blocked !== null || writer.pendingKey !== null}
          onPress={review.open}
        />
      </ListSection>
    );
  return (
    <ListSection
      title="Integration inputs"
      footer="The plan needs approval again before these inputs are used."
    >
      <WorkReadNotice view={view} subject="reviewed inputs" />
      {page !== null && page.candidates.length === 0 && offset === 0 ? (
        <WorkBlock>
          <WorkText muted>No other task has passed review yet.</WorkText>
        </WorkBlock>
      ) : null}
      {page?.candidates.map((candidate) => {
        const index = selected.findIndex((entry) => entry.taskId === candidate.ref.taskId);
        return (
          <View key={candidate.ref.taskId}>
            <ListChoiceRow
              label={index >= 0 ? `${index + 1}. ${candidate.taskTitle}` : candidate.taskTitle}
              description={`head ${candidate.source.headSha.slice(0, 8)}`}
              selected={index >= 0}
              onPress={() => setSelected(toggleIntegrationSource(selected, candidate.ref))}
            />
            {index >= 0 ? (
              <View className="flex-row justify-end gap-2 px-4">
                <Button
                  label="Earlier"
                  tone="text"
                  disabled={index === 0}
                  onPress={() => setSelected(moveIntegrationSource(selected, index, -1))}
                />
                <Button
                  label="Later"
                  tone="text"
                  disabled={index === selected.length - 1}
                  onPress={() => setSelected(moveIntegrationSource(selected, index, 1))}
                />
              </View>
            ) : null}
          </View>
        );
      })}
      {page !== null && (page.hasMore || offset > 0) ? (
        <View className="flex-row justify-end gap-2 px-4 py-2">
          <Button
            label="Previous"
            tone="text"
            disabled={offset === 0}
            onPress={() => onOffset(Math.max(0, offset - SOURCE_PAGE))}
          />
          <Button
            label="Next"
            tone="text"
            disabled={!page.hasMore}
            onPress={() => onOffset(page.nextOffset)}
          />
        </View>
      ) : null}
      <WorkBlock>
        {coverage.missing.length > 0 ? (
          <WorkText muted>
            {coverage.missing.length} plan{" "}
            {coverage.missing.length === 1 ? "dependency has" : "dependencies have"} no selected
            reviewed input.
          </WorkText>
        ) : null}
        <WorkFormActions
          submitLabel="Propose plan with these inputs"
          pending={writer.pendingKey === key}
          disabled={selected.length === 0 || blocked !== null}
          onSubmit={() => void propose()}
          onCancel={() => {
            setSelected(planIntegrationRefs(plan));
            review.close();
          }}
          failure={writer.failureFor(key)}
          changed={review.changed}
          onReview={review.rebase}
        />
      </WorkBlock>
    </ListSection>
  );
}

/**
 * Mounted for the task whether or not its reviewed source is still current: retained
 * operations and receipts stay reachable, and only new previews need `sourceRef`.
 */
function Delivery({
  surface,
  source,
  sourceRef,
  branch,
}: {
  surface: Surface;
  source: WorkDeliverySource;
  sourceRef: ProjectTeamIntegrationSourceRef | null;
  branch: string | null;
}) {
  const { scope, context, writer } = surface;
  const taskId = context.task.taskId;
  const [baseRef, setBaseRef] = useState("");
  const [title, setTitle] = useState(context.task.title);
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [accepted, setAccepted] = useState(false);
  // Reading never writes; every retry below is an explicit press on the original request.
  const recoveryView = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "delivery-recovery",
    taskId,
    limit: RECOVERY_LIMIT,
  });
  const recovery =
    recoveryView.special?.operation === "delivery-recovery" ? recoveryView.special.value : null;
  const gates = recordsOfKind(surface.records, "gate");
  const { publication, merge } = deliveryProgress(recovery?.items ?? [], gates);
  const availability = deliveryAvailability({ source, recovery });
  const blocked =
    surface.blocked ?? (writer.canDeliver ? null : "This connection can't publish or merge here.");
  const prepareBlocked = blocked ?? availability.prepareBlocked;
  const busy = writer.pendingKey !== null;

  const recovered = (item: WorkRecoveryItem | null) =>
    item === null || recovery === null || item.request.operation === "accept"
      ? null
      : prepareProjectWorkRecoveredDelivery({
          selected: surface.current,
          current: surface.current,
          readScope: scope,
          recovery,
          operationId: item.result.operationId,
          operation: item.request.operation,
        });

  const preview = (kind: "create-pr" | "merge", target: string) => {
    const selected = surface.current;
    const publicationOperationId =
      publication.phase === "confirmed" ? publication.operation?.result.operationId : undefined;
    if (sourceRef === null || (kind === "merge" && publicationOperationId === undefined)) return;
    const request: Preview = {
      operation: "preview",
      input: {
        commandId: newCommandId(),
        expectedRevision: selected.revision,
        projectId: scope.projectId,
        taskId,
        sourceRef,
        baseRef: target.trim(),
        kind,
        ...(kind === "merge" && publicationOperationId !== undefined
          ? { publicationOperationId, mergeMethod: method }
          : {}),
      },
    };
    void writer.runDelivery(`delivery:preview:${kind}`, selected, surface.current, request);
  };
  const publish = () => {
    if (publication.phase === "reconcile") {
      const original = recovered(publication.operation);
      if (original !== null)
        void writer.runDelivery(
          "delivery:publish",
          surface.current,
          surface.current,
          original.request,
        );
      return;
    }
    const reviewed = recovered(publication.preview);
    if (publication.phase !== "ready" || reviewed === null) return;
    if (reviewed.request.operation !== "preview") return;
    void writer.runDelivery("delivery:publish", surface.current, surface.current, {
      operation: "publish",
      input: {
        operationId: reviewed.reviewedOperation.operationId,
        projectId: scope.projectId,
        taskId,
        gateId: publication.preview!.gateId,
        sourceRef: reviewed.request.input.sourceRef,
        title: title.trim(),
        body: context.task.summary ?? "",
      },
    });
  };
  const runMerge = () => {
    if (merge.phase === "reconcile") {
      const original = recovered(merge.operation);
      if (original !== null)
        void writer.runDelivery(
          "delivery:merge",
          surface.current,
          surface.current,
          original.request,
          original.reviewedOperation,
        );
      return;
    }
    const reviewed = recovered(merge.preview);
    const publicationOperationId = reviewed?.reviewedOperation.publicationOperationId;
    if (merge.phase !== "ready" || reviewed === null || publicationOperationId === undefined)
      return;
    void writer.runDelivery(
      "delivery:merge",
      surface.current,
      surface.current,
      {
        operation: "merge",
        input: {
          operationId: reviewed.reviewedOperation.operationId,
          publicationOperationId,
          gateId: merge.preview!.gateId,
        },
      },
      reviewed.reviewedOperation,
    );
  };
  // Acceptance uses the confirmed merge's server receipt exactly; the user never types it.
  const receipt =
    merge.phase === "confirmed" ? (recovered(merge.operation)?.reviewedOperation ?? null) : null;
  const accept = async () => {
    if (receipt === null || receipt.receiptHash === undefined) return;
    const result = await writer.runDelivery(
      "delivery:accept",
      surface.current,
      surface.current,
      {
        operation: "accept",
        input: { operationId: receipt.operationId, expectedReceiptHash: receipt.receiptHash },
      },
      receipt,
    );
    if (result !== null) setAccepted(true);
  };

  const pub = publication.operation?.result ?? null;
  const merged = merge.operation?.result ?? null;
  const failure =
    writer.failureFor("delivery:preview:create-pr") ??
    writer.failureFor("delivery:publish") ??
    writer.failureFor("delivery:preview:merge") ??
    writer.failureFor("delivery:merge") ??
    writer.failureFor("delivery:accept");
  const mergeTarget = publication.preview?.baseRef ?? baseRef;
  const shownBranch =
    branch ??
    (publication.preview?.request.operation === "preview"
      ? publication.preview.request.input.sourceRef.expectedBranchRef
      : null);

  if (!availability.showTracks)
    return recovery === null || source === "missing" ? (
      <ListSection title="Delivery">
        {recovery === null ? (
          <WorkReadNotice view={recoveryView} subject="delivery history" />
        ) : (
          <WorkBlock>
            <WorkText muted>
              This task's result appears here after it passes independent review.
            </WorkText>
          </WorkBlock>
        )}
      </ListSection>
    ) : null;

  return (
    <ListSection
      title="Delivery"
      footer={
        prepareBlocked ??
        (shownBranch === null
          ? undefined
          : `From ${shownBranch}${publication.preview ? ` → ${publication.preview.baseRef}` : ""}`)
      }
    >
      <WorkReadNotice view={recoveryView} subject="delivery history" />
      {failure ? (
        <WorkBlock>
          <Notice tone="danger" message={failure} />
        </WorkBlock>
      ) : null}
      <WorkBlock>
        <WorkText>
          Pull request{pub ? ` · ${DELIVERY_STAGE[pub.stage].label}` : ""}
          {pub?.pullRequest ? ` · #${pub.pullRequest.number}` : ""}
        </WorkText>
        <WorkText muted>{DELIVERY_PHASE_DETAIL[publication.phase]}</WorkText>
      </WorkBlock>
      {canPrepareDelivery(publication.phase) && sourceRef !== null ? (
        <WorkBlock>
          <WorkInput label="Target branch" value={baseRef} onChange={setBaseRef} maxLength={256} />
          <View className="flex-row">
            <Button
              label={
                publication.phase === "superseded"
                  ? "Prepare pull request again"
                  : "Prepare pull request"
              }
              tone="secondary"
              loading={writer.pendingKey === "delivery:preview:create-pr"}
              disabled={baseRef.trim() === "" || prepareBlocked !== null || busy}
              onPress={() => preview("create-pr", baseRef)}
            />
          </View>
        </WorkBlock>
      ) : null}
      {publication.phase === "ready" ? (
        <WorkBlock>
          <WorkInput label="Title" value={title} onChange={setTitle} />
          <View className="flex-row">
            <Button
              label="Publish pull request"
              loading={writer.pendingKey === "delivery:publish"}
              disabled={
                title.trim() === "" ||
                blocked !== null ||
                busy ||
                recovered(publication.preview) === null
              }
              onPress={publish}
            />
          </View>
        </WorkBlock>
      ) : null}
      {publication.phase === "reconcile" ? (
        <ListActionRow
          label="Check again"
          loading={writer.pendingKey === "delivery:publish"}
          disabled={blocked !== null || busy || recovered(publication.operation) === null}
          onPress={publish}
        />
      ) : null}
      {publication.phase === "confirmed" ? (
        <>
          <WorkBlock>
            <WorkText>
              Merge{merged ? ` · ${DELIVERY_STAGE[merged.stage].label}` : ""}
              {merged?.mergedCommitSha ? ` · ${merged.mergedCommitSha.slice(0, 12)}` : ""}
            </WorkText>
            <WorkText muted>{DELIVERY_PHASE_DETAIL[merge.phase]}</WorkText>
          </WorkBlock>
          {canPrepareDelivery(merge.phase) && sourceRef !== null ? (
            <>
              {MERGE_METHODS.map(([value, label]) => (
                <ListChoiceRow
                  key={value}
                  label={label}
                  selected={method === value}
                  onPress={() => setMethod(value)}
                />
              ))}
              {publication.preview === null ? (
                <WorkBlock>
                  <WorkInput
                    label="Target branch"
                    value={baseRef}
                    onChange={setBaseRef}
                    maxLength={256}
                  />
                </WorkBlock>
              ) : null}
              <ListActionRow
                label={merge.phase === "superseded" ? "Prepare merge again" : "Prepare merge"}
                loading={writer.pendingKey === "delivery:preview:merge"}
                disabled={mergeTarget.trim() === "" || prepareBlocked !== null || busy}
                onPress={() => preview("merge", mergeTarget)}
              />
            </>
          ) : null}
          {merge.phase === "ready" ? (
            <ListActionRow
              label="Merge pull request"
              loading={writer.pendingKey === "delivery:merge"}
              disabled={blocked !== null || busy || recovered(merge.preview) === null}
              onPress={runMerge}
            />
          ) : null}
          {merge.phase === "reconcile" ? (
            <ListActionRow
              label="Check merge again"
              loading={writer.pendingKey === "delivery:merge"}
              disabled={blocked !== null || busy || recovered(merge.operation) === null}
              onPress={runMerge}
            />
          ) : null}
          {merge.phase === "confirmed" ? (
            accepted ? (
              <WorkBlock>
                <WorkText muted>
                  Delivery accepted. Criteria and the parent task are decided separately.
                </WorkText>
              </WorkBlock>
            ) : (
              <ListActionRow
                label="Accept delivery"
                description={
                  receipt?.receiptHash === undefined
                    ? "The server hasn't returned a merge receipt to accept."
                    : "Records that this merge delivers the task. It doesn't complete the task."
                }
                loading={writer.pendingKey === "delivery:accept"}
                disabled={receipt?.receiptHash === undefined || blocked !== null || busy}
                onPress={() => void accept()}
              />
            )
          ) : null}
        </>
      ) : null}
    </ListSection>
  );
}

// ── Memory ─────────────────────────────────────────────────────────────────

const SHARED_PAGE = 8;

function PageButtons(props: {
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (!props.hasPrevious && !props.hasNext) return null;
  return (
    <View className="flex-row justify-end gap-2 px-4 py-2">
      <Button
        label="Previous"
        tone="text"
        disabled={!props.hasPrevious}
        onPress={props.onPrevious}
      />
      <Button label="Next" tone="text" disabled={!props.hasNext} onPress={props.onNext} />
    </View>
  );
}

/** A keyset cursor stack: Previous pops back to the exact earlier page. */
function useCursorPages() {
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  return {
    cursor: cursors.at(-1),
    hasPrevious: cursors.length > 0,
    previous: () => setCursors(cursors.slice(0, -1)),
    next: (cursor: string | undefined) => cursor !== undefined && setCursors([...cursors, cursor]),
    reset: () => setCursors([]),
  };
}

export function TaskMemory({ surface }: { surface: Surface }) {
  const { scope, context, writer } = surface;
  const taskId = context.task.taskId;
  const pages = useCursorPages();
  const sharedPages = useCursorPages();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState<{
    text: string;
    shared?: ProjectTeamMemorySourceSelector;
  } | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [showFacts, setShowFacts] = useState(false);
  const sharedView = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "memory-shared-sources",
    taskId,
    limit: SHARED_PAGE,
    ...(sharedPages.cursor === undefined ? {} : { cursor: sharedPages.cursor }),
  });
  const sharedPage =
    sharedView.special?.operation === "memory-shared-sources" ? sharedView.special.value : null;
  // A grant that changed since it was chosen is not searched with the old selector.
  const sharedState = sharedSourceSelection(query?.shared, sharedPage?.items ?? []);
  const sharedList =
    sharedPage === null ? "hidden" : scannedPageState(sharedPage, sharedPages.hasPrevious);
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    taskId,
    limit: MEMORY_PAGE,
    ...(query === null || sharedState === "changed"
      ? { operation: "memory-current" as const }
      : {
          operation: "memory-recall" as const,
          query: query.text,
          ...(query.shared === undefined ? {} : { sharedSource: query.shared }),
        }),
    ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
  });
  const page =
    view.special?.operation === "memory-current" || view.special?.operation === "memory-recall"
      ? view.special.value
      : null;
  const notice = page === null ? undefined : MEMORY_STATUS[page.status];
  const search = (next: typeof query) => {
    pages.reset();
    setQuery(next);
  };
  return (
    <>
      <ListSection
        title="Memory"
        footer={
          notice
            ? `${notice.label}. ${notice.detail}`
            : "Forgetting hides it from all future recall."
        }
      >
        <WorkBlock>
          <WorkInput label="Search memory" value={draft} onChange={setDraft} maxLength={8192} />
          <View className="flex-row gap-2">
            <Button
              label="Search"
              tone="secondary"
              onPress={() => search(draft.trim() === "" ? null : { text: draft.trim() })}
            />
            {query !== null ? (
              <Button
                label="Clear"
                tone="text"
                onPress={() => {
                  setDraft("");
                  search(null);
                }}
              />
            ) : null}
          </View>
          {sharedState === "current" ? (
            <WorkText muted>Searching memory shared from another project.</WorkText>
          ) : null}
          {sharedState === "changed" ? (
            <WorkText muted>
              That shared source changed since you chose it. Choose it again below to search it.
            </WorkText>
          ) : null}
        </WorkBlock>
        {page === null ? (
          <WorkReadNotice view={view} subject="memory" />
        ) : page.items.length === 0 ? (
          <WorkBlock>
            <WorkText muted>{query === null ? "Nothing remembered yet." : "No matches."}</WorkText>
          </WorkBlock>
        ) : (
          page.items.map((source) => (
            <MemoryRow key={source.recordId} surface={surface} source={source} />
          ))
        )}
        <PageButtons
          hasPrevious={pages.hasPrevious}
          hasNext={page?.nextCursor !== undefined}
          onPrevious={pages.previous}
          onNext={() => pages.next(page?.nextCursor)}
        />
        {showSources ? (
          <MemorySources surface={surface} />
        ) : (
          <ListActionRow
            label="What can be remembered"
            disabled={writer.pendingKey !== null}
            onPress={() => setShowSources(true)}
          />
        )}
        {showFacts ? (
          <MemoryFacts surface={surface} />
        ) : (
          <ListActionRow label="Remembered facts" onPress={() => setShowFacts(true)} />
        )}
      </ListSection>
      {sharedPage !== null && sharedList !== "hidden" ? (
        <ListSection
          title="Shared with this project"
          footer="Type a search above, then choose a source."
        >
          {sharedList === "items" ? null : (
            <WorkBlock>
              <WorkText muted>
                {sharedList === "empty-scanned"
                  ? "None of the shared sources checked on this page are current. Next checks more."
                  : "No more shared sources."}
              </WorkText>
            </WorkBlock>
          )}
          {sharedPage.items.map((item) => (
            <ListChoiceRow
              key={item.selection.sourceRecordId}
              label={
                item.owner.kind === "project"
                  ? `From project ${item.owner.projectId}`
                  : "From an assistant"
              }
              selected={
                query?.shared !== undefined && sameMemorySelector(query.shared, item.selection)
              }
              disabled={draft.trim() === ""}
              onPress={() => search({ text: draft.trim(), shared: item.selection })}
            />
          ))}
          <PageButtons
            hasPrevious={sharedPages.hasPrevious}
            hasNext={sharedPage.nextCursor !== undefined}
            onPrevious={sharedPages.previous}
            onNext={() => sharedPages.next(sharedPage.nextCursor)}
          />
        </ListSection>
      ) : (
        <WorkReadNotice view={sharedView} subject="shared memory" />
      )}
    </>
  );
}

interface MemoryConfirmation {
  readonly mode: "forget" | "share";
  /** The project revision and exact source the user opened this confirmation on. */
  readonly selected: ProjectWorkSelection;
  readonly source: ProjectMemorySourceRead;
}

function MemoryRow({ surface, source }: { surface: Surface; source: ProjectMemorySourceRead }) {
  const { writer } = surface;
  const [opened, setOpened] = useState<MemoryConfirmation | null>(null);
  const [recipients, setRecipients] = useState("");
  const key = `memory:${source.recordId}`;
  const blocked = surface.blocked;
  // Sends only what was reviewed; a moved project or source needs another look first.
  const changed =
    opened !== null &&
    (!projectWorkSelectionIsCurrent(opened.selected, surface.current) ||
      !sameMemorySelector(memorySelector(opened.source), memorySelector(source)));
  const send = async (
    build: (base: ReturnType<typeof projectFields>, reviewed: ProjectMemorySourceRead) => unknown,
  ) => {
    if (opened === null || changed || blocked !== null) return;
    const base = { ...projectFields(surface), expectedRevision: opened.selected.revision };
    if (await writer.submit(key, opened.selected, surface.current, build(base, opened.source)))
      setOpened(null);
  };
  const shareList = memoryShareRecipients(recipients, surface.scope.projectId);
  const actions = (submitLabel: string, disabled: boolean, build: Parameters<typeof send>[0]) => (
    <WorkFormActions
      submitLabel={submitLabel}
      pending={writer.pendingKey === key}
      disabled={disabled || blocked !== null}
      onSubmit={() => void send(build)}
      onCancel={() => setOpened(null)}
      failure={writer.failureFor(key)}
      changed={changed}
      onReview={() => opened && setOpened({ ...opened, selected: surface.current, source })}
    />
  );
  return (
    <WorkBlock>
      <WorkText>{source.content}</WorkText>
      <WorkText muted>
        {workStateLabel(source.sourceKind)}
        {source.status !== "current" ? ` · ${workStateLabel(source.status)}` : ""}
      </WorkText>
      {opened === null ? (
        <View className="flex-row gap-2">
          <Button
            label="Share…"
            tone="text"
            disabled={blocked !== null || writer.pendingKey !== null}
            onPress={() => setOpened({ mode: "share", selected: surface.current, source })}
          />
          <Button
            label="Forget…"
            tone="text"
            disabled={blocked !== null || writer.pendingKey !== null}
            onPress={() => setOpened({ mode: "forget", selected: surface.current, source })}
          />
        </View>
      ) : opened.mode === "forget" ? (
        <View className="gap-2">
          <WorkText muted>
            Forgetting hides this from recall now and removes derived copies.
          </WorkText>
          {actions("Forget", false, (base, reviewed) => makeMemoryRetractIntent(base, reviewed))}
        </View>
      ) : (
        <View className="gap-2">
          <WorkInput
            label="Project IDs to share with"
            value={recipients}
            onChange={setRecipients}
          />
          <WorkText muted>
            Sharing replaces the full list. Share with nobody to stop sharing.
          </WorkText>
          {actions(
            shareList.length === 0 ? "Stop sharing" : `Share with ${shareList.length}`,
            false,
            (base, reviewed) => makeMemorySharesIntent(base, reviewed, shareList),
          )}
        </View>
      )}
    </WorkBlock>
  );
}

function MemorySources({ surface }: { surface: Surface }) {
  const { scope, context, writer } = surface;
  const pages = useCursorPages();
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "memory-sources",
    taskId: context.task.taskId,
    limit: MEMORY_PAGE,
    ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
  });
  const page = view.special?.operation === "memory-sources" ? view.special.value : null;
  return (
    <View>
      <WorkReadNotice view={view} subject="memory sources" />
      {page?.items.length === 0 ? (
        <WorkBlock>
          <WorkText muted>Nothing on this page.</WorkText>
        </WorkBlock>
      ) : null}
      {page?.items.map((item) => {
        const status = MEMORY_SOURCE_STATUS[item.status] ?? { label: item.status };
        const key = `memory:process:${item.selection.retainedId}`;
        const canProcess = item.status === "waiting" || item.status === "uncertain";
        return (
          <ListActionRow
            key={`${item.selection.kind}:${item.selection.retainedId}`}
            label={`${workStateLabel(item.selection.kind)} · ${status.label}${canProcess ? (item.status === "uncertain" ? " · Check again" : " · Remember") : ""}`}
            {...(writer.failureFor(key)
              ? { description: writer.failureFor(key)! }
              : item.reason
                ? { description: item.reason }
                : {})}
            loading={writer.pendingKey === key}
            disabled={
              !canProcess ||
              page.status === "disabled" ||
              surface.blocked !== null ||
              writer.pendingKey !== null
            }
            onPress={() =>
              void writer.submit(key, surface.current, surface.current, {
                ...teamFields(surface, surface.current),
                type: "project-team.memory.process",
                selection: item.selection,
              })
            }
          />
        );
      })}
      <PageButtons
        hasPrevious={pages.hasPrevious}
        hasNext={page?.nextCursor !== undefined}
        onPrevious={pages.previous}
        onNext={() => pages.next(page?.nextCursor)}
      />
    </View>
  );
}

type Observation = {
  readonly observationId: string;
  readonly revision: number;
  readonly sourceRevision: number;
  readonly body: string;
  readonly quote: string;
};

/** Facts extracted from this task's sources. Saving one as knowledge is an explicit step. */
function MemoryFacts({ surface }: { surface: Surface }) {
  const { scope, context } = surface;
  const pages = useCursorPages();
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "memory-observations",
    taskId: context.task.taskId,
    limit: MEMORY_PAGE,
    ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
  });
  const page = view.special?.operation === "memory-observations" ? view.special.value : null;
  return (
    <View>
      <WorkReadNotice view={view} subject="remembered facts" />
      {page?.items.length === 0 ? (
        <WorkBlock>
          <WorkText muted>No facts extracted on this page.</WorkText>
        </WorkBlock>
      ) : null}
      {page?.items.map((observation) => (
        <FactRow key={observation.observationId} surface={surface} observation={observation} />
      ))}
      <PageButtons
        hasPrevious={pages.hasPrevious}
        hasNext={page?.nextCursor !== undefined}
        onPrevious={pages.previous}
        onNext={() => pages.next(page?.nextCursor)}
      />
    </View>
  );
}

function FactRow({ surface, observation }: { surface: Surface; observation: Observation }) {
  const { writer } = surface;
  const review = useWorkReview(surface.current);
  const [reviewed, setReviewed] = useState<Observation | null>(null);
  const [title, setTitle] = useState("");
  const key = `memory:promote:${observation.observationId}`;
  const moved =
    reviewed !== null &&
    (reviewed.revision !== observation.revision ||
      reviewed.sourceRevision !== observation.sourceRevision);
  const blocked = surface.model.blockedReason ?? surface.blocked;
  const close = () => {
    review.close();
    setReviewed(null);
  };
  const send = async () => {
    if (review.selected === null || reviewed === null || moved) return;
    const sent = await writer.submit(
      key,
      review.selected,
      surface.current,
      makeMemoryPromoteIntent(teamFields(surface, review.selected), reviewed, {
        knowledgeId: uuidv4(),
        title,
      }),
    );
    if (sent) close();
  };
  return (
    <WorkBlock>
      <WorkText>{observation.body}</WorkText>
      {observation.quote !== "" ? <WorkText muted>“{observation.quote}”</WorkText> : null}
      {review.selected === null ? (
        <View className="flex-row">
          <Button
            label="Save as knowledge…"
            tone="text"
            disabled={blocked !== null || writer.pendingKey !== null}
            onPress={() => {
              setReviewed(observation);
              review.open();
            }}
          />
        </View>
      ) : (
        <View className="gap-2">
          <WorkInput label="Knowledge title" value={title} onChange={setTitle} />
          <WorkFormActions
            submitLabel="Save as knowledge"
            pending={writer.pendingKey === key}
            disabled={title.trim() === "" || blocked !== null}
            onSubmit={() => void send()}
            onCancel={close}
            failure={writer.failureFor(key)}
            changed={review.changed || moved}
            onReview={() => {
              setReviewed(observation);
              review.rebase();
            }}
          />
        </View>
      )}
    </WorkBlock>
  );
}
