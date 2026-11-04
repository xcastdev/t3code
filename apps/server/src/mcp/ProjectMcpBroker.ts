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

/**
 * Readable aliases for one catalog. Servers whose names fold to the same alias all carry an id
 * hash instead of an ordinal, so a name cached from an older revision can only fail, never reach
 * another server. An alias never contains `__` or ends in `_`, so the first `__` ends it.
 */
export const catalogAliases = (
  entries: ReadonlyArray<{ readonly logicalServerId: McpServerId; readonly name: string }>,
): ReadonlyMap<McpServerId, string> => {
  const groups = new Map<string, McpServerId[]>();
  for (const entry of entries) {
    const base = catalogAlias(entry.name);
    groups.set(base, [...(groups.get(base) ?? []), entry.logicalServerId]);
  }
  const aliases = new Map<McpServerId, string>();
  const used = new Set<string>();
  for (const [base, ids] of groups)
    if (base !== "" && ids.length === 1) {
      aliases.set(ids[0]!, base);
      used.add(base);
    }
  for (const [base, ids] of [...groups].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (base !== "" && ids.length === 1) continue;
    const hashes = ids.map(idHash);
    const named = (length: number) =>
      hashes.map((hash) => `${base === "" ? "mcp" : base}_${hash.slice(0, length)}`);
    let length = 6;
    let names = named(length);
    while (
      length < 64 &&
      (new Set(names).size !== names.length || names.some((name) => used.has(name)))
    )
      names = named(++length);
    ids.forEach((id, index) => {
      aliases.set(id, names[index]!);
      used.add(names[index]!);
    });
  }
  return aliases;
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
