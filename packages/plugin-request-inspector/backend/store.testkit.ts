// @effect-diagnostics nodeBuiltinImport:off - Test fixtures for the builtin-only inspector backend.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_PROXY_ID,
  type FlowInput,
  type HeaderPair,
  type InspectorStore,
  type InspectorStoreOptions,
  openInspectorStore,
  type ProxyOptions,
} from "./store.ts";

export const KiB = 1024;
export const MiB = 1024 * 1024;

export const header = (name: string, value: string | Uint8Array): HeaderPair => [
  Buffer.from(name, "latin1"),
  typeof value === "string" ? Buffer.from(value, "latin1") : value,
];

/** Deterministic, poorly compressible bytes. */
export const patternBytes = (length: number, seed = 0): Buffer => {
  const bytes = Buffer.allocUnsafe(length);
  let state = (seed * 2654435761 + 1) >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
};

export const makeFlow = (
  recordingId: number,
  index: number,
  bodyBytes: number,
  overrides: Partial<FlowInput> = {},
): FlowInput => ({
  recordingId,
  startedAt: 1_700_000_000_000 + index,
  method: "POST",
  scheme: "https",
  host: "api.example.test",
  port: 443,
  path: `/items/${index}`,
  httpVersion: "HTTP/1.1",
  headers: [
    header("content-type", "application/octet-stream"),
    header("content-length", String(bodyBytes)),
  ],
  body: { bytes: patternBytes(bodyBytes, index) },
  ...overrides,
});

export interface MeasuredUsage {
  readonly database: number;
  readonly wal: number;
  readonly total: number;
}

const sizeOf = (path: string) => {
  try {
    return NodeFS.statSync(path).size;
  } catch {
    return 0;
  }
};

const treeSize = (dir: string): number => {
  let total = 0;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += sizeOf(NodePath.join(entry.parentPath, entry.name));
  }
  return total;
};

/** Measures the budgeted files independently of the store. */
export const measureDataDir = (dataDir: string): MeasuredUsage => {
  const database = sizeOf(NodePath.join(dataDir, "inspector.sqlite"));
  const wal = sizeOf(NodePath.join(dataDir, "inspector.sqlite-wal"));
  const files = ["replay", "drafts", "exports"]
    .map((dir) => NodePath.join(dataDir, dir))
    .filter((dir) => NodeFS.existsSync(dir))
    .reduce((total, dir) => total + treeSize(dir), 0);
  return { database, wal, total: database + wal + files };
};

export interface TempStore extends AsyncDisposable {
  readonly dataDir: string;
  readonly store: InspectorStore;
}

export const DEFAULT_PROXY_OPTIONS: ProxyOptions = {
  listenHost: "127.0.0.1",
  listenPort: 8080,
  mode: { kind: "regular" },
  passthroughHosts: [],
  ignoredHosts: [],
};

export async function openTempStore(
  options: Omit<InspectorStoreOptions, "dataDir" | "defaultProxyOptions"> &
    Partial<Pick<InspectorStoreOptions, "defaultProxyOptions">>,
  dataDir?: string,
): Promise<TempStore> {
  dataDir ??= await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "request-inspector-"));
  const store = openInspectorStore({
    defaultProxyOptions: DEFAULT_PROXY_OPTIONS,
    ...options,
    dataDir,
  });
  return {
    dataDir,
    store,
    [Symbol.asyncDispose]: async () => {
      store.close();
      await NodeFSP.rm(dataDir, { recursive: true, force: true });
    },
  };
}

export const startRecording = (
  store: InspectorStore,
  startedAt = 1_700_000_000_000,
  proxyId = DEFAULT_PROXY_ID,
) =>
  store.exclusive((lane) =>
    lane.startRecording({ proxyId, listenHost: "127.0.0.1", listenPort: 8080, startedAt }),
  );

/** The v1 schema as it shipped in 0.1.0, frozen to build databases for the v2 migration test. */
export const V1_SCHEMA = `
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
