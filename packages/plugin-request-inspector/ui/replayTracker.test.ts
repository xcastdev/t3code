import { describe, expect, it } from "vite-plus/test";

import type { PluginSubscriptionEvent } from "@t3tools/contracts";

import {
  createReplayTracker,
  type GetReplayResult,
  type ReplayStatus,
  type TrackedReplay,
} from "./replayTracker.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** A fake get_replay whose answers the test resolves. */
function fakeGetReplay() {
  const calls: Array<{ replayId: string; answer: Deferred<GetReplayResult> }> = [];
  return {
    calls,
    getReplay: (replayId: string) => {
      const answer = deferred<GetReplayResult>();
      calls.push({ replayId, answer });
      return answer.promise;
    },
  };
}

const status = (overrides: Partial<ReplayStatus> & { seq: number }): ReplayStatus => ({
  replayId: "r1",
  state: "pending",
  dispatched: false,
  ...overrides,
});

const item = (value: ReplayStatus) => ({ kind: "replay", sourceRequestId: "7", ...value });

const captureItem = { kind: "capture", running: null, droppedFlows: 0, storageBlocked: false };

const setup = (tracked: ReadonlyArray<TrackedReplay<string>>) => {
  const fake = fakeGetReplay();
  const persisted: Array<ReadonlyArray<TrackedReplay<string>>> = [];
  const tracker = createReplayTracker<string>({
    initial: tracked,
    getReplay: fake.getReplay,
    onTrackedChange: (next) => persisted.push(next),
  });
  return { tracker, fake, persisted };
};

describe("replayTracker", () => {
  it.each([
    {
      name: "a resync from host reconnect",
      gap: [{ type: "resync" }] satisfies Array<PluginSubscriptionEvent>,
    },
    {
      name: "a resync from overflow",
      gap: [
        { type: "batch", items: [captureItem], revision: "40" },
        { type: "resync" },
      ] satisfies Array<PluginSubscriptionEvent>,
    },
  ])(
    "a terminal replay change missed during a gap is recovered by the get_replay reconcile after the next snapshot ($name)",
    async ({ gap }) => {
      const { tracker, fake, persisted } = setup([{ key: "k1", input: "in", replayId: "r1" }]);
      tracker.handleEvent({
        type: "snapshot",
        items: [captureItem],
        revision: "10",
        cursor: null,
      });
      expect(fake.calls.map((call) => call.replayId)).toEqual(["r1"]);
      fake.calls[0]?.answer.resolve({ found: true, replay: status({ seq: 10 }) });
      await tracker.settled();
      expect(tracker.status("r1")?.state).toBe("pending");

      // The terminal batch for r1 is never delivered.
      for (const event of gap) tracker.handleEvent(event);
      tracker.handleEvent({
        type: "snapshot",
        items: [captureItem],
        revision: "50",
        cursor: null,
      });
      expect(fake.calls.map((call) => call.replayId)).toEqual(["r1", "r1"]);
      fake.calls[1]?.answer.resolve({
        found: true,
        replay: status({ seq: 45, state: "completed", dispatched: true, resultRequestId: "9" }),
      });
      await tracker.settled();

      expect(tracker.status("r1")).toMatchObject({ state: "completed", resultRequestId: "9" });
      expect(tracker.tracked()).toEqual([]);
      expect(persisted.at(-1)).toEqual([]);
    },
  );

  it("a delayed pending get_replay result after a terminal batch does not regress the state", async () => {
    const { tracker, fake } = setup([{ key: "k1", input: "in", replayId: "r1" }]);
    tracker.handleEvent({ type: "snapshot", items: [captureItem], revision: "10", cursor: null });
    tracker.handleEvent({
      type: "batch",
      items: [item(status({ seq: 12, state: "unknown", dispatched: true }))],
      revision: "12",
    });
    fake.calls[0]?.answer.resolve({ found: true, replay: status({ seq: 11, dispatched: true }) });
    await tracker.settled();

    expect(tracker.status("r1")).toMatchObject({ seq: 12, state: "unknown", dispatched: true });
    expect(tracker.tracked()).toEqual([]);
  });

  it("a terminal merge or not-found removes the replay from tracked state, and a key without a replayId is not queried", async () => {
    const { tracker, fake, persisted } = setup([
      { key: "k1", input: "a", replayId: "r1" },
      { key: "k2", input: "b", replayId: "r2" },
      { key: "k3", input: "c" },
    ]);
    tracker.handleEvent({ type: "snapshot", items: [captureItem], revision: "10", cursor: null });
    expect(fake.calls.map((call) => call.replayId)).toEqual(["r1", "r2"]);

    tracker.handleEvent({
      type: "batch",
      items: [item(status({ replayId: "r1", seq: 11, state: "failed" }))],
      revision: "11",
    });
    expect(tracker.tracked().map((entry) => entry.key)).toEqual(["k2", "k3"]);

    fake.calls[1]?.answer.resolve({ found: false });
    fake.calls[0]?.answer.resolve({ found: true, replay: status({ replayId: "r1", seq: 3 }) });
    await tracker.settled();

    expect(tracker.tracked()).toEqual([{ key: "k3", input: "c" }]);
    expect(persisted.at(-1)).toEqual([{ key: "k3", input: "c" }]);
    expect(tracker.status("r1")?.state).toBe("failed");

    // The terminal batch can arrive before replay_request answers with the replayId.
    tracker.begin("k4", "d");
    tracker.handleEvent({
      type: "batch",
      items: [item(status({ replayId: "r4", seq: 12, state: "completed", dispatched: true }))],
      revision: "12",
    });
    tracker.accepted("k4", "r4");
    expect(tracker.tracked()).toEqual([{ key: "k3", input: "c" }]);
    expect(fake.calls.map((call) => call.replayId)).toEqual(["r1", "r2"]);
  });

  it("reconcile keeps at most 4 get_replay calls in flight and retries rejected ones on the next snapshot", async () => {
    const calls: Array<string> = [];
    let active = 0;
    let peak = 0;
    const tracker = createReplayTracker<string>({
      initial: Array.from({ length: 20 }, (_, index) => ({
        key: `k${index}`,
        input: "x",
        replayId: `r${index}`,
      })),
      getReplay: async (replayId) => {
        calls.push(replayId);
        peak = Math.max(peak, ++active);
        await Promise.resolve();
        active--;
        if (replayId === "r19") throw new Error("Too many requests in flight.");
        return { found: true, replay: status({ replayId, seq: 11, state: "completed" }) };
      },
      onTrackedChange: () => undefined,
    });

    tracker.handleEvent({ type: "snapshot", items: [captureItem], revision: "10", cursor: null });
    await tracker.settled();
    expect(peak).toBe(4);
    expect(new Set(calls).size).toBe(20);
    expect(tracker.tracked().map((entry) => entry.replayId)).toEqual(["r19"]);

    tracker.handleEvent({ type: "snapshot", items: [captureItem], revision: "20", cursor: null });
    expect(calls.at(-1)).toBe("r19");
  });
});
