/** Body kinds the viewer can pretty-print or highlight. JS and CSS are highlighted only. */
export type BodyKind = "json" | "xml" | "html" | "form" | "graphql" | "javascript" | "css";

/** highlight.js language names registered in highlight.ts. */
export type HighlightLanguage = "json" | "xml" | "javascript" | "css" | "graphql";

export const PRETTY_MAX_CHARS = 1024 * 1024;
export const HIGHLIGHT_MAX_CHARS = 256 * 1024;

export interface Pretty {
  readonly text: string;
  /** Unset when the kind has no grammar or the text is over the highlight cap. */
  readonly language: HighlightLanguage | undefined;
  /** Why the view fell back to plain or unhighlighted text. */
  readonly note: string | undefined;
}

const SNIFF_CHARS = 2048;
const FORM_PATTERN = /^[^\s=&]+=[^\s&]*(?:&[^\s=&]+=[^\s&]*)*&?$/;
const GRAPHQL_PATTERN = /^\s*(?:query|mutation|subscription|fragment)\b/;

export function sniffKind(contentType: string | undefined, text: string): BodyKind | undefined {
  const type = (contentType ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (/(?:^|[/+])(?:x-)?(?:nd)?json$/.test(type)) return "json";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (/(?:^|[/+])xml$/.test(type)) return "xml";
  if (type === "application/x-www-form-urlencoded") return "form";
  if (type === "application/graphql" || type === "application/graphql-query") return "graphql";
  if (/(?:java|ecma)script$/.test(type)) return "javascript";
  if (type === "text/css") return "css";
  if (type !== "" && type !== "text/plain" && type !== "application/octet-stream") return undefined;
  const head = text.slice(0, SNIFF_CHARS).trimStart();
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  if (/^<(?:!doctype\s+html|html)[\s>]/i.test(head)) return "html";
  if (head.startsWith("<")) return "xml";
  if (GRAPHQL_PATTERN.test(head)) return "graphql";
  if (!head.includes("\n") && FORM_PATTERN.test(head.trimEnd())) return "form";
  return undefined;
}

const indents: Array<string> = [""];
const indentOf = (depth: number) => {
  while (indents.length <= depth) indents.push(`${indents[indents.length - 1]}  `);
  return indents[depth] as string;
};

const isJsonSpace = (char: string) =>
  char === " " || char === "\n" || char === "\r" || char === "\t";
const isJsonStructural = (char: string) =>
  char === "{" || char === "}" || char === "[" || char === "]" || char === "," || char === ":";

/** The end index (exclusive) of the string literal opening at `start`, or the text end. */
const stringEnd = (text: string, start: number, quote: string) => {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") index += 2;
    else if (char === quote) return index + 1;
    else index += 1;
  }
  return text.length;
};

/**
 * Re-indents JSON token by token. Number and string text is copied as written, so big integers
 * survive, and a body cut mid-value still prints what arrived.
 */
export function formatJson(text: string): string {
  const out: Array<string> = [];
  let depth = 0;
  let index = 0;
  const newline = () => out.push(`\n${indentOf(depth)}`);
  const startValue = () => {
    if (depth === 0 && out.length > 0) out.push("\n");
  };
  while (index < text.length) {
    const char = text[index] as string;
    if (isJsonSpace(char)) {
      index += 1;
    } else if (char === '"') {
      startValue();
      const end = stringEnd(text, index, '"');
      out.push(text.slice(index, end));
      index = end;
    } else if (char === "{" || char === "[") {
      startValue();
      const close = char === "{" ? "}" : "]";
      let next = index + 1;
      while (next < text.length && isJsonSpace(text[next] as string)) next += 1;
      if (text[next] === close) {
        out.push(char, close);
        index = next + 1;
      } else {
        out.push(char);
        depth += 1;
        newline();
        index += 1;
      }
    } else if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
      newline();
      out.push(char);
      index += 1;
    } else if (char === ",") {
      out.push(",");
      newline();
      index += 1;
    } else if (char === ":") {
      out.push(": ");
      index += 1;
    } else {
      startValue();
      let end = index + 1;
      while (
        end < text.length &&
        !isJsonSpace(text[end] as string) &&
        !isJsonStructural(text[end] as string) &&
        text[end] !== '"'
      )
        end += 1;
      out.push(text.slice(index, end));
      index = end;
    }
  }
  return out.join("");
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "pre"]);

type MarkupToken =
  | { readonly kind: "open"; readonly text: string; readonly name: string; readonly empty: boolean }
  | { readonly kind: "close"; readonly text: string; readonly name: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "other"; readonly text: string };

/** The index just past the `>` ending the tag at `start`, skipping quoted attribute values. */
const tagEnd = (text: string, start: number) => {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") index = stringEnd(text, index, char);
    else if (char === ">") return index + 1;
    else index += 1;
  }
  return text.length;
};

const tagName = (tag: string) => /^<\/?([^\s/>]+)/.exec(tag)?.[1] ?? "";

