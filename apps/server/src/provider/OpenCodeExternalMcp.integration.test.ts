// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeAssert from "node:assert/strict";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  McpServerId,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { makeOpenCodeAdapter } from "./Layers/OpenCodeAdapter.ts";
import * as OpenCodeExternalMcpCoordinator from "./OpenCodeExternalMcpCoordinator.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "./opencodeRuntime.ts";
import { startOpenCodeExternalMcpFixture } from "./testUtils/openCodeExternalMcpFixture.ts";

class ExternalMcpFixtureError extends Data.TaggedError("ExternalMcpFixtureError")<{
  readonly cause: unknown;
}> {}

const runtime: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () => Effect.die("the external fixture never starts a local server"),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.succeed({
      url: serverUrl!,
      version: "fixture",
      exitCode: null,
      external: true,
    }),
  runOpenCodeCommand: () => Effect.die("the external fixture never invokes the CLI"),
  createOpenCodeSdkClient: ({ baseUrl, directory, serverPassword }) =>
    createOpencodeClient({
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
    }) as OpencodeClient,
  loadOpenCodeInventory: () => Effect.die("the external fixture does not load inventory"),
  loadOpenCodeSkills: () => Effect.succeed([]),
  loadInventoryFromCli: () => Effect.die("the external fixture does not load CLI inventory"),
  loadSkillsFromCli: () => Effect.succeed([]),
};

const adapterDependencies = Layer.mergeAll(
  Layer.succeed(OpenCodeRuntime, runtime),
  ServerConfig.layerTest(process.cwd(), process.cwd()),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("registers an external HTTP MCP client and disconnects it before release", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: startOpenCodeExternalMcpFixture,
          catch: (cause) => new ExternalMcpFixtureError({ cause }),
        }),
        (started) => Effect.promise(started.close),
      );
      const environmentId = EnvironmentId.make("external-mcp-integration-environment");
      const instanceId = ProviderInstanceId.make("external-mcp-integration-instance");
      const threadId = ThreadId.make("external-mcp-integration-thread");
      const coordinator = yield* OpenCodeExternalMcpCoordinator.make;
      const settings = yield* Schema.decodeUnknownEffect(OpenCodeSettings)({
        binaryPath: "unused-opencode",
        serverUrl: fixture.openCodeUrl,
        manageExternalMcp: true,
        externalMcpBaseUrl: "",
      });
      const adapter = yield* makeOpenCodeAdapter(settings, {
        environmentId,
        instanceId,
        externalMcpCoordinator: coordinator,
      }).pipe(Effect.provide(adapterDependencies));

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        cwd: "/fixture/workspace",
        projectMcpServers: [
          {
            id: McpServerId.make("external-mcp-integration-project"),
            name: "External MCP integration project",
            endpoint: new URL(fixture.mcpUrl),
            authorizationHeader: `Bearer ${fixture.token}`,
          },
        ],
      });

      const [name] = [...fixture.registeredClients.keys()];
      NodeAssert.ok(name);
      const toolResult = (yield* Effect.promise(() => fixture.invokeRegisteredTool(name))) as {
        content?: ReadonlyArray<{ readonly text?: string }>;
      };
      NodeAssert.equal(toolResult.content?.[0]?.text, "external-mcp-sentinel");

      yield* adapter.cleanupSessionMcp!(threadId);
      NodeAssert.deepEqual(fixture.status[name], { status: "disabled" });
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
