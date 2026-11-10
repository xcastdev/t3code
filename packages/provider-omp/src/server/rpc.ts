// @effect-diagnostics nodeBuiltinImport:off
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { processSupervisorSource } from "./processSupervisor.ts";
import {
  OmpProtocolDecoder,
  encodeOmpInput,
  MAX_OMP_REASSEMBLED_BYTES,
  type OmpRpcRecord,
} from "./protocol.ts";
export type { OmpRpcRecord } from "./protocol.ts";
export class OmpRpcError extends Schema.TaggedError<OmpRpcError>()("OmpRpcError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `OMP RPC ${this.operation} failed${this.detail ? `: ${this.detail}` : ""}.`;
  }
}
export class OmpRpcTimeoutError extends Schema.TaggedError<OmpRpcTimeoutError>()(
  "OmpRpcTimeoutError",
  { operation: Schema.String, timeoutMs: Schema.Number },
) {
  override get message() {
    return `OMP RPC ${this.operation} timed out after ${this.timeoutMs}ms.`;
  }
}
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSupervisorExit = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literals(["exit", "stdout_end", "stdout_error"]),
      code: Schema.NullOr(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      ),
      signal: Schema.NullOr(Schema.String),
      stdoutBytes: Schema.Int.check(
        Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      ),
      error: Schema.optional(Schema.String),
    }),
  ),
);
export interface OmpRpcSpawnOptions {
  command: string;
  args: readonly string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  guardReady: Effect.Effect<void, OmpRpcError>;
  onUiRequest?: (
    record: OmpRpcRecord,
    send: (record: OmpRpcRecord) => Effect.Effect<void, OmpRpcError>,
  ) => Effect.Effect<void, OmpRpcError>;
  setupTimeoutMs?: number;
  invalidated?: Effect.Effect<never, OmpRpcError>;
  supervisorRuntime?: { command: string; args: readonly string[] };
}
export interface OmpRpcConnection {
  send: (record: OmpRpcRecord) => Effect.Effect<void, OmpRpcError>;
  request: (
    record: OmpRpcRecord,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, OmpRpcError | OmpRpcTimeoutError>;
  events: Queue.Queue<OmpRpcRecord, OmpRpcError>;
  exited: Effect.Effect<number, OmpRpcError>;
  terminate: Effect.Effect<void>;
  diagnostics: () => { stderrBytes: number };
}
const buildConnection = Effect.fn("OmpRpc.connect")(function* (options: OmpRpcSpawnOptions) {
  const scope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = yield* resolveSpawnCommand(options.command, [...options.args], {
    env: options.env,
  }).pipe(Effect.mapError((cause) => new OmpRpcError({ operation: "spawn", cause })));
  const exit = yield* Deferred.make<number, OmpRpcError>();
  const supervisorExit = yield* Deferred.make<number, OmpRpcError>();
  const supervised = platform !== "win32";
  let supervisorExited = false;
  let terminationStarted = false;
  const terminated = yield* Deferred.make<void>();
  const configJson = yield* encodeJson({
    command: command.command,
    args: command.args,
    shell: command.shell,
    cwd: options.cwd,
    parentPid: process.pid,
    electron: options.env.ELECTRON_RUN_AS_NODE,
    nodeOptions: options.env.NODE_OPTIONS,
  }).pipe(Effect.mapError((cause) => new OmpRpcError({ operation: "spawn", cause })));
  let spawnCommand = command;
  let spawnEnv = options.env;
  if (supervised) {
    const runtime = (yield* HostProcess.IsExecutable)
      ? options.supervisorRuntime
      : { command: yield* HostProcess.ExecutablePath, args: ["--input-type=module"] };
    if (!runtime)
      return yield* new OmpRpcError({
        operation: "spawn",
        detail: "packaged OMP requires its configured Bun supervisor runtime",
      });
    spawnEnv = {
      ...options.env,
      NODE_OPTIONS: undefined,
      ELECTRON_RUN_AS_NODE: "1",
      T3_OMP_SUPERVISOR: configJson,
    };
    spawnCommand = yield* resolveSpawnCommand(
      runtime.command,
      [...runtime.args, "--eval", processSupervisorSource],
      { env: spawnEnv },
    ).pipe(Effect.mapError((cause) => new OmpRpcError({ operation: "spawn", cause })));
  }
  const ownProcess = (child: ChildProcessSpawner.ChildProcessHandle) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        if (terminationStarted) return Deferred.await(terminated);
        terminationStarted = true;
        return Effect.gen(function* () {
          if (!supervisorExited) {
            if (supervised) {
              yield* Stream.make(new TextEncoder().encode("stop\n")).pipe(
                Stream.run(child.getInputFd(4)),
                Effect.ignore,
              );
            } else {
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const task = yield* spawner.spawn(
                    ChildProcess.make("taskkill", ["/PID", String(child.pid), "/T", "/F"]),
                  );
                  yield* task.exitCode;
                }),
              ).pipe(Effect.ignore);
            }
            const observed = yield* child.exitCode.pipe(
              Effect.timeoutOption(Duration.seconds(3)),
              Effect.map((result) =>
                Option.isSome(result)
                  ? Exit.succeed(Number(result.value))
                  : Exit.fail(
                      new OmpRpcError({
                        operation: "exit",
                        detail: "supervisor did not stop within its cleanup bound",
                      }),
                    ),
              ),
              Effect.catch((cause) =>
                Effect.succeed(Exit.fail(new OmpRpcError({ operation: "exit", cause }))),
              ),
            );
            supervisorExited = true;
            yield* Deferred.done(supervisorExit, observed);
          }
          if (!(yield* Deferred.isDone(exit)))
            yield* Deferred.fail(
              exit,
              new OmpRpcError({
                operation: "exit",
                detail: "process stopped before its final exit record was observed",
              }),
            );
        }).pipe(Effect.ensuring(Deferred.succeed(terminated, undefined)), Effect.ignore);
      }),
    );
  const child = yield* Effect.acquireRelease(
    spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env: spawnEnv,
          extendEnv: false,
          shell: spawnCommand.shell,
          detached: supervised,
          ...(supervised
            ? {
                additionalFds: {
                  fd3: { type: "output" as const },
                  fd4: { type: "input" as const },
                },
              }
            : {}),
        }),
      )
      .pipe(
        Effect.mapError((cause) => new OmpRpcError({ operation: "spawn", cause })),
        // The pinned supervisor owns teardown, including cleanup after its logical child exits.
        Effect.tap((handle) => (supervised ? handle.unref.pipe(Effect.asVoid) : Effect.void)),
      ),
    ownProcess,
  );

  const terminateProcess = ownProcess(child);
  const events = yield* Queue.dropping<OmpRpcRecord, OmpRpcError>(1024);
  const outgoing = yield* Queue.bounded<Iterable<Uint8Array>, OmpRpcError>(8);
  const down = yield* Deferred.make<never, OmpRpcError>();
  const ready = yield* Deferred.make<void, OmpRpcError>();
  const pending = new Map<
    string,
    { command: string; deferred: Deferred.Deferred<unknown, OmpRpcError> }
  >();
  let next = 0;
  let stderrBytes = 0;
  let diagnosing = false;
  const decoder = new OmpProtocolDecoder();
  const failTransport = Effect.fn("OmpRpc.failTransport")(function* (error: OmpRpcError) {
    if (!(yield* Deferred.fail(down, error))) return;
    yield* Deferred.fail(ready, error);
    for (const entry of pending.values()) yield* Deferred.fail(entry.deferred, error);
    pending.clear();
    yield* Queue.fail(outgoing, error);
    yield* Queue.fail(events, error);
    yield* terminateProcess.pipe(Effect.forkIn(scope));
  });
  if (options.invalidated)
    yield* options.invalidated.pipe(
      Effect.catch((error) => failTransport(error)),
      Effect.forkIn(scope),
    );
  yield* Scope.addFinalizer(
    scope,
    failTransport(new OmpRpcError({ operation: "terminate", detail: "OMP process was stopped" })),
  );
  const rawSend = Effect.fn("OmpRpc.send")(function* (record: OmpRpcRecord) {
    const json = yield* encodeJson(record).pipe(
      Effect.mapError((cause) => new OmpRpcError({ operation: "encode", cause })),
    );
    const size = new TextEncoder().encode(json).length;
    if (size > MAX_OMP_REASSEMBLED_BYTES)
      return yield* new OmpRpcError({
        operation: "write",
        detail: "outbound frame exceeds negotiated transport budget",
      });
    yield* Queue.offer(outgoing, encodeOmpInput(json));
  });
  const rawRequest = Effect.fn("OmpRpc.request")(function* (
    record: OmpRpcRecord,
    timeoutMs = 30000,
  ) {
    if (pending.size >= 1024)
      return yield* new OmpRpcError({ operation: "request", detail: "too many pending requests" });
    const id = `t3-omp-${next++}`;
    const deferred = yield* Deferred.make<unknown, OmpRpcError>();
    pending.set(id, { command: record.type, deferred });
    return yield* rawSend({ ...record, id }).pipe(
      Effect.andThen(Effect.raceFirst(Deferred.await(deferred), Deferred.await(down))),
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () => Effect.fail(new OmpRpcTimeoutError({ operation: record.type, timeoutMs })),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          pending.delete(id);
        }),
      ),
    );
  });
  // Streaming records are already inside the connection span; do not allocate a span per delta.
  const route = Effect.fnUntraced(function* (record: OmpRpcRecord) {
    if (record.type === "ready") {
      yield* Deferred.succeed(ready, undefined);
      return;
    }
    if (record.type === "response" && typeof record.id === "string") {
      const entry = pending.get(record.id);
      if (entry) {
        if (record.command !== entry.command)
          return yield* new OmpRpcError({
            operation: "read",
            detail: "response command does not match its request ID",
          });
        pending.delete(record.id);
        if (record.success === true) {
          if (entry.command === "negotiate_protocol") {
            if (
              typeof record.data !== "object" ||
              record.data === null ||
              !("protocolVersion" in record.data) ||
              record.data.protocolVersion !== 2
            )
              return yield* new OmpRpcError({
                operation: "negotiate",
                detail: "OMP did not accept v2",
              });
            decoder.enableV2();
          }
          yield* Deferred.succeed(entry.deferred, record.data);
        } else
          yield* Deferred.fail(
            entry.deferred,
            new OmpRpcError({
              operation: entry.command,
              detail:
                typeof record.error === "string"
                  ? record.error.slice(0, 200)
                  : "native request failed",
            }),
          );
        return;
      }
    }
    if (record.type === "extension_ui_request" && options.onUiRequest) {
      const send = (answer: OmpRpcRecord) =>
        answer.type === "extension_ui_response" && answer.id === record.id
          ? rawSend(answer)
          : Effect.fail(
              new OmpRpcError({
                operation: "startup UI",
                detail: "invalid UI response correlation",
              }),
            );
      yield* options.onUiRequest(record, send).pipe(
        Effect.catchCause((cause) => failTransport(new OmpRpcError({ operation: "UI", cause }))),
        Effect.forkIn(scope),
      );
    }
    if (!(yield* Queue.offer(events, record)))
      return yield* new OmpRpcError({
        operation: "read",
        detail: "event queue budget exceeded; required frame delivery failed",
      });
  });
  let logicalExitReceived = false;
  let terminalReceived = false;
  let stdoutProcessed = 0;
  let exitTarget: number | undefined;
  const stdoutBarrier = yield* Deferred.make<void>();
  const finishExit = Effect.fn("OmpRpc.finishExit")(function* (
    code: number | null,
    signal: string | null,
    requiredBytes: number,
    error?: string,
    kind: "exit" | "stdout_end" | "stdout_error" = "exit",
  ) {
    if (kind === "exit" && logicalExitReceived)
      return yield* new OmpRpcError({ operation: "read", detail: "duplicate process exit record" });
    if (kind === "exit") logicalExitReceived = true;
    if (terminalReceived) {
      if (kind !== "exit" || requiredBytes !== exitTarget)
        return yield* new OmpRpcError({
          operation: "read",
          detail: "invalid repeated output status",
        });
      if (code !== null) yield* Deferred.succeed(exit, code);
      else
        yield* Deferred.fail(
          exit,
          new OmpRpcError({
            operation: "exit",
            detail: signal ?? error ?? "native process failed",
          }),
        );
      return;
    }
    terminalReceived = true;
    diagnosing = true;
    exitTarget = requiredBytes;
    if (stdoutProcessed >= requiredBytes) yield* Deferred.succeed(stdoutBarrier, undefined);
    yield* Deferred.await(stdoutBarrier);
    const validated = yield* Effect.try({
      try: () => decoder.end(),
      catch: (cause) =>
        new OmpRpcError({ operation: "read", detail: "incomplete final native frame", cause }),
    }).pipe(Effect.exit);
    const frameError = Exit.isFailure(validated)
      ? new OmpRpcError({
          operation: "read",
          detail: "incomplete final native frame",
          cause: validated.cause,
        })
      : undefined;
    const failure =
      frameError ??
      new OmpRpcError({
        operation: "read",
        detail:
          kind !== "exit"
            ? `OMP ${kind === "stdout_error" ? "stdout failed" : "closed stdout"} before process exit was observed; stderr ${stderrBytes} bytes`
            : `OMP ${code === null ? `exited by ${signal ?? error ?? "unknown error"}` : `exited with code ${code}`}; stderr ${stderrBytes} bytes`,
      });
    yield* failTransport(failure);
    if (kind !== "exit") return;
    if (code !== null) yield* Deferred.succeed(exit, code);
    else
      yield* Deferred.fail(
        exit,
        new OmpRpcError({ operation: "exit", detail: signal ?? error ?? "native process failed" }),
      );
  });
  yield* child.exitCode.pipe(
    Effect.matchEffect({
      onSuccess: (code) =>
        Effect.sync(() => {
          supervisorExited = true;
        }).pipe(Effect.andThen(Deferred.succeed(supervisorExit, Number(code)))),
      onFailure: (cause) =>
        Effect.sync(() => {
          supervisorExited = true;
        }).pipe(
          Effect.andThen(
            Deferred.fail(supervisorExit, new OmpRpcError({ operation: "exit", cause })),
          ),
        ),
    }),
    Effect.forkIn(scope),
  );
  if (supervised) {
    yield* Effect.gen(function* () {
      let buffer = "";
      yield* child.getOutputFd(3).pipe(
        Stream.decodeText(),
        Stream.runForEach((text) =>
          Effect.gen(function* () {
            buffer += text;
            if (buffer.length > 4096)
              return yield* new OmpRpcError({
                operation: "read",
                detail: "invalid supervisor status size",
              });
            for (;;) {
              const newline = buffer.indexOf("\n");
              if (newline < 0) return;
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              const value = yield* decodeSupervisorExit(line).pipe(
                Effect.mapError(
                  (cause) =>
                    new OmpRpcError({
                      operation: "read",
                      detail: "invalid supervisor exit record",
                      cause,
                    }),
                ),
              );
              yield* finishExit(
                value.code,
                value.signal,
                value.stdoutBytes,
                value.error,
                value.type,
              );
            }
          }),
        ),
      );
      const status = yield* Deferred.await(supervisorExit).pipe(Effect.exit);
      if (!logicalExitReceived) {
        const detail = Exit.isSuccess(status)
          ? `supervisor exited with code ${status.value} without reporting the logical child exit`
          : "supervisor exited without reporting the logical child exit";
        yield* failTransport(new OmpRpcError({ operation: "read", detail }));
        yield* Deferred.fail(exit, new OmpRpcError({ operation: "exit", detail }));
      }
    }).pipe(
      Effect.catchCause((cause) =>
        failTransport(
          new OmpRpcError({ operation: "read", cause, detail: "supervisor status failed" }),
        ),
      ),
      Effect.forkIn(scope),
    );
  } else {
    yield* Deferred.await(supervisorExit).pipe(
      Effect.exit,
      Effect.flatMap((status) =>
        Effect.sleep(Duration.millis(500)).pipe(
          Effect.andThen(
            finishExit(
              Exit.isSuccess(status) ? status.value : null,
              null,
              stdoutProcessed,
              Exit.isFailure(status) ? "process exited by signal" : undefined,
            ),
          ),
        ),
      ),
      Effect.forkIn(scope),
    );
  }
  yield* child.stderr.pipe(
    Stream.runForEach((bytes) =>
      Effect.sync(() => {
        stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + bytes.length);
      }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );
  yield* Effect.gen(function* () {
    yield* child.stdout.pipe(
      Stream.runForEach((bytes) =>
        Effect.gen(function* () {
          const frames = decoder.push(bytes);
          for (;;) {
            const item = yield* Effect.try({
              try: () => frames.next(),
              catch: (cause) =>
                new OmpRpcError({
                  operation: "decode",
                  cause,
                  detail: cause instanceof Error ? cause.message : "invalid native frame",
                }),
            });
            if (item.done) break;
            yield* route(item.value);
          }
          stdoutProcessed += bytes.length;
          if (exitTarget !== undefined && stdoutProcessed >= exitTarget)
            yield* Deferred.succeed(stdoutBarrier, undefined);
        }),
      ),
    );
    yield* Effect.try({
      try: () => decoder.end(),
      catch: (cause) =>
        new OmpRpcError({ operation: "read", detail: "incomplete native frame", cause }),
    });
    if (supervised) {
      if (exitTarget !== undefined && stdoutProcessed < exitTarget)
        return yield* new OmpRpcError({
          operation: "read",
          detail: "supervisor exit byte barrier was not delivered",
        });
      const failed = yield* Deferred.await(down).pipe(
        Effect.exit,
        Effect.timeoutOption(Duration.millis(250)),
        Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
      );
      if (Option.isNone(failed))
        return yield* new OmpRpcError({
          operation: "read",
          detail: "supervisor stdout closed before logical exit was observed",
        });
      return;
    }
    diagnosing = true;
    const code = yield* Deferred.await(exit).pipe(
      Effect.timeoutOption(Duration.millis(250)),
      Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
      Effect.orElseSucceed(() => Option.none<number>()),
    );
    return yield* new OmpRpcError({
      operation: "read",
      detail: `OMP ${Option.isSome(code) ? `exited with code ${code.value}` : "closed stdout"}; stderr ${stderrBytes} bytes`,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      failTransport(new OmpRpcError({ operation: "read", cause, detail: String(cause) })),
    ),
    Effect.forkIn(scope),
  );
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.flatMap((frames) => Stream.fromIterable(frames)),
    Stream.run(child.stdin),
    Effect.catchCause((cause) =>
      diagnosing ? Effect.void : failTransport(new OmpRpcError({ operation: "write", cause })),
    ),
    Effect.forkIn(scope),
  );
  const setup = Effect.gen(function* () {
    yield* Deferred.await(ready);
    yield* options.guardReady;
    yield* rawRequest({ type: "negotiate_protocol", protocolVersion: 2 });
    const projection = yield* rawRequest({
      type: "set_event_filter",
      events: null,
      messageUpdates: "delta",
    });
    if (
      typeof projection !== "object" ||
      projection === null ||
      !("messageUpdates" in projection) ||
      projection.messageUpdates !== "delta"
    )
      return yield* new OmpRpcError({
        operation: "negotiate",
        detail: "OMP did not accept delta-only updates",
      });
  });
  yield* Effect.raceFirst(setup, Deferred.await(down)).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(options.setupTimeoutMs ?? 60000),
      orElse: () =>
        Effect.fail(
          new OmpRpcTimeoutError({
            operation: "startup",
            timeoutMs: options.setupTimeoutMs ?? 60000,
          }),
        ),
    }),
  );
  const publicRecord = (record: OmpRpcRecord) =>
    !["negotiate_protocol", "set_event_filter"].includes(record.type);
  return {
    send: (record: OmpRpcRecord) =>
      publicRecord(record)
        ? rawSend(record)
        : Effect.fail(
            new OmpRpcError({ operation: "send", detail: "transport controls are owned by T3" }),
          ),
    request: (record: OmpRpcRecord, timeout?: number) =>
      publicRecord(record)
        ? rawRequest(record, timeout)
        : Effect.fail(
            new OmpRpcError({ operation: "request", detail: "transport controls are owned by T3" }),
          ),
    events,
    exited: Deferred.await(exit),
    terminate: failTransport(
      new OmpRpcError({ operation: "terminate", detail: "OMP process stopped" }),
    ).pipe(Effect.andThen(terminateProcess), Effect.ignore, Effect.uninterruptible),
    diagnostics: () => ({ stderrBytes }),
  } satisfies OmpRpcConnection;
});
export const makeOmpRpcConnection = Effect.fn("OmpRpc.makeConnection")(function* (
  options: OmpRpcSpawnOptions,
) {
  const scope = yield* Scope.fork(yield* Effect.scope);
  const connection = yield* buildConnection(options).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.onExit((result) => (Exit.isFailure(result) ? Scope.close(scope, result) : Effect.void)),
  );
  return { ...connection, terminate: Scope.close(scope, Exit.void) };
});
