import * as AtomReact from "@effect/atom-react";
import { verifiedDocumentCsp } from "@t3tools/shared/verifiedDocumentCsp";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";

import * as VerifiedRoutes from "../connection/verified-route";
import * as VerifiedNetwork from "../native/verifiedNetwork";
import {
  framedWebDocument,
  isolatedWebDocument,
  isIsolatedDocumentNavigation,
  readFramedWebMessage,
  useVerifiedWebDocument,
} from "./verifiedWebDocument";
import {
  createVerifiedWebResourceScope,
  verifiedDocumentResourceUrl,
  verifiedWebResourceBootstrap,
  workspaceHtmlResources,
} from "./verifiedWebResources";

vi.mock("@effect/atom-react", () => ({ useAtomValue: vi.fn() }));

it("places a policy before document content and refuses network navigation", () => {
  const document = isolatedWebDocument(
    '<!DOCTYPE html><base href="https://other.test/"><script src="https://other.test/app.js"></script>',
  );
  expect(document).toMatch(
    /^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';/,
  );
  expect(document).toContain(
    "connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
  );
  expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("<base"));
  expect(isIsolatedDocumentNavigation("https://other.test/")).toBe(false);
  expect(isIsolatedDocumentNavigation("file:///cache/secret")).toBe(false);
  expect(isIsolatedDocumentNavigation("about:srcdoc")).toBe(true);
});

it("resolves signed subresources against the exact issuer without inheriting a grant", () => {
  const document = "https://relay.test:8443/api/assets/document.sig/page.html";
  const expected = "https://relay.test:8443/api/assets/asset.sig/image.png";
  expect(verifiedDocumentResourceUrl(document, "../asset.sig/image.png#preview")).toBe(expected);
  expect(verifiedDocumentResourceUrl(document, "/api/auth/session")).toBeNull();
  expect(verifiedDocumentResourceUrl(document, "/api/assets/image.png")).toBeNull();
  expect(
    verifiedDocumentResourceUrl(document, "https://relay.test/api/assets/asset.sig/image.png"),
  ).toBeNull();
  expect(
    verifiedDocumentResourceUrl(
      document,
      "https://user@relay.test:8443/api/assets/asset.sig/image.png",
    ),
  ).toBeNull();
});

it("allows workspace preview dependencies within the signed directory", () => {
  const document = "https://relay.test:8443/api/assets/document.sig/index.html";
  const stylesheet = "https://relay.test:8443/api/assets/document.sig/styles/main.css";
  expect(verifiedDocumentResourceUrl(document, "styles/main.css", true)).toBe(stylesheet);
  expect(verifiedDocumentResourceUrl(document, "styles/main.css")).toBeNull();
  expect(
    verifiedDocumentResourceUrl(document, "../media/cover%20art.png?v=2#sample", true, stylesheet),
  ).toBe("https://relay.test:8443/api/assets/document.sig/media/cover%20art.png?v=2");
  expect(verifiedDocumentResourceUrl(document, "/api/assets/asset.sig/image.png", true)).toBe(
    "https://relay.test:8443/api/assets/asset.sig/image.png",
  );
  for (const reference of [
    "data.txt",
    ".hidden/cover.png",
    "styles/%2e%2e%2foutside.png",
    "styles%2fmain.css",
    "../asset.sig/image.png",
    "../document.sig/media/cover.png",
    "https://other.test/api/assets/document.sig/styles/main.css",
  ]) {
    expect(verifiedDocumentResourceUrl(document, reference, true)).toBeNull();
  }
  expect(verifiedDocumentResourceUrl(document, "other.html")).toBeNull();
  expect(verifiedDocumentResourceUrl(document, "?v=2")).toBe(
    "https://relay.test:8443/api/assets/document.sig/index.html?v=2",
  );
});

const workspaceIssuer = "https://relay.test/api/assets/document.sig/index.html";
const workspacePrefix = "https://relay.test/api/assets/document.sig/";
// The ordinary HTML asset header in apps/server/src/http.ts.
const serverSandbox = "sandbox allow-scripts allow-forms allow-popups allow-downloads";

