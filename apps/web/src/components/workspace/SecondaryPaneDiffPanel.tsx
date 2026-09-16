import type { EnvironmentId, GitRepositoryComparisonInput } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { sourceControlWorkspaceEnvironment } from "~/state/sourceControl";
import { useEnvironmentQuery } from "~/state/query";
import { sourceControlWorkspaceRevisionAtom } from "@t3tools/client-runtime/state/sourceControlWorkspace";
import { useAtomCommand } from "~/state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import { useSecondaryPaneStore, type SecondaryPaneDiffSurface } from "~/secondaryPaneStore";
import { resolveThreadRouteRef } from "~/threadRoutes";

// Diff tabs are retained by the pane store while inactive tabs are unmounted.
// Keep their reader position with the tab rather than with a component instance.
const diffScrollPositions = new Map<string, number>();

export function SecondaryPaneDiffPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly surface: SecondaryPaneDiffSurface;
}) {
  const compare = useAtomCommand(sourceControlWorkspaceEnvironment.compareRepositoryFile, {
    reportFailure: false,
  });
  const threadRef = useParams({ strict: false, select: (params) => resolveThreadRouteRef(params) });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const capabilities = serverConfig?.environment?.capabilities;
  const isLive =
    props.surface.descriptor?.liveSnapshotId !== null &&
    props.surface.descriptor?.liveSnapshotId !== undefined
      ? true
      : props.surface.comparison === "working-tree";
  // Do not attempt a persisted comparison until configuration has settled. A
  // request made during negotiation is rejected by the shared adapter and,
  // without a distinct pending state, used to leave historical tabs stuck on
  // that failure after support arrived.
  const workspaceCapability =
    serverConfig === undefined
      ? "pending"
      : capabilities?.sourceControlWorkspace === true
        ? "supported"
        : "unsupported";
  const repositoryRevision = useAtomValue(
    sourceControlWorkspaceRevisionAtom({
      environmentId: props.environmentId,
      repositoryRoot: props.surface.repositoryRoot,
    }),
  );
  // Historical descriptors are immutable.  They must not refetch merely
  // because a live repository status broadcast arrived.
  const comparisonRevision = isLive ? repositoryRevision : 0;
  // A retained live tab obtains its snapshot when it is activated too. This
  // keeps inactive tabs from subscribing/rendering, while avoiding a stale
  // index/HEAD pair when they are restored.
  const liveStatusQuery = useEnvironmentQuery(
    isLive
      ? sourceControlWorkspaceEnvironment.status({
          environmentId: props.environmentId,
          input: { cwd: props.surface.repositoryRoot || props.cwd },
        })
      : null,
  );
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | {
        kind: "ready";
        oldContents: string;
        newContents: string;
        binary: boolean;
        available: boolean;
        unavailableReason?: string;
      }
  >({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const completedRequestKey = useRef<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const liveDescriptor = useMemo(() => {
    const descriptor = props.surface.descriptor;
    if (!isLive || !descriptor || !liveStatusQuery.data) return descriptor;
    const status = liveStatusQuery.data;
    return {
      ...descriptor,
      liveSnapshotId: status.workingTree.snapshotId ?? descriptor.liveSnapshotId,
      baseRevision:
        descriptor.liveBase === "index" ? (status.indexTree ?? null) : (status.headCommit ?? null),
      // A staged comparison is HEAD -> current index. The working-tree right
      // side remains live, but the index is a real tree object and must be
      // refreshed rather than falling back to the tab's original tree.
      headRevision: descriptor.kind === "index" ? (status.indexTree ?? null) : null,
    };
  }, [isLive, liveStatusQuery.data, props.surface.descriptor]);
  const comparisonInput = useMemo<GitRepositoryComparisonInput>(
    () => ({
      // A thread can host nested repositories; the tab identity is the
      // authoritative comparison scope, not the project route cwd.
      cwd: props.surface.repositoryRoot || props.cwd,
      comparison:
        props.surface.comparison === "working-tree"
          ? "working-tree"
          : props.surface.comparison === "index"
            ? "index"
            : props.surface.comparison === "branch" ||
                (props.surface.comparison === "pull-request" &&
                  props.surface.commitSha === undefined)
              ? "branch"
              : "commit",
      oldPath: props.surface.oldPath,
      newPath: props.surface.newPath,
      ...(props.surface.baseRef !== undefined ? { baseRef: props.surface.baseRef } : {}),
      ...(props.surface.headRef !== undefined ? { headRef: props.surface.headRef } : {}),
      ...(props.surface.indexTree !== undefined ? { indexTree: props.surface.indexTree } : {}),
      ...(props.surface.commitSha !== undefined ? { commitSha: props.surface.commitSha } : {}),
      ...(liveDescriptor !== undefined ? { descriptor: liveDescriptor } : {}),
    }),
    [liveDescriptor, props.cwd, props.surface],
  );
  useEffect(() => {
    let active = true;
    if (workspaceCapability === "pending") {
      return () => {
        active = false;
      };
    }
    if (workspaceCapability === "unsupported") {
      setState({ kind: "error", message: "This server cannot restore this file comparison." });
      return () => {
        active = false;
      };
    }
    if (isLive && liveStatusQuery.error) {
      setState({
        kind: "error",
        message: "The repository status is unavailable. Refresh and try again.",
      });
      return () => {
        active = false;
      };
    }
    // Live comparisons are only meaningful with one coherent status snapshot.
    // Waiting avoids briefly rendering a previous index tree before the
    // current HEAD/index pair has arrived.
    if (isLive && !liveStatusQuery.data) {
      return () => {
        active = false;
      };
    }
    // A repository revision can intentionally publish before its asynchronously
    // persisted status value.  Key completed work by the actual snapshot that
    // will be read as well as the revision: when that status arrives at the
    // same revision it must replace the provisional comparison.
    const liveSnapshotKey = isLive
      ? `${liveDescriptor?.liveSnapshotId ?? ""}:${liveDescriptor?.baseRevision ?? ""}:${liveDescriptor?.headRevision ?? ""}`
      : "";
    const requestKey = `${props.surface.id}:${comparisonRevision}:${liveSnapshotKey}:${reloadKey}`;
    // The server normalizes an unresolved descriptor after the first request.
    // That metadata update must not issue the same comparison a second time.
    if (completedRequestKey.current === requestKey) {
      return () => {
        active = false;
      };
    }
    // Keep the mounted comparison scroller during a live refresh. Replacing
    // it with a loading branch loses the reader's position for every status
    // broadcast.
    setState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    void compare({
      environmentId: props.environmentId,
      input: comparisonInput,
    }).then((result) => {
      if (!active) return;
      if (result._tag === "Failure") {
        setState({ kind: "error", message: "This file comparison is unavailable." });
      } else {
        const value = result.value as {
          oldContents: string;
          newContents: string;
          binary: boolean;
          available: boolean;
          unavailableReason?: string;
          descriptor?: NonNullable<SecondaryPaneDiffSurface["descriptor"]>;
        };
        if (threadRef && value.descriptor) {
          useSecondaryPaneStore
            .getState()
            .resolveDiffDescriptor(threadRef, props.surface.id, value.descriptor);
        }
        completedRequestKey.current = requestKey;
        setState({ kind: "ready", ...value });
      }
    });
    return () => {
      active = false;
    };
  }, [
    compare,
    comparisonInput,
    isLive,
    liveStatusQuery.data,
    liveStatusQuery.error,
    props.environmentId,
    props.surface.id,
    reloadKey,
    comparisonRevision,
    threadRef,
    workspaceCapability,
  ]);

  const retry = useCallback(() => {
    if (isLive) liveStatusQuery.refresh();
    setReloadKey((value) => value + 1);
  }, [isLive, liveStatusQuery]);
  const close = useCallback(() => {
    if (!threadRef) return;
    useSecondaryPaneStore.getState().closeSurface(threadRef, props.surface.id);
  }, [props.surface.id, threadRef]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const savedScrollTop = diffScrollPositions.get(props.surface.id);
    if (savedScrollTop !== undefined) scroller.scrollTop = savedScrollTop;
    return () => {
      diffScrollPositions.set(props.surface.id, scroller.scrollTop);
    };
  }, [props.surface.id, state.kind]);

  if (state.kind === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Loading diff…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-destructive">
        <span>{state.message}</span>
        <div className="flex gap-2">
          <button type="button" className="underline" onClick={retry}>
            Retry
          </button>
          <button type="button" className="underline" onClick={close}>
            Close
          </button>
        </div>
      </div>
    );
  }
  if (state.binary) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Binary content cannot be rendered here.
      </div>
    );
  }
  if (!state.available) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
        <span>{state.unavailableReason ?? "This file comparison is unavailable."}</span>
        <div className="flex gap-2">
          <button type="button" className="underline" onClick={retry}>
            Refresh
          </button>
          <button type="button" className="underline" onClick={close}>
            Close
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      ref={scrollerRef}
      className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border overflow-auto text-xs"
      onScroll={(event) => diffScrollPositions.set(props.surface.id, event.currentTarget.scrollTop)}
    >
      <pre className="whitespace-pre-wrap p-3 text-muted-foreground">{state.oldContents}</pre>
      <pre className="whitespace-pre-wrap p-3">{state.newContents}</pre>
    </div>
  );
}
