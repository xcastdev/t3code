import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { asProjectWorkTaskContext } from "@t3tools/client-runtime/project-work";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  ProjectTeamRecord,
  ProjectWorkTask,
  type ProjectTeamWriteIntent,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useContext, useLayoutEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { WorkCard } from "../../components/work/WorkDataNotice";
import {
  WorkTeamFoundation,
  type WorkTeamFoundationView,
} from "../../components/work/WorkTeamFoundation";
import { projectWorkCommandFailure } from "../../components/work/workCommandFailure";
import { randomUUID } from "../../lib/utils";
import { projectWorkEnvironment } from "../../state/projectWork";
import { useAtomCommand } from "../../state/use-atom-command";

type Question = Extract<ProjectTeamRecord, { kind: "question" }>;
type Answer = Extract<ProjectTeamWriteIntent, { type: "project-team.question.answer" }>;
type Draft = {
  readonly answer: string;
  readonly questionRevision: number;
  readonly targetGateId: string;
  readonly targetRevision: number;
  readonly command?: Answer;
  readonly status?: "sending" | "uncertain" | "rejected" | "accepted";
  readonly notice?: string;
};
const knownRecord = Schema.is(ProjectTeamRecord);
const knownTask = Schema.is(ProjectWorkTask);
const answerableGate = (status: string) =>
  ["proposed", "pending", "approved", "consumed"].includes(status);
const unavailable = () => ({
  code: "stale-revision",
  message:
    "Question changed or current task data is unavailable. Refresh and review before answering.",
});

export interface InboxProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly writesSupported: boolean;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}

/** Local drafts survive snapshot refreshes, while each environment/project owns its session. */
export function Inbox(props: InboxProps) {
  return <InboxSession key={JSON.stringify([props.environmentId, props.projectId])} {...props} />;
}

