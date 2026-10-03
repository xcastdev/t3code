import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ManagedSkillId,
  ManagedSkillKey,
  ProviderInstanceId,
  SkillCatalogRevision,
  SkillContentHash,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import * as Repository from "../../skills/ManagedSkillRepository.ts";
import { makePiSkillAdapter } from "../../skills/ProviderSkillAdapters.ts";
import * as Materialization from "../../skills/SkillMaterializationService.ts";
import { hashSkillPackage } from "../../skills/SkillPackage.ts";
import { PiManagedRuntimeError } from "./PiManagedRuntime.ts";
import {
  piManagedSkillResourceIdentity,
  preparePiManagedSkillResources,
  validatePiManagedSkillPlan,
} from "./PiManagedSkillResources.ts";
import { resolvePiManagedSkillSelection } from "./PiManagedSkillSelection.ts";

const native = process.getBuiltinModule("fs").promises;
const syncExports = process.getBuiltinModule("module").syncBuiltinESMExports;
const crypto = process.getBuiltinModule("crypto");
const key = Schema.decodeUnknownSync(ManagedSkillKey);
const id = Schema.decodeUnknownSync(ManagedSkillId);
const hash = Schema.decodeUnknownSync(SkillContentHash);
const threadId = Schema.decodeSync(ThreadId)("bridge-thread");
const providerInstanceId = Schema.decodeSync(ProviderInstanceId)("pi-bridge");
const decodeRevision = Schema.decodeUnknownSync(SkillCatalogRevision);
const decodeThread = Schema.decodeUnknownSync(ThreadId);
const decodeProvider = Schema.decodeUnknownSync(ProviderInstanceId);
const decodePayload = Schema.decodeUnknownSync(
  Schema.Struct({
    kind: Schema.Literal("pi-managed-skills"),
    root: Schema.String,
    skills: Schema.Array(Schema.Struct({ key: ManagedSkillKey, path: Schema.String })),
  }),
);
const revision = decodeRevision(3);
const emptyIdentity = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const denied = (result: Result.Result<unknown, PiManagedRuntimeError>, detail?: RegExp) => {
  assert.isTrue(Result.isFailure(result));
  if (Result.isFailure(result)) {
    assert.equal(result.failure._tag, "PiManagedRuntimeError");
    assert.equal(result.failure.code, "denied");
    if (detail !== undefined) assert.match(result.failure.detail, detail);
  }
};
const unusedService: Materialization.SkillMaterializationServiceShape = {
  materialize: () => Effect.die("unexpected materialization"),
  dispose: () => Effect.die("unexpected disposal"),
  disposeSession: () => Effect.die("unexpected session disposal"),
};
function portableFixture() {
  const selection = [
    {
      skillId: id("owned-selected-id"),
      key: key("selected"),
      packagePath: "/owned/selected",
      expectedHash: hash("a".repeat(64)),
    },
  ];
  const plan = {
    providerInstanceId,
    desiredRevision: revision,
    applicationMode: "new_session_required" as const,
    skillKeys: [key("selected")],
    payload: {
      kind: "pi-managed-skills" as const,
      root: "/owned/materialization",
      skills: [{ key: key("selected"), path: "/owned/materialization/selected/SKILL.md" }],
    },
  };
  const input = {
    selection,
    skillPlan: plan,
    materialization: unusedService,
    threadId,
    providerInstanceId,
    stagingRoot: "/absent",
    stagingDirectory: "/absent/stage",
    existingRuntimeFiles: [],
    protectedRoots: ["/absent-protected"],
    writableRoots: [],
    authorizeCurrent: Effect.die("malformed plan reached authorization"),
  };
  return { input, plan };
}

