import { encodeCompletionAuthority, projectTerminalOwnerMatches } from "./ProjectTerminalStore.ts";
import {
  cancelTerminalCompletion,
  deliverProjectTerminalCompletion,
} from "./ProjectTerminalCompletion.ts";
import {
  captureTerminalAuthority,
  sameTerminalAuthority,
  type CapturedTerminalAuthority,
} from "./ProjectTerminalAuthority.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Stable completion receipt IDs must survive process restarts.
import * as NodeCrypto from "node:crypto";
import {
  OrchestratorMcpFailure,
  TerminalToolError,
  type ProjectId,
  type ProjectTerminalSummary,
  type ProjectTerminalWriteInput,
  type ProjectTerminalResizeInput,
  type ProjectTerminalKillInput,
  type ProjectTerminalSubscribeCompletionInput,
  type ProjectTerminalUnsubscribeCompletionInput,
  type TerminalReadInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { RunAdmission } from "../orchestration-v2/RunAdmission.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { loadCaller, assertFullAccess, assertLiveCaller } from "../mcp/threadAccess.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { TerminalManager } from "./Manager.ts";

export interface ProjectTerminalSpawnInput {
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly title?: string;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}
export interface ProjectTerminalListInput {
  readonly after?: string;
  readonly limit?: number;
}
export type ProjectTerminalHandleInput = {
  readonly terminalId: string;
  readonly projectId?: ProjectId;
};
const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "thread_not_found",
    message: "The calling thread's project is unavailable.",
  });

