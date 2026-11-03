// @effect-diagnostics nodeBuiltinImport:off - The inspector backend packs to one builtin-only CommonJS file with no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { MISSING_DETAILS } from "./refusals.ts";

const SCHEMA_VERSION = 1;
const DATABASE_FILE = "inspector.sqlite";
const REPLAY_DIR = "replay";
const DRAFTS_DIR = "drafts";

const BUSY_TIMEOUT_MS = 5000;

export const STORE_LIMITS = {
  walTargetBytes: 1024 * 1024,
  vacuumPagesPerStep: 256,
  defaultMaxBodyBytes: 1024 * 1024,
  maxBodyBytes: 16 * 1024 * 1024,
  summaryPathChars: 512,
  maxSearchLimit: 200,
  defaultSearchLimit: 50,
  // Mirrors PLUGIN_LIMITS.maxPayloadBytes, less room for the result envelope.
  searchResultBytes: 232 * 1024,
  flowRowAllowanceBytes: 512,
  replayRowAllowanceBytes: 4 * 1024,
  maxReplayDetailChars: 1024,
} as const;

export type InspectorRefusalKind = "not-found" | "invalid-input" | "storage-full" | "conflict";

/** An expected refusal. Its message is safe to show to the user and the agent. */
export class InspectorRefusal extends Error {
  readonly kind: InspectorRefusalKind;
  constructor(kind: InspectorRefusalKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type HeaderPair = readonly [name: Uint8Array, value: Uint8Array];
export type BodySide = "request" | "response";
export type FlowType = "http" | "websocket" | "other";

export interface BodyInput {
  readonly bytes: Uint8Array;
  /** Set when the sender already cut the body. */
  readonly truncated?: boolean;
}

export interface FlowResponseInput {
  readonly status: number;
  readonly reason?: string;
  readonly httpVersion: string;
  readonly headers: ReadonlyArray<HeaderPair>;
  readonly body?: BodyInput;
}

export interface FlowInput {
  readonly captureId: number;
  readonly startedAt: number;
  readonly flowType?: FlowType;
  readonly method: string;
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
  readonly authority?: string;
  readonly path: string;
  readonly httpVersion: string;
  readonly headers: ReadonlyArray<HeaderPair>;
  readonly body?: BodyInput;
  readonly response?: FlowResponseInput;
  readonly error?: string;
  readonly replayOf?: string;
}

export interface FlowUpdate {
  readonly response?: FlowResponseInput;
  readonly error?: string;
}

export interface BodyMeta {
  readonly capturedBytes: number;
  readonly declaredBytes?: number;
  readonly truncated: boolean;
  readonly contentEncoding?: string;
  readonly contentType?: string;
}

export interface RequestSummary {
  readonly kind: "request";
  readonly id: number;
  readonly seq: number;
  readonly captureId: number;
  readonly startedAt: number;
  readonly flowType: FlowType;
  readonly method: string;
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly pathTruncated?: true;
  readonly status?: number;
  readonly error?: string;
  readonly replayOf?: string;
  readonly requestBytes: number;
  readonly responseBytes?: number;
}

export interface RequestRecord {
  readonly summary: RequestSummary;
  readonly authority: string;
  /** Full path; the summary's path is cut at 512 chars. */
  readonly path: string;
  readonly httpVersion: string;
  readonly requestHeaders: ReadonlyArray<HeaderPair>;
  readonly requestBody?: BodyMeta;
  readonly response?: {
    readonly status: number;
    readonly reason?: string;
    readonly httpVersion: string;
    readonly headers: ReadonlyArray<HeaderPair>;
    readonly body?: BodyMeta;
  };
}

export interface StoredBody {
  readonly meta: BodyMeta;
  readonly bytes: Buffer;
  /** Changes whenever the record changes, so it can key a decoded-body cache. */
  readonly recordSeq: number;
}

export interface CaptureRecord {
  readonly id: number;
  readonly seq: number;
  readonly startedAt: number;
  readonly stoppedAt?: number;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly requestCount: number;
}

export interface CaptureStatus {
  readonly running?: CaptureRecord;
  readonly droppedFlows: number;
  readonly storageBlocked: boolean;
}

export type ReplayState = "pending" | "completed" | "failed" | "unknown";

export interface ReplayDestination {
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
}

export interface ReplayRow {
  readonly replayId: string;
  readonly idempotencyKey: string;
  readonly keySeq: number;
  readonly inputHash: string;
  readonly sourceRequestId: number;
  readonly destination: ReplayDestination;
  readonly state: ReplayState;
  readonly dispatched: boolean;
  readonly detail?: string;
  readonly resultRequestId?: number;
  readonly seq: number;
  readonly acceptedAt: number;
  readonly dispatchedAt?: number;
}

export type NewReplay = Omit<ReplayRow, "seq" | "state" | "dispatched" | "dispatchedAt">;

export interface ReplayPatch {
  readonly state?: ReplayState;
  readonly dispatched?: boolean;
  readonly dispatchedAt?: number;
  readonly detail?: string;
  readonly resultRequestId?: number;
}

export interface StoreMeta {
  readonly storeId: string;
  readonly keySecret: Buffer;
  readonly keyFloor: number;
}

export type StoreChange =
  | { readonly type: "request"; readonly summary: RequestSummary }
  | {
      readonly type: "request-removed";
      readonly id: number;
      readonly seq: number;
      readonly captureId: number;
    }
  | { readonly type: "capture"; readonly capture: CaptureRecord }
  | { readonly type: "capture-removed"; readonly id: number; readonly seq: number }
  | { readonly type: "replay"; readonly replay: ReplayRow }
  | { readonly type: "status"; readonly status: CaptureStatus };

export type StorageStep =
  | { readonly kind: "admitted"; readonly bytes: number }
  | { readonly kind: "refused"; readonly bytes: number }
  | { readonly kind: "write" }
  | { readonly kind: "prune"; readonly removed: number }
  | { readonly kind: "vacuum" }
  | { readonly kind: "checkpoint"; readonly complete: boolean }
  | { readonly kind: "maintenance-error" };

export interface StorageUsage {
  readonly database: number;
  readonly wal: number;
  readonly replay: number;
  readonly drafts: number;
  readonly total: number;
}

export interface SearchFilter {
  readonly query?: string;
  readonly method?: string;
  readonly host?: string;
  readonly status?: number;
  readonly captureId?: number;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly maxBytes?: number;
}

export interface SearchPage {
  readonly items: ReadonlyArray<RequestSummary>;
  readonly cursor: string | null;
  readonly revision: string;
}

export type AdmitResult = "ok" | "full";

export type FlowWriteResult =
  | { readonly ok: true; readonly id: number; readonly seq: number }
  | { readonly ok: false; readonly reason: "storage-full" | "not-found" };

/** Store writes inside one transaction. Valid only during `StoreLane.write`. */
export interface StoreWriteTx {
  readonly nextSeq: () => number;
  readonly insertReplay: (replay: NewReplay) => ReplayRow;
  readonly updateReplay: (replayId: string, patch: ReplayPatch) => ReplayRow | undefined;
  readonly deleteReplay: (replayId: string) => boolean;
  readonly raiseKeyFloor: (floor: number) => number;
  /**
   * Deletes the oldest settled rows (by row seq) beyond `maxSettled` and raises `keyFloor`
   * above each deleted row's `keySeq`. Returns the deleted rows.
   */
  readonly pruneReplayHistory: (maxSettled: number) => ReadonlyArray<ReplayRow>;
}

/** Handle for work that holds the store lane. Valid only inside `InspectorStore.exclusive`. */
export interface StoreLane {
  readonly admit: (bytes: number, options?: { readonly protect?: number }) => AdmitResult;
  readonly write: <T>(fn: (tx: StoreWriteTx) => T) => T;
  readonly insertFlow: (flow: FlowInput) => FlowWriteResult;
  readonly updateFlow: (id: number, update: FlowUpdate) => FlowWriteResult;
  readonly startCapture: (input: {
    readonly listenHost: string;
    readonly listenPort: number;
    readonly startedAt: number;
  }) => CaptureRecord;
  readonly stopCapture: (captureId: number, stoppedAt: number) => CaptureRecord | undefined;
  readonly deleteCapture: (captureId: number) => void;
  /** Counts a flow dropped without a write, for example over maxRequestsPerCapture. */
  readonly noteDroppedFlow: () => void;
  /** Call after a write or delete under `replay/` or `drafts/`, so observers see it. */
  readonly noteFileWrite: () => void;
  readonly checkpointIfNeeded: () => void;
}

export interface InspectorStoreOptions {
  readonly dataDir: string;
  readonly maxDiskBytes: number;
  readonly maxBodyBytes?: number;
  readonly walTargetBytes?: number;
  readonly onStorageStep?: (step: StorageStep) => void;
  /** Receives maintenance errors without data. */
  readonly log?: (message: string) => void;
}

export interface InspectorStore {
  readonly dataDir: string;
  readonly replayDir: string;
  readonly draftsDir: string;
  readonly maxDiskBytes: number;
  /** Runs `fn` holding the single-permit store lane. Never call it from inside `fn`. */
  readonly exclusive: <T>(fn: (lane: StoreLane) => T | Promise<T>) => Promise<T>;
  readonly insertFlow: (flow: FlowInput) => Promise<FlowWriteResult>;
  readonly updateFlow: (id: number, update: FlowUpdate) => Promise<FlowWriteResult>;
  readonly currentSeq: () => number;
  readonly meta: () => StoreMeta;
  readonly measureUsage: () => StorageUsage;
  readonly captureStatus: () => CaptureStatus;
  readonly listCaptures: () => ReadonlyArray<CaptureRecord>;
  readonly getCapture: (captureId: number) => CaptureRecord | undefined;
  readonly getRequest: (id: number) => RequestRecord | undefined;
  readonly readBody: (id: number, side: BodySide) => StoredBody | undefined;
  readonly search: (filter: SearchFilter, options?: SearchOptions) => SearchPage;
  readonly getReplay: (replayId: string) => ReplayRow | undefined;
  readonly getReplayByKey: (idempotencyKey: string) => ReplayRow | undefined;
  readonly listPendingReplays: () => ReadonlyArray<ReplayRow>;
  readonly countPendingReplays: () => number;
  readonly onChange: (listener: (change: StoreChange) => void) => () => void;
  readonly close: () => void;
}

const SCHEMA = `
CREATE TABLE meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  store_id TEXT NOT NULL,
  key_secret BLOB NOT NULL,
  key_floor INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER,
  listen_host TEXT NOT NULL,
  listen_port INTEGER NOT NULL
);
CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL,
  capture_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  flow_type TEXT NOT NULL,
  method TEXT NOT NULL,
  scheme TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  authority TEXT NOT NULL,
  path TEXT NOT NULL,
  http_version TEXT NOT NULL,
  request_headers BLOB NOT NULL,
  status INTEGER,
  reason TEXT,
  response_http_version TEXT,
  response_headers BLOB,
  error TEXT,
  replay_of TEXT,
  stored_bytes INTEGER NOT NULL
);
CREATE INDEX requests_capture ON requests (capture_id, id);
CREATE INDEX requests_method ON requests (method, id);
CREATE INDEX requests_host ON requests (host, id);
CREATE INDEX requests_status ON requests (status, id);
CREATE INDEX requests_started ON requests (started_at);
CREATE TABLE bodies (
  request_id INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('request', 'response')),
  data BLOB NOT NULL,
  captured_bytes INTEGER NOT NULL,
  declared_bytes INTEGER,
  truncated INTEGER NOT NULL,
  content_encoding TEXT,
  content_type TEXT,
  PRIMARY KEY (request_id, side)
);
CREATE TABLE replays (
  replay_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  key_seq INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  source_request_id INTEGER NOT NULL,
  dest_scheme TEXT NOT NULL,
  dest_host TEXT NOT NULL,
  dest_port INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed', 'unknown')),
  dispatched INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  result_request_id INTEGER,
  seq INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL,
  dispatched_at INTEGER
);
CREATE INDEX replays_state_seq ON replays (state, seq);
`;

type Row = Record<string, NodeSqlite.SQLInputValue>;

const num = (value: NodeSqlite.SQLInputValue | undefined): number => Number(value);
const optNum = (value: NodeSqlite.SQLInputValue | undefined): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);
const str = (value: NodeSqlite.SQLInputValue | undefined): string => String(value);
const optStr = (value: NodeSqlite.SQLInputValue | undefined): string | undefined =>
  value === null || value === undefined ? undefined : String(value);
const blob = (value: NodeSqlite.SQLInputValue | undefined): Buffer =>
  value instanceof Uint8Array
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : Buffer.alloc(0);

export function encodeHeaders(headers: ReadonlyArray<HeaderPair>): Buffer {
  let size = 0;
  for (const [name, value] of headers) size += 8 + name.byteLength + value.byteLength;
  const out = Buffer.allocUnsafe(size);
  let offset = 0;
  for (const [name, value] of headers) {
    out.writeUInt32BE(name.byteLength, offset);
    out.set(name, offset + 4);
    offset += 4 + name.byteLength;
    out.writeUInt32BE(value.byteLength, offset);
    out.set(value, offset + 4);
    offset += 4 + value.byteLength;
  }
  return out;
}

export function decodeHeaders(encoded: Uint8Array): Array<[Buffer, Buffer]> {
  const buffer = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const pairs: Array<[Buffer, Buffer]> = [];
  let offset = 0;
  const take = () => {
    const length = buffer.readUInt32BE(offset);
    const bytes = buffer.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
    return bytes;
  };
  while (offset < buffer.byteLength) {
    const name = take();
    pairs.push([name, take()]);
  }
  return pairs;
}

/** The first value of a header, matched case-insensitively, as latin1 text. */
export function headerValue(headers: ReadonlyArray<HeaderPair>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of headers) {
    if (Buffer.from(key).toString("latin1").toLowerCase() === wanted) {
      return Buffer.from(value).toString("latin1");
    }
  }
  return undefined;
}

