import { ProjectId, ThreadId, type ProjectTerminalDockSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProjectTerminalAttachEvent,
  applyProjectTerminalMetadataEvent,
  EMPTY_PROJECT_TERMINAL_DOCK,
  effectiveProjectTerminal,
  initialProjectTerminalView,
  isProjectTerminalViewLive,
  projectTerminalStatusLabel,
} from "./projectTerminalView.ts";

const projectId = ProjectId.make("project-1");
const handle = { projectId, terminalId: "term-1" };

function summary(overrides: Partial<ProjectTerminalDockSummary> = {}): ProjectTerminalDockSummary {
  return {
    generation: "gen-1",
    projectId,
    terminalId: "term-1",
    creatingThreadId: ThreadId.make("thread-1"),
    label: "dev server",
    status: "running",
    cols: 80,
    rows: 24,
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-21T00:00:00.000Z",
    ...overrides,
  };
}

const snapshot = (history: string, sequence: number, terminal = summary()) =>
  ({
    type: "snapshot",
    snapshot: { terminal, history, cols: 80, rows: 24, sequence },
  }) as const;

describe("applyProjectTerminalAttachEvent", () => {
  it("drops replayed output after a snapshot and appends newer output", () => {
    let state = applyProjectTerminalAttachEvent(
      initialProjectTerminalView(handle),
      snapshot("hello", 4),
    );
    state = applyProjectTerminalAttachEvent(state, {
      type: "output",
      handle,
      sequence: 4,
      data: " replay",
    });
    expect(state.history).toBe("hello");
    state = applyProjectTerminalAttachEvent(state, {
      type: "output",
      handle,
      sequence: 5,
      data: " world",
    });
    expect(state).toMatchObject({
      history: "hello world",
      phase: "live",
      lastWrite: { type: "append", data: " world" },
    });
  });

  it("waits for a fresh snapshot after reconnect and resets to the new generation", () => {
    let state = applyProjectTerminalAttachEvent(
      initialProjectTerminalView(handle),
      snapshot("old", 1),
    );
    state = applyProjectTerminalAttachEvent(state, { type: "reconnect", handle, sequence: 2 });
    expect(state.phase).toBe("reconnecting");
    state = applyProjectTerminalAttachEvent(
      state,
      snapshot("new", 0, summary({ generation: "gen-2" })),
    );
    expect(state).toMatchObject({
      phase: "live",
      history: "new",
      terminal: { generation: "gen-2" },
      lastWrite: { type: "reset", data: "new" },
    });
  });

  it("applies reconnect and close markers that carry the sequence already reached", () => {
    let state = applyProjectTerminalAttachEvent(
      initialProjectTerminalView(handle),
      snapshot("abc", 6),
    );
    state = applyProjectTerminalAttachEvent(state, { type: "reconnect", handle, sequence: 6 });
    expect(state).toMatchObject({ phase: "reconnecting", sequence: 6, history: "abc" });
    // Output that raced the marker must not pull the viewer back to live.
    state = applyProjectTerminalAttachEvent(state, {
      type: "output",
      handle,
      sequence: 7,
      data: "d",
    });
    expect(state.phase).toBe("reconnecting");
    state = applyProjectTerminalAttachEvent(state, snapshot("abcdef", 9));
    expect(state).toMatchObject({ phase: "live", sequence: 9, history: "abcdef" });
    state = applyProjectTerminalAttachEvent(state, { type: "closed", handle, sequence: 9 });
    expect(state.phase).toBe("closed");
    const other = { projectId, terminalId: "term-2" };
    expect(
      applyProjectTerminalAttachEvent(state, { type: "reconnect", handle: other, sequence: 99 }),
    ).toBe(state);
  });

  it("ignores events that arrive before the first snapshot", () => {
    const initial = initialProjectTerminalView(handle);
    expect(
      applyProjectTerminalAttachEvent(initial, { type: "output", handle, sequence: 7, data: "x" }),
    ).toBe(initial);
    expect(
      applyProjectTerminalMetadataEvent(EMPTY_PROJECT_TERMINAL_DOCK, projectId, {
        type: "upsert",
        terminal: summary(),
      }),
    ).toBe(EMPTY_PROJECT_TERMINAL_DOCK);
  });

  it("ignores events for another terminal and bounds retained history", () => {
    const other = { projectId, terminalId: "term-2" };
    let state = applyProjectTerminalAttachEvent(
      initialProjectTerminalView(handle),
      snapshot("abc", 0),
      4,
    );
    expect(
      applyProjectTerminalAttachEvent(state, {
        type: "output",
        handle: other,
        sequence: 9,
        data: "x",
      }),
    ).toBe(state);
    state = applyProjectTerminalAttachEvent(
      state,
      { type: "output", handle, sequence: 1, data: "def" },
      4,
    );
    expect(state).toMatchObject({ history: "cdef", trimmed: true });
  });

  it("records exit status without claiming the process is gone on stop requests", () => {
    let state = applyProjectTerminalAttachEvent(
      initialProjectTerminalView(handle),
      snapshot("", 0),
    );
    state = applyProjectTerminalAttachEvent(state, {
      type: "exited",
      handle,
      sequence: 1,
      status: "exited",
      exitCode: 2,
      exitSignal: null,
    });
    expect(state.phase).toBe("exited");
    expect(projectTerminalStatusLabel(state.terminal!)).toBe("Exited with code 2");
    expect(projectTerminalStatusLabel(summary({ status: "unknown" }))).toBe("State unknown");
  });
});

