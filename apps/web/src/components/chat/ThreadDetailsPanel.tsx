import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";
import { type EnvMode } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import BaseGitActionsControl from "../GitActionsControl";
import { GitBranchIcon, SlidersHorizontalIcon } from "lucide-react";
import { lazy, memo, Suspense, useState, type ComponentProps, type MouseEvent } from "react";
import { useClientSettings } from "../../hooks/useSettings";
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
import { ThreadDetailsSection, ThreadDetailsSummary } from "./ThreadDetailsSection";
import {
  ThreadDetailsBackgroundShellsSection,
  ThreadDetailsContextSection,
  ThreadDetailsTasksSection,
  type ThreadDetailsContextProps,
} from "./ThreadDetailsSections";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { ThreadServersPanel } from "./ThreadServersPanel";
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
  activeProjectName: string | undefined;
  gitCwd: string | null;
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
  branch: string | null;
  plans: ThreadStructure["plans"];
  runs: ThreadStructure["runs"];
  pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  /** An agent's home chat gets a status and schedule view instead of the project's. */
  agent?: ThreadDetailsAgent | null;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const serverThread = props.isServerThread && !props.draftId;
  const visible = useClientSettings(resolveThreadDetailsVisibility);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const activeThreadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
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
            {density !== "essential" && serverThread ? (
              <ThreadDetailsTasksSection
                environmentId={props.environmentId}
                threadId={props.threadId}
                plans={props.plans}
                runs={props.runs}
              />
            ) : null}
            {density !== "essential" && serverThread ? (
              <ThreadDetailsBackgroundShellsSection
                environmentId={props.environmentId}
                threadId={props.threadId}
                pendingBackgroundTasks={props.pendingBackgroundTasks}
              />
            ) : null}
            {density !== "essential" ? (
              <ThreadDetailsAgentActivitySection agent={props.agent} />
            ) : null}
            {density !== "essential" ? (
              <ThreadDetailsAgentRoutinesSection agent={props.agent} />
            ) : null}
            {density === "full" ? (
              <ThreadDetailsContextSection {...props.context} separated />
            ) : null}
            {density === "full" ? (
              <Suspense fallback={null}>
                <ThreadDetailsUsageSection
                  environmentId={props.environmentId}
                  providers={props.providers}
                  usageLimitSources={props.usageLimitSources}
                  providerInstanceId={props.providerInstanceId}
                />
              </Suspense>
            ) : null}
          </>
        ) : (
          <>
            <div className="group/details-items">
              <ThreadDetailsContextSection {...props.context} />

              {density !== "essential" ? (
                <Suspense fallback={null}>
                  <ThreadDetailsUsageSection
                    environmentId={props.environmentId}
                    providers={props.providers}
                    usageLimitSources={props.usageLimitSources}
                    providerInstanceId={props.providerInstanceId}
                  />
                </Suspense>
              ) : null}

              {props.gitCwd &&
              ((props.isGitRepo && visible.branch) ||
                (props.activeProjectName && (!props.isGitRepo || visible.changes))) ? (
                <ThreadDetailsSection
                  headingId="thread-details-version-control-heading"
                  title="Version Control"
                  collapsedSummary={
                    props.branch ? (
                      <ThreadDetailsSummary>
                        <GitBranchIcon className="size-3 shrink-0" aria-hidden />
                        <span className="truncate font-mono">{props.branch}</span>
                      </ThreadDetailsSummary>
                    ) : null
                  }
                >
                  <div className="flex flex-col">
                    {props.isGitRepo && visible.branch ? (
                      <BranchToolbar
                        layout="panel"
                        panelSection="branch"
                        {...branchToolbarProps}
                        onOpenSourceControl={props.onOpenSourceControl}
                      />
                    ) : null}
                    {props.activeProjectName && (!props.isGitRepo || visible.changes) ? (
                      <GitActionsControl
                        displayMode="panel"
                        showActions={false}
                        showChanges={visible.changes}
                        compact={density !== "full"}
                        gitCwd={props.gitCwd}
                        activeThreadRef={activeThreadRef}
                        {...(props.draftId ? { draftId: props.draftId } : {})}
                        {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                      />
                    ) : null}
                  </div>
                </ThreadDetailsSection>
              ) : null}

              {density === "full" && !props.draftId && (visible.lineage || visible.sideChats) ? (
                <ThreadRelationshipsPanel
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  showLineage={visible.lineage}
                  showSideChats={visible.sideChats}
                />
              ) : null}

              {density !== "essential" && serverThread ? (
                <ThreadDetailsTasksSection
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  plans={props.plans}
                  runs={props.runs}
                />
              ) : null}

              {density === "full" && serverThread ? (
                <ThreadDetailsBackgroundShellsSection
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  pendingBackgroundTasks={props.pendingBackgroundTasks}
                />
              ) : null}

              {density === "full" && !props.draftId && visible.servers ? (
                <ThreadServersPanel environmentId={props.environmentId} threadId={props.threadId} />
              ) : null}

              {density === "full" && serverThread ? (
                <Suspense fallback={null}>
                  <ThreadDetailsMcpSection
                    environmentId={props.environmentId}
                    projectId={props.projectId}
                    threadId={props.threadId}
                    providerInstanceId={props.providerInstanceId}
                  />
                </Suspense>
              ) : null}

              {density === "full" && !props.draftId && visible.automations ? (
                <ThreadAutomationsPanel
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                />
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
                    Choose what to show
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
