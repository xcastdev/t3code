import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ManagedSkillId,
  ManagedSkillKey,
  ManagedSkillManifest,
  SkillContentHash,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { hashSkillPackage, writeSkillPackageContents } from "../../skills/SkillPackage.ts";
import { preparePiSkillResources } from "./PiSkillResources.ts";

const native = process.getBuiltinModule("fs").promises;
const decodeKey = Schema.decodeUnknownSync(ManagedSkillKey);
const decodeId = Schema.decodeUnknownSync(ManagedSkillId);
const decodeHash = Schema.decodeUnknownSync(SkillContentHash);
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(ManagedSkillManifest));
const fixture = Effect.fn("PiSkillResources.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pi-selected-skills-" });
  const protectedRoot = path.join(root, "userdata");
  const writableRoot = path.join(root, "workspace");
  const source = path.join(protectedRoot, "selected");
  const cache = path.join(root, "native-cache");
  yield* fs.makeDirectory(writableRoot);
  yield* fs.makeDirectory(cache);
  yield* Effect.promise(() => native.chmod(cache, 0o700));
  const key = decodeKey("selected");
  const manifest = {
    schemaVersion: 1 as const,
    kind: "managed-skill" as const,
    id: decodeId("id-selected"),
    key,
    scope: "global" as const,
    revision: { revision: 1, hash: decodeHash("a".repeat(64)) },
    origin: "created" as const,
    ownership: "t3" as const,
  };
  yield* writeSkillPackageContents({
    packagePath: source,
    manifest,
    content: { key, name: "Read the selected fixture", body: "Use [asset](assets/notes.txt)." },
  });
  yield* fs.makeDirectory(path.join(source, "assets"));
  yield* fs.writeFileString(path.join(source, "assets/notes.txt"), "authorized asset");
  const expectedHash = yield* hashSkillPackage(source);
  yield* fs.writeFileString(
    path.join(source, "t3-skill.json"),
    encodeManifest({ ...manifest, revision: { revision: 1, hash: expectedHash } }),
  );
  const stage = path.join(cache, "stage");
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const directory of [
        stage,
        stage + "/selected",
        stage + "/selected/assets",
        stage + "-original",
        stage + "-original/selected",
        stage + "-original/selected/assets",
      ]) {
        try {
          await native.chmod(directory, 0o700);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }),
  );
  yield* fs.makeDirectory(stage);
  yield* Effect.promise(() => native.chmod(stage, 0o700));
  return {
    root,
    source,
    stage,
    key,
    expectedHash,
    manifest,
    options: {
      selection: [{ key, packagePath: source, expectedHash }],
      stagingRoot: cache,
      stagingDirectory: stage,
      existingRuntimeFiles: [],
      protectedRoots: [protectedRoot],
      writableRoots: [writableRoot],
    },
  };
});

type NativeHandle = Awaited<ReturnType<typeof native.open>>;
function observeDescriptors(
  onOpen: (
    handle: NativeHandle,
    entry: string,
    flags: number | string | undefined,
  ) => Promise<void>,
) {
  const open = native.open.bind(native);
  const active = new Set<number>();
  const spy = vi.spyOn(native, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const fd = handle.fd;
    active.add(fd);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      active.delete(fd);
    };
    await onOpen(handle, String(args[0]), args[1]);
    return handle;
  });
  return { spy, active };
}

function denied(result: Result.Result<unknown, { detail: string }>, detail: RegExp) {
  assert.isTrue(Result.isFailure(result));
  if (Result.isFailure(result)) assert.match(result.failure.detail, detail);
}

