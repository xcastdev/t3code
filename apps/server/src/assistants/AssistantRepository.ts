// @effect-diagnostics-next-line nodeBuiltinImport:off -- Stable IDs and command fingerprints are pure synchronous values.
import * as NodeCrypto from "node:crypto";
import {
  AssistantId,
  AssistantDetail,
  AssistantConfigurationRevision,
  CommandId,
  ProjectId,
  ThreadId,
  type AssistantCreateInput,
  type AssistantGetInput,
  type AssistantUpdateConfigurationInput,
  type AssistantLifecycleInput,
  type AssistantListInput,
  AssistantProvisioning as AssistantProvisioningSchema,
  type AssistantProvisioning,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";

export class AssistantError extends Schema.TaggedError<AssistantError>()("AssistantError", {
  reason: Schema.Literals(["not-found", "forbidden", "conflict", "unavailable", "needs-repair"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "conflict"
      ? "Assistant changed; reload its current configuration."
      : this.reason === "needs-repair"
        ? "Assistant workspace needs explicit repair before it can run."
        : this.reason === "not-found"
          ? "Assistant was not found."
          : this.reason === "forbidden"
            ? "Assistant operation is not allowed."
            : "Assistant storage is unavailable.";
  }
}
const provisioningStages = [
  "pending",
  "folder",
  "repository",
  "project",
  "thread",
  "checkpoint",
] as const;
export const AssistantRecord = Schema.Struct({
  provisioningStage: Schema.optional(Schema.Literals(provisioningStages)),
  detail: AssistantDetail,
  ownerRevision: Schema.Number,
  workspaceRoot: Schema.NullOr(Schema.String),
});
export type AssistantRecord = typeof AssistantRecord.Type;
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantRecord));
const encode = Schema.encodeEffect(Schema.fromJsonString(AssistantRecord));
const isAssistantError = Schema.is(AssistantError);
const isProvisioning = Schema.is(AssistantProvisioningSchema);
const unavailable = (cause: unknown) =>
  isAssistantError(cause) ? cause : new AssistantError({ reason: "unavailable", cause });
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(encodeUnknown(value)).digest("hex");

export class AssistantRepository extends Context.Service<
  AssistantRepository,
  {
    readonly get: (scope: AssistantGetInput) => Effect.Effect<AssistantRecord, AssistantError>;
    readonly findByProject: (
      projectId: ProjectId,
    ) => Effect.Effect<AssistantRecord | null, AssistantError>;
    readonly findByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<AssistantRecord | null, AssistantError>;
    readonly list: (
      input: AssistantListInput,
    ) => Effect.Effect<ReadonlyArray<AssistantRecord>, AssistantError>;
    readonly create: (
      input: AssistantCreateInput,
    ) => Effect.Effect<AssistantRecord, AssistantError>;
    readonly updateConfiguration: (
      input: AssistantUpdateConfigurationInput,
    ) => Effect.Effect<AssistantRecord, AssistantError>;
    readonly lifecycle: (
      input: AssistantLifecycleInput,
    ) => Effect.Effect<AssistantRecord, AssistantError>;
    readonly setProvisioning: (
      scope: AssistantGetInput,
      provisioning: AssistantProvisioning,
      workspaceRoot?: string,
      options?: { readonly repair: true },
    ) => Effect.Effect<AssistantRecord, AssistantError>;
  }
>()("t3/assistants/AssistantRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environment = yield* Environment.ServerEnvironment;
  const assertEnvironment = Effect.fn("AssistantRepository.assertEnvironment")(function* (
    id: string,
  ) {
    if (id !== (yield* environment.getEnvironmentId))
      return yield* new AssistantError({ reason: "forbidden" });
  });
  const transaction = Effect.fn("AssistantRepository.transaction")(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) {
    return yield* Option.isSome(yield* Effect.serviceOption(sql.transactionService))
      ? effect
      : sql.withTransaction(effect);
  });
  const get = Effect.fn("AssistantRepository.get")(function* (scope: AssistantGetInput) {
    yield* assertEnvironment(scope.environmentId);
    const row = (yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM t3_workflow_v2_assistants WHERE environment_id=${scope.environmentId} AND assistant_id=${scope.assistantId}`)[0];
    if (!row) return yield* new AssistantError({ reason: "not-found" });
    return yield* decode(row.payload_json);
  }, Effect.mapError(unavailable));
  const write = Effect.fn("AssistantRepository.write")(function* (record: AssistantRecord) {
    const s = record.detail.summary;
    const payload = yield* encode(record);
    yield* sql`UPDATE t3_workflow_v2_assistants SET configuration_revision=${s.configurationRevision}, lifecycle=${s.lifecycle}, provisioning_state=${s.provisioningState}, workspace_root=${record.workspaceRoot}, payload_json=${payload} WHERE environment_id=${s.environmentId} AND assistant_id=${s.assistantId}`;
    return record;
  });
  const existingCommand = Effect.fn("AssistantRepository.existingCommand")(function* (
    environmentId: string,
    commandId: CommandId,
    hash: string,
  ) {
    const row = (yield* sql<{
      fingerprint: string;
      assistant_id: string;
    }>`SELECT fingerprint,assistant_id FROM t3_workflow_v2_assistant_commands WHERE environment_id=${environmentId} AND command_id=${commandId}`)[0];
    if (row && row.fingerprint !== hash) return yield* new AssistantError({ reason: "conflict" });
    return row;
  });
  const create = Effect.fn("AssistantRepository.create")(function* (input: AssistantCreateInput) {
    yield* assertEnvironment(input.environmentId);
    return yield* transaction(
      Effect.gen(function* () {
        const hash = fingerprint(input);
        const prior = yield* existingCommand(input.environmentId, input.commandId, hash);
        if (prior)
          return yield* get({
            environmentId: input.environmentId,
            assistantId: AssistantId.make(prior.assistant_id),
          });
        const id = fingerprint([input.environmentId, input.commandId]);
        const assistantId = AssistantId.make(`assistant-${id}`);
        const binding = {
          environmentId: input.environmentId,
          assistantId,
          backingProjectId: ProjectId.make(`assistant-project-${id}`),
          canonicalThreadId: ThreadId.make(`assistant-thread-${id}`),
        };
        const now = DateTime.formatIso(yield* DateTime.now);
        const record: AssistantRecord = {
          ownerRevision: 0,
          workspaceRoot: null,
          detail: {
            configuration: {
              environmentId: input.environmentId,
              assistantId,
              revision: AssistantConfigurationRevision.make(0),
              configuration: input.configuration,
              createdAt: now,
            },
            summary: {
              environmentId: input.environmentId,
              assistantId,
              name: input.configuration.name,
              configurationRevision: AssistantConfigurationRevision.make(0),
              lifecycle: "active",
              provisioningState: "provisioning",
              binding,
              attention: {
                queuedRuns: 0,
                activeRuns: 0,
                waitingRuns: 0,
                uncertainRuns: 0,
                pendingMemoryJobs: 0,
                memoryStatus: "ready",
                reason: null,
              },
              createdAt: now,
              updatedAt: now,
            },
            provisioning: { state: "provisioning", stage: "pending", binding },
          },
        };
        const payload = yield* encode(record);
        yield* sql`INSERT INTO t3_workflow_v2_assistants(environment_id,assistant_id,project_id,thread_id,owner_revision,configuration_revision,lifecycle,provisioning_state,workspace_root,create_command_id,payload_json) VALUES(${input.environmentId},${assistantId},${binding.backingProjectId},${binding.canonicalThreadId},0,0,'active','provisioning',NULL,${input.commandId},${payload})`;
        yield* sql`INSERT INTO t3_workflow_v2_assistant_commands VALUES(${input.environmentId},${input.commandId},${assistantId},${hash})`;
        return record;
      }),
    );
  }, Effect.mapError(unavailable));
  const mutate = Effect.fn("AssistantRepository.mutate")(function* (
    input: AssistantUpdateConfigurationInput | AssistantLifecycleInput,
  ) {
    yield* assertEnvironment(input.environmentId);
    return yield* transaction(
      Effect.gen(function* () {
        const hash = fingerprint(input);
        const prior = yield* existingCommand(input.environmentId, input.commandId, hash);
        const record = yield* get(input);
        if (prior) return record;
        if (record.detail.configuration.revision !== input.expectedRevision)
          return yield* new AssistantError({ reason: "conflict" });
        const revision = AssistantConfigurationRevision.make(input.expectedRevision + 1);
        const now = DateTime.formatIso(yield* DateTime.now);
        const configuration =
          "configuration" in input
            ? input.configuration
            : record.detail.configuration.configuration;
        const lifecycle =
          "action" in input
            ? input.action === "archive"
              ? "archived"
              : input.action === "disable"
                ? "disabled"
                : input.action === "enable" || input.action === "restore"
                  ? "active"
                  : record.detail.summary.lifecycle
            : record.detail.summary.lifecycle;
        const next: AssistantRecord = {
          ...record,
          detail: {
            ...record.detail,
            configuration: { ...record.detail.configuration, revision, configuration },
            summary: {
              ...record.detail.summary,
              name: configuration.name,
              configurationRevision: revision,
              lifecycle,
              updatedAt: now,
            },
          },
        };
        yield* write(next);
        yield* sql`INSERT INTO t3_workflow_v2_assistant_commands VALUES(${input.environmentId},${input.commandId},${input.assistantId},${hash})`;
        return next;
      }),
    );
  }, Effect.mapError(unavailable));
  const setProvisioning = Effect.fn("AssistantRepository.setProvisioning")(function* (
    scope: AssistantGetInput,
    provisioning: AssistantProvisioning,
    workspaceRoot?: string,
    options?: { readonly repair: true },
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const record = yield* get(scope);
        if (
          record.detail.summary.provisioningState === "needs-repair" &&
          provisioning.state !== "needs-repair" &&
          !(options?.repair && provisioning.state === "ready")
        )
          return yield* new AssistantError({ reason: "needs-repair" });
        if (
          record.detail.summary.provisioningState === "ready" &&
          (provisioning.state === "provisioning" || provisioning.state === "failed")
        )
          return record;
        if (
          record.detail.summary.binding.assistantId !== provisioning.binding.assistantId ||
          record.detail.summary.binding.backingProjectId !==
            provisioning.binding.backingProjectId ||
          record.detail.summary.binding.canonicalThreadId !==
            provisioning.binding.canonicalThreadId ||
          record.detail.summary.binding.environmentId !== provisioning.binding.environmentId
        )
          return yield* new AssistantError({ reason: "conflict" });
        const currentStage =
          record.provisioningStage ??
          (isProvisioning(record.detail.provisioning) &&
          record.detail.provisioning.state === "provisioning"
            ? record.detail.provisioning.stage
            : "pending");
        const stage =
          provisioning.state === "provisioning" &&
          provisioningStages.indexOf(provisioning.stage) > provisioningStages.indexOf(currentStage)
            ? provisioning.stage
            : currentStage;
        return yield* write({
          ...record,
          provisioningStage: stage,
          workspaceRoot: workspaceRoot ?? record.workspaceRoot,
          detail: {
            ...record.detail,
            provisioning:
              provisioning.state === "provisioning" ? { ...provisioning, stage } : provisioning,
            summary: {
              ...record.detail.summary,
              provisioningState: provisioning.state,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            },
          },
        });
      }),
    );
  }, Effect.mapError(unavailable));
  const findByProject = Effect.fn("AssistantRepository.findByProject")(function* (
    projectId: ProjectId,
  ) {
    const environmentId = yield* environment.getEnvironmentId;
    const row = (yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM t3_workflow_v2_assistants WHERE environment_id=${environmentId} AND project_id=${projectId}`)[0];
    return row ? yield* decode(row.payload_json) : null;
  }, Effect.mapError(unavailable));
  const findByThread = Effect.fn("AssistantRepository.findByThread")(function* (
    threadId: ThreadId,
  ) {
    const environmentId = yield* environment.getEnvironmentId;
    const row = (yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM t3_workflow_v2_assistants WHERE environment_id=${environmentId} AND thread_id=${threadId}`)[0];
    return row ? yield* decode(row.payload_json) : null;
  }, Effect.mapError(unavailable));
  const list = Effect.fn("AssistantRepository.list")(function* (input: AssistantListInput) {
    yield* assertEnvironment(input.environmentId);
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM t3_workflow_v2_assistants WHERE environment_id=${input.environmentId} AND assistant_id>${input.cursor ?? ""} AND (${input.includeArchived} OR lifecycle!='archived') ORDER BY assistant_id LIMIT ${Math.min(100, Math.max(1, input.limit))}`;
    return yield* Effect.forEach(rows, (row) => decode(row.payload_json));
  }, Effect.mapError(unavailable));
  return AssistantRepository.of({
    get,
    findByProject,
    findByThread,
    list,
    create,
    updateConfiguration: mutate,
    lifecycle: mutate,
    setProvisioning,
  });
});
export const layer = Layer.effect(AssistantRepository, make);
