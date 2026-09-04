import type { McpServerId, ProjectMcpTransport } from "@t3tools/contracts";
import {
  Client,
  SdkHttpError,
  type ClientOptions,
  type DiscoverResult,
  type OAuthClientProvider,
  type ProtocolEra,
} from "@modelcontextprotocol/client";

import { makeProjectMcpTransport } from "./ProjectMcpTransport.ts";

export interface ProjectMcpClient {
  readonly connect: (transport: unknown) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly transport?: unknown;
  readonly request?: Client["request"];
  readonly notification?: Client["notification"];
  readonly ping?: Client["ping"];
  readonly discover?: Client["discover"];
  readonly complete?: Client["complete"];
  readonly setLoggingLevel?: Client["setLoggingLevel"];
  readonly listTools?: Client["listTools"];
  readonly callTool?: Client["callTool"];
  readonly listResources?: Client["listResources"];
  readonly listResourceTemplates?: Client["listResourceTemplates"];
  readonly readResource?: Client["readResource"];
  readonly subscribeResource?: Client["subscribeResource"];
  readonly unsubscribeResource?: Client["unsubscribeResource"];
  readonly listen?: Client["listen"];
  readonly listPrompts?: Client["listPrompts"];
  readonly getPrompt?: Client["getPrompt"];
  readonly setRequestHandler?: Client["setRequestHandler"];
  readonly setNotificationHandler?: Client["setNotificationHandler"];
  readonly terminateSession?: () => Promise<void>;
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
    readonly oauthProvider?: OAuthClientProvider;
  }) => unknown;
}

const isLegacyFallbackStatus = (error: unknown): boolean => {
  return SdkHttpError.isInstance(error) && [400, 404, 405].includes(error.status);
};

const automaticClientOptions: ClientOptions = {
  versionNegotiation: { mode: "auto" },
  inputRequired: { autoFulfill: false, maxRounds: 10 },
};

const legacyClientOptions: ClientOptions = {
  versionNegotiation: { mode: "legacy" },
  inputRequired: { autoFulfill: false, maxRounds: 10 },
};

const closeResources = async (client: ProjectMcpClient, transport?: unknown): Promise<void> => {
  let firstError: unknown;
  const clientOwnsTransport = transport !== undefined && client.transport === transport;
  try {
    await client.terminateSession?.();
  } catch (error) {
    firstError = error;
  }
  try {
    await client.close();
  } catch (error) {
    firstError ??= error;
  }
  if (
    typeof transport === "object" &&
    transport !== null &&
    !clientOwnsTransport &&
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
  readonly oauthProvider?: OAuthClientProvider;
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
  oauthProvider,
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
        ...(oauthProvider === undefined ? {} : { oauthProvider }),
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
