import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  type DesktopRelayEvent,
  type DesktopRelayExchange,
} from "@t3tools/contracts";
import { readDeviceEventStream } from "./deviceEventStream";
import {
  appendDeviceEventLog,
  DEVICE_EVENT_LOG_LIMIT,
  type DeviceEventLogEntry,
  fetchDeviceAxTree,
  subscribeDeviceForeground,
} from "./deviceHubApi";

const renew = vi.hoisted(() => vi.fn());
vi.mock("~/state/device", () => ({ renewDeviceHubAccess: renew }));

describe("foreground app events", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])(
    "renews media access after stream closure (temporary renewal failure: %s) and stops on disposal",
    async (firstFailure) => {
      vi.useFakeTimers();
      const origin = "https://desktop-relay.example.test";
      const environmentId = EnvironmentId.make("stream-renewal");
      const access = {
        environmentId,
        httpBase: origin + "/api/device-hub",
        wsBase: origin.replace("https:", "wss:") + "/api/device-hub",
        query: { wsTicket: "old", hostId: "host" },
        credentials: false,
      };
      renew
        .mockReset()
        .mockResolvedValue({ ...access, query: { ...access.query, wsTicket: "fresh" } });
      if (firstFailure) renew.mockResolvedValueOnce(null);
      const first = Promise.withResolvers<(event: DesktopRelayEvent) => void>();
      const second = Promise.withResolvers<(event: DesktopRelayEvent) => void>();
      const pulls = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      let count = 0;
      const requests: DesktopRelayExchange[] = [];
      vi.stubGlobal("window", {
        location: { href: "http://localhost/" },
        desktopBridge: {
          relayTransport: {
            origins: [origin],
            open(input: DesktopRelayExchange, receive: (event: DesktopRelayEvent) => void) {
              const index = count++;
              requests.push(input);
              (index === 0 ? first : second).resolve(receive);
              return (command: { type: string }) => {
                if (command.type === "pull") pulls[index]?.resolve();
              };
            },
          },
        },
      });
      const update = Promise.withResolvers<unknown>();
      const stop = subscribeDeviceForeground(
        { access, platform: "ios", deviceId: "sim" },
        update.resolve,
      );
      try {
        const receiveFirst = await first.promise;
        receiveFirst({
          type: "response",
          status: 200,
          statusText: "OK",
          headers: [["content-type", "text/event-stream"]],
          body: true,
        });
        await pulls[0]!.promise;
        receiveFirst({ type: "end" });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(renew).toHaveBeenCalledExactlyOnceWith(environmentId, "host");
        if (firstFailure) {
          await vi.advanceTimersByTimeAsync(2_000);
          expect(renew).toHaveBeenCalledTimes(2);
        }
        const receiveSecond = await second.promise;
        expect(requests[1]).toMatchObject({ url: expect.stringContaining("wsTicket=fresh") });
        receiveSecond({
          type: "response",
          status: 200,
          statusText: "OK",
          headers: [["content-type", "text/event-stream"]],
          body: true,
        });
        await pulls[1]!.promise;
        receiveSecond({
          type: "bytes",
          bytes: new TextEncoder().encode('data: {"bundleId":"com.example.fresh"}\n\n'),
        });
        expect(await update.promise).toEqual({ id: "com.example.fresh" });
        stop();
        receiveSecond({ type: "end" });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(requests).toHaveLength(2);
      } finally {
        stop();
        vi.useRealTimers();
      }
    },
  );

  it("uses the Electron main sender for enrolled relay events and cancels its port", async () => {
    const origin = "https://desktop-relay.example.test";
    const opened = Promise.withResolvers<(event: DesktopRelayEvent) => void>();
    const pulling = Promise.withResolvers<void>();
    const send = vi.fn((command: { type: string }) => {
      if (command.type === "pull") pulling.resolve();
    });
    const open = vi.fn(
      (_request: DesktopRelayExchange, receive: (event: DesktopRelayEvent) => void) => {
        opened.resolve(receive);
        return send;
      },
    );
    vi.stubGlobal("window", {
      location: { href: "http://localhost/" },
      desktopBridge: { relayTransport: { origins: [origin], open } },
    });
    const onApp = Promise.withResolvers<unknown>();
    const stop = subscribeDeviceForeground(
      {
        access: {
          httpBase: origin + "/api/device-hub",
          wsBase: "wss://desktop-relay.example.test/api/device-hub",
          credentials: false,
          query: { wsTicket: "device+ticket" },
        },
        platform: "ios",
        deviceId: "sim",
      },
      onApp.resolve,
    );
    const receive = await opened.promise;
    expect(open).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "http",
        method: "GET",
        url:
          origin + "/api/device-hub/vendor/serve-sim/appstate?device=sim&wsTicket=device%2Bticket",
        headers: [["accept", "text/event-stream"]],
        body: false,
      },
      expect.any(Function),
    );
    receive({
      type: "response",
      status: 200,
      statusText: "OK",
      body: true,
      headers: [["content-type", "text/event-stream"]],
    });
    await pulling.promise;
    receive({ type: "bytes", bytes: new TextEncoder().encode('data: {"bundleId":null}\n\n') });
    expect(await onApp.promise).toBeNull();
    stop();
    expect(send).toHaveBeenCalledWith({ type: "abort" });
  });

  it("clears the last app when it exits and ignores malformed events", () => {
    let source: FakeEventSource;
    class FakeEventSource {
      onmessage: ((event: { data: string }) => void) | null = null;
      addEventListener(_type: string, listener: (event: { data: string }) => void) {
        this.onmessage = listener;
      }
      close = vi.fn();
      constructor() {
        source = this;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const onChange = vi.fn();
    const stop = subscribeDeviceForeground(
      {
        platform: "ios",
        deviceId: "test",
        access: { httpBase: "http://test", wsBase: "ws://test", query: {}, credentials: true },
      },
      onChange,
    );
    const emit = (data: unknown) => source.onmessage?.({ data: JSON.stringify(data) });
    emit({ bundleId: "com.example.app", pid: 123 });
    emit({ bundleId: null });
    emit({ bundleId: "com.example.other" });
    emit({ bundleId: "" });
    emit({ other: "not app state" });
    expect(onChange.mock.calls.map(([app]) => app)).toEqual([
      { id: "com.example.app", pid: 123 },
      null,
      { id: "com.example.other" },
      null,
    ]);
    stop();
    expect(source!.close).toHaveBeenCalledOnce();
  });
});

