// @effect-diagnostics nodeBuiltinImport:off -- This opt-in harness owns disposable filesystem fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import type { ServerConfig } from "../config.ts";
import { assertUpstreamUpgradeCompatibility } from "../persistence/UpstreamUpgradeCompatibility.ts";

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const inside = (root: string, target: string) => {
  const relative = NodePath.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
};

/** Resolve missing leaves too, so a symlinked existing ancestor cannot escape a fixture. */
export function realTarget(target: string): string {
  if (!NodePath.isAbsolute(target)) throw new Error("Fixture paths must be absolute");
  if (NodeFS.existsSync(target)) return NodeFS.realpathSync(target);
  return NodePath.join(realTarget(NodePath.dirname(target)), NodePath.basename(target));
}

export function assertDisposablePath(root: string, target: string): string {
  const resolved = realTarget(target);
  if (!inside(NodeFS.realpathSync(root), resolved))
    throw new Error("NodePath is outside the disposable fixture");
  return resolved;
}

export async function backupUpgradeDatabase(
  source: NodeSqlite.DatabaseSync,
  destination: string,
  progress?: NodeSqlite.BackupOptions["progress"],
) {
  source.exec("BEGIN");
  try {
    // BEGIN alone is deferred: a read must pin the WAL snapshot before backup starts.
    // Otherwise another connection's commits restart SQLite's incremental backup.
    source.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    return await NodeSqlite.backup(source, destination, { rate: 4096, progress });
  } finally {
    source.exec("ROLLBACK");
  }
}

/** Digests permit private before/after comparisons without returning row values or credentials. */
export function inventoryUpgradeDatabase(filename: string) {
  const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    const objects = db
      .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
      .all();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const contents = tables.map(({ name }) => {
      if (typeof name !== "string") throw new Error("Invalid table name");
      const statement = db.prepare(`SELECT * FROM ${quoteIdentifier(name)}`);
      statement.setReadBigInts(true);
      const mask = (1n << 256n) - 1n;
      let count = 0;
      let first = 0n;
      let second = 0n;
      // Two independent modular sums retain duplicate multiplicity without retaining or sorting rows.
      // This is a semantic comparison fingerprint, not a signature for adversarially chosen data.
      for (const row of statement.iterate()) {
        const serialized = JSON.stringify(row, (_key, value: unknown) => {
          if (typeof value === "bigint") return ["integer", value.toString()];
          if (typeof value === "number" && !Number.isFinite(value)) return ["real", String(value)];
          if (value instanceof Uint8Array) return ["blob", Buffer.from(value).toString("base64")];
          return value;
        });
        first =
          (first +
            BigInt(
              `0x${NodeCrypto.createHash("sha256").update("row-a\0").update(serialized).digest("hex")}`,
            )) &
          mask;
        second =
          (second +
            BigInt(
              `0x${NodeCrypto.createHash("sha256").update("row-b\0").update(serialized).digest("hex")}`,
            )) &
          mask;
        count++;
      }
      return {
        name,
        count,
        digest: NodeCrypto.createHash("sha256")
          .update(JSON.stringify([count, first.toString(16), second.toString(16)]))
          .digest("hex"),
      };
    });
    const ledgers = contents.filter(({ name }) => /migrat/i.test(name));
    return { objects, contents, ledgers };
  } finally {
    db.close();
  }
}

export interface UpgradeSnapshot {
  readonly fixtureRoot: string;
  readonly untouchedPath: string;
  readonly runtimePath: string;
  readonly projects: ReadonlyArray<{
    readonly projectId: string;
    readonly sourceRoot: string;
    readonly sandboxRoot: string;
  }>;
  readonly inventory: ReturnType<typeof inventoryUpgradeDatabase>;
}

const preparedSnapshots = new WeakMap<
  UpgradeSnapshot,
  { readonly root: string; readonly runtimeInode: number; readonly untouchedInode: number }
>();

export function assertPreparedUpgradeSnapshot(snapshot: UpgradeSnapshot): void {
  const prepared = preparedSnapshots.get(snapshot);
  if (
    !prepared ||
    NodeFS.realpathSync(snapshot.fixtureRoot) !== prepared.root ||
    NodeFS.statSync(snapshot.runtimePath).ino !== prepared.runtimeInode ||
    NodeFS.statSync(snapshot.untouchedPath).ino !== prepared.untouchedInode
  ) {
    throw new Error("Snapshot is unrecognized or its database files were replaced");
  }
}

