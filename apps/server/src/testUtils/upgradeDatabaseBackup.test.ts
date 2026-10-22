// @effect-diagnostics nodeBuiltinImport:off -- These tests own disposable SQLite WAL fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import { backupUpgradeDatabase } from "./prepareUpgradeSnapshot.ts";

it("copies a pinned WAL snapshot in 4096-page batches while another connection keeps writing", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upgrade-backup-"));
  try {
    const sourcePath = NodePath.join(root, "source.sqlite");
    const destination = NodePath.join(root, "copy.sqlite");
    using writer = new NodeSqlite.DatabaseSync(sourcePath);
    writer.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE marker (value TEXT);
      INSERT INTO marker VALUES ('initial');
      CREATE TABLE records (id INTEGER PRIMARY KEY, payload BLOB);
      WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<9000)
      INSERT INTO records SELECT id, zeroblob(4096) FROM ids;
    `);
    using reader = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
    let writes = 0;
    const progress: NodeSqlite.BackupProgressInfo[] = [];
    const copiedPages = await backupUpgradeDatabase(reader, destination, (info) => {
      progress.push(info);
      // Stop after two commits so an unpinned regression terminates and fails on copied state.
      if (info.remainingPages > 0 && writes < 2) {
        writes++;
        writer.prepare("UPDATE marker SET value=?").run(`during-${writes}`);
        writer.prepare("INSERT INTO records(payload) VALUES (zeroblob(4096))").run();
      }
    });
    expect(writes).toBe(2);
    using copied = new NodeSqlite.DatabaseSync(destination, { readOnly: true });
    expect(copied.prepare("SELECT value FROM marker").get()).toEqual({ value: "initial" });
    expect(copied.prepare("SELECT count(*) AS count FROM records").get()).toEqual({ count: 9000 });
    expect(writer.prepare("SELECT value FROM marker").get()).toEqual({ value: "during-2" });
    expect(writer.prepare("SELECT count(*) AS count FROM records").get()).toEqual({ count: 9002 });
    expect(reader.isTransaction).toBe(false);
    let remaining = progress[0]?.totalPages ?? 0;
    expect(remaining).toBeGreaterThan(8192);
    for (const info of progress) {
      expect(info.totalPages).toBe(progress[0]?.totalPages);
      expect(info.remainingPages).toBe(Math.max(0, remaining - 4096));
      remaining = info.remainingPages;
    }
    // Node reports intermediate steps; SQLITE_DONE is represented by the fulfilled page count.
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(4096);
    expect(copiedPages).toBe(progress[0]?.totalPages);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("releases the read transaction if the backup destination cannot be opened", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upgrade-backup-error-"));
  try {
    const sourcePath = NodePath.join(root, "source.sqlite");
    using writer = new NodeSqlite.DatabaseSync(sourcePath);
    writer.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE records (value); INSERT INTO records VALUES (1)",
    );
    using reader = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
    await expect(
      backupUpgradeDatabase(reader, NodePath.join(root, "missing", "copy.sqlite")),
    ).rejects.toThrow();
    expect(reader.isTransaction).toBe(false);
    writer.exec("UPDATE records SET value=2");
    expect(reader.prepare("SELECT value FROM records").get()).toEqual({ value: 2 });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
