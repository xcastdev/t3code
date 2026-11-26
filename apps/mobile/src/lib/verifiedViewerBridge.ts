import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import { verificationRequiredFor, verifiedRouteFor } from "../connection/verified-route";
import { Connection, Sockets, type NativeModule } from "../native/nativeWebSocketBridge";
import { bytesFromBase64, requestVerifiedRoute } from "../native/verifiedNetwork";
import { viewerEndpoint } from "./verifiedViewerScope";

export function viewerUsesVerifiedRoute(access: DeviceHubAccess): boolean {
  return verificationRequiredFor(access.httpBase) || verificationRequiredFor(access.wsBase);
}

export function verifiedViewerEndpoint(
  access: DeviceHubAccess,
  url: string,
  transport: "http" | "ws",
): URL | null {
  const endpoint = viewerEndpoint(access, url, transport);
  const issuer = verifiedRouteFor(access.httpBase);
  if (!endpoint || !issuer || verifiedRouteFor(access.wsBase) !== issuer) return null;
  return verifiedRouteFor(endpoint.href) === issuer ? endpoint : null;
}

type RequestState = { controller: AbortController; acknowledge?: () => void };

function base64(bytes: Uint8Array): string {
  let data = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    data += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(data);
}

export function createVerifiedViewerBridge(
  access: DeviceHubAccess,
  inject: (script: string) => void,
) {
  let sockets: Sockets | undefined;
  const connections = new Map<number, Connection>();
  const requests = new Map<number, RequestState>();
  let stopped = false;
  const reply = (id: number, payload: object) => {
    if (stopped) return;
    inject(`window.T3VerifiedViewer?.(${id},${JSON.stringify(payload)}); true;`);
  };

  function onMessage(data: string): boolean {
    if (!data.startsWith('{"viewerTransport":')) return false;
    if (stopped) return true;
    try {
      const {
        viewerTransport: type,
        id,
        url,
        method,
        headers,
        body,
        text,
        binary,
      } = JSON.parse(data) as Record<string, unknown>;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return true;
      switch (type) {
        case "connect": {
          if (connections.has(id) || connections.size >= 8) break;
          const endpoint = typeof url === "string" && verifiedViewerEndpoint(access, url, "ws");
          if (!endpoint) {
            reply(id, { type: "close", code: 1006 });
            break;
          }
          const native =
            sockets?.native ??
            requireOptionalNativeModule<NativeModule>(
              Platform.OS === "ios" ? "T3WebSocket" : "T3VerifiedNetwork",
            );
          if (!native?.connectVerified) {
            reply(id, { type: "close", code: 1006 });
            break;
          }
          try {
            sockets ??= new Sockets(native);
            const socket = new Connection(sockets, endpoint.href, undefined, {
              requireVerified: true,
            });
            connections.set(id, socket);
            socket.addEventListener("open", () => reply(id, { type: "open" }));
            socket.addEventListener("message", (event) => {
              if (!("data" in event)) return;
              const data = event.data;
              if (typeof data === "string") reply(id, { type: "message", text: data });
              if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
                const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                reply(id, { type: "message", binary: base64(bytes) });
              }
            });
            socket.addEventListener("close", (event) => {
              connections.delete(id);
              reply(id, { ...event, type: "close" });
            });
          } catch {
            reply(id, { type: "close", code: 1006 });
          }
          break;
        }
        case "send": {
          const socket = connections.get(id);
          if (typeof text === "string") socket?.send(text);
          else if (typeof binary === "string") socket?.send(bytesFromBase64(binary));
          break;
        }
        case "close":
          connections.get(id)?.close();
          break;
        case "fetch": {
          if (requests.has(id) || requests.size >= 8) {
            reply(id, { type: "failure" });
            break;
          }
          const endpoint = typeof url === "string" && verifiedViewerEndpoint(access, url, "http");
          if (!endpoint || (method !== "GET" && method !== "POST")) {
            reply(id, { type: "failure" });
            break;
          }
          const state: RequestState = { controller: new AbortController() };
          requests.set(id, state);
          const stream = method === "GET" && /\/stream\.(?:avcc|mjpeg)$/.test(endpoint.pathname);
          const requestHeaders = new Headers();
          if (Array.isArray(headers)) {
            for (const header of headers) {
              if (
                Array.isArray(header) &&
                header[0] === "content-type" &&
                typeof header[1] === "string"
              ) {
                requestHeaders.set("content-type", header[1]);
              }
            }
          }
          void requestVerifiedRoute(endpoint.href, {
            requireVerified: true,
            method,
            headers: requestHeaders,
            body: typeof body === "string" ? body : null,
            signal: state.controller.signal,
            ...(stream
              ? {
                  stream: {
                    headers: ({ status, headers }) => {
                      if (status >= 300 && status < 400) {
                        reply(id, { type: "failure" });
                        state.controller.abort();
                        return;
                      }
                      reply(id, { type: "headers", status, headers });
                    },
                    chunk: (binary, acknowledge) => {
                      state.acknowledge = acknowledge;
                      reply(id, { type: "chunk", binary });
                    },
                  },
                }
              : {}),
          })
            .then((result) => {
              if (!result || (result.status >= 300 && result.status < 400)) {
                throw new Error("Verified viewer refused a redirect.");
              }
              if (!stream) reply(id, { type: "response", ...result });
              else reply(id, { type: "end" });
            })
            .catch(() => {
              if (!state.controller.signal.aborted) reply(id, { type: "failure" });
            })
            .finally(() => requests.delete(id));
          break;
        }
        case "pull": {
          const request = requests.get(id);
          const acknowledge = request?.acknowledge;
          if (request) delete request.acknowledge;
          acknowledge?.();
          break;
        }
        case "cancel":
          requests.get(id)?.controller.abort();
          break;
      }
    } catch {
      // Ignore malformed bridge messages.
    }
    return true;
  }

  return {
    onMessage,
    stop() {
      stopped = true;
      sockets?.dispose();
      for (const request of requests.values()) request.controller.abort();
      requests.clear();
      connections.clear();
    },
  };
}
