import type { EnvironmentId } from "@t3tools/contracts";

/**
 * The list route has one session-scoped panel shared by every capable server.
 * Its rail remains visible after the final tab closes; only explicit sidebar
 * visibility changes remove the panel itself.
 */
export function shouldRenderPullRequestsPanel(input: {
  isOpen: boolean;
  panelRefAvailable: boolean;
}): boolean {
  return input.isOpen && input.panelRefAvailable;
}

/** The rail is an available panel state even when no detail tab is selected. */
export function canTogglePullRequestsPanel(input: { panelRefAvailable: boolean }): boolean {
  return input.panelRefAvailable;
}

/**
 * Keeps the route's configurable shortcut on the same gate as its visible
 * control. Returning whether it handled the event lets the route continue
 * dispatching unrelated commands.
 */
export function dispatchPullRequestsPanelToggleShortcut(input: {
  available: boolean;
  event: Pick<KeyboardEvent, "preventDefault" | "repeat" | "stopPropagation">;
  onToggle: () => void;
}): boolean {
  if (!input.available) return false;
  input.event.preventDefault();
  input.event.stopPropagation();
  if (!input.event.repeat) input.onToggle();
  return true;
}

/** An empty rail does not own the native titlebar; the list header still does. */
export function shouldReservePullRequestsNativeControls(input: {
  rightPanelOpen: boolean;
  rightPanelHasActiveSurface: boolean;
}): boolean {
  return !input.rightPanelOpen || !input.rightPanelHasActiveSurface;
}

/**
 * Surface environment takes precedence while a detail is rendering. Once it
 * is gone, use only list scope or a stable capable-server fallback: the
 * selection fields describe a closed tab and must not recreate it.
 */
export function resolvePullRequestsPanelEnvironment(input: {
  activeSurfaceEnvironmentId: EnvironmentId | null;
  scopedProjectEnvironmentId: EnvironmentId | null;
  scopedEnvironmentId: EnvironmentId | null;
  capableEnvironmentIds: readonly EnvironmentId[];
}): EnvironmentId | null {
  return (
    input.activeSurfaceEnvironmentId ??
    input.scopedProjectEnvironmentId ??
    input.scopedEnvironmentId ??
    input.capableEnvironmentIds[0] ??
    null
  );
}
