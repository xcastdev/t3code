import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  AssistantId,
  EnvironmentId,
  PositiveInt,
  TrimmedNonEmptyString,
  AssistantMemorySourceSelector,
  AssistantMemoryReadResult,
  AssistantMemoryWriteResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import { AssistantMemoryGateway } from "../../../assistants/AssistantMemoryGateway.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [AssistantMemoryGateway, McpInvocationContext, ThreadManagementService],
};
const read = Tool.make("t3_assistant_memory_read", {
  ...shared,
  description:
    "Read bounded retained assistant memory, current SQL recall and processing status. A native assistant session can read only its canonical home's current memory; children and sibling assistants are denied.",
  parameters: Schema.Struct({
    environmentId: EnvironmentId,
    assistantId: AssistantId,
    operation: Schema.Literals(["list", "context", "status"]),
    cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
    limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(32))),
  }),
  success: AssistantMemoryReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const write = Tool.make("t3_assistant_memory_write", {
  ...shared,
  description:
    "Forget a retained current source from the canonical assistant's own memory. Forgetting leaves visible conversation history intact. Human-only correction, confirmation, sharing and configuration controls are available in the client.",
  parameters: Schema.Struct({
    environmentId: EnvironmentId,
    assistantId: AssistantId,
    operation: Schema.Literal("forget"),
    source: AssistantMemorySourceSelector,
  }),
  success: AssistantMemoryWriteResult,
}).annotate(Tool.Destructive, true);
export const AssistantMemoryToolkit = Toolkit.make(read, write);
