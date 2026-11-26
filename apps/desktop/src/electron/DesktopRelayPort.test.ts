// @effect-diagnostics nodeBuiltinImport:off -- Model Electron's main-process message port with Node's emitter.
import * as NodeEvents from "node:events";
import type { DesktopRelayEvent } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { serveDesktopRelayPort } from "./DesktopRelayPort.ts";
import type { DesktopRelayTransport } from "./DesktopRelayTransport.ts";

it("releases an unread completed HTTP response within the consumer idle bound", async () => {
  vi.useFakeTimers();
  const owner = new AbortController();
  const finished = vi.fn();
  let dispatched: AbortSignal | undefined;
  let responseReady!: () => void;
  const response = new Promise<void>((resolve) => {
    responseReady = resolve;
  });
  const port = new (class extends NodeEvents.EventEmitter {
    postMessage(event: DesktopRelayEvent) {
      if (event.type === "response") responseReady();
    }
    start() {}
    close() {
      this.emit("close");
    }
  })();
  const transport: DesktopRelayTransport = {
    origins: ["https://relay.example"],
    getBinding: () => undefined,
    request: async (_request, signal) => {
      dispatched = signal;
      return {
        status: 503,
        statusText: "Unavailable",
        headers: [],
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
      };
    },
    openSocket: async () => {
      throw new Error("Unexpected socket");
    },
  };
  try {
    serveDesktopRelayPort(
      port,
      transport,
      owner.signal,
      {
        kind: "http",
        url: "https://relay.example/api/auth/session",
        method: "GET",
        headers: [],
        body: false,
      },
      finished,
    );
    await response;
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(finished).toHaveBeenCalledOnce();
    expect(dispatched?.aborted).toBe(true);
  } finally {
    owner.abort();
    vi.useRealTimers();
  }
});
