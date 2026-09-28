import { describe, expect, it } from "vite-plus/test";

import { BoundedTerminalHistory } from "./History.ts";

describe("BoundedTerminalHistory absolute reads", () => {
  it("tracks absolute byte positions through eviction and resumes with an explicit gap", () => {
    const history = new BoundedTerminalHistory(5_000, "", 5);
    history.append("0123456789");

    expect(history.startPosition).toBe(5);
    expect(history.endPosition).toBe(10);
    expect(history.read(0, 2)).toEqual({
      kind: "read",
      output: "56",
      nextPosition: 7,
      hasMore: true,
      truncated: true,
    });
    expect(history.read(7, 8)).toEqual({
      kind: "read",
      output: "789",
      nextPosition: 10,
      hasMore: false,
      truncated: false,
    });
    expect(history.read(-1, 2)).toEqual({ kind: "invalid-position" });
    expect(history.read(11, 2)).toEqual({ kind: "invalid-position" });
  });

  it("keeps UTF-8 code points intact at byte-budget boundaries", () => {
    const history = new BoundedTerminalHistory(5_000, "a😀éz");

    expect(history.read(0, 3)).toEqual({
      kind: "read",
      output: "a",
      nextPosition: 1,
      hasMore: true,
      truncated: false,
    });
    expect(history.read(1, 4)).toEqual({
      kind: "read",
      output: "😀",
      nextPosition: 5,
      hasMore: true,
      truncated: false,
    });
    expect(history.read(1, 3)).toEqual({ kind: "invalid-budget" });
    expect(history.read(2, 8)).toEqual({ kind: "invalid-position" });
  });

  it("invalidates positions when cleared and returns a bounded line tail", () => {
    const history = new BoundedTerminalHistory(5_000, "one\ntwo\nthree");
    const firstGeneration = history.generation;

    expect(history.tail(2, 8)).toEqual({
      kind: "read",
      output: "wo\nthree",
      nextPosition: 13,
      hasMore: false,
      truncated: true,
    });

    history.clear();
    expect(history.generation).not.toBe(firstGeneration);
    expect(history.read(0, 8)).toEqual({
      kind: "read",
      output: "",
      nextPosition: 0,
      hasMore: false,
      truncated: false,
    });
  });

  it("joins a surrogate split across output callbacks before assigning its final byte position", () => {
    const history = new BoundedTerminalHistory(5_000, "");
    history.append("\ud83d");
    expect(history.read(0, 4)).toEqual({
      kind: "read",
      output: "",
      nextPosition: 0,
      hasMore: false,
      truncated: false,
    });
    history.append("\ude80");

    expect(history.endPosition).toBe(4);
    expect(history.read(0, 3)).toEqual({ kind: "invalid-budget" });
    expect(history.read(0, 4)).toEqual({
      kind: "read",
      output: "🚀",
      nextPosition: 4,
      hasMore: false,
      truncated: false,
    });
  });

  it("replaces isolated surrogates while preserving valid pairs in a returned slice", () => {
    const history = new BoundedTerminalHistory(5_000, "a\ud83db\udc00c😀");

    expect(history.read(0, 32)).toEqual({
      kind: "read",
      output: "a\uFFFDb\uFFFDc😀",
      nextPosition: 13,
      hasMore: false,
      truncated: false,
    });
  });

  it("finalizes an unmatched trailing surrogate without moving an exposed cursor", () => {
    const history = new BoundedTerminalHistory(5_000, "");
    history.append("before\ud83d");
    const pending = history.read(0, 32);
    expect(pending).toEqual({
      kind: "read",
      output: "before",
      nextPosition: 6,
      hasMore: false,
      truncated: false,
    });

    history.finalizePendingCodePoint();
    expect(history.endPosition).toBe(9);
    expect(history.read(pending.kind === "read" ? pending.nextPosition : 0, 3)).toEqual({
      kind: "read",
      output: "\uFFFD",
      nextPosition: 9,
      hasMore: false,
      truncated: false,
    });
  });

  it("keeps tail reads on line boundaries when the byte budget permits", () => {
    const history = new BoundedTerminalHistory(2, "one\ntwo\nthree\n");

    expect(history.startPosition).toBe(4);
    expect(history.tail(1, 16)).toEqual({
      kind: "read",
      output: "three\n",
      nextPosition: 14,
      hasMore: false,
      truncated: false,
    });
    expect(history.tail(2, 16)).toEqual({
      kind: "read",
      output: "two\nthree\n",
      nextPosition: 14,
      hasMore: false,
      truncated: false,
    });
  });

  it("does not mark a tail truncated when line eviction retained all requested lines", () => {
    const history = new BoundedTerminalHistory(2, "a\nbc\nxy\n");

    expect(history.tail(2, 100)).toEqual({
      kind: "read",
      output: "bc\nxy\n",
      nextPosition: 8,
      hasMore: false,
      truncated: false,
    });
  });

  it("excludes an unreadable trailing surrogate from the tail byte budget", () => {
    const history = new BoundedTerminalHistory(20, "abcdef\ud83d");

    expect(history.tail(1, 4)).toEqual({
      kind: "read",
      output: "cdef",
      nextPosition: 6,
      hasMore: false,
      truncated: true,
    });
    expect(history.tail(1, 1)).toEqual({
      kind: "read",
      output: "f",
      nextPosition: 6,
      hasMore: false,
      truncated: true,
    });
  });

  it("slices a long unterminated line from retained chunks and rejects an impossible tail budget", () => {
    const history = new BoundedTerminalHistory(5_000, "", 8);
    history.append(`${"a".repeat(20_000)}é🚀`);

    expect(history.endPosition).toBe(20_006);
    expect(history.startPosition).toBe(19_998);
    expect(history.read(0, 2)).toEqual({
      kind: "read",
      output: "aa",
      nextPosition: 20_000,
      hasMore: true,
      truncated: true,
    });
    expect(history.read(20_000, 2)).toEqual({
      kind: "read",
      output: "é",
      nextPosition: 20_002,
      hasMore: true,
      truncated: false,
    });
    expect(history.tail(1, 1)).toEqual({ kind: "invalid-budget" });
  });
});
