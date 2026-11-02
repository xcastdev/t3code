import {
  assistantAttentionCounts,
  assistantRunStatus,
  assistantStatus,
  routineScheduleLabel,
  type AssistantTone,
} from "@t3tools/client-runtime/assistant-presentation";
import type { AssistantId, EnvironmentId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, BrainIcon, CalendarClockIcon } from "lucide-react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import type { AgentSection } from "~/routes/-agentsSearch";
import { assistantsEnvironment } from "~/state/assistants";
import { useEnvironmentQuery } from "~/state/query";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  useAssistantConnection,
  useAssistantDetail,
  useAssistantRoster,
} from "../assistants/useAssistants";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection, ThreadDetailsSummary } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

export const ASSISTANT_TONE_DOT: Record<AssistantTone, string> = {
  neutral: "bg-muted-foreground/40",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

const RECENT_RUNS = 5;
const SHOWN_ROUTINES = 4;

export interface ThreadDetailsAgent {
  readonly environmentId: EnvironmentId;
  readonly assistantId: AssistantId;
}

function useOpenAgentSection(agent: ThreadDetailsAgent) {
  const navigate = useNavigate();
  return (section: AgentSection) =>
    void navigate({
      to: "/agents/$environmentId/$assistantId",
      params: { environmentId: agent.environmentId, assistantId: agent.assistantId },
      search: { section },
    });
}

function ToneDot(props: { readonly tone: AssistantTone; readonly className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        ASSISTANT_TONE_DOT[props.tone],
        props.className,
      )}
    />
  );
}

function SectionNote(props: { readonly children: string }) {
  return <p className="px-2.5 py-1 text-2xs text-muted-foreground">{props.children}</p>;
}

