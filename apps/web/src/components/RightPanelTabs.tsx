import { pullRequestHostOf, type SourceControlProviderKind } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useProjects, useServerConfigs, useThreadShells } from "~/state/entities";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import type {
  ContextMenuItem,
  EnvironmentId,
  PreviewSessionSnapshot,
  ProjectId,
  PullRequestState,
} from "@t3tools/contracts";
import {
  Bot,
  Smartphone,
  ChevronLeft,
  ChevronRight,
  FileDiff,
  Files,
  GitPullRequest,
  GitPullRequestArrow,
  GitBranch,
  Globe2,
  Plus,
  Volume2,
  VolumeOff,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ElementType,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Button } from "~/components/ui/button";
import { AndroidIcon, AppleIcon } from "~/components/Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { ScrollArea } from "~/components/ui/scroll-area";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { useTheme } from "~/hooks/useTheme";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { FaviconImage } from "./preview/PreviewFaviconIcon";
import { previewBridge } from "./preview/previewBridge";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";
import { RightPanelRail } from "./right-panel/RightPanelRail";
import { buildRightPanelSurfaceActions } from "./right-panel/rightPanelSurfaceActions";

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  open?: boolean;
  /** Forwarded to PreviewPanelShell so this surface persists its own width. */
  widthStorageKey?: string;
  /** Forwarded to PreviewPanelShell as the initial width before a user resize. */
  defaultWidth?: number;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  /** Fallback environment for surfaces that do not carry their own. */
  environmentId: EnvironmentId | null;
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  /**
   * Maps a server session tab id to the desktop runtime tab id the Electron
   * preview manager is keyed by. Session ids are only unique within one server
   * process, so desktop operations must not be addressed with them.
   */
  previewRuntimeTabId?: ((tabId: string) => string) | undefined;
  onActivate: (surface: RightPanelSurface) => void;
  onRenameDevice?: (surfaceId: string, title: string) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddBrowser: () => void;
  /**
   * Separate from `onAddBrowser` on purpose: that one is passed directly as a
   * DOM click handler, and a `(profileId?: string)` signature would silently
   * accept the MouseEvent as a profile id.
   */
  onAddBrowserInProfile: (profileId: string) => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddPullRequests: () => void;
  onAddAgents: () => void;
  onAddDevice: () => void;
  onAddSourceControl: () => void;
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  pullRequestsAvailable: boolean;
  agentsAvailable: boolean;
  deviceAvailable: boolean;
  sourceControlAvailable: boolean;
  sourceControlProviderName?: string | null | undefined;
  sourceControlIcon?: ElementType<{ className?: string }> | undefined;
  pullRequestStatusSeeds?: Readonly<Record<string, PullRequestTabStatusSeed>>;
  /** Running + waiting subagents; badges the Agents card in the empty state. */
  liveAgentCount: number;
  children: ReactNode;
}

export interface PullRequestTabStatus {
  projectId: string;
  repository: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
}

export type PullRequestTabStatusSeed = Pick<PullRequestTabStatus, "state" | "isDraft">;

export function shouldOpenDefaultBrowserProfileFromMenuClick(
  pointerType: string | undefined,
): boolean {
  return pointerType !== "touch";
}

const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the T3 Code desktop app.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  pullRequest: "This thread's branch has no pull request yet.",
  pullRequests: "No linked pull requests are available for this thread.",
  sourceControl: "Source Control is only available when a project is open.",
  agents: "Agents are only available from a thread.",
  device: "Devices are only available from a thread.",
} as const;

type TabContextMenuAction =
  | "rename"
  | "copy-path"
  | "toggle-mute"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";

const TAB_SCROLL_EDGE_TOLERANCE = 1;

function tabScrollViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

/**
 * Desktop preview tab backing a surface, or null for non-preview surfaces, the
 * "new browser tab" placeholder, and the web build where no desktop tab exists.
 */
function previewTabIdOf(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): string | null {
  if (surface.kind !== "preview" || !surface.resourceId) return null;
  return sessions[surface.resourceId]?.tabId ?? null;
}

/**
 * Label and enabled state for a preview tab's mute menu entry.
 * Stays disabled until desktop overlay state arrives: a server session id can
 * resolve while the preview manager's createTab is still in flight, and muting
 * then fails with a PreviewTabNotFoundError nothing surfaces to the user.
 */
