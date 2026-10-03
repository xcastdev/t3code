import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { decodeWorkRoute } from "./workNavigation";
import { mobileFoundationProgress, mobileFoundationView, mobileTaskPage } from "./workData";

const projectId = ProjectId.make("project-a");
const environmentId = EnvironmentId.make("environment-a");
const task = {
  projectId,
  taskId: "task-a",
  title: "Inspect",
  state: "draft",
  watchers: [],
  revision: 1,
  specRevision: 0,
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:00:00.000Z",
};

describe("mobile work reads and navigation", () => {
  it("keeps bounded task pagination and validates owning project", () => {
    const items = Array.from({ length: 51 }, (_, index) => ({ ...task, taskId: `task-${index}` }));
    expect(
      mobileTaskPage(
        { projectId, revision: 10, offset: 50, limit: 51, hasMore: true, items },
        projectId,
        50,
      ),
    ).toMatchObject({ revision: 10, nextOffset: 100, records: items.slice(0, 50) });
    expect(
      mobileTaskPage({ projectId: "other", revision: 10, offset: 50, items }, projectId, 50),
    ).toBeNull();
    expect(mobileTaskPage({ projectId, revision: 10, offset: 0, items }, projectId, 50)).toBeNull();
    expect(
      mobileTaskPage({ projectId, revision: -1, offset: 50, items }, projectId, 50),
    ).toBeNull();
    expect(mobileTaskPage([{ ...task, projectId: "other" }], projectId, 0)).toBeNull();
    expect(
      mobileTaskPage(
        Array.from({ length: 52 }, () => task),
        projectId,
        0,
      ),
    ).toBeNull();
    expect(mobileTaskPage([task], projectId, 0)).toMatchObject({
      revision: null,
      nextOffset: null,
    });
  });
  it("keeps opaque cursor pages scoped and disables freshness while refreshing", () => {
    const first = AsyncResult.success({
      projectId,
      revision: 10,
      items: [],
      nextCursor: " opaque ",
    });
    const last = AsyncResult.success({ projectId, revision: 10, items: [] });
    expect(mobileFoundationView(projectId, [undefined, " opaque "], [first, last])).toMatchObject({
      current: true,
      snapshot: { complete: true, revision: 10 },
    });
    expect(mobileFoundationView(projectId, [undefined], [first]).current).toBe(false);
    expect(mobileFoundationView(projectId, [undefined, "opaque"], [first, last]).current).toBe(
      false,
    );
    expect(mobileFoundationView(projectId, [undefined], [AsyncResult.initial(true)]).current).toBe(
      false,
    );
    expect(mobileFoundationView(projectId, [undefined], [AsyncResult.initial(true)]).loading).toBe(
      true,
    );
    expect(mobileFoundationView(projectId, [undefined], [last]).loading).toBe(false);
    expect(
      mobileFoundationView(
        projectId,
        [undefined],
        [AsyncResult.success({ projectId: "other", revision: 10, items: [] })],
      ).current,
    ).toBe(false);
  });
  it("rejects missing route identities and preserves the explicit environment and project", () => {
    expect(decodeWorkRoute({ environmentId: "", projectId: "project-a" })).toBeNull();
    expect(decodeWorkRoute({ projectId: "project-a" })).toBeNull();
    const target = decodeWorkRoute({ environmentId, projectId });
    expect(target).toEqual({ environmentId, projectId });
    expect(decodeWorkRoute({ environmentId: "environment-b", projectId })).toEqual({
      environmentId: "environment-b",
      projectId,
    });
  });
  it("advances opaque cursors, restarts changed revisions once and stays within the read bound", () => {
    const first = AsyncResult.success({
      projectId,
      revision: 10,
      items: [],
      nextCursor: " opaque ",
    });
    const next = mobileFoundationProgress(projectId, [undefined], [first], null);
    expect(next.cursors).toEqual([undefined, " opaque "]);
    const changed = AsyncResult.success({ projectId, revision: 11, items: [] });
    const restarted = mobileFoundationProgress(projectId, next.cursors, [first, changed], null);
    expect(restarted.restart).toBe(true);
    expect(restarted.cursors).toEqual([undefined]);
    expect(
      mobileFoundationProgress(projectId, next.cursors, [first, changed], restarted.resetKey)
        .restart,
    ).toBe(false);
    const pages = Array.from({ length: 16 }, (_, index) =>
      AsyncResult.success({
        projectId,
        revision: 10,
        items: [],
        nextCursor: `cursor-${index + 1}`,
      }),
    );
    const cursors = Array.from({ length: 16 }, (_, index) =>
      index === 0 ? undefined : `cursor-${index}`,
    );
    expect(mobileFoundationProgress(projectId, cursors, pages, null).cursors).toBe(cursors);
    expect(mobileFoundationView(projectId, cursors, pages).current).toBe(false);
  });
});
