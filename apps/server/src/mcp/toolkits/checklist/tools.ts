import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CHECKLIST_STATUSES } from "./checklist.ts";

const ChecklistTool = Tool.make("t3_checklist", {
  description:
    "Your checklist for this chat, shown to the user as you work. Use it for work with 3 or more steps. create: list `steps` in order; replaces any checklist and starts step 1. update: set `step` to `status`; marking a step done starts the next one. clear: remove it. Every call returns the checklist with step numbers.",
  parameters: Schema.Struct({
    action: Schema.Literals(["create", "update", "clear"]),
    steps: Schema.optional(
      Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)))
        .check(Schema.isMinLength(1), Schema.isMaxLength(30))
        .annotate({ description: "create only. Short, in order." }),
    ),
    step: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "update only. The step's number, starting at 1.",
      }),
    ),
    status: Schema.optional(
      Schema.Literals(CHECKLIST_STATUSES).annotate({ description: "update only." }),
    ),
  }),
  success: Schema.Struct({ checklist: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Checklist")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)
  // Harnesses with their own checklist tool never see this one.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleWithCapability("checklist"));

export const ChecklistToolkit = Toolkit.make(ChecklistTool);
