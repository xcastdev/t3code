import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WebSearchMcpService from "../../WebSearchMcpService.ts";

const WebSearchTool = Tool.make("t3_web_search", {
  description:
    "Search the web with a model that has live web search and get a sourced answer. Use it for current or external information you can't find in the workspace.",
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).annotate({
      description: "The question or search query.",
    }),
    instructions: Schema.optional(
      Schema.String.check(Schema.isMaxLength(2000)).annotate({
        description: "What to find out or how to answer.",
      }),
    ),
  }),
  success: Schema.Struct({
    answer: Schema.String,
    sources: Schema.Array(Schema.Struct({ title: Schema.String, url: Schema.String })),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    WebSearchMcpService.WebSearchMcpService,
  ],
})
  .annotate(Tool.Title, "Web search")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleWhileWebSearchOn);

export const WebSearchToolkit = Toolkit.make(WebSearchTool);
