// @effect-diagnostics nodeBuiltinImport:off - Drives the builtin-only inspector replay service on real node:sqlite.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import {
  DRAFT_MISSING_DETAIL,
  incompleteBodyDetail,
  REPLAY_DETAILS,
  STORAGE_FULL_DETAIL,
} from "./refusals.ts";
import {
  makeReplayService,
  REPLAY_LIMITS,
  type ReplayMessage,
  type ReplayResult,
  type ReplayService,
  replayStatusItem,
  type ReplayStatusItem,
} from "./replay.ts";
import {
  makeFakeChannel,
  makeFakeCarriers,
  makeFakeTimer,
  openReplayHarness,
  type ReplayHarness,
} from "./replay.testkit.ts";
import {
  type InspectorStore,
  type StorageStep,
  type StoreLane,
  type StoreWriteTx,
} from "./store.ts";
import {
  header,
  KiB,
  makeFlow,
  measureDataDir,
  MiB,
  patternBytes,
  startCapture,
} from "./store.testkit.ts";

const settled = (replay: ReplayService, replayId: string) =>
  replay.get(replayId, { waitMs: 20_000 });

const responseResult = (replayId: string, bodyBytes = 16): ReplayResult => {
  const { captureId: _captureId, ...flow } = makeFlow(0, 0, 8, {
    response: {
      status: 200,
      httpVersion: "HTTP/1.1",
      headers: [header("content-length", String(bodyBytes))],
      body: { bytes: patternBytes(bodyBytes, 7) },
    },
  });
  return { replayId, flow };
};

const replayFiles = (harness: { readonly store: InspectorStore }) =>
  NodeFS.existsSync(harness.store.replayDir) ? NodeFS.readdirSync(harness.store.replayDir) : [];

const countReplayRows = (dataDir: string) => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(dataDir, "inspector.sqlite"));
  try {
    return Number(db.prepare("SELECT count(*) AS count FROM replays").get()?.count);
  } finally {
    db.close();
  }
};

/** A harness with a live capture channel and one source request. */
const withCapture = async (harness: ReplayHarness, onSend?: (message: ReplayMessage) => void) => {
  const fake = makeFakeChannel(onSend);
  harness.carriers.setCapture(fake.channel);
  const requestId = await harness.source();
  return { fake, requestId };
};

const acceptFresh = async (harness: ReplayHarness, requestId: number) => {
  const { idempotencyKey } = harness.replay.preview({ requestId });
  const accepted = await harness.replay.accept(
    { requestId, idempotencyKey },
    new AbortController().signal,
  );
  return { idempotencyKey, ...accepted };
};

const flipHex = (char: string) => (char === "0" ? "1" : "0");

