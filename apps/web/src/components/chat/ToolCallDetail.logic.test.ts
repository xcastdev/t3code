import { describe, expect, it } from "vite-plus/test";

import {
  fileChangePatch,
  splitNumberedReadOutput,
  splitPathForDisplay,
  toolArgsFilePath,
} from "./ToolCallDetail.logic";

describe("splitNumberedReadOutput", () => {
  it("moves a read's line numbers out of the code", () => {
    expect(splitNumberedReadOutput("    12→const a = 1;\n    13→\n    14\treturn a;\n")).toEqual({
      code: "const a = 1;\n\nreturn a;",
      firstLine: 12,
    });
  });

  it("leaves text alone unless every line carries the next number", () => {
    const shuffled = "1→a\n3→b";
    expect(splitNumberedReadOutput(shuffled)).toEqual({ code: shuffled, firstLine: null });
    const prose = "1→a\nnot numbered";
    expect(splitNumberedReadOutput(prose)).toEqual({ code: prose, firstLine: null });
  });
});

describe("splitPathForDisplay", () => {
  it("separates the file name from its folder", () => {
    expect(splitPathForDisplay("/repo/src/ws.ts")).toEqual({ folder: "/repo/src/", name: "ws.ts" });
    expect(splitPathForDisplay("README.md")).toEqual({ folder: "", name: "README.md" });
  });
});

describe("toolArgsFilePath", () => {
  it("names the file whose text an edit carries, and nothing for a bare path", () => {
    expect(
      toolArgsFilePath([
        ["file_path", "/repo/a.ts"],
        ["new_string", "x"],
      ]),
    ).toBe("/repo/a.ts");
    expect(toolArgsFilePath([["file_path", "/repo/a.ts"]])).toBeNull();
  });
});

describe("fileChangePatch", () => {
  it("passes a git patch through and gives bare hunks a file header", () => {
    const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b";
    expect(fileChangePatch({ fileName: "x.ts", diffStr: patch })).toBe(patch);
    expect(fileChangePatch({ fileName: "x.ts", diffStr: "@@ -1 +1 @@\n-a\n+b" })).toBe(
      "--- x.ts\n+++ x.ts\n@@ -1 +1 @@\n-a\n+b",
    );
  });

  it("builds hunks from Claude's structured edit result", () => {
    const result = JSON.stringify({
      filePath: "/repo/x.ts",
      structuredPatch: [
        { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-a", "+b"] },
      ],
    });
    expect(fileChangePatch({ fileName: "/repo/x.ts", diffStr: result })).toBe(
      "--- /repo/x.ts\n+++ /repo/x.ts\n@@ -3,1 +3,1 @@\n-a\n+b",
    );
  });

  it("shows a new file as all additions", () => {
    expect(
      fileChangePatch({ fileName: "n.ts", diffStr: "one\ntwo\n", changes: [{ operation: "add" }] }),
    ).toBe("--- /dev/null\n+++ n.ts\n@@ -0,0 +1,2 @@\n+one\n+two");
    expect(
      fileChangePatch({
        fileName: "n.ts",
        diffStr: JSON.stringify({ type: "create", content: "one" }),
      }),
    ).toBe("--- /dev/null\n+++ n.ts\n@@ -0,0 +1,1 @@\n+one");
  });

  it("returns nothing for a message about the change", () => {
    expect(
      fileChangePatch({ fileName: "x.ts", diffStr: "The file x.ts has been updated." }),
    ).toBeNull();
  });
});
