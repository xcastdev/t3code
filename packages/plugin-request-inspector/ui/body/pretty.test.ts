import { describe, expect, it } from "vite-plus/test";

import {
  type BodyKind,
  formatForm,
  formatGraphql,
  formatJson,
  formatMarkup,
  HIGHLIGHT_MAX_CHARS,
  PRETTY_MAX_CHARS,
  prettify,
  sniffKind,
} from "./pretty.ts";

describe("formatJson", () => {
  it.each([
    ["object", '{"a":1,"b":[true,null]}', '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}'],
    ["empty containers", '{"a":{},"b":[ ]}', '{\n  "a": {},\n  "b": []\n}'],
    [
      "big integers as written",
      '{"id":12345678901234567890123}',
      '{\n  "id": 12345678901234567890123\n}',
    ],
    ["escaped quotes and brackets in strings", '{"s":"a\\"{,}"}', '{\n  "s": "a\\"{,}"\n}'],
    ["a body cut mid-value", '{"a":[1,2', '{\n  "a": [\n    1,\n    2'],
    ["ndjson lines", '{"a":1}\n{"b":2}', '{\n  "a": 1\n}\n{\n  "b": 2\n}'],
  ])("%s", (_name, input, expected) => {
    expect(formatJson(input)).toBe(expected);
  });
});

describe("formatMarkup", () => {
  it.each([
    [
      "nested xml with text leaves",
      '<?xml version="1.0"?><a x="1>2"><b>hi</b><c/><d></d></a>',
      false,
      '<?xml version="1.0"?>\n<a x="1>2">\n  <b>hi</b>\n  <c/>\n  <d></d>\n</a>',
    ],
    [
      "html void elements and raw text",
      "<!doctype html><html><head><meta charset=utf-8><script>if (a < b) {}</script></head><body><p>x</p></body></html>",
      true,
      "<!doctype html>\n<html>\n  <head>\n    <meta charset=utf-8>\n    <script>if (a < b) {}</script>\n  </head>\n  <body>\n    <p>x</p>\n  </body>\n</html>",
    ],
    [
      "comments and cdata",
      "<r><!-- c --><![CDATA[<x>]]></r>",
      false,
      "<r>\n  <!-- c -->\n  <![CDATA[<x>]]>\n</r>",
    ],
  ])("%s", (_name, input, html, expected) => {
    expect(formatMarkup(input, html)).toBe(expected);
  });
});

describe("formatForm", () => {
  it.each([
    ["decodes names and values", "a=1&b=hello+world&c=%7B%7D", "a = 1\nb = hello world\nc = {}"],
    ["keeps malformed escapes and bare names", "x=%E0%A4&flag", "x = %E0%A4\nflag"],
  ])("%s", (_name, input, expected) => {
    expect(formatForm(input)).toBe(expected);
  });
});

describe("formatGraphql", () => {
  it.each([
    [
      "selections, arguments, fragments and directives",
      "query Q($id: ID!, $x: Boolean = false) { user(id: $id) { id, name ...F friends(first: 10) @include(if: $x) { edges { node { id } } } ... on Admin { level } } } fragment F on User { email }",
      [
        "query Q($id: ID!, $x: Boolean = false) {",
        "  user(id: $id) {",
        "    id",
        "    name",
        "    ...F",
        "    friends(first: 10) @include(if: $x) {",
        "      edges {",
        "        node {",
        "          id",
        "        }",
        "      }",
        "    }",
        "    ... on Admin {",
        "      level",
        "    }",
        "  }",
        "}",
        "",
        "fragment F on User {",
        "  email",
        "}",
      ].join("\n"),
    ],
    [
      "inline object arguments and aliases",
      'mutation{add(input:{name:"a",tags:["x","y"]}){ok: success}}',
      'mutation {\n  add(input: { name: "a", tags: ["x", "y"] }) {\n    ok: success\n  }\n}',
    ],
  ])("%s", (_name, input, expected) => {
    expect(formatGraphql(input)).toBe(expected);
  });
});

describe("sniffKind", () => {
  it.each<[string | undefined, string, BodyKind | undefined]>([
    ["application/json; charset=utf-8", "", "json"],
    ["application/problem+json", "", "json"],
    ["application/x-ndjson", "", "json"],
    ["text/html", "", "html"],
    ["application/atom+xml", "", "xml"],
    ["application/x-www-form-urlencoded", "", "form"],
    ["application/graphql", "", "graphql"],
    ["text/javascript", "", "javascript"],
    ["text/css", "", "css"],
    ["image/png", "{}", undefined],
    [undefined, '  {"a":1}', "json"],
    ["text/plain", "<!DOCTYPE html><html>", "html"],
    [undefined, "<feed/>", "xml"],
    [undefined, "query { a }", "graphql"],
    [undefined, "a=1&b=2", "form"],
    [undefined, "just words", undefined],
  ])("%s %j", (contentType, text, expected) => {
    expect(sniffKind(contentType, text)).toBe(expected);
  });
});

describe("prettify caps", () => {
  it("highlights pretty text under the highlight cap", () => {
    expect(prettify("json", '{"a":1}')).toEqual({
      text: '{\n  "a": 1\n}',
      language: "json",
      note: undefined,
    });
  });

  it("formats but does not color text over the highlight cap", () => {
    const text = `[${'"x",'.repeat(HIGHLIGHT_MAX_CHARS / 4)}"x"]`;
    const result = prettify("json", text);
    expect(result.text.startsWith('[\n  "x",\n')).toBe(true);
    expect(result.language).toBeUndefined();
    expect(result.note).toMatch(/not colored/);
  });

  it("leaves text over the pretty cap untouched", () => {
    const text = `{"a":"${"x".repeat(PRETTY_MAX_CHARS)}"}`;
    const result = prettify("json", text);
    expect(result.text).toBe(text);
    expect(result.language).toBeUndefined();
    expect(result.note).toMatch(/plain text/);
  });

  it("highlights JavaScript and CSS without reformatting them", () => {
    expect(prettify("css", "a{b:c}")).toEqual({ text: "a{b:c}", language: "css", note: undefined });
  });
});
