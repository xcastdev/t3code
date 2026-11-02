import { useAtomValue } from "@effect/atom-react";
import {
  type AttentionEntry,
  collectAttention,
  workAttentionFor,
} from "@t3tools/client-runtime/state/attention";
import type { EnvironmentId, ProjectId, ProjectWorkAttentionItem } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentSummaries } from "./presentation";
import { environmentProjects } from "./projects";
import { projectWorkEnvironment } from "./projectWork";
import { environmentThreadShells } from "./threads";

const NO_ITEMS: ReadonlyArray<ProjectWorkAttentionItem> = [];

// One attention stream per connected environment; an older server without it just reports nothing.
const workAttentionAtom = Atom.make((get) =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).map((environmentId) => ({
    environmentId,
    items: Option.match(AsyncResult.value(get(projectWorkEnvironment.attention(environmentId))), {
      onNone: () => NO_ITEMS,
      onSome: (summary) => summary.items,
    }),
  })),
).pipe(Atom.withLabel("web-work-attention"));

const attentionEntriesAtom = Atom.make((get) =>
  collectAttention({
    threads: get(environmentThreadShells.quietThreadShellsAtom),
    work: get(workAttentionAtom),
    projects: get(environmentProjects.projectsAtom),
  }),
).pipe(Atom.withLabel("web-attention-entries"));

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
