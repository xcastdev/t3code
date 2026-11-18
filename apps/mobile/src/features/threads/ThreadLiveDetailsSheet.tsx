import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isProjectTerminalRunning,
  projectTerminalStatusLabel,
} from "@t3tools/client-runtime/project-terminal-view";
import { formatContextWindowTokens } from "@t3tools/client-runtime/state/context-window";
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import {
  countThreadDetailsStatuses,
  type ThreadDetailsStatusCounts,
} from "@t3tools/client-runtime/state/thread-details";
import {
  presentPendingBackgroundWork,
  type PendingBackgroundWorkItem,
} from "@t3tools/client-runtime/state/thread-execution";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2PlanStep,
  type OrchestrationV2Subagent,
  type ProjectId,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { Atom } from "effect/reactivity";
import { useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type ScrollViewInstance,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useSideChats, useThreadShell as useThreadShellByRef } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { projectTerminalEnvironment, useProjectTerminalDock } from "../../state/projectTerminals";
import { useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { useThreadChecklist, useThreadContextWindow } from "../../state/use-thread-live-data";
import { BackgroundWorkRow } from "./ThreadBackgroundWorkSheet";
import {
  LiveSection,
  StatusBadges,
  SummaryRing,
  SummaryText,
  ThreadDetailsCollapseContext,
} from "./ThreadLiveDetailsSection";
import { ThreadAgentRows, useOpenThreadFromSheet, useWorkflowGroups } from "./ThreadAgentsSheet";
import {
  ThreadAutomationsSection,
  ThreadMcpSection,
  ThreadUsageSection,
  ThreadSourceControlSection,
} from "./ThreadLiveDetailsSettingsSections";
import {
  checklistProgressLabel,
  deriveThreadLiveTurn,
  partitionThreadAgents,
  PREVIOUS_AGENTS_PAGE,
  seenFailureKey,
  SIDE_CHAT_STATE_LABELS,
  SIDE_CHAT_STATUS_BUCKETS,
  sideChatState,
  type SideChatState,
  type ThreadLiveDetailsSection,
} from "./threadLiveDetails.logic";
import {
  useCompactThread,
  useInterruptThread,
  useSeenFailedAgents,
  useThreadDetailsCollapse,
  useThreadModelDisplay,
  useThreadShell,
  type LiveDetailsTarget,
} from "./use-thread-live-details";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { ContextRing } from "./ContextRing";

type ThreadLiveDetailsParams = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly section?: ThreadLiveDetailsSection;
};

type OpenThread = (thread: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) => void;

type Anchor = ((event: LayoutChangeEvent) => void) | undefined;

/** The web thread details panel as a sheet, with the current turn and its Stop on top. */
export function ThreadLiveDetailsSheet({ route }: StaticScreenProps<ThreadLiveDetailsParams>) {
  const { environmentId, threadId, section } = route.params;
  const target = { environmentId, threadId };
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const openThread = useOpenThreadFromSheet(target);
  const collapse = useThreadDetailsCollapse(section);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const userScrolled = useRef(false);
  // Sections above the requested one can load after it lays out; follow it until the user scrolls.
  const anchor = (id: ThreadLiveDetailsSection): Anchor =>
    section !== id || id === "turn"
      ? undefined
      : (event) => {
          if (userScrolled.current) return;
          scrollRef.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: false });
        };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ThreadDetailsHeader target={target} onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ThreadDetailsCollapseContext.Provider value={collapse}>
          <ScrollView
            ref={scrollRef}
            nestedScrollEnabled
            className="flex-1"
            // UIKit must inset content beneath the floating translucent iOS header.
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-4 px-4 pt-3"
            contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
            onScrollBeginDrag={() => {
              userScrolled.current = true;
            }}
          >
            <TurnSection target={target} />
            <ContextSection target={target} onLayout={anchor("context")} />
            <ThreadUsageSection target={target} onLayout={anchor("usage")} />
            <ThreadSourceControlSection target={target} onOpenThread={openThread} />
            <AgentsSection target={target} onOpenThread={openThread} onLayout={anchor("agents")} />
            <SideChatsSection
              target={target}
              onOpenThread={openThread}
              onLayout={anchor("sideChats")}
            />
            <ChecklistSection target={target} onLayout={anchor("checklist")} />
            <ProcessesSection target={target} onOpenThread={openThread} />
            <ThreadMcpSection target={target} />
            <ThreadAutomationsSection target={target} />
          </ScrollView>
        </ThreadDetailsCollapseContext.Provider>
      </ScreenContent>
    </View>
  );
}

