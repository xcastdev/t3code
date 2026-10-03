import {
  ProjectWorkReadIntent,
  ProjectWorkWriteIntent,
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
  Schema.Struct({ roleTools: toolIds, bindingTools: toolIds }),
  strict,
);
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

const freezeTree = (value: unknown): void => {
  if (!Predicate.isObjectOrArray(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
};
const readParameters = decodeJsonObject(Schema.toJsonSchemaDocument(ProjectWorkReadIntent).schema);
const writeParameters = decodeJsonObject(Schema.toJsonSchemaDocument(writeEnvelope).schema);
freezeTree(readParameters);
freezeTree(writeParameters);

/** Advertise only the intersection of the two frozen run configurations. */
export const preparePiProjectWorkTools = (input: {
  readonly roleTools: readonly string[];
  readonly bindingTools: readonly string[];
}): readonly { readonly tool: PiModelTool; readonly capability: Capability }[] => {
  const snapshot = (() => {
    try {
      return decodeToolLists(input);
    } catch {
      throw new PiProjectWorkToolValidationError({ reason: "invalid-tool-lists" });
    }
  })();
  const roleTools = Object.freeze([...snapshot.roleTools]);
  const bindingTools = Object.freeze([...snapshot.bindingTools]);
  const allowed = (capability: Capability) =>
    roleTools.includes(capability) && bindingTools.includes(capability);
  const readCapability = allowed("project-work.read-project")
    ? "project-work.read-project"
    : "project-work.read-task";
  const definitions = [
    ["project_work_read", readCapability, "Read current assigned project work"],
    ["project_work_write", "project-work.write", "Write an authorized project work intent"],
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
          description,
          parameters: name === "project_work_read" ? readParameters : writeParameters,
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
        intent.type !== "project-team.assignment.report") ||
      (input.toolName === "project_work_plan" && intent.type !== "project-team.plan.propose")
    )
      return yield* new PiProjectWorkToolValidationError({ reason: "intent-kind" });
    const gateway = yield* ProjectWorkGateway;
    return yield* gateway.write(intent, input.principal.actor, input.source, input.principal);
  },
);
