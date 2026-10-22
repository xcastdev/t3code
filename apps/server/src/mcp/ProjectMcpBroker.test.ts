import { expect, it } from "@effect/vitest";
import { McpServerId } from "@t3tools/contracts";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import {
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
