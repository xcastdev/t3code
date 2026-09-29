import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type ProjectTerminalBufferState,
  type TerminalOutputCursor,
} from "@t3tools/client-runtime/state/terminal";
import type { ProjectTerminalDockSummary } from "@t3tools/contracts";
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import {
  GhosttyTerminalSurface,
  type GhosttyTerminalSurfaceOptions,
} from "~/terminal/ghostty/surface";
import { terminalThemeFromApp, writeTerminalOutputUpdate } from "./ThreadTerminalDrawer";
import { useEnvironmentQuery } from "../state/query";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { createProjectTerminalTransport } from "./projectTerminalTransport";
import { selectProjectTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";

const EMPTY_TERMINAL_BUFFER: ProjectTerminalBufferState = {
  terminal: null,
  output: {
    generation: 0,
    chunks: [],
    retainedBytes: 0,
    resetVersion: 0,
    nextOffset: 0,
  },
  status: "closed",
  cols: 80,
  rows: 24,
  sequence: 0,
  error: null,
  version: 0,
};

export function ProjectTerminalDockView({
  environmentId,
  projectId,
  height,
  visible,
  onShowThreadTerminals,
}: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly height: number;
  readonly visible: boolean;
  readonly onShowThreadTerminals: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<GhosttyTerminalSurface | null>(null);
  const outputCursorRef = useRef<TerminalOutputCursor>(INITIAL_TERMINAL_OUTPUT_CURSOR);
  const latestSessionRef = useRef(EMPTY_TERMINAL_BUFFER);
  const metadataSnapshotVersionRef = useRef<number | null>(null);
  const metadataRevisionRef = useRef(0);
  const pageRequestIdRef = useRef(0);
  const modeRef = useRef<"view" | "interactive">("view");
  const focusedRef = useRef(false);
  const [attachmentGeneration, setAttachmentGeneration] = useState(0);
  const [extraTerminals, setExtraTerminals] = useState<ReadonlyArray<ProjectTerminalDockSummary>>(
    [],
  );
  const [pageCursor, setPageCursor] = useState<string | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [surfaceVersion, setSurfaceVersion] = useState(0);
  const state = useTerminalUiStateStore((store) =>
    selectProjectTerminalUiState(store.projectTerminalUiStateByKey, environmentId, projectId),
  );
  const selectTerminal = useTerminalUiStateStore((store) => store.selectProjectTerminal);
  const setMode = useTerminalUiStateStore((store) => store.setProjectTerminalMode);
  const metadata = useProjectMetadata(environmentId, projectId);
  const runProjectList = useAtomCommand(terminalEnvironment.projectList, {
    reportFailure: false,
  });
  const runProjectWrite = useAtomCommand(terminalEnvironment.projectWrite, {
    reportFailure: false,
  });
  const runProjectResize = useAtomCommand(terminalEnvironment.projectResize, {
    reportFailure: false,
  });

  const metadataValue = metadata.data;
  const metadataValueRef = useRef(metadataValue);
  metadataValueRef.current = metadataValue;
  metadataRevisionRef.current = metadataValue?.revision ?? 0;
  const terminals = useMemo(() => {
    const byId = new Map(extraTerminals.map((terminal) => [terminal.terminalId, terminal]));
    for (const terminal of metadataValue?.terminals ?? []) byId.set(terminal.terminalId, terminal);
    const removed = new Set(metadataValue?.removedTerminalIds ?? []);
    return [...byId.values()]
      .filter((terminal) => !removed.has(terminal.terminalId))
      .sort((left, right) => left.terminalId.localeCompare(right.terminalId));
  }, [extraTerminals, metadataValue]);
  const attachment = useEnvironmentQuery(
    visible && state.selectedTerminalId !== null
      ? terminalEnvironment.projectAttach({
          environmentId: environmentId as never,
          input: {
            projectId: projectId as never,
            terminalId: state.selectedTerminalId,
            attachmentGeneration,
          },
        })
      : null,
  );
  const session = attachment.data ?? EMPTY_TERMINAL_BUFFER;
  latestSessionRef.current = session;
  const selectedTerminal =
    terminals.find((terminal) => terminal.terminalId === state.selectedTerminalId) ??
    (session.terminal?.terminalId === state.selectedTerminalId ? session.terminal : undefined);

  useEffect(() => {
    if (!metadataValue || state.selectionInitialized) return;
    if (state.selectedTerminalId === null) {
      const first = terminals[0];
      if (first) selectTerminal(environmentId, projectId, first.terminalId);
    }
  }, [
    environmentId,
    metadataValue,
    projectId,
    selectTerminal,
    state.selectionInitialized,
    state.selectedTerminalId,
    terminals,
  ]);

  useEffect(() => {
    if (!metadataValue) return;
    if (metadataSnapshotVersionRef.current === metadataValue.snapshotVersion) return;
    metadataSnapshotVersionRef.current = metadataValue.snapshotVersion;
    pageRequestIdRef.current += 1;
    setExtraTerminals([]);
    setPageCursor(undefined);
  }, [metadataValue]);

  useEffect(() => {
    if (!metadataValue || metadataValue.removedTerminalIds.length === 0) return;
    pageRequestIdRef.current += 1;
    const removed = new Set(metadataValue.removedTerminalIds);
    setExtraTerminals((current) => current.filter((terminal) => !removed.has(terminal.terminalId)));
    if (state.selectedTerminalId !== null && removed.has(state.selectedTerminalId)) {
      selectTerminal(environmentId, projectId, null);
    }
  }, [environmentId, metadataValue, projectId, selectTerminal, state.selectedTerminalId]);

  useEffect(() => {
    if (session.error?.includes("Reconnecting") !== true) return;
    setAttachmentGeneration((current) => current + 1);
  }, [session.error]);

  useLayoutEffect(() => {
    modeRef.current = state.mode;
    const surface = terminalRef.current;
    surface?.setFixedGrid(state.mode === "view" || !focusedRef.current);
    if (state.mode === "interactive" && focusedRef.current) surface?.fit();
  }, [state.mode]);

  useLayoutEffect(() => {
    if (session.version > 0) terminalRef.current?.setRemoteGrid(session.cols, session.rows);
  }, [session.cols, session.rows]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount || !visible || state.selectedTerminalId === null) return;
    let cancelled = false;
    let terminal: GhosttyTerminalSurface | null = null;
    let resizeObserverCleanups: Array<() => void> = [];
    const transport = createProjectTerminalTransport({
      mode: () => modeRef.current,
      focused: () => focusedRef.current,
      write: (data) => {
        void runProjectWrite({
          environmentId: environmentId as never,
          input: { projectId: projectId as never, terminalId: state.selectedTerminalId!, data },
        });
      },
      resize: (cols, rows) => {
        void runProjectResize({
          environmentId: environmentId as never,
          input: {
            projectId: projectId as never,
            terminalId: state.selectedTerminalId!,
            cols,
            rows,
          },
        });
      },
    });
    const options: GhosttyTerminalSurfaceOptions = {
      theme: terminalThemeFromApp(mount),
      // Creation can finish after focus or mode changes. Start fixed, then
      // synchronize the latest mode and remote grid before enabling fit.
      fixedGrid: true,
      initialGrid: { cols: session.cols, rows: session.rows },
      onData: transport.onData,
      onResize: transport.onResize,
      onSelectionChange: () => {},
      beforeKey: () => true,
      onLinkActivate: () => {},
      get visible() {
        return visible;
      },
    };
    const onFocusIn = () => {
      focusedRef.current = true;
      if (modeRef.current === "interactive") {
        terminal?.setFixedGrid(false);
        terminal?.fit();
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!mount.contains(event.relatedTarget as Node | null)) {
        focusedRef.current = false;
        if (modeRef.current === "interactive") {
          terminal?.setFixedGrid(true);
          terminal?.setRemoteGrid(latestSessionRef.current.cols, latestSessionRef.current.rows);
        }
      }
    };
    mount.addEventListener("focusin", onFocusIn);
    mount.addEventListener("focusout", onFocusOut);
    resizeObserverCleanups.push(() => mount.removeEventListener("focusin", onFocusIn));
    resizeObserverCleanups.push(() => mount.removeEventListener("focusout", onFocusOut));

    void GhosttyTerminalSurface.create(mount, options).then((created) => {
      if (cancelled) {
        created.dispose();
        return;
      }
      terminal = created;
      terminalRef.current = created;
      const latestSession = latestSessionRef.current;
      created.setRemoteGrid(latestSession.cols, latestSession.rows);
      created.setFixedGrid(modeRef.current === "view" || !focusedRef.current);
      const initial = readTerminalOutputUpdate(
        latestSession.output,
        INITIAL_TERMINAL_OUTPUT_CURSOR,
      );
      if (initial.type === "reset" && initial.data.length > 0) {
        writeTerminalOutputUpdate(created, initial);
      }
      outputCursorRef.current = initial.cursor;
      setSurfaceVersion((current) => current + 1);
    });

    return () => {
      cancelled = true;
      for (const cleanup of resizeObserverCleanups) cleanup();
      if (terminalRef.current === terminal) terminalRef.current = null;
      terminal?.dispose();
      focusedRef.current = false;
      outputCursorRef.current = INITIAL_TERMINAL_OUTPUT_CURSOR;
    };
    // The surface is recreated for a different remote PTY, environment, or stream generation.
  }, [attachmentGeneration, environmentId, projectId, state.selectedTerminalId, visible]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const update = readTerminalOutputUpdate(session.output, outputCursorRef.current);
    if (update.type !== "none") writeTerminalOutputUpdate(terminal, update);
    outputCursorRef.current = update.cursor;
  }, [session.output, surfaceVersion]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || session.error === null || session.error.includes("Reconnecting")) return;
    terminal.write(`\r\n[terminal] ${session.error}\r\n`);
  }, [session.error]);

  const loadOlder = async () => {
    const cursor = pageCursor === undefined ? (metadata.data?.nextCursor ?? null) : pageCursor;
    if (cursor === null || loadingOlder) return;
    const requestId = ++pageRequestIdRef.current;
    const snapshotVersion = metadataValue?.snapshotVersion ?? 0;
    const revision = metadataValue?.revision ?? 0;
    setLoadingOlder(true);
    try {
      const result = await runProjectList({
        environmentId: environmentId as never,
        input: { projectId: projectId as never, after: cursor, limit: 100 },
      });
      if (result._tag !== "Success") return;
      if (
        requestId !== pageRequestIdRef.current ||
        snapshotVersion !== (metadataValueRef.current?.snapshotVersion ?? 0) ||
        revision !== metadataRevisionRef.current
      )
        return;
      const removed = new Set(metadataValueRef.current?.removedTerminalIds ?? []);
      setExtraTerminals((current) => {
        const byId = new Map(current.map((terminal) => [terminal.terminalId, terminal]));
        for (const terminal of result.value.terminals) {
          if (!removed.has(terminal.terminalId)) byId.set(terminal.terminalId, terminal);
        }
        return [...byId.values()].sort((left, right) =>
          left.terminalId.localeCompare(right.terminalId),
        );
      });
      setPageCursor(result.value.nextCursor);
    } finally {
      setLoadingOlder(false);
    }
  };

  const closeSelectedTab = () => {
    if (!selectedTerminal) return;
    selectTerminal(environmentId, projectId, null);
  };

  const hasOlder =
    (pageCursor === undefined ? metadata.data?.nextCursor : pageCursor) !== null &&
    (pageCursor === undefined ? metadata.data?.nextCursor : pageCursor) !== undefined;

  return (
    <aside
      className="thread-terminal-drawer relative flex h-full min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
      data-terminal-owner="drawer"
      style={{ height: `${height}px` }}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">Project terminals</span>
        <Button size="xs" variant="ghost" onClick={() => setMode(environmentId, projectId, "view")}>
          View
        </Button>
        <Button
          size="xs"
          variant={state.mode === "interactive" ? "secondary" : "ghost"}
          onClick={() => setMode(environmentId, projectId, "interactive")}
        >
          Interactive
        </Button>
        <Button size="xs" variant="ghost" onClick={onShowThreadTerminals}>
          Thread terminals
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-48 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/70 p-1">
          {terminals.map((terminal) => (
            <div key={terminal.terminalId} className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                className={cn(
                  "min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-accent",
                  state.selectedTerminalId === terminal.terminalId && "bg-accent",
                )}
                onClick={() => selectTerminal(environmentId, projectId, terminal.terminalId)}
                aria-label={`Attach to ${terminal.label}`}
              >
                <span className="block truncate">{terminal.label}</span>
                <span className="block text-[10px] text-muted-foreground">{terminal.status}</span>
              </button>
              {state.selectedTerminalId === terminal.terminalId ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Detach ${terminal.label}`}
                  title="Detach terminal"
                  onClick={closeSelectedTab}
                >
                  <X className="size-3" />
                </Button>
              ) : null}
            </div>
          ))}
          {hasOlder ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? "Loading…" : "Load older"}
            </Button>
          ) : null}
          {terminals.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No project terminals yet.</p>
          ) : null}
        </nav>
        <div
          ref={containerRef}
          className="relative min-h-0 min-w-0 flex-1 bg-[var(--terminal-background)]"
          data-terminal-view-mode={state.mode}
        >
          {selectedTerminal ? (
            <div className="pointer-events-none absolute right-2 top-2 z-10 rounded bg-background/80 px-2 py-1 text-[10px] text-muted-foreground">
              {selectedTerminal.label} · {session.status}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a project terminal to attach.
            </div>
          )}
          {attachment.error ? (
            <div className="absolute inset-x-2 bottom-2 rounded bg-background/90 p-2 text-xs text-destructive">
              {String(attachment.error)}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function useProjectMetadata(environmentId: string, projectId: string) {
  return useEnvironmentQuery(
    terminalEnvironment.projectMetadata({
      environmentId: environmentId as never,
      input: { projectId: projectId as never },
    }),
  );
}