export const make = Effect.fn("ProjectTerminalService.make")(function* () {
  const manager = yield* TerminalManager;
  const projects = yield* ProjectStoreV2;
  const threads = yield* ThreadManagementService;
  const admission = yield* RunAdmission;
  const orchestrator = yield* OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
  // Capture service dependencies; invocation credentials remain request-local.
  const callerDependencies = yield* Effect.context<ThreadManagementService>();
  const caller = Effect.fn("ProjectTerminalService.caller")(function* (
    operation: string,
    mutate = false,
    suppliedProject?: ProjectId,
  ) {
    yield* Effect.annotateCurrentSpan({ operation });
    const invocation = yield* McpInvocationContext.requireMcpCapability("terminal");
    if (!invocation.thread) return yield* unavailable();
    const access = yield* loadCaller().pipe(Effect.provide(callerDependencies));
    yield* assertLiveCaller(access);
    if (mutate && access.caller?.latestRunStopRequested) return yield* unavailable();
    if (mutate)
      yield* assertFullAccess(
        access,
        "Project terminals require a full-access thread in default interaction mode.",
      );
    if (
      !access.caller ||
      (suppliedProject !== undefined && suppliedProject !== access.caller.projectId)
    )
      return yield* unavailable();
    const project = yield* projects.get(access.caller.projectId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(project)) return yield* unavailable();
    return {
      invocation: { ...invocation, thread: invocation.thread },
      project: project.value,
      thread: access.caller,
    };
  });
  const mutationGuard = Effect.fn("ProjectTerminalService.mutationGuard")(
    function* (
      access: Effect.Success<ReturnType<typeof caller>>,
      operation: TerminalToolError["operation"],
      terminalId: string,
      captured: CapturedTerminalAuthority,
    ) {
      const current = yield* caller(operation, true, access.project.projectId);
      if (current.thread.activeRunId !== access.thread.activeRunId) return yield* unavailable();
      const next = yield* captureTerminalAuthority({
        threadId: current.thread.id,
        runId: current.thread.activeRunId,
        caller: access.invocation.thread,
        threads,
        admission,
      });
      if (!sameTerminalAuthority(captured, next)) return yield* unavailable();
    },
    (effect, access, operation, terminalId, _captured) =>
      effect.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, access.invocation),
        Effect.mapError(
          () =>
            new TerminalToolError({
              operation,
              reason: "unavailable",
              projectId: access.project.projectId,
              terminalId,
            }),
        ),
      ),
  );
  const sqlError = (
    operation: TerminalToolError["operation"],
    projectId: ProjectId,
    terminalId: string,
  ) => new TerminalToolError({ operation, reason: "cleanup-failed", projectId, terminalId });
  const deliver = (terminal: ProjectTerminalSummary) =>
    deliverProjectTerminalCompletion(terminal, { sql, threads, orchestrator, admission });
  const scope = yield* Scope.Scope;
  const stop = yield* manager.subscribeProjectEvents((event) =>
    deliver(event.terminal).pipe(
      Effect.catchCause(Effect.logError),
      Effect.forkIn(scope),
      Effect.asVoid,
    ),
  );
  yield* Effect.addFinalizer(() => Effect.sync(stop));
  const pending = yield* sql<{
    project_id: string;
  }>`SELECT DISTINCT project_id FROM t3_workflow_v2_terminal_completions WHERE phase IN ('subscribed','pending')`.pipe(
    Effect.orDie,
  );
  for (const row of pending) {
    const terminals = yield* manager.listProjectCompletionSnapshots(row.project_id as ProjectId);
    yield* Effect.forEach(
      terminals,
      (terminal) =>
        deliverProjectTerminalCompletion(terminal, {
          sql,
          threads,
          orchestrator,
          admission,
          recoverPending: true,
        }),
      { discard: true },
    ).pipe(Effect.orDie);
  }
  const spawn = Effect.fn("ProjectTerminalService.spawn")(function* (
    input: ProjectTerminalSpawnInput,
  ) {
    const access = yield* caller("spawn", true);
    const captured = yield* captureTerminalAuthority({
      threadId: access.thread.id,
      runId: access.thread.activeRunId,
      caller: access.invocation.thread,
      threads,
      admission,
    });
    return yield* manager.createProject(
      {
        projectId: access.project.projectId,
        terminalId: NodeCrypto.randomUUID(),
        creatingThreadId: access.thread.id,
        cwd: input.cwd ?? access.project.workspaceRoot,
        providerInstanceId: access.invocation.thread.providerInstanceId,
        ...input,
      },
      mutationGuard(access, "spawn", "new", captured),
      captured.owner,
    );
  });
  const list = Effect.fn("ProjectTerminalService.list")(function* (
    input: ProjectTerminalListInput = {},
  ) {
    const access = yield* caller("list");
    const all = yield* manager.listProject(access.project.projectId);
    const remaining = all.filter(
      (terminal) => input.after === undefined || terminal.terminalId > input.after,
    );
    const terminals = remaining.slice(0, input.limit ?? 50);
    return {
      terminals,
      nextCursor: remaining.length > terminals.length ? terminals.at(-1)!.terminalId : null,
    };
  });
  const read = Effect.fn("ProjectTerminalService.read")(function* (input: TerminalReadInput) {
    const access = yield* caller("read", false, input.projectId);
    return yield* manager.readProject({
      ...input,
      projectId: access.project.projectId,
      readerId: NodeCrypto.createHash("sha256")
        .update(
          `${access.thread.id.length}:${access.thread.id}${access.invocation.thread.providerInstanceId.length}:${access.invocation.thread.providerInstanceId}${access.invocation.thread.providerSessionId}:${access.thread.activeRunId ?? ""}`,
        )
        .digest("hex"),
    });
  });
  const write = Effect.fn("ProjectTerminalService.write")(function* (
    input: ProjectTerminalHandleInput &
      Pick<ProjectTerminalWriteInput, "data" | "expectedGeneration">,
  ) {
    const access = yield* caller("write", true, input.projectId);
    const captured = yield* captureTerminalAuthority({
      threadId: access.thread.id,
      runId: access.thread.activeRunId,
      caller: access.invocation.thread,
      threads,
      admission,
    });
    yield* manager.writeProject(
      { ...input, projectId: access.project.projectId },
      mutationGuard(access, "write", input.terminalId, captured),
      captured.owner,
    );
  });
  const resize = Effect.fn("ProjectTerminalService.resize")(function* (
    input: ProjectTerminalHandleInput &
      Pick<ProjectTerminalResizeInput, "cols" | "rows" | "expectedGeneration">,
  ) {
    const access = yield* caller("resize", true, input.projectId);
    const captured = yield* captureTerminalAuthority({
      threadId: access.thread.id,
      runId: access.thread.activeRunId,
      caller: access.invocation.thread,
      threads,
      admission,
    });
    yield* manager.resizeProject(
      { ...input, projectId: access.project.projectId },
      mutationGuard(access, "resize", input.terminalId, captured),
      captured.owner,
    );
  });
  const kill = Effect.fn("ProjectTerminalService.kill")(function* (
    input: ProjectTerminalHandleInput &
      Pick<ProjectTerminalKillInput, "cleanup" | "expectedGeneration">,
  ) {
    const access = yield* caller("kill", true, input.projectId);
    const captured = yield* captureTerminalAuthority({
      threadId: access.thread.id,
      runId: access.thread.activeRunId,
      caller: access.invocation.thread,
      threads,
      admission,
    });
    return yield* manager.killProjectTerminal(
      { ...input, projectId: access.project.projectId },
      mutationGuard(access, "kill", input.terminalId, captured),
      captured.owner,
    );
  });
  const subscribeCompletion = Effect.fn("ProjectTerminalService.subscribeCompletion")(function* (
    input: ProjectTerminalSubscribeCompletionInput,
  ) {
    const access = yield* caller("subscribeCompletion", true, input.projectId);
    const captured = yield* captureTerminalAuthority({
      threadId: access.thread.id,
      runId: access.thread.activeRunId,
      caller: access.invocation.thread,
      threads,
      admission,
    });
    if (
      captured.owner &&
      !projectTerminalOwnerMatches(yield* manager.getProjectOwnership(input), captured.owner)
    )
      return yield* new TerminalToolError({
        operation: "subscribeCompletion",
        reason: "unavailable",
        ...input,
      });
    const authorityJson = yield* encodeCompletionAuthority(captured).pipe(
      Effect.mapError(() => sqlError("subscribeCompletion", input.projectId, input.terminalId)),
    );
    const terminal = (yield* manager.listProject(access.project.projectId)).find(
      (terminal) => terminal.terminalId === input.terminalId,
    );
    if (!terminal)
      return yield* new TerminalToolError({
        operation: "subscribeCompletion",
        reason: "unavailable",
        ...input,
      });
    const registered =
      yield* sql`INSERT INTO t3_workflow_v2_terminal_completions(project_id,terminal_id,generation,recipient_thread_id,mode,authority_json,phase) VALUES(${input.projectId},${input.terminalId},${terminal.generation},${access.thread.id},${input.mode},${authorityJson},'subscribed') ON CONFLICT(project_id,terminal_id,generation,recipient_thread_id) DO UPDATE SET mode=excluded.mode,phase=CASE WHEN phase='cancelled' THEN 'subscribed' ELSE phase END WHERE phase IN ('subscribed','cancelled') RETURNING phase`.pipe(
        Effect.mapError(() => sqlError("subscribeCompletion", input.projectId, input.terminalId)),
      );
    if (registered.length === 0)
      return yield* new TerminalToolError({
        operation: "subscribeCompletion",
        reason: "completion-in-flight",
        ...input,
      });
    yield* deliver(terminal);
  });
  const unsubscribeCompletion = Effect.fn("ProjectTerminalService.unsubscribeCompletion")(
    function* (input: ProjectTerminalUnsubscribeCompletionInput) {
      const access = yield* caller("unsubscribeCompletion", false, input.projectId);
      yield* cancelTerminalCompletion({
        sql,
        projectId: input.projectId,
        terminalId: input.terminalId,
        recipientThreadId: access.thread.id,
      });
    },
  );
  return {
    spawn,
    list,
    read,
    write,
    resize,
    kill,
    subscribeCompletion,
    unsubscribeCompletion,
    closeProject: manager.closeProject,
  };
});
export class ProjectTerminalService extends Context.Service<
  ProjectTerminalService,
  Effect.Success<ReturnType<typeof make>>
>()("t3/terminal/ProjectTerminalService") {}
export const ProjectTerminalServiceLive = Layer.effect(ProjectTerminalService, make());
