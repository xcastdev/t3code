import type {
  EnvironmentId,
  ProjectTerminalAttachSnapshot,
  ProjectTerminalAttachStreamEvent,
  ProjectTerminalDockSummary,
  ProjectTerminalMetadataStreamEvent,
  TerminalAttachStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";
import {
  appendOutput,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  EMPTY_TERMINAL_OUTPUT_STATE,
  resetOutput,
  type TerminalOutputState,
} from "./terminalOutput.ts";

export {
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  terminalOutputText,
  type TerminalOutputCursor,
  type TerminalOutputState,
  type TerminalOutputUpdate,
} from "./terminalOutput.ts";

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly output: TerminalOutputState;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
  readonly lifecycleVersion: number;
}

export interface TerminalBufferState {
  readonly output: TerminalOutputState;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly version: number;
  readonly lifecycleVersion: number;
}

export interface ProjectTerminalBufferState {
  readonly terminal: ProjectTerminalDockSummary | null;
  readonly output: TerminalOutputState;
  readonly status: ProjectTerminalDockSummary["status"] | "closed";
  readonly cols: number;
  readonly rows: number;
  readonly sequence: number;
  readonly error: string | null;
  readonly version: number;
}

export interface ProjectTerminalMetadataState {
  readonly terminals: ReadonlyArray<ProjectTerminalDockSummary>;
  readonly nextCursor: string | null;
  readonly snapshotVersion: number;
  /** Advances on every snapshot or delta so an in-flight page can be discarded. */
  readonly revision: number;
  readonly removedTerminalIds: ReadonlyArray<string>;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> {
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId);
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  output: EMPTY_TERMINAL_OUTPUT_STATE,
  status: "closed",
  error: null,
  updatedAt: null,
  version: 0,
  lifecycleVersion: 0,
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  output: EMPTY_TERMINAL_OUTPUT_STATE,
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  version: 0,
  lifecycleVersion: 0,
});

export const EMPTY_PROJECT_TERMINAL_BUFFER_STATE = Object.freeze<ProjectTerminalBufferState>({
  terminal: null,
  output: EMPTY_TERMINAL_OUTPUT_STATE,
  status: "closed",
  cols: 80,
  rows: 24,
  sequence: 0,
  error: null,
  version: 0,
});

let terminalAttachGeneration = 0;

/** A reinstalled attach stream must not reuse an old renderer's output cursor. */
export function nextTerminalAttachSeedState(): TerminalBufferState {
  return {
    ...EMPTY_TERMINAL_BUFFER_STATE,
    output: {
      ...EMPTY_TERMINAL_OUTPUT_STATE,
      generation: ++terminalAttachGeneration,
    },
  };
}

function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
  current: TerminalBufferState = EMPTY_TERMINAL_BUFFER_STATE,
): TerminalBufferState {
  return {
    output: resetOutput(current.output, snapshot.history, maxBufferBytes),
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    version: current.version + 1,
    lifecycleVersion: current.lifecycleVersion,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    output: buffer.output,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    version: buffer.version,
    lifecycleVersion: buffer.lifecycleVersion,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "snapshot":
      return {
        ...terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes, current),
        lifecycleVersion:
          current.version === 0 ? current.lifecycleVersion : current.lifecycleVersion + 1,
      };
    case "restarted":
      return {
        ...terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes, current),
        lifecycleVersion: current.lifecycleVersion + 1,
      };
    case "output":
      return {
        ...current,
        output: appendOutput(current.output, event.data, maxBufferBytes),
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        version: current.version + 1,
      };
    case "cleared":
      return {
        ...current,
        output: resetOutput(current.output, "", maxBufferBytes),
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

export function applyProjectTerminalAttachStreamEvent(
  current: ProjectTerminalBufferState,
  event: ProjectTerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): ProjectTerminalBufferState {
  switch (event.type) {
    case "snapshot": {
      const snapshot: ProjectTerminalAttachSnapshot = event.snapshot;
      return {
        terminal: snapshot.terminal,
        output: resetOutput(current.output, snapshot.history, maxBufferBytes),
        status: snapshot.terminal.status,
        cols: snapshot.cols,
        rows: snapshot.rows,
        sequence: snapshot.sequence,
        error: null,
        version: current.version + 1,
      };
    }
    case "output":
      if (event.sequence <= current.sequence) return current;
      return {
        ...current,
        output: appendOutput(current.output, event.data, maxBufferBytes),
        sequence: event.sequence,
        version: current.version + 1,
      };
    case "resized":
      if (event.sequence <= current.sequence) return current;
      return {
        ...current,
        cols: event.cols,
        rows: event.rows,
        sequence: event.sequence,
        version: current.version + 1,
      };
    case "exited":
      if (event.sequence <= current.sequence) return current;
      return {
        ...current,
        status: event.status,
        terminal: current.terminal
          ? {
              ...current.terminal,
              status: event.status,
              exitCode: event.exitCode,
              exitSignal: event.exitSignal,
            }
          : null,
        sequence: event.sequence,
        version: current.version + 1,
      };
    case "closed":
      if (event.sequence <= current.sequence) return current;
      return {
        ...current,
        status: "closed",
        sequence: event.sequence,
        version: current.version + 1,
      };
    case "reconnect":
      return {
        ...current,
        error: "Terminal output fell behind. Reconnecting…",
        version: current.version + 1,
      };
  }
}

export function applyProjectTerminalMetadataStreamEvent(
  current: ProjectTerminalMetadataState,
  event: ProjectTerminalMetadataStreamEvent,
): ProjectTerminalMetadataState {
  if (event.type === "snapshot") {
    return {
      terminals: event.terminals,
      nextCursor: event.nextCursor,
      snapshotVersion: current.snapshotVersion + 1,
      revision: current.revision + 1,
      removedTerminalIds: [],
    };
  }
  if (event.type === "remove") {
    return {
      ...current,
      revision: current.revision + 1,
      terminals: current.terminals.filter(
        (terminal) =>
          terminal.projectId !== event.projectId || terminal.terminalId !== event.terminalId,
      ),
      removedTerminalIds: current.removedTerminalIds.includes(event.terminalId)
        ? current.removedTerminalIds
        : [...current.removedTerminalIds, event.terminalId],
    };
  }
  const next = current.terminals.filter(
    (terminal) =>
      terminal.projectId !== event.terminal.projectId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return {
    ...current,
    revision: current.revision + 1,
    removedTerminalIds: current.removedTerminalIds.filter(
      (terminalId) => terminalId !== event.terminal.terminalId,
    ),
    terminals: [...next, event.terminal].sort((left, right) =>
      left.terminalId.localeCompare(right.terminalId),
    ),
  };
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot") {
    return event.terminals;
  }
  if (event.type === "remove") {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    );
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return [...next, event.terminal];
}
