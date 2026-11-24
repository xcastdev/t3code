import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ProjectId,
  ProviderInstanceId,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";

import type { ComposerThreadTarget, DraftId } from "../../composerDraftStore";
import { type EnvMode } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import BaseGitActionsControl, { useChangesTotals } from "../GitActionsControl";
import { GitBranchIcon, SlidersHorizontalIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { lazy, memo, Suspense, useState, type ComponentProps, type MouseEvent } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { useProject, useServerConfigs } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { ThreadDetailsThreadPrRows } from "./ThreadDetailsPrRows";
import { cn } from "../../lib/utils";
import { Menu, MenuPopup } from "../ui/menu";
import {
  ThreadDetailsAgentActivitySection,
  ThreadDetailsAgentRoutinesSection,
  ThreadDetailsAgentStatusSection,
  type ThreadDetailsAgent,
} from "./ThreadDetailsAgentSections";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsItemsMenuItems } from "./ThreadDetailsItemsMenu";
import {
  ThreadDetailsAutoCollapse,
  ThreadDetailsSection,
  ThreadDetailsSummary,
} from "./ThreadDetailsSection";
import {
  ThreadDetailsProcessesSection,
  ThreadDetailsContextSection,
  ThreadDetailsTasksSection,
  type ThreadDetailsContextProps,
} from "./ThreadDetailsSections";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { ThreadRepositorySections } from "./ThreadRepositorySections";
import { resolveThreadDetailsVisibility, THREAD_DETAILS_ITEMS } from "./threadDetailsItems";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

const GitActionsControl = memo(BaseGitActionsControl);
// Both reuse settings and usage-page modules; keep them out of the chat bundle.
const ThreadDetailsUsageSection = lazy(() => import("./ThreadDetailsUsageSection"));
const ThreadDetailsMcpSection = lazy(() => import("./ThreadDetailsMcpSection"));

export interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle"
> {
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  draftId?: DraftId;
  composerDraftTarget: ComposerThreadTarget;
  activeProjectName: string | undefined;
  gitCwd: string | null;
  workspaceMutationId: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onOpenSourceControl?: (() => void) | undefined;
  context: ThreadDetailsContextProps;
  providers: readonly ServerProvider[];
  usageLimitSources: UsageLimitSourceSnapshots;
  providerInstanceId: ProviderInstanceId | null;
  /** The composer's pick, which a pending handoff moves off the running provider. */
  usageProviderInstanceId: ProviderInstanceId | null;
  /** The model the usage pick runs, which narrows a hub's pooled limits to the accounts it routes. */
  usageModel: string | null;
  branch: string | null;
  plans: ThreadStructure["plans"];
  runs: ThreadStructure["runs"];
  pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  /** An agent's home chat gets a status and schedule view instead of the project's. */
  agent?: ThreadDetailsAgent | null;
}

