import { describe, expect, it } from "vite-plus/test";

import { BoundedTerminalHistory } from "./History.ts";
import { MAX_TERMINAL_SEARCH_SCAN_BYTES, searchTerminalOutput } from "./OutputSearch.ts";

describe("bounded terminal output search", () => {
  it("searches literal text and reports absolute UTF-8 positions", () => {
    const history = new BoundedTerminalHistory(5_000, "x a.*b / aXb y");

    expect(
      searchTerminalOutput(history, {
        position: 0,
        text: "a.*b",
        ignoreCase: false,
        maxBytes: 16,
      }),
    ).toMatchObject({
      kind: "search",
      matches: [{ start: 2, end: 6 }],
      hasMore: false,
      truncated: false,
    });
  });

  it("maps case-insensitive matches back to their source byte positions", () => {
    const history = new BoundedTerminalHistory(5_000, "Café café");

    const result = searchTerminalOutput(history, {
      position: 0,
      text: "CAFÉ",
      ignoreCase: true,
      maxBytes: 16,
    });

    expect(result).toMatchObject({
      kind: "search",
      matches: [
        { start: 0, end: 5 },
        { start: 6, end: 11 },
      ],
      hasMore: false,
    });
    if (result.kind === "search") {
      expect(
        result.matches.reduce((total, match) => total + Buffer.byteLength(match.excerpt), 0),
      ).toBeLessThanOrEqual(16);
    }
  });

  it("preserves source bounds when a Unicode lowercase mapping expands", () => {
    const history = new BoundedTerminalHistory(5_000, "xİy");

    expect(
      searchTerminalOutput(history, {
        position: 0,
        text: "i\u0307",
        ignoreCase: true,
        maxBytes: 16,
      }),
    ).toMatchObject({
      kind: "search",
      matches: [{ start: 1, end: 3 }],
      hasMore: false,
    });
  });

  it("returns overlapping literal matches once each", () => {
    const history = new BoundedTerminalHistory(5_000, "aaaa");

    expect(
      searchTerminalOutput(history, {
        position: 0,
        text: "aa",
        ignoreCase: false,
        maxBytes: 32,
      }),
    ).toMatchObject({
      kind: "search",
      matches: [
        { start: 0, end: 2 },
        { start: 1, end: 3 },
        { start: 2, end: 4 },
      ],
      hasMore: false,
    });
  });

  it("advances after a bounded no-match scan and finds later matches on continuation", () => {
    const history = new BoundedTerminalHistory(5_000, `${"x".repeat(300_000)}needle`);

    const first = searchTerminalOutput(history, {
      position: 0,
      text: "needle",
      ignoreCase: false,
      maxBytes: 16,
    });
    expect(first).toMatchObject({
      kind: "search",
      matches: [],
      nextPosition: MAX_TERMINAL_SEARCH_SCAN_BYTES,
      hasMore: true,
    });

    const nextPosition = first.kind === "search" ? first.nextPosition : 0;
    expect(
      searchTerminalOutput(history, {
        position: nextPosition,
        text: "needle",
        ignoreCase: false,
        maxBytes: 16,
      }),
    ).toMatchObject({
      kind: "search",
      matches: [{ start: 300_000, end: 300_006 }],
      hasMore: false,
    });
  });

  it("finds a match that spans a scan window without repeating it on continuation", () => {
    const history = new BoundedTerminalHistory(
      5_000,
      `${"x".repeat(MAX_TERMINAL_SEARCH_SCAN_BYTES - 2)}abcd${"x".repeat(20)}`,
    );

    const first = searchTerminalOutput(history, {
      position: 0,
      text: "abcd",
      ignoreCase: false,
      maxBytes: 8,
    });
    expect(first).toMatchObject({
      kind: "search",
      matches: [
        { start: MAX_TERMINAL_SEARCH_SCAN_BYTES - 2, end: MAX_TERMINAL_SEARCH_SCAN_BYTES + 2 },
      ],
      hasMore: true,
    });

    const nextPosition = first.kind === "search" ? first.nextPosition : 0;
    expect(
      searchTerminalOutput(history, {
        position: nextPosition,
        text: "abcd",
        ignoreCase: false,
        maxBytes: 8,
      }),
    ).toMatchObject({ kind: "search", matches: [], hasMore: false });
  });

  it("uses source-code-point lookahead when case folding changes UTF-8 widths", () => {
    const prefix = "x".repeat(MAX_TERMINAL_SEARCH_SCAN_BYTES - 3);
    const history = new BoundedTerminalHistory(5_000, `${prefix}${"K".repeat(10)}`);

    const first = searchTerminalOutput(history, {
      position: 0,
      text: "k".repeat(10),
      ignoreCase: true,
      maxBytes: 1_000,
    });
    expect(first).toMatchObject({
      kind: "search",
      matches: [
        { start: MAX_TERMINAL_SEARCH_SCAN_BYTES - 3, end: MAX_TERMINAL_SEARCH_SCAN_BYTES + 27 },
      ],
      hasMore: true,
    });

    if (first.kind !== "search") return;
    expect(
      searchTerminalOutput(history, {
        position: first.nextPosition,
        text: "k".repeat(10),
        ignoreCase: true,
        maxBytes: 1_000,
      }),
    ).toMatchObject({ kind: "search", matches: [], hasMore: false });
  });

  it("keeps a one-byte query moving when lookahead starts at a four-byte character", () => {
    const history = new BoundedTerminalHistory(
      5_000,
      `${"x".repeat(MAX_TERMINAL_SEARCH_SCAN_BYTES - 1)}🚀`,
    );

    expect(
      searchTerminalOutput(history, {
        position: 0,
        text: "z",
        ignoreCase: false,
        maxBytes: 1,
      }),
    ).toMatchObject({
      kind: "search",
      matches: [],
      nextPosition: MAX_TERMINAL_SEARCH_SCAN_BYTES - 1,
      hasMore: true,
    });
  });

  it("keeps excerpts within the byte budget and resumes at an unreturned match", () => {
    const history = new BoundedTerminalHistory(5_000, "hit---hit");

    const first = searchTerminalOutput(history, {
      position: 0,
      text: "hit",
      ignoreCase: false,
      maxBytes: 4,
    });
    expect(first).toMatchObject({
      kind: "search",
      matches: [{ start: 0, end: 3 }],
      nextPosition: 6,
      hasMore: true,
    });
    if (first.kind !== "search") return;
    expect(
      first.matches.reduce((total, match) => total + Buffer.byteLength(match.excerpt), 0),
    ).toBeLessThanOrEqual(4);

    expect(
      searchTerminalOutput(history, {
        position: first.nextPosition,
        text: "hit",
        ignoreCase: false,
        maxBytes: 4,
      }),
    ).toMatchObject({
      kind: "search",
      matches: [{ start: 6, end: 9 }],
      hasMore: false,
    });
  });

  it("rejects an output budget too small to include a full match", () => {
    const history = new BoundedTerminalHistory(5_000, "result");

    expect(
      searchTerminalOutput(history, {
        position: 0,
        text: "result",
        ignoreCase: false,
        maxBytes: 5,
      }),
    ).toEqual({ kind: "invalid-budget" });
  });
});