/** Live status from the roster stream, which also keeps activity and routines below current. */
export function ThreadDetailsAgentStatusSection(props: { readonly agent: ThreadDetailsAgent }) {
  const { environmentId, assistantId } = props.agent;
  const roster = useAssistantRoster(environmentId, false);
  const detail = useAssistantDetail(environmentId, assistantId);
  const connection = useAssistantConnection(environmentId);
  const openSection = useOpenAgentSection(props.agent);
  const summary =
    roster.data?.assistants.find((entry) => entry.assistantId === assistantId) ??
    detail.data?.summary ??
    null;
  if (summary === null) return null;
  const status = assistantStatus({ connected: connection.connected, summary });
  const counts = connection.connected ? assistantAttentionCounts(summary) : [];
  // Pending memory jobs already show in the counts above.
  const memoryNote =
    summary.attention.memoryStatus === "ready" ? null : summary.attention.memoryStatus;
  return (
    <ThreadDetailsSection
      headingId="thread-details-agent-status-heading"
      title="Agent"
      collapsedSummary={
        <ThreadDetailsSummary>
          <ToneDot tone={status.tone} />
          {status.label}
        </ThreadDetailsSummary>
      }
      separated={false}
    >
      <div className="flex flex-col gap-1 px-2.5 pb-1">
        <div className="flex min-w-0 items-center gap-2">
          <BotIcon className="size-4 shrink-0 text-foreground/80" aria-hidden />
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
            {summary.name}
          </span>
          <span className="ms-auto flex shrink-0 items-center gap-1.5 text-xs text-foreground/85">
            <ToneDot tone={status.tone} />
            {status.label}
          </span>
        </div>
        {status.detail ? <p className="text-2xs text-muted-foreground">{status.detail}</p> : null}
        {counts.length > 0 ? (
          <p className="text-2xs text-muted-foreground tabular-nums">{counts.join(" · ")}</p>
        ) : null}
      </div>
      <ThreadDetailsControl
        variant="ghost"
        size="sm"
        part="row"
        onClick={() => openSection("overview")}
      >
        <BotIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        <span className={cn("flex-1 text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          Agent overview
        </span>
      </ThreadDetailsControl>
      <ThreadDetailsControl
        variant="ghost"
        size="sm"
        part="row"
        onClick={() => openSection("memory")}
      >
        <BrainIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        <span className={cn("flex-1 text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>Memory</span>
        {memoryNote ? (
          <span className="shrink-0 text-2xs font-normal text-muted-foreground">{memoryNote}</span>
        ) : null}
      </ThreadDetailsControl>
    </ThreadDetailsSection>
  );
}

function useAgentRoutines(agent: ThreadDetailsAgent) {
  const query = useEnvironmentQuery(
    assistantsEnvironment.routines({
      environmentId: agent.environmentId,
      input: { ...agent, operation: "list", limit: 32 },
    }),
  );
  if (query.data?.operation !== "list") return null;
  return query.data.routines.filter((routine) => !routine.deleted);
}

export function ThreadDetailsAgentActivitySection(props: { readonly agent: ThreadDetailsAgent }) {
  const now = Date.parse(`${useNowMinute()}Z`);
  const openSection = useOpenAgentSection(props.agent);
  const activity = useEnvironmentQuery(
    assistantsEnvironment.activity({
      environmentId: props.agent.environmentId,
      input: { ...props.agent, limit: RECENT_RUNS },
    }),
  );
  const routines = useAgentRoutines(props.agent);
  const runs = activity.data?.runs ?? [];
  if (runs.length === 0) return null;
  const latest = runs[0] ? { run: runs[0], status: assistantRunStatus(runs[0]) } : null;
  const routineTitles = new Map(routines?.map((routine) => [routine.taskId, routine.title]));
  return (
    <ThreadDetailsSection
      headingId="thread-details-agent-activity-heading"
      title="Recent runs"
      collapsedSummary={
        latest ? (
          <ThreadDetailsSummary>
            <ToneDot tone={latest.status.tone} />
            {latest.status.label} · {formatRelativeTimeLabel(latest.run.updatedAt, now)}
          </ThreadDetailsSummary>
        ) : null
      }
      actions={
        <ThreadDetailsControl part="meta" onClick={() => openSection("activity")}>
          View all
        </ThreadDetailsControl>
      }
    >
      <ul className="m-0 list-none p-0">
        {runs.map((run) => {
          const status = assistantRunStatus(run);
          const source =
            run.scheduledTaskId === null
              ? "Chat"
              : (routineTitles.get(run.scheduledTaskId) ?? "Routine");
          return (
            <li
              key={`${run.commandId}:${run.runId ?? "dispatch"}`}
              className={cn(
                "flex h-8 items-center rounded-lg text-sm",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            >
              <ToneDot tone={status.tone} className="mx-1" />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">
                {status.label}
                <span className="font-normal text-muted-foreground"> · {source}</span>
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                {formatRelativeTimeLabel(run.updatedAt, now)}
              </span>
            </li>
          );
        })}
      </ul>
    </ThreadDetailsSection>
  );
}

export function ThreadDetailsAgentRoutinesSection(props: { readonly agent: ThreadDetailsAgent }) {
  const now = Date.parse(`${useNowMinute()}Z`);
  const openSection = useOpenAgentSection(props.agent);
  const routines = useAgentRoutines(props.agent);
  // A connection that can't read routines shows nothing rather than an empty schedule.
  if (routines === null) return null;
  const ordered = routines.toSorted(
    (left, right) =>
      Number(right.enabled) - Number(left.enabled) ||
      (left.nextRunAt ?? "￿").localeCompare(right.nextRunAt ?? "￿"),
  );
  const enabled = routines.filter((routine) => routine.enabled).length;
  const nextRun = ordered
    .filter((routine) => routine.enabled && routine.nextRunAt !== null)
    .map((routine) => Date.parse(routine.nextRunAt ?? ""))
    .find(Number.isFinite);
  return (
    <ThreadDetailsSection
      headingId="thread-details-agent-routines-heading"
      title="Routines"
      collapsedSummary={
        <ThreadDetailsSummary>
          {nextRun ? `Next in ${formatDuration(nextRun - now)}` : `${enabled} active`}
        </ThreadDetailsSummary>
      }
      actions={
        <>
          {routines.length > 0 ? (
            <span className="text-2xs text-muted-foreground tabular-nums">{enabled} active</span>
          ) : null}
          <ThreadDetailsControl part="meta" onClick={() => openSection("routines")}>
            Manage
          </ThreadDetailsControl>
        </>
      }
    >
      {ordered.length === 0 ? (
        <SectionNote>No routines yet.</SectionNote>
      ) : (
        ordered.slice(0, SHOWN_ROUTINES).map((routine) => {
          const nextAt = routine.nextRunAt ? Date.parse(routine.nextRunAt) : Number.NaN;
          const when = !routine.enabled
            ? "Paused"
            : Number.isFinite(nextAt)
              ? `in ${formatDuration(nextAt - now)}`
              : null;
          return (
            <div
              key={routine.taskId}
              className={cn(
                "flex min-h-8 items-center rounded-lg py-1",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
                !routine.enabled && "opacity-64",
              )}
            >
              <CalendarClockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground/80">
                  {routine.title}
                </span>
                <span className="truncate text-2xs text-muted-foreground">
                  {routineScheduleLabel(routine.schedule)}
                </span>
              </span>
              {when ? (
                <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">{when}</span>
              ) : null}
            </div>
          );
        })
      )}
    </ThreadDetailsSection>
  );
}
