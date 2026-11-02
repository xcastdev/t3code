import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ViewImageMcpService from "../../ViewImageMcpService.ts";

const ViewImageTool = Tool.make("t3_view_image", {
  description:
    "Ask a vision model to look at an image file and describe it. Use it when you can't view images yourself. Returns the model's description.",
  parameters: Schema.Struct({
    instructions: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)).annotate({
      description: "What to look for or describe.",
    }),
    path: Schema.String.check(Schema.isMinLength(1)).annotate({
      description:
        "PNG, JPEG, WebP or GIF up to 10 MiB, relative to your workspace or absolute inside it.",
    }),
  }),
  success: Schema.Struct({ description: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    ViewImageMcpService.ViewImageMcpService,
  ],
})
  .annotate(Tool.Title, "View image")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleWhileViewImageOn);

export const ViewImageToolkit = Toolkit.make(ViewImageTool);
