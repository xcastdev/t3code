import {
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  type ProjectTerminalAttachStreamEvent,
  type ProjectTerminalDockSummary,
  type ProjectTerminalHandle,
  type ProjectTerminalMetadataStreamEvent,
  type ProjectTerminalStatus,
} from "@t3tools/contracts";

export type ProjectTerminalViewPhase = "attaching" | "live" | "exited" | "closed" | "reconnecting";

export interface ProjectTerminalViewState {
  readonly handle: ProjectTerminalHandle;
  readonly terminal: ProjectTerminalDockSummary | null;
  readonly phase: ProjectTerminalViewPhase;
  readonly history: string;
  readonly sequence: number;
  readonly cols: number | null;
  readonly rows: number | null;
  /** Earlier output was dropped by this client's bound, on top of the server's own retention. */
  readonly trimmed: boolean;
  /** What the last applied event changed, so an imperative renderer can replay it. */
  readonly lastWrite: { readonly type: "reset" | "append"; readonly data: string } | null;
}

export function initialProjectTerminalView(
  handle: ProjectTerminalHandle,
): ProjectTerminalViewState {
  return {
    handle,
    terminal: null,
    phase: "attaching",
    history: "",
    sequence: -1,
    cols: null,
    rows: null,
    trimmed: false,
    lastWrite: null,
  };
}

function boundHistory(history: string, limit: number): { history: string; trimmed: boolean } {
  if (history.length <= limit) return { history, trimmed: false };
  return { history: history.slice(history.length - limit), trimmed: true };
}

const sameHandle = (left: ProjectTerminalHandle, right: ProjectTerminalHandle) =>
  left.projectId === right.projectId && left.terminalId === right.terminalId;

/**
 * Folds one attach event. Snapshots replace the history (a reattach or a new
 * generation), output at or below the applied sequence is a replay and is
 * dropped, and events for another handle are ignored.
 */
export function applyProjectTerminalAttachEvent(
  state: ProjectTerminalViewState,
  event: ProjectTerminalAttachStreamEvent,
  limit = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): ProjectTerminalViewState {
  if (event.type === "snapshot") {
    const { snapshot } = event;
    if (!sameHandle(snapshot.terminal, state.handle)) return state;
    const bounded = boundHistory(snapshot.history, limit);
    return {
      ...state,
      terminal: snapshot.terminal,
      phase: isProjectTerminalRunning(snapshot.terminal.status) ? "live" : "exited",
      history: bounded.history,
      sequence: snapshot.sequence,
      cols: snapshot.cols,
      rows: snapshot.rows,
      trimmed: bounded.trimmed,
      lastWrite: { type: "reset", data: bounded.history },
    };
  }
  if (!sameHandle(event.handle, state.handle)) return state;
  // Control markers carry the sequence already reached rather than a new one,
  // so the replay guard below would discard them.
  if (event.type === "closed")
    return {
      ...state,
      sequence: Math.max(state.sequence, event.sequence),
      phase: "closed",
      lastWrite: null,
    };
  if (event.type === "reconnect")
    // The server lost continuity for this reader; only a fresh attach snapshot is authoritative.
    return {
      ...state,
      sequence: Math.max(state.sequence, event.sequence),
      phase: "reconnecting",
      lastWrite: null,
    };
  // Until a snapshot arrives, nothing anchors the sequence, so earlier events are not trusted.
  if (state.terminal === null || event.sequence <= state.sequence) return state;
  switch (event.type) {
    case "output": {
      const bounded = boundHistory(state.history + event.data, limit);
      return {
        ...state,
        history: bounded.history,
        sequence: event.sequence,
        trimmed: state.trimmed || bounded.trimmed,
        lastWrite: { type: "append", data: event.data },
      };
    }
    case "resized":
      return {
        ...state,
        sequence: event.sequence,
        cols: event.cols,
        rows: event.rows,
        lastWrite: null,
      };
    case "exited":
      return {
        ...state,
        sequence: event.sequence,
        phase: "exited",
        terminal:
          state.terminal === null
            ? null
            : {
                ...state.terminal,
                status: event.status,
                exitCode: event.exitCode,
                exitSignal: event.exitSignal,
              },
        lastWrite: null,
      };
  }
}

const FINAL_STATUSES: ReadonlySet<ProjectTerminalStatus> = new Set(["exited", "killed", "error"]);

// Lifecycle order within one generation. The server moves a terminal to
// `stopping` or `unknown` without restamping `updatedAt`, so on a timestamp
// tie the later lifecycle stage is the newer fact.
const STATUS_STAGE: Record<ProjectTerminalStatus, number> = {
  starting: 0,
  running: 1,
  stopping: 2,
  unknown: 2,
  exited: 3,
  killed: 3,
  error: 3,
};

