import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  asProjectWorkFoundationPage,
  combineProjectWorkFoundationPages,
  type ProjectWorkFoundationSnapshot,
} from "@t3tools/client-runtime/project-work";
import { ProjectTeamRecord, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { projectWorkEnvironment } from "../../state/projectWork";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { WorkDataNotice } from "./WorkDataNotice";

export interface WorkTeamFoundationView {
  readonly snapshot: ProjectWorkFoundationSnapshot;
  readonly current: boolean;
  readonly verify: () => ProjectWorkFoundationSnapshot;
  readonly refresh: () => void;
}

const knownRecord = Schema.is(ProjectTeamRecord);
const unavailable = () => ({
  code: "stale-revision",
  message: "Refresh the complete current project work before making changes.",
});

/** Keep the queue mounted while a bounded cursor chain reloads, preserving local drafts. */
export function WorkTeamFoundation(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly children: (view: WorkTeamFoundationView) => ReactNode;
}) {
  return (
    <FoundationSession key={JSON.stringify([props.environmentId, props.projectId])} {...props} />
  );
}

function FoundationSession(props: Parameters<typeof WorkTeamFoundation>[0]) {
  const registry = useContext(RegistryContext);
  const [cursors, setCursors] = useState<ReadonlyArray<string | undefined>>([undefined]);
  const [, changed] = useState(0);
  const owner = useRef(true);
  const access = useRef(props);
  useLayoutEffect(() => {
    access.current = props;
  }, [props]);
  useLayoutEffect(() => {
    owner.current = true;
    return () => {
      owner.current = false;
    };
  }, []);
  const reset = useRef<string | null>(null);
  const notify = useCallback(() => changed((value) => value + 1), []);
  const run = useAtomQueryRunner(projectWorkEnvironment.foundationPage, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const targets = useMemo(
    () =>
      cursors.map((cursor) => ({
        environmentId: props.environmentId,
        projectId: props.projectId,
        ...(cursor === undefined ? {} : { cursor }),
      })),
    [cursors, props.environmentId, props.projectId],
  );
  const values = targets.map((target) =>
    registry.get(projectWorkEnvironment.foundationPage(target)),
  );
  const pages = values.flatMap((value, index) => {
    const raw = Option.getOrNull(AsyncResult.value(value));
    return raw === null
      ? []
      : [{ ...(cursors[index] === undefined ? {} : { cursor: cursors[index] }), value: raw }];
  });
  const snapshot = combineProjectWorkFoundationPages({ projectId: props.projectId, pages });
  const [saved, save] = useState<{
    readonly snapshot: ProjectWorkFoundationSnapshot;
    readonly values: typeof values;
  } | null>(null);
  const settled = values.every((value) => value._tag === "Success" && !value.waiting);
  if (
    settled &&
    snapshot.complete &&
    snapshot.error === null &&
    (saved === null ||
      saved.values.length !== values.length ||
      saved.values.some((value, index) => value !== values[index]))
  ) {
    save({ snapshot, values });
  }
  const display =
    snapshot.complete && snapshot.error === null ? snapshot : (saved?.snapshot ?? snapshot);
  const current =
    settled && snapshot.complete && snapshot.error === null && snapshot.records.every(knownRecord);
  const refresh = () => {
    for (const target of targets) void run(target);
  };
  const firstPage = asProjectWorkFoundationPage(pages[0]?.value, props.projectId);
  const lastPage = asProjectWorkFoundationPage(pages.at(-1)?.value, props.projectId);

  useEffect(() => {
    if (
      (snapshot.error === "revision-changed" ||
        (cursors.length > 1 && firstPage?.nextCursor !== cursors[1])) &&
      reset.current !== JSON.stringify([firstPage?.revision, firstPage?.nextCursor])
    ) {
      reset.current = JSON.stringify([firstPage?.revision, firstPage?.nextCursor]);
      setCursors([undefined]);
      // Cached later pages may still belong to the previous aggregate revision.
      for (const target of targets.slice(1)) void run(target);
    } else if (
      settled &&
      lastPage?.nextCursor !== undefined &&
      cursors.length < 16 &&
      snapshot.error === null
    ) {
      setCursors((previous) =>
        previous.includes(lastPage.nextCursor) ? previous : [...previous, lastPage.nextCursor],
      );
    }
  }, [
    snapshot.error,
    reset,
    cursors,
    firstPage?.revision,
    firstPage?.nextCursor,
    lastPage?.nextCursor,
    settled,
    run,
    targets,
  ]);

  const verify = () => {
    if (
      !owner.current ||
      !access.current.connected ||
      !access.current.enabled ||
      !access.current.supported
    )
      throw unavailable();
    const latest = targets.map((target) =>
      registry.get(projectWorkEnvironment.foundationPage(target)),
    );
    if (!latest.every((value) => value._tag === "Success" && !value.waiting)) throw unavailable();
    const fresh = combineProjectWorkFoundationPages({
      projectId: props.projectId,
      pages: latest.map((value, index) => ({
        ...(cursors[index] === undefined ? {} : { cursor: cursors[index] }),
        value: Option.getOrNull(AsyncResult.value(value)),
      })),
    });
    if (
      !fresh.complete ||
      fresh.error !== null ||
      fresh.revision !== snapshot.revision ||
      !fresh.records.every(knownRecord)
    )
      throw unavailable();
    return fresh;
  };
  const error = values.some((value) => value._tag === "Failure")
    ? "Could not refresh project work. Retry to load a current snapshot."
    : snapshot.error !== null
      ? "Project work changed while loading. Reload the current snapshot."
      : cursors.length === 16 && snapshot.nextCursor !== null
        ? "This project exceeds the guided view limit. Actions are unavailable in this view."
        : null;
  return (
    <>
      {targets.map((target) => (
        <FoundationObserver
          key={JSON.stringify(target)}
          atom={projectWorkEnvironment.foundationPage(target)}
          onChange={notify}
        />
      ))}
      <WorkDataNotice
        stale={!props.connected && snapshot.records.length > 0}
        waiting={!settled && snapshot.records.length === 0}
        offline={!props.connected}
        error={error}
        onRetry={refresh}
      />
      {props.children({ snapshot: display, current, verify, refresh })}
    </>
  );
}

function FoundationObserver({
  atom,
  onChange,
}: {
  readonly atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;
  readonly onChange: () => void;
}) {
  const result = useAtomValue(atom);
  useEffect(onChange, [result, onChange]);
  return null;
}
