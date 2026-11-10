export interface CallerContext {
  readonly threadId: string | null;
  readonly projectId: string | null;
  readonly parentThreadId: string | null;
  readonly rootThreadId: string | null;
}

export interface ProxyLink {
  readonly kind: "thread" | "project";
  readonly id: string;
  readonly proxyId: string;
  readonly linkedAt: number;
}

export interface ProxyRef {
  readonly id: string;
  readonly deletedAt?: number | null | undefined;
}

export type CallerLink = "thread" | "project" | "parentThread" | "rootThread";

export interface ProxyCandidate {
  readonly proxyId: string;
  readonly link: "parentThread" | "rootThread" | null;
}

export type ProxyResolution =
  | { readonly proxyId: string; readonly via: "explicit" | "thread" | "project" }
  | { readonly refusal: "not-found"; readonly proxyId: string }
  | { readonly refusal: "no-default-proxy"; readonly candidates: ReadonlyArray<ProxyCandidate> };

export interface ResolveProxyInput {
  readonly explicit?: string | null | undefined;
  readonly links: ReadonlyArray<ProxyLink>;
  readonly context: CallerContext;
  /** Every proxy, in display order. Deleted ones may still be named explicitly. */
  readonly proxies: ReadonlyArray<ProxyRef>;
}

function linkedProxy(
  links: ReadonlyArray<ProxyLink>,
  live: ReadonlySet<string>,
  kind: ProxyLink["kind"],
  id: string | null,
) {
  if (id === null) return undefined;
  let newest: ProxyLink | undefined;
  for (const link of links) {
    if (link.kind !== kind || link.id !== id || !live.has(link.proxyId)) continue;
    // Ties go to the later entry: the store lists links oldest first.
    if (newest === undefined || link.linkedAt >= newest.linkedAt) newest = link;
  }
  return newest?.proxyId;
}

const liveIds = (proxies: ReadonlyArray<ProxyRef>) =>
  new Set(proxies.filter((proxy) => proxy.deletedAt == null).map((proxy) => proxy.id));

/**
 * D15: explicit id, then the caller thread's most recently linked live proxy, then the caller
 * project's. A target may link several proxies; the newest link is its default.
 */
export function resolveProxy(input: ResolveProxyInput): ProxyResolution {
  const { explicit, links, context, proxies } = input;
  if (explicit != null) {
    return proxies.some((proxy) => proxy.id === explicit)
      ? { proxyId: explicit, via: "explicit" }
      : { refusal: "not-found", proxyId: explicit };
  }
  const live = liveIds(proxies);
  const thread = linkedProxy(links, live, "thread", context.threadId);
  if (thread !== undefined) return { proxyId: thread, via: "thread" };
  const project = linkedProxy(links, live, "project", context.projectId);
  if (project !== undefined) return { proxyId: project, via: "project" };

  const ranked: ProxyCandidate[] = [];
  const add = (proxyId: string | undefined, link: ProxyCandidate["link"]) => {
    if (proxyId !== undefined && !ranked.some((candidate) => candidate.proxyId === proxyId))
      ranked.push({ proxyId, link });
  };
  add(linkedProxy(links, live, "thread", context.parentThreadId), "parentThread");
  add(linkedProxy(links, live, "thread", context.rootThreadId), "rootThread");
  for (const id of live) add(id, null);
  return { refusal: "no-default-proxy", candidates: ranked };
}

/** How the caller reaches `proxyId` through a link, nearest first. */
export function callerLink(
  proxyId: string,
  links: ReadonlyArray<ProxyLink>,
  context: CallerContext,
): CallerLink | null {
  const linked = (kind: ProxyLink["kind"], id: string | null) =>
    id !== null &&
    links.some((link) => link.kind === kind && link.id === id && link.proxyId === proxyId);
  if (linked("thread", context.threadId)) return "thread";
  if (linked("project", context.projectId)) return "project";
  if (linked("thread", context.parentThreadId)) return "parentThread";
  if (linked("thread", context.rootThreadId)) return "rootThread";
  return null;
}