function InboxSession(props: InboxProps) {
  const [filter, setFilter] = useState<Question["status"]>("pending");
  const [offset, setOffset] = useState(0);
  const [selected, select] = useState<string | null>(null);
  const [drafts, saveDrafts] = useState<ReadonlyMap<string, Draft>>(new Map());
  const draftsRef = useRef(drafts);
  const storeDraft = (questionId: string, draft: Draft) => {
    const next = new Map(draftsRef.current).set(questionId, draft);
    draftsRef.current = next;
    saveDrafts(next);
  };
  const unsettledQuestion = [...drafts].find(
    ([, draft]) => draft.status === "sending" || draft.status === "uncertain",
  )?.[0];
  if (!props.supported) return <p>This environment does not support the question inbox.</p>;
  return (
    <WorkTeamFoundation {...props}>
      {(foundation) => {
        const questions = foundation.snapshot.records
          .filter(knownRecord)
          .filter((record) => record.kind === "question");
        const filtered = questions.filter((question) => question.status === filter);
        const start = offset < filtered.length ? offset : 0;
        const question = questions.find((item) => item.recordId === selected);
        return (
          <div className="flex min-w-0 flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">Inbox</h2>
              <p className="text-sm text-muted-foreground">
                Human decisions linked to recorded tasks and gates.
              </p>
              {!props.connected || !foundation.current ? (
                <p className="text-sm text-muted-foreground">
                  Cached or incomplete questions. Reconnect and refresh before answering.
                </p>
              ) : null}
              {!props.writesSupported ? (
                <p>This environment does not support question answers.</p>
              ) : null}
              {foundation.snapshot.records.some((record) => !knownRecord(record)) ? (
                <p>Unsupported team records are present. Answers are unavailable.</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Mark seen is unavailable on this environment. Opening a question does not answer or
                resolve it.
              </p>
            </div>
            <div className="flex gap-2" role="group" aria-label="Question status">
              {(["pending", "answered", "canceled"] as const).map((status) => (
                <Button
                  key={status}
                  size="sm"
                  variant={filter === status ? "secondary" : "outline"}
                  aria-pressed={filter === status}
                  onClick={() => {
                    setFilter(status);
                    setOffset(0);
                  }}
                >
                  {status[0]!.toUpperCase() + status.slice(1)}
                </Button>
              ))}
            </div>
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground">No {filter} questions recorded.</p>
            ) : null}
            {filtered.slice(start, start + 128).map((item) => (
              <WorkCard key={item.recordId}>
                <h3 className="whitespace-pre-wrap font-medium">{item.body}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {item.status} · From {item.senderId} · Task {item.taskId}
                </p>
                <p className="text-sm text-muted-foreground">
                  Gate {item.targetGateId} · Revision {item.targetRevision} · Question revision{" "}
                  {item.revision}
                </p>
                <p className="text-xs text-muted-foreground">
                  Last recorded update {item.updatedAt} ·{" "}
                  {item.seenAt ? `Seen ${item.seenAt}` : "Not marked seen"}
                </p>
                <p className="mt-2 text-sm">
                  Why: this question needs a human decision for the linked gate. Answering records
                  the decision; the server rechecks eligibility before resuming dependent work.
                </p>
                {item.choices.length > 0 ? (
                  <p className="mt-1 text-sm">Choices: {item.choices.join(" · ")}</p>
                ) : null}
                {item.answer ? <p className="mt-2 text-sm">Answer: {item.answer}</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => props.onOpenTask(item.taskId)}>
                    Open task {item.taskId}
                  </Button>
                  {item.status === "pending" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        unsettledQuestion !== undefined && unsettledQuestion !== item.recordId
                      }
                      onClick={() => {
                        if (
                          [...draftsRef.current].some(
                            ([id, draft]) =>
                              id !== item.recordId &&
                              (draft.status === "sending" || draft.status === "uncertain"),
                          )
                        )
                          return;
                        select(item.recordId);
                      }}
                    >
                      Answer question
                    </Button>
                  ) : null}
                </div>
              </WorkCard>
            ))}
            {question &&
            (question.status === "pending" || drafts.get(question.recordId)?.command) ? (
              <QuestionEditor
                key={question.recordId}
                {...props}
                question={question}
                foundation={foundation}
                draft={drafts.get(question.recordId)}
                onDraft={(draft) => storeDraft(question.recordId, draft)}
              />
            ) : selected !== null && !question ? (
              <p>
                The selected question is no longer available. Its answer draft remains saved in this
                view.
                {selected && drafts.get(selected)?.command
                  ? ` Original command ${drafts.get(selected)?.command?.commandId}; refresh to reconcile its outcome.`
                  : ""}
              </p>
            ) : null}
            <div className="flex gap-2">
              {start > 0 ? (
                <Button size="sm" variant="outline" onClick={() => setOffset(start - 128)}>
                  Previous question page
                </Button>
              ) : null}
              {start + 128 < filtered.length ? (
                <Button size="sm" variant="outline" onClick={() => setOffset(start + 128)}>
                  Next question page
                </Button>
              ) : null}
            </div>
          </div>
        );
      }}
    </WorkTeamFoundation>
  );
}

