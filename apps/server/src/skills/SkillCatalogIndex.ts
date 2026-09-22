// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import type { ManagedSkillId, SkillContentHash } from "@t3tools/contracts";

import { ManagedSkillRepository, type SkillPackageEntry } from "./ManagedSkillRepository.ts";

export type SkillCatalogScope = "global" | "project";

export interface SkillCatalogDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface SkillCatalogEntry {
  readonly key: string;
  readonly validity: "valid" | "invalid";
  readonly diagnostics: ReadonlyArray<SkillCatalogDiagnostic>;
  readonly skillId?: ManagedSkillId;
  readonly name?: string;
  readonly revision?: number;
  readonly hash?: SkillContentHash;
  readonly state: "global" | "override" | "disabled" | "invalid";
}

export interface SkillCatalogUnavailable {
  readonly code: "scan_failed";
  readonly message: "Managed skill catalog is temporarily unavailable.";
}

export interface SkillCatalogSnapshot {
  readonly scope: SkillCatalogScope;
  readonly scopeId: string;
  readonly catalogRevision: number;
  readonly availability: "available" | "unavailable";
  readonly error?: SkillCatalogUnavailable;
  readonly entries: ReadonlyArray<SkillCatalogEntry>;
}

export interface SkillCatalogChange {
  readonly scope: SkillCatalogScope;
  readonly scopeId: string;
  readonly catalogRevision: number;
  readonly changedKeys: ReadonlyArray<string>;
}

export class SkillCatalogScopeNotAcquired extends Schema.TaggedError<SkillCatalogScopeNotAcquired>()(
  "SkillCatalogScopeNotAcquired",
  { scopeId: Schema.String },
) {}

interface ScopeRecord {
  readonly root: string | undefined;
  readonly snapshot: Ref.Ref<SkillCatalogSnapshot>;
  readonly refreshSemaphore: Semaphore.Semaphore;
  readonly references: Ref.Ref<number>;
}

export interface ProjectLease {
  readonly canonicalRoot: string;
  readonly release: Effect.Effect<void>;
}

type AcquireProjectOwned = (
  projectRoot: string,
  claimLease: (lease: ProjectLease) => void,
  onLeaseClaimed?: Effect.Effect<void>,
) => Effect.Effect<SkillCatalogSnapshot>;

const ownedAcquisitions = new WeakMap<SkillCatalogIndexService, AcquireProjectOwned>();

/** @internal */
export const acquireProjectOwned = (
  service: SkillCatalogIndexService,
  projectRoot: string,
  claimLease: (lease: ProjectLease) => void,
  onLeaseClaimed?: Effect.Effect<void>,
) => {
  const acquire = ownedAcquisitions.get(service);
  return acquire === undefined
    ? Effect.die("Unknown SkillCatalogIndex service")
    : acquire(projectRoot, claimLease, onLeaseClaimed);
};

export interface SkillCatalogIndexService {
  readonly getGlobal: Effect.Effect<SkillCatalogSnapshot>;
  readonly acquireProject: (projectRoot: string) => Effect.Effect<SkillCatalogSnapshot>;
  readonly releaseProject: (projectRoot: string) => Effect.Effect<void>;
  readonly getProject: (
    projectRoot: string,
  ) => Effect.Effect<SkillCatalogSnapshot, SkillCatalogScopeNotAcquired>;
  readonly refreshGlobal: Effect.Effect<SkillCatalogSnapshot>;
  readonly refreshProject: (
    projectRoot: string,
  ) => Effect.Effect<SkillCatalogSnapshot, SkillCatalogScopeNotAcquired>;
  readonly subscribe: Effect.Effect<PubSub.Subscription<SkillCatalogChange>, never, Scope.Scope>;
}

export class SkillCatalogIndex extends Context.Service<
  SkillCatalogIndex,
  SkillCatalogIndexService
>()("t3/skills/SkillCatalogIndex") {}

const unavailable = {
  code: "scan_failed",
  message: "Managed skill catalog is temporarily unavailable.",
} as const;

const projectScopeId = (root: string) =>
  `project:${NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 24)}`;

const sameDiagnostics = (
  left: ReadonlyArray<SkillCatalogDiagnostic>,
  right: ReadonlyArray<SkillCatalogDiagnostic>,
) =>
  left.length === right.length &&
  left.every(
    (diagnostic, index) =>
      diagnostic.code === right[index]?.code && diagnostic.message === right[index]?.message,
  );

