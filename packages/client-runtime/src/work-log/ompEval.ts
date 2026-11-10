import * as Schema from "effect/Schema";
import { turnItemOutputText } from "./itemDetail.ts";
import { AssetResource, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  boundOmpText,
  boundOmpEvalReplies,
  decodeOmpEvalDetail,
  mergeOmpEvalPreview,
  ompEvalHydration,
  readOmpEvalEnvelope,
  isOmpArtifactId,
  ompArtifactReferences,
} from "@t3tools/shared/ompEval";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const languageName = (language: string) => {
  switch (language.toLowerCase()) {
    case "py":
    case "python":
      return "python";
    case "js":
    case "javascript":
      return "javascript";
    default:
      return language.toLowerCase() || "text";
  }
};

export function decodeOmpEval(input: unknown, output: unknown, verifiedNative = false) {
  const args = record(input);
  const native = record(record(output).details);
  const envelope = readOmpEvalEnvelope(output);
  const nativeShape =
    typeof args.code === "string" &&
    (Array.isArray(native.cells) ||
      typeof native.stdout === "string" ||
      Array.isArray(record(output).content));
  if (!envelope && !nativeShape && !(verifiedNative && typeof output === "string")) return;
  const detail = decodeOmpEvalDetail(output, input, verifiedNative || nativeShape);
  if (!detail) return;
  const cells = Array.isArray(native.cells) ? native.cells.map(record).slice(0, 8) : [];
  const language = languageName(text(args.language) || detail.language);
  const bodyAvailable =
    typeof native.stdout === "string" ||
    Array.isArray(record(output).content) ||
    cells.some((cell) => typeof cell.output === "string");
  const phase = envelope?.phase;
  const logs = [...new Set(envelope?.logs ?? [])].slice(-16);
  return {
    ...detail,
    fallbackOutput: undefined as string | undefined,
    language,
    title: boundOmpText(
      text(detail.title) ||
        (language === "python"
          ? "Python eval"
          : language === "javascript"
            ? "JavaScript eval"
            : "Eval"),
      640,
    ),
    stdout: bodyAvailable
      ? detail.stdout
      : (envelope?.stdoutTail ?? (typeof output === "string" ? boundOmpText(output, 65536) : "")),
    outputAvailable:
      bodyAvailable || envelope?.stdoutTail !== undefined || typeof output === "string",
    phase: phase ? boundOmpText(phase, 640) : undefined,
    logs,
    durationMs: envelope?.durationMs,
    exitCode: envelope?.exitCode,
    attachmentRevision: envelope?.attachmentRevision,
    // Views remain data; clients never interpret native markup or execute it.
    views: detail.cells.flatMap((cell) => cell.views ?? []),
  };
}
export type OmpEvalView = NonNullable<ReturnType<typeof decodeOmpEval>>;
const liveItemStatuses: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "idle",
  "pending",
  "running",
  "waiting",
]);

function isOmpEvalItem(item: OrchestrationV2TurnItem) {
  return (
    item.type === "dynamic_tool" && item.toolName === "eval" && item.nativeItemRef?.driver === "omp"
  );
}
export function decodeOmpEvalItem(item: OrchestrationV2TurnItem) {
  if (!isOmpEvalItem(item) || item.type !== "dynamic_tool") return;
  return decodeOmpEval(item.input, item.output, true);
}

