import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTerminalCompletionWakeStatus = Schema.Literals([
  "pending",
  "claimed",
  "delivered",
  "canceled",
  "unknown",
]);
export type ProjectionTerminalCompletionWakeStatus =
  typeof ProjectionTerminalCompletionWakeStatus.Type;

export const ProjectionTerminalCompletionWake = Schema.Struct({
  dedupeKey: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: ProjectId,
  terminalId: TrimmedNonEmptyString,
  generation: TrimmedNonEmptyString,
  serverRunId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  status: Schema.Literals(["exited", "killed"]),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  deliveryStatus: ProjectionTerminalCompletionWakeStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionTerminalCompletionWake = typeof ProjectionTerminalCompletionWake.Type;

export interface ProjectionTerminalCompletionWakeRepositoryShape {
  readonly recordRequest: (
    wake: Omit<ProjectionTerminalCompletionWake, "deliveryStatus" | "updatedAt">,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listPendingByThread: (input: {
    readonly threadId: ThreadId;
    readonly serverRunId: string;
  }) => Effect.Effect<ReadonlyArray<ProjectionTerminalCompletionWake>, ProjectionRepositoryError>;
  readonly listPendingByServerRun: (input: {
    readonly serverRunId: string;
  }) => Effect.Effect<ReadonlyArray<ProjectionTerminalCompletionWake>, ProjectionRepositoryError>;
  readonly listUnknown: (input: {
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ProjectionTerminalCompletionWake>, ProjectionRepositoryError>;
  readonly claim: (input: {
    readonly dedupeKey: string;
    readonly serverRunId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<ProjectionTerminalCompletionWake | null, ProjectionRepositoryError>;
  readonly setStatus: (input: {
    readonly dedupeKey: string;
    readonly status: ProjectionTerminalCompletionWakeStatus;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly cancelOtherServerRuns: (input: {
    readonly serverRunId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly cancelThread: (input: {
    readonly threadId: ThreadId;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionTerminalCompletionWakeRepository extends Context.Service<
  ProjectionTerminalCompletionWakeRepository,
  ProjectionTerminalCompletionWakeRepositoryShape
>()(
  "t3/persistence/Services/ProjectionTerminalCompletionWakes/ProjectionTerminalCompletionWakeRepository",
) {}
