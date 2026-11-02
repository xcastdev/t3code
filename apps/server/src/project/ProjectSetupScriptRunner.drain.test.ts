import { assert, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProjectId, type TerminalEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Projects from "./ProjectService.ts";
import * as Setup from "./ProjectSetupScriptRunner.ts";

const makeEvents = Effect.fn("test.projectSetupDrain.events")(function* () {
  const closed = yield* Deferred.make<void>();
  const listeners = new Set<
    Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]
  >();
  const unsubscribe = vi.fn((listener: (event: TerminalEvent) => Effect.Effect<void>) => {
    listeners.delete(listener);
    if (listeners.size === 0) Deferred.doneUnsafe(closed, Effect.void);
  });
  return {
    closed,
    unsubscribe,
    subscribe: (listener: (event: TerminalEvent) => Effect.Effect<void>) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => unsubscribe(listener);
      }),
    emit: (event: TerminalEvent) =>
      Effect.forEach([...listeners], (listener) => listener(event), { discard: true }),
  };
});

it.effect("captures the exact terminal after an interrupted open before writing setup", () =>
  Effect.gen(function* () {
    const events = yield* makeEvents();
    const entered = yield* Deferred.make<void>();
    const opened = yield* Deferred.make<void>();
    const captured = yield* Deferred.make<TerminalManager.TerminalDrainHandle>();
    const handle = { threadId: "setup-thread", terminalId: "setup-install" };
    const write = vi.fn(() => Effect.void);
    const writeCaptured = vi.fn(() => Effect.void);
    const services = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: () => Effect.succeed(null),
      }),
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.mock(TerminalManager.TerminalManager)({
        getShell: () => Effect.succeed("/bin/zsh"),
        openCaptured: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(opened)),
            Effect.as({
              capture: handle,
              snapshot: {
                ...handle,
                cwd: "/repo-worktree",
                worktreePath: "/repo-worktree",
                status: "running",
                pid: 42,
                history: "",
                exitCode: null,
                exitSignal: null,
                label: "Setup",
                updatedAt: "2026-01-01T00:00:00Z",
              },
            }),
          ),
        write,
        writeCaptured,
        subscribe: events.subscribe,
      }),
    );
    yield* Effect.gen(function* () {
      const runner = yield* Setup.make;
      const running = yield* runner
        .runForThread({
          threadId: handle.threadId,
          worktreePath: "/repo-worktree",
          project: {
            id: ProjectId.make("setup-project"),
            workspaceRoot: "/repo",
            scripts: [
              {
                id: "install",
                name: "Install",
                command: "install",
                icon: "configure",
                runOnWorktreeCreate: true,
              },
            ],
          },
          retainTerminalForDrain: true,
          onTerminalAllocated: (_terminalId, capture) =>
            Deferred.succeed(captured, capture).pipe(Effect.asVoid),
        })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(entered);
      const stopping = yield* Fiber.interrupt(running).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.succeed(opened, undefined);
      yield* Fiber.join(stopping);
      yield* Deferred.await(events.closed);
      assert.isTrue(yield* Deferred.isDone(captured));
      assert.strictEqual(yield* Deferred.await(captured), handle);
      assert.equal(write.mock.calls.length, 0);
      assert.equal(writeCaptured.mock.calls.length, 0);
    }).pipe(Effect.provide(services));
  }),
);

