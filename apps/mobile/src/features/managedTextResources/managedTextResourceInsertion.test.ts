import type {
  ManagedTextResourceContentGetResult,
  ManagedTextResourceSummary,
} from "@t3tools/contracts";
import {
  ManagedTextResourceId,
  ManagedTextResourceKey,
  ManagedTextResourceRevision,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveManagedTextResourceInsertion } from "./managedTextResourceInsertion";

const command: ManagedTextResourceSummary = {
  kind: "command",
  id: ManagedTextResourceId.make("review-command"),
  key: ManagedTextResourceKey.make("review"),
  scope: "environment",
  scopeId: "environment-1",
  projectState: "inherit",
  revision: ManagedTextResourceRevision.make("revision-1"),
  effective: true,
};

function content(
  overrides: Partial<ManagedTextResourceContentGetResult> = {},
): ManagedTextResourceContentGetResult {
  return {
    kind: "command",
    id: ManagedTextResourceId.make("review-command"),
    key: ManagedTextResourceKey.make("review"),
    revision: ManagedTextResourceRevision.make("revision-1"),
    body: "Review $ARGUMENTS and report risks.",
    ...overrides,
  };
}

describe("resolveManagedTextResourceInsertion", () => {
  it("expands a selected command into ordinary editable draft text", () => {
    expect(
      resolveManagedTextResourceInsertion({
        selected: command,
        content: content(),
        currentEntries: [command],
        draft: "Please /rev",
        expectedDraft: "Please /rev",
        rangeStart: 7,
        rangeEnd: 11,
        argument: "src/a.ts",
      }),
    ).toEqual({
      status: "inserted",
      text: "Please Review src/a.ts and report risks.",
      cursor: 40,
    });
  });

  it("inserts only the selected snippet range and keeps the surrounding draft", () => {
    const snippet: ManagedTextResourceSummary = {
      ...command,
      kind: "snippet",
      id: ManagedTextResourceId.make("fix-snippet"),
      key: ManagedTextResourceKey.make("fix"),
    };
    expect(
      resolveManagedTextResourceInsertion({
        selected: snippet,
        content: content({
          kind: "snippet",
          id: ManagedTextResourceId.make("fix-snippet"),
          key: ManagedTextResourceKey.make("fix"),
          body: "Please fix this.",
        }),
        currentEntries: [snippet],
        draft: "left :fi right",
        expectedDraft: "left :fi right",
        rangeStart: 5,
        rangeEnd: 8,
      }),
    ).toEqual({ status: "inserted", text: "left Please fix this. right", cursor: 21 });
  });

  it("rejects content that does not match the selected revision", () => {
    expect(
      resolveManagedTextResourceInsertion({
        selected: command,
        content: content({
          revision: ManagedTextResourceRevision.make("revision-2"),
          body: "New body",
        }),
        currentEntries: [command],
        draft: "/review",
        expectedDraft: "/review",
        rangeStart: 0,
        rangeEnd: 7,
      }),
    ).toEqual({ status: "stale-resource" });
  });

  it("requires reselection if the catalog changed while content was loading", () => {
    const newer = { ...command, revision: ManagedTextResourceRevision.make("revision-2") };
    expect(
      resolveManagedTextResourceInsertion({
        selected: command,
        content: content(),
        currentEntries: [newer],
        draft: "/review",
        expectedDraft: "/review",
        rangeStart: 0,
        rangeEnd: 7,
      }),
    ).toEqual({ status: "stale-resource" });
  });

  it("does not insert a project entry reported as invalid or orphaned", () => {
    expect(
      resolveManagedTextResourceInsertion({
        selected: command,
        content: content(),
        currentEntries: [{ ...command, projectState: "orphan", effective: true }],
        draft: "/review",
        expectedDraft: "/review",
        rangeStart: 0,
        rangeEnd: 7,
      }),
    ).toEqual({ status: "stale-resource" });
  });

  it("does not overwrite draft edits made while content was loading", () => {
    expect(
      resolveManagedTextResourceInsertion({
        selected: command,
        content: content(),
        currentEntries: [command],
        draft: "/review plus user edits",
        expectedDraft: "/review",
        rangeStart: 0,
        rangeEnd: 7,
      }),
    ).toEqual({ status: "draft-changed" });
  });
});
