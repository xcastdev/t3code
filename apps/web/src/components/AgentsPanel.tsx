/**
 * Agents right-panel surface: the fleet view over the native subagent fold.
 * The chat carries one expandable row per spawn batch and links here.
 *
 * Visualization rules (from live-test feedback):
 * - Spawn order is stable. Activity and completion update rows in place.
 * - Agent rows reserve three fixed lines for identity, activity, and metrics;
 *   changing data must never change their height.
 * - Workflow expansion is presentation state. A live run stays expanded when
 *   it settles; older collapsed runs can still be opened at run granularity.
 * - Static status dots, DOM-write elapsed timers, plain token counters.
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  agentTranscriptEntriesFromActivities,
  firstDiscardedAgentTranscriptCursor,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  mergeAgentTranscriptEntries,
  mergeAgentTranscriptPageWindows,
  recoverAgentTranscriptGap,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  ApprovalRequestId,
  EnvironmentId,
  OrchestrationAgentTranscriptEntry,
  OrchestrationThreadActivity,
  ProviderApprovalDecision,
  RuntimeAgentKey,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  derivePendingRequestsForAgent,
  type PendingUserInput,
} from "@t3tools/client-runtime/pending-requests";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { ArrowLeft, ArrowUp, Bot, Braces, Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";
import { useAtomCommand } from "~/state/use-atom-command";
import { threadEnvironment } from "~/state/threads";
import { useEnvironment } from "~/state/environments";
import ChatMarkdown from "./ChatMarkdown";
import { ComposerSurface } from "./chat/ComposerSurface";
import { shouldPreserveAssistantLineBreaks } from "./chat/MessagesTimeline.logic";

const EMPTY_AGENT_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];
const EMPTY_AGENT_TRANSCRIPT_ENTRIES: ReadonlyArray<OrchestrationAgentTranscriptEntry> = [];

/**
 * In-flight states all present as Working (one steady state, per the
 * monitoring-pill design: detail belongs in the activity sub-line, and a
 * stalled/waiting/queued subagent is still the fleet doing its job, not a
 * user problem). Only settled states differentiate.
 */
