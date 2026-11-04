// @effect-diagnostics nodeBuiltinImport:off - The inspector backend packs to one builtin-only CommonJS file with no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { MISSING_DETAILS, PROXY_DETAILS, RECORDING_DETAILS } from "./refusals.ts";

const SCHEMA_VERSION = 3;
const DATABASE_FILE = "inspector.sqlite";
const REPLAY_DIR = "replay";
const DRAFTS_DIR = "drafts";
const EXPORTS_DIR = "exports";

const BUSY_TIMEOUT_MS = 5000;

export const DEFAULT_PROXY_ID = 1;
const DEFAULT_PROXY_NAME = "Default";

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
  maxExportFiles: 64,
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
export type FlowType = "http" | "websocket" | "tunnel" | "other";

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
  readonly recordingId: number;
  readonly startedAt: number;
  readonly flowType?: Exclude<FlowType, "tunnel">;
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

/** A pass-through connection: byte counts only, never headers or bodies. */
export interface TunnelInput {
  readonly recordingId: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** SNI when the client sent one, else the CONNECT host. */
  readonly host: string;
  readonly port: number;
  readonly sni?: string;
  readonly clientAddr?: string;
  readonly bytesUp: number;
  readonly bytesDown: number;
  readonly error?: string;
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
  readonly recordingId: number;
  readonly proxyId: number;
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
  readonly sni?: string;
  readonly clientAddr?: string;
  readonly endedAt?: number;
  readonly bytesUp?: number;
  readonly bytesDown?: number;
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

export type ProxyMode =
  | { readonly kind: "regular" }
  | { readonly kind: "socks5" }
  | { readonly kind: "upstream"; readonly url: string };

/** Stored as JSON. Upstream credentials are kept apart, in `upstream_auth`. */
export interface ProxyOptions {
  readonly listenHost: string;
  readonly listenPort: number | "auto";
  readonly mode: ProxyMode;
  readonly passthroughHosts: ReadonlyArray<string>;
  readonly ignoredHosts: ReadonlyArray<string>;
}

export interface UpstreamAuth {
  readonly username: string;
  readonly password: string;
}

export interface ProxyRecord {
  readonly id: number;
  readonly seq: number;
  readonly name: string;
  readonly createdAt: number;
  readonly deletedAt?: number;
  readonly options: ProxyOptions;
  readonly hasUpstreamAuth: boolean;
}

export type LinkKind = "thread" | "project";

export interface LinkRecord {
  readonly kind: LinkKind;
  readonly targetId: string;
  readonly proxyId: number;
  readonly linkedAt: number;
}

export interface RecordingRecord {
  readonly id: number;
  readonly seq: number;
  readonly proxyId: number;
  readonly name?: string;
  readonly startedAt: number;
  readonly stoppedAt?: number;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly requestCount: number;
  /** Flows dropped while this process had the recording open; not persisted. */
  readonly droppedFlows: number;
}

export interface ExportRecord {
  readonly id: string;
  readonly createdAt: number;
  /** Absolute path under `exportsDir`. */
  readonly path: string;
  readonly bytes: number;
}

export interface StoreStatus {
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
      readonly recordingId: number;
      readonly proxyId: number;
    }
  | { readonly type: "recording"; readonly recording: RecordingRecord }
  | {
      readonly type: "recording-removed";
      readonly id: number;
      readonly seq: number;
      readonly proxyId: number;
    }
  | { readonly type: "proxy"; readonly proxy: ProxyRecord }
  | { readonly type: "link"; readonly link: LinkRecord }
  | {
      readonly type: "link-removed";
      readonly kind: LinkKind;
      readonly targetId: string;
      readonly proxyId: number;
    }
  | { readonly type: "replay"; readonly replay: ReplayRow }
  | { readonly type: "status"; readonly status: StoreStatus };

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
  readonly exports: number;
  readonly total: number;
}

