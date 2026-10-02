// @effect-diagnostics nodeBuiltinImport:off - Disposable filesystem fixtures verify the managed launch boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
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
  preallocatePiManagedProcess,
  reconcilePiManagedProcess,
  PiManagedProcessError,
  type PiManagedProcessPersistence,
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
const decodeWithheldOwner = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("owner"),
      unit: Schema.String,
      nonce: Schema.String,
      invocation: Schema.String,
      cgroup: Schema.String,
    }),
  ),
);

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

describe("managed runtime mount validation", () => {
  check("pins separate native state and protected Git entries", () =>
    Effect.gen(function* () {
      const state = NodePath.join(scratch, "native-state");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(state);
        await NodeFSP.writeFile(
          NodePath.join(input.workspaceRoot, ".git"),
          "gitdir: /unmounted/common.git",
        );
      });
      const result = yield* validate({
        ...input,
        nativeStateRoot: state,
        workspaceAccess: "readonly",
        protectedWorkspaceEntries: [".git"],
      });
      expect(result.nativeState?.path).toBe(state);
      expect(result.workspaceAccess).toBe("readonly");
      expect(result.protectedWorkspaceEntries[0]?.target).toBe("/workspace/.git");
    }),
  );
  check("rejects state overlap with workspace protected data and runtime", () =>
    Effect.gen(function* () {
      for (const state of [input.workspaceRoot, scratch, input.protectedRoots[0]!])
        yield* rejects({ ...input, nativeStateRoot: state }, "separately owned");
      const state = NodePath.join(scratch, "native-state");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(state);
        await NodeFSP.writeFile(NodePath.join(state, "runtime"), "program");
      });
      yield* rejects(
        {
          ...input,
          nativeStateRoot: state,
          runtimeFiles: [{ source: NodePath.join(state, "runtime"), target: "/runtime/program" }],
        },
        "overlap",
      );
    }),
  );
  check("rejects state aliases and protected entry traversal aliases and overlaps", () =>
    Effect.gen(function* () {
      const state = NodePath.join(scratch, "state");
      const alias = NodePath.join(scratch, "state-alias");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(state);
        await NodeFSP.symlink(state, alias);
        await NodeFSP.mkdir(NodePath.join(input.workspaceRoot, "metadata"));
        await NodeFSP.writeFile(NodePath.join(input.workspaceRoot, "metadata", "file"), "pinned");
        await NodeFSP.symlink("metadata", NodePath.join(input.workspaceRoot, "alias"));
      });
      yield* rejects({ ...input, nativeStateRoot: alias }, "canonical");
      for (const entry of [
        "../protected",
        "/metadata",
        "metadata/../file",
        "metadata/./file",
        "metadata//file",
        "metadata\\file",
      ])
        yield* rejects({ ...input, protectedWorkspaceEntries: [entry] }, "relative");
      yield* rejects({ ...input, protectedWorkspaceEntries: ["alias/file"] }, "symlink");
      yield* rejects(
        { ...input, protectedWorkspaceEntries: ["metadata", "metadata/file"] },
        "overlap",
      );
      yield* rejects({ ...input, protectedWorkspaceEntries: Array(17).fill("metadata") }, "bound");
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
        { source: "/usr/bin/rm", target: "/bin/rm" },
        { source: "/usr/bin/mv", target: "/bin/mv" },
        ...[
          "/lib64/ld-linux-x86-64.so.2",
          "/usr/lib/libc.so.6",
          "/usr/lib/libreadline.so.8",
          "/usr/lib/libncursesw.so.6",
          "/usr/lib/libacl.so.1",
          "/usr/lib/libattr.so.1",
        ].map((source) => ({ source, target: source })),
      ];
      for (const file of files) await NodeFSP.stat(file.source);
      return files;
    });
    const acquire = (
      argv: ReadonlyArray<string>,
      overrides: Partial<PiManagedLaunch> = {},
      properties: ReadonlyArray<string> = [],
      persistence?: PiManagedProcessPersistence,
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
        return yield* acquirePiManagedProcess(
          {
            ...input,
            runtimeFiles: yield* closure,
            argv,
            ...overrides,
          },
          persistence,
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
          Effect.tap(retainOwned),
        );
      });
    const runtimeLaunch = (argv: ReadonlyArray<string>, overrides: Partial<PiManagedLaunch> = {}) =>
      Effect.gen(function* () {
        return { ...input, runtimeFiles: yield* closure, argv, ...overrides };
      });
    check("enforces readonly workspace against actual shell writes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* acquire(
            [
              "/bin/bash",
              "-c",
              "if printf forbidden > /workspace/readonly-proof 2>/dev/null; then exit 9; fi; printf readonly",
            ],
            { workspaceAccess: "readonly" },
          );
          yield* child.start;
          const [out] = yield* Effect.all(
            [
              child.stdout.pipe(Stream.decodeText(), Stream.runCollect),
              child.stderr.pipe(Stream.runDrain),
            ],
            { concurrency: "unbounded" },
          );
          expect(Array.from(out).join("")).toBe("readonly");
          expect((yield* child.awaitExit).childExitCode).toBe(0);
          yield* absent(NodePath.join(input.workspaceRoot, "readonly-proof"));
        }),
      ),
    );
    check("mounts only owned state writable and excludes sibling state protected resources", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const state = NodePath.join(scratch, "state");
          const sibling = NodePath.join(scratch, "sibling-state");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(state);
            await NodeFSP.mkdir(sibling);
            await NodeFSP.writeFile(NodePath.join(sibling, "secret"), "other-thread");
            await NodeFSP.writeFile(NodePath.join(scratch, "protected", "secret"), "protected");
          });
          const child = yield* acquire(
            [
              "/bin/bash",
              "-c",
              `set -e; test ! -e '${sibling}/secret'; test ! -e '${scratch}/protected/secret'; printf own > /state/native; printf state`,
            ],
            { nativeStateRoot: state, workspaceAccess: "readonly" },
          );
          yield* child.start;
          const out = yield* child.stdout.pipe(Stream.decodeText(), Stream.runCollect);
          expect(Array.from(out).join("")).toBe("state");
          expect((yield* child.awaitExit).childExitCode).toBe(0);
          expect(
            yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(state, "native"), "utf8")),
          ).toBe("own");
          expect(
            yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(sibling, "secret"), "utf8")),
          ).toBe("other-thread");
        }),
      ),
    );
    for (const directory of [false, true])
      check(
        `keeps Git ${directory ? "directory" : "pointer"} immutable in writable workspace`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const git = NodePath.join(input.workspaceRoot, ".git");
              yield* Effect.promise(async () => {
                if (directory) {
                  await NodeFSP.mkdir(git);
                  await NodeFSP.writeFile(NodePath.join(git, "config"), "protected-config");
                } else await NodeFSP.writeFile(git, "gitdir: /unmounted/common.git");
              });
              const child = yield* acquire(
                [
                  "/bin/bash",
                  "-c",
                  `set -e; test ! -e /unmounted/common.git; if printf changed > /workspace/.git${directory ? "/config" : ""} 2>/dev/null; then exit 9; fi; if /bin/bash -c 'exec 3>/workspace/.git' 2>/dev/null; then exit 8; fi; if /bin/rm -rf /workspace/.git 2>/dev/null; then exit 7; fi; if /bin/mv /workspace/.git /workspace/replaced 2>/dev/null; then exit 6; fi; printf writable > /workspace/edit; printf git`,
                ],
                { protectedWorkspaceEntries: [".git"] },
              );
              yield* child.start;
              const [out] = yield* Effect.all(
                [
                  child.stdout.pipe(Stream.decodeText(), Stream.runCollect),
                  child.stderr.pipe(Stream.runDrain),
                ],
                { concurrency: "unbounded" },
              );
              expect(Array.from(out).join("")).toBe("git");
              expect((yield* child.awaitExit).childExitCode).toBe(0);
              expect(
                yield* Effect.promise(() =>
                  NodeFSP.readFile(directory ? NodePath.join(git, "config") : git, "utf8"),
                ),
              ).toBe(directory ? "protected-config" : "gitdir: /unmounted/common.git");
              expect(
                yield* Effect.promise(() =>
                  NodeFSP.readFile(NodePath.join(input.workspaceRoot, "edit"), "utf8"),
                ),
              ).toBe("writable");
            }),
          ),
      );
    for (const target of ["state", "git"] as const)
      for (const replacement of ["directory", "symlink"] as const)
        check(`rejects ${target} ${replacement} identity replacement before START`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const state = NodePath.join(scratch, "state");
              const git = NodePath.join(input.workspaceRoot, ".git");
              yield* Effect.promise(async () => {
                await NodeFSP.mkdir(state);
                await NodeFSP.mkdir(git);
              });
              const child = yield* acquire(
                ["/bin/bash", "-c", "printf forbidden > /workspace/swapped-runtime-proof"],
                { nativeStateRoot: state, protectedWorkspaceEntries: [".git"] },
              );
              const original = target === "state" ? state : git;
              yield* Effect.promise(async () => {
                await NodeFSP.rename(original, original + "-original");
                if (replacement === "symlink")
                  await NodeFSP.symlink(original + "-original", original);
                else await NodeFSP.mkdir(original);
              });
              expect((yield* child.start.pipe(Effect.flip)).phase).toBe("startup");
              expect((yield* child.stop).kernel).toMatch(/removed|populated 0/);
              yield* absent(NodePath.join(input.workspaceRoot, "swapped-runtime-proof"));
            }),
          ),
        );
    check(
      "persists activation and full owner before exposing START, then recovers exact ownership",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const launch = yield* runtimeLaunch([
              "/bin/bash",
              "-c",
              "printf ready; while :; do :; done",
            ]);
            const allocation = yield* preallocatePiManagedProcess(launch);
            let claimed = false;
            let saved: PiManagedProcessOwner | undefined;
            const child = yield* acquire(launch.argv, {}, [], {
              allocation,
              claimActivation: () =>
                Effect.sync(() => {
                  expect(saved).toBeUndefined();
                  claimed = true;
                }),
              beforeStart: (owner) =>
                Effect.sync(() => {
                  expect(claimed).toBe(true);
                  saved = owner;
                }),
            });
            expect(saved).toEqual(child.owner);
            const inspected = yield* reconcilePiManagedProcess(
              { allocation, activation: "owned", owner: child.owner },
              { stop: false },
            );
            expect(inspected.state).toBe("owned");
            yield* child.start;
            yield* child.stdout.pipe(Stream.take(1), Stream.runDrain);
            const drain = yield* reconcilePiManagedProcess(
              { allocation, activation: "owned", owner: child.owner },
              { stop: true },
            );
            expect(drain.state).toBe("drained");
            expect(drain.kernel).toMatch(/removed|populated 0/);
          }),
        ),
    );
    check(
      "quarantines stale invocation and policy without stopping the current owned service",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const launch = yield* runtimeLaunch([
              "/bin/bash",
              "-c",
              "printf still-owned; while :; do :; done",
            ]);
            const allocation = yield* preallocatePiManagedProcess(launch);
            const child = yield* acquire(launch.argv, {}, [], {
              allocation,
              claimActivation: () => Effect.void,
              beforeStart: () => Effect.void,
            });
            for (const owner of [
              { ...child.owner, invocation: "0".repeat(32) },
              { ...child.owner, nonce: "foreign" },
              { ...child.owner, cgroup: child.owner.cgroup + "/foreign" },
            ])
              expect(
                (yield* reconcilePiManagedProcess(
                  { allocation, activation: "owned", owner },
                  { stop: true },
                ).pipe(Effect.flip)).phase,
              ).toBe("quarantine");
            yield* child.start;
            const out = yield* child.stdout.pipe(Stream.take(1), Stream.runCollect);
            expect(Buffer.concat(Array.from(out)).toString()).toBe("still-owned");
            yield* child.stop;
          }),
        ),
    );
    check("distinguishes unclaimed absence from uncertain claimed activation", () =>
      Effect.gen(function* () {
        const allocation = yield* preallocatePiManagedProcess(
          yield* runtimeLaunch(["/bin/bash", "-c", "true"]),
        );
        expect(
          (yield* reconcilePiManagedProcess(
            { allocation, activation: "unlaunched" },
            { stop: true },
          )).state,
        ).toBe("absent");
        expect(
          (yield* reconcilePiManagedProcess(
            { allocation, activation: "claimed" },
            { stop: true },
          ).pipe(Effect.flip)).phase,
        ).toBe("quarantine");
      }),
    );
    for (const phase of ["claim", "owner"] as const)
      check(`failed ${phase} persistence prevents actual workspace execution`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const launch = yield* runtimeLaunch([
              "/bin/bash",
              "-c",
              "printf forbidden > /workspace/persist-proof",
            ]);
            const allocation = yield* preallocatePiManagedProcess(launch);
            const error = new PiManagedProcessError({
              phase: "startup",
              message: "durable persistence rejected",
            });
            expect(
              (yield* acquire(launch.argv, {}, [], {
                allocation,
                claimActivation: () => (phase === "claim" ? Effect.fail(error) : Effect.void),
                beforeStart: () => (phase === "owner" ? Effect.fail(error) : Effect.void),
              }).pipe(Effect.flip)).message,
            ).toContain("persistence");
            yield* absent(NodePath.join(input.workspaceRoot, "persist-proof"));
          }),
        ),
      );
    check("cancellation while owner persistence is held drains before any START", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const launch = yield* runtimeLaunch([
            "/bin/bash",
            "-c",
            "printf forbidden > /workspace/persist-cancel-proof",
          ]);
          const allocation = yield* preallocatePiManagedProcess(launch);
          const held = yield* Deferred.make<PiManagedProcessOwner>();
          const fiber = yield* Effect.scoped(
            acquire(launch.argv, {}, [], {
              allocation,
              claimActivation: () => Effect.void,
              beforeStart: (owner) =>
                Deferred.succeed(held, owner).pipe(Effect.andThen(Effect.never)),
            }),
          ).pipe(Effect.forkChild);
          const owner = yield* Deferred.await(held);
          yield* Fiber.interrupt(fiber);
          yield* absent(owner.cgroup);
          yield* absent(NodePath.join(input.workspaceRoot, "persist-cancel-proof"));
          yield* retain({ ...owner, kernel: "removed" });
        }),
      ),
    );
    check("held owner persistence leaves the workspace untouched until the receipt commits", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const launch = yield* runtimeLaunch([
            "/bin/bash",
            "-c",
            "printf committed > /workspace/persist-held-proof",
          ]);
          const allocation = yield* preallocatePiManagedProcess(launch);
          const held = yield* Deferred.make<PiManagedProcessOwner>();
          const release = yield* Deferred.make<void>();
          const fiber = yield* acquire(launch.argv, {}, [], {
            allocation,
            claimActivation: () => Effect.void,
            beforeStart: (owner) =>
              Deferred.succeed(held, owner).pipe(Effect.andThen(Deferred.await(release))),
          }).pipe(Effect.forkChild);
          yield* Deferred.await(held).pipe(Effect.timeout("3 seconds"));
          yield* absent(NodePath.join(input.workspaceRoot, "persist-held-proof"));
          yield* Deferred.succeed(release, undefined);
          const child = yield* Fiber.join(fiber);
          yield* child.start;
          yield* child.stdout.pipe(Stream.runDrain);
          expect((yield* child.awaitExit).childExitCode).toBe(0);
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(input.workspaceRoot, "persist-held-proof"), "utf8"),
            ),
          ).toBe("committed");
        }),
      ),
    );
    check("calls the upstream single-use activation claim for every preallocated acquire", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const launch = yield* runtimeLaunch(["/bin/bash", "-c", "printf once"]);
          const allocation = yield* preallocatePiManagedProcess(launch);
          let claimed = false;
          let attempts = 0;
          const persistence = {
            allocation,
            claimActivation: () =>
              Effect.suspend(() => {
                attempts++;
                if (claimed)
                  return Effect.fail(
                    new PiManagedProcessError({
                      phase: "startup",
                      message: "activation already claimed",
                    }),
                  );
                claimed = true;
                return Effect.void;
              }),
            beforeStart: () => Effect.void,
          };
          const child = yield* acquire(launch.argv, {}, [], persistence);
          yield* child.stop;
          expect(
            (yield* acquire(launch.argv, {}, [], persistence).pipe(Effect.flip)).message,
          ).toContain("already claimed");
          expect(attempts).toBe(2);
          expect(
            (yield* reconcilePiManagedProcess(
              { allocation, activation: "owned", owner: child.owner },
              { stop: false },
            )).state,
          ).toBe("drained");
        }),
      ),
    );
    check("rejects preallocated inode and unknown field changes before claiming activation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const launch = yield* runtimeLaunch([
            "/bin/bash",
            "-c",
            "printf forbidden > /workspace/changed-allocation-proof",
          ]);
          const allocation = yield* preallocatePiManagedProcess(launch);
          let claims = 0;
          const claimActivation = () =>
            Effect.sync(() => {
              claims++;
            });
          const beforeStart = () => Effect.void;
          const changed = {
            ...allocation,
            launch: {
              ...allocation.launch,
              workspace: {
                ...allocation.launch.workspace,
                ino: allocation.launch.workspace.ino + 1,
              },
            },
          };
          expect(
            (yield* acquire(launch.argv, {}, [], {
              allocation: changed,
              claimActivation,
              beforeStart,
            }).pipe(Effect.flip)).phase,
          ).toBe("validation");
          const unknown = { ...allocation, env: { arbitrary: "forbidden" } };
          expect(
            (yield* acquire(launch.argv, {}, [], {
              allocation: unknown,
              claimActivation,
              beforeStart,
            }).pipe(Effect.flip)).phase,
          ).toBe("validation");
          expect(claims).toBe(0);
          yield* absent(NodePath.join(input.workspaceRoot, "changed-allocation-proof"));
        }),
      ),
    );
    check(
      "refuses a foreign service reusing the exact unit without signalling its captured process",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const launch = yield* runtimeLaunch(["/bin/bash", "-c", "printf original"]);
            const allocation = yield* preallocatePiManagedProcess(launch);
            const child = yield* acquire(launch.argv, {}, [], {
              allocation,
              claimActivation: () => Effect.void,
              beforeStart: () => Effect.void,
            });
            yield* child.stop;
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const foreign = yield* spawner.spawn(
              ChildProcess.make(
                "/usr/bin/systemd-run",
                [
                  "--user",
                  "--wait",
                  "--pipe",
                  "--quiet",
                  `--unit=${allocation.unit}`,
                  "--description=Foreign recovery control",
                  "-p",
                  "MemoryMax=536870912",
                  "-p",
                  "MemorySwapMax=0",
                  "-p",
                  "OOMPolicy=kill",
                  "-p",
                  "KillMode=control-group",
                  "-p",
                  "RuntimeMaxSec=10s",
                  "/usr/bin/bash",
                  "-c",
                  "printf foreign-ready; IFS= read -r value; printf foreign-survived",
                ],
                {
                  env: {
                    PATH: "/usr/bin:/bin",
                    XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}`,
                    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid!()}/bus`,
                  },
                  extendEnv: false,
                  shell: false,
                },
              ),
            );
            const done = yield* Deferred.make<void>();
            const observed = foreign.stdout.pipe(
              Stream.tap(() => Deferred.succeed(done, undefined)),
              Stream.decodeText(),
              Stream.runCollect,
              Effect.forkChild,
            );
            const reader = yield* observed;
            yield* Deferred.await(done);
            expect(
              (yield* reconcilePiManagedProcess(
                { allocation, activation: "owned", owner: child.owner },
                { stop: true },
              ).pipe(Effect.flip)).phase,
            ).toBe("quarantine");
            yield* Stream.make(Buffer.from("release\n")).pipe(Stream.run(foreign.stdin));
            expect(Array.from(yield* Fiber.join(reader)).join("")).toBe(
              "foreign-readyforeign-survived",
            );
            expect(Number(yield* foreign.exitCode)).toBe(0);
            yield* retain({ ...child.owner, kernel: "foreign-service-exited-from-owned-input" });
          }),
        ),
    );
    for (const sameDescription of [false, true])
      check(
        `failed acquire preserves uncaptured existing unit with ${sameDescription ? "same" : "different"} description`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const directory = process.env.PI_MANAGED_PROCESS_EVIDENCE_DIR;
              if (directory)
                yield* Effect.promise(() => NodeFSP.mkdir(directory, { recursive: true }));
              const launch = yield* runtimeLaunch([
                "/bin/bash",
                "-c",
                "printf forbidden > /workspace/collision-proof",
              ]);
              const allocation = yield* preallocatePiManagedProcess(launch);
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const env = {
                PATH: "/usr/bin:/bin",
                XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}`,
                DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid!()}/bus`,
              };
              const show = Effect.fn("managedTest.collisionShow")(function* () {
                return yield* Effect.scoped(
                  Effect.gen(function* () {
                    const handle = yield* spawner.spawn(
                      ChildProcess.make(
                        "/usr/bin/systemctl",
                        [
                          "--user",
                          "show",
                          allocation.unit,
                          "--property=LoadState,Description,InvocationID,ActiveState,ControlGroup",
                        ],
                        { env, extendEnv: false, shell: false },
                      ),
                    );
                    const [chunks, code] = yield* Effect.all(
                      [handle.stdout.pipe(Stream.decodeText(), Stream.runCollect), handle.exitCode],
                      { concurrency: "unbounded" },
                    );
                    expect(Number(code)).toBe(0);
                    return Object.fromEntries(
                      Array.from(chunks)
                        .join("")
                        .trim()
                        .split("\n")
                        .map((line) => {
                          const equals = line.indexOf("=");
                          return [line.slice(0, equals), line.slice(equals + 1)];
                        }),
                    );
                  }),
                );
              });
              const foreign = yield* spawner.spawn(
                ChildProcess.make(
                  "/usr/bin/systemd-run",
                  [
                    "--user",
                    "--wait",
                    "--pipe",
                    "--quiet",
                    `--unit=${allocation.unit}`,
                    `--description=${sameDescription ? `T3 Pi managed ${allocation.nonce}` : "Captured collision control"}`,
                    "-p",
                    "MemoryMax=536870912",
                    "-p",
                    "MemorySwapMax=0",
                    "-p",
                    "OOMPolicy=kill",
                    "-p",
                    "KillMode=control-group",
                    "-p",
                    "RuntimeMaxSec=15s",
                    "-p",
                    "TimeoutStopSec=2s",
                    "/usr/bin/bash",
                    "-c",
                    "printf foreign-ready; IFS= read -r value; printf foreign-survived",
                  ],
                  { env, extendEnv: false, shell: false },
                ),
              );
              const ready = yield* Deferred.make<void>();
              const reader = yield* foreign.stdout.pipe(
                Stream.tap(() => Deferred.succeed(ready, undefined)),
                Stream.decodeText(),
                Stream.runCollect,
                Effect.forkChild,
              );
              yield* Deferred.await(ready).pipe(Effect.timeout("3 seconds"));
              const before = yield* show();
              let owners = 0;
              let acquireErrorPhase: PiManagedProcessError["phase"] | null = null;
              let launcherPid: number | null = null;
              let launcherExit = Effect.succeed(-1);
              const observed = ChildProcessSpawner.make((command) =>
                spawner.spawn(command).pipe(
                  Effect.tap((handle) =>
                    Effect.sync(() => {
                      if (
                        command._tag === "StandardCommand" &&
                        command.command === "/usr/bin/systemd-run"
                      ) {
                        launcherPid = Number(handle.pid);
                        launcherExit = handle.exitCode.pipe(Effect.map(Number), Effect.orDie);
                      }
                    }),
                  ),
                ),
              );
              const result = yield* Effect.scoped(
                acquirePiManagedProcess(launch, {
                  allocation,
                  claimActivation: () => Effect.void,
                  beforeStart: () =>
                    Effect.sync(() => {
                      owners++;
                    }),
                }).pipe(
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      acquireErrorPhase = error.phase;
                    }),
                  ),
                ),
              ).pipe(Effect.exit);
              const after = yield* show();
              const capturedLauncherExit = yield* launcherExit;
              if (after.ActiveState === "active")
                yield* Stream.make(Buffer.from("release\n")).pipe(Stream.run(foreign.stdin));
              const foreignExit = Number(yield* foreign.exitCode);
              const output = Array.from(yield* Fiber.join(reader)).join("");
              const final = yield* show();
              if (directory)
                yield* Effect.promise(() =>
                  NodeFSP.writeFile(
                    NodePath.join(
                      directory,
                      `collision-${sameDescription ? "same" : "different"}.json`,
                    ),
                    encodeEvidence({
                      unit: allocation.unit,
                      foreignLauncherPid: Number(foreign.pid),
                      launcherPid,
                      capturedLauncherExit,
                      before,
                      after,
                      final,
                      owners,
                      acquireErrorPhase,
                      result: result._tag,
                      cause: result._tag === "Failure" ? Cause.pretty(result.cause) : "",
                      foreignExit,
                      output,
                    }),
                  ),
                );
              expect(owners).toBe(0);
              expect(result._tag).toBe("Failure");
              if (sameDescription) expect(acquireErrorPhase).toBe("quarantine");
              expect(capturedLauncherExit).not.toBe(0);
              expect(launcherPid).toBeGreaterThan(0);
              expect(after.ActiveState).toBe("active");
              expect(after.InvocationID).toBe(before.InvocationID);
              expect(after.ControlGroup).toBe(before.ControlGroup);
              expect(foreignExit).toBe(0);
              expect(output).toBe("foreign-readyforeign-survived");
              expect(final.LoadState).toBe("not-found");
              yield* absent(`/sys/fs/cgroup${before.ControlGroup}`);
              yield* absent(NodePath.join(input.workspaceRoot, "collision-proof"));
            }),
          ),
      );
    for (const cancel of [false, true])
      check(
        `uncaptured helper ownership drains through actual launcher EOF on ${cancel ? "cancellation" : "startup failure"} without START`,
        () =>
          Effect.gen(function* () {
            const launch = yield* runtimeLaunch([
              "/bin/bash",
              "-c",
              "printf forbidden > /workspace/withheld-owner-proof",
            ]);
            const allocation = yield* preallocatePiManagedProcess(launch);
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const receipt = yield* Deferred.make<{
              unit: string;
              nonce: string;
              invocation: string;
              cgroup: string;
            }>();
            let pending = Buffer.alloc(0);
            let captured = false;
            let launcherPid: number | null = null;
            let launcherExit = Effect.succeed(-1);
            let owners = 0;
            let stops = 0;
            let errorPhase: PiManagedProcessError["phase"] | null = null;
            const observed = ChildProcessSpawner.make((command) => {
              if (
                command._tag === "StandardCommand" &&
                command.command === "/usr/bin/systemctl" &&
                command.args.includes("stop") &&
                command.args.includes(allocation.unit)
              )
                stops++;
              if (command._tag !== "StandardCommand" || command.command !== "/usr/bin/systemd-run")
                return spawner.spawn(command);
              return spawner.spawn(command).pipe(
                Effect.map((handle) => {
                  launcherPid = Number(handle.pid);
                  launcherExit = handle.exitCode.pipe(Effect.map(Number), Effect.orDie);
                  return ChildProcessSpawner.makeHandle({
                    ...handle,
                    stdout: handle.stdout.pipe(
                      Stream.tap((chunk) =>
                        Effect.gen(function* () {
                          if (captured) return;
                          if (pending.byteLength + chunk.byteLength > 65536)
                            return yield* Effect.die("Withheld owner fixture exceeded frame bound");
                          pending = Buffer.concat([pending, chunk]);
                          const newline = pending.indexOf(10);
                          if (newline < 0) return;
                          const owner = yield* decodeWithheldOwner(
                            pending.subarray(0, newline).toString("utf8"),
                          ).pipe(Effect.orDie);
                          expect(owner.unit).toBe(allocation.unit);
                          expect(owner.nonce).toBe(allocation.nonce);
                          expect(owner.cgroup.endsWith(`/${allocation.unit}`)).toBe(true);
                          captured = true;
                          pending = Buffer.alloc(0);
                          yield* Deferred.succeed(receipt, owner);
                        }),
                      ),
                      Stream.filter(() => false),
                    ),
                  });
                }),
              );
            });
            const acquisition = Effect.scoped(
              acquirePiManagedProcess(launch, {
                allocation,
                claimActivation: () => Effect.void,
                beforeStart: () =>
                  Effect.sync(() => {
                    owners++;
                  }),
              }).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    errorPhase = error.phase;
                  }),
                ),
              ),
            );
            const fiber = yield* acquisition.pipe(Effect.forkChild);
            if (cancel) {
              yield* Deferred.await(receipt).pipe(Effect.timeout("3 seconds"));
              yield* Fiber.interrupt(fiber);
            }
            const result = yield* Fiber.await(fiber);
            const helper = yield* Deferred.await(receipt).pipe(Effect.timeout("1 second"));
            const groupExists = yield* Effect.promise(() =>
              NodeFSP.stat(helper.cgroup).then(
                () => true,
                () => false,
              ),
            );
            const launcherResult = yield* launcherExit.pipe(Effect.exit);
            const code = launcherResult._tag === "Success" ? launcherResult.value : null;
            const scopeCause = result._tag === "Failure" ? Cause.pretty(result.cause) : "";
            const directory = process.env.PI_MANAGED_PROCESS_EVIDENCE_DIR;
            if (directory)
              yield* Effect.promise(async () => {
                await NodeFSP.mkdir(directory, { recursive: true });
                await NodeFSP.writeFile(
                  NodePath.join(
                    directory,
                    cancel ? "withheld-owner-cancel.json" : "withheld-owner-eof.json",
                  ),
                  encodeEvidence({
                    ...helper,
                    launcherPid,
                    launcherExit: code,
                    owners,
                    errorPhase,
                    groupExists,
                    stops,
                    scopeCause,
                    launcherCause:
                      launcherResult._tag === "Failure" ? Cause.pretty(launcherResult.cause) : "",
                    acquiredOwner: false,
                    result: result._tag,
                  }),
                );
              });
            expect(result._tag).toBe("Failure");
            expect(scopeCause).toContain("unit ownership remains unproved");
            if (!cancel) expect(errorPhase).toBe("quarantine");
            expect(groupExists).toBe(false);
            expect(owners).toBe(0);
            expect(stops).toBe(0);
            expect(code).toBe(0);
            expect(launcherPid).toBeGreaterThan(0);
            yield* absent(NodePath.join(input.workspaceRoot, "withheld-owner-proof"));
          }),
      );
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
    check("shutdown race drains a reader blocked by abandoned bounded output", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const full = yield* Deferred.make<void>();
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          let outputFrames = 0;
          const observed = ChildProcessSpawner.make((command) =>
            spawner.spawn(command).pipe(
              Effect.map((handle) =>
                command._tag !== "StandardCommand" || command.command !== "/usr/bin/systemd-run"
                  ? handle
                  : ChildProcessSpawner.makeHandle({
                      ...handle,
                      stdout: handle.stdout.pipe(
                        Stream.decodeText(),
                        Stream.splitLines,
                        Stream.mapEffect((line) =>
                          Effect.gen(function* () {
                            // The first output frame is consumed readiness; the next 32 fill the queue.
                            if (line.includes('"type":"stdout"') && ++outputFrames === 34)
                              yield* Deferred.succeed(full, undefined);
                            return Buffer.from(line + "\n");
                          }),
                        ),
                      ),
                    }),
              ),
            ),
          );
          const child = yield* acquire([
            "/bin/bash",
            "-c",
            "printf ready; IFS= read -r value; printf '%1048576s' x; while :; do :; done",
          ]).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed));
          yield* child.start;
          const ready = yield* child.stdout.pipe(Stream.take(1), Stream.runCollect);
          expect(Buffer.concat(Array.from(ready)).toString()).toBe("ready");
          yield* child.send(Buffer.from("output\n"));
          yield* Deferred.await(full).pipe(Effect.timeout("3 seconds"));
          // Let the forwarded frame reach its bounded offer before requesting shutdown.
          yield* Effect.yieldNow;
          const drain = yield* child.stop;
          expect(drain.kernel).toMatch(/removed|populated 0/);
          expect(drain.childPid).toBeGreaterThan(0);
          expect(drain.childExitCode).toBeNull();
          yield* child.stdout.pipe(Stream.runDrain);
          yield* absent(child.owner.cgroup);
        }),
      ),
    );
    for (const [cancel, corruption] of [
      [false, null],
      [true, null],
      [false, "base64"],
      [false, "frame"],
      [false, "start"],
    ] as const)
      check(
        `shutdown race ${corruption ? `rejects ${corruption} corruption` : `drains held actual post-START output and exit on ${cancel ? "cancellation" : "stop"}`}`,
        () =>
          Effect.gen(function* () {
            const buffered = yield* Deferred.make<Buffer>();
            const release = yield* Deferred.make<void>();
            const ready = yield* Deferred.make<PiManagedProcess>();
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            let hold = false;
            let shutdownExpected = false;
            let pending = Buffer.alloc(0);
            let drain: PiManagedDrain | undefined;
            const observed = ChildProcessSpawner.make((command) => {
              if (
                shutdownExpected &&
                command._tag === "StandardCommand" &&
                command.command === "/usr/bin/systemctl" &&
                command.args.includes("show")
              )
                return Deferred.succeed(release, undefined).pipe(
                  Effect.andThen(spawner.spawn(command)),
                );
              return spawner.spawn(command).pipe(
                Effect.map((handle) =>
                  command._tag !== "StandardCommand" || command.command !== "/usr/bin/systemd-run"
                    ? handle
                    : ChildProcessSpawner.makeHandle({
                        ...handle,
                        stdout: handle.stdout.pipe(
                          Stream.mapEffect((chunk) =>
                            Effect.gen(function* () {
                              if (!hold) return chunk;
                              if (pending.byteLength + chunk.byteLength > 65536)
                                return yield* Effect.die(
                                  "Held shutdown frames exceeded fixture bound",
                                );
                              pending = Buffer.concat([pending, chunk]);
                              if (!pending.includes('"type":"exited"') || pending.at(-1) !== 10)
                                return Buffer.alloc(0);
                              const bytes = pending;
                              pending = Buffer.alloc(0);
                              yield* Deferred.succeed(buffered, bytes);
                              yield* Deferred.await(release);
                              hold = false;
                              if (corruption === "base64")
                                return Buffer.from(
                                  bytes.toString().replace(/"data":"[^"]*"/, '"data":"bad"'),
                                );
                              if (corruption === "frame")
                                return Buffer.concat([
                                  Buffer.alloc(65537, 120),
                                  Buffer.from("\n"),
                                  bytes,
                                ]);
                              if (corruption === "start")
                                return Buffer.concat([
                                  Buffer.from(encodeEvidence({ type: "started", pid: 1 }) + "\n"),
                                  bytes,
                                ]);
                              return bytes;
                            }),
                          ),
                        ),
                      }),
                ),
              );
            });
            const running = yield* Effect.scoped(
              Effect.gen(function* () {
                const child = yield* acquire([
                  "/bin/bash",
                  "--noprofile",
                  "--norc",
                  "-c",
                  `trap 'printf late-out; printf late-err >&2; exit 0' TERM; printf ready; IFS= read -r value; test "$value" = stop; kill -TERM $$; exit 9`,
                ]);
                yield* Effect.addFinalizer(() =>
                  child.stop.pipe(
                    Effect.tap((receipt) =>
                      Effect.sync(() => {
                        drain = receipt;
                      }),
                    ),
                    Effect.orDie,
                    Effect.asVoid,
                  ),
                );
                yield* child.start;
                const output = yield* child.stdout.pipe(Stream.take(1), Stream.runCollect);
                expect(Buffer.concat(Array.from(output)).toString()).toBe("ready");
                hold = true;
                yield* child.send(Buffer.from("stop\n"));
                yield* Deferred.succeed(ready, child);
                return yield* Effect.never;
              }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed)),
            ).pipe(Effect.forkChild);
            const child = yield* Deferred.await(ready);
            const bytes = yield* Deferred.await(buffered).pipe(Effect.timeout("3 seconds"));
            expect(bytes.toString()).toContain('"type":"stdout"');
            expect(bytes.toString()).toContain('"type":"stderr"');
            expect(bytes.toString()).toContain('"type":"exited","code":0');
            shutdownExpected = true;
            if (cancel) yield* Fiber.interrupt(running);
            else {
              drain = yield* child.stop;
              yield* Fiber.interrupt(running);
            }
            const result = yield* Fiber.await(running);
            const directory = process.env.PI_MANAGED_PROCESS_EVIDENCE_DIR;
            if (directory)
              yield* Effect.promise(() =>
                NodeFSP.writeFile(
                  NodePath.join(directory, child.owner.unit + ".shutdown-race.json"),
                  encodeEvidence({
                    cancel,
                    buffered: bytes.toString(),
                    drain,
                    result: result._tag,
                  }),
                ),
              );
            expect(result._tag).toBe("Failure");
            if (corruption) {
              const error = yield* child.stdout.pipe(Stream.runDrain, Effect.flip);
              expect(error.phase).toBe("transport");
              expect(error.message).toContain(
                corruption === "base64"
                  ? "byte framing bound"
                  : corruption === "frame"
                    ? "frame exceeds its byte bound"
                    : "Unexpected process start receipt",
              );
              expect(drain?.childExitCode).toBeNull();
              yield* absent(child.owner.cgroup);
              return;
            }
            const [out, err] = yield* Effect.all(
              [child.stdout.pipe(Stream.runCollect), child.stderr.pipe(Stream.runCollect)],
              { concurrency: "unbounded" },
            );
            expect(Array.from(out)).toEqual([]);
            expect(Array.from(err)).toEqual([]);
            expect(drain?.childExitCode).toBe(0);
            expect(drain?.childPid).toBeGreaterThan(0);
            expect(drain?.kernel).toMatch(/removed|populated 0/);
            yield* absent(child.owner.cgroup);
            yield* absent(`/proc/${child.owner.pid}`);
            yield* absent(`/proc/${drain!.childPid}`);
          }),
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
