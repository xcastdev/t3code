// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { OpenCodeDriver } from "./driver.ts";

const dependencies = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer({ runBackgroundWork: false }),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("The test must not contact a live provider")),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("resolves and probes the configured external instance through its own SDK endpoint", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-instance-skills-" });
    const project = path.join(root, "project");
    const remoteConfig = path.join(root, "remote-user", ".config", "opencode");
    yield* fs.makeDirectory(project, { recursive: true });
    yield* fs.makeDirectory(remoteConfig, { recursive: true });
    const requests: Array<URL> = [];
    const runtime = Layer.mock(OpenCodeRuntime.OpenCodeRuntime)({
      runOpenCodeCommand: () =>
        Effect.succeed({ stdout: "opencode v2.0.18\n", stderr: "", code: 0 }),
      createOpenCodeSdkClient: (input) =>
        createOpencodeClient({
          baseUrl: input.baseUrl,
          directory: input.directory,
          fetch: async (request) => {
            const url = new URL(request instanceof Request ? request.url : String(request));
            requests.push(url);
            expect(url.origin).toBe("https://configured-instance.example");
            if (url.pathname === "/path")
              return Response.json({
                config: remoteConfig,
                directory: project,
                worktree: project,
                state: root,
              });
            if (url.pathname !== "/file/content")
              throw new Error(`Unexpected request ${url.pathname}`);
            const probe = url.searchParams.get("path");
            if (!probe || !probe.startsWith(project + path.sep))
              return Response.json({ type: "text", content: "different filesystem" });
            return Response.json({ type: "text", content: await NodeFSP.readFile(probe, "utf8") });
          },
        }),
    });
    const instance = yield* OpenCodeDriver.create({
      instanceId: ProviderInstanceId.make("external-configured"),
      displayName: undefined,
      enabled: true,
      environment: [
        { name: "HOME", value: path.join(root, "unrelated-local-home"), sensitive: false },
      ],
      config: {
        ...OpenCodeDriver.defaultConfig(),
        serverUrl: "https://configured-instance.example",
      },
    }).pipe(Effect.provide(runtime));
    expect(instance.nativeSkillContentAccess).toBe("external");
    expect(instance.resolveSkillInstallTargets).toBeDefined();
    const targets = yield* instance.resolveSkillInstallTargets!(project);
    expect(targets.map((target) => target.id)).toEqual(["provider-project", "agents-project"]);
    expect(requests).toHaveLength(5);
    expect(yield* fs.readDirectory(project)).toEqual([]);
    expect(yield* fs.readDirectory(remoteConfig)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
