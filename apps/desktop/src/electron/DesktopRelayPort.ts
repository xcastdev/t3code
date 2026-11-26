// @effect-diagnostics globalTimers:off -- Electron's callback-owned port releases its native idle timer on close.
import type { DesktopRelayEvent } from "@t3tools/contracts";
import type { MessagePortMain } from "electron";
import {
  DESKTOP_RELAY_CHUNK,
  DESKTOP_RELAY_HTTP_LIMIT,
  DESKTOP_RELAY_SOCKET_LIMIT,
  parseRelayHttp,
  parseRelaySocket,
} from "./DesktopRelayPolicy.ts";
import type { DesktopRelayTransport } from "./DesktopRelayTransport.ts";

const invalid = () => new Error("Desktop relay exchange failed.");
type Credit<T> = { readonly receive: (value: T) => void; readonly fail: () => void };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function serveDesktopRelayPort(
  port: MessagePortMain,
  transport: DesktopRelayTransport,
  ownerSignal: AbortSignal,
  input: unknown,
  onFinish: () => void,
) {
  const controller = new AbortController();
  const signal = controller.signal;
  let outcomeUnknown = false;
  let finished = false;
  let consumerDeadline: ReturnType<typeof setTimeout> | undefined;
  let onCommand: (command: Record<string, unknown>) => void = () => {
    throw invalid();
  };
  const post = (event: DesktopRelayEvent) => {
    if (!finished) port.postMessage(event);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    if (consumerDeadline !== undefined) clearTimeout(consumerDeadline);
    ownerSignal.removeEventListener("abort", finish);
    controller.abort();
    port.close();
    onFinish();
  };
  const fail = () => {
    post({ type: "error", outcomeUnknown });
    finish();
  };

  port.on("message", ({ data }: { data: unknown }) => {
    if (finished) return;
    if (!isObject(data)) {
      fail();
      return;
    }
    if (data.type === "abort") {
      finish();
      return;
    }
    try {
      onCommand(data);
    } catch {
      fail();
    }
  });
  port.once("close", finish);
  port.start();
  if (ownerSignal.aborted) {
    finish();
    return;
  }
  ownerSignal.addEventListener("abort", finish, { once: true });

  async function serveHttp(parsed: NonNullable<ReturnType<typeof parseRelayHttp>>) {
    let credit: Credit<Uint8Array | null> | undefined;
    let uploadSize = 0;
    let pulling = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let remainder: Uint8Array | undefined;
    const awaitConsumer = () => {
      if (consumerDeadline !== undefined) clearTimeout(consumerDeadline);
      consumerDeadline = setTimeout(fail, 90_000);
      consumerDeadline.unref();
    };
    async function* upload(): AsyncGenerator<Uint8Array> {
      while (!signal.aborted) {
        const chunk = await new Promise<Uint8Array | null>((receive, reject) => {
          credit = { receive, fail: () => reject(invalid()) };
          post({ type: "uploadPull" });
        });
        if (chunk === null) return;
        yield chunk;
      }
    }
    const pull = async () => {
      if (reader === undefined || pulling) throw invalid();
      awaitConsumer();
      pulling = true;
      if (remainder === undefined) {
        const item = await reader.read();
        if (item.done) {
          post({ type: "end" });
          finish();
          return;
        }
        remainder = item.value;
      }
      const chunk = remainder.subarray(0, DESKTOP_RELAY_CHUNK);
      remainder = remainder.length > chunk.length ? remainder.subarray(chunk.length) : undefined;
      pulling = false;
      post({ type: "bytes", bytes: new Uint8Array(chunk) });
    };
    signal.addEventListener(
      "abort",
      () => {
        credit?.fail();
        void reader?.cancel().catch(() => {});
      },
      { once: true },
    );
    onCommand = (command) => {
      if (command.type === "pull") {
        void pull().catch(fail);
        return;
      }
      if (credit === undefined) throw invalid();
      if (command.type === "uploadEnd") {
        credit.receive(null);
        credit = undefined;
        return;
      }
      if (
        command.type !== "upload" ||
        !(command.bytes instanceof Uint8Array) ||
        command.bytes.byteLength === 0 ||
        command.bytes.byteLength > DESKTOP_RELAY_CHUNK
      )
        throw invalid();
      uploadSize += command.bytes.byteLength;
      if (uploadSize > DESKTOP_RELAY_HTTP_LIMIT) throw invalid();
      credit.receive(command.bytes);
      credit = undefined;
    };
    const result = await transport.request(
      parsed,
      signal,
      parsed.body ? upload() : undefined,
      () => {
        outcomeUnknown = parsed.method !== "GET" && parsed.method !== "HEAD";
      },
    );
    if (finished) {
      await result.body?.cancel();
      return;
    }
    reader = result.body?.getReader();
    if (reader !== undefined) awaitConsumer();
    post({ ...result, type: "response", body: reader !== undefined });
    if (reader === undefined) finish();
  }

  async function serveSocket(parsed: NonNullable<ReturnType<typeof parseRelaySocket>>) {
    let socket: Awaited<ReturnType<DesktopRelayTransport["openSocket"]>> | undefined;
    let sendBytes = 0;
    let sendFrames = 0;
    let receiveBytes = 0;
    let receiveCredit = false;
    let receivedClose: Extract<DesktopRelayEvent, { type: "close" }> | undefined;
    const queue: { readonly data: string | Uint8Array; readonly bytes: number }[] = [];
    const deliver = () => {
      if (!receiveCredit) return;
      const next = queue.shift();
      if (next === undefined) {
        if (receivedClose) {
          post(receivedClose);
          finish();
        } else socket?.resume();
        return;
      }
      receiveBytes -= next.bytes;
      receiveCredit = false;
      post({ type: "message", data: next.data });
    };
    onCommand = (command) => {
      if (
        command.type === "close" &&
        typeof command.code === "number" &&
        typeof command.reason === "string" &&
        (command.code === 1000 ||
          (Number.isInteger(command.code) && command.code >= 3000 && command.code <= 4999)) &&
        Buffer.byteLength(command.reason) <= 123
      ) {
        if (socket === undefined || socket.readyState === 0) {
          post({ type: "close", code: 1006, reason: "" });
          finish();
        } else socket.close(command.code, command.reason);
        return;
      }
      if (command.type === "pull") {
        if (receiveCredit) throw invalid();
        receiveCredit = true;
        deliver();
        return;
      }
      const data = command.data;
      if (
        command.type !== "send" ||
        socket?.readyState !== 1 ||
        (typeof data !== "string" && !(data instanceof Uint8Array))
      )
        throw invalid();
      const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      sendBytes += bytes;
      sendFrames += 1;
      if (sendBytes > DESKTOP_RELAY_SOCKET_LIMIT || sendFrames > 128) throw invalid();
      socket.send(data, (error) => {
        if (error) {
          fail();
          return;
        }
        sendBytes -= bytes;
        sendFrames -= 1;
        post({ type: "sent", bytes });
      });
    };
    const opened = await transport.openSocket(parsed, signal);
    socket = opened;
    opened.on("error", fail);
    opened.on("open", () => {
      post({ type: "open", protocol: opened.protocol, extensions: opened.extensions });
    });
    opened.on("message", (data: Buffer, isBinary) => {
      opened.pause();
      receiveBytes += data.byteLength;
      if (receiveBytes > DESKTOP_RELAY_SOCKET_LIMIT || queue.length >= 128) {
        fail();
        return;
      }
      queue.push({
        data: isBinary ? new Uint8Array(data) : data.toString("utf8"),
        bytes: data.byteLength,
      });
      deliver();
    });
    opened.on("close", (code, reason) => {
      receivedClose = { type: "close", code, reason: reason.toString("utf8") };
      if (queue.length === 0) {
        post(receivedClose);
        finish();
      } else deliver();
    });
    if (finished) opened.terminate();
  }

  if (isObject(input) && input.kind === "http") {
    const parsed = parseRelayHttp({
      kind: "http",
      url: input.url,
      method: input.method,
      headers: input.headers,
      body: input.body,
      redirect: input.redirect,
    });
    if (parsed !== null) {
      void serveHttp(parsed).catch(fail);
      return;
    }
  }
  if (
    isObject(input) &&
    input.kind === "socket" &&
    !("headers" in input) &&
    !("redirect" in input)
  ) {
    const parsed = parseRelaySocket({ url: input.url, protocols: input.protocols });
    if (parsed !== null) {
      void serveSocket(parsed).catch(fail);
      return;
    }
  }
  fail();
}
