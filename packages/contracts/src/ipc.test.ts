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

  it("marks an attached primary without changing the managed default shape", () => {
    expect(
      decode({
        id: "primary",
        label: "Attached server",
        httpBaseUrl: "http://127.0.0.9:4100/",
        wsBaseUrl: "ws://127.0.0.9:4100/",
        ownership: "attached",
      }).ownership,
    ).toBe("attached");
  });

  it("decodes redacted primary backend state", () => {
    expect(
      Schema.decodeUnknownSync(DesktopPrimaryBackendStateSchema)({
        mode: "attached",
        httpBaseUrl: "http://127.0.0.9:4100/",
        environmentId: "remote-environment",
        label: "Attached server",
        bearerExpiresAt: "2026-09-08T18:00:00.000Z",
      }),
    ).toMatchObject({ mode: "attached", environmentId: "remote-environment" });
  });
});