export function mergeOmpEvalDetail(
  wireItem: OrchestrationV2TurnItem,
  fetchedItem?: OrchestrationV2TurnItem | null,
  previousFetchedItem?: OrchestrationV2TurnItem | null,
) {
  if (!isOmpEvalItem(wireItem) || wireItem.type !== "dynamic_tool") return;
  const wireView = decodeOmpEvalItem(wireItem);
  if (!wireView) return;
  const matches = (candidate: OrchestrationV2TurnItem | null | undefined) =>
    candidate?.type === "dynamic_tool" &&
    isOmpEvalItem(candidate) &&
    candidate.id === wireItem.id &&
    candidate.threadId === wireItem.threadId &&
    candidate.nativeItemRef?.nativeId === wireItem.nativeItemRef?.nativeId &&
    candidate.nativeItemRef?.fingerprint === wireItem.nativeItemRef?.fingerprint
      ? candidate
      : undefined;
  const current = matches(fetchedItem);
  const previous = matches(previousFetchedItem);
  const previousLifecycleWins =
    previous &&
    current &&
    !liveItemStatuses.has(previous.status) &&
    liveItemStatuses.has(current.status) &&
    readOmpEvalEnvelope(previous.output)?.revision ===
      readOmpEvalEnvelope(current.output)?.revision;
  const fetched =
    previous &&
    (!current ||
      previousLifecycleWins ||
      mergeOmpEvalPreview(previous.output, current.output) === previous.output)
      ? previous
      : current;
  const terminal = !liveItemStatuses.has(wireItem.status);
  const hydration =
    !wireItem.outputOmitted && !fetched
      ? terminal
        ? ompEvalHydration(wireItem.output, wireItem.output, true, true)
        : "settled"
      : fetched?.outputOmitted !== true
        ? ompEvalHydration(
            wireItem.output,
            fetched?.output,
            terminal,
            fetched !== undefined && !liveItemStatuses.has(fetched.status),
          )
        : "load";
  const selected =
    hydration === "settled"
      ? fetched?.output
      : mergeOmpEvalPreview(wireItem.output, fetched?.output);
  const output = selected ?? wireItem.output;
  const fetchedInput = record(fetched?.input);
  const input =
    typeof fetchedInput.code === "string" && fetchedInput.truncated !== true
      ? fetched?.input
      : wireItem.input;
  const decoded = decodeOmpEval(input, output, true) ?? wireView;
  const fetchedNative = record(record(fetched?.output).details);
  const retainReplies =
    wireItem.outputOmitted === true && output === wireItem.output && fetched !== undefined;
  const replies = retainReplies
    ? boundOmpEvalReplies(fetchedNative.replies)
    : { replies: decoded.replies, repliesOmitted: decoded.repliesOmitted };
  const repliesOmitted =
    replies.repliesOmitted || (retainReplies && fetchedNative.repliesOmitted === true);
  const status =
    terminal && (decoded.status === "running" || decoded.status === "unknown")
      ? wireItem.status === "completed"
        ? "completed"
        : wireItem.status === "failed"
          ? "failed"
          : "cancelled"
      : decoded.status;
  return {
    item: { ...wireItem, input, output },
    detailItem: fetched,
    hydration,
    view: {
      ...decoded,
      replies: replies.replies,
      repliesOmitted,
      status,
      artifacts:
        !decoded.artifacts.length && wireItem.outputOmitted && output === wireItem.output && fetched
          ? ompArtifactReferences(fetched.output)
          : decoded.artifacts,
      fallbackOutput:
        hydration === "fallback" && fetched
          ? boundOmpText(turnItemOutputText(fetched) ?? "", 65536)
          : undefined,
      outputTruncated: decoded.outputTruncated || repliesOmitted || hydration === "fallback",
    },
  };
}

const decodeArtifactResource = Schema.decodeUnknownOption(AssetResource);

export function ompEvalArtifacts(
  item: OrchestrationV2TurnItem,
  artifacts: OmpEvalView["artifacts"],
) {
  return artifacts.map((artifact) => {
    const id = artifact.id ?? "";
    const candidate = {
      _tag: "provider-output-artifact" as const,
      threadId: item.threadId,
      turnItemId: item.id,
      artifactId: id,
    };
    const resource =
      isOmpEvalItem(item) &&
      isOmpArtifactId(id) &&
      decodeArtifactResource(candidate)._tag === "Some"
        ? candidate
        : null;
    return {
      key: JSON.stringify(artifact),
      label: artifact.title || artifact.name || "Full output",
      name: "output-" + id + ".txt",
      resource,
    };
  });
}
