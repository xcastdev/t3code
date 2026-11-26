import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

export const RELAY_MEDIA_RANGE_BYTES = 8 * 1024 ** 2;
export const RELAY_MEDIA_DOWNLOAD_MS = 10 * 60_000;
export const RELAY_MEDIA_DOWNLOAD_HEADER = "x-t3-media-download";
export const RELAY_MEDIA_DOWNLOAD_VALUE = "sha-256";
export const relayMediaDownloadETag = /^"sha256-([0-9a-f]{64})-([0-9a-f]{64})"$/;

/**
 * Players open media with `bytes=N-`; the relay refuses responses over its size cap, so ask for one
 * bounded window and let the player request the next one after the short 206.
 */
export function boundRelayMediaRange(range: string | null): string | null {
  const parts = range === null ? null : /^bytes=(\d{1,15})-(\d{0,15})$/.exec(range);
  if (!parts) return range;
  const first = Number(parts[1]);
  const last = first + RELAY_MEDIA_RANGE_BYTES - 1;
  return parts[2] === "" || Number(parts[2]) > last ? `bytes=${first}-${last}` : range;
}

const mimeTypePattern = /^[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+(?:\s*;[^,]+)?$/;

interface RangeReply<Chunk extends Uint8Array> {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Chunk> | null;
}

type RangeRequest = {
  readonly range: string;
  readonly "if-range"?: string;
  readonly [RELAY_MEDIA_DOWNLOAD_HEADER]: typeof RELAY_MEDIA_DOWNLOAD_VALUE;
};
type Representation = {
  readonly total: number;
  readonly mimeType: string;
  readonly etag: string;
};

const invalidRange = () => new Error("The environment did not return the requested file range.");
const changedFile = () => new Error("The file changed or its revision could not be verified.");

export async function openRelayMediaDownload<Chunk extends Uint8Array>(
  request: (headers: RangeRequest, signal: AbortSignal) => Promise<RangeReply<Chunk>>,
  options: { readonly signal: AbortSignal; readonly maxBytes: number; readonly tooLarge?: string },
) {
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  const tooLarge = () =>
    new Error(options.tooLarge ?? "This file exceeds the download size limit.");

  async function openRange(start: number, previous?: Representation) {
    signal.throwIfAborted();
    const requestedEnd = Math.min(
      start + RELAY_MEDIA_RANGE_BYTES - 1,
      (previous?.total ?? RELAY_MEDIA_RANGE_BYTES) - 1,
    );
    const range = `bytes=${start}-${requestedEnd}`;
    const { body, headers, status } = await request(
      {
        range,
        [RELAY_MEDIA_DOWNLOAD_HEADER]: RELAY_MEDIA_DOWNLOAD_VALUE,
        ...(previous ? { "if-range": previous.etag } : {}),
      },
      signal,
    );
    try {
      signal.throwIfAborted();
      if (previous && status !== 206) throw changedFile();
      if (status === 413) throw tooLarge();
      const contentRange = headers.get("content-range");
      const declared = headers.get("content-length");
      const mimeType = headers.get("content-type");
      const encoding = headers.get("content-encoding");
      const etag = headers.get("etag");
      const length = declared !== null && /^\d+$/.test(declared) ? Number(declared) : NaN;
      if (
        !body ||
        !Number.isSafeInteger(length) ||
        length > RELAY_MEDIA_RANGE_BYTES ||
        mimeType === null ||
        !mimeTypePattern.test(mimeType) ||
        /^multipart\//i.test(mimeType) ||
        (encoding !== null && encoding.toLowerCase() !== "identity")
      )
        throw invalidRange();

      let total = length;
      let end = length - 1;
      if (status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
        if (!match) throw invalidRange();
        total = Number(match[3]);
        end = Math.min(requestedEnd, total - 1);
        if (
          !Number.isSafeInteger(total) ||
          end < start ||
          contentRange !== `bytes ${start}-${end}/${total}` ||
          length !== end - start + 1
        )
          throw invalidRange();
      } else if (status !== 200 || contentRange !== null) {
        throw invalidRange();
      }

      if (
        previous &&
        (total !== previous.total || mimeType !== previous.mimeType || etag !== previous.etag)
      ) {
        throw changedFile();
      }
      if (total > options.maxBytes) throw tooLarge();
      const digest = etag === null ? undefined : relayMediaDownloadETag.exec(etag)?.[1];
      if (etag === null || digest === undefined) {
        throw new Error("The environment did not return a verifiable file digest.");
      }
      return { total, mimeType, etag, digest, end, length, reader: body.getReader() };
    } catch (error) {
      void body?.cancel(error).catch(() => undefined);
      throw error;
    }
  }

  const first = await openRange(0);
  const hash = sha256.create();
  let active = first;
  let received = 0;
  const abort = () => {
    void active.reader.cancel(signal.reason).catch(() => undefined);
  };
  const finish = () => {
    signal.removeEventListener("abort", abort);
    hash.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  const body = new ReadableStream<Chunk>(
    {
      async pull(controller) {
        try {
          while (true) {
            signal.throwIfAborted();
            const { done, value } = await active.reader.read();
            signal.throwIfAborted();
            if (!done) {
              received += value.byteLength;
              if (received > active.length) throw invalidRange();
              hash.update(value);
              controller.enqueue(value);
              return;
            }
            if (received !== active.length) throw invalidRange();
            active.reader.releaseLock();
            if (active.end + 1 === first.total) {
              // The destination commits only after this stream reaches EOF.
              if (bytesToHex(hash.digest()) !== first.digest) throw changedFile();
              finish();
              controller.close();
              return;
            }
            active = await openRange(active.end + 1, first);
            received = 0;
            if (signal.aborted) abort();
          }
        } catch (error) {
          stop.abort(error);
          finish();
          active.reader.releaseLock();
          controller.error(error);
        }
      },
      cancel(reason) {
        stop.abort(reason);
        finish();
        active.reader.releaseLock();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, length: first.total, mimeType: first.mimeType };
}
