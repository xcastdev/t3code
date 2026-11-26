import { RELAY_MEDIA_RANGE_BYTES } from "@t3tools/shared/relayMediaDownload";
import { describe, expect, it } from "vite-plus/test";
import { fetchRelayMediaRange, type RelayMediaReply } from "./relayMediaWindows.ts";

const WINDOW = RELAY_MEDIA_RANGE_BYTES;
const TOTAL = 2 * WINDOW + 1234;
const byteAt = (offset: number) => (offset * 31 + 7) % 251;

function serveFile(
  total = TOTAL,
  alter?: (range: string, reply: RelayMediaReply) => RelayMediaReply,
) {
  const ranges: Array<string | null> = [];
  const fetchWindow = async (range: string | null): Promise<RelayMediaReply> => {
    ranges.push(range);
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(range ?? "")!.map(Number) as number[];
    const end = Math.min(last!, total - 1);
    const bytes = Uint8Array.from({ length: end - first! + 1 }, (_, index) =>
      byteAt(first! + index),
    );
    const reply = {
      status: 206,
      headers: new Headers({
        "content-type": "video/mp4",
        "content-range": `bytes ${first}-${end}/${total}`,
        "content-length": String(bytes.length),
      }),
      body: new Blob([bytes]).stream(),
    };
    return alter ? alter(range!, reply) : reply;
  };
  return { ranges, fetchWindow };
}

describe("fetchRelayMediaRange", () => {
  it("answers an open-ended request with one full 206 built from bounded relay windows", async () => {
    const { ranges, fetchWindow } = serveFile();
    const reply = await fetchRelayMediaRange("bytes=100-", fetchWindow);

    expect(reply.status).toBe(206);
    expect(reply.headers.get("content-range")).toBe(`bytes 100-${TOTAL - 1}/${TOTAL}`);
    expect(reply.headers.get("content-length")).toBe(String(TOTAL - 100));
    const body = new Uint8Array(await new Response(reply.body).arrayBuffer());
    expect(body.length).toBe(TOTAL - 100);
    expect(body.every((value, index) => value === byteAt(100 + index))).toBe(true);
    expect(ranges).toEqual([
      `bytes=100-${100 + WINDOW - 1}`,
      `bytes=${100 + WINDOW}-${100 + 2 * WINDOW - 1}`,
      `bytes=${100 + 2 * WINDOW}-${TOTAL - 1}`,
    ]);
  });

  it("fetches only the first window until the player reads further", async () => {
    const { ranges, fetchWindow } = serveFile();
    const reply = await fetchRelayMediaRange("bytes=0-", fetchWindow);
    await reply.body!.cancel();
    expect(ranges).toEqual([`bytes=0-${WINDOW - 1}`]);
  });

  it("passes a range that fits one window straight through", async () => {
    const { ranges, fetchWindow } = serveFile();
    const reply = await fetchRelayMediaRange("bytes=0-1", fetchWindow);
    expect(reply.headers.get("content-range")).toBe(`bytes 0-1/${TOTAL}`);
    expect(ranges).toEqual(["bytes=0-1"]);
  });

  it("fails the stream when a later window belongs to a different file", async () => {
    const { fetchWindow } = serveFile(TOTAL, (range, reply) =>
      range.startsWith("bytes=0-")
        ? reply
        : { ...reply, headers: new Headers({ "content-range": `bytes ${WINDOW}-${WINDOW}/999` }) },
    );
    const reply = await fetchRelayMediaRange("bytes=0-", fetchWindow);
    await expect(new Response(reply.body).arrayBuffer()).rejects.toThrow();
  });

  it("refuses a first window that does not start at the requested byte", async () => {
    const { fetchWindow } = serveFile(TOTAL, (_range, reply) => ({
      ...reply,
      headers: new Headers({ "content-range": `bytes 0-${WINDOW - 1}/${TOTAL}` }),
    }));
    const reply = await fetchRelayMediaRange("bytes=5-", fetchWindow);
    expect(reply.status).toBe(502);
  });
});
