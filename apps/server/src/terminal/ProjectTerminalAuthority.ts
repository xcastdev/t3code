import {
  OrchestratorMcpFailure,
  type RunId,
  type ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { NativeTarget, RunAdmission } from "../orchestration-v2/RunAdmission.ts";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { McpThreadCaller } from "../mcp/McpInvocationContext.ts";
import type { ProjectTerminalOwnership } from "./ProjectTerminalStore.ts";
const denied = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "The captured provider run no longer has terminal authority.",
  });

type AuthorityProjection = {
  readonly runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      "id" | "activeAttemptId" | "providerThreadId" | "providerInstanceId" | "status"
    >
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "providerSessionId">
  >;
  readonly turnItems: ReadonlyArray<Pick<OrchestrationV2TurnItem, "runId" | "type">>;
};
export const evaluateTerminalAuthority = Effect.fn("ProjectTerminalAuthority.evaluate")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId | null;
    readonly caller: McpThreadCaller;
    readonly projection: AuthorityProjection;
    readonly admission: Pick<RunAdmission["Service"], "check">;
  }) {
    const projection = input.projection;
    const run = projection.runs.find((run) => run.id === input.runId);
    const providerThread = projection.providerThreads.find(
      (thread) => thread.id === run?.providerThreadId,
    );
    if (
      !run ||
      !run.activeAttemptId ||
      !providerThread?.providerSessionId ||
      providerThread.providerSessionId !== input.caller.providerSessionId ||
      run.providerInstanceId !== input.caller.providerInstanceId ||
      !["preparing", "starting", "running", "waiting"].includes(run.status) ||
      projection.turnItems.some(
        (item) => item.runId === run.id && item.type === "run_interrupt_request",
      )
    )
      return yield* denied();
    const nativeTarget: NativeTarget = {
      runAttemptId: run.activeAttemptId,
      providerThreadId: providerThread.id,
      providerSessionId: providerThread.providerSessionId,
    };
    const result = yield* input.admission
      .check({
        threadId: input.threadId,
        runId: run.id,
        nativeTarget,
        originSessionId: input.caller.providerSessionId,
        operation: "continue",
        now: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(Effect.mapError(denied));
    if (result._tag !== "ordinary" && result._tag !== "admitted") return yield* denied();
    const owner: ProjectTerminalOwnership | undefined =
      result._tag === "admitted"
        ? {
            projectId: result.owner.projectId,
            rootId: result.owner.rootId,
            bindingId: result.owner.bindingId,
            generation: result.owner.generation,
            fence: result.owner.fence,
            expiresAt: result.owner.expiresAt,
            threadId: input.threadId,
            runId: run.id,
            runAttemptId: run.activeAttemptId,
            providerThreadId: providerThread.id,
            providerSessionId: providerThread.providerSessionId,
          }
        : undefined;
    return { runId: run.id, nativeTarget, owner };
  },
);
export const captureTerminalAuthority = Effect.fn("ProjectTerminalAuthority.capture")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId | null;
    readonly caller: McpThreadCaller;
    readonly threads: Pick<ThreadManagementService["Service"], "getThreadProjection">;
    readonly admission: Pick<RunAdmission["Service"], "check">;
  }) {
    const projection = yield* input.threads
      .getThreadProjection(input.threadId)
      .pipe(Effect.mapError(denied));
    return yield* evaluateTerminalAuthority({ ...input, projection });
  },
);
export type CapturedTerminalAuthority = Effect.Success<ReturnType<typeof captureTerminalAuthority>>;
export const sameTerminalAuthority = (
  before: CapturedTerminalAuthority,
  after: CapturedTerminalAuthority,
) =>
  before.runId === after.runId &&
  before.nativeTarget.runAttemptId === after.nativeTarget.runAttemptId &&
  before.nativeTarget.providerThreadId === after.nativeTarget.providerThreadId &&
  before.nativeTarget.providerSessionId === after.nativeTarget.providerSessionId &&
  before.owner?.rootId === after.owner?.rootId &&
  before.owner?.bindingId === after.owner?.bindingId &&
  before.owner?.generation === after.owner?.generation &&
  before.owner?.fence === after.owner?.fence;