describe("PiManagedSkillResources portable admission", () => {
  it.layer(NodeServices.layer)("bounded plans and inert defaults", (it) => {
    it.effect("empty absent plan uses the actual inert helper without services or authority", () =>
      Effect.gen(function* () {
        const f = portableFixture();
        const prepared = yield* preparePiManagedSkillResources({
          ...f.input,
          selection: [],
          skillPlan: undefined,
        });
        assert.deepEqual(prepared.runtimeFiles, []);
        assert.deepEqual(prepared.resources, { skills: [] });
        assert.equal(prepared.identityHash, emptyIdentity);
        assert.equal(piManagedSkillResourceIdentity([]), emptyIdentity);
        yield* prepared.revalidate;
      }),
    );

    it.effect("requires an explicit plan for a nonempty selection before admission", () =>
      Effect.gen(function* () {
        const f = portableFixture();
        denied(
          yield* preparePiManagedSkillResources({ ...f.input, skillPlan: undefined }).pipe(
            Effect.result,
          ),
          /explicit/,
        );
      }),
    );

    const malformed: ReadonlyArray<
      readonly [string, (f: ReturnType<typeof portableFixture>) => void]
    > = [
      ["negative revision", ({ plan }) => Object.assign(plan, { desiredRevision: -1 })],
      ["fractional revision", ({ plan }) => Object.assign(plan, { desiredRevision: 0.5 })],
      ["unsafe revision", ({ plan }) => Object.assign(plan, { desiredRevision: 2 ** 53 })],
      ["live mode", ({ plan }) => Object.assign(plan, { applicationMode: "live" })],
      ["wrong payload kind", ({ plan }) => Object.assign(plan.payload, { kind: "native" })],
      ["relative root", ({ plan }) => Object.assign(plan.payload, { root: "relative" })],
      ["noncanonical root", ({ plan }) => Object.assign(plan.payload, { root: "/a/../owned" })],
      [
        "noncanonical path",
        ({ plan }) => Object.assign(plan.payload.skills[0]!, { path: "/a//b" }),
      ],
      [
        "oversized root",
        ({ plan }) => Object.assign(plan.payload, { root: "/" + "a".repeat(4096) }),
      ],
      ["duplicate plan keys", ({ plan }) => plan.skillKeys.push(key("selected"))],
      [
        "duplicate payload keys",
        ({ plan }) => plan.payload.skills.push({ ...plan.payload.skills[0]! }),
      ],
      [
        "too many plan keys",
        ({ plan }) =>
          Object.assign(plan, { skillKeys: Array.from({ length: 33 }, (_, i) => key("key-" + i)) }),
      ],
      [
        "too many payload keys",
        ({ plan }) =>
          Object.assign(plan.payload, {
            skills: Array.from({ length: 33 }, (_, i) => ({
              key: key("key-" + i),
              path: "/owned/key-" + i + "/SKILL.md",
            })),
          }),
      ],
      ["nonportable key", ({ plan }) => Object.assign(plan, { skillKeys: ["../selected"] })],
      ["plan excess field", ({ plan }) => Object.assign(plan, { extra: true })],
      ["payload excess field", ({ plan }) => Object.assign(plan.payload, { extra: true })],
      [
        "payload skill excess field",
        ({ plan }) => Object.assign(plan.payload.skills[0]!, { extra: true }),
      ],
      ["wrong instance", ({ plan }) => Object.assign(plan, { providerInstanceId: "pi-other" })],
      ["missing plan key", ({ plan }) => plan.skillKeys.pop()],
      ["missing payload key", ({ plan }) => plan.payload.skills.pop()],
      [
        "different payload key",
        ({ plan }) => Object.assign(plan.payload.skills[0]!, { key: "other" }),
      ],
      ["duplicate selection", ({ input }) => input.selection.push({ ...input.selection[0]! })],
      [
        "invalid complete hash",
        ({ input }) => Object.assign(input.selection[0]!, { expectedHash: "short" }),
      ],
      [
        "too many selections",
        ({ input }) =>
          Object.assign(input, {
            selection: Array.from({ length: 33 }, (_, i) => ({
              ...input.selection[0]!,
              key: key("key-" + i),
              skillId: id("id-" + i),
            })),
          }),
      ],
    ];
    for (const [name, mutate] of malformed)
      it.effect(`rejects ${name} before filesystem, service and authorization work`, () =>
        Effect.gen(function* () {
          const f = portableFixture();
          mutate(f);
          denied(yield* preparePiManagedSkillResources(f.input).pipe(Effect.result));
        }),
      );

    it.effect(
      "malformed explicit empty plans are rejected instead of taking the inert shortcut",
      () =>
        Effect.gen(function* () {
          const f = portableFixture();
          f.input.selection.length = 0;
          f.plan.skillKeys.length = 0;
          f.plan.payload.skills.length = 0;
          Object.assign(f.plan.payload, { root: "relative" });
          denied(yield* preparePiManagedSkillResources(f.input).pipe(Effect.result));
        }),
    );

    for (const platform of ["darwin", "win32"] as const)
      it.effect(`absent empty selection remains inert on ${platform}`, () =>
        Effect.gen(function* () {
          const f = portableFixture();
          const prepared = yield* preparePiManagedSkillResources({
            ...f.input,
            selection: [],
            skillPlan: undefined,
          }).pipe(Effect.provideService(HostProcessPlatform, platform));
          assert.equal(prepared.identityHash, emptyIdentity);
          yield* prepared.revalidate;
        }),
      );

    it.effect("a custom materializer cannot admit even a well formed empty plan", () =>
      Effect.gen(function* () {
        const f = portableFixture();
        f.input.selection.length = 0;
        f.plan.skillKeys.length = 0;
        f.plan.payload.skills.length = 0;
        denied(
          yield* preparePiManagedSkillResources({ ...f.input, authorizeCurrent: Effect.void }).pipe(
            Effect.result,
          ),
          /Owned/,
        );
      }),
    );

    it("resource identity uses sorted key/hash tuples, ignoring stable IDs and repository paths", () => {
      const f = portableFixture();
      const second = {
        ...f.input.selection[0]!,
        key: key("alpha"),
        skillId: id("alpha-id"),
        expectedHash: hash("b".repeat(64)),
      };
      const expected = crypto
        .createHash("sha256")
        .update('[["alpha","' + "b".repeat(64) + '"],["selected","' + "a".repeat(64) + '"]]')
        .digest("hex");
      assert.equal(piManagedSkillResourceIdentity([f.input.selection[0]!, second]), expected);
      assert.equal(
        piManagedSkillResourceIdentity([
          second,
          { ...f.input.selection[0]!, skillId: id("replacement-id"), packagePath: "/other/path" },
        ]),
        expected,
      );
      assert.notEqual(
        piManagedSkillResourceIdentity([
          { ...second, expectedHash: hash("c".repeat(64)) },
          f.input.selection[0]!,
        ]),
        expected,
      );
    });
  });
});

