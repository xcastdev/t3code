import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isProjectTerminalRunning,
  projectTerminalStatusLabel,
} from "@t3tools/client-runtime/project-terminal-view";
import { ThreadId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { TerminalSquareIcon } from "lucide-react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useProjectTerminalDock } from "../../state/projectTerminals";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ProjectTerminalViewer } from "./ProjectTerminalViewer";

/**
 * Terminals a project owns, usually started by agents through the terminal
 * tools. This page only discovers and attaches; there is no client spawn.
 */
export function ProjectTerminalsPage({
  environmentId,
  projectId,
  terminalId,
  onSelectTerminal,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly terminalId: string | undefined;
  readonly onSelectTerminal: (terminalId: string | undefined) => void;
}) {
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const environment = useEnvironment(environmentId);
  const dock = useProjectTerminalDock(environmentId, projectId);
  const phase = environment?.connection.phase ?? "disconnected";
  const selected =
    dock.terminals.find((terminal) => terminal.terminalId === terminalId) ??
    (terminalId === undefined ? dock.terminals[0] : undefined) ??
    null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Project terminals breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem>
              <h1>Project terminals</h1>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-0">
              <span className="truncate">{project?.title ?? "Project"}</span>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {environment ? (
            <Badge variant={phase === "connected" ? "secondary" : "warning"} className="shrink-0">
              {environment.label}
              {phase === "connected" ? "" : " · offline"}
            </Badge>
          ) : null}
        </WorkspacePageHeader>
        <WorkspacePageContainer width="expanded" className="min-h-0 flex-1 gap-4 overflow-hidden">
          {dock.error !== null ? (
            <div className="flex items-center gap-3 text-sm">
              <p role="alert" className="text-destructive-foreground">
                {dock.error}
              </p>
              <Button size="xs" variant="outline" onClick={dock.retry}>
                Retry
              </Button>
            </div>
          ) : null}
          {!dock.received && dock.error === null ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-3.5" /> Looking for project terminals…
            </p>
          ) : null}
          {dock.received && dock.terminals.length === 0 ? (
            <div className="rounded-xl border border-border/60 bg-card/40 px-4 py-6 text-sm text-muted-foreground">
              No project terminals are running or recently exited. Agents start them with the
              terminal tools, for things like dev servers and watchers; they appear here so you can
              watch, type into or stop them.
            </div>
          ) : null}
          {dock.terminals.length > 0 ? (
            <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
              <nav
                aria-label="Project terminals"
                className="flex shrink-0 gap-1 overflow-x-auto md:w-60 md:flex-col md:overflow-y-auto"
              >
                {dock.terminals.map((terminal) => (
                  <TerminalListRow
                    key={terminal.terminalId}
                    environmentId={environmentId}
                    terminal={terminal}
                    selected={selected?.terminalId === terminal.terminalId}
                    onSelect={() => onSelectTerminal(terminal.terminalId)}
                  />
                ))}
                {dock.truncated ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    Showing the first 100 terminals.
                  </p>
                ) : null}
              </nav>
              {selected ? (
                <ProjectTerminalViewer
                  key={`${environmentId}:${selected.projectId}:${selected.terminalId}`}
                  environmentId={environmentId}
                  summary={selected}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  That terminal isn't in this project anymore. Choose another.
                </p>
              )}
            </div>
          ) : null}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}

function TerminalListRow({
  environmentId,
  terminal,
  selected,
  onSelect,
}: {
  environmentId: EnvironmentId;
  terminal: Parameters<typeof projectTerminalStatusLabel>[0] & {
    readonly terminalId: string;
    readonly label: string;
    readonly creatingThreadId: string;
  };
  selected: boolean;
  onSelect: () => void;
}) {
  const creator = useThreadShell({
    environmentId,
    threadId: ThreadId.make(terminal.creatingThreadId),
  });
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
      className={cn(
        "flex min-w-48 items-start gap-2 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:min-w-0",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <TerminalSquareIcon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          isProjectTerminalRunning(terminal.status) ? "text-success" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0">
        <span className="block truncate text-sm">{terminal.label || terminal.terminalId}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {projectTerminalStatusLabel(terminal)}
        </span>
        {creator ? (
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: creator.id }}
            className="block truncate text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            Started in {creator.title}
          </Link>
        ) : null}
      </span>
    </button>
  );
}
