import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AssistantMemoryToolkit } from "./tools.ts";

const acceptsRead = Schema.is(
  AssistantMemoryToolkit.tools.t3_assistant_memory_read.parametersSchema,
);
const acceptsWrite = Schema.is(
  AssistantMemoryToolkit.tools.t3_assistant_memory_write.parametersSchema,
);
it("the provider catalog exposes current native memory reads and forget without human-only confirmation or recipient discovery", () => {
  const scope = { environmentId: "env", assistantId: "assistant" };
  for (const operation of ["list", "context", "status"])
    assert.isTrue(acceptsRead({ ...scope, operation }));
  for (const operation of ["recipient", "confirmations", "grants", "configuration"])
    assert.isFalse(
      acceptsRead({ ...scope, operation, recipient: { kind: "project", projectId: "project" } }),
    );
  const source = {
    sourceId: "source",
    sourceRevision: 0,
    generation: 0,
    contentHash: "0".repeat(64),
  };
  assert.isTrue(acceptsWrite({ ...scope, operation: "forget", source }));
  for (const operation of ["confirm", "reteach", "grant", "edit", "configure"])
    assert.isFalse(acceptsWrite({ ...scope, operation, source }));
});