const STATUS_VISUALS: Record<RuntimeSubagent["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Working" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Working" },
  // Idle reads as settled (muted, not sky): a resting Codex child looks done
  // unless resumed — live-test: sky idle dots read as stuck in-progress.
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 */
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

/**
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
function agentActivityText(agent: RuntimeSubagent): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  if (live) {
    return (
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error
    );
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? `▸ ${agent.lastToolName}` : null)
  );
}

/** Flat agent status line. */
function AgentRow({
  agent,
  onSelect,
}: {
  agent: RuntimeSubagent;
  onSelect?: ((agent: RuntimeSubagent) => void) | undefined;
}) {
  const visuals = STATUS_VISUALS[agent.status];
  const statusLabel =
    agent.kind === "subagent_batch" && agent.status === "idle" ? "Idle" : visuals.label;
  const activity = agentActivityText(agent);
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const metadata = [
    modelLabel,
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  ].filter((value): value is string => value !== null);

  const content = (
    <div className="grid h-[3.875rem] grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1">
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot status={agent.status} />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{agent.title}</span>
        {role ? (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground">
            {role}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-[.7rem] text-muted-foreground/80">
        <span className="inline-flex items-center gap-1">
          <AgentElapsed agent={agent} />
          {agent.status === "completed" ? (
            <Check aria-hidden className="size-3 text-success" />
          ) : null}
        </span>
      </span>
      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {activity ?? statusLabel}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
        {metadata.join(" · ")}
      </span>
      <span className="sr-only">{statusLabel}</span>
    </div>
  );
  return onSelect && agent.agentKey ? (
    <button
      type="button"
      onClick={() => onSelect(agent)}
      aria-label={`Open ${agent.title} agent transcript`}
      className="w-full rounded-md text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
    >
      {content}
    </button>
  ) : (
    content
  );
}

function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  const status = group.workflow.status;
  return (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  );
}

function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/**
 * Phase rail: the run's shape at a glance. One segment per phase in order,
 * separated by chevrons; each segment shows title + one dot per member.
 * The whole arc (done → live → pending) is visible without scrolling the
 * member list.
 */
function PhaseRail({ group }: { group: AgentPanelWorkflowGroup }) {
  if (group.phases.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-1.5 pb-1 pt-1.5">
      {group.phases.map((phase, index) => (
        <div key={phase.index} className="flex items-center gap-1">
          {index > 0 ? (
            <ChevronRight aria-hidden className="size-3 text-muted-foreground/40" />
          ) : null}
          <div
            className={cn(
              "flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
              phase.state === "running"
                ? "border-info/40"
                : phase.state === "done"
                  ? "border-success/30"
                  : "border-border/50",
            )}
          >
            <span
              className={cn(
                "font-mono text-[.65rem]",
                phase.state === "running"
                  ? "text-info-foreground"
                  : phase.state === "done"
                    ? "text-success-foreground"
                    : "text-muted-foreground/70",
              )}
            >
              {phase.state === "done" ? "✓ " : ""}
              {phase.title}
            </span>
            <span className="flex items-center gap-0.5">
              {phase.members.length === 0 ? (
                <span className="font-mono text-[.6rem] text-muted-foreground/50">–</span>
              ) : (
                phase.members.map((member) => <StatusDot key={member.id} status={member.status} />)
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only workflow script viewer, fetched through the contained
 * getWorkflowScript RPC (never a raw filesystem read from the client).
 */
function WorkflowScriptView({
  environmentId,
  threadId,
  scriptPath,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
  onClose: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.workflowScript({ environmentId, input: { threadId, scriptPath } }),
  );
  return (
    <div className="mx-1.5 mb-1 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <Braces aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-[.65rem] text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label="Close script"
          className="ml-auto"
        >
          <X aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result._tag === "Success" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-foreground/90">
            {result.value.contents}
            {result.value.truncated ? "\n… (truncated)" : ""}
          </pre>
        ) : result._tag === "Failure" ? (
          <p className="text-xs text-destructive-foreground">Could not load the script.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible phase section. A phase opens when it becomes active, then keeps
 * that shape as it settles so completion never yanks rows out from under the
 * user. Manual toggles stick until a later activation begins.
 */
function PhaseSection({
  phase,
  defaultOpen = false,
  onSelectAgent,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  defaultOpen?: boolean;
  onSelectAgent?: ((agent: RuntimeSubagent) => void) | undefined;
}) {
  const [open, setOpen] = useState(defaultOpen || phase.state === "running");
  const previousState = useRef(phase.state);

  useEffect(() => {
    if (previousState.current !== "running" && phase.state === "running") {
      setOpen(true);
    }
    previousState.current = phase.state;
  }, [phase.state]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "mt-2 flex w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-[.65rem] font-medium uppercase tracking-wider hover:bg-accent/40",
          phase.state === "done"
            ? "text-success-foreground"
            : phase.state === "running"
              ? "text-info-foreground"
              : "text-muted-foreground/70",
        )}
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        )}
        {phase.state === "done" ? <Check aria-hidden className="size-3" /> : null}
        <span>{phase.title}</span>
        <span className="font-normal normal-case text-muted-foreground/70">
          {phase.state === "pending" && phase.members.length === 0
            ? "pending"
            : phase.state === "done"
              ? `${phase.settledCount} done`
              : `${phase.activeCount} active · ${phase.settledCount} done`}
        </span>
        {!open && phase.members.length > 0 ? (
          <span className="ml-auto flex items-center gap-0.5">
            {phase.members.map((member) => (
              <StatusDot key={member.id} status={member.status} />
            ))}
          </span>
        ) : null}
      </button>
      {open
        ? phase.members.map((member) => (
            <AgentRow key={member.id} agent={member} onSelect={onSelectAgent} />
          ))
        : null}
    </div>
  );
}

/** Expanded workflow: phase rail + full phase tree. */
function ExpandedWorkflowSection({
  group,
  environmentId,
  threadId,
  onCollapse,
  onSelectAgent,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onCollapse: () => void;
  onSelectAgent?: ((agent: RuntimeSubagent) => void) | undefined;
}) {
  const [scriptOpen, setScriptOpen] = useState(false);
  const members = workflowMembers(group);
  const settled = members.filter(
    (member) =>
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "cancelled" ||
      member.status === "interrupted",
  ).length;
  const scriptPath = group.workflow.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;
  return (
    <section className="rounded-lg border border-border/50 bg-card/30 p-1.5">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        <StatusDot status={group.workflow.status} />
        <span className="min-w-0 truncate">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        {canShowScript ? (
          <button
            type="button"
            onClick={() => setScriptOpen((value) => !value)}
            className={cn(
              "rounded-sm border border-border/60 px-1 font-mono normal-case hover:text-foreground",
              scriptOpen && "text-foreground",
            )}
            aria-expanded={scriptOpen}
          >
            {"{}"} script
          </button>
        ) : null}
        <span className="ml-auto font-mono normal-case text-muted-foreground/80">
          {settled}/{members.length} settled
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onCollapse}
          aria-label="Collapse workflow"
        >
          <ChevronDown aria-hidden className="size-3" />
        </Button>
      </div>
      <PhaseRail group={group} />
      {scriptOpen && canShowScript ? (
        <WorkflowScriptView
          environmentId={environmentId}
          threadId={threadId}
          scriptPath={scriptPath}
          onClose={() => setScriptOpen(false)}
        />
      ) : null}
      {group.phases.map((phase) => (
        <PhaseSection
          key={phase.index}
          phase={phase}
          defaultOpen={!workflowIsLive(group)}
          onSelectAgent={onSelectAgent}
        />
      ))}
      {group.unphasedMembers.map((member) => (
        <AgentRow key={member.id} agent={member} onSelect={onSelectAgent} />
      ))}
      {group.phases.length === 0 && group.unphasedMembers.length === 0 ? (
        <AgentRow agent={group.workflow} onSelect={onSelectAgent} />
      ) : null}
    </section>
  );
}

/**
 * Collapsed workflow: one summary line. The parent owns expansion so a live
 * workflow keeps its shape when it settles.
 */
function CollapsedWorkflowSection({
  group,
  onExpand,
}: {
  group: AgentPanelWorkflowGroup;
  onExpand: () => void;
}) {
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  // Coordinator usage may already aggregate members (panel-footer rule):
  // count it only when there are no member rows to sum.
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? elapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;
  return (
    <section>
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
        aria-expanded={false}
      >
        <StatusDot status={failed > 0 ? "failed" : group.workflow.status} />
        <span className="truncate text-sm">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[.7rem] text-muted-foreground/80">
          {failed > 0 ? <span className="text-destructive-foreground">{failed} failed</span> : null}
          <span>{members.length} agents</span>
          <span className="tabular-nums">· {formatSubagentTokenCount(totalTokens)} tok</span>
          {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
          <ChevronRight aria-hidden className="size-3" />
        </span>
      </button>
    </section>
  );
}

/** A workflow's open state is presentation state, not a status derivative. */
function WorkflowSection({
  group,
  environmentId,
  threadId,
  onSelectAgent,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onSelectAgent?: ((agent: RuntimeSubagent) => void) | undefined;
}) {
  const [open, setOpen] = useState(() => workflowIsLive(group));
  return open ? (
    <ExpandedWorkflowSection
      group={group}
      environmentId={environmentId}
      threadId={threadId}
      onCollapse={() => setOpen(false)}
      onSelectAgent={onSelectAgent}
    />
  ) : (
    <CollapsedWorkflowSection group={group} onExpand={() => setOpen(true)} />
  );
}

function AgentRequestControls({
  environmentId,
  threadId,
  agentKey,
  activities,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  agentKey: RuntimeAgentKey;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
}) {
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "subagent approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "subagent user input response",
  );
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [answersByRequest, setAnswersByRequest] = useState<
    Readonly<Record<string, Record<string, PendingUserInputDraftAnswer>>>
  >({});
  const requests = useMemo(
    () => derivePendingRequestsForAgent(activities, agentKey),
    [activities, agentKey],
  );

  const submitApproval = async (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => {
    setRequestError(null);
    setRespondingRequestId(requestId);
    const result = await respondToApproval({
      environmentId,
      input: { threadId, requestId, decision },
    });
    if (result._tag === "Failure")
      setRequestError("Could not submit the response. The request may have expired.");
    setRespondingRequestId(null);
  };

  const submitAnswers = async (
    requestId: ApprovalRequestId,
    questions: PendingUserInput["questions"],
  ) => {
    const answers = buildPendingUserInputAnswers(questions, answersByRequest[requestId] ?? {});
    if (answers === null) {
      setRequestError("Answer each question before sending.");
      return;
    }
    setRequestError(null);
    setRespondingRequestId(requestId);
    const result = await respondToUserInput({
      environmentId,
      input: { threadId, requestId, answers },
    });
    if (result._tag === "Failure")
      setRequestError("Could not submit the response. The request may have expired.");
    setRespondingRequestId(null);
  };

  if (requests.approvals.length === 0 && requests.userInputs.length === 0) return null;

  return (
    <section
      className="flex flex-col gap-2 border-b border-border/60 p-3"
      aria-label="Pending subagent requests"
    >
      <h3 className="text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        Requests
      </h3>
      {requests.approvals.map((approval) => {
        const options = approval.options?.length
          ? approval.options
          : [
              { decision: "accept" as const, label: "Allow" },
              { decision: "decline" as const, label: "Deny" },
            ];
        return (
          <div
            key={approval.requestId}
            className="rounded-md border border-border/60 bg-background/60 p-2"
          >
            <div className="mb-2 flex items-center gap-2 text-xs font-medium">
              <span className="rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                Subagent request
              </span>
              <span>{approval.appName ?? "Permission"}</span>
            </div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[.7rem] text-foreground/85">
              {approval.detail ?? "The subagent is requesting permission."}
            </pre>
            {approval.options?.find((option) => option.warning)?.warning ? (
              <p className="mt-2 text-[.7rem] text-warning-foreground">
                {approval.options.find((option) => option.warning)?.warning}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {options.map((option) => (
                <Button
                  key={option.decision}
                  size="xs"
                  variant={
                    option.decision === "decline" || option.decision === "cancel"
                      ? "outline"
                      : "default"
                  }
                  disabled={respondingRequestId === approval.requestId}
                  onClick={() => void submitApproval(approval.requestId, option.decision)}
                >
                  {respondingRequestId === approval.requestId ? "Sending…" : option.label}
                </Button>
              ))}
            </div>
          </div>
        );
      })}
      {requests.userInputs.map((request) => {
        const draft = answersByRequest[request.requestId] ?? {};
        return (
          <div
            key={request.requestId}
            className="rounded-md border border-border/60 bg-background/60 p-2"
          >
            <div className="mb-2 text-xs font-medium">Subagent question</div>
            <div className="flex flex-col gap-3">
              {request.questions.map((question) => (
                <fieldset key={question.id} className="flex min-w-0 flex-col gap-1.5">
                  <legend className="text-xs text-foreground">{question.question}</legend>
                  {question.options.map((option) => {
                    const value = option.value ?? option.label;
                    const selected =
                      draft[question.id]?.selectedOptionValues?.includes(value) ?? false;
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={selected}
                        disabled={respondingRequestId === request.requestId}
                        onClick={() =>
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
                        className={cn(
                          "rounded border px-2 py-1 text-left text-xs hover:bg-accent/40",
                          selected ? "border-primary/60 bg-primary/10" : "border-border/60",
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                  {question.allowCustomAnswer !== false ? (
                    <textarea
                      aria-label={`Answer ${question.header || question.question}`}
                      value={draft[question.id]?.customAnswer ?? ""}
                      disabled={respondingRequestId === request.requestId}
                      onChange={(event) =>
                        setAnswersByRequest((current) => ({
                          ...current,
                          [request.requestId]: {
                            ...current[request.requestId],
                            [question.id]: setPendingUserInputCustomAnswer(
                              current[request.requestId]?.[question.id],
                              event.target.value,
                            ),
                          },
                        }))
                      }
                      placeholder="Write an answer"
                      rows={2}
                      className="mt-1 w-full resize-y rounded border border-border/60 bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  ) : null}
                </fieldset>
              ))}
            </div>
            <Button
              size="xs"
              className="mt-2"
              disabled={respondingRequestId === request.requestId}
              onClick={() => void submitAnswers(request.requestId, request.questions)}
            >
              {respondingRequestId === request.requestId ? "Sending…" : "Answer"}
            </Button>
          </div>
        );
      })}
      {requestError ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {requestError}
        </p>
      ) : null}
    </section>
  );
}

function deliveryStatusLabel(
  status: OrchestrationAgentTranscriptEntry["deliveryStatus"],
): string | null {
  switch (status) {
    case "pending":
      return "Sending";
    case "accepted":
      return "Accepted by subagent";
    case "completed":
      return "Completed";
    case "failed":
      return "Delivery failed";
    case "unknown":
      return "Delivery outcome unknown";
    default:
      return null;
  }
}

function handoffStatusLabel(
  status: OrchestrationAgentTranscriptEntry["handoffStatus"],
): string | null {
  switch (status) {
    case "pending":
      return "Parent handoff pending";
    case "recorded":
      return "Added to parent context";
    case "unavailable":
      return "Parent handoff unavailable";
    case "failed":
      return "Parent handoff failed";
    case "unknown":
      return "Parent handoff outcome unknown";
    default:
      return null;
  }
}

function AgentTranscriptEntryMeta({
  entry,
  align = "start",
}: {
  entry: OrchestrationAgentTranscriptEntry;
  align?: "start" | "end";
}) {
  const deliveryStatus = deliveryStatusLabel(entry.deliveryStatus);
  const handoffStatus = handoffStatusLabel(entry.handoffStatus);
  return (
    <div
      className={cn(
        "mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[.65rem] text-muted-foreground/75",
        align === "end" ? "justify-end text-right" : "justify-start",
      )}
    >
      <time className="shrink-0 font-mono tabular-nums">
        {new Date(entry.createdAt).toLocaleTimeString()}
      </time>
      {entry.status ? <span>{entry.status}</span> : null}
      {deliveryStatus ? (
        <span role="status" className="min-w-0 whitespace-pre-wrap break-words">
          {deliveryStatus}
          {entry.detail ? ` · ${entry.detail}` : ""}
        </span>
      ) : null}
      {handoffStatus ? <span role="status">{handoffStatus}</span> : null}
    </div>
  );
}

function AgentTranscriptMessage({
  entry,
  agentTitle,
  markdownCwd,
  threadRef,
}: {
  entry: OrchestrationAgentTranscriptEntry;
  agentTitle: string;
  markdownCwd: string | undefined;
  threadRef: ScopedThreadRef | undefined;
}) {
  const isUser = entry.role === "user";
  const text = entry.content?.length ? entry.content : (entry.detail ?? entry.summary);
  return (
    <div className={isUser ? "group flex flex-col items-end gap-1" : "min-w-0"}>
      <div
        role="group"
        aria-label={isUser ? `Message from you to ${agentTitle}` : `Message from ${agentTitle}`}
        data-agent-transcript-role={isUser ? "user" : "assistant"}
        className={
          isUser
            ? "relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground"
            : "relative min-w-0 px-1 py-0.5"
        }
      >
        <h3 className="sr-only select-none">{isUser ? "You" : agentTitle}</h3>
        <ChatMarkdown
          text={text}
          cwd={markdownCwd}
          threadRef={threadRef}
          isStreaming={!isUser && entry.status === "running"}
          headingLevelOffset={3}
          {...(isUser
            ? { className: "text-message-foreground", lineBreaks: true, parseRawHtml: false }
            : { lineBreaks: shouldPreserveAssistantLineBreaks(text) })}
        />
      </div>
      <AgentTranscriptEntryMeta entry={entry} align={isUser ? "end" : "start"} />
    </div>
  );
}

function AgentTranscriptActivity({ entry }: { entry: OrchestrationAgentTranscriptEntry }) {
  const isTool = entry.kind === "tool" || entry.role === "tool";
  const Icon = isTool ? Braces : entry.kind === "request" ? Check : Bot;
  return (
    <article
      data-agent-transcript-kind={isTool ? "tool" : entry.kind}
      className="flex min-h-6 min-w-0 items-start gap-1.5 rounded-md px-0.5 py-0.5 text-sm leading-relaxed"
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
        <Icon aria-hidden className="size-4 shrink-0 stroke-[1.8]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="min-w-0 whitespace-pre-wrap break-words text-secondary-label">
            {entry.summary}
          </span>
          <time className="shrink-0 font-mono text-[.6rem] tabular-nums text-muted-foreground/70">
            {new Date(entry.createdAt).toLocaleTimeString()}
          </time>
        </div>
        {entry.detail ? (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {entry.detail}
          </p>
        ) : null}
        {entry.content ? (
          <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
            {entry.content}
          </pre>
        ) : null}
        {entry.status || entry.deliveryStatus || entry.handoffStatus ? (
          <AgentTranscriptEntryMeta entry={entry} />
        ) : null}
      </div>
    </article>
  );
}

type AgentTranscriptDisplayEntry =
  | { readonly type: "entry"; readonly entry: OrchestrationAgentTranscriptEntry }
  | {
      readonly type: "running-status-group";
      readonly entries: ReadonlyArray<OrchestrationAgentTranscriptEntry>;
    };

function groupAdjacentRunningStatuses(
  entries: ReadonlyArray<OrchestrationAgentTranscriptEntry>,
): ReadonlyArray<AgentTranscriptDisplayEntry> {
  const grouped: Array<
    | { type: "entry"; entry: OrchestrationAgentTranscriptEntry }
    | { type: "running-status-group"; entries: OrchestrationAgentTranscriptEntry[] }
  > = [];
  for (const entry of entries) {
    if (entry.kind === "status" && entry.status === "running") {
      const previous = grouped.at(-1);
      if (previous?.type === "running-status-group") {
        previous.entries.push(entry);
      } else {
        grouped.push({ type: "running-status-group", entries: [entry] });
      }
    } else {
      grouped.push({ type: "entry", entry });
    }
  }
  return grouped.flatMap((item) =>
    item.type === "running-status-group" && item.entries.length === 1
      ? [{ type: "entry", entry: item.entries[0]! }]
      : [item],
  );
}

function AgentTranscriptRunningStatusGroup({
  entries,
}: {
  entries: ReadonlyArray<OrchestrationAgentTranscriptEntry>;
}) {
  const latest = entries.at(-1);
  return (
    <details
      data-agent-status-group={entries.length}
      className="min-w-0 rounded-md px-0.5 py-0.5 text-sm leading-relaxed"
    >
      <summary className="flex min-h-6 cursor-pointer list-none items-center gap-1.5 rounded-md text-secondary-label hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 [&::-webkit-details-marker]:hidden">
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
          <Bot aria-hidden className="size-4 shrink-0 stroke-[1.8]" />
        </span>
        <span className="min-w-0 flex-1 truncate">Subagent running · {entries.length} updates</span>
        {latest ? (
          <time className="shrink-0 font-mono text-[.6rem] tabular-nums text-muted-foreground/70">
            {new Date(latest.createdAt).toLocaleTimeString()}
          </time>
        ) : null}
      </summary>
      <div className="ml-6 flex min-w-0 flex-col gap-1 border-l border-border/50 pl-1.5">
        {entries.map((entry) => (
          <AgentTranscriptActivity key={entry.id} entry={entry} />
        ))}
      </div>
    </details>
  );
}

function AgentDetailPanel({
  agent,
  agentKey,
  environmentId,
  threadId,
  markdownCwd,
  threadRef,
  activities,
  parentTitle,
  onBack,
}: {
  agent: RuntimeSubagent;
  agentKey: RuntimeAgentKey;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  markdownCwd: string | undefined;
  threadRef: ScopedThreadRef | undefined;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  parentTitle: string | null;
  onBack: () => void;
}) {
  const connectionPhase = useEnvironment(environmentId)?.connection.phase;
  const [requestCursor, setRequestCursor] = useState<string | null>(null);
  const [entries, setEntries] = useState<ReadonlyArray<OrchestrationAgentTranscriptEntry>>([]);
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
  const transcriptPageQuery = orchestrationEnvironment.agentTranscriptPage({
    environmentId,
    input: { threadId, agentKey, ...(requestCursor ? { cursor: requestCursor } : {}) },
  });
  const newestTranscriptPageQuery = orchestrationEnvironment.agentTranscriptPage({
    environmentId,
    input: { threadId, agentKey },
  });
  const pageResult = useAtomValue(transcriptPageQuery);
  const newestPageResult = useAtomValue(newestTranscriptPageQuery);
  const refreshNewestTranscriptPage = useAtomRefresh(newestTranscriptPageQuery);
  const readAgentTranscriptPage = useAtomCommand(orchestrationEnvironment.readAgentTranscriptPage, {
    label: "recover subagent transcript",
    reportFailure: false,
  });
  const previousConnectionPhase = useRef(connectionPhase);
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
    [setDiscardedHistoryCursor, setRecoveredEntries],
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
              environmentId,
              input: { threadId, agentKey, cursor },
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
        refreshNewestTranscriptPage();
      } catch {
        setCatchupIncomplete(true);
        setCatchupFailed(true);
      } finally {
        setCatchupPending(false);
      }
    },
    [
      agentKey,
      environmentId,
      readAgentTranscriptPage,
      refreshNewestTranscriptPage,
      retainRecoveredEntries,
      threadId,
    ],
  );
  const startGapCatchup = useCallback(
    async (watermark: number) => {
      setCatchupFailed(false);
      try {
        const result = await readAgentTranscriptPage({
          environmentId,
          input: { threadId, agentKey },
        });
        if (result._tag !== "Success") throw new Error("Transcript page read failed.");
        retainRecoveredEntries(result.value.entries, new Map(), result.value.nextCursor);
        const overlapsWatermark = result.value.entries.some(
          (entry) => entry.eventSequence <= watermark,
        );
        if (overlapsWatermark || result.value.nextCursor === null) {
          setCatchupCursor(null);
          setCatchupIncomplete(false);
          catchupTargetRef.current = null;
          setCatchupTarget(null);
          refreshNewestTranscriptPage();
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
      agentKey,
      environmentId,
      readAgentTranscriptPage,
      retainRecoveredEntries,
      refreshNewestTranscriptPage,
      runGapCatchup,
      threadId,
    ],
  );
  useEffect(() => {
    if (
      previousConnectionPhase.current !== undefined &&
      previousConnectionPhase.current !== "connected" &&
      connectionPhase === "connected"
    ) {
      const watermark = previousThreadWatermark.current;
      if (watermark === null) {
        refreshNewestTranscriptPage();
      } else {
        catchupTargetRef.current = watermark;
        setCatchupTarget(watermark);
        setCatchupIncomplete(false);
        void startGapCatchup(watermark);
      }
    }
    previousConnectionPhase.current = connectionPhase;
  }, [
    agentKey,
    connectionPhase,
    environmentId,
    refreshNewestTranscriptPage,
    startGapCatchup,
    threadId,
  ]);
  const page = pageResult._tag === "Success" ? pageResult.value : null;
  const newestPage = newestPageResult._tag === "Success" ? newestPageResult.value : null;
  useEffect(() => {
    if (connectionPhase === "connected" && newestPage) {
      previousThreadWatermark.current = newestPage.threadSequence;
    }
  }, [connectionPhase, newestPage]);
  const currentAgent = newestPage?.agent ?? page?.agent;
  const messageAgent = useAtomCommand(threadEnvironment.messageAgent, "message subagent");
  const stopAgent = useAtomCommand(threadEnvironment.stopAgent, "stop subagent");
  const [messageDraft, setMessageDraft] = useState("");
  const [actionPending, setActionPending] = useState<"message" | "stop" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    if (page === null) return;
    const retention = requestCursor === null ? "newest" : "oldest";
    // eslint-disable-next-line react/set-state-in-effect -- Synchronizes the local page window with the async transcript query.
    setEntries((current) =>
      mergeAgentTranscriptEntries(current, page.entries, undefined, retention),
    );
    setNextCursor(page.nextCursor);
    setHasMore(page.hasMore);
  }, [page, requestCursor]);

  const liveEntries = useMemo(
    () => agentTranscriptEntriesFromActivities(activities, agentKey),
    [activities, agentKey],
  );
  const visibleEntries = useMemo(
    () =>
      mergeAgentTranscriptPageWindows(
        entries,
        newestPage?.entries ?? EMPTY_AGENT_TRANSCRIPT_ENTRIES,
        liveEntries,
        recoveredEntries,
      ),
    [entries, liveEntries, newestPage, recoveredEntries],
  );
  const displayEntries = useMemo(
    () => groupAdjacentRunningStatuses(visibleEntries),
    [visibleEntries],
  );
  const childActivityWatermark = useMemo(
    () =>
      activities.reduce((watermark, activity) => {
        if (
          typeof activity.payload !== "object" ||
          activity.payload === null ||
          (activity.payload as Record<string, unknown>).agentKey !== agentKey
        ) {
          return watermark;
        }
        return Math.max(watermark, activity.eventSequence ?? activity.sequence ?? 0);
      }, 0),
    [activities, agentKey],
  );
  const previousChildActivityWatermark = useRef(childActivityWatermark);
  useEffect(() => {
    if (childActivityWatermark !== previousChildActivityWatermark.current) {
      previousChildActivityWatermark.current = childActivityWatermark;
      refreshNewestTranscriptPage();
    }
  }, [childActivityWatermark, refreshNewestTranscriptPage]);

  const submitMessage = async () => {
    const text = messageDraft.trim();
    if (!text || actionPending !== null) return;
    setActionPending("message");
    setActionError(null);
    const result = await messageAgent({
      environmentId,
      input: { threadId, agentKey, text },
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
    const result = await stopAgent({ environmentId, input: { threadId, agentKey } });
    if (result._tag === "Failure") {
      setActionError("Could not stop this child. Its live session may have changed.");
    }
    setActionPending(null);
  };
  const connected = connectionPhase === "connected";
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
  const canMessage = connected && currentAgent?.capabilities.message.state === "supported";
  const canStop = connected && currentAgent?.capabilities.stop.state === "supported";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Button size="icon-sm" variant="ghost-muted" onClick={onBack} aria-label="Back to agents">
          <ArrowLeft aria-hidden />
        </Button>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{agent.title}</span>
          <span className="block truncate text-[.7rem] text-muted-foreground">
            {currentAgent?.provider ?? "Provider pending"} · {agent.status}
            {parentTitle ? ` · nested under ${parentTitle}` : " · child of this thread"}
          </span>
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <AgentRequestControls
          environmentId={environmentId}
          threadId={threadId}
          agentKey={agentKey}
          activities={activities}
        />
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 p-3">
            {page?.completeness.state !== "complete" ? (
              <p className="rounded-md bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
                {page?.completeness.reason ??
                  "Transcript availability is not yet known for this agent."}
              </p>
            ) : null}
            {pageResult._tag === "Failure" ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                Could not load this agent transcript.
              </p>
            ) : null}
            {pageResult._tag === "Initial" || pageResult.waiting ? (
              <p className="text-xs text-muted-foreground">Loading transcript…</p>
            ) : null}
            {displayEntries.map((item) =>
              item.type === "running-status-group" ? (
                <AgentTranscriptRunningStatusGroup
                  key={item.entries[0]?.id ?? "running-status-group"}
                  entries={item.entries}
                />
              ) : item.entry.kind === "message" && item.entry.role !== "tool" ? (
                <AgentTranscriptMessage
                  key={item.entry.id}
                  entry={item.entry}
                  agentTitle={currentAgent?.title ?? agent.title}
                  markdownCwd={markdownCwd}
                  threadRef={threadRef}
                />
              ) : (
                <AgentTranscriptActivity key={item.entry.id} entry={item.entry} />
              ),
            )}
            {visibleEntries.length === 0 && pageResult._tag === "Success" ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No transcript entries are available for this agent.
              </p>
            ) : null}
            {catchupIncomplete ? (
              <div
                role="status"
                className="rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground"
              >
                {catchupFailed
                  ? "Reconnect catch-up failed. Some child activity may be missing."
                  : `Reconnect catch-up stopped before thread sequence ${catchupTarget ?? "the previous connection"}. Some child activity may be missing.`}
                {catchupCursor !== null || catchupFailed ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-2"
                    disabled={catchupPending}
                    onClick={continueCatchup}
                  >
                    {catchupPending
                      ? "Catching up…"
                      : catchupFailed
                        ? "Retry catch-up"
                        : "Continue catch-up"}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {discardedHistoryCursor !== null ? (
              <Button
                size="sm"
                variant="outline"
                disabled={catchupPending}
                onClick={browseDiscardedHistory}
              >
                Browse skipped history
              </Button>
            ) : null}
            {hasMore && nextCursor ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pageResult.waiting}
                onClick={() => setRequestCursor(nextCursor)}
              >
                Load earlier activity
              </Button>
            ) : null}
          </div>
        </ScrollArea>
      </div>
      {canMessage || canStop ? (
        <section
          className="flex flex-col gap-2 border-t border-border/60 px-3 py-3"
          aria-label="Subagent actions"
        >
          {canMessage ? (
            <form
              aria-label="Message this subagent"
              onSubmit={(event) => {
                event.preventDefault();
                void submitMessage();
              }}
            >
              <ComposerSurface.Shell className="max-w-none">
                <ComposerSurface.Host className="shadow-none">
                  <ComposerSurface.Main className="bg-background/70">
                    <div className="rounded-[20px]">
                      <label className="sr-only" htmlFor="subagent-message-input">
                        Message this subagent
                      </label>
                      <textarea
                        id="subagent-message-input"
                        aria-label="Message this subagent"
                        value={messageDraft}
                        maxLength={16_000}
                        rows={2}
                        disabled={actionPending !== null}
                        onChange={(event) => setMessageDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            !event.shiftKey &&
                            !event.nativeEvent.isComposing
                          ) {
                            event.preventDefault();
                            void submitMessage();
                          }
                        }}
                        placeholder={`Message ${currentAgent?.title ?? agent.title}…`}
                        className="block max-h-36 min-h-16 w-full resize-y rounded-[20px] bg-transparent px-3 pt-3 pb-1 text-sm leading-relaxed text-foreground placeholder:text-placeholder outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60"
                      />
                      <div className="flex items-center justify-end gap-2 px-3 pb-2">
                        <button
                          type="submit"
                          disabled={!messageDraft.trim() || actionPending !== null}
                          aria-label={
                            actionPending === "message"
                              ? "Sending message to this subagent"
                              : "Send message to this subagent"
                          }
                          aria-busy={actionPending === "message"}
                          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground transition-colors hover:bg-message-action-hover disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <ArrowUp aria-hidden className="size-4" />
                        </button>
                      </div>
                    </div>
                  </ComposerSurface.Main>
                </ComposerSurface.Host>
              </ComposerSurface.Shell>
            </form>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            {actionError ? (
              <p role="alert" className="min-w-0 flex-1 text-xs text-destructive-foreground">
                {actionError}
              </p>
            ) : canMessage ? (
              <span className="text-[.7rem] text-muted-foreground">
                Enter to send · Shift+Enter for a new line
              </span>
            ) : null}
            {canStop ? (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                aria-label="Stop subagent"
                disabled={actionPending !== null}
                onClick={() => void submitStop()}
              >
                {actionPending === "stop" ? "Stopping…" : "Stop subagent"}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
      <footer className="border-t border-border/60 px-3 py-2 text-[.7rem] text-muted-foreground">
        {canMessage
          ? "Messages appear in this agent's transcript."
          : (currentAgent?.capabilities.message.reason ??
            "Messaging is not verified for this provider session.")}
        {canStop
          ? " Stop targets this subagent only."
          : ` ${currentAgent?.capabilities.stop.reason ?? "Stop is not verified for this provider session."}`}
      </footer>
    </div>
  );
}

export function AgentsPanel({
  model,
  environmentId = null,
  threadId = null,
  markdownCwd,
  threadRef,
  activities = EMPTY_AGENT_ACTIVITIES,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  markdownCwd?: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  activities?: ReadonlyArray<OrchestrationThreadActivity>;
}) {
  const [selection, setSelection] = useState<{
    readonly agentKey: RuntimeAgentKey;
    readonly environmentId: EnvironmentId | null;
    readonly threadId: ThreadId | null;
  } | null>(null);
  const selectedAgentKey =
    selection?.environmentId === environmentId && selection.threadId === threadId
      ? selection.agentKey
      : null;
  const allAgents = useMemo(
    () => [
      ...model.directAgents,
      ...model.workflows.flatMap((group) => [group.workflow, ...workflowMembers(group)]),
    ],
    [model],
  );
  const selectedAgent = selectedAgentKey
    ? (allAgents.find((candidate) => candidate.agentKey === selectedAgentKey) ?? null)
    : null;
  const selectedParentTitle = selectedAgent?.parentAgentKey
    ? (allAgents.find((candidate) => candidate.agentKey === selectedAgent.parentAgentKey)?.title ??
      "Parent agent")
    : null;
  const selectAgent = (agent: RuntimeSubagent) => {
    if (agent.agentKey) {
      setSelection({ agentKey: agent.agentKey, environmentId, threadId });
    }
  };

  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents or runs a workflow, they show up here with live status,
          activity, and token usage.
        </p>
      </div>
    );
  }

  if (selectedAgent && selectedAgentKey !== null && environmentId !== null && threadId !== null) {
    return (
      <AgentDetailPanel
        key={selectedAgentKey}
        agent={selectedAgent}
        agentKey={selectedAgentKey}
        environmentId={environmentId}
        threadId={threadId}
        markdownCwd={markdownCwd}
        threadRef={threadRef}
        activities={activities}
        parentTitle={selectedParentTitle}
        onBack={() => setSelection(null)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-2">
          {model.workflows.map((group) => (
            <WorkflowSection
              key={group.workflow.id}
              group={group}
              environmentId={environmentId}
              threadId={threadId}
              onSelectAgent={selectAgent}
            />
          ))}
          {model.directAgents.length > 0 ? (
            <section>
              <div className="px-1.5 pt-1 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
                Direct spawns
              </div>
              {model.directAgents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} onSelect={selectAgent} />
              ))}
            </section>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
        <span className="flex items-center gap-2">
          {model.runningCount + model.waitingCount > 0 ? (
            <span className="text-info-foreground">
              ● {model.runningCount + model.waitingCount} working
            </span>
          ) : null}
          {model.idleCount > 0 ? <span>{model.idleCount} idle</span> : null}
          {model.settledCount > 0 ? <span>{model.settledCount} settled</span> : null}
        </span>
        <span className="tabular-nums">Σ {formatSubagentTokenCount(model.totalTokens)} tok</span>
      </footer>
    </div>
  );
}
