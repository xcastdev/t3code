import { useAtomValue } from "@effect/atom-react";
import { verifiedDocumentCsp } from "@t3tools/shared/verifiedDocumentCsp";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { verificationRequiredFor } from "../connection/verified-route";
import { bytesFromBase64, requestVerifiedRoute } from "../native/verifiedNetwork";
import {
  RESOURCE_POLICY,
  signedDocumentResources,
  verifiedWebResourceBootstrap,
  type VerifiedWebResourceAccess,
} from "./verifiedWebResources";

const DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

const headerOnlyDirective = /(?:^|;)\s*(?:frame-ancestors|sandbox|report-uri)(?=\s|;|$)/i;
const originRelativeSource = /\s'self'(?=\s|;|$)/i;
const serverSandboxTokens = "allow-scripts allow-forms allow-popups allow-downloads";
const serverSandboxDirective = `sandbox ${serverSandboxTokens}`;
const scriptsDisabledPolicy = "script-src 'none'";

export function isolatedWebDocument(
  html: string,
  resourceIssuer?: string,
  access = signedDocumentResources,
  issuerPolicies: readonly string[] = [],
  script = "",
): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const start = doctype ? doctype[0].length : 0;
  const policy = resourceIssuer ? RESOURCE_POLICY : DOCUMENT_CSP;
  const meta = [policy, ...issuerPolicies]
    .map(
      (policy) =>
        `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}">`,
    )
    .join("");
  const inlineStylesheets =
    !!resourceIssuer &&
    access.workspaceHtml === true &&
    issuerPolicies.length > 0 &&
    issuerPolicies.every((policy) => policy === verifiedDocumentCsp(resourceIssuer));
  const bootstrap = resourceIssuer
    ? verifiedWebResourceBootstrap(resourceIssuer, access, inlineStylesheets)
    : "";
  return `<!doctype html>${meta}${bootstrap}${script}${html.slice(start)}`;
}

const scriptLiteral = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");
const htmlAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

