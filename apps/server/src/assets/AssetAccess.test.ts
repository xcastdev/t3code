// @effect-diagnostics nodeBuiltinImport:off - tests inject swaps at the native open boundary.
import { ownedOmpSessionDirectory } from "@t3tools/provider-omp/server";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeOmpEvalEnvelope } from "@t3tools/shared/ompEval";
import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeCrypto from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import { chromium } from "playwright-core";
import {
  makeStaticRelayEdge,
  connectStaticRelayTunnel,
} from "@t3tools/relay-core/RelayTunnelTransport";
import {
  AuthFilesystemReadScope,
  AuthSessionId,
  EnvironmentId,
  AssetAccessError,
  AssetCreateUrlInput,
  AssetPreviewTypeValidationError,
  PluginId,
  type PluginManifest,
  type PluginRegistrySnapshot,
  SOURCE_CONTROL_MEDIA_ASSET,
  ThreadId,
  TurnItemId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { vi } from "vite-plus/test";

import { serveLoopback } from "../relay/fixtures/p1bIngress.testkit.ts";
import * as Browser from "../preview/ServerBrowser.ts";
import * as Renderer from "../preview/LocalAssetNavigation.ts";
import * as BrowserStream from "../preview/ServerBrowserStream.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as Manager from "../preview/Manager.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as AssetSigner from "./AssetSigner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { makeFakeWslHost } from "../testUtils/fakeWsl.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PluginPackageStore from "../plugins/PluginPackageStore.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { assetFileResponse, layerAssetRoute } from "../http.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, readMcpAppHtml, resolveAsset } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { fakeSourceControlDriverInstance } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { sourceControlMediaResponse } from "./sourceControlMediaResponse.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-test-",
});
const screenshotPng = new Uint8Array(24);
screenshotPng.set([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
new DataView(screenshotPng.buffer).setUint32(16, 390);
new DataView(screenshotPng.buffer).setUint32(20, 844);
const screenshotItem = {
  id: TurnItemId.make("tool-screenshot"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "mcp__t3-code__device_screenshot",
  input: { deviceId: "phone" },
  output: {
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from(screenshotPng).toString("base64"),
        },
      },
    ],
  },
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};

const ompLiveScreenshotItem = {
  ...screenshotItem,
  id: TurnItemId.make("omp-live-image"),
  toolName: "eval",
  output: {
    t3OmpEval: makeOmpEvalEnvelope({ revision: 1, status: "running", language: "python" }),
    content: [{ type: "text", text: "live" }],
    details: {
      images: [
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from(screenshotPng).toString("base64"),
        },
      ],
    },
  },
};

const oversizedScreenshotItem = {
  ...screenshotItem,
  id: TurnItemId.make("tool-screenshot-oversized"),
  output: {
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(14 * 1024 * 1024) },
      },
    ],
  },
};

const echoPluginId = PluginId.make("echo");
const echoManifest = (version: string): PluginManifest => ({
  manifestVersion: 1,
  id: echoPluginId,
  name: "Echo",
  version,
  hostApi: "1.0",
  author: "T3 Tests",
  ui: { panels: [{ id: "main", title: "Main", entry: "panels/main.html" }], commands: [] },
  capabilities: [],
});

const makePluginStore = Effect.fn("test.makePluginStore")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-panels-" });
  const registry = yield* Ref.make<PluginRegistrySnapshot>({ installed: [], retainedData: [] });
  const paths = (pluginId: PluginId, version: string) => ({
    packageDir: path.join(root, "packages", pluginId, version),
    dataDir: path.join(root, "data", pluginId),
    configPath: path.join(root, "config", `${pluginId}.json`),
  });
  const panelPath = (version: string) =>
    path.join(paths(echoPluginId, version).packageDir, "panels", "main.html");
  const stage = Effect.fn("test.stagePluginVersion")(function* (version: string) {
    yield* fs.makeDirectory(path.dirname(panelPath(version)), { recursive: true });
    yield* fs.writeFileString(panelPath(version), `<html>panel ${version}</html>`);
  });
  const activate = (version: string | null, enabled = true) =>
    Ref.set(registry, {
      installed:
        version === null
          ? []
          : [
              {
                pluginId: echoPluginId,
                version,
                name: "Echo",
                author: "T3 Tests",
                enabled,
                status: enabled ? "stopped" : "disabled",
                manifest: echoManifest(version),
              },
            ],
      retainedData: [],
    });
  return {
    layer: Layer.mock(PluginPackageStore.PluginPackageStore)({
      snapshot: Ref.get(registry),
      paths,
    }),
    panelPath,
    stage,
    activate,
  };
});

const resolveIssuedUrl = (relativeUrl: string) => {
  const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  const separator = suffix.indexOf("/");
  return resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
};

const layerTest = Layer.mergeAll(
  NodeHttpPlatform.layer,
  Layer.mock(PluginPackageStore.PluginPackageStore)({
    snapshot: Effect.succeed({ installed: [], retainedData: [] }),
    paths: () => ({ packageDir: "", dataDir: "", configPath: "" }),
  }),
  Layer.mock(Orchestrator.OrchestratorV2)({
    getTurnItem: ({ itemId }) =>
      Effect.succeed(
        itemId === screenshotItem.id
          ? screenshotItem
          : itemId === ompLiveScreenshotItem.id
            ? ompLiveScreenshotItem
            : itemId === oversizedScreenshotItem.id
              ? oversizedScreenshotItem
              : null,
      ),
  }),
  layerConfig,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(layerConfig)),
  AssetSigner.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provide(layerConfig))),
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, EffectNodeCrypto.layer)));