it.effect("withholds a delayed setup write from a replacement and retains unknown completion", () =>
  Effect.gen(function* () {
    const events = yield* makeEvents();
    const attempted = yield* Deferred.make<void>();
    const handle = { threadId: "setup-thread", terminalId: "setup-install" };
    const write = vi.fn(() => Effect.void);
    const replacementWrites: string[] = [];
    let replaced = false;
    const writeCaptured = vi.fn(
      (input: Parameters<TerminalManager.TerminalManager["Service"]["writeCaptured"]>[0]) =>
        (replaced || input.capture !== handle
          ? Effect.fail(
              new TerminalManager.TerminalDrainError({
                ...handle,
                reason: "ownership-mismatch",
              }),
            )
          : Effect.sync(() => {
              replacementWrites.push(input.data);
            })
        ).pipe(Effect.ensuring(Deferred.succeed(attempted, undefined))),
    );
    const services = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: () => Effect.succeed(null),
      }),
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.mock(TerminalManager.TerminalManager)({
        getShell: () => Effect.succeed("/bin/zsh"),
        openCaptured: () =>
          Effect.succeed({
            capture: handle,
            snapshot: {
              ...handle,
              cwd: "/repo-worktree",
              worktreePath: "/repo-worktree",
              status: "running",
              pid: 42,
              history: "",
              exitCode: null,
              exitSignal: null,
              label: "Setup",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          }),
        subscribe: events.subscribe,
        write,
        writeCaptured,
      }),
    );
    yield* Effect.gen(function* () {
      const runner = yield* Setup.make;
      const setup = yield* runner.runForThread({
        threadId: handle.threadId,
        worktreePath: "/repo-worktree",
        project: {
          id: ProjectId.make("setup-project"),
          workspaceRoot: "/repo",
          scripts: [
            {
              id: "install",
              name: "Install",
              command: "install",
              icon: "configure",
              runOnWorktreeCreate: true,
            },
          ],
        },
        retainTerminalForDrain: true,
        observeCompletion: {},
        onTerminalAllocated: () => Effect.void,
      });
      assert.equal(setup.status, "started");
      if (setup.status !== "started" || setup.completion === undefined)
        return yield* Effect.die("Setup observer missing");
      assert.equal(writeCaptured.mock.calls.length, 0);
      replaced = true;
      yield* events.emit({
        type: "restarted",
        ...handle,
        sequence: 1,
        snapshot: {
          ...handle,
          cwd: "/repo-worktree",
          worktreePath: "/repo-worktree",
          status: "running",
          pid: 43,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "Setup",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
      yield* events.emit({ type: "output", ...handle, sequence: 2, data: "% \x1b[?2004h" });
      yield* Deferred.await(attempted);
      assert.equal((yield* setup.completion).exitCode, null);
      yield* Deferred.await(events.closed);
      assert.equal(write.mock.calls.length, 0);
      assert.equal(writeCaptured.mock.calls.length, 1);
      assert.strictEqual(writeCaptured.mock.calls[0]?.[0].capture, handle);
      assert.deepEqual(replacementWrites, []);
      assert.equal(events.unsubscribe.mock.calls.length, 2);
    }).pipe(Effect.provide(services));
  }),
);

it.effect("a terminal restart ends the original setup observer before replacement output", () =>
  Effect.gen(function* () {
    const events = yield* makeEvents();
    const handle = { threadId: "setup-thread", terminalId: "setup-install" };
    const snapshot = {
      ...handle,
      cwd: "/repo-worktree",
      worktreePath: "/repo-worktree",
      status: "running" as const,
      pid: 42,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Setup",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const onOutputLine = vi.fn(() => Effect.void);
    const services = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: () => Effect.succeed(null),
      }),
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.mock(TerminalManager.TerminalManager)({
        getShell: () => Effect.succeed("/bin/zsh"),
        openCaptured: () => Effect.succeed({ capture: handle, snapshot }),
        subscribe: events.subscribe,
        writeCaptured: () => Effect.void,
      }),
    );
    yield* Effect.gen(function* () {
      const runner = yield* Setup.make;
      const setup = yield* runner.runForThread({
        threadId: handle.threadId,
        worktreePath: "/repo-worktree",
        project: {
          id: ProjectId.make("setup-project"),
          workspaceRoot: "/repo",
          scripts: [
            {
              id: "install",
              name: "Install",
              command: "install",
              icon: "configure",
              runOnWorktreeCreate: true,
            },
          ],
        },
        retainTerminalForDrain: true,
        observeCompletion: { onOutputLine },
        onTerminalAllocated: () => Effect.void,
      });
      assert.equal(setup.status, "started");
      if (setup.status !== "started" || setup.completion === undefined)
        return yield* Effect.die("Setup observer missing");
      yield* events.emit({
        type: "restarted",
        ...handle,
        sequence: 1,
        snapshot: { ...snapshot, pid: 43 },
      });
      yield* events.emit({ type: "output", ...handle, sequence: 2, data: "replacement output\n" });
      assert.equal((yield* setup.completion).exitCode, null);
      assert.equal(onOutputLine.mock.calls.length, 0);
    }).pipe(Effect.provide(services));
  }),
);