const TestLayer = Materialization.layer.pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pi-owned-bridge-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.fn("PiManagedSkillResources.fixture")(function* (empty = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const repository = yield* Repository.ManagedSkillRepository;
  const materialization = yield* Materialization.SkillMaterializationService;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pi-owned-resource-stage-" });
  const workspace = path.join(root, "workspace");
  const stagingRoot = path.join(root, "cache");
  const stagingDirectory = path.join(stagingRoot, "operation");
  yield* fs.makeDirectory(workspace);
  const skill = empty
    ? undefined
    : yield* repository.importGlobal({
        expectedRevision: 0,
        content: { key: key("selected"), name: "Selected fixture", body: "Use assets/notes.txt." },
        files: [
          { relativePath: "assets/notes.txt", bytes: new TextEncoder().encode("inert asset") },
        ],
      });
  const selection = yield* resolvePiManagedSkillSelection({
    projectRoot: workspace,
    selectedSkillIds: skill === undefined ? [] : [skill.manifest.id],
    roleSkillIds: skill === undefined ? [] : [skill.manifest.id],
  });
  const sessionId = `thread-${crypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`;
  const adapter = makePiSkillAdapter({
    providerInstanceId,
    materialization,
    authorizeManagedRequest: () => Effect.succeed(new Set(selection.map((entry) => entry.key))),
    discoverCandidates: () => Effect.die("native discovery must not run"),
  });
  const plan = yield* adapter.prepareSession({
    runtime: { providerInstanceId, threadId, sessionId, cwd: workspace },
    desiredRevision: revision,
    skills: selection.map(({ key, packagePath }) => ({ key, packagePath })),
  });
  const ownedRoot = path.join(
    config.skillRuntimeDir,
    sessionId,
    String(revision),
    providerInstanceId,
  );
  if (!empty) {
    yield* fs.makeDirectory(stagingDirectory, { recursive: true });
    yield* Effect.promise(() => native.chmod(stagingRoot, 0o700));
    yield* Effect.promise(() => native.chmod(stagingDirectory, 0o700));
  }
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      // The parent owns stage cleanup. Restore this test's sealed directories for temp cleanup.
      for (const directory of [
        stagingDirectory,
        stagingDirectory + "/selected",
        stagingDirectory + "/selected/assets",
      ])
        await native.chmod(directory, 0o700).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    }),
  );
  return {
    fs,
    path,
    config,
    repository,
    materialization,
    root,
    skill,
    selection,
    plan,
    ownedRoot,
    input: {
      selection,
      skillPlan: plan,
      materialization,
      threadId,
      providerInstanceId,
      stagingRoot,
      stagingDirectory,
      existingRuntimeFiles: [],
      protectedRoots: [config.baseDir],
      writableRoots: [workspace],
      authorizeCurrent: Effect.void,
    },
  };
});
type Handle = Awaited<ReturnType<typeof native.open>>;
const observeDescriptors = Effect.fn("PiManagedSkillResources.observeDescriptors")(function* (
  onOpen: (
    handle: Handle,
    entry: string,
    flags: string | number | undefined,
  ) => Promise<void> = async () => {},
) {
  const open = native.open.bind(native);
  const active = new Set<number>();
  let acquired = 0;
  const spy = vi.spyOn(native, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const fd = handle.fd;
    acquired++;
    active.add(fd);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      active.delete(fd);
    };
    await onOpen(handle, String(args[0]), args[1]);
    return handle;
  });
  syncExports();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      spy.mockRestore();
      syncExports();
    }),
  );
  return { active, acquired: () => acquired };
});
const linux = it.effect.skipIf(HostProcessPlatform.defaultValue() !== "linux");

