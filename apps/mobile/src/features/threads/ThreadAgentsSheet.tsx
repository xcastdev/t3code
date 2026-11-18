import { useAtomValue } from "@effect/atom-react";
import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SheetHeader } from "../../components/ui/SheetHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { environmentThreadDetails } from "../../state/threads";
import { useEnvironments } from "../../state/environments";
import { SubagentRow } from "./SubagentRow";
import { TURN_WORK_RETENTION_LABELS, deriveTurnAgentWork } from "./threadAgentsPresentation";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { SubagentStopButton } from "./SubagentStopButton";
import { ThreadWorkflowGroup } from "./ThreadWorkflowGroup";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { subagentThreadTarget } from "./threadAgentsPresentation";

import { useOpenThreadInspector } from "./thread-inspector-navigation";

type AgentsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const EMPTY_TURN_SUBAGENTS_ATOM = Atom.make<ThreadTurnSubagents | null>(null).pipe(
  Atom.withLabel("mobile-thread-turn-subagents:empty"),
);

export function useThreadTurnSubagents(target: AgentsTarget | null): ThreadTurnSubagents | null {
  return useAtomValue(
    target === null
      ? EMPTY_TURN_SUBAGENTS_ATOM
      : environmentThreadDetails.turnSubagentsAtom(target),
  );
}

export function ThreadAgentsSheet({ route }: StaticScreenProps<AgentsTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const openThread = useOpenThreadFromSheet(target);
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title="Agents" onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          className="flex-1"
          // UIKit must inset content beneath the floating translucent iOS header.
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pb-6"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          <ThreadAgentsList target={target} onOpenThread={openThread} />
        </ScrollView>
      </ScreenContent>
    </View>
  );
}

/**
 * Opens another thread from a sheet over the thread: in the inspector where there is one, else
 * replacing this leaf sheet so the thread enters the workspace stack Home's Back button expects.
 */
export function useOpenThreadFromSheet(target: AgentsTarget) {
  const navigation = useNavigation();
  const openInspector = useOpenThreadInspector();
  return (child: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }) => {
    void Haptics.selectionAsync();
    if (
      openInspector(target, {
        type: "thread",
        environmentId: child.environmentId,
        threadId: child.threadId,
      })
    )
      return;
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: child.environmentId,
        threadId: child.threadId,
      }),
    );
  };
}

/** The turn's agents with their stop buttons; empty when the turn has none. */
export function ThreadAgentsList(props: {
  readonly target: AgentsTarget;
  readonly onOpenThread: (child: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => void;
}) {
  const { target, onOpenThread } = props;
  const turn = useThreadTurnSubagents(target);
  const subagents = turn?.subagents ?? [];
  const hasLiveAgent = (turn?.liveCount ?? 0) > 0;
  // Same thread detail the agents come from; nothing new is subscribed or paged in.
  const thread = useAtomValue(environmentThreadDetails.threadAtom(target));
  const history = useAtomValue(environmentThreadDetails.historyAtom(target));
  const work = deriveTurnAgentWork({
    runId: turn?.runId ?? null,
    projection: thread?.projection ?? null,
    history,
  });
  const workflowGroups = useWorkflowGroups(subagents);

  return (
    <>
      {work ? (
        <Text className="pt-3 text-xs text-foreground-muted">
          This turn: {work.messageCount} messages · {work.commandCount} commands ·{" "}
          {work.toolCallCount} tool calls · {work.subagentCount} agents ·{" "}
          {TURN_WORK_RETENTION_LABELS[work.retention]}
        </Text>
      ) : null}
      {subagents.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No agents in this turn.
        </Text>
      ) : (
        <ThreadAgentRows
          environmentId={target.environmentId}
          subagents={subagents}
          workflowGroups={workflowGroups}
          tickSeconds={hasLiveAgent}
          onOpenThread={onOpenThread}
        />
      )}
    </>
  );
}

export function useWorkflowGroups(subagents: ReadonlyArray<OrchestrationV2Subagent>) {
  return useMemo(
    () =>
      new Map(
        deriveWorkflowGroups(projectedSubagentsToRuntime(subagents)).map((group) => [
          group.workflow.id,
          group,
        ]),
      ),
    [subagents],
  );
}

