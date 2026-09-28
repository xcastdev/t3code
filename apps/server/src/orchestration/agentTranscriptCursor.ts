import { EventId, type RuntimeAgentKey, type ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

const isEventId = Schema.is(EventId);

export interface AgentTranscriptCursor {
  /** Legacy persisted-activity boundary. Kept only to decode version-1 cursors. */
  readonly beforeEventSequence?: number;
  readonly beforeActivityId?: EventId;
  /** Native chronology boundary; independent from persisted revision sequence. */
  readonly beforeProviderOrderKey?: string;
  readonly beforeNativeEntryId?: string;
  /** Provider-owned pagination cursor (Claude offset or OpenCode cursor). */
  readonly nativeSourceCursor?: string;
  readonly nativeSourceComplete?: boolean;
  /** Latest durable event receipt included in the native source walk. */
  readonly revisionWatermark?: number;
  readonly legacy?: boolean;
  readonly malformedLegacyBoundary?: boolean;
}

const scopeHash = (threadId: ThreadId, agentKey: RuntimeAgentKey) =>
  NodeCrypto.createHash("sha256").update(`${threadId}\u0000${agentKey}`).digest("base64url");

export function encodeAgentTranscriptCursor(
  cursor: AgentTranscriptCursor & {
    readonly threadId: ThreadId;
    readonly agentKey: RuntimeAgentKey;
  },
): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      ...(cursor.beforeEventSequence === undefined ? {} : { s: cursor.beforeEventSequence }),
      ...(cursor.beforeActivityId === undefined ? {} : { i: cursor.beforeActivityId }),
      ...(cursor.beforeProviderOrderKey === undefined ? {} : { o: cursor.beforeProviderOrderKey }),
      ...(cursor.beforeNativeEntryId === undefined ? {} : { n: cursor.beforeNativeEntryId }),
      ...(cursor.nativeSourceCursor === undefined ? {} : { p: cursor.nativeSourceCursor }),
      ...(cursor.nativeSourceComplete === undefined ? {} : { c: cursor.nativeSourceComplete }),
      ...(cursor.revisionWatermark === undefined ? {} : { w: cursor.revisionWatermark }),
      h: scopeHash(cursor.threadId, cursor.agentKey),
    }),
  ).toString("base64url");
}

/** Malformed or foreign cursors are ignored and degrade to a first-page read. */
export function decodeAgentTranscriptCursor(
  encoded: string,
  threadId: ThreadId,
  agentKey: RuntimeAgentKey,
): AgentTranscriptCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.h !== scopeHash(threadId, agentKey)) {
    return null;
  }
  if (record.v === 2) {
    if (
      (record.s !== undefined &&
        (typeof record.s !== "number" || !Number.isSafeInteger(record.s) || record.s < 0)) ||
      (record.i !== undefined && (typeof record.i !== "string" || !isEventId(record.i))) ||
      (record.o !== undefined && (typeof record.o !== "string" || record.o.length > 256)) ||
      (record.n !== undefined && (typeof record.n !== "string" || record.n.length > 256)) ||
      (record.p !== undefined && (typeof record.p !== "string" || record.p.length > 1000)) ||
      (record.c !== undefined && typeof record.c !== "boolean") ||
      (record.w !== undefined &&
        (typeof record.w !== "number" || !Number.isSafeInteger(record.w) || record.w < 0))
    ) {
      return null;
    }
    return {
      ...(typeof record.s === "number" ? { beforeEventSequence: record.s } : {}),
      ...(typeof record.i === "string" && isEventId(record.i)
        ? { beforeActivityId: record.i }
        : {}),
      ...(typeof record.o === "string" ? { beforeProviderOrderKey: record.o } : {}),
      ...(typeof record.n === "string" ? { beforeNativeEntryId: record.n } : {}),
      ...(typeof record.p === "string" ? { nativeSourceCursor: record.p } : {}),
      ...(typeof record.c === "boolean" ? { nativeSourceComplete: record.c } : {}),
      ...(typeof record.w === "number" ? { revisionWatermark: record.w } : {}),
    };
  }
  if (
    typeof record.s !== "number" ||
    !Number.isSafeInteger(record.s) ||
    record.s < 0 ||
    (record.i !== undefined && (typeof record.i !== "string" || !isEventId(record.i)))
  ) {
    return null;
  }
  return {
    beforeEventSequence: record.s,
    ...(typeof record.i === "string" && isEventId(record.i) ? { beforeActivityId: record.i } : {}),
    legacy: true,
  };
}
