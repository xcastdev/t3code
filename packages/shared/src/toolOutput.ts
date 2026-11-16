import { readOmpEvalEnvelope, normalizeOmpEvalImages, type OmpEvalEnvelope } from "./ompEval.ts";
import {
  isOrchestrationV2WorkActive,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import {
  HTML_RENDER_TOOL_NAME,
  readHtmlRenderReference,
  type HtmlRenderReference,
} from "./htmlRender.ts";
import {
  claudeMcpToolName,
  MCP_APP_OUTPUT_KEY,
  readMcpAppReference,
  type McpAppReference,
} from "./mcpApp.ts";
import { resolveT3McpToolId } from "./t3McpToolPresentation.ts";

export const SEND_TO_USER_TOOL_NAME = "send_to_user";
// 4,000 UTF-16 units stay inside MAX_PARSED_BYTES even as 3-byte characters.
export const SEND_TO_USER_MAX_LENGTH = 4_000;

const MAX_PARSED_BYTES = 16_384;
const MAX_METADATA_BYTES = 8_192;
const MAX_ID_LENGTH = 256;
const MAX_THREADS = 100;
const MAX_CONTENT_BLOCKS = 32;
const MAX_ENVELOPE_DEPTH = 4;
const MAX_ENVELOPE_NODES = 128;
const encoder = new TextEncoder();

interface ResultReadBudget {
  remainingBytes: number;
  remainingNodes: number;
  exceeded: boolean;
}

interface ResultEnvelope {
  data?: Record<PropertyKey, unknown>;
  failed: boolean;
}

interface CompactToolOutput {
  t3OmpEval?: OmpEvalEnvelope;
  isError?: true;
  threadId?: string;
  messageId?: string;
  taskId?: string;
  scheduledTaskId?: string;
  status?: "rolled_back";
  htmlRender?: HtmlRenderReference;
  [MCP_APP_OUTPUT_KEY]?: McpAppReference;
  thread?: { threadId: string };
  threads?: Array<{ threadId?: string; status?: "rolled_back" }>;
  linkedCount?: number;
  unlinkedCount?: number;
  sentMessage?: string;
}

function readResult(value: unknown, budget: ResultReadBudget, depth = 0): ResultEnvelope {
  if (depth > MAX_ENVELOPE_DEPTH || budget.remainingNodes-- <= 0) {
    budget.exceeded = true;
    return { failed: false };
  }
  if (typeof value === "string") {
    if (value.length > budget.remainingBytes) {
      budget.exceeded = true;
      return { failed: false };
    }
    const bytes = encoder.encode(value).byteLength;
    if (bytes > budget.remainingBytes) {
      budget.exceeded = true;
      return { failed: false };
    }
    budget.remainingBytes -= bytes;
    try {
      return readResult(JSON.parse(value), budget, depth + 1);
    } catch {
      return { failed: false };
    }
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONTENT_BLOCKS) {
      budget.exceeded = true;
      return { failed: false };
    }
    let data: ResultEnvelope["data"];
    let failed = false;
    for (const block of value) {
      const text = Predicate.isObject(block) ? block.text : undefined;
      const result = readResult(
        Predicate.isObject(text) ? (text.text ?? text) : text,
        budget,
        depth + 1,
      );
      data ??= result.data;
      failed ||= result.failed;
      if (budget.exceeded) break;
    }
    return { ...(data === undefined ? {} : { data }), failed };
  }
  if (!Predicate.isObject(value)) return { failed: false };
  const failed =
    value.isError === true ||
    value.is_error === true ||
    value._tag === "OrchestratorMcpFailure" ||
    value.error != null;
  const content = value.structuredContent ?? value.content;
  if (content !== undefined) {
    const nested = readResult(content, budget, depth + 1);
    return { ...nested, failed: failed || nested.failed };
  }
  return { data: value, failed };
}

function boundedId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || value.trim() === "") {
    return undefined;
  }
  return Array.from(value).join("");
}