it.each([
  { policy: "script-src 'none'", bridge: false, kind: "local" },
  { policy: "script-src 'none'", bridge: true, kind: "failed" },
  { policy: "connect-src 'none'", bridge: true, kind: "failed" },
  { policy: "default-src 'self'", bridge: false, kind: "failed" },
  { policy: "frame-ancestors 'none'", bridge: false, kind: "failed" },
  { policy: "sandbox", bridge: false, kind: "failed" },
  { policy: serverSandbox, bridge: true, kind: "local" },
  { policy: `${serverSandbox}; script-src 'none'`, bridge: true, kind: "local" },
  { policy: `${serverSandbox}; connect-src 'none'`, bridge: true, kind: "failed" },
  { policy: 'script-src "invalid,quoted"', bridge: false, kind: "failed" },
  { policy: "script-src 'unsafe-inline'\u00a0", bridge: false, kind: "failed" },
  { policy: "", bridge: true, kind: "local" },
  {
    policy: serverSandbox,
    bridge: true,
    kind: "local",
    documentPolicy:
      "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'unsafe-inline'; connect-src 'none'\">",
  },
  {
    policy: serverSandbox,
    bridge: true,
    kind: "local",
    documentPolicy:
      '<meta content="connect-src \'none\'; img-src https://example.test/?q=>" HTTP-EQUIV="Content-Security-Polic&#121;">',
  },
] as const)(
  "reconstructs a verified response with issuer CSP $policy and bridge=$bridge",
  async (input) => {
    const { policy, bridge, kind } = input;
    const documentPolicy = "documentPolicy" in input ? input.documentPolicy : "";
    const relayPolicy = verifiedDocumentCsp(workspaceIssuer);
    using _required = vi.spyOn(VerifiedRoutes, "verificationRequiredFor").mockReturnValue(true);
    using transport = vi.spyOn(VerifiedNetwork, "requestVerifiedRoute").mockResolvedValue({
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Content-Security-Policy": policy ? `${policy}, ${relayPolicy}` : relayPolicy,
      },
      bodyBase64: btoa(documentPolicy + "<script>run()</script>"),
    });
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const atomValue = vi.mocked(AtomReact.useAtomValue);
    atomValue.mockReset().mockImplementation((atom) => registry.get(atom));
    const access = bridge ? workspaceHtmlResources : undefined;
    expect(useVerifiedWebDocument(workspaceIssuer, access).kind).toBe("loading");
    const [atom] = atomValue.mock.calls[0]!;
    const settled = Promise.withResolvers<void>();
    using _subscription = {
      [Symbol.dispose]: registry.subscribe(
        atom,
        (result) => {
          if (AsyncResult.isAsyncResult(result) && !AsyncResult.isInitial(result))
            settled.resolve();
        },
        { immediate: true },
      ),
    };
    await settled.promise;

    const document = useVerifiedWebDocument(workspaceIssuer, access);
    expect(document.kind).toBe(kind);
    expect(transport.mock.calls.map(([url]) => url)).toEqual([workspaceIssuer]);
    expect(transport.mock.calls[0]?.[1].requireVerified).toBe(true);
    if (document.kind === "local") {
      expect(document.html).toContain(`content="${relayPolicy}"`);
      if (documentPolicy) {
        expect(document.html).toContain(documentPolicy);
        expect(document.html).not.toContain("t3VerifiedResource");
        expect(document.resourceAccess).toBeUndefined();
        expect(transport).toHaveBeenCalledOnce();
      } else if (policy === serverSandbox) {
        expect(document).toMatchObject({
          sandbox: "allow-scripts allow-forms allow-popups allow-downloads",
          resourceAccess: { assets: true, fetch: true, workspaceHtml: true, framed: true },
        });
        expect(document.html).toContain('window.parent.postMessage(message,"*")');
        expect(document.html.indexOf(relayPolicy)).toBeLessThan(
          document.html.indexOf("window.fetch"),
        );
        const outer = framedWebDocument(document, "", "relay-secret");
        expect(outer.match(/<iframe[^>]*\bsandbox="([^"]*)"/)?.[1]).toBe(
          "allow-scripts allow-forms allow-popups allow-downloads",
        );
      } else if (policy.startsWith(serverSandbox)) {
        expect(document.html).toContain(`content="script-src 'none'"`);
        expect(document.html.indexOf("script-src 'none'")).toBeLessThan(
          document.html.indexOf("run()"),
        );
        expect(document.html).not.toContain("t3VerifiedResource");
        expect(document).toMatchObject({ resourceAccess: undefined });
      } else if (policy) {
        expect(document.html).toContain(`content="${policy}"`);
        expect(document.html.indexOf(policy)).toBeLessThan(document.html.indexOf("<script>"));
        expect(document.html).not.toContain("t3VerifiedResource");
      } else {
        expect(document.html.indexOf(relayPolicy)).toBeLessThan(
          document.html.indexOf("window.fetch"),
        );
      }
    }
  },
);

