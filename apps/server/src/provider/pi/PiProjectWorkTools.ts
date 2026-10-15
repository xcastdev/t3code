import {
  CommandId,
  ProjectId,
  ProjectWorkReadIntent,
  ProjectWorkTaskId,
  ProjectWorkWriteIntent,
  type ProjectTeamGuidedIntent,
  type ProjectWorkAttribution,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { ProjectTeamPrincipal } from "../../projectWork/ProjectTeamAuthorization.ts";
import { ProjectWorkGateway } from "../../projectWork/ProjectWorkGateway.ts";
import type { PiModelTool } from "./PiModelBroker.ts";

export const piProjectWorkToolCapabilities = Object.freeze([
  "project-work.read-project",
  "project-work.read-task",
  "project-work.write",
  "project-work.report",
  "project-work.plan",
] as const);
type Capability = (typeof piProjectWorkToolCapabilities)[number];

export class PiProjectWorkToolValidationError extends Schema.TaggedError<PiProjectWorkToolValidationError>()(
  "PiProjectWorkToolValidationError",
  {
    reason: Schema.Literals([
      "invalid-tool-lists",
      "invalid-report-context",
      "unknown-tool",
      "invalid-arguments",
      "invalid-intent",
      "intent-kind",
    ]),
  },
) {}

const strict = { onExcessProperty: "error" } as const;
const toolIds = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isTrimmed()),
).check(Schema.isMaxLength(64));
const decodeToolLists = Schema.decodeUnknownSync(
  Schema.Struct({
    roleTools: toolIds,
    bindingTools: toolIds,
    reportContext: Schema.optionalKey(Schema.Unknown),
  }),
  strict,
);
const NonNegativeRevision = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const ReportContext = Schema.Struct({
  projectId: ProjectId,
  taskId: ProjectWorkTaskId,
  sourceRevision: NonNegativeRevision,
  taskRevision: NonNegativeRevision,
  specRevision: NonNegativeRevision,
  planRevision: NonNegativeRevision,
  assignmentId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.isTrimmed(),
  ),
  assignmentRevision: NonNegativeRevision,
  commandId: CommandId,
});
export type PiProjectWorkReportContext = typeof ReportContext.Type;
const decodeReportContext = Schema.decodeUnknownSync(ReportContext, strict);
const writeEnvelope = Schema.Struct({
  intentJSON: Schema.String.check(Schema.isMaxLength(262144)),
});
const boundedEnvelope = writeEnvelope.check(
  Schema.makeFilter((input) => Buffer.byteLength(input.intentJSON, "utf8") <= 262144),
);
const decodeWriteEnvelope = Schema.decodeUnknownEffect(boundedEnvelope, strict);
const decodeReadIntent = Schema.decodeUnknownEffect(ProjectWorkReadIntent, strict);
const decodeWriteIntentJSON = Schema.decodeEffect(
  Schema.fromJsonString(ProjectWorkWriteIntent),
  strict,
);
const decodeJsonObject = Schema.decodeUnknownSync(Schema.JsonObject);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const freezeTree = (value: unknown): void => {
  if (!Predicate.isObjectOrArray(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
};
const readParameters = decodeJsonObject(Schema.toJsonSchemaDocument(ProjectWorkReadIntent).schema);
const writeParameters = decodeJsonObject(Schema.toJsonSchemaDocument(writeEnvelope).schema);
freezeTree(readParameters);
freezeTree(writeParameters);

const reportParametersFor = (context: PiProjectWorkReportContext) => {
  const template = {
    type: "project-team.assignment.report",
    projectId: context.projectId,
    taskId: context.taskId,
    commandId: context.commandId,
    expectedRevision: context.sourceRevision,
    expectedTaskRevision: context.taskRevision,
    specRevision: context.specRevision,
    planRevision: context.planRevision,
    assignmentId: context.assignmentId,
    expectedAssignmentRevision: context.assignmentRevision,
    summary: "<summary>",
    evidenceIds: [],
    outputArtifactIds: [],
    outcome: "findings",
  } satisfies ProjectTeamGuidedIntent;
  const parameters: unknown = JSON.parse(JSON.stringify(writeParameters));
  if (!isRecord(parameters) || !isRecord(parameters.properties))
    throw new Error("Pi report parameter schema is invalid");
  const intentJSON = parameters.properties.intentJSON;
  if (!isRecord(intentJSON)) throw new Error("Pi report intent parameter is invalid");
  intentJSON.description = JSON.stringify(template);
  return decodeJsonObject(parameters);
};

const reportDescription =
  "Report findings for the authorized assignment. Do not claim verification that was not performed. review-ready requires retained evidence. complete requires existing completion proof.";

/** Advertise only the intersection of the two frozen run configurations. */
export const preparePiProjectWorkTools = (input: {
  readonly roleTools: readonly string[];
  readonly bindingTools: readonly string[];
  readonly reportContext?: PiProjectWorkReportContext;
}): readonly { readonly tool: PiModelTool; readonly capability: Capability }[] => {
  const snapshot = (() => {
    try {
      return decodeToolLists(input);
    } catch {
      throw new PiProjectWorkToolValidationError({ reason: "invalid-tool-lists" });
    }
  })();
  let reportContext: PiProjectWorkReportContext | undefined;
  if (snapshot.reportContext !== undefined) {
    try {
      reportContext = decodeReportContext(snapshot.reportContext);
    } catch {
      throw new PiProjectWorkToolValidationError({ reason: "invalid-report-context" });
    }
  }
  const roleTools = Object.freeze([...snapshot.roleTools]);
  const bindingTools = Object.freeze([...snapshot.bindingTools]);
  const allowed = (capability: Capability) =>
    roleTools.includes(capability) && bindingTools.includes(capability);
  const readCapability = allowed("project-work.read-project")
    ? "project-work.read-project"
    : "project-work.read-task";
  const definitions = [
    [
      "project_work_read",
      readCapability,
      "Read current assigned project work. Read memory-sources with the assigned task and cursor for exact retained source selectors, including historical cleanup identified by its reason.",
    ],
    [
      "project_work_write",
      "project-work.write",
      "Write an authorized intentJSON. To ask a human, use project-team.question.request with commandId, projectId, taskId, expectedRevision, expectedTaskRevision, specRevision, planRevision, questionId, targetGateId, expectedGateRevision, body and choices. Read current task-context revisions first. The server derives sender identity and retains the human answer; an answer does not approve a gate. To message a teammate, use project-team.message.send with those task revisions plus messageId, recipientId, recipientTaskId, expectedRecipientMembershipRevision, body, evidenceIds and optional replyTo. Select an explicit current member/task address from private prepared context. Messages grant no approval or new work. To select memory processing, submit project-team.memory.process with current task revisions and the exact returned selection. Historical cleanup deletes only that captured source and makes no model calls; select it explicitly rather than funding obsolete indexing. Never supply an owner, model or limits. Ownerless, stopped or disabled sources wait; selection grants no new work. To search semantically, submit project-team.memory.query with current assigned-task revisions and an exact nonempty query of at most 8 KiB. The original running operation funds embedding and search; never supply a vector, owner, model or limits. Completed authenticated results can enter later prepared context; context keeps lexical fallback without waiting.",
    ],
    ["project_work_report", "project-work.report", "Report findings for the authorized assignment"],
    ["project_work_plan", "project-work.plan", "Propose a plan for the authorized task"],
  ] as const;
  const tools = definitions
    .filter(([, capability]) => allowed(capability))
    .map(([name, capability, description]) => ({
      capability,
      tool: {
        type: "function" as const,
        function: {
          name,
          description:
            name === "project_work_report" && reportContext !== undefined
              ? reportDescription
              : description,
          parameters:
            name === "project_work_read"
              ? readParameters
              : name === "project_work_report" && reportContext !== undefined
                ? reportParametersFor(reportContext)
                : writeParameters,
        },
      },
    }));
  freezeTree(tools);
  return tools;
};

/** The caller owns current authorization checks; arguments never supply identity. */
export const executePiProjectWorkBridgeTool = Effect.fn("executePiProjectWorkBridgeTool")(
  function* (input: {
    readonly toolName: string;
    readonly arguments: unknown;
    readonly principal: ProjectTeamPrincipal;
    readonly source: ProjectWorkAttribution["source"];
  }) {
    if (input.toolName === "project_work_read") {
      const intent = yield* decodeReadIntent(input.arguments).pipe(
        Effect.mapError(
          () => new PiProjectWorkToolValidationError({ reason: "invalid-arguments" }),
        ),
      );
      const gateway = yield* ProjectWorkGateway;
      return yield* gateway.read(intent, input.principal);
    }
    if (
      input.toolName !== "project_work_write" &&
      input.toolName !== "project_work_report" &&
      input.toolName !== "project_work_plan"
    )
      return yield* new PiProjectWorkToolValidationError({ reason: "unknown-tool" });
    const envelope = yield* decodeWriteEnvelope(input.arguments).pipe(
      Effect.mapError(() => new PiProjectWorkToolValidationError({ reason: "invalid-arguments" })),
    );
    const intent = yield* decodeWriteIntentJSON(envelope.intentJSON).pipe(
      Effect.mapError(() => new PiProjectWorkToolValidationError({ reason: "invalid-intent" })),
    );
    if (
      (input.toolName === "project_work_report" &&
        intent.type !== "project-team.assignment.report" &&
        intent.type !== "project-team.review.finding.record") ||
      (input.toolName === "project_work_plan" && intent.type !== "project-team.plan.propose")
    )
      return yield* new PiProjectWorkToolValidationError({ reason: "intent-kind" });
    const gateway = yield* ProjectWorkGateway;
    return yield* gateway.write(intent, input.principal.actor, input.source, input.principal);
  },
);
