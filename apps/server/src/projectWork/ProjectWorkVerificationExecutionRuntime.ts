import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import {
  makeProjectTeamExecutionReactor,
  type ProjectTeamExecutionOwner,
} from "./ProjectTeamExecutionReactor.ts";
import type { ProjectWorkVerificationExecutionError } from "./ProjectWorkVerificationExecutionJournal.ts";
import type * as Scope from "effect/Scope";

/** Reuses committed work/settings wakes. The owner reconciles before discovery;
 * provider publication is a disposable availability hint, never job authority.
 */
export const makeProjectWorkVerificationExecutionWorker = Effect.fn(
  "VerificationExecutionRuntime.make",
)(function* <R>(
  start: Effect.Effect<
    ProjectTeamExecutionOwner<ProjectWorkVerificationExecutionError, R>,
    ProjectWorkVerificationExecutionError,
    R | Scope.Scope
  >,
  activation: Effect.Effect<void> = Effect.void,
) {
  const pi = yield* ProjectTeamPiRuntime;
  const changes = yield* pi.subscribeChanges;
  const reactor = yield* makeProjectTeamExecutionReactor({
    start: activation.pipe(Effect.andThen(start)),
  });
  yield* changes.pipe(
    Stream.runForEach(() =>
      reactor.drain().pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Verification availability wake failed", cause),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  return reactor;
});
