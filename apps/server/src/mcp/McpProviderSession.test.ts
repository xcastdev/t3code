import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  beginMcpProviderSessionReplacement,
  clearAllMcpProviderSessions,
  readMcpProviderSession,
  rollbackMcpProviderSessionReplacement,
  setMcpProviderSession,
  withAgentDeviceEnvironment,
  type McpProviderSessionConfig,
} from "./McpProviderSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

it("restores an existing terminal-only credential when a preview-disabled replacement fails", () => {
  clearAllMcpProviderSessions();
  const threadId = ThreadId.make("thread-terminal-rollback");
  const previous: McpProviderSessionConfig = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId,
    providerSessionId: "session-previous",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer previous-token",
    capabilities: new Set(["pull-requests", "terminal"]),
  };
  const candidate: McpProviderSessionConfig = {
    ...previous,
    providerSessionId: "session-candidate",
    authorizationHeader: "Bearer candidate-token",
  };
  setMcpProviderSession(previous);
  beginMcpProviderSessionReplacement(threadId, {
    previous,
    candidate,
    previewWasRevoked: false,
  });
  setMcpProviderSession(candidate);

  rollbackMcpProviderSessionReplacement(threadId);

  expect(readMcpProviderSession(threadId)).toBe(previous);
  clearAllMcpProviderSessions();
});

it("does not restore a credential whose preview capability was revoked", () => {
  clearAllMcpProviderSessions();
  const threadId = ThreadId.make("thread-preview-revocation");
  const previous: McpProviderSessionConfig = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId,
    providerSessionId: "session-preview-previous",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer preview-previous-token",
    capabilities: new Set(["pull-requests", "preview", "terminal"]),
  };
  const candidate: McpProviderSessionConfig = {
    ...previous,
    providerSessionId: "session-preview-candidate",
    authorizationHeader: "Bearer preview-candidate-token",
    capabilities: new Set(["pull-requests", "terminal"]),
  };
  setMcpProviderSession(previous);
  beginMcpProviderSessionReplacement(threadId, {
    previous,
    candidate,
    previewWasRevoked: true,
  });
  setMcpProviderSession(candidate);

  rollbackMcpProviderSessionReplacement(threadId);

  expect(readMcpProviderSession(threadId)).toBeUndefined();
  clearAllMcpProviderSessions();
});
