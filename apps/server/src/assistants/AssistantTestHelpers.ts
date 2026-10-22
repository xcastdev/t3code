import { AssistantConfiguration, AssistantCreateInput, EnvironmentId } from "@t3tools/contracts";
import * as NodeSqlite from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import { assistantMigration } from "../persistence/AssistantMigration.ts";
import * as Repository from "./AssistantRepository.ts";
export const environmentId = EnvironmentId.make("assistant-test");
export const configuration = Schema.decodeUnknownSync(AssistantConfiguration)({
  name: "Research",
  rules: "Ask before publishing.",
  prompt: "Help with research.",
  personality: "Direct",
  modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  resources: { mcpTools: [], skills: [], instructions: [] },
  memory: {
    automaticCapture: true,
    allowRoutineCreation: false,
    extractionFallback: null,
    externalIndexing: null,
  },
});
export const input = Schema.decodeUnknownSync(AssistantCreateInput)({
  environmentId,
  commandId: "create",
  configuration,
});
const storage = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of assistantMigration.statements) yield* sql.unsafe(statement);
  }),
).pipe(Layer.provideMerge(NodeSqlite.layer({ filename: ":memory:" })));
export const repository = Repository.layer.pipe(
  Layer.provideMerge(storage),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("unused"),
    }),
  ),
);
