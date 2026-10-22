import {
  assistantHomeTarget,
  prepareAssistantLifecycleMutation,
  prepareAssistantStop,
  type AssistantSelection,
} from "@t3tools/client-runtime/state/assistants";
import {
  CommandId,
  UnknownUnionMember,
  type AssistantDetail,
  type AssistantId,
  type AssistantLifecycleInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { AGENT_SECTIONS, type AgentSection } from "../../routes/-agentsSearch";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { assistantsEnvironment } from "../../state/assistants";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkEmpty,
  WorkFormStatus,
  WorkMeta,
  WorkRevision,
  WorkRow,
  WorkSection,
  WorkTime,
} from "../work/WorkLayout";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AgentConfiguration } from "./AgentConfiguration";
import { AgentMemory } from "./AgentMemory";
import { AgentRoutines } from "./AgentRoutines";
import {
  assistantAttentionCounts,
  assistantHasStoppableWork,
  assistantRunStatus,
  assistantStatus,
  currentAssistantSelection,
} from "@t3tools/client-runtime/assistant-presentation";
import { AssistantToneBadge } from "./AssistantParts";
import {
  newAssistantCommandId,
  useAssistantConnection,
  useAssistantDetail,
  useAssistantRoster,
  useAssistantWriter,
  type AssistantWriter,
} from "./useAssistants";

const SECTION_LABELS: Record<AgentSection, string> = {
  overview: "Overview",
  activity: "Activity",
  configuration: "Configuration",
  memory: "Memory",
  routines: "Routines",
};

/** Everything a section needs to act on the agent exactly as it was shown. */
export interface AgentContext {
  readonly environmentId: EnvironmentId;
  readonly detail: AssistantDetail;
  readonly connected: boolean;
  readonly epoch: string | null;
  readonly selection: AssistantSelection | null;
  /** The newest selection, read after a confirmation so a change during it is caught. */
  readonly latestSelection: () => AssistantSelection | null;
  readonly writer: AssistantWriter;
}

