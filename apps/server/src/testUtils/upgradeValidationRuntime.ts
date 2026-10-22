import * as ProjectWorkRunAdmission from "../projectWork/ProjectWorkRunAdmission.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Test-only filesystem access is restricted to disposable roots.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodePlatformPath from "@effect/platform-node/NodePath";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import { layerFixtureServicesForMode } from "./upgradeFixtureServices.ts";
import { layerFixtureFilesystem, layerFixtureWorkspace } from "./upgradeFixtureFilesystem.ts";
import { upgradeFixtureRoots } from "./upgradeFixtureRoots.ts";
import { layerFixtureNative } from "./upgradeFixtureNative.ts";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import {
  assertDisposablePath,
  assertPreparedUpgradeSnapshot,
  type UpgradeSnapshot,
} from "./prepareUpgradeSnapshot.ts";

export class UpgradeValidationDenied extends Schema.TaggedError<UpgradeValidationDenied>()(
  "UpgradeValidationDenied",
  { operation: Schema.String },
) {
  override get message() {
    return `Upgrade fixture denies ${this.operation}.`;
  }
}

export class UpgradeValidationEffects extends Context.Service<
  UpgradeValidationEffects,
  {
    readonly readFile: (
      projectId: string,
      relativePath: string,
    ) => Effect.Effect<string, UpgradeValidationDenied>;
  }
>()("t3/testUtils/upgradeValidationRuntime/UpgradeValidationEffects") {}

