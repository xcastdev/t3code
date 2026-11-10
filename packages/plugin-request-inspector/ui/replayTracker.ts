import type { PluginSubscriptionEvent } from "@t3tools/contracts";

export type ReplayState = "pending" | "completed" | "failed" | "unknown";

export interface ReplayStatus {
  readonly replayId: string;
  readonly seq: number;
  readonly state: ReplayState;
  readonly dispatched: boolean;
  readonly detail?: string;
  readonly resultRequestId?: string;
}

/** One Send the panel has not seen settle. Persisted in bridge state. */
export interface TrackedReplay<Input> {
  readonly key: string;
  readonly input: Input;
  readonly replayId?: string;
}

export type GetReplayResult =
  | { readonly found: true; readonly replay: ReplayStatus }
  | { readonly found: false };

export interface ReplayTrackerOptions<Input> {
  readonly initial?: ReadonlyArray<TrackedReplay<Input>>;
  /** `get_replay { replayId, waitMs: 0 }`. Rejections leave the entry tracked. */
  readonly getReplay: (replayId: string) => Promise<GetReplayResult>;
  readonly onTrackedChange: (tracked: ReadonlyArray<TrackedReplay<Input>>) => void;
  readonly onStatusChange?: () => void;
}

export const MAX_UNSETTLED_REPLAYS = 20;
const MAX_HELD_STATUSES = 200;
/** The host bridge refuses more than 16 calls in flight; leave room for the panel's own calls. */
const MAX_CONCURRENT_QUERIES = 4;

const STATES: ReadonlySet<string> = new Set(["pending", "completed", "failed", "unknown"]);

export const isTerminal = (state: ReplayState) => state !== "pending";

/** `unknown`, and `failed` after handoff, may have reached the upstream. */
export const mayHaveBeenSent = (status: ReplayStatus) =>
  status.state === "unknown" || (status.state === "failed" && status.dispatched);

export function parseReplayStatus(value: unknown): ReplayStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.replayId !== "string" ||
    typeof record.seq !== "number" ||
    typeof record.state !== "string" ||
    !STATES.has(record.state) ||
    typeof record.dispatched !== "boolean"
  ) {
    return undefined;
  }
  return {
    replayId: record.replayId,
    seq: record.seq,
    state: record.state as ReplayState,
    dispatched: record.dispatched,
    ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    ...(typeof record.resultRequestId === "string"
      ? { resultRequestId: record.resultRequestId }
      : {}),
  };
}

/**
 * Holds replay statuses by `replayId`, applying an update only when its `seq` is newer, and the
 * tracked Sends that still need an outcome.
 */
export function createReplayTracker<Input>(options: ReplayTrackerOptions<Input>) {
  let tracked: ReadonlyArray<TrackedReplay<Input>> = (options.initial ?? []).slice(
    0,
    MAX_UNSETTLED_REPLAYS,
  );
  const statuses = new Map<string, ReplayStatus>();
  const inFlight = new Set<Promise<void>>();
  const queued: Array<string> = [];

  const isTracked = (replayId: string) => tracked.some((entry) => entry.replayId === replayId);

  const setTracked = (next: ReadonlyArray<TrackedReplay<Input>>) => {
    tracked = next;
    options.onTrackedChange(tracked);
  };

  const untrack = (predicate: (entry: TrackedReplay<Input>) => boolean) => {
    if (tracked.some(predicate)) setTracked(tracked.filter((entry) => !predicate(entry)));
  };

  const merge = (status: ReplayStatus) => {
    const held = statuses.get(status.replayId);
    if (held !== undefined && status.seq <= held.seq) {
      if (isTerminal(held.state)) untrack((entry) => entry.replayId === status.replayId);
      return;
    }
    statuses.delete(status.replayId);
    statuses.set(status.replayId, status);
    for (const replayId of statuses.keys()) {
      if (statuses.size <= MAX_HELD_STATUSES) break;
      if (!isTracked(replayId)) statuses.delete(replayId);
    }
    if (isTerminal(status.state)) untrack((entry) => entry.replayId === status.replayId);
    options.onStatusChange?.();
  };

  const pump = () => {
    while (inFlight.size < MAX_CONCURRENT_QUERIES && queued.length > 0) {
      const replayId = queued.shift();
      if (replayId === undefined || !isTracked(replayId)) continue;
      const done: Promise<void> = options
        .getReplay(replayId)
        .then(
          (result) => {
            if (result.found) merge(result.replay);
            else untrack((entry) => entry.replayId === replayId);
          },
          () => undefined,
        )
        .finally(() => {
          inFlight.delete(done);
          pump();
        });
      inFlight.add(done);
    }
  };

  const refresh = (replayId: string) => {
    if (!queued.includes(replayId)) queued.push(replayId);
    pump();
  };

  const reconcile = () => {
    for (const entry of tracked) if (entry.replayId !== undefined) refresh(entry.replayId);
  };

  return {
    tracked: () => tracked,
    status: (replayId: string) => statuses.get(replayId),
    statuses: () => [...statuses.values()],
    isFull: () => tracked.length >= MAX_UNSETTLED_REPLAYS,
    /** Records a key before its Send, so a reconnect or remount can retry it. */
    begin: (key: string, input: Input) => {
      if (tracked.length >= MAX_UNSETTLED_REPLAYS) return false;
      if (!tracked.some((entry) => entry.key === key)) setTracked([...tracked, { key, input }]);
      return true;
    },
    accepted: (key: string, replayId: string) => {
      const held = statuses.get(replayId);
      if (held !== undefined && isTerminal(held.state)) {
        untrack((entry) => entry.key === key);
        return;
      }
      setTracked(tracked.map((entry) => (entry.key === key ? { ...entry, replayId } : entry)));
      refresh(replayId);
    },
    forget: (key: string) => untrack((entry) => entry.key === key),
    /** Feeds one `capture_status` event. Every snapshot reconciles the tracked replays. */
    handleEvent: (event: PluginSubscriptionEvent) => {
      if (event.type !== "snapshot" && event.type !== "batch") return;
      for (const item of event.items) {
        if (typeof item !== "object" || item === null || !("kind" in item)) continue;
        if (item.kind !== "replay") continue;
        const status = parseReplayStatus(item);
        if (status !== undefined) merge(status);
      }
      if (event.type === "snapshot") reconcile();
    },
    /** Resolves when every get_replay started so far has been merged. */
    settled: async () => {
      while (inFlight.size > 0) await Promise.all(inFlight);
    },
  };
}

export type ReplayTracker<Input> = ReturnType<typeof createReplayTracker<Input>>;
