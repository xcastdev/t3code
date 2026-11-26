import { boundRelayMediaRange } from "@t3tools/shared/relayMediaDownload";

export interface RelayMediaReply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
}

type FetchWindow = (range: string | null) => Promise<RelayMediaReply>;

const contentRangePattern = /^bytes (\d+)-(\d+)\/(\d+)$/;

function windowOf(reply: RelayMediaReply) {
  const match = contentRangePattern.exec(reply.headers.get("content-range") ?? "");
  if (reply.status !== 206 || reply.body === null || !match) return null;
  const [first, last, total] = match.slice(1).map(Number) as [number, number, number];
  return first <= last && last < total ? { first, last, total } : null;
}

/**
 * Chromium's media loader behind `protocol.handle` cannot splice a short 206 into an open-ended
 * request, so the relay hops stay bounded while Chromium receives the one response it asked for.
 */
export async function fetchRelayMediaRange(
  range: string | null,
  fetchWindow: FetchWindow,
): Promise<RelayMediaReply> {
  const bounded = boundRelayMediaRange(range);
  const first = await fetchWindow(bounded);
  if (bounded === range) return first;
  const opened = windowOf(first);
  const requested = /^bytes=(\d+)-(\d*)$/.exec(range ?? "");
  if (opened === null || requested === null || opened.first !== Number(requested[1])) {
    await first.body?.cancel();
    return { status: 502, headers: new Headers(), body: null };
  }
  const { total } = opened;
  const last = Math.min(requested[2] === "" ? total - 1 : Number(requested[2]), total - 1);

  let reader = first.body!.getReader();
  let expected = opened;
  let position = opened.first;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (!done) {
              position += value.byteLength;
              if (position > expected.last + 1) throw new Error("Relay media window overran.");
              controller.enqueue(value);
              return;
            }
            if (position !== expected.last + 1) throw new Error("Relay media window ended early.");
            if (position > last) {
              controller.close();
              return;
            }
            const next = await fetchWindow(boundRelayMediaRange(`bytes=${position}-${last}`));
            const window = windowOf(next);
            if (
              window === null ||
              window.first !== position ||
              window.last > last ||
              window.total !== total
            ) {
              await next.body?.cancel();
              throw new Error("Relay media window did not continue the file.");
            }
            expected = window;
            reader = next.body!.getReader();
          }
        } catch (error) {
          controller.error(error);
          await reader.cancel().catch(() => undefined);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  const headers = new Headers(first.headers);
  headers.set("content-range", `bytes ${opened.first}-${last}/${total}`);
  headers.set("content-length", String(last - opened.first + 1));
  return { status: 206, headers, body };
}
