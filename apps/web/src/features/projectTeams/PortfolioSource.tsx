import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { asProjectTeamSupervisionSummary } from "@t3tools/client-runtime/project-work";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useContext, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { projectWorkEnvironment } from "../../state/projectWork";
import { Portfolio, type PortfolioProps } from "./Portfolio";

type Project = Pick<
  PortfolioProps["entries"][number],
  "environmentId" | "projectId" | "title" | "connected" | "enabled" | "supported"
>;
export type PortfolioSourceProps = Omit<PortfolioProps, "entries" | "now" | "loading"> & {
  readonly projects: ReadonlyArray<Project>;
};
type Saved = {
  readonly token: string;
  readonly snapshot: NonNullable<PortfolioProps["entries"][number]["snapshot"]>;
};
const ownerKey = (project: Project) => JSON.stringify([project.environmentId, project.projectId]);
const eligible = (project: Project) => project.connected && project.enabled && project.supported;

/** Read one bounded owner page. Global project pagination belongs to the parent. */
export function PortfolioSource(props: PortfolioSourceProps) {
  const owners = new Set<string>();
  const projects: Project[] = [];
  for (const project of props.projects) {
    const key = ownerKey(project);
    if (owners.has(key)) continue;
    owners.add(key);
    projects.push(project);
    if (projects.length === 25) break;
  }
  return <PortfolioRead key={JSON.stringify([...owners])} {...props} projects={projects} />;
}

function PortfolioRead(props: PortfolioSourceProps) {
  const registry = useContext(RegistryContext);
  const queries = props.projects.map((project) =>
    projectWorkEnvironment.supervision({
      environmentId: project.environmentId,
      projectId: project.projectId,
      enabled: project.enabled,
      capability: project.supported,
      connectionPhase: project.connected ? "connected" : "disconnected",
    }),
  );
  const [pageRead, savePageRead] = useState(() => ({
    queries,
    atom: Atom.make((get) => queries.map((query) => get(query))),
  }));
  const sameQueries = queries.every((query, index) => query === pageRead.queries[index]);
  const aggregate = sameQueries
    ? pageRead.atom
    : Atom.make((get) => queries.map((query) => get(query)));
  if (!sameQueries) savePageRead({ queries, atom: aggregate });
  const results = useAtomValue(aggregate);
  const [inspectedAt, setInspectedAt] = useState(Date.now);
  useLayoutEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active && registry.get(aggregate) === results) setInspectedAt(Date.now());
    });
    return () => {
      active = false;
    };
  }, [registry, aggregate, results]);
  const [saved, save] = useState<ReadonlyArray<Saved | null>>([]);
  const snapshots = props.projects.map((project, index) => {
    const result = results[index];
    const success =
      result?._tag === "Success"
        ? result
        : result?._tag === "Failure"
          ? Option.getOrNull(result.previousSuccess)
          : null;
    const decoded = success
      ? asProjectTeamSupervisionSummary(success.value, project.projectId)
      : null;
    const accepted: Saved | null =
      success && decoded
        ? {
            token: JSON.stringify(decoded),
            snapshot: {
              environmentId: project.environmentId,
              data: decoded,
              receivedAt: success.timestamp,
            },
          }
        : null;
    return {
      accepted,
      error:
        result?._tag === "Failure"
          ? "Could not refresh supervision. Cached metadata may be out of date."
          : success && !decoded
            ? "Unsupported or incoherent supervision metadata."
            : undefined,
    };
  });
  const retained = snapshots.map(({ accepted }, index) => accepted ?? saved[index] ?? null);
  if (
    retained.some(
      (entry, index) =>
        entry?.token !== saved[index]?.token ||
        !Object.is(entry?.snapshot.receivedAt, saved[index]?.snapshot.receivedAt),
    )
  )
    save(retained);
  const loading = props.projects.some(
    (project, index) =>
      eligible(project) && (results[index]?._tag === "Initial" || results[index]?.waiting),
  );
  const entries = props.projects.map((project, index) => {
    const result = results[index];
    const data = snapshots[index]?.accepted?.snapshot.data;
    const snapshot = retained[index]?.snapshot;
    const error = snapshots[index]?.error;
    return {
      ...project,
      current:
        eligible(project) &&
        result?._tag === "Success" &&
        !result.waiting &&
        data?.availability === "available",
      ...(snapshot ? { snapshot } : {}),
      ...(error === undefined ? {} : { error }),
    };
  });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentIndex = (target: Parameters<PortfolioProps["onOpenProject"]>[0]) =>
    props.projects.findIndex(
      (project) =>
        project.environmentId === target.environmentId && project.projectId === target.projectId,
    );
  const permits = (target: Parameters<PortfolioProps["onOpenProject"]>[0]) => {
    const index = currentIndex(target);
    const entry = entries[index];
    const query = queries[index];
    return (
      mounted.current &&
      !loading &&
      entry?.current &&
      query !== undefined &&
      registry.get(query) === results[index]
    );
  };
  const canRead = () =>
    !loading &&
    (props.projects.length === 0 || props.projects.some(eligible)) &&
    props.projects.every((project, index) => {
      const query = queries[index];
      return !eligible(project) || (query !== undefined && registry.get(query) === results[index]);
    });
  const refresh = useEffectEvent(() => {
    if (!mounted.current || !canRead()) return;
    for (const [index, project] of props.projects.entries()) {
      const query = queries[index];
      if (eligible(project) && query) registry.refresh(query);
    }
    props.onRefresh();
  });
  const previous = useEffectEvent(() => {
    if (mounted.current && canRead() && props.hasPrevious) props.onPrevious();
  });
  const next = useEffectEvent(() => {
    if (mounted.current && canRead() && props.hasNext) props.onNext();
  });
  // Changed public records retire held entry controls. Receive-time updates keep the widget mounted.
  const metadataKey = JSON.stringify(retained.map((entry) => entry?.token ?? null));
  return (
    <Portfolio
      key={metadataKey}
      {...props}
      entries={entries}
      now={inspectedAt}
      loading={loading}
      onRefresh={() => refresh()}
      onPrevious={() => previous()}
      onNext={() => next()}
      onOpenProject={(target) => {
        if (mounted.current && currentIndex(target) >= 0) props.onOpenProject(target);
      }}
      onOpenTask={(target) => {
        if (permits(target)) props.onOpenTask(target);
      }}
      onOpenWorker={(target) => {
        if (permits(target)) props.onOpenWorker(target);
      }}
    />
  );
}
