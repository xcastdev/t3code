import type { McpServerId, ProjectMcpTransport } from "@t3tools/contracts";
import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type SSEClientTransportOptions,
  type StreamableHTTPClientTransportOptions,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";

export class ProjectMcpSecretUnavailableError extends Error {
  constructor(serverId: McpServerId, secretRef: string) {
    void secretRef;
    super(`MCP secret is unavailable for server '${serverId}'.`);
    this.name = "ProjectMcpSecretUnavailableError";
  }
}

export class ProjectMcpTransportConfigurationError extends Error {
  constructor(serverId: McpServerId, reason: "oauth_provider_required" | "authorization_header") {
    super(
      reason === "oauth_provider_required"
        ? `MCP OAuth provider is unavailable for server '${serverId}'.`
        : `MCP OAuth transport cannot use a configured Authorization header for server '${serverId}'.`,
    );
    this.name = "ProjectMcpTransportConfigurationError";
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
  readonly oauthProvider?: OAuthClientProvider;
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
  oauthProvider,
  constructors = sdkConstructors,
}: MakeProjectMcpTransportInput): Transport => {
  switch (transport.type) {
    case "stdio": {
      const env = resolveHeaders(serverId, transport.env, resolveSecret);
      return constructors.stdio({
        command: transport.command,
        args: [...transport.args],
        ...(transport.cwd ? { cwd: transport.cwd } : {}),
        env: { ...getDefaultEnvironment(), ...env },
        stderr: "pipe",
      }) as Transport;
    }
    case "streamable-http": {
      if (
        transport.authorization.type === "oauth" &&
        transport.headers.some(({ name }) => name.toLowerCase() === "authorization")
      ) {
        throw new ProjectMcpTransportConfigurationError(serverId, "authorization_header");
      }
      const headers = resolveHeaders(serverId, transport.headers, resolveSecret);
      if (transport.authorization.type === "oauth" && oauthProvider === undefined) {
        throw new ProjectMcpTransportConfigurationError(serverId, "oauth_provider_required");
      }
      return constructors.streamableHttp(new URL(transport.url), {
        requestInit: { headers },
        ...(oauthProvider ? { authProvider: oauthProvider } : {}),
      }) as Transport;
    }
    case "legacy-sse": {
      if (
        transport.authorization.type === "oauth" &&
        transport.headers.some(({ name }) => name.toLowerCase() === "authorization")
      ) {
        throw new ProjectMcpTransportConfigurationError(serverId, "authorization_header");
      }
      const headers = resolveHeaders(serverId, transport.headers, resolveSecret);
      if (transport.authorization.type === "oauth" && oauthProvider === undefined) {
        throw new ProjectMcpTransportConfigurationError(serverId, "oauth_provider_required");
      }
      return constructors.legacySse(new URL(transport.url), {
        eventSourceInit: {},
        requestInit: { headers },
        ...(oauthProvider ? { authProvider: oauthProvider } : {}),
      }) as Transport;
    }
  }
};
