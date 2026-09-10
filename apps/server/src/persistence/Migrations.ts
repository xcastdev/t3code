/**
 * MigrationsLive - Migration runners with inline loaders
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * There are two independent sequences, each with its own tracking table:
 *
 * - Upstream migrations own `effect_sql_migrations` and keep the ids they
 *   ship with, so a database written by upstream T3 Code and one written
 *   here agree on what a given id means.
 * - Fork migrations own `t3_fork_migrations` and are numbered from 1 in this
 *   repository only. Because the runner only compares an id against the
 *   latest id in its own table, upstream can add ids forever without
 *   colliding with, skipping, or reordering anything here.
 *
 * Upstream runs first on every startup, so a fork migration may depend on
 * upstream tables. Add new fork work to `forkMigrationEntries`; only touch
 * `migrationEntries` when carrying an upstream migration across.
 *
 * Migrations run automatically when the MigrationLayer is provided,
 * ensuring the database schema is always up-to-date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";

// Fork migrations - separate sequence, separate tracking table.
import ForkMigration0001 from "./Migrations/fork/001_ProjectionTurnsProvenance.ts";
import ForkMigration0002 from "./Migrations/fork/002_ProjectionProjectMcpServers.ts";
import ForkMigration0003 from "./Migrations/fork/003_ProjectionProjectMcpTransport.ts";
import ForkMigration0004 from "./Migrations/fork/004_McpCatalogScopes.ts";
import ForkMigration0005 from "./Migrations/fork/005_McpCatalogRevisions.ts";
import ForkMigration0006 from "./Migrations/fork/006_McpCatalogAppliedCatalog.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "AuthSessionClientConnection", Migration0041],
  [42, "ProjectionThreadLinkedPullRequest", Migration0042],
  [43, "ProjectionThreadsUnsettledAt", Migration0043],
] as const;

/**
 * Fork-only migrations, numbered from 1 and tracked in their own table.
 *
 * New schema work in this repository belongs here, not in
 * `migrationEntries` - see the note at the top of this file.
 */
export const forkMigrationEntries = [
  [1, "ProjectionTurnsProvenance", ForkMigration0001],
  [2, "ProjectionProjectMcpServers", ForkMigration0002],
  [3, "ProjectionProjectMcpTransport", ForkMigration0003],
  [4, "McpCatalogScopes", ForkMigration0004],
  [5, "McpCatalogRevisions", ForkMigration0005],
  [6, "McpCatalogAppliedCatalog", ForkMigration0006],
] as const;

/** Tracking table for the fork sequence. Upstream keeps `effect_sql_migrations`. */
export const FORK_MIGRATIONS_TABLE = "t3_fork_migrations";

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const makeLoader = (
  entries: typeof migrationEntries | typeof forkMigrationEntries,
  throughId?: number,
) =>
  Migrator.fromRecord(
    Object.fromEntries(
      entries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

export const makeMigrationLoader = (throughId?: number) => makeLoader(migrationEntries, throughId);

export const makeForkMigrationLoader = (throughId?: number) =>
  makeLoader(forkMigrationEntries, throughId);

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  /** Stop after this upstream migration id. */
  readonly toMigrationInclusive?: number | undefined;
  /**
   * Stop after this fork migration id. Omit to run every fork migration;
   * pass 0 to run none, which is how a test reconstructs a database as it
   * looked before the fork sequence existed.
   */
  readonly toForkMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations, upstream first and then fork.
 *
 * Each sequence creates its own tracking table if needed and runs the
 * migrations whose id is greater than the latest id recorded in that table.
 *
 * Returns the executed migrations as [id, name] tuples, upstream ids first
 * and fork ids after; the two ranges overlap, so callers that need to tell
 * them apart should use `runUpstreamMigrations` or `runForkMigrations`.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
  toForkMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const executedUpstream = yield* runUpstreamMigrations(toMigrationInclusive);
  const executedFork = yield* runForkMigrations(toForkMigrationInclusive);
  return [...executedUpstream, ...executedFork];
});

/** Run the upstream sequence only, tracked in `effect_sql_migrations`. */
export const runUpstreamMigrations = Effect.fn("runUpstreamMigrations")(function* (
  throughId?: number,
) {
  const executedMigrations = yield* run({ loader: makeMigrationLoader(throughId) });
  yield* logExecuted(executedMigrations, "upstream");
  return executedMigrations;
});

/** Run the fork sequence only, tracked in `t3_fork_migrations`. */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* (throughId?: number) {
  const executedMigrations = yield* run({
    loader: makeForkMigrationLoader(throughId),
    table: FORK_MIGRATIONS_TABLE,
  });
  yield* logExecuted(executedMigrations, "fork");
  return executedMigrations;
});

const logExecuted = (
  executed: ReadonlyArray<readonly [id: number, name: string]>,
  sequence: "upstream" | "fork",
) => {
  const migrations = executed.map(([id, name]) => `${id}_${name}`);
  return migrations.length === 0
    ? Effect.logDebug("Database schema is current", { sequence })
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ sequence, migrations }));
};

/**
 * Layer that runs migrations when the layer is built.
 *
 * Use this to ensure migrations run before your application starts.
 * Migrations are run automatically - no separate script is needed.
 *
 * @example
 * ```typescript
 * import { MigrationsLive } from "@acme/db/Migrations"
 * import * as SqliteClient from "@acme/db/SqliteClient"
 *
 * // Migrations run automatically when SqliteClient is provided
 * const AppLayer = MigrationsLive.pipe(
 *   Layer.provideMerge(SqliteClient.layer({ filename: "database.sqlite" }))
 * )
 * ```
 */
export const MigrationsLive = Layer.effectDiscard(runMigrations());
