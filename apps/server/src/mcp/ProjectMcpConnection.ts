import type { McpServerId, ProjectMcpTransport } from "@t3tools/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { makeProjectMcpTransport } from "./ProjectMcpTransport.ts";

export interface ProjectMcpClient {
  readonly connect: (transport: unknown) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface ProjectMcpConnectionDependencies {
  readonly createClient: () => ProjectMcpClient;
  readonly createTransport: (input: {
    readonly serverId: McpServerId;
    readonly transport: ProjectMcpTransport;
    readonly resolveSecret: (secretRef: string) => string | undefined;
  }) => unknown;
}

const isLegacyFallbackStatus = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  ((error as { readonly code?: unknown }).code === 404 ||
    (error as { readonly code?: unknown }).code === 405);

const defaultDependencies: ProjectMcpConnectionDependencies = {
  createClient: () => new Client({ name: "t3-code", version: "0.0.0" }) as ProjectMcpClient,
  createTransport: makeProjectMcpTransport,
};

export interface ConnectProjectMcpServerInput {
  readonly serverId: McpServerId;
  readonly transport: ProjectMcpTransport;
  readonly resolveSecret: (secretRef: string) => string | undefined;
  readonly dependencies?: ProjectMcpConnectionDependencies;
}

export interface ProjectMcpConnection {
  readonly client: ProjectMcpClient;
  readonly transport: ProjectMcpTransport;
  readonly close: () => Promise<void>;
}

export const connectProjectMcpServer = async ({
  serverId,
  transport,
  resolveSecret,
  dependencies = defaultDependencies,
}: ConnectProjectMcpServerInput): Promise<ProjectMcpConnection> => {
  const client = dependencies.createClient();
  const connect = async (selectedTransport: ProjectMcpTransport) => {
    await client.connect(
      dependencies.createTransport({ serverId, transport: selectedTransport, resolveSecret }),
    );
    return {
      client,
      transport: selectedTransport,
      close: () => client.close(),
    } satisfies ProjectMcpConnection;
  };

  try {
    return await connect(transport);
  } catch (error) {
    if (transport.type !== "streamable-http" || !isLegacyFallbackStatus(error)) throw error;
    return connect({ type: "legacy-sse", url: transport.url, headers: transport.headers });
  }
};