export function framedWebDocument(
  document: { readonly uri: string } | { readonly html: string; readonly sandbox?: string },
  allow: string,
  secret: string,
): string {
  const load =
    "html" in document
      ? `frame.srcdoc=${scriptLiteral(document.html)};`
      : `frame.src=${scriptLiteral(document.uri)};`;
  const sandbox = "html" in document ? document.sandbox : undefined;
  // Android exposes ReactNativeWebView in subframes. Only the outer page holds the relay secret.
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head>
<body><iframe id="app" sandbox="${htmlAttribute(sandbox ?? "allow-scripts allow-forms")}" allow="${htmlAttribute(allow)}"></iframe>
<script>(function(){var frame=document.getElementById("app"),secret=${scriptLiteral(secret)},loads=0,live=true;
var send=function(m){var u=navigator.userActivation;window.ReactNativeWebView.postMessage(JSON.stringify({secret:secret,active:!!(u&&u.isActive)&&document.activeElement===frame,message:m}));};
frame.addEventListener("load",function(){loads+=1;if(loads>1&&live){live=false;send({t3:"navigated"});}});
window.addEventListener("message",function(e){if(live&&e.source===frame.contentWindow)send(e.data);});
window.__t3McpAppReceive=function(m){live&&frame.contentWindow&&frame.contentWindow.postMessage(m,"*");};
${load}})();</script></body></html>`;
}

export function readFramedWebMessage(data: string, secret: string) {
  try {
    const envelope: unknown = JSON.parse(data);
    if (
      typeof envelope === "object" &&
      envelope !== null &&
      "secret" in envelope &&
      envelope.secret === secret &&
      "message" in envelope
    ) {
      return {
        message: envelope.message,
        active: "active" in envelope && envelope.active === true,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function isIsolatedDocumentNavigation(url: string): boolean {
  return url === "about:blank" || url === "about:srcdoc";
}

class VerifiedWebDocumentError extends Schema.TaggedError<VerifiedWebDocumentError>()(
  "VerifiedWebDocumentError",
  { cause: Schema.Defect() },
) {}

const noDocument = Atom.make(AsyncResult.initial<never, VerifiedWebDocumentError>());
const documentForUrl = Atom.family((url: string) =>
  Atom.make(
    Effect.tryPromise({
      try: async (signal) => {
        const endpoint = new URL(url);
        endpoint.hash = "";
        const result = await requestVerifiedRoute(endpoint.toString(), {
          requireVerified: true,
          signal,
        });
        if (result === null || result.status < 200 || result.status >= 300) {
          throw new Error("Could not read the verified document.");
        }
        const headers = new Headers(result.headers);
        const type = headers.get("content-type")?.split(";", 1)[0]?.trim();
        if (type === "image/svg+xml") {
          return {
            html: `<img alt="" style="max-width:100%" src="data:image/svg+xml;base64,${result.bodyBase64}">`,
            policies: [],
          };
        }
        if (type !== "text/html" && type !== "application/xhtml+xml") {
          throw new Error("Unexpected verified document type.");
        }
        const policyHeader = Object.entries(result.headers)
          .filter(([name]) => name.toLowerCase() === "content-security-policy")
          .map(([, value]) => value)
          .join(",");
        // Reject values whose quoting or whitespace could change meaning during reconstruction.
        if (/[^\t\x20-\x7e]|"/.test(policyHeader)) {
          throw new Error("Unexpected verified document policy.");
        }
        const policies = policyHeader
          .split(",")
          .map((policy) => policy.trim())
          .filter(Boolean);
        return { html: new TextDecoder().decode(bytesFromBase64(result.bodyBase64)), policies };
      },
      catch: (cause) => new VerifiedWebDocumentError({ cause }),
    }),
  ),
);

export function useVerifiedWebDocument(
  url: string | null,
  resourceAccess?: VerifiedWebResourceAccess,
  framedScript = "",
) {
  const verified = url !== null && verificationRequiredFor(url);
  const result = useAtomValue(verified ? documentForUrl(url) : noDocument);
  if (!verified) return { kind: "direct", url } as const;
  if (AsyncResult.isFailure(result)) return { kind: "failed" } as const;
  if (!AsyncResult.isSuccess(result)) return { kind: "loading" } as const;
  const { html, policies } = result.value;
  const metaPolicies: string[] = [];
  let sandbox: string | undefined;
  for (const policy of policies) {
    const separator = policy.indexOf(";");
    const firstDirective = separator === -1 ? policy : policy.slice(0, separator).trimEnd();
    if (firstDirective === serverSandboxDirective) {
      sandbox = serverSandboxTokens;
      const remainder = separator === -1 ? "" : policy.slice(separator + 1).trim();
      if (remainder) metaPolicies.push(remainder);
    } else {
      metaPolicies.push(policy);
    }
  }
  const scriptsDisabled = sandbox !== undefined && metaPolicies.includes(scriptsDisabledPolicy);
  // Native reads cannot enforce a policy supplied by the document itself.
  const documentPolicy = /\bhttp-equiv\b/i.test(html);
  const access =
    scriptsDisabled || documentPolicy || !resourceAccess
      ? undefined
      : sandbox === undefined || resourceAccess.framed
        ? resourceAccess
        : { ...resourceAccess, framed: true };
  const relayPolicy = access && metaPolicies.length > 0 ? verifiedDocumentCsp(url) : undefined;
  // Signed bridge reads fit the relay policy. Other restrictions must be enforced by the document.
  if (
    metaPolicies.some(
      (policy) =>
        headerOnlyDirective.test(policy) ||
        originRelativeSource.test(policy) ||
        (relayPolicy !== undefined && policy !== relayPolicy),
    )
  ) {
    return { kind: "failed" } as const;
  }
  return {
    kind: "local",
    sandbox,
    resourceAccess: access,
    html: isolatedWebDocument(
      html,
      access ? url : undefined,
      access,
      metaPolicies,
      sandbox !== undefined && !scriptsDisabled ? framedScript : "",
    ),
  } as const;
}
