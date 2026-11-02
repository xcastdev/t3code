import { ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readPrimaryEnvironmentTarget, resolvePrimaryEnvironmentHttpUrl } from ".";
import { attachedPrimaryIdentityError } from "../../connection/platform";

function installTestBrowser(url: string) {
  vi.stubGlobal("window", {
    location: new URL(url),
    history: {
      replaceState: vi.fn(),
    },
  });
}

describe("environmentBootstrap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses https descriptor urls when the primary environment uses wss", () => {
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "https://remote.example.com/.well-known/t3/environment",
    );
  });

  it("keeps an uppercase wss scheme secure when deriving the http url", () => {
    vi.stubEnv("VITE_WS_URL", "WSS://remote.example.com");

    expect(readPrimaryEnvironmentTarget()?.target).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("keeps an uppercase https scheme secure when deriving the websocket url", () => {
    vi.stubEnv("VITE_HTTP_URL", "HTTPS://remote.example.com");

    expect(readPrimaryEnvironmentTarget()?.target).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("uses the vite proxy for desktop-managed loopback descriptor requests during local dev", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5733");
    vi.stubGlobal("window", {
      location: new URL("http://127.0.0.1:5733/"),
      history: {
        replaceState: vi.fn(),
      },
      desktopBridge: {
        getLocalEnvironmentEnabled: () => true,
        getLocalEnvironmentBootstraps: () => [
          {
            id: "primary",
            label: "Windows",
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
            bootstrapToken: "desktop-bootstrap-token",
          },
        ],
      },
    });

    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://127.0.0.1:5733/.well-known/t3/environment",
    );
  });

  function installAttachedDesktop(input: { readonly environmentId?: string }) {
    vi.stubGlobal("window", {
      location: new URL("http://127.0.0.1:5733/"),
      history: { replaceState: vi.fn() },
      desktopBridge: {
        getLocalEnvironmentEnabled: () => true,
        getLocalEnvironmentBootstraps: () => [
          {
            id: "primary",
            label: "External",
            httpBaseUrl: "http://127.0.0.1:4773",
            wsBaseUrl: "ws://127.0.0.1:4773",
            ownership: "attached",
            ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
            attachmentRevision: "revision-1",
          },
        ],
        getLocalEnvironmentBearerToken: async () => "attached-bearer",
      },
    });
  }

  it("sends attached loopback requests straight to the attached server, not the dev proxy", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5733");
    installAttachedDesktop({ environmentId: "environment-local" });

    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://127.0.0.1:4773/.well-known/t3/environment",
    );
    expect(
      attachedPrimaryIdentityError(
        readPrimaryEnvironmentTarget()!,
        EnvironmentId.make("environment-local"),
      ),
    ).toBeNull();
  });

  it("refuses a different server answering at the attached address", () => {
    installAttachedDesktop({ environmentId: "environment-expected" });

    const error = attachedPrimaryIdentityError(
      readPrimaryEnvironmentTarget()!,
      EnvironmentId.make("environment-local"),
    );
    expect(error).toBeInstanceOf(ConnectionBlockedError);
    expect(error?.reason).toBe("configuration");
    expect(error?.message).toContain(
      "A different T3 Code server is answering at the attached address",
    );
  });

  it("fails closed when an attached bootstrap has no identity", () => {
    installAttachedDesktop({});

    expect(() => readPrimaryEnvironmentTarget()).toThrow(
      "The attached T3 Code server is missing its identity",
    );
  });
});
