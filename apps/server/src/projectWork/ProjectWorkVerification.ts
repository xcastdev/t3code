import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { assertProjectAcceptsMutations } from "../project/ProjectMutationFence.ts";
import { makeProjectWorkVerificationJobs } from "./ProjectWorkVerificationJobs.ts";
import {
  makeProjectWorkVerificationPreparationRoot,
  ProjectWorkVerificationPreparationError,
} from "./ProjectWorkVerificationPreparation.ts";
import { ProjectWorkVerificationRequest } from "./ProjectWorkVerificationRequest.ts";

const make = Effect.gen(function* () {
  const identity = yield* ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const jobs = yield* makeProjectWorkVerificationJobs({ environmentId });
  const preparation = yield* makeProjectWorkVerificationPreparationRoot({
    environmentId,
    maximumEnvironmentModelCalls: 128,
    assertHumanCurrent: (principal, projectId) =>
      Effect.gen(function* () {
        const denied = () =>
          new ProjectWorkVerificationPreparationError({
            reason: "Current human verification permission unavailable",
          });
        const request = yield* Effect.serviceOption(ProjectWorkVerificationRequest);
        if (Option.isNone(request)) return yield* denied();
        yield* request.value
          .assertCurrent(principal, projectId, "write")
          .pipe(Effect.mapError(denied));
        const current = yield* settings.getSettings.pipe(Effect.mapError(denied));
        if (!current.projectWorkEnabled) return yield* denied();
        yield* assertProjectAcceptsMutations(sql, projectId).pipe(Effect.mapError(denied));
      }),
  });
  return { environmentId, prepare: preparation.prepare, readPrepared: jobs.readPrepared };
});

/** Private Root host preparation and committed storage. Public callers supply selections only. */
export class ProjectWorkVerification extends Context.Service<
  ProjectWorkVerification,
  Effect.Success<typeof make>
>()("t3/projectWork/ProjectWorkVerification") {}

export const layer = Layer.effect(ProjectWorkVerification, make);