export function compactDynamicToolOutput(value: unknown): CompactToolOutput | undefined {
  const omp = readOmpEvalEnvelope(value);
  const budget: ResultReadBudget = {
    remainingBytes: MAX_PARSED_BYTES,
    remainingNodes: MAX_ENVELOPE_NODES,
    exceeded: false,
  };
  const result = readResult(value, budget);
  const output: CompactToolOutput = {
    ...(result.failed ? { isError: true as const } : {}),
    ...(omp ? { t3OmpEval: omp } : {}),
  };
  const data = budget.exceeded ? undefined : result.data;
  if (data !== undefined) {
    for (const key of ["threadId", "messageId", "taskId", "scheduledTaskId"] as const) {
      const id = boundedId(data[key]);
      if (id !== undefined) output[key] = id;
    }
    if (data.status === "rolled_back") output.status = "rolled_back";
    for (const key of ["linkedCount", "unlinkedCount"] as const) {
      const count = data[key];
      if (typeof count === "number" && Number.isSafeInteger(count)) output[key] = count;
    }
    if (
      typeof data.sentMessage === "string" &&
      data.sentMessage.trim() !== "" &&
      data.sentMessage.length <= SEND_TO_USER_MAX_LENGTH
    ) {
      output.sentMessage = data.sentMessage;
    }
    const htmlRender = readHtmlRenderReference(data.htmlRender);
    if (htmlRender !== undefined) output.htmlRender = htmlRender;
    const mcpApp = readMcpAppReference(data[MCP_APP_OUTPUT_KEY]);
    if (mcpApp !== undefined) output[MCP_APP_OUTPUT_KEY] = mcpApp;
    const nestedThreadId = Predicate.isObject(data.thread)
      ? boundedId(data.thread.threadId)
      : undefined;
    if (nestedThreadId !== undefined) output.thread = { threadId: nestedThreadId };

    if (Array.isArray(data.threads)) {
      let complete = data.threads.length <= MAX_THREADS;
      const threads: NonNullable<CompactToolOutput["threads"]> = [];
      if (complete) {
        for (const entry of data.threads) {
          if (!Predicate.isObject(entry)) {
            complete = false;
            break;
          }
          const threadId = boundedId(entry.threadId);
          const rolledBack = entry.status === "rolled_back";
          if (threadId === undefined && !rolledBack) {
            complete = false;
            break;
          }
          threads.push({
            ...(threadId === undefined ? {} : { threadId }),
            ...(rolledBack ? { status: "rolled_back" as const } : {}),
          });
        }
      }
      if (complete) output.threads = threads;
      else {
        // Partial batches or top-level ids make the summary parser report a false creation count.
        delete output.threadId;
        delete output.status;
      }
    }
  }
  const oversized = () => encoder.encode(JSON.stringify(output)).byteLength > MAX_METADATA_BYTES;
  if (oversized()) {
    delete output.threads;
    delete output.threadId;
    delete output.status;
  }
  const app = output[MCP_APP_OUTPUT_KEY];
  if (app?.csp !== undefined && oversized()) {
    const { csp: _csp, ...rest } = app;
    output[MCP_APP_OUTPUT_KEY] = rest;
  }
  if (oversized()) delete output[MCP_APP_OUTPUT_KEY];
  if (oversized()) delete output.threads;
  if (oversized()) delete output.htmlRender;
  return Object.keys(output).length === 0 ? undefined : output;
}

// OpenCode 2 Code Mode reports a script's nested T3 tool calls as one item with the script's result.
const OPENCODE_CODE_MODE_TOOL_NAME = "execute";

export function htmlRenderFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): HtmlRenderReference | undefined {
  if (
    item.toolName !== OPENCODE_CODE_MODE_TOOL_NAME &&
    resolveT3McpToolId(item.toolName) !== HTML_RENDER_TOOL_NAME
  ) {
    return undefined;
  }
  const output = compactDynamicToolOutput(item.output);
  return output?.isError ? undefined : output?.htmlRender;
}

