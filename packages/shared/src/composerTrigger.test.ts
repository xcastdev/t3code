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
});
