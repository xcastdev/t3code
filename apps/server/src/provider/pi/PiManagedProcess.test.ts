// @effect-diagnostics nodeBuiltinImport:off - Disposable filesystem fixtures verify the managed launch boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, beforeEach, describe, expect } from "vite-plus/test";
import {
  acquirePiManagedProcess,
  validatePiManagedLaunch,
  type PiManagedLaunch,
  type PiManagedProcessOwner,
  type PiManagedDrain,
  type PiManagedProcess,
} from "./PiManagedProcess.ts";

let scratch = "";
let input: PiManagedLaunch;
beforeEach(async () => {
  scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-managed-portable-"));
  await Promise.all(
    ["workspace", "protected"].map((name) => NodeFSP.mkdir(NodePath.join(scratch, name))),
  );
  await NodeFSP.writeFile(NodePath.join(scratch, "runtime"), "trusted-runtime");
  input = {
    workspaceRoot: NodePath.join(scratch, "workspace"),
    protectedRoots: [NodePath.join(scratch, "protected")],
    runtimeFiles: [{ source: NodePath.join(scratch, "runtime"), target: "/runtime/program" }],
    argv: ["/runtime/program"],
    memoryBytes: 536870912,
    runtimeSeconds: 30,
  };
});
afterEach(async () => {
  delete process.env.PI_MANAGED_PROCESS_TEST_SENTINEL;
  await NodeFSP.rm(scratch, { recursive: true, force: true });
});
const check = <A, E>(name: string, body: () => Effect.Effect<A, E, NodeServices.NodeServices>) =>
  it.live(name, () => body().pipe(Effect.provide(NodeServices.layer)));
const validate = (value = input, platform: NodeJS.Platform = "linux") =>
  validatePiManagedLaunch(value).pipe(Effect.provideService(HostProcessPlatform, platform));
const rejects = Effect.fn("managedTest.rejects")(function* (
  value: PiManagedLaunch,
  text: string,
  platform: NodeJS.Platform = "linux",
) {
  const error = yield* validate(value, platform).pipe(Effect.flip);
  expect(error.message).toContain(text);
});
const absent = (path: string) =>
  Effect.promise(() => expect(NodeFSP.stat(path)).rejects.toMatchObject({ code: "ENOENT" }));