/** The text `send_to_user` showed the user, which clients render as the agent's own words. */
export function sentMessageFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): string | undefined {
  if (
    item.toolName !== OPENCODE_CODE_MODE_TOOL_NAME &&
    resolveT3McpToolId(item.toolName) !== SEND_TO_USER_TOOL_NAME
  ) {
    return undefined;
  }
  const output = compactDynamicToolOutput(item.output);
  return output?.isError ? undefined : output?.sentMessage;
}

/** The thread-owned file `preview_recording_stop` stored for the agent. */
export function previewRecordingIdFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): string | undefined {
  if (resolveT3McpToolId(item.toolName) !== "preview_recording_stop") return undefined;
  const budget: ResultReadBudget = {
    remainingBytes: MAX_PARSED_BYTES,
    remainingNodes: MAX_ENVELOPE_NODES,
    exceeded: false,
  };
  const result = readResult(item.output, budget);
  return result.failed || budget.exceeded ? undefined : boundedId(result.data?.id);
}

/** Accept app references only when server and tool match the item, so tools cannot impersonate another app source. */
export function mcpAppFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): McpAppReference | undefined {
  const app = compactDynamicToolOutput(item.output)?.[MCP_APP_OUTPUT_KEY];
  return app !== undefined &&
    (item.toolName === `${app.server}.${app.tool}` ||
      item.toolName === claudeMcpToolName(app.server, app.tool))
    ? app
    : undefined;
}

// Exact names adapters give our own server's tool: Claude, Cursor, and Pi; Codex and ACP; OpenCode 1.x.
// OpenCode 2 names a per-thread server, so its adapter converts those calls itself.
const T3_WEB_SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  "mcp__t3-code__t3_web_search",
  "mcp__t3_code__t3_web_search",
  "t3-code.t3_web_search",
  "t3-code-direct.t3_web_search",
  "t3-code_t3_web_search",
]);
const MAX_WEB_SEARCH_PARSE_BYTES = 262_144;
const MAX_WEB_SEARCH_ITEM_BYTES = 16_384;
const MAX_WEB_SEARCH_SOURCES = 20;
const MAX_WEB_SEARCH_TITLE_CHARS = 300;
const MAX_WEB_SEARCH_URL_CHARS = 2_048;
const MAX_WEB_SEARCH_QUERY_CHARS = 1_000;
const MAX_WEB_SEARCH_TEXT_CHARS = 8_000;
const MAX_WEB_SEARCH_TEXT_BYTES = 8_192;

type WebSearchTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "web_search" }>;
type WebSearchResult = NonNullable<WebSearchTurnItem["results"]>[number];
type DynamicToolTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>;
type WebSearchTurnItemBase = Omit<
  DynamicToolTurnItem,
  "type" | "toolName" | "input" | "output" | "outputOmitted" | "viewedImagePath"
>;

function trimmedText(value: unknown, maxChars: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? undefined : text.slice(0, maxChars);
}

function rawOutputText(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_ENVELOPE_DEPTH || value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .slice(0, MAX_CONTENT_BLOCKS)
      .map((block) => rawOutputText(Predicate.isObject(block) ? block.text : block, depth + 1))
      .filter((part) => part !== undefined);
    return parts.length === 0 ? undefined : parts.join("\n");
  }
  if (Predicate.isObject(value) && value.content !== undefined) {
    return rawOutputText(value.content, depth + 1);
  }
  try {
    return JSON.stringify(value)?.slice(0, MAX_WEB_SEARCH_TEXT_CHARS);
  } catch {
    return undefined;
  }
}

function fitBytes(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly bytes: number } {
  let fitted = text;
  let bytes = encoder.encode(fitted).byteLength;
  while (bytes > maxBytes) {
    fitted = fitted.slice(0, Math.floor((fitted.length * maxBytes) / bytes) - 1);
    bytes = encoder.encode(fitted).byteLength;
  }
  return { text: fitted, bytes };
}

