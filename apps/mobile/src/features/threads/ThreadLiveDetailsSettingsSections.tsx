import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { resolveMergeBackTargetThreadId } from "@t3tools/client-runtime/state/thread-relationships";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import { StackActions, useNavigation } from "@react-navigation/native";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import { resolveChangesTotals } from "@t3tools/client-runtime/state/changes-totals";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import { shortPlanLabel, usageSummaryWindows } from "@t3tools/client-runtime/state/thread-details";
import type { ScheduledTask } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  findThreadLimitAccount,
  formatDuration,
  remainingPercent,
  resolveUsageLimitDriver,
  type LimitAccount,
} from "@t3tools/shared/usageLimits";
import type { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";
import { Pressable, View, type LayoutChangeEvent } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useNowMinuteMs } from "../../lib/clock";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentThreadDetails } from "../../state/threads";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useVcsActionState } from "../../state/use-vcs-action-state";
import { useThreadSelection } from "../../state/use-thread-selection";
import { vcsEnvironment } from "../../state/vcs";
import { openSettings } from "../settings/settings-navigation";
import {
  describeSchedule,
  formatNextScheduledTaskRun,
} from "../settings/scheduledTaskPresentation";
import { AccountLimits, useBarColor } from "../usage/UsageLimitsSection";
import { environmentIdsKey, limitsAutoRefreshSetAtom } from "../usage/usageLimitsRefresh";
import {
  LinkedPullRequestRow,
  linkedPullRequestKey,
  useLinkedPullRequestLines,
} from "./LinkedPullRequestList";
import { LiveSection, SummaryRing, SummaryText } from "./ThreadLiveDetailsSection";
import { threadAutomations, usageAccountsToShow } from "./threadLiveDetails.logic";
import { useThreadGitPanelItems } from "./ThreadGitControls";
import { useLinkedPullRequestActions } from "./useLinkedPullRequestActions";
import { useThreadMergeBack } from "./use-thread-merge-back";
import {
  useThreadMcpServers,
  useThreadShell,
  type LiveDetailsTarget,
} from "./use-thread-live-details";

type ThreadDetail = typeof environmentThreadDetails.threadAtom extends (
  ...args: never[]
) => Atom.Atom<infer A>
  ? A
  : never;

/** The thread provider's plan limits; the environment's other accounts behind a toggle. */
export function ThreadUsageSection(props: {
  readonly target: LiveDetailsTarget;
  readonly onLayout: ((event: LayoutChangeEvent) => void) | undefined;
}) {
  const { environmentId } = props.target;
  const shell = useThreadShell(props.target);
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const now = useNowMinuteMs();
  const [showAll, setShowAll] = useState(false);
  const accounts = useMemo(
    () =>
      serverConfig === null
        ? []
        : collectLimitAccounts(
            new Map([
              [
                environmentId,
                {
                  entry: { target: { label: "" } },
                  serverConfig: {
                    providers: serverConfig.providers,
                    usageLimitSources: serverConfig.usageLimitSources,
                  },
                },
              ],
            ]),
          ).filter((account) => account.limits.windows.length > 0),
    [environmentId, serverConfig],
  );
  // Limits arrive on demand on mobile, so the section asks for them as the Usage screen does.
  useAtomMount(limitsAutoRefreshSetAtom(environmentIdsKey([environmentId])));
  if (serverConfig === null) return null;
  if (accounts.length === 0) {
    return (
      <LiveSection id="usage" title="Usage" onLayout={props.onLayout}>
        <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
          No provider here reports plan limits.
        </Text>
      </LiveSection>
    );
  }
  const instanceId = shell?.modelSelection.instanceId ?? null;
  const threadAccount = findThreadLimitAccount(accounts, {
    environmentId,
    instanceId,
    driver: resolveUsageLimitDriver({
      provider: serverConfig.providers.find((provider) => provider.instanceId === instanceId),
      mapping:
        instanceId === null ? undefined : serverConfig.settings.usageLimitMappings[instanceId],
    }),
  });
  const { shown, hiddenCount } = usageAccountsToShow({ accounts, threadAccount, showAll });
  const canToggle = threadAccount !== null && (showAll || hiddenCount > 0);
  return (
    <LiveSection
      id="usage"
      title="Usage"
      onLayout={props.onLayout}
      summary={threadAccount ? <UsageSummary account={threadAccount} now={now} /> : undefined}
    >
      {shown.map((account, index) => {
        const driverLabel = providerClients.get(account.driver)?.label ?? String(account.driver);
        return (
          <AccountLimits
            key={account.key}
            dense
            first={index === 0}
            driver={account.driver}
            accentColor={account.accentColor}
            label={driverLabel}
            instanceLabel={account.displayName ?? driverLabel}
            detail={
              account.plan ? (shortPlanLabel(account.plan, driverLabel) ?? undefined) : undefined
            }
            limits={account.limits}
            now={now}
          />
        );
      })}
      {canToggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showAll }}
          onPress={() => setShowAll((current) => !current)}
          className="min-h-11 justify-center border-t border-border-subtle px-4 active:opacity-70"
        >
          <Text textRole="footnote" className="font-t3-medium text-primary-text">
            {showAll ? "Show less" : `Show ${hiddenCount} more`}
          </Text>
        </Pressable>
      ) : null}
    </LiveSection>
  );
}

