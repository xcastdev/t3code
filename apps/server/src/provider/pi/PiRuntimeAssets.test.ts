import * as NodeOS from "node:os";
import * as Crypto from "effect/Crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { HostProcessPlatform, HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import { afterEach, beforeEach, describe, expect } from "vite-plus/test";
import { decodePiWorkerLaunch } from "./PiWorkerEntrypoint.ts";
import { preparePiRuntimeAssets } from "./PiRuntimeAssets.ts";

// Fixtures replace inodes and directory names using actual native filesystem handles.
const NodeFS = process.getBuiltinModule("fs");
const NodeFSP = NodeFS.promises;
const drainEvidenceDirectory = process.env.PI_RUNTIME_ASSETS_DRAIN_EVIDENCE_DIRECTORY;
const encodeDrainObservation = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      mode: Schema.String,
      childPid: Schema.Int,
      readySeen: Schema.Boolean,
      sigtermReceived: Schema.Boolean,
      stdoutReaderJoined: Schema.Boolean,
      stderrReaderJoined: Schema.Boolean,
      manualKillRequired: Schema.Boolean,
      failureOnly: Schema.Boolean,
      childAbsent: Schema.Boolean,
      stageEmpty: Schema.Boolean,
      forceKillAfter: Schema.NullOr(Schema.String),
      producerCompletionBeforeTerminalExit: Schema.Boolean,
      terminalExitObserved: Schema.Boolean,
      elapsedMillis: Schema.Finite,
    }),
  ),
);
const fixturePath = (...parts: ReadonlyArray<string>) => parts.join("/");
let scratch = "";
let input: Parameters<typeof preparePiRuntimeAssets>[0];
beforeEach(async () => {
  scratch = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(fixturePath(NodeOS.tmpdir(), "pi-assets-")),
  );
  const distributionDirectory = fixturePath(scratch, "dist");
  const stagingDirectory = fixturePath(scratch, "stage");
  await Promise.all([
    NodeFSP.mkdir(distributionDirectory),
    NodeFSP.mkdir(stagingDirectory),
    NodeFSP.mkdir(fixturePath(scratch, "protected")),
  ]);
  await NodeFSP.mkdir(fixturePath(distributionDirectory, "pi-sdk"));
  await NodeFSP.writeFile(
    fixturePath(distributionDirectory, "pi-sdk/package.json"),
    '{"name":"@earendil-works/pi-coding-agent","version":"0.99.1"}',
  );
  await NodeFSP.writeFile(
    fixturePath(distributionDirectory, "pi-worker.mjs"),
    "export const worker = true;\n",
  );
  input = {
    distributionDirectory,
    stagingDirectory,
    protectedRoots: [fixturePath(scratch, "protected")],
  };
});
afterEach(async () => {
  // Only the fixture's original captured directory is ours to remove.
  await NodeFSP.chmod(input.stagingDirectory, 0o700).catch(() => undefined);
  await NodeFSP.rm(scratch, { recursive: true, force: true });
});
const check = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, NodeServices.NodeServices>,
  timeout?: number,
) => it.live(name, () => body().pipe(Effect.provide(NodeServices.layer)), timeout);
const beforeDiscovery = Effect.fn("assetsTest.beforeDiscovery")(function* (value = input) {
  let discoveries = 0;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const error = yield* preparePiRuntimeAssets(value).pipe(
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.ChildProcessSpawner.of({
        ...spawner,
        spawn: () => {
          discoveries++;
          return Effect.die("unexpected process discovery");
        },
      }),
    ),
    Effect.flip,
  );
  expect(error.phase).toBe("validation");
  expect(discoveries).toBe(0);
  return error;
});

