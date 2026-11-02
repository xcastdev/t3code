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
import { GitBranchIcon } from "lucide-react";
import { lazy, memo, Suspense, type ComponentProps } from "react";
import {
  ThreadDetailsAgentActivitySection,
  ThreadDetailsAgentRoutinesSection,
  ThreadDetailsAgentStatusSection,
  type ThreadDetailsAgent,
} from "./ThreadDetailsAgentSections";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { ThreadDetailsSection, ThreadDetailsSummary } from "./ThreadDetailsSection";
import {
  ThreadDetailsBackgroundShellsSection,
  ThreadDetailsContextSection,
  ThreadDetailsTasksSection,
  type ThreadDetailsContextProps,
} from "./ThreadDetailsSections";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

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

            {props.gitCwd ? (
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
                  {props.isGitRepo ? (
                    <BranchToolbar
                      layout="panel"
                      panelSection="branch"
                      {...branchToolbarProps}
                      onOpenSourceControl={props.onOpenSourceControl}
                    />
                  ) : null}
                  {props.activeProjectName ? (
                    <GitActionsControl
                      displayMode="panel"
                      showActions={false}
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

            {density === "full" && !props.draftId ? (
              <ThreadRelationshipsPanel
                environmentId={props.environmentId}
                threadId={props.threadId}
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

            {density === "full" && !props.draftId ? (
              <ThreadAutomationsPanel
                environmentId={props.environmentId}
                threadId={props.threadId}
              />
            ) : null}
          </>
        )
      }
    </ThreadDetailsCard>
  );
}
