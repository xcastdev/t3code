import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ManagedSkillId,
  ManagedSkillKey,
  ManagedSkillManifest,
  SkillContentHash,
} from "@t3tools/contracts";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { hashSkillPackage, writeSkillPackageContents } from "../../skills/SkillPackage.ts";
import { preparePiSkillResources } from "./PiSkillResources.ts";
import { makePiSkillStageLifetime } from "./PiSkillStageLifetime.ts";
import { vi } from "vite-plus/test";

const native = process.getBuiltinModule("fs").promises;
const decodeKey = Schema.decodeUnknownSync(ManagedSkillKey);
const decodeId = Schema.decodeUnknownSync(ManagedSkillId);
const decodeHash = Schema.decodeUnknownSync(SkillContentHash);
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(ManagedSkillManifest));

// Test cleanup owns only its disposable root, including intentionally retained sealed trees.
const fixture = Effect.fn("PiSkillStageLifetime.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pi-skill-lifetime-" });
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      const writable = async (directory: string): Promise<void> => {
        await native.chmod(directory, 0o700);
        for (const entry of await native.readdir(directory, { withFileTypes: true }))
          if (entry.isDirectory()) await writable(directory + "/" + entry.name);
      };
      await writable(root);
    }),
  );
  const cache = root + "/cache";
  const protectedRoot = root + "/userdata";
  const workspace = root + "/workspace";
  for (const directory of [cache, protectedRoot, workspace])
    yield* Effect.promise(() => native.mkdir(directory, { mode: 0o700 }));
  yield* fs.writeFileString(cache + "/sibling", "sibling bytes");
  return { fs, root, cache, protectedRoot, workspace };
});

const populated = Effect.fn("PiSkillStageLifetime.populated")(function* () {
  const f = yield* fixture();
  const stage = yield* makePiSkillStageLifetime(f.cache);
  const key = decodeKey("selected");
  const source = f.protectedRoot + "/selected";
  const manifest = {
    schemaVersion: 1 as const,
    kind: "managed-skill" as const,
    id: decodeId("lifetime-selected"),
    key,
    scope: "global" as const,
    revision: { revision: 1, hash: decodeHash("a".repeat(64)) },
    origin: "created" as const,
    ownership: "t3" as const,
  };
  yield* writeSkillPackageContents({
    packagePath: source,
    manifest,
    content: { key, name: "Read the fixture", body: "Read [notes](assets/deep/notes.txt)." },
  });
  yield* f.fs.makeDirectory(source + "/assets/deep", { recursive: true });
  yield* f.fs.writeFileString(source + "/assets/deep/notes.txt", "owned asset bytes");
  const expectedHash = yield* hashSkillPackage(source);
  yield* f.fs.writeFileString(
    source + "/t3-skill.json",
    encodeManifest({ ...manifest, revision: { revision: 1, hash: expectedHash } }),
  );
  const prepared = yield* preparePiSkillResources({
    selection: [{ key, packagePath: source, expectedHash }],
    stagingRoot: stage.stagingRoot,
    stagingDirectory: stage.stagingDirectory,
    existingRuntimeFiles: [],
    protectedRoots: [f.protectedRoot],
    writableRoots: [f.workspace],
  });
  yield* prepared.revalidate;
  return { ...f, stage, source, prepared };
});

function denied(
  result: Result.Result<unknown, { readonly _tag: string; readonly detail: string }>,
) {
  assert.isTrue(Result.isFailure(result));
  if (Result.isFailure(result)) assert.equal(result.failure._tag, "PiManagedRuntimeError");
}

function observeDescriptors(
  onClose: (entry: string) => Promise<void> = async () => {},
  afterClose: (entry: string) => Promise<void> = async () => {},
) {
  const original = native.open.bind(native);
  const active = new Set<number>();
  const spy = vi.spyOn(native, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    const fd = handle.fd;
    const entry = await native.realpath("/proc/self/fd/" + fd);
    active.add(fd);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await onClose(entry);
      await close();
      active.delete(fd);
      await afterClose(entry);
    };
    return handle;
  });
  return { active, spy };
}

