import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ProjectWorkTaskId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import {
  BookOpenIcon,
  BrainIcon,
  FileCheckIcon,
  InboxIcon,
  ListTodoIcon,
  PanelTopIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useCallback, useContext, useRef } from "react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { projectWorkStreamAvailable } from "@t3tools/client-runtime/project-work";

import { isElectron } from "../../env";
import { useEnvironment } from "../../state/environments";
import { useProject } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkKnowledge } from "./WorkKnowledge";
import { WorkOverview } from "./WorkOverview";
import { WorkTasks } from "./WorkTasks";
import { projectWorkEnvironment } from "../../state/projectWork";
import { type WorkTab } from "./workPresentation";
import { Team } from "../../features/projectTeams/Team";
import { Inbox } from "../../features/projectTeams/Inbox";
import { Memory } from "../../features/projectTeams/Memory";
import { Evidence } from "../../features/projectTeams/Evidence";
import { WorkSupervisionSource } from "./WorkSupervisionSource";

import { createGuidedTaskDraftState, type GuidedTaskDraftStore } from "./guidedTaskDraft";

const TAB_ITEMS: ReadonlyArray<{
  readonly id: WorkTab;
  readonly label: string;
  readonly icon: typeof PanelTopIcon;
}> = [
  { id: "overview", label: "Overview", icon: PanelTopIcon },
  { id: "supervision", label: "Supervision", icon: UsersIcon },
  { id: "tasks", label: "Tasks", icon: ListTodoIcon },
  { id: "team", label: "Team", icon: UsersIcon },
  { id: "inbox", label: "Inbox", icon: InboxIcon },
  { id: "knowledge", label: "Knowledge", icon: BookOpenIcon },
  { id: "memory", label: "Memory", icon: BrainIcon },
  { id: "evidence", label: "Evidence", icon: FileCheckIcon },
];

export interface WorkPageSelection {
  readonly tab: WorkTab;
  readonly taskId?: ProjectWorkTaskId;
}

interface WorkPageProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly selection?: WorkPageSelection;
  readonly onSelectionChange?: (selection: WorkPageSelection) => void;
}

export function WorkPage({
  environmentId,
  projectId,
  selection,
  onSelectionChange,
}: WorkPageProps) {
  return (
    <ProjectWorkPage
      key={JSON.stringify([environmentId, projectId])}
      environmentId={environmentId}
      projectId={projectId}
      {...(selection ? { selection } : {})}
      {...(onSelectionChange ? { onSelectionChange } : {})}
    />
  );
}

