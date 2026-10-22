import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ProjectWorkClientRead } from "@t3tools/client-runtime/state/project-work";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { projectWorkEnvironment } from "../../state/projectWork";

export const WORK_PAGE_SIZE = 64;

function describeReadFailure(error: unknown): string {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    if (error._tag === "ProjectWorkRpcError" && "reason" in error) {
      if (error.reason === "forbidden") return "This connection can't read Work for this project.";
      if (error.reason === "invalid-request") return "The server could not read this request.";
    }
    if (error._tag === "EnvironmentAuthorizationError")
      return "This connection lacks permission to read Work on this environment.";
  }
  return "Work isn't available on this environment. It may need a newer T3 Code server.";
}

/** One bounded Work read. The shared atom owns caching, stream refresh and cleanup. */
export function useWorkRead(environmentId: EnvironmentId, input: ProjectWorkClientRead) {
  const atom = projectWorkEnvironment.read({ environmentId, input });
  const view = useAtomValue(atom);
  // Refreshing the read wrapper re-runs its underlying query, including after a failure.
  const retry = useAtomRefresh(atom);
  const error =
    view.result._tag === "Failure"
      ? describeReadFailure(squashAtomCommandFailure(view.result))
      : null;
  return { ...view, error, retry };
}

export type WorkReadView = ReturnType<typeof useWorkRead>;

/** Why writes are off right now, or null when the view is current and writable. */
export function workWriteBlockedReason(view: WorkReadView, canWrite: boolean): string | null {
  if (view.status === "disconnected") return "Reconnect to make changes.";
  if (!canWrite) return "This connection is not allowed to change Work here.";
  if (view.status === "loading") return "Loading the current revision.";
  if (view.status === "stale") return "Waiting for the current revision before changes.";
  return null;
}