describe("PiSkillStageLifetime", () => {
  it.layer(NodeServices.layer)("owned native filesystem lifetime", (it) => {
    it.effect("allocates unique empty private stages and removes only the owned empty stage", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = yield* makePiSkillStageLifetime(f.cache);
        const second = yield* makePiSkillStageLifetime(f.cache);
        assert.notEqual(first.stagingDirectory, second.stagingDirectory);
        assert.equal(first.stagingRoot, f.cache);
        assert.deepEqual(yield* f.fs.readDirectory(first.stagingDirectory), []);
        assert.equal(
          (yield* Effect.promise(() => native.lstat(first.stagingDirectory))).mode & 0o7777,
          0o700,
        );
        yield* first.remove();
        yield* first.remove();
        denied(yield* first.retain().pipe(Effect.result));
        assert.isFalse(yield* f.fs.exists(first.stagingDirectory));
        assert.isTrue(yield* f.fs.exists(second.stagingDirectory));
        assert.equal(yield* f.fs.readFileString(f.cache + "/sibling"), "sibling bytes");
        yield* second.retain();
      }),
    );

    it.effect(
      "captures and removes the actual helper's sealed package tree while preserving its source",
      () =>
        Effect.gen(function* () {
          const f = yield* populated();
          const receipts = yield* f.stage.captureSealedTree(f.prepared.runtimeFiles);
          assert.equal(receipts.length, 3);
          assert.isTrue(Object.isFrozen(receipts));
          for (const receipt of receipts) {
            const info = yield* Effect.promise(() => native.lstat(receipt.source));
            assert.equal(receipt.dev, info.dev);
            assert.equal(receipt.ino, info.ino);
            assert.isTrue(Object.isFrozen(receipt));
          }
          yield* f.stage.remove();
          assert.isFalse(yield* f.fs.exists(f.stage.stagingDirectory));
          assert.equal(
            yield* f.fs.readFileString(f.source + "/assets/deep/notes.txt"),
            "owned asset bytes",
          );
          assert.equal(yield* f.fs.readFileString(f.cache + "/sibling"), "sibling bytes");
        }),
    );

    it.effect("retain keeps captured bytes and rejects a later removal", () =>
      Effect.gen(function* () {
        const f = yield* populated();
        yield* f.stage.captureSealedTree(f.prepared.runtimeFiles);
        yield* f.stage.retain();
        yield* f.stage.retain();
        denied(yield* f.stage.remove().pipe(Effect.result));
        assert.equal(
          yield* f.fs.readFileString(f.stage.stagingDirectory + "/selected/assets/deep/notes.txt"),
          "owned asset bytes",
        );
      }),
    );

    it.effect("scope fallback retains an uncaptured populated tree", () =>
      Effect.gen(function* () {
        const outer = yield* fixture();
        const directory = yield* Effect.scoped(
          Effect.gen(function* () {
            const stage = yield* makePiSkillStageLifetime(outer.cache);
            yield* outer.fs.writeFileString(
              stage.stagingDirectory + "/preserved",
              "uncertain bytes",
            );
            return stage.stagingDirectory;
          }),
        );
        assert.equal(yield* outer.fs.readFileString(directory + "/preserved"), "uncertain bytes");
      }),
    );

    it.effect("denies removal of a populated stage without a captured sealed tree", () =>
      Effect.gen(function* () {
        const f = yield* populated();
        denied(yield* f.stage.remove().pipe(Effect.result));
        assert.equal(
          yield* f.fs.readFileString(f.stage.stagingDirectory + "/selected/assets/deep/notes.txt"),
          "owned asset bytes",
        );
      }),
    );

    it.effect(
      "denies changed stage paths, stage modes and unlisted descendants without deleting bytes",
      () =>
        Effect.gen(function* () {
          for (const change of ["replacement", "symlink", "mode", "foreign"] as const) {
            const f = yield* populated();
            yield* f.stage.captureSealedTree(f.prepared.runtimeFiles);
            const stage = f.stage.stagingDirectory;
            if (change === "replacement" || change === "symlink") {
              yield* Effect.promise(() => native.rename(stage, stage + "-original"));
              if (change === "replacement") {
                yield* Effect.promise(() => native.mkdir(stage, { mode: 0o500 }));
              } else yield* Effect.promise(() => native.symlink(stage + "-original", stage));
            } else {
              yield* Effect.promise(() => native.chmod(stage, 0o700));
              if (change === "foreign") {
                yield* f.fs.writeFileString(stage + "/foreign", "foreign bytes");
                yield* Effect.promise(() => native.chmod(stage, 0o500));
              }
            }
            denied(yield* f.stage.remove().pipe(Effect.result));
            const original =
              change === "replacement" || change === "symlink" ? stage + "-original" : stage;
            assert.equal(
              yield* f.fs.readFileString(original + "/selected/assets/deep/notes.txt"),
              "owned asset bytes",
            );
            assert.equal(yield* f.fs.readFileString(f.cache + "/sibling"), "sibling bytes");
          }
        }),
    );

    it.effect("denies an incomplete or duplicate launch file closure", () =>
      Effect.gen(function* () {
        for (const problem of ["missing", "duplicate"] as const) {
          const f = yield* populated();
          const files = f.prepared.runtimeFiles;
          denied(
            yield* f.stage
              .captureSealedTree(problem === "missing" ? files.slice(1) : [...files, files[0]!])
              .pipe(Effect.result),
          );
          assert.equal(
            yield* f.fs.readFileString(
              f.stage.stagingDirectory + "/selected/assets/deep/notes.txt",
            ),
            "owned asset bytes",
          );
        }
      }),
    );

    it.effect("fails closed before allocation for unsupported hosts and invalid cache roots", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const before = yield* f.fs.readDirectory(f.cache);
        denied(
          yield* makePiSkillStageLifetime(f.cache).pipe(
            Effect.provideService(HostProcessPlatform, "darwin"),
            Effect.result,
          ),
        );
        denied(
          yield* makePiSkillStageLifetime(f.cache).pipe(
            Effect.provideService(HostProcessUserId, undefined),
            Effect.result,
          ),
        );
        denied(yield* makePiSkillStageLifetime(f.root + "/missing").pipe(Effect.result));
        denied(yield* makePiSkillStageLifetime(f.cache + "/..").pipe(Effect.result));
        const alias = f.root + "/alias";
        yield* Effect.promise(() => native.symlink(f.cache, alias));
        denied(yield* makePiSkillStageLifetime(alias).pipe(Effect.result));
        yield* Effect.promise(() => native.chmod(f.cache, 0o755));
        denied(yield* makePiSkillStageLifetime(f.cache).pipe(Effect.result));
        assert.deepEqual(yield* f.fs.readDirectory(f.cache), before);
      }),
    );

    it.effect("retention and removal join every original descriptor close", () =>
      Effect.gen(function* () {
        for (const release of ["remove", "retain"] as const) {
          const observed = observeDescriptors();
          yield* Effect.addFinalizer(() => Effect.sync(() => observed.spy.mockRestore()));
          const f = yield* populated();
          yield* f.stage.captureSealedTree(f.prepared.runtimeFiles);
          assert.isAbove(observed.active.size, 0);
          yield* f.stage[release]();
          assert.equal(observed.active.size, 0);
          observed.spy.mockRestore();
        }
      }),
    );

    it.effect(
      "interruption while a close is held waits for the close receipt and preserves bytes",
      () =>
        Effect.gen(function* () {
          const f = yield* populated();
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          let held = false;
          const observed = observeDescriptors(async (entry) => {
            if (!held && entry.endsWith("/assets/deep/notes.txt")) {
              held = true;
              entered.resolve();
              await release.promise;
            }
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              release.resolve();
              observed.spy.mockRestore();
            }),
          );
          yield* f.stage.captureSealedTree(f.prepared.runtimeFiles);
          const retaining = yield* f.stage.retain().pipe(Effect.forkChild);
          yield* Effect.promise(() => entered.promise);
          const interrupted = yield* Fiber.interrupt(retaining).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.isAbove(observed.active.size, 0, "held native close has not finished");
          release.resolve();
          yield* Fiber.join(interrupted);
          assert.isTrue(Exit.isFailure(yield* Fiber.await(retaining)));
          assert.equal(observed.active.size, 0);
          assert.equal(
            yield* f.fs.readFileString(
              f.stage.stagingDirectory + "/selected/assets/deep/notes.txt",
            ),
            "owned asset bytes",
          );
        }),
    );

    it.effect(
      "interrupted capture retains the tree and closes descriptors after its native inspection joins",
      () =>
        Effect.gen(function* () {
          const f = yield* populated();
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          const observed = observeDescriptors();
          const original = native.opendir.bind(native);
          let held = false;
          const inspection = vi.spyOn(native, "opendir").mockImplementation(async (...args) => {
            const value = await original(...args);
            if (
              !held &&
              (await native.realpath(args[0])) ===
                f.stage.stagingDirectory + "/selected/assets/deep"
            ) {
              held = true;
              entered.resolve();
              await release.promise;
            }
            return value;
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              release.resolve();
              inspection.mockRestore();
              observed.spy.mockRestore();
            }),
          );
          const capture = yield* f.stage
            .captureSealedTree(f.prepared.runtimeFiles)
            .pipe(Effect.forkChild);
          yield* Effect.promise(() => entered.promise);
          const interrupted = yield* Fiber.interrupt(capture).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          release.resolve();
          yield* Fiber.join(interrupted);
          assert.isTrue(Exit.isFailure(yield* Fiber.await(capture)));
          assert.equal(observed.active.size, 0);
          denied(yield* f.stage.remove().pipe(Effect.result));
          assert.equal(
            yield* f.fs.readFileString(
              f.stage.stagingDirectory + "/selected/assets/deep/notes.txt",
            ),
            "owned asset bytes",
          );
        }),
    );

    it.effect(
      "denies changed captured children and cache ancestors before removing any owned file",
      () =>
        Effect.gen(function* () {
          for (const change of [
            "file-mode",
            "file-replacement",
            "file-symlink",
            "directory-mode",
            "cache-mode",
            "ancestor-mode",
            "cache-replacement",
          ] as const) {
            const f = yield* populated();
            yield* f.stage.captureSealedTree(f.prepared.runtimeFiles);
            const asset = f.stage.stagingDirectory + "/selected/assets/deep/notes.txt";
            if (change === "file-mode") yield* Effect.promise(() => native.chmod(asset, 0o600));
            if (change === "file-replacement" || change === "file-symlink") {
              yield* Effect.promise(() =>
                native.chmod(f.stage.stagingDirectory + "/selected/assets/deep", 0o700),
              );
              yield* Effect.promise(() => native.rename(asset, f.root + "/original-asset"));
              if (change === "file-replacement") {
                yield* f.fs.writeFileString(asset, "replacement bytes");
                yield* Effect.promise(() => native.chmod(asset, 0o400));
              } else yield* Effect.promise(() => native.symlink(f.root + "/original-asset", asset));
              yield* Effect.promise(() =>
                native.chmod(f.stage.stagingDirectory + "/selected/assets/deep", 0o500),
              );
            }
            if (change === "directory-mode")
              yield* Effect.promise(() =>
                native.chmod(f.stage.stagingDirectory + "/selected/assets", 0o700),
              );
            if (change === "cache-mode") yield* Effect.promise(() => native.chmod(f.cache, 0o755));
            if (change === "ancestor-mode")
              yield* Effect.promise(() => native.chmod(f.root, 0o755));
            if (change === "cache-replacement") {
              yield* Effect.promise(() => native.rename(f.cache, f.cache + "-original"));
              yield* Effect.promise(() => native.mkdir(f.cache, { mode: 0o700 }));
            }
            denied(yield* f.stage.remove().pipe(Effect.result));
            const preserved =
              change === "cache-replacement"
                ? f.cache + "-original/" + f.stage.stagingDirectory.slice(f.cache.length + 1)
                : f.stage.stagingDirectory;
            assert.equal(
              yield* f.fs.readFileString(preserved + "/selected/assets/deep/notes.txt"),
              change === "file-replacement" ? "replacement bytes" : "owned asset bytes",
            );
            assert.isTrue(yield* f.fs.exists(preserved + "/selected/SKILL.md"));
          }
        }),
    );

    it.effect("bounds native traversal, manifest sizes and total package bytes", () =>
      Effect.gen(function* () {
        for (const problem of ["entries", "manifest", "bytes"] as const) {
          const f = yield* populated();
          if (problem === "entries") {
            const selected = f.stage.stagingDirectory + "/selected";
            yield* Effect.promise(async () => {
              await native.chmod(selected, 0o700);
              for (let index = 0; index < 512; index++)
                await native.mkdir(selected + "/empty-" + index, { mode: 0o500 });
              await native.chmod(selected, 0o500);
            });
          } else {
            const file =
              f.stage.stagingDirectory +
              (problem === "manifest"
                ? "/selected/t3-skill.json"
                : "/selected/assets/deep/notes.txt");
            yield* Effect.promise(async () => {
              await native.chmod(file, 0o600);
              await native.truncate(file, problem === "manifest" ? 65_537 : 8_000_001);
              await native.chmod(file, 0o400);
            });
          }
          denied(yield* f.stage.captureSealedTree(f.prepared.runtimeFiles).pipe(Effect.result));
          assert.isTrue(yield* f.fs.exists(f.stage.stagingDirectory + "/selected/SKILL.md"));
        }
      }),
    );

    it.effect("joins actual handles on a failed capture and on scope failure", () =>
      Effect.gen(function* () {
        const outer = yield* fixture();
        for (const failure of ["capture", "scope", "defect"] as const) {
          const observed = observeDescriptors();
          yield* Effect.addFinalizer(() => Effect.sync(() => observed.spy.mockRestore()));
          const ended = yield* Effect.scoped(
            Effect.gen(function* () {
              const stage = yield* makePiSkillStageLifetime(outer.cache);
              yield* outer.fs.writeFileString(
                stage.stagingDirectory + "/foreign",
                "retained bytes",
              );
              if (failure === "capture")
                denied(yield* stage.captureSealedTree([]).pipe(Effect.result));
              if (failure === "defect") return yield* Effect.die("scope defect");
              return yield* Effect.fail("scope failed");
            }),
          ).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(ended));
          assert.equal(observed.active.size, 0);
          observed.spy.mockRestore();
        }
      }),
    );

    it.effect(
      "reports uncertain close instead of successful retention while joining every other handle",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          let uncertain = false;
          const observed = observeDescriptors(undefined, async (entry) => {
            if (!uncertain && entry.startsWith(f.cache + "/")) {
              uncertain = true;
              throw new Error("native close receipt unavailable");
            }
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => observed.spy.mockRestore()));
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const stage = yield* makePiSkillStageLifetime(f.cache);
              yield* f.fs.writeFileString(stage.stagingDirectory + "/preserved", "uncertain bytes");
              denied(yield* stage.retain().pipe(Effect.result));
              denied(yield* stage.retain().pipe(Effect.result));
              assert.equal(
                yield* f.fs.readFileString(stage.stagingDirectory + "/preserved"),
                "uncertain bytes",
              );
            }),
          ).pipe(Effect.exit);
          assert.isTrue(uncertain);
          assert.isTrue(Exit.isFailure(result), "scope surfaces uncertain descriptor closure");
          assert.equal(observed.active.size, 0);
        }),
    );

    it.effect("refuses an empty stage whose creation receipt changed", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const stage = yield* makePiSkillStageLifetime(f.cache);
        yield* Effect.promise(() => native.chmod(stage.stagingDirectory, 0o500));
        yield* Effect.promise(() => native.chmod(stage.stagingDirectory, 0o700));
        denied(yield* stage.remove().pipe(Effect.result));
        assert.isTrue(yield* f.fs.exists(stage.stagingDirectory));
      }),
    );

    it.effect("refuses an unlisted sealed empty package before capture", () =>
      Effect.gen(function* () {
        const f = yield* populated();
        yield* Effect.promise(async () => {
          await native.chmod(f.stage.stagingDirectory, 0o700);
          await native.mkdir(f.stage.stagingDirectory + "/unlisted", { mode: 0o500 });
          await native.chmod(f.stage.stagingDirectory, 0o500);
        });
        denied(yield* f.stage.captureSealedTree(f.prepared.runtimeFiles).pipe(Effect.result));
        assert.equal(
          yield* f.fs.readFileString(f.stage.stagingDirectory + "/selected/assets/deep/notes.txt"),
          "owned asset bytes",
        );
        assert.isTrue(yield* f.fs.exists(f.stage.stagingDirectory + "/unlisted"));
      }),
    );
  });
});
