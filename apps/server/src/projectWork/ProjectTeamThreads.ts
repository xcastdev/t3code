import {
  canonicalProjectWorkPayload,
  CommandId,
  type ModelSelection,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import type { ProjectTeamDispatchSnapshot } from "./ProjectTeamDispatch.ts";
import { projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";

export class ProjectTeamThreadsDenied extends Schema.TaggedError<ProjectTeamThreadsDenied>()(
  "ProjectTeamThreadsDenied",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

const deny = (reason: string) => new ProjectTeamThreadsDenied({ reason });

/** Root retains current admission and managed execution authority; this only prepares metadata. */
export const makeProjectTeamThreads = <RootError, RootServices>(ports: {
  readonly assertCurrent: (
    snapshot: ProjectTeamDispatchSnapshot,
    modelSelection: ModelSelection,
  ) => Effect.Effect<void, RootError, RootServices>;
}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    const eventStore = yield* OrchestrationEventStore;
    const ensure = Effect.fn("ProjectTeamThreads.ensure")(function* (
      snapshot: ProjectTeamDispatchSnapshot,
      modelSelection: ModelSelection,
    ) {
      const { intent, fence } = snapshot;
      const transition = intent.compiledClaim.transition;
      if (transition?.kind !== "claim") return yield* deny("Immutable compiled claim is missing");
      const binding = transition.binding;
      if (
        fence.dispatchId !== intent.request.dispatchId ||
        intent.compiledClaim.projectId !== binding.projectId ||
        intent.request.claim.projectId !== binding.projectId ||
        intent.request.git.runId !== binding.recordId ||
        intent.request.git.generation !== binding.generation ||
        intent.request.git.worktreePath !== binding.worktree ||
        intent.request.git.branchRef !== binding.branch ||
        modelSelection.instanceId !== binding.providerInstanceId ||
        modelSelection.model !== binding.model
      )
        return yield* deny("Thread preparation does not match the immutable assignment");

      const command = {
        type: "thread.create",
        commandId: CommandId.make(projectTeamDerivedRecordId(fence.dispatchId, "thread.create")),
        threadId: binding.threadId,
        projectId: binding.projectId,
        title: "Project team assignment",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: binding.branch,
        worktreePath: binding.worktree,
        createdAt: intent.request.claim.committedAt,
      } as const;
      const matches = (thread: OrchestrationThreadShell) =>
        thread.id === command.threadId &&
        thread.projectId === command.projectId &&
        thread.title === command.title &&
        canonicalProjectWorkPayload(thread.modelSelection) ===
          canonicalProjectWorkPayload(command.modelSelection) &&
        thread.runtimeMode === command.runtimeMode &&
        thread.interactionMode === command.interactionMode &&
        thread.branch === command.branch &&
        thread.worktreePath === command.worktreePath &&
        thread.createdAt === command.createdAt &&
        thread.archivedAt === null;

      // Only the first event is read, through a captured head. Command receipts alone
      // do not compare retry content within the same aggregate.
      const readOriginal = Effect.fn("ProjectTeamThreads.readOriginal")(function* () {
        const head = yield* engine.latestSequence;
        const events = yield* Stream.runCollect(
          engine.readThreadEvents({
            threadId: command.threadId,
            fromSequenceExclusive: 0,
            toSequenceInclusive: head,
            limit: 1,
          }),
        );
        const event = events[0];
        if (!event) return Option.none<number>();
        if (
          event.type !== "thread.created" ||
          event.commandId !== command.commandId ||
          event.aggregateId !== command.threadId ||
          canonicalProjectWorkPayload(event.payload) !==
            canonicalProjectWorkPayload({
              threadId: command.threadId,
              projectId: command.projectId,
              title: command.title,
              modelSelection: command.modelSelection,
              runtimeMode: command.runtimeMode,
              interactionMode: command.interactionMode,
              branch: command.branch,
              worktreePath: command.worktreePath,
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
            })
        )
          return yield* deny("Existing thread lacks the original assignment creation event");
        return Option.some(event.sequence);
      });
      const verify = Effect.fn("ProjectTeamThreads.verify")(function* () {
        const original = yield* readOriginal();
        if (
          Option.isSome(original) &&
          (yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            sequenceExclusive: original.value,
            type: "thread.created",
          }))
        )
          return yield* deny("Original assignment thread was recreated");
        const thread = yield* query.getThreadShellById(command.threadId);
        if (Option.isNone(original) || Option.isNone(thread) || !matches(thread.value))
          return yield* deny("Original assignment thread is missing, inactive, or changed");
        yield* ports.assertCurrent(snapshot, modelSelection);
        return {
          threadId: command.threadId,
          projectId: command.projectId,
          commandId: command.commandId,
          sequence: original.value,
        };
      });

      yield* ports.assertCurrent(snapshot, modelSelection);
      const original = yield* readOriginal();
      if (Option.isSome(original)) return yield* verify();
      if (Option.isSome(yield* query.getThreadShellById(command.threadId)))
        return yield* deny("Existing thread has no original assignment creation event");

      yield* ports.assertCurrent(snapshot, modelSelection);
      const dispatched = yield* Effect.exit(engine.dispatch(command));
      if (Exit.isFailure(dispatched) && Cause.hasInterrupts(dispatched.cause))
        return yield* Effect.failCause(dispatched.cause);
      const verified = yield* Effect.exit(verify());
      if (Exit.isSuccess(verified)) return verified.value;
      return yield* Effect.failCause(
        Exit.isFailure(dispatched)
          ? Cause.combine(dispatched.cause, verified.cause)
          : verified.cause,
      );
    });
    return { ensure };
  });