function QuestionEditor(
  props: InboxProps & {
    readonly question: Question;
    readonly foundation: WorkTeamFoundationView;
    readonly draft: Draft | undefined;
    readonly onDraft: (draft: Draft) => void;
  },
) {
  const registry = useContext(RegistryContext);
  const target = {
    environmentId: props.environmentId,
    projectId: props.projectId,
    taskId: props.question.taskId,
  };
  const atom = projectWorkEnvironment.taskContext(target);
  const result = useAtomValue(atom);
  const context = asProjectWorkTaskContext(Option.getOrNull(AsyncResult.value(result)));
  const write = useAtomCommand(projectWorkEnvironment.write, {
    reportFailure: false,
    reportDefect: false,
  });
  const mounted = useRef(false);
  const busy = useRef(false);
  const access = useRef(props);
  useLayoutEffect(() => {
    access.current = props;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const newDraft = (): Draft => ({
    answer: "",
    questionRevision: props.question.revision,
    targetGateId: props.question.targetGateId,
    targetRevision: props.question.targetRevision,
  });
  const draft = props.draft ?? newDraft();
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    draftRef.current = draft;
  });
  const update = (next: Draft) => {
    draftRef.current = next;
    props.onDraft(next);
  };
  const records = props.foundation.snapshot.records.filter(knownRecord);
  const gate = records.find(
    (record) => record.kind === "gate" && record.recordId === props.question.targetGateId,
  );
  const senderKnown = records.some(
    (record) => record.kind === "member" && record.recordId === props.question.senderId,
  );
  const memberships = records.filter(
    (record) => record.kind === "task-membership" && record.taskId === props.question.taskId,
  );
  const bindingsKnown = records.every(
    (record) =>
      record.kind !== "run-binding" ||
      record.taskId !== props.question.taskId ||
      (record.environmentId === props.environmentId &&
        records.some((member) => member.kind === "member" && member.recordId === record.memberId) &&
        records.some(
          (role) => role.kind === "role-revision" && role.recordId === record.roleRevisionId,
        )),
  );
  const changed =
    props.question.revision !== draft.questionRevision ||
    props.question.targetGateId !== draft.targetGateId ||
    props.question.targetRevision !== draft.targetRevision;
  const eligible =
    props.connected &&
    props.enabled &&
    props.writesSupported &&
    props.foundation.current &&
    senderKnown &&
    bindingsKnown &&
    memberships.length === 1 &&
    memberships[0]?.kind === "task-membership" &&
    memberships[0].status === "active" &&
    result._tag === "Success" &&
    !result.waiting &&
    context?.revision === props.foundation.snapshot.revision &&
    context?.projectId === props.projectId &&
    context.task.projectId === props.projectId &&
    context.task.taskId === props.question.taskId &&
    knownTask(context.task) &&
    gate?.kind === "gate" &&
    answerableGate(gate.status) &&
    gate.taskId === props.question.taskId &&
    gate.revision === props.question.targetRevision &&
    gate.specRevision === context.task.specRevision;

  function verify(original?: Answer) {
    if (
      !mounted.current ||
      !access.current.connected ||
      !access.current.enabled ||
      !access.current.writesSupported
    )
      throw unavailable();
    const fresh = props.foundation.verify();
    const currentResult = registry.get(atom);
    const current = asProjectWorkTaskContext(Option.getOrNull(AsyncResult.value(currentResult)));
    const known = fresh.records.filter(knownRecord);
    const question = known.find((record) => record.recordId === props.question.recordId);
    const gate =
      question?.kind === "question"
        ? known.find((record) => record.recordId === question.targetGateId)
        : undefined;
    const member =
      question?.kind === "question"
        ? known.find((record) => record.recordId === question.senderId && record.kind === "member")
        : undefined;
    const memberships = known.filter(
      (record) => record.kind === "task-membership" && record.taskId === props.question.taskId,
    );
    const bindings = known.filter(
      (record) => record.kind === "run-binding" && record.taskId === props.question.taskId,
    );
    const duplicate =
      original &&
      question?.kind === "question" &&
      question.status === "answered" &&
      question.revision === original.expectedQuestionRevision + 1 &&
      question.answer === original.answer;
    if (
      fresh.revision === null ||
      currentResult._tag !== "Success" ||
      currentResult.waiting ||
      !current ||
      current.revision !== fresh.revision ||
      current.projectId !== props.projectId ||
      current.task.projectId !== props.projectId ||
      current.task.taskId !== props.question.taskId ||
      !knownTask(current.task) ||
      question?.kind !== "question" ||
      question.taskId !== current.task.taskId ||
      question.targetGateId !== draftRef.current.targetGateId ||
      question.targetRevision !== draftRef.current.targetRevision ||
      (!duplicate &&
        (question.status !== "pending" ||
          question.revision !== draftRef.current.questionRevision)) ||
      gate?.kind !== "gate" ||
      !answerableGate(gate.status) ||
      gate.taskId !== question.taskId ||
      gate.revision !== question.targetRevision ||
      gate.specRevision !== current.task.specRevision ||
      !member ||
      memberships.length !== 1 ||
      memberships[0]?.kind !== "task-membership" ||
      memberships[0].status !== "active" ||
      bindings.some(
        (binding) =>
          binding.kind !== "run-binding" ||
          binding.environmentId !== props.environmentId ||
          !known.some(
            (record) => record.kind === "member" && record.recordId === binding.memberId,
          ) ||
          !known.some(
            (record) =>
              record.kind === "role-revision" && record.recordId === binding.roleRevisionId,
          ),
      ) ||
      (original &&
        (original.projectId !== props.projectId ||
          original.taskId !== question.taskId ||
          original.expectedTaskRevision !== current.task.revision ||
          original.specRevision !== current.task.specRevision ||
          original.planRevision !== gate.planRevision ||
          original.expectedGateRevision !== gate.revision))
    )
      throw unavailable();
    return { question, gate, context: current, revision: fresh.revision };
  }

  async function submit() {
    if (
      busy.current ||
      draftRef.current.status === "sending" ||
      draftRef.current.status === "accepted" ||
      draftRef.current.status === "rejected"
    )
      return;
    busy.current = true;
    const wasUncertain = draftRef.current.status === "uncertain";
    let command: Answer | undefined;
    try {
      const previous = draftRef.current;
      const fresh = verify(previous.command);
      const answer = previous.answer.trim();
      if (
        !answer ||
        answer.length > 4000 ||
        (fresh.question.choices.length > 0 && !fresh.question.choices.includes(answer))
      )
        throw {
          code: "invalid-state",
          message: "Choose an available answer or enter up to 4,000 characters.",
        };
      command = previous.command ?? {
        type: "project-team.question.answer",
        commandId: CommandId.make(randomUUID()),
        projectId: props.projectId,
        taskId: fresh.question.taskId,
        expectedRevision: fresh.revision,
        expectedTaskRevision: fresh.context.task.revision,
        specRevision: fresh.context.task.specRevision,
        planRevision: fresh.gate.planRevision,
        questionId: fresh.question.recordId,
        expectedQuestionRevision: fresh.question.revision,
        expectedGateRevision: fresh.gate.revision,
        answer,
      };
      update({ ...previous, command, status: "sending" });
      const outcome = await write({ environmentId: props.environmentId, input: command });
      if (outcome._tag === "Failure") throw squashAtomCommandFailure(outcome);
      if (mounted.current) {
        update({
          ...draftRef.current,
          status: "accepted",
          notice: "Answer submitted. Waiting for the recorded question to refresh.",
        });
        props.foundation.refresh();
      }
    } catch (error) {
      if (mounted.current) {
        const failure = projectWorkCommandFailure(error);
        const explicit =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          [
            "stale-revision",
            "invalid-state",
            "permission-denied",
            "forbidden",
            "unauthorized",
            "not-found",
            "invalid-request",
          ].includes(String(error.code));
        update({
          ...draftRef.current,
          ...(command ? { command } : {}),
          status: wasUncertain || (command && !explicit) ? "uncertain" : "rejected",
          notice: failure.message,
        });
      }
    } finally {
      busy.current = false;
    }
  }
  const frozen = draft.command !== undefined;
  return (
    <WorkCard>
      <h3 className="font-medium">Answer question</h3>
      {changed ? (
        <p className="mt-2 text-sm">Question changed. Your answer draft is preserved.</p>
      ) : null}
      {draft.notice ? (
        <p role="status" className="mt-2 text-sm">
          {draft.notice}
        </p>
      ) : null}
      {draft.command ? (
        <p className="mt-2 break-all text-xs text-muted-foreground">
          Original command {draft.command.commandId}
          {draft.status === "uncertain" ? " · Delivery uncertain; retry this exact answer." : ""}
        </p>
      ) : null}
      {props.question.choices.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {props.question.choices.map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant={draft.answer === choice ? "secondary" : "outline"}
              disabled={frozen}
              aria-pressed={draft.answer === choice}
              onClick={() => update({ ...draft, answer: choice })}
            >
              {choice}
            </Button>
          ))}
        </div>
      ) : (
        <Textarea
          className="mt-3"
          aria-label="Your answer"
          value={draft.answer}
          maxLength={4000}
          disabled={frozen}
          onChange={(event) => update({ ...draft, answer: event.target.value })}
        />
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            !eligible ||
            (!draft.command && changed) ||
            !draft.answer.trim() ||
            draft.status === "sending" ||
            draft.status === "accepted" ||
            draft.status === "rejected"
          }
          onClick={() => void submit()}
        >
          {draft.status === "sending"
            ? "Sending answer…"
            : draft.command
              ? "Retry exact answer"
              : "Submit answer"}
        </Button>
        {(changed || draft.status === "rejected") &&
        draft.status !== "uncertain" &&
        draft.status !== "sending" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!eligible || props.question.status !== "pending"}
            onClick={() => {
              try {
                const previous = draftRef.current;
                draftRef.current = { ...newDraft(), answer: previous.answer };
                verify();
                update(draftRef.current);
              } catch {
                draftRef.current = draft;
              }
            }}
          >
            Use current question
          </Button>
        ) : null}
      </div>
    </WorkCard>
  );
}