const decodeAssetResource = Schema.decodeUnknownOption(AssetCreateUrlInput);
describe("AssetAccess", () => {
  it("validates provider artifact IDs without URI paths or selectors", () => {
    const resource = {
      _tag: "provider-output-artifact",
      threadId: "thread-1",
      turnItemId: "tool-1",
    };
    for (const artifactId of ["0", "12", "12345678901234567890123456789012"])
      expect(decodeAssetResource({ resource: { ...resource, artifactId } })._tag).toBe("Some");
    for (const artifactId of [
      "",
      "../0",
      "-1",
      "%30",
      "artifact://0",
      "0:raw:1-9",
      "0.eval.log",
      "1".repeat(33),
    ])
      expect(decodeAssetResource({ resource: { ...resource, artifactId } })._tag).toBe("None");
  });
  describe("readMcpAppHtml", () => {
    it.effect("accepts snapshots at the stored HTML byte limit", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const file = path.join(directory, "app.html");
        const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
        yield* fileSystem.writeFile(file, new Uint8Array(limit).fill(120));

        const bytes = yield* readMcpAppHtml(file);
        expect(bytes?.byteLength).toBe(limit);
        expect(bytes?.every((byte) => byte === 120)).toBe(true);
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, EffectNodeCrypto.layer))),
    );

    it.effect("rejects snapshots one byte past the limit and much larger files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const file = path.join(directory, "app.html");
        const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
        for (const size of [limit + 1, limit * 2]) {
          yield* fileSystem.writeFile(file, new Uint8Array(size).fill(120));
          expect(yield* readMcpAppHtml(file)).toBeNull();
        }
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, EffectNodeCrypto.layer))),
    );

    it.effect("preserves UTF-8 bytes across stream chunks and accepts empty snapshots", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const file = path.join(directory, "app.html");
        for (const html of ["", "<body>" + "☃".repeat(100_000) + "</body>"]) {
          const expected = new TextEncoder().encode(html);
          yield* fileSystem.writeFile(file, expected);
          const bytes = yield* readMcpAppHtml(file);
          expect(bytes?.byteLength).toBe(expected.byteLength);
          expect(bytes && new TextDecoder().decode(bytes)).toBe(html);
        }
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, EffectNodeCrypto.layer))),
    );

    // regression: #17026 apply host color scheme to saved MCP apps
    it.effect("preserves filesystem failures instead of reporting oversized HTML", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const error = yield* readMcpAppHtml(path.join(directory, "missing.html")).pipe(Effect.flip);
        expect(error._tag).toBe("PlatformError");
        expect(error.reason._tag).toBe("NotFound");
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, EffectNodeCrypto.layer))),
    );
  });

  it.effect.each([
    "valid",
    "detached",
    "unreferenced",
    "wrong-thread",
    "foreign-session",
    "wrong-instance",
    "wrong-session",
    "foreign-journal",
    "wrong-driver",
    "missing",
    "ambiguous",
    "artifact-symlink",
    "root-symlink",
    "replacement",
    "retired-reference",
  ] as const)("provider artifact %s stays owned and identity-bound", (scenario) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("omp-test"),
        driver = ProviderDriverKind.make("omp"),
        threadId = screenshotItem.threadId;
      const providerThreadId = ProviderThreadId.make("omp-provider-thread"),
        providerSessionId = ProviderSessionId.make("omp-session");
      const root = ownedOmpSessionDirectory(config.stateDir, instanceId);
      const journal = path.join(root, "owned.jsonl"),
        directory = path.join(root, "owned"),
        file = path.join(directory, "0.eval.log");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(journal, '{"type":"session","id":"owned-native"}\n');
      yield* fs.writeFileString(file, "Complete native output");
      const now = yield* DateTime.now;
      let projection: OrchestrationV2ThreadProjection = {
        thread: {
          ...liveThreadShell(threadId),
          lastVisitedAt: null,
          settledOverride: null,
          settledAt: null,
          archivedAt: null,
          deletedAt: null,
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "default" },
        },
        runs: [],
        attempts: [],
        nodes: [],
        subagents: [],
        providerSessions: [
          {
            id: providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "stopped",
            cwd: config.cwd,
            model: null,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        ],
        providerThreads: [
          {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: journal, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "not_loaded",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            goal: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        providerTurns: [],
        runtimeRequests: [],
        messages: [],
        plans: [],
        turnItems: [],
        checkpointScopes: [],
        checkpoints: [],
        contextHandoffs: [],
        contextTransfers: [],
        visibleTurnItems: [],
        updatedAt: now,
      };
      let item = {
        ...screenshotItem,
        id: TurnItemId.make("omp-artifact"),
        providerThreadId,
        nativeItemRef: { driver, nativeId: "native-tool", strength: "strong" as const },
        toolName: "eval",
        output: { content: [], details: { meta: { truncation: { artifactId: "0" } } } },
      };
      const owner = projection.providerThreads[0]!;
      const outsider = path.join(config.baseDir, "outside.log");
      yield* fs.writeFileString(outsider, "Private outside data");
      if (scenario === "detached")
        projection = { ...projection, providerThreads: [{ ...owner, providerSessionId: null }] };
      if (scenario === "unreferenced")
        item = {
          ...item,
          output: { content: [], details: { meta: { truncation: { artifactId: "9" } } } },
        };
      if (scenario === "wrong-thread")
        item = { ...item, threadId: ThreadId.make("another-thread") };
      if (scenario === "foreign-session")
        projection = {
          ...projection,
          providerThreads: [{ ...owner, appThreadId: ThreadId.make("another-thread") }],
        };
      if (scenario === "wrong-instance")
        projection = {
          ...projection,
          providerThreads: [
            { ...owner, providerInstanceId: ProviderInstanceId.make("other-instance") },
          ],
        };
      if (scenario === "wrong-session")
        projection = {
          ...projection,
          providerThreads: [
            { ...owner, providerSessionId: ProviderSessionId.make("foreign-session") },
          ],
        };
      if (scenario === "foreign-journal") {
        const foreign = path.join(config.baseDir, "foreign.jsonl");
        yield* fs.writeFileString(foreign, '{"type":"session","id":"foreign"}');
        projection = {
          ...projection,
          providerThreads: [
            { ...owner, nativeThreadRef: { driver, nativeId: foreign, strength: "strong" } },
          ],
        };
      }
      if (scenario === "wrong-driver")
        item = {
          ...item,
          nativeItemRef: { ...item.nativeItemRef, driver: ProviderDriverKind.make("codex") },
        };
      if (scenario === "missing") yield* fs.remove(file);
      if (scenario === "ambiguous")
        yield* fs.writeFileString(path.join(directory, "0.read.log"), "Ambiguous output");
      if (scenario === "artifact-symlink") {
        yield* fs.remove(file);
        yield* fs.symlink(outsider, file);
      }
      if (scenario === "root-symlink") {
        const foreign = path.join(config.baseDir, "foreign-artifacts");
        yield* fs.makeDirectory(foreign);
        yield* fs.writeFileString(path.join(foreign, "0.eval.log"), "Foreign");
        yield* fs.remove(directory, { recursive: true });
        yield* fs.symlink(foreign, directory);
      }
      const delegate = yield* Orchestrator.OrchestratorV2;
      const service = Orchestrator.OrchestratorV2.of({
        ...delegate,
        getTurnItem: () => Effect.succeed(item),
        getThreadRecords: () => Effect.succeed(projection),
      });
      const resource = {
        _tag: "provider-output-artifact" as const,
        threadId,
        turnItemId: item.id,
        artifactId: "0",
      };
      yield* Effect.gen(function* () {
        if (!["valid", "detached", "replacement", "retired-reference"].includes(scenario)) {
          expect(yield* issueAssetUrl({ resource }).pipe(Effect.flip)).toMatchObject({
            _tag: "AssetWorkspaceAssetNotFoundError",
          });
          return;
        }
        const result = yield* issueAssetUrl({ resource });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length),
          split = suffix.indexOf("/"),
          token = suffix.slice(0, split),
          name = suffix.slice(split + 1);
        if (scenario === "replacement") {
          const replacement = path.join(directory, "replacement.log");
          yield* fs.writeFileString(replacement, "Replaced");
          yield* fs.rename(replacement, file);
        }
        if (scenario === "retired-reference")
          item = {
            ...item,
            output: { content: [], details: { meta: { truncation: { artifactId: "9" } } } },
          };
        const resolved = yield* resolveAsset(token, name);
        if (scenario === "replacement" || scenario === "retired-reference") {
          expect(resolved).toBeNull();
          return;
        }
        expect(resolved).toMatchObject({
          kind: "file",
          mimeType: "application/octet-stream",
          download: true,
          fileName: "0.eval.log",
        });
        if (resolved?.kind !== "file" || !("file" in resolved) || !resolved.file)
          throw new Error("Expected validated descriptor");
        const response = HttpServerResponse.toWeb(yield* assetFileResponse(resolved));
        expect(response.headers.get("content-disposition")).toContain("attachment;");
        expect(response.headers.get("content-type")).toBe("application/octet-stream");
        expect(yield* Effect.promise(() => response.text())).toBe("Complete native output");
        expect(yield* resolveAsset(token, "other.log")).toBeNull();
      }).pipe(Effect.provideService(Orchestrator.OrchestratorV2, service));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([screenshotItem, ompLiveScreenshotItem])(
    "serves an image returned by $toolName from the stored item",
    (item) =>
      Effect.gen(function* () {
        const resource = {
          _tag: "tool-output-image" as const,
          threadId: item.threadId,
          itemId: item.id,
          index: 0,
        };
        const result = yield* issueAssetUrl({ resource });
        expect(result.imageDimensions).toEqual({ width: 390, height: 844 });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
        ).toEqual({
          kind: "bytes",
          mimeType: "image/png",
          bytes: Buffer.from(screenshotPng),
        });
        const missing = yield* issueAssetUrl({ resource: { ...resource, index: 1 } }).pipe(
          Effect.flip,
        );
        expect(missing._tag).toBe("AssetWorkspaceAssetNotFoundError");
        const oversized = yield* issueAssetUrl({
          resource: { ...resource, itemId: oversizedScreenshotItem.id },
        }).pipe(Effect.flip);
        expect(oversized._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves the background image published beside an environment theme", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(environmentThemesDir, { recursive: true });
      const imagePath = `${environmentThemesDir}/frieren.png`;
      yield* fs.writeFile(imagePath, screenshotPng);
      const result = yield* issueAssetUrl({
        resource: { _tag: "environment-theme-background", themeId: "frieren" },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const token = suffix.slice(0, separator);
      const asset = yield* resolveAsset(token, suffix.slice(separator + 1));
      expect(asset).toMatchObject({ kind: "file", path: yield* fs.realPath(imagePath) });
      if (asset?.kind !== "file") return;
      const response = yield* assetFileResponse(asset);
      expect(response.headers["content-type"]).toBe("image/png");

      yield* fs.remove(imagePath);
      expect(yield* resolveAsset(token, suffix.slice(separator + 1))).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("issues exact URLs for media and browser documents outside the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-root-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-outside-" });
      for (const [name, mimeType] of [
        ["screenshot.png", "image/png"],
        ["recording.mp4", "video/mp4"],
        ["recording.webm", "video/webm"],
        ["report.html", "text/html"],
        ["report.pdf", "application/pdf"],
        ["notes.odt", "application/vnd.oasis.opendocument.text"],
        ["budget.ods", "application/vnd.oasis.opendocument.spreadsheet"],
        ["slides.odp", "application/vnd.oasis.opendocument.presentation"],
        ["notes.rtf", "application/rtf"],
        ["book.epub", "application/epub+zip"],
        ["analysis.ipynb", "application/x-ipynb+json"],
        ["tone.wav", "audio/wav"],
        ["tone.webm-audio", "audio/webm"],
        ["archive.zip", "application/zip"],
        ["archive.jar", "application/java-archive"],
        ["archive.tar", "application/x-tar"],
        ["archive.gz", "application/gzip"],
        ["archive.tgz", "application/gzip"],
        ["data.sqlite", "application/vnd.sqlite3"],
        ["data.sqlite3", "application/vnd.sqlite3"],
        ["data.db", "application/vnd.sqlite3"],
      ] as const) {
        const filePath = path.join(outside, name);
        yield* fs.writeFileString(filePath, "media");
        const canonicalFile = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        expect(yield* resolveAsset(token, suffix.slice(separator + 1))).toMatchObject({
          kind: "file",
          path: canonicalFile,
          mimeType,
        });
        yield* fs.writeFileString(path.join(outside, "sibling.png"), "private sibling");
        expect(yield* resolveAsset(token, "sibling.png")).toBeNull();
        expect(yield* resolveAsset(token, `../${name}`)).toBeNull();
        expect(yield* resolveAsset(`${token}tampered`, name)).toBeNull();
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("downloads any linked file with the same exact-file identity checks as media", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-download-root-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-download-outside-" });
      for (const name of [
        "data.csv",
        "report.docx",
        "sheet.xlsx",
        "slides.pptx",
        "archive.zip",
        "no-extension",
      ]) {
        for (const directory of [root, outside]) {
          const filePath = path.join(directory, name);
          yield* fs.writeFileString(filePath, "shared file bytes");
          const resource = {
            _tag: "media-file" as const,
            threadId: ThreadId.make("thread-1"),
            path: directory === root ? name : filePath,
            disposition: "attachment" as const,
          };
          const result = yield* issueAssetUrl({ resource, workspaceRoot: root });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          const token = suffix.slice(0, separator);
          const asset = yield* resolveAsset(token, suffix.slice(separator + 1));
          expect(asset).toMatchObject({
            kind: "file",
            download: true,
            fileName: name,
            mimeType: "application/octet-stream",
          });
          if (asset?.kind !== "file") throw new Error("Expected a downloadable file");
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset));
          expect(response.headers.get("content-disposition")).toContain("attachment;");
          expect(response.headers.get("content-type")).toBe("application/octet-stream");
          expect(yield* Effect.promise(() => response.text())).toBe("shared file bytes");
          expect(yield* resolveAsset(token, "sibling.docx")).toBeNull();
          expect(yield* resolveAsset(token, `../${name}`)).toBeNull();
          expect(yield* resolveAsset(`${token}tampered`, name)).toBeNull();
          yield* fs.rename(filePath, `${filePath}.original`);
          yield* fs.writeFileString(filePath, "replacement bytes");
          expect(yield* resolveAsset(token, name)).toBeNull();
        }
      }
      const directoryError = yield* issueAssetUrl({
        resource: {
          _tag: "media-file",
          threadId: ThreadId.make("thread-1"),
          path: root,
          disposition: "attachment",
        },
      }).pipe(Effect.flip);
      expect(directoryError._tag).toBe("AssetWorkspaceAssetNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("resolves relative media paths from the thread workspace, including outside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-relative-" });
      const root = path.join(directory, "workspace");
      yield* fs.makeDirectory(root);
      for (const relativePath of ["screenshot.png", "../recording.mp4"]) {
        const filePath = path.resolve(root, relativePath);
        yield* fs.writeFileString(filePath, "media");
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: relativePath },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
        ).toMatchObject({
          kind: "file",
          path: yield* fs.realPath(filePath),
        });
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("previews draft audio and video from relative workspace paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-media-" });
      for (const [name, mimeType] of [
        ["video.mp4", "video/mp4"],
        ["audio.wav", "audio/wav"],
      ] as const) {
        const filePath = path.join(root, name);
        yield* fs.writeFileString(filePath, "media bytes");
        const result = yield* issueAssetUrl({
          resource: { _tag: "draft-workspace-file", cwd: root, path: name },
          workspaceRoot: root,
        });
        expect(result.fileRevision).toEqual(expect.any(String));
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        const asset = yield* resolveAsset(token, suffix.slice(separator + 1));
        expect(asset).toMatchObject({ kind: "file", path: yield* fs.realPath(filePath), mimeType });
        if (asset?.kind !== "file") throw new Error("Expected draft media file");
        for (const [range, status, body] of [
          [undefined, 200, "media bytes"],
          ["bytes=2-5", 206, "dia "],
        ] as const) {
          const resolved = yield* resolveAsset(token, suffix.slice(separator + 1));
          if (resolved?.kind !== "file") throw new Error("Expected draft media file");
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(resolved, range));
          expect(response.status).toBe(status);
          expect(response.headers.get("content-type")).toBe(mimeType);
          expect(response.headers.get("content-length")).toBe(String(body.length));
          if (range) expect(response.headers.get("content-range")).toBe("bytes 2-5/11");
          expect(yield* Effect.promise(() => response.text())).toBe(body);
        }
        for (const requestedPath of [
          name === "video.mp4" ? "audio.wav" : "video.mp4",
          `../${name}`,
        ]) {
          expect(yield* resolveAsset(token, requestedPath)).toBeNull();
        }
        expect(yield* resolveAsset(`${token}tampered`, name)).toBeNull();
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "rejects draft media escapes and disallowed types without enabling non-draft media",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-boundary-" });
        const root = path.join(directory, "workspace");
        yield* fs.makeDirectory(root);
        for (const name of ["video.mp4", "audio.wav", "secret.txt"]) {
          yield* fs.writeFileString(path.join(root, name), "workspace bytes");
          yield* fs.writeFileString(path.join(directory, name), "outside bytes");
        }
        for (const [requestedPath, tag] of [
          ["../video.mp4", "AssetWorkspacePathValidationError"],
          ["../audio.wav", "AssetWorkspacePathValidationError"],
          ["secret.txt", "AssetPreviewTypeValidationError"],
        ] as const) {
          const error = yield* issueAssetUrl({
            resource: { _tag: "draft-workspace-file", cwd: root, path: requestedPath },
            workspaceRoot: root,
          }).pipe(Effect.flip);
          expect(error._tag).toBe(tag);
        }
        for (const name of ["video.mp4", "audio.wav"]) {
          const error = yield* issueAssetUrl({
            resource: { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: name },
            workspaceRoot: root,
          }).pipe(Effect.flip);
          expect(error._tag).toBe("AssetPreviewTypeValidationError");
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects draft media symlinks escaping the workspace or targeting disallowed types",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-symlink-" });
        const root = path.join(directory, "workspace");
        yield* fs.makeDirectory(root);
        const outside = path.join(directory, "outside.mp4");
        const secret = path.join(root, "secret.txt");
        yield* fs.writeFileString(outside, "outside bytes");
        yield* fs.writeFileString(secret, "private bytes");
        for (const [name, target] of [
          ["escape.mp4", outside],
          ["disguised.wav", secret],
        ] as const) {
          yield* fs.symlink(target, path.join(root, name));
          const error = yield* issueAssetUrl({
            resource: { _tag: "draft-workspace-file", cwd: root, path: name },
            workspaceRoot: root,
          }).pipe(Effect.flip);
          expect(["AssetWorkspaceAssetNotFoundError", "AssetPreviewTypeValidationError"]).toContain(
            error._tag,
          );
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "preserves absolute draft previews through stable symlinks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-absolute-" });
        for (const extension of ["png", "mp4", "wav"]) {
          const target = path.join(root, `target.${extension}`);
          const alias = path.join(root, `alias.${extension}`);
          yield* fs.writeFileString(target, "preview bytes");
          yield* fs.symlink(target, alias);
          const result = yield* issueAssetUrl({
            resource: { _tag: "draft-workspace-file", cwd: root, path: alias },
            workspaceRoot: root,
          });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          expect(
            yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
          ).toMatchObject({ kind: "file", path: yield* fs.realPath(target) });
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a draft media path swapped after workspace containment validation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-swap-" });
        const root = path.join(directory, "workspace");
        yield* fs.makeDirectory(root);
        const filePath = path.join(root, "video.mp4");
        const outside = path.join(directory, "outside.mp4");
        yield* fs.writeFileString(filePath, "workspace video");
        yield* fs.writeFileString(outside, "outside video");
        const canonicalFile = yield* fs.realPath(filePath);
        let swapped = false;
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          stat: Effect.fn(function* (requestedPath) {
            const info = yield* fs.stat(requestedPath);
            if (requestedPath === canonicalFile && !swapped) {
              swapped = true;
              yield* fs.remove(filePath);
              yield* fs.symlink(outside, filePath);
            }
            return info;
          }),
        });
        const result = yield* issueAssetUrl({
          resource: { _tag: "draft-workspace-file", cwd: root, path: "video.mp4" },
          workspaceRoot: root,
        }).pipe(Effect.result, Effect.provideService(FileSystem.FileSystem, swappingFileSystem));
        expect(swapped).toBe(true);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "AssetWorkspaceAssetNotFoundError" },
        });
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["media-file", "draft-workspace-file"] as const)(
    "resolves home-relative %s paths independently of the workspace",
    (tag) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-home-" });
        const home = path.join(directory, "var", "home", "alice");
        const filePath = path.join(home, "Downloads", "repro.mp4");
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, "recording bytes");
        const canonicalFile = yield* fs.realPath(filePath);
        yield* Effect.gen(function* () {
          for (const workspaceRoot of [
            path.join(home, "project"),
            path.join(directory, "srv", "project"),
            undefined,
          ]) {
            if (workspaceRoot) yield* fs.makeDirectory(workspaceRoot, { recursive: true });
            for (const requestedPath of ["~/Downloads/repro.mp4", "~\\Downloads/repro.mp4"]) {
              const result = yield* issueAssetUrl({
                resource: {
                  ...(tag === "media-file"
                    ? { _tag: tag, threadId: ThreadId.make("thread-1") }
                    : { _tag: tag, cwd: workspaceRoot ?? directory }),
                  path: requestedPath,
                },
                ...(workspaceRoot ? { workspaceRoot } : {}),
              });
              const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
              const separator = suffix.indexOf("/");
              const asset = yield* resolveAsset(
                suffix.slice(0, separator),
                suffix.slice(separator + 1),
              );
              expect(asset).toMatchObject({
                kind: "file",
                path: canonicalFile,
                mimeType: "video/mp4",
              });
              if (asset?.kind !== "file") throw new Error("Expected a resolved home media file");
              const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset));
              expect(yield* Effect.promise(() => response.text())).toBe("recording bytes");
            }
          }
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "resolves a Windows drive media path under WSL to where wslpath mounts it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { mountRoot, underWsl } = yield* makeFakeWslHost;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-wsl-root-" });
        const filePath = path.join(mountRoot, "c", "Users", "me", "Pictures", "shot.png");
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFile(filePath, screenshotPng);
        const canonicalFile = yield* fs.realPath(filePath);
        const drivePath = "C:\\Users\\me\\Pictures\\shot.png";

        for (const resource of [
          { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: drivePath },
          { _tag: "draft-workspace-file", cwd: workspaceRoot, path: drivePath },
        ] as const) {
          const result = yield* underWsl(issueAssetUrl({ resource, workspaceRoot }));
          expect(result.imageDimensions).toEqual({ width: 390, height: 844 });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          expect(
            yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
          ).toMatchObject({ kind: "file", path: canonicalFile, mimeType: "image/png" });
        }
      }).pipe(Effect.provide(layerTest)),
  );

  // Resolving `file://attacker.test/share/cat.jpg` from an agent's markdown sent the
  // Windows user's NTLM credentials to attacker.test.
  it.effect("never resolves a network media path outside the thread's project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolved: Array<string> = [];
      const recordingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        realPath: (requestedPath) => {
          resolved.push(requestedPath);
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "realPath",
              pathOrDescriptor: requestedPath,
            }),
          );
        },
      });
      const share = "//nas.test/share/project";
      for (const resource of [
        {
          _tag: "media-file",
          threadId: ThreadId.make("thread-1"),
          path: "//attacker.test/s/a.png",
        },
        { _tag: "draft-workspace-file", cwd: share, path: "//attacker.test/s/a.png" },
        { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: `${share}/a.png` },
      ] as const) {
        const error = yield* issueAssetUrl({ resource, workspaceRoot: share }).pipe(
          Effect.provideService(FileSystem.FileSystem, recordingFileSystem),
          Effect.flip,
        );
        expect(error._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }
      expect(resolved).toEqual([path.resolve(`${share}/a.png`)]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects non-previewable files, disguised targets, and directories",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-validation-" });
        for (const name of ["report.md", "secret.txt", "secret.%70ng", "secret.png#private.txt"]) {
          const filePath = path.join(root, name);
          yield* fs.writeFileString(filePath, "not media");
          const error = yield* issueAssetUrl({
            resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
          }).pipe(Effect.flip);
          expect(error).toBeInstanceOf(AssetPreviewTypeValidationError);
        }
        const disguisedPath = path.join(root, "disguised.png");
        yield* fs.symlink(path.join(root, "secret.txt"), disguisedPath);
        const disguisedError = yield* issueAssetUrl({
          resource: {
            _tag: "media-file",
            threadId: ThreadId.make("thread-1"),
            path: disguisedPath,
          },
        }).pipe(Effect.flip);
        expect(disguisedError).toBeInstanceOf(AssetPreviewTypeValidationError);
        const directoryPath = path.join(root, "directory.png");
        yield* fs.makeDirectory(directoryPath);
        const directoryError = yield* issueAssetUrl({
          resource: {
            _tag: "media-file",
            threadId: ThreadId.make("thread-1"),
            path: directoryPath,
          },
        }).pipe(Effect.flip);
        expect(directoryError._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)("does not issue URLs for server state files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const stateFile = path.join(config.secretsDir, "example.bin");
      yield* fs.makeDirectory(config.secretsDir, { recursive: true });
      yield* fs.writeFile(stateFile, new Uint8Array(32).fill(7));
      yield* fs.writeFileString(config.dbPath, "SQLite format 3");
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-state-" });
      const alias = path.join(root, "alias");
      yield* fs.symlink(stateFile, alias);
      const threadId = ThreadId.make("thread-1");
      for (const resource of [
        { _tag: "media-file", threadId, path: stateFile, disposition: "attachment" },
        { _tag: "media-file", threadId, path: alias, disposition: "attachment" },
        {
          _tag: "media-file",
          threadId,
          path: path.join(config.secretsDir, "..", "secrets", "example.bin"),
          disposition: "attachment",
        },
        { _tag: "media-file", threadId, path: config.dbPath },
        { _tag: "draft-workspace-file", cwd: config.stateDir, path: "statev2.sqlite" },
      ] as const) {
        const error = yield* issueAssetUrl({ resource }).pipe(Effect.flip);
        expect(error._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }

      const icon = path.join(config.baseDir, "icon.png");
      yield* fs.symlink(stateFile, icon);
      yield* fs.writeFileString(path.join(config.baseDir, "page.html"), '<img src="icon.png">');
      const page = yield* issueAssetUrl({
        resource: { _tag: "draft-workspace-file", cwd: config.baseDir, path: "page.html" },
      });
      const pageToken = page.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length).split("/")[0]!;
      expect(yield* resolveAsset(pageToken, "icon.png")).toBeNull();
      const faviconError = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
        projectFaviconPath: icon,
      }).pipe(Effect.flip);
      expect(faviconError._tag).toBe("AssetProjectFaviconNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "binds media URLs to the canonical target and rejects symlink substitution",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-symlink-" });
        const filePath = path.join(root, "actual.svg");
        const aliasPath = path.join(root, "alias.png");
        const replacementPath = path.join(root, "other.svg");
        yield* fs.writeFileString(filePath, "<svg/>");
        yield* fs.writeFileString(replacementPath, "<svg>private</svg>");
        yield* fs.symlink(filePath, aliasPath);
        const canonicalFile = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: aliasPath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        const name = suffix.slice(separator + 1);
        const expected = { kind: "file", path: canonicalFile, mimeType: "image/svg+xml" };
        expect(yield* resolveAsset(token, name)).toMatchObject(expected);
        yield* fs.remove(aliasPath);
        yield* fs.symlink(replacementPath, aliasPath);
        expect(yield* resolveAsset(token, name)).toMatchObject(expected);
        yield* fs.remove(filePath);
        yield* fs.symlink(replacementPath, filePath);
        expect(yield* resolveAsset(token, name)).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "keeps full and partial responses bound to the file opened during resolution",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-open-file-" });
        const filePath = path.join(root, "recording.mp4");
        const savedPath = path.join(root, "saved.mp4");
        const secretPath = path.join(root, "secret.txt");
        yield* fs.writeFileString(filePath, "0123456789");
        yield* fs.writeFileString(secretPath, "private information");
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        for (const [range, expected, status] of [
          [undefined, "0123456789", 200],
          ["bytes=2-5", "2345", 206],
        ] as const) {
          const asset = yield* resolveAsset(
            suffix.slice(0, separator),
            suffix.slice(separator + 1),
          );
          if (asset?.kind !== "file") throw new Error("Expected a resolved media file");

          yield* fs.rename(filePath, savedPath);
          yield* fs.symlink(secretPath, filePath);
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, range));
          expect(response.status).toBe(status);
          expect(response.headers.get("content-length")).toBe(String(expected.length));
          expect(yield* Effect.promise(() => response.text())).toBe(expected);
          yield* fs.remove(filePath);
          yield* fs.rename(savedPath, filePath);
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a symlink swapped in after canonical validation but before open",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-open-race-" });
        const filePath = path.join(root, "recording.mp4");
        const secretPath = path.join(root, "secret.txt");
        yield* fs.writeFileString(filePath, "video");
        yield* fs.writeFileString(secretPath, "secret");
        const canonicalPath = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          stat: Effect.fn(function* (requestedPath) {
            const info = yield* fs.stat(requestedPath);
            if (requestedPath === canonicalPath) {
              yield* fs.remove(filePath);
              yield* fs.symlink(secretPath, filePath);
            }
            return info;
          }),
        });
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)).pipe(
            Effect.provideService(FileSystem.FileSystem, swappingFileSystem),
          ),
        ).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects an ancestor symlink race even when canonical path rechecks would pass",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-parent-race-" });
        const publicDirectory = path.join(root, "public");
        const privateDirectory = path.join(root, "private");
        yield* fs.makeDirectory(publicDirectory);
        yield* fs.makeDirectory(privateDirectory);
        const filePath = path.join(publicDirectory, "recording.mp4");
        yield* fs.writeFileString(filePath, "public video");
        yield* fs.writeFileString(path.join(privateDirectory, "recording.mp4"), "private video");
        const canonicalPath = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const native = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        const savedDirectory = path.join(root, "saved");
        const realpathSpy = vi.mocked(NodeFSP.realpath).mockImplementationOnce(async () => {
          await native.unlink(publicDirectory);
          await native.rename(savedDirectory, publicDirectory);
          const canonical = await native.realpath(canonicalPath);
          await native.rename(publicDirectory, savedDirectory);
          await native.symlink(privateDirectory, publicDirectory, "junction");
          return canonical;
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => realpathSpy.mockReset().mockImplementation(native.realpath)),
        );
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          realPath: Effect.fn(function* (requestedPath) {
            const canonical = yield* fs.realPath(requestedPath);
            if (requestedPath === canonicalPath) {
              yield* fs.rename(publicDirectory, savedDirectory);
              yield* Effect.promise(() =>
                NodeFSP.symlink(privateDirectory, publicDirectory, "junction"),
              );
            }
            return canonical;
          }),
        });
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)).pipe(
            Effect.provideService(FileSystem.FileSystem, swappingFileSystem),
          ),
        ).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("versions media by file changes rather than by re-signing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-revision-" });
      const filePath = path.join(root, "recording.mp4");
      yield* fs.writeFileString(filePath, "original");
      yield* Effect.promise(() => NodeFSP.utimes(filePath, 1_000, 1_000));
      const input = {
        resource: {
          _tag: "media-file" as const,
          threadId: ThreadId.make("thread-1"),
          path: filePath,
        },
      };
      const original = yield* issueAssetUrl(input);
      expect(original.fileRevision).toEqual(expect.any(String));

      yield* TestClock.adjust("1 minute");
      const renewed = yield* issueAssetUrl(input);
      expect(renewed.relativeUrl).not.toBe(original.relativeUrl);
      expect(renewed.fileRevision).toBe(original.fileRevision);

      yield* fs.writeFileString(filePath, "modified");
      yield* Effect.promise(() => NodeFSP.utimes(filePath, 2_000, 2_000));
      const edited = yield* issueAssetUrl(input);
      expect(edited.fileRevision).not.toBe(original.fileRevision);

      const replacement = path.join(root, "replacement.mp4");
      yield* fs.writeFileString(replacement, "modified");
      yield* Effect.promise(() => NodeFSP.utimes(replacement, 2_000, 2_000));
      yield* fs.rename(replacement, filePath);
      const replaced = yield* issueAssetUrl(input);
      expect(replaced.fileRevision).not.toBe(edited.fileRevision);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps in-place edits readable but requires a new URL after atomic replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-replacement-" });
      const filePath = path.join(root, "recording.mp4");
      yield* fs.writeFileString(filePath, "original");
      const input = {
        resource: {
          _tag: "media-file" as const,
          threadId: ThreadId.make("thread-1"),
          path: filePath,
        },
      };
      const original = yield* issueAssetUrl(input);
      const suffix = original.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const token = suffix.slice(0, separator);
      const name = suffix.slice(separator + 1);
      yield* fs.writeFileString(filePath, "in-place edit");
      const edited = yield* resolveAsset(token, name);
      if (edited?.kind !== "file") throw new Error("Expected the edited media file");
      const editedResponse = HttpServerResponse.toWeb(yield* assetFileResponse(edited));
      expect(yield* Effect.promise(() => editedResponse.text())).toBe("in-place edit");

      const replacement = path.join(root, "replacement.mp4");
      yield* fs.writeFileString(replacement, "replacement");
      yield* fs.rename(replacement, filePath);
      expect(yield* resolveAsset(token, name)).toBeNull();

      const renewed = yield* issueAssetUrl(input);
      const renewedSuffix = renewed.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const renewedSeparator = renewedSuffix.indexOf("/");
      const renewedAsset = yield* resolveAsset(
        renewedSuffix.slice(0, renewedSeparator),
        renewedSuffix.slice(renewedSeparator + 1),
      );
      if (renewedAsset?.kind !== "file") throw new Error("Expected the replacement media file");
      const renewedResponse = HttpServerResponse.toWeb(yield* assetFileResponse(renewedAsset));
      expect(yield* Effect.promise(() => renewedResponse.text())).toBe("replacement");
      yield* fs.remove(filePath);
      expect(
        yield* resolveAsset(
          renewedSuffix.slice(0, renewedSeparator),
          renewedSuffix.slice(renewedSeparator + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)("validates canonical preview dependency paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const page = path.join(root, "report.html");
      yield* fs.writeFileString(page, "<!doctype html>");
      for (const name of ["report.css", ".internal.css", "notes.txt"]) {
        yield* fs.writeFileString(path.join(root, name), "fixture");
      }
      yield* fs.symlink(path.join(root, "report.css"), path.join(root, "theme.css"));
      yield* fs.symlink(path.join(root, ".internal.css"), path.join(root, "internal.css"));
      yield* fs.symlink(path.join(root, "notes.txt"), path.join(root, "notes.css"));

      const result = yield* issueAssetUrl({
        resource: { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: page },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(ASSET_ROUTE_PREFIX.length + 1);
      const token = suffix.slice(0, suffix.indexOf("/"));
      expect(yield* resolveAsset(token, "theme.css")).toMatchObject({
        path: yield* fs.realPath(path.join(root, "report.css")),
      });
      expect(yield* resolveAsset(token, "internal.css")).toBeNull();
      expect(yield* resolveAsset(token, "notes.css")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues workspace URLs that resolve the entry file and sibling assets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-workspace-",
      });
      const htmlPath = path.join(root, "report.html");
      const cssPath = path.join(root, "report.css");
      yield* fileSystem.writeFileString(htmlPath, '<link rel="stylesheet" href="report.css">');
      yield* fileSystem.writeFileString(cssPath, "body { color: red; }");
      yield* fileSystem.writeFileString(path.join(root, ".env"), "SECRET=value");
      const canonicalHtmlPath = yield* fileSystem.realPath(htmlPath);
      const canonicalCssPath = yield* fileSystem.realPath(cssPath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "report.html")).toEqual({
        kind: "file",
        path: canonicalHtmlPath,
        renderIntent: "file-preview",
      });
      expect(yield* resolveAsset(token, "report.css")).toEqual({
        kind: "file",
        path: canonicalCssPath,
        renderIntent: "file-preview",
      });
      yield* fileSystem.makeDirectory(path.join(root, "clips"));
      for (const mediaName of ["clips/clip.mp4", "clips/clip.webm", "clips/clip.mp3"]) {
        const mediaPath = path.join(root, mediaName);
        yield* fileSystem.writeFileString(mediaPath, "media bytes");
        expect(yield* resolveAsset(token, mediaName)).toMatchObject({
          kind: "file",
          path: yield* fileSystem.realPath(mediaPath),
        });
      }
      for (const extension of ["otf", "ttf", "woff", "woff2"]) {
        const fontName = `preview.${extension}`;
        const fontPath = path.join(root, fontName);
        yield* fileSystem.writeFileString(fontPath, "font bytes");
        const canonicalFontPath = yield* fileSystem.realPath(fontPath);
        for (const resource of [
          { _tag: "workspace-file" as const, threadId: ThreadId.make("thread-1"), path: htmlPath },
          { _tag: "draft-workspace-file" as const, cwd: root, path: "report.html" },
        ]) {
          const url = yield* issueAssetUrl({ resource, workspaceRoot: root });
          const suffix = url.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          expect(yield* resolveAsset(suffix.slice(0, suffix.indexOf("/")), fontName)).toEqual({
            kind: "file",
            path: canonicalFontPath,
            renderIntent: "file-preview",
          });
        }
      }
      expect(yield* resolveAsset(token, "../secret.txt")).toBeNull();
      expect(yield* resolveAsset(token, ".env")).toBeNull();
      expect(yield* resolveAsset(`${token}tampered`, "report.html")).toBeNull();
      for (const extension of [
        "odt",
        "ods",
        "odp",
        "rtf",
        "epub",
        "ipynb",
        "zip",
        "jar",
        "tar",
        "gz",
        "tgz",
        "sqlite",
        "sqlite3",
        "db",
        "docx",
        "xlsx",
        "pptx",
        "bmp",
        "heic",
        "tif",
        "tiff",
        "weba",
        "mmd",
        "mermaid",
      ]) {
        const siblingName = `private.${extension}`;
        yield* fileSystem.writeFileString(path.join(root, siblingName), "private sibling");
        for (const resource of [
          { _tag: "workspace-file" as const, threadId: ThreadId.make("thread-1"), path: htmlPath },
          { _tag: "draft-workspace-file" as const, cwd: root, path: "report.html" },
        ]) {
          const url = yield* issueAssetUrl({ resource, workspaceRoot: root });
          const suffix = url.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          expect(yield* resolveAsset(suffix.slice(0, suffix.indexOf("/")), siblingName)).toBeNull();
        }
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "serves relative document and stylesheet dependencies through the signed asset route",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const page = '<link rel="stylesheet" href="styles/main.css"><video src="media/clip.mp4">';
        const css = '@import "./theme.css"; body { background: url("../media/cover%20art.png"); }';
        const theme = "body { color: red; }";
        yield* fs.makeDirectory(path.join(root, "docs", "styles"), { recursive: true });
        yield* fs.makeDirectory(path.join(root, "docs", "media"));
        yield* fs.writeFileString(path.join(root, "docs", "index.html"), page);
        yield* fs.writeFileString(path.join(root, "docs", "styles", "main.css"), css);
        yield* fs.writeFileString(path.join(root, "docs", "styles", "theme.css"), theme);
        yield* fs.writeFileString(path.join(root, "docs", "media", "clip.mp4"), "video");
        yield* fs.writeFileString(path.join(root, "docs", "media", "cover art.png"), "cover");
        yield* fs.writeFileString(path.join(root, "docs", "data.txt"), "private");
        yield* fs.writeFileString(path.join(root, "outside.png"), "outside the document directory");

        const grant = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: "docs/index.html",
          },
          workspaceRoot: root,
        });
        const documentUrl = new URL(grant.relativeUrl, "https://issuer.example");
        const stylesheetUrl = new URL("styles/main.css", documentUrl);
        const handle = yield* HttpRouter.toHttpEffect(layerAssetRoute);
        const read = (url: URL) =>
          handle.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(new Request(url)),
            ),
            Effect.map((response) => HttpServerResponse.toWeb(response)),
          );
        const document = yield* read(documentUrl);
        expect(document.status).toBe(200);
        expect(yield* Effect.promise(() => document.text())).toContain(page);

        for (const [url, mime, body] of [
          [stylesheetUrl, "text/css", css],
          [new URL("./theme.css", stylesheetUrl), "text/css", theme],
          [new URL("../media/cover%20art.png?v=2#sample", stylesheetUrl), "image/png", "cover"],
          [new URL("media/clip.mp4", documentUrl), "video/mp4", "video"],
        ] as const) {
          const response = yield* read(url);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toContain(mime);
          expect(yield* Effect.promise(() => response.text())).toBe(body);
        }

        for (const reference of ["data.txt", "../outside.png", "%2e%2e%2foutside.png"]) {
          expect((yield* read(new URL(reference, documentUrl))).status).toBe(404);
        }
      }).pipe(
        Effect.provideService(BuiltInDrivers.SourceControlDrivers, []),
        Effect.provideService(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: () => Effect.succeed(null),
        }),
        Effect.provide(layerTest),
      ),
  );

  it.effect("rejects workspace files outside the authorized root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-outside-",
      });
      const htmlPath = path.join(outside, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>outside</p>");

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error.message).toBe("Workspace file path must be relative to the project root.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspacePathValidationError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues exact workspace URLs for every non-HTML preview", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-image-workspace-",
      });
      const assetsDirectory = path.join(root, "assets");
      yield* fileSystem.makeDirectory(assetsDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(assetsDirectory, "private.docx"),
        "private document",
      );
      for (const extension of [
        "pdf",
        "odt",
        "ods",
        "odp",
        "rtf",
        "epub",
        "ipynb",
        "png",
        "bmp",
        "heic",
        "tif",
        "tiff",
        "docx",
        "xlsx",
        "pptx",
        "ttf",
        "otf",
        "woff",
        "woff2",
        "zip",
        "jar",
        "tar",
        "gz",
        "tgz",
        "sqlite",
        "sqlite3",
        "db",
      ]) {
        const name = `preview.${extension}`;
        const filePath = path.join(assetsDirectory, name);
        const siblingName = `other.${extension}`;
        yield* fileSystem.writeFileString(filePath, "preview");
        yield* fileSystem.writeFileString(
          path.join(assetsDirectory, siblingName),
          "private sibling",
        );
        const canonicalPath = yield* fileSystem.realPath(filePath);
        for (const resource of [
          {
            _tag: "workspace-file" as const,
            threadId: ThreadId.make("thread-1"),
            path: filePath,
          },
          { _tag: "draft-workspace-file" as const, cwd: root, path: `assets/${name}` },
        ]) {
          const result = yield* issueAssetUrl({ resource, workspaceRoot: root });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const token = suffix.slice(0, suffix.indexOf("/"));
          expect(yield* resolveAsset(token, name)).toEqual({ kind: "file", path: canonicalPath });
          expect(yield* resolveAsset(token, siblingName)).toBeNull();
          expect(yield* resolveAsset(token, "private.docx")).toBeNull();
          expect(yield* resolveAsset(token, `../${name}`)).toBeNull();
        }
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("previews workspace files with literal fragment characters in their paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-preview-literal-" });
      const directory = path.join(root, "assets#archive");
      yield* fileSystem.makeDirectory(directory);

      for (const name of [
        "icon#v2.png",
        "report#draft.pdf",
        "report.docx",
        "workbook.xlsx",
        "slides.pptx",
        "notes.odt",
        "budget.ods",
        "slides.odp",
        "notes.rtf",
        "book.epub",
        "analysis.ipynb",
        "specimen.ttf",
        "specimen.otf",
        "specimen.woff",
        "specimen.woff2",
        "image.bmp",
        "image.heic",
        "image.tif",
        "image.tiff",
      ]) {
        const filePath = path.join(directory, name);
        yield* fileSystem.writeFileString(filePath, "preview fixture");
        const canonicalFile = yield* fileSystem.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: filePath,
          },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const token = suffix.slice(0, suffix.indexOf("/"));

        expect(yield* resolveAsset(token, name)).toEqual({ kind: "file", path: canonicalFile });
        if (name.endsWith(".png")) {
          expect(yield* resolveAsset(token, "other.png")).toBeNull();
        }
      }

      const disguisedPath = path.join(root, "image.png#notes.txt");
      yield* fileSystem.writeFileString(disguisedPath, "not an image");
      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: disguisedPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(AssetPreviewTypeValidationError);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signs MCP render intent only for inline HTML attachments", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      for (const extension of ["html", "pdf"]) {
        const attachmentId = `thread-1-00000000-0000-4000-8000-000000000031-${extension}`;
        yield* fs.writeFileString(
          path.join(config.attachmentsDir, `${attachmentId}.${extension}`),
          "capture",
        );
        for (const disposition of ["inline", "attachment"] as const) {
          const result = yield* issueAssetUrl({
            resource: {
              _tag: "attachment",
              attachmentId,
              disposition,
              renderIntent: "mcp-app",
            },
          });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          const asset = yield* resolveAsset(
            suffix.slice(0, separator),
            suffix.slice(separator + 1),
          );
          if (asset?.kind !== "file") throw new Error("Expected attachment file");
          expect("renderIntent" in asset ? asset.renderIntent : undefined).toBe(
            extension === "html" && disposition === "inline" ? "mcp-app" : undefined,
          );
          const token = suffix.slice(0, separator);
          const [payload, signature] = token.split(".");
          const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
          claims.renderIntent = claims.renderIntent ? undefined : "mcp-app";
          const tampered = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
          expect(yield* resolveAsset(tampered, suffix.slice(separator + 1))).toBeNull();
        }
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "reports image attachment dimensions when the attachments directory is a symlink",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attachments-link-" });
        const realAttachmentsDir = path.join(root, "real");
        const linkedAttachmentsDir = path.join(root, "linked");
        yield* fs.makeDirectory(realAttachmentsDir);
        yield* fs.symlink(realAttachmentsDir, linkedAttachmentsDir);
        const attachmentId = "thread-1-00000000-0000-4000-8000-000000000041";
        yield* fs.writeFile(path.join(realAttachmentsDir, `${attachmentId}.png`), screenshotPng);

        const result = yield* issueAssetUrl({
          resource: { _tag: "attachment", attachmentId },
        }).pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            ...config,
            attachmentsDir: linkedAttachmentsDir,
          }),
        );
        expect(result.imageDimensions).toEqual({ width: 390, height: 844 });
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves document attachments inline when a viewer requests it", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      for (const [extension, mimeType] of [
        ["pdf", "application/pdf"],
        ["svg", "image/svg+xml"],
        ["bmp", "image/bmp"],
        ["ttf", "font/ttf"],
        ["otf", "font/otf"],
        ["woff", "font/woff"],
        ["woff2", "font/woff2"],
        ["weba", "audio/webm"],
        ["zip", "application/zip"],
        ["jar", "application/java-archive"],
        ["tar", "application/x-tar"],
        ["gz", "application/gzip"],
        ["tgz", "application/gzip"],
        ["sqlite", "application/vnd.sqlite3"],
        ["sqlite3", "application/vnd.sqlite3"],
        ["db", "application/vnd.sqlite3"],
      ] as const) {
        const attachmentId = `thread-1-00000000-0000-4000-8000-000000000001-${extension}`;
        const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.${extension}`);
        yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

        const result = yield* issueAssetUrl({
          resource: {
            _tag: "attachment",
            attachmentId,
            fileName: `report.${extension}`,
            mimeType: "text/html",
            disposition: "inline",
          },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separatorIndex = suffix.indexOf("/");

        expect(
          yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
        ).toEqual({
          kind: "file",
          path: attachmentPath,
          fileName: `report.${extension}`,
          mimeType,
        });
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps inline requests for other attachment types as downloads", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000002-7z";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.7z`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "attachment",
          attachmentId,
          fileName: "archive.7z",
          mimeType: "text/html",
          disposition: "inline",
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toMatchObject({ kind: "file", path: attachmentPath, download: true });
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("issues project favicon capabilities with a signed fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-",
      });
      const faviconPath = path.join(root, "favicon.svg");
      const initialFavicon = "<svg>a</svg>";
      const updatedFavicon = "<svg>b</svg>";
      expect(updatedFavicon).toHaveLength(initialFavicon.length);
      yield* fileSystem.writeFileString(faviconPath, initialFavicon);
      const canonicalFaviconPath = yield* fileSystem.realPath(faviconPath);

      const faviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(faviconResult.sourcePath).toBe("favicon.svg");
      expect(faviconResult.relativeUrl).toMatch(/\/v[0-9a-f]{64}-favicon\.svg$/);
      expect(
        yield* issueAssetUrl({
          resource: { _tag: "project-favicon", cwd: root },
        }),
      ).toEqual(faviconResult);
      const faviconSuffix = faviconResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const faviconSeparatorIndex = faviconSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          faviconSuffix.slice(0, faviconSeparatorIndex),
          faviconSuffix.slice(faviconSeparatorIndex + 1),
        ),
      ).toEqual({ kind: "file", path: canonicalFaviconPath });

      yield* fileSystem.writeFileString(faviconPath, updatedFavicon);
      const updatedFaviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(
        updatedFaviconResult.relativeUrl.slice(updatedFaviconResult.relativeUrl.lastIndexOf("/")),
      ).not.toBe(faviconResult.relativeUrl.slice(faviconResult.relativeUrl.lastIndexOf("/")));

      yield* fileSystem.remove(faviconPath);
      const fallbackResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(fallbackResult.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)).toBe(true);
      expect(fallbackResult.sourcePath).toBeUndefined();
      const fallbackSuffix = fallbackResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const fallbackSeparatorIndex = fallbackSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          fallbackSuffix.slice(0, fallbackSeparatorIndex),
          fallbackSuffix.slice(fallbackSeparatorIndex + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues an exact capability for a saved favicon outside the workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-workspace-",
      });
      const pictures = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-pictures-",
      });
      const externalPath = path.join(pictures, "custom.png");
      const siblingPath = path.join(pictures, "sibling.png");
      yield* fileSystem.writeFile(externalPath, new Uint8Array([1, 2, 3]));
      yield* fileSystem.writeFile(siblingPath, new Uint8Array([4, 5, 6]));
      const canonicalPath = yield* fileSystem.realPath(externalPath);
      const canonicalSiblingPath = yield* fileSystem.realPath(siblingPath);

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
        projectFaviconPath: externalPath,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(result.sourcePath).toBe(externalPath);
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-custom\.png$/);
      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toEqual({ kind: "file", path: canonicalPath });
      const tamperedSuffixResult = yield* resolveAsset(
        suffix.slice(0, separatorIndex),
        "sibling.png",
      );
      expect(tamperedSuffixResult).toEqual({ kind: "file", path: canonicalPath });
      expect(tamperedSuffixResult).not.toEqual({ kind: "file", path: canonicalSiblingPath });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("ignores a client favicon path hint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-hint-",
      });
      yield* fileSystem.makeDirectory(path.join(root, "brand"));
      yield* fileSystem.writeFileString(path.join(root, "brand", "hint.svg"), "<svg>hint</svg>");
      yield* fileSystem.writeFileString(path.join(root, "brand", "saved.svg"), "<svg>saved</svg>");

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root, path: "brand/hint.svg" },
        projectFaviconPath: "brand/saved.svg",
      });

      expect(result.sourcePath).toBe(path.join("brand", "saved.svg"));
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-saved\.svg$/);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("preserves the change request repository through RPC decoding and signed media", () =>
    Effect.gen(function* () {
      const decodeAssetCreateUrlInput = Schema.decodeEffect(AssetCreateUrlInput);
      const resource = {
        _tag: SOURCE_CONTROL_MEDIA_ASSET,
        cwd: "/personal-fork",
        url: "https://github.com/user-attachments/assets/1a1842fb-6383-492f-873c-57aa0033fa6c",
        repository: "enterprise/private",
      };
      const input = yield* decodeAssetCreateUrlInput({ resource });
      const issued = yield* issueAssetUrl(input);
      const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const resolved = yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));

      expect(resolved).toEqual({
        kind: "source-control-media",
        url: resource.url,
        cwd: resource.cwd,
        repository: resource.repository,
        expiresAt: issued.expiresAt,
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves a host's credentialed media through that host's driver", () => {
    const fetched: Array<{
      url: string;
      headers: Readonly<Record<string, string>>;
      repository?: string;
    }> = [];
    const url = "https://github.com/owner/repo/blob/main/docs/shot.png";
    const media = sourceControlDefinitions.mediaUrl(url)!;
    const layerDrivers = Layer.succeed(BuiltInDrivers.SourceControlDrivers, [
      {
        driver: { kind: media.definition.kind, definition: media.definition },
        instance: fakeSourceControlDriverInstance(media.definition.kind, {
          pullRequests: null,
          fetchMedia: (request) =>
            Effect.sync(() => {
              fetched.push(request);
              return HttpClientResponse.fromWeb(
                HttpClientRequest.get(request.url),
                new Response("bytes", { status: 206, headers: { "content-length": "5" } }),
              );
            }),
        }),
      },
    ]);
    // Clients that predate `repository` get the checkout's.
    const layerIdentities = Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
      resolve: () =>
        Effect.succeed({
          canonicalKey: "github.com/owner/repo",
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: "" },
          provider: media.definition.kind,
          owner: "owner",
          name: "repo",
        }),
    });
    return Effect.gen(function* () {
      const decodeAssetCreateUrlInput = Schema.decodeEffect(AssetCreateUrlInput);

      // Every client and server release spells the resource this way on the wire.
      const { resource } = yield* decodeAssetCreateUrlInput({
        resource: { _tag: "github-media", cwd: "/repo", url },
      });
      const issued = yield* issueAssetUrl({ resource });
      const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const asset = yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
      expect(asset).toEqual({
        kind: "source-control-media",
        url: media.fetchUrl,
        cwd: "/repo",
        expiresAt: issued.expiresAt,
      });
      if (asset?.kind !== "source-control-media") return;

      const response = yield* sourceControlMediaResponse(asset, {
        range: "bytes=0-4",
        cookie: "session",
      });
      expect(fetched).toEqual([
        { url: media.fetchUrl, headers: { range: "bytes=0-4" }, repository: "owner/repo" },
      ]);
      expect(response.status).toBe(206);
      // The upstream sent no type, so it comes from the file name the host gave the media.
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["content-length"]).toBe("5");

      // A pull request's own repository wins over the checkout it is shown in.
      yield* sourceControlMediaResponse({ ...asset, repository: "enterprise/private" }, {});
      expect(fetched.at(-1)?.repository).toBe("enterprise/private");
    }).pipe(Effect.provide(Layer.mergeAll(layerTest, layerDrivers, layerIdentities)));
  });

  it.effect("refuses media no host keeps behind a credential, without echoing the URL", () =>
    Effect.gen(function* () {
      const encodeAssetAccessError = Schema.encodeEffect(Schema.fromJsonString(AssetAccessError));

      for (const url of [
        "https://example.com/shot.png",
        "https://example.com/shot.png?token=private-media-token",
      ]) {
        const error = yield* issueAssetUrl({
          resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: "/repo", url },
        }).pipe(Effect.flip);
        expect(error._tag).toBe("AssetGitHubMediaUrlValidationError");
        const encoded = yield* encodeAssetAccessError(error);
        expect(encoded).not.toContain(url);
      }
    }).pipe(Effect.provide(layerTest)),
  );

  describe("plugin panels", () => {
    const panel = (version: string) => ({
      _tag: "plugin-panel" as const,
      pluginId: echoPluginId,
      panelId: "main",
      version,
    });

    it.effect("mints and serves plugin-panel html with its render intent", () =>
      Effect.gen(function* () {
        const store = yield* makePluginStore();
        yield* store.stage("1.0.0");
        yield* store.activate("1.0.0");
        yield* Effect.gen(function* () {
          const result = yield* issueAssetUrl({ resource: panel("1.0.0") });
          expect(result.relativeUrl.endsWith("/main.html")).toBe(true);
          expect(yield* resolveIssuedUrl(result.relativeUrl)).toEqual({
            kind: "file",
            path: store.panelPath("1.0.0"),
            mimeType: "text/html",
            renderIntent: "plugin-panel",
          });
          const missingPanel = yield* issueAssetUrl({
            resource: { ...panel("1.0.0"), panelId: "other" },
          }).pipe(Effect.flip);
          expect(missingPanel._tag).toBe("AssetWorkspaceAssetNotFoundError");
        }).pipe(Effect.provide(store.layer));
      }).pipe(Effect.provide(layerTest)),
    );

    it.effect("returns not found for a disabled or uninstalled plugin", () =>
      Effect.gen(function* () {
        const store = yield* makePluginStore();
        yield* store.stage("1.0.0");
        yield* store.activate("1.0.0");
        yield* Effect.gen(function* () {
          const { relativeUrl } = yield* issueAssetUrl({ resource: panel("1.0.0") });
          for (const [version, enabled] of [
            ["1.0.0", false],
            [null, true],
          ] as const) {
            yield* store.activate(version, enabled);
            const error = yield* issueAssetUrl({ resource: panel("1.0.0") }).pipe(Effect.flip);
            expect(error._tag).toBe("AssetWorkspaceAssetNotFoundError");
            expect(error.message).toBe("Plugin panel was not found.");
            expect(yield* resolveIssuedUrl(relativeUrl)).toBeNull();
          }
        }).pipe(Effect.provide(store.layer));
      }).pipe(Effect.provide(layerTest)),
    );

    it.effect(
      "a resource naming a non-active version is not found, before and after update to B",
      () =>
        Effect.gen(function* () {
          const store = yield* makePluginStore();
          yield* store.stage("1.0.0");
          yield* store.stage("2.0.0");
          yield* store.activate("1.0.0");
          yield* Effect.gen(function* () {
            const staged = yield* issueAssetUrl({ resource: panel("2.0.0") }).pipe(Effect.flip);
            expect(staged._tag).toBe("AssetWorkspaceAssetNotFoundError");
            const before = yield* issueAssetUrl({ resource: panel("1.0.0") });

            yield* store.activate("2.0.0");
            expect(yield* resolveIssuedUrl(before.relativeUrl)).toBeNull();
            const stale = yield* issueAssetUrl({ resource: panel("1.0.0") }).pipe(Effect.flip);
            expect(stale._tag).toBe("AssetWorkspaceAssetNotFoundError");
            const after = yield* issueAssetUrl({ resource: panel("2.0.0") });
            expect(after.relativeUrl).not.toBe(before.relativeUrl);
            const resolved = yield* resolveIssuedUrl(after.relativeUrl);
            expect(resolved?.kind === "file" ? resolved.path : null).toBe(store.panelPath("2.0.0"));
          }).pipe(Effect.provide(store.layer));
        }).pipe(Effect.provide(layerTest)),
    );
  });
});