export function AgentDetailPage({
  environmentId,
  assistantId,
  section,
  onSectionChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly assistantId: AssistantId;
  readonly section: AgentSection;
  readonly onSectionChange: (section: AgentSection) => void;
}) {
  const environment = useEnvironment(environmentId);
  // The roster stream is what invalidates this detail when another client changes it.
  useAssistantRoster(environmentId, true);
  const detailQuery = useAssistantDetail(environmentId, assistantId);
  const connection = useAssistantConnection(environmentId);
  const writer = useAssistantWriter(environmentId);
  const detail = detailQuery.data;
  const selection = currentAssistantSelection(detail, connection.epoch);
  const latest = useRef(selection);
  useEffect(() => {
    latest.current = selection;
  });

  const header = (
    <WorkspacePageHeader electron={isElectron}>
      <WorkspaceBreadcrumb ariaLabel="Agent breadcrumb" className="min-w-0 flex-1">
        <WorkspaceBreadcrumbItem>
          <Link to="/agents" className="text-muted-foreground hover:text-foreground">
            Agents
          </Link>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-0">
          <h1 className="truncate">{detail?.summary.name ?? "Agent"}</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {environment ? (
        <Badge variant={connection.connected ? "secondary" : "warning"} className="shrink-0">
          {environment.label}
          {connection.connected ? "" : " · offline"}
        </Badge>
      ) : null}
    </WorkspacePageHeader>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {header}
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer className="gap-5">
            {detail === null ? (
              <WorkSection title="Agent">
                <WorkEmpty
                  title={
                    detailQuery.error !== null
                      ? "This agent isn't available"
                      : connection.connected
                        ? "Loading agent…"
                        : "Offline"
                  }
                  {...(detailQuery.error !== null
                    ? {
                        detail:
                          "It may have been removed, or this connection can't read agents here.",
                      }
                    : {})}
                />
              </WorkSection>
            ) : (
              <>
                <ToggleGroup
                  aria-label="Agent sections"
                  value={[section]}
                  onValueChange={(next) => {
                    const value = next[0];
                    if (AGENT_SECTIONS.some((candidate) => candidate === value))
                      onSectionChange(value as AgentSection);
                  }}
                >
                  {AGENT_SECTIONS.map((value) => (
                    <Toggle key={value} value={value}>
                      {SECTION_LABELS[value]}
                    </Toggle>
                  ))}
                </ToggleGroup>
                <AgentSectionContent
                  section={section}
                  context={{
                    environmentId,
                    detail,
                    connected: connection.connected,
                    epoch: connection.epoch,
                    selection,
                    latestSelection: () => latest.current,
                    writer,
                  }}
                />
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function AgentSectionContent({
  section,
  context,
}: {
  readonly section: AgentSection;
  readonly context: AgentContext;
}) {
  switch (section) {
    case "overview":
      return <AgentOverview context={context} />;
    case "activity":
      return <AgentActivity context={context} />;
    case "configuration":
      return (
        // A reconnect or saved revision remounts nothing; the form decides what is stale.
        <AgentConfiguration context={context} />
      );
    case "memory":
      return <AgentMemory context={context} />;
    case "routines":
      return <AgentRoutines context={context} />;
  }
}

/** Why an action is unavailable right now, or null. */
export function agentBlockedReason(context: AgentContext, allowed: boolean): string | null {
  if (!context.connected || context.selection === null) return "Reconnect to make changes.";
  if (!allowed) return "This connection isn't allowed to do that.";
  return null;
}

const LIFECYCLE_COPY: Record<
  AssistantLifecycleInput["action"],
  { readonly label: string; readonly confirm?: string; readonly destructive?: boolean }
> = {
  disable: {
    label: "Disable",
    confirm:
      "Disable this agent? Routines and queued messages won't start new runs until you enable it. Work already running continues until you stop it.",
  },
  enable: { label: "Enable" },
  archive: {
    label: "Archive",
    destructive: true,
    confirm:
      "Archive this agent? It stops admitting new runs and routines. Its chat and memory are kept, and you can restore it later. Work already running continues until you stop it.",
  },
  restore: {
    label: "Restore",
    confirm:
      "Restore this agent? Its chat and memory come back. Routines stay paused until you turn them on.",
  },
  "retry-provisioning": { label: "Retry setup" },
};

function AgentOverview({ context }: { readonly context: AgentContext }) {
  const navigate = useNavigate();
  const { detail, writer } = context;
  const summary = detail.summary;
  const status = assistantStatus({ connected: context.connected, summary });
  const counts = assistantAttentionCounts(summary);
  // A newer server's provisioning state stays visible by name rather than failing the page.
  const provisioning =
    detail.provisioning instanceof UnknownUnionMember
      ? { state: "unknown" as const, value: detail.provisioning.value }
      : detail.provisioning;
  const home = assistantHomeTarget(summary.binding);
  const lifecycleBlocked = agentBlockedReason(context, writer.permissions.lifecycle);
  const stopBlocked = agentBlockedReason(context, writer.permissions.stop);
  // A retry of an unconfirmed Stop reuses its ID; once one is accepted, the next Stop is new work.
  const [stopCommandId, setStopCommandId] = useState(() => CommandId.make(newAssistantCommandId()));

  const lifecycle = async (action: AssistantLifecycleInput["action"]) => {
    const selected = context.selection;
    if (selected === null) return;
    const copy = LIFECYCLE_COPY[action];
    if (copy.confirm) {
      const confirmed = await requestConfirmDialog(copy.confirm, {
        variant: copy.destructive ? "destructive" : "default",
      });
      if (confirmed !== true) return;
    }
    const current = context.latestSelection();
    await writer.run(
      "lifecycle",
      assistantsEnvironment.lifecycle,
      current === null
        ? null
        : prepareAssistantLifecycleMutation({
            selected,
            current,
            commandId: CommandId.make(newAssistantCommandId()),
            action,
          }),
    );
  };

  const stop = async () => {
    const selected = context.selection;
    if (selected === null) return;
    const confirmed = await requestConfirmDialog(
      "Stop this agent's current work? Queued and running turns in its chat are stopped. If a provider can't confirm the stop, it stays marked uncertain.",
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    const current = context.latestSelection();
    const prepared =
      current === null
        ? null
        : prepareAssistantStop({ selected, current, commandId: stopCommandId });
    const result = await writer.run("stop", assistantsEnvironment.stop, prepared?.input ?? null);
    if (result !== null) setStopCommandId(CommandId.make(newAssistantCommandId()));
  };

  const lifecycleButtons: ReadonlyArray<AssistantLifecycleInput["action"]> =
    summary.lifecycle === "archived"
      ? ["restore"]
      : summary.lifecycle === "disabled"
        ? ["enable", "archive"]
        : ["disable", "archive"];

  return (
    <>
      <WorkSection
        title="Status"
        actions={
          <Button
            size="xs"
            variant="outline"
            disabled={provisioning.state !== "ready"}
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: home.environmentId, threadId: home.threadId },
              })
            }
          >
            Open chat
          </Button>
        }
      >
        <WorkRow>
          <div className="flex flex-wrap items-center gap-2">
            <AssistantToneBadge tone={status.tone}>{status.label}</AssistantToneBadge>
            <WorkMeta>
              Configuration <WorkRevision>r{summary.configurationRevision}</WorkRevision>
            </WorkMeta>
          </div>
          {status.detail ? <WorkMeta>{status.detail}</WorkMeta> : null}
          {context.connected && counts.length > 0 ? (
            <WorkMeta>{counts.join(" · ")}</WorkMeta>
          ) : null}
        </WorkRow>
        {provisioning.state === "failed" || provisioning.state === "needs-repair" ? (
          <WorkRow>
            <p className="text-sm">
              {provisioning.state === "failed" ? "Setup failed" : "Needs repair"}
            </p>
            {"reason" in provisioning ? <WorkMeta>{provisioning.reason}</WorkMeta> : null}
            {provisioning.state === "failed" && provisioning.retryable ? (
              <div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={lifecycleBlocked !== null || writer.pendingKey !== null}
                  onClick={() => void lifecycle("retry-provisioning")}
                >
                  Retry setup
                </Button>
              </div>
            ) : null}
          </WorkRow>
        ) : provisioning.state === "provisioning" ? (
          <WorkRow>
            <WorkMeta>Setting up its workspace ({provisioning.stage}).</WorkMeta>
          </WorkRow>
        ) : provisioning.state === "unknown" ? (
          <WorkRow>
            <WorkMeta>Setup state: {provisioning.value}</WorkMeta>
          </WorkRow>
        ) : null}
      </WorkSection>

      <WorkSection
        title="Lifecycle"
        description="Changing the lifecycle never starts a run. History and memory are kept."
      >
        <WorkRow>
          <div className="flex flex-wrap gap-2">
            {lifecycleButtons.map((action) => (
              <Button
                key={action}
                size="xs"
                variant={LIFECYCLE_COPY[action].destructive ? "destructive-outline" : "outline"}
                disabled={lifecycleBlocked !== null || writer.pendingKey !== null}
                onClick={() => void lifecycle(action)}
              >
                {LIFECYCLE_COPY[action].label}
              </Button>
            ))}
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={
                stopBlocked !== null ||
                writer.pendingKey !== null ||
                !assistantHasStoppableWork(summary)
              }
              onClick={() => void stop()}
            >
              Stop current work
            </Button>
          </div>
          <WorkFormStatus
            message={
              writer.failureFor("lifecycle") ?? writer.failureFor("stop") ?? lifecycleBlocked
            }
            {...((writer.failureFor("lifecycle") ?? writer.failureFor("stop"))
              ? {}
              : { tone: "muted" as const })}
          />
        </WorkRow>
      </WorkSection>

      <WorkSection title="Workspace">
        <WorkRow>
          <WorkMeta>
            The agent works in its own backing workspace on {summary.environmentId}. It is a
            workspace, not a sandbox: the agent's permissions follow its runtime mode.
          </WorkMeta>
          <WorkMeta>
            Created <WorkTime value={summary.createdAt} /> · updated{" "}
            <WorkTime value={summary.updatedAt} />
          </WorkMeta>
        </WorkRow>
      </WorkSection>
    </>
  );
}

const ACTIVITY_PAGE = 25;

function AgentActivity({ context }: { readonly context: AgentContext }) {
  const { environmentId, detail } = context;
  const assistantId = detail.summary.assistantId;
  // Older pages are reached by cursor; only the current page is held.
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const cursor = cursors.at(-1);
  const activity = useEnvironmentQuery(
    assistantsEnvironment.activity({
      environmentId,
      input: {
        environmentId,
        assistantId,
        limit: ACTIVITY_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  );
  const runs = activity.data?.runs ?? [];
  const nextCursor = activity.data?.nextCursor ?? null;
  return (
    <WorkSection
      title="Activity"
      description="Runs started from the agent's chat and routines. A sent message counts as finished only when its run completes."
      actions={
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={cursors.length === 0}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Newer
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={nextCursor === null}
            onClick={() => {
              if (nextCursor !== null) setCursors((current) => [...current, nextCursor]);
            }}
          >
            Older
          </Button>
        </>
      }
    >
      {activity.data === null ? (
        <WorkEmpty
          title={activity.error !== null ? "Activity isn't available" : "Loading activity…"}
        />
      ) : runs.length === 0 ? (
        <WorkEmpty title="No runs yet" detail="Send a message in the agent's chat to start one." />
      ) : (
        runs.map((run) => {
          const status = assistantRunStatus(run);
          return (
            <WorkRow key={`${run.commandId}:${run.runId ?? "dispatch"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <AssistantToneBadge tone={status.tone}>{status.label}</AssistantToneBadge>
                <WorkMeta>
                  {run.scheduledTaskId === null ? "Chat" : "Routine"} · configuration{" "}
                  <WorkRevision>r{run.configurationRevision}</WorkRevision>
                </WorkMeta>
              </div>
              <WorkMeta>
                <WorkTime value={run.updatedAt} />
                {run.runId === null ? null : (
                  <>
                    {" · run "}
                    <WorkRevision>{run.runId.slice(0, 12)}</WorkRevision>
                  </>
                )}
              </WorkMeta>
            </WorkRow>
          );
        })
      )}
    </WorkSection>
  );
}
