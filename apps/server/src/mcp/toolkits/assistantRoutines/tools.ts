import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  AssistantRoutineReadInput,
  AssistantRoutineReadResult,
  AssistantRoutineWriteInput,
  AssistantRoutineWriteResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import { AssistantRoutineGateway } from "../../../assistants/AssistantRoutineGateway.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [AssistantRoutineGateway, McpInvocationContext, ThreadManagementService],
};
const read = Tool.make("t3_assistant_routines_read", {
  ...shared,
  description:
    "Read bounded routines and exact dispatch/execution outcomes for this canonical assistant. Delegated children and sibling assistants cannot access the routine owner.",
  parameters: AssistantRoutineReadInput,
  success: AssistantRoutineReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const write = Tool.make("t3_assistant_routines_write", {
  ...shared,
  description:
    "Create, edit, pause, remove, or explicitly run an assistant routine on the existing scheduler. Configuration changes do not start inference; run-now requires a stable command ID. Routines stay bound to the same canonical assistant thread.",
  parameters: AssistantRoutineWriteInput,
  success: AssistantRoutineWriteResult,
}).annotate(Tool.Destructive, true);
export const AssistantRoutineToolkit = Toolkit.make(read, write);
