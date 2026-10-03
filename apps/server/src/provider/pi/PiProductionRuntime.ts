import { HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { PiManagedRuntime, PiManagedRuntimeError } from "./PiManagedRuntime.ts";
import { makePiManagedRuntimeLive } from "./PiManagedRuntimeLive.ts";
import { PiModelCatalogue } from "./PiModelCatalogue.ts";
import { preparePiRuntimeAssets } from "./PiRuntimeAssets.ts";

const NodeFS = process.getBuiltinModule("fs");
const nativeFS = NodeFS.promises;
const directoryFlags =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW;
type Directory = Awaited<ReturnType<typeof nativeFS.open>>;
type Identity = Awaited<ReturnType<Directory["stat"]>>;
const unavailable = () =>
  new PiManagedRuntimeError({ code: "unavailable", detail: "Pi production runtime unavailable" });
const closed = () =>
  new PiManagedRuntimeError({ code: "denied", detail: "Pi production runtime scope closed" });
const native = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: unavailable }).pipe(Effect.uninterruptible);
const absolute = Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^\/[^\0\r\n]*$/));
const positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Options = Schema.Struct({
  environmentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  distributionDirectory: absolute,
  agentDirectory: absolute,
  nativeStateRoot: absolute,
  stagingRoot: absolute,
  protectedRoots: Schema.Array(absolute).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  memoryBytes: positive,
  cleanupDeadlineMs: positive,
  maxInputTokens: positive,
  maxOutputTokens: positive,
});
export type PiProductionRuntimeOptions = typeof Options.Type;
const decodeOptions = Schema.decodeEffect(Options, { onExcessProperty: "error" });
const FileIdentity = Schema.Struct({
  source: absolute,
  target: absolute,
  dev: Schema.Int,
  ino: positive,
});
const Allocation = Schema.fromJsonString(
  Schema.Struct({
    unit: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    nonce: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    policy: Schema.Struct({ memoryBytes: positive }),
    launch: Schema.Struct({
      runtimeFiles: Schema.Array(FileIdentity).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(128),
      ),
    }),
  }),
);
const decodeAllocationPage = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      rowId: Schema.Int,
      unit: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
      allocation: Allocation,
    }),
  ).check(Schema.isMaxLength(16)),
);
const ProcessRow = Schema.Struct({
  unit: Schema.String,
  status: Schema.Literal("drained"),
  allocation: Allocation,
  ownerBytes: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 262144 }))),
  drainBytes: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 262144 }))),
  owner: Schema.NullOr(
    Schema.fromJsonString(
      Schema.Struct({
        unit: Schema.String,
        nonce: Schema.String,
        invocation: Schema.String.check(Schema.isMinLength(1)),
        cgroup: absolute,
        pid: positive,
        memoryBytes: positive,
        swapBytes: Schema.Literal(0),
        oomGroup: Schema.Literal(1),
      }),
    ),
  ),
  drain: Schema.NullOr(
    Schema.fromJsonString(
      Schema.Struct({
        unit: Schema.String,
        invocation: Schema.String,
        cgroup: absolute,
        ownerPid: positive,
        launcherPid: positive,
        childPid: Schema.NullOr(positive),
        childExitCode: Schema.NullOr(Schema.Int),
        memoryBytes: positive,
        swapBytes: Schema.Literal(0),
        oomGroup: Schema.Literal(1),
        kernel: Schema.String.check(Schema.isMaxLength(4096)),
      }),
    ),
  ),
});
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(ProcessRow).check(Schema.isMaxLength(1024)),
);
const fdPath = (directory: Directory) => `/proc/self/fd/${directory.fd}`;
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const overlap = (a: string, b: string) =>
  a === "/" || b === "/" || a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

