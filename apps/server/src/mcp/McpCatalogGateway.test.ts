import {
  McpCatalogSessionId,
  McpDefinitionId,
  McpServerId,
  ProviderInstanceId,
  ThreadId,
  type ResolvedMcpCatalogEntry,
} from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as McpCatalogGateway from "./McpCatalogGateway.ts";
import * as ProjectMcpProxyRegistry from "./ProjectMcpProxyRegistry.ts";

const provider = ProviderInstanceId.make("codex");
const transport = {
  type: "streamable-http" as const,
  url: "https://weather.example.test/mcp",
  headers: [],
  authorization: { type: "none" as const },
};

const entry = (logicalServerId: string, name: string): ResolvedMcpCatalogEntry => ({
  logicalServerId: McpServerId.make(logicalServerId),
  transportDefinitionId: McpDefinitionId.make(`${logicalServerId}-definition`),
  name,
  transport,
  providerInstanceId: provider,
  scope: "project",
  scopeId: "project-1",
});

const proxy = () => {
  const registerSession: ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape["registerSession"] =
    vi.fn((input) =>
      Effect.succeed([
        {
          endpointHandle: `endpoint-${input.providerSessionId}`,
          endpoint: new URL("http://127.0.0.1/mcp/project/endpoint"),
          id: input.servers[0]?.id ?? McpServerId.make("missing"),
          name: input.servers[0]?.name ?? "missing",
        },
      ]),
    );
  return {
    registerSession,
    resolve: () => Effect.succeed(null).pipe(Effect.as(undefined)),
    handle: () => Effect.die("unused"),
    revokeProviderSession: vi.fn(() => Effect.void),
    revokeThread: () => Effect.void,
    revokeServer: () => Effect.void,
    revokeAll: Effect.void,
  } satisfies ProjectMcpProxyRegistry.ProjectMcpProxyRegistryShape;
};

it("uses deterministic namespaces for names and resources", () => {
  const serverId = McpServerId.make("weather-server");
  expect(McpCatalogGateway.namespaceName(serverId, "forecast")).toBe("mcp_weatherserver__forecast");
  expect(McpCatalogGateway.namespaceResourceUri(serverId, "https://example.test/weather")).toBe(
    `t3-mcp://${serverId}/aHR0cHM6Ly9leGFtcGxlLnRlc3Qvd2VhdGhlcg`,
  );
});

it("detects namespaced item and resource URI collisions", () => {
  expect(() =>
    McpCatalogGateway.aggregateCatalog([
      entry("weather", "forecast"),
      entry("weather", "forecast"),
    ]),
  ).toThrow(McpCatalogGateway.McpCatalogGatewayCollisionError);
  expect(() =>
    McpCatalogGateway.aggregateResourceUris([
      { logicalServerId: McpServerId.make("weather"), upstreamUri: "memory://forecast" },
      { logicalServerId: McpServerId.make("weather"), upstreamUri: "memory://forecast" },
    ]),
  ).toThrow(McpCatalogGateway.McpCatalogGatewayCollisionError);
});

it.effect("registers and swaps a catalog revision through the project proxy", () =>
  Effect.gen(function* () {
    const projectProxy = proxy();
    const gateway = yield* McpCatalogGateway.__testing.make.pipe(
      Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, projectProxy),
    );
    const input = {
      catalogSessionId: McpCatalogSessionId.make("catalog-1"),
      providerSessionId: "provider-1",
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: provider,
      revision: 1,
      entries: [entry("weather", "forecast")],
    };
    const first = yield* gateway.registerCatalogSession(input);
    expect(first.entries[0]?.exposedName).toBe("mcp_weather__forecast");
    expect(first.endpoints[0]?.name).toBe("mcp_weather__forecast");

    const second = yield* gateway.applyCatalogRevision({
      ...input,
      revision: 2,
      entries: [entry("weather", "forecast"), entry("search", "query")],
    });
    expect(second.revision).toBe(2);
    expect((yield* gateway.resolveCatalogSession(input.catalogSessionId))?.revision).toBe(2);
    expect(projectProxy.registerSession).toHaveBeenCalledTimes(2);
  }),
);
