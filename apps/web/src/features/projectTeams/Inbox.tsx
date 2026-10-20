import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { asProjectWorkTaskContext } from "@t3tools/client-runtime/project-work";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  ProjectTeamRecord,
  ProjectWorkTask,
  ProjectWorkAttentionRead,
  ProjectWorkAttention,
  type ProjectWorkWriteIntent,
  ProjectWorkBoundedReadEnvelope,
  type ProjectTeamWriteIntent,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useContext, useLayoutEffect, useRef, useState } from "react";

import { RefreshCwIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { WorkCard } from "../../components/work/WorkDataNotice";
import {
  WorkDetails,
  WorkSectionHeader,
  WorkTime,
  workStateLabel,
} from "../../components/work/WorkLayout";
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

function failedAnswer(draft: Draft, error: unknown, command?: Answer): Draft {
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
  return {
    ...draft,
    ...(command ? { command } : {}),
    status: draft.status === "uncertain" || (command && !explicit) ? "uncertain" : "rejected",
    notice: projectWorkCommandFailure(error).message,
  };
}

export interface InboxProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly writesSupported: boolean;
  readonly poll?: boolean;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}

/** Local drafts survive snapshot refreshes, while each environment/project owns its session. */
export function Inbox(props: InboxProps) {
  return <InboxSession key={JSON.stringify([props.environmentId, props.projectId])} {...props} />;
}

