import {
  ManagedTextResourceId,
  ManagedTextResourceKey,
  ManagedTextResourceRevision,
  type ManagedTextResourceSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  expandManagedCommandTemplate,
  resolveManagedCommandSource,
  insertManagedCommand,
  insertManagedSnippet,
  managedTextResourceMenuItemId,
  parseManagedCommandInvocation,
} from "./managedTextResources.ts";

describe("expandManagedCommandTemplate", () => {
  it("replaces every arguments placeholder with the one trailing argument", () => {
    expect(
      expandManagedCommandTemplate(
        "Review $ARGUMENTS and compare the result with $ARGUMENTS.",
        "src/a.ts",
      ),
    ).toBe("Review src/a.ts and compare the result with src/a.ts.");
  });

  it("inserts dollar replacement tokens as literal argument text", () => {
    expect(expandManagedCommandTemplate("Review $ARGUMENTS", "$& $$ $` $'")).toBe(
      "Review $& $$ $` $'",
    );
  });

  it("appends a nonempty argument on a new line when the template has no placeholder", () => {
    expect(expandManagedCommandTemplate("Review the change.", "include edge cases")).toBe(
      "Review the change.\ninclude edge cases",
    );
  });

  it("does not add an extra separator when the template already ends with a newline", () => {
    expect(expandManagedCommandTemplate("Review the change.\n", "include edge cases")).toBe(
      "Review the change.\ninclude edge cases",
    );
  });

  it("leaves a template unchanged when there is no argument", () => {
    expect(expandManagedCommandTemplate("Review the change.", "")).toBe("Review the change.");
  });

  it("replaces placeholders with empty text when the argument is empty", () => {
    expect(expandManagedCommandTemplate("Review $ARGUMENTS now.", "")).toBe("Review  now.");
  });
});

describe("parseManagedCommandInvocation", () => {
  it("keeps the trailing text as one editable argument", () => {
    expect(parseManagedCommandInvocation("/review source file.ts and tests")).toEqual({
      key: "review",
      argument: "source file.ts and tests",
    });
    expect(parseManagedCommandInvocation("/review")).toEqual({ key: "review", argument: "" });
  });

  it("ignores prose and malformed command names", () => {
    expect(parseManagedCommandInvocation("Please /review this")).toBeNull();
    expect(parseManagedCommandInvocation("/review_this")).toBeNull();
  });
});

describe("insertManagedSnippet", () => {
  it("replaces the active trigger range and returns the cursor after inserted text", () => {
    expect(insertManagedSnippet("left :fix right", 5, 9, "resolved")).toEqual({
      text: "left resolved right",
      cursor: 13,
    });
  });
});

describe("insertManagedCommand", () => {
  it("inserts expanded text without changing surrounding draft content", () => {
    expect(
      insertManagedCommand(
        "/review file.ts\nKeep this note",
        0,
        15,
        "Review $ARGUMENTS",
        "file.ts",
      ),
    ).toEqual({
      text: "Review file.ts\nKeep this note",
      cursor: 14,
    });
  });
});

describe("managedTextResourceMenuItemId", () => {
  it("keeps a native command distinct from a managed command with the same key", () => {
    expect(managedTextResourceMenuItemId("managed", "review")).toBe("managed:review");
    expect(managedTextResourceMenuItemId("native", "review")).toBe("native:review");
  });
});

it("requires an explicit managed/native choice and rechecks availability", () => {
  const command: ManagedTextResourceSummary = {
    kind: "command",
    id: ManagedTextResourceId.make("review"),
    key: ManagedTextResourceKey.make("review"),
    scope: "environment",
    scopeId: "local",
    projectState: "inherit",
    effective: true,
    revision: ManagedTextResourceRevision.make("hash"),
  };
  const input = { key: "review", managed: [command], nativeKeys: ["review"] };
  expect(resolveManagedCommandSource(input)).toBe("choose-source");
  expect(resolveManagedCommandSource({ ...input, choice: "managed" })).toBe("managed");
  expect(resolveManagedCommandSource({ ...input, choice: "native" })).toBe("native");
  expect(
    resolveManagedCommandSource({
      ...input,
      managed: [{ ...command, effective: false }],
      choice: "managed",
    }),
  ).toBe("missing");
});
