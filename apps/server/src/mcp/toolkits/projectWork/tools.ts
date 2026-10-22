import * as Work from "@t3tools/contracts";
import {
  OrchestratorMcpFailure,
  ProjectWorkReadIntent,
  ProjectWorkWriteResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Gateway from "../../../projectWork/ProjectWorkGateway.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Gateway.ProjectWorkGateway,
    Invocation.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const read = Tool.make("t3_project_work_read", {
  ...shared,
  description:
    "Read human Work tasks, criteria, evidence, relationships, blockers, decisions, comments, knowledge, attention, activities, checkpoints, search, briefings and exports. Collection pages contain at most 128 records; request envelope=true for revision and pagination metadata. A thread caller can access only its own project. Team records and pending questions are readable through foundation-records; supervision returns bounded team metadata. Verification and memory are unavailable.",
  parameters: Schema.Struct({
    ...ProjectWorkReadIntent.fields,
    operation: Schema.Literals([
      "foundation-records",
      "supervision",
      "snapshot",
      "task",
      "task-context",
      "tasks",
      "criteria",
      "evidence",
      "relationships",
      "blockers",
      "attention",
      "activities",
      "checkpoints",
      "knowledge",
      "decisions",
      "comments",
      "search",
      "briefing",
      "export-json",
      "export-markdown",
    ]),
  }),
  success: Schema.Unknown,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const write = Tool.make("t3_project_work_write", {
  ...shared,
  description:
    "Record human Work task planning, specification, criteria, evidence, dependencies, blockers, decisions, comments and knowledge. Reuse commandId and identical payload to retry; expectedRevision rejects stale edits. Attribution is assigned from your actual MCP session. Human approvals remain human-only. Current managed workers can send scoped messages, ask questions, propose their planning output and report their own assignment. Human approvals, dispatch, memory and publication are unavailable through this tool.",
  parameters: Schema.Struct({
    intent: Schema.Union([
      Work.ProjectWorkTaskCreateCommand,
      Work.ProjectWorkTaskSpecifyCommand,
      Work.ProjectWorkTaskReviseProtectedSpecificationCommand,
      Work.ProjectWorkTaskReadyCommand,
      Work.ProjectWorkTaskBlockCommand,
      Work.ProjectWorkTaskResolveBlockerCommand,
      Work.ProjectWorkTaskReopenCommand,
      Work.ProjectWorkTaskCancelCommand,
      Work.ProjectWorkTaskDuplicateCommand,
      Work.ProjectWorkTaskApproveCommand,
      Work.ProjectWorkTaskWatchCommand,
      Work.ProjectWorkTaskUnwatchCommand,
      Work.ProjectWorkTaskProtectSpecificationCommand,
      Work.ProjectWorkCriterionUpsertCommand,
      Work.ProjectWorkCriterionWaiveCommand,
      Work.ProjectWorkEvidenceAddCommand,
      Work.ProjectWorkRelationshipLinkCommand,
      Work.ProjectWorkRelationshipUnlinkCommand,
      Work.ProjectWorkKnowledgePromoteCommand,
      Work.ProjectWorkDecisionProposeCommand,
      Work.ProjectWorkDecisionAcceptCommand,
      Work.ProjectWorkDecisionRejectCommand,
      Work.ProjectWorkDecisionSupersedeCommand,
      Work.ProjectWorkCommentAddCommand,
      Work.ProjectWorkAttentionSeenCommand,
      Work.ProjectTeamWriteIntent.check(
        Schema.makeFilter(
          (intent) =>
            intent.type === "project-team.message.send" ||
            intent.type === "project-team.question.request",
        ),
      ),
      Work.ProjectTeamGuidedIntent.check(
        Schema.makeFilter(
          (intent) =>
            intent.type === "project-team.assignment.report" ||
            intent.type === "project-team.plan.propose",
        ),
      ),
    ]),
  }),
  success: ProjectWorkWriteResult,
}).annotate(Tool.Destructive, true);
export const ProjectWorkToolkit = Toolkit.make(read, write);
