import { describe, expect, it } from "vite-plus/test";

import type { T3PluginClient } from "@t3tools/plugin-sdk/ui";

import { createReplayModel } from "./replays.ts";
import { createPersistence, jsonBytes, sliceBytes } from "./state.ts";

const setup = (stored?: unknown) => {
  const saved: Array<Record<string, unknown>> = [];
  const client = {
    state: {
      set: async (value: Record<string, unknown>) => {
        saved.push(value);
      },
    },
    call: async () => ({ replayId: "r1" }),
  } as unknown as T3PluginClient;
  const persistence = createPersistence(client, stored);
  const model = createReplayModel(client, persistence);
  const last = () => saved.at(-1) ?? {};
  return { model, persistence, last };
};

describe("replay model persistence", () => {
  it("saves tab edits as typed, credential headers included", async () => {
    const { model, persistence, last } = setup();
    model.tabs.open("7");
    model.tabs.update("7", { edits: { headers: "Authorization: Bearer s3cret\nX-Keep: 1" } });
    await persistence.now();
    expect(last().replayer).toEqual({
      active: "7",
      tabs: [
        {
          requestId: "7",
          label: "Request 7",
          edits: { headers: "Authorization: Bearer s3cret\nX-Keep: 1" },
        },
      ],
    });
  });

  it("keeps each slice under its own cap, trimming tab edits and old history first", async () => {
    const history = Array.from({ length: 50 }, (_, index) => ({
      key: `k${index}`,
      label: "x".repeat(600),
      requestId: "7",
      at: index,
    }));
    const { model, persistence, last } = setup({ v: 1, replayHistory: history });
    for (let index = 0; index < 20; index += 1) {
      model.tabs.open(`${index}`);
      model.tabs.update(`${index}`, { edits: { url: "u".repeat(4000) } });
    }
    await persistence.now();
    const state = last();
    expect(jsonBytes(state.replayer)).toBeLessThanOrEqual(sliceBytes("replayer"));
    expect((state.replayer as { tabs: Array<unknown> }).tabs).toHaveLength(20);
    const keptHistory = state.replayHistory as Array<{ key: string }>;
    expect(jsonBytes(keptHistory)).toBeLessThanOrEqual(sliceBytes("replayHistory"));
    expect(keptHistory[0]?.key).toBe("k0");
    expect(keptHistory.length).toBeLessThan(50);
    expect(jsonBytes(state)).toBeLessThan(240 * 1024);
  });

  it("refuses a Send whose retry record would not fit", async () => {
    const { model } = setup();
    const send = (index: number) =>
      model.send(`key${index}`, {
        label: "POST /",
        request: {
          requestId: "7",
          idempotencyKey: `key${index}`,
          edits: { headers: [["X-Big", "b".repeat(30 * 1024)]] },
        },
      });
    expect(await send(0)).toBe("sent");
    const { model: full } = setup({
      v: 1,
      replays: Array.from({ length: 3 }, (_, index) => ({
        key: `held${index}`,
        input: {
          label: "POST /",
          request: {
            requestId: "7",
            idempotencyKey: `held${index}`,
            edits: { headers: [["X-Big", "b".repeat(30 * 1024)]] },
          },
        },
      })),
    });
    expect(
      await full.send("key9", {
        label: "POST /",
        request: {
          requestId: "7",
          idempotencyKey: "key9",
          edits: { headers: [["X-Big", "b".repeat(30 * 1024)]] },
        },
      }),
    ).toBe("not-kept");
  });
});
