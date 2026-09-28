import {
  type ApprovalRequestId,
  type EnvironmentId,
  type OrchestrationAgentTranscriptEntry,
  type OrchestrationThreadActivity,
  type RuntimeAgentKey,
  type ThreadId,
} from "@t3tools/contracts";
import {
  agentTranscriptEntriesFromActivities,
  firstDiscardedAgentTranscriptCursor,
  mergeAgentTranscriptEntries,
  mergeAgentTranscriptPageWindows,
  recoverAgentTranscriptGap,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { derivePendingRequestsForAgent } from "@t3tools/client-runtime/pending-requests";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { AppText as Text } from "../../components/AppText";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function AgentTranscriptSheet(props: {
  readonly visible: boolean;
  readonly isConnected: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly agentKey: RuntimeAgentKey;
  readonly title: string;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: import("@t3tools/contracts").ProviderApprovalDecision,
  ) => Promise<unknown>;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const previousConnected = useRef(props.isConnected);
  const [requestCursor, setRequestCursor] = useState<string | null>(null);
  const [entries, setEntries] = useState<ReadonlyArray<OrchestrationAgentTranscriptEntry>>([]);
  const [newestEntries, setNewestEntries] = useState<
    ReadonlyArray<OrchestrationAgentTranscriptEntry>
  >([]);
  const [recoveredEntries, setRecoveredEntries] = useState<
    ReadonlyArray<OrchestrationAgentTranscriptEntry>
  >([]);
  const recoveredEntriesRef = useRef<ReadonlyArray<OrchestrationAgentTranscriptEntry>>([]);
  const [discardedHistoryCursor, setDiscardedHistoryCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [catchupCursor, setCatchupCursor] = useState<string | null>(null);
  const [catchupTarget, setCatchupTarget] = useState<number | null>(null);
  const [catchupIncomplete, setCatchupIncomplete] = useState(false);
  const [catchupPending, setCatchupPending] = useState(false);
  const [catchupFailed, setCatchupFailed] = useState(false);
  const catchupTargetRef = useRef<number | null>(null);
  const previousThreadWatermark = useRef<number | null>(null);
  const [answersByRequest, setAnswersByRequest] = useState<
    Readonly<Record<string, Record<string, PendingUserInputDraftAnswer>>>
  >({});
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );
  const [requestError, setRequestError] = useState<string | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [actionPending, setActionPending] = useState<"message" | "stop" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "subagent user input response",
  );
  const messageAgent = useAtomCommand(threadEnvironment.messageAgent, "message subagent");
  const stopAgent = useAtomCommand(threadEnvironment.stopAgent, "stop subagent");
  const readAgentTranscriptPage = useAtomCommand(orchestrationEnvironment.readAgentTranscriptPage, {
    label: "recover subagent transcript",
    reportFailure: false,
  });
  const retainRecoveredEntries = useCallback(
    (
      incoming: ReadonlyArray<OrchestrationAgentTranscriptEntry>,
      pageCursorByEntryId: ReadonlyMap<string, string> = new Map(),
      fallbackCursor: string | null = null,
    ) => {
      const current = recoveredEntriesRef.current;
      const discardedCursor = firstDiscardedAgentTranscriptCursor(
        current,
        incoming,
        pageCursorByEntryId,
        fallbackCursor,
      );
      const merged = mergeAgentTranscriptEntries(current, incoming);
      recoveredEntriesRef.current = merged;
      setRecoveredEntries(merged);
      if (discardedCursor !== null) {
        setDiscardedHistoryCursor((existing) => existing ?? discardedCursor);
      }
    },
    [],
  );
  const pageQuery = useEnvironmentQuery(
    props.visible
      ? orchestrationEnvironment.agentTranscriptPage({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
            agentKey: props.agentKey,
            ...(requestCursor ? { cursor: requestCursor } : {}),
          },
        })
      : null,
  );
  const newestPageQuery = useEnvironmentQuery(
    props.visible
      ? orchestrationEnvironment.agentTranscriptPage({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, agentKey: props.agentKey },
        })
      : null,
  );
  const runGapCatchup = useCallback(
    async (startCursor: string | null, watermark: number) => {
      setCatchupPending(true);
      setCatchupFailed(false);
      try {
        const pageCursorByEntryId = new Map<string, string>();
        const recovered = await recoverAgentTranscriptGap({
          startCursor,
          watermark,
          fetchPage: async (cursor) => {
            const result = await readAgentTranscriptPage({
              environmentId: props.environmentId,
              input: { threadId: props.threadId, agentKey: props.agentKey, cursor },
            });
            if (result._tag !== "Success") throw new Error("Transcript page read failed.");
            for (const entry of result.value.entries) pageCursorByEntryId.set(entry.id, cursor);
            return result.value;
          },
        });
        retainRecoveredEntries(recovered.entries, pageCursorByEntryId);
        setCatchupCursor(recovered.nextCursor);
        setCatchupIncomplete(!recovered.reachedWatermark);
        if (recovered.reachedWatermark) {
          catchupTargetRef.current = null;
          setCatchupTarget(null);
        }
        newestPageQuery.refresh();
      } catch {
        setCatchupIncomplete(true);
        setCatchupFailed(true);
      } finally {
        setCatchupPending(false);
      }
    },
    [
      newestPageQuery.refresh,
      props.agentKey,
      props.environmentId,
      props.threadId,
      readAgentTranscriptPage,
      retainRecoveredEntries,
    ],
  );
  const startGapCatchup = useCallback(
    async (watermark: number) => {
      setCatchupFailed(false);
      try {
        const result = await readAgentTranscriptPage({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, agentKey: props.agentKey },
        });
        if (result._tag !== "Success") throw new Error("Transcript page read failed.");
        setNewestEntries(result.value.entries);
        retainRecoveredEntries(result.value.entries, new Map(), result.value.nextCursor);
        const overlapsWatermark = result.value.entries.some(
          (entry) => entry.eventSequence <= watermark,
        );
        if (overlapsWatermark || result.value.nextCursor === null) {
          setCatchupCursor(null);
          setCatchupIncomplete(false);
          catchupTargetRef.current = null;
          setCatchupTarget(null);
          newestPageQuery.refresh();
          return;
        }
        await runGapCatchup(result.value.nextCursor, watermark);
      } catch {
        setCatchupCursor(null);
        setCatchupIncomplete(true);
        setCatchupFailed(true);
      }
    },
    [
      newestPageQuery.refresh,
      props.agentKey,
      props.environmentId,
      props.threadId,
      readAgentTranscriptPage,
      retainRecoveredEntries,
      runGapCatchup,
    ],
  );
  useEffect(() => {
    if (!previousConnected.current && props.isConnected && props.visible) {
      const watermark = previousThreadWatermark.current;
      if (watermark === null) {
        newestPageQuery.refresh();
      } else {
        catchupTargetRef.current = watermark;
        setCatchupTarget(watermark);
        setCatchupIncomplete(false);
        void startGapCatchup(watermark);
      }
    }
    previousConnected.current = props.isConnected;
  }, [
    newestPageQuery.refresh,
    props.agentKey,
    props.environmentId,
    props.isConnected,
    props.threadId,
    props.visible,
    readAgentTranscriptPage,
    startGapCatchup,
  ]);
  const page = pageQuery.data;
  const newestPage = newestPageQuery.data;
  const currentAgent = newestPage?.agent ?? page?.agent;
  useEffect(() => {
    if (props.visible && props.isConnected && newestPage) {
      previousThreadWatermark.current = newestPage.threadSequence;
    }
  }, [newestPage, props.isConnected, props.visible]);
  useEffect(() => {
    if (!page) return;
    const retention = requestCursor === null ? "newest" : "oldest";
    setEntries((current) =>
      mergeAgentTranscriptEntries(current, page.entries, undefined, retention),
    );
    setNextCursor(page.nextCursor);
    setHasMore(page.hasMore);
  }, [page, requestCursor]);
  useEffect(() => {
    if (newestPage) setNewestEntries(newestPage.entries);
  }, [newestPage]);
  const liveEntries = useMemo(
    () => agentTranscriptEntriesFromActivities(props.activities, props.agentKey),
    [props.activities, props.agentKey],
  );
  const visibleEntries = useMemo(
    () => mergeAgentTranscriptPageWindows(entries, newestEntries, liveEntries, recoveredEntries),
    [entries, newestEntries, liveEntries, recoveredEntries],
  );
  const childActivityWatermark = useMemo(
    () =>
      props.activities.reduce((watermark, activity) => {
        if (
          typeof activity.payload !== "object" ||
          activity.payload === null ||
          (activity.payload as Record<string, unknown>).agentKey !== props.agentKey
        ) {
          return watermark;
        }
        return Math.max(watermark, activity.eventSequence ?? activity.sequence ?? 0);
      }, 0),
    [props.activities, props.agentKey],
  );
  const previousChildActivityWatermark = useRef(childActivityWatermark);
  useEffect(() => {
    if (childActivityWatermark !== previousChildActivityWatermark.current) {
      previousChildActivityWatermark.current = childActivityWatermark;
      newestPageQuery.refresh();
    }
  }, [childActivityWatermark, newestPageQuery.refresh]);
  const requests = useMemo(
    () => derivePendingRequestsForAgent(props.activities, props.agentKey),
    [props.activities, props.agentKey],
  );
  const parentTitle = useMemo(() => {
    const parentKey = currentAgent?.parentKey;
    if (!parentKey) return null;
    for (let index = props.activities.length - 1; index >= 0; index -= 1) {
      const activity = props.activities[index];
      if (typeof activity?.payload !== "object" || activity.payload === null) continue;
      const payload = activity.payload as Record<string, unknown>;
      if (
        payload.agentKey === parentKey &&
        typeof payload.title === "string" &&
        payload.title.trim()
      ) {
        return payload.title.trim();
      }
    }
    return "another subagent";
  }, [currentAgent?.parentKey, props.activities]);

  useEffect(() => {
    if (!props.visible) {
      setRequestCursor(null);
      setEntries([]);
      setNewestEntries([]);
      setRecoveredEntries([]);
      recoveredEntriesRef.current = [];
      setNextCursor(null);
      setHasMore(false);
      setDiscardedHistoryCursor(null);
      setCatchupCursor(null);
      setCatchupTarget(null);
      setCatchupIncomplete(false);
      setCatchupFailed(false);
      catchupTargetRef.current = null;
      setRequestError(null);
      if (actionPending === null) setMessageDraft("");
      setActionError(null);
    }
  }, [actionPending, props.visible]);

  const submitMessage = async () => {
    const text = messageDraft.trim();
    if (!text || actionPending !== null) return;
    setActionPending("message");
    setActionError(null);
    const result = await messageAgent({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, agentKey: props.agentKey, text },
    });
    if (result._tag === "Failure") {
      setActionError("Could not send the message. The child session may have changed.");
    } else {
      setMessageDraft("");
    }
    setActionPending(null);
  };

  const submitStop = async () => {
    if (actionPending !== null) return;
    setActionPending("stop");
    setActionError(null);
    const result = await stopAgent({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, agentKey: props.agentKey },
    });
    if (result._tag === "Failure") {
      setActionError("Could not stop this child. Its live session may have changed.");
    }
    setActionPending(null);
  };
  const continueCatchup = () => {
    const target = catchupTargetRef.current;
    if (target === null) return;
    if (catchupCursor !== null) {
      void runGapCatchup(catchupCursor, target);
    } else if (catchupFailed) {
      void startGapCatchup(target);
    }
  };
  const browseDiscardedHistory = () => {
    if (discardedHistoryCursor === null) return;
    setEntries([]);
    setNextCursor(null);
    setHasMore(false);
    setRequestCursor(discardedHistoryCursor);
    setDiscardedHistoryCursor(null);
  };
  const canMessage = props.isConnected && currentAgent?.capabilities.message.state === "supported";
  const canStop = props.isConnected && currentAgent?.capabilities.stop.state === "supported";

  const submitUserInput = async (
    requestId: ApprovalRequestId,
    questions: PendingUserInput["questions"],
  ) => {
    const answers = buildPendingUserInputAnswers(questions, answersByRequest[requestId] ?? {});
    if (answers === null) {
      setRequestError("Answer each question before sending.");
      return;
    }
    setRequestError(null);
    setRespondingUserInputId(requestId);
    const result = await respondToUserInput({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, requestId, answers },
    });
    if (result._tag === "Failure")
      setRequestError("Could not submit the answer. The request may have expired.");
    setRespondingUserInputId(null);
  };

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center gap-3 border-b border-border px-4 py-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to parent thread"
            onPress={props.onClose}
            className="rounded-xl bg-subtle-strong px-3 py-2"
          >
            <Text className="font-t3-bold text-sm text-foreground">Back</Text>
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="font-t3-bold text-base text-foreground" numberOfLines={1}>
              {currentAgent?.title ?? props.title}
            </Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {currentAgent?.role ?? "Subagent"} · {currentAgent?.provider ?? "Provider pending"} ·{" "}
              {currentAgent?.status ?? "Loading"}
              {parentTitle ? ` · Nested under ${parentTitle}` : " · Child of this thread"}
            </Text>
          </View>
        </View>
        <ScrollView contentContainerClassName="gap-3 p-4">
          {newestPage?.completeness.state !== "complete" ? (
            <View className="rounded-2xl bg-subtle px-3 py-2.5">
              <Text className="text-xs leading-normal text-foreground-muted">
                {newestPage?.completeness.reason ??
                  "Transcript availability is not yet known for this agent."}
              </Text>
            </View>
          ) : null}
          {pageQuery.error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              Could not load this agent transcript.
            </Text>
          ) : null}
          {pageQuery.isPending && visibleEntries.length === 0 ? (
            <Text className="py-5 text-center text-sm text-foreground-muted">
              Loading transcript…
            </Text>
          ) : null}
          {requests.approvals.map((approval) => (
            <PendingApprovalCard
              key={approval.requestId}
              approval={approval}
              respondingApprovalId={props.respondingApprovalId}
              onRespond={props.onRespondToApproval}
            />
          ))}
          {requests.userInputs.map((request) => {
            const draft = answersByRequest[request.requestId] ?? {};
            return (
              <View
                key={request.requestId}
                className="gap-3 rounded-[20px] border border-border bg-card-alt p-4"
              >
                <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
                  Subagent question
                </Text>
                {request.questions.map((question) => (
                  <View key={question.id} className="gap-2">
                    <Text className="font-t3-medium text-sm text-foreground">
                      {question.question}
                    </Text>
                    {question.options.map((option) => {
                      const value = option.value ?? option.label;
                      const selected =
                        draft[question.id]?.selectedOptionValues?.includes(value) ?? false;
                      return (
                        <Pressable
                          key={value}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          disabled={respondingUserInputId === request.requestId}
                          onPress={() =>
                            setAnswersByRequest((current) => ({
                              ...current,
                              [request.requestId]: {
                                ...current[request.requestId],
                                [question.id]: togglePendingUserInputOptionSelection(
                                  question,
                                  current[request.requestId]?.[question.id],
                                  value,
                                ),
                              },
                            }))
                          }
                          className={`rounded-xl px-3 py-2.5 ${selected ? "bg-primary" : "bg-subtle-strong"}`}
                        >
                          <Text
                            className={`text-sm ${selected ? "text-primary-foreground" : "text-foreground"}`}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                    {question.allowCustomAnswer !== false ? (
                      <TextInput
                        accessibilityLabel={`Answer ${question.header || question.question}`}
                        value={draft[question.id]?.customAnswer ?? ""}
                        editable={respondingUserInputId !== request.requestId}
                        onChangeText={(text) =>
                          setAnswersByRequest((current) => ({
                            ...current,
                            [request.requestId]: {
                              ...current[request.requestId],
                              [question.id]: setPendingUserInputCustomAnswer(
                                question,
                                current[request.requestId]?.[question.id],
                                text,
                              ),
                            },
                          }))
                        }
                        placeholder="Write an answer"
                        multiline
                        className="min-h-12 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
                      />
                    ) : null}
                  </View>
                ))}
                <Pressable
                  accessibilityRole="button"
                  disabled={respondingUserInputId === request.requestId}
                  onPress={() => void submitUserInput(request.requestId, request.questions)}
                  className="self-start rounded-xl bg-primary px-4 py-3"
                >
                  <Text className="font-t3-bold text-sm text-primary-foreground">
                    {respondingUserInputId === request.requestId ? "Sending…" : "Answer"}
                  </Text>
                </Pressable>
              </View>
            );
          })}
          {requestError ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {requestError}
            </Text>
          ) : null}
          {visibleEntries.map((entry) => (
            <View key={entry.id} className="gap-1 rounded-2xl border border-border bg-card p-3">
              <Text className="font-t3-bold text-2xs uppercase tracking-[1px] text-foreground-muted">
                {entry.kind === "message"
                  ? entry.role === "user"
                    ? "You"
                    : entry.role === "tool"
                      ? "Tool"
                      : "Agent"
                  : entry.kind}
              </Text>
              {entry.content ? (
                <Text selectable className="font-mono text-sm leading-normal text-foreground">
                  {entry.content}
                </Text>
              ) : (
                <Text selectable className="text-sm leading-normal text-foreground-secondary">
                  {entry.detail ?? entry.summary}
                </Text>
              )}
              {entry.deliveryStatus ? (
                <Text accessibilityRole="text" className="text-xs text-foreground-muted">
                  {entry.deliveryStatus === "pending"
                    ? "Sending"
                    : entry.deliveryStatus === "accepted"
                      ? "Accepted by subagent"
                      : entry.deliveryStatus === "completed"
                        ? "Completed"
                        : entry.deliveryStatus === "failed"
                          ? "Delivery failed"
                          : "Delivery outcome unknown"}
                  {entry.detail ? ` · ${entry.detail}` : ""}
                </Text>
              ) : null}
              {entry.handoffStatus ? (
                <Text accessibilityRole="text" className="text-xs text-foreground-muted">
                  {entry.handoffStatus === "pending"
                    ? "Parent handoff pending"
                    : entry.handoffStatus === "recorded"
                      ? "Added to parent context"
                      : entry.handoffStatus === "unavailable"
                        ? "Parent handoff unavailable"
                        : entry.handoffStatus === "failed"
                          ? "Parent handoff failed"
                          : "Parent handoff outcome unknown"}
                </Text>
              ) : null}
            </View>
          ))}
          {canMessage ? (
            <View className="gap-2 rounded-2xl border border-border bg-card p-3">
              <Text className="font-t3-bold text-sm text-foreground">Message this subagent</Text>
              <TextInput
                accessibilityLabel="Message this subagent"
                value={messageDraft}
                maxLength={16_000}
                editable={actionPending === null}
                multiline
                onChangeText={setMessageDraft}
                placeholder="Send guidance to this subagent"
                className="min-h-20 rounded-xl bg-subtle px-3 py-2 text-sm text-foreground"
              />
              <Pressable
                accessibilityRole="button"
                disabled={!messageDraft.trim() || actionPending !== null}
                onPress={() => void submitMessage()}
                className="self-end rounded-xl bg-primary px-4 py-2.5"
              >
                <Text className="font-t3-bold text-sm text-primary-foreground">
                  {actionPending === "message" ? "Sending…" : "Send"}
                </Text>
              </Pressable>
            </View>
          ) : null}
          {canStop ? (
            <Pressable
              accessibilityRole="button"
              disabled={actionPending !== null}
              onPress={() => void submitStop()}
              className="self-start rounded-xl border border-border bg-subtle-strong px-4 py-3"
            >
              <Text className="font-t3-bold text-sm text-foreground">
                {actionPending === "stop" ? "Stopping…" : "Stop subagent"}
              </Text>
            </Pressable>
          ) : null}
          {actionError ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {actionError}
            </Text>
          ) : null}
          {visibleEntries.length === 0 &&
          page &&
          requests.approvals.length === 0 &&
          requests.userInputs.length === 0 ? (
            <Text className="py-5 text-center text-sm text-foreground-muted">
              No transcript entries are available for this agent.
            </Text>
          ) : null}
          {catchupIncomplete ? (
            <View accessibilityRole="alert" className="rounded-xl border border-border px-3 py-2">
              <Text className="text-xs text-foreground-muted">
                {catchupFailed
                  ? "Reconnect catch-up failed. Some child activity may be missing."
                  : `Reconnect catch-up stopped before thread sequence ${catchupTarget ?? "the previous connection"}. Some child activity may be missing.`}
              </Text>
              {catchupCursor !== null || catchupFailed ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={catchupPending}
                  onPress={continueCatchup}
                  className="mt-2 self-start rounded-xl bg-subtle-strong px-3 py-2"
                >
                  <Text className="font-t3-bold text-sm text-foreground">
                    {catchupPending
                      ? "Catching up…"
                      : catchupFailed
                        ? "Retry catch-up"
                        : "Continue catch-up"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {discardedHistoryCursor !== null ? (
            <Pressable
              accessibilityRole="button"
              disabled={catchupPending}
              onPress={browseDiscardedHistory}
              className="self-center rounded-xl bg-subtle-strong px-4 py-3"
            >
              <Text className="font-t3-bold text-sm text-foreground">Browse skipped history</Text>
            </Pressable>
          ) : null}
          {hasMore && nextCursor ? (
            <Pressable
              accessibilityRole="button"
              disabled={pageQuery.isPending}
              onPress={() => setRequestCursor(nextCursor)}
              className="self-center rounded-xl bg-subtle-strong px-4 py-3"
            >
              <Text className="font-t3-bold text-sm text-foreground">
                {pageQuery.isPending ? "Loading…" : "Load earlier activity"}
              </Text>
            </Pressable>
          ) : null}
          <View className="rounded-2xl bg-subtle px-3 py-2.5">
            <Text className="text-xs leading-normal text-foreground-muted">
              {currentAgent?.capabilities.message.state === "supported"
                ? "Messaging is available for this agent."
                : (currentAgent?.capabilities.message.reason ??
                  "Messaging is not verified for this provider session.")}
              {currentAgent?.capabilities.stop.state === "supported"
                ? " Stop is available."
                : ` ${currentAgent?.capabilities.stop.reason ?? "Stop is not verified for this provider session."}`}
            </Text>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