export interface SearchFilter {
  readonly query?: string;
  readonly method?: string;
  readonly host?: string;
  readonly status?: number;
  readonly recordingId?: number;
  readonly proxyId?: number;
  readonly flowType?: FlowType;
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

export interface NewProxy {
  readonly name: string;
  readonly createdAt: number;
  readonly options: ProxyOptions;
  readonly upstreamAuth?: UpstreamAuth;
}

export interface ProxyPatch {
  readonly name?: string;
  readonly options?: ProxyOptions;
  /** `null` clears the stored credentials. */
  readonly upstreamAuth?: UpstreamAuth | null;
}

export interface NewRecording {
  readonly proxyId: number;
  readonly startedAt: number;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly name?: string;
}

export interface NewExport {
  readonly id: string;
  readonly createdAt: number;
  /** A plain file name inside `exportsDir`. */
  readonly fileName: string;
  readonly bytes: number;
}

/** Handle for work that holds the store lane. Valid only inside `InspectorStore.exclusive`. */
export interface StoreLane {
  /** Frees room by deleting exports, then the oldest records (never `protect`). */
  readonly admit: (bytes: number, options?: { readonly protect?: number }) => AdmitResult;
  /** Frees room for a new export by deleting older exports only; records are never pruned. */
  readonly admitExport: (bytes: number) => AdmitResult;
  readonly write: <T>(fn: (tx: StoreWriteTx) => T) => T;
  readonly insertFlow: (flow: FlowInput) => FlowWriteResult;
  readonly insertTunnel: (tunnel: TunnelInput) => FlowWriteResult;
  readonly updateFlow: (id: number, update: FlowUpdate) => FlowWriteResult;
  readonly createProxy: (proxy: NewProxy) => ProxyRecord;
  readonly updateProxy: (proxyId: number, patch: ProxyPatch) => ProxyRecord;
  /** Marks the proxy deleted and drops its links. Its recordings are kept. */
  readonly deleteProxy: (proxyId: number, deletedAt: number) => ProxyRecord;
  /** Adds the link, or refreshes its linkedAt. A target may link several proxies. */
  readonly link: (link: LinkRecord) => void;
  /** Removes the target's link to `proxyId`, or every link of the target. Returns the unlinked proxies. */
  readonly unlink: (kind: LinkKind, targetId: string, proxyId?: number) => ReadonlyArray<number>;
  readonly startRecording: (input: NewRecording) => RecordingRecord;
  readonly stopRecording: (recordingId: number, stoppedAt: number) => RecordingRecord | undefined;
  readonly deleteRecording: (recordingId: number) => void;
  /** Records a file already written under `exportsDir`, deleting the oldest past the cap. */
  readonly addExport: (input: NewExport) => ExportRecord;
  /** Counts a flow dropped without a write, for example over maxRequestsPerRecording. */
  readonly noteDroppedFlow: (recordingId: number) => void;
  /** Call after a write or delete under `replay/`, `drafts/`, or `exports/`, so observers see it. */
  readonly noteFileWrite: () => void;
  readonly checkpointIfNeeded: () => void;
}

export interface InspectorStoreOptions {
  readonly dataDir: string;
  readonly maxDiskBytes: number;
  /** Options of proxy 1, created on a fresh database and by the v1 migration. */
  readonly defaultProxyOptions: ProxyOptions;
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
  readonly exportsDir: string;
  readonly maxDiskBytes: number;
  /** Runs `fn` holding the single-permit store lane. Never call it from inside `fn`. */
  readonly exclusive: <T>(fn: (lane: StoreLane) => T | Promise<T>) => Promise<T>;
  readonly insertFlow: (flow: FlowInput) => Promise<FlowWriteResult>;
  readonly insertTunnel: (tunnel: TunnelInput) => Promise<FlowWriteResult>;
  readonly updateFlow: (id: number, update: FlowUpdate) => Promise<FlowWriteResult>;
  readonly currentSeq: () => number;
  readonly meta: () => StoreMeta;
  readonly measureUsage: () => StorageUsage;
  readonly status: () => StoreStatus;
  /** Every proxy, deleted ones included, by id. */
  readonly listProxies: () => ReadonlyArray<ProxyRecord>;
  readonly getProxy: (proxyId: number) => ProxyRecord | undefined;
  /** Never put this in a view (D22). */
  readonly upstreamAuth: (proxyId: number) => UpstreamAuth | undefined;
  readonly listLinks: (proxyId?: number) => ReadonlyArray<LinkRecord>;
  /** Newest first. */
  readonly listRecordings: (proxyId?: number) => ReadonlyArray<RecordingRecord>;
  readonly getRecording: (recordingId: number) => RecordingRecord | undefined;
  readonly openRecording: (proxyId: number) => RecordingRecord | undefined;
  readonly listExports: () => ReadonlyArray<ExportRecord>;
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
CREATE TABLE proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  options TEXT NOT NULL,
  upstream_auth TEXT
);
CREATE TABLE proxy_links (
  kind TEXT NOT NULL CHECK (kind IN ('thread', 'project')),
  target_id TEXT NOT NULL,
  proxy_id INTEGER NOT NULL,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (kind, target_id, proxy_id)
);
CREATE TABLE recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER,
  listen_host TEXT NOT NULL,
  listen_port INTEGER NOT NULL,
  proxy_id INTEGER NOT NULL DEFAULT 1,
  name TEXT
);
CREATE INDEX recordings_proxy ON recordings (proxy_id, id);
CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL,
  recording_id INTEGER NOT NULL,
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
  stored_bytes INTEGER NOT NULL,
  sni TEXT,
  client_addr TEXT,
  ended_at INTEGER,
  bytes_up INTEGER,
  bytes_down INTEGER
);
CREATE INDEX requests_recording ON requests (recording_id, id);
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
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL
);
`;

// v1 -> v2. Must leave the same tables, columns, and indexes as SCHEMA (store.test.ts checks).
const MIGRATE_V1 = `
CREATE TABLE proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  options TEXT NOT NULL,
  upstream_auth TEXT
);
CREATE TABLE proxy_links (
  kind TEXT NOT NULL CHECK (kind IN ('thread', 'project')),
  target_id TEXT NOT NULL,
  proxy_id INTEGER NOT NULL,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (kind, target_id)
);
ALTER TABLE captures RENAME TO recordings;
ALTER TABLE recordings ADD COLUMN proxy_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recordings ADD COLUMN name TEXT;
CREATE INDEX recordings_proxy ON recordings (proxy_id, id);
DROP INDEX requests_capture;
ALTER TABLE requests RENAME COLUMN capture_id TO recording_id;
ALTER TABLE requests ADD COLUMN sni TEXT;
ALTER TABLE requests ADD COLUMN client_addr TEXT;
ALTER TABLE requests ADD COLUMN ended_at INTEGER;
ALTER TABLE requests ADD COLUMN bytes_up INTEGER;
ALTER TABLE requests ADD COLUMN bytes_down INTEGER;
CREATE INDEX requests_recording ON requests (recording_id, id);
-- v1 could keep a replay result whose capture row was already pruned; give it a recording.
INSERT INTO recordings (id, seq, started_at, stopped_at, listen_host, listen_port)
  SELECT recording_id, 0, min(started_at), max(started_at), '', 0 FROM requests
  WHERE recording_id NOT IN (SELECT id FROM recordings) GROUP BY recording_id;
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL
);
`;

// v2 -> v3: a target may link several proxies. Must leave the same shape as SCHEMA.
const MIGRATE_V2 = `
ALTER TABLE proxy_links RENAME TO proxy_links_v2;
CREATE TABLE proxy_links (
  kind TEXT NOT NULL CHECK (kind IN ('thread', 'project')),
  target_id TEXT NOT NULL,
  proxy_id INTEGER NOT NULL,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (kind, target_id, proxy_id)
);
INSERT INTO proxy_links (kind, target_id, proxy_id, linked_at)
  SELECT kind, target_id, proxy_id, linked_at FROM proxy_links_v2;
