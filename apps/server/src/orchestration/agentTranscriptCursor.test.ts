import { EventId, RuntimeAgentKey, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeAgentTranscriptCursor,
  encodeAgentTranscriptCursor,
} from "./agentTranscriptCursor.ts";

describe("agent transcript cursor", () => {
  it("round trips a composite seek boundary scoped to one agent", () => {
    const threadId = ThreadId.make("cursor-thread");
    const agentKey = RuntimeAgentKey.make("cursor-agent");
    const beforeActivityId = EventId.make("cursor-activity");
    const encoded = encodeAgentTranscriptCursor({
      threadId,
      agentKey,
      beforeEventSequence: 42,
      beforeActivityId,
    });

    expect(encoded.length).toBeLessThan(512);
    expect(decodeAgentTranscriptCursor(encoded, threadId, agentKey)).toEqual({
      beforeEventSequence: 42,
      beforeActivityId,
    });
    expect(
      decodeAgentTranscriptCursor(encoded, threadId, RuntimeAgentKey.make("other-agent")),
    ).toBeNull();
  });
});
