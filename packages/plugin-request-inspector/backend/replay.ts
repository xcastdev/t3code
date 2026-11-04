// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - The inspector backend packs to one builtin-only CommonJS file with no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { decodeBase64Chunk, type DraftStore } from "./bodies.ts";
import {
  DRAFT_MISSING_DETAIL,
  incompleteBodyDetail,
  REPLAY_DETAILS,
  REPLAY_INPUT_DETAILS,
  STORAGE_FULL_DETAIL,
} from "./refusals.ts";
import {
  type FlowInput,
  type HeaderPair,
  headerValue,
  type InspectorStore,
  InspectorRefusal,
  type ReplayDestination,
  type ReplayPatch,
  type ReplayRow,
  type ReplayState,
  STORE_LIMITS,
  type StoreLane,
} from "./store.ts";

export const REPLAY_LIMITS = {
  maxPending: 20,
  maxReplayHistory: 1000,
  startupMs: 10_000,
  resultMs: 30_000,
  maxWaitMs: 20_000,
  settleRetryMs: 5_000,
} as const;

/** Schedules `fn` after `ms` and returns a cancel function. Injected so tests drive deadlines. */
export interface InspectorTimer {
  readonly after: (ms: number, fn: () => void) => () => void;
}

export const realTimer: InspectorTimer = {
  after: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return () => clearTimeout(handle);
  },
};

export type ReplayBodyEdit =
  | { readonly kind: "inline"; readonly base64: string }
  | { readonly kind: "draft"; readonly draftId: string };

export interface ReplayEdits {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: ReadonlyArray<readonly [string, string]>;
  readonly body?: ReplayBodyEdit;
}

export interface ReplayInput {
  readonly requestId: number;
  readonly edits?: ReplayEdits;
}

/** The request the addon builds with `http.Request(...)`. Header pairs and names are base64. */
export interface ReplayRequestMessage {
  readonly method: string;
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
  readonly authority: string;
  readonly path: string;
  readonly httpVersion: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly bodyFile: string;
}

export interface ReplayMessage {
  readonly type: "replay";
  readonly replayId: string;
  readonly request: ReplayRequestMessage;
}

/** A replayed flow as mitmproxy finished it: the request as sent, then a response or an error. */
export type ReplayResult =
  | { readonly replayId: string; readonly flow: Omit<FlowInput, "recordingId"> }
  | { readonly replayId: string; readonly error: string };

/** A live control connection to one mitmdump. */
export interface ReplayChannel {
  /** Writes one replay message. Rejects when the write fails. */
  readonly send: (message: ReplayMessage) => Promise<void>;
  readonly isOpen: () => boolean;
  /** Resolves once the control connection closes or its mitmdump exits. */
  readonly closed: Promise<void>;
}

export interface TransientCarrier {
  /** Resolves when the replay-only mitmdump's control socket connects. */
  readonly ready: Promise<ReplayChannel>;
  /** Stops it by its captured PID. */
  readonly stop: () => Promise<void>;
}

/** How a replay leaves (D35): through its source proxy's process, or a replay-only one. */
export type ReplayCarrier =
  | { readonly kind: "running"; readonly channel: ReplayChannel }
  | {
      readonly kind: "transient";
      /** Replays whose carriers share a key share one replay-only mitmdump. */
      readonly key: string;
      readonly start: () => TransientCarrier;
    };

export interface ReplayCarriers {
  /** `proxyId` is the source request's proxy, undefined when the source is gone. */
  readonly carrierFor: (proxyId: number | undefined) => ReplayCarrier;
}

export interface ReplayPreview {
  readonly destination: ReplayDestination;
  readonly method: string;
  readonly path: string;
  readonly pathTruncated?: true;
  readonly bodyBytes: number;
  readonly refusal?: string;
  readonly idempotencyKey: string;
}

export interface ReplayAccepted {
  readonly replayId: string;
  readonly state: ReplayState;
  readonly destination: ReplayDestination;
}

