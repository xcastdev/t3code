// @effect-diagnostics nodeBuiltinImport:off - Drives the builtin-only inspector store on real node:sqlite.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { makeDraftStore } from "./bodies.ts";
import { STORAGE_FULL_DETAIL } from "./refusals.ts";
import {
  DEFAULT_PROXY_ID,
  InspectorRefusal,
  type RequestSummary,
  STORE_LIMITS,
  type StorageStep,
  type StoreChange,
} from "./store.ts";
import {
  DEFAULT_PROXY_OPTIONS,
  header,
  KiB,
  makeFlow,
  measureDataDir,
  MiB,
  openTempStore,
  patternBytes,
  startRecording,
  V1_SCHEMA,
} from "./store.testkit.ts";

const BUDGET = 4 * MiB;
const FLOW_BODY = 256 * KiB;
// One flow's stored size plus SQLite page and overflow overhead (about 64 KiB in the plan's probe).
const ONE_FLOW = FLOW_BODY + 64 * KiB;
const VACUUM_STEP = 1 * MiB;

describe("storage budget", () => {
  it("under storage pressure, inserting flows prunes the oldest recordings and then the open recording's oldest records, and measured usage stays within the stated bound", async () => {
    const violations: Array<string> = [];
    const logs: Array<string> = [];
    let dataDir = "";
    let previousDatabase = 0;
    let databaseShrank = false;
    let maintenanceErrors = 0;
    const onStorageStep = (step: StorageStep) => {
      const usage = measureDataDir(dataDir);
      const bound = BUDGET + ONE_FLOW + STORE_LIMITS.walTargetBytes + VACUUM_STEP;
      if (usage.total > bound) violations.push(`${step.kind}: ${usage.total} > ${bound}`);
      if (step.kind === "admitted" && usage.total + step.bytes > BUDGET) {
        violations.push(`admitted at ${usage.total} + ${step.bytes}`);
      }
      if (step.kind === "maintenance-error") maintenanceErrors += 1;
      if (usage.database < previousDatabase) databaseShrank = true;
      previousDatabase = usage.database;
    };
    await using temp = await openTempStore({
      maxDiskBytes: BUDGET,
      onStorageStep,
      log: (message) => logs.push(message),
    });
    dataDir = temp.dataDir;
    const { store } = temp;
    const removedRecordingOrder: Array<number> = [];
    const removedIds: Array<number> = [];
    store.onChange((change) => {
      if (change.type === "request-removed") {
        removedRecordingOrder.push(change.recordingId);
        removedIds.push(change.id);
      }
    });

    const first = await startRecording(store);
    const firstIds: Array<number> = [];
    for (let index = 0; index < 100; index += 1) {
      const result = await store.insertFlow(makeFlow(first.id, index, FLOW_BODY));
      expect(result.ok).toBe(true);
      if (result.ok) firstIds.push(result.id);
    }
    await store.exclusive((lane) => lane.stopRecording(first.id, 1_700_000_100_000));
    const second = await startRecording(store, 1_700_000_200_000);
    for (let index = 100; index < 200; index += 1) {
      const result = await store.insertFlow(makeFlow(second.id, index, FLOW_BODY));
      expect(result.ok).toBe(true);
    }

    expect(violations).toEqual([]);
    expect(databaseShrank).toBe(true);
    expect(maintenanceErrors).toBe(0);
    expect(logs.filter((message) => message.includes("locked"))).toEqual([]);
    expect(measureDataDir(dataDir).total).toBeLessThanOrEqual(BUDGET);

    // Every record of the stopped recording went before any record of the open one, oldest first.
    const firstSecondRemoval = removedRecordingOrder.indexOf(second.id);
    expect(firstSecondRemoval).toBeGreaterThan(0);
    expect(removedRecordingOrder.slice(0, firstSecondRemoval).every((id) => id === first.id)).toBe(
      true,
    );
    expect(removedIds.slice(0, firstSecondRemoval)).toEqual(firstIds);
    expect(removedIds.slice(firstSecondRemoval)).toEqual(
      removedIds.slice(firstSecondRemoval).toSorted((a, b) => a - b),
    );
    expect(store.getRecording(first.id)).toBeUndefined();
    expect(store.getRecording(second.id)?.droppedFlows).toBe(0);
    expect(store.status().storageBlocked).toBe(false);
  });

  it("a checkpoint blocked by an open reader stops new writes instead of growing the -wal file, and the next admission after the reader closes checkpoints and accepts", async () => {
    const steps: Array<{ readonly step: StorageStep; readonly database: number }> = [];
    let dataDir = "";
    await using temp = await openTempStore({
      maxDiskBytes: BUDGET,
      onStorageStep: (step) => steps.push({ step, database: measureDataDir(dataDir).database }),
    });
    dataDir = temp.dataDir;
    const { store } = temp;
    const recording = await startRecording(store);
    for (let index = 0; index < 30; index += 1) {
      await store.insertFlow(makeFlow(recording.id, index, FLOW_BODY));
    }
    expect(measureDataDir(dataDir).total).toBeLessThanOrEqual(BUDGET);

    const reader = new NodeSqlite.DatabaseSync(NodePath.join(dataDir, "inspector.sqlite"));
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) AS count FROM requests").get();

      expect(await store.insertFlow(makeFlow(recording.id, 30, FLOW_BODY))).toEqual({
        ok: false,
        reason: "storage-full",
      });
      expect(store.status().storageBlocked).toBe(true);
      const blockedWal = measureDataDir(dataDir).wal;
      for (let index = 31; index < 36; index += 1) {
        expect((await store.insertFlow(makeFlow(recording.id, index, FLOW_BODY))).ok).toBe(false);
        expect(measureDataDir(dataDir).wal).toBe(blockedWal);
      }
      expect(store.getRecording(recording.id)?.droppedFlows).toBe(6);
      expect(store.status().storageBlocked).toBe(true);
      reader.exec("COMMIT");
    } finally {
      reader.close();
    }

    const databaseBefore = measureDataDir(dataDir).database;
    steps.length = 0;
    const accepted = await store.insertFlow(makeFlow(recording.id, 36, FLOW_BODY));
    expect(accepted.ok).toBe(true);
    expect(store.status().storageBlocked).toBe(false);
    const firstCheckpoint = steps.findIndex(({ step }) => step.kind === "checkpoint");
    expect(steps[firstCheckpoint]?.step).toEqual({ kind: "checkpoint", complete: true });
    expect(steps[firstCheckpoint]?.database).toBeLessThan(databaseBefore);
    expect(measureDataDir(dataDir).total).toBeLessThanOrEqual(BUDGET);
  });

  // The replay_request refusal and the completed-without-response settle belong to replay.ts.
  it("when only unprunable data remains over budget, a new flow is dropped and counted, and body_draft_write is refused with the storage-full detail, recording nothing", async () => {
    await using temp = await openTempStore({ maxDiskBytes: BUDGET });
    const { store, dataDir } = temp;
    const drafts = makeDraftStore(store);
    const recording = await startRecording(store);
    const sources: Array<number> = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await store.insertFlow(makeFlow(recording.id, index, FLOW_BODY));
      if (result.ok) sources.push(result.id);
    }
    await store.exclusive((lane) =>
      lane.write((tx) => {
        for (const [index, sourceRequestId] of sources.entries()) {
          tx.insertReplay({
            replayId: `replay-${index}`,
            idempotencyKey: `key-${index}`,
            keySeq: 1,
            inputHash: "hash",
            sourceRequestId,
            destination: { scheme: "https", host: "api.example.test", port: 443 },
            acceptedAt: 0,
          });
        }
      }),
    );

    const chunk = patternBytes(128 * KiB).toString("base64");
    const draft = await drafts.write({ offset: 0, base64: chunk });
    let refusal: unknown;
    for (let offset = draft.size; refusal === undefined; offset += 128 * KiB) {
      refusal = await drafts.write({ draftId: draft.draftId, offset, base64: chunk }).then(
        () => undefined,
        (error: unknown) => error,
      );
    }
    expect(refusal).toBeInstanceOf(InspectorRefusal);
    expect((refusal as InspectorRefusal).message).toBe(STORAGE_FULL_DETAIL);

    const draftFiles = () =>
      NodeFS.readdirSync(store.draftsDir).map((name) => [
        name,
        NodeFS.statSync(NodePath.join(store.draftsDir, name)).size,
      ]);
    const filesBefore = draftFiles();
    const revisionBefore = store.currentSeq();

    expect(await store.insertFlow(makeFlow(recording.id, 10, FLOW_BODY))).toEqual({
      ok: false,
      reason: "storage-full",
    });
    expect(store.getRecording(recording.id)?.droppedFlows).toBe(1);
    await expect(drafts.write({ offset: 0, base64: chunk })).rejects.toThrow(STORAGE_FULL_DETAIL);
    await expect(
      drafts.write({
        draftId: draft.draftId,
        offset: drafts.size(draft.draftId) ?? 0,
        base64: chunk,
      }),
    ).rejects.toThrow(STORAGE_FULL_DETAIL);

    expect(draftFiles()).toEqual(filesBefore);
    expect(store.currentSeq()).toBe(revisionBefore);
    expect(store.search({}).items.map((item) => item.id)).toEqual(sources.toReversed());
    expect(measureDataDir(dataDir).total).toBeLessThanOrEqual(BUDGET);
  });
  it("exports are pruned oldest first before any record, and a new export never prunes records: it is refused when older exports cannot make room", async () => {
    await using temp = await openTempStore({ maxDiskBytes: BUDGET });
    const { store, dataDir } = temp;
    const removedRequests: Array<number> = [];
    const exportsAtFirstRemoval: Array<number> = [];
    store.onChange((change) => {
      if (change.type !== "request-removed") return;
      if (removedRequests.length === 0) exportsAtFirstRemoval.push(store.listExports().length);
      removedRequests.push(change.id);
    });
    const writeExport = (id: string, bytes: number, target = store) =>
      target.exclusive((lane) => {
        if (lane.admitExport(bytes) === "full") return "full";
        NodeFS.mkdirSync(target.exportsDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(target.exportsDir, `${id}.bin`), patternBytes(bytes));
        lane.noteFileWrite();
        lane.addExport({ id, createdAt: Number(id.slice(1)), fileName: `${id}.bin`, bytes });
        return "ok";
      });
    const exportIds = (target = store) => target.listExports().map((record) => record.id);

    const recording = await startRecording(store);
    let index = 0;
    while (measureDataDir(dataDir).total + 1 * MiB < BUDGET) {
      expect((await store.insertFlow(makeFlow(recording.id, index, FLOW_BODY))).ok).toBe(true);
      index += 1;
    }
    expect(await writeExport("e1", 512 * KiB)).toBe("ok");
    expect(await writeExport("e2", 256 * KiB)).toBe("ok");
    const tight = BUDGET - measureDataDir(dataDir).total + 64 * KiB;
    expect(await writeExport("e3", tight)).toBe("ok");
    expect(exportIds()).toEqual(["e3", "e2"]);
    expect(removedRequests).toEqual([]);

    const recordsBefore = store.search({}).items.map((item) => item.id);
    expect(await writeExport("e4", BUDGET)).toBe("full");
    expect(removedRequests).toEqual([]);
    expect(store.search({}).items.map((item) => item.id)).toEqual(recordsBefore);

    expect(await writeExport("e5", 128 * KiB)).toBe("ok");
    while (removedRequests.length === 0) {
      expect((await store.insertFlow(makeFlow(recording.id, index, FLOW_BODY))).ok).toBe(true);
      index += 1;
    }
    expect(exportsAtFirstRemoval).toEqual([0]);
    expect(measureDataDir(dataDir).total).toBeLessThanOrEqual(BUDGET);

    // Past the file cap, the oldest exports go whatever their size.
    await using roomy = await openTempStore({ maxDiskBytes: BUDGET });
    const capped = Array.from(
      { length: STORE_LIMITS.maxExportFiles + 1 },
      (_, offset) => `c${1000 + offset}`,
    );
    for (const id of capped) expect(await writeExport(id, 1, roomy.store)).toBe("ok");
    expect(exportIds(roomy.store)).toEqual(capped.slice(1).toReversed());
    expect(NodeFS.readdirSync(roomy.store.exportsDir).toSorted()).toEqual(
      capped
        .slice(1)
        .map((id) => `${id}.bin`)
        .toSorted(),
    );
  });
});