/** The thread's provider, model and effort, as the composer's model button shows them. */
function ThreadDetailsHeader(props: {
  readonly target: LiveDetailsTarget;
  readonly onClose: () => void;
}) {
  const model = useThreadModelDisplay(props.target);
  if (model === null) return <SheetHeader title="Thread details" onClose={props.onClose} />;
  const title = [model.label, model.summary].filter(Boolean).join(", ");
  return (
    <SheetHeader
      title={title}
      titleContent={
        <View
          accessible
          accessibilityLabel={title}
          className="min-w-0 shrink flex-row items-center gap-1.5"
        >
          <ProviderIcon provider={model.providerDriver} iconUrl={model.providerIconUrl} size={16} />
          <Text
            textRole="body"
            numberOfLines={1}
            className="min-w-0 shrink font-t3-semibold text-foreground"
          >
            {model.shortLabel}
            {model.summary ? (
              <Text className="font-t3-medium text-foreground-muted"> · {model.summary}</Text>
            ) : null}
          </Text>
        </View>
      }
      onClose={props.onClose}
    />
  );
}

/** While a turn runs: how long it has worked, and Stop. Nothing once it ends. */
function TurnSection(props: { readonly target: LiveDetailsTarget }) {
  const shell = useThreadShell(props.target);
  const { canStop, stopping, stop } = useInterruptThread(props.target);
  const turn = deriveThreadLiveTurn(shell);
  const working = turn?.kind === "working";
  const nowMs = useVisibleSecondClock(working && turn.startedAt !== null);
  if (!working) return null;
  const title =
    turn.startedAt === null
      ? "Working"
      : `Working for ${formatWorkingDurationLabel(nowMs - Date.parse(turn.startedAt))}`;
  return (
    <View className="min-h-12 flex-row items-center gap-3 px-2">
      <View className="min-w-0 flex-1 flex-row items-center gap-2">
        <View className="size-2 rounded-full bg-adaptive-blue-500-400" />
        <Text
          textRole="body"
          className="shrink font-t3-medium tabular-nums text-foreground"
          numberOfLines={1}
        >
          {title}
        </Text>
      </View>
      {canStop ? (
        <Button
          label={stopping ? "Stopping…" : "Stop"}
          icon="stop.fill"
          tone="danger"
          size="compact"
          disabled={stopping}
          onPress={() => void stop()}
        />
      ) : null}
    </View>
  );
}

