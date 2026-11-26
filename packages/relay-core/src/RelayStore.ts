// @effect-diagnostics-next-line nodeBuiltinImport:off -- Generate the local SQLite identity with the Node CSPRNG.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Check file links and sync opened directory descriptors.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Path handling stays within the Node SQLite filesystem boundary.
import * as NodePath from "node:path";

import { SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { AuthorizationError, SqlError } from "effect/sql/SqlError";

export class RelayStorageError extends Schema.TaggedError<RelayStorageError>()(
  "RelayStorageError",
  {
    reason: Schema.Literals(["ownership-conflict", "invalid-state", "unsupported-version", "io"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Relay storage is unavailable (${this.reason}).`;
  }
}

const isStorageError = Schema.is(RelayStorageError);

const applicationId = 0x5433524c;
const schemaVersion = 4;

const identityRow = Schema.Struct({
  relayId: SelfHostedRelayId,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const decodeIdentity = Schema.decodeUnknownEffect(identityRow);

const migration = [
  `CREATE TABLE relay_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    relay_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 0)
  ) STRICT`,
  `CREATE TABLE relay_grants (
    grant_id TEXT PRIMARY KEY NOT NULL,
    parent_grant_id TEXT REFERENCES relay_grants (grant_id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('operator', 'client', 'device', 'publisher')),
    subject_id TEXT,
    grant_json TEXT NOT NULL,
    pairing_hash TEXT UNIQUE,
    expires_at INTEGER,
    session_hash TEXT UNIQUE,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
    CHECK ((pairing_hash IS NULL) = (expires_at IS NULL)),
    CHECK ((subject_kind IN ('publisher', 'device')) = (subject_id IS NOT NULL)),
    CHECK (session_hash IS NOT NULL OR pairing_hash IS NOT NULL OR revoked = 1),
    CHECK (parent_grant_id IS NOT NULL OR (subject_kind = 'operator' AND pairing_hash IS NULL))
  ) STRICT`,
  "CREATE INDEX relay_grants_by_parent ON relay_grants (parent_grant_id)",
  "CREATE INDEX relay_grants_by_subject ON relay_grants (subject_kind, subject_id, generation)",
  `CREATE TABLE relay_environments (
    environment_id TEXT PRIMARY KEY NOT NULL,
    record_json TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE relay_devices (
    device_id TEXT PRIMARY KEY NOT NULL,
    registration_json TEXT,
    entitlement_json TEXT
  ) STRICT`,
] as const;

const deviceBindingMigration = [
  "ALTER TABLE relay_devices ADD COLUMN binding_grant_id TEXT REFERENCES relay_grants (grant_id)",
  `INSERT INTO relay_devices (device_id, binding_grant_id)
    SELECT child.subject_id, MIN(child.grant_id)
    FROM relay_grants child JOIN relay_grants issuer ON child.parent_grant_id = issuer.grant_id
    WHERE child.subject_kind = 'device' AND child.revoked = 0 AND child.session_hash IS NOT NULL
      AND issuer.subject_kind = 'operator'
    GROUP BY child.subject_id HAVING COUNT(DISTINCT issuer.grant_id) = 1
    ON CONFLICT(device_id) DO UPDATE SET binding_grant_id = excluded.binding_grant_id`,
  `INSERT INTO relay_devices (device_id, binding_grant_id)
    SELECT child.subject_id, owner.grant_id
    FROM relay_grants child JOIN relay_grants issuer ON child.parent_grant_id = issuer.grant_id
    JOIN relay_grants owner ON owner.parent_grant_id IS NULL AND owner.generation = child.generation
    WHERE child.subject_kind = 'device' AND child.revoked = 0 AND child.session_hash IS NOT NULL
      AND issuer.subject_kind = 'operator'
    GROUP BY child.subject_id HAVING COUNT(DISTINCT issuer.grant_id) > 1
    ON CONFLICT(device_id) DO UPDATE SET binding_grant_id = excluded.binding_grant_id`,
  `WITH RECURSIVE ambiguous(grant_id) AS (
    SELECT child.grant_id FROM relay_grants child
    JOIN relay_devices device ON child.subject_kind = 'device' AND child.subject_id = device.device_id
    JOIN relay_grants binding ON binding.grant_id = device.binding_grant_id
    WHERE binding.subject_kind = 'operator' AND binding.parent_grant_id IS NULL
    UNION
    SELECT child.grant_id FROM relay_grants child JOIN ambiguous parent ON child.parent_grant_id = parent.grant_id
  ) UPDATE relay_grants SET revoked = 1, pairing_hash = NULL, expires_at = NULL, session_hash = NULL
    WHERE grant_id IN (SELECT grant_id FROM ambiguous)`,
] as const;

const hookPolicyMigration = [
  `CREATE TABLE relay_hook_policies (
    environment_id TEXT NOT NULL REFERENCES relay_environments(environment_id) ON DELETE CASCADE,
    hook_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    revision TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    hold_enabled INTEGER NOT NULL CHECK (hold_enabled IN (0, 1)),
    PRIMARY KEY (environment_id, hook_id)
  ) STRICT`,
] as const;

const writerSettings = {
  journalMode: "wal",
  synchronous: 2,
  fullfsync: true,
  checkpointFullfsync: true,
} as const;

export class RelayStore extends Context.Service<
  RelayStore,
  {
    readonly sql: SqlClient.SqlClient;
    readonly relayId: SelfHostedRelayId;
    readonly schemaVersion: typeof schemaVersion;
    readonly writerSettings: typeof writerSettings;
  }
>()("@t3tools/relay-core/RelayStore") {}

const prepareHome = Effect.fn("RelayStore.prepareHome")(function* (directory: string) {
  const platform = yield* HostProcess.Platform;
  return yield* Effect.tryPromise({
    try: async () => {
      const firstCreated = await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      const home = await NodeFSP.realpath(directory);
      const { mode } = await NodeFSP.stat(home);
      const enforceUnixModes = platform !== "win32";
      if (enforceUnixModes && (mode & 0o077) !== 0) {
        throw new RelayStorageError({ reason: "invalid-state" });
      }

      const filename = NodePath.join(home, "relay.sqlite");
      let created = false;
      try {
        const handle = await NodeFSP.open(filename, "wx", 0o600);
        await handle.close();
        created = true;
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
      }
      for (const path of [filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`]) {
        const stat = await NodeFSP.lstat(path).catch((cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
            return undefined;
          throw cause;
        });
        if (
          stat &&
          (!stat.isFile() || stat.nlink !== 1 || (enforceUnixModes && (stat.mode & 0o077) !== 0))
        ) {
          throw new RelayStorageError({ reason: "invalid-state" });
        }
      }
      return { filename, home, firstCreated, created };
    },
    catch: (cause) =>
      isStorageError(cause) ? cause : new RelayStorageError({ reason: "io", cause }),
  });
});

