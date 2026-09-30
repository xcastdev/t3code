import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";

export const decodeProjectWorkEvent = (value: unknown): ProjectWorkEvent => {
  if (value === null || typeof value !== "object")
    throw new Error("project-work event is not an object");
  const event = value as Record<string, unknown>;
  if (
    typeof event.eventId !== "string" ||
    typeof event.projectId !== "string" ||
    typeof event.type !== "string"
  )
    throw new Error("project-work event is missing metadata");
  return event as unknown as ProjectWorkEvent;
};

export const readProjectWorkEvents = (
  sql: SqlClient.SqlClient,
  projectId?: string,
  afterSequence = 0,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<Record<string, unknown>>`
    SELECT payload_json AS payloadJson
    FROM project_work_events
    ${
      projectId === undefined
        ? afterSequence === 0
          ? sql``
          : sql`WHERE sequence > ${afterSequence}`
        : sql`WHERE project_id = ${projectId} AND sequence > ${afterSequence}`
    }
    ORDER BY sequence ASC
  `;
    return rows.map((row) => decodeProjectWorkEvent(JSON.parse(String(row.payloadJson))));
  });
