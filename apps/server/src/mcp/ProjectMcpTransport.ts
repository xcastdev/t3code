import type { McpServerId, ProjectMcpTransport } from "@t3tools/contracts";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class ProjectMcpSecretUnavailableError extends Error {
  constructor(serverId: McpServerId, secretRef: string) {
    super(`MCP secret is unavailable for server '${serverId}' (${secretRef}).`);
    this.name = "ProjectMcpSecretUnavailableError";
  }
}

export interface ProjectMcpTransportConstructors<T = unknown> {
  readonly streamableHttp: (
    url: URL,
    options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
  ) => T;
  readonly legacySse: (url: URL, options: ConstructorParameters<typeof SSEClientTransport>[1]) => T;
  readonly stdio: (options: ConstructorParameters<typeof StdioClientTransport>[0]) => T;
}

const sdkConstructors: ProjectMcpTransportConstructors = {
  streamableHttp: (url, options) => new StreamableHTTPClientTransport(url, options),
  legacySse: (url, options) => new SSEClientTransport(url, options),
  stdio: (options) => new StdioClientTransport(options),
};

export interface MakeProjectMcpTransportInput {
  readonly serverId: McpServerId;
  readonly transport: ProjectMcpTransport;
  readonly resolveSecret: (secretRef: string) => string | undefined;
  readonly constructors?: ProjectMcpTransportConstructors;
}

const resolveHeaders = (
  serverId: McpServerId,
  entries: ReadonlyArray<{ readonly name: string; readonly secretRef: string }>,
  resolveSecret: (secretRef: string) => string | undefined,
): Record<string, string> =>
  Object.fromEntries(
    entries.map(({ name, secretRef }) => {
      const value = resolveSecret(secretRef);
      if (value === undefined) throw new ProjectMcpSecretUnavailableError(serverId, secretRef);
      return [name, value];
    }),
  );

export const makeProjectMcpTransport = ({
  serverId,
  transport,
  resolveSecret,
  constructors = sdkConstructors,
}: MakeProjectMcpTransportInput): unknown => {
  switch (transport.type) {
    case "stdio": {
      const env = resolveHeaders(serverId, transport.env, resolveSecret);
      return constructors.stdio({
        command: transport.command,
        args: [...transport.args],
        ...(transport.cwd ? { cwd: transport.cwd } : {}),
        env,
        stderr: "pipe",
      });
    }
    case "streamable-http": {
      const headers = resolveHeaders(serverId, transport.headers, resolveSecret);
      return constructors.streamableHttp(new URL(transport.url), {
        requestInit: { headers },
      });
    }
    case "legacy-sse": {
      const headers = resolveHeaders(serverId, transport.headers, resolveSecret);
      return constructors.legacySse(new URL(transport.url), {
        eventSourceInit: {},
        requestInit: { headers },
      });
    }
  }
};