const sameEntry = (left: SkillCatalogEntry, right: SkillCatalogEntry) =>
  left.key === right.key &&
  left.validity === right.validity &&
  left.skillId === right.skillId &&
  left.name === right.name &&
  left.revision === right.revision &&
  left.hash === right.hash &&
  left.state === right.state &&
  sameDiagnostics(left.diagnostics, right.diagnostics);

const changedKeys = (
  previous: ReadonlyArray<SkillCatalogEntry>,
  next: ReadonlyArray<SkillCatalogEntry>,
) => {
  const before = new Map(previous.map((entry) => [entry.key, entry]));
  const after = new Map(next.map((entry) => [entry.key, entry]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => {
      const left = before.get(key);
      const right = after.get(key);
      return left === undefined || right === undefined || !sameEntry(left, right);
    })
    .sort((left, right) => left.localeCompare(right));
};

export const toSkillCatalogEntry = (
  entry: SkillPackageEntry,
  scope: SkillCatalogScope,
): SkillCatalogEntry => {
  const scrub = (value: string) => value.split(entry.packagePath).join("<skill>");
  const diagnostics = entry.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: scrub(diagnostic.message),
  }));
  if (entry.validity === "invalid" || entry.manifest === undefined) {
    return {
      key: entry.directoryName,
      validity: "invalid",
      diagnostics,
      state: "invalid",
    };
  }
  return {
    key: entry.manifest.key,
    validity: "valid",
    diagnostics,
    skillId: entry.manifest.id,
    ...(entry.content === undefined ? {} : { name: entry.content.name }),
    revision: entry.manifest.revision.revision,
    hash: entry.manifest.revision.hash,
    state: scope === "global" ? "global" : (entry.projectState ?? "override"),
  };
};

const sameSnapshotState = (
  snapshot: SkillCatalogSnapshot,
  availability: SkillCatalogSnapshot["availability"],
  entries: ReadonlyArray<SkillCatalogEntry>,
) =>
  snapshot.availability === availability &&
  snapshot.entries.length === entries.length &&
  snapshot.entries.every((entry, index) => {
    const next = entries[index];
    return next !== undefined && sameEntry(entry, next);
  });