DROP TABLE proxy_links_v2;
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
  const exportsDir = NodePath.join(dataDir, EXPORTS_DIR);
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
  const readVersion = () => num(db.prepare("PRAGMA user_version").get()?.user_version);
  const refuseNewer = (version: number) => {
    if (version <= SCHEMA_VERSION) return;
    throw new Error(
      `The inspector database has schema version ${version}, newer than this plugin supports.`,
    );
  };
  const initialVersion = readVersion();
  try {
    refuseNewer(initialVersion);
  } catch (error) {
    db.close();
    throw error;
  }
  if (initialVersion === 0) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA journal_mode = WAL");
  if (initialVersion < SCHEMA_VERSION) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have upgraded between the read above and the write lock.
      const version = readVersion();
      refuseNewer(version);
      if (version === 0) {
        db.exec(SCHEMA);
        db.prepare("INSERT INTO meta (id, store_id, key_secret) VALUES (1, ?, ?)").run(
          NodeCrypto.randomBytes(8).toString("hex"),
          NodeCrypto.randomBytes(32),
        );
      } else {
        if (version === 1) db.exec(MIGRATE_V1);
        if (version <= 2) db.exec(MIGRATE_V2);
      }
      if (version < 2) {
        const seq = num(
          db.prepare("UPDATE meta SET seq = seq + 1 WHERE id = 1 RETURNING seq").get()?.seq,
        );
        db.prepare(
          "INSERT INTO proxies (id, seq, name, created_at, options) VALUES (?, ?, ?, ?, ?)",
        ).run(
          DEFAULT_PROXY_ID,
          seq,
          DEFAULT_PROXY_NAME,
          // @effect-diagnostics-next-line globalDate:off - One wall-clock stamp when the store is created or migrated.
          Date.now(),
          JSON.stringify(options.defaultProxyOptions),
        );
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
      throw error;
    }
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
      INSERT INTO requests (seq, recording_id, started_at, flow_type, method, scheme, host, port,
        authority, path, http_version, request_headers, status, reason, response_http_version,
        response_headers, error, replay_of, stored_bytes, sni, client_addr, ended_at, bytes_up,
        bytes_down)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
    updateResponse: db.prepare(`
      UPDATE requests SET seq = ?, status = ?, reason = ?, response_http_version = ?,
        response_headers = ?, stored_bytes = stored_bytes + ? WHERE id = ?`),
    updateError: db.prepare("UPDATE requests SET seq = ?, error = ? WHERE id = ?"),
    insertBody: db.prepare(`
      INSERT OR REPLACE INTO bodies (request_id, side, data, captured_bytes, declared_bytes,
        truncated, content_encoding, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    requestRow: db.prepare("SELECT * FROM requests WHERE id = ?"),
    requestOwner: db.prepare(`
      SELECT r.recording_id, rec.proxy_id FROM requests r
      JOIN recordings rec ON rec.id = r.recording_id WHERE r.id = ?`),
    summaryRow: db.prepare(`${summarySelect()} WHERE r.id = ?`),
    bodyMeta: db.prepare(
      "SELECT side, captured_bytes, declared_bytes, truncated, content_encoding, content_type FROM bodies WHERE request_id = ?",
    ),
    bodyData: db.prepare(
      "SELECT data, captured_bytes, declared_bytes, truncated, content_encoding, content_type FROM bodies WHERE request_id = ? AND side = ?",
    ),
    deleteBodies: db.prepare("DELETE FROM bodies WHERE request_id = ?"),
    deleteRequest: db.prepare("DELETE FROM requests WHERE id = ?"),
    pruneStopped: db.prepare(`
      SELECT r.id, r.recording_id, r.stored_bytes FROM requests r
      JOIN recordings rec ON rec.id = r.recording_id
      WHERE rec.stopped_at IS NOT NULL ORDER BY r.recording_id, r.id`),
    pruneOpen: db.prepare(`
      SELECT r.id, r.recording_id, r.stored_bytes FROM requests r
      JOIN recordings rec ON rec.id = r.recording_id
      WHERE rec.stopped_at IS NULL ORDER BY r.id`),
    recordingRequestIds: db.prepare("SELECT id FROM requests WHERE recording_id = ? ORDER BY id"),
    deleteEmptyRecording: db.prepare(`
      DELETE FROM recordings WHERE id = ? AND stopped_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM requests WHERE recording_id = ?) RETURNING proxy_id`),
    insertRecording: db.prepare(`
      INSERT INTO recordings (seq, started_at, listen_host, listen_port, proxy_id, name)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id`),
    stopRecording: db.prepare(
      "UPDATE recordings SET seq = ?, stopped_at = ? WHERE id = ? AND stopped_at IS NULL",
    ),
    deleteRecordingRow: db.prepare("DELETE FROM recordings WHERE id = ?"),
    recording: db.prepare(`${recordingSelect()} WHERE rec.id = ?`),
    recordings: db.prepare(`${recordingSelect()} ORDER BY rec.id DESC`),
    recordingsOf: db.prepare(`${recordingSelect()} WHERE rec.proxy_id = ? ORDER BY rec.id DESC`),
    openRecordingOf: db.prepare(
      "SELECT id FROM recordings WHERE proxy_id = ? AND stopped_at IS NULL ORDER BY id DESC LIMIT 1",
    ),
    recordingExists: db.prepare("SELECT 1 AS found FROM recordings WHERE id = ?"),
    proxy: db.prepare("SELECT * FROM proxies WHERE id = ?"),
    proxies: db.prepare("SELECT * FROM proxies ORDER BY id"),
    insertProxy: db.prepare(`
      INSERT INTO proxies (seq, name, created_at, options, upstream_auth)
      VALUES (?, ?, ?, ?, ?) RETURNING id`),
    deleteProxy: db.prepare(
      "UPDATE proxies SET seq = ?, deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
    ),
    links: db.prepare("SELECT * FROM proxy_links ORDER BY kind, target_id, linked_at, rowid"),
    linksOf: db.prepare("SELECT * FROM proxy_links WHERE proxy_id = ? ORDER BY kind, target_id"),
    // REPLACE gives a relinked row a new rowid, so it also wins linked_at ties.
    upsertLink: db.prepare(
      "INSERT OR REPLACE INTO proxy_links (kind, target_id, proxy_id, linked_at) VALUES (?, ?, ?, ?)",
    ),
    deleteLink: db.prepare(
      "DELETE FROM proxy_links WHERE kind = ? AND target_id = ? AND proxy_id = ? RETURNING proxy_id",
    ),
    deleteTargetLinks: db.prepare(
      "DELETE FROM proxy_links WHERE kind = ? AND target_id = ? RETURNING proxy_id",
    ),
    deleteLinksOf: db.prepare(
      "DELETE FROM proxy_links WHERE proxy_id = ? RETURNING kind, target_id",
    ),
    insertExport: db.prepare(
      "INSERT INTO exports (id, created_at, path, bytes) VALUES (?, ?, ?, ?)",
    ),
    exports: db.prepare("SELECT * FROM exports ORDER BY created_at DESC, rowid DESC"),
    exportsPastCap: db.prepare(
      "SELECT * FROM exports ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?",
    ),
    deleteExport: db.prepare("DELETE FROM exports WHERE id = ?"),
    oldestExports: db.prepare("SELECT * FROM exports ORDER BY created_at, rowid"),
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
  const droppedFlows = new Map<number, number>();
  let checkpointIncomplete = false;
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
    const exported = directorySize(exportsDir);
    return {
      database,
      wal,
      replay,
      drafts,
      exports: exported,
      total: database + wal + replay + drafts + exported,
    };
  };

  const status = (): StoreStatus => ({ storageBlocked: checkpointIncomplete });

  const toRecording = (row: Row): RecordingRecord => {
    const id = num(row.id);
    const stoppedAt = optNum(row.stopped_at);
    const name = optStr(row.name);
    return {
      id,
      seq: num(row.seq),
      proxyId: num(row.proxy_id),
      ...(name === undefined ? {} : { name }),
      startedAt: num(row.started_at),
      ...(stoppedAt === undefined ? {} : { stoppedAt }),
      listenHost: str(row.listen_host),
      listenPort: num(row.listen_port),
      requestCount: num(row.request_count),
      droppedFlows: droppedFlows.get(id) ?? 0,
    };
  };

  const getRecording = (recordingId: number) => {
    const row = statements.recording.get(recordingId);
    return row === undefined ? undefined : toRecording(row);
  };

  const openRecording = (proxyId: number) => {
    const id = optNum(statements.openRecordingOf.get(proxyId)?.id);
    return id === undefined ? undefined : getRecording(id);
  };

  const recordingExists = (recordingId: number) =>
    statements.recordingExists.get(recordingId) !== undefined;

  const toProxy = (row: Row): ProxyRecord => {
    const deletedAt = optNum(row.deleted_at);
    return {
      id: num(row.id),
      seq: num(row.seq),
      name: str(row.name),
      createdAt: num(row.created_at),
      ...(deletedAt === undefined ? {} : { deletedAt }),
      options: JSON.parse(str(row.options)) as ProxyOptions,
      hasUpstreamAuth: row.upstream_auth !== null,
    };
  };

  const getProxy = (proxyId: number) => {
    const row = statements.proxy.get(proxyId);
    return row === undefined ? undefined : toProxy(row);
  };

  const liveProxy = (proxyId: number): ProxyRecord => {
    const proxy = getProxy(proxyId);
    if (proxy === undefined) throw new InspectorRefusal("not-found", MISSING_DETAILS.proxy);
    if (proxy.deletedAt !== undefined) {
      throw new InspectorRefusal("conflict", PROXY_DETAILS.deleted);
    }
    return proxy;
  };

  const toLink = (row: Row): LinkRecord => ({
    kind: str(row.kind) as LinkKind,
    targetId: str(row.target_id),
    proxyId: num(row.proxy_id),
    linkedAt: num(row.linked_at),
  });

  const toExport = (row: Row): ExportRecord => ({
    id: str(row.id),
    createdAt: num(row.created_at),
    path: NodePath.join(exportsDir, str(row.path)),
    bytes: num(row.bytes),
  });

  const toSummary = (row: Row): RequestSummary => {
    const path = str(row.path);
    const cut = path.length > STORE_LIMITS.summaryPathChars;
    const status = optNum(row.status);
    const error = optStr(row.error);
    const replayOf = optStr(row.replay_of);
    const responseBytes = optNum(row.response_bytes);
    const sni = optStr(row.sni);
    const clientAddr = optStr(row.client_addr);
    const endedAt = optNum(row.ended_at);
    const bytesUp = optNum(row.bytes_up);
    const bytesDown = optNum(row.bytes_down);
    return {
      kind: "request",
      id: num(row.id),
      seq: num(row.seq),
      recordingId: num(row.recording_id),
      proxyId: num(row.proxy_id),
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
      ...(sni === undefined ? {} : { sni }),
      ...(clientAddr === undefined ? {} : { clientAddr }),
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(bytesUp === undefined ? {} : { bytesUp }),
      ...(bytesDown === undefined ? {} : { bytesDown }),
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
    if (wasBlocked !== checkpointIncomplete) emit([{ type: "status", status: status() }]);
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
    const owner = statements.requestOwner.get(id);
    if (owner === undefined) return;
    statements.deleteBodies.run(id);
    statements.deleteRequest.run(id);
    changes.push({
      type: "request-removed",
      id,
      seq: tx.nextSeq(),
      recordingId: num(owner.recording_id),
      proxyId: num(owner.proxy_id),
    });
  };

  const removeEmptyRecordings = (
    tx: StoreWriteTx,
    changes: Array<StoreChange>,
    recordingIds: Iterable<number>,
  ) => {
    for (const recordingId of recordingIds) {
      const removed = statements.deleteEmptyRecording.get(recordingId, recordingId);
      if (removed === undefined) continue;
      droppedFlows.delete(recordingId);
      changes.push({
        type: "recording-removed",
        id: recordingId,
        seq: tx.nextSeq(),
        proxyId: num(removed.proxy_id),
      });
    }
  };

  // One write transaction that deletes the oldest prunable records covering `shortfall`:
  // stopped recordings first, then the oldest records of open ones.
  const prunePass = (shortfall: number, protect: number | undefined): number => {
    const keep = new Set(statements.pendingSources.all().map((row) => num(row.id)));
    if (protect !== undefined) keep.add(protect);
    const victims: Array<number> = [];
    const recordings = new Set<number>();
    let covered = 0;
    const collect = (rows: Iterable<Row>) => {
      for (const row of rows) {
        if (covered >= shortfall && victims.length > 0) return;
        const id = num(row.id);
        if (keep.has(id)) continue;
        victims.push(id);
        recordings.add(num(row.recording_id));
        covered += num(row.stored_bytes);
      }
    };
    collect(statements.pruneStopped.iterate());
    if (covered < shortfall || victims.length === 0) collect(statements.pruneOpen.iterate());
    if (victims.length === 0) return 0;
    const changes: Array<StoreChange> = [];
    runWrite((tx) => {
      for (const id of victims) deleteRequestInTx(tx, changes, id);
      removeEmptyRecordings(tx, changes, recordings);
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

  const vacuumQuietly = () => {
    try {
      vacuumFreePages();
    } catch (error) {
      log(`Store maintenance failed: ${errorText(error)}`);
      step({ kind: "maintenance-error" });
    }
  };

  // Exports are regenerable, so they go first, oldest first, until `shortfall` is covered.
  const pruneExports = (shortfall: number): number => {
    const victims: Array<ExportRecord> = [];
    let covered = 0;
    for (const row of statements.oldestExports.iterate()) {
      if (covered >= shortfall) break;
      const record = toExport(row);
      victims.push(record);
      covered += record.bytes;
    }
    if (victims.length === 0) return 0;
    runWrite(() => {
      for (const record of victims) statements.deleteExport.run(record.id);
    });
    for (const record of victims) NodeFS.rmSync(record.path, { force: true });
    step({ kind: "prune", removed: victims.length });
    return victims.length;
  };

  const admit = (bytes: number, protect: number | undefined, exportsOnly = false): AdmitResult => {
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
        const shortfall = measureUsage().total + bytes - options.maxDiskBytes;
        if (pruneExports(shortfall) > 0) continue;
        if (exportsOnly || prunePass(shortfall, protect) === 0) break;
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

  const recordDrop = (recordingId: number) => {
    droppedFlows.set(recordingId, (droppedFlows.get(recordingId) ?? 0) + 1);
    const recording = getRecording(recordingId);
    if (recording !== undefined) emit([{ type: "recording", recording }]);
  };

  interface RequestRow {
    readonly recordingId: number;
    readonly startedAt: number;
    readonly flowType: FlowType;
    readonly method: string;
    readonly scheme: string;
    readonly host: string;
    readonly port: number;
    readonly authority: string;
    readonly path: string;
    readonly httpVersion: string;
    readonly requestHeaders: Uint8Array;
    readonly response?: FlowResponseInput;
    readonly error?: string;
    readonly replayOf?: string;
    readonly storedBytes: number;
    readonly tunnel?: Pick<TunnelInput, "sni" | "clientAddr" | "endedAt" | "bytesUp" | "bytesDown">;
  }

  const insertRequestRow = (seq: number, row: RequestRow): number =>
    num(
      statements.insertRequest.get(
        seq,
        row.recordingId,
        row.startedAt,
        row.flowType,
        row.method.toUpperCase(),
        row.scheme.toLowerCase(),
        row.host.toLowerCase(),
        row.port,
        row.authority,
        row.path,
        row.httpVersion,
        row.requestHeaders,
        row.response?.status ?? null,
        row.response?.reason ?? null,
        row.response?.httpVersion ?? null,
        row.response === undefined ? null : encodeHeaders(row.response.headers),
        row.error ?? null,
        row.replayOf ?? null,
        row.storedBytes,
        row.tunnel?.sni ?? null,
        row.tunnel?.clientAddr ?? null,
        row.tunnel?.endedAt ?? null,
        row.tunnel?.bytesUp ?? null,
        row.tunnel?.bytesDown ?? null,
      )?.id,
    );

  // Admits, then inserts one row in its own transaction. `bodies` run inside it.
  const writeRequest = (
    row: RequestRow,
    bodies: (id: number) => void = () => undefined,
  ): FlowWriteResult => {
    if (!recordingExists(row.recordingId)) return { ok: false, reason: "not-found" };
    if (admit(row.storedBytes, undefined) === "full") {
      recordDrop(row.recordingId);
      return { ok: false, reason: "storage-full" };
    }
    const changes: Array<StoreChange> = [];
    const result = runWrite((tx): FlowWriteResult => {
      // Pruning during admission can remove an emptied recording.
      if (!recordingExists(row.recordingId)) return { ok: false, reason: "not-found" };
      const seq = tx.nextSeq();
      const id = insertRequestRow(seq, row);
      bodies(id);
      changes.push({ type: "request", summary: summaryOf(id) as RequestSummary });
      return { ok: true, id, seq };
    });
    emit(changes);
    return result;
  };

  const insertFlowInLane = (flow: FlowInput): FlowWriteResult => {
    const requestBody = prepareBody(flow.body, flow.headers, maxBodyBytes);
    const response = flow.response;
    const responseBody =
      response === undefined
        ? undefined
        : prepareBody(response.body, response.headers, maxBodyBytes);
    const storedBytes = flowEstimate(
      flow.headers,
      requestBody,
      response === undefined
        ? 0
        : headersBytes(response.headers) + (responseBody?.data.byteLength ?? 0),
    );
    return writeRequest(
      {
        recordingId: flow.recordingId,
        startedAt: flow.startedAt,
        flowType: flow.flowType ?? "http",
        method: flow.method,
        scheme: flow.scheme,
        host: flow.host,
        port: flow.port,
        authority: flow.authority ?? "",
        path: flow.path,
        httpVersion: flow.httpVersion,
        requestHeaders: encodeHeaders(flow.headers),
        ...(response === undefined ? {} : { response }),
        ...(flow.error === undefined ? {} : { error: flow.error }),
        ...(flow.replayOf === undefined ? {} : { replayOf: flow.replayOf }),
        storedBytes,
      },
      (id) => {
        if (requestBody !== undefined) insertBody(id, "request", requestBody);
        if (responseBody !== undefined) insertBody(id, "response", responseBody);
      },
    );
  };

  const insertTunnelInLane = (tunnel: TunnelInput): FlowWriteResult =>
    writeRequest({
      recordingId: tunnel.recordingId,
      startedAt: tunnel.startedAt,
      flowType: "tunnel",
      method: "CONNECT",
      scheme: "tcp",
      host: tunnel.host,
      port: tunnel.port,
      authority: `${tunnel.host}:${tunnel.port}`,
      path: "",
      httpVersion: "",
      requestHeaders: Buffer.alloc(0),
      ...(tunnel.error === undefined ? {} : { error: tunnel.error }),
      storedBytes:
        STORE_LIMITS.flowRowAllowanceBytes +
        2 * tunnel.host.length +
        (tunnel.sni?.length ?? 0) +
        (tunnel.clientAddr?.length ?? 0) +
        (tunnel.error?.length ?? 0),
      tunnel,
    });

  const updateFlowInLane = (id: number, update: FlowUpdate): FlowWriteResult => {
    const owner = statements.requestOwner.get(id);
    if (owner === undefined) return { ok: false, reason: "not-found" };
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
      recordDrop(num(owner.recording_id));
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

  // Runs `fn` in a write transaction and emits the changes it collected after commit.
  const writeEmitting = <T>(fn: (tx: StoreWriteTx, changes: Array<StoreChange>) => T): T => {
    const changes: Array<StoreChange> = [];
    const result = runWrite((tx) => fn(tx, changes));
    emit(changes);
    return result;
  };

  const createProxy = (input: NewProxy): ProxyRecord =>
    writeEmitting((tx, changes) => {
      const id = num(
        statements.insertProxy.get(
          tx.nextSeq(),
          input.name,
          input.createdAt,
          JSON.stringify(input.options),
          input.upstreamAuth === undefined ? null : JSON.stringify(input.upstreamAuth),
        )?.id,
      );
      const proxy = getProxy(id) as ProxyRecord;
      changes.push({ type: "proxy", proxy });
      return proxy;
    });

  const updateProxy = (proxyId: number, patch: ProxyPatch): ProxyRecord =>
    writeEmitting((tx, changes) => {
      liveProxy(proxyId);
      const sets = ["seq = ?"];
      const values: Array<NodeSqlite.SQLInputValue> = [tx.nextSeq()];
      if (patch.name !== undefined) {
        sets.push("name = ?");
        values.push(patch.name);
      }
      if (patch.options !== undefined) {
        sets.push("options = ?");
        values.push(JSON.stringify(patch.options));
      }
      if (patch.upstreamAuth !== undefined) {
        sets.push("upstream_auth = ?");
        values.push(patch.upstreamAuth === null ? null : JSON.stringify(patch.upstreamAuth));
      }
      db.prepare(`UPDATE proxies SET ${sets.join(", ")} WHERE id = ?`).run(...values, proxyId);
      const proxy = getProxy(proxyId) as ProxyRecord;
      changes.push({ type: "proxy", proxy });
      return proxy;
    });

  const deleteProxy = (proxyId: number, deletedAt: number): ProxyRecord =>
    writeEmitting((tx, changes) => {
      liveProxy(proxyId);
      if (openRecording(proxyId) !== undefined) {
        throw new InspectorRefusal("conflict", PROXY_DETAILS.recordingOpen);
      }
      statements.deleteProxy.run(tx.nextSeq(), deletedAt, proxyId);
      for (const row of statements.deleteLinksOf.all(proxyId)) {
        changes.push({
          type: "link-removed",
          kind: str(row.kind) as LinkKind,
          targetId: str(row.target_id),
          proxyId,
        });
      }
      const proxy = getProxy(proxyId) as ProxyRecord;
      changes.push({ type: "proxy", proxy });
      return proxy;
    });

  const link = (input: LinkRecord) =>
    writeEmitting((tx, changes) => {
      if (input.targetId === "") {
        throw new InspectorRefusal("invalid-input", PROXY_DETAILS.linkTarget);
      }
      liveProxy(input.proxyId);
      statements.upsertLink.run(input.kind, input.targetId, input.proxyId, input.linkedAt);
      tx.nextSeq();
      changes.push({ type: "link", link: input });
    });

  const unlink = (kind: LinkKind, targetId: string, proxyId?: number) =>
    writeEmitting((tx, changes) => {
      const rows =
        proxyId === undefined
          ? statements.deleteTargetLinks.all(kind, targetId)
          : statements.deleteLink.all(kind, targetId, proxyId);
      const removed = rows.map((row) => num(row.proxy_id)).toSorted((a, b) => a - b);
      if (removed.length === 0) return removed;
      tx.nextSeq();
      for (const id of removed) changes.push({ type: "link-removed", kind, targetId, proxyId: id });
      return removed;
    });

  const startRecording = (input: NewRecording): RecordingRecord =>
    writeEmitting((tx, changes) => {
      liveProxy(input.proxyId);
      if (openRecording(input.proxyId) !== undefined) {
        throw new InspectorRefusal("conflict", PROXY_DETAILS.alreadyRecording);
      }
      const id = num(
        statements.insertRecording.get(
          tx.nextSeq(),
          input.startedAt,
          input.listenHost,
          input.listenPort,
          input.proxyId,
          input.name ?? null,
        )?.id,
      );
      droppedFlows.set(id, 0);
      const recording = getRecording(id) as RecordingRecord;
      changes.push({ type: "recording", recording });
      return recording;
    });

  const stopRecording = (recordingId: number, stoppedAt: number) =>
    writeEmitting((tx, changes) => {
      if (statements.stopRecording.run(tx.nextSeq(), stoppedAt, recordingId).changes === 0) {
        return undefined;
      }
      const recording = getRecording(recordingId) as RecordingRecord;
      changes.push({ type: "recording", recording });
      return recording;
    });

  const deleteRecording = (recordingId: number) => {
    const recording = getRecording(recordingId);
    if (recording === undefined) throw new InspectorRefusal("not-found", MISSING_DETAILS.recording);
    if (recording.stoppedAt === undefined) {
      throw new InspectorRefusal("conflict", RECORDING_DETAILS.open);
    }
    const ids = statements.recordingRequestIds.all(recordingId).map((row) => num(row.id));
    const pending = new Set(statements.pendingSources.all().map((row) => num(row.id)));
    if (ids.some((id) => pending.has(id))) {
      throw new InspectorRefusal("conflict", RECORDING_DETAILS.replaysPending);
    }
    writeEmitting((tx, changes) => {
      for (const id of ids) deleteRequestInTx(tx, changes, id);
      statements.deleteRecordingRow.run(recordingId);
      droppedFlows.delete(recordingId);
      changes.push({
        type: "recording-removed",
        id: recordingId,
        seq: tx.nextSeq(),
        proxyId: recording.proxyId,
      });
    });
    vacuumQuietly();
  };

  const addExport = (input: NewExport): ExportRecord => {
    const name = input.fileName;
    if (name === "" || name === "." || name === ".." || NodePath.basename(name) !== name) {
      throw new InspectorRefusal("invalid-input", "An export file name cannot contain a path.");
    }
    const removed = runWrite(() => {
      statements.insertExport.run(input.id, input.createdAt, name, input.bytes);
      const past = statements.exportsPastCap.all(STORE_LIMITS.maxExportFiles).map(toExport);
      for (const row of past) statements.deleteExport.run(row.id);
      return past;
    });
    for (const row of removed) NodeFS.rmSync(row.path, { force: true });
    if (removed.length > 0) step({ kind: "write" });
    return {
      id: input.id,
      createdAt: input.createdAt,
      path: NodePath.join(exportsDir, name),
      bytes: input.bytes,
    };
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
        admitExport: guard((bytes: number) => admit(bytes, undefined, true)),
        write: guard(runWrite) as StoreLane["write"],
        insertFlow: guard(insertFlowInLane),
        insertTunnel: guard(insertTunnelInLane),
        updateFlow: guard(updateFlowInLane),
        createProxy: guard(createProxy),
        updateProxy: guard(updateProxy),
        deleteProxy: guard(deleteProxy),
        link: guard(link),
        unlink: guard(unlink),
        startRecording: guard(startRecording),
        stopRecording: guard(stopRecording),
        deleteRecording: guard(deleteRecording),
        addExport: guard(addExport),
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
    filterBy("r.recording_id = ?", filter.recordingId);
    filterBy("rec.proxy_id = ?", filter.proxyId);
    filterBy("r.flow_type = ?", filter.flowType);
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
    exportsDir,
    maxDiskBytes: options.maxDiskBytes,
    exclusive,
    insertFlow: (flow) => exclusive((handle) => handle.insertFlow(flow)),
    insertTunnel: (tunnel) => exclusive((handle) => handle.insertTunnel(tunnel)),
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
    status,
    listProxies: () => statements.proxies.all().map(toProxy),
    getProxy,
    upstreamAuth: (proxyId) => {
      const value = optStr(statements.proxy.get(proxyId)?.upstream_auth);
      return value === undefined ? undefined : (JSON.parse(value) as UpstreamAuth);
    },
    listLinks: (proxyId) =>
      (proxyId === undefined ? statements.links.all() : statements.linksOf.all(proxyId)).map(
        toLink,
      ),
    listRecordings: (proxyId) =>
      (proxyId === undefined
        ? statements.recordings.all()
        : statements.recordingsOf.all(proxyId)
      ).map(toRecording),
    getRecording,
    openRecording,
    listExports: () => statements.exports.all().map(toExport),
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
  return `SELECT r.id, r.seq, r.recording_id, rec.proxy_id, r.started_at, r.flow_type, r.method,
    r.scheme, r.host, r.port, r.path, r.status, r.error, r.replay_of, r.sni, r.client_addr,
    r.ended_at, r.bytes_up, r.bytes_down,
    (SELECT captured_bytes FROM bodies b WHERE b.request_id = r.id AND b.side = 'request') AS request_bytes,
    (SELECT captured_bytes FROM bodies b WHERE b.request_id = r.id AND b.side = 'response') AS response_bytes
    FROM requests r JOIN recordings rec ON rec.id = r.recording_id`;
}

function recordingSelect(): string {
  return `SELECT rec.*,
    (SELECT count(*) FROM requests r WHERE r.recording_id = rec.id) AS request_count
    FROM recordings rec`;
}
