import { useAtomValue } from "@effect/atom-react";
import { type ProjectId, type EnvironmentId } from "@t3tools/contracts";
import { type ProjectWorkFoundationSnapshot } from "@t3tools/client-runtime/project-work";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobileWorkEnvironment } from "./workEnvironment";
import { mobileFoundationProgress, mobileFoundationView } from "./workData";

/** Loads at most sixteen opaque cursor pages; incomplete reads never enable writes. */
export function useWorkFoundation(
  target: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
  supported: boolean,
) {
  const { environmentId, projectId } = target;
  const [cursors, setCursors] = useState<ReadonlyArray<string | undefined>>([undefined]);
  const resetKey = useRef<string | null>(null);
  const atoms = useMemo(
    () =>
      supported
        ? cursors.map((cursor) =>
            mobileWorkEnvironment.foundationPage({
              environmentId,
              projectId,
              ...(cursor === undefined ? {} : { cursor }),
            }),
          )
        : [],
    [environmentId, projectId, supported, cursors],
  );
  const combined = useMemo(() => Atom.make((get) => atoms.map((atom) => get(atom))), [atoms]);
  const values = useAtomValue(combined);
  const view = mobileFoundationView(target.projectId, cursors, values);
  const [saved, save] = useState<{
    readonly snapshot: ProjectWorkFoundationSnapshot;
    readonly loadedAt: string;
    readonly values: typeof values;
  } | null>(null);
  useEffect(
    () =>
      appAtomRegistry.subscribe(
        combined,
        (observed) => {
          const coherent = mobileFoundationView(projectId, cursors, observed);
          if (coherent.current)
            save((previous) =>
              previous?.values.length === observed.length &&
              previous.values.every((value, index) => value === observed[index])
                ? previous
                : {
                    snapshot: coherent.snapshot,
                    loadedAt: new Date().toLocaleString(),
                    values: observed,
                  },
            );
          const next = mobileFoundationProgress(projectId, cursors, observed, resetKey.current);
          resetKey.current = next.resetKey;
          if (next.restart) for (const atom of atoms.slice(1)) appAtomRegistry.refresh(atom);
          if (next.cursors !== cursors) setCursors(next.cursors);
        },
        { immediate: true },
      ),
    [combined, projectId, cursors, atoms],
  );
  const refresh = () => {
    for (const atom of atoms) appAtomRegistry.refresh(atom);
  };
  const verify = () =>
    mobileFoundationView(
      target.projectId,
      cursors,
      atoms.map((atom) => appAtomRegistry.get(atom)),
    );
  const display = view.current ? view.snapshot : (saved?.snapshot ?? view.snapshot);
  const error = values.some((value) => value._tag === "Failure")
    ? "Could not refresh project work. Cached work may be out of date."
    : supported && !view.loading && values.length > 0 && view.snapshot.error !== null
      ? "Project work changed while loading. Refresh to load a coherent view."
      : cursors.length === 16 && view.snapshot.nextCursor !== null
        ? "This project exceeds this view's read limit. Guided actions are unavailable."
        : null;
  return {
    snapshot: display,
    current: view.current,
    error,
    loadedAt: saved?.loadedAt ?? null,
    refresh,
    verify,
  };
}
