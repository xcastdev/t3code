import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  PiManagedRuntimeError,
  type PiManagedOperationRequest,
} from "../provider/pi/PiManagedRuntime.ts";
import { ProjectTeamAuthorization } from "./ProjectTeamAuthorization.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";

const isManagedRuntimeError = Schema.is(PiManagedRuntimeError);
const denied = (detail: string) => new PiManagedRuntimeError({ code: "denied", detail });
const DispatchIds = Schema.Array(
  Schema.Struct({
    dispatch_id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  }),
).check(Schema.isMaxLength(1));
const decodeDispatchIds = Schema.decodeUnknownEffect(DispatchIds);

/** The adapter asks this private producer for the original durable operation ID.
 * Runtime preparation still performs its own current authority and resource checks. */
export const makeProjectTeamRuntime = Effect.fn("makeProjectTeamRuntime")(function* (options: {
  readonly environmentId: string;
  readonly maximumEnvironmentModelCalls: number;
}) {
  const environmentId = options.environmentId;
  const maximumEnvironmentModelCalls = options.maximumEnvironmentModelCalls;
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const authorization = yield* ProjectTeamAuthorization;
  const pi = yield* ProjectTeamPiRuntime;
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId,
    maximumEnvironmentModelCalls,
  });
  let stopped = false;
  const resolveOperationId = Effect.fn("ProjectTeamRuntime.resolveOperationId")(function* (
    providerInstanceId: ProviderInstanceId,
    request: PiManagedOperationRequest,
  ) {
    const credential = yield* authorization.discover({
      providerInstanceId,
      threadId: request.threadId,
    });
    if (credential === undefined) return undefined;
    const enabled = yield* settings.getSettings;
    if (stopped || !enabled.projectWorkEnabled || !enabled.projectTeamExecutionEnabled)
      return yield* denied("Project team execution is disabled");
    const rows = yield* decodeDispatchIds(
      yield* sql`SELECT dispatch_id FROM project_team_dispatch
        WHERE environment_id=${environmentId} AND binding_id=${credential.bindingId}
        AND generation=${credential.generation} LIMIT 2`,
    );
    if (rows.length !== 1)
      return yield* denied("Managed assignment has no unique original dispatch");
    const original = yield* journal.inspect(rows[0]!.dispatch_id, { requireClaim: true });
    const transition = original.intent.compiledClaim.transition;
    if (
      transition?.kind !== "claim" ||
      transition.binding.recordId !== credential.bindingId ||
      transition.binding.generation !== credential.generation ||
      transition.binding.providerInstanceId !== providerInstanceId ||
      transition.binding.threadId !== request.threadId ||
      original.fence.claimGeneration <= 0 ||
      (request.modelSelection !== undefined &&
        (request.modelSelection.instanceId !== providerInstanceId ||
          request.modelSelection.model !== transition.binding.model)) ||
      (request.cwd !== undefined && request.cwd !== transition.binding.worktree) ||
      (request.runtimeMode !== undefined && request.runtimeMode !== "approval-required")
    )
      return yield* denied("Provider request differs from the original assignment");
    let operationId: string;
    if (request.kind === "initialize") {
      if (original.fence.stage !== "setup-complete" && original.fence.stage !== "session-bound")
        return yield* denied("Initialization requires its original completed setup");
      operationId = original.intent.request.initializeOperationId;
    } else if (request.kind === "prompt") {
      if (
        (original.fence.stage !== "assignment-intent" &&
          original.fence.stage !== "assignment-observed") ||
        request.prompt !== original.intent.request.assignment
      )
        return yield* denied("Prompt differs from its original durable assignment intent");
      operationId = original.intent.request.assignmentOperationId;
    } else {
      return yield* denied("Managed compaction requires a separately retained context operation");
    }
    const currentSettings = yield* settings.getSettings;
    const fresh = yield* journal.inspect(original.fence.dispatchId, { requireClaim: true });
    const now = yield* Clock.currentTimeMillis;
    if (
      stopped ||
      !currentSettings.projectWorkEnabled ||
      !currentSettings.projectTeamExecutionEnabled ||
      now >=
        Math.min(original.intent.limits.deadlineAtMs, original.intent.limits.rootDeadlineAtMs) ||
      fresh.fence.revision !== original.fence.revision ||
      fresh.fence.claimGeneration !== original.fence.claimGeneration ||
      fresh.fence.stage !== original.fence.stage
    )
      return yield* denied("Original dispatch changed during provider identity lookup");
    return operationId;
  });
  yield* pi.installOperationResolver((instanceId, request) =>
    resolveOperationId(instanceId, request).pipe(
      Effect.mapError((error) =>
        isManagedRuntimeError(error)
          ? error
          : denied("Original durable dispatch identity is unavailable"),
      ),
    ),
  );
  const stop = Effect.sync(() => {
    stopped = true;
  });
  yield* Effect.addFinalizer(() => stop);
  return { stop };
});
