import type { McpServerId } from "@t3tools/contracts";

export const namespaceName = (id: McpServerId, name: string): string =>
  `mcp_${Buffer.from(id).toString("hex")}__${name}`;
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