describe("PiSkillResources", () => {
  it.layer(NodeServices.layer)("selected immutable resources", (it) => {
    it.effect(
      "copies a real managed package and assets without mounting its protected source",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const f = yield* fixture();
          const before = yield* fs.readFileString(f.source + "/SKILL.md");
          const prepared = yield* preparePiSkillResources(f.options);
          assert.equal(prepared.resources.skills[0]?.description, "Read the selected fixture");
          assert.equal(prepared.resources.skills[0]?.path, "/runtime/skills/selected/SKILL.md");
          assert.equal(prepared.runtimeFiles.length, 3);
          for (const file of prepared.runtimeFiles) {
            assert.isTrue(file.source.startsWith(f.stage + "/"));
            assert.isFalse(file.source.startsWith(f.source + "/"));
            const stat = yield* Effect.promise(() => native.lstat(file.source));
            assert.equal(stat.mode & 0o777, 0o400);
            assert.equal(stat.nlink, 1);
          }
          assert.equal(
            yield* fs.readFileString(
              prepared.runtimeFiles.find((f) => f.target.endsWith("notes.txt"))!.source,
            ),
            "authorized asset",
          );
          assert.equal(yield* hashSkillPackage(f.stage + "/selected"), f.expectedHash);
          assert.equal(yield* fs.readFileString(f.source + "/SKILL.md"), before);
          yield* prepared.revalidate;
        }),
    );
    it.effect("denies a selected hash mismatch", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        denied(
          yield* preparePiSkillResources({
            ...f.options,
            selection: [{ ...f.options.selection[0]!, expectedHash: decodeHash("b".repeat(64)) }],
          }).pipe(Effect.result),
          /hash/i,
        );
      }),
    );
    for (const count of [129, 253, 254])
      it.effect(`selected skills obey the combined bound with ${count} runtime files`, () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const f = yield* fixture();
          const runtime = f.root + "/runtime-inputs";
          yield* fs.makeDirectory(runtime);
          const existingRuntimeFiles = yield* Effect.forEach(
            Array.from({ length: count }, (_, index) => index),
            (index) =>
              Effect.gen(function* () {
                const source = runtime + "/" + index;
                yield* fs.writeFileString(source, "fixed runtime fixture");
                return { source, target: "/runtime/fixed/" + index };
              }),
          );
          const preparation = preparePiSkillResources({ ...f.options, existingRuntimeFiles });
          if (count === 254) {
            denied(yield* preparation.pipe(Effect.result), /combined file bound/);
            assert.deepEqual(yield* fs.readDirectory(f.stage), []);
            return;
          }
          const prepared = yield* preparation;
          assert.equal(prepared.runtimeFiles.length, 3);
          yield* prepared.revalidate;
        }),
      );

    it.effect("preserves the 128-file bound for selected resources", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* fixture();
        for (let index = 0; index < 126; index++)
          yield* fs.writeFileString(f.source + `/assets/extra-${index}.txt`, "bounded fixture");
        const expectedHash = yield* hashSkillPackage(f.source);
        denied(
          yield* preparePiSkillResources({
            ...f.options,
            selection: [{ ...f.options.selection[0]!, expectedHash }],
          }).pipe(Effect.result),
          /combined file bound/,
        );
        assert.deepEqual(yield* fs.readDirectory(f.stage), []);
      }),
    );

    it.effect("empty selection touches no filesystem or unavailable platform", () =>
      Effect.gen(function* () {
        const prepared = yield* preparePiSkillResources({
          selection: [],
          stagingRoot: "/missing",
          stagingDirectory: "/missing/stage",
          existingRuntimeFiles: [],
          protectedRoots: ["/missing"],
          writableRoots: [],
        }).pipe(Effect.provideService(HostProcessPlatform, "win32"));
        assert.deepEqual(prepared.runtimeFiles, []);
        assert.deepEqual(prepared.resources, { skills: [] });
        yield* prepared.revalidate;
      }),
    );
    it.effect("nonempty selection reports unsupported descriptor platforms", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* preparePiSkillResources(f.options).pipe(
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.result,
        );
        denied(result, /Linux/);
        if (Result.isFailure(result)) assert.equal(result.failure.code, "unavailable");
      }),
    );
    it.effect("rejects duplicate keys and overlapping runtime targets before copying", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* fixture();
        denied(
          yield* preparePiSkillResources({
            ...f.options,
            selection: [...f.options.selection, ...f.options.selection],
          }).pipe(Effect.result),
          /duplicated/,
        );
        assert.deepEqual(yield* fs.readDirectory(f.stage), []);
        const runtime = f.root + "/worker";
        yield* fs.writeFileString(runtime, "worker");
        denied(
          yield* preparePiSkillResources({
            ...f.options,
            existingRuntimeFiles: [{ source: runtime, target: "/runtime/skills/selected" }],
          }).pipe(Effect.result),
          /target.*overlap/,
        );
        assert.deepEqual(yield* fs.readDirectory(f.stage), []);
      }),
    );
    it.effect("refuses source symlinks and hardlinks without altering protected source", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const link of ["symlink", "hardlink"] as const) {
          const f = yield* fixture();
          const asset = f.source + "/assets/notes.txt";
          const outside = f.root + "/outside";
          yield* fs.writeFileString(outside, "outside secret");
          yield* fs.remove(asset);
          yield* Effect.promise(() =>
            link === "symlink" ? native.symlink(outside, asset) : native.link(outside, asset),
          );
          denied(
            yield* preparePiSkillResources(f.options).pipe(Effect.result),
            /single-link|symlink|identity/,
          );
          assert.equal(yield* fs.readFileString(outside), "outside secret");
          assert.deepEqual(yield* fs.readDirectory(f.stage), []);
        }
      }),
    );
    it.effect("rejects a source entry replaced immediately before descriptor open", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* fixture();
        const source = f.source + "/assets/notes.txt";
        const outside = f.root + "/outside";
        yield* fs.writeFileString(outside, "protected outside bytes");
        const open = native.open.bind(native);
        let replaced = false;
        const spy = vi.spyOn(native, "open").mockImplementation(async (...args) => {
          if (!replaced && String(args[0]).endsWith("/notes.txt")) {
            replaced = true;
            await native.unlink(source);
            await native.symlink(outside, source);
          }
          return open(...args);
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        denied(yield* preparePiSkillResources(f.options).pipe(Effect.result), /identity|receipt/);
        assert.isTrue(replaced);
        assert.equal(yield* fs.readFileString(outside), "protected outside bytes");
        assert.deepEqual(yield* fs.readDirectory(f.stage), []);
      }),
    );
    it.effect("receipt boundary refuses replacement of the admitted empty stage before copy", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const admitted = yield* Effect.promise(() => native.stat(f.stage));
        let changed = false;
        const observed = observeDescriptors(async (_handle, entry, flags) => {
          if (
            !changed &&
            typeof flags === "number" &&
            (flags & process.getBuiltinModule("fs").constants.O_WRONLY) === 0 &&
            entry.endsWith("/notes.txt")
          ) {
            await native.rename(f.stage, f.stage + "-original");
            await native.mkdir(f.stage, { mode: 0o755 });
            changed = true;
          }
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => observed.spy.mockRestore()));
        const result = yield* preparePiSkillResources(f.options).pipe(Effect.result);
        assert.isTrue(changed);
        assert.equal(observed.active.size, 0, "all acquired descriptors drained");
        denied(result, /identity|receipt|changed/);
        const replacement = yield* Effect.promise(() => native.stat(f.stage));
        assert.notEqual(replacement.ino, admitted.ino);
        assert.equal(replacement.mode & 0o777, 0o755);
        assert.deepEqual(yield* Effect.promise(() => native.readdir(f.stage)), []);
        assert.deepEqual(yield* Effect.promise(() => native.readdir(f.stage + "-original")), []);
      }),
    );
    it.effect("receipt boundary refuses writable copied file after its seal chmod", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let changed = false;
        const observed = observeDescriptors(async (handle, entry, flags) => {
          if (
            typeof flags === "number" &&
            (flags & process.getBuiltinModule("fs").constants.O_WRONLY) !== 0 &&
            entry.endsWith("/notes.txt")
          ) {
            const chmod = handle.chmod.bind(handle);
            handle.chmod = async (mode) => {
              await chmod(mode);
              if (mode === 0o400) {
                await chmod(0o600);
                changed = true;
              }
            };
          }
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => observed.spy.mockRestore()));
        const result = yield* preparePiSkillResources(f.options).pipe(Effect.result);
        assert.isTrue(changed);
        assert.equal(observed.active.size, 0, "all acquired descriptors drained");
        denied(result, /identity|receipt|changed|mode/);
        assert.equal(
          (yield* Effect.promise(() => native.stat(f.stage + "/selected/assets/notes.txt"))).mode &
            0o777,
          0o600,
        );
        assert.equal(
          yield* Effect.promise(() => native.readFile(f.source + "/assets/notes.txt", "utf8")),
          "authorized asset",
        );
      }),
    );
    it.effect(
      "receipt boundary refuses an identical copied file replaced after creation closes",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          let createdInode: number | undefined;
          let replacementInode: number | undefined;
          const observed = observeDescriptors(async (handle, entry, flags) => {
            if (
              typeof flags === "number" &&
              (flags & process.getBuiltinModule("fs").constants.O_WRONLY) !== 0 &&
              entry.endsWith("/notes.txt")
            ) {
              const close = handle.close.bind(handle);
              handle.close = async () => {
                createdInode = (await handle.stat()).ino;
                await close();
                await native.rename(entry, f.root + "/copied-created");
                await native.writeFile(entry, "authorized asset", { mode: 0o400 });
                replacementInode = (await native.stat(entry)).ino;
              };
            }
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => observed.spy.mockRestore()));
          const result = yield* preparePiSkillResources(f.options).pipe(Effect.result);
          assert.isDefined(createdInode);
          assert.isDefined(replacementInode);
          assert.notEqual(createdInode, replacementInode);
          assert.equal(observed.active.size, 0, "all acquired descriptors drained");
          denied(result, /identity|receipt|changed/);
          assert.equal(
            yield* Effect.promise(() => native.readFile(f.source + "/assets/notes.txt", "utf8")),
            "authorized asset",
          );
        }),
    );
    it.effect("receipt boundary refuses writable copied directory after its seal chmod", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let changed = false;
        const observed = observeDescriptors(async (handle, _entry, flags) => {
          if (
            typeof flags === "number" &&
            (flags & process.getBuiltinModule("fs").constants.O_DIRECTORY) !== 0 &&
            (await native.realpath("/proc/self/fd/" + handle.fd)) === f.stage + "/selected/assets"
          ) {
            const chmod = handle.chmod.bind(handle);
            handle.chmod = async (mode) => {
              await chmod(mode);
              if (mode === 0o500) {
                await chmod(0o700);
                changed = true;
              }
            };
          }
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => observed.spy.mockRestore()));
        const result = yield* preparePiSkillResources(f.options).pipe(Effect.result);
        assert.isTrue(changed);
        assert.equal(observed.active.size, 0, "all acquired descriptors drained");
        denied(result, /identity|receipt|changed|mode/);
        assert.equal(
          (yield* Effect.promise(() => native.stat(f.stage + "/selected/assets"))).mode & 0o777,
          0o700,
        );
      }),
    );
    it.effect("refuses redirected source ancestors and writable aliases", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* fixture();
        const alias = f.root + "/alias";
        yield* Effect.promise(() => native.symlink(f.root + "/userdata", alias, "dir"));
        denied(
          yield* preparePiSkillResources({
            ...f.options,
            selection: [{ ...f.options.selection[0]!, packagePath: alias + "/selected" }],
          }).pipe(Effect.result),
          /symlink/,
        );
        denied(
          yield* preparePiSkillResources({ ...f.options, writableRoots: [alias] }).pipe(
            Effect.result,
          ),
          /overlap/,
        );
        assert.deepEqual(yield* fs.readDirectory(f.stage), []);
      }),
    );
    it.effect("rejects foreign, nonprivate and nonchild staging", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* fixture();
        yield* fs.writeFileString(f.stage + "/foreign", "preserved");
        denied(yield* preparePiSkillResources(f.options).pipe(Effect.result), /bound|empty/);
        assert.equal(yield* fs.readFileString(f.stage + "/foreign"), "preserved");
        const g = yield* fixture();
        yield* Effect.promise(() => native.chmod(g.stage, 0o755));
        denied(yield* preparePiSkillResources(g.options).pipe(Effect.result), /owner-only/);
        const h = yield* fixture();
        denied(
          yield* preparePiSkillResources({ ...h.options, stagingRoot: h.root }).pipe(Effect.result),
          /fixed cache/,
        );
      }),
    );
    it.effect("refuses wrong metadata, missing SKILL and nonportable frontmatter", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const problem of ["metadata", "missing", "frontmatter", "asset"] as const) {
          const f = yield* fixture();
          if (problem === "metadata") yield* fs.writeFileString(f.source + "/t3-skill.json", "{}");
          if (problem === "missing") yield* fs.remove(f.source + "/SKILL.md");
          if (problem === "asset") yield* fs.remove(f.source + "/assets/notes.txt");
          if (problem === "frontmatter")
            yield* fs.writeFileString(f.source + "/SKILL.md", "not portable");
          denied(
            yield* preparePiSkillResources(f.options).pipe(Effect.result),
            /metadata|SKILL|frontmatter|hash/,
          );
        }
      }),
    );
    it.effect("enforces package and combined runtime count and byte bounds", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* fixture();
        yield* Effect.promise(() => native.truncate(f.source + "/assets/notes.txt", 8_000_001));
        denied(yield* preparePiSkillResources(f.options).pipe(Effect.result), /package byte bound/);
        const g = yield* fixture();
        const runtime = g.root + "/worker";
        yield* fs.writeFileString(runtime, "worker");
        denied(
          yield* preparePiSkillResources({
            ...g.options,
            existingRuntimeFiles: Array.from({ length: 254 }, (_, i) => ({
              source: runtime,
              target: "/runtime/part-" + i,
            })),
          }).pipe(Effect.result),
          /combined file bound/,
        );
        yield* Effect.promise(() => native.truncate(runtime, 256 * 1024 * 1024 + 1));
        denied(
          yield* preparePiSkillResources({
            ...g.options,
            existingRuntimeFiles: [{ source: runtime, target: "/runtime/worker" }],
          }).pipe(Effect.result),
          /combined byte bound/,
        );
        const h = yield* fixture();
        denied(
          yield* preparePiSkillResources({
            ...h.options,
            selection: Array.from({ length: 33 }, () => h.options.selection[0]!),
          }).pipe(Effect.result),
          /keys or limits/,
        );
      }),
    );
    it.effect("identity is independent of staging pathname and manifest revision", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* fixture();
        const first = yield* preparePiSkillResources(f.options);
        const g = yield* fixture();
        yield* fs.writeFileString(
          g.source + "/t3-skill.json",
          encodeManifest({ ...g.manifest, revision: { revision: 9, hash: g.expectedHash } }),
        );
        const second = yield* preparePiSkillResources(g.options);
        assert.equal(first.identityHash, second.identityHash);
        assert.match(first.identityHash, /^[a-f0-9]{64}$/);
      }),
    );
    it.effect("revalidation rejects mode, inode, directory and existing-runtime changes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const problem of ["mode", "inode", "directory", "runtime"] as const) {
          const f = yield* fixture();
          const runtime = f.root + "/worker";
          yield* fs.writeFileString(runtime, "worker");
          const prepared = yield* preparePiSkillResources({
            ...f.options,
            existingRuntimeFiles: [{ source: runtime, target: "/runtime/worker" }],
          });
          const copied = prepared.runtimeFiles.find((f) => f.target.endsWith("notes.txt"))!.source;
          if (problem === "mode") yield* Effect.promise(() => native.chmod(copied, 0o600));
          if (problem === "inode") {
            yield* Effect.promise(() => native.chmod(f.stage + "/selected/assets", 0o700));
            yield* fs.remove(copied);
            yield* fs.writeFileString(copied, "authorized asset");
            yield* Effect.promise(() => native.chmod(copied, 0o400));
            yield* Effect.promise(() => native.chmod(f.stage + "/selected/assets", 0o500));
          }
          if (problem === "directory") {
            yield* fs.rename(f.stage, f.stage + "-original");
            yield* fs.makeDirectory(f.stage);
            yield* Effect.promise(() => native.chmod(f.stage, 0o500));
          }
          if (problem === "runtime") yield* fs.writeFileString(runtime, "changed runtime");
          denied(yield* prepared.revalidate.pipe(Effect.result), /changed|receipt/);
        }
      }),
    );
    it.effect("revalidation refuses changed source and staged bytes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* fixture();
        const prepared = yield* preparePiSkillResources(f.options);
        yield* fs.writeFileString(f.source + "/assets/notes.txt", "forbidden bytes!");
        denied(yield* prepared.revalidate.pipe(Effect.result), /changed|receipt/i);
        const g = yield* fixture();
        const second = yield* preparePiSkillResources(g.options);
        const copied = second.runtimeFiles.find((f) => f.target.endsWith("notes.txt"))!.source;
        yield* Effect.promise(() => native.chmod(copied, 0o600));
        yield* fs.writeFileString(copied, "forbidden bytes!");
        yield* Effect.promise(() => native.chmod(copied, 0o400));
        denied(yield* second.revalidate.pipe(Effect.result), /changed|receipt/i);
      }),
    );
  });
});
