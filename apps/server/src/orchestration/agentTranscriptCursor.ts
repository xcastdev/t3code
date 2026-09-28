import { EventId, type RuntimeAgentKey, type ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

const isEventId = Schema.is(EventId);

export interface AgentTranscriptCursor {
  readonly beforeEventSequence: number;
  readonly beforeActivityId?: EventId;
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
      s: cursor.beforeEventSequence,
      ...(cursor.beforeActivityId === undefined ? {} : { i: cursor.beforeActivityId }),
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
  if (
    typeof record.s !== "number" ||
    !Number.isSafeInteger(record.s) ||
    record.s < 0 ||
    (record.i !== undefined && (typeof record.i !== "string" || !isEventId(record.i))) ||
    record.h !== scopeHash(threadId, agentKey)
  ) {
    return null;
  }
  return {
    beforeEventSequence: record.s,
    ...(typeof record.i === "string" && isEventId(record.i) ? { beforeActivityId: record.i } : {}),
  };
}