function webSearchSource(source: unknown): WebSearchResult | undefined {
  if (!Predicate.isObject(source) || typeof source.url !== "string") return undefined;
  const url = source.url.trim();
  if (url.length > MAX_WEB_SEARCH_URL_CHARS || !/^https?:\/\//i.test(url)) return undefined;
  const title = trimmedText(source.title, MAX_WEB_SEARCH_TITLE_CHARS);
  return title === undefined ? { url } : { title, url };
}

/** T3's web search tool is stored as the native web search it stands in for. */
export function t3WebSearchTurnItem(
  base: WebSearchTurnItemBase,
  query: string | undefined,
  output: unknown,
): WebSearchTurnItem {
  const { toolSurface: _surface, toolIcon: _icon, toolSource: _source, ...item } = base;
  const result = readResult(output, {
    remainingBytes: MAX_WEB_SEARCH_PARSE_BYTES,
    remainingNodes: MAX_ENVELOPE_NODES,
    exceeded: false,
  });
  const data = result.data ?? {};
  const failed = result.failed || item.status === "failed";
  const answer = failed ? undefined : trimmedText(data.answer, MAX_WEB_SEARCH_TEXT_CHARS);
  const sources =
    failed || !Array.isArray(data.sources)
      ? []
      : data.sources.slice(0, 100).flatMap((source) => webSearchSource(source) ?? []);
  const fallback =
    answer !== undefined || sources.length > 0
      ? undefined
      : trimmedText(
          (failed ? (data.message ?? data.error) : undefined) ?? rawOutputText(output),
          MAX_WEB_SEARCH_TEXT_CHARS,
        );
  const snippet = answer ?? fallback;
  const fitted = snippet === undefined ? undefined : fitBytes(snippet, MAX_WEB_SEARCH_TEXT_BYTES);
  const results: WebSearchResult[] =
    fitted === undefined
      ? []
      : [
          {
            title: answer !== undefined ? "Answer" : failed ? "Error" : "Output",
            snippet: fitted.text,
          },
        ];
  let bytes = fitted?.bytes ?? 0;
  for (const source of sources.slice(0, MAX_WEB_SEARCH_SOURCES)) {
    bytes += encoder.encode(`${source.title ?? ""}${source.url ?? ""}`).byteLength;
    if (bytes > MAX_WEB_SEARCH_ITEM_BYTES) break;
    results.push(source);
  }
  const trimmedQuery = trimmedText(query, MAX_WEB_SEARCH_QUERY_CHARS);
  return {
    ...item,
    status: result.failed && item.status === "completed" ? "failed" : item.status,
    title: null,
    type: "web_search",
    ...(trimmedQuery === undefined ? {} : { patterns: [trimmedQuery] }),
    ...(results.length === 0 ? {} : { results }),
  };
}

function convertT3WebSearchTurnItem(
  item: DynamicToolTurnItem,
  trustOutput: boolean,
): WebSearchTurnItem {
  const {
    type: _type,
    toolName: _toolName,
    input,
    output,
    outputOmitted: _omitted,
    viewedImagePath: _viewed,
    ...base
  } = item;
  const query = Predicate.isObject(input) ? input.query : undefined;
  return t3WebSearchTurnItem(
    base,
    typeof query === "string" ? query : undefined,
    trustOutput ? output : undefined,
  );
}

/** Converts only ended calls: a running one stays dynamic_tool, which Stop and settlement end. */
export function asT3WebSearchTurnItem(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (
    item.type !== "dynamic_tool" ||
    isOrchestrationV2WorkActive(item.status) ||
    !T3_WEB_SEARCH_TOOL_NAMES.has(item.toolName ?? "")
  ) {
    return item;
  }
  return convertT3WebSearchTurnItem(item, true);
}

/**
 * Clients show a T3 web search call as a web search in every state, so the row does not change
 * look when it ends; Stop and recovery end calls without converting them. Output from a name
 * other than our own server's (OpenCode 2 names one per thread) is not shown as sources.
 */
export function t3WebSearchDisplayItem(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "dynamic_tool" || resolveT3McpToolId(item.toolName) !== "t3_web_search") {
    return item;
  }
  return convertT3WebSearchTurnItem(item, T3_WEB_SEARCH_TOOL_NAMES.has(item.toolName ?? ""));
}

