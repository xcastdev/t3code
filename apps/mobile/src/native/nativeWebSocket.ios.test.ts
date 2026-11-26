import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import { onTestFinished, vi } from "vite-plus/test";

const savedEnrollment = vi.hoisted(() => ({
  value: null as string | null,
  relay: new Map<string, string>(),
}));

const expo = vi.hoisted(() => ({ native: null as object | null }));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => expo.native }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) =>
    key === "t3code.verified-routes.v1"
      ? savedEnrollment.value
      : (savedEnrollment.relay.get(key) ?? null),
  setItemAsync: async (key: string, value: string) => {
    if (key === "t3code.verified-routes.v1") savedEnrollment.value = value;
    else savedEnrollment.relay.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    savedEnrollment.relay.delete(key);
  },
}));

import {
  clearNativeRelayAdmission,
  installNativeRelayAdmission,
} from "../connection/relay-admission";
import {
  enrollVerifiedRoute,
  markVerificationRequired,
  readVerifiedRouteEnrollment,
} from "../connection/verified-route";
import * as NativeWebSocket from "./nativeWebSocket.ios";

function setup() {
  const listeners = new Map<string, (event: never) => void>();
  let nextId = 7;
  const native = {
    connect: vi.fn(() => nextId++),
    connectVerified: vi.fn(() => nextId++),
    connectVerifiedRelay: vi.fn(() => nextId++),
    sendText: vi.fn(),
    sendBinary: vi.fn(),
    close: vi.fn(),
    addListener: vi.fn((event: string, listener: (event: never) => void) => {
      listeners.set(event, listener);
      return { remove: () => listeners.delete(event) };
    }),
  } satisfies NativeWebSocket.NativeModule;
  const emit = (event: "open" | "message" | "error" | "close", payload: Record<string, unknown>) =>
    listeners.get(event)?.(payload as never);
  const sockets = new NativeWebSocket.Sockets(native);
  const events: Array<Record<string, unknown>> = [];
  const socket = new NativeWebSocket.Connection(sockets, "ws://host/ws", ["t3"]);
  for (const type of ["open", "message", "error", "close"] as const) {
    socket.addEventListener(type, (event) => events.push({ ...event }));
  }
  return { native, emit, socket, events, sockets, id: 7 };
}

