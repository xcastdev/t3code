import { EventId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boundProjectWorkReplay, projectWorkDeltaForEvent } from "./ProjectWorkStream.ts";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";

const projectId = ProjectId.make("stream-project");
const event = {
  eventId: EventId.make("work-event-1"),
  projectId,
  revision: 4,
  occurredAt: "2026-01-01T00:00:00.000Z",
  type: "project-work.task.created" as const,
  task: {
    taskId: ProjectWorkTaskId.make("task-1"),
  },
} as unknown as ProjectWorkEvent;

describe("ProjectWorkStream", () => {
  it("maps work events to bounded deltas without entering legacy event unions", () => {
    expect(projectWorkDeltaForEvent(event, 19)).toEqual({
      projectId,
      cursor: 19,
      eventId: event.eventId,
      kind: "task",
      recordId: "task-1",
      revision: 4,
      deleted: false,
    });
  });

  it("resumes after unrelated global-log rows without renumbering the cursor", () => {
    const first = projectWorkDeltaForEvent(event, 19);
    const second = projectWorkDeltaForEvent(
      { ...event, eventId: EventId.make("work-event-2"), revision: 5 },
      27,
    );
    const replay = boundProjectWorkReplay({
      afterCursor: 18,
      headCursor: 27,
      rows: [
        { cursor: 19, delta: first },
        { cursor: 27, delta: second },
      ],
      limit: 2,
    });
    expect(replay.resync).toBeNull();
    expect(replay.cursor).toBe(27);
    expect(replay.deltas.map((delta) => delta.cursor)).toEqual([19, 27]);
  });

  it("forces a resync for an impossible or oversized cursor range", () => {
    const delta = projectWorkDeltaForEvent(event, 4);
    expect(boundProjectWorkReplay({ afterCursor: 8, headCursor: 4, rows: [] }).resync).toBe(
      "cursor-ahead",
    );
    expect(
      boundProjectWorkReplay({
        afterCursor: 0,
        headCursor: 4,
        rows: [
          { cursor: 4, delta },
          { cursor: 5, delta: { ...delta, cursor: 5 } },
        ],
        limit: 1,
      }).resync,
    ).toBe("replay-too-large");
  });
});
