// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeOmpRpcConnection, type OmpRpcRecord, OmpRpcError } from "./rpc.ts";
const ready = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
};
const fixture = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array>();
  const writes = yield* Queue.unbounded<OmpRpcRecord>();
  const spawned = yield* Deferred.make<void>();
  const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const stops = yield* Queue.unbounded<string>();
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      yield* Deferred.succeed(spawned, undefined);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(2147483000),
        exitCode: Deferred.await(exit),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) =>
          Queue.offer(writes, JSON.parse(new TextDecoder().decode(bytes))),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () =>
          Sink.forEach((bytes: Uint8Array) =>
            Queue.offer(stops, new TextDecoder().decode(bytes)).pipe(
              Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0))),
            ),
          ),
        getOutputFd: () =>
          Stream.fromEffect(Deferred.await(exit)).pipe(
            Stream.map((code) =>
              new TextEncoder().encode(
                JSON.stringify({ type: "exit", code: Number(code), signal: null, stdoutBytes: 0 }) +
                  "\n",
              ),
            ),
          ),
      });
    }),
  );
  const push = (v: unknown) =>
    Queue.offer(stdout, new TextEncoder().encode(JSON.stringify(v) + "\n"));
  const open = (
    onUiRequest?: (
      r: OmpRpcRecord,
      send: (r: OmpRpcRecord) => Effect.Effect<void, OmpRpcError>,
    ) => Effect.Effect<void, OmpRpcError>,
  ) =>
    makeOmpRpcConnection({
      command: process.execPath,
      args: [],
      env: {},
      cwd: undefined,
      guardReady: Effect.void,
      ...(onUiRequest ? { onUiRequest } : {}),
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  const ack = (r: OmpRpcRecord, data: unknown) =>
    push({ type: "response", id: r.id, command: r.type, success: true, data });
  const negotiate = Effect.gen(function* () {
    yield* push(ready);
    const n = yield* Queue.take(writes);
    assert.equal(n.type, "negotiate_protocol");
    yield* ack(n, { protocolVersion: 2 });
    const f = yield* Queue.take(writes);
    assert.equal(f.type, "set_event_filter");
    assert.equal(f.messageUpdates, "delta");
    yield* ack(f, { events: null, messageUpdates: "delta" });
  });
  return { stdout, writes, spawned, exit, stops, spawner, push, open, ack, negotiate };
});
it.effect(
  "negotiates before discovery, services startup UI and correlates out-of-order acknowledgements and late failures",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const opening = yield* f
        .open((r, send) => send({ type: "extension_ui_response", id: r.id, value: "yes" }))
        .pipe(Effect.forkChild);
      yield* Deferred.await(f.spawned);
      yield* f.push({ type: "extension_ui_request", id: "dialog", method: "select" });
      assert.equal((yield* Queue.take(f.writes)).type, "extension_ui_response");
      yield* f.negotiate;
      const c = yield* Fiber.join(opening);
      assert.equal((yield* Queue.take(c.events)).type, "extension_ui_request");
      const a = yield* c.request({ type: "get_state" }).pipe(Effect.forkChild);
      const ar = yield* Queue.take(f.writes);
      const b = yield* c.request({ type: "get_models" }).pipe(Effect.forkChild);
      const br = yield* Queue.take(f.writes);
      yield* f.ack(br, { b: 2 });
      yield* f.ack(ar, { a: 1 });
      assert.deepEqual(yield* Fiber.join(a), { a: 1 });
      assert.deepEqual(yield* Fiber.join(b), { b: 2 });
      yield* f.push({
        type: "response",
        command: ar.type,
        id: ar.id,
        success: false,
        error: "late prompt error",
      });
      assert.equal((yield* Queue.take(c.events)).success, false);
      const cancelled = yield* c.request({ type: "get_state" }).pipe(Effect.forkChild);
      const cr = yield* Queue.take(f.writes);
      yield* Fiber.interrupt(cancelled);
      yield* f.ack(cr, { late: true });
      assert.deepEqual((yield* Queue.take(c.events)).data, { late: true });
      yield* Deferred.succeed(f.exit, ChildProcessSpawner.ExitCode(0));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("fails pending requests on a mismatched command or interrupted chunk sequence", () =>
  Effect.gen(function* () {
    for (const variant of ["command", "chunk"]) {
      const f = yield* fixture;
      const opening = yield* f.open().pipe(Effect.forkChild);
      yield* f.negotiate;
      const c = yield* Fiber.join(opening);
      const a = yield* c.request({ type: "get_state" }).pipe(Effect.forkChild);
      const r = yield* Queue.take(f.writes);
      if (variant === "command")
        yield* f.push({
          type: "response",
          id: r.id,
          command: "different",
          success: true,
          data: {},
        });
      else {
        yield* f.push({
          type: "rpc_chunk",
          chunkId: "c",
          index: 0,
          count: 5,
          byteLength: 1100000,
          data: Buffer.alloc(262144, 32).toString("base64"),
        });
        yield* f.push({ type: "agent_end", messages: [] });
      }
      const error = yield* Fiber.join(a).pipe(
        Effect.match({
          onSuccess: () => assert.fail("expected native transport failure"),
          onFailure: (error) => error,
        }),
      );
      assert.equal(error._tag, "OmpRpcError");
      yield* Deferred.succeed(f.exit, ChildProcessSpawner.ExitCode(1));
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("diagnoses immediate exit and owns teardown when setup is interrupted", () =>
  Effect.gen(function* () {
    const failed = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(2147483000),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(17)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.make(new TextEncoder().encode("secret\n".repeat(10000))),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    const error = yield* makeOmpRpcConnection({
      command: process.execPath,
      args: [],
      env: {},
      cwd: undefined,
      guardReady: Effect.void,
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failed), Effect.flip);
    assert.include(error.message, "17");
    assert.notInclude(error.message, "secret");
    const f = yield* fixture;
    const opening = yield* f.open().pipe(Effect.scoped, Effect.forkChild);
    yield* Deferred.await(f.spawned);
    yield* Fiber.interrupt(opening);
    assert.equal(yield* Queue.take(f.stops), "stop\n");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "launches the guarded factory, services pre-ready UI and tears down its child, config and credentials",
  () =>
    Effect.gen(function* () {
      const fs = yield* Effect.promise(() => import("node:fs/promises"));
      const path = yield* Effect.promise(() => import("node:path"));
      const os = yield* Effect.promise(() => import("node:os"));
      const { writeFakeCli } = yield* Effect.promise(
        () => import("@t3tools/provider-testing/fakeCli"),
      );
      const { fakeOmpCliSource } = yield* Effect.promise(() => import("../testing/fakeOmpCli.ts"));
      const { makeOmpProviderSession } = yield* Effect.promise(() => import("./session.ts"));
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "t3-omp-fake-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      );
      const fake = writeFakeCli({ directory: root, name: "bun", source: fakeOmpCliSource });
      const nodePath = yield* Effect.promise(() => import("node:url"));
      const packageRoot = path.dirname(
        path.dirname(nodePath.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"))),
      );
      const c = yield* makeOmpProviderSession({
        binaryPath: path.join(packageRoot, "dist/cli.js"),
        bunPath: fake,
        launchArgs: "--profile=work --model=test",
        env: { PATH: process.env.PATH, TEST_PROVIDER_KEY: "scoped", T3CODE_TOKEN: "must-clear" },
        cacheDir: root,
        config: { cwd: root, mode: "full-access", environment: "e", project: "p" },
        onUiRequest: (r, send) => send({ type: "extension_ui_response", id: r.id, value: "yes" }),
      });
      const result = yield* c.request({ type: "get_state" });
      assert.isObject(result);
      const state = result as {
        pid: number;
        configPath: string;
        credentialPath: string;
        args: string[];
        providerKey: string;
        cleared: boolean;
      };
      assert.equal(state.providerKey, "scoped");
      assert.isTrue(state.cleared);
      assert.include(state.args, "--no-env-file");
      assert.include(state.args, "--preload");
      assert.isTrue(state.args.some((arg) => arg.startsWith("--config=")));
      yield* c.terminate;
      yield* c.exited.pipe(
        Effect.match({
          onSuccess: (code) => assert.equal(code, 0),
          onFailure: (error) => assert.equal(error.operation, "exit"),
        }),
      );
      assert.isFalse(
        yield* Effect.promise(() =>
          fs.access(state.configPath).then(
            () => true,
            () => false,
          ),
        ),
      );
      assert.isFalse(
        yield* Effect.promise(() =>
          fs.access(state.credentialPath).then(
            () => true,
            () => false,
          ),
        ),
      );
      assert.throws(() => process.kill(state.pid, 0));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "times out only the pending request and remains usable for subsequent correlated replies",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const opening = yield* f.open().pipe(Effect.forkChild);
      yield* f.negotiate;
      const c = yield* Fiber.join(opening);
      const pending = yield* c.request({ type: "get_state" }, 200).pipe(Effect.forkChild);
      const request = yield* Queue.take(f.writes);
      yield* TestClock.adjust(200);
      const error = yield* Fiber.join(pending).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("expected timeout"),
        }),
      );
      assert.equal(error._tag, "OmpRpcTimeoutError");
      yield* f.ack(request, { late: true });
      assert.deepEqual((yield* Queue.take(c.events)).data, { late: true });
      yield* Deferred.succeed(f.exit, ChildProcessSpawner.ExitCode(0));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const processFixture = Effect.fn("test.ompProcessFixture")(function* (variant: string) {
  const fs = yield* Effect.promise(() => import("node:fs/promises"));
  const net = yield* Effect.promise(() => import("node:net"));
  const path = yield* Effect.promise(() => import("node:path"));
  const os = yield* Effect.promise(() => import("node:os"));
  const { descendantSource, processFixtureSource } = yield* Effect.promise(
    () => import("../testing/rpcProcessFixture.ts"),
  );
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "t3-omp-process-"))),
    (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
  );
  const messages = yield* Queue.unbounded<{ type: string; pid?: number }>();
  const closed = yield* Deferred.make<void>();
  let peer: import("node:net").Socket | undefined;
  let termSeen = false;
  const socketPath = path.join(root, "witness.sock");
  const server = net.createServer((socket) => {
    peer = socket;
    socket.on("error", () => {});
    socket.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const i = buffer.indexOf("\n");
        if (i < 0) break;
        const message = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (message.type === "term") termSeen = true;
        Queue.offerUnsafe(messages, message);
      }
    });
  });
  yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        }),
    ),
    () =>
      Effect.promise(async () => {
        if (peer && !peer.destroyed) {
          peer.write("stop\n");
          await new Promise<void>((resolve) => peer!.once("close", resolve));
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
  );
  const descendant = path.join(root, "descendant.mjs");
  const entry = path.join(root, "leader.mjs");
  yield* Effect.promise(() =>
    Promise.all([
      fs.writeFile(descendant, descendantSource),
      fs.writeFile(entry, processFixtureSource),
    ]),
  );
  return {
    options: {
      command: process.execPath,
      args: [entry, descendant, socketPath, variant],
      env: {},
      cwd: root,
      guardReady: Effect.void,
    },
    messages,
    closed,
    termSeen: () => termSeen,
    running: (pid: number) =>
      Effect.promise(async () => {
        try {
          const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
          return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
        } catch (error) {
          if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? ""))
            return false;
          throw error;
        }
      }),
  };
});

