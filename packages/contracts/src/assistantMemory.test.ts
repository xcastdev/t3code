import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  AssistantMemoryReadInput,
  AssistantMemoryReadResult,
  AssistantMemoryWriteInput,
} from "./assistantMemory.ts";
const acceptsRead = Schema.is(AssistantMemoryReadInput);
const acceptsReadResult = Schema.is(AssistantMemoryReadResult);
const acceptsWrite = Schema.is(AssistantMemoryWriteInput);

it("recipient metadata requires explicit owner identity and owner revision independently of memory facts", () => {
  const scope = { environmentId: "env", assistantId: "source" };
  for (const owner of [
    { kind: "assistant", assistantId: "empty" },
    { kind: "project", projectId: "empty" },
  ]) {
    assert.isTrue(acceptsRead({ ...scope, operation: "recipient", recipient: owner }));
    assert.isTrue(
      acceptsReadResult({
        operation: "recipient",
        environmentId: "env",
        owner,
        ownerRevision: 0,
        title: "Empty recipient",
      }),
    );
    assert.isFalse(
      acceptsReadResult({
        operation: "recipient",
        environmentId: "env",
        owner,
        revision: 0,
        title: "Empty recipient",
      }),
    );
  }
  assert.isFalse(acceptsRead({ ...scope, operation: "recipient" }));
});

it("confirmation pages stay bounded and explicit confirmation requires the reviewed source hash and revisions", () => {
  const scope = { environmentId: "env", assistantId: "source" };
  assert.isTrue(acceptsRead({ ...scope, operation: "confirmations", limit: 32 }));
  assert.isFalse(acceptsRead({ ...scope, operation: "confirmations", limit: 33 }));
  const source = {
    sourceId: "reviewed",
    sourceRevision: 1,
    generation: 1,
    contentHash: "0".repeat(64),
  };
  assert.isTrue(acceptsWrite({ ...scope, operation: "confirm", source }));
  assert.isFalse(acceptsWrite({ ...scope, operation: "confirm" }));
  assert.isFalse(
    acceptsWrite({ ...scope, operation: "confirm", source: { ...source, contentHash: "changed" } }),
  );
  assert.isFalse(acceptsWrite({ ...scope, operation: "confirm-all" }));
});