/** Branch plus the same line totals the expanded Changes row shows. */
function VersionControlSummary(props: {
  readonly threadRef: ScopedThreadRef;
  readonly gitCwd: string | null;
  readonly workspaceMutationId: string | null;
  readonly branch: string | null;
}) {
  const { data: status } = useEnvironmentQuery(
    props.gitCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId: props.threadRef.environmentId,
          input: { cwd: props.gitCwd },
        }),
  );
  const totals = useChangesTotals({
    activeThreadRef: props.threadRef,
    gitCwd: props.gitCwd,
    status,
    workspaceMutationId: props.workspaceMutationId,
    enabled: status?.isRepo ?? false,
  });
  const hasChanges = totals !== null && (totals.insertions > 0 || totals.deletions > 0);
  if (!props.branch && !hasChanges) return null;
  return (
    <ThreadDetailsSummary>
      {hasChanges ? (
        <span className="flex shrink-0 items-baseline gap-1.5 font-mono">
          <span className="text-diff-addition-foreground">
            +{formatDiffCount(totals.insertions)}
          </span>
          <span className="text-diff-deletion-foreground">
            -{formatDiffCount(totals.deletions)}
          </span>
        </span>
      ) : null}
      {props.branch ? (
        <>
          <GitBranchIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate font-mono">{props.branch}</span>
        </>
      ) : null}
    </ThreadDetailsSummary>
  );
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const serverThread = props.isServerThread && !props.draftId;
  const visible = useClientSettings(resolveThreadDetailsVisibility);
  const gt = useGT();
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const activeThreadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const project = useProject(scopeProjectRef(props.environmentId, props.projectId));
  const serverConfig = useServerConfigs().get(props.environmentId);
  const tracksFolders = (project?.trackedFolders?.length ?? 0) > 0;
  // A worktree thread reaches tracked repositories only through its own task folder.
  const taskFolderQuery = useEnvironmentQuery(
    // Asked whatever the project tracks now: a thread keeps its task folder when that changes.
    props.isServerThread && props.worktreePath !== null
      ? filesystemEnvironment.taskFolder({
          environmentId: props.environmentId,
          input: { worktreePath: props.worktreePath },
        })
      : null,
  );
  const taskFolder = taskFolderQuery.data?.taskFolder ?? null;
  // A task folder's plain project directory can sit inside someone else's repository.
  const folderIsRepo = props.isGitRepo && taskFolder?.projectIsWorktree !== false;
  // A No project thread's folder sits inside the shared scratch root, so it must never get git.
  // Until the config and project load, a No project thread looks like any other folder.
  const offersGit =
    props.gitCwd !== null &&
    serverConfig !== undefined &&
    project !== null &&
    !isScratchProject(project, serverConfig.scratchWorkspaceRoot);
  // Version Control rows, so the section renders only when one of them does.
  const showVersionControl = {
    branch: offersGit && folderIsRepo && visible.branch,
    // Without a branch selector, linked pull requests still need somewhere to show.
    pullRequests: !(offersGit && folderIsRepo) && visible.branch,
    // A plain folder that tracks repositories is not asked to become one itself.
    git:
      offersGit &&
      props.gitCwd !== null &&
      Boolean(props.activeProjectName) &&
      (folderIsRepo || (!tracksFolders && taskFolder === null)) &&
      (!folderIsRepo || visible.changes),
    // Also for a project that tracks nothing: a thread can change a submodule.
    repositories: offersGit && visible.gitActions,
  };
  const branchToolbarProps = {
    showGitControls: folderIsRepo,
    environmentId: props.environmentId,
    threadId: props.threadId,
    projectId: props.projectId,
    worktreePath: props.worktreePath,
    isServerThread: props.isServerThread,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    envMode: props.envMode,
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    forceNewWorktree: props.forceNewWorktree ?? false,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  return (
    <ThreadDetailsCard
      threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
      anchor={props.anchor}
      handle={props.handle}
      contentKey={THREAD_DETAILS_ITEMS.filter((item) => visible[item.id])
        .map((item) => item.id)
        .join(",")}
      // An agent home shows its own sections, which the item choices do not cover.
      {...(props.agent
        ? {}
        : {
            onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
              // Popups the card opens bubble here through React; they, fields, links, and selected text
              // keep their own menus.
              const target = event.target;
              const selection = window.getSelection();
              if (
                !(target instanceof Element) ||
                !event.currentTarget.contains(target) ||
                target.closest("input, textarea, [contenteditable], a[href]") ||
                (selection &&
                  !selection.isCollapsed &&
                  (event.currentTarget.contains(selection.anchorNode) ||
                    event.currentTarget.contains(selection.focusNode)))
              )
                return;
              event.preventDefault();
              setMenuPosition({ x: event.clientX, y: event.clientY });
            },
          })}
    >
      {(density) =>
        props.agent ? (
          <>
            <ThreadDetailsAgentStatusSection agent={props.agent} />
            {serverThread ? (
              <ThreadDetailsAutoCollapse collapsed={density === "essential"}>
                <ThreadDetailsTasksSection
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  plans={props.plans}
                  runs={props.runs}
                />
              </ThreadDetailsAutoCollapse>
            ) : null}
            {serverThread ? (
              <ThreadDetailsAutoCollapse collapsed={density === "essential"}>
                <ThreadDetailsProcessesSection
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  projectId={props.projectId}
                  pendingBackgroundTasks={props.pendingBackgroundTasks}
                  showTerminals={visible.terminals}
                  showServers={!props.draftId && visible.servers}
                />
              </ThreadDetailsAutoCollapse>
            ) : null}
            <ThreadDetailsAutoCollapse collapsed={density === "essential"}>
              <ThreadDetailsAgentActivitySection agent={props.agent} />
            </ThreadDetailsAutoCollapse>
            <ThreadDetailsAutoCollapse collapsed={density === "essential"}>
              <ThreadDetailsAgentRoutinesSection agent={props.agent} />
            </ThreadDetailsAutoCollapse>
            <ThreadDetailsAutoCollapse collapsed={density !== "full"}>
              <ThreadDetailsContextSection {...props.context} separated />
            </ThreadDetailsAutoCollapse>
            <ThreadDetailsAutoCollapse collapsed={density !== "full"}>
              <Suspense fallback={null}>
                <ThreadDetailsUsageSection
                  environmentId={props.environmentId}
                  providers={props.providers}
                  usageLimitSources={props.usageLimitSources}
                  providerInstanceId={props.usageProviderInstanceId}
                  model={props.usageModel}
                />
              </Suspense>
            </ThreadDetailsAutoCollapse>
          </>
        ) : (
          <>
            <div className="group/details-items">
              <ThreadDetailsContextSection {...props.context} />

              <ThreadDetailsAutoCollapse collapsed={density === "essential"}>
                <Suspense fallback={null}>
                  <ThreadDetailsUsageSection
                    environmentId={props.environmentId}
                    providers={props.providers}
                    usageLimitSources={props.usageLimitSources}
                    providerInstanceId={props.usageProviderInstanceId}
                    model={props.usageModel}
                  />
                </Suspense>
              </ThreadDetailsAutoCollapse>

              {showVersionControl.branch ||
              showVersionControl.pullRequests ||
              showVersionControl.git ||
              (showVersionControl.repositories && density !== "essential") ? (
                <ThreadDetailsSection
                  headingId="thread-details-version-control-heading"
                  title={gt("Version Control")}
                  collapsedSummary={
                    <VersionControlSummary
                      threadRef={activeThreadRef}
                      gitCwd={offersGit && folderIsRepo ? props.gitCwd : null}
                      workspaceMutationId={props.workspaceMutationId}
                      branch={props.branch}
                    />
                  }
                >
                  <div className="flex flex-col">
                    {showVersionControl.branch ? (
                      <BranchToolbar
                        layout="panel"
                        panelSection="branch"
                        {...branchToolbarProps}
                        onOpenSourceControl={props.onOpenSourceControl}
                      />
                    ) : null}
                    {showVersionControl.pullRequests ? (
                      <ThreadDetailsThreadPrRows
                        threadRef={activeThreadRef}
                        project={project}
                        composerTarget={props.composerDraftTarget}
                      />
                    ) : null}
                    {showVersionControl.git && props.gitCwd ? (
                      <GitActionsControl
                        displayMode="panel"
                        showActions={false}
                        showChanges={visible.changes}
                        compact={density !== "full"}
                        gitCwd={props.gitCwd}
                        name={props.activeProjectName ?? ""}
                        workspaceMutationId={props.workspaceMutationId}
                        activeThreadRef={activeThreadRef}
                        {...(props.draftId ? { draftId: props.draftId } : {})}
                        {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                      />
                    ) : null}
                    {showVersionControl.repositories && density !== "essential" ? (
                      <ThreadRepositorySections
                        environmentId={props.environmentId}
                        threadId={props.threadId}
                        projectId={props.projectId}
                        isServerThread={props.isServerThread}
                        threadCwd={props.gitCwd}
                        taskFolder={taskFolder}
                        reachesTracked={
                          props.worktreePath === null ? tracksFolders : taskFolder !== null
                        }
                        onTaskFolderChange={taskFolderQuery.refresh}
                        explainsEmpty={!folderIsRepo}
                        showActions={visible.gitActions}
                      />
                    ) : null}
                  </div>
                </ThreadDetailsSection>
              ) : null}

              {!props.draftId && (visible.lineage || visible.sideChats) ? (
                <ThreadDetailsAutoCollapse collapsed={density !== "full"}>
                  <ThreadRelationshipsPanel
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                    showLineage={visible.lineage}
                    showSideChats={visible.sideChats}
                  />
                </ThreadDetailsAutoCollapse>
              ) : null}

              {serverThread ? (
                <ThreadDetailsAutoCollapse collapsed={density === "essential"}>
                  <ThreadDetailsTasksSection
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                    plans={props.plans}
                    runs={props.runs}
                  />
                </ThreadDetailsAutoCollapse>
              ) : null}

              {serverThread ? (
                <ThreadDetailsAutoCollapse collapsed={density !== "full"}>
                  <ThreadDetailsProcessesSection
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                    projectId={props.projectId}
                    pendingBackgroundTasks={props.pendingBackgroundTasks}
                    showTerminals={visible.terminals}
                    showServers={!props.draftId && visible.servers}
                  />
                </ThreadDetailsAutoCollapse>
              ) : null}

              {serverThread ? (
                <ThreadDetailsAutoCollapse collapsed={density !== "full"}>
                  <Suspense fallback={null}>
                    <ThreadDetailsMcpSection
                      environmentId={props.environmentId}
                      projectId={props.projectId}
                      threadId={props.threadId}
                      providerInstanceId={props.providerInstanceId}
                    />
                  </Suspense>
                </ThreadDetailsAutoCollapse>
              ) : null}

              {!props.draftId && visible.automations ? (
                <ThreadDetailsAutoCollapse collapsed={density !== "full"}>
                  <ThreadAutomationsPanel
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                  />
                </ThreadDetailsAutoCollapse>
              ) : null}

              {/* Shown only when no section above has content, so an emptied card can be refilled. */}
              <div className="p-2 group-has-[>section>:last-child:not(:empty)]/details-items:hidden">
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  part="row"
                  panel
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenuPosition({ x: rect.left, y: rect.bottom });
                  }}
                >
                  <SlidersHorizontalIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
                  <span className={cn("ml-0.5", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                    <T>Choose what to show</T>
                  </span>
                </ThreadDetailsControl>
              </div>
            </div>

            <Menu
              open={menuPosition !== null}
              onOpenChange={(open) => !open && setMenuPosition(null)}
            >
              <MenuPopup
                anchor={
                  menuPosition
                    ? {
                        getBoundingClientRect: () =>
                          new DOMRect(menuPosition.x, menuPosition.y, 0, 0),
                      }
                    : undefined
                }
                align="start"
                side="bottom"
              >
                <ThreadDetailsItemsMenuItems />
              </MenuPopup>
            </Menu>
          </>
        )
      }
    </ThreadDetailsCard>
  );
}
