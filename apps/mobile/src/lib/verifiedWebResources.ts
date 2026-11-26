import { useLayoutEffect, useRef, type RefObject } from "react";
import type { WebView } from "react-native-webview";

import { verifiedRouteFor } from "../connection/verified-route";
import { requestVerifiedRoute } from "../native/verifiedNetwork";

const signedAssetPath = /^(\/api\/assets\/[\w-]+\.[\w-]+\/)(.+)$/;
// Match the directory grant's preview allowlist in AssetAccess.
const previewDependency =
  /\.(?:avif|gif|ico|jpe?g|png|svg|webp|m4v|mp4|ogv|webm|aac|flac|m4a|mp3|oga|ogg|opus|wav|css|m?js|otf|ttf|woff2?|html?|pdf)$/i;

export function verifiedDocumentResourceUrl(
  issuer: string,
  reference: string,
  workspaceHtml = false,
  stylesheet?: string,
): string | null {
  try {
    const document = new URL(issuer);
    const documentPrefix = signedAssetPath.exec(document.pathname)?.[1];
    const base =
      stylesheet === undefined
        ? document
        : workspaceHtml && verifiedDocumentResourceUrl(issuer, stylesheet, true);
    if (!base || document.protocol !== "https:" || document.username || document.password) {
      return null;
    }
    const url = new URL(reference, base);
    const asset = signedAssetPath.exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      url.origin !== document.origin ||
      url.username ||
      url.password ||
      !asset
    )
      return null;
    const [, prefix, suffix] = asset;
    if (!prefix || !suffix) return null;
    const segments = suffix.split("/").map(decodeURIComponent);
    if (segments.some((segment) => !segment || /[/\\\x00-\x1f\x7f]/.test(segment))) {
      return null;
    }
    if (workspaceHtml && documentPrefix) {
      const rawPath = reference.trim().split(/[?#]/, 1)[0] ?? "";
      const relative = !/^(?:\/|[a-z][a-z\d+.-]*:)/i.test(rawPath);
      const basePath = typeof base === "string" ? new URL(base).pathname : base.pathname;
      if (relative && prefix !== signedAssetPath.exec(basePath)?.[1]) return null;
      let depth = relative ? basePath.slice(prefix.length).split("/").length - 1 : 0;
      for (const segment of rawPath.split("/")) {
        const decoded = decodeURIComponent(segment);
        if (/[/\\\x00-\x1f\x7f]/.test(decoded)) return null;
        if (decoded === ".." && (!relative || segment !== decoded || --depth < 0)) return null;
        if (decoded === "." && segment !== decoded) return null;
        if (decoded && decoded !== "." && decoded !== "..") depth++;
      }
      if (prefix === documentPrefix) {
        if (
          segments.some((segment) => segment.startsWith(".")) ||
          !previewDependency.test(segments.at(-1) ?? "")
        ) {
          return null;
        }
      } else if (segments.length !== 1) {
        return null;
      }
    } else if (
      segments.length !== 1 ||
      (prefix === documentPrefix && url.pathname !== document.pathname)
    ) {
      return null;
    }
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export interface VerifiedWebResourceAccess {
  readonly assets: boolean;
  readonly fetch: boolean;
  readonly framed?: boolean;
  readonly workspaceHtml?: boolean;
}

export const signedDocumentResources: VerifiedWebResourceAccess = { assets: true, fetch: true };
export const workspaceHtmlResources: VerifiedWebResourceAccess = {
  ...signedDocumentResources,
  workspaceHtml: true,
};

export function createVerifiedWebResourceScope(
  issuer: string,
  inject: (script: string) => void,
  access: VerifiedWebResourceAccess = signedDocumentResources,
) {
  const binding = verifiedRouteFor(issuer);
  const requests = new Map<number, AbortController>();
  let stopped = false;
  const reply = (id: number, value: object | null) => {
    if (stopped) return;
    const script = access.framed
      ? `window.__t3McpAppReceive?.(${JSON.stringify({ t3VerifiedResourceReply: id, value })});true;`
      : `window.__t3VerifiedResource?.(${id},${JSON.stringify(value)});true;`;
    inject(script);
  };
  return {
    receive(message: unknown) {
      if (typeof message !== "object" || message === null || !("t3VerifiedResource" in message)) {
        return false;
      }
      if (stopped) return true;
      const {
        t3VerifiedResource: operation,
        id,
        reference,
        stylesheet,
      } = message as Record<string, unknown>;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return true;
      if (operation === "cancel") {
        requests.get(id)?.abort();
        return true;
      }
      if (requests.has(id)) return true;
      const enabled =
        (operation === "read" && access.fetch) || (operation === "load" && access.assets);
      const url =
        enabled &&
        typeof reference === "string" &&
        (stylesheet === undefined || (operation === "load" && typeof stylesheet === "string")) &&
        verifiedDocumentResourceUrl(issuer, reference, access.workspaceHtml, stylesheet);
      if (!url || !binding || verifiedRouteFor(url) !== binding || requests.size >= 8) {
        reply(id, null);
        return true;
      }
      const request = new AbortController();
      requests.set(id, request);
      void requestVerifiedRoute(url, {
        method: "GET",
        requireVerified: true,
        signal: request.signal,
      })
        .then((response) => {
          if (request.signal.aborted) return;
          if (!response || (response.status >= 300 && response.status < 400)) {
            reply(id, null);
            return;
          }
          const type = new Headers(response.headers).get("content-type");
          reply(id, { status: response.status, type, body: response.bodyBase64 });
        })
        .catch(() => {
          if (!request.signal.aborted) reply(id, null);
        })
        .finally(() => requests.delete(id));
      return true;
    },
    stop() {
      stopped = true;
      for (const request of requests.values()) request.abort();
      requests.clear();
    },
  };
}

export function useVerifiedWebResources(
  issuer: string | null,
  view: RefObject<WebView<object> | null>,
  generation = 0,
  access = signedDocumentResources,
) {
  const { assets, fetch, framed, workspaceHtml } = access;
  const scope = useRef<{
    readonly generation: number;
    readonly active: ReturnType<typeof createVerifiedWebResourceScope>;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A resource request must stop when its WebView unmounts or is replaced.
  useLayoutEffect(() => {
    if (!issuer) return;
    const activeView = view.current;
    const active = createVerifiedWebResourceScope(
      issuer,
      (script) => activeView?.injectJavaScript(script),
      { assets, fetch, framed, workspaceHtml },
    );
    scope.current = { generation, active };
    return () => {
      active.stop();
      scope.current = null;
    };
  }, [issuer, view, generation, assets, fetch, framed, workspaceHtml]);
  return (data: unknown) => {
    if (scope.current?.generation !== generation) return false;
    if (typeof data !== "string") return scope.current.active.receive(data);
    if (!data.startsWith('{"t3VerifiedResource":')) return false;
    try {
      return scope.current.active.receive(JSON.parse(data));
    } catch {
      return true;
    }
  };
}

export const RESOURCE_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' blob:; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

const workspaceStylesheetBootstrap = String.raw`
const cssType=/^text\/css$/i;
const cssFontType=/^(?:font\/[a-z\d.+-]+|application\/(?:font-woff|vnd\.ms-fontobject))$/i;
const cssAssetType=/^(?:image\/|font\/|application\/(?:font-woff|vnd\.ms-fontobject)$)/i;
const cssEscape=/\\(?:[a-f\d]{1,6}(?:\r\n|[ \t\r\n\f])?|\r\n|[\s\S])/gi;
const cssComment=/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//.source;
const cssTrivia='(?:'+cssComment+'|[ \\t\\r\\n\\f])*';
const cssString='"(?:'+cssEscape.source+'|[^"\\\\])*"|\'(?:'+cssEscape.source+'|[^\'\\\\])*\'';
const cssUrl='url\\('+cssTrivia+'('+cssString+'|(?:'+cssEscape.source+'|[^\\s"\'()\\\\])*?)'+cssTrivia+'\\)';
const cssTokens=new RegExp(
  '(@import'+cssTrivia+')(?:('+cssString+')|'+cssUrl+')|'+
  cssUrl+'|'+cssComment+'|'+cssString+'|(?:'+cssEscape.source+'|[\\w\\u0080-\\uffff-])+',
  'gi',
);
const cssBareImport=cssTrivia+'@import(?![\\w\\u0080-\\uffff\\\\-])'+cssTrivia+
  '(?:('+cssString+')|'+cssUrl+')'+cssTrivia+'(?:;|$)';
function cssReference(value) {
  if(value.startsWith('"') || value.startsWith("'")) value=value.slice(1,-1);
  return value.replace(cssEscape,escape=>{
    const hex=/^\\([a-f\d]{1,6})/i.exec(escape);
    if(hex) {
      const point=parseInt(hex[1],16);
      return String.fromCodePoint(point===0 || point>0x10ffff || (point>=0xd800 && point<=0xdfff)?0xfffd:point);
    }
    return /^\\[\r\n\f]/.test(escape)?'':escape.slice(1);
  });
}
async function stylesheetContent(response,url,request) {
  const budget=request.budget;
  const sheets=[];
  async function rewrite(response,base,ancestors) {
    let css=await response.text();
    if(inlineStylesheets) {
      // Only lift a leading run of bare imports. Let CSP block the remaining import rules.
      const imports=new RegExp(cssBareImport,'iy');
      let start=/^@charset "[^"\\\r\n\f]+";/.exec(css)?.[0].length ?? 0;
      imports.lastIndex=start;
      for(let match; (match=imports.exec(css));) {
        start=imports.lastIndex;
        await resolve(cssReference(match[1] ?? match[2]),base,ancestors,true);
      }
      css=css.slice(start);
    }
    const pieces=[];
    let cursor=0;
    for(const match of css.matchAll(cssTokens)) {
      const [token,importPrefix,importString,importUrl,assetUrl]=match;
      const encoded=importString ?? importUrl ?? assetUrl;
      if(encoded===undefined || (inlineStylesheets && importPrefix)) continue;
      const reference=cssReference(encoded);
      if(!importPrefix && /^(?:data:|#)/i.test(reference)) continue;
      if(request.abort.signal.aborted) throw request.abort.signal.reason;
      const objectUrl=await resolve(reference,base,ancestors,Boolean(importPrefix));
      pieces.push(css.slice(cursor,match.index),importPrefix ?? '', 'url('+JSON.stringify(objectUrl)+')');
      cursor=match.index+token.length;
    }
    pieces.push(css.slice(cursor));
    return pieces.join('');
  }
  async function resolve(reference,base,ancestors,isImport) {
    const unavailable='data:,';
    if(!reference || budget.reads>=32 || budget.bytes<=0 || (isImport && ancestors.length>=5)) return unavailable;
    try {
      const url=new URL(reference,base);
      const hash=url.hash;
      url.hash='';
      if(url.origin!==base.origin || ancestors.includes(url.href)) return unavailable;
      budget.reads++;
      const response=await read('load',reference,request.abort.signal,base.href,budget);
      const type=response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if(!response.ok || !(isImport?cssType:cssAssetType).test(type)) return unavailable;
      let blob;
      if(isImport) {
        const css=await rewrite(response,url,[...ancestors,url.href]);
        if(inlineStylesheets) {
          // Separate style elements keep each imported sheet's namespace and parse scope.
          sheets.push(css);
          return unavailable;
        }
        blob=new Blob([css],{type:'text/css'});
      } else if(inlineStylesheets && cssFontType.test(type)) {
        const bytes=new Uint8Array(await response.arrayBuffer());
        const encoded=[];
        for(let i=0;i<bytes.length;i+=0x6000) {
          encoded.push(btoa(String.fromCharCode(...bytes.subarray(i,i+0x6000))));
        }
        return 'data:'+type+';base64,'+encoded.join('')+hash;
      } else {
        if(inlineStylesheets && !/^image\//i.test(type)) return unavailable;
        blob=await response.blob();
      }
      if(request.abort.signal.aborted) return unavailable;
      const local=URL.createObjectURL(blob);
      request.dependencies.push(local);
      return local+hash;
    } catch {
      return unavailable;
    }
  }
  const base=new URL(url);
  base.hash='';
  const css=await rewrite(response,base,[base.href]);
  return inlineStylesheets ? [...sheets,css] : new Blob([css],{type:'text/css'});
}
`;

export function verifiedWebResourceBootstrap(
  issuer: string,
  access: VerifiedWebResourceAccess,
  useInlineStylesheets = false,
): string {
  const base = JSON.stringify(issuer).replace(/</g, "\\u003c");
  return `<script>(function(){
const issuer=${base}, pending=new Map(), queued=new Map(), hydrated=new WeakMap();
let sequence=0;
const post=(operation,id,reference,stylesheet)=>{
  const message={t3VerifiedResource:operation,id,reference,stylesheet};
  ${access.framed ? 'window.parent.postMessage(message,"*");' : "window.ReactNativeWebView.postMessage(JSON.stringify(message));"}
};
const receive=(id,value)=>{
  const receive=pending.get(id);
  if(receive) receive(value);
};
${
  access.framed
    ? `window.addEventListener('message',event=>{
    if(event.source===window.parent && event.data?.t3VerifiedResourceReply) {
      receive(event.data.t3VerifiedResourceReply,event.data.value);
    }
  });`
    : "window.__t3VerifiedResource=receive;"
}
function pump() {
  for(const [id,start] of queued) {
    if(pending.size>=6) break;
    queued.delete(id);
    start();
  }
}
function read(operation,reference,signal,stylesheet,budget) {
  const id=++sequence;
  return new Promise((resolve,reject)=>{
    if(signal?.aborted) {reject(signal.reason);return;}
    const clear=()=>{
      queued.delete(id);
      pending.delete(id);
      signal?.removeEventListener('abort',abort);
      pump();
    };
    const abort=()=>{
      if(pending.has(id)) post('cancel',id);
      clear();
      reject(signal.reason);
    };
    queued.set(id,()=>{
      pending.set(id,value=>{
        clear();
        if(!value) {reject(new TypeError('Verified resource request failed.'));return;}
        if(budget) {
          const padding=value.body.endsWith('==')?2:value.body.endsWith('=')?1:0;
          budget.bytes-=value.body.length*3/4-padding;
          if(budget.bytes<0) {reject(new TypeError('Verified stylesheet exceeds the byte limit.'));return;}
        }
        try {
          const binary=atob(value.body);
          const bytes=new Uint8Array(binary.length);
          for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
          resolve(new Response([204,205].includes(value.status)?null:bytes,{
            status:value.status,headers:value.type?{'content-type':value.type}:{}
          }));
        } catch(error) {
          reject(error);
        }
      });
      post(operation,id,reference,stylesheet);
    });
    signal?.addEventListener('abort',abort,{once:true});
    pump();
  });
}
${
  access.fetch
    ? `window.fetch=async (input,options)=>{
  const request=new Request(input instanceof Request ? input : new URL(input,issuer),options);
  if(request.method!=='GET') throw new TypeError('Verified document requests are read-only.');
  return read('read',input instanceof Request ? request.url : String(input),request.signal);
};`
    : ""
}
${
  access.assets
    ? `const inlineStylesheets=${Boolean(access.workspaceHtml && useInlineStylesheets)};
${access.workspaceHtml ? workspaceStylesheetBootstrap : ""}
function placeStyles(link,styles) {
  for(const style of styles) {
    style.media=link.disabled ? 'not all' : link.media;
    style.title=link.title;
  }
  if(link.nextSibling!==styles[0]) link.after(...styles);
}
function dispose(request) {
  request.abort.abort();
  if(request.blob) URL.revokeObjectURL(request.blob);
  request.styles?.forEach(style=>style.remove());
  for(const url of request.dependencies) URL.revokeObjectURL(url);
  request.dependencies.length=0;
}
function hydrate(element,attribute,types) {
  const raw=element.getAttribute(attribute);
  let state=hydrated.get(element);
  const previous=state?.get(attribute);
  if(previous && (previous.raw===raw || previous.installed===raw)) {
    if(previous.styles) placeStyles(element,previous.styles);
    return;
  }
  if(previous) {
    dispose(previous);
    state.delete(attribute);
  }
  if(!raw || !/^(?:https:|[^:]+$)/i.test(raw) || raw.startsWith('#')) return;
  let url;
  try {url=new URL(raw,issuer);} catch {return;}
  if(url.origin!==new URL(issuer).origin) return;
  if(!state) {state=new Map();hydrated.set(element,state);}
  const budget=${access.workspaceHtml ? "element.tagName==='LINK' ? { reads:1,bytes:8*1024*1024 } : undefined" : "undefined"};
  const request={raw,abort:new AbortController(),dependencies:[],budget};
  state.set(attribute,request);
  read('load',raw,request.abort.signal,undefined,budget).then(async response=>{
    const type=response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if(!response.ok || !types.test(type)) return;
    const content=await ${
      access.workspaceHtml
        ? "(element.tagName==='LINK' ? stylesheetContent(response,url,request) : response.blob())"
        : "response.blob()"
    };
    if(request.abort.signal.aborted || state.get(attribute)!==request || !element.isConnected || element.getAttribute(attribute)!==raw) {
      dispose(request);
      return;
    }
    if(Array.isArray(content)) {
      request.styles=content.map(css=>{
        const style=document.createElement('style');
        style.textContent=css;
        return style;
      });
      placeStyles(element,request.styles);
      return;
    }
    request.blob=URL.createObjectURL(content);
    request.installed=request.blob+url.hash;
    element.setAttribute(attribute,request.installed);
    if(element.tagName==='SOURCE') element.parentElement?.load?.();
  }).catch(()=>dispose(request));
}
const selector='img, video, audio, source, link';
function visit(root,action) {
  if(root.matches?.(selector)) action(root);
  root.querySelectorAll?.(selector).forEach(action);
}
function unload(element) {
  const state=hydrated.get(element);
  if(!state) return;
  for(const request of state.values()) dispose(request);
  hydrated.delete(element);
}
function load(element) {
  switch(element.tagName) {
    case 'IMG': hydrate(element,'src',/^image\\//i); break;
    case 'VIDEO': hydrate(element,'poster',/^image\\//i);
    case 'AUDIO': hydrate(element,'src',/^(?:audio|video)\\//i); break;
    case 'SOURCE': hydrate(element,'src',/^(?:image|audio|video)\\//i); break;
    case 'LINK':
      if(element.relList.contains('stylesheet') &&
        !(inlineStylesheets && (element.relList.contains('alternate') || element.integrity ||
          (element.type && element.type.toLowerCase()!=='text/css')))) {
        hydrate(element,'href',/^text\\/css$/i);
      }
      else unload(element);
      break;
  }
}
new MutationObserver(records=>{
  for(const record of records) {
    if(record.type==='attributes' && record.target.matches(selector)) load(record.target);
    for(const node of record.removedNodes) visit(node,element=>{if(!element.isConnected) unload(element);});
    for(const node of record.addedNodes) visit(node,element=>{if(element.isConnected) load(element);});
  }
}).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['src','poster','href','rel'${
        access.workspaceHtml && useInlineStylesheets
          ? ",'disabled','media','title','integrity','type'"
          : ""
      }]});
visit(document,load);`
    : ""
}
})();</script>`;
}
