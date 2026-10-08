import { useNavigation } from "@react-navigation/native";
import {
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkTaskId,
  type ProjectWorkWriteIntent,
} from "@t3tools/contracts";
import type { ProjectWorkFoundationSnapshot } from "@t3tools/client-runtime/project-work";
import {
  asProjectTeamBindingAccounting,
  projectTeamAccountingCaptions,
} from "@t3tools/client-runtime/project-work";
import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { createHomeThreadNavigationAction } from "../home/home-thread-navigation";
import { type MobileWorkCurrent } from "./workActions";
import { Notice, WorkButton, WorkCard } from "./WorkScreens";
import {
  createQuestionActionSession,
  mobileTeamView,
  reviewMobileQuestion,
} from "./workTeamActions";

type Target = { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
const PAGE_SIZE = 10;

function RecordPage<T>({
  title,
  rows,
  render,
}: {
  readonly title: string;
  readonly rows: ReadonlyArray<T>;
  readonly render: (row: T) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visible = Math.min(page, pages - 1);
  return (
    <WorkCard title={title}>
      {rows.slice(visible * PAGE_SIZE, (visible + 1) * PAGE_SIZE).map(render)}
      {rows.length === 0 ? <Notice>No records.</Notice> : null}
      {pages > 1 ? (
        <>
          <View className="flex-row flex-wrap gap-2">
            <WorkButton disabled={visible === 0} onPress={() => setPage(visible - 1)}>
              Previous {title.toLowerCase()}
            </WorkButton>
            <WorkButton disabled={visible + 1 === pages} onPress={() => setPage(visible + 1)}>
              Next {title.toLowerCase()}
            </WorkButton>
          </View>
          <Notice>
            Page {visible + 1} of {pages}
          </Notice>
        </>
      ) : null}
    </WorkCard>
  );
}

/** Uses the existing complete foundation cache; opening a worker loads its thread separately. */
export function WorkTeam({
  target,
  foundation,
  supported,
}: {
  readonly target: Target;
  readonly foundation: ProjectWorkFoundationSnapshot;
  readonly supported: boolean;
}) {
  const navigation = useNavigation();
  const view = useMemo(() => mobileTeamView(foundation, target), [foundation, target]);
  const openTask = (taskId: ProjectWorkTaskId) =>
    navigation.navigate("WorkTask", { ...target, taskId });
  if (!supported)
    return (
      <WorkCard title="Team and questions">
        <Notice>This server does not support team reads. Update it to supervise team work.</Notice>
      </WorkCard>
    );
  return (
    <>
      <RecordPage
        title="Team"
        rows={view.members}
        render={({ member, role, runs }) => (
          <View key={member.recordId} className="gap-2 border-t border-border pt-3">
            <Text className="font-t3-medium text-foreground">{member.name}</Text>
            <Notice>
              {member.status}
              {member.coordinator ? " · coordinator" : ""}
            </Notice>
            <Notice>
              {role
                ? `${role.role} · ${role.model} · profile ${role.roleRevision}`
                : "Role unavailable"}
            </Notice>
            {runs
              .filter(({ run }) => run.status !== "settled")
              .slice(0, 3)
              .map(({ run, role: frozen }) => (
                <Notice key={run.recordId}>
                  {run.taskId} · {run.status} · {frozen?.role ?? "Role unavailable"} · {run.model}
                </Notice>
              ))}
            {runs.length > 0 ? (
              <Notice>Inspect assignments and recorded run configuration below.</Notice>
            ) : (
              <Notice>No recorded assignments.</Notice>
            )}
          </View>
        )}
      />
      <RecordPage
        title="Workers"
        rows={view.runs}
        render={(run) => {
          const member = view.members.find((entry) => entry.member.recordId === run.memberId);
          const role = member?.runs.find((entry) => entry.run.recordId === run.recordId)?.role;
          const local = run.environmentId === target.environmentId;
          return (
            <View key={run.recordId} className="gap-2 border-t border-border pt-3">
              <Text className="font-t3-medium text-foreground">
                {member?.member.name ?? run.memberId}
              </Text>
              <Notice>
                {run.status} · {role?.role ?? run.roleRevisionId} · {run.model}
              </Notice>
              <Notice>
                Task {run.taskId} · attempt {run.attemptId}
              </Notice>
              {projectTeamAccountingCaptions(
                asProjectTeamBindingAccounting(
                  foundation.accounting?.find((item) => item.bindingId === run.recordId),
                  run,
                ),
              ).map((caption) => (
                <Notice key={caption}>{caption}</Notice>
              ))}
              <Notice>
                Specification {run.specRevision} · plan {run.planRevision}
              </Notice>
              <Text selectable className="text-sm text-foreground-muted">
                {run.worktree} · {run.branch}
              </Text>
              <Notice>
                Parent run: {run.parentRunId ?? "none"} · recorded {run.updatedAt}
              </Notice>
              <View className="flex-row flex-wrap gap-2">
                <WorkButton onPress={() => openTask(run.taskId)}>Inspect worker task</WorkButton>
                <WorkButton
                  disabled={!local}
                  onPress={() => {
                    if (!local) return;
                    navigation.dispatch((state) =>
                      createHomeThreadNavigationAction({
                        state,
                        dismissingRouteKey: null,
                        thread: { environmentId: target.environmentId, id: run.threadId },
                      }),
                    );
                  }}
                >
                  Open worker thread
                </WorkButton>
              </View>
              {!local ? (
                <Notice>
                  This run belongs to another environment. Open that environment to inspect its
                  thread.
                </Notice>
              ) : null}
            </View>
          );
        }}
      />
      <RecordPage
        title="Questions"
        rows={view.questions}
        render={(question) => (
          <View key={question.recordId} className="gap-2 border-t border-border pt-3">
            <Text selectable>{question.body}</Text>
            <Notice>
              {question.status} · request {question.recordId} · task {question.taskId}
            </Notice>
            <Notice>
              Gate {question.targetGateId} · revision {question.targetRevision}
            </Notice>
            {question.answer ? <Text selectable>Answer: {question.answer}</Text> : null}
            <WorkButton onPress={() => openTask(question.taskId)}>
              Review question in task
            </WorkButton>
          </View>
        )}
      />
      {view.unsupported.length > 0 ? (
        <RecordPage
          title="Unsupported workflow records"
          rows={view.unsupported}
          render={(record) => (
            <View key={record.recordId} className="gap-1 border-t border-border pt-3">
              <Notice>
                {record.kind} · {record.status} · {record.recordId}
              </Notice>
              {"payload" in record && typeof record.payload === "string" ? (
                <Text selectable>{record.payload}</Text>
              ) : null}
              <Notice>Update this client to make authoritative changes.</Notice>
            </View>
          )}
        />
      ) : null}
    </>
  );
}

/** Keep each draft and uncertain original command when paging among task questions. */
export function WorkQuestions({
  current,
  readCurrent,
  send,
}: {
  readonly current: MobileWorkCurrent;
  readonly readCurrent: () => MobileWorkCurrent;
  readonly send: (intent: ProjectWorkWriteIntent) => Promise<void>;
}) {
  const [, changed] = useState(0);
  const [sessions] = useState(
    () => new Map<string, ReturnType<typeof createQuestionActionSession>>(),
  );
  const [page, setPage] = useState(0);
  const questions = useMemo(
    () =>
      mobileTeamView(current.foundation, current).questions.filter(
        (question) => question.taskId === current.taskId,
      ),
    [current],
  );
  const pages = Math.max(1, Math.ceil(questions.length / PAGE_SIZE));
  const visible = Math.min(page, pages - 1);
  const visibleQuestions = useMemo(
    () => questions.slice(visible * PAGE_SIZE, (visible + 1) * PAGE_SIZE),
    [questions, visible],
  );
  const reviews = useMemo(
    () =>
      new Map(
        visibleQuestions.map((question) => [
          question.recordId,
          reviewMobileQuestion(current, question.recordId),
        ]),
      ),
    [current, visibleQuestions],
  );
  for (const question of visibleQuestions) {
    if (!sessions.has(question.recordId))
      sessions.set(
        question.recordId,
        createQuestionActionSession(
          { ...current, questionId: question.recordId },
          readCurrent,
          send,
          () => CommandId.make(uuidv4()),
          () => changed((value) => value + 1),
        ),
      );
  }
  useLayoutEffect(() => {
    for (const session of sessions.values()) session.setCurrent(readCurrent);
  });
  useLayoutEffect(() => {
    for (const session of sessions.values()) session.activate();
    return () => {
      for (const session of sessions.values()) session.dispose();
    };
  }, [sessions]);
  return (
    <WorkCard title="Human questions">
      <Notice>
        Answer the recorded request. Seeing it does not resolve it. Continuing this task still
        requires current approvals, ownership, and server eligibility.
      </Notice>
      {questions.length === 0 ? <Notice>No recorded questions for this task.</Notice> : null}
      {visibleQuestions.map((question) => {
        const session = sessions.get(question.recordId)!;
        const state = session.state;
        const review = reviews.get(question.recordId)!;
        const editing = state.status !== "sending" && state.status !== "uncertain";
        return (
          <View key={question.recordId} className="gap-3 border-t border-border pt-3">
            <Text selectable>{question.body}</Text>
            <Notice>
              {question.status} · request {question.recordId} · from {question.senderId}
            </Notice>
            <Notice>
              Waiting on {review.gate?.gate ?? question.targetGateId} · gate revision{" "}
              {question.targetRevision}
              {review.gate
                ? ` · specification ${review.gate.specRevision}, plan ${review.gate.planRevision}`
                : " · target unavailable"}
            </Notice>
            {question.seenAt ? (
              <Notice>Seen {question.seenAt}; an answer is still required while pending.</Notice>
            ) : null}
            {question.answer ? <Text selectable>Recorded answer: {question.answer}</Text> : null}
            {review.reason && question.status !== "answered" && question.status !== "canceled" ? (
              <Notice>{review.reason}</Notice>
            ) : null}
            {state.notice ? <Notice>{state.notice}</Notice> : null}
            {state.status === "sending" ? <Notice>Sending answer…</Notice> : null}
            {question.status === "pending" ? (
              <>
                {question.choices.length > 0 ? (
                  question.choices.map((choice) => (
                    <WorkButton
                      key={choice}
                      disabled={!editing}
                      onPress={() => session.edit(choice)}
                    >
                      {state.draft === choice ? `Selected: ${choice}` : choice}
                    </WorkButton>
                  ))
                ) : (
                  <TextInput
                    accessibilityLabel={`Answer to request ${question.recordId}`}
                    multiline
                    maxLength={4000}
                    editable={editing}
                    value={state.draft}
                    onChangeText={(text) => session.edit(text)}
                    placeholder="Your answer"
                  />
                )}
                <WorkButton
                  disabled={
                    review.reason !== null ||
                    state.status !== "idle" ||
                    state.draft.trim().length === 0
                  }
                  onPress={() => void session.submit()}
                >
                  Send answer
                </WorkButton>
              </>
            ) : null}
            {state.status === "uncertain" ? (
              <WorkButton
                disabled={!current.connected || !current.fresh}
                onPress={() => void session.retry()}
              >
                Retry original answer
              </WorkButton>
            ) : null}
            {state.status !== "sending" &&
            state.status !== "uncertain" &&
            question.status === "pending" ? (
              <WorkButton disabled={review.reason !== null} onPress={() => session.review()}>
                Review current question
              </WorkButton>
            ) : null}
          </View>
        );
      })}
      {pages > 1 ? (
        <View className="flex-row flex-wrap gap-2">
          <WorkButton disabled={visible === 0} onPress={() => setPage(visible - 1)}>
            Previous questions
          </WorkButton>
          <WorkButton disabled={visible + 1 === pages} onPress={() => setPage(visible + 1)}>
            Next questions
          </WorkButton>
        </View>
      ) : null}
    </WorkCard>
  );
}
