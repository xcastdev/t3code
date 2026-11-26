import { PREVIEW_ASSET_WIDGET_MAX_MESSAGE_BYTES } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createPreviewStreamClient, type PreviewStreamControl } from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = {
      ...agent,
      controller: "you" as const,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });

  it("binds the widget bridge to its one ready socket and disposes before reconnect", () => {
    vi.useFakeTimers();
    let client: ReturnType<typeof createPreviewStreamClient> | undefined;
    try {
      const verifiedAssetUrl = "https://relay.test/api/assets/signed.token/panel.html";
      const handlers = [0, 1].map(() => ({ receive: vi.fn(), dispose: vi.fn() }));
      const widgetHasActivation = vi.fn(() => false);
      const posts: Array<(data: unknown) => void> = [];
      const connectWidget = vi.fn((post: (data: unknown) => void) => {
        const handler = handlers[posts.length];
        posts.push(post);
        if (!handler) throw new Error("Unexpected widget bridge");
        return handler;
      });
      client = createPreviewStreamClient(
        {
          ...target,
          asset: {
            type: "openAsset",
            widget: "plugin-panel",
            appearance: "dark",
            verifiedAssetUrl,
          },
        },
        {
          onFrame: vi.fn(),
          onViewport: vi.fn(),
          onConnectedChange: vi.fn(),
          onUnauthorized: vi.fn(),
          connectWidget,
          widgetHasActivation,
        },
      );
      const first = FakeSocket.current;
      first.dispatchEvent(new Event("open"));
      expect(new URL(first.url).searchParams.has("asset")).toBe(true);
      expect(first.url).not.toContain("signed.token");
      expect(JSON.parse(first.sent[0]!)).toMatchObject({
        widget: "plugin-panel",
        verifiedAssetUrl,
      });
      first.message('{"type":"widgetReady","kind":"mcp-app"}');
      first.message('{"type":"widgetMessage","data":{"id":0}}');
      expect(connectWidget).not.toHaveBeenCalled();
      first.message('{"type":"widgetReady","kind":"plugin-panel"}');
      first.message('{"type":"widgetReady","kind":"plugin-panel"}');
      first.message('{"type":"widgetMessage","data":{"id":1},"activated":true}');
      expect(connectWidget).toHaveBeenCalledTimes(1);
      expect(handlers[0]?.receive).toHaveBeenCalledExactlyOnceWith({ id: 1 }, false);
      posts[0]?.({ id: 1, result: {} });
      expect(first.sent).toContain('{"type":"widgetMessage","data":{"id":1,"result":{}}}');
      first.control({ ...agent, controller: "you" });
      const press = {
        type: "key",
        action: "down",
        key: "Enter",
        code: "Enter",
        modifiers: 0,
      } as const;
      expect(client.send(press, true)).toBe(true);
      first.message('{"type":"widgetMessage","data":{"id":2},"gesture":1}');
      expect(handlers[0]?.receive).toHaveBeenLastCalledWith({ id: 2 }, false);
      widgetHasActivation.mockReturnValue(true);
      expect(client.send(press, true)).toBe(true);
      first.message('{"type":"widgetMessage","data":{"id":3},"gesture":2}');
      first.message('{"type":"widgetMessage","data":{"id":4},"gesture":2}');
      expect(handlers[0]?.receive).toHaveBeenNthCalledWith(3, { id: 3 }, true);
      expect(handlers[0]?.receive).toHaveBeenLastCalledWith({ id: 4 }, false);

      first.dispatchEvent(Object.assign(new Event("close"), { code: 1012 }));
      expect(handlers[0]?.dispose).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      const second = FakeSocket.current;
      expect(second).not.toBe(first);
      second.dispatchEvent(new Event("open"));
      second.message('{"type":"widgetReady","kind":"plugin-panel"}');
      posts[0]?.({ stale: true });
      first.message('{"type":"widgetMessage","data":{"stale":true}}');
      expect(second.sent).toHaveLength(1);
      expect(handlers[1]?.receive).not.toHaveBeenCalled();
      client.stop();
      expect(handlers[1]?.dispose).toHaveBeenCalledTimes(1);
    } finally {
      client?.stop();
      vi.useRealTimers();
    }
  });

  it("returns a bounded MCP error for oversized widget replies", () => {
    let post!: (data: unknown) => void;
    const client = createPreviewStreamClient(
      {
        ...target,
        asset: {
          type: "openAsset",
          widget: "mcp-app",
          appearance: "dark",
          verifiedAssetUrl: "https://relay.test/api/assets/signed.token/app.html",
        },
      },
      {
        onFrame: vi.fn(),
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
        connectWidget: (send) => {
          post = send;
          return { receive: vi.fn(), dispose: vi.fn() };
        },
      },
    );
    try {
      const socket = FakeSocket.current;
      socket.message('{"type":"widgetReady","kind":"mcp-app"}');
      const large = "é".repeat(PREVIEW_ASSET_WIDGET_MAX_MESSAGE_BYTES / 2);
      post({ jsonrpc: "2.0", id: "resource", result: { contents: [{ text: large }] } });
      post({ jsonrpc: "2.0", id: 42, result: { content: [{ type: "text", text: large }] } });
      post({ jsonrpc: "2.0", id: "failure", error: { code: -32000, message: large } });
      expect(socket.sent.map((message) => message.length < 256)).toEqual([true, true, true]);
      expect(socket.sent.map((message) => JSON.parse(message))).toEqual(
        ["resource", 42, "failure"].map((id) => ({
          type: "widgetMessage",
          data: {
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "MCP app response exceeds 1 MiB." },
          },
        })),
      );
    } finally {
      client.stop();
    }
  });

  it("withdraws an offered file picker when the stream drops or stops", () => {
    const onFileChooser = vi.fn();
    const events = {
      onFrame: vi.fn(),
      onFileChooser,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    };
    const client = createPreviewStreamClient(target, events);
    const socket = FakeSocket.current;
    socket.dispatchEvent(new Event("open"));
    socket.message(
      JSON.stringify({
        type: "fileChooser",
        id: "c1",
        requestId: "picker",
        multiple: false,
        accept: "",
      }),
    );
    expect(onFileChooser).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: "picker" }),
    );
    socket.dispatchEvent(Object.assign(new Event("close"), { code: 1012 }));
    expect(onFileChooser).toHaveBeenLastCalledWith(null);
    client.stop();

    const restarted = createPreviewStreamClient(target, events);
    FakeSocket.current.message(
      JSON.stringify({
        type: "fileChooser",
        id: "c2",
        requestId: "picker",
        multiple: false,
        accept: "",
      }),
    );
    expect(onFileChooser).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestId: "picker",
        uploadUrl: expect.stringContaining("chooser=c2"),
      }),
    );
    restarted.stop();
    expect(onFileChooser).toHaveBeenLastCalledWith(null);
  });
});

describe("preview stream downloads", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download at a URL carrying the stream's ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      fileName: "a b.csv",
      sizeBytes: 3,
      url: "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=ticket",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });
});
