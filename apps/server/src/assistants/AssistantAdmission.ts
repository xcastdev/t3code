// @effect-diagnostics-next-line nodeBuiltinImport:off -- Exact routine prompts bind their retained fire receipt.
import * as NodeCrypto from "node:crypto";
import { AssistantRoutineRepository } from "./AssistantRoutineRepository.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { makeAssistantRepositoryValidator } from "../project/ManagedProjectFolders.ts";
// @effect-diagnostics nodeBuiltinImport:off
import {
  AssistantConfigurationSnapshot,
  OrchestrationV2InstructionSnapshot,
  ProjectId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Admission from "../orchestration-v2/RunAdmission.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { AssistantRepository, AssistantRecord } from "./AssistantRepository.ts";
import {
  AssistantResources,
  AssistantInstructionEpoch,
  assistantConfigurationHash,
  assistantMemoryContextHash,
} from "./AssistantResources.ts";
import { assistantThreadIsCurrent } from "./AssistantThreadAuthority.ts";

// Only the checked lifecycle service supplies this scope; no wire input carries it.
export class AssistantLifecycleMutation extends Context.Reference<string>(
  "t3/assistants/AssistantLifecycleMutation",
  { defaultValue: () => "" },
) {}
const denied = (reason: string): Admission.AdmissionResult => ({ _tag: "denied", reason });
const wrap = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new Admission.RunAdmissionError({ operation, cause })));
const StoredSnapshot = Schema.Struct({
  configuration: AssistantConfigurationSnapshot,
  snapshot: OrchestrationV2InstructionSnapshot,
  runAttemptId: Schema.NullOr(RunAttemptId),
  configurationHash: Schema.String,
});
const decodeOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantRecord));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSnapshot));
const encode = Schema.encodeEffect(Schema.fromJsonString(StoredSnapshot));

