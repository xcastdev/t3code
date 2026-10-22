import { makeProjectWorkProjectGuard } from "./ProjectWorkProjectGuard.ts";
import {
  ProjectWorkDelta,
  ProjectWorkStreamInput,
  type ProjectWorkDelta as ProjectWorkDeltaType,
  type ProjectWorkStreamItem,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";
import * as ProjectWorkEventBus from "./ProjectWorkEventBus.ts";

export const PROJECT_WORK_STREAM_DEFAULT_LIMIT = 128;
export const PROJECT_WORK_STREAM_MAX_LIMIT = 256;
export const PROJECT_WORK_STREAM_MAX_REPLAY_BYTES = 2 * 1024 * 1024;

export class ProjectWorkStreamError extends Schema.TaggedError<ProjectWorkStreamError>()(
  "ProjectWorkStreamError",
  {
    reason: Schema.Literals(["read-failed", "decode-failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Project-work stream ${this.reason}: ${this.detail}`;
  }
}

export interface ProjectWorkReplayResult {
  readonly cursor: number;
  readonly deltas: ReadonlyArray<ProjectWorkDeltaType>;
  readonly resync: "cursor-ahead" | "replay-too-large" | null;
}

const boundedLimit = (limit: number | undefined): number =>
  Math.min(
    PROJECT_WORK_STREAM_MAX_LIMIT,
    Math.max(
      1,
      Number.isFinite(limit) ? Math.floor(limit as number) : PROJECT_WORK_STREAM_DEFAULT_LIMIT,
    ),
  );

const decodeDelta = Schema.decodeSync(ProjectWorkDelta);
const isStreamError = Schema.is(ProjectWorkStreamError);

const eventRecordId = (event: ProjectWorkEvent): string => {
  const value = event as unknown as Record<string, unknown>;
  const direct = [
    "taskId",
    "attemptId",
    "criterionId",
    "evidenceId",
    "relationshipId",
    "blockerId",
    "knowledgeId",
    "decisionId",
    "commentId",
    "activityId",
  ].find((key) => typeof value[key] === "string");
  if (direct !== undefined) return String(value[direct]);
  const task = value.task;
  if (
    task !== null &&
    typeof task === "object" &&
    typeof (task as Record<string, unknown>).taskId === "string"
  ) {
    return String((task as Record<string, unknown>).taskId);
  }
  const attempt = value.attempt;
  if (
    attempt !== null &&
    typeof attempt === "object" &&
    typeof (attempt as Record<string, unknown>).attemptId === "string"
  ) {
    return String((attempt as Record<string, unknown>).attemptId);
  }
  const relationship = value.relationship;
  if (
    relationship !== null &&
    typeof relationship === "object" &&
    typeof (relationship as Record<string, unknown>).relationshipId === "string"
  ) {
    return String((relationship as Record<string, unknown>).relationshipId);
  }
  return String(event.eventId);
};

const deltaKind = (type: ProjectWorkEvent["type"]): ProjectWorkDeltaType["kind"] => {
  if (type.includes("attempt")) return "attempt";
  if (type.includes("criterion")) return "criterion";
  if (type.includes("evidence")) return "evidence";
  if (type.includes("relationship")) return "relationship";
  if (type.includes("blocker")) return "blocker";
  if (type.includes("knowledge")) return "knowledge";
  if (type.includes("decision")) return "decision";
  if (type.includes("comment")) return "comment";
  if (type.includes("attention")) return "attention";
  return "task";
};

/** Convert an authoritative event to a bounded, non-authoritative delta. */
export const projectWorkDeltaForEvent = (
  event: ProjectWorkEvent,
  cursor: number,
): ProjectWorkDeltaType =>
  decodeDelta({
    projectId: event.projectId,
    cursor,
    eventId: event.eventId,
    kind:
      event.type === "project-work.foundation.recorded" && event.record.kind === "memory-revision"
        ? "memory"
        : deltaKind(event.type),
    recordId:
      event.type === "project-work.foundation.recorded" && event.record.kind === "memory-revision"
        ? event.record.recordId
        : eventRecordId(event),
    revision: event.revision,
    deleted: event.type === "project-work.relationship.unlinked",
  });

export const boundProjectWorkReplay = (input: {
  readonly afterCursor: number;
  readonly headCursor: number;
  readonly rows: ReadonlyArray<{ readonly cursor: number; readonly delta: ProjectWorkDeltaType }>;
  readonly limit?: number;
  readonly maxBytes?: number;
}): ProjectWorkReplayResult => {
  const limit = boundedLimit(input.limit);
  if (input.afterCursor > input.headCursor) {
    return {
      cursor: input.headCursor,
      deltas: [],
      resync: "cursor-ahead" as const,
    };
  }
  const deltas: ProjectWorkDeltaType[] = [];
  let bytes = 0;
  for (const row of input.rows) {
    const nextBytes = Buffer.byteLength(JSON.stringify(row.delta));
    if (
      deltas.length >= limit ||
      bytes + nextBytes > (input.maxBytes ?? PROJECT_WORK_STREAM_MAX_REPLAY_BYTES)
    ) {
      return {
        cursor: input.headCursor,
        deltas: [],
        resync: "replay-too-large" as const,
      };
    }
    deltas.push(row.delta);
    bytes += nextBytes;
  }
  return {
    cursor: input.rows.at(-1)?.cursor ?? input.afterCursor,
    deltas,
    resync: null,
  };
};

const decodeEvent = (value: unknown): ProjectWorkEvent => {
  if (value === null || typeof value !== "object") throw new Error("event is not an object");
  const event = value as Record<string, unknown>;
  if (
    typeof event.eventId !== "string" ||
    typeof event.projectId !== "string" ||
    typeof event.type !== "string"
  ) {
    throw new Error("event metadata is missing");
  }
  return event as unknown as ProjectWorkEvent;
};

const makeProjectWorkStream = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const assertProject = yield* makeProjectWorkProjectGuard;
  const bus = yield* Effect.serviceOption(ProjectWorkEventBus.ProjectWorkEventBus);

  const readReplay = Effect.fn("ProjectWorkStream.readReplay")(
    function* (input: ProjectWorkStreamInput) {
      yield* assertProject(String(input.projectId));
      const afterCursor = input.afterCursor ?? 0;
      const headRows = yield* sql<Record<string, unknown>>`
        SELECT COALESCE(MAX(sequence), 0) AS cursor FROM t3_workflow_v2_work_events WHERE project_id = ${String(input.projectId)}
      `;
      const headCursor = Number(headRows[0]?.cursor ?? 0);
      if (afterCursor > headCursor) {
        return {
          cursor: headCursor,
          deltas: [],
          resync: "cursor-ahead" as const,
        };
      }
      const rows = yield* sql<Record<string, unknown>>`
        SELECT sequence AS cursor, payload_json AS payloadJson
        FROM t3_workflow_v2_work_events
        WHERE project_id = ${String(input.projectId)} AND sequence > ${afterCursor} AND sequence <= ${headCursor}
        ORDER BY sequence ASC
        LIMIT ${boundedLimit(input.limit) + 1}
      `;
      const decoded = rows.map((row) => {
        const event = decodeEvent(JSON.parse(String(row.payloadJson)));
        return {
          cursor: Number(row.cursor),
          delta: projectWorkDeltaForEvent(event, Number(row.cursor)),
        };
      });
      return boundProjectWorkReplay({
        afterCursor,
        headCursor,
        rows: decoded,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    },
    Effect.mapError((cause) =>
      isStreamError(cause)
        ? cause
        : new ProjectWorkStreamError({
            reason: "read-failed",
            detail: "failed to read work events",
            cause,
          }),
    ),
  );

  const streamRaw = Effect.fn("ProjectWorkStream.streamRaw")(function* (
    input: ProjectWorkStreamInput,
  ) {
    // Subscribe before reading history so a commit racing the captured head
    // leaves a wake hint. Hints can coalesce; only durable replay delivers deltas.
    let live: Stream.Stream<ProjectWorkWorkBusItem>;
    if (Option.isSome(bus)) {
      live = yield* bus.value.subscribe;
    } else {
      live = Stream.empty;
    }
    const replay = yield* readReplay(input);
    const initial: ProjectWorkStreamItem[] = replay.resync
      ? [
          {
            kind: "resync-required",
            projectId: input.projectId,
            cursor: replay.cursor,
            reason: replay.resync,
          },
        ]
      : [
          ...replay.deltas.map((delta) => ({ kind: "delta" as const, delta })),
          ...(input.requestCompletionMarker === true
            ? [
                {
                  kind: "synchronized" as const,
                  projectId: input.projectId,
                  cursor: replay.cursor,
                },
              ]
            : []),
        ];
    let cursor = replay.cursor;
    const liveItems = live.pipe(
      // A foreign-project hint may have overwritten this project's hint.
      // Every wake must reread this project's indexed durable tail.
      Stream.mapEffect(() =>
        readReplay({ ...input, afterCursor: cursor }).pipe(
          Effect.map((next): ReadonlyArray<ProjectWorkStreamItem> => {
            cursor = next.cursor;
            return next.resync
              ? [
                  {
                    kind: "resync-required",
                    projectId: input.projectId,
                    cursor,
                    reason: next.resync,
                  },
                ]
              : next.deltas.map((delta) => ({ kind: "delta" as const, delta }));
          }),
        ),
      ),
      Stream.flatMap(Stream.fromIterable),
    );
    return Stream.concat(Stream.fromIterable(initial), liveItems);
  });

  const stream = streamRaw;
  return { readReplay, stream };
});

type ProjectWorkWorkBusItem = ProjectWorkEventBus.ProjectWorkCommittedEvent;

export interface ProjectWorkStreamShape {
  readonly readReplay: (
    input: ProjectWorkStreamInput,
  ) => Effect.Effect<ProjectWorkReplayResult, ProjectWorkStreamError | ProjectionRepositoryError>;
  readonly stream: (
    input: ProjectWorkStreamInput,
  ) => Effect.Effect<
    Stream.Stream<ProjectWorkStreamItem, ProjectWorkStreamError>,
    ProjectWorkStreamError,
    Scope.Scope
  >;
}

export class ProjectWorkStream extends Context.Service<ProjectWorkStream, ProjectWorkStreamShape>()(
  "t3/projectWork/ProjectWorkStream",
) {}

export const ProjectWorkStreamLive = Layer.effect(ProjectWorkStream, makeProjectWorkStream);
