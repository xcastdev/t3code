import * as Redacted from "effect/Redacted";

import {
  assertRelayAdmissionEndpoint,
  readNativeRelayAdmission,
  relayAdmissionHeader,
} from "../connection/relay-admission";
import {
  enrollVerifiedRoute,
  readVerifiedRouteForDispatch,
  supportsVerifiedRoutes,
  type VerifiedRoute,
} from "../connection/verified-route";

type NativeRequest = {
  readonly url: string;
  readonly httpsOrigin: string;
  readonly leafSpkiSha256: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly bodyBase64?: string;
  readonly uploadFile?: string;
  readonly downloadFile?: string;
  readonly stream?: boolean;
};

type NativeResponse =
  | {
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly bodyBase64: string;
    }
  | { readonly error: string };

interface NativeTransport {
  startVerifiedRequest(id: string, request: NativeRequest): void;
  startVerifiedRelayRequest?(id: string, request: NativeRequest, relayAuthorization: string): void;
  cancelVerifiedRequest(id: string): void;
  acknowledgeVerifiedChunk?(id: string): void;
  addListener<K extends keyof VerifiedEvents>(
    event: K,
    listener: (value: VerifiedEvents[K] & { readonly id: string }) => void,
  ): { remove(): void };
}

type VerifiedEvents = {
  readonly verifiedResponse: NativeResponse;
  readonly verifiedProgress: { readonly fraction: number };
  readonly verifiedHeaders: { readonly status: number; readonly headers: Record<string, string> };
  readonly verifiedChunk: { readonly dataBase64: string };
};

type TransferOptions = {
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit | null;
  readonly uploadFile?: string;
  readonly downloadFile?: string;
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal | null;
  readonly requireVerified?: boolean;
  readonly stream?: {
    readonly headers: (value: VerifiedEvents["verifiedHeaders"]) => void;
    readonly chunk: (dataBase64: string, acknowledge: () => void) => void;
  };
};

export function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
}