const make = Effect.gen(function* () {
  const previous = yield* Admission.RunAdmission;
  const repository = yield* AssistantRepository;
  const routines = yield* Effect.serviceOption(AssistantRoutineRepository);
  const resources = yield* AssistantResources;
  const memoryContext = yield* Effect.serviceOption(AssistantInstructionEpoch);
  const projections = yield* ProjectionStoreV2;
  const projects = yield* ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const validateRepository = yield* makeAssistantRepositoryValidator;
  const ownerOf = Effect.fn("AssistantAdmission.ownerOf")(function* (
    threadId: ThreadId,
    projectId?: ProjectId,
  ) {
    const retainedOwners = yield* sql<{
      payload_json: string;
    }>`SELECT DISTINCT a.payload_json FROM t3_workflow_v2_assistants a JOIN t3_workflow_v2_assistant_admissions r ON r.assistant_id=a.assistant_id WHERE r.thread_id=${threadId} LIMIT 2`;
    if (retainedOwners.length > 1)
      return yield* new Admission.RunAdmissionError({
        operation: "ownerOf",
        cause: "Retained assistant child ownership is ambiguous.",
      });
    if (retainedOwners[0] !== undefined) {
      const owner = yield* decodeOwner(retainedOwners[0].payload_json);
      return yield* repository.get(owner.detail.summary);
    }
    let id = threadId;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(id) || seen.size >= 9)
        return yield* new Admission.RunAdmissionError({
          operation: "ownerOf",
          cause: "Thread owner lineage is invalid.",
        });
      seen.add(id);
      const direct = yield* repository.findByThread(id);
      if (direct !== null) return direct;
      const shell = yield* projections.getThreadShell(id);
      const targetProjectId = id === threadId ? (projectId ?? shell?.projectId) : shell?.projectId;
      const project =
        targetProjectId === undefined ? null : yield* repository.findByProject(targetProjectId);
      if (project !== null) return project;
      if (shell?.lineage.parentThreadId == null) return null;
      id = shell.lineage.parentThreadId;
    }
  });
  const physical = Effect.fn("AssistantAdmission.physical")(function* (record: AssistantRecord) {
    if (record.workspaceRoot === null)
      return yield* new Admission.RunAdmissionError({
        operation: "physical",
        cause: "Assistant workspace is unavailable.",
      });
    yield* validateRepository({
      assistantId: record.detail.summary.assistantId,
      workspaceRoot: record.workspaceRoot,
    }).pipe(
      Effect.catch((cause) =>
        repository
          .setProvisioning(record.detail.summary, {
            state: "needs-repair",
            binding: record.detail.summary.binding,
            reason:
              "The retained assistant repository could not be validated. Restore it explicitly.",
          })
          .pipe(
            Effect.andThen(
              Effect.fail(new Admission.RunAdmissionError({ operation: "physical", cause })),
            ),
          ),
      ),
    );
  });
  const current = Effect.fn("AssistantAdmission.current")(function* (
    record: AssistantRecord,
    allowInactive = false,
  ) {
    const summary = record.detail.summary;
    if (
      (!allowInactive && summary.lifecycle !== "active") ||
      summary.provisioningState !== "ready" ||
      record.workspaceRoot === null
    )
      return false;
    const binding = summary.binding;
    const project = yield* projects.get(binding.backingProjectId);
    const thread = yield* projections.getThreadShell(binding.canonicalThreadId);
    if (
      Option.isNone(project) ||
      project.value.deletedAt !== null ||
      project.value.workspaceRoot !== record.workspaceRoot ||
      thread === null ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.projectId !== binding.backingProjectId ||
      (thread.worktreePath !== null && thread.worktreePath !== record.workspaceRoot)
    ) {
      yield* repository.setProvisioning(
        { environmentId: summary.environmentId, assistantId: summary.assistantId },
        { state: "needs-repair", binding, reason: "The canonical assistant workspace changed." },
      );
      return false;
    }
    return true;
  });
  const threadCurrent = Effect.fn("AssistantAdmission.threadCurrent")(function* (
    record: AssistantRecord,
    threadId: ThreadId,
  ) {
    return yield* assistantThreadIsCurrent({
      threadId,
      ...record.detail.summary.binding,
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  });
  const admitted = (
    record: AssistantRecord,
    input: { threadId: ThreadId; runId?: RunId; runAttemptId?: RunAttemptId },
    snapshot: OrchestrationV2InstructionSnapshot,
  ): Admission.AdmissionResult => {
    const { configuration, revision } = record.detail.configuration;
    return {
      _tag: "admitted",
      owner: {
        ownerKind: "assistant",
        projectId: record.detail.summary.binding.backingProjectId,
        bindingId: record.detail.summary.assistantId,
        rootId: record.detail.summary.binding.canonicalThreadId,
        generation: revision,
        fence: revision,
        threadId: input.threadId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.runAttemptId === undefined ? {} : { runAttemptId: input.runAttemptId }),
        expiresAt: null,
        configuration: {
          providerInstanceId: configuration.modelSelection.instanceId,
          model: configuration.modelSelection.model,
          ...(configuration.modelSelection.options === undefined
            ? {}
            : { options: configuration.modelSelection.options }),
          instructionsHash: snapshot.configurationHash,
          instructionSnapshot: snapshot,
          toolIds: snapshot.toolIds,
          skillIds: snapshot.skillIds,
          runtimeVersion: `assistant:${revision}`,
          paidFallback: false,
        },
      },
    };
  };
  const retained = Effect.fn("AssistantAdmission.retained")(function* (
    record: AssistantRecord,
    input: Admission.CheckInput,
  ) {
    if (input.operation === "escape")
      return denied("An assistant cannot launch an ordinary workspace.");
    const records = yield* projections.getThreadRecords(input.threadId, [
      "runs",
      "providerThreads",
      "providerSessions",
      "providerTurns",
    ]);
    const candidates =
      input.runId === undefined
        ? records.runs.filter(
            (value) =>
              value.status === "starting" ||
              value.status === "running" ||
              value.status === "waiting",
          )
        : records.runs.filter((value) => value.id === input.runId);
    if (candidates.length !== 1)
      return denied("Assistant inference requires one exact retained run.");
    const run = candidates[0]!;
    if (input.runAttemptId !== undefined && input.runAttemptId !== run.activeAttemptId)
      return denied("Assistant native attempt changed.");
    const providerThread = records.providerThreads.find(
      (value) => value.id === run.providerThreadId,
    );
    const target = input.nativeTarget;
    if (target !== undefined) {
      const session = records.providerSessions.find(
        (value) => value.id === target.providerSessionId,
      );
      if (session === undefined || session.status === "stopped" || session.status === "error")
        return denied("Assistant native session is unavailable.");
    }
    if (
      input.originSessionId !== undefined &&
      providerThread?.providerSessionId !== input.originSessionId
    )
      return denied("Assistant native session changed.");
    if (
      target !== undefined &&
      (run.activeAttemptId !== target.runAttemptId ||
        run.providerThreadId !== target.providerThreadId ||
        providerThread?.providerSessionId !== target.providerSessionId ||
        (target.nodeId !== undefined && run.rootNodeId !== target.nodeId) ||
        (target.providerTurnId !== undefined &&
          !records.providerTurns.some(
            (turn) =>
              turn.id === target.providerTurnId &&
              turn.runAttemptId === target.runAttemptId &&
              turn.providerThreadId === target.providerThreadId,
          )))
    )
      return denied("Assistant native target changed.");
    const row = (yield* sql<{
      configuration_revision: number;
      configuration_json: string;
    }>`SELECT configuration_revision,configuration_json FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${input.threadId} AND run_id=${run.id}`)[0];
    if (row === undefined) return denied("Assistant run has no retained configuration.");
    const captured = yield* decode(row.configuration_json);
    const inFlight = run.status === "running" || run.status === "waiting";
    if (
      (input.operation === "start" ||
        input.operation === "preparation" ||
        (input.operation === "continue" && !inFlight)) &&
      input.threadId === record.detail.summary.binding.canonicalThreadId &&
      Option.isSome(memoryContext)
    ) {
      const latestMemory = yield* memoryContext.value.context(record);
      if (
        latestMemory.memoryEpoch !== captured.snapshot.memoryEpoch ||
        assistantMemoryContextHash(latestMemory.text) !== captured.snapshot.memoryContextHash
      )
        return denied("Assistant memory changed before inference; submit a new turn.");
    }
    if (!inFlight && input.operation !== "completion" && Option.isSome(routines)) {
      const messages = yield* sql<{
        message_id: import("@t3tools/contracts").MessageId;
      }>`SELECT message_id FROM orchestration_v2_projection_messages WHERE thread_id=${input.threadId} AND run_id=${run.id} AND (json_extract(payload_json,'$.scheduledTaskId') IS NOT NULL OR EXISTS(SELECT 1 FROM t3_workflow_v2_assistant_routine_fires f WHERE f.message_id=orchestration_v2_projection_messages.message_id))`;
      for (const message of messages)
        yield* routines.value.assertQueued({
          threadId: input.threadId,
          runId: run.id,
          messageId: message.message_id,
        });
    }
    if (input.operation !== "completion" && !(yield* current(record, inFlight)))
      return denied("Assistant is disabled or its canonical workspace needs repair.");
    if (input.operation !== "completion" && !(yield* threadCurrent(record, input.threadId)))
      return denied("Assistant child lineage changed.");
    if (captured.runAttemptId !== run.activeAttemptId)
      return denied("Assistant attempt fence changed.");
    if (
      ((input.operation === "continue" && !inFlight) ||
        input.operation === "start" ||
        input.operation === "preparation" ||
        run.status === "queued" ||
        run.status === "preparing") &&
      (row.configuration_revision !== record.detail.configuration.revision ||
        captured.configurationHash !== assistantConfigurationHash(record))
    )
      return denied("Assistant configuration changed before inference; submit a new turn.");
    if (
      input.retainedOwner !== undefined &&
      input.retainedOwner !== null &&
      (input.retainedOwner.bindingId !== record.detail.summary.assistantId ||
        input.retainedOwner.generation !== row.configuration_revision ||
        input.retainedOwner.runId !== run.id ||
        input.retainedOwner.runAttemptId !== run.activeAttemptId)
    )
      return denied("Assistant completion owner changed.");
    return admitted(
      { ...record, detail: { ...record.detail, configuration: captured.configuration } },
      {
        threadId: input.threadId,
        runId: run.id,
        ...(run.activeAttemptId === null ? {} : { runAttemptId: run.activeAttemptId }),
      },
      captured.snapshot,
    );
  });
  const guardEvents = Effect.fn("AssistantAdmission.guardEvents")(function* (input: {
    commandId: import("@t3tools/contracts").CommandId;
    commandType: string;
    events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) {
    yield* previous.guardEvents?.(input) ?? Effect.void;
    const changed = new Set<string>();
    for (const event of input.events) {
      const creation = input.events.find(
        (value) => value.type === "thread.created" && value.threadId === event.threadId,
      );
      const projectId =
        creation?.type === "thread.created" ? creation.payload.projectId : undefined;
      const record = yield* ownerOf(event.threadId, projectId);
      if (record === null) continue;
      const binding = record.detail.summary.binding;
      const fail = () =>
        new Admission.RunAdmissionError({
          operation: input.commandType,
          cause:
            "Use the assistant lifecycle and configuration controls for its canonical workspace.",
        });
      if (event.type === "message.updated" && event.payload.role === "user") {
        if (event.payload.scheduledTaskId !== undefined) {
          if (Option.isNone(routines)) return yield* fail();
          yield* routines.value.assertAdmission({
            threadId: event.threadId,
            commandId: input.commandId,
            messageId: event.payload.id,
            taskId: event.payload.scheduledTaskId,
            promptHash: NodeCrypto.createHash("sha256").update(event.payload.text).digest("hex"),
          });
        }
        const latest = (yield* sql<{
          configuration_json: string;
        }>`SELECT configuration_json FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${event.threadId} AND run_id=${event.payload.runId ?? ""} LIMIT 1`)[0];
        const allowed =
          latest === undefined ? [] : (yield* decode(latest.configuration_json)).snapshot.skillIds;
        const selected = [...event.payload.text.matchAll(/(?:^|\s)\$([a-zA-Z0-9_-]+)/g)].map(
          (match) => match[1]!,
        );
        for (const context of event.payload.context?.records ?? [])
          if (context.kind === "skill" && "name" in context && typeof context.name === "string")
            selected.push(context.name);
        if (selected.some((key) => !allowed.includes(key))) return yield* fail();
      }
      if (event.type === "thread.created") {
        if (event.threadId === binding.canonicalThreadId) {
          if (
            event.payload.projectId !== binding.backingProjectId ||
            event.payload.lineage.parentThreadId !== null ||
            record.detail.summary.provisioningState !== "provisioning"
          )
            return yield* fail();
        } else {
          const parent = event.payload.lineage.parentThreadId;
          if (
            parent === null ||
            !(yield* current(record)) ||
            !(yield* threadCurrent(record, parent))
          )
            return yield* fail();
          const isolated =
            event.payload.worktreePath !== null &&
            event.payload.worktreePath !== record.workspaceRoot;
          if (
            input.commandType !== "delegated_task.request" &&
            !(input.commandType === "thread.fork" && isolated)
          )
            return yield* fail();
        }
      } else if (event.type === "thread.archived") {
        return yield* fail();
      } else if (event.type === "thread.deleted" || event.type === "thread.unarchived") {
        if (
          (yield* AssistantLifecycleMutation) !== binding.assistantId ||
          event.type !== "thread.unarchived"
        )
          return yield* fail();
      } else if (event.type === "thread.metadata-updated") {
        const shell = yield* projections.getThreadShell(event.threadId);
        if (
          shell === null ||
          event.payload.projectId !== shell.projectId ||
          event.payload.worktreePath !== shell.worktreePath ||
          event.payload.lineage.parentThreadId !== shell.lineage.parentThreadId
        )
          return yield* fail();
      } else if (
        event.type === "thread.model-selection-updated" ||
        event.type === "thread.runtime-mode-updated" ||
        event.type === "thread.interaction-mode-updated" ||
        event.type === "thread.provider-switched"
      ) {
        if (event.threadId !== binding.canonicalThreadId) return yield* fail();
        if (changed.has(binding.assistantId)) continue;
        changed.add(binding.assistantId);
        const configured = record.detail.configuration.configuration;
        if (
          ((event.type === "thread.model-selection-updated" ||
            event.type === "thread.provider-switched") &&
            !modelSelectionsEqual(event.payload.modelSelection, configured.modelSelection)) ||
          (event.type === "thread.runtime-mode-updated" &&
            event.payload.runtimeMode !== configured.runtimeMode) ||
          (event.type === "thread.interaction-mode-updated" &&
            event.payload.interactionMode !== configured.interactionMode)
        )
          return yield* fail();
      }
    }
  });
  return Admission.RunAdmission.of({
    ...previous,
    validatePhysical: (threadId) =>
      wrap(
        "validatePhysical",
        Effect.gen(function* () {
          const record = yield* ownerOf(threadId);
          if (record !== null) yield* physical(record);
          else yield* previous.validatePhysical?.(threadId) ?? Effect.void;
        }),
      ),
    guardEvents: (input) => wrap("guardEvents", guardEvents(input)),
    guardProject: (input) =>
      wrap(
        "guardProject",
        Effect.gen(function* () {
          yield* previous.guardProject?.(input) ?? Effect.void;
          const record = yield* repository.findByProject(input.projectId);
          if (
            record !== null &&
            (input.commandType !== "project.create" ||
              record.detail.summary.provisioningState !== "provisioning")
          )
            return yield* new Admission.RunAdmissionError({
              operation: input.commandType,
              cause: "Assistant backing projects are managed by the assistant lifecycle.",
            });
        }),
      ),
    prepareResources: (input) =>
      wrap(
        "prepareResources",
        Effect.gen(function* () {
          const record =
            (yield* ownerOf(input.threadId, input.projectId)) ??
            (input.originThreadId === undefined ? null : yield* ownerOf(input.originThreadId));
          if (record === null)
            return yield* previous.prepareResources?.(input) ?? Effect.succeed(undefined);
          if (input.operation === "bind-thread") return undefined;
          if (!(yield* current(record))) return undefined;
          yield* physical(record);
          return {
            snapshot: yield* resources.prepare(record, input.threadId),
            catalogRevision: 0,
            baseHash: assistantConfigurationHash(record),
          };
        }),
      ),
    commit: (input) =>
      wrap(
        "commit",
        Effect.gen(function* () {
          const record =
            (yield* ownerOf(input.threadId, input.projectId)) ??
            (input.originThreadId === undefined ? null : yield* ownerOf(input.originThreadId));
          if (record === null) return yield* previous.commit(input);
          if (input.operation === "bind-thread")
            return input.projectId === record.detail.summary.binding.backingProjectId &&
              (input.threadId === record.detail.summary.binding.canonicalThreadId ||
                (input.originThreadId !== undefined &&
                  (yield* threadCurrent(record, input.originThreadId))))
              ? { _tag: "ordinary" as const }
              : denied("Assistant sibling or fork must use an owned delegation.");
          const existingRun =
            input.runId === undefined
              ? undefined
              : (yield* projections.getThreadRecords(input.threadId, ["runs"], {
                  runIds: [input.runId],
                })).runs.find((run) => run.id === input.runId);
          if (
            existingRun !== undefined &&
            input.operation !== "steer" &&
            input.operation !== "runtime-answer" &&
            Option.isSome(routines)
          ) {
            const messages = yield* sql<{
              message_id: import("@t3tools/contracts").MessageId;
            }>`SELECT message_id FROM orchestration_v2_projection_messages WHERE thread_id=${input.threadId} AND run_id=${existingRun.id} AND (json_extract(payload_json,'$.scheduledTaskId') IS NOT NULL OR EXISTS(SELECT 1 FROM t3_workflow_v2_assistant_routine_fires f WHERE f.message_id=orchestration_v2_projection_messages.message_id))`;
            for (const message of messages)
              yield* routines.value.assertQueued({
                runId: existingRun.id,
                threadId: input.threadId,
                messageId: message.message_id,
              });
          }
          const inFlight =
            (input.operation === "steer" || input.operation === "runtime-answer") &&
            (existingRun?.status === "running" || existingRun?.status === "waiting");
          if (!(yield* current(record, inFlight))) return denied("Assistant is not runnable.");
          if (input.runId === undefined) return denied("Assistant inference needs a run identity.");
          const shell = yield* projections.getThreadShell(input.threadId);
          if (shell !== null && !(yield* threadCurrent(record, input.threadId)))
            return denied("Assistant child target changed.");
          const configuration = record.detail.configuration.configuration;
          if (
            shell !== null &&
            input.operation !== "steer" &&
            input.operation !== "runtime-answer" &&
            (!modelSelectionsEqual(shell.modelSelection, configuration.modelSelection) ||
              shell.runtimeMode !== configuration.runtimeMode ||
              shell.interactionMode !== configuration.interactionMode)
          )
            return denied("Assistant thread configuration is pending synchronization.");
          const prior = (yield* sql<{
            configuration_json: string;
            configuration_revision: number;
          }>`SELECT configuration_json,configuration_revision FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${input.threadId} AND run_id=${input.runId}`)[0];
          if (prior !== undefined) {
            if (
              prior.configuration_revision !== record.detail.configuration.revision &&
              input.operation !== "steer" &&
              input.operation !== "runtime-answer"
            )
              return denied("Queued assistant configuration changed.");
            const captured = yield* decode(prior.configuration_json);
            if (
              (input.operation === "restart" || input.operation === "promote") &&
              input.runAttemptId !== undefined &&
              captured.runAttemptId !== input.runAttemptId
            )
              yield* sql`UPDATE t3_workflow_v2_assistant_admissions SET configuration_json=${yield* encode({ ...captured, runAttemptId: input.runAttemptId })} WHERE thread_id=${input.threadId} AND run_id=${input.runId}`;
            else if (
              input.runAttemptId !== undefined &&
              captured.runAttemptId !== input.runAttemptId
            )
              return denied("Assistant attempt fence changed.");
            return admitted(
              { ...record, detail: { ...record.detail, configuration: captured.configuration } },
              input,
              captured.snapshot,
            );
          }
          if (input.operation === "steer" || input.operation === "runtime-answer")
            return denied("Assistant continuation needs a retained run.");
          if (
            input.preparedResources === undefined ||
            input.preparedResources.baseHash !== assistantConfigurationHash(record)
          )
            return denied("Assistant resources changed during admission.");
          const captured = {
            configuration: record.detail.configuration,
            snapshot: input.preparedResources.snapshot,
            configurationHash: assistantConfigurationHash(record),
            runAttemptId: input.runAttemptId ?? null,
          };
          yield* sql`INSERT INTO t3_workflow_v2_assistant_admissions(thread_id,run_id,assistant_id,configuration_revision,configuration_json,created_at) VALUES(${input.threadId},${input.runId},${record.detail.summary.assistantId},${record.detail.configuration.revision},${yield* encode(captured)},${input.now})`;
          return admitted(record, input, captured.snapshot);
        }),
      ),
    check: (input) =>
      wrap(
        "check",
        Effect.gen(function* () {
          const record = yield* ownerOf(input.threadId);
          return record === null ? yield* previous.check(input) : yield* retained(record, input);
        }),
      ),
    reconcileNative: (input) =>
      wrap(
        "reconcileNative",
        Effect.gen(function* () {
          const record = yield* ownerOf(input.threadId);
          return record === null
            ? yield* previous.reconcileNative(input)
            : yield* retained(record, { ...input, operation: "continue" });
        }),
      ),
    settle: (input) =>
      wrap(
        "settle",
        Effect.gen(function* () {
          return (yield* ownerOf(input.threadId)) === null ? yield* previous.settle(input) : [];
        }),
      ),
    observeNativeTurn: (input) =>
      wrap(
        "observeNativeTurn",
        Effect.gen(function* () {
          const record = yield* ownerOf(input.threadId);
          if (record === null) return yield* previous.observeNativeTurn(input);
          const checked = yield* retained(record, {
            ...input,
            operation: input.terminal ? "completion" : "continue",
          });
          return { stop: checked._tag !== "admitted", cancelControlIds: [] };
        }),
      ),
  });
});
export const layer = Layer.effect(Admission.RunAdmission, make);