describe("Pi runtime assets refuse unsafe inputs before discovery", () => {
  for (const platform of ["darwin", "win32"] as const)
    check(`reports ${platform} unavailable`, () =>
      Effect.gen(function* () {
        const error = yield* preparePiRuntimeAssets(input).pipe(
          Effect.provideService(HostProcessPlatform, platform),
          Effect.flip,
        );
        expect(error.phase).toBe("unavailable");
      }),
    );
  check("rejects a nonempty stage without changing foreign bytes", () =>
    Effect.gen(function* () {
      const file = fixturePath(input.stagingDirectory, "foreign");
      yield* Effect.promise(() => NodeFSP.writeFile(file, "keep"));
      yield* beforeDiscovery();
      expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe("keep");
    }),
  );
  check("rejects distribution/staging and protected overlap", () =>
    Effect.gen(function* () {
      yield* beforeDiscovery({ ...input, stagingDirectory: input.distributionDirectory });
      yield* beforeDiscovery({ ...input, protectedRoots: [scratch] });
      yield* beforeDiscovery({ ...input, protectedRoots: [] });
    }),
  );
  check("rejects traversal and relative inputs", () =>
    Effect.gen(function* () {
      yield* beforeDiscovery({ ...input, distributionDirectory: "relative" });
      yield* beforeDiscovery({ ...input, stagingDirectory: input.stagingDirectory + "/../stage" });
    }),
  );
  check("rejects symlinked stage and bundle directory", () =>
    Effect.gen(function* () {
      const alias = fixturePath(scratch, "alias");
      yield* Effect.promise(() => NodeFSP.symlink(input.stagingDirectory, alias));
      yield* beforeDiscovery({ ...input, stagingDirectory: alias });
      yield* Effect.promise(() => NodeFSP.unlink(alias));
      yield* Effect.promise(() => NodeFSP.symlink(input.distributionDirectory, alias));
      yield* beforeDiscovery({ ...input, distributionDirectory: alias });
    }),
  );
  for (const contents of [
    '{"name":"wrong","version":"0.99.1"}',
    '{"name":"@earendil-works/pi-coding-agent","version":"0.99.2"}',
    "{bad",
    " ".repeat(65537),
  ])
    check(`rejects invalid SDK metadata ${contents.length}`, () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            fixturePath(input.distributionDirectory, "pi-sdk/package.json"),
            contents,
          ),
        );
        yield* beforeDiscovery();
      }),
    );
  check("rejects a symlinked MJS, metadata, or nested metadata directory", () =>
    Effect.gen(function* () {
      const worker = fixturePath(input.distributionDirectory, "pi-worker.mjs");
      const other = fixturePath(scratch, "other");
      yield* Effect.promise(() => NodeFSP.writeFile(other, "foreign"));
      yield* Effect.promise(() => NodeFSP.unlink(worker));
      yield* Effect.promise(() => NodeFSP.symlink(other, worker));
      yield* beforeDiscovery();
      yield* Effect.promise(() => NodeFSP.unlink(worker));
      yield* Effect.promise(() => NodeFSP.writeFile(worker, "worker"));
      const metadata = fixturePath(input.distributionDirectory, "pi-sdk/package.json");
      yield* Effect.promise(() => NodeFSP.unlink(metadata));
      yield* Effect.promise(() => NodeFSP.symlink(other, metadata));
      yield* beforeDiscovery();
    }),
  );
  check("rejects a directory named MJS and a missing worker", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.mkdir(fixturePath(input.distributionDirectory, "bad.mjs")),
      );
      yield* beforeDiscovery();
      yield* Effect.promise(() =>
        NodeFSP.rmdir(fixturePath(input.distributionDirectory, "bad.mjs")),
      );
      yield* Effect.promise(() =>
        NodeFSP.unlink(fixturePath(input.distributionDirectory, "pi-worker.mjs")),
      );
      yield* beforeDiscovery();
    }),
  );
  check("bounds flat enumeration even when excess entries are not MJS", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 513 }, (_, i) =>
            NodeFSP.writeFile(fixturePath(input.distributionDirectory, `${i}.map`), ""),
          ),
        ),
      );
      yield* beforeDiscovery();
    }),
  );
  check("rejects more than 96 MJS and a sparse file over the total byte bound", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 96 }, (_, i) =>
            NodeFSP.writeFile(fixturePath(input.distributionDirectory, `${i}.mjs`), ""),
          ),
        ),
      );
      yield* beforeDiscovery();
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 96 }, (_, i) =>
            NodeFSP.unlink(fixturePath(input.distributionDirectory, `${i}.mjs`)),
          ),
        ),
      );
      yield* Effect.promise(async () => {
        const file = await NodeFSP.open(fixturePath(input.distributionDirectory, "huge.mjs"), "wx");
        try {
          await file.truncate(256 * 1024 * 1024 + 1);
        } finally {
          await file.close();
        }
      });
      yield* beforeDiscovery();
    }),
  );
});

