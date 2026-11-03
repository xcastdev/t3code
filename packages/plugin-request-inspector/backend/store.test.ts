// @effect-diagnostics nodeBuiltinImport:off - Drives the builtin-only inspector store on real node:sqlite.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { makeDraftStore } from "./bodies.ts";
import { STORAGE_FULL_DETAIL } from "./refusals.ts";
import {
  InspectorRefusal,
  type RequestSummary,
  STORE_LIMITS,
  type StorageStep,
  type StoreChange,
} from "./store.ts";
import {
  header,
  KiB,
  makeFlow,
  measureDataDir,
  MiB,
  openTempStore,
  patternBytes,
  startCapture,
} from "./store.testkit.ts";

const BUDGET = 4 * MiB;
const FLOW_BODY = 256 * KiB;
// One flow's stored size plus SQLite page and overflow overhead (about 64 KiB in the plan's probe).
const ONE_FLOW = FLOW_BODY + 64 * KiB;
const VACUUM_STEP = 1 * MiB;

describe("storage budget", () => {
  it("under storage pressure, inserting flows prunes the oldest captures and then the running capture's oldest records, and measured usage stays within the stated bound", async () => {
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
    const removedCaptureOrder: Array<number> = [];
    const removedIds: Array<number> = [];
    store.onChange((change) => {
      if (change.type === "request-removed") {
        removedCaptureOrder.push(change.captureId);
        removedIds.push(change.id);
      }
    });

    const first = await startCapture(store);
    const firstIds: Array<number> = [];
    for (let index = 0; index < 100; index += 1) {
      const result = await store.insertFlow(makeFlow(first.id, index, FLOW_BODY));
      expect(result.ok).toBe(true);
      if (result.ok) firstIds.push(result.id);
    }
    await store.exclusive((lane) => lane.stopCapture(first.id, 1_700_000_100_000));
    const second = await startCapture(store, 1_700_000_200_000);
    for (let index = 100; index < 200; index += 1) {
      const result = await store.insertFlow(makeFlow(second.id, index, FLOW_BODY));
      expect(result.ok).toBe(true);
    }

    expect(violations).toEqual([]);
    expect(databaseShrank).toBe(true);
    expect(maintenanceErrors).toBe(0);
    expect(logs.filter((message) => message.includes("locked"))).toEqual([]);
    expect(measureDataDir(dataDir).total).toBeLessThanOrEqual(BUDGET);

    // Every record of the stopped capture went before any record of the running one, oldest first.
    const firstSecondRemoval = removedCaptureOrder.indexOf(second.id);
    expect(firstSecondRemoval).toBeGreaterThan(0);
    expect(removedCaptureOrder.slice(0, firstSecondRemoval).every((id) => id === first.id)).toBe(
      true,
    );
    expect(removedIds.slice(0, firstSecondRemoval)).toEqual(firstIds);
    expect(removedIds.slice(firstSecondRemoval)).toEqual(
      removedIds.slice(firstSecondRemoval).toSorted((a, b) => a - b),
    );
    expect(store.getCapture(first.id)).toBeUndefined();
    expect(store.captureStatus()).toMatchObject({ droppedFlows: 0, storageBlocked: false });
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
    const capture = await startCapture(store);
    for (let index = 0; index < 30; index += 1) {
      await store.insertFlow(makeFlow(capture.id, index, FLOW_BODY));
    }
    expect(measureDataDir(dataDir).total).toBeLessThanOrEqual(BUDGET);

    const reader = new NodeSqlite.DatabaseSync(NodePath.join(dataDir, "inspector.sqlite"));
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) AS count FROM requests").get();

      expect(await store.insertFlow(makeFlow(capture.id, 30, FLOW_BODY))).toEqual({
        ok: false,
        reason: "storage-full",
      });
      expect(store.captureStatus().storageBlocked).toBe(true);
      const blockedWal = measureDataDir(dataDir).wal;
      for (let index = 31; index < 36; index += 1) {
        expect((await store.insertFlow(makeFlow(capture.id, index, FLOW_BODY))).ok).toBe(false);
        expect(measureDataDir(dataDir).wal).toBe(blockedWal);
      }
      expect(store.captureStatus()).toMatchObject({ droppedFlows: 6, storageBlocked: true });
      reader.exec("COMMIT");
    } finally {
      reader.close();
    }

    const databaseBefore = measureDataDir(dataDir).database;
    steps.length = 0;
    const accepted = await store.insertFlow(makeFlow(capture.id, 36, FLOW_BODY));
    expect(accepted.ok).toBe(true);
    expect(store.captureStatus().storageBlocked).toBe(false);
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
    const capture = await startCapture(store);
    const sources: Array<number> = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await store.insertFlow(makeFlow(capture.id, index, FLOW_BODY));
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

    expect(await store.insertFlow(makeFlow(capture.id, 10, FLOW_BODY))).toEqual({
      ok: false,
      reason: "storage-full",
    });
    expect(store.captureStatus().droppedFlows).toBe(1);
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
});

describe("records", () => {
  it("bodies over maxBodyBytes are truncated and flagged with declared length", async () => {
    await using temp = await openTempStore({ maxDiskBytes: 64 * MiB, maxBodyBytes: 1 * MiB });
    const { store } = temp;
    const capture = await startCapture(store);
    const large = patternBytes(1.5 * MiB);
    const inserted = await store.insertFlow(
      makeFlow(capture.id, 0, large.byteLength, { body: { bytes: large } }),
    );
    const cutBySender = await store.insertFlow(
      makeFlow(capture.id, 1, 500, { body: { bytes: patternBytes(100), truncated: true } }),
    );
    const whole = await store.insertFlow(makeFlow(capture.id, 2, 100));
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
    const capture = await startCapture(store);
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
      makeFlow(capture.id, 0, 0, {
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
    const capture = await startCapture(store);
    for (let index = 0; index < 250; index += 1) {
      await store.insertFlow(makeFlow(capture.id, index, 16));
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
        await store.insertFlow(makeFlow(capture.id, inserted, 16));
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
    const capture = await startCapture(store);
    await store.insertFlow(makeFlow(capture.id, 0, 0, { method: "get", path: "/login?next=%2F" }));
    await store.insertFlow(
      makeFlow(capture.id, 1, 0, {
        host: "Auth.Example.Test",
        path: `/login/${"x".repeat(600)}`,
        response: { status: 401, httpVersion: "HTTP/1.1", headers: [] },
      }),
    );
    await store.insertFlow(makeFlow(capture.id, 2, 0, { path: "/other_100%" }));

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