export interface ReplayView {
  readonly replayId: string;
  readonly seq: number;
  readonly state: ReplayState;
  readonly dispatched: boolean;
  readonly detail?: string;
  readonly resultRequestId?: string;
  readonly destination: ReplayDestination;
}

/** The `proxies` topic item for one replay row change. */
export interface ReplayStatusItem {
  readonly kind: "replay";
  readonly replayId: string;
  readonly seq: number;
  readonly state: ReplayState;
  readonly dispatched: boolean;
  readonly sourceRequestId: string;
  readonly resultRequestId?: string;
}

export const replayView = (row: ReplayRow): ReplayView => ({
  replayId: row.replayId,
  seq: row.seq,
  state: row.state,
  dispatched: row.dispatched,
  ...(row.detail === undefined ? {} : { detail: row.detail }),
  ...(row.resultRequestId === undefined ? {} : { resultRequestId: String(row.resultRequestId) }),
  destination: row.destination,
});

export const replayStatusItem = (row: ReplayRow): ReplayStatusItem => ({
  kind: "replay",
  replayId: row.replayId,
  seq: row.seq,
  state: row.state,
  dispatched: row.dispatched,
  sourceRequestId: String(row.sourceRequestId),
  ...(row.resultRequestId === undefined ? {} : { resultRequestId: String(row.resultRequestId) }),
});

const KEY_PATTERN = /^rk1\.([0-9a-f]{16})\.(0|[1-9][0-9]{0,15})\.([0-9a-f]{16})\.([0-9a-f]{32})$/;

const keyTag = (secret: Buffer, prefix: string) =>
  NodeCrypto.createHmac("sha256", secret).update(prefix).digest("hex").slice(0, 32);

/** Mints `rk1.<storeId>.<seq>.<nonce>.<tag>`. Writes nothing and reads no clock. */
export function mintReplayKey(store: InspectorStore): string {
  const meta = store.meta();
  const prefix = `rk1.${meta.storeId}.${store.currentSeq()}.${NodeCrypto.randomBytes(8).toString("hex")}`;
  return `${prefix}.${keyTag(meta.keySecret, prefix)}`;
}

type KeyCheck =
  | { readonly ok: true; readonly seq: number }
  | { readonly ok: false; readonly detail: string };

