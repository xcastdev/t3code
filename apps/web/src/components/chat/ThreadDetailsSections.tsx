import { useAtomValue } from "@effect/atom-react";
import {
  isProjectTerminalRunning,
  projectTerminalStatusLabel,
} from "@t3tools/client-runtime/project-terminal-view";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { presentPendingBackgroundWork } from "@t3tools/client-runtime/state/thread-execution";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2PlanStep,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CpuIcon,
  Minimize2Icon,
  TerminalIcon,
  TerminalSquareIcon,
} from "lucide-react";

import { formatContextWindowTokens, type ContextWindowSnapshot } from "~/lib/contextWindow";
import { revealThreadTerminal } from "~/lib/revealThreadTerminal";
import { cn } from "~/lib/utils";
import { useThreadDiscoveredPorts } from "~/portDiscoveryState";
import { orchestrationEnvironment } from "~/state/orchestration";
import { projectTerminalEnvironment, useProjectTerminalDock } from "~/state/projectTerminals";
import { terminalEnvironment } from "~/state/terminal";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection, ThreadDetailsSummary } from "./ThreadDetailsSection";
import { latestTodoList } from "./ThreadDetailsSections.logic";
import { ThreadProcessRow } from "./ThreadProcessRow";
import { ThreadServerRows } from "./ThreadServersPanel";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

function SectionNote(props: { readonly children: string }) {
  return <p className="px-2.5 py-1 text-2xs text-muted-foreground">{props.children}</p>;
}

function StatRow(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-2.5 text-xs leading-5">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="font-medium text-foreground/85 tabular-nums">{props.value}</span>
    </div>
  );
}

export interface ThreadDetailsContextProps {
  readonly snapshot: ContextWindowSnapshot | null;
  readonly modelDisplayName: string | null;
  readonly onCompact?: (() => void) | undefined;
  readonly compactDisabled: boolean;
  readonly compactDisabledReason: string | null;
}

export function ThreadDetailsContextSection(
  props: ThreadDetailsContextProps & { readonly separated?: boolean },
) {
  const usage = props.snapshot;
  const percentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const breakdown = usage
    ? [
        { label: "Input", value: usage.inputTokens },
        { label: "Cached", value: usage.cachedInputTokens },
        { label: "Output", value: usage.outputTokens },
        { label: "Reasoning", value: usage.reasoningOutputTokens },
      ].filter((entry): entry is { label: string; value: number } => entry.value !== null)
    : [];
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title="Context"
      separated={props.separated ?? false}
      collapsedSummary={
        usage ? (
          <ThreadDetailsSummary>
            {usage.maxTokens !== null
              ? `${Math.round(percentage)}% used`
              : `${formatContextWindowTokens(usage.usedTokens)} tokens`}
          </ThreadDetailsSummary>
        ) : null
      }
      actions={
        props.modelDisplayName ? (
          <span className="truncate text-2xs text-muted-foreground">{props.modelDisplayName}</span>
        ) : null
      }
    >
      {usage === null ? (
        <SectionNote>No context usage reported yet.</SectionNote>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 px-2.5">
            <span className="text-lg font-semibold text-foreground tabular-nums">
              {usage.maxTokens !== null
                ? `${Math.round(percentage)}%`
                : formatContextWindowTokens(usage.usedTokens)}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {usage.maxTokens !== null
                ? `${formatContextWindowTokens(usage.usedTokens)} / ${formatContextWindowTokens(usage.maxTokens ?? null)} tokens`
                : "tokens used"}
            </span>
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="mx-2.5 h-1.5 overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percentage)}
              aria-label="Context window usage"
            >
              <div
                className={cn(
                  "h-full rounded-full",
                  percentage > 90 ? "bg-destructive" : "bg-muted-foreground/70",
                )}
                style={{ width: `${percentage}%` }}
              />
            </div>
          ) : null}
          {breakdown.map((entry) => (
            <StatRow
              key={entry.label}
              label={entry.label}
              value={formatContextWindowTokens(entry.value)}
            />
          ))}
          {usage.compactsAutomatically ? (
            <SectionNote>
              {formatContextWindowCompactionMessage(
                props.modelDisplayName,
                usage.autoCompactThreshold,
              )}
            </SectionNote>
          ) : null}
        </div>
      )}
      {props.onCompact ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                variant="ghost"
                size="sm"
                part="row"
                aria-disabled={props.compactDisabled || undefined}
                onClick={() => {
                  if (!props.compactDisabled) props.onCompact?.();
                }}
              />
            }
          >
            <Minimize2Icon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span className={cn("flex-1 text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
              Compact context
            </span>
          </TooltipTrigger>
          {props.compactDisabled && props.compactDisabledReason ? (
            <TooltipPopup side="left">{props.compactDisabledReason}</TooltipPopup>
          ) : null}
        </Tooltip>
      ) : null}
    </ThreadDetailsSection>
  );
}

function formatStepDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function TaskStatusIcon(props: { readonly status: OrchestrationV2PlanStep["status"] }) {
  if (props.status === "completed")
    return <CircleCheckIcon className="size-4 shrink-0 text-success" aria-label="Done" />;
  if (props.status === "running")
    return <CircleDotIcon className="size-4 shrink-0 text-primary" aria-label="In progress" />;
  return (
    <CircleDashedIcon className="size-4 shrink-0 text-muted-foreground/60" aria-label="Pending" />
  );
}

export function ThreadDetailsTasksSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly plans: ThreadStructure["plans"];
  readonly runs: ThreadStructure["runs"];
}) {
  const clearTodoList = useAtomCommand(threadEnvironment.clearTodoList, {
    label: "clear checklist",
  });
  const todoList = latestTodoList(props.plans, props.runs);
  const steps = todoList?.steps ?? [];
  const done = steps.filter((step) => step.status === "completed").length;
  if (todoList === null || steps.length === 0) return null;
  const progress = (
    <ThreadDetailsSummary>
      {done} of {steps.length} done
    </ThreadDetailsSummary>
  );
  return (
    <ThreadDetailsSection
      headingId="thread-details-checklist-heading"
      title="Checklist"
      collapsedSummary={progress}
      actions={
        <>
          {progress}
          <ThreadDetailsControl
            part="meta"
            onClick={() =>
              void clearTodoList({
                environmentId: props.environmentId,
                input: { threadId: props.threadId, planId: todoList.id },
              })
            }
          >
            Clear
          </ThreadDetailsControl>
        </>
      }
    >
      <ol className="m-0 list-none p-0">
        {steps.map((step) => (
          <li
            key={step.id}
            className={cn(
              "flex items-start rounded-lg py-1.5 text-sm leading-4.5",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              step.status === "running" && "bg-accent",
            )}
          >
            <span className="mt-px">
              <TaskStatusIcon status={step.status} />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1",
                step.status === "completed"
                  ? "text-muted-foreground line-through decoration-muted-foreground/40"
                  : step.status === "running"
                    ? "text-foreground"
                    : "text-foreground/80",
              )}
            >
              {step.text}
            </span>
            {step.status === "completed" && step.durationMs !== undefined ? (
              <span className="text-2xs text-muted-foreground tabular-nums">
                {formatStepDuration(step.durationMs)}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </ThreadDetailsSection>
  );
}

const BACKGROUND_WORK_KIND_LABELS: Partial<Record<string, string>> = {
  command: "Command",
  monitor: "Monitor",
};

/**
 * What runs for this thread: its terminals, terminals its agent opened, the provider's background
 * work, and the local servers those started. Subagents are listed under Agents instead.
 */
export function ThreadDetailsProcessesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  /** The "Servers" item in "Choose what to show". */
  readonly showServers: boolean;
}) {
  const navigate = useNavigate();
  const terminals = useKnownTerminalSessions({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const dock = useProjectTerminalDock(props.environmentId, props.projectId);
  const discoveredServers = useThreadDiscoveredPorts({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const canInterruptTerminal = useAtomValue(
    terminalEnvironment.write.permissionAtom(props.environmentId),
  );
  const canKillAgentShell = useAtomValue(
    projectTerminalEnvironment.kill.permissionAtom(props.environmentId),
  );
  const canStopTask = useAtomValue(
    orchestrationEnvironment.stopBackgroundTask.permissionAtom(props.environmentId),
  );
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const killAgentShell = useAtomCommand(projectTerminalEnvironment.kill, {
    reportFailure: false,
  });
  const stopTask = useAtomCommand(orchestrationEnvironment.stopBackgroundTask, {
    reportFailure: false,
  });

  const servers = props.showServers ? discoveredServers : [];
  const shells = (terminals ?? []).filter((session) => session.state.status !== "closed");
  const agentShells = dock.terminals.filter(
    (terminal) =>
      terminal.creatingThreadId === props.threadId &&
      (isProjectTerminalRunning(terminal.status) || terminal.status === "stopping"),
  );
  const backgroundWork = presentPendingBackgroundWork(
    props.pendingBackgroundTasks.filter((task) => task.kind !== "subagent"),
  );
  const running =
    shells.filter((session) => session.state.hasRunningSubprocess).length +
    agentShells.length +
    (backgroundWork?.items.length ?? 0) +
    servers.length;
  if (
    shells.length === 0 &&
    agentShells.length === 0 &&
    backgroundWork === null &&
    servers.length === 0
  ) {
    return null;
  }

  const reportFailure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-processes-heading"
      title="Processes"
      actions={
        running > 0 ? (
          <span className="text-2xs text-muted-foreground tabular-nums">{running} running</span>
        ) : null
      }
    >
      <ul className="m-0 list-none p-0">
        {shells.map((session) => {
          const summary = session.state.summary;
          const busy = session.state.hasRunningSubprocess;
          const terminalId = session.target.terminalId;
          const status = busy
            ? "Running"
            : summary?.exitCode !== null && summary?.exitCode !== undefined
              ? `Exited ${summary.exitCode}`
              : null;
          return (
            <ThreadProcessRow
              key={terminalId}
              icon={
                <span className="relative inline-flex">
                  <TerminalSquareIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -right-1 -top-1 size-1.5 rounded-full",
                      busy ? "bg-success" : "bg-muted-foreground/40",
                    )}
                  />
                </span>
              }
              title={summary?.label || getTerminalLabel(terminalId)}
              detail={["Terminal", status].filter(Boolean).join(" · ")}
              open={{
                tooltip: "Open in the terminal panel",
                onOpen: () =>
                  revealThreadTerminal(
                    { environmentId: props.environmentId, threadId: props.threadId },
                    terminalId,
                  ),
              }}
              {...(busy && canInterruptTerminal
                ? {
                    stop: {
                      label: `Stop what runs in ${summary?.label || getTerminalLabel(terminalId)}`,
                      tooltip: "Stop the running command (Ctrl-C)",
                      onStop: async () => {
                        reportFailure(
                          "Could not stop the command",
                          await writeTerminal({
                            environmentId: props.environmentId,
                            input: { threadId: props.threadId, terminalId, data: "\u0003" },
                          }),
                        );
                      },
                    },
                  }
                : {})}
            />
          );
        })}
        {agentShells.map((terminal) => (
          <ThreadProcessRow
            key={terminal.terminalId}
            icon={<TerminalSquareIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />}
            title={terminal.label || terminal.terminalId}
            detail={["Agent Shell", projectTerminalStatusLabel(terminal)].join(" · ")}
            open={{
              tooltip: "Open the agent's terminal",
              onOpen: () =>
                void navigate({
                  to: "/terminals/$environmentId/$projectId",
                  params: { environmentId: props.environmentId, projectId: props.projectId },
                  search: { terminal: terminal.terminalId },
                }),
            }}
            {...(canKillAgentShell && terminal.status !== "stopping"
              ? {
                  stop: {
                    label: `Stop ${terminal.label || terminal.terminalId}`,
                    tooltip: "Stop agent shell",
                    onStop: async () => {
                      reportFailure(
                        "Could not stop the agent shell",
                        await killAgentShell({
                          environmentId: props.environmentId,
                          input: {
                            projectId: terminal.projectId,
                            terminalId: terminal.terminalId,
                            expectedGeneration: terminal.generation,
                          },
                        }),
                      );
                    },
                  },
                }
              : {})}
          />
        ))}
        {backgroundWork?.items.map((item) => {
          const kind = BACKGROUND_WORK_KIND_LABELS[item.kind] ?? "Process";
          return (
            <ThreadProcessRow
              key={item.taskId}
              icon={
                item.kind === "background_task" ? (
                  <CpuIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
                ) : (
                  <TerminalIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
                )
              }
              title={item.label}
              detail={kind}
              {...(canStopTask
                ? {
                    stop: {
                      label: `Stop ${item.label}`,
                      tooltip: `Stop ${kind.toLowerCase()}`,
                      onStop: async () => {
                        reportFailure(
                          `Could not stop the ${kind.toLowerCase()}`,
                          await stopTask({
                            environmentId: props.environmentId,
                            input: { threadId: props.threadId, taskId: item.taskId },
                          }),
                        );
                      },
                    },
                  }
                : {})}
            />
          );
        })}
        {servers.length > 0 ? (
          <ThreadServerRows
            environmentId={props.environmentId}
            threadId={props.threadId}
            servers={servers}
          />
        ) : null}
      </ul>
    </ThreadDetailsSection>
  );
}
