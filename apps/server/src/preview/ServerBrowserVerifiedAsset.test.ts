// @effect-diagnostics nodeBuiltinImport:off -- This fixture sets platform trust for its disposable TLS servers.
import * as NodeCrypto from "node:crypto";
import * as NodeTls from "node:tls";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import { chromium } from "playwright-core";
import { expect, vi } from "vite-plus/test";

import { createRouteProof, environmentId } from "../../../web/test/relayRouteProof/fixture.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

const threadId = ThreadId.make("verified-asset");
const dependencies = Layer.mergeAll(
  Manager.layer,
  Broker.layer,
  DesktopBrowserChannel.layer,
  PreviewAgentActivity.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make(environmentId)),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.succeed(chromium.executablePath()),
    installed: Effect.succeedSome(chromium.executablePath()),
  }),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-verified-asset-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, Crypto.layer)),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));

it.live(
  "opens a verified attachment in dark Chromium and confines its signed reads to the enrolled connection",
  () =>
    Effect.gen(function* () {
      const proof = yield* Effect.acquireDisposable(Effect.promise(createRouteProof));
      const trusted = NodeTls.getCACertificates("default");
      NodeTls.setDefaultCACertificates([...trusted, proof.ca]);
      const pin = NodeCrypto.createHash("sha256")
        .update(
          new NodeCrypto.X509Certificate(proof.alpha.cert).publicKey.export({
            type: "spki",
            format: "der",
          }),
        )
        .digest("base64");
      const signedPath = "/api/assets/fixture.signature";
      const signed = (file: string, origin = proof.alpha.origin) =>
        `${origin}${signedPath}/${file}`;
      const sent: Array<{ path: string | undefined; range: string | undefined }> = [];
      const unexpected: Array<string | undefined> = [];
      proof.alpha.server.removeAllListeners("request");
      proof.beta.server.removeAllListeners("request");
      proof.beta.server.on("request", (request, response) => {
        unexpected.push(request.url);
        response.writeHead(200).end();
      });
      proof.alpha.server.on("request", (request, response) => {
        sent.push({ path: request.url, range: request.headers.range });
        expect(request.headers.cookie).toBeUndefined();
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers.referer).toBeUndefined();
        switch (request.url) {
          case `${signedPath}/report.html`:
            response.writeHead(200, {
              "content-type": "text/html",
              "content-security-policy":
                "sandbox allow-scripts allow-forms allow-popups allow-downloads",
            }).end(`
          <title>Verified attachment</title>
          <link rel="stylesheet" href="style.css">
          <audio controls preload="metadata" src="sound.wav"></audio>
          <iframe src="unrelated.html"></iframe>
          <img src="${proof.beta.origin}/foreign">
          <img src="/api/session">
          <script>document.title = "Unexpected script"; new WebSocket("${proof.beta.origin.replace("https:", "wss:")}/socket");</script>
        `);
            return;
          case `${signedPath}/style.css`:
            response
              .writeHead(200, { "content-type": "text/css" })
              .end("@media (prefers-color-scheme: dark) { body { background: #181818; } }");
            return;
          case `${signedPath}/sound.wav`: {
            const bytes = Buffer.alloc(8_000);
            bytes.write("RIFF", 0);
            bytes.writeUInt32LE(bytes.length - 8, 4);
            bytes.write("WAVEfmt ", 8);
            bytes.writeUInt32LE(16, 16);
            bytes.writeUInt16LE(1, 20);
            bytes.writeUInt16LE(1, 22);
            bytes.writeUInt32LE(8_000, 24);
            bytes.writeUInt32LE(8_000, 28);
            bytes.writeUInt16LE(1, 32);
            bytes.writeUInt16LE(8, 34);
            bytes.write("data", 36);
            bytes.writeUInt32LE(bytes.length - 44, 40);
            response
              .writeHead(206, {
                "content-type": "audio/wav",
                "accept-ranges": "bytes",
                "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
                "content-length": bytes.length,
              })
              .end(bytes);
            return;
          }
          case `${signedPath}/oversize.html`:
            response
              .writeHead(200, { "content-type": "text/html", "content-length": 33 * 1024 * 1024 })
              .end();
            return;
          case `${signedPath}/redirect.html`:
            response
              .writeHead(302, { location: signed("redirect-target.html", proof.beta.origin) })
              .end();
            return;
          default:
            unexpected.push(request.url);
            response.writeHead(404).end();
        }
      });
      proof.beta.server.on("upgrade", (request, socket) => {
        unexpected.push(request.url);
        socket.destroy();
      });

      const enroll = (httpsOrigin: string, id = environmentId) =>
        vi.stubEnv(
          "T3CODE_SERVER_BROWSER_VERIFIED_ROUTE",
          JSON.stringify({
            environmentId: id,
            httpsOrigin,
            leafSpkiSha256: pin,
          }),
        );
      vi.stubEnv("T3CODE_SERVER_BROWSER_SANDBOX", "0");
      enroll(proof.alpha.origin);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeTls.setDefaultCACertificates(trusted);
          vi.unstubAllEnvs();
        }),
      );
      yield* Effect.gen(function* () {
        yield* ServerBrowser.ServerBrowser;
        const manager = yield* Manager.PreviewManager;
        const broker = yield* Broker.PreviewAutomationBroker;
        const events = yield* manager.subscribeEvents;
        yield* Effect.yieldNow;
        expect(yield* manager.list({ threadId })).toMatchObject({
          verifiedAssetOrigin: proof.alpha.origin,
        });
        const open = Effect.fnUntraced(function* (verifiedAssetUrl: string) {
          const tab = yield* manager.open({
            threadId,
            runtime: "server",
            colorScheme: "dark",
            verifiedAssetUrl,
          });
          expect(tab).toMatchObject({ headless: true, verifiedAsset: true });
          expect(JSON.stringify(tab)).not.toContain("fixture.signature");
          while (true) {
            const event = yield* PubSub.take(events);
            if (
              (event.type !== "navigated" && event.type !== "failed") ||
              event.tabId !== tab.tabId
            )
              continue;
            expect(JSON.stringify(event)).not.toContain("fixture.signature");
            if (event.type === "failed")
              return {
                tabId: tab.tabId,
                status: { _tag: "LoadFailed", description: event.description },
              };
            if (event.snapshot.navStatus._tag !== "Loading")
              return { tabId: tab.tabId, status: event.snapshot.navStatus };
          }
        });

        const rendered = yield* open(signed("report.html"));
        expect(rendered.status).toMatchObject({
          _tag: "Success",
          title: "Verified attachment",
        });
        const target = {
          scope: {
            environmentId: EnvironmentId.make(environmentId),
            thread: {
              threadId,
              providerSessionId: "browser-proof",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            client: undefined,
            requestNamespace: "verified-asset",
            capabilities: new Set(["preview"] as const),
            issuedAt: 1,
          },
          tabId: PreviewTabId.make(rendered.tabId),
        };
        expect(
          yield* broker.invoke({
            ...target,
            operation: "evaluate",
            input: {
              expression: `(async () => {
            const audio = document.querySelector("audio");
            if (audio.readyState === 0) await new Promise((resolve, reject) => {
              audio.addEventListener("loadedmetadata", resolve, { once: true });
              audio.addEventListener("error", reject, { once: true });
            });
            return {
              dark: matchMedia("(prefers-color-scheme: dark)").matches,
              offline: !navigator.onLine,
              background: getComputedStyle(document.body).backgroundColor,
              duration: audio.duration,
            };
          })()`,
            },
          }),
        ).toEqual({ dark: true, offline: true, background: "rgb(24, 24, 24)", duration: 0.9945 });
        expect(sent.find(({ path }) => path === `${signedPath}/sound.wav`)?.range).toBe(
          "bytes=0-8388607",
        );
        expect(sent.map(({ path }) => path).sort()).toEqual([
          `${signedPath}/report.html`,
          `${signedPath}/sound.wav`,
          `${signedPath}/style.css`,
        ]);
        const foreignNavigation = yield* broker
          .invoke<void>({
            ...target,
            operation: "navigate",
            input: { url: `${proof.beta.origin}/escape` },
          })
          .pipe(Effect.flip);
        expect(foreignNavigation.message).toContain("ERR_FAILED");
        expect((yield* open(signed("redirect.html"))).status).toMatchObject({ _tag: "LoadFailed" });
        expect((yield* open(signed("oversize.html"))).status).toMatchObject({ _tag: "LoadFailed" });

        const mismatchedOrigin = yield* manager
          .open({
            threadId,
            runtime: "server",
            verifiedAssetUrl: signed("report.html", proof.beta.origin),
          })
          .pipe(Effect.flip);
        expect(mismatchedOrigin._tag).toBe("PreviewVerifiedAssetUnavailableError");

        enroll(proof.beta.origin);
        expect((yield* open(signed("report.html", proof.beta.origin))).status).toMatchObject({
          _tag: "LoadFailed",
        });
        enroll(proof.alpha.origin, "another-environment");
        expect((yield* open(signed("report.html"))).status).toMatchObject({ _tag: "LoadFailed" });

        enroll(proof.alpha.origin);
        NodeTls.setDefaultCACertificates(trusted);
        expect((yield* open(signed("report.html"))).status).toMatchObject({ _tag: "LoadFailed" });
        vi.stubEnv("T3CODE_SERVER_BROWSER_VERIFIED_ROUTE", undefined);
        expect((yield* manager.list({ threadId })).verifiedAssetOrigin).toBeUndefined();
        const missingEnrollment = yield* manager
          .open({
            threadId,
            runtime: "server",
            verifiedAssetUrl: signed("report.html"),
          })
          .pipe(Effect.flip);
        expect(missingEnrollment._tag).toBe("PreviewVerifiedAssetUnavailableError");
        // Chromium may repeat a refused load under load; only the reached paths are fixed.
        expect([...new Set(sent.map(({ path }) => path))].sort()).toEqual([
          `${signedPath}/oversize.html`,
          `${signedPath}/redirect.html`,
          `${signedPath}/report.html`,
          `${signedPath}/sound.wav`,
          `${signedPath}/style.css`,
        ]);
        for (const name of ["report.html", "style.css", "sound.wav"]) {
          expect(sent.filter(({ path }) => path === `${signedPath}/${name}`)).toHaveLength(1);
        }
        expect(unexpected).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
);
