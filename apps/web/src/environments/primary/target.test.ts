import { PRIMARY_LOCAL_ENVIRONMENT_ID, type DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { readPrimaryEnvironmentTarget, resolvePrimaryEnvironmentHttpUrl } from "./target";

const attached: DesktopEnvironmentBootstrap = {
  id: PRIMARY_LOCAL_ENVIRONMENT_ID,
  label: "Attached environment",
  runningDistro: null,
  httpBaseUrl: "http://127.0.0.1:4321/",
  wsBaseUrl: "ws://127.0.0.1:4321/",
  ownership: "attached",
};

function installBridge(bootstraps: () => DesktopEnvironmentBootstrap[], enabled = false) {
  vi.stubGlobal("window", {
    location: new URL("http://127.0.0.1:9000/work"),
    desktopBridge: {
      getLocalEnvironmentEnabled: () => enabled,
      getLocalEnvironmentBootstraps: bootstraps,
    },
  });
}

describe("attached primary with managed local backends disabled", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_HTTP_URL", "https://configured.example.test");
    vi.stubEnv("VITE_WS_URL", "wss://configured.example.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("resolves the actual host bootstrap without enabling managed local backends", () => {
    installBridge(() => [attached]);
    expect(isLocalEnvironmentDisabled()).toBe(true);
    expect(readPrimaryEnvironmentTarget()).toEqual({
      source: "desktop-managed",
      target: { httpBaseUrl: attached.httpBaseUrl, wsBaseUrl: attached.wsBaseUrl },
    });
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://127.0.0.1:4321/.well-known/t3/environment",
    );
    expect(isLocalEnvironmentDisabled()).toBe(true);
  });

  it("removes the primary after detach even if a managed bootstrap remains", () => {
    let bootstraps = [attached];
    installBridge(() => bootstraps);
    expect(readPrimaryEnvironmentTarget()).not.toBeNull();
    bootstraps = [{ ...attached, ownership: "managed" }];
    expect(readPrimaryEnvironmentTarget()).toBeNull();
    bootstraps = [];
    expect(readPrimaryEnvironmentTarget()).toBeNull();
  });

  it.each([undefined, "managed"] as const)("does not activate a %s local primary", (ownership) => {
    const { ownership: _ownership, ...bootstrap } = attached;
    installBridge(() => [{ ...bootstrap, ...(ownership === undefined ? {} : { ownership }) }]);
    expect(readPrimaryEnvironmentTarget()).toBeNull();
  });

  it("keeps the primary absent without an attached bootstrap", () => {
    installBridge(() => []);
    expect(readPrimaryEnvironmentTarget()).toBeNull();
  });

  it("does not fall back when the bridge is unavailable", () => {
    installBridge(() => {
      throw new Error("bridge unavailable");
    });
    expect(() => readPrimaryEnvironmentTarget()).toThrow("bridge unavailable");
  });

  it("keeps the primary absent when attached endpoints are unavailable", () => {
    installBridge(() => [{ ...attached, httpBaseUrl: null, wsBaseUrl: null }]);
    expect(readPrimaryEnvironmentTarget()).toBeNull();
  });

  it.each([
    { httpBaseUrl: "http://[", wsBaseUrl: attached.wsBaseUrl },
    { httpBaseUrl: "/relative", wsBaseUrl: attached.wsBaseUrl },
    { httpBaseUrl: attached.httpBaseUrl, wsBaseUrl: "file:///socket" },
    { httpBaseUrl: attached.httpBaseUrl, wsBaseUrl: null },
  ])("never falls back for malformed attached endpoints %o", (endpoints) => {
    installBridge(() => [{ ...attached, ...endpoints }]);
    expect(() => readPrimaryEnvironmentTarget()).toThrow();
  });

  it("preserves managed primary resolution when the local backend is enabled", () => {
    installBridge(() => [{ ...attached, ownership: "managed" }], true);
    expect(readPrimaryEnvironmentTarget()?.target.httpBaseUrl).toBe(attached.httpBaseUrl);
  });
});