// Pin every component: canonical strings alone cannot authorize a later chmod or unlink.
async function withDirectory<A>(
  directory: string,
  create: boolean,
  use: (handle: Directory) => Promise<A>,
) {
  const handles: Directory[] = [];
  let result: { readonly success: true; readonly value: A } | { readonly success: false };
  try {
    let handle = await nativeFS.open("/", directoryFlags);
    handles.push(handle);
    let expected = "";
    for (const component of directory.split("/").filter(Boolean)) {
      expected += "/" + component;
      const entry = fdPath(handle) + "/" + component;
      if (create)
        await nativeFS.mkdir(entry, { mode: 0o700 }).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code !== "EEXIST") throw cause;
        });
      const before = await nativeFS.lstat(entry);
      if (!before.isDirectory()) throw unavailable();
      handle = await nativeFS.open(entry, directoryFlags);
      handles.push(handle);
      if (
        !sameIdentity(before, await handle.stat()) ||
        (await nativeFS.realpath(fdPath(handle))) !== expected
      )
        throw unavailable();
    }
    if ((await nativeFS.realpath(directory)) !== directory) throw unavailable();
    result = { success: true, value: await use(handle) };
  } catch {
    result = { success: false };
  }
  const closed = await Promise.allSettled(handles.toReversed().map((handle) => handle.close()));
  if (!result.success || closed.some((entry) => entry.status === "rejected")) throw unavailable();
  return result.value;
}
async function privateDirectory(directory: string, uid: number) {
  return withDirectory(directory, true, async (handle) => {
    const stat = await handle.stat();
    if (stat.uid !== uid || (stat.mode & 0o022) !== 0 || stat.ino < 1) throw unavailable();
    return stat;
  });
}
// Missing private targets are allowed, but every existing ancestor must be a physical directory.
// Inspect with no writes so an alias in any declared root cannot precede state creation.
async function canonicalTarget(directory: string) {
  let existing = directory;
  while (true) {
    try {
      await nativeFS.lstat(existing);
      break;
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
      existing = existing.slice(0, existing.lastIndexOf("/")) || "/";
    }
  }
  await withDirectory(existing, false, async () => undefined);
}
type Stage = {
  readonly directory: string;
  readonly identity: Identity;
  readonly rootIdentity: Identity;
  readonly uid: number;
  entries: ReadonlyArray<{
    readonly name: string;
    readonly target: string;
    readonly identity: Identity;
  }>;
};
async function createStage(root: string, uid: number): Promise<Stage> {
  await privateDirectory(root, uid);
  return withDirectory(root, false, async (handle) => {
    const rootIdentity = await handle.stat();
    if (rootIdentity.uid !== uid || (rootIdentity.mode & 0o022) !== 0) throw unavailable();
    const created = await nativeFS.mkdtemp(fdPath(handle) + "/pi-runtime-");
    const directory = await nativeFS.realpath(created);
    if (!directory.startsWith(root + "/pi-runtime-")) throw unavailable();
    const identity = await nativeFS.lstat(created);
    if (!identity.isDirectory() || identity.uid !== uid || (identity.mode & 0o077) !== 0)
      throw unavailable();
    return { directory, identity, rootIdentity, uid, entries: [] };
  });
}
async function captureEntries(
  stage: Stage,
  files: ReadonlyArray<{ readonly source: string; readonly target: string }>,
) {
  return withDirectory(stage.directory, false, async (handle) => {
    if (!sameIdentity(stage.identity, await handle.stat())) throw unavailable();
    const entries = [];
    for (const { source, target } of files) {
      const name = source.slice(stage.directory.length + 1);
      if (source !== stage.directory + "/" + name || !/^\d{4}$/.test(name)) throw unavailable();
      const identity = await nativeFS.lstat(fdPath(handle) + "/" + name);
      if (
        !identity.isFile() ||
        identity.uid !== stage.uid ||
        identity.nlink !== 1 ||
        (identity.mode & 0o222) !== 0
      )
        throw unavailable();
      entries.push({ name, target, identity });
    }
    return entries;
  });
}
async function removeStage(stage: Stage, root: string) {
  await withDirectory(root, false, async (parent) => {
    const rootStat = await parent.stat();
    if (
      !sameIdentity(rootStat, stage.rootIdentity) ||
      rootStat.uid !== stage.uid ||
      (rootStat.mode & 0o022) !== 0
    )
      throw unavailable();
    await withDirectory(stage.directory, false, async (handle) => {
      const stat = await handle.stat();
      if (
        !sameIdentity(stat, stage.identity) ||
        stat.uid !== stage.uid ||
        (stat.mode & 0o022) !== 0
      )
        throw unavailable();
      const names: string[] = [];
      const directory = await nativeFS.opendir(fdPath(handle));
      try {
        for (;;) {
          const entry = await directory.read();
          if (entry === null) break;
          if (names.length === stage.entries.length) throw unavailable();
          names.push(entry.name);
        }
      } finally {
        await directory.close();
      }
      if (
        names.length !== stage.entries.length ||
        names.some((name) => !stage.entries.some((entry) => entry.name === name))
      )
        throw unavailable();
      for (const entry of stage.entries) {
        const actual = await nativeFS.lstat(fdPath(handle) + "/" + entry.name);
        if (
          !sameIdentity(actual, entry.identity) ||
          !actual.isFile() ||
          actual.nlink !== 1 ||
          actual.uid !== stage.uid ||
          actual.mode !== entry.identity.mode ||
          actual.size !== entry.identity.size ||
          actual.mtimeMs !== entry.identity.mtimeMs ||
          actual.ctimeMs !== entry.identity.ctimeMs
        )
          throw unavailable();
      }
      if (
        !sameIdentity(stat, await nativeFS.lstat(stage.directory)) ||
        (await nativeFS.realpath(fdPath(handle))) !== stage.directory
      )
        throw unavailable();
      await handle.chmod(0o700);
      for (const entry of stage.entries) await nativeFS.unlink(fdPath(handle) + "/" + entry.name);
      if (!sameIdentity(stat, await nativeFS.lstat(stage.directory))) throw unavailable();
      await nativeFS.rmdir(fdPath(parent) + "/" + stage.directory.slice(root.length + 1));
    });
  });
}

