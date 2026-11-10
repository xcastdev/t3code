import { expect, it } from "vite-plus/test";
import { OmpProtocolDecoder, MAX_OMP_REASSEMBLED_BYTES } from "./protocol.ts";
const encode = (x: unknown) => new TextEncoder().encode(JSON.stringify(x) + "\n");
const ready = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
};
function setup() {
  const d = new OmpProtocolDecoder();
  expect([...d.push(encode(ready))]).toEqual([ready]);
  d.enableV2();
  return d;
}
function chunks(bytes: Uint8Array) {
  const size = 256 * 1024;
  return Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) => ({
    type: "rpc_chunk",
    chunkId: "rpc-1",
    index,
    count: Math.ceil(bytes.length / size),
    byteLength: bytes.length,
    data: Buffer.from(bytes.subarray(index * size, (index + 1) * size)).toString("base64"),
  }));
}
it("preserves partial UTF-8 and Unicode separators and delivers terminal payloads unchanged", () => {
  const d = setup();
  const frame = {
    type: "agent_end",
    messages: [{ text: "日本語😀\u2028\u2029" }],
    messageCount: 4,
  };
  const bytes = encode(frame);
  const out = [];
  for (const byte of bytes) out.push(...d.push(Uint8Array.of(byte)));
  expect(out).toEqual([frame]);
  d.end();
  const large = {
    type: "response",
    id: "x",
    command: "get_messages",
    success: true,
    data: "😀".repeat(270000),
  };
  const result = chunks(new TextEncoder().encode(JSON.stringify(large))).flatMap((c) => [
    ...d.push(encode(c)),
  ]);
  expect(result).toEqual([large]);
  d.end();
});
it("rejects metadata, base64, interleaving, truncation, oversized and non-UTF-8 records without dropping a completion", () => {
  const records = chunks(
    new TextEncoder().encode(JSON.stringify({ type: "agent_end", text: "x".repeat(1100000) })),
  );
  for (const patch of [
    { chunkId: "" },
    { count: 1 },
    { count: NaN },
    { index: 1 },
    { index: -1 },
    { byteLength: MAX_OMP_REASSEMBLED_BYTES + 1 },
    { data: "!!!!" },
    { data: "Zh==" },
    { data: "" },
  ])
    expect(() => [...setup().push(encode({ ...records[0], ...patch }))]).toThrow();
  for (const next of [
    { type: "message_end" },
    { ...records[1], chunkId: "different" },
    { ...records[1], index: 2 },
  ]) {
    const d = setup();
    expect([...d.push(encode(records[0]))]).toEqual([]);
    expect(() => [...d.push(encode(next))]).toThrow();
  }
  const d = setup();
  Array.from(d.push(encode(records[0])));
  expect(() => d.end()).toThrow(/incomplete/);
  expect(() => [...setup().push(new Uint8Array([0xff, 10]))]).toThrow();
  expect(() => [...setup().push(new TextEncoder().encode("x".repeat(1024 * 1024)))]).toThrow(
    /limit/,
  );
  expect(() => [
    ...setup().push(encode({ type: "rpc_frame_error", originalType: "agent_end" })),
  ]).toThrow();
  const trailing = setup();
  Array.from(trailing.push(new TextEncoder().encode('{"type":"agent_end"}')));
  expect(() => trailing.end()).toThrow(/incomplete/);
  const invalid = records.map((r, i) => ({
    ...r,
    data: i === 0 ? Buffer.alloc(256 * 1024, 0xff).toString("base64") : r.data,
  }));
  const utf = setup();
  expect(() => invalid.flatMap((c) => [...utf.push(encode(c))])).toThrow();
});
it("requires compatible readiness and explicit v2 and caps advertised budgets", () => {
  for (const patch of [
    { protocolVersion: 2 },
    { supportedProtocolVersions: [1] },
    { maxFrameBytes: 0 },
    { maxReassembledFrameBytes: Infinity },
  ])
    expect(() => [...new OmpProtocolDecoder().push(encode({ ...ready, ...patch }))]).toThrow();
  const d = new OmpProtocolDecoder();
  Array.from(d.push(encode(ready)));
  expect(() => [...d.push(encode({ type: "rpc_chunk" }))]).toThrow(/negotiat/);
  const cap = setup();
  expect(() => [
    ...cap.push(
      encode({
        type: "rpc_chunk",
        chunkId: "x",
        index: 0,
        count: 200,
        byteLength: 50 * 1024 * 1024,
        data: "AA==",
      }),
    ),
  ]).toThrow(/metadata/);
});

it("writes a large Unicode host result as one bounded LF command across byte writes", async () => {
  const { encodeOmpInput } = await import("./protocol.ts");
  const value = {
    type: "host_tool_result",
    id: "image-call",
    result: { content: [{ type: "text", text: "日本語😀".repeat(200000) }] },
  };
  const frames = [...encodeOmpInput(JSON.stringify(value))];
  expect(frames.length).toBeGreaterThan(1);
  expect(frames.every((f) => f.length <= 256 * 1024)).toBe(true);
  const line = Buffer.concat(frames).toString("utf8");
  expect(line.endsWith("\n")).toBe(true);
  expect(line.split("\n")).toHaveLength(2);
  expect(JSON.parse(line)).toEqual(value);
  expect(() => [...encodeOmpInput("x".repeat(MAX_OMP_REASSEMBLED_BYTES + 1))]).toThrow();
});