// This required gate is separately selected. Missing Linux/proc/ldd/ELF prerequisites fail.
const native: typeof check = (name, body, timeout) =>
  process.env.PI_RUNTIME_ASSETS_LINUX_GATE === "1"
    ? check(name, body, timeout)
    : it.skip(name, () => {});
describe("required actual Linux executable closure", () => {
  for (const mode of ["cancellation", "deadline"] as const)
    native(
      `drains SIGTERM-ignoring discovery on ${mode}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis;
            const ready = yield* Deferred.make<void>();
            const stdoutJoined = yield* Deferred.make<void>();
            const stderrJoined = yield* Deferred.make<void>();
            const signalFile = fixturePath(scratch, "sigterm-receipt");
            yield* Effect.promise(() => NodeFSP.writeFile(signalFile, ""));
            // This separate native receipt remains observable after product stream cancellation.
            let watcher: ReturnType<typeof NodeFS.watch> | undefined;
            const signalReceived = new Promise<void>((resolve, reject) => {
              watcher = NodeFS.watch(signalFile, { persistent: false }, () => {
                NodeFSP.readFile(signalFile, "utf8").then((value) => {
                  if (value === "SIGTERM") resolve();
                }, reject);
              });
              watcher.on("error", reject);
            });
            yield* Effect.addFinalizer(() => Effect.sync(() => watcher?.close()));
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            let captured: ChildProcessSpawner.ChildProcessHandle | undefined;
            let forceKillAfter: string | null = null;
            const childCode =
              'const fs=require("node:fs");process.on("SIGTERM",()=>fs.writeFileSync(process.argv[1],"SIGTERM"));process.stdout.write("ready\\n");setInterval(()=>{},1000)';
            const fiber = yield* preparePiRuntimeAssets(input).pipe(
              Effect.provideService(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.ChildProcessSpawner.of({
                  ...spawner,
                  spawn: (command) =>
                    Effect.gen(function* () {
                      if (command._tag !== "StandardCommand")
                        return yield* Effect.die("unexpected discovery pipeline");
                      expect(command.command).toBe("/usr/bin/ldd");
                      expect(command.options.extendEnv).toBe(false);
                      expect(command.options.shell).toBeUndefined();
                      forceKillAfter =
                        typeof command.options.forceKillAfter === "string"
                          ? command.options.forceKillAfter
                          : null;
                      const child = yield* spawner.spawn(
                        ChildProcess.make(
                          process.execPath,
                          ["--max-old-space-size=512", "-e", childCode, signalFile],
                          command.options,
                        ),
                      );
                      captured = child;
                      let readiness = "";
                      return {
                        ...child,
                        stdout: child.stdout.pipe(
                          Stream.tap((chunk) =>
                            Effect.gen(function* () {
                              readiness += Buffer.from(chunk).toString("utf8");
                              if (readiness === "ready\n")
                                yield* Deferred.succeed(ready, undefined);
                            }),
                          ),
                          Stream.ensuring(Deferred.succeed(stdoutJoined, undefined)),
                        ),
                        stderr: child.stderr.pipe(
                          Stream.ensuring(Deferred.succeed(stderrJoined, undefined)),
                        ),
                      };
                    }),
                }),
              ),
              Effect.forkChild,
            );
            yield* Deferred.await(ready).pipe(Effect.timeout("3 seconds"));
            const child = captured;
            if (!child) return yield* Effect.die("missing captured discovery child");
            const stopping =
              mode === "cancellation"
                ? yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
                : undefined;
            yield* Effect.promise(() => signalReceived).pipe(
              Effect.timeout(mode === "cancellation" ? "3 seconds" : "8 seconds"),
            );
            const completed = stopping
              ? yield* Fiber.await(stopping).pipe(
                  Effect.timeoutOption("1 second"),
                  Effect.map(Option.isSome),
                )
              : yield* Fiber.await(fiber).pipe(
                  Effect.timeoutOption("1 second"),
                  Effect.map(Option.isSome),
                );
            const manualKillRequired = !completed;
            // Only a failing old-source control needs this captured-handle cleanup.
            if (manualKillRequired) yield* child.kill({ killSignal: "SIGKILL" });
            if (stopping) yield* Fiber.join(stopping);
            const completion = yield* Fiber.await(fiber);
            const producerCompletionBeforeTerminalExit = yield* child.isRunning;
            const terminalExit = yield* child.exitCode.pipe(Effect.exit);
            yield* Deferred.await(stdoutJoined);
            yield* Deferred.await(stderrJoined);
            yield* Effect.promise(() =>
              expect(NodeFSP.access(`/proc/${child.pid}`)).rejects.toMatchObject({
                code: "ENOENT",
              }),
            );
            const entries = yield* Effect.promise(() => NodeFSP.readdir(input.stagingDirectory));
            const observation = {
              mode,
              childPid: Number(child.pid),
              readySeen: true,
              sigtermReceived: true,
              stdoutReaderJoined: true,
              stderrReaderJoined: true,
              manualKillRequired,
              failureOnly: Exit.isFailure(completion),
              childAbsent: true,
              stageEmpty: entries.length === 0,
              forceKillAfter,
              producerCompletionBeforeTerminalExit,
              terminalExitObserved: Exit.isFailure(terminalExit),
              elapsedMillis: (yield* Clock.currentTimeMillis) - started,
            };
            if (drainEvidenceDirectory) {
              const json = yield* encodeDrainObservation(observation);
              yield* Effect.promise(() =>
                NodeFSP.writeFile(fixturePath(drainEvidenceDirectory, `${mode}.json`), json),
              );
            }
            expect(manualKillRequired).toBe(false);
            expect(Exit.isFailure(completion)).toBe(true);
            expect(entries).toEqual([]);
            if (Exit.isFailure(completion)) {
              if (mode === "cancellation") expect(Cause.hasInterrupts(completion.cause)).toBe(true);
              else
                expect(Cause.findErrorOption(completion.cause)).toMatchObject({
                  _tag: "Some",
                  value: { phase: "unavailable" },
                });
            }
          }),
        ),
      10000,
    );
  native("rejects a source inode replacement after its bounded read", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      let replaced = false;
      const worker = fixturePath(input.distributionDirectory, "pi-worker.mjs");
      const error = yield* preparePiRuntimeAssets(input).pipe(
        Effect.provideService(
          Crypto.Crypto,
          Crypto.Crypto.of({
            ...crypto,
            digest: (algorithm, bytes) =>
              Effect.gen(function* () {
                if (!replaced) {
                  replaced = true;
                  yield* Effect.promise(async () => {
                    const original = await NodeFSP.readFile(worker);
                    await NodeFSP.rename(worker, worker + "-original");
                    await NodeFSP.writeFile(worker, original);
                  });
                }
                return yield* crypto.digest(algorithm, bytes);
              }),
          }),
        ),
        Effect.flip,
      );
      expect(replaced).toBe(true);
      expect(error.phase).toBe("validation");
    }),
  );
  native("rejects replacement before the first write without touching the foreign stage", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      let replaced = false;
      const error = yield* preparePiRuntimeAssets(input).pipe(
        Effect.provideService(
          Crypto.Crypto,
          Crypto.Crypto.of({
            ...crypto,
            digest: (algorithm, bytes) =>
              Effect.gen(function* () {
                if (!replaced) {
                  replaced = true;
                  yield* Effect.promise(async () => {
                    await NodeFSP.rename(
                      input.stagingDirectory,
                      input.stagingDirectory + "-original",
                    );
                    await NodeFSP.mkdir(input.stagingDirectory);
                    await NodeFSP.writeFile(
                      fixturePath(input.stagingDirectory, "foreign"),
                      "retain",
                    );
                  });
                }
                return yield* crypto.digest(algorithm, bytes);
              }),
          }),
        ),
        Effect.flip,
      );
      expect(error.phase).toBe("validation");
      expect(yield* Effect.promise(() => NodeFSP.readdir(input.stagingDirectory))).toEqual([
        "foreign",
      ]);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(fixturePath(input.stagingDirectory, "foreign"), "utf8"),
        ),
      ).toBe("retain");
    }),
  );
  native("drains stdout, stderr and nonzero exit without creating a staged closure", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const captured: number[] = [];
      const error = yield* preparePiRuntimeAssets(input).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.ChildProcessSpawner.of({
            ...spawner,
            spawn: () =>
              Effect.gen(function* () {
                const child = yield* spawner.spawn(
                  ChildProcess.make(
                    process.execPath,
                    [
                      "--max-old-space-size=512",
                      "-e",
                      'process.stdout.write("x".repeat(70000));process.stderr.write("y".repeat(70000));process.exitCode=9',
                    ],
                    { env: {}, extendEnv: false, stdin: "ignore" },
                  ),
                );
                captured.push(Number(child.pid));
                return child;
              }),
          }),
        ),
        Effect.flip,
      );
      expect(error.phase).toBe("unavailable");
      expect(captured).toHaveLength(1);
      expect(yield* Effect.promise(() => NodeFSP.readdir(input.stagingDirectory))).toEqual([]);
      for (const pid of captured)
        yield* Effect.promise(() =>
          expect(NodeFSP.access(`/proc/${pid}`)).rejects.toMatchObject({ code: "ENOENT" }),
        );
    }),
  );
  native(
    "copies exact flat bundles, pinned metadata and actual ELF closure with readonly executable modes",
    () =>
      Effect.gen(function* () {
        expect(yield* HostProcessPlatform).toBe("linux");
        yield* Effect.promise(() => NodeFSP.access("/proc/self/fd"));
        yield* Effect.promise(() => NodeFSP.access("/usr/bin/ldd", 1));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            fixturePath(input.distributionDirectory, "extra.mjs"),
            "export const extra = 42;\n",
          ),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            fixturePath(input.distributionDirectory, "ignored.mjs.map"),
            "secret-map",
          ),
        );
        yield* Effect.promise(() =>
          NodeFSP.mkdir(fixturePath(input.distributionDirectory, "nested")),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            fixturePath(input.distributionDirectory, "nested/ambient.mjs"),
            "not-flat",
          ),
        );
        const result = yield* preparePiRuntimeAssets({
          ...input,
          protectedRoots: [input.distributionDirectory],
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.runtimeFiles)).toBe(true);
        const mounted = new Map(result.runtimeFiles.map((file) => [file.target, file.source]));
        expect(mounted.has("/runtime/dist/extra.mjs")).toBe(true);
        expect(
          [...mounted.keys()].some(
            (target) => target.includes("ignored") || target.includes("ambient"),
          ),
        ).toBe(false);
        for (const file of result.runtimeFiles) {
          expect(Object.isFrozen(file)).toBe(true);
          expect(file.source.startsWith(input.stagingDirectory + "/")).toBe(true);
          const stat = yield* Effect.promise(() => NodeFSP.lstat(file.source));
          expect(stat.isFile()).toBe(true);
          expect(stat.mode & 0o222).toBe(0);
        }
        const node = mounted.get("/runtime/node")!;
        expect((yield* Effect.promise(() => NodeFSP.stat(node))).mode & 0o111).toBe(
          (yield* Effect.promise(() => NodeFSP.stat(process.execPath))).mode & 0o111,
        );
        const crypto = yield* Crypto.Crypto;
        const staged = yield* Effect.promise(() => NodeFSP.readFile(node));
        const original = yield* Effect.promise(() => NodeFSP.readFile(process.execPath));
        expect(Buffer.from(yield* crypto.digest("SHA-256", staged)).toString("hex")).toBe(
          Buffer.from(yield* crypto.digest("SHA-256", original)).toString("hex"),
        );
        const argv = result.workerArgv(
          { workerId: "worker", generation: 1 },
          { operationId: "operation", operationKind: "initialize" },
          "/state/sessions",
        );
        expect(argv.slice(0, 3)).toEqual([
          "/runtime/node",
          "--max-old-space-size=512",
          "/runtime/dist/pi-worker.mjs",
        ]);
        expect(decodePiWorkerLaunch(argv[3])).toMatchObject({
          sessionDirectory: "/state/sessions",
          trustedSdkPackageDirectory: "/runtime/dist/pi-sdk",
        });
        expect(() =>
          result.workerArgv(
            { workerId: "worker", generation: 1 },
            { operationId: "operation", operationKind: "initialize" },
            "/host/state",
          ),
        ).toThrow();
        yield* result.revalidate;
        yield* Effect.promise(() => NodeFSP.chmod(node, 0o755));
        expect((yield* result.revalidate.pipe(Effect.flip)).phase).toBe("validation");
      }),
  );
  native("rejects a replaced staging directory without writing or removing foreign files", () =>
    Effect.gen(function* () {
      const result = yield* preparePiRuntimeAssets(input);
      const original = input.stagingDirectory + "-original";
      yield* Effect.promise(() => NodeFSP.rename(input.stagingDirectory, original));
      yield* Effect.promise(() => NodeFSP.mkdir(input.stagingDirectory));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(fixturePath(input.stagingDirectory, "foreign"), "retained"),
      );
      expect((yield* result.revalidate.pipe(Effect.flip)).phase).toBe("validation");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(fixturePath(input.stagingDirectory, "foreign"), "utf8"),
        ),
      ).toBe("retained");
      yield* Effect.promise(() => NodeFSP.chmod(original, 0o700));
    }),
  );
  native("rejects replaced file and added foreign entry on revalidation", () =>
    Effect.gen(function* () {
      const result = yield* preparePiRuntimeAssets(input);
      yield* Effect.promise(() => NodeFSP.chmod(input.stagingDirectory, 0o700));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(fixturePath(input.stagingDirectory, "foreign"), "keep"),
      );
      expect((yield* result.revalidate.pipe(Effect.flip)).phase).toBe("validation");
      yield* Effect.promise(() => NodeFSP.unlink(fixturePath(input.stagingDirectory, "foreign")));
      const file = result.runtimeFiles[0]!.source;
      yield* Effect.promise(() => NodeFSP.unlink(file));
      yield* Effect.promise(() => NodeFSP.writeFile(file, "different"));
      yield* Effect.promise(() => NodeFSP.chmod(input.stagingDirectory, 0o555));
      expect((yield* result.revalidate.pipe(Effect.flip)).phase).toBe("validation");
    }),
  );
  native("derives the SEA argv from host executable data", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.unlink(fixturePath(input.distributionDirectory, "pi-worker.mjs")),
      );
      const result = yield* preparePiRuntimeAssets(input).pipe(
        Effect.provideService(HostProcessIsExecutable, true),
      );
      expect(
        result
          .workerArgv(
            { workerId: "worker", generation: 0 },
            { operationId: "init", operationKind: "initialize" },
            "/state/sessions",
          )
          .slice(0, 2),
      ).toEqual(["/runtime/t3", "__pi-worker"]);
      // This is a host-reference branch control, not actual SEA startup evidence.
      expect(result.runtimeFiles.some((file) => file.target === "/runtime/t3")).toBe(true);
    }),
  );
});
