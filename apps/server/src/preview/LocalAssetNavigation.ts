// @effect-diagnostics nodeBuiltinImport:off -- The Node HTTP file response provides a lazy Node readable.
import type { PreviewAssetWidgetKind } from "@t3tools/contracts";
import * as NodeStream from "node:stream";
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { BrowserContext, Frame } from "playwright-core";

import { resolveAsset, type ResolvedAsset } from "../assets/AssetAccess.ts";
import { assetFileResponse } from "../http.ts";
import { boundedRange } from "./VerifiedAssetNavigation.ts";

const VIEW_URL = "https://t3-local-preview.invalid/document";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_VIEW_BYTES = 128 * 1024 * 1024;
const MAX_IN_FLIGHT = 8;
const ASSET_PATH = /^\/api\/assets\/([\w-]+\.[\w-]+)\/([^/]+(?:\/[^/]+)*)$/;
const RESOURCE_TYPES = new Set(["document", "stylesheet", "script", "image", "font", "media"]);

function exactAssetUrl(raw: string, issuer: string) {
  const url = URL.parse(raw);
  if (
    raw.length > 4608 ||
    url?.protocol !== "https:" ||
    url.origin !== issuer ||
    url.href !== raw ||
    url.username ||
    url.password ||
    url.hash ||
    /%(?:2f|5c|00)/i.test(url.pathname)
  )
    return null;
  return ASSET_PATH.test(url.pathname) ? url : null;
}

function supportedMime(type: string, contentType: string) {
  switch (type) {
    case "document":
      return /^(?:text\/html|image\/svg\+xml)$/.test(contentType);
    case "stylesheet":
      return contentType === "text/css";
    case "script":
      return /^(?:application|text)\/(?:javascript|ecmascript)$/.test(contentType);
    case "image":
      return contentType.startsWith("image/");
    case "font":
      return /^(?:font\/|application\/(?:font-woff|vnd.ms-fontobject|x-font-))/.test(contentType);
    case "media":
      return /^(?:audio|video)\//.test(contentType);
    default:
      return false;
  }
}

const readSignedAsset = Effect.fn("LocalAssetNavigation.readSignedAsset")(
  function* (options: {
    readonly url: URL;
    readonly method: "GET" | "HEAD";
    readonly range: string | undefined;
    readonly ifRange: string | undefined;
    readonly type: string;
    readonly widget?: PreviewAssetWidgetKind;
  }) {
    const match = ASSET_PATH.exec(options.url.pathname);
    if (!match?.[1] || !match[2]) return null;
    const asset: ResolvedAsset | null = yield* resolveAsset(match[1], match[2]);
    // Source control media would dispatch a network request.
    if (asset?.kind !== "file" || asset.download) return null;
    const widget =
      asset.renderIntent === "mcp-app" || asset.renderIntent === "plugin-panel"
        ? asset.renderIntent
        : undefined;
    if (options.widget !== widget) return null;
    const response = yield* assetFileResponse(
      asset,
      options.range,
      options.ifRange,
      options.method,
    );
    if (response.status !== 200 && response.status !== 206 && response.status !== 416) return null;
    const mime = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!supportedMime(options.type, mime)) return null;
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (options.method !== "HEAD") {
      if (Number(response.headers["content-length"]) > MAX_BODY_BYTES) return null;
      if (response.body._tag === "Uint8Array") {
        length = response.body.body.byteLength;
        chunks.push(response.body.body);
      } else if (response.body._tag !== "Empty") {
        const body = response.body;
        const nodeBody =
          body._tag === "Raw" && body.body instanceof NodeStream.Readable ? body.body : null;
        const stream =
          body._tag === "Stream"
            ? body.stream
            : nodeBody
              ? EffectNodeStream.fromReadable<Uint8Array>({ evaluate: () => nodeBody })
              : null;
        if (!stream) return null;
        yield* Stream.runForEach(
          Stream.mapError(stream, () => "asset read failed" as const),
          (chunk) => {
            length += chunk.byteLength;
            if (length > MAX_BODY_BYTES) return Effect.fail("asset byte limit");
            chunks.push(chunk);
            return Effect.void;
          },
        );
      }
      if (length > MAX_BODY_BYTES) return null;
    }
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      // Fonts and module scripts are CORS requests from the opaque frame.
      "access-control-allow-origin": "null",
    };
    for (const name of ["accept-ranges", "content-length", "content-range", "content-type"]) {
      const value = response.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    const assets = options.url.origin + "/api/assets/";
    const policy = [
      "default-src 'none'",
      `script-src ${assets} 'unsafe-inline'`,
      `style-src ${assets} 'unsafe-inline'`,
      `img-src ${assets} data: blob:`,
      `font-src ${assets} data:`,
      `media-src ${assets} blob:`,
      `frame-src ${assets}`,
      "base-uri 'none'",
      "form-action 'none'",
      "sandbox allow-scripts",
    ].join("; ");
    headers["content-security-policy"] = [response.headers["content-security-policy"], policy]
      .filter(Boolean)
      .join(", ");
    return { status: response.status, headers, body: Buffer.concat(chunks, length) };
  },
  Effect.scoped,
  Effect.orElseSucceed(() => null),
);