/** Preservation is readonly; controlled app writes remain behind quarantined native boundaries. */
function makeUpgradeValidationRuntime(
  snapshot: UpgradeSnapshot,
  mode: "preservation" | "controlled-fixture",
) {
  assertPreparedUpgradeSnapshot(snapshot);
  assertDisposablePath(snapshot.fixtureRoot, snapshot.runtimePath);
  assertDisposablePath(snapshot.fixtureRoot, snapshot.untouchedPath);
  if (NodeFS.realpathSync(snapshot.runtimePath) === NodeFS.realpathSync(snapshot.untouchedPath))
    throw new Error("Runtime must not open the untouched snapshot");
  const roots = upgradeFixtureRoots(snapshot);
  const rootFor = roots.rootFor;
  const projectOverlay = Layer.effect(
    ProjectStore.ProjectStoreV2,
    Effect.gen(function* () {
      const store = yield* ProjectStore.ProjectStoreV2;
      const overlay = (project: ProjectStore.ProjectRow): ProjectStore.ProjectRow => ({
        ...project,
        workspaceRoot: rootFor(project.projectId),
        scripts: [],
        faviconPath: null,
      });
      const shellOverlay = (project: import("@t3tools/contracts").OrchestrationProjectShell) => ({
        ...project,
        workspaceRoot: rootFor(project.id),
        scripts: [],
        faviconPath: null,
      });
      return ProjectStore.ProjectStoreV2.of({
        apply: (event) =>
          Effect.suspend(() => {
            if (mode !== "controlled-fixture")
              return Effect.die(new UpgradeValidationDenied({ operation: "project mutation" }));
            rootFor(event.aggregateId);
            if (
              event.type === "project.created" &&
              event.payload.workspaceRoot !== rootFor(event.aggregateId)
            )
              return Effect.die(
                new UpgradeValidationDenied({ operation: "unregistered project root" }),
              );
            return store.apply(event);
          }),
        get: (id, options) => store.get(id, options).pipe(Effect.map(Option.map(overlay))),
        list: (options) =>
          store.list(options).pipe(Effect.map((projects) => projects.map(overlay))),
        getShell: (id) => store.getShell(id).pipe(Effect.map(Option.map(shellOverlay))),
        listShells: (options) =>
          store.listShells(options).pipe(Effect.map((projects) => projects.map(shellOverlay))),
        findActiveByWorkspaceRoot: (root) =>
          store
            .list()
            .pipe(
              Effect.map((projects) =>
                Option.fromNullishOr(
                  projects.find((project) => rootFor(project.projectId) === root),
                ).pipe(Option.map(overlay)),
              ),
            ),
      });
    }),
  ).pipe(Layer.provide(ProjectStore.layer));
  const migrations = SqlitePersistence.layerFromPath(snapshot.runtimePath).pipe(
    Layer.provide(NodeServices.layer),
  );
  // TEMP isolation is connection-local. Controlled reads and transactions must use the same
  // writer, including reads explicitly routed through NodeSqliteClient.readOnly.
  const migratedDatabase =
    mode === "controlled-fixture"
      ? Layer.unwrap(
          Effect.gen(function* () {
            yield* SqlClient.SqlClient;
            return NodeSqliteClient.layer({ filename: snapshot.runtimePath, readerWorker: false });
          }),
        ).pipe(Layer.provide(migrations))
      : migrations;
  const database = Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Migrations may upgrade only the runtime copy. Thereafter copied native work is evidence,
      // so real admission/recovery/claim code must refuse writes instead of consuming that work.
      if (mode === "controlled-fixture") return sql;
      yield* sql`PRAGMA query_only = ON`;
      // Some upstream snapshot readers use transactions. Route those to the driver's readonly
      // connection so BEGIN itself remains valid while any attempted mutation still fails.
      const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
        sql.withTransaction(effect).pipe(NodeSqliteClient.readOnly);
      return new Proxy(sql, {
        get(target, key, receiver) {
          return key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver);
        },
      });
    }),
  ).pipe(Layer.provide(migratedDatabase));
  const filesystem = layerFixtureFilesystem(snapshot, mode).pipe(Layer.provide(NodeServices.layer));
  const environment = Layer.mergeAll(
    filesystem,
    NodePlatformPath.layer,
    NodePlatformCrypto.layer,
    ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }).pipe(Layer.orDie),
    ServerConfig.layerTest(
      snapshot.fixtureRoot,
      NodePath.join(snapshot.fixtureRoot, "runtime"),
    ).pipe(Layer.provide(NodeServices.layer)),
  );
  const outbox =
    mode === "controlled-fixture"
      ? Layer.unwrap(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{
              readonly boundary: number;
            }>`SELECT COALESCE(MAX(rowid), 0) AS boundary FROM orchestration_v2_effect_outbox`;
            return EffectOutbox.layerWithOptions({ testOnlyAfterRowId: rows[0]?.boundary ?? 0 });
          }),
        )
      : EffectOutbox.layer;
  const stores = Layer.mergeAll(
    EventStore.layer,
    ProjectionStore.layer,
    projectOverlay,
    CommandReceiptStore.layer,
    outbox,
    TurnItemPositionStore.layer,
  ).pipe(Layer.provideMerge(database));
  const admission = ProjectWorkRunAdmission.layer.pipe(Layer.provide(database));
  const sink = EventSink.layerWithAdmission.pipe(
    Layer.provide(admission),
    Layer.provideMerge(stores),
  );
  const registries = Layer.mergeAll(
    Layer.succeed(
      ProviderRegistry.ProviderRegistry,
      ProviderRegistry.ProviderRegistry.of({
        getProviders: Effect.succeed([]),
        refresh: () => Effect.succeed([]),
        refreshInstance: () => Effect.succeed([]),
        refreshAfterUpdate: () => Effect.succeed([]),
        refreshWorkspaceSnapshot: () => Effect.succeed([]),
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.die(new UpgradeValidationDenied({ operation: "provider maintenance" })),
        setProviderMaintenanceActionState: () => Effect.succeed([]),
        streamChanges: Stream.empty,
      }),
    ),
    Layer.effect(
      ProviderInstanceRegistry.ProviderInstanceRegistry,
      Effect.gen(function* () {
        const changes = yield* PubSub.unbounded<void>();
        return ProviderInstanceRegistry.ProviderInstanceRegistry.of({
          getInstance: () => Effect.succeed(undefined),
          listInstances: Effect.succeed([]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: PubSub.subscribe(changes),
        });
      }),
    ),
    Layer.succeed(
      UpgradeValidationEffects,
      UpgradeValidationEffects.of({
        readFile: (id, relativePath) =>
          Effect.try({
            try: () => {
              if (NodePath.isAbsolute(relativePath))
                throw new Error("Expected a relative fixture path");
              const target = assertDisposablePath(
                rootFor(id),
                NodePath.resolve(rootFor(id), relativePath),
              );
              return NodeFS.readFileSync(target, "utf8");
            },
            catch: () => new UpgradeValidationDenied({ operation: "filesystem read" }),
          }),
      }),
    ),
  );
  const fixtureServices = layerFixtureServicesForMode(mode).pipe(
    Layer.provide(admission),
    Layer.provideMerge(sink),
    Layer.provideMerge(environment),
  );
  const workspace = layerFixtureWorkspace(snapshot, mode).pipe(Layer.provide(environment));
  const common = Layer.mergeAll(workspace, registries, layerFixtureNative(snapshot, mode));
  return {
    base: Layer.mergeAll(sink.pipe(Layer.provideMerge(environment)), common),
    fixture: Layer.mergeAll(fixtureServices, common),
  };
}

export function upgradeValidationRuntime(
  snapshot: UpgradeSnapshot,
  options: { readonly mode?: "preservation" | "controlled-fixture" } = {},
) {
  assertPreparedUpgradeSnapshot(snapshot);
  // Revalidate when a delayed or reused Layer builds, not just at construction.
  return Layer.unwrap(
    Effect.sync(
      () => makeUpgradeValidationRuntime(snapshot, options.mode ?? "preservation").fixture,
    ),
  );
}

/** The actual controlled app supplies business services without the preservation mocks. */
export function upgradeValidationBaseRuntime(snapshot: UpgradeSnapshot) {
  assertPreparedUpgradeSnapshot(snapshot);
  return Layer.unwrap(
    Effect.sync(() => makeUpgradeValidationRuntime(snapshot, "controlled-fixture").base),
  );
}