it("relays scoped native resource replies to the sandboxed document and rejects forged messages", async () => {
  const binding = {
    httpsOrigin: "https://relay.test",
    environmentId: "test",
    leafSpkiSha256: "A".repeat(43) + "=",
  };
  using _route = vi.spyOn(VerifiedRoutes, "verifiedRouteFor").mockReturnValue(binding);
  using transport = vi.spyOn(VerifiedNetwork, "requestVerifiedRoute").mockResolvedValue({
    status: 200,
    headers: { "Content-Type": "image/png" },
    bodyBase64: btoa("image"),
  });
  const access = { assets: false, fetch: true, framed: true, workspaceHtml: true };
  const html = isolatedWebDocument("", workspaceIssuer, access, [
    verifiedDocumentCsp(workspaceIssuer),
  ]);
  const secret = "relay-secret";
  const outerHtml = framedWebDocument({ html }, "", secret);
  type Message = { source: object; data: unknown };
  const outerEvents = new Map<string, (event: Message) => void>();
  const childEvents = new Map<string, (event: Message) => void>();
  const parentWindow = {
    postMessage: (data: unknown) => outerEvents.get("message")?.({ source: childWindow, data }),
  };
  const childWindow = {
    parent: parentWindow,
    addEventListener: (type: string, handler: (event: Message) => void) =>
      childEvents.set(type, handler),
    postMessage: (data: unknown) => childEvents.get("message")?.({ source: parentWindow, data }),
  };
  const frame = { srcdoc: "", contentWindow: childWindow, addEventListener() {} };
  const receiveNative = (data: string) => {
    const envelope = readFramedWebMessage(data, secret);
    if (envelope) scope.receive(envelope.message);
  };
  const outer = NodeVM.createContext({
    navigator: {},
    document: { getElementById: () => frame },
    window: {
      addEventListener: (type: string, handler: (event: Message) => void) =>
        outerEvents.set(type, handler),
      ReactNativeWebView: { postMessage: receiveNative },
    },
  });
  const scope = createVerifiedWebResourceScope(
    workspaceIssuer,
    (script) => NodeVM.runInContext(script, outer),
    access,
  );
  using _scope = { [Symbol.dispose]: () => scope.stop() };
  const scriptBody = (document: string) => /<script>([\s\S]*)<\/script>/.exec(document)?.[1] ?? "";
  NodeVM.runInContext(scriptBody(outerHtml), outer);
  expect(frame.srcdoc).toBe(html);
  const request = { t3VerifiedResource: "read", id: 1, reference: "media/cover.png" };
  outerEvents.get("message")?.({ source: {}, data: request });
  receiveNative(JSON.stringify({ secret: "forged", message: request }));
  expect(transport).not.toHaveBeenCalled();

  const child = NodeVM.createContext({ Request, Response, URL, atob, window: childWindow });
  NodeVM.runInContext(scriptBody(frame.srcdoc), child);
  const body: unknown = await NodeVM.runInContext(
    'window.fetch("media/cover.png").then(response => response.text())',
    child,
  );
  expect(body).toBe("image");
  expect(transport).toHaveBeenCalledExactlyOnceWith(`${workspacePrefix}media/cover.png`, {
    method: "GET",
    requireVerified: true,
    signal: expect.any(AbortSignal),
  });
});

