import * as Predicate from "effect/Predicate";

export type PluginPanelDocument =
  | { readonly kind: "src"; readonly url: string }
  | { readonly kind: "srcdoc"; readonly html: string };

// Panels reach the host only through the bridge; a panel's own CSP can tighten this, not widen it.
const PANEL_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'">`;

/** Client panels get the same policy the server injects into environment panels. */
function withPanelCsp(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype
    ? `${doctype[0]}${PANEL_CSP_META}${html.slice(doctype[0].length)}`
    : `<!doctype html>${PANEL_CSP_META}${html}`;
}

const scriptLiteral = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * Android exposes `ReactNativeWebView` to every frame, so the sandboxed panel could post to
 * React Native directly. This outer page wraps what it relays with a secret only it holds, and
 * attests activation, which the panel cannot set. The panel's `window.parent` is this page.
 */
export function pluginOuterDocument(document: PluginPanelDocument, secret: string): string {
  const load =
    document.kind === "src"
      ? `frame.src=${scriptLiteral(document.url)};`
      : `frame.srcdoc=${scriptLiteral(withPanelCsp(document.html))};`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head>
<body><iframe id="panel" sandbox="allow-scripts allow-forms"></iframe>
<script>(function(){var frame=document.getElementById("panel"),secret=${JSON.stringify(secret)},loads=0,live=true;
var post=function(e){window.ReactNativeWebView.postMessage(JSON.stringify(e));};
frame.addEventListener("load",function(){loads+=1;if(loads>1&&live){live=false;post({secret:secret,navigated:true});}});
window.addEventListener("message",function(e){if(!live||e.source!==frame.contentWindow)return;var u=navigator.userActivation;post({secret:secret,active:!!(u&&u.isActive)&&document.activeElement===frame,message:e.data});});
window.__t3PluginReceive=function(m){live&&frame.contentWindow&&frame.contentWindow.postMessage(m,"*");};
${load}})();</script></body></html>`;
}

export type PluginRelayMessage =
  | { readonly kind: "message"; readonly message: unknown; readonly active: boolean }
  | { readonly kind: "navigated" };

/** Accepts only envelopes the outer page wrapped with this view's secret. */
export function decodePluginRelayMessage(data: string, secret: string): PluginRelayMessage | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(data);
  } catch {
    return null;
  }
  if (!Predicate.isObject(envelope) || envelope.secret !== secret) return null;
  if (envelope.navigated === true) return { kind: "navigated" };
  if (!("message" in envelope)) return null;
  return { kind: "message", message: envelope.message, active: envelope.active === true };
}