function ProjectWorkPage({
  environmentId,
  projectId,
  selection,
  onSelectionChange,
}: WorkPageProps) {
  const registry = useContext(RegistryContext);
  const verifyVerificationAccess = useCallback(() => {
    const presentation = registry.get(environmentPresentations.presentationAtom(environmentId));
    const config = registry.get(serverEnvironment.configValueAtom(environmentId));
    if (
      presentation?.entry.target.environmentId !== environmentId ||
      presentation.entry.enabled !== true ||
      presentation.connection.phase !== "connected" ||
      config?.settings.projectWorkEnabled !== true ||
      config.environment?.capabilities?.projectTeamFoundationReads !== true ||
      config.environment?.capabilities?.projectTeamGuidedWrites !== true
    )
      throw {
        code: "unavailable",
        message:
          "Reconnect and refresh current verification access before preparing or responding.",
      };
  }, [environmentId, registry]);
  const environment = useEnvironment(environmentId);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [draftSnapshot, draftsChanged] = useState(createGuidedTaskDraftState);
  const draftState = useRef(draftSnapshot);
  const verificationDrafts = useMemo<GuidedTaskDraftStore>(
    () => ({
      snapshot: draftSnapshot,
      read: () => draftState.current,
      write: (state) => {
        draftState.current = state;
        draftsChanged(state);
      },
    }),
    [draftSnapshot],
  );
  const [localTab, setTab] = useState<WorkTab>("overview");
  const [inboxVisited, setInboxVisited] = useState(selection?.tab === "inbox");
  const [localTargetTask, setTargetTask] = useState<ProjectWorkTaskId | undefined>();
  const tab = selection?.tab ?? localTab;
  const targetTask = selection ? selection.taskId : localTargetTask;
  if (tab === "inbox" && !inboxVisited) setInboxVisited(true);
  const selectTab = (nextTab: WorkTab) => {
    if (onSelectionChange) {
      onSelectionChange({
        tab: nextTab,
        ...(nextTab === "tasks" && targetTask ? { taskId: targetTask } : {}),
      });
    } else setTab(nextTab);
  };
  const openTask = (taskId: ProjectWorkTaskId) => {
    if (onSelectionChange) {
      onSelectionChange({ tab: "tasks", taskId });
      return;
    }
    setTargetTask(taskId);
    setTab("tasks");
  };
  const connected = environment?.connection.phase === "connected";
  const enabled = serverConfig?.settings.projectWorkEnabled === true;
  const streamCapable = serverConfig?.environment?.capabilities?.projectWorkStream === true;
  const streamAvailable = projectWorkStreamAvailable({
    capability: serverConfig?.environment?.capabilities?.projectWorkStream,
    connectionPhase: environment?.connection.phase ?? "disconnected",
  });
  const projectTitle = project?.title ?? String(projectId);
  const cursorRef = useRef(0);
  const [resumeCursor, setResumeCursor] = useState(0);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [poll, setPoll] = useState(true);

  const onStreamState = useCallback(
    (state: { cursor: number; healthy: boolean; resyncRequired: boolean } | null) => {
      if (state === null) {
        setPoll(true);
        return;
      }
      if (state.resyncRequired) {
        // A resync marker can move backwards after retention or a server
        // restore. Resume from the server's exact lower authoritative cursor.
        cursorRef.current = state.cursor;
        setPoll(true);
        setResumeCursor(state.cursor);
        setStreamGeneration((value) => value + 1);
      } else if (state.healthy) {
        cursorRef.current = Math.max(cursorRef.current, state.cursor);
        setPoll(false);
      } else {
        cursorRef.current = Math.max(cursorRef.current, state.cursor);
      }
    },
    [],
  );

  useEffect(() => {
    if (!connected) setResumeCursor(cursorRef.current);
    else if (streamCapable) setPoll(true);
  }, [connected, streamCapable]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm text-muted-foreground">Work</span>
          <span className="text-muted-foreground/50">/</span>
          <h1 className="truncate text-sm font-medium">{projectTitle}</h1>
          {!connected ? <Badge variant="warning">Offline view</Badge> : null}
        </div>
      </WorkspacePageHeader>
      <WorkspacePageContainer width="expanded" className="min-h-0 flex-1 gap-4 overflow-y-auto">
        {!enabled ? (
          <WorkDisabledState />
        ) : (
          <>
            {streamAvailable ? (
              <ProjectWorkStreamBridge
                key={`${environmentId}:${projectId}:${streamGeneration}`}
                environmentId={environmentId}
                projectId={projectId}
                afterCursor={resumeCursor}
                onState={onStreamState}
              />
            ) : null}
            <div>
              <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
                Project workspace
              </p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight">Work</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Keep the current objective, durable tasks, and project knowledge in one place.
              </p>
            </div>
            <nav
              className="flex min-w-0 gap-1 overflow-x-auto border-b border-border/70"
              aria-label="Work sections"
            >
              {TAB_ITEMS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className={`inline-flex h-9 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors ${
                    tab === id
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => {
                    if (id === "inbox") setInboxVisited(true);
                    selectTab(id);
                  }}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              ))}
            </nav>
            {tab === "overview" ? (
              <WorkOverview
                environmentId={environmentId}
                projectId={projectId}
                connected={connected}
                streamAvailable={!poll}
              />
            ) : tab === "supervision" ? (
              <ProjectSupervision
                environmentId={environmentId}
                projectId={projectId}
                title={projectTitle}
                connected={connected}
                enabled={enabled}
                supported={
                  serverConfig?.environment?.capabilities?.projectTeamSupervisionReads === true
                }
                onOpenTask={openTask}
                onInspectProject={() => selectTab("team")}
              />
            ) : tab === "tasks" ? (
              <WorkTasks
                verifyVerificationAccess={verifyVerificationAccess}
                verificationDrafts={verificationDrafts}
                key={`${environmentId}:${projectId}:tasks`}
                environmentId={environmentId}
                projectId={projectId}
                connected={connected}
                enabled={enabled}
                streamAvailable={!poll}
                teamReadSupported={
                  serverConfig?.environment?.capabilities?.projectTeamFoundationReads === true
                }
                guidedWritesSupported={
                  serverConfig?.environment?.capabilities?.projectTeamGuidedWrites === true
                }
                {...(targetTask ? { targetTaskId: targetTask } : {})}
              />
            ) : tab === "team" ? (
              <Team
                environmentId={environmentId}
                projectId={projectId}
                connected={connected}
                enabled={enabled}
                supported={
                  serverConfig?.environment?.capabilities?.projectTeamFoundationReads === true
                }
                onOpenTask={openTask}
              />
            ) : tab === "memory" ? (
              <Memory
                environmentId={environmentId}
                projectId={projectId}
                connected={connected}
                enabled={enabled}
                supported={
                  serverConfig?.environment?.capabilities?.projectTeamFoundationReads === true
                }
                writesSupported={
                  serverConfig?.environment?.capabilities?.projectTeamMemoryRetractions === true
                }
              />
            ) : tab === "evidence" ? (
              <Evidence
                environmentId={environmentId}
                projectId={projectId}
                connected={connected}
                enabled={enabled}
                supported={
                  serverConfig?.environment?.capabilities?.projectTeamFoundationReads === true
                }
                onOpenTask={openTask}
              />
            ) : tab === "inbox" ? null : (
              <WorkKnowledge
                key={`${environmentId}:${projectId}:knowledge`}
                environmentId={environmentId}
                projectId={projectId}
                connected={connected}
                canWrite={enabled && connected}
                streamAvailable={!poll}
              />
            )}
            {tab === "inbox" || inboxVisited ? (
              <div hidden={tab !== "inbox"}>
                <Inbox
                  poll={poll}
                  environmentId={environmentId}
                  projectId={projectId}
                  connected={connected}
                  enabled={enabled}
                  supported={
                    serverConfig?.environment?.capabilities?.projectTeamFoundationReads === true
                  }
                  writesSupported={
                    serverConfig?.environment?.capabilities?.projectTeamGuidedWrites === true
                  }
                  onOpenTask={openTask}
                />
              </div>
            ) : null}
          </>
        )}
      </WorkspacePageContainer>
    </SidebarInset>
  );
}

function ProjectSupervision({
  environmentId,
  projectId,
  onOpenTask,
  onInspectProject,
  ...props
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
  readonly onInspectProject: () => void;
}) {
  const navigate = useNavigate();
  const owns = (target: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId }) =>
    target.environmentId === environmentId && target.projectId === projectId;
  return (
    <WorkSupervisionSource
      {...props}
      environmentId={environmentId}
      projectId={projectId}
      onOpenTask={(target) => {
        if (owns(target)) onOpenTask(ProjectWorkTaskId.make(target.taskId));
      }}
      onOpenWorker={(target) => {
        if (owns(target))
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: target.threadId },
          });
      }}
      onInspectProject={(target) => {
        if (owns(target)) onInspectProject();
      }}
    />
  );
}

function ProjectWorkStreamBridge({
  environmentId,
  projectId,
  afterCursor,
  onState,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly afterCursor: number;
  readonly onState: (
    state: { cursor: number; healthy: boolean; resyncRequired: boolean } | null,
  ) => void;
}) {
  const result = useAtomValue(
    projectWorkEnvironment.stream({ environmentId, projectId, afterCursor }),
  );
  const state = Option.getOrNull(AsyncResult.value(result));
  useEffect(() => {
    if (result._tag === "Failure") onState(null);
    else if (state !== null) onState(state);
  }, [onState, result._tag, state]);
  return null;
}

function WorkDisabledState() {
  return (
    <div className="flex min-h-72 flex-1 items-center justify-center">
      <div className="max-w-md rounded-2xl border border-border/70 bg-card/45 p-8 text-center shadow-sm/5">
        <h2 className="text-lg font-semibold">Project Work is turned off</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Enable the project-work setting on this environment to use durable tasks and knowledge.
          Existing records remain stored while the feature is off.
        </p>
      </div>
    </div>
  );
}
