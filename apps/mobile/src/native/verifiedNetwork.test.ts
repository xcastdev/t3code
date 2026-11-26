import { expect, it, onTestFinished, vi } from "vite-plus/test";

import {
  clearNativeRelayAdmission,
  installNativeRelayAdmission,
} from "../connection/relay-admission";
import { markVerificationRequired } from "../connection/verified-route";
import { issuedMobileAssetUrl, issuedMobileTransferUrl } from "../lib/verifiedAssetUrl";
import {
  fetchRouteWith,
  installVerifiedRoute,
  requestVerifiedRoute,
  supportsVerifiedRoutes,
} from "./verifiedNetwork";

const native = vi.hoisted(() => ({
  module: null as object | null,
  saved: null as string | null,
  relay: new Map<string, string>(),
  policyUnavailable: false,
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => native.module,
  Platform: { OS: "android" },
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => {
    if (key === "t3code.verified-route-policy.v1" && native.policyUnavailable) {
      throw new Error("SecureStore unavailable");
    }
    return key === "t3code.verified-routes.v1" ? native.saved : (native.relay.get(key) ?? null);
  },
  setItemAsync: async (key: string, value: string) => {
    if (key === "t3code.verified-routes.v1") native.saved = value;
    else native.relay.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    native.relay.delete(key);
  },
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "transfer" }));

const pin = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const httpsOrigin = "https://edge.example.com:8443";
const binding = { httpsOrigin, environmentId: "env", leafSpkiSha256: pin };

it.each([
  "missing pin",
  "corrupt pin",
  "restored pin after clear",
  "corrupt policy",
  "unavailable policy",
] as const)("refuses a bare signed HTTPS URL after a cold start with %s", async (failure) => {
  native.saved = null;
  native.relay.clear();
  onTestFinished(() => {
    native.relay.clear();
    native.policyUnavailable = false;
  });
  const startVerifiedRequest = vi.fn();
  const startVerifiedRelayRequest = vi.fn();
  // Throw if a downgraded request reaches native so the assertion can inspect the call.
  startVerifiedRequest.mockImplementation(() => {
    throw new Error("Dispatched pin only");
  });
  native.module = {
    connectVerified: vi.fn(),
    startVerifiedRequest,
    startVerifiedRelayRequest,
    cancelVerifiedRequest: vi.fn(),
    addListener: () => ({ remove() {} }),
  };
  const coldOrigin = "https://cold-http.example.com:8443";
  const coldBinding = { ...binding, httpsOrigin: coldOrigin };
  await installVerifiedRoute(coldBinding);
  const pinOnly = native.saved;
  if (failure === "restored pin after clear") {
    await installNativeRelayAdmission(coldBinding, "relay-session");
    await clearNativeRelayAdmission(coldBinding);
    native.saved = pinOnly;
  } else if (failure === "corrupt policy") {
    native.relay.set("t3code.verified-route-policy.v1", "{bad");
  } else if (failure === "unavailable policy") {
    native.policyUnavailable = true;
  } else {
    native.saved = failure === "missing pin" ? null : "{bad";
  }

  vi.resetModules();
  const { fetchRouteWith: coldFetch } = await import("./verifiedNetwork");
  const fallback = vi.fn(async () => new Response("ordinary"));
  await expect(coldFetch(fallback, `${coldOrigin}/file?ticket=signed`)).rejects.toThrow(
    failure === "restored pin after clear"
      ? "Relay admission credential is unavailable."
      : "Verified route enrollment is unavailable.",
  );
  expect(fallback).not.toHaveBeenCalled();
  expect(startVerifiedRequest).not.toHaveBeenCalled();
  expect(startVerifiedRelayRequest).not.toHaveBeenCalled();
  if (failure === "missing pin") {
    const direct = "https://explicit-direct.example.com/file?ticket=direct";
    await expect(coldFetch(fallback, direct)).resolves.toBeInstanceOf(Response);
    expect(fallback).toHaveBeenCalledExactlyOnceWith(direct, undefined);
  }
});