/** Agent rows with their stop buttons; a workflow's agent shows its phases instead. */
export function ThreadAgentRows(props: {
  readonly environmentId: EnvironmentId;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly workflowGroups: ReturnType<typeof useWorkflowGroups>;
  readonly tickSeconds: boolean;
  readonly onOpenThread: OpenAgentThread;
  /** Failures not yet seen show their elapsed time in red. */
  readonly isUnseenFailure?: (subagent: OrchestrationV2Subagent) => boolean;
  readonly onOpened?: (subagent: OrchestrationV2Subagent) => void;
  /** Rule between rows instead of under each, for rows inside a grouped card. */
  readonly dividedBetween?: boolean;
}) {
  const { environmentId, onOpenThread } = props;
  return props.subagents.map((subagent, index) => {
    const group = props.workflowGroups.get(subagent.id);
    const open: OpenAgentThread = (child) => {
      props.onOpened?.(subagent);
      onOpenThread(child);
    };
    return group === undefined ? (
      <View
        key={subagent.id}
        className={
          !props.dividedBetween
            ? "border-b border-border"
            : index === 0
              ? undefined
              : "border-t border-border-subtle"
        }
      >
        <AgentRow
          subagent={subagent}
          environmentId={environmentId}
          tickSeconds={props.tickSeconds}
          failed={props.isUnseenFailure?.(subagent) ?? false}
          onOpen={open}
        />
      </View>
    ) : (
      <ThreadWorkflowGroup
        key={subagent.id}
        environmentId={environmentId}
        subagent={subagent}
        group={group}
        onOpen={(threadId) => open({ environmentId, threadId })}
      />
    );
  });
}

type OpenAgentThread = (child: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) => void;

function AgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
  readonly failed: boolean;
  readonly onOpen: OpenAgentThread;
}) {
  const { subagent } = props;
  const { presentationById } = useEnvironments();
  const target = subagentThreadTarget(subagent, props.environmentId, (id) =>
    presentationById.has(id),
  );

  const row = (
    <View className="py-3.5">
      <SubagentRow
        environmentId={props.environmentId}
        subagent={subagent}
        canOpenRemote={target !== null}
        elapsed={
          <AgentElapsed subagent={subagent} tickSeconds={props.tickSeconds} failed={props.failed} />
        }
      />
    </View>
  );

  const content =
    target === null ? (
      <View
        accessible
        className="min-w-0 flex-1"
        accessibilityHint={
          subagent.remoteChild === undefined
            ? "Provider-managed agent. Its work appears in the transcript."
            : `Runs on ${subagent.remoteChild.label}. Connect to it to open its thread.`
        }
      >
        {row}
      </View>
    ) : (
      <Pressable
        accessibilityRole="link"
        accessibilityHint="Opens this agent's thread"
        onPress={() => props.onOpen(target)}
        className="min-w-0 flex-1 active:opacity-70"
      >
        {row}
      </Pressable>
    );

  return (
    <View className="flex-row items-center">
      {content}
      <SubagentStopButton environmentId={props.environmentId} subagent={subagent} />
    </View>
  );
}

function AgentElapsed(props: {
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
  readonly failed: boolean;
}) {
  const elapsed = useSubagentElapsed(props.subagent, props.tickSeconds);
  return elapsed === null ? null : (
    <Text
      accessibilityLabel={props.failed ? `Failed, ${elapsed}` : undefined}
      className={
        props.failed
          ? "shrink-0 text-xs tabular-nums text-danger-foreground"
          : "shrink-0 text-xs tabular-nums text-foreground-muted"
      }
    >
      {elapsed}
    </Text>
  );
}

function useSubagentElapsed(
  subagent: Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">,
  tickSeconds: boolean,
): string | null {
  const running = isOrchestrationV2WorkActive(subagent.status);
  const nowMs = useVisibleSecondClock(tickSeconds && running);
  const elapsedMs = deriveSubagentElapsedMs(
    {
      status: subagent.status,
      startedAt: subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt),
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
    },
    nowMs,
  );
  return elapsedMs === null || elapsedMs === 0 ? null : formatDuration(elapsedMs);
}
