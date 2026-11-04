// @effect-diagnostics nodeBuiltinImport:off - Test fixtures for the builtin-only inspector backend.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type DraftStore, makeDraftStore } from "./bodies.ts";
import {
  type InspectorTimer,
  makeReplayService,
  type ReplayCarriers,
  type ReplayChannel,
  type ReplayMessage,
  type ReplayService,
  type ReplayServiceOptions,
} from "./replay.ts";
import { type InspectorStore, type InspectorStoreOptions, openInspectorStore } from "./store.ts";
import { DEFAULT_PROXY_OPTIONS, MiB, makeFlow, startRecording } from "./store.testkit.ts";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface TimerEntry {
  readonly ms: number;
  readonly fn: () => void;
  active: boolean;
}

/** A timer the test fires by hand. */
export function makeFakeTimer() {
  const entries: Array<TimerEntry> = [];
  const waiters: Array<{ readonly ms: number; readonly resolve: () => void }> = [];
  const timer: InspectorTimer = {
    after: (ms, fn) => {
      const entry: TimerEntry = { ms, fn, active: true };
      entries.push(entry);
      for (const waiter of waiters.filter((candidate) => candidate.ms === ms)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
      return () => {
        entry.active = false;
      };
    },
  };
  const active = (ms: number) => entries.filter((entry) => entry.active && entry.ms === ms);
  return {
    timer,
    /** Resolves once a timer for `ms` is scheduled and still active. */
    scheduled: (ms: number) =>
      active(ms).length > 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ ms, resolve })),
    /** Fires every active timer for `ms`. Returns how many fired. */
    fire: (ms: number) => {
      const due = active(ms);
      for (const entry of due) {
        entry.active = false;
        entry.fn();
      }
      return due.length;
    },
  };
}

export interface FakeChannel {
  readonly channel: ReplayChannel;
  readonly sent: Array<ReplayMessage>;
  readonly nextMessage: () => Promise<ReplayMessage>;
  readonly close: () => void;
  readonly failNextSend: () => void;
}

/** A fake mitmdump control connection. `onSend` runs when a message arrives. */
export function makeFakeChannel(onSend?: (message: ReplayMessage) => void): FakeChannel {
  const sent: Array<ReplayMessage> = [];
  let open = true;
  let failNext = false;
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  let waiter = deferred<ReplayMessage>();
  return {
    channel: {
      send: async (message) => {
        if (failNext || !open) {
          failNext = false;
          throw new Error("write failed");
        }
        sent.push(message);
        onSend?.(message);
        const current = waiter;
        waiter = deferred();
        current.resolve(message);
      },
      isOpen: () => open,
      closed,
    },
    sent,
    nextMessage: () => waiter.promise,
    close: () => {
      open = false;
      markClosed();
    },
    failNextSend: () => {
      failNext = true;
    },
  };
}

export interface FakeTransient {
  readonly ready: Deferred<ReplayChannel>;
  /** The source proxy the replay that started it came from. */
  readonly proxyId: number | undefined;
  readonly key: string;
  stops: number;
}

/**
 * Fake D35 carriers. A channel set with `setRunning(proxyId, …)` carries that proxy's replays;
 * `setCapture` sets one for every proxy. Otherwise a transient starts, keyed by `transientKey`.
 */
export function makeFakeCarriers(
  transientKey: (proxyId: number | undefined) => string = () => "direct",
) {
  let everyProxy: ReplayChannel | undefined;
  const running = new Map<number, ReplayChannel>();
  const transients: Array<FakeTransient> = [];
  const asked: Array<number | undefined> = [];
  let started = deferred<FakeTransient>();
  const carriers: ReplayCarriers = {
    carrierFor: (proxyId) => {
      asked.push(proxyId);
      const channel = (proxyId === undefined ? undefined : running.get(proxyId)) ?? everyProxy;
      if (channel?.isOpen() === true) return { kind: "running", channel };
      const key = transientKey(proxyId);
      return {
        kind: "transient",
        key,
        start: () => {
          const entry: FakeTransient = { ready: deferred(), proxyId, key, stops: 0 };
          entry.ready.promise.catch(() => undefined);
          transients.push(entry);
          const current = started;
          started = deferred();
          current.resolve(entry);
          return {
            ready: entry.ready.promise,
            stop: async () => {
              entry.stops += 1;
            },
          };
        },
      };
    },
  };
  return {
    carriers,
    setCapture: (channel: ReplayChannel | undefined) => {
      everyProxy = channel;
    },
    setRunning: (proxyId: number, channel: ReplayChannel | undefined) => {
      if (channel === undefined) running.delete(proxyId);
      else running.set(proxyId, channel);
    },
    /** The proxy id of each carrier lookup, in order. */
    asked,
    transients,
    nextTransient: () =>
      transients.length > 0 ? Promise.resolve(transients.at(-1) as FakeTransient) : started.promise,
  };
}

export interface ReplayInstance {
  readonly store: InspectorStore;
  readonly drafts: DraftStore;
  readonly replay: ReplayService;
  readonly timer: ReturnType<typeof makeFakeTimer>;
  readonly carriers: ReturnType<typeof makeFakeCarriers>;
}

export interface ReplayHarness extends ReplayInstance, AsyncDisposable {
  readonly dataDir: string;
  /** Opens a second store and replay service on the same dataDir, as a restarted worker would. */
  readonly reopen: (
    options?: Partial<Omit<ReplayServiceOptions, "store" | "drafts">>,
  ) => ReplayInstance;
  /** Inserts one captured POST with a body of `bodyBytes` and returns its id. */
  readonly source: (bodyBytes?: number) => Promise<number>;
}

export async function openReplayHarness(
  options: {
    readonly store?: Omit<InspectorStoreOptions, "dataDir" | "defaultProxyOptions">;
    readonly replay?: Partial<Omit<ReplayServiceOptions, "store" | "drafts">>;
    readonly dataDir?: string;
  } = {},
): Promise<ReplayHarness> {
  const dataDir =
    options.dataDir ??
    (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "request-inspector-replay-")));
  const opened: Array<InspectorStore> = [];
  const open = (
    replayOptions: Partial<Omit<ReplayServiceOptions, "store" | "drafts">> = {},
  ): ReplayInstance => {
    const store = openInspectorStore({
      maxDiskBytes: 64 * MiB,
      defaultProxyOptions: DEFAULT_PROXY_OPTIONS,
      ...options.store,
      dataDir,
    });
    opened.push(store);
    const drafts = makeDraftStore(store);
    const timer = makeFakeTimer();
    const carriers = makeFakeCarriers();
    const replay = makeReplayService({
      store,
      drafts,
      timer: timer.timer,
      carriers: carriers.carriers,
      now: () => 1_700_000_000_000,
      ...replayOptions,
    });
    return { store, drafts, replay, timer, carriers };
  };
  const first = open(options.replay);
  let recordingId: number | undefined;
  let index = 0;
  return {
    dataDir,
    ...first,
    reopen: open,
    source: async (bodyBytes = 64) => {
      recordingId ??= (await startRecording(first.store)).id;
      const result = await first.store.insertFlow(makeFlow(recordingId, index++, bodyBytes));
      if (!result.ok) throw new Error("insert failed");
      return result.id;
    },
    [Symbol.asyncDispose]: async () => {
      for (const store of opened) store.close();
      await NodeFSP.rm(dataDir, { recursive: true, force: true });
    },
  };
}
