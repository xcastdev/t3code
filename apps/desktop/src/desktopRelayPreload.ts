import { ipcRenderer } from "electron";
import type { DesktopRelayBridge, DesktopRelayEvent } from "@t3tools/contracts";
import * as IpcChannels from "./ipc/channels.ts";

export function makeDesktopRelayBridge(): DesktopRelayBridge {
  let origins: readonly string[] = [];
  try {
    const configured: unknown = ipcRenderer.sendSync(IpcChannels.RELAY_TRANSPORT_ORIGINS_CHANNEL);
    if (Array.isArray(configured))
      origins = configured.filter((value) => typeof value === "string");
  } catch {}
  let active = 0;
  const maxChunk = 64 * 1024;
  const maxSocketBytes = 16 * 1024 * 1024;
  const encoder = new TextEncoder();
  return {
    origins,
    open(exchange, receive) {
      if (
        active >= 24 ||
        typeof exchange.url !== "string" ||
        exchange.url.length > 32_768 ||
        (exchange.kind === "http" &&
          (exchange.headers.length > 24 ||
            exchange.headers.reduce((size, [name, value]) => size + name.length + value.length, 0) >
              maxChunk)) ||
        (exchange.kind === "socket" &&
          (exchange.protocols.length > 16 ||
            exchange.protocols.some((value) => typeof value !== "string" || value.length > 128)))
      ) {
        throw new Error("Invalid desktop relay exchange.");
      }
      const { port1, port2 } = new MessageChannel();
      active += 1;
      let closed = false;
      let pullPending = false;
      let uploadCredit = false;
      let pendingSends = 0;
      let pendingSendBytes = 0;
      const close = () => {
        if (closed) return;
        closed = true;
        active -= 1;
        port1.close();
      };
      port1.onmessage = ({ data }: MessageEvent<DesktopRelayEvent>) => {
        if (closed) return;
        if (data.type === "bytes" || data.type === "message") pullPending = false;
        if (data.type === "uploadPull") uploadCredit = true;
        if (data.type === "sent") {
          pendingSends -= 1;
          pendingSendBytes -= data.bytes;
        }
        const done =
          data.type === "error" ||
          data.type === "end" ||
          data.type === "close" ||
          (data.type === "response" && !data.body);
        try {
          receive(data);
        } finally {
          if (done) close();
        }
      };
      port1.addEventListener("close", () => {
        if (closed) return;
        close();
        receive({
          type: "error",
          outcomeUnknown:
            exchange.kind === "http" && exchange.method !== "GET" && exchange.method !== "HEAD",
        });
      });
      try {
        ipcRenderer.postMessage(IpcChannels.RELAY_TRANSPORT_OPEN_CHANNEL, exchange, [port2]);
      } catch (error) {
        close();
        throw error;
      }
      return (command) => {
        if (closed) return;
        switch (command.type) {
          case "pull":
            if (pullPending) return;
            pullPending = true;
            break;
          case "upload":
          case "uploadEnd":
            if (
              !uploadCredit ||
              (command.type === "upload" &&
                (!(command.bytes instanceof Uint8Array) || command.bytes.byteLength > maxChunk))
            )
              return;
            uploadCredit = false;
            break;
          case "send": {
            if (typeof command.data !== "string" && !(command.data instanceof Uint8Array)) return;
            if (
              pendingSends >= 128 ||
              (typeof command.data === "string" && command.data.length > maxSocketBytes)
            )
              return;
            const size =
              typeof command.data === "string"
                ? encoder.encode(command.data).byteLength
                : command.data.byteLength;
            if (pendingSendBytes + size > maxSocketBytes) return;
            pendingSendBytes += size;
            pendingSends += 1;
            break;
          }
          case "close":
            if (typeof command.reason !== "string" || command.reason.length > 123) return;
            break;
        }
        const outgoing =
          command.type === "upload"
            ? { type: "upload", bytes: command.bytes }
            : command.type === "send"
              ? { type: "send", data: command.data }
              : command.type === "close"
                ? { type: "close", code: command.code, reason: command.reason }
                : { type: command.type };
        port1.postMessage(outgoing);
        if (command.type === "abort") close();
      };
    },
    createMediaLease: (url, kind) =>
      ipcRenderer.invoke(IpcChannels.RELAY_MEDIA_CREATE_CHANNEL, url, kind),
    disposeMediaLease: (url) => ipcRenderer.invoke(IpcChannels.RELAY_MEDIA_DISPOSE_CHANNEL, url),
    saveMedia: async (url, suggestedName) => {
      await ipcRenderer.invoke(IpcChannels.RELAY_MEDIA_SAVE_CHANNEL, url, suggestedName);
    },
  };
}