function markupTokens(text: string, html: boolean): Array<MarkupToken> {
  const tokens: Array<MarkupToken> = [];
  let index = 0;
  const until = (marker: string, from: number) => {
    const found = text.indexOf(marker, from);
    return found < 0 ? text.length : found + marker.length;
  };
  while (index < text.length) {
    if (text[index] !== "<") {
      const next = text.indexOf("<", index);
      const end = next < 0 ? text.length : next;
      tokens.push({ kind: "text", text: text.slice(index, end) });
      index = end;
      continue;
    }
    let end: number;
    if (text.startsWith("<!--", index)) end = until("-->", index + 4);
    else if (text.startsWith("<![CDATA[", index)) end = until("]]>", index + 9);
    else if (text.startsWith("<?", index)) end = until("?>", index + 2);
    else if (text.startsWith("<!", index)) end = tagEnd(text, index);
    else if (/^<\/?[A-Za-z_:]/.test(text.slice(index, index + 3))) {
      end = tagEnd(text, index);
      const tag = text.slice(index, end);
      const name = tagName(tag);
      const lower = name.toLowerCase();
      if (tag.startsWith("</")) {
        tokens.push({ kind: "close", text: tag, name });
      } else {
        const empty = tag.endsWith("/>") || (html && VOID_ELEMENTS.has(lower));
        if (html && !empty && RAW_TEXT_ELEMENTS.has(lower)) {
          const closeAt = text.toLowerCase().indexOf(`</${lower}`, end);
          const contentEnd = closeAt < 0 ? text.length : closeAt;
          const closeEnd = closeAt < 0 ? text.length : tagEnd(text, closeAt);
          tokens.push({ kind: "other", text: text.slice(index, closeEnd) });
          index = closeEnd;
          if (contentEnd === text.length) break;
          continue;
        }
        tokens.push({ kind: "open", text: tag, name, empty });
      }
      index = end;
      continue;
    } else {
      const next = text.indexOf("<", index + 1);
      end = next < 0 ? text.length : next;
      tokens.push({ kind: "text", text: text.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ kind: "other", text: text.slice(index, end) });
    index = end;
  }
  return tokens;
}

/** One element per line, children indented; an element holding only text stays on one line. */
export function formatMarkup(text: string, html: boolean): string {
  const tokens = markupTokens(text, html);
  const lines: Array<string> = [];
  let depth = 0;
  const line = (value: string) => {
    const indent = indentOf(depth);
    lines.push(indent + value.replaceAll(/\s*\n\s*/g, `\n${indent}`));
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as MarkupToken;
    if (token.kind === "text") {
      const trimmed = token.text.trim();
      if (trimmed !== "") line(trimmed);
    } else if (token.kind === "other") {
      lines.push(indentOf(depth) + token.text.trim());
    } else if (token.kind === "close") {
      depth = Math.max(0, depth - 1);
      line(token.text);
    } else if (token.empty) {
      line(token.text);
    } else {
      const next = tokens[index + 1];
      const after = tokens[index + 2];
      if (next?.kind === "close" && next.name === token.name) {
        line(token.text + next.text);
        index += 1;
      } else if (
        next?.kind === "text" &&
        after?.kind === "close" &&
        after.name === token.name &&
        !next.text.trim().includes("\n")
      ) {
        line(token.text + next.text.trim() + after.text);
        index += 2;
      } else {
        line(token.text);
        depth += 1;
      }
    }
  }
  return lines.join("\n");
}

const decodeFormPart = (part: string) => {
  const spaced = part.replaceAll("+", " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
};

/** One `name = value` line per field, percent-decoded. */
export function formatForm(text: string): string {
  return text
    .trim()
    .split("&")
    .filter((part) => part !== "")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq < 0) return decodeFormPart(part);
      return `${decodeFormPart(part.slice(0, eq))} = ${decodeFormPart(part.slice(eq + 1))}`;
    })
    .join("\n");
}

type GraphqlToken =
  | { readonly kind: "word" | "string" | "comment"; readonly text: string }
  | { readonly kind: "punct"; readonly text: string };

const GRAPHQL_WORD = /[\w.+-]/;
const GRAPHQL_PUNCT = new Set(["!", "$", "&", "(", ")", ":", "=", "@", "[", "]", "{", "|", "}"]);

function graphqlTokens(text: string): Array<GraphqlToken> {
  const tokens: Array<GraphqlToken> = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (/[\s,﻿]/.test(char)) {
      if (char === ",") tokens.push({ kind: "punct", text: "," });
      index += 1;
    } else if (char === "#") {
      const end = text.indexOf("\n", index);
      const stop = end < 0 ? text.length : end;
      tokens.push({ kind: "comment", text: text.slice(index, stop).trimEnd() });
      index = stop;
    } else if (text.startsWith('"""', index)) {
      let end = index + 3;
      while (end < text.length && !text.startsWith('"""', end)) end += text[end] === "\\" ? 2 : 1;
      end = Math.min(text.length, end + 3);
      tokens.push({ kind: "string", text: text.slice(index, end) });
      index = end;
    } else if (char === '"') {
      const end = stringEnd(text, index, '"');
      tokens.push({ kind: "string", text: text.slice(index, end) });
      index = end;
    } else if (text.startsWith("...", index)) {
      tokens.push({ kind: "punct", text: "..." });
      index += 3;
    } else if (GRAPHQL_PUNCT.has(char)) {
      tokens.push({ kind: "punct", text: char });
      index += 1;
    } else {
      let end = index + 1;
      while (end < text.length && GRAPHQL_WORD.test(text[end] as string)) end += 1;
      tokens.push({ kind: "word", text: text.slice(index, end) });
      index = end;
    }
  }
  return tokens;
}

