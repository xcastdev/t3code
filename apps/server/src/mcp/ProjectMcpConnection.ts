import type { McpServerId, ProjectMcpTransport } from "@t3tools/contracts";
import {
  Client,
  type ClientOptions,
  type DiscoverResult,
  type ProtocolEra,
} from "@modelcontextprotocol/client";

import { makeProjectMcpTransport } from "./ProjectMcpTransport.ts";

export interface ProjectMcpClient {
  readonly connect: (transport: unknown) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly getProtocolEra?: () => ProtocolEra | undefined;
  readonly getNegotiatedProtocolVersion?: () => string | undefined;
  readonly getDiscoverResult?: () => DiscoverResult | undefined;
}

export interface ProjectMcpConnectionDependencies {
  readonly createClient: (options: ClientOptions) => ProjectMcpClient;
  readonly createTransport: (input: {
    readonly serverId: McpServerId;
    readonly transport: ProjectMcpTransport;
    readonly resolveSecret: (secretRef: string) => string | undefined;
  }) => unknown;
}

const isLegacyFallbackStatus = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const data = "data" in error ? error.data : undefined;
  const status =
    typeof data === "object" && data !== null && "status" in data
      ? data.status
      : "status" in error
        ? error.status
        : "code" in error && typeof error.code === "number"
          ? error.code
          : undefined;
  return status === 400 || status === 404 || status === 405;
};

const automaticClientOptions: ClientOptions = {
  versionNegotiation: { mode: "auto" },
  inputRequired: { autoFulfill: false, maxRounds: 10 },
};

const legacyClientOptions: ClientOptions = {
  versionNegotiation: { mode: "legacy" },
  inputRequired: { autoFulfill: false, maxRounds: 10 },
};

const closeResources = async (client: ProjectMcpClient, transport: unknown): Promise<void> => {
  let firstError: unknown;
  try {
    await client.close();
  } catch (error) {
    firstError = error;
  }

  if (
    typeof transport === "object" &&
    transport !== null &&
    "close" in transport &&
    typeof transport.close === "function"
  ) {
    try {
      await transport.close();
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError !== undefined) throw firstError;
};

const defaultDependencies: ProjectMcpConnectionDependencies = {
  createClient: (options) =>
    new Client({ name: "t3-code", version: "0.0.0" }, options) as ProjectMcpClient,
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
  readonly protocolEra: ProtocolEra | undefined;
  readonly negotiatedProtocolVersion: string | undefined;
  readonly discoverResult: DiscoverResult | undefined;
  readonly close: () => Promise<void>;
}

export const connectProjectMcpServer = async ({
  serverId,
  transport,
  resolveSecret,
  dependencies = defaultDependencies,
}: ConnectProjectMcpServerInput): Promise<ProjectMcpConnection> => {
  const connect = async (selectedTransport: ProjectMcpTransport, clientOptions: ClientOptions) => {
    const client = dependencies.createClient(clientOptions);
    let sdkTransport: unknown;
    try {
      sdkTransport = dependencies.createTransport({
        serverId,
        transport: selectedTransport,
        resolveSecret,
      });
      await client.connect(sdkTransport);
    } catch (error) {
      try {
        await closeResources(client, sdkTransport);
      } catch {
        // Preserve the connection error. Cleanup is best effort on a failed attempt.
      }
      throw error;
    }

    let closed = false;
    return {
      client,
      transport: selectedTransport,
      protocolEra: client.getProtocolEra?.(),
      negotiatedProtocolVersion: client.getNegotiatedProtocolVersion?.(),
      discoverResult: client.getDiscoverResult?.(),
      close: async () => {
        if (closed) return;
        closed = true;
        await closeResources(client, sdkTransport);
      },
    } satisfies ProjectMcpConnection;
  };

  try {
    return await connect(transport, automaticClientOptions);
  } catch (error) {
    if (transport.type !== "streamable-http" || !isLegacyFallbackStatus(error)) throw error;
    return connect(
      {
        type: "legacy-sse",
        url: transport.url,
        headers: transport.headers,
        authorization: transport.authorization,
      },
      legacyClientOptions,
    );
  }
};
