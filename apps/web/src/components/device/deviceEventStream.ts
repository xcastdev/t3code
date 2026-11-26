const FRAME_LIMIT = 256 * 1024;
const DECODE_CHUNK_SIZE = 16 * 1024;

export async function readDeviceEventStream(
  response: Response,
  signal: AbortSignal,
  onMessage: (data: string) => void,
): Promise<void> {
  const body = response.body;
  if (body === null) return;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.ok || contentType !== "text/event-stream") {
    await body.cancel();
    return;
  }

  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let line = "";
  let event = "";
  let data: string[] = [];
  let size = 0;
  let previousCR = false;

  const readLine = () => {
    if (line === "") {
      if (!signal.aborted && data.length > 0 && (event === "" || event === "message")) {
        onMessage(data.join("\n"));
      }
      data = [];
      event = "";
      size = 0;
      return;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1));
    if (field === "event") event = value;
    if (field === "data") data.push(value);
    line = "";
  };

  const decode = (chunk: string) => {
    let start = previousCR && chunk.startsWith("\n") ? 1 : 0;
    previousCR = chunk.endsWith("\r");
    const append = (text: string, lineEnding = 0) => {
      size += text.length + lineEnding;
      if (size > FRAME_LIMIT) throw new Error("Device event stream frame is too large.");
      line += text;
    };
    const newline = /\r\n|[\r\n]/g;
    newline.lastIndex = start;
    for (const match of chunk.matchAll(newline)) {
      const end = match.index;
      append(chunk.slice(start, end), 1);
      readLine();
      start = end + match[0].length;
    }
    append(chunk.slice(start));
  };

  try {
    while (!signal.aborted) {
      const item = await reader.read();
      if (item.done || signal.aborted) break;
      for (
        let offset = 0;
        offset < item.value.length && !signal.aborted;
        offset += DECODE_CHUNK_SIZE
      ) {
        const chunk = decoder.decode(item.value.subarray(offset, offset + DECODE_CHUNK_SIZE), {
          stream: true,
        });
        if (chunk !== "") decode(chunk);
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
