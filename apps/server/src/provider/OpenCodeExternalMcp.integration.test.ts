import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  McpServerId,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as OpenCodeExternalMcpCoordinator from "./OpenCodeExternalMcpCoordinator.ts";
import { makeOpenCodeAdapter } from "./Layers/OpenCodeAdapter.ts";
import * as ProviderAdapterRegistry from "./Services/ProviderAdapterRegistry.ts";
import * as ProviderEventLoggers from "./Layers/ProviderEventLoggers.ts";
import * as ProviderService from "./Layers/ProviderService.ts";
import * as ProviderServiceService from "./Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./Services/ProviderSessionDirectory.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectMcpService from "../project/ProjectMcpService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HttpServer } from "effect/unstable/http";
import { makeAdapterRegistryMock } from "./testUtils/providerAdapterRegistryMock.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "./opencodeRuntime.ts";
import { startOpenCodeExternalMcpFixture } from "./testUtils/openCodeExternalMcpFixture.ts";

class OpenCodeExternalMcpFixtureError extends Error {
  readonly _tag = "OpenCodeExternalMcpFixtureError" as const;
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Failed to start the external OpenCode MCP fixture.");
    this.cause = cause;
  }
}

const runtime: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () => Effect.die("local OpenCode is not used by this fixture"),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.succeed({
      url: serverUrl!,
      version: "1.15.13",
      exitCode: null,
      external: true,
    }),
  runOpenCodeCommand: () => Effect.die("OpenCode CLI is not used by this fixture"),
  createOpenCodeSdkClient: ({ baseUrl, directory, serverPassword }) => {
    const client = createOpencodeClient({
      baseUrl,
      directory,
      ...(serverPassword
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}`,
            },
          }
        : {}),
      throwOnError: true,
    });
    return new Proxy(client, {
      get(target, property, receiver) {
        if (property === "permission") {
          return { ...target.permission, list: async () => ({ data: [] }) };
        }
        if (property === "question") {
          return { ...target.question, list: async () => ({ data: [] }) };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as OpencodeClient;
  },
  loadOpenCodeInventory: () => Effect.die("inventory is not used by this fixture"),
  loadInventoryFromCli: () => Effect.die("inventory is not used by this fixture"),
};

const makeAdapterDependencies = () =>
  Layer.mergeAll(Layer.succeed(OpenCodeRuntime, runtime), NodeServices.layer).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  );

const integrationServices = OpenCodeExternalMcpCoordinator.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
);

const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const settingsFor = (serverUrl: string) =>
  decodeOpenCodeSettings({
    binaryPath: "unused-opencode",
    serverUrl,
    manageExternalMcp: true,
    externalMcpBaseUrl: "",
  });

const startInput = (threadId: ThreadId, endpoint: string) => ({
  provider: ProviderDriverKind.make("opencode"),
  threadId,
  runtimeMode: "full-access" as const,
  cwd: "/fixture/workspace",
  projectMcpServers: [
    {
      id: McpServerId.make("fixture-project-mcp"),
      name: "Fixture project MCP",
      endpoint: new URL(endpoint),
      authorizationHeader: "Bearer fixture-mcp-token",
    },
  ],
});

const findPreviewName = (fixture: Awaited<ReturnType<typeof startOpenCodeExternalMcpFixture>>) =>
  [...fixture.registeredClients.keys()].find((name) => name.endsWith("-preview"));

describe("external OpenCode MCP integration", () => {
  it.effect("invokes a real MCP tool through OpenCode's registered client", () => {
    const threadId = ThreadId.make("integration-external-mcp");
    const environmentId = EnvironmentId.make("integration-environment");
    const providerInstanceId = ProviderInstanceId.make("opencode-integration");

    return Effect.gen(function* () {
      const fixture = yield* Effect.tryPromise({
        try: startOpenCodeExternalMcpFixture,
        catch: (cause) => new OpenCodeExternalMcpFixtureError(cause),
      });

      yield* Effect.ensuring(
        Effect.scoped(
          Effect.gen(function* () {
            const coordinator =
              yield* OpenCodeExternalMcpCoordinator.OpenCodeExternalMcpCoordinator;
            const adapter = yield* makeOpenCodeAdapter(settingsFor(fixture.openCodeUrl), {
              environmentId,
              instanceId: providerInstanceId,
              externalMcpCoordinator: coordinator,
            }).pipe(Effect.provide(makeAdapterDependencies()));

            yield* Effect.sync(() =>
              McpProviderSession.setMcpProviderSession({
                environmentId,
                threadId,
                providerSessionId: "integration-provider-session",
                providerInstanceId,
                endpoint: fixture.mcpUrl,
                authorizationHeader: `Bearer ${fixture.token}`,
              }),
            );
            yield* adapter.startSession(startInput(threadId, fixture.mcpUrl));

            const previewName = findPreviewName(fixture);
            expect(previewName).toBeDefined();
            const result = (yield* Effect.promise(() =>
              fixture.invokeRegisteredTool(previewName!),
            )) as {
              content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
            };
            expect(result.content?.[0]?.text).toBe("external-mcp-sentinel");

            yield* adapter.cleanupSessionMcp!(threadId);
            yield* adapter.stopSession(threadId);
            expect(Object.values(fixture.status)).toEqual([
              { status: "disabled" },
              { status: "disabled" },
            ]);
            fixture.revokeToken();
            expect((yield* Effect.promise(fixture.probeWithRevokedToken)).status).toBe(401);
          }).pipe(Effect.provide(integrationServices)),
        ),
        Effect.gen(function* () {
          yield* Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId));
          yield* Effect.promise(fixture.close);
        }),
      );
    });
  });

  it.effect("revokes the real credential before ProviderService disconnects MCP", () => {
    const threadId = ThreadId.make("integration-provider-service-ordering");
    const environmentId = EnvironmentId.make("integration-provider-environment");
    const providerInstanceId = ProviderInstanceId.make("opencode");

    return Effect.gen(function* () {
      const fixture = yield* Effect.tryPromise({
        try: startOpenCodeExternalMcpFixture,
        catch: (cause) => new OpenCodeExternalMcpFixtureError(cause),
      });
      const fixturePort = Number(new URL(fixture.mcpUrl).port);
      const credentials = yield* McpSessionRegistry.__testing.make().pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(HttpServer.HttpServer, {
              address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: fixturePort },
              serve: () => Effect.void,
            }),
            Layer.succeed(ServerEnvironment.ServerEnvironment, {
              getEnvironmentId: Effect.succeed(environmentId),
              getDescriptor: Effect.die("descriptor is not used by this test"),
            }),
          ),
        ),
      );
      const activeTokens = new Set<string>();
      const issueCredential: typeof credentials.issue = (request) =>
        credentials.issue(request).pipe(
          Effect.tap(({ config }) =>
            Effect.sync(() => {
              const token = config.authorizationHeader.replace(/^Bearer\s+/, "");
              activeTokens.add(token);
            }),
          ),
        );
      let observedToken: string | undefined;
      fixture.setTokenValidator(async (token) => {
        observedToken = token;
        return activeTokens.has(token);
      });
      let tokenActiveWhenDisconnectStarted: boolean | undefined;
      fixture.setDisconnectObserver(async (_name, token) => {
        tokenActiveWhenDisconnectStarted =
          token === undefined ? undefined : activeTokens.has(token);
      });

      yield* Effect.ensuring(
        Effect.scoped(
          Effect.gen(function* () {
            const coordinator =
              yield* OpenCodeExternalMcpCoordinator.OpenCodeExternalMcpCoordinator;
            const adapter = yield* makeOpenCodeAdapter(settingsFor(fixture.openCodeUrl), {
              environmentId,
              instanceId: providerInstanceId,
              externalMcpCoordinator: coordinator,
            }).pipe(Effect.provide(makeAdapterDependencies()));
            const registry = makeAdapterRegistryMock({
              [ProviderDriverKind.make("opencode")]: adapter,
            });
            const projectLayer = Layer.mergeAll(
              Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
                getThreadShellById: () =>
                  Effect.succeed(Option.some({ projectId: ProjectId.make("fixture-project") })),
              } as never),
              Layer.succeed(ProjectMcpService.ProjectMcpService, {
                resolveForSession: () => Effect.succeed([]),
                acquireSessionLease: () =>
                  Effect.succeed({
                    servers: [],
                    resolveSecret: () => undefined,
                    oauthStateLeases: new Map(),
                  }),
                acquireResolvedSessionLease: (servers: ReadonlyArray<unknown>) =>
                  Effect.succeed({
                    servers,
                    resolveSecret: () => undefined,
                    oauthStateLeases: new Map(),
                  }),
                withCatalogMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
              } as never),
            );
            const bindings = new Map<ThreadId, ProviderSessionDirectory.ProviderRuntimeBinding>();
            const directoryLayer = Layer.succeed(
              ProviderSessionDirectory.ProviderSessionDirectory,
              {
                upsert: (binding) =>
                  Effect.sync(() => {
                    bindings.set(binding.threadId, binding);
                  }),
                getProvider: (id) => {
                  const binding = bindings.get(id);
                  return binding === undefined
                    ? Effect.die(`No provider binding for '${id}'.`)
                    : Effect.succeed(binding.provider);
                },
                getBinding: (id) => {
                  const binding = bindings.get(id);
                  return Effect.succeed(
                    binding === undefined ? Option.none() : Option.some(binding),
                  );
                },
                listThreadIds: () => Effect.succeed([...bindings.keys()]),
                listBindings: () =>
                  Effect.succeed(
                    [...bindings.values()].map((binding) => ({
                      ...binding,
                      lastSeenAt: "2026-01-01T00:00:00.000Z",
                    })),
                  ),
              },
            );
            const providerLayer = ProviderService.makeProviderServiceLive({
              issueMcpCredential: issueCredential,
              revokeMcpCredential: (id) =>
                credentials
                  .revokeThread(id)
                  .pipe(Effect.tap(() => Effect.sync(() => activeTokens.clear()))),
            }).pipe(
              Layer.provide(projectLayer),
              Layer.provide(
                Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry),
              ),
              Layer.provide(directoryLayer),
              Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
              Layer.provide(
                ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
                  Layer.provide(NodeServices.layer),
                ),
              ),
              Layer.provide(AnalyticsService.layerTest),
              Layer.provide(
                Layer.succeed(
                  ProviderEventLoggers.ProviderEventLoggers,
                  ProviderEventLoggers.NoOpProviderEventLoggers,
                ),
              ),
            );
            const provider = yield* ProviderServiceService.ProviderService.pipe(
              Effect.provide(providerLayer),
            );
            const started = yield* provider.startSession(threadId, {
              provider: ProviderDriverKind.make("opencode"),
              providerInstanceId,
              threadId,
              runtimeMode: "full-access",
              cwd: "/fixture/workspace",
            });
            expect(started.provider).toBe("opencode");
            expect(observedToken).toBeDefined();
            expect(yield* credentials.resolve(observedToken!)).toBeDefined();
            const previewName = findPreviewName(fixture);
            expect(previewName).toBeDefined();
            const result = (yield* Effect.promise(() =>
              fixture.invokeRegisteredTool(previewName!),
            )) as { content?: ReadonlyArray<{ readonly text?: string }> };
            expect(result.content?.[0]?.text).toBe("external-mcp-sentinel");

            yield* provider.stopSession({ threadId });

            expect(tokenActiveWhenDisconnectStarted).toBe(false);
            expect(Object.values(fixture.status)).toEqual([{ status: "disabled" }]);
          }).pipe(Effect.provide(integrationServices)),
        ),
        Effect.gen(function* () {
          yield* credentials.revokeAll;
          yield* Effect.promise(fixture.close);
        }),
      );
    });
  });

  it.effect("rejects a second provider instance before it mutates the fixture", () => {
    const firstThread = ThreadId.make("integration-first");
    const secondThread = ThreadId.make("integration-second");
    const environmentId = EnvironmentId.make("integration-environment");

    return Effect.gen(function* () {
      const fixture = yield* Effect.tryPromise({
        try: startOpenCodeExternalMcpFixture,
        catch: (cause) => new OpenCodeExternalMcpFixtureError(cause),
      });

      yield* Effect.ensuring(
        Effect.scoped(
          Effect.gen(function* () {
            const coordinator =
              yield* OpenCodeExternalMcpCoordinator.OpenCodeExternalMcpCoordinator;
            const first = yield* makeOpenCodeAdapter(settingsFor(fixture.openCodeUrl), {
              environmentId,
              instanceId: ProviderInstanceId.make("opencode-first"),
              externalMcpCoordinator: coordinator,
            }).pipe(Effect.provide(makeAdapterDependencies()));
            const second = yield* makeOpenCodeAdapter(settingsFor(fixture.openCodeUrl), {
              environmentId,
              instanceId: ProviderInstanceId.make("opencode-second"),
              externalMcpCoordinator: coordinator,
            }).pipe(Effect.provide(makeAdapterDependencies()));
            yield* Effect.sync(() =>
              McpProviderSession.setMcpProviderSession({
                environmentId,
                threadId: firstThread,
                providerSessionId: "integration-first-session",
                providerInstanceId: ProviderInstanceId.make("opencode-first"),
                endpoint: fixture.mcpUrl,
                authorizationHeader: `Bearer ${fixture.token}`,
              }),
            );
            yield* Effect.sync(() =>
              McpProviderSession.setMcpProviderSession({
                environmentId,
                threadId: secondThread,
                providerSessionId: "integration-second-session",
                providerInstanceId: ProviderInstanceId.make("opencode-second"),
                endpoint: fixture.mcpUrl,
                authorizationHeader: `Bearer ${fixture.token}`,
              }),
            );
            yield* first.startSession(startInput(firstThread, fixture.mcpUrl));
            const before = Object.keys(fixture.config).length;
            const secondResult = yield* second
              .startSession(startInput(secondThread, fixture.mcpUrl))
              .pipe(Effect.result);
            expect(secondResult._tag).toBe("Failure");
            expect(Object.keys(fixture.config).length).toBe(before);
            yield* first.cleanupSessionMcp!(firstThread);
            yield* first.stopSession(firstThread);
          }).pipe(Effect.provide(integrationServices)),
        ),
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            McpProviderSession.clearMcpProviderSession(firstThread);
            McpProviderSession.clearMcpProviderSession(secondThread);
          });
          yield* Effect.promise(fixture.close);
        }),
      );
    });
  });
});