it("forwards a verified dependency as a cancellable native GET", () => {
  const binding = {
    httpsOrigin: "https://relay.test",
    environmentId: "test",
    leafSpkiSha256: "A".repeat(43) + "=",
  };
  using _route = vi.spyOn(VerifiedRoutes, "verifiedRouteFor").mockReturnValue(binding);
  const pending = Promise.withResolvers<null>();
  using transport = vi
    .spyOn(VerifiedNetwork, "requestVerifiedRoute")
    .mockReturnValue(pending.promise);
  const scope = createVerifiedWebResourceScope(workspaceIssuer, () => {}, workspaceHtmlResources);
  scope.receive({
    t3VerifiedResource: "load",
    id: 1,
    reference: "../media/cover.png",
    stylesheet: `${workspacePrefix}styles/main.css`,
  });
  const [url, options] = transport.mock.calls[0] ?? [];
  expect(url).toBe(`${workspacePrefix}media/cover.png`);
  expect(options?.method).toBe("GET");
  expect(options?.signal?.aborted).toBe(false);
  scope.receive({ t3VerifiedResource: "cancel", id: 1 });
  expect(options?.signal?.aborted).toBe(true);
  pending.resolve(null);
  scope.stop();
});

function runWorkspaceStylesheet(
  read: (url: string) => readonly [type: string, body: string] | undefined,
  issuerPolicies: readonly string[] = [],
) {
  const installed = Promise.withResolvers<string>();
  const cancelled = Promise.withResolvers<number>();
  const blobs = new Map<string, Blob>();
  const requests: string[] = [];
  const inlineStyles = new Set<{ textContent: string }>();
  let observer: ((records: unknown) => void) | undefined;
  const link = {
    tagName: "LINK",
    relList: { contains: (rel: string) => rel === "stylesheet" },
    isConnected: true,
    matches: () => true,
    getAttribute: () => "styles/main.css",
    setAttribute: (_name: string, value: string) => installed.resolve(value),
    after(...styles: { textContent: string }[]) {
      for (const style of styles) inlineStyles.add(style);
      installed.resolve("inline");
    },
  };
  const html = isolatedWebDocument("", workspaceIssuer, workspaceHtmlResources, issuerPolicies);
  const bootstrap = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
  const context = NodeVM.createContext({
    AbortController,
    Blob,
    Request,
    Response,
    TextDecoder,
    atob,
    btoa,
    URL: class extends URL {
      static override createObjectURL(blob: Blob) {
        const url = `blob:${blobs.size + 1}`;
        blobs.set(url, blob);
        return url;
      }

      static override revokeObjectURL(url: string) {
        blobs.delete(url);
      }
    },
    MutationObserver: class {
      constructor(callback: (records: unknown) => void) {
        observer = callback;
      }

      observe() {}
    },
    document: {
      querySelectorAll: () => [link],
      createElement(tagName: string) {
        expect(tagName).toBe("style");
        return {
          textContent: "",
          remove() {
            inlineStyles.delete(this);
          },
        };
      },
    },
    window: {
      ReactNativeWebView: {
        postMessage(message: string) {
          const { t3VerifiedResource, id, reference, stylesheet } = JSON.parse(message);
          if (t3VerifiedResource === "cancel") {
            cancelled.resolve(id);
            return;
          }
          const url = verifiedDocumentResourceUrl(workspaceIssuer, reference, true, stylesheet);
          if (url) requests.push(url);
          const result = url ? read(url) : null;
          if (result === undefined) return;
          const value = result
            ? { status: 200, type: result[0], body: Buffer.from(result[1]).toString("base64") }
            : null;
          queueMicrotask(() =>
            NodeVM.runInContext(
              `window.__t3VerifiedResource(${id},${JSON.stringify(value)})`,
              context,
            ),
          );
        },
      },
    },
  });
  NodeVM.runInContext(bootstrap, context);
  return {
    html,
    installed: installed.promise,
    cancelled: cancelled.promise,
    blobs,
    inlineStyles,
    requests,
    removeLink() {
      link.isConnected = false;
      observer?.([{ type: "childList", addedNodes: [], removedNodes: [link] }]);
    },
  };
}

