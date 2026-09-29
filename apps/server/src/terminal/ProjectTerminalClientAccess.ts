import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { TerminalToolError, type ProjectTerminalHandle } from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "./Manager.ts";

export type ProjectTerminalClientOperation = "attach" | "list" | "write" | "resize";

const unavailable = (
  operation: ProjectTerminalClientOperation,
  projectId: ProjectTerminalHandle["projectId"],
  terminalId?: ProjectTerminalHandle["terminalId"],
) =>
  new TerminalToolError({
    operation,
    reason: "unavailable",
    projectId,
    ...(terminalId === undefined ? {} : { terminalId }),
  });

export const makeProjectTerminalClientAccess = (
  snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
  terminals: TerminalManager.TerminalManager["Service"],
) => {
  const requireProject = (
    projectId: ProjectTerminalHandle["projectId"],
    operation: ProjectTerminalClientOperation = "list",
  ): Effect.Effect<void, TerminalToolError> =>
    snapshots.getProjectShellById(projectId).pipe(
      Effect.mapError(() => unavailable(operation, projectId)),
      Effect.flatMap((project) =>
        Option.isSome(project) ? Effect.void : Effect.fail(unavailable(operation, projectId)),
      ),
    );

  const requireExisting = (
    handle: ProjectTerminalHandle,
    operation: Exclude<ProjectTerminalClientOperation, "list">,
  ): Effect.Effect<void, TerminalToolError> =>
    requireProject(handle.projectId, operation).pipe(
      Effect.andThen(terminals.getProjectDockSummary(handle)),
      Effect.flatMap((summary) =>
        summary === null
          ? Effect.fail(unavailable(operation, handle.projectId, handle.terminalId))
          : Effect.void,
      ),
    );

  return { requireProject, requireExisting };
};
