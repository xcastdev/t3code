// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pins the alias hash independently of the implementation.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { McpServerId } from "@t3tools/contracts";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import {
  catalogAlias,
  catalogAliases,
  namespaceResourceTemplate,
  denamespaceResourceUri,
  namespaceContentUris,
  namespaceResourceUri,
} from "./ProjectMcpBroker.ts";

it.each([
  "file:///{path}",
  "file:///{+path}",
  "https://example.test/items{?q,limit}",
  "file:///{path*}",
])("preserves RFC6570 expansion and encoded values for %s", (template) => {
  const id = McpServerId.make("server");
  const variables = { path: "a/b", q: "search & encoded", limit: "10" };
  const upstream = new UriTemplate(template);
  const exposed = new UriTemplate(namespaceResourceTemplate(id, template));
  expect(exposed.variableNames).toEqual(upstream.variableNames);
  expect(denamespaceResourceUri(id, exposed.expand(variables))).toBe(upstream.expand(variables));
});
it("rewrites text and blob resource contents without optional MIME types, including embedded content", () => {
  const id = McpServerId.make("server");
  expect(
    namespaceContentUris(id, {
      contents: [
        { uri: "file:///text", text: "hello" },
        { uri: "file:///blob", blob: "AA==" },
      ],
      content: [{ type: "resource", resource: { uri: "file:///embedded", text: "hello" } }],
    }),
  ).toEqual({
    contents: [
      { uri: namespaceResourceUri(id, "file:///text"), text: "hello" },
      { uri: namespaceResourceUri(id, "file:///blob"), blob: "AA==" },
    ],
    content: [
      {
        type: "resource",
        resource: { uri: namespaceResourceUri(id, "file:///embedded"), text: "hello" },
      },
    ],
  });
});

it.each([
  ["Browser MCP", "browser_mcp"],
  ["browser-mcp", "browser_mcp"],
  ["Café", "cafe"],
  ["  __Übersicht -- Server__ ", "ubersicht_server"],
  ["!!!", ""],
  ["Plugin Echo", "mcp_plugin_echo"],
  ["An extremely long server name that goes on", "an_extremely_long_server_name_th"],
  ["abcdefghijklmnopqrstuvwxyz abcdef ghi", "abcdefghijklmnopqrstuvwxyz_abcde"],
  ["abcdefghijklmnopqrstuvwxyz abcd ghi", "abcdefghijklmnopqrstuvwxyz_abcd"],
])("aliases %j as %j", (name, alias) => {
  expect(catalogAlias(name)).toBe(alias);
});
const aliasEntry = (id: string, name: string) => ({ logicalServerId: McpServerId.make(id), name });
const hashed = (base: string, id: string) =>
  `${base}_${NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 6)}`;
it("suffixes every colliding server with its id hash, independent of input order", () => {
  const entries = [aliasEntry("b", "Docs."), aliasEntry("a", "Docs"), aliasEntry("c", "Search")];
  const expected = new Map([
    ["a", hashed("docs", "a")],
    ["b", hashed("docs", "b")],
    ["c", "search"],
  ]);
  expect(catalogAliases(entries)).toEqual(expected);
  expect(catalogAliases(entries.toReversed())).toEqual(expected);
  expect(catalogAliases([aliasEntry("x", "!!!")])).toEqual(new Map([["x", hashed("mcp", "x")]]));
});
it("never lets a name from one catalog revision resolve to another server in the next", () => {
  // "Docs" stays throughout; colliding and symbol-only servers come and go around it.
  const revisions = [
    [aliasEntry("a", "Docs")],
    [aliasEntry("a", "Docs"), aliasEntry("b", "Docs.")],
    [
      aliasEntry("a", "Docs"),
      aliasEntry("b", "Docs."),
      aliasEntry("c", "docs!"),
      aliasEntry("d", "?"),
    ],
    [aliasEntry("a", "Docs"), aliasEntry("c", "docs!"), aliasEntry("d", "?"), aliasEntry("e", "*")],
    [aliasEntry("a", "Docs"), aliasEntry("d", "?")],
  ].map((entries) => new Map([...catalogAliases(entries)].map(([id, alias]) => [alias, id])));
  for (const before of revisions)
    for (const after of revisions)
      for (const [alias, id] of before) if (after.has(alias)) expect(after.get(alias)).toBe(id);
});