describe("records", () => {
  it("bodies over maxBodyBytes are truncated and flagged with declared length", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 64 * MiB, maxBodyBytes: 1 * MiB });
    const { store } = temp;
    const recording = await startRecording(store);
    const large = patternBytes(1.5 * MiB);
    const inserted = await store.insertFlow(
      makeFlow(recording.id, 0, large.byteLength, { body: { bytes: large } }),
    );
    const cutBySender = await store.insertFlow(
      makeFlow(recording.id, 1, 500, { body: { bytes: patternBytes(100), truncated: true } }),
    );
    const whole = await store.insertFlow(makeFlow(recording.id, 2, 100));
    if (!inserted.ok || !cutBySender.ok || !whole.ok) throw new Error("insert failed");

    expect(store.getRequest(inserted.id)?.requestBody).toEqual({
      capturedBytes: 1 * MiB,
      declaredBytes: 1.5 * MiB,
      truncated: true,
      contentType: "application/octet-stream",
    });
    expect(store.readBody(inserted.id, "request")?.bytes.equals(large.subarray(0, MiB))).toBe(true);
    expect(store.getRequest(cutBySender.id)?.requestBody).toMatchObject({
      capturedBytes: 100,
      declaredBytes: 500,
      truncated: true,
    });
    expect(store.getRequest(whole.id)?.requestBody).toMatchObject({
      capturedBytes: 100,
      declaredBytes: 100,
      truncated: false,
    });
  });

  it("headers keep duplicates and order through store round-trip", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 64 * MiB });
    const { store } = temp;
    const recording = await startRecording(store);
    const requestHeaders = [
      header("Host", "api.example.test"),
      header("Cookie", "a=1"),
      header("X-Trace", "first"),
      header("cookie", "b=2"),
      header("X-Binary", Buffer.from([0xff, 0x00, 0x80])),
      header("X-Trace", "second"),
    ];
    const responseHeaders = [
      header("Set-Cookie", "session=1; Path=/"),
      header("Content-Type", "text/plain"),
      header("Set-Cookie", "theme=dark"),
    ];
    const inserted = await store.insertFlow(
      makeFlow(recording.id, 0, 0, {
        headers: requestHeaders,
        response: {
          status: 302,
          reason: "Found",
          httpVersion: "HTTP/1.1",
          headers: responseHeaders,
        },
      }),
    );
    if (!inserted.ok) throw new Error("insert failed");
    const record = store.getRequest(inserted.id);
    const asText = (pairs: ReadonlyArray<readonly [Uint8Array, Uint8Array]>) =>
      pairs.map(([name, value]) => [
        Buffer.from(name).toString("hex"),
        Buffer.from(value).toString("hex"),
      ]);
    expect(asText(record?.requestHeaders ?? [])).toEqual(asText(requestHeaders));
    expect(asText(record?.response?.headers ?? [])).toEqual(asText(responseHeaders));
    expect(record?.response).toMatchObject({ status: 302, reason: "Found" });
  });

  it("paging a requests snapshot while 100 records arrive and 10 paged records update yields every record exactly once after merging by id and seq", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 256 * MiB });
    const { store } = temp;
    const recording = await startRecording(store);
    for (let index = 0; index < 250; index += 1) {
      await store.insertFlow(makeFlow(recording.id, index, 16));
    }

    const merged = new Map<number, RequestSummary>();
    const merge = (summary: RequestSummary) => {
      const held = merged.get(summary.id);
      if (held === undefined || held.seq < summary.seq) merged.set(summary.id, summary);
    };
    const batches: Array<StoreChange> = [];
    store.onChange((change) => batches.push(change));

    const snapshot = store.search({}, { limit: 50 });
    snapshot.items.forEach(merge);
    const pagedIds = snapshot.items.map((item) => item.id);
    const highWater = Math.max(...pagedIds);
    let cursor = snapshot.cursor;
    let inserted = 250;
    let updated = 0;
    while (cursor !== null) {
      for (let count = 0; count < 25 && inserted < 350; count += 1, inserted += 1) {
        await store.insertFlow(makeFlow(recording.id, inserted, 16));
      }
      // Update records on both sides of the cursor: ones already paged and ones still ahead.
      const oldest = Math.min(...pagedIds);
      for (const id of [oldest - 1, oldest + 1, pagedIds[0] as number]) {
        if (updated >= 10) break;
        await store.updateFlow(id, {
          response: { status: 200, httpVersion: "HTTP/1.1", headers: [header("x-update", "1")] },
        });
        updated += 1;
      }
      const page = store.search({}, { limit: 50, cursor });
      expect(page.revision).toBe(snapshot.revision);
      for (const item of page.items) {
        expect(item.id).toBeLessThanOrEqual(highWater);
        expect(pagedIds).not.toContain(item.id);
        pagedIds.push(item.id);
        merge(item);
      }
      cursor = page.cursor;
    }
    for (const change of batches) if (change.type === "request") merge(change.summary);

    expect(inserted).toBe(350);
    expect(updated).toBe(10);
    const current = store.search({}, { limit: 200 });
    const rest = store.search({}, { limit: 200, cursor: current.cursor as string });
    const truth = [...current.items, ...rest.items];
    expect(truth).toHaveLength(350);
    expect([...merged.keys()].toSorted((a, b) => a - b)).toEqual(
      truth.map((item) => item.id).toSorted((a, b) => a - b),
    );
    for (const item of truth) expect(merged.get(item.id)?.seq).toBe(item.seq);
  });

  it("search filters on indexed summary columns and cuts long paths", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 64 * MiB });
    const { store } = temp;
    const recording = await startRecording(store);
    await store.insertFlow(
      makeFlow(recording.id, 0, 0, { method: "get", path: "/login?next=%2F" }),
    );
    await store.insertFlow(
      makeFlow(recording.id, 1, 0, {
        host: "Auth.Example.Test",
        path: `/login/${"x".repeat(600)}`,
        response: { status: 401, httpVersion: "HTTP/1.1", headers: [] },
      }),
    );
    await store.insertFlow(makeFlow(recording.id, 2, 0, { path: "/other_100%" }));

    expect(store.search({ query: "login" }).items.map((item) => item.path.slice(0, 6))).toEqual([
      "/login",
      "/login",
    ]);
    expect(store.search({ method: "GET" }).items).toHaveLength(1);
    expect(store.search({ host: "auth.example.test", status: 401 }).items[0]).toMatchObject({
      pathTruncated: true,
      status: 401,
    });
    expect(store.search({ host: "auth.example.test" }).items[0]?.path).toHaveLength(
      STORE_LIMITS.summaryPathChars,
    );
    expect(store.search({ query: "_100%" }).items).toHaveLength(1);
    expect(store.search({ query: "o%r" }).items).toHaveLength(0);
    expect(() => store.search({}, { cursor: "c1.01.2.3" })).toThrow(InspectorRefusal);
  });
});