export const makeDispatcher = Effect.gen(function* () {
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof readSignedAsset>>>();
  const run = Effect.runPromiseWith(context);
  return (request: Parameters<typeof readSignedAsset>[0], signal: AbortSignal) =>
    run(readSignedAsset(request), { signal });
});

export class LocalAssetDispatcher extends Context.Service<
  LocalAssetDispatcher,
  { readonly read: Effect.Success<typeof makeDispatcher> }
>()("t3/preview/LocalAssetNavigation/LocalAssetDispatcher") {}

export const layer = Layer.effect(
  LocalAssetDispatcher,
  Effect.map(makeDispatcher, (read) => LocalAssetDispatcher.of({ read })),
);

export function prepare(
  issuedUrl: string,
  issuer: string,
  appearance: "light" | "dark",
  dispatch: Effect.Success<typeof makeDispatcher>,
  themeFragment = "",
  widget?: PreviewAssetWidgetKind,
) {
  const upstream = exactAssetUrl(issuedUrl, issuer);
  if (!upstream) return null;
  return { upstream, viewUrl: new URL(VIEW_URL), appearance, dispatch, themeFragment, widget };
}

export type LocalAssetNavigation = NonNullable<ReturnType<typeof prepare>>;

const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

export async function install(context: BrowserContext, asset: LocalAssetNavigation) {
  const closed = new AbortController();
  context.once("close", () => closed.abort());
  let inFlight = 0;
  let bytes = 0;
  let rootRequested = false;
  let shellFrame: Frame | undefined;
  await context.routeWebSocket("**/*", (socket) => socket.close());
  await context.route("**/*", async (route, request) => {
    try {
      const raw = request.url();
      const method = request.method();
      const type = request.resourceType();
      const frame = request.frame();
      if (!shellFrame && raw === VIEW_URL && method === "GET" && frame.parentFrame() === null) {
        shellFrame = frame;
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          headers: {
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-src ${asset.upstream.origin}/api/assets/`,
          },
          body: `<!doctype html><meta name="color-scheme" content="${asset.appearance}"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block;background:#fff}@media(prefers-color-scheme:dark){html,body,iframe{background:#181818}}</style><iframe title="Document" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${attribute(asset.upstream.href + asset.themeFragment)}"></iframe>`,
        });
        return;
      }
      const rootDocument =
        type === "document" && shellFrame !== undefined && frame.parentFrame() === shellFrame;
      if (rootDocument && (rootRequested || raw !== asset.upstream.href || method !== "GET")) {
        await route.abort();
        if (asset.widget)
          void frame
            .page()
            .close()
            .catch(() => undefined);
        return;
      }
      const url = exactAssetUrl(raw, asset.upstream.origin);
      if (
        !url ||
        !shellFrame ||
        frame.page() !== shellFrame.page() ||
        frame === shellFrame ||
        (method !== "GET" && method !== "HEAD") ||
        !RESOURCE_TYPES.has(type) ||
        inFlight >= MAX_IN_FLIGHT ||
        bytes >= MAX_VIEW_BYTES
      ) {
        await route.abort();
        return;
      }
      if (rootDocument) rootRequested = true;
      const headers = request.headers();
      const range = headers.range === undefined ? undefined : boundedRange(headers.range);
      if (range === null) {
        await route.abort();
        return;
      }
      inFlight++;
      try {
        const response = await asset.dispatch(
          {
            url,
            method,
            range,
            ifRange: headers["if-range"],
            type,
            ...(rootDocument && asset.widget !== undefined ? { widget: asset.widget } : {}),
          },
          AbortSignal.any([closed.signal, AbortSignal.timeout(15_000)]),
        );
        if (!response || bytes + response.body.byteLength > MAX_VIEW_BYTES) {
          await route.abort();
          return;
        }
        bytes += response.body.byteLength;
        await route.fulfill(response);
      } finally {
        inFlight--;
      }
    } catch {
      await route.abort().catch(() => undefined);
    }
  });
}