describe("replay identity and outcome", () => {
  it("replay_request returns pending with a replayId before the upstream answers", async () => {
    await using harness = await openReplayHarness();
    const { fake, requestId } = await withCapture(harness);

    const accepted = await acceptFresh(harness, requestId);
    expect(accepted.state).toBe("pending");
    expect(accepted.replayId).toMatch(/^[0-9a-f]{16}$/);
    expect(accepted.destination).toEqual({ scheme: "https", host: "api.example.test", port: 443 });

    const message = await fake.nextMessage();
    expect(message.replayId).toBe(accepted.replayId);
    expect(await harness.replay.get(accepted.replayId)).toMatchObject({
      state: "pending",
      dispatched: true,
    });
  });

  it("the same idempotencyKey and input returns the existing replay and dispatches once", async () => {
    await using harness = await openReplayHarness();
    const { fake, requestId } = await withCapture(harness);
    const first = await acceptFresh(harness, requestId);
    await fake.nextMessage();

    const retry = await harness.replay.accept(
      { requestId, idempotencyKey: first.idempotencyKey },
      new AbortController().signal,
    );
    expect(retry.replayId).toBe(first.replayId);
    await harness.replay.onResult(responseResult(first.replayId));
    const after = await harness.replay.accept(
      { requestId, idempotencyKey: first.idempotencyKey },
      new AbortController().signal,
    );
    expect(after).toMatchObject({ replayId: first.replayId, state: "completed" });
    expect(fake.sent).toHaveLength(1);
    expect(countReplayRows(harness.dataDir)).toBe(1);
  });

  it("the same key with different input is refused", async () => {
    await using harness = await openReplayHarness();
    const { fake, requestId } = await withCapture(harness);
    const first = await acceptFresh(harness, requestId);
    await fake.nextMessage();

    await expect(
      harness.replay.accept(
        { requestId, idempotencyKey: first.idempotencyKey, edits: { method: "PUT" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow(REPLAY_DETAILS.conflict);
    expect(fake.sent).toHaveLength(1);
    expect(countReplayRows(harness.dataDir)).toBe(1);
  });

  it("an abort before acceptance records nothing; an abort after acceptance does not stop dispatch", async () => {
    await using harness = await openReplayHarness();
    const { fake, requestId } = await withCapture(harness);

    const aborted = new AbortController();
    aborted.abort();
    const { idempotencyKey } = harness.replay.preview({ requestId });
    await expect(
      harness.replay.accept({ requestId, idempotencyKey }, aborted.signal),
    ).rejects.toThrow(REPLAY_DETAILS.aborted);
    expect(countReplayRows(harness.dataDir)).toBe(0);
    expect(replayFiles(harness)).toEqual([]);

    const later = new AbortController();
    const accepted = await harness.replay.accept({ requestId, idempotencyKey }, later.signal);
    later.abort();
    expect((await fake.nextMessage()).replayId).toBe(accepted.replayId);
  });

  it("no result 30 s after dispatch marks unknown and stops the transient mitmdump by its captured PID", async () => {
    await using harness = await openReplayHarness();
    const requestId = await harness.source();
    const accepted = await acceptFresh(harness, requestId);
    const transient = await harness.carriers.nextTransient();
    const fake = makeFakeChannel();
    transient.ready.resolve(fake.channel);
    await fake.nextMessage();

    await harness.timer.scheduled(30_000);
    expect(harness.timer.fire(30_000)).toBe(1);
    expect(await settled(harness.replay, accepted.replayId)).toMatchObject({
      state: "unknown",
      dispatched: true,
      detail: REPLAY_DETAILS.noResponse,
    });
    expect(transient.stops).toBe(1);
    expect(replayFiles(harness)).toEqual([]);
  });

  it("a transient mitmdump that never connects marks failed with dispatched false", async () => {
    await using harness = await openReplayHarness();
    const requestId = await harness.source();
    const accepted = await acceptFresh(harness, requestId);
    const transient = await harness.carriers.nextTransient();

    await harness.timer.scheduled(10_000);
    expect(harness.timer.fire(10_000)).toBe(1);
    expect(await settled(harness.replay, accepted.replayId)).toMatchObject({
      state: "failed",
      dispatched: false,
      detail: REPLAY_DETAILS.notStarted,
    });
    expect(transient.stops).toBe(1);
  });

  it("worker start marks dispatched pending replays unknown and undispatched ones failed", async () => {
    await using harness = await openReplayHarness();
    const { fake, requestId } = await withCapture(harness);
    const dispatched = await acceptFresh(harness, requestId);
    await fake.nextMessage();
    harness.carriers.setCapture(undefined);
    const waiting = await acceptFresh(harness, requestId);
    await harness.carriers.nextTransient();
    NodeFS.writeFileSync(NodePath.join(harness.store.replayDir, "orphan.bin"), "x");
    expect(replayFiles(harness)).toHaveLength(3);

    const restarted = harness.reopen();
    await restarted.replay.recover();

    expect(await restarted.replay.get(dispatched.replayId)).toMatchObject({
      state: "unknown",
      dispatched: true,
      detail: REPLAY_DETAILS.interrupted,
    });
    expect(await restarted.replay.get(waiting.replayId)).toMatchObject({
      state: "failed",
      dispatched: false,
      detail: REPLAY_DETAILS.stopped,
    });
    expect(replayFiles(restarted)).toEqual([]);
  });

  it("the replay message reaches the control connection only after dispatched:true is committed", async () => {
    await using harness = await openReplayHarness();
    const observed: Array<number> = [];
    const reader = new NodeSqlite.DatabaseSync(NodePath.join(harness.dataDir, "inspector.sqlite"));
    try {
      const { fake, requestId } = await withCapture(harness, (message) => {
        observed.push(
          Number(
            reader
              .prepare("SELECT dispatched FROM replays WHERE replay_id = ?")
              .get(message.replayId)?.dispatched,
          ),
        );
      });
      await acceptFresh(harness, requestId);
      await fake.nextMessage();
    } finally {
      reader.close();
    }
    expect(observed).toEqual([1]);
  });

  it.each(["restart", "close", "write-fails"] as const)(
    "an interruption after the replay message is written and before any result is unknown, never not-sent (%s)",
    async (interruption) => {
      await using harness = await openReplayHarness();
      const { fake, requestId } = await withCapture(harness);
      if (interruption === "write-fails") fake.failNextSend();
      const accepted = await acceptFresh(harness, requestId);

      let result;
      if (interruption === "restart") {
        await fake.nextMessage();
        const restarted = harness.reopen();
        await restarted.replay.recover();
        result = await restarted.replay.get(accepted.replayId);
      } else {
        if (interruption === "close") {
          await fake.nextMessage();
          fake.close();
        }
        result = await settled(harness.replay, accepted.replayId);
      }
      expect(result).toMatchObject({
        state: "unknown",
        dispatched: true,
        detail: REPLAY_DETAILS.interrupted,
      });
    },
  );

  it("a failed intent commit writes nothing to the control connection and settles failed with dispatched false, retrying a settle that fails", async () => {
    await using harness = await openReplayHarness();
    let settleFailures = 1;
    const failingTx = (tx: StoreWriteTx): StoreWriteTx => ({
      ...tx,
      updateReplay: (replayId, patch) => {
        if (patch.dispatched === true) throw new Error("disk I/O error");
        if (patch.state === "failed" && settleFailures > 0) {
          settleFailures -= 1;
          throw new Error("database is locked");
        }
        return tx.updateReplay(replayId, patch);
      },
    });
    const failingLane = (lane: StoreLane): StoreLane => ({
      ...lane,
      write: (fn) => lane.write((tx) => fn(failingTx(tx))),
    });
    const store: InspectorStore = {
      ...harness.store,
      exclusive: (fn) => harness.store.exclusive((lane) => fn(failingLane(lane))),
    };
    const carriers = makeFakeCarriers();
    const fake = makeFakeChannel();
    carriers.setCapture(fake.channel);
    const timer = makeFakeTimer();
    const replay = makeReplayService({
      store,
      drafts: harness.drafts,
      carriers: carriers.carriers,
      timer: timer.timer,
    });
    const requestId = await harness.source();
    const { idempotencyKey } = replay.preview({ requestId });
    const accepted = await replay.accept(
      { requestId, idempotencyKey },
      new AbortController().signal,
    );

    await timer.scheduled(REPLAY_LIMITS.settleRetryMs);
    expect(harness.store.countPendingReplays()).toBe(1);
    expect(timer.fire(REPLAY_LIMITS.settleRetryMs)).toBe(1);
    expect(await settled(replay, accepted.replayId)).toMatchObject({
      state: "failed",
      dispatched: false,
      detail: REPLAY_DETAILS.intentFailed,
    });
    expect(fake.sent).toEqual([]);
  });

  it("history keeps every pending row and the newest settled rows; the settle that exceeds maxReplayHistory deletes the oldest settled row and raises keyFloor above its keySeq in the same transaction", async () => {
    await using harness = await openReplayHarness({ replay: { maxReplayHistory: 3 } });
    const { fake, requestId } = await withCapture(harness);
    const pending = await acceptFresh(harness, requestId);
    await fake.nextMessage();

    const settledIds: Array<string> = [];
    for (let index = 0; index < 3; index += 1) {
      const accepted = await acceptFresh(harness, requestId);
      await fake.nextMessage();
      await harness.replay.onResult(responseResult(accepted.replayId));
      settledIds.push(accepted.replayId);
    }
    const oldest = harness.store.getReplay(settledIds[0] as string);
    if (oldest === undefined) throw new Error("missing row");
    expect(harness.store.meta().keyFloor).toBe(0);

    const fourth = await acceptFresh(harness, requestId);
    await fake.nextMessage();
    const atCommit: Array<{ readonly oldestKept: boolean; readonly keyFloor: number }> = [];
    harness.store.onChange((change) => {
      if (change.type === "replay" && change.replay.replayId === fourth.replayId) {
        atCommit.push({
          oldestKept: harness.store.getReplay(oldest.replayId) !== undefined,
          keyFloor: harness.store.meta().keyFloor,
        });
      }
    });
    await harness.replay.onResult(responseResult(fourth.replayId));

    expect(atCommit).toEqual([{ oldestKept: false, keyFloor: oldest.keySeq + 1 }]);
    expect(harness.store.getReplay(pending.replayId)?.state).toBe("pending");
    expect(countReplayRows(harness.dataDir)).toBe(4);
  });

  it("a same-key retry after its replay was pruned is refused as expired and writes nothing to the control connection", async () => {
    await using harness = await openReplayHarness({ replay: { maxReplayHistory: 1 } });
    const { fake, requestId } = await withCapture(harness);
    const pruneKey = harness.replay.preview({ requestId }).idempotencyKey;
    const keptKey = harness.replay.preview({ requestId }).idempotencyKey;
    const unusedKey = harness.replay.preview({ requestId }).idempotencyKey;
    const signal = new AbortController().signal;

    const pruned = await harness.replay.accept({ requestId, idempotencyKey: pruneKey }, signal);
    await fake.nextMessage();
    const kept = await harness.replay.accept({ requestId, idempotencyKey: keptKey }, signal);
    await fake.nextMessage();
    await harness.replay.onResult(responseResult(pruned.replayId));
    await harness.replay.onResult(responseResult(kept.replayId));
    expect(harness.store.getReplay(pruned.replayId)).toBeUndefined();
    const keptRow = harness.store.getReplay(kept.replayId);
    expect(keptRow?.keySeq).toBeLessThan(harness.store.meta().keyFloor);
    const sent = fake.sent.length;

    await expect(
      harness.replay.accept({ requestId, idempotencyKey: pruneKey }, signal),
    ).rejects.toThrow(REPLAY_DETAILS.expired);
    await expect(
      harness.replay.accept({ requestId, idempotencyKey: unusedKey }, signal),
    ).rejects.toThrow(REPLAY_DETAILS.expired);
    expect(
      await harness.replay.accept({ requestId, idempotencyKey: keptKey }, signal),
    ).toMatchObject({ replayId: kept.replayId, state: "completed" });
    await expect(harness.replay.get(pruned.replayId)).rejects.toThrow(REPLAY_DETAILS.replayMissing);
    expect(fake.sent).toHaveLength(sent);
    expect(countReplayRows(harness.dataDir)).toBe(1);
  });

  it("a key minted before a restart is accepted after reopening the same dataDir; a key from a deleted and recreated dataDir, a key whose seq is above the high-water mark, and a malformed key are refused as not issued and send nothing", async () => {
    await using harness = await openReplayHarness();
    const requestId = await harness.source();
    const minted = harness.replay.preview({ requestId }).idempotencyKey;
    const restarted = harness.reopen();
    const fake = makeFakeChannel();
    restarted.carriers.setCapture(fake.channel);
    const signal = new AbortController().signal;
    expect(
      await restarted.replay.accept({ requestId, idempotencyKey: minted }, signal),
    ).toMatchObject({ state: "pending" });
    await fake.nextMessage();

    const recreatedDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inspector-gone-"));
    let foreignKey: string;
    {
      await using gone = await openReplayHarness({ dataDir: recreatedDir });
      foreignKey = gone.replay.preview({ requestId: await gone.source() }).idempotencyKey;
    }
    await using recreated = await openReplayHarness({ dataDir: recreatedDir });
    const recreatedFake = makeFakeChannel();
    recreated.carriers.setCapture(recreatedFake.channel);
    const recreatedSource = await recreated.source();
    expect(recreatedSource).toBe(requestId);
    await expect(
      recreated.replay.accept({ requestId: recreatedSource, idempotencyKey: foreignKey }, signal),
    ).rejects.toThrow(REPLAY_DETAILS.notIssued);

    const meta = harness.store.meta();
    const aheadPrefix = `rk1.${meta.storeId}.${harness.store.currentSeq() + 5}.${"a".repeat(16)}`;
    const ahead = `${aheadPrefix}.${NodeCrypto.createHmac("sha256", meta.keySecret).update(aheadPrefix).digest("hex").slice(0, 32)}`;
    for (const key of [ahead, "not-a-key"]) {
      await expect(
        restarted.replay.accept({ requestId, idempotencyKey: key }, signal),
      ).rejects.toThrow(REPLAY_DETAILS.notIssued);
    }
    expect(fake.sent).toHaveLength(1);
    expect(recreatedFake.sent).toEqual([]);
    expect(countReplayRows(harness.dataDir)).toBe(1);
    expect(countReplayRows(recreatedDir)).toBe(0);
  });

  it("an issued key altered in one character is refused as not issued before dispatch", async () => {
    await using harness = await openReplayHarness();
    await using other = await openReplayHarness();
    const { fake, requestId } = await withCapture(harness);
    const key = harness.replay.preview({ requestId }).idempotencyKey;
    await harness.source();
    const [prefix, storeId, seq, nonce, tag] = key.split(".") as [
      string,
      string,
      string,
      string,
      string,
    ];
    expect(Number(seq)).toBeLessThan(harness.store.currentSeq());
    const alterations = {
      storeId: [prefix, `${flipHex(storeId[0] as string)}${storeId.slice(1)}`, seq, nonce, tag],
      seq: [prefix, storeId, String(Number(seq) + 1), nonce, tag],
      nonce: [prefix, storeId, seq, `${flipHex(nonce[0] as string)}${nonce.slice(1)}`, tag],
      tag: [prefix, storeId, seq, nonce, `${flipHex(tag[0] as string)}${tag.slice(1)}`],
      uppercase: [prefix, storeId, seq, nonce, tag.toUpperCase()],
      leadingZero: [prefix, storeId, `0${seq}`, nonce, tag],
    };
    expect(tag.toUpperCase()).not.toBe(tag);
    const altered = [
      ...Object.values(alterations).map((parts) => parts.join(".")),
      other.replay.preview({ requestId: await other.source() }).idempotencyKey,
    ];
    const signal = new AbortController().signal;

    for (const candidate of altered) {
      await expect(
        harness.replay.accept({ requestId, idempotencyKey: candidate }, signal),
      ).rejects.toThrow(REPLAY_DETAILS.notIssued);
    }
    expect(countReplayRows(harness.dataDir)).toBe(0);
    expect(replayFiles(harness)).toEqual([]);
    expect(fake.sent).toEqual([]);

    const accepted = await harness.replay.accept({ requestId, idempotencyKey: key }, signal);
    await fake.nextMessage();
    for (const candidate of altered) {
      await expect(
        harness.replay.accept({ requestId, idempotencyKey: candidate }, signal),
      ).rejects.toThrow(REPLAY_DETAILS.notIssued);
    }
    expect(countReplayRows(harness.dataDir)).toBe(1);
    expect(fake.sent.map((message) => message.replayId)).toEqual([accepted.replayId]);
  });

  it("under storage pressure, replay_request prunes and checkpoints outside its accept transaction and then accepts", async () => {
    const steps: Array<{ readonly step: StorageStep; readonly database: number }> = [];
    const logs: Array<string> = [];
    let dataDir = "";
    await using harness = await openReplayHarness({
      store: {
        maxDiskBytes: 4 * MiB,
        onStorageStep: (step) => steps.push({ step, database: measureDataDir(dataDir).database }),
        log: (message) => logs.push(message),
      },
    });
    dataDir = harness.dataDir;
    const fake = makeFakeChannel();
    harness.carriers.setCapture(fake.channel);
    const capture = await startCapture(harness.store);
    const ids: Array<number> = [];
    for (let index = 0; index < 16; index += 1) {
      const result = await harness.store.insertFlow(makeFlow(capture.id, index, 256 * KiB));
      if (result.ok) ids.push(result.id);
    }
    await harness.store.exclusive((lane) => lane.stopCapture(capture.id, 1));
    const survivors = harness.store.search({}, { limit: 200 }).items.map((item) => item.id);
    const source = Math.min(...survivors);
    const removed: Array<number> = [];
    harness.store.onChange((change) => {
      if (change.type === "request-removed") removed.push(change.id);
    });
    // Fold the WAL into the main file first, so the size compared below is the settled one.
    const folder = new NodeSqlite.DatabaseSync(NodePath.join(dataDir, "inspector.sqlite"));
    folder.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    folder.close();
    const databaseBefore = measureDataDir(dataDir).database;
    steps.length = 0;

    const accepted = await acceptFresh(harness, source);
    expect(accepted.state).toBe("pending");
    expect(harness.store.getRequest(source)).toBeDefined();
    expect(removed.length).toBeGreaterThan(0);
    expect(removed).not.toContain(source);
    expect(steps.some(({ step }) => step.kind === "vacuum")).toBe(true);
    expect(measureDataDir(dataDir).database).toBeLessThan(databaseBefore);
    expect(logs.filter((message) => message.includes("locked"))).toEqual([]);
    expect(steps.some(({ step }) => step.kind === "maintenance-error")).toBe(false);
    expect(replayFiles(harness)).toEqual([`${accepted.replayId}.bin`]);
    expect((await fake.nextMessage()).replayId).toBe(accepted.replayId);

    const nextSource = harness.store
      .search({}, { limit: 200 })
      .items.map((item) => item.id)
      .find((id) => id !== source) as number;
    const blockedKey = harness.replay.preview({ requestId: nextSource }).idempotencyKey;
    const reader = new NodeSqlite.DatabaseSync(NodePath.join(dataDir, "inspector.sqlite"));
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) AS count FROM requests").get();
      await expect(
        harness.replay.accept(
          { requestId: nextSource, idempotencyKey: blockedKey },
          new AbortController().signal,
        ),
      ).rejects.toThrow(STORAGE_FULL_DETAIL);
      expect(harness.store.captureStatus().storageBlocked).toBe(true);
      expect(countReplayRows(dataDir)).toBe(1);
      expect(replayFiles(harness)).toEqual([`${accepted.replayId}.bin`]);
      expect(
        await harness.replay.accept(
          { requestId: source, idempotencyKey: accepted.idempotencyKey },
          new AbortController().signal,
        ),
      ).toMatchObject({ replayId: accepted.replayId, state: "pending" });
      reader.exec("COMMIT");
    } finally {
      reader.close();
    }
    expect(fake.sent).toHaveLength(1);
  });

  it("a 21st concurrent replay is refused with nothing recorded, and a same-key retry of a pending replay is still returned at the cap", async () => {
    await using harness = await openReplayHarness();
    const { fake, requestId } = await withCapture(harness);
    const accepted = [];
    for (let index = 0; index < 20; index += 1) {
      accepted.push(await acceptFresh(harness, requestId));
    }
    const { idempotencyKey } = harness.replay.preview({ requestId });
    await expect(
      harness.replay.accept({ requestId, idempotencyKey }, new AbortController().signal),
    ).rejects.toThrow(REPLAY_DETAILS.pendingCap);
    expect(countReplayRows(harness.dataDir)).toBe(20);
    expect(replayFiles(harness)).toHaveLength(20);

    const first = accepted[0];
    if (first === undefined) throw new Error("no replay");
    expect(
      await harness.replay.accept(
        { requestId, idempotencyKey: first.idempotencyKey },
        new AbortController().signal,
      ),
    ).toMatchObject({ replayId: first.replayId, state: "pending" });
    expect(fake.sent.length).toBeLessThanOrEqual(20);
  });

  it("get_replay with waitMs answers when the replay completes", async () => {
    await using harness = await openReplayHarness();
    const items: Array<ReplayStatusItem> = [];
    harness.store.onChange((change) => {
      if (change.type === "replay") items.push(replayStatusItem(change.replay));
    });
    const { fake, requestId } = await withCapture(harness);
    const accepted = await acceptFresh(harness, requestId);
    await fake.nextMessage();

    const waiting = harness.replay.get(accepted.replayId, { waitMs: 20_000 });
    await harness.replay.onResult(responseResult(accepted.replayId));
    const result = await waiting;

    expect(result).toMatchObject({ state: "completed", dispatched: true });
    expect(result.resultRequestId).toBeDefined();
    expect(items.map((item) => item.state)).toEqual(["pending", "pending", "completed"]);
    const seqs = items.map((item) => item.seq);
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(result.seq).toBe(items.at(-1)?.seq);
    const stored = harness.store.getRequest(Number(result.resultRequestId));
    expect(stored?.summary.replayOf).toBe(String(requestId));
    expect(stored?.summary.captureId).toBe(harness.store.getRequest(requestId)?.summary.captureId);
  });
});

describe("replay refusals", () => {
  it("when only unprunable data remains over budget, replay_request is refused with the storage-full detail, recording and sending nothing; a pending replay that completes in that state settles completed with the response-not-stored detail", async () => {
    await using harness = await openReplayHarness({ store: { maxDiskBytes: 4 * MiB } });
    const { store, drafts } = harness;
    const fake = makeFakeChannel();
    harness.carriers.setCapture(fake.channel);
    const capture = await startCapture(store);
    const sources: Array<number> = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await store.insertFlow(makeFlow(capture.id, index, 256 * KiB));
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
    for (let offset = draft.size; ; offset += 128 * KiB) {
      const full = await drafts.write({ draftId: draft.draftId, offset, base64: chunk }).then(
        () => false,
        () => true,
      );
      if (full) break;
    }
    const source = sources[0] as number;
    const { idempotencyKey } = harness.replay.preview({ requestId: source });
    const revision = store.currentSeq();

    await expect(
      harness.replay.accept({ requestId: source, idempotencyKey }, new AbortController().signal),
    ).rejects.toThrow(STORAGE_FULL_DETAIL);
    expect(countReplayRows(harness.dataDir)).toBe(10);
    expect(replayFiles(harness)).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(store.currentSeq()).toBe(revision);

    await harness.replay.onResult(responseResult("replay-0", 256 * KiB));
    expect(await harness.replay.get("replay-0")).toMatchObject({
      state: "completed",
      detail: REPLAY_DETAILS.responseNotStored,
    });
    expect(store.getReplay("replay-0")?.resultRequestId).toBeUndefined();
  });

  it("a replay naming an evicted draft is refused as not sent", async () => {
    await using harness = await openReplayHarness();
    const { fake, requestId } = await withCapture(harness);
    const draftIds: Array<string> = [];
    for (let seed = 0; seed < 5; seed += 1) {
      const written = await harness.drafts.write({
        offset: 0,
        base64: patternBytes(KiB, seed).toString("base64"),
      });
      draftIds.push(written.draftId);
    }
    const edits = { body: { kind: "draft" as const, draftId: draftIds[0] as string } };
    expect(harness.replay.preview({ requestId, edits }).refusal).toBe(DRAFT_MISSING_DETAIL);
    const { idempotencyKey } = harness.replay.preview({ requestId });
    await expect(
      harness.replay.accept({ requestId, idempotencyKey, edits }, new AbortController().signal),
    ).rejects.toThrow(DRAFT_MISSING_DETAIL);
    expect(countReplayRows(harness.dataDir)).toBe(0);
    expect(fake.sent).toEqual([]);

    const kept = { body: { kind: "draft" as const, draftId: draftIds[4] as string } };
    const accepted = await harness.replay.accept(
      { requestId, idempotencyKey, edits: kept },
      new AbortController().signal,
    );
    await fake.nextMessage();
    expect(accepted.state).toBe("pending");
    expect(harness.drafts.path(draftIds[4] as string)).toBeUndefined();
  });

  it("replay refuses a truncated captured body without a replacement, with the incomplete-body detail", async () => {
    await using harness = await openReplayHarness({
      store: { maxDiskBytes: 64 * MiB, maxBodyBytes: KiB },
    });
    const { fake, requestId } = await withCapture(harness);
    const detail = incompleteBodyDetail(KiB, 64);
    expect(harness.store.getRequest(requestId)?.requestBody).toMatchObject({ truncated: false });

    const truncatedId = await harness.source(2 * KiB);
    const truncatedDetail = incompleteBodyDetail(KiB, 2 * KiB);
    expect(detail).not.toBe(truncatedDetail);
    expect(harness.replay.preview({ requestId: truncatedId }).refusal).toBe(truncatedDetail);
    const { idempotencyKey } = harness.replay.preview({ requestId: truncatedId });
    await expect(
      harness.replay.accept(
        { requestId: truncatedId, idempotencyKey },
        new AbortController().signal,
      ),
    ).rejects.toThrow(truncatedDetail);
    expect(countReplayRows(harness.dataDir)).toBe(0);

    const replacement = {
      body: { kind: "inline" as const, base64: Buffer.from("ok").toString("base64") },
    };
    expect(
      harness.replay.preview({ requestId: truncatedId, edits: replacement }).refusal,
    ).toBeUndefined();
    await harness.replay.accept(
      { requestId: truncatedId, idempotencyKey, edits: replacement },
      new AbortController().signal,
    );
    expect((await fake.nextMessage()).replayId).toBeDefined();
  });

  it("replay with an edited body rewrites an existing Content-Length and never adds Transfer-Encoding", async () => {
    await using harness = await openReplayHarness();
    const { fake, requestId } = await withCapture(harness);
    const capture = harness.store.getRequest(requestId)?.summary.captureId as number;
    const bare = await harness.store.insertFlow(
      makeFlow(capture, 50, 8, { headers: [header("content-type", "text/plain")] }),
    );
    if (!bare.ok) throw new Error("insert failed");
    const body = { kind: "inline" as const, base64: Buffer.from("hello").toString("base64") };
    const decode = (message: ReplayMessage) =>
      message.request.headers.map(([name, value]) => [
        Buffer.from(name, "base64").toString("latin1"),
        Buffer.from(value, "base64").toString("latin1"),
      ]);

    const withLength = harness.replay.preview({ requestId, edits: { body } });
    await harness.replay.accept(
      { requestId, idempotencyKey: withLength.idempotencyKey, edits: { body } },
      new AbortController().signal,
    );
    const first = await fake.nextMessage();
    expect(decode(first)).toEqual([
      ["content-type", "application/octet-stream"],
      ["content-length", "5"],
    ]);
    expect(NodeFS.readFileSync(first.request.bodyFile, "utf8")).toBe("hello");

    const without = harness.replay.preview({ requestId: bare.id, edits: { body } });
    await harness.replay.accept(
      { requestId: bare.id, idempotencyKey: without.idempotencyKey, edits: { body } },
      new AbortController().signal,
    );
    expect(decode(await fake.nextMessage())).toEqual([["content-type", "text/plain"]]);
  });
});
