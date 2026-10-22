import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetDesktopPrimaryAuthForTests,
  attachedTargetForRequestUrl,
  readDesktopPrimaryBearerToken,
} from "./desktopAuth";
import {
  __resetDesktopPrimaryAttachmentForTests,
  readPrimaryEnvironmentTarget,
  verifyDesktopPrimaryAttachment,
} from "./target";

const ATTACHED = {
  httpBaseUrl: "http://127.0.0.1:4773",
  wsBaseUrl: "ws://127.0.0.1:4773",
  environmentId: EnvironmentId.make("environment-attached"),
  attachmentRevision: "revision-1",
};

function installDesktop(input: {
  readonly bootstrap: Record<string, unknown> | null;
  readonly tokens: ReadonlyArray<string>;
  readonly backendState?: Record<string, unknown>;
}) {
  let bootstrap = input.bootstrap;
  let index = 0;
  const getLocalEnvironmentBearerToken = vi.fn(async () => input.tokens[index++] ?? "exhausted");
  vi.stubGlobal("window", {
    location: new URL("http://127.0.0.1:5733/"),
    desktopBridge: {
      getLocalEnvironmentBootstraps: () => (bootstrap === null ? [] : [bootstrap]),
      getLocalEnvironmentBearerToken,
      getPrimaryBackendState: async () => input.backendState ?? { mode: "managed" },
    },
  });
  return {
    getLocalEnvironmentBearerToken,
    setBootstrap: (next: Record<string, unknown> | null) => {
      bootstrap = next;
    },
  };
}

describe("readDesktopPrimaryBearerToken", () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    __resetDesktopPrimaryAttachmentForTests();
    vi.unstubAllGlobals();
  });

  it("keeps caching the managed bearer and asks without a target", async () => {
    const desktop = installDesktop({
      bootstrap: {
        id: "primary",
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
      },
      tokens: ["managed-1", "managed-2"],
    });

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("managed-1");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("managed-1");
    expect(desktop.getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1);
    expect(desktop.getLocalEnvironmentBearerToken).toHaveBeenCalledWith();
  });

  it("asks the main process on every attached read with the captured attachment", async () => {
    const desktop = installDesktop({
      bootstrap: { id: "primary", label: "External", ownership: "attached", ...ATTACHED },
      tokens: ["attached-1", "attached-2"],
    });

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("attached-1");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("attached-2");
    expect(desktop.getLocalEnvironmentBearerToken.mock.calls).toEqual([[ATTACHED], [ATTACHED]]);
  });

  it("never fetches a token for a newer attachment on behalf of an older target", async () => {
    const desktop = installDesktop({
      bootstrap: { id: "primary", label: "External", ownership: "attached", ...ATTACHED },
      tokens: ["attached-b"],
    });
    desktop.setBootstrap({
      id: "primary",
      label: "Other",
      ownership: "attached",
      ...ATTACHED,
      httpBaseUrl: "http://127.0.0.1:4774",
      wsBaseUrl: "ws://127.0.0.1:4774",
      attachmentRevision: "revision-2",
    });

    await expect(readDesktopPrimaryBearerToken(ATTACHED)).rejects.toThrow(
      "The attached T3 Code server changed",
    );
    expect(() => attachedTargetForRequestUrl("http://127.0.0.1:4773/api/auth/session")).toThrow(
      "The attached T3 Code server changed",
    );
    expect(desktop.getLocalEnvironmentBearerToken).not.toHaveBeenCalled();
  });

  it("refuses a bundled-server credential once the primary is an attachment", async () => {
    const desktop = installDesktop({
      bootstrap: { id: "primary", label: "External", ownership: "attached", ...ATTACHED },
      tokens: ["attached-1"],
    });

    await expect(readDesktopPrimaryBearerToken("managed")).rejects.toThrow(
      "The attached T3 Code server changed",
    );
    expect(desktop.getLocalEnvironmentBearerToken).not.toHaveBeenCalled();
  });

  it("never falls back to the page origin for an unusable saved attachment", async () => {
    const desktop = installDesktop({
      bootstrap: null,
      tokens: ["leaked"],
      backendState: { mode: "invalid-attached", reason: "the saved credential can't be read" },
    });

    await expect(verifyDesktopPrimaryAttachment()).rejects.toThrow(
      "the saved credential can't be read",
    );
    expect(() => readPrimaryEnvironmentTarget()).toThrow("Attach it again");
    await expect(readDesktopPrimaryBearerToken("managed")).rejects.toThrow("Attach it again");
    expect(desktop.getLocalEnvironmentBearerToken).not.toHaveBeenCalled();
  });

  it("keeps the page-origin primary while a bundled server has no bootstrap yet", async () => {
    installDesktop({ bootstrap: null, tokens: [] });

    await expect(verifyDesktopPrimaryAttachment()).resolves.toBeUndefined();
    expect(readPrimaryEnvironmentTarget()?.source).toBe("window-origin");
  });
});
