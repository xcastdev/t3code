import { asProjectTeamRecord } from "@t3tools/client-runtime/project-work";
import type { ProjectTeamRecordRead } from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkEmpty,
  WorkField,
  WorkFormStatus,
  WorkMeta,
  WorkRevision,
  WorkRow,
  WorkSection,
  WorkTime,
} from "./WorkLayout";
import { WorkReviewChanged } from "./WorkNotice";
import { useWorkRecords, workRecordsBlockedReason } from "./useWorkRecords";
import {
  bindingPhase,
  makeAssignmentStartIntent,
  makeDispatchIntent,
  makeExecutionStartIntent,
  makeInvestigationStartIntent,
  makeMessageAttentionIntent,
  makeMessageSendIntent,
  makeQuestionAnswerIntent,
  makeQuestionRequestIntent,
  messageActions,
  openMessages,
  PROPOSAL_LABEL,
  proposalAvailability,
  proposalOutputs,
  recordsOfKind,
  startAvailability,
  startCandidates,
  startChoiceProblem,
  type WorkProposalKind,
  type WorkMessageAction,
  type WorkQuestionRecord,
} from "./workPresentation";
import { guidedFields, teamFields, useWorkReview, type WorkTaskSurface } from "./workTaskSurface";

/**
 * Workers, questions and messages for one task. Starting a worker is its own
 * step after an approved assignment; approving never starts anything.
 */
export function WorkTaskTeam({ surface }: { surface: WorkTaskSurface }) {
  if (!surface.model.guided) return null;
  const bindings = recordsOfKind(surface.records, "run-binding").toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  return (
    <WorkSection
      title="Workers"
      description="Who is working on this task, and anything they need from you."
    >
      {bindings.length === 0 ? <WorkEmpty title="No worker has run this task yet" /> : null}
      {bindings.slice(0, 8).map((binding) => {
        const phase = bindingPhase(binding.status);
        return (
          <WorkRow key={binding.recordId}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={phase.tone}>{phase.label}</Badge>
              <span className="min-w-0 truncate text-sm">{binding.model}</span>
              <WorkRevision className="text-muted-foreground">r{binding.revision}</WorkRevision>
              <span className="min-w-0 flex-1" />
              <WorkMeta>
                <WorkTime value={binding.updatedAt} />
              </WorkMeta>
            </div>
            <WorkMeta className="break-all">
              {binding.workspaceState === "pending"
                ? "Preparing a workspace"
                : binding.workspaceKind === "root" || binding.branch === null
                  ? (binding.worktree ?? "Project checkout")
                  : `${binding.branch} · ${binding.worktree ?? ""}`}
            </WorkMeta>
            {binding.status === "quarantined" ? (
              <WorkMeta>
                Work can't confirm what this worker did last. Resume or reassign the task to
                recover.
              </WorkMeta>
            ) : null}
          </WorkRow>
        );
      })}
      <ProposeWork surface={surface} />
      <StartWorker surface={surface} />
      <WorkQuestions surface={surface} />
      <WorkMessages surface={surface} />
    </WorkSection>
  );
}

function teamRecordsOf(values: ReadonlyArray<unknown>) {
  return values.flatMap((value): ProjectTeamRecordRead[] => {
    const record = asProjectTeamRecord(value);
    return record === null ? [] : [record];
  });
}

