import type {
  EnvironmentId,
  ProjectWorkAttentionItem,
  ProjectWorkAttentionSummary,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { collectAttention, type AttentionEntry } from "./attention.ts";
import { deriveWorkHome } from "./workHome.ts";

type CollectInput = Parameters<typeof collectAttention>[0];
type HomeProjects = Parameters<typeof deriveWorkHome>[0]["projects"];

const NO_ITEMS: ReadonlyArray<ProjectWorkAttentionItem> = [];

/**
 * What waits on the user and what is moving, from one attention stream per connected
 * environment. An older server without the stream just reports nothing.
 */
export function createWorkAttentionAtoms(input: {
  readonly label: string;
  readonly connectedEnvironmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
  readonly attention: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<ProjectWorkAttentionSummary, unknown>>;
  /** Chat threads waiting on the user; a Work-only surface leaves them out. */
  readonly threadsAtom?: Atom.Atom<CollectInput["threads"]>;
  readonly projectsAtom: Atom.Atom<CollectInput["projects"] & HomeProjects>;
}) {
  const summaryOf = (get: Atom.AtomContext, environmentId: EnvironmentId) =>
    Option.getOrNull(AsyncResult.value(get(input.attention(environmentId))));

  const workAttentionAtom = Atom.make((get) =>
    get(input.connectedEnvironmentIdsAtom).map((environmentId) => ({
      environmentId,
      items: summaryOf(get, environmentId)?.items ?? NO_ITEMS,
    })),
  ).pipe(Atom.withLabel(`${input.label}:work-attention`));

  const attentionEntriesAtom = Atom.make((get): ReadonlyArray<AttentionEntry> =>
    collectAttention({
      threads: input.threadsAtom === undefined ? [] : get(input.threadsAtom),
      work: get(workAttentionAtom),
      projects: get(input.projectsAtom),
    }),
  ).pipe(Atom.withLabel(`${input.label}:attention-entries`));

  const workHomeAtom = Atom.make((get) =>
    deriveWorkHome({
      items: get(attentionEntriesAtom).flatMap((entry) =>
        entry.type === "work" ? [{ environmentId: entry.environmentId, item: entry.item }] : [],
      ),
      activity: get(input.connectedEnvironmentIdsAtom).map((environmentId) => ({
        environmentId,
        activity: summaryOf(get, environmentId)?.activity ?? null,
      })),
      projects: get(input.projectsAtom),
    }),
  ).pipe(Atom.withLabel(`${input.label}:work-home`));

  // A boolean, so the tab bar only repaints when the dot appears or clears.
  const hasWorkAttentionAtom = Atom.make((get) =>
    get(attentionEntriesAtom).some((entry) => entry.type === "work"),
  ).pipe(Atom.withLabel(`${input.label}:has-work-attention`));

  return { workAttentionAtom, attentionEntriesAtom, workHomeAtom, hasWorkAttentionAtom };
}
