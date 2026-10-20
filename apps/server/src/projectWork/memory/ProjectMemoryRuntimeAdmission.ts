import * as Effect from "effect/Effect";
import { ProjectMemoryServiceError } from "./ProjectMemoryService.ts";

export const makeProjectMemoryRuntimeAdmission = (options: {
  platform: NodeJS.Platform;
  userId: number | undefined;
  readSettings: Effect.Effect<
    { projectWorkEnabled: boolean; projectTeamExecutionEnabled: boolean },
    ProjectMemoryServiceError
  >;
}) => ({
  // Readiness only; runtime and resource owners enforce concrete execution requirements.
  assertAdmission: Effect.gen(function* () {
    if (options.platform !== "linux") {
      return yield* new ProjectMemoryServiceError({
        reason: "Memory processing requires Linux",
      });
    }
    if (options.userId === undefined || !Number.isInteger(options.userId) || options.userId < 0) {
      return yield* new ProjectMemoryServiceError({
        reason: "Memory processing requires a valid host user id",
      });
    }
    const settings = yield* options.readSettings;
    if (!settings.projectWorkEnabled || !settings.projectTeamExecutionEnabled) {
      return yield* new ProjectMemoryServiceError({
        reason: "Memory processing requires project work and project team execution to be enabled",
      });
    }
  }),
});