export function tabMuteMenuItem(input: {
  overlay: DesktopPreviewOverlay | null;
  canResolveRuntimeTabId: boolean;
}): { label: string; disabled: boolean } {
  const muted = input.overlay?.audioMuted ?? false;
  return {
    label: muted ? "Unmute tab" : "Mute tab",
    disabled: input.overlay === null || !input.canResolveRuntimeTabId,
  };
}

type TabAudioState = "none" | "audible" | "muted";

/**
 * A muted tab that is not making sound shows nothing: mute is armed silently,
 * and the indicator only appears once there is audio to speak of.
 */
function tabAudioState(overlay: DesktopPreviewOverlay | null): TabAudioState {
  if (!overlay?.audible) return "none";
  return overlay.audioMuted ? "muted" : "audible";
}

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
>;

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return (
    actions.find(
      (action) => action.available && action.shortcut.toLowerCase() === event.key.toLowerCase(),
    ) ?? null
  );
}

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  shortcut: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
      aria-keyshortcuts={props.shortcut}
    >
      {props.children}
      <MenuShortcut>{props.shortcut}</MenuShortcut>
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): string {
  switch (surface.kind) {
    case "diff":
      return "Diff";
    case "files":
      return "Files";
    case "file":
      return surface.relativePath.slice(
        Math.max(surface.relativePath.lastIndexOf("/"), surface.relativePath.lastIndexOf("\\")) + 1,
      );
    case "pull-request":
      return `#${surface.number}`;
    case "pull-requests":
      return "Pull requests";
    case "source-control":
      return "Source Control";
    case "agents":
      return "Agents";
    case "device":
      return surface.title ?? surface.target?.name ?? "Device";
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return "Browser";
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
      try {
        return new URL(snapshot.navStatus.url).host || "Browser";
      } catch {
        return "Browser";
      }
    }
  }
}

function PreviewFavicon({ capturedUrl, url }: { capturedUrl: string | null; url: string | null }) {
  const publicProviderUrl = faviconUrlForOrigin(url, 32);
  return (
    <FaviconImage
      sources={[capturedUrl, publicProviderUrl]}
      fallback={<Globe2 className="size-3 shrink-0" />}
      className="size-3 shrink-0 rounded-sm object-contain"
    />
  );
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function SurfaceIcon({
  surface,
  sessions,
  desktopByTabId,
  theme,
  environmentId,
  pullRequestStatusSeeds,
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  theme: "light" | "dark";
  environmentId: EnvironmentId | null;
  pullRequestStatusSeeds: Readonly<Record<string, PullRequestTabStatusSeed>> | undefined;
}) {
  switch (surface.kind) {
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
      const favicon = snapshot ? (desktopByTabId[snapshot.tabId]?.favicon ?? null) : null;
      const capturedUrl =
        favicon && url && sameOrigin(favicon.pageUrl, url) ? favicon.dataUrl : null;
      return <PreviewFavicon capturedUrl={capturedUrl} url={url} />;
    }
    case "diff":
      return <FileDiff className="size-3 shrink-0" />;
    case "files":
      return <Files className="size-3 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3"
        />
      );
    case "pull-request":
      return (
        <PullRequestSurfaceIcon
          surface={surface}
          environmentId={environmentId}
          seed={pullRequestStatusSeeds?.[surface.id]}
        />
      );
    case "pull-requests":
      return <GitPullRequestArrow className="size-3 shrink-0" />;
    case "source-control":
      return <GitBranch className="size-3 shrink-0" />;
    case "agents":
      return <Bot className="size-3 shrink-0" />;
    case "device":
      return surface.target?.platform === "ios" ? (
        <AppleIcon className="size-3 shrink-0" />
      ) : surface.target?.platform === "android" ? (
        <AndroidIcon className="size-3 shrink-0" />
      ) : (
        <Smartphone className="size-3 shrink-0" />
      );
  }
}

export function resolvePullRequestTabLink(
  threads: readonly Pick<EnvironmentThreadShell, "environmentId" | "pullRequests">[],
  environmentId: EnvironmentId | null,
  host: string | null,
  reference: { repository: string; number: number },
) {
  if (environmentId === null || host === null) return undefined;
  let newest: EnvironmentThreadShell["pullRequests"][number] | undefined;
  for (const thread of threads) {
    if (thread.environmentId !== environmentId) continue;
    for (const link of visibleThreadPullRequests(thread.pullRequests)) {
      if (
        !threadPullRequestKeysEqual(link, {
          host,
          repository: reference.repository,
          number: reference.number,
        })
      )
        continue;
      if (
        newest === undefined ||
        (link.snapshot?.syncedAt ?? "") > (newest.snapshot?.syncedAt ?? "")
      )
        newest = link;
    }
  }
  return newest;
}