describe("effectiveProjectTerminal", () => {
  it("shows a newer metadata status instead of the attach snapshot", () => {
    const attached = summary();
    const stopping = summary({ status: "stopping", updatedAt: "2026-10-21T00:00:05.000Z" });
    expect(effectiveProjectTerminal(attached, stopping).status).toBe("stopping");
    const unknown = summary({ status: "unknown", updatedAt: "2026-10-21T00:00:06.000Z" });
    expect(effectiveProjectTerminal(attached, unknown).status).toBe("unknown");
    expect(effectiveProjectTerminal(null, unknown)).toBe(unknown);
    // A stale metadata row never reverts what the attach stream already knows.
    const newer = summary({ updatedAt: "2026-10-21T00:00:09.000Z" });
    expect(effectiveProjectTerminal(newer, stopping)).toBe(newer);
  });

  it("lets same-time stopping or unknown metadata supersede a running attach", () => {
    const state = applyProjectTerminalAttachEvent(
      initialProjectTerminalView(handle),
      snapshot("", 0),
    );
    // The server's stop path changes status without restamping updatedAt.
    for (const status of ["stopping", "unknown"] as const) {
      const listed = summary({ status });
      const shown = effectiveProjectTerminal(state.terminal, listed);
      expect(shown.status).toBe(status);
      expect(isProjectTerminalViewLive(state, shown)).toBe(false);
    }
    // An attach that already moved further at the same time is not reverted.
    const stoppingAttach = summary({ status: "stopping" });
    expect(effectiveProjectTerminal(stoppingAttach, summary())).toBe(stoppingAttach);
    // A same-time row from another generation keeps the viewer passive.
    const other = summary({ generation: "gen-2" });
    expect(isProjectTerminalViewLive(state, effectiveProjectTerminal(state.terminal, other))).toBe(
      false,
    );
  });

  it("keeps a finished generation finished, whichever stream reported it", () => {
    const exited = summary({ status: "exited", exitCode: 0 });
    const lateRunning = summary({ status: "stopping", updatedAt: "2026-10-21T00:00:05.000Z" });
    expect(effectiveProjectTerminal(exited, lateRunning)).toBe(exited);
    const killed = summary({ status: "killed", updatedAt: "2026-10-21T00:00:01.000Z" });
    expect(effectiveProjectTerminal(summary(), killed)).toBe(killed);
  });

  it("stays passive while metadata reports a generation the viewer has not attached", () => {
    const state = applyProjectTerminalAttachEvent(
      initialProjectTerminalView(handle),
      snapshot("", 0),
    );
    expect(
      isProjectTerminalViewLive(state, effectiveProjectTerminal(state.terminal, summary())),
    ).toBe(true);
    const restarted = summary({ generation: "gen-2", updatedAt: "2026-10-21T00:00:05.000Z" });
    expect(
      isProjectTerminalViewLive(state, effectiveProjectTerminal(state.terminal, restarted)),
    ).toBe(false);
    const stopping = summary({ status: "stopping", updatedAt: "2026-10-21T00:00:05.000Z" });
    expect(
      isProjectTerminalViewLive(state, effectiveProjectTerminal(state.terminal, stopping)),
    ).toBe(false);
  });
});

describe("applyProjectTerminalMetadataEvent", () => {
  it("only trusts an empty list after the first snapshot and keeps project isolation", () => {
    expect(EMPTY_PROJECT_TERMINAL_DOCK.received).toBe(false);
    let state = applyProjectTerminalMetadataEvent(EMPTY_PROJECT_TERMINAL_DOCK, projectId, {
      type: "snapshot",
      projectId,
      terminals: [],
      nextCursor: null,
    });
    expect(state).toEqual({ terminals: [], received: true, truncated: false });
    state = applyProjectTerminalMetadataEvent(state, projectId, {
      type: "upsert",
      terminal: summary({ projectId: ProjectId.make("other") }),
    });
    expect(state.terminals).toEqual([]);
    state = applyProjectTerminalMetadataEvent(state, projectId, {
      type: "upsert",
      terminal: summary(),
    });
    state = applyProjectTerminalMetadataEvent(state, projectId, {
      type: "upsert",
      terminal: summary({ status: "stopping" }),
    });
    expect(state.terminals.map((terminal) => terminal.status)).toEqual(["stopping"]);
    state = applyProjectTerminalMetadataEvent(state, projectId, {
      type: "remove",
      projectId,
      terminalId: "term-1",
    });
    expect(state.terminals).toEqual([]);
  });
});
