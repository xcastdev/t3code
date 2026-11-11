import { toolOutputImages } from "@t3tools/shared/toolOutput";
import {
  makeOmpEvalEnvelope,
  ompEvalTitle,
  normalizeOmpEvalImages,
  readOmpEvalEnvelope,
  boundOmpEvalReplies,
} from "@t3tools/shared/ompEval";
import type { NativeRecord } from "./turnController.ts";
export const nativeObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export function nativeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .flatMap((v) =>
        nativeObject(v) && v.type === "text" && typeof v.text === "string" ? [v.text] : [],
      )
      .join("\n");
  return nativeObject(value) ? nativeText(value.content) : "";
}
export interface OmpToolProjection {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly kind:
    | "dynamic_tool"
    | "command_execution"
    | "file_change"
    | "file_search"
    | "web_search";
  readonly complete: boolean;
  readonly failed: boolean;
  readonly revision: number;
  readonly fileName?: string;
  readonly toolSurface?: "browser" | "computer";
  readonly pattern?: string;
  readonly results?: readonly { fileName: string }[];
  readonly changes?: readonly { path: string; operation: string; oldPath?: string }[];
  readonly exitCode?: number;
  readonly diffStr?: string;
  readonly oldStr?: string;
  readonly newStr?: string;
  readonly patterns?: readonly string[];
  readonly webResults?: readonly { title?: string; url?: string; snippet?: string }[];
}
// OMP calls a mounted tool by writing its JSON arguments to `xd://<tool>`; show that call as the
// tool itself, the same target runtimePolicyHooks approves, so clients can render its result.
function deviceCall(name: string, input: unknown) {
  if (name !== "write" || !nativeObject(input) || typeof input.content !== "string") return;
  const path = typeof input.path === "string" ? input.path : "";
  const tool = /^xd:\/\/([A-Za-z0-9_.-]{1,128})$/.exec(path)?.[1];
  if (tool === undefined) return;
  let args: unknown;
  try {
    args = JSON.parse(input.content);
  } catch {
    return;
  }
  return nativeObject(args) ? { name: tool, input: args } : undefined;
}
export class OmpToolItems {
  private readonly items = new Map<string, OmpToolProjection>();
  update(event: NativeRecord): OmpToolProjection | undefined {
    if (typeof event.toolCallId !== "string") return;
    const old = this.items.get(event.toolCallId);
    if (old?.complete) return old;
    const nativeName =
      typeof event.toolName === "string" ? event.toolName : (old?.name ?? "unknown");
    const nativeInput = event.args ?? old?.input ?? {};
    const device = deviceCall(nativeName, nativeInput);
    const name = device?.name ?? nativeName;
    const input = device?.input ?? nativeInput;
    const complete = event.type === "tool_execution_end";
    const failed = event.isError === true;
    let output = complete ? event.result : (event.partialResult ?? old?.output);
    const revision = old ? old.revision + 1 : 0;
    if (name === "eval") {
      output = normalizeOmpEvalImages(output);
      if (!nativeObject(output)) output = { content: [] };
      const body = nativeObject(output) ? output : {};
      const details = nativeObject(body.details) ? body.details : {};
      const args = nativeObject(input) ? input : {};
      const cells = Array.isArray(details.cells) ? details.cells.filter(nativeObject) : [];
      const cell = cells.at(-1) ?? {};
      const events = [
        ...(Array.isArray(details.statusEvents) ? details.statusEvents : []),
        ...(Array.isArray(cell.statusEvents) ? cell.statusEvents : []),
      ].filter(nativeObject);
      const eventText = (v: Record<string, unknown>) =>
        [v.text, v.message, v.label, v.name].find((v): v is string => typeof v === "string");
      const phase = events
        .filter((v) => v.op === "phase")
        .map((v) => (typeof v.title === "string" ? v.title : undefined))
        .filter((v): v is string => v !== undefined)
        .at(-1);
      const logs = events
        .filter((v) => v.op === "log")
        .map(eventText)
        .filter((v): v is string => v !== undefined);
      const images = toolOutputImages(body),
        priorImages = toolOutputImages(old?.output);
      const imageChanged =
        images.length !== priorImages.length ||
        images.some(
          (image, index) =>
            image.mimeType !== priorImages[index]?.mimeType ||
            image.data !== priorImages[index]?.data,
        );
      const priorDetails =
        nativeObject(old?.output) && nativeObject(old.output.details) ? old.output.details : {};
      const repliesChanged =
        JSON.stringify(boundOmpEvalReplies(details.replies)) !==
        JSON.stringify(boundOmpEvalReplies(priorDetails.replies));
      const attachmentRevision =
        (readOmpEvalEnvelope(old?.output)?.attachmentRevision ?? 0) +
        (imageChanged || repliesChanged ? 1 : 0);
      output = {
        ...body,
        t3OmpEval: makeOmpEvalEnvelope({
          revision,
          images: images.map((image, index) => ({ index, mimeType: image.mimeType })),
          attachmentRevision,
          language:
            typeof args.language === "string"
              ? args.language
              : typeof cell.language === "string"
                ? cell.language
                : "unknown",
          status: complete ? (failed ? "failed" : "completed") : "running",
          title: ompEvalTitle(args.title, cell.title, args.language ?? cell.language),
          stdoutTail: typeof cell.output === "string" ? cell.output : nativeText(output),
          ...(phase ? { phase } : {}),
          ...(logs.length ? { logs } : {}),
          ...(typeof cell.durationMs === "number" ? { durationMs: cell.durationMs } : {}),
          ...(typeof cell.exitCode === "number" ? { exitCode: cell.exitCode } : {}),
          ...(!phase && typeof details.phase === "string" ? { phase: details.phase } : {}),
          ...(Array.isArray(details.logs)
            ? { logs: details.logs.filter((v): v is string => typeof v === "string") }
            : {}),
          ...(typeof details.durationMs === "number" ? { durationMs: details.durationMs } : {}),
          ...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}),
        }),
      };
    }
    const args = nativeObject(input) ? input : {};
    const path = typeof args.path === "string" ? args.path : undefined;
    const details = nativeObject(output) && nativeObject(output.details) ? output.details : {};
    const files = Array.isArray(details.perFileResults)
      ? details.perFileResults
      : typeof details.path === "string"
        ? [details]
        : [];
    const file = files.length && nativeObject(files[0]) ? files[0] : undefined;
    const changes = files
      .filter(nativeObject)
      .filter(
        (f) =>
          typeof f.path === "string" && f.path.length && !/^[a-z][a-z0-9+.-]*:\/\//i.test(f.path),
      )
      .map((f) => ({
        path: String(f.path),
        operation: typeof f.op === "string" ? f.op : "update",
        ...(typeof f.sourcePath === "string" ? { oldPath: f.sourcePath } : {}),
      }));
    const fileName =
      path ??
      (typeof details.path === "string" ? details.path : undefined) ??
      (file && typeof file.path === "string" ? file.path : undefined);
    const local = fileName !== undefined && !/^[a-z][a-z0-9+.-]*:\/\//i.test(fileName);
    const kind =
      name === "web_search"
        ? "web_search"
        : ["grep", "find"].includes(name)
          ? "file_search"
          : name === "bash"
            ? "command_execution"
            : complete && !failed && local && ["edit", "write"].includes(name)
              ? "file_change"
              : "dynamic_tool";
    const diff = typeof details.diff === "string" ? details.diff : undefined;
    const result: OmpToolProjection = {
      id: event.toolCallId,
      name,
      input,
      output,
      kind,
      complete,
      failed,
      revision,
      ...(fileName ? { fileName } : {}),
      ...(changes.length ? { changes } : {}),
      ...(typeof details.oldText === "string" ? { oldStr: details.oldText } : {}),
      ...(typeof details.newText === "string" ? { newStr: details.newText } : {}),
      ...(kind === "web_search"
        ? {
            patterns: typeof args.query === "string" ? [args.query] : [],
            webResults:
              nativeObject(details.response) && Array.isArray(details.response.sources)
                ? details.response.sources.filter(nativeObject).map((source) => ({
                    ...(typeof source.title === "string" ? { title: source.title } : {}),
                    ...(typeof source.url === "string" && source.url ? { url: source.url } : {}),
                    ...(typeof source.snippet === "string" ? { snippet: source.snippet } : {}),
                  }))
                : [],
          }
        : {}),
      ...(["browser", "computer"].includes(name)
        ? { toolSurface: name as "browser" | "computer" }
        : {}),
      ...(typeof args.pattern === "string" ? { pattern: args.pattern } : {}),
      ...(kind === "file_search" && Array.isArray(details.files)
        ? {
            results: details.files
              .filter((v): v is string => typeof v === "string" && v.length > 0)
              .map((fileName) => ({ fileName })),
          }
        : {}),
      ...(typeof details.exitCode === "number" && Number.isSafeInteger(details.exitCode)
        ? { exitCode: details.exitCode }
        : {}),
      ...(diff !== undefined ? { diffStr: diff } : {}),
    };
    this.items.set(result.id, result);
    return result;
  }
}
