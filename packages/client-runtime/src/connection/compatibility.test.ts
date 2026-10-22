import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "./compatibility.ts";

const descriptor = (orchestrationProtocolVersion?: number): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make("environment-remote"),
  label: "Build Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "9.0.0",
  ...(orchestrationProtocolVersion === undefined ? {} : { orchestrationProtocolVersion }),
  capabilities: { repositoryIdentity: true },
});

describe("orchestration protocol compatibility", () => {
  it.each([
    "ws://127.0.0.1:3773/ws",
    "wss://desk.example.com/ws",
    "wss://relay.example.com/environments/desk/ws?connectionMethod=relay",
    "wss://desk.tail1234.ts.net/ws?wsTicket=fixture-ticket",
    "wss://tunnel.example.com/session/ws?connectionMethod=tunnel",
  ])("keeps the selected transport origin and path for %s", (address) => {
    const selected = new URL(address);
    const announced = new URL(appendOrchestrationProtocol(address));
    expect(announced.origin).toBe(selected.origin);
    expect(announced.pathname).toBe(selected.pathname);
    announced.searchParams.delete("orchestrationProtocol");
    expect(announced.href).toBe(selected.href);
  });

  it("accepts the current protocol and announces it without disturbing socket credentials", () => {
    expect(
      orchestrationProtocolCompatibilityError(descriptor(ORCHESTRATION_PROTOCOL_VERSION)),
    ).toBeNull();

    const socketUrl = new URL(
      appendOrchestrationProtocol("wss://host.test/ws?wsTicket=secret&connectionMethod=relay"),
    );
    expect(socketUrl.searchParams.get("orchestrationProtocol")).toBe(
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    expect(socketUrl.searchParams.get("wsTicket")).toBe("secret");
    expect(socketUrl.searchParams.get("connectionMethod")).toBe("relay");
  });

  it("treats missing metadata as protocol 1", () => {
    const error = orchestrationProtocolCompatibilityError(descriptor());
    if (Number(ORCHESTRATION_PROTOCOL_VERSION) === 1) {
      expect(error).toBeNull();
    } else {
      expect(error).toMatchObject({ reason: "unsupported" });
    }
  });

  it("blocks a different protocol before connecting", () => {
    const error = orchestrationProtocolCompatibilityError(
      descriptor(ORCHESTRATION_PROTOCOL_VERSION + 1),
    );
    expect(error).toMatchObject({ reason: "unsupported" });
    expect(error?.message).toContain("This client is not supported");
    expect(error).not.toHaveProperty("serverUpdateRequired");
  });

  it("offers a remote update only for an older host that can update itself", () => {
    const older = descriptor(ORCHESTRATION_PROTOCOL_VERSION - 1);
    const withCapabilities = (capabilities: ExecutionEnvironmentDescriptor["capabilities"]) =>
      orchestrationProtocolCompatibilityError({ ...older, capabilities });

    expect(
      withCapabilities({ repositoryIdentity: true, serverSelfUpdate: "boot-service" }),
    ).toMatchObject({ serverUpdateRequired: true });
    expect(withCapabilities({ repositoryIdentity: true })).not.toHaveProperty(
      "serverUpdateRequired",
    );
    expect(
      withCapabilities({ repositoryIdentity: true, serverSelfUpdate: "desktop-managed" }),
    ).not.toHaveProperty("serverUpdateRequired");
    expect(
      withCapabilities({
        repositoryIdentity: true,
        serverSelfUpdate: "desktop-managed",
        desktopAppUpdate: true,
      }),
    ).toMatchObject({ serverUpdateRequired: true });
  });
});
