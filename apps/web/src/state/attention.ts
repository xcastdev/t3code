import { useAtomValue } from "@effect/atom-react";
import { type AttentionEntry, workAttentionFor } from "@t3tools/client-runtime/state/attention";
import type { WorkHome } from "@t3tools/client-runtime/state/work-home";
import { createWorkAttentionAtoms } from "@t3tools/client-runtime/state/work-attention";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { environmentSummaries } from "./presentation";
import { environmentProjects } from "./projects";
import { projectWorkEnvironment } from "./projectWork";
import { environmentThreadShells } from "./threads";

const { workAttentionAtom, attentionEntriesAtom, workHomeAtom } = createWorkAttentionAtoms({
  label: "web",
  connectedEnvironmentIdsAtom: environmentSummaries.connectedEnvironmentIdsAtom,
  attention: projectWorkEnvironment.attention,
  threadsAtom: environmentThreadShells.quietThreadShellsAtom,
  projectsAtom: environmentProjects.projectsAtom,
});

/** Everything waiting on the user across environments, newest first. */
export function useAttentionEntries(): ReadonlyArray<AttentionEntry> {
  return useAtomValue(attentionEntriesAtom);
}

const NO_WORK_ATTENTION = { overview: [], tasks: [] } as const;

/** Keys of one project's Work items, split by where they're answered. */
export function useProjectWorkAttention(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): { readonly overview: ReadonlyArray<string>; readonly tasks: ReadonlyArray<string> } {
  const work = useAtomValue(workAttentionAtom);
  return environmentId === null || projectId === null
    ? NO_WORK_ATTENTION
    : workAttentionFor(work, environmentId, projectId);
}

/** Keys of every project's Work items, for the sidebar's Work entry. */
export function useAllWorkAttentionKeys(): ReadonlyArray<string> {
  return useAtomValue(attentionEntriesAtom)
    .filter((entry) => entry.type === "work")
    .map((entry) => entry.key);
}

/** What waits on the user and what is moving, across every connected project. */
export function useWorkHome(): WorkHome {
  return useAtomValue(workHomeAtom);
}
