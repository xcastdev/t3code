import { EventId, RuntimeAgentKey, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeAgentTranscriptCursor,
  encodeAgentTranscriptCursor,
} from "./agentTranscriptCursor.ts";

describe("agent transcript cursor", () => {
  it("round trips independent native, revision, and chronological boundaries", () => {
    const threadId = ThreadId.make("cursor-thread");
    const agentKey = RuntimeAgentKey.make("cursor-agent");
    const encoded = encodeAgentTranscriptCursor({
      threadId,
      agentKey,
      beforeProviderOrderKey: "2026-09-01T00:00:00.000Z:message-42",
      beforeNativeEntryId: "claude:child-42:block-0",
      nativeSourceCursor: "43",
      nativeSourceComplete: false,
      revisionWatermark: 902,
    });

    expect(encoded.length).toBeLessThan(2048);
    expect(decodeAgentTranscriptCursor(encoded, threadId, agentKey)).toEqual({
      beforeProviderOrderKey: "2026-09-01T00:00:00.000Z:message-42",
      beforeNativeEntryId: "claude:child-42:block-0",
      nativeSourceCursor: "43",
      nativeSourceComplete: false,
      revisionWatermark: 902,
    });
    expect(
      decodeAgentTranscriptCursor(encoded, threadId, RuntimeAgentKey.make("other-agent")),
    ).toBeNull();
  });

  it("decodes legacy sequence/activity cursors without treating sequence as chronology", () => {
    const threadId = ThreadId.make("cursor-thread");
    const agentKey = RuntimeAgentKey.make("cursor-agent");
    const activityId = EventId.make("cursor-activity");
    const current = encodeAgentTranscriptCursor({ threadId, agentKey });
    const hash = Buffer.from(current, "base64url")
      .toString("utf8")
      .match(/"h":"([^"]+)"/)?.[1];
    expect(hash).toBeDefined();
    if (hash === undefined) throw new Error("The scoped cursor hash was not encoded.");

    const legacy = Buffer.from(`{"v":1,"s":42,"i":"${activityId}","h":"${hash}"}`).toString(
      "base64url",
    );

    expect(decodeAgentTranscriptCursor(legacy, threadId, agentKey)).toEqual({
      beforeEventSequence: 42,
      beforeActivityId: activityId,
      legacy: true,
    });
  });
});
