import { canonicalProjectWorkPayload, ProviderDriverKind } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { ProviderValidationError } from "../provider/Errors.ts";
import {
  sendManagedProviderAssignment,
  startManagedProviderSession,
} from "../provider/ProviderManagedSessions.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  inspectProjectTeamSessionAuthority,
  ProjectTeamAuthorization,
} from "./ProjectTeamAuthorization.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import type { PiManagedRuntimeError } from "../provider/pi/PiManagedRuntime.ts";

const denied = (issue: string, cause?: unknown) =>
  new ProviderValidationError({
    operation: "ProjectTeamProviderSessions",
    issue,
    ...(cause === undefined ? {} : { cause }),
  });
const authorityError = (cause: unknown) =>
  denied("Original managed dispatch authority is unavailable", cause);

/** Only the retained dispatch supplies session inputs; this bridge records no completion. */
export const makeProjectTeamProviderSessions = Effect.fn("makeProjectTeamProviderSessions")(
  function* (options: {
    readonly environmentId: string;
    readonly maximumEnvironmentModelCalls: number;
  }) {
    const provider = yield* ProviderService;
    const settings = yield* ServerSettingsService;
    const authorization = yield* ProjectTeamAuthorization;
    const pi = yield* ProjectTeamPiRuntime;
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: options.environmentId,
      maximumEnvironmentModelCalls: options.maximumEnvironmentModelCalls,
    });
    let active = true;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        active = false;
      }),
    );

    const retained = Effect.fn("ProjectTeamProviderSessions.retained")(function* (
      dispatchId: string,
      operation: "initialize" | "assignment",
    ) {
      const original = yield* journal
        .inspect(dispatchId, { requireClaim: true })
        .pipe(Effect.mapError(authorityError));
      const transition = original.intent.compiledClaim.transition;
      if (transition?.kind !== "claim" || original.fence.claimGeneration <= 0)
        return yield* denied("Managed session requires its original committed claim");
      const allowed =
        operation === "initialize"
          ? original.fence.stage === "setup-complete" || original.fence.stage === "session-bound"
          : original.fence.stage === "assignment-intent";
      if (!allowed) return yield* denied("Managed session is not at its original operation stage");
      return { original, binding: transition.binding };
    });

    const assertSnapshot = Effect.fn("ProjectTeamProviderSessions.assertSnapshot")(function* (
      original: ProjectTeamDispatchSnapshot,
      assertInstance: Effect.Effect<void, PiManagedRuntimeError>,
    ) {
      if (!active) return yield* denied("Managed session producer has closed");
      const transition = original.intent.compiledClaim.transition;
      if (transition?.kind !== "claim") return yield* denied("Original binding is unavailable");
      const binding = transition.binding;
      yield* assertInstance.pipe(Effect.mapError(authorityError));
      const credential = yield* authorization
        .discover({
          providerInstanceId: binding.providerInstanceId,
          threadId: binding.threadId,
        })
        .pipe(Effect.mapError(authorityError));
      if (
        credential === undefined ||
        credential.projectId !== binding.projectId ||
        credential.bindingId !== binding.recordId ||
        credential.generation !== binding.generation
      )
        return yield* denied("Original managed credential changed");
      const authority = yield* inspectProjectTeamSessionAuthority(authorization, {
        providerInstanceId: binding.providerInstanceId,
        threadId: binding.threadId,
      }).pipe(Effect.mapError(authorityError));
      if (authority === undefined)
        return yield* denied("Original managed authority is unavailable");
      const enabled = yield* settings.getSettings.pipe(Effect.mapError(authorityError));
      const fresh = yield* journal
        .inspect(original.fence.dispatchId, { requireClaim: true })
        .pipe(Effect.mapError(authorityError));
      yield* assertInstance.pipe(Effect.mapError(authorityError));
      const now = yield* Clock.currentTimeMillis;
      if (
        !active ||
        !enabled.projectWorkEnabled ||
        !enabled.projectTeamExecutionEnabled ||
        fresh.fence.revision !== original.fence.revision ||
        fresh.fence.claimGeneration !== original.fence.claimGeneration ||
        fresh.fence.stage !== original.fence.stage ||
        canonicalProjectWorkPayload(fresh.intent) !==
          canonicalProjectWorkPayload(original.intent) ||
        now >=
          Math.min(original.intent.limits.deadlineAtMs, original.intent.limits.rootDeadlineAtMs)
      )
        return yield* denied("Original managed dispatch changed or expired");
    });

    const initialize = Effect.fn("ProjectTeamProviderSessions.initialize")(function* (
      dispatchId: string,
    ) {
      const { original, binding } = yield* retained(dispatchId, "initialize");
      return yield* pi.withInstance(binding.providerInstanceId, ({ assertCurrent }) =>
        startManagedProviderSession(provider, {
          input: {
            threadId: binding.threadId,
            providerInstanceId: binding.providerInstanceId,
            provider: ProviderDriverKind.make("piAgent"),
            modelSelection: { instanceId: binding.providerInstanceId, model: binding.model },
            cwd: original.intent.request.git.worktreePath,
            runtimeMode: "approval-required",
          },
          primaryProjectRoot: original.intent.request.git.primaryRoot,
          assertCurrent: assertSnapshot(original, assertCurrent),
        }),
      );
    });

    const assign = Effect.fn("ProjectTeamProviderSessions.assign")(function* (dispatchId: string) {
      const { original, binding } = yield* retained(dispatchId, "assignment");
      return yield* pi.withInstance(binding.providerInstanceId, ({ assertCurrent }) =>
        sendManagedProviderAssignment(provider, {
          instanceId: binding.providerInstanceId,
          input: {
            threadId: binding.threadId,
            input: original.intent.request.assignment,
            modelSelection: { instanceId: binding.providerInstanceId, model: binding.model },
          },
          assertCurrent: assertSnapshot(original, assertCurrent),
        }),
      );
    });
    return { initialize, assign };
  },
);