const NO_SPACE_AFTER = new Set(["(", "[", "$", "@", "..."]);
const NO_SPACE_BEFORE = new Set([")", "]", "!", ":", ",", "("]);

/**
 * Selection sets one field per line; arguments, variables and object values stay inline.
 * Commas outside arguments are dropped, since GraphQL ignores them.
 */
export function formatGraphql(text: string): string {
  const out: Array<string> = [];
  let depth = 0;
  // Open "(", "[" and "{" inside arguments; selection-set braces are counted by `depth`.
  const inline: Array<string> = [];
  let lineEmpty = true;
  let blankBeforeNext = false;
  let previous: GraphqlToken | undefined;
  const newline = () => {
    out.push(`\n${indentOf(depth)}`);
    lineEmpty = true;
  };
  const ensureLine = () => {
    if (!lineEmpty) newline();
  };
  const write = (token: GraphqlToken) => {
    const prev = previous?.text;
    const spaced =
      !lineEmpty &&
      prev !== undefined &&
      !NO_SPACE_BEFORE.has(token.text) &&
      !(prev === "..." ? token.text !== "on" : NO_SPACE_AFTER.has(prev));
    if (spaced) out.push(" ");
    out.push(token.text);
    lineEmpty = false;
  };
  for (const token of graphqlTokens(text)) {
    const inSelection = depth > 0 && inline.length === 0;
    if (token.kind === "comment") {
      ensureLine();
      out.push(token.text);
      lineEmpty = false;
      newline();
      continue;
    }
    if (depth === 0 && inline.length === 0 && blankBeforeNext && token.text !== ",") {
      out.push("\n\n");
      lineEmpty = true;
      blankBeforeNext = false;
    }
    const text = token.text;
    if (token.kind === "punct" && text === ",") {
      if (inline.length === 0) continue;
      write(token);
    } else if (token.kind === "punct" && (text === "(" || text === "[")) {
      write(token);
      inline.push(text);
    } else if (token.kind === "punct" && (text === ")" || text === "]")) {
      inline.pop();
      write(token);
    } else if (token.kind === "punct" && text === "{") {
      write(token);
      if (inline.length > 0) inline.push("{");
      else {
        depth += 1;
        newline();
      }
    } else if (token.kind === "punct" && text === "}") {
      if (inline.length > 0) {
        inline.pop();
        write(token);
      } else {
        depth = Math.max(0, depth - 1);
        if (lineEmpty) out[out.length - 1] = `\n${indentOf(depth)}`;
        else newline();
        write(token);
        if (depth === 0) blankBeforeNext = true;
      }
    } else {
      const startsField =
        inSelection &&
        (token.kind === "word" || text === "...") &&
        previous !== undefined &&
        (previous.kind === "string" ||
          (previous.kind === "word" && previous.text !== "on") ||
          [")", "]", "}", "!"].includes(previous.text));
      if (startsField) ensureLine();
      write(token);
    }
    previous = token;
  }
  return out.join("").trim();
}

const LANGUAGES: Readonly<Record<BodyKind, HighlightLanguage | undefined>> = {
  json: "json",
  xml: "xml",
  html: "xml",
  form: undefined,
  graphql: "graphql",
  javascript: "javascript",
  css: "css",
};

const FORMATTERS: Readonly<Record<BodyKind, ((text: string) => string) | undefined>> = {
  json: formatJson,
  xml: (text) => formatMarkup(text, false),
  html: (text) => formatMarkup(text, true),
  form: formatForm,
  graphql: formatGraphql,
  javascript: undefined,
  css: undefined,
};

const MIB_LABEL = "1 MiB";
const HIGHLIGHT_LABEL = "256 KiB";

/** The pretty view of `text`, or `text` itself with a note when it is over a cap. */
export function prettify(kind: BodyKind, text: string): Pretty {
  if (text.length > PRETTY_MAX_CHARS) {
    return {
      text,
      language: undefined,
      note: `Over ${MIB_LABEL}, so it is shown as plain text.`,
    };
  }
  const formatted = FORMATTERS[kind]?.(text) ?? text;
  const language = LANGUAGES[kind];
  if (language !== undefined && formatted.length > HIGHLIGHT_MAX_CHARS) {
    return {
      text: formatted,
      language: undefined,
      note: `Over ${HIGHLIGHT_LABEL}, so not colored.`,
    };
  }
  return { text: formatted, language, note: undefined };
}
