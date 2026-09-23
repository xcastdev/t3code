// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";

import type {
  ManagedSkillContent,
  ManagedSkillContentDraft,
  ManagedSkillId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  SkillCatalogChanged,
  SkillCatalogListResult,
  SkillCompatibility,
  SkillContentDetail,
  SkillContentHash,
  SkillHistoryListResult,
  SkillApplicationDetail,
  SkillMutationResult,
  SkillNativeContentDetail,
  SkillNativeObservationId,
} from "@t3tools/contracts";
import { ManagedSkillKey, SkillCatalogRevision, SkillRpcError, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderSkillPlan } from "./ProviderSkillAdapter.ts";
import {
  ManagedSkillRepository,
  type OwnedSkillPackage,
  type SkillPackageEntry,
} from "./ManagedSkillRepository.ts";
import { NativeSkillObservationService } from "./NativeSkillObservationService.ts";
import { readNativeSkillForImport } from "./NativeSkillImport.ts";
import {
  SkillCatalogIndex,
  toSkillCatalogEntry,
  type SkillCatalogChange,
  type SkillCatalogSnapshot,
} from "./SkillCatalogIndex.ts";
import { projectSkillCatalog } from "./SkillCatalogProjection.ts";
import { resolveSkillCatalog } from "./SkillCatalogResolver.ts";
import { inspectSkillPackage } from "./SkillPackage.ts";
import { SkillWatchService } from "./SkillWatchService.ts";

interface CatalogContext {
  readonly projectId?: ProjectId;
  readonly projectRoot?: string;
  readonly threadId?: string;
  readonly providerInstanceId?: ProviderInstanceId;
}

interface SessionOverlayValue {
  readonly enabled: boolean;
}

export interface SkillCatalogServiceShape {
  readonly currentRevision: Effect.Effect<SkillCatalogRevision>;
  readonly list: (context?: CatalogContext) => Effect.Effect<SkillCatalogListResult, SkillRpcError>;
  readonly content: (
    skillId: ManagedSkillId,
    projectRoot?: string,
  ) => Effect.Effect<SkillContentDetail, SkillRpcError>;
  readonly source: (
    skillId: ManagedSkillId,
    projectRoot?: string,
  ) => Effect.Effect<
    {
      readonly key: ManagedSkillKey;
      readonly packagePath: string;
      readonly hash: SkillContentHash;
    },
    SkillRpcError
  >;
  readonly nativeContent: (input: {
    readonly observationId: SkillNativeObservationId;
    readonly maxBytes: number;
  }) => Effect.Effect<SkillNativeContentDetail, SkillRpcError>;
  readonly history: (
    skillId: ManagedSkillId,
  ) => Effect.Effect<SkillHistoryListResult, SkillRpcError>;
  readonly createGlobal: (input: {
    readonly expectedRevision: number;
    readonly content: ManagedSkillContent;
  }) => Effect.Effect<SkillMutationResult, SkillRpcError>;
  readonly updateGlobal: (input: {
    readonly skillId: ManagedSkillId;
    readonly expectedHash: SkillContentHash;
    readonly content: ManagedSkillContentDraft;
  }) => Effect.Effect<SkillMutationResult, SkillRpcError>;
  readonly deleteGlobal: (input: {
    readonly skillId: ManagedSkillId;
    readonly expectedHash: SkillContentHash;
  }) => Effect.Effect<SkillMutationResult, SkillRpcError>;
  readonly renameGlobal: (input: {
    readonly skillId: ManagedSkillId;
    readonly expectedHash: SkillContentHash;
    readonly key: ManagedSkillKey;
  }) => Effect.Effect<SkillMutationResult, SkillRpcError>;
  readonly rollbackGlobal: (input: {
    readonly skillId: ManagedSkillId;
    readonly expectedHash: SkillContentHash;
    readonly revision: number;
  }) => Effect.Effect<SkillMutationResult, SkillRpcError>;
  readonly importNative: (input: {
    readonly observationId: SkillNativeObservationId;
    readonly expectedRevision: number;
    readonly key: ManagedSkillKey;
  }) => Effect.Effect<SkillMutationResult, SkillRpcError>;
  readonly setProjectOverride: (input: {
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly expectedRevision: number;
    readonly key: ManagedSkillKey;
    readonly content: ManagedSkillContentDraft;
  }) => Effect.Effect<SkillMutationResult, SkillRpcError>;
  readonly setProjectDisabled: (input: {
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly expectedRevision: number;
    readonly key: ManagedSkillKey;
  }) => Effect.Effect<SkillMutationResult, SkillRpcError>;
  readonly deleteProjectState: (input: {
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly expectedRevision: number;
    readonly key: ManagedSkillKey;
  }) => Effect.Effect<SkillMutationResult, SkillRpcError>;
  readonly renameProject: (input: {
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly skillId: ManagedSkillId;
    readonly expectedHash: SkillContentHash;
    readonly key: ManagedSkillKey;
  }) => Effect.Effect<SkillMutationResult, SkillRpcError>;
  readonly setSessionEnabled: (input: {
    readonly threadId: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly expectedRevision: number;
    readonly key: ManagedSkillKey;
    readonly enabled: boolean;
  }) => Effect.Effect<SkillMutationResult, SkillRpcError>;
  readonly resetSession: (input: {
    readonly threadId: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly expectedRevision: number;
    readonly key?: ManagedSkillKey;
  }) => Effect.Effect<SkillMutationResult, SkillRpcError>;
  /** Resolve authored state and let only the owning provider interpret its session plan. */
  readonly prepareSession: (input: {
    readonly threadId: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly projectRoot?: string;
    readonly projectId?: ProjectId;
    readonly cwd: string;
    readonly desiredRevision: SkillCatalogRevision;
    readonly appliedRevision: SkillCatalogRevision;
  }) => Effect.Effect<
    { readonly plan?: ProviderSkillPlan; readonly application: SkillApplicationDetail },
    SkillRpcError
  >;
  readonly describeSession: (input: {
    readonly threadId: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly projectRoot?: string;
    readonly projectId?: ProjectId;
    readonly cwd: string;
    readonly desiredRevision: SkillCatalogRevision;
    readonly appliedRevision: SkillCatalogRevision;
  }) => Effect.Effect<SkillApplicationDetail, SkillRpcError>;
  readonly disposeSession: (input: {
    readonly threadId: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly cwd: string;
  }) => Effect.Effect<void, SkillRpcError>;
  readonly changes: Stream.Stream<SkillCatalogChanged, never, Scope.Scope>;
  readonly notifyInstalledSkillChanged: (
    readers: ReadonlyArray<ProviderDriverKind>,
    key: ManagedSkillKey,
  ) => Effect.Effect<void>;
}

