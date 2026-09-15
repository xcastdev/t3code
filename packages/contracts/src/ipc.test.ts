import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema, DesktopPrimaryBackendStateSchema } from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });

  it("carries attached ownership without exposing a credential", () => {
    expect(
      Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema)({
        id: "primary",
        label: "Attached server",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
        ownership: "attached",
      }).ownership,
    ).toBe("attached");
  });
});

describe("DesktopPrimaryBackendStateSchema", () => {
  it("never includes the attached credential", () => {
    expect(
      Schema.decodeUnknownSync(DesktopPrimaryBackendStateSchema)({
        mode: "attached",
        httpBaseUrl: "http://127.0.0.1:3773/",
        environmentId: "environment-1",
        label: "Local server",
        bearerExpiresAt: "2099-01-01T00:00:00.000Z",
        encryptedBearerToken: "must-not-cross-ipc",
      }),
    ).not.toHaveProperty("encryptedBearerToken");
  });
});