it("installs scoped linked CSS and bare imports under the preserved relay policy", async () => {
  const policy = verifiedDocumentCsp(workspaceIssuer);
  const assets = new Map<string, readonly [string, string]>([
    [
      "styles/main.css",
      [
        "text/css",
        '/* @import "ignored.css"; */ @import "./nested/theme.css"; @import "print.css" print; body { background: url("../media/cover.png#sample"); } @import "late.css";',
      ],
    ],
    [
      "styles/nested/theme.css",
      [
        "text/css",
        '@charset "UTF-8"; @import url("../main.css"); @font-face { src: url(../../fonts/face.woff2); }',
      ],
    ],
    ["fonts/face.woff2", ["font/woff2", "font"]],
    ["media/cover.png", ["image/png", "cover"]],
  ]);
  const view = runWorkspaceStylesheet(
    (url) => assets.get(url.slice(workspacePrefix.length)) ?? ["text/plain", "unexpected request"],
    [policy],
  );
  expect(view.html).toContain(`content="${policy}"`);
  expect(await view.installed).toBe("inline");
  expect(view.requests).toEqual([
    `${workspacePrefix}styles/main.css`,
    `${workspacePrefix}styles/nested/theme.css`,
    `${workspacePrefix}fonts/face.woff2`,
    `${workspacePrefix}media/cover.png`,
  ]);
  const styles = Array.from(view.inlineStyles, (style) => style.textContent).join("\n");
  expect(styles).toContain('url("data:font/woff2;base64,Zm9udA==")');
  expect(styles).toContain('url("blob:1#sample")');
  expect(styles.indexOf("@font-face")).toBeLessThan(styles.indexOf("body {"));
  expect(Array.from(view.blobs.values(), (blob) => blob.type)).toEqual(["image/png"]);
  view.removeLink();
  expect(view.inlineStyles.size).toBe(0);
  expect(view.blobs.size).toBe(0);
});

it("hydrates imports and CSS assets from their containing stylesheet before installing the link", async () => {
  const assets = new Map<string, readonly [string, string]>([
    [
      "styles/main.css",
      [
        "text/css; charset=utf-8",
        '@import "./nested/theme.css" layer(theme); body { background: url("../media/cover%20art.png?v=2#sample"); }',
      ],
    ],
    [
      "styles/nested/theme.css",
      [
        "text/css",
        '@import url("../main.css"); @font-face { src: url(../../fonts/face.woff2) format("woff2"); } .wrong { background: url("../../media/wrong.png"); } /* url("ignored.png") */',
      ],
    ],
    ["fonts/face.woff2", ["font/woff2", "font"]],
    ["media/wrong.png", ["text/html", "<p>wrong MIME</p>"]],
    ["media/cover%20art.png?v=2", ["image/png", "cover"]],
  ]);
  const view = runWorkspaceStylesheet(
    (url) => assets.get(url.slice(workspacePrefix.length)) ?? ["text/plain", "unexpected request"],
  );
  const installed = await view.installed;
  expect(view.requests).toEqual([
    `${workspacePrefix}styles/main.css`,
    `${workspacePrefix}styles/nested/theme.css`,
    `${workspacePrefix}fonts/face.woff2`,
    `${workspacePrefix}media/wrong.png`,
    `${workspacePrefix}media/cover%20art.png?v=2`,
  ]);
  expect(view.blobs.get(installed)?.type).toBe("text/css");
  expect(await view.blobs.get(installed)?.text()).toBe(
    '@import url("blob:2") layer(theme); body { background: url("blob:3#sample"); }',
  );
  expect(await view.blobs.get("blob:2")?.text()).toBe(
    '@import url("data:,"); @font-face { src: url("blob:1") format("woff2"); } .wrong { background: url("data:,"); } /* url("ignored.png") */',
  );
  expect(view.blobs.get("blob:1")?.type).toBe("font/woff2");
  expect(view.blobs.get("blob:3")?.type).toBe("image/png");
  view.removeLink();
  expect(view.blobs.size).toBe(0);
});