export class SkillCatalogService extends Context.Service<
  SkillCatalogService,
  SkillCatalogServiceShape
>()("t3/skills/SkillCatalogService") {}

const rpcError = (code: string, message: string) => new SkillRpcError({ code, message });
const isSkillRpcError = Schema.is(SkillRpcError);
const isPortableKey = Schema.is(ManagedSkillKey);

/**
 * Index revisions are monotonic per scope, so a replayed invalidation must not
 * advance the service revision or notify clients a second time.
 */
export const acceptCatalogIndexChange = (
  published: Map<string, number>,
  change: Pick<SkillCatalogChange, "scopeId" | "catalogRevision">,
) => {
  if (change.catalogRevision <= (published.get(change.scopeId) ?? -1)) return false;
  published.set(change.scopeId, change.catalogRevision);
  return true;
};

export const make = Effect.gen(function* () {
  const repository = yield* ManagedSkillRepository;
  const nativeObservations = yield* NativeSkillObservationService;
  const instances = yield* ProviderInstanceRegistry;
  const catalogIndex = yield* SkillCatalogIndex;
  const watches = yield* SkillWatchService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const mutationLock = yield* Semaphore.make(1);
  const storedRevision = yield* sql`SELECT revision FROM skill_catalog_revision WHERE id = 1`;
  const initialRevision = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ revision: Schema.Number })),
  )(storedRevision);
  const revision = yield* Ref.make(initialRevision[0]?.revision ?? 0);
  const rows =
    yield* sql`SELECT thread_id, provider_instance_id, skill_key, enabled FROM skill_session_overlays`;
  const storedOverlays = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        thread_id: Schema.String,
        provider_instance_id: Schema.String,
        skill_key: ManagedSkillKey,
        enabled: Schema.Number,
      }),
    ),
  )(rows);
  const overlays = yield* Ref.make<ReadonlyMap<string, SessionOverlayValue>>(
    new Map(
      storedOverlays.map((row) => [
        `${row.thread_id}:${row.provider_instance_id}:${row.skill_key}`,
        { enabled: row.enabled === 1 },
      ]),
    ),
  );
  const advanceRevision =
    sql`UPDATE skill_catalog_revision SET revision = revision + 1 WHERE id = 1 RETURNING revision`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ revision: Schema.Number }))),
      ),
      Effect.flatMap((rows) =>
        Ref.set(revision, rows[0]!.revision).pipe(Effect.as(rows[0]!.revision)),
      ),
      Effect.orDie,
    );
  const changes = yield* PubSub.unbounded<SkillCatalogChanged>();
  const watchedProjects = new Map<string, string>();
  const projectScopeIds = new Map<string, string>();
  const knownProviderIds = new Set<ProviderInstanceId>();
  const publishedIndexRevisions = new Map<string, number>();

  const indexChanges = yield* catalogIndex.subscribe;
  yield* Stream.fromSubscription(indexChanges).pipe(
    Stream.runForEach((change) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const scopeId =
            change.scope === "global"
              ? "global"
              : (projectScopeIds.get(change.scopeId) ?? change.scopeId);
          if (!acceptCatalogIndexChange(publishedIndexRevisions, change)) return;
          yield* advanceRevision.pipe(
            Effect.flatMap((catalogRevision) =>
              PubSub.publish(changes, {
                scope: change.scope,
                scopeId,
                catalogRevision: SkillCatalogRevision.make(catalogRevision),
                changedKeys: change.changedKeys.flatMap((key) => (isPortableKey(key) ? [key] : [])),
              }),
            ),
            Effect.asVoid,
          );
        }),
      ),
    ),
    Effect.forkScoped,
  );

  const mapFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, code = "skill_operation_failed") =>
    effect.pipe(
      Effect.mapError((cause) =>
        isSkillRpcError(cause) ? cause : rpcError(code, "The managed skill operation failed."),
      ),
    );

  const inspect = (packagePath: string) =>
    inspectSkillPackage({ packagePath, expectedScope: "global" }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const snapshot = (
    scope: "global" | "project",
    scopeId: string,
    entries: ReadonlyArray<SkillPackageEntry>,
  ) =>
    ({
      scope,
      scopeId,
      catalogRevision: 0,
      availability: "available",
      entries: entries.map((entry) => toSkillCatalogEntry(entry, scope)),
    }) satisfies SkillCatalogSnapshot;

  const discoverNative = (cwd: string | undefined, requested?: ProviderInstanceId) =>
    cwd === undefined
      ? Effect.succeed([])
      : instances.listInstances.pipe(
          Effect.flatMap((all) => {
            all.forEach((instance) => knownProviderIds.add(instance.instanceId));
            if (requested !== undefined) knownProviderIds.add(requested);
            return Effect.forEach(
              [...knownProviderIds].filter((id) => requested === undefined || id === requested),
              (id) => {
                const instance = all.find((instance) => instance.instanceId === id);
                return instance?.enabled && instance.discoverNativeSkills !== undefined
                  ? nativeObservations.discover({
                      providerInstanceId: id,
                      scopeId: cwd,
                      discovery: instance.discoverNativeSkills(cwd),
                    })
                  : nativeObservations.markUnavailable(id, cwd);
              },
              { concurrency: 4 },
            );
          }),
        );

  const watchProject = Effect.fn("SkillCatalogService.watchProject")(function* (
    context: CatalogContext,
  ) {
    if (context.projectRoot === undefined) return;
    const indexed = watchedProjects.has(context.projectRoot)
      ? undefined
      : yield* watches.acquireProject(context.projectRoot);
    if (indexed !== undefined) watchedProjects.set(context.projectRoot, indexed.scopeId);
    if (indexed !== undefined)
      projectScopeIds.set(indexed.scopeId, context.projectId ?? indexed.scopeId);
    else if (context.projectId !== undefined)
      projectScopeIds.set(watchedProjects.get(context.projectRoot)!, context.projectId);
  });

  const list: SkillCatalogServiceShape["list"] = (context = {}) =>
    mapFailure(
      Effect.gen(function* () {
        yield* watchProject(context);
        const [globalEntries, projectEntries, nativeDiscoveries, catalogRevision, state] =
          yield* Effect.all([
            repository.listGlobal(),
            context.projectRoot === undefined
              ? Effect.succeed([])
              : repository.listProject(context.projectRoot),
            discoverNative(context.projectRoot, context.providerInstanceId),
            Ref.get(revision),
            Ref.get(overlays),
          ]);
        const overlayPrefix = `${context.threadId ?? ""}:${context.providerInstanceId ?? ""}:`;
        const session = [...state.entries()].flatMap(([id, value]) =>
          id.startsWith(overlayPrefix)
            ? [
                {
                  key: id.slice(overlayPrefix.length) as ManagedSkillKey,
                  enabled: value.enabled,
                },
              ]
            : [],
        );
        const resolved = resolveSkillCatalog({
          global: {
            ...snapshot("global", "global", [...globalEntries]),
            catalogRevision,
          },
          ...(context.projectRoot === undefined
            ? {}
            : {
                project: {
                  ...snapshot("project", context.projectId ?? "project", [...projectEntries]),
                  catalogRevision,
                },
              }),
          session,
          nativeDiscoveries,
        });
        const availableInstances = yield* instances.listInstances;
        const requestedInstances = availableInstances.filter(
          (instance) =>
            context.providerInstanceId === undefined ||
            instance.instanceId === context.providerInstanceId,
        );
        const compatibilityByKey = new Map<ManagedSkillKey, ReadonlyArray<SkillCompatibility>>();
        for (const requestedInstance of requestedInstances) {
          if (requestedInstance.skillAdapter === undefined) continue;
          const runtime = {
            providerInstanceId: requestedInstance.instanceId,
            cwd: context.projectRoot ?? process.cwd(),
            sessionId: `catalog-${NodeCrypto.createHash("sha256")
              .update(context.threadId ?? context.projectRoot ?? "global")
              .digest("hex")
              .slice(0, 24)}`,
            ...(context.threadId ? { threadId: context.threadId } : {}),
          };
          for (const item of resolved.byKey.values()) {
            if (item.winner === undefined) continue;
            const source = item.winner.scope === "global" ? globalEntries : projectEntries;
            const packagePath = source[item.winner.candidateIndex]?.packagePath;
            if (packagePath === undefined) continue;
            const key = item.key as ManagedSkillKey;
            compatibilityByKey.set(key, [
              ...(compatibilityByKey.get(key) ?? []),
              requestedInstance.skillAdapter.evaluateCompatibility({ key, packagePath }, runtime),
            ]);
          }
        }
        return {
          ...projectSkillCatalog(resolved, { compatibilityByKey }),
          installProviderInstances: availableInstances
            .filter((instance) => instance.enabled && instance.skillInstallTargets !== undefined)
            .map((instance) => instance.instanceId),
          nativeDiscoveries: nativeDiscoveries.map(
            ({ observations: _observations, ...discovery }) => discovery,
          ),
        };
      }),
    );

  const packageDetail = (value: OwnedSkillPackage): SkillContentDetail => {
    return {
      metadata: {
        id: value.manifest.id,
        key: value.manifest.key,
        name: value.content.name,
        scope: value.manifest.scope,
        scopeId: value.manifest.scope === "global" ? "global" : "project",
        origin: value.manifest.origin,
        ownership: value.manifest.ownership,
        revision: value.manifest.revision,
      },
      content: value.content,
    };
  };

  const content: SkillCatalogServiceShape["content"] = (skillId, projectRoot) =>
    Effect.gen(function* () {
      const global = yield* repository.readGlobal(skillId).pipe(Effect.result);
      if (Result.isSuccess(global)) return packageDetail(global.success);
      if (projectRoot === undefined)
        return yield* rpcError("not_found", "Managed skill was not found.");
      const project = yield* repository.readProject(projectRoot, skillId).pipe(Effect.result);
      if (Result.isFailure(project))
        return yield* rpcError("not_found", "Managed skill was not found.");
      if (project.success.content === undefined)
        return yield* rpcError(
          "content_unavailable",
          "Disabled project state has no authored content.",
        );
      return packageDetail(project.success);
    });

  const source: SkillCatalogServiceShape["source"] = (skillId, projectRoot) =>
    Effect.gen(function* () {
      const global = yield* repository.readGlobal(skillId).pipe(Effect.result);
      if (Result.isSuccess(global)) {
        return {
          key: global.success.manifest.key,
          packagePath: global.success.packagePath,
          hash: global.success.manifest.revision.hash,
        };
      }
      if (projectRoot === undefined)
        return yield* rpcError("not_found", "Managed skill was not found.");
      const project = yield* repository.readProject(projectRoot, skillId).pipe(Effect.result);
      if (Result.isFailure(project) || project.success.content === undefined) {
        return yield* rpcError("not_found", "Managed skill was not found.");
      }
      return {
        key: project.success.manifest.key,
        packagePath: project.success.packagePath,
        hash: project.success.manifest.revision.hash,
      };
    });

  const nativeContent: SkillCatalogServiceShape["nativeContent"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        const observation = yield* nativeObservations.getObservation(input.observationId);
        if (observation === undefined) {
          return yield* rpcError("not_found", "Native skill observation was not found.");
        }
        if (observation.contentAccess === "external") {
          return yield* rpcError(
            "external_filesystem",
            "This skill belongs to an external provider server. T3 cannot read or import its filesystem.",
          );
        }
        const selected = yield* Effect.tryPromise({
          try: async () => {
            const handle = await NodeFSP.open(
              observation.nativePath,
              NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
            );
            try {
              const info = await handle.stat();
              if (!info.isFile()) throw new Error("Native skill content is not a regular file.");
              const bytes = new Uint8Array(input.maxBytes + 1);
              const read = await handle.read(bytes, 0, bytes.length, 0);
              return bytes.slice(0, read.bytesRead);
            } finally {
              await handle.close();
            }
          },
          catch: () => rpcError("native_read_failed", "Native skill content could not be read."),
        });
        const { nativePath: _nativePath, ...clientObservation } = observation;
        return {
          observation: clientObservation,
          content: new TextDecoder().decode(selected.slice(0, input.maxBytes)),
          truncated: selected.length > input.maxBytes,
          provenance: path.basename(path.dirname(observation.nativePath)),
        };
      }),
    );

  const history: SkillCatalogServiceShape["history"] = (skillId) =>
    mapFailure(
      Effect.gen(function* () {
        const entries = yield* repository.listGlobalHistory(skillId);
        return {
          entries: yield* Effect.forEach(
            [...entries].sort((left, right) => right.revision - left.revision),
            (entry) =>
              Effect.gen(function* () {
                const inspected = yield* inspect(entry.packagePath);
                if (
                  inspected.validity !== "valid" ||
                  inspected.manifest === undefined ||
                  inspected.content === undefined
                ) {
                  return yield* rpcError("invalid_history", "A history snapshot is invalid.");
                }
                const stat = yield* Effect.tryPromise({
                  try: () => NodeFSP.stat(entry.packagePath),
                  catch: () => rpcError("history_read_failed", "Skill history could not be read."),
                });
                return {
                  revision: inspected.manifest.revision,
                  createdAt: stat.mtime.toISOString(),
                  name: inspected.content.name,
                };
              }),
          ),
        };
      }),
    );

  const publish = Effect.fn("SkillCatalogService.publish")(function* (
    scope: SkillCatalogChanged["scope"],
    scopeId: string,
    changedKeys: ReadonlyArray<ManagedSkillKey>,
  ) {
    if (scope === "global") {
      const indexed = yield* catalogIndex.refreshGlobal;
      publishedIndexRevisions.set(indexed.scopeId, indexed.catalogRevision);
    } else if (scope === "project") {
      for (const [root, indexedScopeId] of watchedProjects) {
        if (projectScopeIds.get(indexedScopeId) !== scopeId) continue;
        const indexed = yield* catalogIndex
          .refreshProject(root)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (indexed !== undefined)
          publishedIndexRevisions.set(indexed.scopeId, indexed.catalogRevision);
      }
    }
    const next = yield* advanceRevision;
    yield* PubSub.publish(changes, {
      scope,
      scopeId,
      catalogRevision: next as SkillCatalogRevision,
      changedKeys: [...changedKeys],
    });
    return next as SkillCatalogRevision;
  });

  const mutationResult = (catalogRevision: SkillCatalogRevision, keys: ManagedSkillKey[]) => ({
    catalogRevision,
    changedKeys: keys,
  });

  const createGlobal: SkillCatalogServiceShape["createGlobal"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        const current = yield* Ref.get(revision);
        if (input.expectedRevision !== current)
          return yield* rpcError("revision_conflict", "The skill catalog changed.");
        yield* repository.createGlobal({ expectedRevision: 0, content: input.content });
        return mutationResult(yield* publish("global", "global", [input.content.key]), [
          input.content.key,
        ]);
      }),
    );

  const updateGlobal: SkillCatalogServiceShape["updateGlobal"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        const updated = yield* repository.updateGlobal(input);
        const next = yield* publish("global", "global", [updated.manifest.key]);
        return mutationResult(next, [updated.manifest.key]);
      }),
    );

  const deleteGlobal: SkillCatalogServiceShape["deleteGlobal"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        const current = yield* repository.readGlobal(input.skillId);
        yield* repository.deleteGlobal(input);
        const next = yield* publish("global", "global", [current.manifest.key]);
        return mutationResult(next, [current.manifest.key]);
      }),
    );

  const renameGlobal: SkillCatalogServiceShape["renameGlobal"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        const current = yield* repository.readGlobal(input.skillId);
        yield* repository.renameGlobal(input);
        const keys = [current.manifest.key, input.key];
        return mutationResult(yield* publish("global", "global", keys), keys);
      }),
    );

  const rollbackGlobal: SkillCatalogServiceShape["rollbackGlobal"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        const restored = yield* repository.rollbackGlobal(input);
        const next = yield* publish("global", "global", [restored.manifest.key]);
        return mutationResult(next, [restored.manifest.key]);
      }),
    );

  const assertRevision = (expected: number) =>
    Ref.get(revision).pipe(
      Effect.filterOrFail(
        (current) => current === expected,
        () => rpcError("revision_conflict", "The skill catalog changed."),
      ),
    );

  const setProjectOverride: SkillCatalogServiceShape["setProjectOverride"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        yield* assertRevision(input.expectedRevision);
        yield* watchProject(input);
        const current = (yield* repository.listProject(input.projectRoot)).find(
          (candidate) => candidate.manifest?.key === input.key,
        );
        const updated = yield* repository.setProjectOverride({
          ...input,
          ...(current?.hash === undefined ? {} : { expectedHash: current.hash }),
        });
        return mutationResult(yield* publish("project", input.projectId, [updated.manifest.key]), [
          updated.manifest.key,
        ]);
      }),
    );

  const setProjectDisabled: SkillCatalogServiceShape["setProjectDisabled"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        yield* assertRevision(input.expectedRevision);
        yield* watchProject(input);
        const current = (yield* repository.listProject(input.projectRoot)).find(
          (candidate) => candidate.manifest?.key === input.key,
        );
        yield* repository.setProjectDisabled({
          ...input,
          ...(current?.hash === undefined ? {} : { expectedHash: current.hash }),
        });
        return mutationResult(yield* publish("project", input.projectId, [input.key]), [input.key]);
      }),
    );

  const deleteProjectState: SkillCatalogServiceShape["deleteProjectState"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        yield* assertRevision(input.expectedRevision);
        yield* watchProject(input);
        const entry = (yield* repository.listProject(input.projectRoot)).find(
          (candidate) => candidate.manifest?.key === input.key,
        );
        if (entry?.hash === undefined)
          return yield* rpcError("not_found", "Project skill state was not found.");
        yield* repository.deleteProjectState({
          projectRoot: input.projectRoot,
          key: input.key,
          expectedHash: entry.hash,
        });
        return mutationResult(yield* publish("project", input.projectId, [input.key]), [input.key]);
      }),
    );

  const renameProject: SkillCatalogServiceShape["renameProject"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        yield* watchProject(input);
        const current = yield* repository.readProject(input.projectRoot, input.skillId);
        yield* repository.renameProject(input);
        const keys = [current.manifest.key, input.key];
        return mutationResult(yield* publish("project", input.projectId, keys), keys);
      }),
    );

  const overlayId = (threadId: string, provider: ProviderInstanceId, key: ManagedSkillKey) =>
    `${threadId}:${provider}:${key}`;
  const setSessionEnabled: SkillCatalogServiceShape["setSessionEnabled"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        yield* assertRevision(input.expectedRevision);
        yield* sql`INSERT INTO skill_session_overlays (thread_id, provider_instance_id, skill_key, enabled)
            VALUES (${input.threadId}, ${input.providerInstanceId}, ${input.key}, ${input.enabled ? 1 : 0})
            ON CONFLICT (thread_id, provider_instance_id, skill_key) DO UPDATE SET enabled = excluded.enabled`;
        yield* Ref.update(overlays, (current) => {
          const next = new Map(current);
          next.set(overlayId(input.threadId, input.providerInstanceId, input.key), {
            enabled: input.enabled,
          });
          return next;
        });
        return mutationResult(yield* publish("session", input.threadId, [input.key]), [input.key]);
      }),
    );
  const resetSession: SkillCatalogServiceShape["resetSession"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        yield* assertRevision(input.expectedRevision);
        if (input.key === undefined) {
          yield* sql`DELETE FROM skill_session_overlays WHERE thread_id = ${input.threadId} AND provider_instance_id = ${input.providerInstanceId}`;
        } else {
          yield* sql`DELETE FROM skill_session_overlays WHERE thread_id = ${input.threadId} AND provider_instance_id = ${input.providerInstanceId} AND skill_key = ${input.key}`;
        }
        const prefix = `${input.threadId}:${input.providerInstanceId}:`;
        const changed = yield* Ref.modify(overlays, (current) => {
          const next = new Map(current);
          const keys: ManagedSkillKey[] = [];
          for (const id of current.keys()) {
            if (
              id.startsWith(prefix) &&
              (input.key === undefined ||
                id === overlayId(input.threadId, input.providerInstanceId, input.key))
            ) {
              keys.push(id.slice(prefix.length) as ManagedSkillKey);
              next.delete(id);
            }
          }
          return [keys, next] as const;
        });
        return mutationResult(yield* publish("session", input.threadId, changed), changed);
      }),
    );

  const resolveSession = Effect.fn("SkillCatalogService.resolveSession")(function* (input: {
    readonly threadId: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly projectRoot?: string;
    readonly projectId?: ProjectId;
    readonly cwd: string;
    readonly desiredRevision: SkillCatalogRevision;
    readonly appliedRevision: SkillCatalogRevision;
  }) {
    yield* watchProject(input);
    const instance = yield* instances.getInstance(input.providerInstanceId);
    const adapter = instance?.skillAdapter;
    const [globalEntries, projectEntries, state] = yield* Effect.all([
      repository.listGlobal(),
      input.projectRoot === undefined
        ? Effect.succeed([])
        : repository.listProject(input.projectRoot),
      Ref.get(overlays),
    ]);
    const overlayPrefix = `${input.threadId}:${input.providerInstanceId}:`;
    const session = [...state.entries()].flatMap(([id, value]) =>
      id.startsWith(overlayPrefix)
        ? [{ key: id.slice(overlayPrefix.length) as ManagedSkillKey, enabled: value.enabled }]
        : [],
    );
    const resolved = resolveSkillCatalog({
      global: snapshot("global", "global", globalEntries),
      ...(input.projectRoot === undefined
        ? {}
        : { project: snapshot("project", "project", projectEntries) }),
      session,
    });
    const winners = [...resolved.byKey.values()].flatMap((item) => {
      if (!item.effective || item.winner === undefined) return [];
      const source = item.winner.scope === "global" ? globalEntries : projectEntries;
      const packagePath = source[item.winner.candidateIndex]?.packagePath;
      return packagePath === undefined ? [] : [{ key: item.key as ManagedSkillKey, packagePath }];
    });
    const runtime = {
      providerInstanceId: input.providerInstanceId,
      cwd: input.cwd,
      sessionId: `thread-${NodeCrypto.createHash("sha256").update(input.threadId).digest("hex").slice(0, 24)}`,
      threadId: input.threadId,
    };
    const compatibility = winners.map(
      (skill) =>
        adapter?.evaluateCompatibility(skill, runtime) ?? {
          providerInstanceId: input.providerInstanceId,
          support: "unsupported" as const,
          applicationMode: "unsupported" as const,
          reasons: [
            {
              code: "provider_adapter_unavailable",
              message: "This provider does not expose managed skill delivery.",
            },
          ],
        },
    );
    const supported = compatibility.every((value) => value.support !== "unsupported");
    const status = !supported
      ? ("unsupported" as const)
      : compatibility.some((value) => value.applicationMode === "restart_required")
        ? ("pending_restart" as const)
        : ("pending_new_session" as const);
    const application: SkillApplicationDetail = {
      providerInstanceId: input.providerInstanceId,
      threadId: ThreadId.make(input.threadId),
      desiredRevision: input.desiredRevision,
      appliedRevision: input.appliedRevision,
      status,
      outcomes: winners.map((skill, index) => ({
        key: skill.key,
        status: compatibility[index]?.support === "unsupported" ? "unsupported" : status,
        ...(compatibility[index]?.reasons[0] === undefined
          ? {}
          : { reason: compatibility[index]!.reasons[0] }),
      })),
    };
    return { adapter, supported, application, runtime, winners };
  });

  const describeSession: SkillCatalogServiceShape["describeSession"] = (input) =>
    mapFailure(resolveSession(input).pipe(Effect.map((resolved) => resolved.application)));

  const prepareSession: SkillCatalogServiceShape["prepareSession"] = (input) =>
    mapFailure(
      resolveSession(input).pipe(
        Effect.flatMap(({ adapter, supported, application, runtime, winners }) =>
          winners.length === 0 || adapter === undefined || !supported
            ? Effect.succeed({ application })
            : adapter
                .prepareSession({
                  runtime,
                  desiredRevision: input.desiredRevision,
                  skills: winners,
                })
                .pipe(Effect.map((plan) => ({ plan, application }))),
        ),
      ),
    );

  const disposeSession: SkillCatalogServiceShape["disposeSession"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        const instance = yield* instances.getInstance(input.providerInstanceId);
        if (instance?.skillAdapter === undefined) return;
        yield* instance.skillAdapter.disposeSession({
          providerInstanceId: input.providerInstanceId,
          cwd: input.cwd,
          sessionId: `thread-${NodeCrypto.createHash("sha256").update(input.threadId).digest("hex").slice(0, 24)}`,
          threadId: input.threadId,
        });
      }),
    );

  const importNative: SkillCatalogServiceShape["importNative"] = (input) =>
    mapFailure(
      Effect.gen(function* () {
        yield* assertRevision(input.expectedRevision);
        const observation = yield* nativeObservations.getObservation(input.observationId);
        if (observation === undefined) {
          return yield* rpcError("not_found", "Native skill observation was not found.");
        }
        if (observation.contentAccess === "external") {
          return yield* rpcError(
            "external_filesystem",
            "This skill belongs to an external provider server. T3 cannot read or import its filesystem.",
          );
        }
        const imported = yield* readNativeSkillForImport({
          nativePath: observation.nativePath,
          key: input.key,
        }).pipe(Effect.mapError((error) => rpcError(error.code, error.detail)));
        const created = yield* repository.importGlobal({
          expectedRevision: 0,
          content: imported.content,
          files: imported.files,
        });
        const next = yield* publish("global", "global", [created.manifest.key]);
        return mutationResult(next, [created.manifest.key]);
      }),
    );

  const providerChanges = yield* instances.subscribeChanges;
  yield* Stream.fromSubscription(providerChanges).pipe(
    Stream.runForEach(() =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const available = yield* instances.listInstances;
          const unavailable = yield* instances.listUnavailable;
          available.forEach((instance) => knownProviderIds.add(instance.instanceId));
          unavailable.forEach((instance) => knownProviderIds.add(instance.instanceId));
          for (const id of knownProviderIds) yield* publish("provider", id, []);
        }),
      ),
    ),
    Effect.forkScoped,
  );

  return SkillCatalogService.of({
    currentRevision: Ref.get(revision).pipe(Effect.map(SkillCatalogRevision.make)),
    list,
    content,
    source,
    nativeContent,
    history,
    createGlobal: (input) => mutationLock.withPermits(1)(createGlobal(input)),
    updateGlobal: (input) => mutationLock.withPermits(1)(updateGlobal(input)),
    deleteGlobal: (input) => mutationLock.withPermits(1)(deleteGlobal(input)),
    renameGlobal: (input) => mutationLock.withPermits(1)(renameGlobal(input)),
    rollbackGlobal: (input) => mutationLock.withPermits(1)(rollbackGlobal(input)),
    importNative: (input) => mutationLock.withPermits(1)(importNative(input)),
    setProjectOverride: (input) => mutationLock.withPermits(1)(setProjectOverride(input)),
    setProjectDisabled: (input) => mutationLock.withPermits(1)(setProjectDisabled(input)),
    deleteProjectState: (input) => mutationLock.withPermits(1)(deleteProjectState(input)),
    renameProject: (input) => mutationLock.withPermits(1)(renameProject(input)),
    setSessionEnabled: (input) => mutationLock.withPermits(1)(setSessionEnabled(input)),
    resetSession: (input) => mutationLock.withPermits(1)(resetSession(input)),
    describeSession,
    prepareSession,
    disposeSession,
    notifyInstalledSkillChanged: (readers, key) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const available = yield* instances.listInstances;
          for (const instance of available) {
            if (readers.includes(instance.driverKind))
              yield* publish("provider", instance.instanceId, [key]);
          }
        }).pipe(Effect.orDie),
      ),
    changes: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(SkillCatalogService, make);