export const make = Effect.gen(function* () {
  const repository = yield* ManagedSkillRepository;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const changes = yield* PubSub.unbounded<SkillCatalogChange>();
  const revision = yield* Ref.make(0);
  const projects = yield* Ref.make<ReadonlyMap<string, ScopeRecord>>(new Map());
  const projectsSemaphore = yield* Semaphore.make(1);

  const canonicalProjectRoot = (projectRoot: string) =>
    fs.realPath(projectRoot).pipe(Effect.orElseSucceed(() => path.resolve(projectRoot)));

  const makeRecord = Effect.fn("SkillCatalogIndex.makeRecord")(function* (
    scope: SkillCatalogScope,
    scopeId: string,
    root?: string,
  ) {
    return {
      root,
      snapshot: yield* Ref.make<SkillCatalogSnapshot>({
        scope,
        scopeId,
        catalogRevision: 0,
        availability: "unavailable",
        error: unavailable,
        entries: [],
      }),
      refreshSemaphore: yield* Semaphore.make(1),
      references: yield* Ref.make(scope === "global" ? 1 : 0),
    } satisfies ScopeRecord;
  });

  const global = yield* makeRecord("global", "global");

  const refreshRecord = (record: ScopeRecord) =>
    record.refreshSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const previous = yield* Ref.get(record.snapshot);
        const scan = yield* (
          record.root === undefined ? repository.listGlobal() : repository.listProject(record.root)
        ).pipe(Effect.result);
        const nextEntries = Result.isSuccess(scan)
          ? scan.success
              .map((entry) => toSkillCatalogEntry(entry, previous.scope))
              .sort((left, right) => left.key.localeCompare(right.key))
          : previous.entries;
        const availability = Result.isSuccess(scan) ? "available" : "unavailable";
        if (sameSnapshotState(previous, availability, nextEntries)) return previous;

        const catalogRevision = yield* Ref.updateAndGet(revision, (value) => value + 1);
        const next: SkillCatalogSnapshot = {
          scope: previous.scope,
          scopeId: previous.scopeId,
          catalogRevision,
          availability,
          ...(availability === "unavailable" ? { error: unavailable } : {}),
          entries: nextEntries,
        };
        yield* Ref.set(record.snapshot, next);
        yield* PubSub.publish(changes, {
          scope: next.scope,
          scopeId: next.scopeId,
          catalogRevision,
          changedKeys: Result.isSuccess(scan) ? changedKeys(previous.entries, nextEntries) : [],
        }).pipe(Effect.asVoid);
        return next;
      }),
    );

  yield* refreshRecord(global);

  const findProject = Effect.fn("SkillCatalogIndex.findProject")(function* (projectRoot: string) {
    const canonicalRoot = yield* canonicalProjectRoot(projectRoot);
    const record = (yield* Ref.get(projects)).get(canonicalRoot);
    if (record === undefined) {
      return yield* new SkillCatalogScopeNotAcquired({ scopeId: projectScopeId(canonicalRoot) });
    }
    return record;
  });

  const acquireProjectOwnedImpl: AcquireProjectOwned = (projectRoot, claimLease, onLeaseClaimed) =>
    Effect.gen(function* () {
      const canonicalRoot = yield* canonicalProjectRoot(projectRoot);
      return yield* projectsSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(projects);
          const existing = current.get(canonicalRoot);
          const record =
            existing ??
            (yield* makeRecord("project", projectScopeId(canonicalRoot), canonicalRoot));
          const snapshot =
            existing === undefined ? yield* refreshRecord(record) : yield* Ref.get(record.snapshot);
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (existing === undefined) {
                yield* Ref.set(projects, new Map(current).set(canonicalRoot, record));
                yield* Ref.set(record.references, 1);
              } else {
                yield* Ref.update(record.references, (value) => value + 1);
              }
              const released = yield* Ref.make(false);
              const lease: ProjectLease = {
                canonicalRoot,
                release: projectsSemaphore.withPermits(1)(
                  Ref.modify(released, (alreadyReleased) => [!alreadyReleased, true] as const).pipe(
                    Effect.flatMap((shouldRelease) =>
                      shouldRelease
                        ? Effect.gen(function* () {
                            const latest = yield* Ref.get(projects);
                            if (latest.get(canonicalRoot) !== record) return;
                            const references = yield* Ref.updateAndGet(record.references, (value) =>
                              Math.max(0, value - 1),
                            );
                            if (references > 0) return;
                            const next = new Map(latest);
                            next.delete(canonicalRoot);
                            yield* Ref.set(projects, next);
                          })
                        : Effect.void,
                    ),
                  ),
                ),
              };
              yield* Effect.sync(() => claimLease(lease));
              yield* onLeaseClaimed ?? Effect.void;
              return snapshot;
            }),
          );
        }),
      );
    });

  const acquireProject = (projectRoot: string) =>
    Effect.suspend(() => {
      let lease: ProjectLease | undefined;
      return Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Effect.interruptible(
              acquireProjectOwnedImpl(projectRoot, (claimed) => (lease = claimed)),
            ),
          );
          if (!Exit.isSuccess(exit) && lease !== undefined) yield* lease.release;
          if (Exit.isSuccess(exit)) lease = undefined;
          return yield* exit;
        }),
      );
    });

  const releaseProject = (projectRoot: string) =>
    projectsSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const canonicalRoot = yield* canonicalProjectRoot(projectRoot);
        const current = yield* Ref.get(projects);
        const record = current.get(canonicalRoot);
        if (record === undefined) return;
        const references = yield* Ref.updateAndGet(record.references, (value) =>
          Math.max(0, value - 1),
        );
        if (references > 0) return;
        const next = new Map(current);
        next.delete(canonicalRoot);
        yield* Ref.set(projects, next);
      }),
    );

  const service = SkillCatalogIndex.of({
    getGlobal: Ref.get(global.snapshot),
    acquireProject,
    releaseProject,
    getProject: (projectRoot) =>
      Effect.flatMap(findProject(projectRoot), (record) => Ref.get(record.snapshot)),
    refreshGlobal: refreshRecord(global),
    refreshProject: (projectRoot) => Effect.flatMap(findProject(projectRoot), refreshRecord),
    subscribe: PubSub.subscribe(changes),
  });
  ownedAcquisitions.set(service, acquireProjectOwnedImpl);
  return service;
});

export const layer = Layer.effect(SkillCatalogIndex, make);
