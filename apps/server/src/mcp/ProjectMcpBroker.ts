// @effect-diagnostics-next-line nodeBuiltinImport:off -- Alias suffixes are pure, synchronous hashes of server ids.
import * as NodeCrypto from "node:crypto";
import type { McpServerId } from "@t3tools/contracts";

const MAX_ALIAS_BASE_LENGTH = 32;
// `plugin_<id>__<op>` belongs to plugin tools, which the gateway resolves first.
export const catalogAlias = (name: string): string => {
  const folded = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const reserved = folded.startsWith("plugin_") ? `mcp_${folded}` : folded;
  return reserved.slice(0, MAX_ALIAS_BASE_LENGTH).replace(/_+$/, "");
};

const idHash = (id: McpServerId) => NodeCrypto.createHash("sha256").update(id).digest("hex");

export interface CatalogAliases {
  readonly byServer: ReadonlyMap<McpServerId, { readonly base: string; readonly alias: string }>;
  /** Every alias issued in this catalog session, mapped to the one server it may ever reach. */
  readonly issued: ReadonlyMap<string, McpServerId>;
}

/**
 * Readable aliases for one catalog revision, given the session's previous one. A server keeps its
 * alias while its name folds the same, and no alias is reissued to another server in the session,
 * so a cached name can only fail or reach its original server. `__` never appears in an alias.
 */
export const catalogAliases = (
  entries: ReadonlyArray<{ readonly logicalServerId: McpServerId; readonly name: string }>,
  previous?: CatalogAliases,
): CatalogAliases => {
  const issued = new Map(previous?.issued);
  const byServer = new Map<McpServerId, { readonly base: string; readonly alias: string }>();
  const used = new Set<string>();
  const free = (alias: string, id: McpServerId) =>
    !used.has(alias) && (issued.get(alias) ?? id) === id;
  const assign = (id: McpServerId, base: string, alias: string) => {
    byServer.set(id, { base, alias });
    issued.set(alias, id);
    used.add(alias);
  };
  const groups = new Map<string, McpServerId[]>();
  for (const entry of entries) {
    const base = catalogAlias(entry.name);
    const kept = previous?.byServer.get(entry.logicalServerId);
    if (kept?.base === base) assign(entry.logicalServerId, base, kept.alias);
    else groups.set(base, [...(groups.get(base) ?? []), entry.logicalServerId]);
  }
  const sorted = [...groups].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hashed: Array<readonly [string, McpServerId[]]> = [];
  for (const [base, ids] of sorted)
    if (base !== "" && ids.length === 1 && free(base, ids[0]!)) assign(ids[0]!, base, base);
    else hashed.push([base, ids]);
  for (const [base, ids] of hashed) {
    const hashes = ids.map(idHash);
    const named = (length: number) =>
      hashes.map((hash) => `${base === "" ? "mcp" : base}_${hash.slice(0, length)}`);
    let length = 6;
    let names = named(length);
    while (
      length < 64 &&
      (new Set(names).size !== names.length || names.some((name, i) => !free(name, ids[i]!)))
    )
      names = named(++length);
    ids.forEach((id, index) => assign(id, base, names[index]!));
  }
  return { byServer, issued };
};
export const namespaceName = (alias: string, name: string): string => `${alias}__${name}`;
export const splitNamespacedName = (
  name: string,
): { readonly alias: string; readonly name: string } | undefined => {
  const separator = name.indexOf("__");
  return separator > 0 && separator + 2 < name.length
    ? { alias: name.slice(0, separator), name: name.slice(separator + 2) }
    : undefined;
};
export const namespaceResourceUri = (id: McpServerId, uri: string): string =>
  `t3-mcp://${encodeURIComponent(id)}/${Buffer.from(uri).toString("base64url")}`;
export const namespaceResourceTemplate = (id: McpServerId, uri: string): string =>
  `t3-mcp://${encodeURIComponent(id)}/template/${uri}`;
export const denamespaceResourceUri = (id: McpServerId, uri: string): string | undefined => {
  const prefix = `t3-mcp://${encodeURIComponent(id)}/`;
  if (!uri.startsWith(prefix)) return undefined;
  const tail = uri.slice(prefix.length);
  try {
    return tail.startsWith("template/")
      ? tail.slice(9)
      : Buffer.from(tail, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
};
export const namespaceContentUris = (id: McpServerId, value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => namespaceContentUris(id, item));
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [
      key,
      key === "uri" &&
      typeof item === "string" &&
      (object.type === "resource" ||
        object.type === "resource_link" ||
        "mimeType" in object ||
        "text" in object ||
        "blob" in object)
        ? namespaceResourceUri(id, item)
        : namespaceContentUris(id, item),
    ]),
  );
};
