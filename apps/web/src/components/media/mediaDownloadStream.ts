export async function writeMediaDownload(
  response: Response,
  openDestination: (length: number | null) => Promise<WritableStream<Uint8Array<ArrayBuffer>>>,
  maxBytes: number,
  signal: AbortSignal,
  tooLarge = "This file exceeds the download size limit.",
): Promise<void> {
  const { body, headers, status } = response;
  if (body === null) throw new Error("The environment did not return a file.");
  try {
    if (status !== 200 || headers.has("content-range")) {
      throw new Error("The environment did not return a complete file.");
    }
    const declared = headers.get("content-length");
    const length = declared === null ? null : Number(declared);
    if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(length))) {
      throw new Error("The environment returned an invalid file size.");
    }
    if (length !== null && length > maxBytes) throw new Error(tooLarge);

    signal.throwIfAborted();
    const writer = (await openDestination(length)).getWriter();
    const reader = body.getReader();
    let rejectAbort!: (reason: unknown) => void;
    const canceled = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
      void writer.abort(signal.reason).catch(() => undefined);
      rejectAbort(signal.reason);
    };
    try {
      signal.throwIfAborted();
      signal.addEventListener("abort", abort, { once: true });
      let size = 0;
      while (true) {
        const next = await Promise.race([reader.read(), canceled]);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) throw new Error(tooLarge);
        if (length !== null && size > length) {
          throw new Error("The file size did not match the response.");
        }
        await Promise.race([writer.write(next.value), canceled]);
      }
      signal.throwIfAborted();
      if (length !== null && length !== size)
        throw new Error("The file size did not match the response.");
      await Promise.race([writer.close(), canceled]);
    } catch (error) {
      void reader.cancel(error).catch(() => undefined);
      void writer.abort(error).catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
      writer.releaseLock();
    }
  } finally {
    void body.cancel().catch(() => undefined);
  }
}