/** The two windows closest to running out, each with when it resets. */
function UsageSummary(props: { readonly account: LimitAccount; readonly now: number }) {
  const { account } = props;
  const providerColor = useBarColor(account.driver);
  const color = normalizeProviderAccentColor(account.accentColor) ?? providerColor;
  const windows = usageSummaryWindows(account.limits.windows);
  if (windows.length === 0) return null;
  const driverLabel = providerClients.get(account.driver)?.label ?? String(account.driver);
  return (
    <View className="flex-row items-center gap-2">
      <ProviderIcon provider={account.driver} size={14} />
      {windows.map((window) => {
        const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
        const remaining = remainingPercent(window);
        return (
          <View key={window.id} className="flex-row items-center gap-1">
            <SummaryRing
              percent={remaining}
              color={color}
              label={`${driverLabel} ${window.label}: ${remaining}% left`}
            />
            {Number.isFinite(resetsAt) ? (
              <SummaryText>{formatDuration(resetsAt - props.now)}</SummaryText>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const MCP_SCOPE_LABELS = {
  global: "Environment",
  project: "Project",
  session: "This thread",
} as const;

export function ThreadMcpSection(props: { readonly target: LiveDetailsTarget }) {
  const shell = useThreadShell(props.target);
  const mcp = useThreadMcpServers(props.target, shell?.projectId ?? null);
  if (mcp.rows === null) return null;
  const enabledCount = mcp.rows.filter((row) => row.enabled).length;
  return (
    <LiveSection
      id="mcp"
      title="MCP servers"
      // T3 Code's own server is injected into every session; the catalog doesn't list it.
      actions={`${enabledCount + 1} of ${mcp.rows.length + 1} on`}
      footer={
        mcp.rows.length > 0 && !mcp.hasSession
          ? "Servers can be switched for this thread once it has run."
          : mcp.delivery && (mcp.delivery.tone === "warning" || mcp.delivery.tone === "error")
            ? mcp.delivery.label
            : undefined
      }
    >
      <ListToggleRow
        icon="cable.connector"
        label="T3 Code"
        description="Built in"
        value
        disabled
        onValueChange={() => undefined}
      />
      {mcp.rows.map((row) => (
        <View key={row.definition.definitionId} className="border-t border-border-subtle">
          <ListToggleRow
            icon="cable.connector"
            label={row.name}
            description={`${MCP_SCOPE_LABELS[row.definition.scope]}${
              row.override?.enabled !== undefined ? " · changed for this thread" : ""
            }`}
            value={row.enabled}
            disabled={!mcp.writable || mcp.busy}
            onValueChange={() => void mcp.toggle(row)}
          />
        </View>
      ))}
    </LiveSection>
  );
}

const RUN_STATUS_DOT: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-icon-subtle",
  running: "bg-adaptive-blue-500-400",
  succeeded: "bg-adaptive-emerald-600-400",
  failed: "bg-danger-foreground",
};

/** Scheduled tasks bound to this thread, each with Run now and its on/off switch. */
export function ThreadAutomationsSection(props: { readonly target: LiveDetailsTarget }) {
  const { environmentId, threadId } = props.target;
  const navigation = useNavigation();
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const canOperate = useAtomValue(
    serverEnvironment.setScheduledTaskEnabled.permissionAtom(environmentId),
  );
  const canRun = useAtomValue(serverEnvironment.runScheduledTaskNow.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, { reportFailure: false });
  const now = useNowMinuteMs();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const bound = useMemo(
    () => threadAutomations(tasks.data?.tasks ?? [], threadId),
    [tasks.data, threadId],
  );
  if (bound.length === 0) return null;

  const toggle = async (task: ScheduledTask, enabled: boolean) => {
    if (busyTaskId !== null || !canOperate) return;
    setBusyTaskId(task.id);
    const result = await setEnabled({ environmentId, input: { id: task.id, enabled } }).finally(
      () => setBusyTaskId(null),
    );
    if (result._tag === "Failure") Dialog.alert("Could not update automation", "Try again.");
  };
  const run = async (task: ScheduledTask) => {
    if (busyTaskId !== null || !canRun) return;
    setBusyTaskId(task.id);
    const result = await runNow({ environmentId, input: { id: task.id } }).finally(() =>
      setBusyTaskId(null),
    );
    if (result._tag === "Failure") Dialog.alert("Could not run automation", "Try again.");
  };
  const onCount = bound.filter((task) => task.enabled).length;

  return (
    <LiveSection
      id="automations"
      title="Automations"
      summary={`${onCount} of ${bound.length} on`}
      actions={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Manage scheduled tasks"
          hitSlop={8}
          onPress={() => openSettings(navigation, "SettingsScheduledTasks")}
          className="size-8 items-center justify-center active:opacity-60"
        >
          <SymbolView
            name="gearshape"
            size={15}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      }
    >
      {bound.map((task, index) => {
        const schedule = `${describeSchedule(task, tasks.data?.timeZone)}${
          task.blockedByPolicy !== undefined
            ? ` · ${task.blockedByPolicy}`
            : !task.enabled
              ? " · Paused"
              : task.nextRunAt
                ? ` · ${formatNextScheduledTaskRun(task.nextRunAt, now)}`
                : ""
        }`;
        return (
          <View
            key={task.id}
            className={
              index === 0
                ? "min-h-14 flex-row items-center gap-3 px-4 py-3"
                : "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
            }
          >
            <View className="size-6 items-center justify-center">
              <SymbolView
                name="calendar.badge.clock"
                size={20}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
              <View
                className={`absolute -right-0.5 -top-0.5 size-2 rounded-full ${RUN_STATUS_DOT[task.lastRunStatus]}`}
              />
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
              <Text textRole="body" className="text-foreground" numberOfLines={1}>
                {task.title}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted" numberOfLines={2}>
                {schedule}
              </Text>
            </View>
            {/* Webhook tasks need a request from their URL. */}
            {task.schedule.type === "webhook" ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Run ${task.title} now`}
                disabled={!canRun || busyTaskId !== null || task.lastRunStatus === "running"}
                hitSlop={6}
                onPress={() => void run(task)}
                className="size-9 items-center justify-center rounded-full active:opacity-60 disabled:opacity-40"
              >
                <SymbolView
                  name="play"
                  size={15}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
              </Pressable>
            )}
            <ThemedSwitch
              accessibilityLabel={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
              disabled={!canOperate || busyTaskId !== null}
              value={task.enabled}
              onValueChange={(enabled) => void toggle(task, enabled)}
            />
          </View>
        );
      })}
    </LiveSection>
  );
}

const NO_ROW = null;
const selectMergeBackTarget = (thread: ThreadDetail) =>
  thread === null ? NO_ROW : resolveMergeBackTargetThreadId(thread.projection);
const selectMergeBackRunId = (thread: ThreadDetail) =>
  thread === null ? NO_ROW : (resolveLatestMergeBackRun(thread.projection)?.id ?? NO_ROW);

/**
 * Web's Version Control content (branch, linked pull requests, changes) plus the tools panel's
 * Source control actions. Shown whenever the thread has a working directory.
 */
export function ThreadSourceControlSection(props: {
  readonly target: LiveDetailsTarget;
  readonly onOpenThread: (thread: LiveDetailsTarget) => void;
}) {
  const navigation = useNavigation();
  const { environmentId, threadId } = props.target;
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const status = useEnvironmentQuery(
    selectedThreadCwd === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd: selectedThreadCwd } }),
  );
  const gitActions = useSelectedThreadGitActions();
  const operation = useVcsActionState({ environmentId, cwd: selectedThreadCwd });
  const threadAtom = environmentThreadDetails.threadAtom(props.target);
  const onMergeBack = useThreadMergeBack({
    environmentId,
    threadId,
    targetThreadId: useAtomValue(threadAtom, selectMergeBackTarget),
    runId: useAtomValue(threadAtom, selectMergeBackRunId),
    onMerged: props.onOpenThread,
  });
  const gitItems = useThreadGitPanelItems({
    environmentId,
    threadId,
    currentBranch: selectedThread?.branch ?? null,
    gitStatus: status.data,
    gitOperationLabel: operation.currentLabel,
    ...(onMergeBack ? { onMergeBack } : {}),
    onPull: gitActions.onPullSelectedThreadBranch,
    onRunAction: gitActions.onRunSelectedThreadGitAction,
    replaceOnNavigate: true,
  });
  const lines = useLinkedPullRequestLines(selectedThread, selectedEnvironmentRuntime);
  const openPullRequest = useOpenPullRequest({
    replace: true,
    context: selectedThread ?? undefined,
  });
  const actions = useLinkedPullRequestActions({
    thread: selectedThread,
    project: selectedThreadProject,
    runtime: selectedEnvironmentRuntime,
  });
  if (selectedThreadCwd === null && lines.length === 0) return null;
  const data = status.data;
  const isRepo = data?.isRepo === true;
  const totals = isRepo ? resolveChangesTotals(data) : null;
  const hasChanges = totals !== null && (totals.insertions > 0 || totals.deletions > 0);
  const branch = (isRepo ? data.refName : null) ?? selectedThread?.branch ?? null;
  const [statusItem, ...actionItems] = gitItems;
  // The Changes row opens the same review, with the line counts web shows.
  const rows = actionItems.filter(
    (item): item is Extract<AppBarMenuItem, { onPress: () => void }> =>
      "onPress" in item && !(totals !== null && item.id === "git-review"),
  );

  return (
    <LiveSection
      id="versionControl"
      title="Source control"
      summary={
        data !== null && !isRepo ? (
          "Not a repo"
        ) : hasChanges || branch ? (
          <View className="min-w-0 shrink flex-row items-center gap-1.5">
            {hasChanges ? (
              <DiffCounts insertions={totals.insertions} deletions={totals.deletions} />
            ) : null}
            {branch ? (
              <>
                <SymbolView
                  name="arrow.triangle.branch"
                  size={12}
                  tintColorClassName="accent-foreground-muted"
                  type="monochrome"
                />
                <SummaryText className="shrink font-mono text-foreground-muted">
                  {branch}
                </SummaryText>
              </>
            ) : null}
          </View>
        ) : undefined
      }
    >
      {selectedThreadCwd !== null && statusItem && "onPress" in statusItem ? (
        <View className="min-h-12 flex-row items-center gap-3 px-4 py-3">
          <SymbolView
            name="arrow.triangle.branch"
            size={18}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
          <View className="min-w-0 flex-1">
            <Text textRole="body" className="font-mono text-foreground" numberOfLines={1}>
              {statusItem.title}
            </Text>
            {statusItem.subtitle ? (
              <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
                {statusItem.subtitle}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
      {lines.map((line) => (
        <View key={linkedPullRequestKey(line)} className="border-t border-border-subtle">
          <LinkedPullRequestRow
            line={line}
            separator={false}
            surfaceClassName="text-grouped-card"
            openPullRequest={openPullRequest}
            actions={actions}
          />
        </View>
      ))}
      {totals !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Changes${totals.baseRef ? ` against ${totals.baseRef}` : ""}, ${totals.insertions} added, ${totals.deletions} removed`}
          accessibilityHint="Opens the review of this thread's changes"
          onPress={() => navigation.dispatch(StackActions.replace("ThreadReview", props.target))}
          className="min-h-12 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
        >
          <SymbolView name="file.diff" size={18} tintColorClassName="accent-icon" />
          <View className="min-w-0 flex-1 flex-row items-baseline gap-1.5">
            <Text textRole="body" className="shrink-0 text-foreground">
              Changes
            </Text>
            {totals.baseRef ? (
              <Text
                textRole="footnote"
                className="min-w-0 shrink text-foreground-muted"
                numberOfLines={1}
              >
                vs {totals.baseRef}
              </Text>
            ) : null}
          </View>
          <DiffCounts insertions={totals.insertions} deletions={totals.deletions} muteZero />
          <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
        </Pressable>
      ) : null}
      {rows.map((item) => (
        <View key={item.id} className="border-t border-border-subtle">
          <NavigationRow
            className="bg-grouped-card"
            title={item.title}
            subtitle={item.subtitle}
            subtitleNumberOfLines={1}
            leading={
              <SymbolView
                name={(item.icon ?? "arrow.triangle.branch") as AppSymbolName}
                size={20}
                tintColorClassName="accent-icon"
              />
            }
            disabled={item.disabled}
            onPress={item.onPress}
          />
        </View>
      ))}
    </LiveSection>
  );
}

function DiffCounts(props: {
  readonly insertions: number;
  readonly deletions: number;
  readonly muteZero?: boolean;
}) {
  const muted = "text-foreground-muted";
  return (
    <Text textRole="footnote" className="shrink-0 font-mono tabular-nums">
      <Text
        className={
          props.muteZero && props.insertions === 0 ? muted : "text-adaptive-emerald-600-400"
        }
      >
        +{formatDiffCount(props.insertions)}
      </Text>{" "}
      <Text className={props.muteZero && props.deletions === 0 ? muted : "text-danger-foreground"}>
        −{formatDiffCount(props.deletions)}
      </Text>
    </Text>
  );
}
