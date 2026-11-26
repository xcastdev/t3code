import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Socket from "effect/socket/Socket";
import { requireOptionalNativeModule } from "expo";
import {
  assertRelayAdmissionEndpoint,
  readNativeRelayAdmission,
} from "../connection/relay-admission";
import {
  initializeVerifiedRoutes,
  readVerifiedRouteForDispatch,
  routeOrigin,
  verificationRequiredFor,
} from "../connection/verified-route";
import { bytesFromBase64 } from "./verifiedNetwork";

type EventType = "open" | "message" | "error" | "close";

interface NativeEvents {
  readonly open: { readonly id: number };
  readonly message: {
    readonly id: number;
    readonly text?: string;
    readonly data?: Uint8Array;
    readonly dataBase64?: string;
  };
  readonly error: { readonly id: number; readonly message: string };
  readonly close: {
    readonly id: number;
    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;
  };
}

export interface NativeModule {
  connect?(url: string, protocols: ReadonlyArray<string>): number;
  connectVerified?(
    url: string,
    protocols: ReadonlyArray<string>,
    origin: string,
    pin: string,
  ): number;
  connectVerifiedRelay?(
    url: string,
    protocols: ReadonlyArray<string>,
    origin: string,
    pin: string,
    relayAuthorization: string,
  ): number;
  sendText(id: number, text: string): void;
  sendBinary(id: number, bytes: Uint8Array): void;
  close(id: number, code: number, reason: string): void;
  addListener<K extends keyof NativeEvents>(
    event: K,
    listener: (event: NativeEvents[K]) => void,
  ): { remove(): void };
}

interface Listener {
  readonly listener: (event: Socket.WebSocketEvent) => void;
  readonly once: boolean;
}

/** Subset of the WHATWG WebSocket API that Effect's socket layer touches, over the native module. */
export class Connection implements Socket.WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState: number = Connection.CONNECTING;

  #id: number | undefined;
  readonly #sockets: Sockets;
  readonly #listeners = new Map<EventType, Array<Listener>>();

  constructor(
    sockets: Sockets,
    url: string,
    protocols?: string | ReadonlyArray<string>,
    options?: { readonly requireVerified?: boolean },
  ) {
    this.url = url;
    this.#sockets = sockets;
    const offered =
      protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : protocols;
    if (
      options?.requireVerified ||
      verificationRequiredFor(url) ||
      routeOrigin(url)?.startsWith("https:")
    ) {
      sockets.trackPending(this);
      void this.#connect(offered, options?.requireVerified);
    } else {
      if (!sockets.native.connect) throw new Error("Native WebSocket is unavailable.");
      this.#id = sockets.native.connect(url, offered);
      sockets.register(this.#id, this);
    }
  }

  async #connect(
    protocols: ReadonlyArray<string>,
    requireVerified: boolean | undefined,
  ): Promise<void> {
    const { native } = this.#sockets;
    try {
      const binding = await readVerifiedRouteForDispatch(this.url, requireVerified);
      if (this.readyState !== Connection.CONNECTING) return;
      if (binding === null) {
        if (!native.connect) throw new Error("Native WebSocket is unavailable.");
        this.#id = native.connect(this.url, protocols);
        this.#sockets.register(this.#id, this);
        return;
      }
      const credential = await readNativeRelayAdmission(binding);
      if (this.readyState !== Connection.CONNECTING) return;
      const args = [this.url, protocols, binding.httpsOrigin, binding.leafSpkiSha256] as const;
      if (credential === null) {
        if (!native.connectVerified) throw new Error("Verified WebSocket is unavailable.");
        this.#id = native.connectVerified(...args);
      } else {
        assertRelayAdmissionEndpoint(binding, this.url, "wss:");
        if (!native.connectVerifiedRelay) {
          throw new Error("Update the mobile app to use relay admission.");
        }
        this.#id = native.connectVerifiedRelay(...args, `Bearer ${Redacted.value(credential)}`);
      }
      this.#sockets.register(this.#id, this);
    } catch (error) {
      if (this.readyState !== Connection.CONNECTING) return;
      this.#dispatch("error", {
        type: "error",
        message: error instanceof Error ? error.message : "Verified WebSocket failed.",
      });
      this.#finish(1006, "", false);
    }
  }

  addEventListener(
    type: EventType,
    listener: (event: Socket.WebSocketEvent) => void,
    options?: { readonly once?: boolean },
  ): void {
    const entries = this.#listeners.get(type) ?? [];
    if (entries.some((entry) => entry.listener === listener)) return;
    entries.push({ listener, once: options?.once === true });
    this.#listeners.set(type, entries);
  }

  removeEventListener(type: EventType, listener: (event: Socket.WebSocketEvent) => void): void {
    const entries = this.#listeners.get(type);
    if (entries === undefined) return;
    this.#listeners.set(
      type,
      entries.filter((entry) => entry.listener !== listener),
    );
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    if (this.readyState === Connection.CONNECTING) {
      throw new Error("InvalidStateError: WebSocket is still connecting");
    }
    // Browsers drop writes after close instead of throwing.
    if (this.readyState !== Connection.OPEN || this.#id === undefined) return;
    if (typeof data === "string") {
      this.#sockets.native.sendText(this.#id, data);
    } else {
      this.#sockets.native.sendBinary(this.#id, data);
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= Connection.CLOSING) return;
    this.readyState = Connection.CLOSING;
    if (this.#id === undefined) queueMicrotask(() => this.#finish(1006, "", false));
    else this.#sockets.native.close(this.#id, code, reason);
  }

  handleOpen(_event: NativeEvents["open"]): void {
    if (this.readyState !== Connection.CONNECTING) return;
    this.readyState = Connection.OPEN;
    this.#dispatch("open", { type: "open" });
  }

  handleMessage(event: NativeEvents["message"]): void {
    if (this.readyState !== Connection.OPEN) return;
    this.#dispatch("message", {
      type: "message",
      data:
        event.text ??
        event.data ??
        (event.dataBase64 === undefined ? undefined : bytesFromBase64(event.dataBase64)),
    });
  }

  handleError(event: NativeEvents["error"]): void {
    if (this.readyState === Connection.CLOSED) return;
    this.#dispatch("error", { type: "error", message: event.message });
  }

  handleClose(event: NativeEvents["close"]): void {
    this.#finish(event.code, event.reason, event.wasClean);
  }

  #finish(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === Connection.CLOSED) return;
    this.readyState = Connection.CLOSED;
    this.#sockets.unregister(this.#id, this);
    this.#dispatch("close", { type: "close", code, reason, wasClean });
  }

  #dispatch(type: EventType, event: Socket.WebSocketEvent & Record<string, unknown>): void {
    const entries = this.#listeners.get(type);
    if (entries === undefined || entries.length === 0) return;
    this.#listeners.set(
      type,
      entries.filter((entry) => !entry.once),
    );
    for (const entry of entries) entry.listener(event);
  }
}