it("never dispatches an admitted route with its pin alone", async () => {
  const origin = "https://admission-required.example.com";
  native.saved = JSON.stringify([
    { ...binding, httpsOrigin: origin, relayAdmissionRequired: true },
  ]);
  let respond: ((value: object) => void) | undefined;
  const startVerifiedRequest = vi.fn((id: string) =>
    respond?.({ id, status: 204, headers: {}, bodyBase64: "" }),
  );
  native.module = {
    startVerifiedRequest,
    startVerifiedRelayRequest: startVerifiedRequest,
    addListener: (_name: string, listener: (value: object) => void) => {
      respond = listener;
      return { remove() {} };
    },
  };
  const fallback = vi.fn();
  await expect(
    fetchRouteWith(fallback, `${origin}/api/auth/bootstrap`, {
      method: "POST",
      body: "pairing-code",
    }),
  ).rejects.toThrow("Relay admission credential is unavailable.");
  expect(startVerifiedRequest).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
  native.saved = null;
});

it("passes separate relay admission to native pairing and signed transfers at the original issuer", async () => {
  native.saved = null;
  const admitted = { ...binding, httpsOrigin: "https://admitted.example.com:8443" };
  let respond: ((value: object) => void) | undefined;
  const startVerifiedRequest = vi.fn((id: string) =>
    respond?.({ id, status: 204, headers: {}, bodyBase64: "" }),
  );
  const module = {
    connectVerified: vi.fn(),
    startVerifiedRequest: vi.fn(),
    startVerifiedRelayRequest: startVerifiedRequest,
    cancelVerifiedRequest: vi.fn(),
    addListener: (_name: string, listener: (value: object) => void) => {
      respond = listener;
      return { remove() {} };
    },
  };
  native.module = module;
  expect(await installVerifiedRoute(admitted)).toBe(true);
  await installNativeRelayAdmission(admitted, "relay-session");
  const fallback = vi.fn(async () => new Response("direct"));
  const bootstrap = `${admitted.httpsOrigin}/api/auth/bootstrap`;
  await fetchRouteWith(fallback, bootstrap, { method: "POST", body: "pairing-code" });
  expect(startVerifiedRequest).toHaveBeenLastCalledWith(
    "transfer",
    expect.objectContaining({
      url: bootstrap,
      method: "POST",
      headers: {},
      bodyBase64: btoa("pairing-code"),
    }),
    "Bearer relay-session",
  );
  const issued = `${admitted.httpsOrigin}/files/content?ticket=signed%2Bticket`;
  await installNativeRelayAdmission(admitted, "rotated-session");
  const headers = {
    Authorization: "DPoP destination",
    DPoP: "proof",
    Cookie: "session=destination",
  };
  await requestVerifiedRoute(issued, {
    method: "POST",
    headers,
    uploadFile: "file:///cache/source",
  });
  expect(startVerifiedRequest).toHaveBeenLastCalledWith(
    "transfer",
    expect.objectContaining({
      url: issued,
      httpsOrigin: admitted.httpsOrigin,
      leafSpkiSha256: pin,
      headers: {
        authorization: "DPoP destination",
        cookie: "session=destination",
        dpop: "proof",
      },
      uploadFile: "file:///cache/source",
    }),
    "Bearer rotated-session",
  );
  await requestVerifiedRoute(issued, { downloadFile: "file:///cache/download" });
  expect(startVerifiedRequest).toHaveBeenLastCalledWith(
    "transfer",
    expect.objectContaining({ url: issued, downloadFile: "file:///cache/download" }),
    "Bearer rotated-session",
  );
  startVerifiedRequest.mockImplementationOnce((id) =>
    respond?.({
      id,
      status: 307,
      headers: { location: "https://elsewhere.example.com/file" },
      bodyBase64: "",
    }),
  );
  await expect(fetchRouteWith(fallback, issued)).rejects.toThrow("refused a redirect");
  await expect(
    fetchRouteWith(fallback, bootstrap, {
      headers: [
        ["Proxy-Authorization", "Bearer caller"],
        ["proxy-authorization", "duplicate"],
      ],
    }),
  ).rejects.toThrow("reserved for relay admission");
  await expect(requestVerifiedRoute(`${admitted.httpsOrigin}/file#fragment`, {})).rejects.toThrow(
    "does not match the relay admission binding",
  );
  native.module = { ...module, startVerifiedRelayRequest: undefined };
  await expect(requestVerifiedRoute(issued, {})).rejects.toThrow("Update the mobile app");
  native.module = module;
  await clearNativeRelayAdmission(admitted);
  await expect(fetchRouteWith(fallback, issued)).rejects.toThrow("credential is unavailable");
  await fetchRouteWith(fallback, "https://explicit-direct.example.com/api/auth/session", {
    headers,
  });
  expect(fallback).toHaveBeenCalledExactlyOnceWith(
    "https://explicit-direct.example.com/api/auth/session",
    { headers },
  );
  expect(startVerifiedRequest).toHaveBeenCalledTimes(4);
  expect(module.startVerifiedRequest).not.toHaveBeenCalled();
  native.saved = null;
});

