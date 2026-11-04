import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ProjectMcpTransport } from "@t3tools/contracts";

import {
  ProjectMcpSecretUnavailableError,
  ProjectMcpTransportConfigurationError,
} from "./ProjectMcpTransport.ts";

export const PROJECT_MCP_HANDSHAKE_TIMEOUT_MS = 15_000;

export const connectProjectMcp = async (
  transport: Omit<Transport, "sessionId">,
): Promise<Client> => {
  const client = new Client({ name: "t3-catalog-gateway", version: "1" });
  try {
    await client.connect(transport, { timeout: PROJECT_MCP_HANDSHAKE_TIMEOUT_MS });
    return client;
  } catch (cause) {
    await transport.close().catch(() => undefined);
    throw new Error("MCP upstream handshake failed.", { cause });
  }
};

const httpHint = (status: number, transport: ProjectMcpTransport["type"]): string => {
  if (status === 401 || status === 403) return " Check the server's credentials.";
  if (status === 404) return " Check the server's URL and path.";
  if (status === 405)
    return transport === "legacy-sse"
      ? " The server may need the Streamable HTTP transport."
      : transport === "streamable-http"
        ? " The server may need the legacy SSE transport."
        : "";
  return "";
};

/**
 * A user-facing account of why a connection failed. Upstream messages can echo
 * request data, so only the known secret values are scrubbed from any text kept.
 */
export const describeProjectMcpFailure = (
  cause: unknown,
  transport: ProjectMcpTransport,
  secretValues: Iterable<string> = [],
): string => {
  const errors: Array<unknown> = [];
  for (let current = cause; current !== undefined && errors.length < 8;) {
    errors.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  for (const error of errors) {
    if (error instanceof ProjectMcpSecretUnavailableError)
      return "A stored secret for this server is unavailable. Enter it again.";
    if (error instanceof ProjectMcpTransportConfigurationError) return error.message;
    if (error instanceof UnauthorizedError)
      return "The server requires authorization. Connect OAuth for it first.";
    if (
      (error instanceof StreamableHTTPError || error instanceof SseError) &&
      typeof error.code === "number" &&
      error.code >= 100
    )
      return `HTTP ${error.code} from upstream.${httpHint(error.code, transport.type)}`;
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
      return `The server didn't answer within ${PROJECT_MCP_HANDSHAKE_TIMEOUT_MS / 1000} seconds.`;
    if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed)
      return transport.type === "stdio"
        ? "The command exited or closed its connection."
        : "The server closed the connection.";
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (transport.type === "stdio" && code === "ENOENT")
      return transport.cwd === undefined
        ? `Command not found: ${transport.command}`
        : `Command or working directory not found: ${transport.command} in ${transport.cwd}`;
    if (transport.type === "stdio" && code === "EACCES")
      return `Command isn't executable: ${transport.command}`;
    if (code === "ECONNREFUSED") return "Connection refused. Check that the server is running.";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Couldn't resolve the server's host.";
  }
  const innermost = errors.findLast((error) => error instanceof Error);
  let detail = innermost instanceof Error ? innermost.message : "";
  for (const value of secretValues)
    if (value.length > 0) detail = detail.replaceAll(value, "[redacted]");
  detail = detail.trim().slice(0, 300);
  return detail.length > 0
    ? `Couldn't connect to the MCP server: ${detail}`
    : "Couldn't connect to the MCP server.";
};