/** Routes the module's per-id events to the sockets that own them. Native assigns the ids, so a reload cannot reuse one. */
export class Sockets {
  readonly native: NativeModule;
  readonly #open = new Map<number, Connection>();
  readonly #pending = new Set<Connection>();
  readonly #subscriptions: ReadonlyArray<{ remove(): void }>;

  constructor(native: NativeModule) {
    this.native = native;
    this.#subscriptions = [
      native.addListener("open", (event) => this.#open.get(event.id)?.handleOpen(event)),
      native.addListener("message", (event) => this.#open.get(event.id)?.handleMessage(event)),
      native.addListener("error", (event) => this.#open.get(event.id)?.handleError(event)),
      native.addListener("close", (event) => this.#open.get(event.id)?.handleClose(event)),
    ];
  }

  trackPending(socket: Connection): void {
    this.#pending.add(socket);
  }

  register(id: number, socket: Connection): void {
    this.#pending.delete(socket);
    this.#open.set(id, socket);
  }

  unregister(id: number | undefined, socket: Connection): void {
    if (id === undefined) this.#pending.delete(socket);
    else this.#open.delete(id);
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) subscription.remove();
    for (const socket of [...this.#pending, ...this.#open.values()]) {
      socket.close(1001);
      socket.handleClose({ id: 0, code: 1001, reason: "", wasClean: false });
    }
  }
}

export function layerFromModule(moduleName: string) {
  const native = requireOptionalNativeModule<NativeModule>(moduleName);
  return Layer.effect(
    Socket.WebSocketConstructor,
    Effect.gen(function* () {
      const direct = yield* Socket.WebSocketConstructor;
      const sockets =
        native === null
          ? null
          : yield* Effect.acquireRelease(
              Effect.sync(() => new Sockets(native)),
              (sockets) => Effect.sync(() => sockets.dispose()),
            );
      const initialized = yield* Effect.tryPromise({
        try: initializeVerifiedRoutes,
        catch: () => "verified-route-unavailable" as const,
      }).pipe(Effect.isSuccess);
      const construct: typeof direct = (url, options) => {
        if (!sockets?.native.connect && !verificationRequiredFor(url)) return direct(url, options);
        if (!sockets) {
          throw new Error(
            initialized
              ? "Verified WebSocket is unavailable."
              : "Verified route enrollment is unavailable.",
          );
        }
        if (options !== undefined && typeof options !== "string" && !Array.isArray(options)) {
          throw new TypeError("WebSocket client options are not supported by the native WebSocket");
        }
        return new Connection(sockets, url, options);
      };
      return construct;
    }),
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
}