// A superset of every needle below, so most outputs are rejected by this single scan.
const FAILURE_HINT =
  /enoent|no such|no files found|not found|commandnotfound|not recognized|cannot (?:find path|be found)|exit/i;

/** Some providers report completion even when command output describes a failure. */
export function toolOutputIndicatesFailure(text: string): boolean {
  return (
    FAILURE_HINT.test(text) &&
    (/file not found|no files found|enoent|no such file|commandnotfoundexception|command not found|is not recognized as the name of a cmdlet|a parameter cannot be found that matches parameter name/i.test(
      text,
    ) ||
      (/cannot find path/i.test(text) && /because it does not exist/i.test(text)) ||
      (/is not recognized/i.test(text) && /the term '/i.test(text)) ||
      /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
      /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text))
  );
}

export interface ToolOutputImage {
  readonly mimeType: string;
  readonly data?: string;
}

/** Raster types only, so agent SVG/HTML cannot be served inline. */
export function readToolOutputImage(block: unknown): ToolOutputImage | null {
  if (!Predicate.isObject(block) || block.type !== "image") return null;
  const source = Predicate.isObject(block.source) ? block.source : undefined;
  if (source !== undefined && source.type !== "base64") return null;
  const mimeType = source === undefined ? block.mimeType : source.media_type;
  const data = source === undefined ? block.data : source.data;
  if (typeof mimeType !== "string" || !isProviderSendTurnSupportedImageMimeType(mimeType)) {
    return null;
  }
  const image = { mimeType: mimeType.toLowerCase() };
  return typeof data === "string" ? { ...image, data } : image;
}

function outputBlocks(value: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(value)) return value;
  if (Predicate.isObject(value) && Array.isArray(value.content)) return value.content;
  return [value];
}

export const MAX_TOOL_OUTPUT_IMAGES = 8;

export const MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH =
  Math.ceil(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 3) * 4;

export function toolOutputImageBlocks(value: unknown): ReadonlyArray<unknown> {
  const blocks: unknown[] = [];
  for (const block of outputBlocks(
    readOmpEvalEnvelope(value) ? normalizeOmpEvalImages(value) : value,
  )) {
    if (readToolOutputImage(block) === null) continue;
    blocks.push(block);
    if (blocks.length === MAX_TOOL_OUTPUT_IMAGES) break;
  }
  return blocks;
}

/** Order defines the shared tool-output-image asset index. */
export function toolOutputImages(value: unknown): ReadonlyArray<ToolOutputImage> {
  return toolOutputImageBlocks(value).flatMap((block) => readToolOutputImage(block) ?? []);
}

export function mcpToolResultOutput(result: {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
}): unknown {
  const structuredContent =
    (Array.isArray(result.structuredContent) || Predicate.isObject(result.structuredContent)) &&
    Object.keys(result.structuredContent).length === 0
      ? undefined
      : result.structuredContent;
  if (structuredContent != null && toolOutputImages(result.content).length > 0) {
    return { content: result.content, structuredContent };
  }
  return structuredContent ?? result.content;
}

export function omitToolOutputImageData(value: unknown): unknown {
  if (readOmpEvalEnvelope(value)) value = normalizeOmpEvalImages(value);
  const omit = (block: unknown) => {
    const image = readToolOutputImage(block);
    return image?.data === undefined ? block : { type: "image", mimeType: image.mimeType };
  };
  if (Array.isArray(value)) return value.map(omit);
  if (Predicate.isObject(value) && Array.isArray(value.content)) {
    return { ...value, content: value.content.map(omit) };
  }
  return omit(value);
}