it.live("renders real signed assets in an opaque dark Chromium frame", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hosted-renderer-" });
    const origin = "https://asset-view.invalid";
    const issue = Effect.fn("test.issueLocalPreview")(function* (file: string) {
      const { relativeUrl } = yield* issueAssetUrl({
        resource: { _tag: "draft-workspace-file", cwd: root, path: file },
        workspaceRoot: root,
      });
      return origin + relativeUrl;
    });
    const dispatch = yield* Renderer.makeDispatcher;
    const browser = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch()),
      (browser) => Effect.promise(() => browser.close()),
    );
    const context = yield* Effect.acquireRelease(
      Effect.promise(() =>
        browser.newContext({ offline: true, serviceWorkers: "block", colorScheme: "dark" }),
      ),
      (context) => Effect.promise(() => context.close()),
    );
    let trapHits = 0;
    const trapOrigin = yield* serveLoopback(
      NodeHttp.createServer((_request, response) => {
        trapHits++;
        response.end("unexpected");
      }),
    );
    const trapUrl = trapOrigin + "/trap";
    yield* fs.writeFileString(
      path.join(root, "nested.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    );
    const passive = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="document.documentElement.setAttribute('ran','true')"/>`;
    yield* fs.writeFileString(path.join(root, "passive.svg"), passive);
    const svgUrl = yield* issue("passive.svg");
    const independent = yield* issue("nested.svg");
    const sound = Buffer.alloc(8_000);
    sound.write("RIFF", 0);
    sound.writeUInt32LE(sound.length - 8, 4);
    sound.write("WAVEfmt ", 8);
    sound.writeUInt32LE(16, 16);
    sound.writeUInt16LE(1, 20);
    sound.writeUInt16LE(1, 22);
    sound.writeUInt32LE(8000, 24);
    sound.writeUInt32LE(8000, 28);
    sound.writeUInt16LE(1, 32);
    sound.writeUInt16LE(8, 34);
    sound.write("data", 36);
    sound.writeUInt32LE(sound.length - 44, 40);
    yield* fs.writeFile(path.join(root, "sound.wav"), sound);
    yield* fs.writeFile(
      path.join(root, "test.woff2"),
      yield* fs.readFile(
        new URL(
          "../../../web/src/terminal/ghostty/fonts/SymbolsNerdFontMono-Regular.woff2",
          import.meta.url,
        ).pathname,
      ),
    );
    yield* fs.writeFileString(
      path.join(root, "theme.css"),
      `
      @font-face { font-family: SignedFont; src: url(test.woff2) }
      body { font-family: SignedFont; background-image: url("${independent}?purpose=css%2Fimage"); }
      @media (prefers-color-scheme: dark) { body { background-color: #181818 } }
    `,
    );
    yield* fs.writeFileString(
      path.join(root, "action.js"),
      `
      document.querySelector('button').onclick = () => {
        document.body.dataset.clicked = 'yes';
        document.querySelector('input').focus();
      };
    `,
    );
    yield* fs.writeFileString(
      path.join(root, "report.html"),
      `
      <link rel="stylesheet" href="theme.css">
      <img src="${independent}">
      <audio controls preload="metadata" src="sound.wav?play=1"></audio>
      <img src="${trapUrl}">
      <img src="/api/assets/unsigned.fake/nested.svg">
      <iframe src="${svgUrl}"></iframe>
      <button>Update</button><input aria-label="Notes"><script src="action.js"></script>
    `,
    );
    yield* fs.writeFileString(
      path.join(root, "redirect.html"),
      `<meta http-equiv="refresh" content="0;url=${trapUrl}"><p>Redirect</p>`,
    );
    const assetUrl = yield* issue("report.html");
    const redirectUrl = yield* issue("redirect.html");

    yield* Effect.promise(async () => {
      const responses: Array<{
        path: string;
        search: string;
        status: number | undefined;
        range: string | undefined;
        csp: string | undefined;
      }> = [];
      const asset = Renderer.prepare(assetUrl, origin, "dark", async (request, signal) => {
        const response = await dispatch(request, signal);
        responses.push({
          path: request.url.pathname.slice(request.url.pathname.lastIndexOf("/") + 1),
          search: request.url.search,
          status: response?.status,
          range: response?.headers["content-range"],
          csp: response?.headers["content-security-policy"],
        });
        return response;
      });
      expect(asset).not.toBeNull();
      if (!asset) return;
      await Renderer.install(context, asset);
      const page = await context.newPage();
      await page.goto(asset.viewUrl.href);
      const frame = page.frameLocator("iframe");
      await frame.getByRole("button", { name: "Update" }).click();
      await page.keyboard.type("typed");
      await page.setViewportSize({ width: 840, height: 480 });
      const rootFrame = page.frames().find((frame) => frame.url() === assetUrl);
      expect(rootFrame?.url().split("/").at(-1)).toBe("report.html");
      expect(
        await rootFrame?.evaluate(`(async () => {
        await document.fonts.ready;
        const audio = document.querySelector("audio");
        if (audio.readyState === 0) await new Promise((resolve, reject) => {
          audio.addEventListener("loadedmetadata", resolve, { once: true });
          audio.addEventListener("error", reject, { once: true });
        });
        return {
          dark: matchMedia("(prefers-color-scheme: dark)").matches,
          origin: window.origin,
          color: getComputedStyle(document.body).backgroundColor,
          clicked: document.body.dataset.clicked,
          notes: document.querySelector("input").value,
          image: document.images[0]?.naturalWidth,
          font: [...document.fonts][0]?.status,
          duration: audio.duration,
          width: window.innerWidth,
        };
      })()`),
      ).toEqual({
        dark: true,
        origin: "null",
        color: "rgb(24, 24, 24)",
        clicked: "yes",
        notes: "typed",
        image: 10,
        font: "loaded",
        duration: 0.9945,
        width: 840,
      });
      expect(responses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "nested.svg",
            search: "?purpose=css%2Fimage",
            status: 200,
          }),
          expect.objectContaining({
            path: "sound.wav",
            search: "?play=1",
            status: 206,
            range: "bytes 0-7999/8000",
          }),
          expect.objectContaining({
            path: "passive.svg",
            status: 200,
            csp: expect.stringContaining("sandbox, "),
          }),
          expect.objectContaining({ path: "nested.svg", status: undefined }),
        ]),
      );
      expect(
        await page
          .frames()
          .find((frame) => frame.url() === svgUrl)
          ?.locator("svg")
          .getAttribute("ran"),
      ).toBeNull();
      await context.close();
      expect(page.isClosed()).toBe(true);

      const redirectContext = await browser.newContext({
        offline: true,
        serviceWorkers: "block",
        colorScheme: "dark",
      });
      try {
        const redirect = Renderer.prepare(redirectUrl, origin, "dark", dispatch);
        if (!redirect) throw new Error("Expected a signed redirect document");
        await Renderer.install(redirectContext, redirect);
        const page = await redirectContext.newPage();
        const redirected = page.waitForResponse((response) => response.url() === redirectUrl);
        await page.goto(redirect.viewUrl.href);
        expect((await redirected).status()).toBe(200);
        expect(trapHits).toBe(0);
      } finally {
        await redirectContext.close();
      }
    });
  }).pipe(
    Effect.provide(Layer.merge(layerTest, NodeHttpPlatform.layer.pipe(Layer.provide(layerTest)))),
  ),
);

it.live("streams a signed document over its destination session and closes it on revoke", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hosted-stream-" });
    const issuer = "https://localhost";
    const canonicalOrigin = "https://canonical.t3.test";
    const relayTls = {
      key: yield* fs.readFileString(
        new URL("../peer/fixtures/localhost-key.pem", import.meta.url).pathname,
      ),
      cert: yield* fs.readFileString(
        new URL("../peer/fixtures/localhost-cert.pem", import.meta.url).pathname,
      ),
    };
    const envTls = {
      key: yield* fs.readFileString(
        new URL("../relay/fixtures/p1b-ingress-client-key.pem", import.meta.url).pathname,
      ),
      cert: yield* fs.readFileString(
        new URL("../relay/fixtures/p1b-ingress-client-cert.pem", import.meta.url).pathname,
      ),
    };
    const backend = NodeHttp.createServer();
    const edge = makeStaticRelayEdge({
      tunnelTls: { ...relayTls, ca: envTls.cert },
      environmentFingerprint: new NodeCrypto.X509Certificate(envTls.cert).fingerprint256,
      publicOrigin: issuer,
      canonicalOrigin,
      admission: () => "active",
    });
    const target = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<{ host: string; port: number }>((resolve, reject) => {
            edge.tunnelServer.once("error", reject);
            edge.tunnelServer.listen(0, "127.0.0.1", () => {
              const address = edge.tunnelServer.address();
              if (address === null || typeof address === "string")
                reject(new Error("Expected TCP listener"));
              else resolve({ host: address.address, port: address.port });
            });
          }),
      ),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              edge.revoke();
              edge.tunnelServer.close(() => resolve());
            }),
        ),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        connectStaticRelayTunnel({
          relay: { ...target, ...envTls, servername: "localhost", ca: relayTls.cert },
          relayFingerprint: new NodeCrypto.X509Certificate(relayTls.cert).fingerprint256,
          publicOrigin: issuer,
          canonicalOrigin,
          backend,
        }),
      ),
      (tunnel) => Effect.sync(() => tunnel.close()),
    );
    const origin = yield* serveLoopback(
      NodeHttps.createServer(relayTls, edge.request).on("upgrade", edge.upgrade),
    );
    yield* Effect.promise(() => edge.ready);
    yield* fs.writeFileString(
      path.join(root, "view.html"),
      `
      <style>body{margin:0}input{position:absolute;left:0;top:0;width:150px;height:60px}</style>
      <input aria-label="Input">
      <script>
        parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 240 } }, "*");
        document.querySelector('input').oninput = () => {
          const image = new Image();
          image.src = 'pressed.svg?text=' + encodeURIComponent(document.querySelector('input').value);
          document.body.append(image);
          const pending = new Image();
          pending.src = 'pending.svg';
          document.body.append(pending);
        };
      </script>
    `,
    );
    yield* fs.writeFileString(
      path.join(root, "pressed.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"/>',
    );
    const { relativeUrl } = yield* issueAssetUrl({
      resource: { _tag: "draft-workspace-file", cwd: root, path: "view.html" },
      workspaceRoot: root,
    });
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    const attachmentId = "thread-1-00000000-0000-4000-8000-000000000032-html";
    yield* fs.writeFileString(
      path.join(config.attachmentsDir, `${attachmentId}.html`),
      `<!doctype html><body style="margin:0">
      <button style="width:100px;height:75px">Request</button>
      <iframe title="Nested" style="position:absolute;top:90px;left:0;width:120px;height:80px;border:0"
        srcdoc="<style>body{margin:0}button{width:100px;height:75px}</style><button onclick=&quot;parent.postMessage('nested-click', '*')&quot;>Nested</button>"></iframe>
      <script>
        document.querySelector("button").onclick = () => {
          parent.postMessage({ jsonrpc: "2.0", id: 2, method: "t3/test" }, "*");
        };
        Object.defineProperty(document, "hasFocus", { value: () => false });
        parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize" }, "*");
        addEventListener("message", (event) => {
          if (event.source === document.querySelector("iframe").contentWindow &&
              event.data === "nested-click") {
            parent.postMessage({ jsonrpc: "2.0", id: 3, method: "t3/test" }, "*");
            return;
          }
          if (event.source !== parent) return;
          if (event.data.navigate) {
            location.href = "about:blank";
            return;
          }
          if (event.data.id !== 1) return;
          parent.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/initialized",
            result: event.data.result,
            color: new URLSearchParams(location.search).get("t3-color-scheme"),
          }, "*");
        });
      </script></body>`,
    );
    const widgetGrant = yield* issueAssetUrl({
      resource: {
        _tag: "attachment",
        attachmentId,
        mimeType: "text/html",
        disposition: "inline",
        renderIntent: "mcp-app",
      },
    });
    const trigger = Deferred.makeUnsafe<string>();
    const pendingRead = Deferred.makeUnsafe<void>();
    const canceledRead = Deferred.makeUnsafe<void>();
    const revoke = Deferred.makeUnsafe<void>();
    const dispatch = yield* Renderer.makeDispatcher;
    const widgetUrl = new URL(issuer + widgetGrant.relativeUrl + "?t3-color-scheme=dark");
    const deniedWidget = yield* Effect.promise(() =>
      dispatch(
        {
          url: widgetUrl,
          type: "document",
          method: "GET",
          range: undefined,
          ifRange: undefined,
          widget: "plugin-panel",
        },
        new AbortController().signal,
      ),
    );
    expect(deniedWidget).toBeNull();
    // The loopback-only runner maps the test process to root, which Chrome cannot sandbox.
    yield* Effect.acquireRelease(
      Effect.sync(() => vi.stubEnv("T3CODE_SERVER_BROWSER_SANDBOX", "0")),
      () => Effect.sync(() => vi.unstubAllEnvs()),
    );
    const viewerLayer = Browser.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Manager.layer,
          Broker.layer,
          DesktopBrowserChannel.layer,
          PreviewAgentActivity.layer,
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("destination")),
            getDescriptor: Effect.die("unused"),
          }),
          Layer.succeed(PreviewBrowser.PreviewBrowser, {
            executable: Effect.succeed(chromium.executablePath()),
            installed: Effect.succeedSome(chromium.executablePath()),
          }),
        ),
      ),
    );
    const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
      authenticateWebSocketUpgrade: (_request, purpose) => {
        expect(purpose).toBe("media");
        return Effect.succeed({
          sessionId: AuthSessionId.make("asset-view-test"),
          subject: "asset-view-test",
          method: "bearer-access-token",
          scopes: [AuthFilesystemReadScope],
        });
      },
    });
    const services = yield* Layer.build(
      HttpRouter.serve(BrowserStream.routeLayer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(() => backend, { port: 0, host: "127.0.0.1" })),
        Layer.provide(viewerLayer),
        Layer.provide(auth),
        Layer.provide(
          Layer.mock(SessionStore.SessionStore, {
            cookieName: "test",
            legacyCookieName: undefined,
            awaitInvalidation: (sessionId) => {
              expect(sessionId).toBe("asset-view-test");
              return Deferred.await(revoke);
            },
          }),
        ),
        Layer.provide(
          Layer.succeed(Renderer.LocalAssetDispatcher, {
            read: async (request, signal) => {
              if (request.url.pathname.endsWith("/pending.svg")) {
                return new Promise<null>((resolve) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      Deferred.doneUnsafe(canceledRead, Effect.void);
                      resolve(null);
                    },
                    { once: true },
                  );
                  Deferred.doneUnsafe(pendingRead, Effect.void);
                });
              }
              const response = await dispatch(request, signal);
              if (request.url.pathname.endsWith("/pressed.svg") && response?.status === 200) {
                Deferred.doneUnsafe(trigger, Effect.succeed(request.url.search));
              }
              return response;
            },
          }),
        ),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const direct = HttpServer.formatAddress(server.address);
    const route = "/api/preview-stream/ws?asset=1&wsTicket=fixture";
    const directStatus = yield* Effect.promise(
      () =>
        new Promise<number | undefined>((resolve, reject) => {
          const socket = new NodeWS.WebSocket(direct.replace("http:", "ws:") + route, {
            headers: {
              host: "localhost",
              forwarded: "host=localhost;proto=https",
              "x-forwarded-proto": "https",
            },
          });
          socket.once("error", reject);
          socket.once("unexpected-response", (_request, response) => {
            response.resume();
            resolve(response.statusCode);
          });
          socket.once("open", () => {
            socket.close();
            reject(new Error("The direct connection was accepted"));
          });
        }),
    );
    expect(directStatus).toBe(404);
    const awaitSocketEvent = <A>(
      event: Deferred.Deferred<A>,
      disconnected: Deferred.Deferred<number>,
      label: string,
    ) =>
      Effect.raceFirst(
        Deferred.await(event),
        Deferred.await(disconnected).pipe(
          Effect.flatMap((code) =>
            Effect.die(new Error(`Socket closed (${code}) before ${label}`)),
          ),
        ),
      );
    const frames = Deferred.makeUnsafe<void>();
    const measured = Deferred.makeUnsafe<number>();
    const closed = Deferred.makeUnsafe<number>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const options = {
          ca: relayTls.cert,
          servername: "localhost",
          headers: { host: "localhost" },
          perMessageDeflate: false,
        };
        const client = new NodeWS.WebSocket(origin.replace("https:", "wss:") + route, options);
        client.once("open", () => {
          client.send(
            JSON.stringify({
              type: "openAsset",
              appearance: "dark",
              theme: { "--background": "#181818" },
              verifiedAssetUrl: issuer + relativeUrl,
            }),
          );
        });
        client.once("error", (error) => Deferred.doneUnsafe(closed, Effect.die(error)));
        client.once("close", (code) => Deferred.doneUnsafe(closed, Effect.succeed(code)));
        client.on("message", (data, binary) => {
          if (!binary) {
            const message = JSON.parse(String(data));
            if (message.type === "assetHeight")
              Deferred.doneUnsafe(measured, Effect.succeed(message.height));
            return;
          }
          expect(Buffer.isBuffer(data) && data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
          client.send('{"type":"ack"}');
          if (!Deferred.doneUnsafe(frames, Effect.void)) return;
          for (const message of [
            { type: "navigate", url: "https://denied.invalid" },
            { type: "resize", width: 420, height: 240 },
            { type: "mouse", action: "down", x: 20, y: 20, button: "left", buttons: 1 },
            { type: "mouse", action: "up", x: 20, y: 20, button: "left", buttons: 0 },
            { type: "text", text: "through stream" },
          ])
            client.send(JSON.stringify(message));
        });
        return client;
      }),
      (client) => Effect.sync(() => client.terminate()),
    );
    yield* awaitSocketEvent(frames, closed, "the document frame");
    expect(yield* awaitSocketEvent(measured, closed, "the document height")).toBe(240);
    expect(yield* awaitSocketEvent(trigger, closed, "the input-triggered asset request")).toBe(
      "?text=through%20stream",
    );
    const widgetReady = Deferred.makeUnsafe<void>();
    const widgetFrame = Deferred.makeUnsafe<void>();
    const activated = Deferred.makeUnsafe<unknown>();
    const nestedActivation = Deferred.makeUnsafe<unknown>();
    const widgetMessage = Deferred.makeUnsafe<unknown>();
    const widgetClosed = Deferred.makeUnsafe<number>();
    const widgetSocket = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const options = {
          ca: relayTls.cert,
          servername: "localhost",
          headers: { host: "localhost" },
        };
        const client = new NodeWS.WebSocket(origin.replace("https:", "wss:") + route, options);
        client.once("error", (error) => Deferred.doneUnsafe(widgetClosed, Effect.die(error)));
        client.once("close", (code) => Deferred.doneUnsafe(widgetClosed, Effect.succeed(code)));
        client.once("open", () =>
          client.send(
            JSON.stringify({
              type: "openAsset",
              appearance: "dark",
              verifiedAssetUrl: widgetUrl.href,
              widget: "mcp-app",
            }),
          ),
        );
        client.on("message", (frame, binary) => {
          if (binary) {
            client.send('{"type":"ack"}');
            Deferred.doneUnsafe(widgetFrame, Effect.void);
            return;
          }
          const message = JSON.parse(String(frame));
          if (message.type === "widgetReady") Deferred.doneUnsafe(widgetReady, Effect.void);
          if (message.type !== "widgetMessage") return;
          if (message.data.method === "t3/test") {
            Deferred.doneUnsafe(
              message.data.id === 3 ? nestedActivation : activated,
              Effect.succeed(message.gesture),
            );
          } else if (message.data.method === "ui/initialize") {
            client.send(
              JSON.stringify({
                type: "widgetMessage",
                data: { jsonrpc: "2.0", id: message.data.id, result: { host: "typed-bridge" } },
              }),
            );
          } else {
            Deferred.doneUnsafe(widgetMessage, Effect.succeed(message.data));
          }
        });
        return client;
      }),
      (client) => Effect.sync(() => client.terminate()),
    );
    expect(
      yield* awaitSocketEvent(widgetMessage, widgetClosed, "widget initialization"),
    ).toMatchObject({
      method: "ui/notifications/initialized",
      result: { host: "typed-bridge" },
      color: "dark",
    });
    expect(yield* Deferred.isDone(widgetReady)).toBe(true);
    yield* awaitSocketEvent(widgetFrame, widgetClosed, "the widget frame");
    for (const input of [
      { type: "mouse", action: "down", x: 30, y: 30, button: "left", buttons: 1 },
      { type: "mouse", action: "up", x: 30, y: 30, button: "left", buttons: 0, widgetGesture: 1 },
    ])
      widgetSocket.send(JSON.stringify(input));
    expect(yield* awaitSocketEvent(activated, widgetClosed, "the widget button response")).toBe(1);
    for (const input of [
      { type: "mouse", action: "down", x: 30, y: 120, button: "left", buttons: 1 },
      { type: "mouse", action: "up", x: 30, y: 120, button: "left", buttons: 0, widgetGesture: 2 },
    ])
      widgetSocket.send(JSON.stringify(input));
    expect(
      yield* awaitSocketEvent(nestedActivation, widgetClosed, "the nested button response"),
    ).toBeUndefined();
    widgetSocket.send('{"type":"widgetMessage","data":{"navigate":true}}');
    expect(yield* Deferred.await(widgetClosed)).toBe(4404);
    yield* awaitSocketEvent(pendingRead, closed, "the pending asset request");
    expect(yield* Deferred.isDone(closed)).toBe(false);
    expect(yield* Deferred.isDone(canceledRead)).toBe(false);
    yield* Deferred.succeed(revoke, undefined);
    yield* Deferred.await(closed);
    yield* Deferred.await(canceledRead);
  }).pipe(
    Effect.provide(Layer.merge(layerTest, NodeHttpPlatform.layer.pipe(Layer.provide(layerTest)))),
  ),
);