it("requires installed pinned HTTP and WSS before admitting an origin", async () => {
  native.module = {};
  expect(await installVerifiedRoute(binding)).toBe(false);
  const direct = vi.fn(async () => new Response("direct"));
  const response = await fetchRouteWith(direct, "http://192.168.1.2:3773/api/auth/session");
  expect(await response.text()).toBe("direct");
  expect(direct).toHaveBeenCalledOnce();
});

it("routes a bearer through the native pin and refuses redirects and cross-origin assets", async () => {
  const events = new Map<string, (value: object) => void>();
  const startVerifiedRequest = vi.fn((id: string) =>
    events.get("verifiedResponse")?.({
      id,
      status: 307,
      headers: { location: "https://redirect.example.com/" },
      bodyBase64: "",
    }),
  );
  const cancelVerifiedRequest = vi.fn();
  native.module = {
    connectVerified: () => 1,
    startVerifiedRequest,
    cancelVerifiedRequest,
    addListener: (name: string, listener: (value: object) => void) => {
      events.set(name, listener);
      return { remove: () => events.delete(name) };
    },
  };
  expect(await installVerifiedRoute(binding)).toBe(true);
  expect(JSON.parse(native.saved ?? "[]")).toEqual([binding]);
  const fallback = vi.fn();
  await expect(
    fetchRouteWith(fallback, `${httpsOrigin}/api/auth/session`, {
      headers: { Authorization: "Bearer session" },
    }),
  ).rejects.toThrow("refused a redirect");
  expect(fallback).not.toHaveBeenCalled();
  expect(startVerifiedRequest).toHaveBeenCalledWith("transfer", {
    url: `${httpsOrigin}/api/auth/session`,
    httpsOrigin,
    leafSpkiSha256: pin,
    method: "GET",
    headers: { authorization: "Bearer session" },
  });
  const signedUrl = `${httpsOrigin}/download?ticket=secret`;
  expect(
    issuedMobileTransferUrl("env", "//redirect.example.com/download?ticket=secret"),
  ).toBeNull();
  expect(issuedMobileAssetUrl("env", { relativeUrl: signedUrl, learnedRoute: true })).toBe(
    signedUrl,
  );
  expect(issuedMobileAssetUrl("other", { relativeUrl: signedUrl, learnedRoute: true })).toBeNull();
  expect(
    issuedMobileAssetUrl("env", {
      relativeUrl: "https://redirect.example.com/download?ticket=secret",
      learnedRoute: true,
    }),
  ).toBeNull();
  await expect(installVerifiedRoute({ ...binding, environmentId: "other" })).rejects.toThrow(
    "different verified route",
  );

  const controller = new AbortController();
  startVerifiedRequest.mockImplementationOnce(() => controller.abort());
  await expect(
    requestVerifiedRoute(`${httpsOrigin}/upload?signed=secret`, {
      method: "POST",
      uploadFile: "file:///cache/test",
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelVerifiedRequest).toHaveBeenCalledWith("transfer");
  expect(events.size).toBe(0);

  native.module = null;
  await expect(
    fetchRouteWith(fallback, `${httpsOrigin}/api/auth/session`, {
      headers: { Authorization: "Bearer session" },
    }),
  ).rejects.toThrow("Update the mobile app");
  expect(fallback).not.toHaveBeenCalled();
});

it("refuses HTTP fallback after a required binding is removed or corrupted", async () => {
  const startVerifiedRequest = vi.fn();
  native.module = {
    connectVerified: vi.fn(),
    startVerifiedRequest,
    cancelVerifiedRequest: vi.fn(),
  };
  native.saved = null;
  expect(await supportsVerifiedRoutes()).toBe(true);
  expect(native.saved).toBeNull();
  const url = "https://missing-pin.test/api/assets/signed?ticket=secret";
  markVerificationRequired(url);
  const fallback = vi.fn(async () => new Response("ordinary network"));
  for (const saved of [null, "{corrupt"]) {
    native.saved = saved;
    await expect(fetchRouteWith(fallback, url)).rejects.toThrow(/enrollment/i);
    await expect(fetchRouteWith(fallback, new Request(url))).rejects.toThrow(/verified/i);
  }
  native.saved = null;
  await expect(
    fetchRouteWith(fallback, "https://unknown-issuer.test/file?ticket=secret", {
      requireVerified: true,
    }),
  ).rejects.toThrow(/enrollment/i);
  expect(fallback).not.toHaveBeenCalled();
  expect(startVerifiedRequest).not.toHaveBeenCalled();
});

it("streams headers and chunks before completion and cancels the native request", async () => {
  const events = new Map<string, (event: object) => void>();
  const ready = Promise.withResolvers<void>();
  const acknowledgeVerifiedChunk = vi.fn();
  const cancelVerifiedRequest = vi.fn();
  native.module = {
    connectVerified: () => 1,
    startVerifiedRequest: (_id: string, request: { stream?: boolean }) => {
      if (request.stream === true) ready.resolve();
    },
    acknowledgeVerifiedChunk,
    cancelVerifiedRequest,
    addListener: (name: string, listener: (value: object) => void) => {
      events.set(name, listener);
      return { remove: () => events.delete(name) };
    },
  };
  expect(await installVerifiedRoute(binding)).toBe(true);
  const reportHeaders = vi.fn();
  const chunk = Promise.withResolvers<{ bytes: string; ack: () => void }>();
  const controller = new AbortController();
  const result = requestVerifiedRoute(`${httpsOrigin}/stream.avcc?ticket=exact`, {
    signal: controller.signal,
    stream: {
      headers: reportHeaders,
      chunk: (bytes, ack) => chunk.resolve({ bytes, ack }),
    },
  });
  await ready.promise;
  const headers = { "content-type": "video/avcc" };
  events.get("verifiedHeaders")?.({ id: "transfer", status: 200, headers });
  events.get("verifiedChunk")?.({ id: "transfer", dataBase64: "YQ==" });
  expect(reportHeaders).toHaveBeenCalledWith({ id: "transfer", status: 200, headers });
  const first = await chunk.promise;
  expect(first.bytes).toBe("YQ==");
  expect(acknowledgeVerifiedChunk).not.toHaveBeenCalled();
  first.ack();
  expect(acknowledgeVerifiedChunk).toHaveBeenCalledWith("transfer");
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelVerifiedRequest).toHaveBeenCalledWith("transfer");
  expect(events.size).toBe(0);
});