function PullRequestSurfaceIcon({
  surface,
  environmentId,
  seed,
}: {
  surface: Extract<RightPanelSurface, { kind: "pull-request" }>;
  environmentId: EnvironmentId | null;
  seed: PullRequestTabStatusSeed | undefined;
}) {
  const resolvedEnvironmentId =
    (surface.environmentId as EnvironmentId | undefined) ?? environmentId;
  const projects = useProjects();
  const threads = useThreadShells();
  const project = projects.find(
    (entry) => entry.environmentId === resolvedEnvironmentId && entry.id === surface.projectId,
  );
  const identity = project?.repositoryIdentity;
  const host =
    surface.host ??
    (identity?.provider
      ? pullRequestHostOf(identity, identity.provider as SourceControlProviderKind)
      : null);
  const configs = useServerConfigs();
  const capabilities =
    resolvedEnvironmentId === null
      ? undefined
      : configs.get(resolvedEnvironmentId)?.environment.capabilities;
  const linkedSnapshot =
    capabilities?.threadPullRequests === true
      ? (resolvePullRequestTabLink(threads, resolvedEnvironmentId, host, surface)?.snapshot ?? null)
      : null;
  const detail = useEnvironmentQuery(
    resolvedEnvironmentId === null || capabilities?.pullRequests !== true || linkedSnapshot !== null
      ? null
      : pullRequestEnvironment.detail({
          environmentId: resolvedEnvironmentId,
          input: {
            projectId: surface.projectId as ProjectId,
            ...(capabilities?.threadPullRequests === true && surface.host !== undefined
              ? { host: surface.host }
              : {}),
            repository: surface.repository,
            number: surface.number,
          },
        }),
  ).data;
  // Only state and draft reach the tab. A list seed cannot know mergeability, so feeding the
  // full detail would flip an open tab to the conflict glyph the moment its read lands.
  const status =
    linkedSnapshot !== null
      ? linkedSnapshot
      : detail === null
        ? (seed ?? null)
        : { state: detail.state, isDraft: detail.isDraft };
  if (status === null) {
    return <GitPullRequest className="size-3 shrink-0 text-muted-foreground" />;
  }
  const presentation = resolvePullRequestState({
    state: status.state,
    isDraft: status.isDraft,
  });
  return <presentation.Icon className={cn("size-3 shrink-0", presentation.toneClassName)} />;
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const browserProfiles = useBrowserDefaults().profiles;
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);
  const [renamingDevice, setRenamingDevice] = useState<string | null>(null);
  const [addSurfaceMenuOpen, setAddSurfaceMenuOpen] = useState(false);
  const [tabScrollState, setTabScrollState] = useState({
    hasOverflow: false,
    canScrollLeft: false,
    canScrollRight: false,
  });
  const railVisible = props.activeSurfaceId === null;
  const railReplacesTabBar = railVisible && props.mode === "inline";
  const railActions = buildRightPanelSurfaceActions({
    browserProfiles,
    sourceControlProviderName: props.sourceControlProviderName ?? null,
    sourceControlIcon: props.sourceControlIcon,
    availability: {
      browser: props.browserAvailable,
      files: props.filesAvailable,
      "source-control": props.sourceControlAvailable,
      agents: props.agentsAvailable,
      "pull-request": props.pullRequestAvailable,
      "pull-requests": props.pullRequestsAvailable,
      device: props.deviceAvailable,
    },
    onAddBrowser: props.onAddBrowser,
    onAddBrowserInProfile: props.onAddBrowserInProfile,
    onAddFiles: props.onAddFiles,
    onAddSourceControl: props.onAddSourceControl,
    onAddAgents: props.onAddAgents,
    onAddPullRequest: props.onAddPullRequest,
    onAddPullRequests: props.onAddPullRequests,
    onAddDevice: props.onAddDevice,
    liveAgentCount: props.liveAgentCount,
  });

  const updateTabScrollState = useCallback(() => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;

    const hasOverflow = viewport.scrollWidth - viewport.clientWidth > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollLeft = hasOverflow && viewport.scrollLeft > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollRight =
      hasOverflow &&
      viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - TAB_SCROLL_EDGE_TOLERANCE;
    setTabScrollState((current) => {
      if (
        current.hasOverflow === hasOverflow &&
        current.canScrollLeft === canScrollLeft &&
        current.canScrollRight === canScrollRight
      ) {
        return current;
      }
      return { hasOverflow, canScrollLeft, canScrollRight };
    });
  }, []);

  const scrollTabs = useCallback((direction: -1 | 1) => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollBy({
      left: direction * Math.max(120, viewport.clientWidth * 0.75),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, []);

  const addSurfaceActions = [
    {
      label: "Browser",
      icon: Globe2,
      shortcut: "B",
      available: props.browserAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: "Files",
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
    },
    {
      label: "Diff",
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
    },
    {
      label: "Pull request",
      icon: GitPullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.pullRequest,
      onClick: props.onAddPullRequest,
    },
    {
      label: "Linked pull requests",
      icon: GitPullRequestArrow,
      shortcut: "L",
      available: props.pullRequestsAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.pullRequests,
      onClick: props.onAddPullRequests,
    },
    ...(props.onAddSourceControl
      ? [
          {
            label: "Source Control",
            icon: GitBranch,
            shortcut: "G",
            available: props.sourceControlAvailable === true,
            disabledReason: SURFACE_DISABLED_REASONS.sourceControl,
            onClick: props.onAddSourceControl,
          },
        ]
      : []),
    {
      label: "Agents",
      icon: Bot,
      shortcut: "A",
      available: props.agentsAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.agents,
      onClick: props.onAddAgents,
    },
    {
      label: "Device",
      icon: Smartphone,
      shortcut: "M",
      available: props.deviceAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.device,
      onClick: props.onAddDevice,
    },
  ] as const;

  const handleAddSurfaceMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = surfaceShortcutActionForKey(addSurfaceActions, event.nativeEvent);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    setAddSurfaceMenuOpen(false);
    action.onClick();
  };

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: RightPanelSurface) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      const items: ContextMenuItem<TabContextMenuAction>[] = [];
      if (surface.kind === "device" && props.onRenameDevice)
        items.push({ id: "rename", label: "Rename" });
      if (surface.kind === "file" && surface.attachment === undefined) {
        items.push({ id: "copy-path", label: "Copy path" });
      }
      const menuPreviewTabId = previewTabIdOf(surface, props.previewSessions);
      // Desktop overlay state only arrives once the preview manager has created
      // the tab. A server session id alone can still be ahead of that, and
      // muting then fails with PreviewTabNotFoundError that nobody surfaces.
      const menuOverlay = menuPreviewTabId
        ? (props.desktopByTabId[menuPreviewTabId] ?? null)
        : null;
      const menuMuted = menuOverlay?.audioMuted ?? false;
      if (surface.kind === "preview") {
        // Not gated on audibility: silencing a quiet tab ahead of time is the
        // point, so the item is offered whenever the tab is mutable at all.
        items.push({
          id: "toggle-mute",
          ...tabMuteMenuItem({
            overlay: menuOverlay,
            canResolveRuntimeTabId: props.previewRuntimeTabId !== undefined,
          }),
        });
      }
      items.push(
        { id: "close", label: "Close" },
        {
          id: "close-others",
          label: "Close others",
          disabled: props.surfaces.length <= 1,
        },
        {
          id: "close-to-right",
          label: "Close to the right",
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        {
          id: "close-all",
          label: "Close all",
          disabled: props.surfaces.length === 0,
        },
      );

      const action = await api.contextMenu.show(items, {
        x: event.clientX,
        y: event.clientY,
      });
      switch (action) {
        case "rename":
          setRenamingDevice(surface.id);
          break;
        case "copy-path":
          if (surface.kind === "file" && surface.attachment === undefined) {
            props.onCopyFilePath(surface.relativePath);
          }
          break;
        case "toggle-mute": {
          // menuOverlay repeats the disabled gate above: the desktop tab must
          // exist before it can be addressed, however the menu was dismissed.
          const runtimeTabId =
            menuPreviewTabId && menuOverlay
              ? (props.previewRuntimeTabId?.(menuPreviewTabId) ?? null)
              : null;
          if (runtimeTabId) {
            void previewBridge?.setAudioMuted(runtimeTabId, !menuMuted).catch(() => undefined);
          }
          break;
        }
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [props],
  );
  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );

  useEffect(() => {
    if (!props.activeSurfaceId || !tabScrollState.hasOverflow) return;
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId, tabScrollState.hasOverflow]);

  useEffect(() => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;

    const content = viewport.firstElementChild;
    const resizeObserver = new ResizeObserver(updateTabScrollState);
    resizeObserver.observe(viewport);
    if (content) resizeObserver.observe(content);
    viewport.addEventListener("scroll", updateTabScrollState, {
      passive: true,
    });
    updateTabScrollState();

    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", updateTabScrollState);
    };
  }, [updateTabScrollState]);

  useEffect(() => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth;
      if (delta === 0) return;

      const previousScrollLeft = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft === previousScrollLeft) return;
      event.preventDefault();
      updateTabScrollState();
    };

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [updateTabScrollState]);

  return (
    <PreviewPanelShell
      mode={props.mode}
      rail={railReplacesTabBar}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
    >
      {!railReplacesTabBar ? (
        <div
          className={cn(
            "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2",
            // The sheet overlays from the viewport top, so its tab bar keeps
            // the titlebar's height: a compact row re-centers the layout
            // controls a few pixels higher and the cluster jumps on open.
            props.mode === "inline" && !props.layoutControls ? "pr-28" : "pr-3",
            ownsDesktopTitleBar && "drag-region",
            ownsDesktopTitleBar &&
              (props.layoutControls
                ? "wco:pr-[var(--workspace-native-controls-inset)]"
                : "wco:pr-[calc(var(--workspace-native-controls-inset)+6rem)]"),
            props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
          data-right-panel-tabbar
        >
          <ScrollArea
            ref={tabListRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1 rounded-none"
            data-right-panel-tab-list
          >
            <div className="flex h-full w-max min-w-full items-center gap-1">
              {props.surfaces.map((surface) => {
                const active = surface.id === props.activeSurfaceId;
                const pending = props.pendingSurfaceIds.has(surface.id);
                const title = surfaceTitle(surface, props.previewSessions);
                const previewTabId = previewTabIdOf(surface, props.previewSessions);
                // Desktop state is keyed by the session id, but desktop actions
                // must be addressed with the runtime id.
                const audio = tabAudioState(
                  previewTabId ? (props.desktopByTabId[previewTabId] ?? null) : null,
                );
                const audioRuntimeTabId = previewTabId
                  ? (props.previewRuntimeTabId?.(previewTabId) ?? null)
                  : null;
                return (
                  <div
                    key={surface.id}
                    data-active-tab={active}
                    onMouseDown={handleTabMouseDown}
                    onAuxClick={(event) => handleTabAuxClick(event, surface)}
                    onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                    className={cn(
                      "cursor-pointer group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                      ownsDesktopTitleBar && "[-webkit-app-region:no-drag]",
                      active
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <PanelTabCloseButton
                      label={`Close ${title}`}
                      onClick={() => props.onCloseSurface(surface)}
                    >
                      <SurfaceIcon
                        surface={surface}
                        sessions={props.previewSessions}
                        desktopByTabId={props.desktopByTabId}
                        theme={resolvedTheme}
                        environmentId={props.environmentId}
                        pullRequestStatusSeeds={props.pullRequestStatusSeeds}
                      />
                      {pending ? (
                        <span
                          className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
                          aria-hidden
                        />
                      ) : null}
                    </PanelTabCloseButton>
                    {audio === "none" || !audioRuntimeTabId ? null : (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              className="cursor-pointer flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
                              aria-label={audio === "muted" ? `Unmute ${title}` : `Mute ${title}`}
                              onClick={(event) => {
                                // Sibling of the close button, inside a tab that
                                // activates on click: keep this to the toggle.
                                event.stopPropagation();
                                void previewBridge
                                  ?.setAudioMuted(audioRuntimeTabId, audio !== "muted")
                                  .catch(() => undefined);
                              }}
                            >
                              {audio === "muted" ? (
                                <VolumeOff className="size-3" />
                              ) : (
                                <Volume2 className="size-3" />
                              )}
                            </button>
                          }
                        />
                        <TooltipPopup>{audio === "muted" ? "Unmute tab" : "Mute tab"}</TooltipPopup>
                      </Tooltip>
                    )}
                    {renamingDevice === surface.id ? (
                      <input
                        aria-label="Device tab name"
                        className="w-24 min-w-0 rounded-sm bg-background px-1 outline-none ring-1 ring-ring"
                        defaultValue={title}
                        ref={(element) => {
                          element?.focus();
                          element?.select();
                        }}
                        onBlur={(event) => {
                          props.onRenameDevice?.(surface.id, event.currentTarget.value);
                          setRenamingDevice(null);
                        }}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") {
                            event.currentTarget.value = title;
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    ) : (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onDoubleClick={() => {
                                if (surface.kind === "device" && props.onRenameDevice)
                                  setRenamingDevice(surface.id);
                              }}
                              className="cursor-pointer flex min-w-0 items-center"
                              onClick={() => props.onActivate(surface)}
                            >
                              <span className="truncate">{title}</span>
                            </button>
                          }
                        />
                        <TooltipPopup>{title}</TooltipPopup>
                      </Tooltip>
                    )}
                  </div>
                );
              })}
              {props.surfaces.length > 0 ? (
                <Menu open={addSurfaceMenuOpen} onOpenChange={setAddSurfaceMenuOpen}>
                  <MenuTrigger
                    render={
                      <Button
                        aria-label="Add panel surface"
                        className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                        size="icon-xs"
                        variant="ghost"
                      />
                    }
                  >
                    <Plus className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup
                    align="start"
                    side="bottom"
                    sideOffset={6}
                    className="min-w-44"
                    onKeyDownCapture={handleAddSurfaceMenuKeyDown}
                  >
                    {addSurfaceActions.map((action) => {
                      const Icon = action.icon;
                      // Browser collapses into one row: clicking the trigger opens
                      // the default profile (the common case stays one click),
                      // while hover or arrow reveals the profiles. The choice
                      // lives at open time because a tab's profile is fixed then —
                      // Electron only honours a partition before attach.
                      if (action.label === "Browser" && action.available) {
                        return (
                          <MenuSub key={action.label}>
                            <MenuSubTrigger
                              className="[&>svg:last-child]:ms-0"
                              aria-keyshortcuts={action.shortcut}
                              onClick={(event) => {
                                const pointerType =
                                  "pointerType" in event.nativeEvent &&
                                  typeof event.nativeEvent.pointerType === "string"
                                    ? event.nativeEvent.pointerType
                                    : undefined;
                                // Touch has no hover path to the profile choices:
                                // its first tap opens the submenu, then a profile
                                // is selected there. Mouse click keeps the common
                                // default-profile action at one click.
                                if (!shouldOpenDefaultBrowserProfileFromMenuClick(pointerType))
                                  return;
                                setAddSurfaceMenuOpen(false);
                                action.onClick();
                              }}
                            >
                              <Icon />
                              {action.label}
                              <MenuShortcut>{action.shortcut}</MenuShortcut>
                            </MenuSubTrigger>
                            {/*
                            Capped and truncated: profile names are user-supplied
                            and run to 48 characters, which would otherwise widen
                            the popup to fit-content and wrap.
                          */}
                            <MenuSubPopup className="min-w-40 max-w-56">
                              {browserProfiles.map((profile) => (
                                <MenuItem
                                  key={profile.id}
                                  onClick={() => props.onAddBrowserInProfile(profile.id)}
                                >
                                  <span className="min-w-0 truncate">{profile.name}</span>
                                </MenuItem>
                              ))}
                            </MenuSubPopup>
                          </MenuSub>
                        );
                      }
                      return (
                        <SurfaceMenuItem
                          key={action.label}
                          available={action.available}
                          disabledReason={action.disabledReason}
                          shortcut={action.shortcut}
                          onClick={action.onClick}
                        >
                          <Icon />
                          {action.label}
                        </SurfaceMenuItem>
                      );
                    })}
                  </MenuPopup>
                </Menu>
              ) : null}
            </div>
          </ScrollArea>
          {tabScrollState.hasOverflow ? (
            <div
              className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
              role="group"
              aria-label="Scroll panel tabs"
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex">
                      <Button
                        aria-label="Scroll tabs left"
                        disabled={!tabScrollState.canScrollLeft}
                        onClick={() => scrollTabs(-1)}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <ChevronLeft />
                      </Button>
                    </span>
                  }
                />
                <TooltipPopup>Scroll tabs left</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex">
                      <Button
                        aria-label="Scroll tabs right"
                        disabled={!tabScrollState.canScrollRight}
                        onClick={() => scrollTabs(1)}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <ChevronRight />
                      </Button>
                    </span>
                  }
                />
                <TooltipPopup>Scroll tabs right</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
          {props.layoutControls}
          {ownsDesktopTitleBar ? (
            <span
              aria-hidden
              className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
            />
          ) : null}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col" data-right-panel-surface-content>
        {railVisible ? (
          <RightPanelRail
            actions={railActions}
            onAddBrowserInProfile={props.onAddBrowserInProfile}
            topInset={railReplacesTabBar}
          />
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  );
}
