// @effect-diagnostics nodeBuiltinImport:off - Test fixtures for the builtin-only inspector backend.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type FlowInput,
  type HeaderPair,
  type InspectorStore,
  type InspectorStoreOptions,
  openInspectorStore,
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
  captureId: number,
  index: number,
  bodyBytes: number,
  overrides: Partial<FlowInput> = {},
): FlowInput => ({
  captureId,
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
  const files = ["replay", "drafts"]
    .map((dir) => NodePath.join(dataDir, dir))
    .filter((dir) => NodeFS.existsSync(dir))
    .reduce((total, dir) => total + treeSize(dir), 0);
  return { database, wal, total: database + wal + files };
};

export interface TempStore extends AsyncDisposable {
  readonly dataDir: string;
  readonly store: InspectorStore;
}

export async function openTempStore(
  options: Omit<InspectorStoreOptions, "dataDir">,
): Promise<TempStore> {
  const dataDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "request-inspector-"));
  const store = openInspectorStore({ ...options, dataDir });
  return {
    dataDir,
    store,
    [Symbol.asyncDispose]: async () => {
      store.close();
      await NodeFSP.rm(dataDir, { recursive: true, force: true });
    },
  };
}

export const startCapture = (store: InspectorStore, startedAt = 1_700_000_000_000) =>
  store.exclusive((lane) =>
    lane.startCapture({ listenHost: "127.0.0.1", listenPort: 8080, startedAt }),
  );
