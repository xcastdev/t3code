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
const aliasesOf = (aliases: ReturnType<typeof catalogAliases>) =>
  new Map([...aliases.byServer].map(([id, { alias }]) => [id, alias]));
it("suffixes every colliding server with its id hash, independent of input order", () => {
  const entries = [aliasEntry("b", "Docs."), aliasEntry("a", "Docs"), aliasEntry("c", "Search")];
  const expected = new Map([
    ["a", hashed("docs", "a")],
    ["b", hashed("docs", "b")],
    ["c", "search"],
  ]);
  expect(aliasesOf(catalogAliases(entries))).toEqual(expected);
  expect(aliasesOf(catalogAliases(entries.toReversed()))).toEqual(expected);
  expect(aliasesOf(catalogAliases([aliasEntry("x", "!!!")]))).toEqual(
    new Map([["x", hashed("mcp", "x")]]),
  );
});
it.each([
  {
    name: "colliding and symbol-only servers come and go",
    revisions: [
      [aliasEntry("a", "Docs")],
      [aliasEntry("a", "Docs"), aliasEntry("b", "Docs.")],
      [
        aliasEntry("a", "Docs"),
        aliasEntry("b", "Docs."),
        aliasEntry("c", "docs!"),
        aliasEntry("d", "?"),
      ],
      [
        aliasEntry("a", "Docs"),
        aliasEntry("c", "docs!"),
        aliasEntry("d", "?"),
        aliasEntry("e", "*"),
      ],
      [aliasEntry("a", "Docs"), aliasEntry("d", "?")],
    ],
  },
  {
    name: "the bare holder is deleted after a collision",
    revisions: [
      [aliasEntry("a", "Docs")],
      [aliasEntry("a", "Docs"), aliasEntry("b", "Docs.")],
      [aliasEntry("b", "Docs.")],
      [aliasEntry("b", "Docs."), aliasEntry("a", "Docs")],
    ],
  },
  {
    name: "servers rename onto each other's former names",
    revisions: [
      [aliasEntry("a", "Docs"), aliasEntry("b", "Search")],
      [aliasEntry("a", "Search"), aliasEntry("b", "Docs")],
      [aliasEntry("a", "Docs"), aliasEntry("b", "Search")],
      [aliasEntry("a", "Docs")],
      [aliasEntry("a", "Docs"), aliasEntry("c", "Search")],
    ],
  },
])("never lets a cached name reach another server in the session when $name", ({ revisions }) => {
  const generations: Array<ReturnType<typeof catalogAliases>> = [];
  for (const entries of revisions) generations.push(catalogAliases(entries, generations.at(-1)));
  const byAlias = generations.map(
    (generation) => new Map([...generation.byServer].map(([id, { alias }]) => [alias, id])),
  );
  for (const before of byAlias)
    for (const after of byAlias)
      for (const [alias, id] of before) if (after.has(alias)) expect(after.get(alias)).toBe(id);
});
it("keeps a surviving server's alias and gives the bare name back to its original server", () => {
  const first = catalogAliases([aliasEntry("a", "Docs")]);
  const second = catalogAliases([aliasEntry("a", "Docs"), aliasEntry("b", "Docs.")], first);
  expect(aliasesOf(second)).toEqual(
    new Map([
      ["a", "docs"],
      ["b", hashed("docs", "b")],
    ]),
  );
  const third = catalogAliases([aliasEntry("b", "Docs.")], second);
  expect(aliasesOf(third)).toEqual(new Map([["b", hashed("docs", "b")]]));
  const renamed = catalogAliases([aliasEntry("b", "Search")], third);
  expect(
    aliasesOf(catalogAliases([aliasEntry("b", "Search"), aliasEntry("a", "Docs")], renamed)),
  ).toEqual(
    new Map([
      ["b", "search"],
      ["a", "docs"],
    ]),
  );
});