/** Explicit opt-in only: callers obtain dbPath from the same resolved config used by the server. */
export async function prepareUpgradeSnapshot(input: {
  readonly configured: Pick<ServerConfig["Service"], "dbPath">;
  readonly disposableRoot: string;
  readonly activeDatabasePaths: ReadonlyArray<string>;
}): Promise<UpgradeSnapshot> {
  const sourcePath = NodeFS.realpathSync(input.configured.dbPath);
  if (NodePath.basename(sourcePath) !== "statev2.sqlite")
    throw new Error("Upgrade validation requires statev2.sqlite");
  const disposableRoot = NodeFS.realpathSync(input.disposableRoot);
  if (NodeFS.readdirSync(disposableRoot).length !== 0)
    throw new Error("Disposable root must be empty");
  for (const active of [sourcePath, ...input.activeDatabasePaths.map(realTarget)]) {
    const activeDirectory = NodePath.dirname(active);
    if (
      disposableRoot === activeDirectory ||
      inside(activeDirectory, disposableRoot) ||
      inside(disposableRoot, active)
    ) {
      throw new Error("Disposable root overlaps an active database directory");
    }
  }
  const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(disposableRoot, "upgrade-"));
  NodeFS.chmodSync(fixtureRoot, 0o700);
  try {
    const untouchedPath = assertDisposablePath(
      fixtureRoot,
      NodePath.join(fixtureRoot, "untouched", "statev2.sqlite"),
    );
    const runtimePath = assertDisposablePath(
      fixtureRoot,
      NodePath.join(fixtureRoot, "runtime", "userdata", "statev2.sqlite"),
    );
    NodeFS.mkdirSync(NodePath.dirname(untouchedPath), { recursive: true, mode: 0o700 });
    NodeFS.mkdirSync(NodePath.dirname(runtimePath), { recursive: true, mode: 0o700 });
    const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
    try {
      await backupUpgradeDatabase(source, untouchedPath);
    } finally {
      source.close();
    }
    NodeFS.chmodSync(untouchedPath, 0o600);
    await Effect.runPromise(
      assertUpstreamUpgradeCompatibility.pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: untouchedPath, readonly: true })),
      ),
    );
    const inventory = inventoryUpgradeDatabase(untouchedPath);
    const untouched = new NodeSqlite.DatabaseSync(untouchedPath, { readOnly: true });
    let projects: UpgradeSnapshot["projects"];
    try {
      await backupUpgradeDatabase(untouched, runtimePath);
      projects = untouched
        .prepare("SELECT project_id, workspace_root FROM projection_projects")
        .all()
        .map((row, index) => {
          if (
            typeof row.project_id !== "string" ||
            typeof row.workspace_root !== "string" ||
            !NodePath.isAbsolute(row.workspace_root)
          )
            throw new Error("Invalid project root");
          const sandboxRoot = NodePath.join(fixtureRoot, "projects", String(index));
          NodeFS.mkdirSync(sandboxRoot, { recursive: true, mode: 0o700 });
          // Native commands may use only this authored fixture, never copied project startup code.
          NodeFS.writeFileSync(NodePath.join(sandboxRoot, "fixture.txt"), "T3 upgrade fixture\n", {
            mode: 0o600,
          });
          return { projectId: row.project_id, sourceRoot: row.workspace_root, sandboxRoot };
        });
    } finally {
      untouched.close();
    }
    NodeFS.chmodSync(runtimePath, 0o600);
    const snapshot: UpgradeSnapshot = Object.freeze({
      fixtureRoot,
      untouchedPath,
      runtimePath,
      projects: Object.freeze(projects.map((project) => Object.freeze(project))),
      inventory,
    });
    preparedSnapshots.set(snapshot, {
      root: NodeFS.realpathSync(fixtureRoot),
      runtimeInode: NodeFS.statSync(runtimePath).ino,
      untouchedInode: NodeFS.statSync(untouchedPath).ino,
    });
    return snapshot;
  } catch (error) {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}
