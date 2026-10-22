import { assert, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Projects from "./ProjectService.ts";
import * as Setup from "./ProjectSetupScriptRunner.ts";

it.effect("captures the exact terminal after an interrupted open before writing setup", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const opened = yield* Deferred.make<void>();
    const captured = yield* Deferred.make<TerminalManager.TerminalDrainHandle>();
    const handle = { threadId: "setup-thread", terminalId: "setup-install" };
    const write = vi.fn(() => Effect.void);
    const services = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({}),
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.mock(TerminalManager.TerminalManager)({
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
      assert.isTrue(yield* Deferred.isDone(captured));
      assert.strictEqual(yield* Deferred.await(captured), handle);
      assert.equal(write.mock.calls.length, 0);
    }).pipe(Effect.provide(services));
  }),
);

it.effect("rejects a setup write when restart replaces the captured terminal", () =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    const restarted = yield* Deferred.make<void>();
    const handle = { threadId: "setup-thread", terminalId: "setup-install" };
    const write = vi.fn(() => Effect.void);
    const unsubscribe = vi.fn();
    const writeCaptured = vi.fn(() =>
      Effect.fail(
        new TerminalManager.TerminalDrainError({
          ...handle,
          reason: "ownership-mismatch",
        }),
      ),
    );
    const services = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({}),
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.mock(TerminalManager.TerminalManager)({
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
        subscribe: () =>
          Deferred.succeed(subscribed, undefined).pipe(
            Effect.andThen(Deferred.await(restarted)),
            Effect.as(unsubscribe),
          ),
        write,
        writeCaptured,
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
          observeCompletion: {},
          onTerminalAllocated: () => Effect.void,
        })
        .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(subscribed);
      yield* Deferred.succeed(restarted, undefined);
      const result = yield* Fiber.join(running);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProjectSetupScriptOperationError");
        if (result.failure._tag === "ProjectSetupScriptOperationError")
          assert.equal(result.failure.operation, "writeCommand");
      }
      assert.equal(write.mock.calls.length, 0);
      assert.equal(writeCaptured.mock.calls.length, 1);
      assert.equal(unsubscribe.mock.calls.length, 1);
    }).pipe(Effect.provide(services));
  }),
);

it.effect("a terminal restart ends the original setup observer before replacement output", () =>
  Effect.gen(function* () {
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
    let listener:
      | Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]
      | undefined;
    const onOutputLine = vi.fn(() => Effect.void);
    const services = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({}),
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.mock(TerminalManager.TerminalManager)({
        openCaptured: () => Effect.succeed({ capture: handle, snapshot }),
        subscribe: (next) =>
          Effect.sync(() => {
            listener = next;
            return () => {};
          }),
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
      if (setup.status !== "started" || setup.completion === undefined || listener === undefined)
        return yield* Effect.die("Setup observer missing");
      yield* listener({
        type: "restarted",
        ...handle,
        sequence: 1,
        snapshot: { ...snapshot, pid: 43 },
      });
      yield* listener({ type: "output", ...handle, sequence: 2, data: "replacement output\n" });
      assert.equal((yield* setup.completion).exitCode, null);
      assert.equal(onOutputLine.mock.calls.length, 0);
    }).pipe(Effect.provide(services));
  }),
);
