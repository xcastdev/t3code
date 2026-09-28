import {
  ProjectId,
  TerminalToolError,
  type ProjectTerminalCreateInput,
  type ProjectTerminalKillInput,
  type ProjectTerminalListResult,
  type ProjectTerminalResizeInput,
  type ProjectTerminalSummary,
  type ProjectTerminalWriteInput,
  type TerminalReadInput,
  type TerminalReadResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "./Manager.ts";

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
  /** Included by handle-shaped schemas; authorization always comes from the invocation. */
  readonly projectId?: ProjectId;
};

export interface ProjectTerminalServiceShape {
  readonly spawn: (
    input: ProjectTerminalSpawnInput,
  ) => Effect.Effect<
    ProjectTerminalSummary,
    | McpInvocationContext.McpCapabilityError<"terminal">
    | ProjectTerminalAccessUnavailableError
    | TerminalToolError,
    McpInvocationContext.McpInvocationContext
  >;
  readonly list: (
    input?: ProjectTerminalListInput,
  ) => Effect.Effect<
    ProjectTerminalListResult,
    | McpInvocationContext.McpCapabilityError<"terminal">
    | ProjectTerminalAccessUnavailableError
    | TerminalToolError,
    McpInvocationContext.McpInvocationContext
  >;
  readonly read: (
    input: TerminalReadInput,
  ) => Effect.Effect<
    TerminalReadResult,
    | McpInvocationContext.McpCapabilityError<"terminal">
    | ProjectTerminalAccessUnavailableError
    | TerminalToolError,
    McpInvocationContext.McpInvocationContext
  >;
  readonly write: (
    input: ProjectTerminalHandleInput & Pick<ProjectTerminalWriteInput, "data">,
  ) => Effect.Effect<
    void,
    | McpInvocationContext.McpCapabilityError<"terminal">
    | ProjectTerminalAccessUnavailableError
    | TerminalToolError,
    McpInvocationContext.McpInvocationContext
  >;
  readonly resize: (
    input: ProjectTerminalHandleInput & Pick<ProjectTerminalResizeInput, "cols" | "rows">,
  ) => Effect.Effect<
    void,
    | McpInvocationContext.McpCapabilityError<"terminal">
    | ProjectTerminalAccessUnavailableError
    | TerminalToolError,
    McpInvocationContext.McpInvocationContext
  >;
  readonly kill: (
    input: ProjectTerminalHandleInput & Pick<ProjectTerminalKillInput, "cleanup">,
  ) => Effect.Effect<
    void,
    | McpInvocationContext.McpCapabilityError<"terminal">
    | ProjectTerminalAccessUnavailableError
    | TerminalToolError,
    McpInvocationContext.McpInvocationContext
  >;
  /** Internal lifecycle hook. It deliberately does not require MCP invocation context. */
  readonly closeProject: (projectId: ProjectId) => Effect.Effect<void, TerminalToolError>;
}

/** A stale or deleted caller has no project identity to put in TerminalToolError. */
export class ProjectTerminalAccessUnavailableError extends Schema.TaggedError<ProjectTerminalAccessUnavailableError>()(
  "ProjectTerminalAccessUnavailableError",
  {
    operation: Schema.Literals(["spawn", "list", "read", "write", "resize", "kill"]),
  },
) {
  override get message(): string {
    return `Project terminal ${this.operation} failed (unavailable).`;
  }
}

export class ProjectTerminalService extends Context.Service<
  ProjectTerminalService,
  ProjectTerminalServiceShape
>()("t3/terminal/ProjectTerminalService") {}

interface ProjectLifecycleLockEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly references: number;
}

const operationError = (
  operation: "spawn" | "list" | "read" | "write" | "resize" | "kill" | "close",
  projectId: ProjectId,
  terminalId?: string,
) =>
  new TerminalToolError({
    operation,
    reason: "unavailable",
    projectId,
    ...(terminalId === undefined ? {} : { terminalId }),
  });