const parseDeclaredLength = (headers: ReadonlyArray<HeaderPair>): number | undefined => {
  const value = headerValue(headers, "content-length")?.trim();
  if (value === undefined || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
};

const headersBytes = (headers: ReadonlyArray<HeaderPair>) =>
  headers.reduce((total, [name, value]) => total + 8 + name.byteLength + value.byteLength, 0);

interface PreparedBody {
  readonly data: Uint8Array;
  readonly truncated: boolean;
  readonly declaredBytes: number | undefined;
  readonly contentEncoding: string | undefined;
  readonly contentType: string | undefined;
}

const prepareBody = (
  body: BodyInput | undefined,
  headers: ReadonlyArray<HeaderPair>,
  maxBodyBytes: number,
): PreparedBody | undefined => {
  if (body === undefined) return undefined;
  const cut = body.bytes.byteLength > maxBodyBytes;
  return {
    data: cut ? body.bytes.subarray(0, maxBodyBytes) : body.bytes,
    truncated: cut || body.truncated === true,
    declaredBytes: parseDeclaredLength(headers),
    contentEncoding: headerValue(headers, "content-encoding")?.trim().toLowerCase() || undefined,
    contentType: headerValue(headers, "content-type")?.trim() || undefined,
  };
};

const fileSize = (path: string): number => {
  try {
    return NodeFS.statSync(path).size;
  } catch {
    return 0;
  }
};

const directorySize = (dir: string): number => {
  let entries: Array<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const path = NodePath.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(path) : fileSize(path);
  }
  return total;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const CURSOR_PATTERN = /^c1\.(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})$/;

