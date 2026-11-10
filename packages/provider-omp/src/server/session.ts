// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { createControlServer, type ControlEnvelope } from "./controlChannel.ts";
import { buildOmpRpcLaunch, materializeOmpRuntimeAssets } from "./launch.ts";
import { ownedPolicyManifest, type RuntimeConfig } from "./runtimeOptions.ts";
import { normalizeOmpMode } from "./policy.ts";
import { makeOmpRpcConnection, OmpRpcError, type OmpRpcSpawnOptions } from "./rpc.ts";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export interface OmpSessionOptions {
  binaryPath?: string;
  bunPath?: string;
  launchArgs: string;
  env: NodeJS.ProcessEnv;
  cacheDir: string;
  config: Omit<RuntimeConfig, "credentialPath" | "providerSession">;
  onUiRequest?: OmpRpcSpawnOptions["onUiRequest"];
  setupTimeoutMs?: number;
}
const openSession = Effect.fn("Omp.openSession")(function* (options: OmpSessionOptions) {
  const providerSession = NodeCrypto.randomUUID();
  const expectedMode = yield* Effect.try({
    try: () => normalizeOmpMode(options.config.mode).mode,
    catch: (cause) => new OmpRpcError({ operation: "policy", cause }),
  });
  const ready = yield* Deferred.make<void, OmpRpcError>();
  const invalidated = yield* Deferred.make<never, OmpRpcError>();
  const controls = yield* Queue.dropping<ControlEnvelope, OmpRpcError>(256);
  let epoch: string | undefined;
  let closed = false;
  let shuttingDown = false;
  const nativeClosed = yield* Deferred.make<void>();
  let failed = false;
  let reply: ((frame: ControlEnvelope) => void) | undefined;
  const approvals = new Set<string>();
  const fail = (detail: string) => {
    if (failed) return;
    failed = true;
    approvals.clear();
    reply = undefined;
    const error = new OmpRpcError({ operation: "policy", detail });
    Deferred.doneUnsafe(ready, Effect.fail(error));
    Deferred.doneUnsafe(invalidated, Effect.fail(error));
    Queue.failCauseUnsafe(controls, Cause.fail(error));
  };
  yield* Effect.addFinalizer(() => Effect.sync(() => fail("session closed")));
  const control = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        createControlServer(
          (frame, send) => {
            if (failed) return;
            if (frame.providerSession !== providerSession) {
              fail("control provider session mismatch");
              return;
            }
            if (frame.type === "ready") {
              if (epoch || frame.payload.mode !== expectedMode) {
                fail("control ready/mode mismatch");
                return;
              }
              epoch = frame.epoch;
              reply = send;
              Deferred.doneUnsafe(ready, Effect.void);
              return;
            }
            if (!epoch || frame.epoch !== epoch) {
              fail("control epoch mismatch");
              return;
            }
            if (shuttingDown && frame.type === "invalidate") return;
            if (frame.type === "approval_request") {
              if (approvals.has(frame.id)) {
                fail("duplicate native approval ID");
                return;
              }
              approvals.add(frame.id);
              if (!Queue.offerUnsafe(controls, frame)) fail("policy control queue budget exceeded");
            } else fail("native policy invalidated or unexpected control direction");
          },
          () => {
            if (shuttingDown) Deferred.doneUnsafe(nativeClosed, Effect.void);
            else if (!closed) fail("private control disconnected");
          },
        ),
      catch: (cause) => new OmpRpcError({ operation: "control", cause }),
    }),
    (server) =>
      Effect.promise(async () => {
        closed = true;
        await server.close();
      }),
  );
  const dir = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-omp-session-")),
      catch: (cause) => new OmpRpcError({ operation: "config", cause }),
    }),
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
  const assets = yield* materializeOmpRuntimeAssets(options.cacheDir).pipe(
    Effect.mapError((cause) => new OmpRpcError({ operation: "assets", cause })),
  );
  const configPath = NodePath.join(dir, "runtime.json");
  const configJson = yield* encodeJson({
    ...options.config,
    providerSession,
    credentialPath: control.credentialPath,
    policyManifest: ownedPolicyManifest,
  }).pipe(Effect.mapError((cause) => new OmpRpcError({ operation: "config", cause })));
  yield* Effect.tryPromise({
    try: () => NodeFSP.writeFile(configPath, configJson, { mode: 0o600, flag: "wx" }),
    catch: (cause) => new OmpRpcError({ operation: "config", cause }),
  });
  const launch = yield* Effect.try({
    try: () =>
      buildOmpRpcLaunch({
        ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
        ...(options.bunPath ? { bunPath: options.bunPath } : {}),
        launchArgs: options.launchArgs,
        env: options.env,
        assets,
        runtimeConfigPath: configPath,
      }),
    catch: (cause) => new OmpRpcError({ operation: "launch", cause }),
  });
  const connection = yield* makeOmpRpcConnection({
    ...launch,
    supervisorRuntime: { command: launch.command, args: ["--no-env-file", launch.args[1]!] },
    cwd: options.config.cwd,
    guardReady: Deferred.await(ready),
    invalidated: Deferred.await(invalidated),
    ...(options.onUiRequest ? { onUiRequest: options.onUiRequest } : {}),
    ...(options.setupTimeoutMs === undefined ? {} : { setupTimeoutMs: options.setupTimeoutMs }),
  });
  const sendControl = Effect.fn("Omp.sendControl")(function* (frame: ControlEnvelope) {
    if (
      shuttingDown ||
      !reply ||
      frame.providerSession !== providerSession ||
      frame.epoch !== epoch ||
      frame.type !== "approval_answer" ||
      !["once", "deny"].includes(frame.answer) ||
      !approvals.delete(frame.id)
    )
      return yield* new OmpRpcError({
        operation: "control",
        detail: "invalid, stale or consumed native approval answer",
      });
    yield* Effect.try({
      try: () => reply!(frame),
      catch: (cause) => new OmpRpcError({ operation: "control", cause }),
    });
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (epoch && reply)
        try {
          reply({ v: 1, type: "cancel", providerSession, epoch, id: NodeCrypto.randomUUID() });
        } catch {}
    }),
  );
  const shutdown = Effect.fn("Omp.shutdown")(function* () {
    if (shuttingDown) return;
    shuttingDown = true;
    approvals.clear();
    if (epoch && reply) {
      yield* Effect.try({
        try: () =>
          reply!({
            v: 1,
            type: "cancel",
            providerSession,
            epoch: epoch!,
            id: NodeCrypto.randomUUID(),
          }),
        catch: (cause) => new OmpRpcError({ operation: "shutdown", cause }),
      }).pipe(Effect.ignore);
      yield* Deferred.await(nativeClosed).pipe(Effect.timeoutOption("3 seconds"));
    }
  });
  return { ...connection, controls, sendControl, providerSession, policyEpoch: epoch!, shutdown };
});
export const makeOmpProviderSession = Effect.fn("Omp.makeProviderSession")(function* (
  options: OmpSessionOptions,
) {
  const scope = yield* Scope.fork(yield* Effect.scope);
  const connection = yield* openSession(options).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.onExit((result) => (Exit.isFailure(result) ? Scope.close(scope, result) : Effect.void)),
  );
  return {
    ...connection,
    terminate: connection
      .shutdown()
      .pipe(Effect.ensuring(Scope.close(scope, Exit.void)), Effect.uninterruptible),
  };
});