describe("PiManagedSkillResources actual Linux owned staging", () => {
  linux("stages the actual owned package and inert asset as sealed explicit mounts", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const observed = yield* observeDescriptors();
      const before = yield* f.fs.readFileString(f.skill!.packagePath + "/SKILL.md");
      const prepared = yield* preparePiManagedSkillResources(f.input);
      assert.deepEqual(prepared.resources, {
        skills: [
          {
            key: "selected",
            path: "/runtime/skills/selected/SKILL.md",
            description: "Selected fixture",
          },
        ],
      });
      assert.deepEqual(prepared.runtimeFiles.map((entry) => entry.target).sort(), [
        "/runtime/skills/selected/SKILL.md",
        "/runtime/skills/selected/assets/notes.txt",
        "/runtime/skills/selected/t3-skill.json",
      ]);
      assert.equal(prepared.identityHash, piManagedSkillResourceIdentity(f.selection));
      for (const mount of prepared.runtimeFiles) {
        assert.isTrue(mount.source.startsWith(f.input.stagingDirectory + "/"));
        assert.isFalse(mount.source.startsWith(f.ownedRoot));
        assert.equal((yield* Effect.promise(() => native.stat(mount.source))).mode & 0o777, 0o400);
      }
      assert.equal(
        yield* f.fs.readFileString(f.input.stagingDirectory + "/selected/assets/notes.txt"),
        "inert asset",
      );
      assert.equal(
        (yield* Effect.promise(() => native.stat(f.input.stagingDirectory))).mode & 0o777,
        0o500,
      );
      assert.equal(yield* hashSkillPackage(f.skill!.packagePath), f.selection[0]!.expectedHash);
      assert.equal(
        yield* hashSkillPackage(f.ownedRoot + "/selected"),
        f.selection[0]!.expectedHash,
      );
      assert.equal(yield* f.fs.readFileString(f.skill!.packagePath + "/SKILL.md"), before);
      assert.isAbove(observed.acquired(), 0);
      assert.equal(observed.active.size, 0);
      // A leaked owned.revalidate would fail here after its admission closes.
      yield* prepared.revalidate;
      yield* prepared.revalidate;
      assert.equal(observed.active.size, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  linux("explicit empty plan admits the real owned generation without stage allocation", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const observed = yield* observeDescriptors();
      const prepared = yield* preparePiManagedSkillResources(f.input);
      assert.equal(prepared.identityHash, emptyIdentity);
      assert.deepEqual(prepared.resources, { skills: [] });
      assert.deepEqual(prepared.runtimeFiles, []);
      assert.isFalse(yield* f.fs.exists(f.input.stagingRoot));
      assert.isAbove(observed.acquired(), 0);
      assert.equal(observed.active.size, 0);
      yield* prepared.revalidate;
      assert.equal(observed.active.size, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  linux("explicit empty plan cannot bypass missing owned admission", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      yield* f.fs.remove(f.ownedRoot, { recursive: true });
      const observed = yield* observeDescriptors();
      denied(yield* preparePiManagedSkillResources(f.input).pipe(Effect.result), /Owned/);
      assert.equal(observed.active.size, 0);
      assert.isFalse(yield* f.fs.exists(f.ownedRoot));
      assert.isFalse(yield* f.fs.exists(f.input.stagingRoot));
    }).pipe(Effect.provide(TestLayer)),
  );

  linux("canonicalizes key order across selection, plan and payload using actual packages", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const alpha = yield* f.repository.createGlobal({
        expectedRevision: 0,
        content: { key: key("alpha"), name: "Alpha fixture", body: "Explicit alpha" },
      });
      const selection = yield* resolvePiManagedSkillSelection({
        projectRoot: f.input.writableRoots[0]!,
        selectedSkillIds: [f.skill!.manifest.id, alpha.manifest.id],
        roleSkillIds: [f.skill!.manifest.id, alpha.manifest.id],
      });
      const materialized = yield* f.materialization.materialize({
        sessionId: `thread-${crypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`,
        providerInstanceId,
        desiredRevision: revision,
        packages: selection.map((entry) => ({ key: entry.key, sourcePath: entry.packagePath })),
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          native
            .chmod(f.input.stagingDirectory + "/alpha", 0o700)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            }),
        ),
      );
      const prepared = yield* preparePiManagedSkillResources({
        ...f.input,
        selection: selection.toReversed(),
        skillPlan: {
          ...f.plan,
          skillKeys: selection.map((entry) => entry.key),
          payload: {
            kind: "pi-managed-skills",
            root: materialized.root,
            skills: selection.toReversed().map((entry) => ({
              key: entry.key,
              path: materialized.skillPaths.get(entry.key)! + "/SKILL.md",
            })),
          },
        },
      });
      assert.deepEqual(
        prepared.resources.skills.map((entry) => entry.key),
        ["alpha", "selected"],
      );
      assert.equal(prepared.identityHash, piManagedSkillResourceIdentity(selection));
      yield* prepared.revalidate;
    }).pipe(Effect.provide(TestLayer)),
  );

  linux("retains the actual helper's existing runtime closure receipts and overlap policy", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = f.root + "/worker";
      yield* f.fs.writeFileString(source, "runtime worker fixture");
      const prepared = yield* preparePiManagedSkillResources({
        ...f.input,
        existingRuntimeFiles: [{ source, target: "/runtime/worker" }],
      });
      assert.isFalse(prepared.runtimeFiles.some((entry) => entry.target === "/runtime/worker"));
      yield* prepared.revalidate;
      yield* f.fs.writeFileString(source, "changed runtime worker");
      denied(yield* prepared.revalidate.pipe(Effect.result), /runtime.*receipt/);
      const stage = f.input.stagingRoot + "/overlap";
      yield* f.fs.makeDirectory(stage);
      yield* Effect.promise(() => native.chmod(stage, 0o700));
      denied(
        yield* preparePiManagedSkillResources({
          ...f.input,
          stagingDirectory: stage,
          existingRuntimeFiles: [{ source, target: "/runtime/skills/selected" }],
        }).pipe(Effect.result),
        /overlap/,
      );
      assert.deepEqual(yield* f.fs.readDirectory(stage), []);
    }).pipe(Effect.provide(TestLayer)),
  );

  for (const forged of [
    "foreign-root",
    "foreign-path",
    "wrong-revision",
    "wrong-thread",
    "custom-service",
  ] as const)
    linux(`rejects ${forged} before copying and preserves original packages`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const foreign = f.root + "/foreign";
        yield* f.fs.makeDirectory(foreign);
        yield* f.fs.writeFileString(foreign + "/keep", "foreign unchanged");
        const plan = decodePayload(f.plan.payload);
        const input = {
          ...f.input,
          threadId: forged === "wrong-thread" ? decodeThread("other-thread") : threadId,
          materialization:
            forged === "custom-service" ? { ...f.materialization } : f.materialization,
          skillPlan: {
            ...f.plan,
            desiredRevision: forged === "wrong-revision" ? decodeRevision(4) : revision,
            payload: {
              ...plan,
              kind: "pi-managed-skills",
              root: forged === "foreign-root" ? foreign : plan.root,
              skills: plan.skills.map((entry) => ({
                ...entry,
                path: forged === "foreign-path" ? foreign + "/SKILL.md" : entry.path,
              })),
            },
          },
        };
        const observed = yield* observeDescriptors();
        denied(yield* preparePiManagedSkillResources(input).pipe(Effect.result));
        assert.equal(observed.active.size, 0);
        assert.deepEqual(yield* f.fs.readDirectory(f.input.stagingDirectory), []);
        assert.equal(yield* f.fs.readFileString(foreign + "/keep"), "foreign unchanged");
        assert.equal(yield* hashSkillPackage(f.skill!.packagePath), f.selection[0]!.expectedHash);
      }).pipe(Effect.provide(TestLayer)),
    );

  linux("denies a complete package hash mismatch without modifying either original package", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const observed = yield* observeDescriptors();
      denied(
        yield* preparePiManagedSkillResources({
          ...f.input,
          selection: [{ ...f.selection[0]!, expectedHash: hash("b".repeat(64)) }],
        }).pipe(Effect.result),
        /hash/,
      );
      assert.equal(observed.active.size, 0);
      assert.equal(yield* hashSkillPackage(f.skill!.packagePath), f.selection[0]!.expectedHash);
      assert.equal(
        yield* hashSkillPackage(f.ownedRoot + "/selected"),
        f.selection[0]!.expectedHash,
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  linux("snapshots plan, selection and staging policy before asynchronous authorization", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const selection = f.selection.map((entry) => ({ ...entry }));
      const payload = decodePayload(f.plan.payload);
      const plan = { ...f.plan, skillKeys: [...f.plan.skillKeys], payload };
      const protectedRoots = [...f.input.protectedRoots];
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const input = {
        ...f.input,
        selection,
        skillPlan: plan,
        protectedRoots,
        authorizeCurrent: Effect.gen(function* () {
          if (++calls === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
        }),
      };
      const captured = preparePiManagedSkillResources(input);
      const running = yield* captured.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      Object.assign(selection[0]!, { packagePath: "/foreign", expectedHash: hash("b".repeat(64)) });
      Object.assign(plan.payload, { root: "/foreign" });
      Object.assign(plan.payload.skills[0]!, { path: "/foreign/SKILL.md" });
      plan.skillKeys.length = 0;
      protectedRoots.length = 0;
      Object.assign(input, {
        stagingDirectory: "/foreign/stage",
        materialization: unusedService,
        authorizeCurrent: Effect.die("mutated effect"),
      });
      yield* Deferred.succeed(release, undefined);
      const prepared = yield* Fiber.join(running);
      assert.equal(prepared.identityHash, piManagedSkillResourceIdentity(f.selection));
      assert.isTrue(
        prepared.runtimeFiles.every((entry) => entry.source.startsWith(f.input.stagingDirectory)),
      );
      yield* prepared.revalidate;
    }).pipe(Effect.provide(TestLayer)),
  );

  linux(
    "identity agrees with actual staging across unrelated catalogue and plan revision changes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = yield* preparePiManagedSkillResources(f.input);
        yield* f.repository.createGlobal({
          expectedRevision: 0,
          content: { key: key("unrelated"), name: "Unrelated", body: "Ignore" },
        });
        const nextRevision = decodeRevision(9);
        const materialized = yield* f.materialization.materialize({
          sessionId: `thread-${crypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`,
          providerInstanceId,
          desiredRevision: nextRevision,
          packages: f.selection.map((entry) => ({ key: entry.key, sourcePath: entry.packagePath })),
        });
        const stage = f.input.stagingRoot + "/next";
        yield* f.fs.makeDirectory(stage);
        yield* Effect.promise(() => native.chmod(stage, 0o700));
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            for (const directory of [stage, stage + "/selected", stage + "/selected/assets"])
              await native.chmod(directory, 0o700);
          }),
        );
        const second = yield* preparePiManagedSkillResources({
          ...f.input,
          stagingDirectory: stage,
          skillPlan: {
            ...f.plan,
            desiredRevision: nextRevision,
            payload: {
              kind: "pi-managed-skills",
              root: materialized.root,
              skills: [{ key: key("selected"), path: materialized.root + "/selected/SKILL.md" }],
            },
          },
        });
        assert.equal(first.identityHash, second.identityHash);
        assert.equal(second.identityHash, piManagedSkillResourceIdentity(f.selection));
        yield* first.revalidate;
        yield* second.revalidate;
      }).pipe(Effect.provide(TestLayer)),
  );

  linux(
    "returned resource revalidation enforces current authorization before and after native reads",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let current = true;
        const authorizeCurrent = Effect.suspend(() =>
          current
            ? Effect.void
            : Effect.fail(new PiManagedRuntimeError({ code: "denied", detail: "revoked" })),
        );
        const prepared = yield* preparePiManagedSkillResources({ ...f.input, authorizeCurrent });
        const observed = yield* observeDescriptors(async (_handle, entry) => {
          if (entry.endsWith("/notes.txt")) current = false;
        });
        denied(yield* prepared.revalidate.pipe(Effect.result), /revoked/);
        assert.isAbove(observed.acquired(), 0);
        assert.equal(observed.active.size, 0);
        const before = observed.acquired();
        denied(yield* prepared.revalidate.pipe(Effect.result), /revoked/);
        assert.equal(observed.acquired(), before);
      }).pipe(Effect.provide(TestLayer)),
  );

  for (const boundary of ["admission", "copy", "final-release"] as const)
    linux(`current revocation during actual ${boundary} denies and drains all descriptors`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let current = true;
        let revoked = false;
        const flags = process.getBuiltinModule("fs").constants;
        const observed = yield* observeDescriptors(async (handle, entry, mode) => {
          if (revoked) return;
          if (boundary === "admission" && entry.endsWith("/.t3-owned.json")) {
            current = false;
            revoked = true;
          }
          if (
            boundary === "copy" &&
            entry.endsWith("/notes.txt") &&
            typeof mode === "number" &&
            (mode & flags.O_WRONLY) !== 0
          ) {
            const write = handle.writeFile.bind(handle);
            handle.writeFile = async (...args) => {
              await write(...args);
              current = false;
              revoked = true;
            };
          }
          if (boundary === "final-release" && entry.endsWith("/.t3-owned.json")) {
            const close = handle.close.bind(handle);
            handle.close = async () => {
              await close();
              current = false;
              revoked = true;
            };
          }
        });
        denied(
          yield* preparePiManagedSkillResources({
            ...f.input,
            authorizeCurrent: Effect.suspend(() =>
              current
                ? Effect.void
                : Effect.fail(
                    new PiManagedRuntimeError({
                      code: "denied",
                      detail: "revoked current authority",
                    }),
                  ),
            ),
          }).pipe(Effect.result),
          /revoked/,
        );
        assert.isTrue(revoked);
        assert.isAbove(observed.acquired(), 0);
        assert.equal(observed.active.size, 0);
        assert.equal(yield* hashSkillPackage(f.skill!.packagePath), f.selection[0]!.expectedHash);
        assert.equal(
          yield* hashSkillPackage(f.ownedRoot + "/selected"),
          f.selection[0]!.expectedHash,
        );
        if (boundary === "admission")
          assert.deepEqual(yield* f.fs.readDirectory(f.input.stagingDirectory), []);
      }).pipe(Effect.provide(TestLayer)),
    );

  linux("cancellation joins an actual held copy operation and owned admission close", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let resolveEntered: (() => void) | undefined;
      let resolveRelease: (() => void) | undefined;
      const enteredNative = new Promise<void>((resolve) => {
        resolveEntered = resolve;
      });
      const releaseNative = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
      let held = false;
      const flags = process.getBuiltinModule("fs").constants;
      const observed = yield* observeDescriptors(async (handle, entry, mode) => {
        if (
          held ||
          !entry.endsWith("/notes.txt") ||
          typeof mode !== "number" ||
          (mode & flags.O_WRONLY) === 0
        )
          return;
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...args) => {
          await write(...args);
          held = true;
          resolveEntered!();
          await releaseNative;
        };
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => resolveRelease!()));
      const running = yield* preparePiManagedSkillResources(f.input).pipe(Effect.forkChild);
      yield* Effect.promise(() => enteredNative);
      let joined = false;
      const interrupting = yield* Fiber.interrupt(running).pipe(
        Effect.andThen(
          Effect.sync(() => {
            joined = true;
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      assert.isFalse(joined, "interruption must wait for the held write receipt");
      assert.isTrue(held);
      assert.isAbove(observed.active.size, 0);
      resolveRelease!();
      yield* Fiber.join(interrupting);
      assert.isTrue(joined);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(running)));
      assert.equal(observed.active.size, 0);
      assert.equal(yield* hashSkillPackage(f.skill!.packagePath), f.selection[0]!.expectedHash);
      assert.equal(
        yield* hashSkillPackage(f.ownedRoot + "/selected"),
        f.selection[0]!.expectedHash,
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("PiManagedSkillResources validate-only plan", () => {
  it.layer(NodeServices.layer)("portable validation", (it) => {
    it.effect("absent empty selection is inert without materialization or authority work", () =>
      Effect.gen(function* () {
        const f = portableFixture();
        const observed = yield* observeDescriptors();
        yield* validatePiManagedSkillPlan({ ...f.input, selection: [], skillPlan: undefined });
        assert.equal(observed.acquired(), 0);
      }),
    );

    it.effect("nonempty selection requires a plan before materialization or authority work", () =>
      Effect.gen(function* () {
        const f = portableFixture();
        denied(
          yield* validatePiManagedSkillPlan({ ...f.input, skillPlan: undefined }).pipe(
            Effect.result,
          ),
          /explicit/,
        );
      }),
    );

    it.effect("malformed explicit empty plan is denied before authority work", () =>
      Effect.gen(function* () {
        const f = portableFixture();
        f.input.selection.length = 0;
        f.plan.skillKeys.length = 0;
        f.plan.payload.skills.length = 0;
        Object.assign(f.plan.payload, { root: "relative" });
        denied(yield* validatePiManagedSkillPlan(f.input).pipe(Effect.result));
      }),
    );

    it.effect("unowned custom service cannot admit an explicit empty plan", () =>
      Effect.gen(function* () {
        const f = portableFixture();
        f.input.selection.length = 0;
        f.plan.skillKeys.length = 0;
        f.plan.payload.skills.length = 0;
        denied(
          yield* validatePiManagedSkillPlan({ ...f.input, authorizeCurrent: Effect.void }).pipe(
            Effect.result,
          ),
          /Owned/,
        );
      }),
    );
  });

  linux(
    "validates the complete actual owned package without stage or materialization allocation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.remove(f.input.stagingRoot, { recursive: true });
        const materialize = vi.spyOn(f.materialization, "materialize");
        const dispose = vi.spyOn(f.materialization, "dispose");
        const disposeSession = vi.spyOn(f.materialization, "disposeSession");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            materialize.mockRestore();
            dispose.mockRestore();
            disposeSession.mockRestore();
          }),
        );
        const observed = yield* observeDescriptors();
        yield* validatePiManagedSkillPlan(f.input);
        assert.isAbove(observed.acquired(), 0);
        assert.equal(observed.active.size, 0);
        assert.isFalse(yield* f.fs.exists(f.input.stagingRoot));
        assert.equal(materialize.mock.calls.length, 0);
        assert.equal(dispose.mock.calls.length, 0);
        assert.equal(disposeSession.mock.calls.length, 0);
        assert.equal(
          yield* hashSkillPackage(f.ownedRoot + "/selected"),
          f.selection[0]!.expectedHash,
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  linux("explicit empty plan validates real ownership without staging", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const observed = yield* observeDescriptors();
      yield* validatePiManagedSkillPlan(f.input);
      assert.isAbove(observed.acquired(), 0);
      assert.equal(observed.active.size, 0);
      assert.isFalse(yield* f.fs.exists(f.input.stagingRoot));
      yield* f.materialization.disposeSession({
        sessionId: `thread-${crypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`,
        providerInstanceId,
      });
      denied(yield* validatePiManagedSkillPlan(f.input).pipe(Effect.result), /Owned/);
      assert.equal(observed.active.size, 0);
      assert.isFalse(yield* f.fs.exists(f.ownedRoot));
    }).pipe(Effect.provide(TestLayer)),
  );

  for (const mismatch of [
    "root",
    "path",
    "revision",
    "thread",
    "provider",
    "key",
    "payload-key",
    "hash",
  ] as const)
    linux(`denies exact ${mismatch} mismatch against the actual owned materialization`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const payload = decodePayload(f.plan.payload);
        const observed = yield* observeDescriptors();
        const input = {
          ...f.input,
          selection: f.selection.map((entry) => ({
            ...entry,
            expectedHash: mismatch === "hash" ? hash("b".repeat(64)) : entry.expectedHash,
          })),
          threadId: mismatch === "thread" ? decodeThread("other-thread") : threadId,
          providerInstanceId:
            mismatch === "provider" ? decodeProvider("pi-other") : providerInstanceId,
          skillPlan: {
            ...f.plan,
            desiredRevision: mismatch === "revision" ? decodeRevision(4) : revision,
            skillKeys: mismatch === "key" ? [key("other")] : f.plan.skillKeys,
            payload: {
              ...payload,
              root: mismatch === "root" ? f.root : payload.root,
              skills: payload.skills.map((entry) => ({
                ...entry,
                key: mismatch === "payload-key" ? key("other") : entry.key,
                path: mismatch === "path" ? entry.path + "/extra" : entry.path,
              })),
            },
          },
        };
        denied(yield* validatePiManagedSkillPlan(input).pipe(Effect.result));
        assert.equal(observed.active.size, 0);
        assert.deepEqual(yield* f.fs.readDirectory(f.input.stagingDirectory), []);
        assert.equal(
          yield* hashSkillPackage(f.ownedRoot + "/selected"),
          f.selection[0]!.expectedHash,
        );
      }).pipe(Effect.provide(TestLayer)),
    );

  linux("hashes assets as part of the complete package and denies a disposed generation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.writeFileString(f.ownedRoot + "/selected/assets/notes.txt", "changed asset");
      const observed = yield* observeDescriptors();
      denied(yield* validatePiManagedSkillPlan(f.input).pipe(Effect.result), /hash/);
      assert.equal(observed.active.size, 0);
      assert.equal(yield* hashSkillPackage(f.skill!.packagePath), f.selection[0]!.expectedHash);
      yield* f.materialization.dispose({
        sessionId: `thread-${crypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`,
        providerInstanceId,
        desiredRevision: revision,
      });
      denied(yield* validatePiManagedSkillPlan(f.input).pipe(Effect.result), /Owned/);
      assert.isFalse(yield* f.fs.exists(f.ownedRoot));
      assert.equal(observed.active.size, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  linux(
    "snapshots caller plan, selection and identity before execution and held authorization",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const selection = f.selection.map((entry) => ({ ...entry }));
        const plan = {
          ...f.plan,
          skillKeys: [...f.plan.skillKeys],
          payload: decodePayload(f.plan.payload),
        };
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const input = {
          ...f.input,
          selection,
          skillPlan: plan,
          authorizeCurrent: Effect.gen(function* () {
            if (++calls === 1) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
          }),
        };
        const captured = validatePiManagedSkillPlan(input);
        Object.assign(input, {
          threadId: decodeThread("mutated-thread"),
          providerInstanceId: "pi-other",
          materialization: unusedService,
        });
        const running = yield* captured.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        Object.assign(selection[0]!, {
          key: key("other"),
          skillId: id("other"),
          packagePath: "/absent",
          expectedHash: hash("b".repeat(64)),
        });
        plan.skillKeys.length = 0;
        Object.assign(plan, { providerInstanceId: "pi-other", desiredRevision: 99 });
        Object.assign(plan.payload, { root: "/absent" });
        Object.assign(plan.payload.skills[0]!, { key: key("other"), path: "/absent/SKILL.md" });
        Object.assign(input, { authorizeCurrent: Effect.die("mutated authorization") });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);
        assert.isAtLeast(calls, 3);
        assert.deepEqual(yield* f.fs.readDirectory(f.input.stagingDirectory), []);
      }).pipe(Effect.provide(TestLayer)),
  );

  linux("held current-authority change denies before admission", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let current = true;
      const observed = yield* observeDescriptors();
      const running = yield* validatePiManagedSkillPlan({
        ...f.input,
        authorizeCurrent: Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          if (!current)
            return yield* new PiManagedRuntimeError({
              code: "denied",
              detail: "revoked current authority",
            });
        }),
      }).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      current = false;
      yield* Deferred.succeed(release, undefined);
      denied(yield* Fiber.join(running), /revoked/);
      assert.equal(observed.acquired(), 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  for (const boundary of ["hash", "final-release"] as const)
    linux(`current authority change during actual ${boundary} denies and drains descriptors`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let current = true;
        const observed = yield* observeDescriptors(async (handle, entry) => {
          if (boundary === "hash" && entry.endsWith("/notes.txt")) current = false;
          if (boundary === "final-release" && entry.endsWith("/.t3-owned.json")) {
            const close = handle.close.bind(handle);
            handle.close = async () => {
              await close();
              current = false;
            };
          }
        });
        denied(
          yield* validatePiManagedSkillPlan({
            ...f.input,
            authorizeCurrent: Effect.suspend(() =>
              current
                ? Effect.void
                : Effect.fail(
                    new PiManagedRuntimeError({
                      code: "denied",
                      detail: "revoked current authority",
                    }),
                  ),
            ),
          }).pipe(Effect.result),
          /revoked/,
        );
        assert.isFalse(current);
        assert.isAbove(observed.acquired(), 0);
        assert.equal(observed.active.size, 0);
        assert.deepEqual(yield* f.fs.readDirectory(f.input.stagingDirectory), []);
      }).pipe(Effect.provide(TestLayer)),
    );
});
