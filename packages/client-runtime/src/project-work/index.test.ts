import { describe, expect, it } from "@effect/vitest";

import {
  PROJECT_WORK_PAGE_REQUEST_SIZE,
  PROJECT_WORK_PAGE_SIZE,
  asProjectWorkArray,
  asProjectWorkBriefing,
  asProjectWorkPage,
  projectWorkPageInput,
  projectWorkPageTargetKey,
  projectWorkStreamAvailable,
  initialProjectWorkStreamState,
  reduceProjectWorkStreamItem,
  reduceProjectWorkStreamBatch,
  projectWorkWritesAvailable,
} from "./index.ts";

describe("project-work client bounds", () => {
  it("keeps read collections bounded when the server response is malformed", () => {
    expect(asProjectWorkArray({ records: Array.from({ length: 500 }, () => ({})) })).toEqual([]);
    expect(asProjectWorkArray(["first", "second"])).toHaveLength(2);
    expect(PROJECT_WORK_PAGE_SIZE).toBe(50);
    expect(PROJECT_WORK_PAGE_REQUEST_SIZE).toBe(51);
  });

  it("keys each page by environment, project, collection, and offset", () => {
    const target = {
      environmentId: "environment-a" as never,
      projectId: "project-a" as never,
      collection: "tasks" as const,
      offset: 50,
    };
    expect(projectWorkPageTargetKey(target)).toBe(
      JSON.stringify(["environment-a", "project-a", "tasks", 50]),
    );
    expect(projectWorkPageTargetKey({ ...target, poll: false })).toBe(
      projectWorkPageTargetKey(target),
    );
    expect(projectWorkPageInput(target)).toEqual({
      projectId: "project-a",
      operation: "tasks",
      limit: 51,
      offset: 50,
      envelope: true,
    });
    expect(projectWorkPageInput({ ...target, offset: Number.NaN })).toMatchObject({
      offset: 0,
      limit: 51,
    });
  });

  it("advances durable cursors and requires a new snapshot after resync", () => {
    const initial = initialProjectWorkStreamState(3);
    const changed = reduceProjectWorkStreamItem(initial, {
      kind: "delta",
      delta: {
        projectId: "project-a" as never,
        cursor: 5,
        eventId: "event-1" as never,
        kind: "task",
        recordId: "task-1",
        revision: 2,
        deleted: false,
      },
    });
    expect(changed).toMatchObject({ cursor: 5, healthy: false, changedKinds: ["task"] });
    expect(
      reduceProjectWorkStreamItem(changed, {
        kind: "synchronized",
        projectId: "project-a" as never,
        cursor: 7,
      }),
    ).toMatchObject({ cursor: 7, healthy: true, resyncRequired: false });
    expect(
      reduceProjectWorkStreamItem(changed, {
        kind: "resync-required",
        projectId: "project-a" as never,
        cursor: 9,
        reason: "replay-too-large",
      }),
    ).toEqual({ cursor: 9, healthy: false, resyncRequired: true, changedKinds: [] });
  });

  it("accepts revision-bearing bounded envelopes", () => {
    expect(
      asProjectWorkPage({
        projectId: "project-a",
        revision: 11,
        offset: 0,
        limit: 50,
        hasMore: true,
        items: [{ id: 1 }],
      }),
    ).toEqual({ records: [{ id: 1 }], offset: 0, hasNext: true, nextOffset: 50, revision: 11 });
  });

  it("uses the extra row as a sentinel without rendering it", () => {
    const records = Array.from({ length: 51 }, (_, index) => ({ id: index }));
    expect(asProjectWorkPage(records, 50)).toEqual({
      records: records.slice(0, 50),
      offset: 50,
      hasNext: true,
      nextOffset: 100,
      revision: null,
    });
    expect(asProjectWorkPage(records.slice(0, 50), 50)).toEqual({
      records: records.slice(0, 50),
      offset: 50,
      hasNext: false,
      nextOffset: null,
      revision: null,
    });
    expect(asProjectWorkPage({ records }, 50)).toEqual({
      records: [],
      offset: 50,
      hasNext: false,
      nextOffset: null,
      revision: null,
    });
  });

  it("keeps a 51st envelope item as the next-page sentinel even when hasMore is false", () => {
    const records = Array.from({ length: 51 }, (_, id) => ({ id }));
    expect(asProjectWorkPage({ revision: 9, hasMore: false, items: records }, 0)).toEqual({
      records: records.slice(0, 50),
      offset: 0,
      hasNext: true,
      nextOffset: 50,
      revision: 9,
    });
  });

  it("folds every marker in a coalesced stream batch", () => {
    const state = reduceProjectWorkStreamBatch(initialProjectWorkStreamState(2), [
      {
        kind: "delta",
        delta: {
          projectId: "project-a" as never,
          cursor: 3,
          eventId: "event-1" as never,
          kind: "task",
          recordId: "task-1",
          revision: 1,
          deleted: false,
        },
      },
      { kind: "synchronized", projectId: "project-a" as never, cursor: 4 },
    ]);
    expect(state).toMatchObject({ cursor: 4, healthy: true, changedKinds: ["task"] });
  });

  it("only permits authoritative writes while enabled and connected", () => {
    expect(projectWorkWritesAvailable({ enabled: false, connectionPhase: "connected" })).toBe(
      false,
    );
    expect(projectWorkWritesAvailable({ enabled: true, connectionPhase: "reconnecting" })).toBe(
      false,
    );
    expect(projectWorkWritesAvailable({ enabled: true, connectionPhase: "connected" })).toBe(true);
  });

  it("requires the advertised stream capability before opening a work stream", () => {
    expect(
      projectWorkStreamAvailable({ capability: undefined, connectionPhase: "connected" }),
    ).toBe(false);
    expect(projectWorkStreamAvailable({ capability: false, connectionPhase: "connected" })).toBe(
      false,
    );
    expect(projectWorkStreamAvailable({ capability: true, connectionPhase: "reconnecting" })).toBe(
      false,
    );
    expect(projectWorkStreamAvailable({ capability: true, connectionPhase: "connected" })).toBe(
      true,
    );
  });

  it("ignores an incompatible overview envelope", () => {
    expect(asProjectWorkBriefing({ text: "missing revision" })).toBeNull();
    expect(
      asProjectWorkBriefing({
        text: "A bounded brief",
        sourceRevision: 3,
        includedTaskIds: [],
        includedKnowledgeIds: [],
        omittedReasons: [],
      }),
    ).not.toBeNull();
  });
});