export function checkReplayKey(store: InspectorStore, key: string): KeyCheck {
  const match = KEY_PATTERN.exec(key);
  const meta = store.meta();
  if (match === null || match[1] !== meta.storeId) {
    return { ok: false, detail: REPLAY_DETAILS.notIssued };
  }
  const prefix = key.slice(0, key.lastIndexOf("."));
  const expected = Buffer.from(keyTag(meta.keySecret, prefix));
  const actual = Buffer.from(match[4] as string);
  const seq = Number(match[2]);
  if (!NodeCrypto.timingSafeEqual(expected, actual) || seq > store.currentSeq()) {
    return { ok: false, detail: REPLAY_DETAILS.notIssued };
  }
  if (seq < meta.keyFloor) return { ok: false, detail: REPLAY_DETAILS.expired };
  return { ok: true, seq };
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const replayInputHash = (input: ReplayInput) =>
  NodeCrypto.createHash("sha256")
    .update(canonical({ requestId: input.requestId, edits: input.edits ?? null }))
    .digest("hex");

/** Header text as wire bytes: latin1 when every char fits, otherwise UTF-8. */
const textBytes = (text: string) => Buffer.from(text, /[^\u0000-ÿ]/.test(text) ? "utf8" : "latin1");

const isHeader = (pair: HeaderPair, name: string) =>
  Buffer.from(pair[0]).toString("latin1").toLowerCase() === name;

const TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

type BuiltBody =
  | { readonly kind: "source"; readonly size: number }
  | { readonly kind: "inline"; readonly bytes: Buffer }
  | {
      readonly kind: "draft";
      readonly draftId: string;
      readonly path: string;
      readonly size: number;
    };

interface BuiltReplay {
  readonly proxyId: number;
  readonly destination: ReplayDestination;
  readonly method: string;
  readonly authority: string;
  readonly path: string;
  readonly httpVersion: string;
  readonly headers: ReadonlyArray<HeaderPair>;
  readonly body: BuiltBody;
  readonly bodyBytes: number;
  readonly refusal?: string;
}

const defaultPort = (scheme: string) => (scheme === "https" ? 443 : 80);

/** Builds the replay request from the stored record plus edits. Throws only when the source is gone. */
function buildReplay(store: InspectorStore, drafts: DraftStore, input: ReplayInput): BuiltReplay {
  const record = store.getRequest(input.requestId);
  if (record === undefined) throw new InspectorRefusal("not-found", REPLAY_DETAILS.sourceMissing);
  const edits = input.edits ?? {};
  const refusals: Array<string> = [];

  let destination: ReplayDestination = {
    scheme: record.summary.scheme,
    host: record.summary.host,
    port: record.summary.port,
  };
  let authority = record.authority;
  let path = record.path;
  let hostHeader: string | undefined;
  if (edits.url !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(edits.url);
    } catch {
      url = undefined;
    }
    const scheme = url?.protocol.replace(/:$/, "");
    if (url === undefined || (scheme !== "http" && scheme !== "https") || url.hostname === "") {
      refusals.push(REPLAY_INPUT_DETAILS.url);
    } else {
      const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
      const port = url.port === "" ? defaultPort(scheme as string) : Number(url.port);
      destination = { scheme: scheme as string, host, port };
      hostHeader = url.host;
      if (authority !== "") authority = url.host;
      path = `${url.pathname}${url.search}`;
    }
  }

  const method = edits.method ?? record.summary.method;
  if (!TOKEN_PATTERN.test(method)) refusals.push(REPLAY_INPUT_DETAILS.method);

  let headers: Array<HeaderPair> =
    edits.headers === undefined
      ? record.requestHeaders.map(([name, value]) => [name, value] as const)
      : edits.headers.map(([name, value]) => [textBytes(name), textBytes(value)] as const);
  if (hostHeader !== undefined) {
    headers = headers.map((pair) =>
      isHeader(pair, "host") ? ([pair[0], textBytes(hostHeader)] as const) : pair,
    );
  }

  const upgrade = headerValue(record.requestHeaders, "upgrade");
  if (
    record.summary.flowType !== "http" ||
    record.response?.status === 101 ||
    (upgrade !== undefined && upgrade.toLowerCase().includes("websocket"))
  ) {
    refusals.push(REPLAY_DETAILS.httpOnly);
  }

  let body: BuiltBody;
  if (edits.body === undefined) {
    const meta = record.requestBody;
    if (meta?.truncated === true) {
      refusals.push(incompleteBodyDetail(meta.capturedBytes, meta.declaredBytes));
    }
    body = { kind: "source", size: meta?.capturedBytes ?? 0 };
  } else if (edits.body.kind === "inline") {
    body = { kind: "inline", bytes: decodeBase64Chunk(edits.body.base64) };
  } else {
    const draftPath = drafts.path(edits.body.draftId);
    const size = drafts.size(edits.body.draftId);
    if (draftPath === undefined || size === undefined) {
      refusals.push(DRAFT_MISSING_DETAIL);
      body = { kind: "inline", bytes: Buffer.alloc(0) };
    } else {
      body = { kind: "draft", draftId: edits.body.draftId, path: draftPath, size };
    }
  }
  const bodyBytes = body.kind === "inline" ? body.bytes.byteLength : body.size;
  if (edits.body !== undefined) {
    const length = textBytes(String(bodyBytes));
    headers = headers.map((pair) =>
      isHeader(pair, "content-length") ? ([pair[0], length] as const) : pair,
    );
  }

  const refusal = refusals[0];
  return {
    proxyId: record.summary.proxyId,
    destination,
    method,
    authority,
    path,
    httpVersion: record.httpVersion,
    headers,
    body,
    bodyBytes,
    ...(refusal === undefined ? {} : { refusal }),
  };
}

