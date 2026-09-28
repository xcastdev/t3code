import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";

export const terminalOnlyMcpEndpoint = "http://127.0.0.1:43123/mcp";
export const terminalOnlyMcpAuthorization = "Bearer terminal-only-test-token";

export const installTerminalOnlyMcpSession = (
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
): McpProviderSession.McpProviderSessionConfig => {
  const config: McpProviderSession.McpProviderSessionConfig = {
    environmentId: EnvironmentId.make("environment-mcp-adapter-test"),
    threadId,
    providerSessionId: `provider-session-${threadId}`,
    providerInstanceId,
    endpoint: terminalOnlyMcpEndpoint,
    authorizationHeader: terminalOnlyMcpAuthorization,
    capabilities: new Set(["pull-requests", "terminal"]),
  };
  McpProviderSession.setMcpProviderSession(config);
  return config;
};