const make = Effect.gen(function* () {
  const manager = yield* TerminalManager.TerminalManager;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const projectLocks = yield* SynchronizedRef.make(new Map<ProjectId, ProjectLifecycleLockEntry>());

  const projectLock = (projectId: ProjectId) =>
    SynchronizedRef.modifyEffect(projectLocks, (current) => {
      const existing = current.get(projectId);
      if (existing) {
        const next = new Map(current);
        next.set(projectId, { ...existing, references: existing.references + 1 });
        return Effect.succeed([existing.semaphore, next] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(projectId, { semaphore, references: 1 });
          return [semaphore, next] as const;
        }),
      );
    });

  const releaseProjectLock = (projectId: ProjectId) =>
    SynchronizedRef.update(projectLocks, (current) => {
      const existing = current.get(projectId);
      if (!existing) return current;
      const next = new Map(current);
      if (existing.references <= 1) {
        next.delete(projectId);
      } else {
        next.set(projectId, { ...existing, references: existing.references - 1 });
      }
      return next;
    });

  const withProjectLifecycleLock = <A, E, R>(
    projectId: ProjectId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(projectLock(projectId), (lock) =>
      lock.withPermit(effect).pipe(Effect.ensuring(releaseProjectLock(projectId))),
    );

  const requireCallerProject = Effect.fn("ProjectTerminalService.requireCallerProject")(function* (
    operation: "spawn" | "list" | "read" | "write" | "resize" | "kill",
  ) {
    const invocation = yield* McpInvocationContext.requireMcpCapability("terminal");
    const thread = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(Effect.mapError(() => new ProjectTerminalAccessUnavailableError({ operation })));
    if (Option.isNone(thread)) {
      return yield* Effect.fail(new ProjectTerminalAccessUnavailableError({ operation }));
    }

    const projectId = thread.value.projectId;
    const project = yield* snapshots
      .getProjectShellById(projectId)
      .pipe(Effect.mapError(() => operationError(operation, projectId)));
    if (Option.isNone(project)) {
      return yield* operationError(operation, projectId);
    }
    return { invocation, project: project.value };
  });

  const requireActiveProject = (projectId: ProjectId, operation: "spawn" | "close") =>
    snapshots.getProjectShellById(projectId).pipe(
      Effect.mapError(() => operationError(operation, projectId)),
      Effect.flatMap((project) =>
        Option.isSome(project)
          ? Effect.succeed(project.value)
          : Effect.fail(operationError(operation, projectId)),
      ),
    );

  const checkHandleProject = (
    requestedProjectId: ProjectId | undefined,
    currentProjectId: ProjectId,
    operation: "read" | "write" | "resize" | "kill",
    terminalId: string,
  ) =>
    requestedProjectId === undefined || requestedProjectId === currentProjectId
      ? Effect.void
      : Effect.fail(operationError(operation, currentProjectId, terminalId));

  const hasUsefulReadResult = (result: TerminalReadResult): boolean => {
    if (
      result.terminal.status === "exited" ||
      result.terminal.status === "killed" ||
      result.terminal.status === "error" ||
      result.hasMore ||
      result.truncated
    ) {
      return true;
    }
    return result.kind === "stream" ? result.output.length > 0 : result.matches.length > 0;
  };

  const read: ProjectTerminalServiceShape["read"] = (input) =>
    Effect.gen(function* () {
      const { project } = yield* requireCallerProject("read");
      yield* checkHandleProject(input.projectId, project.id, "read", input.terminalId);
      const managerInput = { ...input, projectId: project.id };
      const waitMs = input.waitMs ?? 0;
      if (waitMs === 0) return yield* manager.readProject(managerInput);

      const eventVersion = yield* SubscriptionRef.make(0);
      const target = { projectId: project.id, terminalId: input.terminalId };
      return yield* Effect.acquireUseRelease(
        manager.subscribeProjectTerminal(target, () =>
          SubscriptionRef.update(eventVersion, (version) => version + 1),
        ),
        () =>
          Effect.gen(function* () {
            const startedAt = yield* Clock.currentTimeMillis;
            const deadline = startedAt + waitMs;
            let observedVersion = yield* SubscriptionRef.get(eventVersion);
            let result = yield* manager.readProject(managerInput);

            while (!hasUsefulReadResult(result)) {
              const currentVersion = yield* SubscriptionRef.get(eventVersion);
              if (currentVersion !== observedVersion) {
                observedVersion = currentVersion;
              } else {
                const remainingMs = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
                if (remainingMs === 0) return result;
                const nextVersion = yield* SubscriptionRef.changes(eventVersion).pipe(
                  Stream.filter((version) => version > observedVersion),
                  Stream.runHead,
                  Effect.timeoutOption(remainingMs),
                  Effect.map(Option.flatten),
                );
                if (Option.isNone(nextVersion)) return result;
                observedVersion = nextVersion.value;
              }
              result = yield* manager.readProject(managerInput);
            }
            return result;
          }),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
    });

  const spawn: ProjectTerminalServiceShape["spawn"] = (input) =>
    Effect.gen(function* () {
      const { invocation, project } = yield* requireCallerProject("spawn");
      return yield* withProjectLifecycleLock(
        project.id,
        Effect.gen(function* () {
          const currentProject = yield* requireActiveProject(project.id, "spawn");
          const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const managerInput: ProjectTerminalCreateInput = {
            projectId: currentProject.id,
            terminalId: `terminal_${uuid}`,
            creatingThreadId: invocation.threadId,
            cwd: input.cwd ?? currentProject.workspaceRoot,
            providerInstanceId: invocation.providerInstanceId,
            ...(input.cols === undefined ? {} : { cols: input.cols }),
            ...(input.rows === undefined ? {} : { rows: input.rows }),
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.command === undefined ? {} : { command: input.command }),
            ...(input.args === undefined ? {} : { args: [...input.args] }),
            ...(input.env === undefined ? {} : { env: input.env }),
          };

          // Once the manager has committed the new process, request cancellation
          // must not leave a live terminal whose handle was never returned.
          const terminal = yield* Effect.uninterruptible(manager.createProject(managerInput));
          // The manager operation commits a durable project-scoped process. Defer
          // cancellation until it has returned, then still report cancellation
          // to the caller instead of turning a cancellation request into success.
          yield* Effect.interruptible(Effect.void);
          return terminal;
        }),
      );
    });

  const list: ProjectTerminalServiceShape["list"] = (input = {}) =>
    Effect.gen(function* () {
      const { project } = yield* requireCallerProject("list");
      const limit = input.limit ?? 50;
      const listed = yield* manager.listProject(project.id);
      const filtered = [...listed]
        .filter((terminal) => input.after === undefined || terminal.terminalId > input.after)
        .sort((left, right) => left.terminalId.localeCompare(right.terminalId));
      const terminals = filtered.slice(0, limit);
      const hasMore = filtered.length > terminals.length;
      return {
        terminals,
        nextCursor: hasMore ? (terminals.at(-1)?.terminalId ?? null) : null,
      };
    });

  const write: ProjectTerminalServiceShape["write"] = (input) =>
    Effect.gen(function* () {
      const { project } = yield* requireCallerProject("write");
      yield* checkHandleProject(input.projectId, project.id, "write", input.terminalId);
      yield* manager.writeProject({
        projectId: project.id,
        terminalId: input.terminalId,
        data: input.data,
      });
    });

  const resize: ProjectTerminalServiceShape["resize"] = (input) =>
    Effect.gen(function* () {
      const { project } = yield* requireCallerProject("resize");
      yield* checkHandleProject(input.projectId, project.id, "resize", input.terminalId);
      yield* manager.resizeProject({
        projectId: project.id,
        terminalId: input.terminalId,
        cols: input.cols,
        rows: input.rows,
      });
    });

  const kill: ProjectTerminalServiceShape["kill"] = (input) =>
    Effect.gen(function* () {
      const { project } = yield* requireCallerProject("kill");
      yield* checkHandleProject(input.projectId, project.id, "kill", input.terminalId);
      yield* manager.killProjectTerminal({
        projectId: project.id,
        terminalId: input.terminalId,
        cleanup: input.cleanup ?? false,
      });
    });

  const closeProject: ProjectTerminalServiceShape["closeProject"] = (projectId) =>
    withProjectLifecycleLock(projectId, manager.closeProject(projectId));

  return {
    spawn,
    list,
    read,
    write,
    resize,
    kill,
    closeProject,
  } satisfies ProjectTerminalServiceShape;
});

export const ProjectTerminalServiceLive = Layer.effect(ProjectTerminalService, make);