export interface ReplayServiceOptions {
  readonly store: InspectorStore;
  readonly drafts: DraftStore;
  readonly carriers: ReplayCarriers;
  readonly timer?: InspectorTimer;
  /** Display-only timestamps (acceptedAt, dispatchedAt). No rule reads them. */
  readonly now?: () => number;
  readonly maxReplayHistory?: number;
  readonly log?: (message: string) => void;
}

export interface ReplayService {
  readonly preview: (input: ReplayInput) => ReplayPreview;
  readonly accept: (
    input: ReplayInput & { readonly idempotencyKey: string },
    signal: AbortSignal,
  ) => Promise<ReplayAccepted>;
  readonly get: (
    replayId: string,
    options?: { readonly waitMs?: number; readonly signal?: AbortSignal },
  ) => Promise<ReplayView>;
  readonly onResult: (result: ReplayResult) => Promise<void>;
  /** Settles every replay handed to `channel` as interrupted. */
  readonly interruptChannel: (channel: ReplayChannel) => Promise<void>;
  /** Worker start: settles rows left pending and deletes orphan body files. */
  readonly recover: () => Promise<void>;
  /** Worker stop: stops a transient mitmdump and settles what is still pending. */
  readonly stop: () => Promise<void>;
}

interface TransientEntry {
  readonly key: string;
  readonly carrier: TransientCarrier;
  readonly ready: Promise<ReplayChannel | undefined>;
  readonly users: Set<string>;
  stopping: boolean;
}