const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("managed launch filesystem boundary", () => {
  check("accepts a pinned regular runtime file and records the canonical workspace inode", () =>
    Effect.gen(function* () {
      const result = yield* validate();
      const stat = yield* Effect.promise(() => NodeFSP.stat(input.workspaceRoot));
      const path = yield* Effect.promise(() => NodeFSP.realpath(input.workspaceRoot));
      expect(result.workspace).toEqual({ path, dev: stat.dev, ino: stat.ino });
      expect(result.runtimeFiles[0]?.source).toBe(
        yield* Effect.promise(() => NodeFSP.realpath(input.runtimeFiles[0]!.source)),
      );
    }),
  );
  for (const platform of ["darwin", "win32"] as const)
    check(`keeps ${platform} managed execution unavailable`, () =>
      rejects(input, "Linux", platform),
    );
  check("rejects protected data below the writable root", () =>
    rejects({ ...input, protectedRoots: [input.workspaceRoot] }, "protected"),
  );
  check("rejects writable roots below protected data", () =>
    rejects({ ...input, protectedRoots: [scratch] }, "protected"),
  );
  check("rejects the host root as protected data overlapping every workspace", () =>
    rejects({ ...input, protectedRoots: ["/"] }, "protected"),
  );
  check("rejects a symlinked assigned cwd", () =>
    Effect.gen(function* () {
      const alias = NodePath.join(scratch, "alias");
      yield* Effect.promise(() => NodeFSP.symlink(input.workspaceRoot, alias));
      yield* rejects({ ...input, workspaceRoot: alias }, "canonical");
    }),
  );
  check("resolves protected symlinks before checking overlaps", () =>
    Effect.gen(function* () {
      const alias = NodePath.join(scratch, "alias");
      yield* Effect.promise(() => NodeFSP.symlink(input.workspaceRoot, alias));
      yield* rejects({ ...input, protectedRoots: [alias] }, "protected");
    }),
  );
  check("rejects directories in the trusted runtime closure", () =>
    Effect.gen(function* () {
      const directory = NodePath.join(scratch, "runtime-dir");
      yield* Effect.promise(() => NodeFSP.mkdir(directory));
      yield* rejects(
        { ...input, runtimeFiles: [{ source: directory, target: "/runtime/all" }] },
        "regular file",
      );
    }),
  );
  check("rejects runtime aliases resolving into protected data", () =>
    Effect.gen(function* () {
      const secret = NodePath.join(scratch, "protected", "secret");
      const alias = NodePath.join(scratch, "secret-alias");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(secret, "synthetic-secret");
        await NodeFSP.symlink(secret, alias);
      });
      yield* rejects(
        { ...input, runtimeFiles: [{ source: alias, target: "/runtime/program" }] },
        "protected",
      );
    }),
  );
  for (const target of ["/", "/home", "/workspace/escape", "/proc/leak", "/runtime/../escape"])
    check(`rejects mount target ${target}`, () =>
      rejects(
        { ...input, runtimeFiles: [{ source: input.runtimeFiles[0]!.source, target }] },
        "target",
      ),
    );
  check("rejects nested and duplicate mount targets", () =>
    Effect.gen(function* () {
      for (const target of ["/runtime/program", "/runtime/program/child"])
        yield* rejects(
          {
            ...input,
            runtimeFiles: [
              ...input.runtimeFiles,
              { source: input.runtimeFiles[0]!.source, target },
            ],
          },
          "overlap",
        );
    }),
  );
  check("rejects an executable outside the explicit runtime closure", () =>
    rejects({ ...input, argv: ["/bin/unmounted"] }, "executable"),
  );
  check("rejects absent bounds and empty protection before launch", () =>
    Effect.gen(function* () {
      yield* rejects({ ...input, memoryBytes: 0 }, "bounds");
      yield* rejects({ ...input, protectedRoots: [] }, "protected");
    }),
  );
  check("rejects environmental and additional descriptor passthrough", () =>
    Effect.gen(function* () {
      const environment = { ...input, env: { GH_TOKEN: "synthetic" } };
      const descriptors = { ...input, additionalFds: [3] };
      yield* rejects(environment, "passthrough");
      yield* rejects(descriptors, "passthrough");
    }),
  );
});

