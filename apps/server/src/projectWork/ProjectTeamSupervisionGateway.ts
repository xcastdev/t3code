import {
  ProjectId,
  ProjectTeamSupervisionSummary,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

const decodeSummary = Schema.decodeUnknownSync(ProjectTeamSupervisionSummary);

/** Projection metadata only. Reading attention never acknowledges it or resolves a question. */
export const projectTeamSupervisionSummary = (
  state: ProjectWorkReducerState,
): ProjectTeamSupervisionSummary => {
  const records = state.foundationRecords ?? [];
  const taskCounts = {
    draft: 0,
    specified: 0,
    ready: 0,
    "in-progress": 0,
    blocked: 0,
    "in-review": 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    unknown: 0,
    total: state.tasks.length,
  };
  for (const task of state.tasks) {
    if (task.state in taskCounts) taskCounts[task.state]++;
    else taskCounts.unknown++;
  }
  const latest = <T extends { readonly updatedAt: string; readonly recordId: string }>(
    items: ReadonlyArray<T>,
  ) =>
    items.toSorted(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.recordId.localeCompare(b.recordId),
    );
  const metadata = (r: ProjectTeamRecord) => ({
    recordId: r.recordId,
    revision: r.revision,
    generation: r.generation,
    status: r.status,
    supported: true,
  });
  const missions = latest(
    records.filter(
      (r): r is Extract<ProjectTeamRecord, { kind: "mission" }> =>
        r.kind === "mission" && r.status !== "canceled",
    ),
  );
  const bindings = latest(records.filter((r) => r.kind === "run-binding"));
  const questions = latest(
    records.filter(
      (r): r is Extract<ProjectTeamRecord, { kind: "question" }> =>
        r.kind === "question" && r.status === "pending",
    ),
  );
  const blockers = state.blockers
    .filter((r) => r.resolvedAt === undefined)
    .toSorted((a, b) => b.revision - a.revision || a.blockerId.localeCompare(b.blockerId));
  return {
    projectId: ProjectId.make(state.projectId),
    availability: "available",
    revision: state.revision,
    taskCounts,
    missions: {
      items: missions.slice(0, 5).map((r) => ({ ...metadata(r), title: r.title.slice(0, 240) })),
      hasMore: missions.length > 5,
    },
    bindings: {
      items: bindings.slice(0, 8).map((r) => ({
        ...metadata(r),
        taskId: r.taskId,
        attemptId: r.attemptId,
        memberId: r.memberId,
        roleRevisionId: r.roleRevisionId,
        providerInstanceId: r.providerInstanceId,
        model: r.model,
        workerThreadId: r.threadId,
        ...(r.runId === undefined ? {} : { runId: r.runId }),
        ...(r.runAttemptId === undefined ? {} : { runAttemptId: r.runAttemptId }),
        ...(r.nodeId === undefined ? {} : { nodeId: r.nodeId }),
      })),
      hasMore: bindings.length > 8,
    },
    questions: {
      items: questions.slice(0, 5).map((r) => ({
        ...metadata(r),
        taskId: r.taskId,
        senderId: r.senderId,
        targetGateId: r.targetGateId,
        targetRevision: r.targetRevision,
      })),
      hasMore: questions.length > 5,
    },
    blockers: {
      items: blockers.slice(0, 5).map((r) => ({
        recordId: r.blockerId,
        taskId: r.taskId,
        revision: r.revision,
        reason: r.reason.slice(0, 240),
        resolver: r.resolver,
      })),
      hasMore: blockers.length > 5,
    },
  };
};

export class ProjectTeamSupervisionGateway extends Context.Service<
  ProjectTeamSupervisionGateway,
  {
    readonly read: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectTeamSupervisionSummary, ProjectionRepositoryError>;
  }
>()("t3/projectWork/ProjectTeamSupervisionGateway") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = Effect.fn("ProjectTeamSupervisionGateway.read")(function* (projectId: ProjectId) {
    const state = yield* readCurrentState(sql, projectId).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectTeamSupervisionGateway.read")),
    );
    // Decode the bounded public view so future record changes cannot leak bodies through this boundary.
    return yield* Effect.sync(() => decodeSummary(projectTeamSupervisionSummary(state)));
  });
  return ProjectTeamSupervisionGateway.of({ read });
});
export const layer = Layer.effect(ProjectTeamSupervisionGateway, make);