it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "owned POSIX group teardown kills a TERM-resistant descendant after its leader exits",
  () =>
    Effect.gen(function* () {
      const fixture = yield* processFixture("live");
      const c = yield* makeOmpRpcConnection(fixture.options);
      const result = yield* Deferred.make();
      yield* c.request({ type: "get_state" }).pipe(
        Effect.exit,
        Effect.flatMap((exit) => Deferred.succeed(result, exit)),
        Effect.forkChild,
      );
      const descendant = yield* Queue.take(fixture.messages);
      assert.equal(descendant.type, "descendant");
      assert.isNumber(descendant.pid);
      yield* c.terminate;
      assert.isFalse(yield* fixture.running(descendant.pid!));
      yield* Deferred.await(fixture.closed);
      assert.isTrue(fixture.termSeen());
      assert.isTrue(yield* Deferred.isDone(result));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "owned POSIX leader exit fails pending work even when its descendant holds stdout",
  () =>
    Effect.gen(function* () {
      const fixture = yield* processFixture("exit");
      const c = yield* makeOmpRpcConnection(fixture.options);
      const result =
        yield* Deferred.make<
          import("effect/Exit").Exit<
            unknown,
            import("./rpc.ts").OmpRpcError | import("./rpc.ts").OmpRpcTimeoutError
          >
        >();
      yield* c.request({ type: "get_state" }).pipe(
        Effect.exit,
        Effect.flatMap((exit) => Deferred.succeed(result, exit)),
        Effect.forkChild,
      );
      const descendant = yield* Queue.take(fixture.messages);
      assert.equal(descendant.type, "descendant");
      assert.equal(yield* c.exited, 0);
      assert.isTrue(yield* Deferred.isDone(result));
      const exit = yield* Deferred.await(result);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, OmpRpcError);
        assert.include(String(error), "exited with code 0");
      }
      yield* c.terminate;
      assert.isFalse(yield* fixture.running(descendant.pid!));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "owned POSIX leader exit preserves buffered final acknowledgements and terminal records",
  () =>
    Effect.gen(function* () {
      const fixture = yield* processFixture("final");
      const c = yield* makeOmpRpcConnection(fixture.options);
      const response = yield* c.request({ type: "get_state" });
      assert.deepEqual(response, { text: "日本語😀\u2028\u2029".repeat(4096) });
      assert.equal(yield* c.exited, 0);
      assert.equal((yield* Queue.take(c.events)).type, "descendant");
      assert.deepEqual(yield* Queue.take(c.events), {
        type: "agent_end",
        messages: [{ text: "final" }],
        messageCount: 3,
      });
      yield* c.terminate;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "owned POSIX early exit fails setup without requiring stdout EOF or its setup timeout",
  () =>
    Effect.gen(function* () {
      const fixture = yield* processFixture("setup");
      const error = yield* makeOmpRpcConnection(fixture.options).pipe(Effect.flip);
      assert.equal(error._tag, "OmpRpcError");
      assert.include(error.message, "exited with code 0");
      const descendant = yield* Queue.take(fixture.messages);
      assert.equal(descendant.type, "descendant");
      assert.isFalse(yield* fixture.running(descendant.pid!));
      yield* Deferred.await(fixture.closed);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "logical stdout EOF fails a pending request and cleans a still-live child without using its request deadline",
  () =>
    Effect.gen(function* () {
      const fixture = yield* processFixture("stdout-pending");
      const c = yield* makeOmpRpcConnection(fixture.options);
      const request = yield* c.request({ type: "get_state" }, 2000).pipe(
        Effect.match({
          onSuccess: () => assert.fail("stdout-close fixture cannot reply"),
          onFailure: (error) => error,
        }),
        Effect.forkChild,
      );
      const descendant = yield* Queue.take(fixture.messages);
      assert.equal(descendant.type, "descendant");
      assert.equal((yield* Queue.take(fixture.messages)).type, "stdout-closed");
      const error = yield* Fiber.join(request);
      assert.equal(error._tag, "OmpRpcError");
      assert.include(error.message, "stdout");
      assert.equal(yield* c.exited, 23);
      yield* c.terminate;
      assert.isFalse(yield* fixture.running(descendant.pid!));
      yield* Deferred.await(fixture.closed);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "logical stdout EOF fails pre-ready setup and cleans a still-live child without using its setup deadline",
  () =>
    Effect.gen(function* () {
      const fixture = yield* processFixture("stdout-setup");
      const opening = yield* makeOmpRpcConnection({
        ...fixture.options,
        setupTimeoutMs: 2000,
      }).pipe(Effect.flip, Effect.forkChild);
      const descendant = yield* Queue.take(fixture.messages);
      assert.equal(descendant.type, "descendant");
      assert.equal((yield* Queue.take(fixture.messages)).type, "stdout-closed");
      const error = yield* Fiber.join(opening);
      assert.equal(error._tag, "OmpRpcError");
      assert.include(error.message, "stdout");
      assert.isFalse(yield* fixture.running(descendant.pid!));
      yield* Deferred.await(fixture.closed);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