type SqliteValue = NodeSqlite.SQLOutputValue;

const schemaShape = (db: NodeSqlite.DatabaseSync) => {
  const objects = db
    .prepare(
      "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
  return objects.map((object) => {
    const name = String(object.name);
    const pragma = object.type === "table" ? "table_xinfo" : "index_xinfo";
    const columns = db
      .prepare(`PRAGMA ${pragma}(${JSON.stringify(name)})`)
      .all()
      .map((column) =>
        Object.fromEntries(
          Object.entries(column).filter(([key]) => key !== "cid" && key !== "seqno"),
        ),
      );
    return { type: object.type, name, table: object.tbl_name, columns };
  });
};

const readDatabase = <T>(dataDir: string, fn: (db: NodeSqlite.DatabaseSync) => T): T => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(dataDir, "inspector.sqlite"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

const userVersion = (db: NodeSqlite.DatabaseSync): SqliteValue =>
  db.prepare("PRAGMA user_version").get()?.user_version as SqliteValue;

describe("schema v2", () => {
  it("migrates a v1 database in place: one Default proxy owns the old captures as recordings, search still works, and the replay key secret, floor, and history survive", async () => {
    const dataDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "request-inspector-"));
    const secret = patternBytes(32, 9);
    readDatabase(dataDir, (db) => {
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(V1_SCHEMA);
      db.prepare(
        "INSERT INTO meta (id, store_id, key_secret, key_floor, seq) VALUES (1, 'store-v1', ?, 7, 40)",
      ).run(secret);
      db.exec(
        "INSERT INTO captures (id, seq, started_at, stopped_at, listen_host, listen_port) VALUES (3, 10, 1000, 2000, '127.0.0.1', 8080)",
      );
      const insertRequest = db.prepare(`
        INSERT INTO requests (id, seq, capture_id, started_at, flow_type, method, scheme, host, port,
          authority, path, http_version, request_headers, stored_bytes)
        VALUES (?, ?, ?, ?, 'http', 'GET', 'https', ?, 443, '', ?, 'HTTP/1.1', x'', 512)`);
      insertRequest.run(11, 20, 3, 1100, "api.example.test", "/v1/login");
      insertRequest.run(12, 21, 3, 1200, "api.example.test", "/v1/items");
      // A replay result whose capture was pruned away, which v1 could leave behind.
      insertRequest.run(13, 22, 4, 1300, "api.example.test", "/v1/replayed");
      db.exec(`
        INSERT INTO replays (replay_id, idempotency_key, key_seq, input_hash, source_request_id,
          dest_scheme, dest_host, dest_port, state, dispatched, seq, accepted_at)
        VALUES ('replay-1', 'rk1.store-v1.30.tag', 30, 'hash', 11, 'https', 'api.example.test',
          443, 'completed', 1, 30, 1500)`);
      db.exec("PRAGMA user_version = 1");
    });

    await using temp = await openTempStore(
      {
        maxDiskBytes: 64 * MiB,
        defaultProxyOptions: { ...DEFAULT_PROXY_OPTIONS, listenPort: 9090 },
      },
      dataDir,
    );
    const { store } = temp;

    expect(store.listProxies()).toEqual([
      expect.objectContaining({
        id: DEFAULT_PROXY_ID,
        name: "Default",
        options: { ...DEFAULT_PROXY_OPTIONS, listenPort: 9090 },
        hasUpstreamAuth: false,
      }),
    ]);
    expect(store.listRecordings().map(({ id, proxyId }) => ({ id, proxyId }))).toEqual([
      { id: 4, proxyId: DEFAULT_PROXY_ID },
      { id: 3, proxyId: DEFAULT_PROXY_ID },
    ]);
    expect(store.getRecording(3)).toMatchObject({ requestCount: 2, stoppedAt: 2000 });
    expect(store.search({ query: "login" }).items).toEqual([
      expect.objectContaining({ id: 11, recordingId: 3, proxyId: DEFAULT_PROXY_ID }),
    ]);
    expect(store.search({ proxyId: DEFAULT_PROXY_ID }).items.map((item) => item.id)).toEqual([
      13, 12, 11,
    ]);
    const meta = store.meta();
    expect(meta).toMatchObject({ storeId: "store-v1", keyFloor: 7 });
    expect(meta.keySecret.equals(secret)).toBe(true);
    expect(store.currentSeq()).toBeGreaterThan(40);
    expect(store.getReplayByKey("rk1.store-v1.30.tag")).toMatchObject({
      replayId: "replay-1",
      state: "completed",
      sourceRequestId: 11,
    });

    const fresh = await openTempStore({ maxDiskBytes: 64 * MiB });
    try {
      const migrated = readDatabase(dataDir, (db) => ({
        version: userVersion(db),
        shape: schemaShape(db),
      }));
      expect(migrated.version).toBe(3);
      expect(migrated.shape).toEqual(readDatabase(fresh.dataDir, schemaShape));
    } finally {
      await fresh[Symbol.asyncDispose]();
    }
  });

  it("migrates a v2 database to v3 keeping its links, after which a target can link a second proxy", async () => {
    const v2 = await openTempStore({ maxDiskBytes: 64 * MiB });
    const second = await v2.store.exclusive((lane) =>
      lane.createProxy({ name: "Second", createdAt: 1, options: DEFAULT_PROXY_OPTIONS }),
    );
    await v2.store.exclusive((lane) =>
      lane.link({ kind: "thread", targetId: "thread-1", proxyId: DEFAULT_PROXY_ID, linkedAt: 5 }),
    );
    await v2.store.exclusive((lane) =>
      lane.link({ kind: "project", targetId: "project-1", proxyId: second.id, linkedAt: 6 }),
    );
    v2.store.close();
    // v2 differed from v3 only in proxy_links' primary key.
    readDatabase(v2.dataDir, (db) => {
      db.exec(`
        ALTER TABLE proxy_links RENAME TO proxy_links_v3;
        CREATE TABLE proxy_links (
          kind TEXT NOT NULL CHECK (kind IN ('thread', 'project')),
          target_id TEXT NOT NULL,
          proxy_id INTEGER NOT NULL,
          linked_at INTEGER NOT NULL,
          PRIMARY KEY (kind, target_id)
        );
        INSERT INTO proxy_links SELECT kind, target_id, proxy_id, linked_at FROM proxy_links_v3;
        DROP TABLE proxy_links_v3;
        PRAGMA user_version = 2;`);
    });

    await using temp = await openTempStore({ maxDiskBytes: 64 * MiB }, v2.dataDir);
    const { store } = temp;
    expect(store.listProxies().map((proxy) => proxy.id)).toEqual([DEFAULT_PROXY_ID, second.id]);
    expect(store.listLinks()).toEqual([
      { kind: "project", targetId: "project-1", proxyId: second.id, linkedAt: 6 },
      { kind: "thread", targetId: "thread-1", proxyId: DEFAULT_PROXY_ID, linkedAt: 5 },
    ]);
    await store.exclusive((lane) =>
      lane.link({ kind: "thread", targetId: "thread-1", proxyId: second.id, linkedAt: 7 }),
    );
    expect(store.listLinks()).toHaveLength(3);

    await using fresh = await openTempStore({ maxDiskBytes: 64 * MiB });
    expect(readDatabase(temp.dataDir, (db) => [userVersion(db), schemaShape(db)])).toEqual([
      3,
      readDatabase(fresh.dataDir, schemaShape),
    ]);
  });

  it("refuses to open a database with a newer schema version and leaves it untouched", async () => {
    const dataDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "request-inspector-"));
    try {
      readDatabase(dataDir, (db) => {
        db.exec("CREATE TABLE future (id INTEGER PRIMARY KEY)");
        db.exec("PRAGMA user_version = 4");
      });
      await expect(openTempStore({ maxDiskBytes: 64 * MiB }, dataDir)).rejects.toThrow(
        "schema version 4",
      );
      expect(readDatabase(dataDir, (db) => [userVersion(db), schemaShape(db).length])).toEqual([
        4, 1,
      ]);
    } finally {
      await NodeFSP.rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("proxies", () => {
  it("a target links several proxies; relinking refreshes linkedAt and unlink removes one or all", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 64 * MiB });
    const { store } = temp;
    const second = await store.exclusive((lane) =>
      lane.createProxy({ name: "Second", createdAt: 1, options: DEFAULT_PROXY_OPTIONS }),
    );
    const target = { kind: "thread" as const, targetId: "thread-1" };
    const removed: Array<unknown> = [];
    store.onChange((change) => {
      if (change.type === "link-removed") removed.push(change);
    });

    await store.exclusive((lane) =>
      lane.link({ ...target, proxyId: DEFAULT_PROXY_ID, linkedAt: 1 }),
    );
    await store.exclusive((lane) => lane.link({ ...target, proxyId: second.id, linkedAt: 2 }));
    await store.exclusive((lane) =>
      lane.link({ ...target, proxyId: DEFAULT_PROXY_ID, linkedAt: 3 }),
    );

    expect(store.listLinks()).toEqual([
      { ...target, proxyId: second.id, linkedAt: 2 },
      { ...target, proxyId: DEFAULT_PROXY_ID, linkedAt: 3 },
    ]);
    expect(store.listLinks(DEFAULT_PROXY_ID)).toEqual([
      { ...target, proxyId: DEFAULT_PROXY_ID, linkedAt: 3 },
    ]);
    expect(
      await store.exclusive((lane) => lane.unlink("thread", "thread-1", DEFAULT_PROXY_ID)),
    ).toEqual([DEFAULT_PROXY_ID]);
    expect(store.listLinks()).toEqual([{ ...target, proxyId: second.id, linkedAt: 2 }]);
    await store.exclusive((lane) =>
      lane.link({ ...target, proxyId: DEFAULT_PROXY_ID, linkedAt: 4 }),
    );
    expect(await store.exclusive((lane) => lane.unlink("thread", "thread-1"))).toEqual([
      DEFAULT_PROXY_ID,
      second.id,
    ]);
    expect(store.listLinks()).toEqual([]);
    expect(await store.exclusive((lane) => lane.unlink("thread", "thread-1"))).toEqual([]);
    expect(removed).toEqual([
      { type: "link-removed", ...target, proxyId: DEFAULT_PROXY_ID },
      { type: "link-removed", ...target, proxyId: DEFAULT_PROXY_ID },
      { type: "link-removed", ...target, proxyId: second.id },
    ]);
  });

  it("search by proxyId excludes flows recorded by other proxies", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 64 * MiB });
    const { store } = temp;
    const other = await store.exclusive((lane) =>
      lane.createProxy({ name: "Other", createdAt: 1, options: DEFAULT_PROXY_OPTIONS }),
    );
    const mine = await startRecording(store);
    const theirs = await startRecording(store, 1_700_000_000_000, other.id);
    await store.insertFlow(makeFlow(mine.id, 0, 0));
    await store.insertFlow(makeFlow(theirs.id, 1, 0));
    await store.insertFlow(makeFlow(mine.id, 2, 0));

    const ids = (proxyId: number) =>
      store.search({ proxyId }).items.map((item) => [item.proxyId, item.recordingId]);
    expect(ids(DEFAULT_PROXY_ID)).toEqual([
      [DEFAULT_PROXY_ID, mine.id],
      [DEFAULT_PROXY_ID, mine.id],
    ]);
    expect(ids(other.id)).toEqual([[other.id, theirs.id]]);
  });

  it("a tunnel row stores byte counts and no headers or bodies", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 64 * MiB });
    const { store, dataDir } = temp;
    const recording = await startRecording(store);
    const result = await store.insertTunnel({
      recordingId: recording.id,
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_000_500,
      host: "Pinned.Example.Test",
      port: 443,
      sni: "pinned.example.test",
      clientAddr: "127.0.0.1:50000",
      bytesUp: 517,
      bytesDown: 4096,
    });
    if (!result.ok) throw new Error("insert failed");

    expect(store.getRequest(result.id)).toEqual({
      summary: expect.objectContaining({
        flowType: "tunnel",
        method: "CONNECT",
        host: "pinned.example.test",
        sni: "pinned.example.test",
        clientAddr: "127.0.0.1:50000",
        endedAt: 1_700_000_000_500,
        bytesUp: 517,
        bytesDown: 4096,
        requestBytes: 0,
      }),
      authority: "Pinned.Example.Test:443",
      path: "",
      httpVersion: "",
      requestHeaders: [],
    });
    expect(store.search({ flowType: "tunnel" }).items.map((item) => item.id)).toEqual([result.id]);
    const bodies = readDatabase(dataDir, (db) =>
      db.prepare("SELECT count(*) AS count FROM bodies").get(),
    );
    expect(bodies?.count).toBe(0);
  });
});