it.each([false, true])(
  "cancels a pending stylesheet dependency on link removal (relay CSP: %s)",
  async (relay) => {
    const pending = Promise.withResolvers<void>();
    const view = runWorkspaceStylesheet(
      (url) => {
        if (url.endsWith("/main.css")) return ["text/css", '@import "pending.css";'];
        pending.resolve();
        return undefined;
      },
      relay ? [verifiedDocumentCsp(workspaceIssuer)] : [],
    );
    await pending.promise;
    view.removeLink();
    expect(await view.cancelled).toBe(2);
    expect(view.blobs.size).toBe(0);
  },
);

it.each([false, true])(
  "bounds stylesheet depth and dependency reads (relay CSP: %s)",
  async (relay) => {
    const references = Array.from({ length: 40 }, (_, index) => `url("image-${index}.png")`);
    const view = runWorkspaceStylesheet(
      (url) => {
        if (url.endsWith("/main.css")) {
          return [
            "text/css",
            `@import "level-1.css"; body { background: ${references.join(",")}; }`,
          ];
        }
        const level = /level-(\d+)\.css$/.exec(url)?.[1];
        return level
          ? ["text/css", `@import "level-${Number(level) + 1}.css";`]
          : ["image/png", "image"];
      },
      relay ? [verifiedDocumentCsp(workspaceIssuer)] : [],
    );
    const installed = await view.installed;
    expect(view.requests).toHaveLength(32);
    expect(view.requests).toContain(`${workspacePrefix}styles/level-4.css`);
    expect(view.requests).not.toContain(`${workspacePrefix}styles/level-5.css`);
    expect(view.requests.at(-1)).toBe(`${workspacePrefix}styles/image-26.png`);
    const css = relay
      ? Array.from(view.inlineStyles, (style) => style.textContent).join("\n")
      : await view.blobs.get(installed)?.text();
    expect(css).not.toContain("image-27.png");
  },
);

it.each([false, true])(
  "drops the dependency that exceeds the byte budget (relay CSP: %s)",
  async (relay) => {
    const view = runWorkspaceStylesheet(
      (url) =>
        url.endsWith("/main.css")
          ? ["text/css", 'body { background: url("large.png"), url("later.png"); }']
          : ["image/png", "x".repeat(8 * 1024 * 1024)],
      relay ? [verifiedDocumentCsp(workspaceIssuer)] : [],
    );
    const installed = await view.installed;
    expect(view.requests).toEqual([
      `${workspacePrefix}styles/main.css`,
      `${workspacePrefix}styles/large.png`,
    ]);
    const css = relay
      ? Array.from(view.inlineStyles, (style) => style.textContent).join("\n")
      : await view.blobs.get(installed)?.text();
    expect(css).toBe('body { background: url("data:,"), url("data:,"); }');
  },
);

it("installs guarded resource scripts before the document runs", () => {
  const issuer = "https://relay.test/api/assets/document.sig/page.html";
  for (const framed of [true, false]) {
    const bootstrap = verifiedWebResourceBootstrap(issuer, { assets: true, fetch: true, framed });
    expect(
      () => new NodeVM.Script(bootstrap.slice("<script>".length, -"</script>".length)),
    ).not.toThrow();
    expect(bootstrap).toContain("request.method!=='GET'");
    expect(bootstrap).toContain(
      framed ? "event.source===window.parent" : "window.ReactNativeWebView.postMessage",
    );
  }
  const document = isolatedWebDocument("<script>run()</script>", issuer);
  expect(document).toContain("connect-src 'none'");
  expect(document.indexOf("window.fetch")).toBeLessThan(document.indexOf("run()"));
});
