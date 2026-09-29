import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TerminalToolError,
  ThreadId,
  type ProjectTerminalCreateInput,
  type ProjectTerminalSummary,
  type TerminalReadInput,
  type TerminalReadResult,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "./Manager.ts";
import type { ProjectTerminalRuntimeEvent } from "./RuntimeTypes.ts";
import { ProjectTerminalService, ProjectTerminalServiceLive } from "./ProjectTerminalService.ts";

const projectId = ProjectId.make("project-terminal-service-test");
const firstThreadId = ThreadId.make("thread-terminal-service-first");
const secondThreadId = ThreadId.make("thread-terminal-service-second");
const now = "2026-09-28T00:00:00.000Z";
const isTerminalToolError = Schema.is(TerminalToolError);

const invocation = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["terminal"],
  providerInstanceId = ProviderInstanceId.make("codex"),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-terminal-service-test"),
  threadId,
  providerSessionId: `session-${threadId}`,
  providerInstanceId,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const project = {
  id: projectId,
  title: "Terminal service project",
  workspaceRoot: "/workspace/terminal-service",
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
};

const makeHarness = () => {
  const threads = new Map([
    [firstThreadId, { id: firstThreadId, projectId }],
    [secondThreadId, { id: secondThreadId, projectId }],
  ]);
  const terminals = new Map<string, ProjectTerminalSummary>();
  const createInputs: Array<ProjectTerminalCreateInput> = [];
  const listProjects: Array<string> = [];
  const accessAttempts: Array<{ operation: string; terminalId: string }> = [];
  const readInputs: Array<TerminalReadInput> = [];
  const eventOrder: Array<string> = [];
  const readResults: Array<TerminalReadResult> = [];
  const projectEventListeners = new Set<
    (event: ProjectTerminalRuntimeEvent) => Effect.Effect<void>
  >();
  let beforeRead: Effect.Effect<void> = Effect.void;
  let unsubscribeCalls = 0;
  const unavailable = (operation: "read" | "write" | "resize" | "kill", terminalId: string) =>
    new TerminalToolError({ operation, reason: "unavailable", projectId, terminalId });

  const rejectUnavailableTarget = (operation: "write" | "resize" | "kill", terminalId: string) => {
    accessAttempts.push({ operation, terminalId });
    return Effect.fail(unavailable(operation, terminalId));
  };

  const manager = {
    createProject: (input: ProjectTerminalCreateInput) =>
      Effect.sync(() => {
        createInputs.push(input);
        const summary: ProjectTerminalSummary = {
          projectId: input.projectId,
          terminalId: input.terminalId,
          title: input.title ?? null,
          command: input.command ?? null,
          args: input.args ?? [],
          cwd: input.cwd,
          creatingThreadId: input.creatingThreadId,
          label: input.title ?? input.command ?? "Terminal",
          status: "running",
          pid: 9123,
          exitCode: null,
          exitSignal: null,
          updatedAt: now,
        };
        terminals.set(summary.terminalId, summary);
        return summary;
      }),
    listProject: (id: string) =>
      Effect.sync(() => {
        listProjects.push(id);
        return [...terminals.values()].filter((terminal) => terminal.projectId === id);
      }),
    readProject: (input: TerminalReadInput) => {
      eventOrder.push("read");
      readInputs.push(input);
      accessAttempts.push({ operation: "read", terminalId: input.terminalId });
      return beforeRead.pipe(
        Effect.andThen(
          Effect.sync(() => readResults.shift() ?? unavailable("read", input.terminalId)),
        ),
        Effect.flatMap((result) =>
          isTerminalToolError(result) ? Effect.fail(result) : Effect.succeed(result),
        ),
      );
    },
    subscribeProjectTerminal: (
      _handle: Pick<TerminalReadInput, "projectId" | "terminalId">,
      listener: Parameters<typeof projectEventListeners.add>[0],
    ) =>
      Effect.sync(() => {
        eventOrder.push("subscribe");
        projectEventListeners.add(listener);
        return () => {
          unsubscribeCalls += 1;
          projectEventListeners.delete(listener);
        };
      }),
    writeProject: (input: { terminalId: string }) =>
      rejectUnavailableTarget("write", input.terminalId),
    resizeProject: (input: { terminalId: string }) =>
      rejectUnavailableTarget("resize", input.terminalId),
    killProjectTerminal: (input: { terminalId: string }) =>
      rejectUnavailableTarget("kill", input.terminalId),
    closeProject: (id: string) =>
      Effect.sync(() => {
        for (const [terminalId, terminal] of terminals) {
          if (terminal.projectId === id) terminals.delete(terminalId);
        }
      }),
    subscribeProjectEvents: () => Effect.succeed(() => undefined),
  };

  const snapshots = {
    getThreadShellById: (id: ThreadId) => Effect.succeed(Option.fromNullishOr(threads.get(id))),
    getProjectShellById: (id: ProjectId) =>
      Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;

  const crypto = Crypto.make({
    randomBytes: (size) => new Uint8Array(size).fill(7),
    digest: (_algorithm, data) => Effect.succeed(data),
  });

  const layer = ProjectTerminalServiceLive.pipe(
    Layer.provide(
      Layer.succeed(
        TerminalManager.TerminalManager,
        manager as unknown as TerminalManager.TerminalManager["Service"],
      ),
    ),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots)),
    Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
  );

  const publishProjectTerminalEvent = (event: ProjectTerminalRuntimeEvent) =>
    Effect.forEach([...projectEventListeners], (listener) => listener(event), { discard: true });

  return {
    layer,
    threads,
    terminals,
    createInputs,
    listProjects,
    readInputs,
    readResults,
    eventOrder,
    accessAttempts,
    manager,
    publishProjectTerminalEvent,
    setBeforeRead: (effect: Effect.Effect<void>) => {
      beforeRead = effect;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
  };
};

