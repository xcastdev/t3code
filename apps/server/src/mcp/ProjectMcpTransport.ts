import type { McpServerId, ProjectMcpTransport } from "@t3tools/contracts";
import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type SSEClientTransportOptions,
  type StreamableHTTPClientTransportOptions,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";

export class ProjectMcpSecretUnavailableError extends Error {
  constructor(serverId: McpServerId, secretRef: string) {
    super(`MCP secret is unavailable for server '${serverId}' (${secretRef}).`);
    this.name = "ProjectMcpSecretUnavailableError";
  }
}

export interface ProjectMcpTransportConstructors<T = unknown> {
  readonly streamableHttp: (url: URL, options?: StreamableHTTPClientTransportOptions) => T;
  readonly legacySse: (url: URL, options?: SSEClientTransportOptions) => T;
  readonly stdio: (options: StdioServerParameters) => T;
}

const sdkConstructors: ProjectMcpTransportConstructors<Transport> = {
  streamableHttp: (url, options) => new StreamableHTTPClientTransport(url, options),
  legacySse: (url, options) => new SSEClientTransport(url, options),
  stdio: (options) => new StdioClientTransport(options),
};

export interface MakeProjectMcpTransportInput {
  readonly serverId: McpServerId;
  readonly transport: ProjectMcpTransport;
  readonly resolveSecret: (secretRef: string) => string | undefined;
  readonly constructors?: ProjectMcpTransportConstructors<unknown>;
}

const resolveHeaders = (
  serverId: McpServerId,
  entries: ReadonlyArray<{
    readonly name: string;
    readonly credential: { readonly id: string };
  }>,
  resolveSecret: (secretRef: string) => string | undefined,
): Record<string, string> =>
  Object.fromEntries(
    entries.map(({ name, credential }) => {
      const value = resolveSecret(credential.id);
      if (value === undefined) {
        throw new ProjectMcpSecretUnavailableError(serverId, credential.id);
      }
      return [name, value];
    }),
  );

export const makeProjectMcpTransport = ({
  serverId,
  transport,
  resolveSecret,
  constructors = sdkConstructors,
}: MakeProjectMcpTransportInput): Transport => {
  switch (transport.type) {
    case "stdio": {
      const env = resolveHeaders(serverId, transport.env, resolveSecret);
      return constructors.stdio({
        command: transport.command,
        args: [...transport.args],
        ...(transport.cwd ? { cwd: transport.cwd } : {}),
        env,
        stderr: "pipe",
      }) as Transport;
    }
    case "streamable-http": {
      const headers = resolveHeaders(serverId, transport.headers, resolveSecret);
      return constructors.streamableHttp(new URL(transport.url), {
        requestInit: { headers },
      }) as Transport;
    }
    case "legacy-sse": {
      const headers = resolveHeaders(serverId, transport.headers, resolveSecret);
      return constructors.legacySse(new URL(transport.url), {
        eventSourceInit: {},
        requestInit: { headers },
      }) as Transport;
    }
  }
};
