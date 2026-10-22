import * as SqlClient from "effect/sql/SqlClient";
import { assertOrdinaryAssistantDestination } from "../assistants/AssistantGuards.ts";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";

export const makeProjectWorkProjectGuard = Effect.gen(function* () {
  const projects = yield* ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  return Effect.fn("ProjectWork.assertProjectActive")(function* (projectId: string) {
    yield* assertOrdinaryAssistantDestination({ projectId: ProjectId.make(projectId) }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({
            operation: "ProjectWork.assertProjectActive",
            detail: "Assistant backing projects cannot enable Project Work.",
            cause,
          }),
      ),
    );
    const project = yield* projects
      .get(ProjectId.make(projectId))
      .pipe(Effect.mapError(toPersistenceSqlError("ProjectWork.assertProjectActive")));
    if (Option.isNone(project))
      return yield* Effect.fail(
        new PersistenceSqlError({
          operation: "ProjectWork.assertProjectActive",
          detail: "Project does not exist or has been deleted",
        }),
      );
  });
});
