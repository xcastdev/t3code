export type MediaDestination = "audio" | "video";
export type MediaMethod = "GET" | "HEAD";

const MAX_MEDIA_BYTES = 16 * 1024 ** 3;

function byteCount(value: string) {
  if (!/^\d{1,12}$/.test(value)) return null;
  const count = Number(value);
  return count <= MAX_MEDIA_BYTES ? count : null;
}

function parseRange(value: string) {
  const parts = /^bytes=(\d{0,12})-(\d{0,12})$/.exec(value);
  if (!parts) return null;
  const first = parts[1] ? byteCount(parts[1]) : null;
  const last = parts[2] ? byteCount(parts[2]) : null;
  if ((parts[1] && first === null) || (parts[2] && last === null)) return null;
  if (first === null ? !last : last !== null && first > last) return null;
  return { first, last };
}

export function isMediaRange(value: string | null): boolean {
  return value === null || parseRange(value) !== null;
}

function boundedMediaBody(body: ReadableStream<Uint8Array>, length: number | null) {
  const reader = body.getReader();
  let size = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            if (length !== null && size !== length) throw new Error("Incomplete media response.");
            controller.close();
            return;
          }
          size += value.byteLength;
          if (size > (length ?? MAX_MEDIA_BYTES))
            throw new Error("Media response exceeds its limit.");
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
          await reader.cancel().catch(() => undefined);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

export function mediaResponse(
  response: Response,
  method: MediaMethod,
  rangeHeader: string | null,
  destination: MediaDestination,
) {
  const range = rangeHeader === null ? null : parseRange(rangeHeader);
  if (rangeHeader !== null && range === null) return null;
  const { status } = response;
  const contentRange = response.headers.get("content-range");
  const headers: Record<string, string> = {};
  if (status === 416) {
    const unsatisfied = /^bytes \*\/(\d+)$/.exec(contentRange ?? "");
    const total = unsatisfied ? byteCount(unsatisfied[1]!) : null;
    if (range === null || total === null || (total > 0 && (range.first ?? 0) < total)) {
      return null;
    }
    headers["content-range"] = contentRange!;
    headers["accept-ranges"] = "bytes";
    return { status, headers, body: null };
  }

  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    !type ||
    (!type.startsWith(`${destination}/`) &&
      type !== "application/ogg" &&
      type !== "application/octet-stream")
  ) {
    return null;
  }

  const declaredLength = response.headers.get("content-length");
  let length = declaredLength === null ? null : byteCount(declaredLength);
  if (declaredLength !== null && length === null) return null;
  if (status === 206 && range !== null) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
    if (!match) return null;
    const first = byteCount(match[1]!);
    const last = byteCount(match[2]!);
    const total = byteCount(match[3]!);
    if (first === null || last === null || total === null || first > last || last >= total) {
      return null;
    }
    const expectedFirst = range.first ?? Math.max(0, total - range.last!);
    const expectedLast =
      range.first === null ? total - 1 : Math.min(total - 1, range.last ?? total - 1);
    if (first !== expectedFirst || last !== expectedLast) return null;
    const actualLength = last - first + 1;
    if (length !== null && length !== actualLength) return null;
    length = actualLength;
    headers["content-range"] = contentRange!;
    headers["accept-ranges"] = "bytes";
  } else if (status === 200 && contentRange === null && (range === null || method === "HEAD")) {
    if (response.headers.get("accept-ranges") === "bytes") headers["accept-ranges"] = "bytes";
  } else {
    return null;
  }

  if (method === "GET" && response.body === null) return null;
  headers["content-type"] = type;
  if (length !== null) headers["content-length"] = String(length);
  const body = method === "GET" && response.body ? boundedMediaBody(response.body, length) : null;
  return { status, headers, body };
}