export function makeReplayService(options: ReplayServiceOptions): ReplayService {
  const { store, drafts, carriers } = options;
  const timer = options.timer ?? realTimer;
  const now = options.now ?? Date.now;
  const maxReplayHistory = options.maxReplayHistory ?? REPLAY_LIMITS.maxReplayHistory;
  const log = options.log ?? (() => undefined);

  const prepared = new Map<string, { readonly message: ReplayMessage; readonly proxyId: number }>();
  const inflight = new Map<string, ReplayChannel>();
  const deadlines = new Map<string, () => void>();
  const transientOf = new Map<string, TransientEntry>();
  const watched = new WeakSet<ReplayChannel>();
  const transients = new Map<string, TransientEntry>();
  let stopped = false;

  const bodyFile = (replayId: string) => NodePath.join(store.replayDir, `${replayId}.bin`);

  const stopTransient = (entry: TransientEntry) => {
    if (entry.stopping) return Promise.resolve();
    entry.stopping = true;
    if (transients.get(entry.key) === entry) transients.delete(entry.key);
    return entry.carrier.stop().catch(() => log("Stopping the replay mitmdump failed."));
  };

  const release = (replayId: string) => {
    deadlines.get(replayId)?.();
    deadlines.delete(replayId);
    inflight.delete(replayId);
    prepared.delete(replayId);
    const entry = transientOf.get(replayId);
    transientOf.delete(replayId);
    if (entry !== undefined && entry.users.delete(replayId) && entry.users.size === 0) {
      void stopTransient(entry);
    }
  };

  const settleInLane = (lane: StoreLane, replayId: string, patch: ReplayPatch) => {
    const row = lane.write((tx) => {
      if (store.getReplay(replayId)?.state !== "pending") return undefined;
      const updated = tx.updateReplay(replayId, patch);
      tx.pruneReplayHistory(maxReplayHistory);
      return updated;
    });
    NodeFS.rmSync(bodyFile(replayId), { force: true });
    lane.noteFileWrite();
    release(replayId);
    return row;
  };

  // A row left pending would count toward maxPending until the next worker start, so retry.
  const settle = (replayId: string, patch: ReplayPatch): Promise<ReplayRow | undefined> =>
    store
      .exclusive((lane) => settleInLane(lane, replayId, patch))
      .catch(() => {
        release(replayId);
        log("Settling a replay failed.");
        if (!stopped) {
          deadlines.set(
            replayId,
            timer.after(REPLAY_LIMITS.settleRetryMs, () => {
              deadlines.delete(replayId);
              void settle(replayId, patch);
            }),
          );
        }
        return undefined;
      });

  const interruptedPatch = (row: ReplayRow): ReplayPatch =>
    row.dispatched
      ? { state: "unknown", detail: REPLAY_DETAILS.interrupted }
      : { state: "failed", detail: REPLAY_DETAILS.stopped };

  const interruptChannel = async (channel: ReplayChannel) => {
    const ids = [...inflight].filter(([, carrier]) => carrier === channel).map(([id]) => id);
    if (ids.length === 0) return;
    await store
      .exclusive((lane) => {
        for (const id of ids) {
          const row = store.getReplay(id);
          if (row?.state === "pending") settleInLane(lane, id, interruptedPatch(row));
          else release(id);
        }
      })
      .catch(() => log("Settling interrupted replays failed."));
  };

  const watch = (channel: ReplayChannel) => {
    if (watched.has(channel)) return;
    watched.add(channel);
    void channel.closed.then(() => interruptChannel(channel));
  };

  const acquireChannel = async (
    replayId: string,
    proxyId: number,
  ): Promise<ReplayChannel | undefined> => {
    const chosen = carriers.carrierFor(proxyId);
    if (chosen.kind === "running") return chosen.channel;
    let entry = transients.get(chosen.key);
    if (entry === undefined) {
      const carrier = chosen.start();
      const ready = new Promise<ReplayChannel | undefined>((resolve) => {
        const cancel = timer.after(REPLAY_LIMITS.startupMs, () => resolve(undefined));
        carrier.ready.then(
          (channel) => {
            cancel();
            resolve(channel);
          },
          () => {
            cancel();
            resolve(undefined);
          },
        );
      });
      const created: TransientEntry = {
        key: chosen.key,
        carrier,
        ready,
        users: new Set(),
        stopping: false,
      };
      entry = created;
      transients.set(chosen.key, created);
      void ready.then((channel) => {
        if (channel === undefined) void stopTransient(created);
      });
    }
    entry.users.add(replayId);
    transientOf.set(replayId, entry);
    return entry.ready;
  };

  const dispatch = async (replayId: string) => {
    const entry = prepared.get(replayId);
    if (entry === undefined) return;
    const { message } = entry;
    const channel = await acquireChannel(replayId, entry.proxyId);
    if (stopped) return;
    if (channel === undefined || !channel.isOpen()) {
      await settle(replayId, { state: "failed", detail: REPLAY_DETAILS.notStarted });
      return;
    }
    let committed: boolean;
    try {
      committed = await store.exclusive((lane) =>
        lane.write((tx) => {
          if (store.getReplay(replayId)?.state !== "pending") return false;
          tx.updateReplay(replayId, { dispatched: true, dispatchedAt: now() });
          return true;
        }),
      );
    } catch {
      log("Recording a replay handoff failed.");
      await settle(replayId, { state: "failed", detail: REPLAY_DETAILS.intentFailed });
      return;
    }
    if (!committed) {
      release(replayId);
      return;
    }
    inflight.set(replayId, channel);
    watch(channel);
    deadlines.set(
      replayId,
      timer.after(REPLAY_LIMITS.resultMs, () => {
        void settle(replayId, { state: "unknown", detail: REPLAY_DETAILS.noResponse });
      }),
    );
    if (!channel.isOpen()) {
      await settle(replayId, { state: "unknown", detail: REPLAY_DETAILS.interrupted });
      return;
    }
    try {
      await channel.send(message);
    } catch {
      await settle(replayId, { state: "unknown", detail: REPLAY_DETAILS.interrupted });
    }
  };

  type Checked =
    | { readonly kind: "existing"; readonly row: ReplayRow }
    | { readonly kind: "new"; readonly built: BuiltReplay; readonly keySeq: number };

  const check = (
    input: ReplayInput & { readonly idempotencyKey: string },
    inputHash: string,
    signal: AbortSignal,
  ): Checked => {
    const existing = store.getReplayByKey(input.idempotencyKey);
    if (existing !== undefined) {
      if (existing.inputHash !== inputHash) {
        throw new InspectorRefusal("conflict", REPLAY_DETAILS.conflict);
      }
      return { kind: "existing", row: existing };
    }
    const key = checkReplayKey(store, input.idempotencyKey);
    if (!key.ok) throw new InspectorRefusal("conflict", key.detail);
    if (store.countPendingReplays() >= REPLAY_LIMITS.maxPending) {
      throw new InspectorRefusal("conflict", REPLAY_DETAILS.pendingCap);
    }
    const body = input.edits?.body;
    if (body?.kind === "draft" && drafts.path(body.draftId) === undefined) {
      throw new InspectorRefusal("not-found", DRAFT_MISSING_DETAIL);
    }
    const built = buildReplay(store, drafts, input);
    if (built.refusal !== undefined) throw new InspectorRefusal("invalid-input", built.refusal);
    if (signal.aborted) throw new InspectorRefusal("conflict", REPLAY_DETAILS.aborted);
    return { kind: "new", built, keySeq: key.seq };
  };

  const accepted = (row: ReplayRow): ReplayAccepted => ({
    replayId: row.replayId,
    state: row.state,
    destination: row.destination,
  });

  const writeBody = (path: string, built: BuiltReplay, requestId: number) => {
    NodeFS.mkdirSync(store.replayDir, { recursive: true });
    switch (built.body.kind) {
      case "inline":
        NodeFS.writeFileSync(path, built.body.bytes, { mode: 0o600 });
        return;
      case "draft":
        NodeFS.copyFileSync(built.body.path, path);
        return;
      case "source": {
        const stored = store.readBody(requestId, "request");
        if (stored === undefined) {
          throw new InspectorRefusal("not-found", REPLAY_DETAILS.sourceMissing);
        }
        NodeFS.writeFileSync(path, stored.bytes, { mode: 0o600 });
      }
    }
  };

  const toMessage = (replayId: string, built: BuiltReplay, path: string): ReplayMessage => ({
    type: "replay",
    replayId,
    request: {
      method: built.method,
      scheme: built.destination.scheme,
      host: built.destination.host,
      port: built.destination.port,
      authority: built.authority,
      path: built.path,
      httpVersion: built.httpVersion,
      headers: built.headers.map(
        ([name, value]) =>
          [Buffer.from(name).toString("base64"), Buffer.from(value).toString("base64")] as const,
      ),
      bodyFile: path,
    },
  });

  const accept: ReplayService["accept"] = async (input, signal) => {
    const inputHash = replayInputHash(input);
    const result = await store.exclusive((lane) => {
      const first = check(input, inputHash, signal);
      if (first.kind === "existing") return { row: first.row, fresh: false };
      if (
        lane.admit(first.built.bodyBytes + STORE_LIMITS.replayRowAllowanceBytes, {
          protect: input.requestId,
        }) === "full"
      ) {
        throw new InspectorRefusal("storage-full", STORAGE_FULL_DETAIL);
      }
      const replayId = NodeCrypto.randomBytes(8).toString("hex");
      const path = bodyFile(replayId);
      const removeBody = () => {
        NodeFS.rmSync(path, { force: true });
        lane.noteFileWrite();
      };
      try {
        writeBody(path, first.built, input.requestId);
        lane.noteFileWrite();
        const outcome = lane.write((tx) => {
          const again = check(input, inputHash, signal);
          if (again.kind === "existing") return { row: again.row, fresh: false };
          const row = tx.insertReplay({
            replayId,
            idempotencyKey: input.idempotencyKey,
            keySeq: again.keySeq,
            inputHash,
            sourceRequestId: input.requestId,
            destination: again.built.destination,
            acceptedAt: now(),
          });
          return { row, fresh: true };
        });
        if (!outcome.fresh) {
          removeBody();
          return outcome;
        }
        if (first.built.body.kind === "draft") drafts.remove(lane, first.built.body.draftId);
        prepared.set(replayId, {
          message: toMessage(replayId, first.built, path),
          proxyId: first.built.proxyId,
        });
        return outcome;
      } catch (error) {
        removeBody();
        throw error;
      }
    });
    if (result.fresh) {
      void dispatch(result.row.replayId).catch(() => log("Dispatching a replay failed."));
    }
    return accepted(result.row);
  };

  const preview: ReplayService["preview"] = (input) => {
    const built = buildReplay(store, drafts, input);
    const pathCut = built.path.length > STORE_LIMITS.summaryPathChars;
    return {
      destination: built.destination,
      method: built.method,
      path: pathCut ? built.path.slice(0, STORE_LIMITS.summaryPathChars) : built.path,
      ...(pathCut ? { pathTruncated: true as const } : {}),
      bodyBytes: built.bodyBytes,
      ...(built.refusal === undefined ? {} : { refusal: built.refusal }),
      idempotencyKey: mintReplayKey(store),
    };
  };

  const get: ReplayService["get"] = (replayId, getOptions = {}) => {
    const row = store.getReplay(replayId);
    if (row === undefined) {
      return Promise.reject(new InspectorRefusal("not-found", REPLAY_DETAILS.replayMissing));
    }
    const waitMs = Math.min(Math.max(0, getOptions.waitMs ?? 0), REPLAY_LIMITS.maxWaitMs);
    if (row.state !== "pending" || waitMs === 0 || getOptions.signal?.aborted === true) {
      return Promise.resolve(replayView(row));
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        unsubscribe();
        cancel();
        getOptions.signal?.removeEventListener("abort", finish);
        resolve(replayView(store.getReplay(replayId) ?? row));
      };
      const unsubscribe = store.onChange((change) => {
        if (
          change.type === "replay" &&
          change.replay.replayId === replayId &&
          change.replay.state !== "pending"
        ) {
          finish();
        }
      });
      const cancel = timer.after(waitMs, finish);
      getOptions.signal?.addEventListener("abort", finish);
    });
  };

  const onResult: ReplayService["onResult"] = async (result) => {
    if (store.getReplay(result.replayId)?.state !== "pending") return;
    if ("error" in result) {
      await settle(result.replayId, { state: "failed", detail: result.error });
      return;
    }
    await store
      .exclusive((lane) => {
        const row = store.getReplay(result.replayId);
        if (row?.state !== "pending") return;
        const source = store.getRequest(row.sourceRequestId);
        const stored =
          source === undefined
            ? undefined
            : lane.insertFlow({
                ...result.flow,
                recordingId: source.summary.recordingId,
                replayOf: String(row.sourceRequestId),
              });
        settleInLane(
          lane,
          result.replayId,
          stored?.ok === true
            ? { state: "completed", resultRequestId: stored.id }
            : { state: "completed", detail: REPLAY_DETAILS.responseNotStored },
        );
      })
      .catch(() => log("Storing a replay result failed."));
  };

  const settlePending = () =>
    store.exclusive((lane) => {
      for (const row of store.listPendingReplays()) {
        settleInLane(lane, row.replayId, interruptedPatch(row));
      }
      const pending = new Set(store.listPendingReplays().map((row) => row.replayId));
      let names: Array<string> = [];
      try {
        names = NodeFS.readdirSync(store.replayDir);
      } catch {
        names = [];
      }
      for (const name of names) {
        if (!pending.has(name.replace(/\.bin$/, ""))) {
          NodeFS.rmSync(NodePath.join(store.replayDir, name), { recursive: true, force: true });
        }
      }
      lane.noteFileWrite();
    });

  return {
    preview,
    accept,
    get,
    onResult,
    interruptChannel,
    recover: settlePending,
    stop: async () => {
      stopped = true;
      for (const cancel of deadlines.values()) cancel();
      deadlines.clear();
      await Promise.all([...transients.values()].map(stopTransient));
      await settlePending();
    },
  };
}
