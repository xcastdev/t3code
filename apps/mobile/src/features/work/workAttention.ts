import { useAtomValue } from "@effect/atom-react";
import { createWorkAttentionAtoms } from "@t3tools/client-runtime/state/work-attention";
import { Atom } from "effect/reactivity";

import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { projectWorkEnvironment } from "../../state/projectWork";

const NO_DOT = Atom.make(false).pipe(Atom.withLabel("mobile-work-attention:off"));

// Work surfaces only show Work items, so chat requests stay out of the collection.
const { attentionEntriesAtom, workHomeAtom, hasWorkAttentionAtom } = createWorkAttentionAtoms({
  label: "mobile",
  connectedEnvironmentIdsAtom,
  attention: projectWorkEnvironment.attention,
  projectsAtom: environmentProjects.projectsAtom,
});

/** Everything in Work waiting on the user, newest first. */
export function useWorkAttentionEntries() {
  return useAtomValue(attentionEntriesAtom).flatMap((entry) =>
    entry.type === "work" ? [entry] : [],
  );
}
export type WorkAttentionEntry = ReturnType<typeof useWorkAttentionEntries>[number];

/** What waits on the user and what is moving, across every connected project. */
export function useWorkHome() {
  return useAtomValue(workHomeAtom);
}

/** The Work tab's dot. Only subscribes while the tab is shown. */
export function useWorkTabAttention(shown: boolean): boolean {
  return useAtomValue(shown ? hasWorkAttentionAtom : NO_DOT);
}
