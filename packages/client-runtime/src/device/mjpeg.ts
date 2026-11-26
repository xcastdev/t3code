const MAX_HEADER = 16 * 1024;
const MAX_FRAME = 16 * 1024 * 1024;

export async function* readMjpegFrames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const header = new Uint8Array(MAX_HEADER);
  let headerSize = 0;
  let frame: Uint8Array<ArrayBuffer> | undefined;
  let frameSize = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      let offset = 0;
      while (offset < value.length) {
        if (frame !== undefined) {
          const size = Math.min(frame.length - frameSize, value.length - offset);
          frame.set(value.subarray(offset, offset + size), frameSize);
          frameSize += size;
          offset += size;
          if (frameSize === frame.length) {
            yield frame;
            frame = undefined;
            frameSize = 0;
          }
          continue;
        }
        if (headerSize >= MAX_HEADER) throw new Error("Invalid MJPEG header");
        header[headerSize++] = value[offset++]!;
        if (
          headerSize < 4 ||
          header[headerSize - 4] !== 13 ||
          header[headerSize - 3] !== 10 ||
          header[headerSize - 2] !== 13 ||
          header[headerSize - 1] !== 10
        )
          continue;
        const fields = decoder.decode(header.subarray(0, headerSize)).trimStart();
        const length = Number(/^content-length:[ \t]*(\d+)[ \t]*\r?$/im.exec(fields)?.[1]);
        if (!fields.startsWith("--") || !(length > 0 && length <= MAX_FRAME)) {
          throw new Error("Invalid MJPEG frame length");
        }
        frame = new Uint8Array(length);
        headerSize = 0;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