// Required separately: PI_MANAGED_PROCESS_LINUX_GATE=1 vp test run <this file>.
// Ordinary discovery never launches systemd or claims a Linux containment proof.
describe.runIf(process.env.PI_MANAGED_PROCESS_LINUX_GATE === "1")(
  "actual Linux managed process",
  () => {
    const retain = (receipt: PiManagedDrain | PiManagedProcessOwner) =>
      Effect.promise(async () => {
        const directory = process.env.PI_MANAGED_PROCESS_EVIDENCE_DIR;
        if (!directory) return;
        await NodeFSP.mkdir(directory, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(
            directory,
            receipt.unit + ("type" in receipt ? ".owner.json" : ".drain.json"),
          ),
          encodeEvidence(receipt),
        );
      });
    const retainOwned = (child: PiManagedProcess) =>
      Effect.addFinalizer(() =>
        child.stop.pipe(Effect.flatMap(retain), Effect.orDie, Effect.asVoid),
      );
    const closure = Effect.promise(async () => {
      const files = [
        { source: "/usr/bin/bash", target: "/bin/bash" },
        ...[
          "/lib64/ld-linux-x86-64.so.2",
          "/usr/lib/libc.so.6",
          "/usr/lib/libreadline.so.8",
          "/usr/lib/libncursesw.so.6",
        ].map((source) => ({ source, target: source })),
      ];
      for (const file of files) await NodeFSP.stat(file.source);
      return files;
    });
    const acquire = (
      argv: ReadonlyArray<string>,
      overrides: Partial<PiManagedLaunch> = {},
      properties: ReadonlyArray<string> = [],
    ) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = process.env.PI_MANAGED_PROCESS_EVIDENCE_DIR;
        const observed = ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand" || command.command !== "/usr/bin/systemd-run")
            return spawner.spawn(command);
          const args = [...command.args];
          args.splice(
            args.indexOf("/usr/bin/python3"),
            0,
            ...properties.flatMap((value) => ["-p", value]),
          );
          const unit = args.find((arg) => arg.startsWith("--unit="))!.slice(7);
          let pending = Buffer.alloc(0);
          let retained = false;
          return spawner.spawn(ChildProcess.make(command.command, args, command.options)).pipe(
            Effect.tap((handle) =>
              Effect.promise(async () => {
                if (!directory) return;
                await NodeFSP.mkdir(directory, { recursive: true });
                await NodeFSP.writeFile(
                  NodePath.join(directory, unit + ".launch.json"),
                  encodeEvidence({ unit, launcherPid: Number(handle.pid), args }),
                );
              }),
            ),
            Effect.map((handle) =>
              ChildProcessSpawner.makeHandle({
                ...handle,
                stdout: handle.stdout.pipe(
                  Stream.tap((chunk) =>
                    Effect.promise(async () => {
                      if (!directory || retained) return;
                      if (pending.byteLength + chunk.byteLength > 65536)
                        throw new Error("Bootstrap evidence exceeded its bound");
                      pending = Buffer.concat([pending, chunk]);
                      const newline = pending.indexOf(10);
                      if (newline < 0) return;
                      retained = true;
                      await NodeFSP.writeFile(
                        NodePath.join(directory, unit + ".bootstrap.json"),
                        pending.subarray(0, newline),
                      );
                      pending = Buffer.alloc(0);
                    }),
                  ),
                ),
              }),
            ),
          );
        });
        return yield* acquirePiManagedProcess({
          ...input,
          runtimeFiles: yield* closure,
          argv,
          ...overrides,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
          Effect.tap(retainOwned),
        );
      });
    for (const seconds of [59, 60, 61, 120, 3600])
      check(`accepts the exact numeric runtime policy for ${seconds} seconds`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* acquire(["/bin/bash", "-c", "printf duration"], {
              runtimeSeconds: seconds,
            });
            yield* child.start;
            const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.runCollect);
            const receipt = yield* child.awaitExit;
            expect(Array.from(output).join("")).toBe("duration");
            expect(receipt.childExitCode).toBe(0);
          }),
        ),
      );
    check("rejects a numerically different runtime service policy before START", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const error = yield* acquire(
            ["/bin/bash", "-c", "printf forbidden > /workspace/wrong-policy"],
            { runtimeSeconds: 60 },
            ["RuntimeMaxSec=61s"],
          ).pipe(Effect.flip);
          expect(error.phase).toBe("startup");
          yield* absent(NodePath.join(input.workspaceRoot, "wrong-policy"));
        }),
      ),
    );
    check("isolates Python startup from writable workspace sitecustomize before START", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const secret = NodePath.join(scratch, "protected", "secret");
          const marker = NodePath.join(input.workspaceRoot, "python-startup-proof");
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(secret, "synthetic-protected");
            await NodeFSP.writeFile(
              NodePath.join(input.workspaceRoot, "sitecustomize.py"),
              `with open(${encodeEvidence(secret)}) as source, open(${encodeEvidence(marker)}, "w") as target:\n target.write(source.read())\n`,
            );
          });
          const child = yield* acquire(["/bin/bash", "-c", "printf okay"], {}, [
            "Environment=PYTHONPATH=" + input.workspaceRoot,
          ]);
          yield* absent(marker);
          yield* child.stop;
        }),
      ),
    );
    check("removes native-loader output injection before the trusted helper starts", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const prefix = NodePath.join(input.workspaceRoot, "loader-startup-proof");
          const child = yield* acquire(["/bin/bash", "-c", "printf okay"], {}, [
            "Environment=LD_DEBUG=libs LD_DEBUG_OUTPUT=" + prefix,
          ]);
          const names = yield* Effect.promise(() => NodeFSP.readdir(input.workspaceRoot));
          expect(names.filter((name) => name.startsWith("loader-startup-proof"))).toEqual([]);
          yield* child.stop;
        }),
      ),
    );
    for (const outputBytes of [4096, 1048576])
      check(
        `streams ${outputBytes} output bytes while queued input preserves byte order through EOF`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const script = `set -e; printf '%${outputBytes}s' x; for letter in a b c d e f g h i j k l m n o p; do IFS= read -r -N8192 value; printf -v expected '%8192s' ''; expected=\${expected// /$letter}; if test "$letter" = p; then expected=\${expected:0:8191}$'\\n'; fi; test "$value" = "$expected"; done; if IFS= read -r extra; then exit 7; fi; printf consumed`;
              const child = yield* acquire(["/bin/bash", "--noprofile", "--norc", "-c", script]);
              yield* child.start;
              const sender = Effect.gen(function* () {
                for (let n = 0; n < 16; n++) {
                  const bytes = Buffer.alloc(8192, 97 + n);
                  if (n === 15) bytes[8191] = 10;
                  yield* child.send(bytes);
                }
                yield* child.endInput;
              });
              const output = child.stdout.pipe(
                Stream.runFold(
                  () => Buffer.alloc(0),
                  (total, bytes) => Buffer.concat([total, bytes]),
                ),
              );
              const [bytes] = yield* Effect.all([output, sender], {
                concurrency: "unbounded",
              }).pipe(Effect.timeout("3 seconds"));
              expect(bytes.subarray(0, outputBytes).toString()).toBe(
                " ".repeat(outputBytes - 1) + "x",
              );
              expect(bytes.subarray(outputBytes).toString()).toBe("consumed");
              const receipt = yield* child.awaitExit;
              expect(receipt.childExitCode).toBe(0);
            }),
          ),
      );
    check("fails closed when a worker refuses input beyond the bounded queue", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* acquire(["/bin/bash", "-c", "printf ready; while :; do :; done"]);
          yield* child.start;
          const ready = yield* child.stdout.pipe(Stream.take(1), Stream.runCollect);
          expect(Buffer.concat(Array.from(ready)).toString()).toBe("ready");
          yield* Effect.gen(function* () {
            for (let n = 0; n < 64; n++) yield* child.send(Buffer.alloc(8192, 120));
          }).pipe(Effect.forkScoped);
          const error = yield* child.stdout.pipe(
            Stream.runDrain,
            Effect.flip,
            Effect.timeout("3 seconds"),
          );
          expect(error._tag).toBe("PiManagedProcessError");
          const receipt = yield* child.stop;
          expect(receipt.kernel).toMatch(/removed|populated 0/);
        }),
      ),
    );
    check(
      "runs a setup shell after ownership and keeps protected data, environment and descriptors inaccessible",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(scratch, "protected", "secret"), "synthetic-secret"),
            );
            process.env.PI_MANAGED_PROCESS_TEST_SENTINEL = "synthetic-should-not-cross";
            const child = yield* acquire([
              "/bin/bash",
              "--noprofile",
              "--norc",
              "-c",
              `set -e; test "$PWD" = /workspace; test "\${GH_TOKEN-unset}" = unset; test "\${PI_MANAGED_PROCESS_TEST_SENTINEL-unset}" = unset; test ! -e '${scratch}/protected/secret'; test ! -e /protected/secret; for descriptor in /proc/self/fd/*; do case "$descriptor" in /proc/self/fd/0|/proc/self/fd/1|/proc/self/fd/2) ;; *) test ! -e "$descriptor" ;; esac; done; printf restricted > /workspace/setup-proof; printf success`,
            ]);
            yield* child.start;
            const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.runCollect);
            const exit = yield* child.awaitExit;
            expect(Array.from(output).join("")).toBe("success");
            expect(exit.childExitCode).toBe(0);
            expect(exit.kernel).toMatch(/removed|populated 0/);
            expect(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(input.workspaceRoot, "setup-proof"), "utf8"),
              ),
            ).toBe("restricted");
            expect(child.owner.memoryBytes).toBe(536870912);
          }),
        ),
    );
    check("cancels an owned setup before start acknowledgement without writing the workspace", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* acquire([
            "/bin/bash",
            "-c",
            "printf forbidden > /workspace/prestart-proof",
          ]);
          const receipt = yield* child.stop;
          const error = yield* child.start.pipe(Effect.flip);
          expect(error.phase).toBe("startup");
          expect(receipt.kernel).toMatch(/removed|populated 0/);
          yield* absent(NodePath.join(input.workspaceRoot, "prestart-proof"));
        }),
      ),
    );
    check("rejects a workspace inode swap after ownership before executing setup", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* acquire([
            "/bin/bash",
            "-c",
            "printf forbidden > /workspace/swapped-proof",
          ]);
          yield* Effect.promise(async () => {
            await NodeFSP.rename(input.workspaceRoot, input.workspaceRoot + "-original");
            await NodeFSP.mkdir(input.workspaceRoot);
          });
          const error = yield* child.start.pipe(Effect.flip);
          expect(error.phase).toBe("startup");
          const receipt = yield* child.stop;
          expect(receipt.kernel).toMatch(/removed|populated 0/);
          for (const root of [input.workspaceRoot, input.workspaceRoot + "-original"])
            yield* absent(NodePath.join(root, "swapped-proof"));
        }),
      ),
    );
    check("stops a running setup and drains a child that ignores TERM", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* acquire([
            "/bin/bash",
            "-c",
            "trap '' TERM; /bin/bash -c 'trap \"\" TERM; while :; do :; done' & printf ready; wait",
          ]);
          yield* child.start;
          const chunks = yield* child.stdout.pipe(Stream.take(1), Stream.runCollect);
          expect(Buffer.concat(Array.from(chunks)).toString()).toBe("ready");
          for (let n = 0; n < 16; n++) yield* child.send(Buffer.alloc(8192, 120));
          const receipt = yield* child.stop;
          const error = yield* child.send(Buffer.from("late input")).pipe(Effect.flip);
          expect(error.phase).toBe("transport");
          expect(receipt.kernel).toMatch(/removed|populated 0/);
          expect(receipt.childPid).toBeGreaterThan(0);
          expect(receipt.childExitCode).toBeNull();
        }),
      ),
    );
    check("scope interruption drains prestart ownership before setup execution", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const receipt = yield* Deferred.make<PiManagedProcessOwner>();
          const fiber = yield* Effect.scoped(
            Effect.gen(function* () {
              const child = yield* acquire([
                "/bin/bash",
                "-c",
                "printf forbidden > /workspace/interrupted-proof",
              ]);
              yield* Deferred.succeed(receipt, child.owner);
              return yield* Effect.never;
            }),
          ).pipe(Effect.forkChild);
          const owner = yield* Deferred.await(receipt);
          yield* Fiber.interrupt(fiber);
          yield* absent(owner.cgroup);
          const drained = { ...owner, kernel: "removed", confirmed: true };
          yield* retain(drained);
          yield* absent(NodePath.join(input.workspaceRoot, "interrupted-proof"));
        }),
      ),
    );
    check("drains descendants even when the setup shell exits first", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* acquire([
            "/bin/bash",
            "-c",
            "/bin/bash -c 'trap \"\" TERM; while :; do :; done' & printf descendant; exit 0",
          ]);
          yield* child.start;
          yield* child.stdout.pipe(Stream.runDrain);
          const receipt = yield* child.awaitExit;
          expect(receipt.childExitCode).toBe(0);
          expect(receipt.kernel).toMatch(/removed|populated 0/);
        }),
      ),
    );
  },
);