function ContextSection(props: { readonly target: LiveDetailsTarget; readonly onLayout: Anchor }) {
  const usage = useThreadContextWindow(
    scopeThreadRef(props.target.environmentId, props.target.threadId),
  );
  const { unavailableReason, compact } = useCompactThread(props.target);
  if (usage === null) return null;
  const percentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const percent = Math.round(percentage);
  const maxTokens = usage.maxTokens ?? null;
  const remaining =
    maxTokens === null
      ? null
      : (usage.remainingTokens ?? Math.max(0, maxTokens - usage.usedTokens));
  const breakdown = [
    { label: "Input", value: usage.inputTokens },
    { label: "Cached", value: usage.cachedInputTokens },
    { label: "Output", value: usage.outputTokens },
    { label: "Reasoning", value: usage.reasoningOutputTokens },
  ].filter((entry): entry is { label: string; value: number } => !!entry.value);
  return (
    <LiveSection
      id="context"
      title="Context"
      onLayout={props.onLayout}
      summary={
        maxTokens !== null ? (
          <View className="flex-row items-center gap-1.5">
            <SummaryRing
              percent={percent}
              dangerAt={90}
              label={`Context window: ${percent}% used`}
            />
            <SummaryText>
              {formatContextWindowTokens(usage.usedTokens)}/{formatContextWindowTokens(maxTokens)}
            </SummaryText>
          </View>
        ) : (
          `${formatContextWindowTokens(usage.usedTokens)} tokens`
        )
      }
    >
      <View className="flex-row items-center gap-4 px-4 py-4">
        {maxTokens !== null ? (
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={`${percent}% of the context window used`}
            className="size-14 items-center justify-center"
          >
            <View className="absolute inset-0">
              <ContextRing percent={percentage} size={56} stroke={5} dangerAt={90} />
            </View>
            <Text className="text-sm font-t3-semibold tabular-nums text-foreground">
              {percent}%
            </Text>
          </View>
        ) : null}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="body" className="font-t3-semibold tabular-nums text-foreground">
            {maxTokens !== null
              ? `${formatContextWindowTokens(usage.usedTokens)} of ${formatContextWindowTokens(maxTokens).toUpperCase()} tokens`
              : `${formatContextWindowTokens(usage.usedTokens)} tokens used`}
          </Text>
          <Text
            textRole="footnote"
            className="tabular-nums text-foreground-muted"
            numberOfLines={2}
          >
            {unavailableReason ??
              (remaining === null
                ? "Window size not reported"
                : `${formatContextWindowTokens(remaining)} remaining`)}
          </Text>
        </View>
        {unavailableReason === null ? (
          <Button
            label="Compact"
            icon="arrow.down.right.and.arrow.up.left"
            tone="secondary"
            size="compact"
            accessibilityHint="Summarizes the conversation so far to free up context"
            onPress={() => void compact()}
          />
        ) : null}
      </View>
      {breakdown.length > 0 ? (
        <View className="flex-row flex-wrap border-t border-border-subtle px-4 py-2">
          {breakdown.map((entry) => (
            <View
              key={entry.label}
              className="w-1/2 flex-row items-baseline justify-between gap-2 py-1 pr-4"
            >
              <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
                {entry.label}
              </Text>
              <Text textRole="footnote" className="font-t3-medium tabular-nums text-foreground">
                {formatContextWindowTokens(entry.value)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </LiveSection>
  );
}

const NO_SUBAGENTS: ReadonlyArray<OrchestrationV2Subagent> = [];
type ThreadDetail = typeof environmentThreadDetails.threadAtom extends (
  ...args: never[]
) => Atom.Atom<infer A>
  ? A
  : never;
const selectSubagents = (thread: ThreadDetail) => thread?.projection.subagents ?? NO_SUBAGENTS;
// A joined key, so streaming run updates don't re-render the list.
const selectRolledBackRunIds = (thread: ThreadDetail) =>
  thread?.projection.runs
    .filter((run) => run.status === "rolled_back")
    .map((run) => run.id)
    .join("\u0000") ?? "";

function AgentsSection(props: {
  readonly target: LiveDetailsTarget;
  readonly onOpenThread: OpenThread;
  readonly onLayout: Anchor;
}) {
  const { environmentId } = props.target;
  const threadAtom = environmentThreadDetails.threadAtom(props.target);
  const subagents = useAtomValue(threadAtom, selectSubagents);
  const rolledBack = useAtomValue(threadAtom, selectRolledBackRunIds);
  const shell = useThreadShell(props.target);
  const { seen, markSeen } = useSeenFailedAgents();
  const workflowGroups = useWorkflowGroups(subagents);
  const [previousOpen, setPreviousOpen] = useState(false);
  const [previousCount, setPreviousCount] = useState(PREVIOUS_AGENTS_PAGE);
  const { active, previous, unseenFailedKeys, counts } = partitionThreadAgents({
    subagents,
    environmentId,
    seenFailures: seen,
    rolledBackRunIds: new Set(rolledBack === "" ? [] : rolledBack.split("\u0000")),
  });
  const parentThreadId =
    shell?.forkedFrom?.type === "run" ? shell.forkedFrom.threadId : shell?.lineage.parentThreadId;
  if (!parentThreadId && active.length === 0 && previous.length === 0) return null;

  const isUnseenFailure = (subagent: OrchestrationV2Subagent) =>
    unseenFailedKeys.includes(seenFailureKey(environmentId, subagent));
  const onOpened = (subagent: OrchestrationV2Subagent) => {
    if (isUnseenFailure(subagent)) markSeen([seenFailureKey(environmentId, subagent)]);
  };
  const shownPrevious = previous.slice(0, previousCount);
  const hiddenPrevious = previous.length - shownPrevious.length;

  return (
    <LiveSection
      id="agents"
      title="Agents"
      onLayout={props.onLayout}
      summary={<StatusBadges running={counts.running} failed={counts.failed} done={counts.done} />}
      actions={<StatusBadges running={counts.running} />}
    >
      {parentThreadId ? (
        <ParentRow
          environmentId={environmentId}
          threadId={parentThreadId}
          label={
            shell?.lineage.relationshipToParent === "subagent" ? "Parent agent" : "Parent thread"
          }
          onOpen={props.onOpenThread}
        />
      ) : null}
      {active.length > 0 ? (
        <View className={parentThreadId ? "border-t border-border-subtle px-4" : "px-4"}>
          <ThreadAgentRows
            environmentId={environmentId}
            subagents={active}
            workflowGroups={workflowGroups}
            tickSeconds={active.length > 0}
            onOpenThread={props.onOpenThread}
            dividedBetween
          />
        </View>
      ) : null}
      {previous.length > 0 ? (
        <View
          className={
            parentThreadId || active.length > 0 ? "border-t border-border-subtle" : undefined
          }
        >
          <View className="min-h-12 flex-row items-center gap-3 px-4">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Previous agents, ${previous.length}`}
              accessibilityState={{ expanded: previousOpen }}
              onPress={() => setPreviousOpen((open) => !open)}
              className="min-h-12 min-w-0 flex-1 flex-row items-center gap-3 active:opacity-70"
            >
              <SymbolView name="robot" size={16} tintColorClassName="accent-icon-muted" />
              <Text textRole="body" className="min-w-0 flex-1 text-foreground" numberOfLines={1}>
                Previous agents
              </Text>
              {previousOpen ? null : (
                <Text textRole="footnote" className="tabular-nums text-foreground-muted">
                  {previous.length}
                </Text>
              )}
            </Pressable>
            {unseenFailedKeys.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Dismiss ${unseenFailedKeys.length} failed`}
                hitSlop={8}
                onPress={() => markSeen(unseenFailedKeys)}
                className="flex-row items-center gap-1 rounded-full bg-danger px-2 py-1 active:opacity-70"
              >
                <SymbolView
                  name="xmark"
                  size={10}
                  tintColorClassName="accent-danger-foreground"
                  type="monochrome"
                  weight="semibold"
                />
                <Text className="text-xs font-t3-medium tabular-nums text-danger-foreground">
                  {unseenFailedKeys.length} failed
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityElementsHidden
              importantForAccessibility="no"
              hitSlop={8}
              onPress={() => setPreviousOpen((open) => !open)}
            >
              <SymbolView
                name={previousOpen ? "chevron.down" : "chevron.right"}
                size={12}
                tintColorClassName="accent-icon-subtle"
              />
            </Pressable>
          </View>
          {previousOpen ? (
            <View className="border-t border-border-subtle px-4">
              <ThreadAgentRows
                environmentId={environmentId}
                subagents={shownPrevious}
                workflowGroups={workflowGroups}
                tickSeconds={false}
                onOpenThread={props.onOpenThread}
                isUnseenFailure={isUnseenFailure}
                onOpened={onOpened}
                dividedBetween
              />
              {hiddenPrevious > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setPreviousCount((count) => count + 12)}
                  className="min-h-11 flex-row items-center gap-2 border-t border-border-subtle active:opacity-70"
                >
                  <SymbolView name="plus" size={13} tintColorClassName="accent-icon-muted" />
                  <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
                    Show {Math.min(hiddenPrevious, 12)} more
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </LiveSection>
  );
}

function ParentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly onOpen: OpenThread;
}) {
  const parent = useThreadShellByRef(scopeThreadRef(props.environmentId, props.threadId));
  const title = parent?.title ?? props.label;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${props.label.toLowerCase()} ${title}`}
      onPress={() => props.onOpen({ environmentId: props.environmentId, threadId: props.threadId })}
      className="min-h-12 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
    >
      <SymbolView name="arrow.turn.left.up" size={16} tintColorClassName="accent-icon-muted" />
      <Text textRole="body" className="min-w-0 flex-1 text-foreground" numberOfLines={1}>
        {title}
      </Text>
      <Text textRole="footnote" className="text-foreground-muted">
        {props.label}
      </Text>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
    </Pressable>
  );
}

const EMPTY_COUNTS: ThreadDetailsStatusCounts = { running: 0, input: 0, failed: 0, done: 0 };

// Keyed by environment and side chat ids; counts change only when a chat changes bucket.
const sideChatCountsAtom = Atom.family((key: string) => {
  const [environmentId = "", ...threadIds] = key.split("\u0000");
  let previous = EMPTY_COUNTS;
  return Atom.make((get) => {
    const next = countThreadDetailsStatuses(
      threadIds.flatMap((threadId) => {
        const shell = get(
          environmentThreadShells.threadShellAtom(
            scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
          ),
        );
        return shell === null ? [] : [SIDE_CHAT_STATUS_BUCKETS[sideChatState(shell)]];
      }),
    );
    if (
      next.running !== previous.running ||
      next.input !== previous.input ||
      next.failed !== previous.failed ||
      next.done !== previous.done
    ) {
      previous = next;
    }
    return previous;
  }).pipe(Atom.withLabel(`mobile-thread-details-side-chat-counts:${key}`));
});

function SideChatsSection(props: {
  readonly target: LiveDetailsTarget;
  readonly onOpenThread: OpenThread;
  readonly onLayout: Anchor;
}) {
  const sideChats = useSideChats(scopeThreadRef(props.target.environmentId, props.target.threadId));
  const counts = useAtomValue(
    sideChatCountsAtom(
      [props.target.environmentId, ...sideChats.map((sideChat) => sideChat.id)].join("\u0000"),
    ),
  );
  if (sideChats.length === 0) return null;
  return (
    <LiveSection
      id="sideChats"
      title="Side chats"
      onLayout={props.onLayout}
      summary={
        <StatusBadges
          running={counts.running}
          input={counts.input}
          failed={counts.failed}
          done={counts.done}
        />
      }
      actions={<StatusBadges running={counts.running} input={counts.input} />}
    >
      {sideChats.map((sideChat, index) => (
        <SideChatRow
          key={sideChat.id}
          environmentId={props.target.environmentId}
          threadId={sideChat.id}
          first={index === 0}
          onOpen={props.onOpenThread}
        />
      ))}
    </LiveSection>
  );
}

const SIDE_CHAT_MARKS: Record<
  SideChatState,
  { readonly icon: "circle.fill" | "checkmark" | "xmark" | "circle"; readonly tint: string }
> = {
  approval: { icon: "circle.fill", tint: "accent-warning-foreground" },
  input: { icon: "circle.fill", tint: "accent-warning-foreground" },
  running: { icon: "circle.fill", tint: "accent-adaptive-blue-500-400" },
  failed: { icon: "xmark", tint: "accent-danger-foreground" },
  done: { icon: "checkmark", tint: "accent-foreground-muted" },
  idle: { icon: "circle", tint: "accent-icon-subtle" },
};

/** Each row reads its own shell, since the side chat list keeps its array through run changes. */
function SideChatRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly first: boolean;
  readonly onOpen: OpenThread;
}) {
  const shell = useAtomValue(
    environmentThreadShells.threadShellAtom(scopeThreadRef(props.environmentId, props.threadId)),
  );
  if (shell === null) return null;
  const state = sideChatState(shell);
  const mark = SIDE_CHAT_MARKS[state];
  const label = SIDE_CHAT_STATE_LABELS[state];
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open side chat ${shell.title}, ${label}`}
      onPress={() => props.onOpen({ environmentId: props.environmentId, threadId: shell.id })}
      className={
        props.first
          ? "min-h-12 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
          : "min-h-12 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
      }
    >
      <View className="size-5 items-center justify-center">
        <SymbolView
          name={mark.icon}
          size={mark.icon === "circle.fill" ? 9 : 14}
          tintColorClassName={mark.tint}
          type="monochrome"
        />
      </View>
      <Text textRole="body" className="min-w-0 flex-1 text-foreground" numberOfLines={1}>
        {shell.title}
      </Text>
      <Text
        textRole="footnote"
        className={
          state === "approval" || state === "input"
            ? "text-warning-foreground"
            : state === "failed"
              ? "text-danger-foreground"
              : "text-foreground-muted"
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

const STEP_ICONS = {
  completed: { name: "checkmark.circle.fill", tint: "accent-adaptive-emerald-600-400" },
  running: { name: "circle.inset.filled", tint: "accent-adaptive-blue-500-400" },
  pending: { name: "circle.dashed", tint: "accent-icon-subtle" },
} as const satisfies Record<
  OrchestrationV2PlanStep["status"],
  { readonly name: string; readonly tint: string }
>;

function ChecklistSection(props: {
  readonly target: LiveDetailsTarget;
  readonly onLayout: Anchor;
}) {
  const { environmentId, threadId } = props.target;
  const checklist = useThreadChecklist(scopeThreadRef(environmentId, threadId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const clearTodoList = useAtomCommand(threadEnvironment.clearTodoList, { reportFailure: false });
  const steps = checklist?.steps ?? [];
  if (checklist === null || steps.length === 0) return null;
  const progress = checklistProgressLabel(steps);
  const clear = async () => {
    const result = await clearTodoList({
      environmentId,
      input: { threadId, planId: checklist.id },
    });
    if (result._tag === "Failure") Dialog.alert("Could not clear the checklist", "Try again.");
  };
  return (
    <LiveSection
      id="checklist"
      title="Checklist"
      onLayout={props.onLayout}
      summary={progress}
      actions={
        <>
          <SummaryText>{progress}</SummaryText>
          {canOperate ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear checklist"
              hitSlop={8}
              onPress={() => void clear()}
              className="min-h-8 justify-center px-1 active:opacity-60"
            >
              <Text textRole="footnote" className="font-t3-medium text-primary-text">
                Clear
              </Text>
            </Pressable>
          ) : null}
        </>
      }
    >
      {steps.map((step, index) => (
        <View
          key={step.id}
          accessible
          accessibilityLabel={`${step.text}, ${step.status === "completed" ? "done" : step.status === "running" ? "in progress" : "pending"}`}
          className={[
            "flex-row items-start gap-3 px-4 py-3",
            index > 0 ? "border-t border-border-subtle" : "",
            step.status === "running" ? "bg-subtle" : "",
          ].join(" ")}
        >
          <View className="pt-0.5">
            <SymbolView
              name={STEP_ICONS[step.status].name}
              size={17}
              tintColorClassName={STEP_ICONS[step.status].tint}
              type="monochrome"
            />
          </View>
          <Text
            textRole="body"
            className={
              step.status === "completed"
                ? "min-w-0 flex-1 text-foreground-muted line-through"
                : step.status === "running"
                  ? "min-w-0 flex-1 text-foreground"
                  : "min-w-0 flex-1 text-foreground-muted"
            }
          >
            {step.text}
          </Text>
          {step.status === "completed" && step.durationMs !== undefined ? (
            <Text textRole="footnote" className="pt-0.5 tabular-nums text-foreground-muted">
              {formatDuration(step.durationMs)}
            </Text>
          ) : null}
        </View>
      ))}
    </LiveSection>
  );
}

function ProcessesSection(props: {
  readonly target: LiveDetailsTarget;
  readonly onOpenThread: OpenThread;
}) {
  const shell = useThreadShell(props.target);
  if (shell === null) return null;
  return (
    <ProcessesContent
      target={props.target}
      projectId={shell.projectId}
      pendingBackgroundTasks={shell.pendingBackgroundTasks}
      onOpenThread={props.onOpenThread}
    />
  );
}

/**
 * What runs for this thread: its terminals, terminals its agent opened, and the provider's
 * background work. Subagents are listed under Agents instead.
 */
function ProcessesContent(props: {
  readonly target: LiveDetailsTarget;
  readonly projectId: ProjectId;
  readonly pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly onOpenThread: OpenThread;
}) {
  const { environmentId, threadId } = props.target;
  const navigation = useNavigation();
  const { sessions } = useKnownTerminalSessions({ environmentId, threadId });
  const dock = useProjectTerminalDock(environmentId, props.projectId);
  const canWriteTerminal = useAtomValue(terminalEnvironment.write.permissionAtom(environmentId));
  const canKillAgentShell = useAtomValue(
    projectTerminalEnvironment.kill.permissionAtom(environmentId),
  );
  const canStopTask = useAtomValue(
    orchestrationEnvironment.stopBackgroundTask.permissionAtom(environmentId),
  );
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const killAgentShell = useAtomCommand(projectTerminalEnvironment.kill, { reportFailure: false });
  const stopTask = useAtomCommand(orchestrationEnvironment.stopBackgroundTask, {
    reportFailure: false,
  });
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const shells = (sessions ?? []).filter((session) => session.state.status !== "closed");
  const agentShells = dock.terminals.filter(
    (terminal) =>
      terminal.creatingThreadId === threadId &&
      (isProjectTerminalRunning(terminal.status) || terminal.status === "stopping"),
  );
  const backgroundWork = presentPendingBackgroundWork(
    props.pendingBackgroundTasks.filter((task) => task.kind !== "subagent"),
  );
  const backgroundItems: ReadonlyArray<PendingBackgroundWorkItem> = backgroundWork?.items ?? [];
  if (shells.length === 0 && agentShells.length === 0 && backgroundItems.length === 0) return null;
  const running =
    shells.filter((session) => session.state.hasRunningSubprocess).length +
    agentShells.length +
    backgroundItems.length;

  const runStop = async (id: string, failure: string, action: () => Promise<{ _tag: string }>) => {
    if (stoppingId !== null) return;
    setStoppingId(id);
    const result = await action().finally(() => setStoppingId(null));
    if (result._tag === "Failure") Dialog.alert(failure, "Try again.");
  };
  const routeIds = { environmentId: String(environmentId), threadId: String(threadId) };
  const divider = (first: boolean) => (first ? "" : "border-t border-border-subtle");

  return (
    <LiveSection
      id="processes"
      title="Processes"
      actions={running > 0 ? `${running} running` : undefined}
    >
      {shells.map((session, index) => {
        const summary = session.state.summary;
        const busy = session.state.hasRunningSubprocess;
        const terminalId = session.target.terminalId;
        const label = summary?.label || getTerminalLabel(terminalId);
        const status = busy
          ? "Running"
          : summary?.exitCode !== null && summary?.exitCode !== undefined
            ? `Exited ${summary.exitCode}`
            : null;
        return (
          <ProcessRow
            key={`terminal:${terminalId}`}
            className={divider(index === 0)}
            icon="terminal"
            live={busy}
            title={label}
            detail={["Terminal", status].filter(Boolean).join(" · ")}
            onOpen={() =>
              navigation.dispatch(
                StackActions.replace("ThreadTerminal", { ...routeIds, terminalId }),
              )
            }
            {...(busy && canWriteTerminal
              ? {
                  stopLabel: `Stop what runs in ${label}`,
                  stopping: stoppingId === `terminal:${terminalId}`,
                  onStop: () =>
                    void runStop(`terminal:${terminalId}`, "Could not stop the command", () =>
                      writeTerminal({
                        environmentId,
                        input: { threadId, terminalId, data: "\u0003" },
                      }),
                    ),
                }
              : {})}
          />
        );
      })}
      {agentShells.map((terminal, index) => {
        const label = terminal.label || terminal.terminalId;
        return (
          <ProcessRow
            key={`agent-shell:${terminal.terminalId}`}
            className={divider(shells.length === 0 && index === 0)}
            icon="terminal"
            live={isProjectTerminalRunning(terminal.status)}
            title={label}
            detail={["Agent Shell", projectTerminalStatusLabel(terminal)].join(" · ")}
            onOpen={() =>
              navigation.dispatch(
                StackActions.replace("ProjectTerminals", {
                  environmentId: String(environmentId),
                  projectId: String(props.projectId),
                  terminalId: terminal.terminalId,
                }),
              )
            }
            {...(canKillAgentShell && terminal.status !== "stopping"
              ? {
                  stopLabel: `Stop ${label}`,
                  stopping: stoppingId === `agent-shell:${terminal.terminalId}`,
                  onStop: () =>
                    void runStop(
                      `agent-shell:${terminal.terminalId}`,
                      "Could not stop the agent shell",
                      () =>
                        killAgentShell({
                          environmentId,
                          input: {
                            projectId: terminal.projectId,
                            terminalId: terminal.terminalId,
                            expectedGeneration: terminal.generation,
                          },
                        }),
                    ),
                }
              : {})}
          />
        );
      })}
      {backgroundItems.length > 0 ? (
        <View className={`px-4 ${divider(shells.length === 0 && agentShells.length === 0)}`}>
          {backgroundItems.map((item, index) => (
            <BackgroundWorkRow
              key={item.taskId}
              item={item}
              last={index === backgroundItems.length - 1}
              stopping={stoppingId === `task:${item.taskId}`}
              onStop={
                canStopTask
                  ? () =>
                      void runStop(`task:${item.taskId}`, "Could not stop the process", () =>
                        stopTask({ environmentId, input: { threadId, taskId: item.taskId } }),
                      )
                  : undefined
              }
              onOpen={(childThreadId) =>
                props.onOpenThread({ environmentId, threadId: childThreadId })
              }
            />
          ))}
        </View>
      ) : null}
    </LiveSection>
  );
}

function ProcessRow(props: {
  readonly className: string;
  readonly icon: "terminal";
  readonly live: boolean;
  readonly title: string;
  readonly detail: string;
  readonly onOpen: () => void;
  readonly stopLabel?: string;
  readonly stopping?: boolean;
  readonly onStop?: () => void;
}) {
  return (
    <View className={`min-h-12 flex-row items-center gap-3 pr-2 ${props.className}`}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open ${props.title}, ${props.detail}`}
        onPress={props.onOpen}
        className="min-h-12 min-w-0 flex-1 flex-row items-center gap-3 py-2.5 pl-4 active:opacity-70"
      >
        <View className="size-5 items-center justify-center">
          <SymbolView name={props.icon} size={15} tintColorClassName="accent-foreground-muted" />
          <View
            className={`absolute -right-0.5 -top-0.5 size-1.5 rounded-full ${props.live ? "bg-adaptive-emerald-600-400" : "bg-icon-subtle"}`}
          />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="font-t3-medium text-sm text-foreground" numberOfLines={1}>
            {props.title}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.detail}
          </Text>
        </View>
      </Pressable>
      {props.onStop ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.stopLabel}
          disabled={props.stopping}
          hitSlop={6}
          onPress={props.onStop}
          className="size-9 items-center justify-center rounded-full active:opacity-60"
        >
          <SymbolView
            name="stop.fill"
            size={13}
            tintColorClassName={props.stopping ? "accent-icon-subtle" : "accent-danger-foreground"}
            type="monochrome"
          />
        </Pressable>
      ) : (
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
      )}
    </View>
  );
}
