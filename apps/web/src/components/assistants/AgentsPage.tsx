import { assistantHomeTarget } from "@t3tools/client-runtime/state/assistants";
import type { AssistantSummary, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { WorkEmpty, WorkMeta, WorkRow, WorkSection } from "../work/WorkLayout";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  assistantAttentionCounts,
  assistantStatus,
} from "@t3tools/client-runtime/assistant-presentation";
import { AssistantToneBadge } from "./AssistantParts";
import { CreateAgentDialog } from "./CreateAgentDialog";
import {
  ROSTER_LIMIT,
  useAssistantConnection,
  useAssistantRoster,
  useCursorPages,
} from "./useAssistants";

export function AgentsPage({
  includeArchived,
  onIncludeArchivedChange,
}: {
  readonly includeArchived: boolean;
  readonly onIncludeArchivedChange: (includeArchived: boolean) => void;
}) {
  const { environments, isReady } = useEnvironments();
  const [creatingIn, setCreatingIn] = useState<EnvironmentId | null>(null);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Agents breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current>
              <h1>Agents</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="flex shrink-0 items-center gap-2">
            <Switch
              id="agents-show-archived"
              checked={includeArchived}
              onCheckedChange={(checked) => onIncludeArchivedChange(Boolean(checked))}
            />
            <Label htmlFor="agents-show-archived">Show archived</Label>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer className="gap-6">
            {environments.length === 0 ? (
              <WorkSection title="No environments">
                <WorkEmpty
                  title={isReady ? "Connect an environment" : "Loading environments…"}
                  {...(isReady
                    ? { detail: "Agents live on an environment. Pair one to create agents there." }
                    : {})}
                />
              </WorkSection>
            ) : (
              environments.map((environment) => (
                // The archive filter is part of the key so changing it starts again at the first page.
                <EnvironmentRoster
                  key={`${environment.environmentId}:${includeArchived}`}
                  environment={environment}
                  includeArchived={includeArchived}
                  onCreate={() => setCreatingIn(environment.environmentId)}
                />
              ))
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {creatingIn !== null ? (
        <CreateAgentDialog
          key={creatingIn}
          environmentId={creatingIn}
          onClose={() => setCreatingIn(null)}
        />
      ) : null}
    </SidebarInset>
  );
}

function EnvironmentRoster({
  environment,
  includeArchived,
  onCreate,
}: {
  readonly environment: EnvironmentPresentation;
  readonly includeArchived: boolean;
  readonly onCreate: () => void;
}) {
  const environmentId = environment.environmentId;
  const pages = useCursorPages();
  const roster = useAssistantRoster(environmentId, includeArchived, pages.cursor);
  const connection = useAssistantConnection(environmentId);
  const assistants = roster.data?.assistants ?? [];
  const nextCursor = roster.data?.nextCursor ?? null;
  return (
    <WorkSection
      title={
        <span className="flex items-center gap-2">
          {environment.label}
          {connection.connected ? null : <Badge variant="warning">Offline</Badge>}
        </span>
      }
      description={
        connection.connected
          ? pages.hasPrevious || nextCursor !== null
            ? `${ROSTER_LIMIT} agents per page.`
            : undefined
          : "Showing what was last known. Nothing here is current until it reconnects."
      }
      actions={
        <>
          {pages.hasPrevious || nextCursor !== null ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={!pages.hasPrevious}
                onClick={pages.previous}
              >
                Previous
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={nextCursor === null}
                onClick={() => pages.next(nextCursor)}
              >
                Next
              </Button>
            </>
          ) : null}
          <Button size="xs" variant="outline" disabled={!connection.connected} onClick={onCreate}>
            <PlusIcon />
            New agent
          </Button>
        </>
      }
    >
      {roster.data === null ? (
        <WorkEmpty
          title={
            roster.error !== null
              ? "Agents aren't available here"
              : connection.connected
                ? "Loading agents…"
                : "Offline"
          }
          {...(roster.error !== null
            ? { detail: "This environment may need a newer T3 Code server." }
            : {})}
        />
      ) : assistants.length === 0 ? (
        <WorkEmpty
          title="No agents yet"
          detail="An agent has its own chat, rules, model, tools and memory. Creating one never starts a run."
        />
      ) : (
        assistants.map((assistant) => (
          <AgentRosterRow
            key={assistant.assistantId}
            assistant={assistant}
            connected={connection.connected}
          />
        ))
      )}
    </WorkSection>
  );
}

function AgentRosterRow({
  assistant,
  connected,
}: {
  readonly assistant: AssistantSummary;
  readonly connected: boolean;
}) {
  const navigate = useNavigate();
  const status = assistantStatus({ connected, summary: assistant });
  const counts = assistantAttentionCounts(assistant);
  const home = assistantHomeTarget(assistant.binding);
  return (
    <WorkRow className="sm:flex-row sm:items-center sm:gap-3">
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() =>
          void navigate({
            to: "/agents/$environmentId/$assistantId",
            params: { environmentId: assistant.environmentId, assistantId: assistant.assistantId },
            search: { section: "overview" },
          })
        }
      >
        <span className="flex min-w-0 max-w-full items-center gap-2">
          <span className="truncate text-sm font-medium">{assistant.name}</span>
          <AssistantToneBadge tone={status.tone}>{status.label}</AssistantToneBadge>
        </span>
        <WorkMeta>
          {[status.detail, ...(connected ? counts : [])].filter(Boolean).join(" · ") ||
            "No active runs"}
        </WorkMeta>
      </button>
      <Button
        size="xs"
        variant="outline"
        disabled={assistant.provisioningState !== "ready"}
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: home.environmentId, threadId: home.threadId },
          })
        }
      >
        Open chat
      </Button>
    </WorkRow>
  );
}