function StartWorker({ surface }: { surface: WorkTaskSurface }) {
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
  const [workspace, setWorkspace] = useState<"worktree" | "root">("worktree");
  const [baseRef, setBaseRef] = useState("");
  const key = "start";

  if ("reason" in availability)
    return (
      <WorkRow>
        <div>
          <Button size="sm" variant="outline" disabled title={availability.reason}>
            Start worker
          </Button>
        </div>
        <WorkMeta>{availability.reason}</WorkMeta>
      </WorkRow>
    );

  const plan = availability.plan;
  const candidates = startCandidates(
    recordsOfKind(teamRecordsOf(members.records), "member"),
    recordsOfKind(teamRecordsOf(roles.records), "role-revision"),
    plan,
  );
  const chosen = candidates.find((entry) => entry.member.recordId === memberId) ?? null;
  const workspaceChoice =
    workspace === "root" ? ({ type: "root" } as const) : ({ type: "worktree", baseRef } as const);
  const problem = startChoiceProblem(chosen, workspaceChoice);
  const blocked =
    model.blockedReason ??
    surface.blocked ??
    workRecordsBlockedReason(members, "team members") ??
    workRecordsBlockedReason(roles, "team roles");

  const send = async () => {
    if (review.selected === null || chosen === null || problem !== null) return;
    const {
      specRevision: _spec,
      planRevision: _plan,
      ...base
    } = teamFields(surface, review.selected);
    const sent = await writer.submit(
      key,
      review.selected,
      surface.current,
      makeDispatchIntent(base, {
        plan,
        member: chosen.member,
        role: chosen.role,
        workspace:
          workspace === "root" ? { type: "root" } : { type: "worktree", baseRef: baseRef.trim() },
      }),
    );
    if (sent) review.close();
  };

  if (review.selected === null)
    return (
      <WorkRow>
        <div>
          <Button
            size="sm"
            disabled={blocked !== null || writer.pendingKey !== null}
            title={blocked ?? undefined}
            onClick={() => {
              setMemberId(
                candidates.find((entry) => entry.ineligible === null && entry.preferred)?.member
                  .recordId ??
                  candidates.find((entry) => entry.ineligible === null)?.member.recordId ??
                  null,
              );
              review.open();
            }}
          >
            Start worker…
          </Button>
        </div>
        <WorkMeta>The assignment is approved. Starting it is a separate step.</WorkMeta>
      </WorkRow>
    );

  return (
    <WorkRow className="gap-3">
      {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
      <p className="text-sm font-medium">Start worker</p>
      <WorkField label="Team member">
        {(id) => (
          <Select value={memberId} onValueChange={(value) => setMemberId(value as string | null)}>
            <SelectTrigger id={id} size="sm">
              <SelectValue placeholder="Choose a member" />
            </SelectTrigger>
            <SelectPopup>
              {candidates.map((entry) => (
                <SelectItem
                  key={entry.member.recordId}
                  value={entry.member.recordId}
                  disabled={entry.ineligible !== null}
                >
                  {entry.member.name} · {entry.role.role} · {entry.role.model}
                  {entry.ineligible !== null ? ` — ${entry.ineligible}` : ""}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
      </WorkField>
      {candidates.length === 0 ? (
        <WorkMeta>No active member has a current role. Configure the team in Overview.</WorkMeta>
      ) : null}
      <ToggleGroup
        aria-label="Workspace"
        value={[workspace]}
        onValueChange={(next) => {
          if (next[0] === "root" || next[0] === "worktree") setWorkspace(next[0]);
        }}
      >
        <Toggle value="worktree">New worktree</Toggle>
        <Toggle value="root">Project checkout</Toggle>
      </ToggleGroup>
      {workspace === "worktree" ? (
        <WorkField label="Base branch">
          {(id) => (
            <Input
              id={id}
              size="sm"
              maxLength={256}
              value={baseRef}
              placeholder="main"
              onChange={(event) => setBaseRef(event.target.value)}
            />
          )}
        </WorkField>
      ) : null}
      <WorkMeta>
        Runs {chosen ? chosen.role.model : "the member's model"} on {plan.providerInstanceId} for
        this one assignment, within the team's limits.
      </WorkMeta>
      {problem !== null ? <WorkMeta className="text-warning-foreground">{problem}</WorkMeta> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            problem !== null || review.changed || blocked !== null || writer.pendingKey !== null
          }
          onClick={() => void send()}
        >
          {writer.pendingKey === key ? "Starting…" : "Confirm start"}
        </Button>
        <Button size="sm" variant="ghost" onClick={review.close}>
          Cancel
        </Button>
      </div>
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
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
function ProposeWork({ surface }: { surface: WorkTaskSurface }) {
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
  const available = PROPOSAL_KINDS.filter((entry) => availability[entry] === null);
  const specCriteria = context.criteria.filter((criterion) =>
    context.task.specification?.criterionIds.includes(criterion.criterionId),
  );
  const close = () => {
    review.close();
    setKind(null);
  };

  if (review.selected === null || kind === null)
    return (
      <WorkRow className="gap-2">
        <p className="text-sm font-medium">Propose work</p>
        {available.length === 0 ? (
          <WorkMeta>{availability.execution ?? "Nothing can be proposed right now."}</WorkMeta>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {available.map((entry) => (
              <Button
                key={entry}
                size="xs"
                variant="outline"
                disabled={blocked !== null || writer.pendingKey !== null}
                title={blocked ?? undefined}
                onClick={() => {
                  setKind(entry);
                  setObjective(context.task.summary ?? context.task.title);
                  setOutputs("");
                  setCriterionIds(specCriteria.map((criterion) => criterion.criterionId));
                  review.open();
                }}
              >
                {PROPOSAL_LABEL[entry]}…
              </Button>
            ))}
          </div>
        )}
        <WorkMeta>Proposing records what may run. Starting a worker is a separate step.</WorkMeta>
      </WorkRow>
    );

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
    const base = guidedFields(surface, selected);
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
    const sent = await writer.submit(key, selected, surface.current, intent);
    if (sent) close();
  };

  return (
    <WorkRow className="gap-3">
      {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
      <p className="text-sm font-medium">{PROPOSAL_LABEL[kind]}</p>
      {kind === "execution" ? (
        <WorkMeta>
          Authorizes one worker to deliver this task under the approved scope and plan, r
          {context.task.specRevision}/{model.plan?.planRevision ?? "—"}.
        </WorkMeta>
      ) : (
        <>
          <WorkField label="Objective">
            {(id) => (
              <Textarea
                id={id}
                size="sm"
                maxLength={32000}
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
              />
            )}
          </WorkField>
          {kind === "implementation" ? (
            <div className="flex flex-col gap-1">
              <WorkMeta>Criteria to implement</WorkMeta>
              {specCriteria.map((criterion) => {
                const on = criterionIds.includes(criterion.criterionId);
                return (
                  <Button
                    key={criterion.criterionId}
                    size="xs"
                    variant={on ? "secondary" : "ghost"}
                    aria-pressed={on}
                    className="justify-start text-left"
                    onClick={() =>
                      setCriterionIds(
                        on
                          ? criterionIds.filter((entry) => entry !== criterion.criterionId)
                          : [...criterionIds, criterion.criterionId],
                      )
                    }
                  >
                    {on ? "✓ " : ""}
                    {criterion.description}
                  </Button>
                );
              })}
            </div>
          ) : (
            <WorkField
              label={kind === "planning" ? "Expected plan" : "Expected outputs, one per line"}
            >
              {(id) => (
                <Textarea
                  id={id}
                  size="sm"
                  maxLength={64000}
                  value={outputs}
                  onChange={(event) => setOutputs(event.target.value)}
                />
              )}
            </WorkField>
          )}
          <WorkMeta>
            {kind === "investigation"
              ? "Creates a read-only investigation task."
              : "Creates a child task bound to the approved scope"}
            {kind === "planning" || kind === "investigation" ? "." : " and plan."}
          </WorkMeta>
        </>
      )}
      {problem !== null ? <WorkMeta className="text-warning-foreground">{problem}</WorkMeta> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            problem !== null || review.changed || blocked !== null || writer.pendingKey !== null
          }
          onClick={() => void send()}
        >
          {writer.pendingKey === key ? "Recording…" : "Record proposal"}
        </Button>
        <Button size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
      </div>
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}

function WorkQuestions({ surface }: { surface: WorkTaskSurface }) {
  const questions = recordsOfKind(surface.records, "question").toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const pending = questions.filter((question) => question.status === "pending");
  const answered = questions.filter((question) => question.status === "answered").slice(0, 3);
  return (
    <>
      {pending.map((question) => (
        <QuestionRow key={question.recordId} surface={surface} question={question} />
      ))}
      {answered.map((question) => (
        <WorkRow key={question.recordId}>
          <WorkMeta>Answered question</WorkMeta>
          <p className="text-sm whitespace-pre-wrap break-words">{question.body}</p>
          <p className="text-sm text-muted-foreground break-words">{question.answer}</p>
        </WorkRow>
      ))}
      <AskQuestion surface={surface} />
    </>
  );
}

function QuestionRow({
  surface,
  question,
}: {
  surface: WorkTaskSurface;
  question: WorkQuestionRecord;
}) {
  const { writer } = surface;
  const [answer, setAnswer] = useState("");
  const key = `question:${question.recordId}`;
  const gate =
    recordsOfKind(surface.records, "gate").find((g) => g.recordId === question.targetGateId) ??
    null;
  const blocked = surface.model.blockedReason ?? surface.blocked;
  const send = async (value: string) => {
    const selected = surface.current;
    const sent = await writer.submit(
      key,
      selected,
      surface.current,
      makeQuestionAnswerIntent(teamFields(surface, selected), question, gate, value),
    );
    if (sent) setAnswer("");
  };
  return (
    <WorkRow className="gap-2">
      <div className="flex items-center gap-2">
        <Badge variant="warning">Waiting for you</Badge>
        <WorkMeta>
          From {question.senderId} · <WorkTime value={question.updatedAt} />
        </WorkMeta>
      </div>
      <p className="text-sm whitespace-pre-wrap break-words">{question.body}</p>
      {question.choices.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {question.choices.map((choice) => (
            <Button
              key={choice}
              size="xs"
              variant="outline"
              disabled={blocked !== null || writer.pendingKey !== null}
              onClick={() => void send(choice)}
            >
              {choice}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Input
          size="sm"
          aria-label="Answer"
          maxLength={4000}
          value={answer}
          placeholder="Answer"
          onChange={(event) => setAnswer(event.target.value)}
        />
        <Button
          size="sm"
          disabled={answer.trim() === "" || blocked !== null || writer.pendingKey !== null}
          title={blocked ?? undefined}
          onClick={() => void send(answer)}
        >
          {writer.pendingKey === key ? "Sending…" : "Answer"}
        </Button>
      </div>
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}

/** A human question pauses the gate it names until the team answers it. */
function AskQuestion({ surface }: { surface: WorkTaskSurface }) {
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
      <WorkRow>
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={blocked !== null || writer.pendingKey !== null}
            title={blocked ?? undefined}
            onClick={review.open}
          >
            Ask the team…
          </Button>
        </div>
      </WorkRow>
    );
  const send = async () => {
    if (review.selected === null) return;
    const sent = await writer.submit(
      key,
      review.selected,
      surface.current,
      makeQuestionRequestIntent(teamFields(surface, review.selected), {
        questionId: randomUUID(),
        gate,
        body,
        choices: [],
      }),
    );
    if (sent) {
      review.close();
      setBody("");
    }
  };
  return (
    <WorkRow className="gap-2">
      {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
      <WorkField
        label="Question for the team"
        hint={`About the ${gate.gate} waiting for approval.`}
      >
        {(id) => (
          <Textarea
            id={id}
            size="sm"
            maxLength={32000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        )}
      </WorkField>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={
            body.trim() === "" || review.changed || blocked !== null || writer.pendingKey !== null
          }
          onClick={() => void send()}
        >
          {writer.pendingKey === key ? "Sending…" : "Send question"}
        </Button>
        <Button size="sm" variant="ghost" onClick={review.close}>
          Cancel
        </Button>
      </div>
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}

const MESSAGE_ACTION_LABEL: Record<WorkMessageAction, string> = {
  acknowledge: "Mark seen",
  resolve: "Resolve",
};

function WorkMessages({ surface }: { surface: WorkTaskSurface }) {
  const { writer, model } = surface;
  const messages = openMessages(surface.records).slice(0, 8);
  const blocked = model.blockedReason ?? surface.blocked;
  const [body, setBody] = useState("");
  const live = recordsOfKind(surface.records, "run-binding").find(
    (binding) => bindingPhase(binding.status).live,
  );
  const key = "message:send";
  const act = (message: (typeof messages)[number], action: WorkMessageAction) => {
    const selected = surface.current;
    const { taskId: _task, expectedTaskRevision: _rev, ...base } = guidedFields(surface, selected);
    void writer.submit(
      `message:${message.recordId}`,
      selected,
      surface.current,
      makeMessageAttentionIntent(base, message, action),
    );
  };
  const send = async () => {
    if (live === undefined || model.membership === null) return;
    const selected = surface.current;
    const sent = await writer.submit(
      key,
      selected,
      surface.current,
      makeMessageSendIntent(teamFields(surface, selected), {
        messageId: randomUUID(),
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
        <WorkRow key={message.recordId} className="gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <WorkMeta>
              {message.senderId} · <WorkTime value={message.updatedAt} />
            </WorkMeta>
            {message.status === "uncertain" ? (
              <Badge variant="error">Delivery unknown</Badge>
            ) : null}
            <span className="min-w-0 flex-1" />
            {messageActions(message).map((action) => (
              <Button
                key={action}
                size="xs"
                variant="outline"
                disabled={blocked !== null || writer.pendingKey !== null}
                onClick={() => act(message, action)}
              >
                {MESSAGE_ACTION_LABEL[action]}
              </Button>
            ))}
          </div>
          <p className="text-sm whitespace-pre-wrap break-words">{message.body}</p>
          <WorkFormStatus message={writer.failureFor(`message:${message.recordId}`)} />
        </WorkRow>
      ))}
      {live !== undefined && model.membership !== null ? (
        <WorkRow className="gap-2">
          <WorkField label="Message the worker">
            {(id) => (
              <Textarea
                id={id}
                size="sm"
                maxLength={32000}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            )}
          </WorkField>
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={body.trim() === "" || blocked !== null || writer.pendingKey !== null}
              title={blocked ?? undefined}
              onClick={() => void send()}
            >
              {writer.pendingKey === key ? "Sending…" : "Send message"}
            </Button>
          </div>
          <WorkFormStatus message={writer.failureFor(key)} />
        </WorkRow>
      ) : null}
    </>
  );
}
