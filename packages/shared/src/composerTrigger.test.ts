import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  parseComposerHashQuery,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("composer prefix routing", () => {
  it("uses ! for skills and leaves $ free for agents", () => {
    expect(detectComposerTrigger("!review", 7)?.kind).toBe("skill");
    expect(detectComposerTrigger("$review", 7)).toBeNull();
  });

  it("keeps the hash namespace while typing and narrows the search", () => {
    expect(detectComposerTrigger("#iss:42", 7)?.query).toBe("iss:42");
    expect(parseComposerHashQuery("iss:42")).toEqual({ kind: "issue", search: "42" });
    expect(parseComposerHashQuery("pr:42")).toEqual({ kind: "pull-request", search: "42" });
    expect(parseComposerHashQuery("42")).toEqual({ kind: "all", search: "42" });
  });

  it("detects a single-colon snippet token and returns its replacement range", () => {
    expect(detectComposerTrigger("Use :fix-bug after this", 12)).toEqual({
      kind: "snippet",
      query: "fix-bug",
      rangeStart: 4,
      rangeEnd: 12,
    });
  });

  it("opens the snippet picker for a single colon but not a double colon", () => {
    expect(detectComposerTrigger(":", 1)).toEqual({
      kind: "snippet",
      query: "",
      rangeStart: 0,
      rangeEnd: 1,
    });
    expect(detectComposerTrigger("::fix-bug", 9)).toBeNull();
    expect(detectComposerTrigger("word:fix-bug", 12)).toBeNull();
  });

  it("keeps existing path, skill, slash, and hash triggers while raw dollar text stays inert", () => {
    expect(detectComposerTrigger("@src/index.ts", 13)?.kind).toBe("path");
    expect(detectComposerTrigger("!review", 7)?.kind).toBe("skill");
    expect(detectComposerTrigger("/fix", 4)?.kind).toBe("slash-command");
    expect(detectComposerTrigger("#pr:42", 6)?.kind).toBe("pull-request");
    expect(detectComposerTrigger("$agent", 6)).toBeNull();
  });
});