/** Root supplies trusted product paths; each enabled instance owns one scoped immutable stage. */
export const makePiProductionRuntime = Effect.fn("makePiProductionRuntime")(function* (
  supplied: PiProductionRuntimeOptions,
) {
  const options = yield* decodeOptions(supplied).pipe(Effect.mapError(unavailable));
  const sql = yield* SqlClient.SqlClient;
  const outsideTransaction = Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* unavailable();
  });
  yield* outsideTransaction;
  const catalogue = yield* PiModelCatalogue;
  const parentFetch = yield* FetchHttpClient.Fetch;
  const path = yield* Path.Path;
  // Instance finalizers belong to its caller's scope, not the factory construction scope.
  const services = (yield* Effect.context<
    Effect.Services<ReturnType<typeof makePiManagedRuntimeLive>>
  >()).pipe(Context.omit(Scope.Scope));
  const readCatalogue = catalogue.readFresh.pipe(
    Effect.map((value) => {
      if (!value) return undefined;
      const { max_output_tokens, ...entry } = value.selectedEntry;
      return {
        source: value.source,
        fetchedAt: value.fetchedAt,
        selectedEntry: {
          ...entry,
          ...(max_output_tokens === undefined ? {} : { max_output_tokens }),
        },
      };
    }),
    Effect.mapError(unavailable),
  );
  const transport: Parameters<typeof makePiManagedRuntimeLive>[0]["transport"] = (endpoint, init) =>
    parentFetch(endpoint, {
      ...init,
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal: init.signal,
    });
  const forInstance: PiManagedRuntime["Service"]["forInstance"] = (instance) =>
    Effect.gen(function* () {
      yield* outsideTransaction;
      if (!instance.enabled) {
        const runtime = yield* makePiManagedRuntimeLive({
          ...options,
          runtimeFiles: [],
          readCatalogue,
          transport,
          workerArgv: () => {
            throw unavailable();
          },
        });
        return yield* runtime.forInstance(instance);
      }
      const uid = yield* HostProcessUserId;
      if (uid === undefined) return yield* unavailable();
      const agentDirectory = instance.configuration.agentDirectory ?? options.agentDirectory;
      for (const root of [
        options.stagingRoot,
        options.nativeStateRoot,
        options.distributionDirectory,
        options.agentDirectory,
        agentDirectory,
        ...options.protectedRoots,
      ]) {
        if (root === "/" || path.resolve(root) !== root) return yield* unavailable();
        yield* native(() => canonicalTarget(root));
      }
      if (
        overlap(options.nativeStateRoot, options.stagingRoot) ||
        [
          options.agentDirectory,
          agentDirectory,
          options.distributionDirectory,
          ...options.protectedRoots,
        ].some(
          (root) => overlap(root, options.stagingRoot) || overlap(root, options.nativeStateRoot),
        )
      )
        return yield* unavailable();
      // Native state survives scope closure and server replacement; only the cache stage is scoped.
      yield* native(() => privateDirectory(options.nativeStateRoot, uid));
      const stage = yield* native(() => createStage(options.stagingRoot, uid));
      let accepting = true;
      let preparing = 0;
      let runtimeFiles: Stage["entries"] | undefined;
      const safeToRelease = Effect.gen(function* () {
        yield* outsideTransaction;
        if (accepting || preparing !== 0 || !runtimeFiles) return false;
        // Validate every bounded closure before filtering its source paths. Keyset pages keep
        // unrelated history out of the matched-stage limit without retaining it in memory.
        const ownedIdentities = new Set(
          stage.entries.map((entry) => `${entry.identity.dev}:${entry.identity.ino}`),
        );
        let cursor: number | undefined;
        let matched = 0;
        while (true) {
          const rows = yield* sql`
          SELECT rowid AS "rowId",
            CASE WHEN length(CAST(unit AS BLOB)) <= 4096 THEN unit ELSE NULL END AS unit, status,
            CASE WHEN length(CAST(allocation_json AS BLOB)) <= 262144 THEN allocation_json ELSE NULL END AS allocation,
            length(CAST(owner_json AS BLOB)) AS "ownerBytes",
            length(CAST(drain_json AS BLOB)) AS "drainBytes",
            CASE WHEN length(CAST(owner_json AS BLOB)) <= 262144 THEN owner_json ELSE NULL END AS owner,
            CASE WHEN length(CAST(drain_json AS BLOB)) <= 262144 THEN drain_json ELSE NULL END AS drain
          FROM project_team_pi_process
          WHERE ${cursor === undefined ? sql`1` : sql`rowid > ${cursor}`}
          ORDER BY rowid LIMIT 16
        `;
          const allocations = yield* decodeAllocationPage(rows);
          for (const row of allocations) {
            const files = row.allocation.launch.runtimeFiles;
            if (
              row.allocation.unit !== row.unit ||
              new Set(files.map((file) => file.source)).size !== files.length ||
              new Set(files.map((file) => file.target)).size !== files.length ||
              files.some(
                (file) =>
                  path.resolve(file.source) !== file.source ||
                  path.resolve(file.target) !== file.target,
              )
            )
              return false;
          }
          const relevant = rows.filter((_, index) =>
            allocations[index]!.allocation.launch.runtimeFiles.some(
              (file) =>
                // A normalized alias can still name an owned inode outside the stage prefix.
                ownedIdentities.has(`${file.dev}:${file.ino}`) ||
                file.source.startsWith(stage.directory + "/"),
            ),
          );
          matched += relevant.length;
          if (matched > 1024) return false;
          const processes = yield* decodeRows(relevant);
          for (const process of processes) {
            const allocation = process.allocation;
            if (allocation.launch.runtimeFiles.length !== stage.entries.length) return false;
            for (const file of allocation.launch.runtimeFiles) {
              const entry = stage.entries.find(
                (entry) => stage.directory + "/" + entry.name === file.source,
              );
              if (
                !entry ||
                entry.target !== file.target ||
                entry.identity.dev !== file.dev ||
                entry.identity.ino !== file.ino
              )
                return false;
            }
            if (!process.owner && !process.drain) continue;
            const owner = process.owner;
            const drain = process.drain;
            if (
              !owner ||
              !drain ||
              owner.unit !== process.unit ||
              owner.nonce !== allocation.nonce ||
              drain.unit !== process.unit ||
              drain.invocation !== owner.invocation ||
              drain.cgroup !== owner.cgroup ||
              drain.ownerPid !== owner.pid ||
              owner.memoryBytes !== allocation.policy.memoryBytes ||
              drain.memoryBytes !== owner.memoryBytes ||
              (drain.kernel !== "removed" && !drain.kernel.split("\n").includes("populated 0"))
            )
              return false;
          }
          if (rows.length < 16) return true;
          cursor = allocations.at(-1)!.rowId;
        }
      }).pipe(
        Effect.timeoutOption(options.cleanupDeadlineMs),
        Effect.map(Option.getOrElse(() => false)),
        Effect.catch(() => Effect.succeed(false)),
      );
      // Registered before Runtime's finalizer: its stop attempt runs first. A caught stop
      // failure never substitutes for durable verified drainage of this exact stage.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          accepting = false;
          if (yield* safeToRelease) yield* native(() => removeStage(stage, options.stagingRoot));
        }).pipe(Effect.catch(() => Effect.void)),
      );
      const assets = yield* preparePiRuntimeAssets({
        distributionDirectory: options.distributionDirectory,
        stagingDirectory: stage.directory,
        protectedRoots: options.protectedRoots,
      }).pipe(Effect.mapError(unavailable));
      stage.entries = yield* native(() => captureEntries(stage, assets.runtimeFiles));
      runtimeFiles = stage.entries;
      const revalidateRuntime = Effect.suspend(() =>
        accepting ? assets.revalidate.pipe(Effect.mapError(unavailable)) : Effect.fail(closed()),
      );
      const liveOptions = {
        ...options,
        runtimeFiles: assets.runtimeFiles,
        readCatalogue,
        transport,
        revalidateRuntime,
        workerArgv: (...args: Parameters<typeof assets.workerArgv>) =>
          assets.workerArgv(args[0], args[1], "/state/sessions"),
      };
      const runtime = yield* makePiManagedRuntimeLive(liveOptions);
      const managed = yield* runtime.forInstance(instance);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          accepting = false;
        }),
      );
      return {
        ...managed,
        prepareOperation: (...args: Parameters<typeof managed.prepareOperation>) =>
          Effect.suspend(() => {
            if (!accepting) return Effect.fail(closed());
            preparing++;
            return managed.prepareOperation(...args).pipe(
              Effect.map((prepared) => ({
                ...prepared,
                run: Effect.suspend(() => (accepting ? prepared.run : Effect.fail(closed()))),
              })),
              Effect.ensuring(
                Effect.sync(() => {
                  preparing--;
                }),
              ),
            );
          }),
      };
    }).pipe(
      Effect.provide(services),
      Effect.mapError(() => unavailable()),
    );
  return PiManagedRuntime.of({ forInstance });
});