function InboxSession(props: InboxProps) {
  const write = useAtomCommand(projectWorkEnvironment.write, {
    reportFailure: false,
    reportDefect: false,
  });
  const owner = useRef(false);
  useLayoutEffect(() => {
    owner.current = true;
    return () => {
      owner.current = false;
    };
  }, []);
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
  // The environment/project session owns results even when its selected editor disappears.
  async function sendAnswer(command: Answer, refresh: () => void, wasUncertain: boolean) {
    const previous = draftsRef.current.get(command.questionId);
    if (!owner.current || previous?.command !== command) return;
    let completed: Draft;
    try {
      const outcome = await write({ environmentId: props.environmentId, input: command });
      if (outcome._tag === "Failure") throw squashAtomCommandFailure(outcome);
      completed = {
        ...previous,
        status: "accepted",
        notice: "Answer submitted. Waiting for the recorded question to refresh.",
      };
    } catch (error) {
      completed = failedAnswer(
        wasUncertain ? { ...previous, status: "uncertain" } : previous,
        error,
        command,
      );
    }
    if (!owner.current || draftsRef.current.get(command.questionId)?.command !== command) return;
    storeDraft(command.questionId, completed);
    if (completed.status === "accepted") refresh();
  }
  const unsettledQuestion = [...drafts].find(
    ([, draft]) => draft.status === "sending" || draft.status === "uncertain",
  )?.[0];
  const questionsInbox = (
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
            <div className="space-y-1">
              <WorkSectionHeader
                title="Questions"
                description="Decisions an agent is waiting on. Answering records the decision; the server rechecks eligibility before dependent work resumes."
              />
              {!props.connected || !foundation.current ? (
                <p className="text-sm text-warning-foreground">
                  Cached or incomplete questions. Reconnect and refresh before answering.
                </p>
              ) : null}
              {!props.writesSupported ? (
                <p className="text-sm text-warning-foreground">
                  This environment does not support question answers.
                </p>
              ) : null}
              {foundation.snapshot.records.some((record) => !knownRecord(record)) ? (
                <p className="text-sm text-warning-foreground">
                  Unsupported team records are present. Answers are unavailable.
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Mark seen is unavailable for questions on this environment. Opening a question does
                not answer or resolve it.
              </p>
            </div>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Question status">
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
                <div className="flex items-start justify-between gap-3">
                  <h3 className="min-w-0 whitespace-pre-wrap break-words font-medium">
                    {item.body}
                  </h3>
                  <Badge variant={item.status === "pending" ? "warning" : "secondary"}>
                    {workStateLabel(item.status)}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Last recorded update <WorkTime value={item.updatedAt} /> ·{" "}
                  {item.seenAt ? (
                    <>
                      Seen <WorkTime value={item.seenAt} />
                    </>
                  ) : (
                    "Not marked seen"
                  )}
                </p>
                {item.choices.length > 0 ? (
                  <p className="mt-2 text-sm">Choices: {item.choices.join(" · ")}</p>
                ) : null}
                {item.answer ? <p className="mt-2 text-sm">Answer: {item.answer}</p> : null}
                <WorkDetails className="mt-2">
                  <p>
                    {item.status} · From {item.senderId} · Task {item.taskId}
                  </p>
                  <p>
                    Gate {item.targetGateId} · Revision {item.targetRevision} · Question revision{" "}
                    {item.revision}
                  </p>
                </WorkDetails>
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
                onSend={sendAnswer}
              />
            ) : selected !== null && !question ? (
              <p className="text-sm text-warning-foreground">
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
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <TaskAttention {...props} />
      {props.supported ? (
        questionsInbox
      ) : (
        <p className="text-sm text-muted-foreground">
          This environment does not support the question inbox.
        </p>
      )}
    </div>
  );
}

const knownAttentionPage = Schema.is(ProjectWorkBoundedReadEnvelope);
const knownAttention = Schema.is(ProjectWorkAttentionRead);

function attentionPage(
  value: unknown,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  offset: number,
) {
  if (
    offset > 1_000_000 ||
    !knownAttentionPage(value) ||
    value.projectId !== projectId ||
    !Number.isSafeInteger(value.offset) ||
    !Number.isSafeInteger(value.limit) ||
    value.offset !== offset ||
    value.limit !== projectWorkEnvironment.pageRequestSize ||
    !Number.isSafeInteger(value.revision) ||
    value.items.length > value.limit ||
    new Set(value.items.filter(knownAttention).map((item) => item.taskId)).size !==
      value.items.length ||
    value.items.some(
      (item) =>
        !knownAttention(item) ||
        !Number.isSafeInteger(item.revision) ||
        item.revision > value.revision ||
        item.taskId.length > 256 ||
        item.taskId.trim() !== item.taskId ||
        item.reason.length > 4_000 ||
        item.reason.trim() !== item.reason ||
        item.reason.length === 0 ||
        ("projectId" in item && item.projectId !== projectId) ||
        ("environmentId" in item && item.environmentId !== environmentId),
    )
  )
    return null;
  return {
    revision: value.revision,
    records: value.items.filter(knownAttention).slice(0, projectWorkEnvironment.pageSize),
    hasNext: value.items.length > projectWorkEnvironment.pageSize || value.hasMore,
  };
}

type Seen = Extract<ProjectWorkWriteIntent, { type: "project-work.attention.seen" }>;
type AttentionReview = {
  readonly occurrence: ProjectWorkAttentionRead;
  readonly revision: number;
  readonly command?: Seen;
  readonly status?: "sending" | "uncertain" | "rejected" | "accepted";
  readonly notice?: string;
};
const supportedAttention = Schema.is(ProjectWorkAttention);
const sameAttention = (a: ProjectWorkAttentionRead, b: ProjectWorkAttentionRead) =>
  a.taskId === b.taskId &&
  a.revision === b.revision &&
  a.reason === b.reason &&
  a.detail === b.detail &&
  a.seenAt === b.seenAt &&
  a.resolvedAt === b.resolvedAt;

/** The owner retains an uncertain seen command even when its page or capability disappears. */
function TaskAttention(props: InboxProps) {
  const write = useAtomCommand(projectWorkEnvironment.write, {
    reportFailure: false,
    reportDefect: false,
  });
  const [offset, setOffset] = useState(0);
  const [showResolved, setShowResolved] = useState(false);
  const [review, setReview] = useState<AttentionReview>();
  const reviewRef = useRef(review);
  const owner = useRef(false);
  const access = useRef(props);
  useLayoutEffect(() => {
    access.current = props;
  });
  useLayoutEffect(() => {
    owner.current = true;
    return () => {
      owner.current = false;
    };
  }, []);
  const store = (next: AttentionReview) => {
    reviewRef.current = next;
    setReview(next);
  };
  async function send(command: Seen) {
    const previous = reviewRef.current;
    if (
      !owner.current ||
      !access.current.connected ||
      !access.current.enabled ||
      !access.current.supported ||
      !access.current.writesSupported ||
      !previous ||
      previous.status === "sending" ||
      command.taskId !== previous.occurrence.taskId ||
      command.expectedRevision !== previous.revision ||
      (previous.command !== undefined && previous.command !== command)
    )
      return;
    store({ ...previous, command, status: "sending", notice: "Recording task attention as seen…" });
    let completed: AttentionReview;
    try {
      const outcome = await write({ environmentId: props.environmentId, input: command });
      if (outcome._tag === "Failure") throw squashAtomCommandFailure(outcome);
      completed = {
        ...previous,
        command,
        status: "accepted",
        notice: "Task attention marked seen. Resolution is unchanged.",
      };
    } catch (error) {
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
      completed = {
        ...previous,
        command,
        status: previous.status === "uncertain" || !explicit ? "uncertain" : "rejected",
        notice: projectWorkCommandFailure(error).message,
      };
    }
    if (!owner.current || reviewRef.current?.command !== command) return;
    store(completed);
  }
  return (
    <div className="flex flex-col gap-3" aria-label="Task attention">
      <WorkSectionHeader
        title="Task attention"
        description="Task notices that need a look. Marking one seen records acknowledgment; the task stays unresolved."
      />
      {!props.supported ? (
        <p className="text-sm text-muted-foreground">
          This environment does not support task attention.
        </p>
      ) : (
        <AttentionPage
          {...props}
          offset={offset}
          showResolved={showResolved}
          onOffset={setOffset}
          onShowResolved={setShowResolved}
          review={review}
          onReview={store}
          onSend={send}
        />
      )}
    </div>
  );
}

function AttentionPage(
  props: InboxProps & {
    readonly offset: number;
    readonly showResolved: boolean;
    readonly onOffset: (offset: number) => void;
    readonly onShowResolved: (value: boolean) => void;
    readonly review: AttentionReview | undefined;
    readonly onReview: (review: AttentionReview) => void;
    readonly onSend: (command: Seen) => Promise<void>;
  },
) {
  const registry = useContext(RegistryContext);
  const atom = projectWorkEnvironment.page({
    ...props,
    collection: "attention",
    offset: props.offset,
  });
  const result = useAtomValue(atom);
  const page = attentionPage(
    Option.getOrNull(AsyncResult.value(result)),
    props.environmentId,
    props.projectId,
    props.offset,
  );
  const current = page !== null && AsyncResult.isSuccess(result) && !result.waiting;
  const access = useRef(props);
  useLayoutEffect(() => {
    access.current = props;
  });
  const writable = props.connected && props.enabled && props.writesSupported && current;
  const rows = page?.records.filter((item) => props.showResolved || !item.resolvedAt) ?? [];
  const unsettled = props.review?.status === "sending" || props.review?.status === "uncertain";
  const latest = page?.records.find((item) => item.taskId === props.review?.occurrence.taskId);
  const changed =
    !latest ||
    !props.review ||
    !sameAttention(latest, props.review.occurrence) ||
    page?.revision !== props.review.revision;
  const canMark =
    writable &&
    props.review !== undefined &&
    !changed &&
    latest !== undefined &&
    supportedAttention(latest) &&
    !latest.resolvedAt &&
    !latest.seenAt &&
    !props.review.command &&
    page?.records.filter((item) => item.taskId === latest.taskId).length === 1;
  async function submit(retry: boolean) {
    const active = access.current;
    const review = active.review;
    if (
      !active.connected ||
      !active.enabled ||
      !active.supported ||
      !active.writesSupported ||
      !review ||
      review.status === "sending"
    )
      return;
    const freshResult = registry.get(atom);
    const fresh = attentionPage(
      Option.getOrNull(AsyncResult.value(freshResult)),
      active.environmentId,
      active.projectId,
      active.offset,
    );
    if (!fresh || !AsyncResult.isSuccess(freshResult) || freshResult.waiting) {
      active.onReview({
        ...review,
        notice: "Task attention is unavailable. Refresh and review before marking seen.",
      });
      return;
    }
    if (retry) {
      if (review.status === "uncertain" && review.command) await active.onSend(review.command);
      return;
    }
    const occurrences = fresh.records.filter((item) => item.taskId === review.occurrence.taskId);
    const occurrence = occurrences[0];
    if (
      review.command ||
      occurrences.length !== 1 ||
      !occurrence ||
      !supportedAttention(occurrence) ||
      occurrence.resolvedAt ||
      occurrence.seenAt ||
      fresh.revision !== review.revision ||
      !sameAttention(occurrence, review.occurrence)
    ) {
      active.onReview({
        ...review,
        notice: "Task attention changed. Review the current occurrence before marking seen.",
      });
      return;
    }
    await active.onSend({
      type: "project-work.attention.seen",
      projectId: active.projectId,
      taskId: occurrence.taskId,
      commandId: CommandId.make(randomUUID()),
      expectedRevision: review.revision,
      seenAt: new Date().toISOString(),
    });
  }
  return (
    <>
      {!props.connected || !current ? (
        <p className="text-sm text-warning-foreground">
          Cached or unavailable task attention. Reconnect and refresh before marking seen.
        </p>
      ) : null}
      {!props.writesSupported ? (
        <p className="text-sm text-muted-foreground">
          This environment does not support task attention acknowledgment.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={props.showResolved ? "secondary" : "outline"}
          aria-pressed={props.showResolved}
          onClick={() => props.onShowResolved(!props.showResolved)}
        >
          Include resolved attention
        </Button>
        <Button size="sm" variant="ghost" onClick={() => registry.refresh(atom)}>
          <RefreshCwIcon aria-hidden />
          Refresh task attention
        </Button>
      </div>
      {current && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No {props.showResolved ? "" : "unresolved "}task attention on this page.
        </p>
      ) : null}
      {rows.map((item) => (
        <WorkCard key={JSON.stringify([item.taskId, item.revision, item.resolvedAt])}>
          <h3 className="font-medium">
            {supportedAttention(item)
              ? item.reason
              : `Unsupported attention reason: ${item.reason}`}
          </h3>
          {item.detail ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.detail}</p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            {item.resolvedAt ? (
              <>
                Resolved <WorkTime value={item.resolvedAt} />
              </>
            ) : (
              "Unresolved"
            )}{" "}
            ·{" "}
            {item.seenAt ? (
              <>
                Seen <WorkTime value={item.seenAt} />
              </>
            ) : (
              "Not marked seen"
            )}
          </p>
          <WorkDetails className="mt-1">
            <p>
              Task {item.taskId} · Revision {item.revision}
            </p>
          </WorkDetails>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => props.onOpenTask(item.taskId)}>
              Open task {item.taskId}
            </Button>
            {supportedAttention(item) && !item.resolvedAt && !item.seenAt ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!writable || unsettled}
                onClick={() => props.onReview({ occurrence: item, revision: page!.revision })}
              >
                Review task attention
              </Button>
            ) : null}
          </div>
        </WorkCard>
      ))}
      {props.review ? (
        <div
          className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-card/50 p-4 text-sm"
          aria-label="Review task attention"
        >
          <p className="whitespace-pre-wrap">
            Reviewing task {props.review.occurrence.taskId}: {props.review.occurrence.reason}
            {props.review.occurrence.detail ? ` · ${props.review.occurrence.detail}` : ""}
          </p>
          {changed && !unsettled ? (
            <p>Task attention changed. Review the current occurrence before marking seen.</p>
          ) : null}
          {props.review.notice ? <p>{props.review.notice}</p> : null}
          {props.review.command ? (
            <p className="break-all text-xs text-muted-foreground">
              Original command {props.review.command.commandId}
            </p>
          ) : null}
          {props.review.status === "uncertain" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!writable}
              onClick={() => void submit(true)}
            >
              Retry exact task attention seen
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!canMark}
              onClick={() => void submit(false)}
            >
              Mark task attention seen
            </Button>
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {props.offset > 0 ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              props.onOffset(Math.max(0, props.offset - projectWorkEnvironment.pageSize))
            }
          >
            Previous attention page
          </Button>
        ) : null}
        {page?.hasNext ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.onOffset(props.offset + projectWorkEnvironment.pageSize)}
          >
            Next attention page
          </Button>
        ) : null}
      </div>
    </>
  );
}

function QuestionEditor(
  props: InboxProps & {
    readonly question: Question;
    readonly foundation: WorkTeamFoundationView;
    readonly draft: Draft | undefined;
    readonly onDraft: (draft: Draft) => void;
    readonly onSend: (command: Answer, refresh: () => void, wasUncertain: boolean) => Promise<void>;
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
      await props.onSend(command, props.foundation.refresh, previous.status === "uncertain");
    } catch (error) {
      if (mounted.current) update(failedAnswer(draftRef.current, error, command));
    } finally {
      busy.current = false;
    }
  }
  const frozen = draft.command !== undefined;
  return (
    <WorkCard className="border-primary/30">
      <h3 className="font-medium">Answer question</h3>
      {changed ? (
        <p className="mt-2 text-sm text-warning-foreground">
          Question changed. Your answer draft is preserved.
        </p>
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
