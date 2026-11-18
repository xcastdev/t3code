import { useAtomValue } from "@effect/atom-react";
import { assistantStatus } from "@t3tools/client-runtime/assistant-presentation";
import {
  agentChatTitle,
  agentListRows,
  NO_AGENT_FILTER,
} from "@t3tools/client-runtime/state/agents-list";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AssistantSummary, EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { memo, use, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { usePaneRole } from "../../components/ui/Pane";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import { useAllAgents } from "../assistants/useAssistants";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import {
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  selectedThreadRowColors,
} from "../threads/thread-list-v2-row-appearance";
import { useSidebarRowThreadKey } from "../threads/useSidebarRowThreadKey";
import { WorkAgentAvatar } from "../work/WorkAgentAvatar";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import { HomeScrollView } from "./HomeScreen";
import { ThreadListFilters } from "./ThreadListFilters";

const VISIBLE_CHATS = 3;
const AVATAR_SIZE = 36;
const AGENT_MENU_ACTIONS = [{ id: "details", title: "Agent details", image: "info.circle" }];

type AgentRow = ReturnType<typeof agentListRows<AssistantSummary, EnvironmentThreadShell>>[number];

/** The thread list's row colors, so agents and chats read like the rows around them. */
function rowAppearance(pane: "screen" | "sidebar", selected: boolean) {
  const sidebar = pane === "sidebar";
  return {
    className: cn(
      sidebar && "rounded-xl",
      selected ? "bg-thread-selected" : sidebar ? "bg-drawer" : "bg-screen",
    ),
    interactionClassName: sidebar ? "bg-thread-hover" : "bg-row-hover",
    interactionOpacity: selected ? 0 : 1,
    foregroundClassName: selected
      ? selectedThreadRowColors.foregroundClassName
      : sidebar
        ? "text-drawer-foreground"
        : "text-foreground",
    mutedForegroundClassName: selected
      ? selectedThreadRowColors.mutedForegroundClassName
      : sidebar
        ? "text-drawer-foreground-muted"
        : "text-foreground-muted",
    iconTintClassName: selected
      ? selectedThreadRowColors.mutedIconTintClassName
      : sidebar
        ? "accent-drawer-foreground-muted"
        : "accent-foreground-tertiary",
  };
}

/** The Agents tab: each agent's Home with its latest chats, pinned agents first. */
export function HomeAgentsList(props: {
  readonly environments: ReadonlyArray<
    HomeListFilterMenuEnvironment & Pick<WorkspaceEnvironment, "connectionState">
  >;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly searchQuery: string;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onOpenThread: (thread: {
    readonly environmentId: EnvironmentId;
    readonly threadId: string;
  }) => void;
  /** Opens the agent's Home chat. */
  readonly onOpenAgent: (agent: AssistantSummary) => void;
  readonly onOpenAgentDetails: (agent: AssistantSummary) => void;
  readonly onNewAgent: () => void;
}) {
  const primaryColumn = use(NativePrimaryColumnContext);
  const sidebarSurface = usePaneRole() === "sidebar" && primaryColumn !== null;
  const selectedThreadKey = useSidebarRowThreadKey(primaryColumn?.selectedThreadKey ?? null);
  const workspace = useWorkspaceTabs();
  const insets = useSafeAreaInsets();
  const contentTopInset = useContentTopInset();
  const { fabClearance } = useAndroidControlSizing();
  const { machineByEnvironmentId } = useAtomValue(threadListEnvironmentsAtom);
  const nowMs = useNowMinuteMs();

  const shown = props.environments.filter(
    (environment) =>
      props.selectedEnvironmentId === null ||
      environment.environmentId === props.selectedEnvironmentId,
  );
  const connected = new Set(
    shown
      .filter((environment) => environment.connectionState === "connected")
      .map((environment) => environment.environmentId),
  );
  const { agents } = useAllAgents(shown.map((environment) => environment.environmentId));
  // Offline rosters never answer, so only connected ones can still be loading.
  const { loading } = useAllAgents([...connected]);
  const { threads, searchQuery } = props;
  const rows = useMemo(
    () => agentListRows(agents, threads, { query: searchQuery, filter: NO_AGENT_FILTER }),
    [agents, threads, searchQuery],
  );
  const labelByEnvironment = new Map(
    props.environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const showEnvironment = props.environments.length > 1;
  const searching = searchQuery.trim().length > 0;

  const content =
    rows.length === 0 ? (
      loading && !searching ? (
        <View className="items-center py-10">
          <AppActivityIndicator colorClassName="accent-icon-muted" />
        </View>
      ) : (
        <View className="px-4">
          <EmptyState
            title={searching ? "No results" : "No agents yet"}
            detail={
              searching
                ? `No agents or chats matching "${searchQuery}".`
                : connected.size === 0
                  ? "Connect an environment to see its agents."
                  : "An agent keeps its own chat, memory and routines."
            }
            variant={Platform.OS === "android" ? "plain" : undefined}
          />
        </View>
      )
    ) : (
      rows.map((row, index) => (
        <HomeAgentRow
          key={`${row.agent.environmentId}:${row.agent.assistantId}`}
          row={row}
          pane={sidebarSurface ? "sidebar" : "screen"}
          connected={connected.has(row.agent.environmentId)}
          environmentLabel={
            showEnvironment ? (labelByEnvironment.get(row.agent.environmentId) ?? null) : null
          }
          environmentMachine={machineByEnvironmentId.get(row.agent.environmentId)}
          selectedThreadKey={selectedThreadKey}
          nowMs={nowMs}
          showTrailingDivider={index < rows.length - 1}
          onOpenThread={props.onOpenThread}
          onOpenAgent={props.onOpenAgent}
          onOpenAgentDetails={props.onOpenAgentDetails}
        />
      ))
    );

  const scrollProps = {
    style: { flex: 1 },
    automaticallyAdjustsScrollIndicatorInsets: Platform.OS === "ios",
    contentInsetAdjustmentBehavior: "never" as const,
    contentInset: Platform.OS === "ios" ? { top: contentTopInset } : undefined,
    contentOffset: Platform.OS === "ios" ? { x: 0, y: -contentTopInset } : undefined,
    showsVerticalScrollIndicator: false,
    keyboardDismissMode: "on-drag" as const,
    keyboardShouldPersistTaps: "handled" as const,
    contentContainerStyle: {
      paddingLeft: sidebarSurface ? 8 : 0,
      paddingRight: sidebarSurface ? 8 : 0,
      paddingTop: Platform.OS === "ios" ? 0 : 16,
      paddingBottom:
        Platform.OS === "ios"
          ? Math.max(insets.bottom, 24, workspace?.bottomClearance ?? 0)
          : (workspace?.bottomClearance ?? Math.max(insets.bottom, 16) + fabClearance),
    },
    children: (
      <>
        {Platform.OS === "ios" && workspace ? (
          <ThreadListFilters
            gutter={sidebarSurface ? 8 : 0}
            environments={props.environments}
            selectedEnvironmentId={props.selectedEnvironmentId}
            onEnvironmentChange={props.onEnvironmentChange}
          />
        ) : null}
        {content}
        <NewAgentRow pane={sidebarSurface ? "sidebar" : "screen"} onPress={props.onNewAgent} />
      </>
    ),
  };

  return (
    <View
      className={cn(
        "flex-1",
        Platform.OS === "android" ? "bg-header" : sidebarSurface ? "bg-drawer" : "bg-screen",
      )}
    >
      <ScreenContent surface="screen">
        {Platform.OS === "ios" ? (
          <HomeScrollView {...scrollProps} />
        ) : (
          <ScrollView {...scrollProps} />
        )}
      </ScreenContent>
    </View>
  );
}

const HomeAgentRow = memo(function HomeAgentRow(props: {
  readonly row: AgentRow;
  readonly pane: "screen" | "sidebar";
  readonly connected: boolean;
  readonly environmentLabel: string | null;
  readonly environmentMachine: EnvironmentMachineKind | undefined;
  readonly selectedThreadKey: string | null;
  readonly nowMs: number;
  readonly showTrailingDivider: boolean;
  readonly onOpenThread: (thread: {
    readonly environmentId: EnvironmentId;
    readonly threadId: string;
  }) => void;
  readonly onOpenAgent: (agent: AssistantSummary) => void;
  readonly onOpenAgentDetails: (agent: AssistantSummary) => void;
}) {
  const { agent, chats } = props.row;
  const [showAll, setShowAll] = useState(false);
  const sidebarPane = props.pane === "sidebar";
  const homeThreadId = agent.binding.canonicalThreadId;
  const selected = props.selectedThreadKey === scopedThreadKey(agent.environmentId, homeThreadId);
  const appearance = rowAppearance(props.pane, selected);
  const status = assistantStatus({ connected: props.connected, summary: agent });
  const lifecycleNote =
    agent.lifecycle === "active"
      ? null
      : agent.lifecycle.charAt(0).toUpperCase() + agent.lifecycle.slice(1);
  // Idle is just "no work"; the time since the last activity says more.
  const workStatus = status.label !== "Idle" && status.label !== lifecycleNote;
  // An agent still being set up has no chat yet; its page shows the progress.
  const ready = agent.provisioningState === "ready";
  const visibleChats = ready ? (showAll ? chats : chats.slice(0, VISIBLE_CHATS)) : [];
  const hiddenChats = ready ? chats.length - visibleChats.length : 0;
  const subtitle = [
    props.environmentLabel,
    lifecycleNote,
    chats.length > 0 ? `${chats.length} ${chats.length === 1 ? "chat" : "chats"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const foreground = appearance.foregroundClassName;
  const muted = appearance.mutedForegroundClassName;
  const statusClassName =
    status.tone === "warning"
      ? "text-adaptive-amber-700-300"
      : status.tone === "danger"
        ? "text-danger-foreground"
        : muted;

  return (
    <View>
      <Menu
        actions={AGENT_MENU_ACTIONS}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "details") props.onOpenAgentDetails(agent);
        }}
        shouldOpenOnLongPress
      >
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel={[agent.name, workStatus ? status.label : null, subtitle]
            .filter(Boolean)
            .join(", ")}
          accessibilityHint={
            ready ? "Opens the agent's chat. Long press for agent details." : "Opens the agent."
          }
          accessibilityState={{ selected }}
          accessibilityActions={[{ name: "details", label: "Agent details" }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "details") props.onOpenAgentDetails(agent);
          }}
          className={appearance.className}
          interactionClassName={appearance.interactionClassName}
          interactionOpacity={appearance.interactionOpacity}
          onPress={() => props.onOpenAgent(agent)}
        >
          <View
            className={cn(THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME, "flex-row items-center gap-3")}
          >
            <WorkAgentAvatar name={agent.name} avatar={agent.avatar} size={AVATAR_SIZE} />
            <View className="min-w-0 flex-1 gap-0.5">
              <View className="flex-row items-baseline gap-2">
                <Text
                  className={cn("flex-1 text-base font-t3-medium", foreground)}
                  numberOfLines={1}
                >
                  {agent.name}
                </Text>
                <Text className={cn("text-xs", workStatus ? statusClassName : muted)}>
                  {workStatus ? status.label : relativeTime(props.row.lastActivityAt, props.nowMs)}
                </Text>
              </View>
              {subtitle ? (
                <View className="flex-row items-center gap-1">
                  {props.environmentLabel && props.environmentMachine ? (
                    <EnvironmentMachineSymbol
                      kind={props.environmentMachine}
                      size={12}
                      tintColorClassName={appearance.iconTintClassName}
                    />
                  ) : null}
                  <Text className={cn("shrink text-xs", muted)} numberOfLines={1}>
                    {subtitle}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        </RowPressable>
      </Menu>
      {visibleChats.map((chat) => (
        <HomeAgentChatRow
          key={chat.id}
          chat={chat}
          pane={props.pane}
          selected={props.selectedThreadKey === scopedThreadKey(chat.environmentId, chat.id)}
          nowMs={props.nowMs}
          onPress={() =>
            props.onOpenThread({ environmentId: chat.environmentId, threadId: chat.id })
          }
        />
      ))}
      {hiddenChats > 0 || (showAll && chats.length > VISIBLE_CHATS) ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowAll(!showAll)}
          className="py-2"
          style={({ pressed }) => ({
            paddingLeft: 20 + AVATAR_SIZE + 12,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text className={cn("text-xs font-t3-medium", appearance.mutedForegroundClassName)}>
            {showAll ? "Show fewer" : `Show ${hiddenChats} more`}
          </Text>
        </Pressable>
      ) : null}
      {!sidebarPane && THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider ? (
        <View className="ml-5 h-px bg-border-subtle" />
      ) : null}
    </View>
  );
});

function HomeAgentChatRow(props: {
  readonly chat: EnvironmentThreadShell;
  readonly pane: "screen" | "sidebar";
  readonly selected: boolean;
  readonly nowMs: number;
  readonly onPress: () => void;
}) {
  const appearance = rowAppearance(props.pane, props.selected);
  const title = agentChatTitle(props.chat.title);
  const working = threadRuntimeIsActive(props.chat.runtime);
  const needsYou = props.chat.hasPendingApprovals || props.chat.hasPendingUserInput;
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[title, working ? "Working" : needsYou ? "Needs you" : null]
        .filter(Boolean)
        .join(", ")}
      accessibilityState={{ selected: props.selected }}
      className={appearance.className}
      interactionClassName={appearance.interactionClassName}
      interactionOpacity={appearance.interactionOpacity}
      onPress={props.onPress}
    >
      <View
        className="flex-row items-center gap-2 py-2 pr-5"
        style={{ paddingLeft: 20 + AVATAR_SIZE + 12 }}
      >
        <SymbolView
          name="bubble.left"
          size={13}
          tintColorClassName={appearance.iconTintClassName}
          type="monochrome"
        />
        <Text className={cn("flex-1 text-sm", appearance.foregroundClassName)} numberOfLines={1}>
          {title}
        </Text>
        {working ? (
          <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
        ) : needsYou ? (
          <Text className="text-xs font-t3-medium text-adaptive-amber-700-300">Needs you</Text>
        ) : (
          <Text className={cn("text-xs", appearance.mutedForegroundClassName)}>
            {relativeTime(props.chat.updatedAt, props.nowMs)}
          </Text>
        )}
      </View>
    </RowPressable>
  );
}

function NewAgentRow(props: { readonly pane: "screen" | "sidebar"; readonly onPress: () => void }) {
  const appearance = rowAppearance(props.pane, false);
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel="New agent"
      className={cn(appearance.className, "mt-2")}
      interactionClassName={appearance.interactionClassName}
      onPress={props.onPress}
    >
      <View className={cn(THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME, "flex-row items-center gap-3")}>
        <View
          className="items-center justify-center"
          style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
        >
          <SymbolView
            name="plus"
            size={18}
            tintColorClassName="accent-primary-text"
            type="monochrome"
            weight="semibold"
          />
        </View>
        <Text className="text-base font-t3-medium text-primary-text">New agent</Text>
      </View>
    </RowPressable>
  );
}