/**
 * The status to show for a viewer: its attach stream and the project metadata
 * stream both report the terminal, and neither is always newer. A finished
 * generation stays finished; otherwise the later update wins, so a metadata
 * `stopping` or `unknown` is never hidden behind the attach snapshot. Ties go
 * to the later lifecycle stage, then to metadata, which keeps the viewer
 * passive rather than writable when the order is unknown.
 */
export function effectiveProjectTerminal(
  attached: ProjectTerminalDockSummary | null,
  listed: ProjectTerminalDockSummary,
): ProjectTerminalDockSummary {
  if (attached === null) return listed;
  const sameGeneration = attached.generation === listed.generation;
  if (sameGeneration) {
    if (FINAL_STATUSES.has(attached.status) !== FINAL_STATUSES.has(listed.status))
      return FINAL_STATUSES.has(attached.status) ? attached : listed;
  }
  if (listed.updatedAt !== attached.updatedAt)
    return listed.updatedAt > attached.updatedAt ? listed : attached;
  if (sameGeneration && STATUS_STAGE[attached.status] > STATUS_STAGE[listed.status])
    return attached;
  return listed;
}

/**
 * Input, resize and stop target the process the viewer is showing. A newer
 * generation in metadata means the viewer is behind, so it stays passive until
 * its attach stream catches up.
 */
export function isProjectTerminalViewLive(
  state: Pick<ProjectTerminalViewState, "phase" | "terminal">,
  shown: ProjectTerminalDockSummary,
): boolean {
  return (
    state.terminal !== null &&
    state.phase === "live" &&
    state.terminal.generation === shown.generation &&
    isProjectTerminalRunning(shown.status)
  );
}

export function isProjectTerminalRunning(status: ProjectTerminalStatus): boolean {
  return status === "starting" || status === "running";
}

/** Truthful wording: `unknown` and `stopping` never read as stopped. */
export function projectTerminalStatusLabel(
  terminal: Pick<ProjectTerminalDockSummary, "status" | "exitCode" | "exitSignal">,
): string {
  switch (terminal.status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
    case "unknown":
      return "State unknown";
    case "killed":
      return terminal.exitSignal === null ? "Stopped" : `Stopped (signal ${terminal.exitSignal})`;
    case "exited":
      return terminal.exitCode === null ? "Exited" : `Exited with code ${terminal.exitCode}`;
    case "error":
      return "Failed";
  }
}

export interface ProjectTerminalDockState {
  readonly terminals: ReadonlyArray<ProjectTerminalDockSummary>;
  /** False until the first metadata snapshot; an empty list is only trusted after it. */
  readonly received: boolean;
  /** The server holds more terminals than its first page. */
  readonly truncated: boolean;
}

export const EMPTY_PROJECT_TERMINAL_DOCK: ProjectTerminalDockState = {
  terminals: [],
  received: false,
  truncated: false,
};

const DOCK_LIMIT = 100;

const compareTerminals = (left: ProjectTerminalDockSummary, right: ProjectTerminalDockSummary) =>
  left.terminalId.localeCompare(right.terminalId, undefined, { numeric: true });

export function applyProjectTerminalMetadataEvent(
  state: ProjectTerminalDockState,
  projectId: string,
  event: ProjectTerminalMetadataStreamEvent,
): ProjectTerminalDockState {
  switch (event.type) {
    case "snapshot":
      if (event.projectId !== projectId) return state;
      return {
        terminals: [...event.terminals].sort(compareTerminals),
        received: true,
        truncated: event.nextCursor !== null,
      };
    case "upsert": {
      if (!state.received || event.terminal.projectId !== projectId) return state;
      const rest = state.terminals.filter(
        (terminal) => terminal.terminalId !== event.terminal.terminalId,
      );
      if (rest.length >= DOCK_LIMIT) return { ...state, truncated: true };
      return { ...state, terminals: [...rest, event.terminal].sort(compareTerminals) };
    }
    case "remove":
      if (!state.received || event.projectId !== projectId) return state;
      return {
        ...state,
        terminals: state.terminals.filter((terminal) => terminal.terminalId !== event.terminalId),
      };
  }
}

/** The server's typed reason, phrased as what happened and what the user can do. */
export function describeProjectTerminalFailure(error: unknown): string {
  if (error === null || typeof error !== "object" || !("_tag" in error))
    return "The environment couldn't reach this terminal. Check the connection and try again.";
  if (error._tag === "EnvironmentAuthorizationError")
    return "This connection isn't allowed to operate project terminals on this environment.";
  if (error._tag !== "TerminalToolError" || !("reason" in error))
    return "The environment couldn't reach this terminal. Check the connection and try again.";
  switch (error.reason) {
    case "stale-generation":
      return "This terminal was restarted. Showing the current process; resend if needed.";
    case "not-running":
      return "This terminal isn't running anymore.";
    case "stop-uncertain":
      return "The stop request couldn't be confirmed. The process may still be running.";
    case "unavailable":
      return "Project terminals aren't available on this environment.";
    default:
      return `The terminal rejected this (${String(error.reason)}).`;
  }
}