describe("event log buffer", () => {
  const entry = (id: number): DeviceEventLogEntry => ({ id, timestamp: "", kind: "", summary: "" });

  it("replaces the log on a reset batch and keeps only the newest entries", () => {
    const full = Array.from({ length: DEVICE_EVENT_LOG_LIMIT }, (_, index) => entry(index));
    const appended = appendDeviceEventLog(full, [entry(DEVICE_EVENT_LOG_LIMIT)], false);
    expect(appended).toHaveLength(DEVICE_EVENT_LOG_LIMIT);
    expect(appended[0]?.id).toBe(1);
    expect(appended.at(-1)?.id).toBe(DEVICE_EVENT_LOG_LIMIT);
    expect(appendDeviceEventLog(full, [entry(7)], true)).toEqual([entry(7)]);
  });
});

it("cancels unread Device JSON error responses", async () => {
  const cancel = vi.fn();
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 503 }));
  await expect(
    fetchDeviceAxTree({
      access: {
        httpBase: "https://direct.example.test/api/device-hub",
        wsBase: "",
        query: {},
        credentials: false,
      },
      platform: "ios",
      deviceId: "sim",
    }),
  ).rejects.toThrow("503");
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels an oversized SSE frame without delivering partial data", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(controller) {
      const encode = (line: string) => new TextEncoder().encode(line);
      controller.enqueue(encode("data: " + "a".repeat(150_000) + "\n"));
      controller.enqueue(encode("data: " + "b".repeat(150_000) + "\n\n"));
    },
    cancel,
  });
  const onMessage = vi.fn();
  await expect(
    readDeviceEventStream(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      new AbortController().signal,
      onMessage,
    ),
  ).rejects.toThrow("too large");
  expect(onMessage).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});
