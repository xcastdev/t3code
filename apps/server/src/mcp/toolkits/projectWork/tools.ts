import {
  McpCapabilityUnavailableError,
  ProjectWorkReadIntent,
  ProjectWorkWriteIntent,
  ProjectWorkWriteResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectWorkGateway from "../../../projectWork/ProjectWorkGateway.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

/**
 * MCP requires the top-level tool schema to be an object. Project-work writes
 * are a tagged union, so expose the union through an object-shaped JSON codec
 * while retaining strict command validation for the handler.
 */
const ProjectWorkWriteParameters = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.decodeTo(
    ProjectWorkWriteIntent,
    SchemaTransformation.transformOrFail({
      // The contract package owns this schema and therefore its generated
      // ParseError carries the package-local Effect type; the runtime codec is
      // identical, so keep the cross-package transformation boundary opaque.
      decode: (input) => Schema.decodeUnknownEffect(ProjectWorkWriteIntent)(input) as never,
      encode: (input) => Effect.succeed(input),
    }),
  ),
);

export class ProjectWorkToolError extends Schema.TaggedError<ProjectWorkToolError>()(
  "ProjectWorkToolError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export const ProjectWorkToolkitError = Schema.Union([
  McpCapabilityUnavailableError,
  ProjectWorkToolError,
]);
export type ProjectWorkToolkitError = typeof ProjectWorkToolkitError.Type;

const ProjectWorkReadTool = Tool.make("project_work_read", {
  description:
    "Read authoritative project-work state. Use task-context for one bounded actionable task view; collection reads can request a revision-bearing envelope. Read memory-sources with the assigned task and cursor for exact retained source selectors, including historical cleanup identified by its reason.",
  parameters: ProjectWorkReadIntent,
  success: Schema.Unknown,
  failure: ProjectWorkToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Read project work")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ProjectWorkWriteTool = Tool.make("project_work_write", {
  description:
    "Append one authorized intent. To ask a human, use project-team.question.request with commandId, projectId, taskId, expectedRevision, expectedTaskRevision, specRevision, planRevision, questionId, targetGateId, expectedGateRevision, body and choices. Read current task-context revisions first. Sender identity is server-derived and the human answer is retained; it does not approve a gate. To message a teammate, use project-team.message.send with those task revisions plus messageId, recipientId, recipientTaskId, expectedRecipientMembershipRevision, body, evidenceIds and optional replyTo. Select an explicit current member/task address from private prepared context. Messages grant no approval or new work. To select memory processing, submit project-team.memory.process with current task revisions and the exact returned selection. Historical cleanup deletes only that captured source and makes no model calls; select it explicitly rather than funding obsolete indexing. Never supply an owner, model or limits. Ownerless, stopped or disabled sources wait; selection grants no new work. To search semantically, submit project-team.memory.query with current assigned-task revisions and an exact nonempty query of at most 8 KiB. The original running operation funds embedding and search; never supply a vector, owner, model or limits. Completed authenticated results can enter later prepared context; context keeps lexical fallback without waiting. Protected revisions require a matching single-use human approval token.",
  parameters: ProjectWorkWriteParameters,
  success: ProjectWorkWriteResult,
  failure: ProjectWorkToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Write project work")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ProjectWorkToolkit = Toolkit.make(ProjectWorkReadTool, ProjectWorkWriteTool);