describe("NativeWebSocket", () => {
  it("opens, then delivers text and binary frames as string and ArrayBuffer", () => {
    const { native, emit, socket, events, id } = setup();
    expect(native.connect).toHaveBeenCalledWith("ws://host/ws", ["t3"]);
    expect(socket.readyState).toBe(NativeWebSocket.Connection.CONNECTING);
    expect(() => socket.send("early")).toThrow(/connecting/);

    emit("open", { id });
    expect(socket.readyState).toBe(NativeWebSocket.Connection.OPEN);

    const bytes = new Uint8Array([1, 2, 3]);
    emit("message", { id, text: "hello" });
    emit("message", { id, data: bytes.subarray(1) });
    emit("message", { id: id + 1, text: "other socket" });
    expect(events).toEqual([
      { type: "open" },
      { type: "message", data: "hello" },
      { type: "message", data: new Uint8Array([2, 3]) },
    ]);

    socket.send("out");
    socket.send(bytes);
    expect(native.sendText).toHaveBeenCalledWith(id, "out");
    expect(native.sendBinary).toHaveBeenCalledWith(id, bytes);
  });

  it("uses the verified constructor for every upgrade to an enrolled origin", async () => {
    const { native, sockets } = setup();
    const origin = "https://relay.example.com:8443";
    const leafSpkiSha256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    await enrollVerifiedRoute({ httpsOrigin: origin, environmentId: "env", leafSpkiSha256 });

    for (const ticket of ["one", "two"]) {
      const url = `wss://relay.example.com:8443/ws?ticket=${ticket}`;
      const dialed = Promise.withResolvers<void>();
      native.connectVerified.mockImplementationOnce(() => {
        dialed.resolve();
        return ticket === "one" ? 8 : 9;
      });
      const socket = new NativeWebSocket.Connection(sockets, url, ["t3"]);
      await dialed.promise;
      expect(native.connectVerified).toHaveBeenLastCalledWith(url, ["t3"], origin, leafSpkiSha256);
      socket.close();
    }
    expect(native.connect).toHaveBeenCalledOnce();
    sockets.dispose();
  });

  it("refreshes relay admission on every pinned upgrade and refuses after clear", async () => {
    const { native, sockets } = setup();
    const origin = "https://admitted.example.com:8443";
    const leafSpkiSha256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const binding = { httpsOrigin: origin, environmentId: "env", leafSpkiSha256 };
    await enrollVerifiedRoute(binding);
    for (const ticket of ["one", "two"]) {
      await installNativeRelayAdmission(binding, `relay-${ticket}`);
      const url = `wss://admitted.example.com:8443/ws?ticket=${ticket}`;
      const dialed = Promise.withResolvers<void>();
      native.connectVerifiedRelay.mockImplementationOnce(() => {
        dialed.resolve();
        return ticket === "one" ? 8 : 9;
      });
      const socket = new NativeWebSocket.Connection(sockets, url, ["t3"]);
      await dialed.promise;
      expect(native.connectVerifiedRelay).toHaveBeenLastCalledWith(
        url,
        ["t3"],
        origin,
        leafSpkiSha256,
        `Bearer relay-${ticket}`,
      );
      socket.close();
    }
    await clearNativeRelayAdmission(binding);
    const socket = new NativeWebSocket.Connection(
      sockets,
      "wss://admitted.example.com:8443/ws?ticket=three",
      ["t3"],
    );
    const closed = Promise.withResolvers<Socket.WebSocketEvent>();
    socket.addEventListener("close", closed.resolve);
    expect(await closed.promise).toMatchObject({ code: 1006, wasClean: false });
    expect(native.connectVerifiedRelay).toHaveBeenCalledTimes(2);
    expect(native.connectVerified).not.toHaveBeenCalled();
    expect(native.connect).toHaveBeenCalledExactlyOnceWith("ws://host/ws", ["t3"]);
    sockets.dispose();
  });

  it.effect.each(["missing pin", "corrupt pin", "restored pin after clear"] as const)(
    "refuses a bare WSS ticket after a cold start with %s",
    (failure) =>
      Effect.gen(function* () {
        savedEnrollment.value = null;
        savedEnrollment.relay.clear();
        const origin = "https://cold-wss.test";
        const binding = {
          httpsOrigin: origin,
          environmentId: "env",
          leafSpkiSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        };
        yield* Effect.promise(() => enrollVerifiedRoute(binding));
        const pinOnly = savedEnrollment.value;
        if (failure === "restored pin after clear") {
          yield* Effect.promise(() => installNativeRelayAdmission(binding, "relay-session"));
          yield* Effect.promise(() => clearNativeRelayAdmission(binding));
          savedEnrollment.value = pinOnly;
        } else {
          savedEnrollment.value = failure === "missing pin" ? null : "{bad";
        }

        const { native, sockets } = setup();
        sockets.dispose();
        native.connect.mockClear();
        expo.native = native;
        const ordinary = vi.fn();
        vi.stubGlobal("WebSocket", ordinary);
        onTestFinished(() => {
          expo.native = null;
          vi.unstubAllGlobals();
        });
        vi.resetModules();
        const { layer } = yield* Effect.promise(() => import("./nativeWebSocket.ios"));
        yield* Effect.gen(function* () {
          const connect = yield* Socket.WebSocketConstructor;
          const attempted = Promise.withResolvers<void>();
          native.connect.mockImplementationOnce(() => {
            attempted.resolve();
            return 8;
          });
          native.connectVerified.mockImplementationOnce(() => {
            attempted.resolve();
            return 8;
          });
          native.connectVerifiedRelay.mockImplementationOnce(() => {
            attempted.resolve();
            return 8;
          });
          const socket = connect("wss://cold-wss.test/ws?ticket=signed", ["t3"]);
          const closed = Promise.withResolvers<Socket.WebSocketEvent>();
          socket.addEventListener("close", closed.resolve);
          expect(
            yield* Effect.promise(() => Promise.race([closed.promise, attempted.promise])),
          ).toMatchObject({
            code: 1006,
            wasClean: false,
          });
        }).pipe(Effect.provide(layer));
        expect(ordinary).not.toHaveBeenCalled();
        expect(native.connect).not.toHaveBeenCalled();
        expect(native.connectVerified).not.toHaveBeenCalled();
        expect(native.connectVerifiedRelay).not.toHaveBeenCalled();
      }),
  );

  it.effect.each(["missing", "unreadable"] as const)(
    "guards the global WSS fallback with a %s pin store",
    (pinStore) =>
      Effect.gen(function* () {
        savedEnrollment.value = pinStore === "missing" ? null : "{bad";
        savedEnrollment.relay.clear();
        savedEnrollment.relay.set(
          "t3code.verified-route-policy.v1",
          JSON.stringify({ "https://protected-global.test": "verified" }),
        );
        const ordinary = vi.fn(function OrdinaryWebSocket() {});
        vi.stubGlobal("WebSocket", ordinary);
        onTestFinished(() => {
          vi.unstubAllGlobals();
        });
        vi.resetModules();
        const { layer } = yield* Effect.promise(() => import("./nativeWebSocket.ios"));
        yield* Effect.gen(function* () {
          const connect = yield* Socket.WebSocketConstructor;
          expect(() => connect("wss://protected-global.test/ws?ticket=signed")).toThrow();
          expect(ordinary).not.toHaveBeenCalled();
          const direct = "wss://explicit-direct.test/ws";
          if (pinStore === "missing") {
            connect(direct);
            expect(ordinary).toHaveBeenCalledExactlyOnceWith(direct, undefined);
          } else {
            expect(() => connect(direct)).toThrow();
            expect(ordinary).not.toHaveBeenCalled();
          }
        }).pipe(Effect.provide(layer));
        savedEnrollment.value = null;
      }),
  );

  it("refuses ordinary WSS for a required origin or an explicitly verified ticket without a pin", async () => {
    const { native, sockets } = setup();
    native.connect.mockClear();
    const httpsOrigin = "https://missing-pin.test";
    savedEnrollment.value = null;
    await enrollVerifiedRoute({
      httpsOrigin,
      environmentId: "env",
      leafSpkiSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    const marked = "wss://missing-pin.test/ws?ticket=secret";
    markVerificationRequired(marked);
    savedEnrollment.value = "{corrupt";
    for (const [url, requireVerified] of [
      [marked, false],
      ["wss://unknown-issuer.test/ws?ticket=secret", true],
    ] as const) {
      const socket = new NativeWebSocket.Connection(sockets, url, [], { requireVerified });
      expect(native.connect).not.toHaveBeenCalled();
      const closed = Promise.withResolvers<Socket.WebSocketEvent>();
      socket.addEventListener("close", closed.resolve);
      expect(await closed.promise).toMatchObject({ code: 1006, wasClean: false });
    }
    expect(native.connect).not.toHaveBeenCalled();
    expect(native.connectVerified).not.toHaveBeenCalled();
    sockets.dispose();
  });

  it("never dials if closed during the verified enrollment lookup", async () => {
    const { native, sockets } = setup();
    const httpsOrigin = "https://cancel-preflight.test";
    savedEnrollment.value = null;
    await enrollVerifiedRoute({
      httpsOrigin,
      environmentId: "env",
      leafSpkiSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    const socket = new NativeWebSocket.Connection(sockets, "wss://cancel-preflight.test/ws");
    const closed = Promise.withResolvers<Socket.WebSocketEvent>();
    socket.addEventListener("close", closed.resolve);
    socket.close();
    expect(await closed.promise).toMatchObject({ code: 1006, wasClean: false });
    await readVerifiedRouteEnrollment(httpsOrigin);
    expect(native.connectVerified).not.toHaveBeenCalled();
    sockets.dispose();
  });

  it("reports the server's close frame once and ignores later events", () => {
    const { emit, socket, events, id } = setup();
    emit("open", { id });
    emit("close", { id, code: 1001, reason: "going away", wasClean: true });
    emit("close", { id, code: 1006, reason: "", wasClean: false });
    emit("message", { id, text: "late" });
    expect(socket.readyState).toBe(NativeWebSocket.Connection.CLOSED);
    expect(events.slice(1)).toEqual([
      { type: "close", code: 1001, reason: "going away", wasClean: true },
    ]);
  });

  it("fires error before close when the handshake fails", () => {
    const { emit, events, id } = setup();
    emit("error", { id, message: "connection refused" });
    emit("close", { id, code: 1006, reason: "", wasClean: false });
    expect(events).toEqual([
      { type: "error", message: "connection refused" },
      { type: "close", code: 1006, reason: "", wasClean: false },
    ]);
  });

  it("closes through the native module once and honours once listeners", () => {
    const { native, emit, socket, id } = setup();
    const once = vi.fn();
    const always = vi.fn();
    socket.addEventListener("close", once, { once: true });
    socket.addEventListener("close", always);
    socket.addEventListener("close", always);
    emit("open", { id });
    socket.close(1000, "done");
    socket.close(1000, "again");
    expect(socket.readyState).toBe(NativeWebSocket.Connection.CLOSING);
    expect(native.close).toHaveBeenCalledTimes(1);
    expect(native.close).toHaveBeenCalledWith(id, 1000, "done");
    expect(() => socket.send("after close")).not.toThrow();
    expect(native.sendText).not.toHaveBeenCalled();

    socket.removeEventListener("close", always);
    emit("close", { id, code: 1000, reason: "", wasClean: true });
    expect(once).toHaveBeenCalledTimes(1);
    expect(always).not.toHaveBeenCalled();
  });

  it("forwards close while connecting and drops a late upgrade event", () => {
    const { native, emit, socket, events, id } = setup();
    socket.close();
    expect(native.close).toHaveBeenCalledExactlyOnceWith(id, 1000, "");
    emit("open", { id });
    emit("message", { id, text: "late" });
    expect(socket.readyState).toBe(NativeWebSocket.Connection.CLOSING);
    emit("close", { id, code: 1006, reason: "", wasClean: false });
    expect(events).toEqual([{ type: "close", code: 1006, reason: "", wasClean: false }]);
    expect(socket.readyState).toBe(NativeWebSocket.Connection.CLOSED);
  });

  it("closes open sockets and stops listening when disposed", () => {
    const { native, emit, socket, sockets, events, id } = setup();
    emit("open", { id });
    sockets.dispose();
    expect(native.close).toHaveBeenCalledWith(id, 1001, "");
    expect(socket.readyState).toBe(NativeWebSocket.Connection.CLOSED);
    expect(events.at(-1)).toEqual({ type: "close", code: 1001, reason: "", wasClean: false });
    expect(emit("message", { id, text: "late" })).toBeUndefined();
  });

  it.effect("surfaces a server close through Effect's socket as SocketCloseError", () =>
    Effect.gen(function* () {
      const { emit, socket, id } = setup();
      emit("open", { id });
      const effectSocket = yield* Socket.fromWebSocket(Effect.succeed(socket));
      const reader = yield* effectSocket.reader;
      emit("message", { id, text: "hi" });
      emit("close", { id, code: 1011, reason: "boom", wasClean: true });
      expect(yield* reader.pull).toEqual(["hi"]);
      const error = yield* Effect.flip(reader.pull);
      expect(error.reason).toMatchObject({
        _tag: "SocketCloseError",
        code: 1011,
        closeReason: "boom",
      });
    }),
  );
});
