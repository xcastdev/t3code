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