function encodeBody(body: BodyInit): string {
  const MAX_BODY = 8 * 1024 * 1024;
  if (typeof body !== "string" && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
    throw new Error("This request body is not supported by verified transport.");
  }
  const bytes =
    typeof body === "string"
      ? new TextEncoder().encode(body)
      : body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (bytes.byteLength > MAX_BODY) throw new Error("Verified request body is too large.");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

async function nativeTransport() {
  const { requireOptionalNativeModule, Platform } = await import("expo");
  return requireOptionalNativeModule<NativeTransport>(
    Platform.OS === "ios" ? "T3WebSocket" : "T3VerifiedNetwork",
  );
}

export { supportsVerifiedRoutes };

export async function installVerifiedRoute(binding: VerifiedRoute): Promise<boolean> {
  if (!(await supportsVerifiedRoutes())) return false;
  await enrollVerifiedRoute(binding);
  return true;
}

export async function requestVerifiedRoute(url: string, options: TransferOptions) {
  const requestHeaders = new Headers(options.headers);
  if (requestHeaders.has(relayAdmissionHeader)) {
    throw new Error("Proxy-Authorization is reserved for relay admission.");
  }
  const binding = await readVerifiedRouteForDispatch(url, options.requireVerified);
  if (binding === null) return null;
  const native = await nativeTransport();
  if (!native?.startVerifiedRequest) {
    throw new Error("Update the mobile app to connect to this verified environment.");
  }
  const { uuidv4 } = await import("../lib/uuid");
  const transport = native;
  const stream = options.stream;
  const acknowledgeChunk = native.acknowledgeVerifiedChunk?.bind(native);
  if (stream && !acknowledgeChunk) {
    throw new Error("Update the mobile app to stream from this verified environment.");
  }
  const { signal } = options;
  signal?.throwIfAborted();
  const bodyBase64 = options.body == null ? undefined : encodeBody(options.body);
  const credential = await readNativeRelayAdmission(binding);
  signal?.throwIfAborted();
  const headers: Record<string, string> = {};
  requestHeaders.forEach((value, name) => {
    headers[name] = value;
  });
  if (credential !== null) {
    assertRelayAdmissionEndpoint(binding, url, "https:");
  }
  return new Promise<Exclude<NativeResponse, { error: string }>>((resolve, reject) => {
    const id = uuidv4();
    const response = native.addListener("verifiedResponse", (result) => {
      if (result.id !== id) return;
      cleanup();
      if ("error" in result) reject(new Error(result.error));
      else resolve(result);
    });
    const progress = options.onProgress
      ? native.addListener("verifiedProgress", (event) => {
          if (event.id === id) options.onProgress?.(event.fraction);
        })
      : undefined;
    const headersSubscription = stream
      ? native.addListener("verifiedHeaders", (value) => {
          if (value.id === id) stream.headers(value);
        })
      : undefined;
    const chunkSubscription =
      stream && acknowledgeChunk
        ? native.addListener("verifiedChunk", (value) => {
            if (value.id === id) stream.chunk(value.dataBase64, () => acknowledgeChunk(id));
          })
        : undefined;
    function cleanup() {
      response.remove();
      progress?.remove();
      headersSubscription?.remove();
      chunkSubscription?.remove();
      signal?.removeEventListener("abort", abort);
    }
    function abort() {
      cleanup();
      transport.cancelVerifiedRequest(id);
      reject(signal?.reason ?? new Error("Verified request cancelled."));
    }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const request = {
        url,
        ...(stream ? { stream: true } : {}),
        httpsOrigin: binding.httpsOrigin,
        leafSpkiSha256: binding.leafSpkiSha256,
        method: (options.method ?? "GET").toUpperCase(),
        headers,
        ...(bodyBase64 === undefined ? {} : { bodyBase64 }),
        ...(options.uploadFile === undefined ? {} : { uploadFile: options.uploadFile }),
        ...(options.downloadFile === undefined ? {} : { downloadFile: options.downloadFile }),
      };
      if (credential !== null) {
        if (!native.startVerifiedRelayRequest) {
          throw new Error("Update the mobile app to use relay admission.");
        }
        native.startVerifiedRelayRequest(id, request, `Bearer ${Redacted.value(credential)}`);
      } else {
        native.startVerifiedRequest(id, request);
      }
    } catch (cause) {
      cleanup();
      reject(cause);
    }
  });
}

type VerifiedFetchInit = RequestInit & { readonly requireVerified?: boolean };

export async function fetchRouteWith(
  fallback: typeof globalThis.fetch,
  input: Parameters<typeof globalThis.fetch>[0],
  init?: VerifiedFetchInit,
): Promise<Response> {
  const { requireVerified, ...requestInit } = init ?? {};
  if (typeof input !== "string" && !(input instanceof URL)) {
    if (
      input.headers.has(relayAdmissionHeader) ||
      new Headers(requestInit.headers).has(relayAdmissionHeader)
    ) {
      throw new Error("Proxy-Authorization is reserved for relay admission.");
    }
    if (requireVerified || (await readVerifiedRouteForDispatch(input.url))) {
      throw new Error("Verified fetch requires a URL.");
    }
    return fallback(input, init === undefined ? undefined : requestInit);
  }
  const url = input.toString();
  const response = await requestVerifiedRoute(url, init ?? {});
  if (response === null) return fallback(input, init === undefined ? undefined : requestInit);
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    throw new Error("Verified route refused a redirect.");
  }
  const noBody = init?.method === "HEAD" || [204, 205, 304].includes(response.status);
  const headers = new Headers(response.headers);
  const bytes = noBody ? null : bytesFromBase64(response.bodyBase64);
  const type = headers.get("content-type") ?? "";
  // React Native's fetch polyfill decodes ArrayBuffer text one byte at a time.
  const body =
    bytes !== null && /^(text\/|application\/(?:[^;]+\+)?json)/i.test(type)
      ? new TextDecoder().decode(bytes)
      : (bytes?.buffer ?? null);
  return new Response(body, { status: response.status, headers });
}

export const fetchRoute = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: VerifiedFetchInit,
): Promise<Response> => fetchRouteWith(globalThis.fetch, input, init);
