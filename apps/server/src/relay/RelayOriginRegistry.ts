// @effect-diagnostics nodeBuiltinImport:off -- The HTTPS edge reads its own SQLite authority outside the T3 runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";

export type RelayOriginAdmission =
  | { readonly status: "unknown" }
  | { readonly status: "active" | "retired"; readonly environmentId: string };

function isCanonicalHttpsOrigin(origin: string): boolean {
  const parsed = URL.parse(origin);
  return parsed?.protocol === "https:" && parsed.origin === origin;
}

function syncPath(path: string, flags: "r" | "r+"): void {
  const fd = NodeFS.openSync(path, flags);
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  // Windows does not expose directory descriptors through Node's filesystem API.
  if (HostProcess.Platform.defaultValue() !== "win32") syncPath(path, "r");
}

function openRegistry(path: string, initialize: boolean) {
  if (initialize) NodeFS.closeSync(NodeFS.openSync(path, "wx", 0o600));
  const authorityFile = NodeFS.lstatSync(path);
  if (!authorityFile.isFile() || authorityFile.nlink !== 1) {
    throw new Error("Invalid relay origin authority file");
  }
  const url = NodeURL.pathToFileURL(path);
  url.search = "mode=rw";
  const db = new NodeSqlite.DatabaseSync(url.href);
  try {
    function checkAuthorityFile(): void {
      const currentFile = NodeFS.lstatSync(path);
      if (
        !currentFile.isFile() ||
        currentFile.nlink !== 1 ||
        currentFile.dev !== authorityFile.dev ||
        currentFile.ino !== authorityFile.ino
      ) {
        throw new Error("Relay origin authority was replaced");
      }
    }

    checkAuthorityFile();
    db.exec("PRAGMA trusted_schema = OFF; PRAGMA synchronous = EXTRA; PRAGMA fullfsync = ON;");
    if (initialize) {
      db.exec(`
        CREATE TABLE relay_origins (
          origin TEXT PRIMARY KEY,
          environment_id TEXT NOT NULL CHECK(length(environment_id) > 0),
          retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0, 1))
        ) STRICT;
      `);
      syncPath(path, "r+");
      syncDirectory(NodePath.dirname(path));
    }

    const select = db.prepare("SELECT environment_id, retired FROM relay_origins WHERE origin = ?");
    const insert = db.prepare(
      "INSERT INTO relay_origins (origin, environment_id) VALUES (?, ?) ON CONFLICT(origin) DO NOTHING",
    );
    const tombstone = db.prepare(
      "UPDATE relay_origins SET retired = 1 WHERE origin = ? AND environment_id = ? AND retired = 0",
    );
    const tombstoneEnvironment = db.prepare(
      "UPDATE relay_origins SET retired = 1 WHERE environment_id = ? AND retired = 0",
    );

    function lookup(origin: string): RelayOriginAdmission {
      checkAuthorityFile();
      if (!isCanonicalHttpsOrigin(origin)) return { status: "unknown" };
      const row: Record<string, NodeSqlite.SQLOutputValue> | undefined = select.get(origin);
      if (!row) return { status: "unknown" };
      if (typeof row.environment_id !== "string" || (row.retired !== 0 && row.retired !== 1)) {
        throw new Error("Invalid relay origin authority record");
      }
      return {
        status: row.retired === 1 ? "retired" : "active",
        environmentId: row.environment_id,
      };
    }

    return {
      lookup,
      register(origin: string, environmentId: string): void {
        checkAuthorityFile();
        if (!isCanonicalHttpsOrigin(origin) || !environmentId) {
          throw new Error("An HTTPS origin and an environment identity are required");
        }
        insert.run(origin, environmentId);
        const existing = lookup(origin);
        if (existing.status !== "active" || existing.environmentId !== environmentId) {
          throw new Error("Relay origin is reserved");
        }
      },
      retire(origin: string, environmentId: string): void {
        checkAuthorityFile();
        tombstone.run(origin, environmentId);
        const existing = lookup(origin);
        if (existing.status !== "retired" || existing.environmentId !== environmentId) {
          throw new Error("Relay origin does not belong to this environment");
        }
      },
      retireEnvironment(environmentId: string): void {
        checkAuthorityFile();
        tombstoneEnvironment.run(environmentId);
      },
      [Symbol.dispose]: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function createRelayOriginRegistry(path: string) {
  return openRegistry(path, true);
}

export function openRelayOriginRegistry(path: string) {
  return openRegistry(path, false);
}

function authorityDirectory(homeDirectory: string): string {
  return `${NodeFS.realpathSync(homeDirectory)}.origins`;
}

export function initializeRelayHomeOriginRegistry(homeDirectory: string): void {
  const directory = authorityDirectory(homeDirectory);
  NodeFS.mkdirSync(directory, { mode: 0o700 });
  using _registry = createRelayOriginRegistry(NodePath.join(directory, "authority.sqlite"));
  syncDirectory(NodePath.dirname(directory));
}

export function openRelayHomeOriginRegistry(homeDirectory: string) {
  const directory = authorityDirectory(homeDirectory);
  const stat = NodeFS.lstatSync(directory, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (!stat.isDirectory()) throw new Error("Invalid relay origin authority directory");
  return openRelayOriginRegistry(NodePath.join(directory, "authority.sqlite"));
}