const flushHome = Effect.fn("RelayStore.flushHome")(function* (
  home: string,
  firstCreated: string | undefined,
) {
  if ((yield* HostProcess.Platform) === "win32") return;
  yield* Effect.tryPromise({
    try: async () => {
      const last = firstCreated
        ? await NodeFSP.realpath(NodePath.dirname(NodePath.resolve(firstCreated)))
        : home;
      let directory = home;
      while (true) {
        const handle = await NodeFSP.open(directory, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const parent = NodePath.dirname(directory);
        if (directory === last || parent === directory) return;
        directory = parent;
      }
    },
    catch: (cause) => new RelayStorageError({ reason: "io", cause }),
  });
});

export const storageError = (cause: SqlError) => {
  switch (cause.reason._tag) {
    case "LockTimeoutError":
      return new RelayStorageError({ reason: "ownership-conflict", cause });
    default:
      return new RelayStorageError({ reason: "io", cause });
  }
};

const initialize = Effect.fn("RelayStore.initialize")(function* (created: boolean) {
  const sql = yield* SqlClient.SqlClient;

  // Exclusive WAL mode holds SQLite's OS lock on the database until this connection closes.
  const [locking] = yield* sql<{ locking_mode: string }>`PRAGMA locking_mode = EXCLUSIVE`;
  const [id] = yield* sql<{ application_id: number }>`PRAGMA application_id`;
  const [version] = yield* sql<{ user_version: number }>`PRAGMA user_version`;
  if (locking?.locking_mode !== "exclusive") {
    return yield* new RelayStorageError({ reason: "io" });
  }
  if (version && version.user_version > schemaVersion && id?.application_id === applicationId) {
    return yield* new RelayStorageError({ reason: "unsupported-version" });
  }
  if (
    created
      ? id?.application_id !== 0 || version?.user_version !== 0
      : id?.application_id !== applicationId ||
        (version?.user_version !== 1 &&
          version?.user_version !== 2 &&
          version?.user_version !== 3 &&
          version?.user_version !== schemaVersion)
  ) {
    return yield* new RelayStorageError({ reason: "invalid-state" });
  }

  const [journal] = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode = WAL`;
  yield* sql`PRAGMA synchronous = FULL`;
  yield* sql`PRAGMA fullfsync = ON`;
  yield* sql`PRAGMA checkpoint_fullfsync = ON`;
  yield* sql`PRAGMA foreign_keys = ON`;
  const [sync] = yield* sql<{ synchronous: number }>`PRAGMA synchronous`;
  const [flush] = yield* sql<{ fullfsync: number }>`PRAGMA fullfsync`;
  const [checkpoint] = yield* sql<{ checkpoint_fullfsync: number }>`PRAGMA checkpoint_fullfsync`;
  const [foreignKeys] = yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`;
  if (
    journal?.journal_mode !== writerSettings.journalMode ||
    sync?.synchronous !== writerSettings.synchronous ||
    flush?.fullfsync !== 1 ||
    checkpoint?.checkpoint_fullfsync !== 1 ||
    foreignKeys?.foreign_keys !== 1
  ) {
    return yield* new RelayStorageError({ reason: "io" });
  }

  const identity = yield* sql.withTransaction(
    Effect.gen(function* () {
      if (created) {
        for (const statement of migration) yield* sql.unsafe(statement);
        yield* sql.unsafe(`PRAGMA application_id = ${applicationId}`);
        const relayId = SelfHostedRelayId.make(NodeCrypto.randomUUID());
        yield* sql`INSERT INTO relay_identity (singleton, relay_id, generation) VALUES (1, ${relayId}, 0)`;
      }
      if (created || version?.user_version === 1) {
        for (const statement of deviceBindingMigration) yield* sql.unsafe(statement);
      }
      if (created || version!.user_version < 3) {
        for (const statement of hookPolicyMigration) yield* sql.unsafe(statement);
      }
      if (!created && version?.user_version === 3) {
        const columns = yield* sql<{ name: string }>`PRAGMA table_info(relay_hook_policies)`;
        if (!columns.some((column) => column.name === "revision")) {
          yield* sql`ALTER TABLE relay_hook_policies ADD COLUMN revision TEXT NOT NULL DEFAULT ''`;
          const targets = yield* sql<{
            environment_id: string;
            hook_id: string;
          }>`SELECT environment_id, hook_id FROM relay_hook_policies`;
          for (const target of targets) {
            yield* sql`UPDATE relay_hook_policies SET revision = ${NodeCrypto.randomUUID()}
              WHERE environment_id = ${target.environment_id} AND hook_id = ${target.hook_id}`;
          }
        }
      }
      if (created || version!.user_version < schemaVersion) {
        yield* sql.unsafe(`PRAGMA user_version = ${schemaVersion}`);
      }
      const [checked] = yield* sql<{ quick_check: string }>`PRAGMA quick_check`;
      const invalidReferences = yield* sql`PRAGMA foreign_key_check`;
      const rows = yield* sql`SELECT relay_id AS relayId, generation FROM relay_identity`;
      if (checked?.quick_check !== "ok" || invalidReferences.length > 0 || rows.length !== 1) {
        return yield* new RelayStorageError({ reason: "invalid-state" });
      }
      return yield* decodeIdentity(rows[0]).pipe(
        Effect.mapError((cause) => new RelayStorageError({ reason: "invalid-state", cause })),
      );
    }),
  );
  // Raw reservations cannot share the runtime's lock order; consumers use scoped transactions.
  const sharedSql = Object.assign(sql, {
    reserve: Effect.fail(
      new SqlError({
        reason: new AuthorizationError({
          cause: undefined,
          message: "Relay storage requires scoped transactions.",
        }),
      }),
    ),
  });
  return RelayStore.of({
    sql: sharedSql,
    relayId: identity.relayId,
    schemaVersion,
    writerSettings,
  });
});

export const layer = (directory: string) =>
  Layer.effect(
    RelayStore,
    Effect.gen(function* () {
      const { filename, home, firstCreated, created } = yield* prepareHome(directory);
      const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
      const store = yield* initialize(created).pipe(Effect.provideContext(context));
      yield* flushHome(home, firstCreated);
      return store;
    }).pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) })),
  );