const encodeCursor = (highWaterId: number, lastId: number, revision: string) =>
  `c1.${highWaterId}.${lastId}.${revision}`;

const decodeCursor = (cursor: string) => {
  const match = CURSOR_PATTERN.exec(cursor);
  if (match === null) throw new InspectorRefusal("invalid-input", "This cursor is not valid.");
  return { highWaterId: Number(match[1]), lastId: Number(match[2]), revision: match[3] as string };
};

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

class Lane {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function openInspectorStore(options: InspectorStoreOptions): InspectorStore {
  const dataDir = options.dataDir;
  const replayDir = NodePath.join(dataDir, REPLAY_DIR);
  const draftsDir = NodePath.join(dataDir, DRAFTS_DIR);
  const databasePath = NodePath.join(dataDir, DATABASE_FILE);
  const walPath = `${databasePath}-wal`;
  const maxBodyBytes = Math.min(
    options.maxBodyBytes ?? STORE_LIMITS.defaultMaxBodyBytes,
    STORE_LIMITS.maxBodyBytes,
  );
  const walTargetBytes = options.walTargetBytes ?? STORE_LIMITS.walTargetBytes;
  const log = options.log ?? (() => undefined);
  const step = (value: StorageStep) => options.onStorageStep?.(value);

  NodeFS.mkdirSync(dataDir, { recursive: true });
  const db = new NodeSqlite.DatabaseSync(databasePath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const version = num(db.prepare("PRAGMA user_version").get()?.user_version);
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `The inspector database has schema version ${version}, newer than this plugin supports.`,
    );
  }
  if (version === 0) {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(SCHEMA);
      db.prepare("INSERT INTO meta (id, store_id, key_secret) VALUES (1, ?, ?)").run(
        NodeCrypto.randomBytes(8).toString("hex"),
        NodeCrypto.randomBytes(32),
      );
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  } else {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA wal_autocheckpoint = 0");
  db.exec("PRAGMA synchronous = NORMAL");

  const statements = {
    seq: db.prepare("SELECT seq FROM meta WHERE id = 1"),
    nextSeq: db.prepare("UPDATE meta SET seq = seq + 1 WHERE id = 1 RETURNING seq"),
    meta: db.prepare("SELECT store_id, key_secret, key_floor FROM meta WHERE id = 1"),
    raiseKeyFloor: db.prepare(
      "UPDATE meta SET key_floor = max(key_floor, ?) WHERE id = 1 RETURNING key_floor",
    ),
    freelist: db.prepare("PRAGMA freelist_count"),
    checkpoint: db.prepare("PRAGMA wal_checkpoint(TRUNCATE)"),
    insertRequest: db.prepare(`
      INSERT INTO requests (seq, capture_id, started_at, flow_type, method, scheme, host, port,
        authority, path, http_version, request_headers, status, reason, response_http_version,
        response_headers, error, replay_of, stored_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
    updateResponse: db.prepare(`
      UPDATE requests SET seq = ?, status = ?, reason = ?, response_http_version = ?,
        response_headers = ?, stored_bytes = stored_bytes + ? WHERE id = ?`),
    updateError: db.prepare("UPDATE requests SET seq = ?, error = ? WHERE id = ?"),
    insertBody: db.prepare(`
      INSERT OR REPLACE INTO bodies (request_id, side, data, captured_bytes, declared_bytes,
        truncated, content_encoding, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    requestRow: db.prepare("SELECT * FROM requests WHERE id = ?"),
    summaryRow: db.prepare(`${summarySelect()} WHERE r.id = ?`),
    bodyMeta: db.prepare(
      "SELECT side, captured_bytes, declared_bytes, truncated, content_encoding, content_type FROM bodies WHERE request_id = ?",
    ),
    bodyData: db.prepare(
      "SELECT data, captured_bytes, declared_bytes, truncated, content_encoding, content_type FROM bodies WHERE request_id = ? AND side = ?",
    ),
    deleteBodies: db.prepare("DELETE FROM bodies WHERE request_id = ?"),
    deleteRequest: db.prepare("DELETE FROM requests WHERE id = ?"),
    pruneOthers: db.prepare(
      "SELECT id, capture_id, stored_bytes FROM requests WHERE capture_id != ? ORDER BY capture_id, id",
    ),
    pruneRunning: db.prepare(
      "SELECT id, capture_id, stored_bytes FROM requests WHERE capture_id = ? ORDER BY id",
    ),
    captureRequestIds: db.prepare("SELECT id FROM requests WHERE capture_id = ? ORDER BY id"),
    captureHasRequests: db.prepare("SELECT 1 AS found FROM requests WHERE capture_id = ? LIMIT 1"),
    insertCapture: db.prepare(
      "INSERT INTO captures (seq, started_at, listen_host, listen_port) VALUES (?, ?, ?, ?) RETURNING id",
    ),
    stopCapture: db.prepare(
      "UPDATE captures SET seq = ?, stopped_at = ? WHERE id = ? AND stopped_at IS NULL",
    ),
    deleteCaptureRow: db.prepare("DELETE FROM captures WHERE id = ?"),
    capture: db.prepare(`
      SELECT c.*, (SELECT count(*) FROM requests r WHERE r.capture_id = c.id) AS request_count
      FROM captures c WHERE c.id = ?`),
    captures: db.prepare(`
      SELECT c.*, (SELECT count(*) FROM requests r WHERE r.capture_id = c.id) AS request_count
      FROM captures c ORDER BY c.id DESC`),
    runningCapture: db.prepare(
      "SELECT id FROM captures WHERE stopped_at IS NULL ORDER BY id DESC LIMIT 1",
    ),
    maxRequestId: db.prepare("SELECT max(id) AS id FROM requests"),
    insertReplay: db.prepare(`
      INSERT INTO replays (replay_id, idempotency_key, key_seq, input_hash, source_request_id,
        dest_scheme, dest_host, dest_port, state, dispatched, detail, result_request_id, seq,
        accepted_at, dispatched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, NULL)`),
    replay: db.prepare("SELECT * FROM replays WHERE replay_id = ?"),
    replayByKey: db.prepare("SELECT * FROM replays WHERE idempotency_key = ?"),
    pendingReplays: db.prepare("SELECT * FROM replays WHERE state = 'pending' ORDER BY seq"),
    pendingCount: db.prepare("SELECT count(*) AS count FROM replays WHERE state = 'pending'"),
    pendingSources: db.prepare(
      "SELECT DISTINCT source_request_id AS id FROM replays WHERE state = 'pending'",
    ),
    settledCount: db.prepare("SELECT count(*) AS count FROM replays WHERE state != 'pending'"),
    oldestSettled: db.prepare(
      "SELECT * FROM replays WHERE state != 'pending' ORDER BY seq LIMIT ?",
    ),
    deleteReplay: db.prepare("DELETE FROM replays WHERE replay_id = ?"),
  };

  const listeners = new Set<(change: StoreChange) => void>();
  const lane = new Lane();
  let checkpointIncomplete = false;
  let droppedFlows = 0;
  let closed = false;

  const emit = (changes: ReadonlyArray<StoreChange>) => {
    for (const change of changes) {
      for (const listener of listeners) {
        try {
          listener(change);
        } catch (error) {
          log(`Store change listener failed: ${errorText(error)}`);
        }
      }
    }
  };

  const currentSeq = () => num(statements.seq.get()?.seq);

  const measureUsage = (): StorageUsage => {
    const database = fileSize(databasePath);
    const wal = fileSize(walPath);
    const replay = directorySize(replayDir);
    const drafts = directorySize(draftsDir);
    return { database, wal, replay, drafts, total: database + wal + replay + drafts };
  };

  const runningCaptureId = (): number | undefined => optNum(statements.runningCapture.get()?.id);

  const toCapture = (row: Row): CaptureRecord => {
    const stoppedAt = optNum(row.stopped_at);
    return {
      id: num(row.id),
      seq: num(row.seq),
      startedAt: num(row.started_at),
      ...(stoppedAt === undefined ? {} : { stoppedAt }),
      listenHost: str(row.listen_host),
      listenPort: num(row.listen_port),
      requestCount: num(row.request_count),
    };
  };

  const getCapture = (captureId: number) => {
    const row = statements.capture.get(captureId);
    return row === undefined ? undefined : toCapture(row);
  };

  const captureStatus = (): CaptureStatus => {
    const runningId = runningCaptureId();
    const running = runningId === undefined ? undefined : getCapture(runningId);
    return {
      ...(running === undefined ? {} : { running }),
      droppedFlows,
      storageBlocked: checkpointIncomplete,
    };
  };

  const toSummary = (row: Row): RequestSummary => {
    const path = str(row.path);
    const cut = path.length > STORE_LIMITS.summaryPathChars;
    const status = optNum(row.status);
    const error = optStr(row.error);
    const replayOf = optStr(row.replay_of);
    const responseBytes = optNum(row.response_bytes);
    return {
      kind: "request",
      id: num(row.id),
      seq: num(row.seq),
      captureId: num(row.capture_id),
      startedAt: num(row.started_at),
      flowType: str(row.flow_type) as FlowType,
      method: str(row.method),
      scheme: str(row.scheme),
      host: str(row.host),
      port: num(row.port),
      path: cut ? path.slice(0, STORE_LIMITS.summaryPathChars) : path,
      ...(cut ? { pathTruncated: true as const } : {}),
      ...(status === undefined ? {} : { status }),
      ...(error === undefined ? {} : { error }),
      ...(replayOf === undefined ? {} : { replayOf }),
      requestBytes: num(row.request_bytes ?? 0),
      ...(responseBytes === undefined && status === undefined
        ? {}
        : { responseBytes: responseBytes ?? 0 }),
    };
  };

  const summaryOf = (id: number): RequestSummary | undefined => {
    const row = statements.summaryRow.get(id);
    return row === undefined ? undefined : toSummary(row);
  };

  const toBodyMeta = (row: Row): BodyMeta => {
    const declaredBytes = optNum(row.declared_bytes);
    const contentEncoding = optStr(row.content_encoding);
    const contentType = optStr(row.content_type);
    return {
      capturedBytes: num(row.captured_bytes),
      ...(declaredBytes === undefined ? {} : { declaredBytes }),
      truncated: num(row.truncated) === 1,
      ...(contentEncoding === undefined ? {} : { contentEncoding }),
      ...(contentType === undefined ? {} : { contentType }),
    };
  };

  const toReplay = (row: Row): ReplayRow => {
    const detail = optStr(row.detail);
    const resultRequestId = optNum(row.result_request_id);
    const dispatchedAt = optNum(row.dispatched_at);
    return {
      replayId: str(row.replay_id),
      idempotencyKey: str(row.idempotency_key),
      keySeq: num(row.key_seq),
      inputHash: str(row.input_hash),
      sourceRequestId: num(row.source_request_id),
      destination: {
        scheme: str(row.dest_scheme),
        host: str(row.dest_host),
        port: num(row.dest_port),
      },
      state: str(row.state) as ReplayState,
      dispatched: num(row.dispatched) === 1,
      ...(detail === undefined ? {} : { detail }),
      ...(resultRequestId === undefined ? {} : { resultRequestId }),
      seq: num(row.seq),
      acceptedAt: num(row.accepted_at),
      ...(dispatchedAt === undefined ? {} : { dispatchedAt }),
    };
  };

  const getReplay = (replayId: string) => {
    const row = statements.replay.get(replayId);
    return row === undefined ? undefined : toReplay(row);
  };

  const clipDetail = (detail: string) =>
    detail.length > STORE_LIMITS.maxReplayDetailChars
      ? `${detail.slice(0, STORE_LIMITS.maxReplayDetailChars - 1)}…`
      : detail;

  const makeTx = (changes: Array<StoreChange>): StoreWriteTx => {
    const nextSeq = () => num(statements.nextSeq.get()?.seq);
    const updateReplay = (replayId: string, patch: ReplayPatch) => {
      const current = getReplay(replayId);
      if (current === undefined) return undefined;
      const seq = nextSeq();
      const sets = ["seq = ?"];
      const values: Array<NodeSqlite.SQLInputValue> = [seq];
      const set = (column: string, value: NodeSqlite.SQLInputValue | undefined) => {
        if (value === undefined) return;
        sets.push(`${column} = ?`);
        values.push(value);
      };
      set("state", patch.state);
      set("dispatched", patch.dispatched === undefined ? undefined : patch.dispatched ? 1 : 0);
      set("dispatched_at", patch.dispatchedAt);
      set("detail", patch.detail === undefined ? undefined : clipDetail(patch.detail));
      set("result_request_id", patch.resultRequestId);
      db.prepare(`UPDATE replays SET ${sets.join(", ")} WHERE replay_id = ?`).run(
        ...values,
        replayId,
      );
      const replay = getReplay(replayId) as ReplayRow;
      changes.push({ type: "replay", replay });
      return replay;
    };
    const raiseKeyFloor = (floor: number) => num(statements.raiseKeyFloor.get(floor)?.key_floor);
    return {
      nextSeq,
      insertReplay: (replay) => {
        const seq = nextSeq();
        statements.insertReplay.run(
          replay.replayId,
          replay.idempotencyKey,
          replay.keySeq,
          replay.inputHash,
          replay.sourceRequestId,
          replay.destination.scheme,
          replay.destination.host,
          replay.destination.port,
          replay.detail === undefined ? null : clipDetail(replay.detail),
          replay.resultRequestId ?? null,
          seq,
          replay.acceptedAt,
        );
        const row = getReplay(replay.replayId) as ReplayRow;
        changes.push({ type: "replay", replay: row });
        return row;
      },
      updateReplay,
      deleteReplay: (replayId) => statements.deleteReplay.run(replayId).changes > 0,
      raiseKeyFloor,
      pruneReplayHistory: (maxSettled) => {
        const excess = num(statements.settledCount.get()?.count) - maxSettled;
        if (excess <= 0) return [];
        const rows = statements.oldestSettled.all(excess).map(toReplay);
        for (const row of rows) {
          statements.deleteReplay.run(row.replayId);
          raiseKeyFloor(row.keySeq + 1);
        }
        return rows;
      },
    };
  };

  const checkpoint = (): boolean => {
    let complete = false;
    // A TRUNCATE checkpoint waits out readers under the busy handler; never block the worker on one.
    db.exec("PRAGMA busy_timeout = 0");
    try {
      const result = statements.checkpoint.get();
      complete = num(result?.busy) === 0;
    } catch (error) {
      log(`Store checkpoint failed: ${errorText(error)}`);
    } finally {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
    const wasBlocked = checkpointIncomplete;
    checkpointIncomplete = !complete;
    step({ kind: "checkpoint", complete });
    if (wasBlocked !== checkpointIncomplete) emit([{ type: "status", status: captureStatus() }]);
    return complete;
  };

  const checkpointIfNeeded = () => {
    if (fileSize(walPath) > walTargetBytes) checkpoint();
  };

  const runWrite = <T>(fn: (tx: StoreWriteTx) => T): T => {
    const changes: Array<StoreChange> = [];
    db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = fn(makeTx(changes));
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    step({ kind: "write" });
    checkpointIfNeeded();
    emit(changes);
    return result;
  };

  const deleteRequestInTx = (tx: StoreWriteTx, changes: Array<StoreChange>, id: number) => {
    const row = statements.requestRow.get(id);
    if (row === undefined) return;
    statements.deleteBodies.run(id);
    statements.deleteRequest.run(id);
    changes.push({
      type: "request-removed",
      id,
      seq: tx.nextSeq(),
      captureId: num(row.capture_id),
    });
  };

  const removeEmptyCaptures = (
    tx: StoreWriteTx,
    changes: Array<StoreChange>,
    captureIds: Iterable<number>,
    runningId: number | undefined,
  ) => {
    for (const captureId of captureIds) {
      if (captureId === runningId) continue;
      if (statements.captureHasRequests.get(captureId) !== undefined) continue;
      if (statements.deleteCaptureRow.run(captureId).changes > 0) {
        changes.push({ type: "capture-removed", id: captureId, seq: tx.nextSeq() });
      }
    }
  };

  // One write transaction that deletes the oldest prunable records covering `shortfall`.
  const prunePass = (shortfall: number, protect: number | undefined): number => {
    const runningId = runningCaptureId();
    const keep = new Set(statements.pendingSources.all().map((row) => num(row.id)));
    if (protect !== undefined) keep.add(protect);
    const victims: Array<number> = [];
    const captures = new Set<number>();
    let covered = 0;
    const collect = (rows: Iterable<Row>) => {
      for (const row of rows) {
        if (covered >= shortfall && victims.length > 0) return;
        const id = num(row.id);
        if (keep.has(id)) continue;
        victims.push(id);
        captures.add(num(row.capture_id));
        covered += num(row.stored_bytes);
      }
    };
    collect(statements.pruneOthers.iterate(runningId ?? -1));
    if (runningId !== undefined && (covered < shortfall || victims.length === 0)) {
      collect(statements.pruneRunning.iterate(runningId));
    }
    if (victims.length === 0) return 0;
    const changes: Array<StoreChange> = [];
    runWrite((tx) => {
      for (const id of victims) deleteRequestInTx(tx, changes, id);
      removeEmptyCaptures(tx, changes, captures, runningId);
    });
    step({ kind: "prune", removed: victims.length });
    emit(changes);
    return victims.length;
  };

  // Bounded vacuum steps, each followed by a checkpoint. False when a step could not finish.
  const vacuumFreePages = (): boolean => {
    for (;;) {
      const free = num(statements.freelist.get()?.freelist_count);
      if (free === 0) return true;
      db.exec(`PRAGMA incremental_vacuum(${STORE_LIMITS.vacuumPagesPerStep})`);
      step({ kind: "vacuum" });
      if (!checkpoint()) return false;
      if (num(statements.freelist.get()?.freelist_count) >= free) {
        log("Store vacuum made no progress.");
        return false;
      }
    }
  };

  const admit = (bytes: number, protect: number | undefined): AdmitResult => {
    const over = () => measureUsage().total + bytes > options.maxDiskBytes;
    if (checkpointIncomplete && !checkpoint()) {
      step({ kind: "refused", bytes });
      return "full";
    }
    try {
      while (over()) {
        if (num(statements.freelist.get()?.freelist_count) > 0) {
          if (!vacuumFreePages()) break;
          continue;
        }
        const usage = measureUsage().total;
        if (prunePass(usage + bytes - options.maxDiskBytes, protect) === 0) break;
      }
    } catch (error) {
      log(`Store maintenance failed: ${errorText(error)}`);
      step({ kind: "maintenance-error" });
    }
    const result: AdmitResult = over() ? "full" : "ok";
    step({ kind: result === "ok" ? "admitted" : "refused", bytes });
    return result;
  };

  const flowEstimate = (
    headers: ReadonlyArray<HeaderPair>,
    body: PreparedBody | undefined,
    extra: number,
  ) =>
    STORE_LIMITS.flowRowAllowanceBytes +
    headersBytes(headers) +
    (body?.data.byteLength ?? 0) +
    extra;

  const insertBody = (requestId: number, side: BodySide, body: PreparedBody) => {
    statements.insertBody.run(
      requestId,
      side,
      body.data,
      body.data.byteLength,
      body.declaredBytes ?? null,
      body.truncated ? 1 : 0,
      body.contentEncoding ?? null,
      body.contentType ?? null,
    );
  };

  const recordDrop = () => {
    droppedFlows += 1;
    emit([{ type: "status", status: captureStatus() }]);
  };

  const insertFlowInLane = (flow: FlowInput): FlowWriteResult => {
    const requestBody = prepareBody(flow.body, flow.headers, maxBodyBytes);
    const response = flow.response;
    const responseBody =
      response === undefined
        ? undefined
        : prepareBody(response.body, response.headers, maxBodyBytes);
    const estimate = flowEstimate(
      flow.headers,
      requestBody,
      response === undefined
        ? 0
        : headersBytes(response.headers) + (responseBody?.data.byteLength ?? 0),
    );
    if (admit(estimate, undefined) === "full") {
      recordDrop();
      return { ok: false, reason: "storage-full" };
    }
    const changes: Array<StoreChange> = [];
    const result = runWrite((tx) => {
      const seq = tx.nextSeq();
      const id = num(
        statements.insertRequest.get(
          seq,
          flow.captureId,
          flow.startedAt,
          flow.flowType ?? "http",
          flow.method.toUpperCase(),
          flow.scheme.toLowerCase(),
          flow.host.toLowerCase(),
          flow.port,
          flow.authority ?? "",
          flow.path,
          flow.httpVersion,
          encodeHeaders(flow.headers),
          response?.status ?? null,
          response?.reason ?? null,
          response?.httpVersion ?? null,
          response === undefined ? null : encodeHeaders(response.headers),
          flow.error ?? null,
          flow.replayOf ?? null,
          estimate,
        )?.id,
      );
      if (requestBody !== undefined) insertBody(id, "request", requestBody);
      if (responseBody !== undefined) insertBody(id, "response", responseBody);
      const summary = summaryOf(id) as RequestSummary;
      changes.push({ type: "request", summary });
      return { ok: true as const, id, seq };
    });
    emit(changes);
    return result;
  };

  const updateFlowInLane = (id: number, update: FlowUpdate): FlowWriteResult => {
    if (statements.requestRow.get(id) === undefined) return { ok: false, reason: "not-found" };
    const response = update.response;
    const responseBody =
      response === undefined
        ? undefined
        : prepareBody(response.body, response.headers, maxBodyBytes);
    const extra =
      response === undefined
        ? 0
        : headersBytes(response.headers) + (responseBody?.data.byteLength ?? 0);
    if (admit(extra + (update.error?.length ?? 0), id) === "full") {
      recordDrop();
      return { ok: false, reason: "storage-full" };
    }
    const changes: Array<StoreChange> = [];
    const result = runWrite((tx): FlowWriteResult => {
      if (statements.requestRow.get(id) === undefined) return { ok: false, reason: "not-found" };
      const seq = tx.nextSeq();
      if (response !== undefined) {
        statements.updateResponse.run(
          seq,
          response.status,
          response.reason ?? null,
          response.httpVersion,
          encodeHeaders(response.headers),
          extra,
          id,
        );
        if (responseBody !== undefined) insertBody(id, "response", responseBody);
      }
      if (update.error !== undefined) statements.updateError.run(seq, update.error, id);
      if (response === undefined && update.error === undefined) {
        db.prepare("UPDATE requests SET seq = ? WHERE id = ?").run(seq, id);
      }
      changes.push({ type: "request", summary: summaryOf(id) as RequestSummary });
      return { ok: true, id, seq };
    });
    emit(changes);
    return result;
  };

  const exclusive = <T>(fn: (lane: StoreLane) => T | Promise<T>): Promise<T> =>
    lane.run(async () => {
      if (closed) throw new Error("The inspector store is closed.");
      let active = true;
      const guard =
        <A extends Array<unknown>, R>(method: (...args: A) => R) =>
        (...args: A): R => {
          if (!active) throw new Error("The store lane was used after it was released.");
          return method(...args);
        };
      const handle: StoreLane = {
        admit: guard((bytes: number, admitOptions?: { readonly protect?: number }) =>
          admit(bytes, admitOptions?.protect),
        ),
        write: guard(runWrite) as StoreLane["write"],
        insertFlow: guard(insertFlowInLane),
        updateFlow: guard(updateFlowInLane),
        startCapture: guard((input) => {
          if (runningCaptureId() !== undefined) {
            throw new InspectorRefusal("conflict", "A capture is already running.");
          }
          const changes: Array<StoreChange> = [];
          const capture = runWrite((tx) => {
            const id = num(
              statements.insertCapture.get(
                tx.nextSeq(),
                input.startedAt,
                input.listenHost,
                input.listenPort,
              )?.id,
            );
            const record = getCapture(id) as CaptureRecord;
            changes.push({ type: "capture", capture: record });
            return record;
          });
          droppedFlows = 0;
          emit(changes);
          emit([{ type: "status", status: captureStatus() }]);
          return capture;
        }),
        stopCapture: guard((captureId: number, stoppedAt: number) => {
          const changes: Array<StoreChange> = [];
          const capture = runWrite((tx) => {
            if (statements.stopCapture.run(tx.nextSeq(), stoppedAt, captureId).changes === 0) {
              return undefined;
            }
            const record = getCapture(captureId) as CaptureRecord;
            changes.push({ type: "capture", capture: record });
            return record;
          });
          emit(changes);
          if (capture !== undefined) emit([{ type: "status", status: captureStatus() }]);
          return capture;
        }),
        deleteCapture: guard((captureId: number) => {
          const capture = getCapture(captureId);
          if (capture === undefined) {
            throw new InspectorRefusal("not-found", MISSING_DETAILS.capture);
          }
          if (capture.stoppedAt === undefined) {
            throw new InspectorRefusal("conflict", "Stop the capture before deleting it.");
          }
          const ids = statements.captureRequestIds.all(captureId).map((row) => num(row.id));
          const pending = new Set(statements.pendingSources.all().map((row) => num(row.id)));
          if (ids.some((id) => pending.has(id))) {
            throw new InspectorRefusal(
              "conflict",
              "This capture has replays in progress. Delete it after they finish.",
            );
          }
          const changes: Array<StoreChange> = [];
          runWrite((tx) => {
            for (const id of ids) deleteRequestInTx(tx, changes, id);
            statements.deleteCaptureRow.run(captureId);
            changes.push({ type: "capture-removed", id: captureId, seq: tx.nextSeq() });
          });
          emit(changes);
          try {
            vacuumFreePages();
          } catch (error) {
            log(`Store maintenance failed: ${errorText(error)}`);
            step({ kind: "maintenance-error" });
          }
        }),
        noteDroppedFlow: guard(recordDrop),
        noteFileWrite: guard(() => step({ kind: "write" })),
        checkpointIfNeeded: guard(checkpointIfNeeded),
      };
      try {
        return await fn(handle);
      } finally {
        active = false;
      }
    });

  const search = (filter: SearchFilter, searchOptions: SearchOptions = {}): SearchPage => {
    const limit = Math.min(
      Math.max(1, Math.trunc(searchOptions.limit ?? STORE_LIMITS.defaultSearchLimit)),
      STORE_LIMITS.maxSearchLimit,
    );
    const maxBytes = searchOptions.maxBytes ?? STORE_LIMITS.searchResultBytes;
    let highWaterId: number;
    let revision: string;
    const where: Array<string> = [];
    const values: Array<NodeSqlite.SQLInputValue> = [];
    if (searchOptions.cursor === undefined) {
      highWaterId = num(statements.maxRequestId.get()?.id ?? 0);
      revision = String(currentSeq());
      where.push("r.id <= ?");
      values.push(highWaterId);
    } else {
      const cursor = decodeCursor(searchOptions.cursor);
      highWaterId = cursor.highWaterId;
      revision = cursor.revision;
      where.push("r.id <= ?", "r.id < ?");
      values.push(highWaterId, cursor.lastId);
    }
    const filterBy = (clause: string, value: NodeSqlite.SQLInputValue | undefined) => {
      if (value === undefined) return;
      where.push(clause);
      values.push(value);
    };
    filterBy("r.method = ?", filter.method?.toUpperCase());
    filterBy("r.host = ?", filter.host?.toLowerCase());
    filterBy("r.status = ?", filter.status);
    filterBy("r.capture_id = ?", filter.captureId);
    if (filter.query !== undefined && filter.query !== "") {
      const pattern = `%${escapeLike(filter.query)}%`;
      where.push("(r.path LIKE ? ESCAPE '\\' OR r.host LIKE ? ESCAPE '\\')");
      values.push(pattern, pattern);
    }
    const rows = db
      .prepare(`${summarySelect()} WHERE ${where.join(" AND ")} ORDER BY r.id DESC LIMIT ?`)
      .all(...values, limit + 1);
    const envelope = jsonBytes({
      items: [],
      cursor: encodeCursor(highWaterId, 0, revision),
      revision,
    });
    const items: Array<RequestSummary> = [];
    let bytes = envelope;
    for (const row of rows.slice(0, limit)) {
      const summary = toSummary(row);
      const size = jsonBytes(summary) + 1;
      if (bytes + size > maxBytes) break;
      bytes += size;
      items.push(summary);
    }
    const more = rows.length > items.length;
    const last = items.at(-1);
    return {
      items,
      cursor: more && last !== undefined ? encodeCursor(highWaterId, last.id, revision) : null,
      revision,
    };
  };

  if (fileSize(walPath) > walTargetBytes) checkpoint();

  return {
    dataDir,
    replayDir,
    draftsDir,
    maxDiskBytes: options.maxDiskBytes,
    exclusive,
    insertFlow: (flow) => exclusive((handle) => handle.insertFlow(flow)),
    updateFlow: (id, update) => exclusive((handle) => handle.updateFlow(id, update)),
    currentSeq,
    meta: () => {
      const row = statements.meta.get() as Row;
      return {
        storeId: str(row.store_id),
        keySecret: Buffer.from(blob(row.key_secret)),
        keyFloor: num(row.key_floor),
      };
    },
    measureUsage,
    captureStatus,
    listCaptures: () => statements.captures.all().map(toCapture),
    getCapture,
    getRequest: (id) => {
      const row = statements.requestRow.get(id);
      if (row === undefined) return undefined;
      const summary = toSummary({ ...row, ...statements.summaryRow.get(id) });
      const bodies = new Map(
        statements.bodyMeta.all(id).map((body) => [str(body.side), toBodyMeta(body)]),
      );
      const requestBody = bodies.get("request");
      const responseBody = bodies.get("response");
      const status = optNum(row.status);
      const reason = optStr(row.reason);
      return {
        summary,
        authority: str(row.authority),
        path: str(row.path),
        httpVersion: str(row.http_version),
        requestHeaders: decodeHeaders(blob(row.request_headers)),
        ...(requestBody === undefined ? {} : { requestBody }),
        ...(status === undefined
          ? {}
          : {
              response: {
                status,
                ...(reason === undefined ? {} : { reason }),
                httpVersion: str(row.response_http_version),
                headers: decodeHeaders(blob(row.response_headers)),
                ...(responseBody === undefined ? {} : { body: responseBody }),
              },
            }),
      };
    },
    readBody: (id, side) => {
      const record = statements.requestRow.get(id);
      if (record === undefined) return undefined;
      const row = statements.bodyData.get(id, side);
      const recordSeq = num(record.seq);
      if (row === undefined) {
        return { meta: { capturedBytes: 0, truncated: false }, bytes: Buffer.alloc(0), recordSeq };
      }
      return { meta: toBodyMeta(row), bytes: blob(row.data), recordSeq };
    },
    search,
    getReplay,
    getReplayByKey: (key) => {
      const row = statements.replayByKey.get(key);
      return row === undefined ? undefined : toReplay(row);
    },
    listPendingReplays: () => statements.pendingReplays.all().map(toReplay),
    countPendingReplays: () => num(statements.pendingCount.get()?.count),
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      if (closed) return;
      closed = true;
      listeners.clear();
      db.close();
    },
  };
}

function summarySelect(): string {
  return `SELECT r.id, r.seq, r.capture_id, r.started_at, r.flow_type, r.method, r.scheme, r.host,
    r.port, r.path, r.status, r.error, r.replay_of,
    (SELECT captured_bytes FROM bodies b WHERE b.request_id = r.id AND b.side = 'request') AS request_bytes,
    (SELECT captured_bytes FROM bodies b WHERE b.request_id = r.id AND b.side = 'response') AS response_bytes
    FROM requests r`;
}