describe("ProjectTerminalService", () => {
  effectIt.effect(
    "lets another provider find a project terminal after its creator thread is deleted",
    () => {
      const harness = makeHarness();

      return Effect.gen(function* () {
        const service = yield* ProjectTerminalService;
        const spawned = yield* service
          .spawn({ title: "shared shell" })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(firstThreadId),
            ),
          );

        harness.threads.delete(firstThreadId);
        const listed = yield* service
          .list({})
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(secondThreadId, ["terminal"], ProviderInstanceId.make("claude")),
            ),
          );

        expect(harness.createInputs).toHaveLength(1);
        expect(harness.createInputs[0]).toMatchObject({
          projectId,
          creatingThreadId: firstThreadId,
          cwd: project.workspaceRoot,
          providerInstanceId: ProviderInstanceId.make("codex"),
        });
        expect(spawned.projectId).toBe(projectId);
        expect(spawned.creatingThreadId).toBe(firstThreadId);
        expect(listed.terminals).toEqual([spawned]);
        expect(harness.listProjects).toEqual([projectId]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  effectIt.effect(
    "checks the terminal capability before resolving or changing project terminals",
    () => {
      const harness = makeHarness();

      return Effect.gen(function* () {
        const service = yield* ProjectTerminalService;
        const failure = yield* service
          .spawn({})
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(firstThreadId, []),
            ),
            Effect.flip,
          );

        expect(failure).toMatchObject({
          _tag: "McpCapabilityUnavailableError",
          capability: "terminal",
        });
        expect(harness.createInputs).toEqual([]);
        expect(harness.terminals.size).toBe(0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  effectIt.effect("preserves explicit worktree cwd and provider environment attribution", () => {
    const harness = makeHarness();
    const worktreePath = "/workspace/terminal-service/worktrees/feature-a";

    return Effect.gen(function* () {
      const service = yield* ProjectTerminalService;
      const spawned = yield* service
        .spawn({
          cwd: worktreePath,
          cols: 132,
          rows: 43,
          command: "node",
          args: ["-e", "process.stdout.write('worktree')"],
          env: { REQUEST_VALUE: "kept-private" },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(firstThreadId),
          ),
        );

      expect(harness.createInputs[0]).toMatchObject({
        cwd: worktreePath,
        cols: 132,
        rows: 43,
        providerInstanceId: ProviderInstanceId.make("codex"),
        command: "node",
        args: ["-e", "process.stdout.write('worktree')"],
        env: { REQUEST_VALUE: "kept-private" },
      });
      expect(spawned).not.toHaveProperty("env");
    }).pipe(Effect.provide(harness.layer));
  });

  effectIt.effect("subscribes before the first read and rereads after terminal output", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const service = yield* ProjectTerminalService;
      const terminal = yield* service
        .spawn({ title: "readable project shell" })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(firstThreadId),
          ),
        );
      const initial: TerminalReadResult = {
        kind: "stream",
        terminal,
        output: "",
        nextCursor: "0",
        hasMore: false,
        truncated: false,
      };
      const updated: TerminalReadResult = {
        ...initial,
        output: "ready\n",
        nextCursor: "6",
      };
      harness.readResults.push(initial, updated);
      const initialReadStarted = yield* Deferred.make<void>();
      harness.setBeforeRead(Deferred.succeed(initialReadStarted, undefined));

      const readFiber = yield* Effect.forkChild(
        service
          .read({ projectId, terminalId: terminal.terminalId, waitMs: 1_000 })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(secondThreadId),
            ),
          ),
      );
      yield* Deferred.await(initialReadStarted);

      expect(harness.eventOrder).toEqual(["subscribe", "read"]);
      yield* harness.publishProjectTerminalEvent({
        type: "output",
        target: { owner: { kind: "project", projectId }, terminalId: terminal.terminalId },
        generation: "generation-1",
        sequence: 1,
        data: "ready\n",
      });
      const read = yield* Fiber.join(readFiber);

      expect(read).toEqual(updated);
      expect(harness.readInputs.map((input) => input.projectId)).toEqual([projectId, projectId]);
      expect(harness.unsubscribeCalls).toBe(1);
    }).pipe(Effect.provide(harness.layer));
  });

  effectIt.effect("cancels a pending read subscription without holding the project lock", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const service = yield* ProjectTerminalService;
      const terminal = yield* service
        .spawn({ title: "cancellable read shell" })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(firstThreadId),
          ),
        );
      harness.readResults.push({
        kind: "stream",
        terminal,
        output: "",
        nextCursor: "0",
        hasMore: false,
        truncated: false,
      });
      const initialReadStarted = yield* Deferred.make<void>();
      const closeStarted = yield* Deferred.make<void>();
      harness.setBeforeRead(Deferred.succeed(initialReadStarted, undefined));
      const originalClose = harness.manager.closeProject;
      harness.manager.closeProject = (id) =>
        Deferred.succeed(closeStarted, undefined).pipe(Effect.andThen(originalClose(id)));

      const readFiber = yield* Effect.forkChild(
        service
          .read({ projectId, terminalId: terminal.terminalId, waitMs: 30_000 })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(secondThreadId),
            ),
          ),
      );
      yield* Deferred.await(initialReadStarted);
      const closeFiber = yield* Effect.forkChild(service.closeProject(projectId));
      yield* Deferred.await(closeStarted);
      yield* Fiber.interrupt(readFiber);
      yield* Fiber.join(closeFiber);

      expect(harness.unsubscribeCalls).toBe(1);
      expect(
        (yield* service
          .list({})
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(secondThreadId),
            ),
          )).terminals,
      ).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  effectIt.effect("returns the latest empty read when the wait deadline expires", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const service = yield* ProjectTerminalService;
      const terminal = yield* service
        .spawn({ title: "timed read shell" })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(firstThreadId),
          ),
        );
      const emptyRead: TerminalReadResult = {
        kind: "stream",
        terminal,
        output: "",
        nextCursor: "0",
        hasMore: false,
        truncated: false,
      };
      harness.readResults.push(emptyRead);
      const initialReadStarted = yield* Deferred.make<void>();
      harness.setBeforeRead(Deferred.succeed(initialReadStarted, undefined));

      const readFiber = yield* Effect.forkChild(
        service
          .read({ projectId, terminalId: terminal.terminalId, waitMs: 25 })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(secondThreadId),
            ),
          ),
      );
      yield* Deferred.await(initialReadStarted);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("25 millis");
      const read = yield* Fiber.join(readFiber);

      expect(read).toEqual(emptyRead);
      expect(harness.readInputs).toHaveLength(1);
      expect(harness.unsubscribeCalls).toBe(1);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));
  });

  effectIt.effect("returns a truncated cursor gap without waiting for new output", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const service = yield* ProjectTerminalService;
      const terminal = yield* service
        .spawn({ title: "truncated read shell" })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(firstThreadId),
          ),
        );
      const truncatedRead: TerminalReadResult = {
        kind: "stream",
        terminal,
        output: "",
        nextCursor: "8",
        hasMore: false,
        truncated: true,
      };
      harness.readResults.push(truncatedRead);
      const initialReadStarted = yield* Deferred.make<void>();
      harness.setBeforeRead(Deferred.succeed(initialReadStarted, undefined));

      const readFiber = yield* Effect.forkChild(
        service
          .read({ projectId, terminalId: terminal.terminalId, waitMs: 30_000 })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(secondThreadId),
            ),
            Effect.timeoutOption("100 millis"),
          ),
      );
      yield* Deferred.await(initialReadStarted);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      const maybeRead = yield* Fiber.join(readFiber);

      expect(Option.isSome(maybeRead)).toBe(true);
      if (Option.isSome(maybeRead)) expect(maybeRead.value).toEqual(truncatedRead);
      expect(harness.readInputs).toHaveLength(1);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));
  });

  effectIt.effect(
    "leaves a committed terminal discoverable after its spawn request is cancelled",
    () => {
      const harness = makeHarness();

      return Effect.gen(function* () {
        const createEntered = yield* Deferred.make<void>();
        const releaseCreate = yield* Deferred.make<void>();
        const originalCreate = harness.manager.createProject;
        harness.manager.createProject = (input) =>
          Deferred.succeed(createEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCreate)),
            Effect.andThen(originalCreate(input)),
          );

        const service = yield* ProjectTerminalService;
        const spawn = yield* Effect.forkChild(
          service
            .spawn({ title: "survive request cancellation" })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(firstThreadId),
              ),
            ),
        );
        yield* Deferred.await(createEntered);

        const interrupt = yield* Effect.forkChild(Fiber.interrupt(spawn));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseCreate, undefined);
        yield* Fiber.join(interrupt);
        const interrupted = yield* Fiber.await(spawn);
        const listed = yield* service
          .list({})
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(secondThreadId),
            ),
          );

        expect(interrupted._tag).toBe("Failure");
        expect(listed.terminals).toHaveLength(1);
        expect(listed.terminals[0]?.title).toBe("survive request cancellation");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  effectIt.effect(
    "returns the same unavailable result for foreign, dock, and unknown handles",
    () => {
      const harness = makeHarness();
      const invalidTargets = [
        "foreign-project-terminal",
        "human-dock-terminal",
        "unknown-terminal",
      ];
      const invalidOperations = ["read", "write", "resize", "kill"] as const;
      const errorReason = (failure: unknown) =>
        isTerminalToolError(failure) ? failure.reason : "unexpected-error";

      return Effect.gen(function* () {
        const service = yield* ProjectTerminalService;
        const failures = yield* Effect.forEach(
          invalidOperations.flatMap((operation) =>
            invalidTargets.map((terminalId) => ({ operation, terminalId })),
          ),
          ({ operation, terminalId }) => {
            const request =
              operation === "read"
                ? service.read({ projectId, terminalId })
                : operation === "write"
                  ? service.write({ terminalId, data: "x" })
                  : operation === "resize"
                    ? service.resize({ terminalId, cols: 100, rows: 40 })
                    : service.kill({ terminalId });
            return request.pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(secondThreadId),
              ),
              Effect.flip,
            );
          },
        );

        expect(failures.map(errorReason)).toEqual(Array(12).fill("unavailable"));

        const foreignProjectId = ProjectId.make("another-project");
        const crossProjectFailures = yield* Effect.all([
          service
            .read({ projectId: foreignProjectId, terminalId: "foreign-project-terminal" })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(secondThreadId),
              ),
              Effect.flip,
            ),
          service
            .write({
              projectId: foreignProjectId,
              terminalId: "foreign-project-terminal",
              data: "x",
            })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(secondThreadId),
              ),
              Effect.flip,
            ),
          service
            .resize({
              projectId: foreignProjectId,
              terminalId: "foreign-project-terminal",
              cols: 100,
              rows: 40,
            })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(secondThreadId),
              ),
              Effect.flip,
            ),
          service
            .kill({ projectId: foreignProjectId, terminalId: "foreign-project-terminal" })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(secondThreadId),
              ),
              Effect.flip,
            ),
        ]);

        expect(crossProjectFailures.map(errorReason)).toEqual(Array(4).fill("unavailable"));
        expect(harness.accessAttempts).toEqual(
          invalidOperations.flatMap((operation) =>
            invalidTargets.map((terminalId) => ({ operation, terminalId })),
          ),
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
