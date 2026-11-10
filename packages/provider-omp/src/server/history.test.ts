import { expect, it } from "@effect/vitest";
import { OmpHistory } from "./history.ts";
it("reconciles append identities and leaf ancestry, resyncs unknown cursors and rejects corrupt branch graphs", async () => {
  const history = new OmpHistory();
  const all = [
    { id: "u", parentId: null, type: "message", message: { role: "user", content: "hello" } },
    {
      id: "a",
      parentId: "u",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
    },
    { id: "x", parentId: "u", type: "future_entry" },
  ];
  const calls: Record<string, unknown>[] = [];
  await history.refresh(async (r) => {
    calls.push(r);
    return { entries: all, leafId: "a" };
  });
  expect(history.branch().map((e) => e.id)).toEqual(["u", "a"]);
  let first = true;
  await history.refresh(async (r) => {
    calls.push(r);
    if (first) {
      first = false;
      throw new Error("unknown_since");
    }
    return { entries: all, leafId: "x" };
  });
  expect(history.branch().map((e) => e.id)).toEqual(["u", "x"]);
  expect(calls.at(-1)).toEqual({ type: "get_entries" });
  expect(() =>
    history.apply(
      { entries: [{ id: "bad", parentId: "bad", type: "future" }], leafId: "bad" },
      true,
    ),
  ).toThrow();
});

it("rebuilds stable native message identities and paginated messages after a stale cursor", async () => {
  const { nativeMessageBaseKey, historyMessages, readOmpMessages } = await import("./history.ts");
  const message = {
    role: "assistant",
    timestamp: 123,
    provider: "p",
    model: "m",
    content: [{ type: "text", text: "one" }],
  };
  const entries = [
    { id: "a", parentId: null, type: "message", timestamp: "2026-11-04T00:00:00Z", message },
    {
      id: "b",
      parentId: "a",
      type: "message",
      message: { ...message, content: [{ type: "text", text: "two" }] },
    },
  ];
  const rebuilt = historyMessages(entries);
  expect(rebuilt.map((m) => m.key)).toEqual([
    nativeMessageBaseKey(message) + ":0",
    nativeMessageBaseKey(message) + ":1",
  ]);
  expect(rebuilt.map((m) => m.text)).toEqual(["one", "two"]);
  let request = 0;
  const messages = await readOmpMessages(async (record) => {
    request++;
    if (request === 1) return { messages: ["old"], nextCursor: "stale" };
    if (request === 2) throw new Error("stale_cursor");
    expect(record.cursor).toBeUndefined();
    return { messages: ["fresh"] };
  });
  expect(messages).toEqual(["fresh"]);
});
