import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectTeamRunBinding,
  ProjectTeamRoleRevision,
  ProjectTeamMessage,
  ProjectWorkAttemptId,
  ProjectWorkFoundationCommitCommand,
  projectWorkPayloadFingerprint,
  IsoDateTime,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PiManagedProcessAllocationSchema } from "../provider/pi/PiManagedProcess.ts";
import {
  PiNativeReference,
  PiWorkerIdentity,
  PiWorkerOperation,
} from "../provider/pi/PiWorkerProtocol.ts";
import { ProjectTeamAuthorization, managedActorId } from "./ProjectTeamAuthorization.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";
import {
  makeProjectTeamSessionReceipts,
  type ProjectTeamAssignmentReceipt,
} from "./ProjectTeamSessionReceipts.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { decodeProjectWorkEvent } from "./ProjectWorkEventStore.ts";
import { planMessageDelivery, applyMessageReceipt } from "./ProjectTeamMailboxPolicy.ts";

export class ProjectTeamMailboxConsumptionError extends Schema.TaggedError<ProjectTeamMailboxConsumptionError>()(
  "ProjectTeamMailboxConsumptionError",
  { reason: Schema.String },
) {}
const deny = (reason: string) => new ProjectTeamMailboxConsumptionError({ reason });
const isError = Schema.is(ProjectTeamMailboxConsumptionError);
const strict = { onExcessProperty: "error" } as const;
const canonical = canonicalProjectWorkPayload;
const textHash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const hash = (value: unknown) => textHash(canonical(value));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Safe.check(Schema.isGreaterThan(0));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const bounded = (bytes: number) =>
  Schema.String.check(Schema.makeFilter((value) => Buffer.byteLength(value) <= bytes));
const SealInput = Schema.Struct({ operationId: Id, baseSystemText: bounded(65536) });
const BindInput = Schema.Struct({
  operationId: Id,
  reservationId: Id,
  encodedRequestSha256: Digest,
});
const BoundInput = Schema.Struct({
  reservation_id: Id,
  operation_id: Id,
  request_id: Positive,
  worker_id: Id,
  generation: Safe,
  route_id: Id,
  provider: Schema.Literal("command-code"),
  model: Id,
  system_text_sha256: Digest,
  encoded_request_sha256: Digest,
});
const Reservation = Schema.Struct({
  workerId: Id,
  generation: Safe,
  operationId: Id,
  requestId: Positive,
  routeId: Id,
  provider: Schema.Literal("command-code"),
  model: Id,
  maxInputTokens: Positive,
  maxOutputTokens: Positive,
  callCount: Schema.Literal(1),
  deadlineAtMs: Positive,
});
const ReservationRow = Schema.Struct({
  reservation_id: Id,
  environment_id: Id,
  project_id: Id,
  root_task_id: Id,
  run_id: Id,
  attempt_id: Id,
  worker_id: Id,
  generation: Safe,
  operation_id: Id,
  request_id: Positive,
  route_id: Id,
  provider: Schema.Literal("command-code"),
  model: Id,
  maximum_input_tokens: Positive,
  maximum_output_tokens: Positive,
  deadline_at_ms: Positive,
  status: Schema.Literals(["held", "reported", "failed", "unknown"]),
  capacity_state: Schema.Literals(["held", "released", "quarantine", "legacy"]),
  reservation_json: bounded(8192),
});
const Limits = Schema.Struct({ maximumTokens: Positive, deadlineAtMs: Positive });
const Request = Schema.Struct({
  kind: Schema.Literal("prompt"),
  operationId: Id,
  threadId: ThreadId,
  prompt: bounded(131072),
  runtimeMode: Schema.optionalKey(Schema.Literal("approval-required")),
  cwd: Schema.optionalKey(bounded(4096)),
  modelSelection: Schema.optionalKey(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      model: Id,
      options: Schema.optionalKey(Schema.JsonObject),
    }),
  ),
  resumeCursor: Schema.optionalKey(Schema.NullOr(PiNativeReference)),
  skillPlan: Schema.optionalKey(Schema.JsonObject),
});
const Intent = Schema.Struct({
  request: Request,
  binding: ProjectTeamRunBinding,
  role: ProjectTeamRoleRevision,
  allocation: PiManagedProcessAllocationSchema,
  resourceHash: Digest,
  rootBudget: Schema.Struct({ rootTaskId: Id, ...Limits.fields }),
  operationLimits: Limits,
});
const OperationRow = Schema.Struct({
  operation_id: Id,
  environment_id: Id,
  project_id: Id,
  binding_id: Id,
  generation: Safe,
  provider_instance_id: ProviderInstanceId,
  thread_id: ThreadId,
  worker_id: Id,
  request_hash: Digest,
  root_task_id: Id,
  maximum_tokens: Positive,
  deadline_at_ms: Positive,
  status: Schema.Literals(["prepared", "starting", "running", "settled", "quarantine"]),
  intent_json: bounded(1048576),
});
const Target = Schema.Struct({
  projectId: ProjectTeamMessage.fields.projectId,
  messageId: Id,
  messageRevision: Safe,
  runBindingRecordId: Id,
  attemptId: ProjectWorkAttemptId.check(Schema.isMaxLength(256)),
  bindingGeneration: Safe,
  leaseGeneration: Safe,
  deliveryGeneration: Safe,
  deliveryCursor: Positive,
});
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  operationId: Id,
  environmentId: Id,
  projectId: ProjectTeamMessage.fields.projectId,
  dispatchId: Id,
  bindingId: Id,
  generation: Safe,
  claimGeneration: Positive,
  intentSha256: Digest,
  requestHash: Digest,
  workerId: Id,
  baseSystemTextSha256: Digest,
  binding: ProjectTeamRunBinding,
  deliveries: Schema.Array(Schema.Struct({ message: ProjectTeamMessage, target: Target })).check(
    Schema.isMaxLength(64),
  ),
});
const BatchRow = Schema.Struct({
  operation_id: Id,
  batch_id: Id,
  environment_id: Id,
  project_id: ProjectTeamMessage.fields.projectId,
  dispatch_id: Id,
  binding_id: Id,
  generation: Safe,
  manifest_json: bounded(262144),
  manifest_sha256: Digest,
  system_text: bounded(65536),
  system_text_sha256: Digest,
  revision: Safe,
  status: Schema.Literals(["sealed", "uncertain", "delivered"]),
});
const SnapshotInput = Schema.Struct({
  fence: Schema.Struct({
    dispatchId: Id,
    revision: Safe,
    claimGeneration: Positive,
    stage: Schema.Literals([
      "reserved",
      "workspace-ready",
      "setup-complete",
      "session-bound",
      "assignment-intent",
      "assignment-observed",
      "stopping",
      "settled",
      "quarantine",
    ]),
  }),
  intent: Schema.JsonObject,
});
const Terminal = Schema.Struct({
  identity: PiWorkerIdentity,
  operation: PiWorkerOperation,
  outcome: Schema.Literals(["success", "failed", "canceled", "quarantine"]),
  ownerCaptured: Schema.Boolean,
  native: Schema.NullOr(PiNativeReference),
  drain: Schema.NullOr(Schema.JsonObject),
  accountingReceipts: Schema.Array(Schema.JsonObject).check(Schema.isMaxLength(256)),
  failureCode: Schema.optionalKey(Id),
});
const Commands = Schema.Array(ProjectWorkFoundationCommitCommand).check(Schema.isMaxLength(1));
const Outcomes = Schema.Array(ProjectTeamMessage).check(Schema.isMaxLength(64));
const ReflectionRow = Schema.Struct({
  operation_id: Id,
  phase: Schema.Literals(["uncertain", "delivered"]),
  command_json: bounded(262144),
  command_sha256: Digest,
  observation_sha256: Digest,
  observed_at: IsoDateTime,
  outcome_json: bounded(262144),
});
type Reflection =
  | { readonly status: "pending" | "uncertain" }
  | { readonly status: "delivered" | "unchanged"; readonly receipt: ProjectTeamAssignmentReceipt };
const exact = <A>(input: unknown, decode: (value: unknown) => A) => {
  const copy: unknown = structuredClone(input);
  const decoded = decode(copy);
  if (canonical(copy) !== canonical(decoded)) throw deny("Input changed during decoding");
  return decoded;
};
const immutableBinding = (binding: typeof ProjectTeamRunBinding.Type) => {
  const {
    revision: _,
    status: _status,
    sessionId: _session,
    updatedAt: _at,
    ...identity
  } = binding;
  return canonical(identity);
};
const idFor = (domain: string, environmentId: string, operationId: string) =>
  `${domain}:${hash([domain, environmentId, operationId])}`;
const decodeEnvironmentId = Schema.decodeUnknownEffect(Id);
const decodeOperationRow = Schema.decodeUnknownEffect(OperationRow, strict);
const decodeOperationIntent = Schema.decodeUnknownEffect(Schema.fromJsonString(Intent), strict);
const decodeBatchRow = Schema.decodeUnknownEffect(BatchRow, strict);
const decodeManifestValue = Schema.decodeUnknownEffect(Manifest, strict);
const decodeBoundInput = Schema.decodeUnknownEffect(BoundInput, strict);
const decodeReservationRow = Schema.decodeUnknownEffect(ReservationRow, strict);
const decodeReservation = Schema.decodeUnknownEffect(Schema.fromJsonString(Reservation), strict);
const decodeReflectionRow = Schema.decodeUnknownEffect(ReflectionRow, strict);
const decodeCommands = Schema.decodeUnknownEffect(Schema.fromJsonString(Commands), strict);
const decodeOutcomes = Schema.decodeUnknownEffect(Schema.fromJsonString(Outcomes), strict);
const decodeEventPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject));
const decodeMessagePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamMessage),
  strict,
);
const decodeTerminal = Schema.decodeUnknownEffect(Schema.fromJsonString(Terminal), strict);
const decodeFoundationCommand = Schema.decodeUnknownEffect(
  ProjectWorkFoundationCommitCommand,
  strict,
);
const decodeSeal = Schema.decodeUnknownSync(SealInput, strict);
const decodeBind = Schema.decodeUnknownSync(BindInput, strict);
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest), strict);
const render = (base: string, deliveries: (typeof Manifest.Type)["deliveries"]) =>
  deliveries.length === 0
    ? base
    : `${base}\n\nInitial assignment mailbox (retained messages):\n${canonical(deliveries.map(({ message }) => ({ messageId: message.recordId, senderId: message.senderId, taskId: message.taskId, missionId: message.missionId, body: message.body, evidenceIds: message.evidenceIds })))}`;

/** Original assignment custody only. These receipts grant no wake, acknowledgement, or execution. */
export const makeProjectTeamMailboxConsumption = Effect.fn("makeProjectTeamMailboxConsumption")(
  function* (options: { readonly environmentId: string }) {
    const environmentId = yield* decodeEnvironmentId(options.environmentId);
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const authorization = yield* ProjectTeamAuthorization;
    // A decoding ceiling, never a model reservation or admission grant.
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId,
      maximumEnvironmentModelCalls: 128,
    });
    const receipts = yield* makeProjectTeamSessionReceipts({
      environmentId,
      maximumEnvironmentModelCalls: 128,
    });
    const guard = Effect.gen(function* () {
      const supplied = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (
        Option.isNone(supplied) ||
        supplied.value !== sql ||
        Option.isSome(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Mailbox consumption must own its original SQL transaction");
    });
    const own = <A, E, R>(body: Effect.Effect<A, E, R>) =>
      guard.pipe(
        Effect.flatMap(() =>
          sql.withTransaction(body.pipe(Effect.provideService(SqlClient.SqlClient, sql))),
        ),
        Effect.mapError((error) =>
          isError(error) ? error : deny("Mailbox custody is unavailable"),
        ),
      );
    const operationRecord = Effect.fn("mailbox.operationRecord")(function* (operationId: string) {
      const rows =
        yield* sql`SELECT operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,request_hash,root_task_id,maximum_tokens,deadline_at_ms,status,
      CASE WHEN length(CAST(intent_json AS BLOB)) <= 1048576 THEN intent_json ELSE NULL END AS intent_json
      FROM project_team_pi_operation WHERE operation_id=${operationId} LIMIT 2`;
      if (rows.length !== 1)
        return yield* deny("Original assignment operation is missing or ambiguous");
      const row = yield* decodeOperationRow(rows[0]);
      const intent = yield* decodeOperationIntent(row.intent_json);
      if (
        row.environment_id !== environmentId ||
        intent.binding.environmentId !== environmentId ||
        row.project_id !== intent.binding.projectId ||
        row.binding_id !== intent.binding.recordId ||
        row.generation !== intent.binding.generation ||
        row.provider_instance_id !== intent.binding.providerInstanceId ||
        row.thread_id !== intent.binding.threadId ||
        intent.request.operationId !== operationId ||
        intent.request.threadId !== row.thread_id ||
        row.request_hash !== hash(intent.request) ||
        row.intent_json !== canonical(intent)
      )
        return yield* deny("Original operation owner differs");
      return { row, intent };
    });
    const operation = Effect.fn("mailbox.operation")(function* (operationId: string) {
      const { row, intent } = yield* operationRecord(operationId);
      const dispatches = yield* sql<{
        dispatch_id: string;
      }>`SELECT dispatch_id FROM project_team_dispatch WHERE environment_id=${environmentId} AND project_id=${row.project_id} AND binding_id=${row.binding_id} AND generation=${row.generation} LIMIT 2`;
      if (dispatches.length !== 1)
        return yield* deny("Original assignment dispatch is missing or ambiguous");
      const snapshot = yield* journal.readRetained(dispatches[0]!.dispatch_id);
      const transition = snapshot.intent.compiledClaim.transition;
      if (transition?.kind !== "claim") return yield* deny("Original assignment claim is missing");
      const binding = transition.binding;
      const limits = snapshot.intent.limits;
      const budgets = yield* sql<{
        maximum_tokens: number;
        deadline_at_ms: number;
      }>`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget WHERE environment_id=${environmentId} AND project_id=${row.project_id} AND root_task_id=${row.root_task_id} LIMIT 2`;
      if (
        row.environment_id !== environmentId ||
        binding.environmentId !== environmentId ||
        row.project_id !== binding.projectId ||
        row.binding_id !== binding.recordId ||
        row.generation !== binding.generation ||
        row.provider_instance_id !== binding.providerInstanceId ||
        row.thread_id !== binding.threadId ||
        snapshot.fence.claimGeneration < 1 ||
        operationId !== snapshot.intent.request.assignmentOperationId ||
        intent.request.operationId !== operationId ||
        intent.request.threadId !== row.thread_id ||
        intent.request.prompt !== snapshot.intent.request.assignment ||
        row.request_hash !== hash(intent.request) ||
        canonical(intent) !== row.intent_json ||
        immutableBinding(intent.binding) !== immutableBinding(binding) ||
        row.root_task_id !== limits.rootTaskId ||
        intent.rootBudget.rootTaskId !== limits.rootTaskId ||
        intent.rootBudget.maximumTokens !== limits.maximumTokens ||
        intent.rootBudget.deadlineAtMs !== limits.rootDeadlineAtMs ||
        row.maximum_tokens !== intent.operationLimits.maximumTokens ||
        row.deadline_at_ms !== intent.operationLimits.deadlineAtMs ||
        row.maximum_tokens > limits.attemptMaximumTokens ||
        row.deadline_at_ms > limits.deadlineAtMs ||
        budgets.length !== 1 ||
        budgets[0]?.maximum_tokens !== limits.maximumTokens ||
        budgets[0]?.deadline_at_ms !== limits.rootDeadlineAtMs
      )
        return yield* deny("Original assignment identity or frozen budget differs");
      return { row, intent, snapshot, binding };
    });
    const forward = (original: Effect.Success<ReturnType<typeof operation>>, observed = false) =>
      original.snapshot.fence.stage === "assignment-intent" ||
      (observed && original.snapshot.fence.stage === "assignment-observed")
        ? Effect.void
        : Effect.fail(deny("Original assignment is not at its active delivery boundary"));
    const current = Effect.fn("mailbox.current")(function* (
      original: Effect.Success<ReturnType<typeof operation>>,
    ) {
      const binding = original.binding;
      const credential = yield* authorization.discover({
        providerInstanceId: binding.providerInstanceId,
        threadId: binding.threadId,
      });
      if (
        !credential ||
        credential.bindingId !== binding.recordId ||
        credential.generation !== binding.generation ||
        credential.projectId !== binding.projectId
      )
        return yield* deny("Original mailbox owner was replaced");
      const authority = yield* authorization.resolve({
        actor: { kind: "agent", id: managedActorId(credential) },
        managed: credential,
      });
      if (
        !authority ||
        immutableBinding(authority.binding) !== immutableBinding(binding) ||
        !authority.binding.sessionId
      )
        return yield* deny("Original mailbox owner is unavailable");
      const records = authority.state.foundationRecords ?? [];
      const members = records.filter((r) => r.kind === "member" && r.recordId === binding.memberId);
      const memberships = records.filter(
        (r) => r.kind === "task-membership" && r.taskId === binding.taskId,
      );
      const tasks = authority.state.tasks.filter((t) => t.taskId === binding.taskId);
      const member = members[0];
      const taskMembership = memberships[0];
      const task = tasks[0];
      if (
        members.length !== 1 ||
        member?.kind !== "member" ||
        memberships.length !== 1 ||
        taskMembership?.kind !== "task-membership" ||
        tasks.length !== 1 ||
        !task ||
        task.state !== "in-progress"
      )
        return yield* deny("Original mailbox recipient is missing or ambiguous");
      return {
        authority,
        recipient: { member, runBinding: authority.binding, taskMembership, task },
      };
    });
    const batch = Effect.fn("mailbox.batch")(function* (operationId: string) {
      const rows =
        yield* sql`SELECT operation_id,batch_id,environment_id,project_id,dispatch_id,binding_id,generation,
      CASE WHEN length(CAST(manifest_json AS BLOB)) <= 262144 THEN manifest_json ELSE NULL END AS manifest_json,manifest_sha256,
      CASE WHEN length(CAST(system_text AS BLOB)) <= 65536 THEN system_text ELSE NULL END AS system_text,system_text_sha256,revision,status
      FROM project_team_mailbox_batch WHERE operation_id=${operationId} LIMIT 2`;
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) return yield* deny("Sealed mailbox is ambiguous");
      const row = yield* decodeBatchRow(rows[0]);
      const manifest = yield* Effect.try({
        try: () => decodeManifest(row.manifest_json),
        catch: () => deny("Sealed mailbox manifest is invalid"),
      });
      if (
        row.environment_id !== environmentId ||
        row.operation_id !== manifest.operationId ||
        row.project_id !== manifest.projectId ||
        row.dispatch_id !== manifest.dispatchId ||
        row.binding_id !== manifest.bindingId ||
        row.generation !== manifest.generation ||
        manifest.environmentId !== environmentId ||
        row.batch_id !== idFor("mailbox-batch", environmentId, operationId) ||
        row.manifest_json !== canonical(manifest) ||
        row.manifest_sha256 !== textHash(row.manifest_json) ||
        row.system_text_sha256 !== textHash(row.system_text) ||
        new Set(manifest.deliveries.map((d) => d.message.recordId)).size !==
          manifest.deliveries.length
      )
        return yield* deny("Sealed mailbox integrity differs");
      return { row, manifest };
    });
    const sealInside = Effect.fn("mailbox.sealInside")(function* (input: typeof SealInput.Type) {
      const original = yield* operation(input.operationId);
      yield* forward(original);
      const owner = yield* current(original);
      if (original.row.status === "settled" || original.row.status === "quarantine")
        return yield* deny("Assignment is no longer available for initial sealing");
      const retained = yield* batch(input.operationId);
      if (retained) {
        if (
          retained.manifest.intentSha256 !== hash(original.snapshot.intent) ||
          retained.manifest.requestHash !== original.row.request_hash ||
          retained.manifest.workerId !== original.row.worker_id ||
          retained.manifest.baseSystemTextSha256 !== textHash(input.baseSystemText) ||
          retained.row.system_text !== render(input.baseSystemText, retained.manifest.deliveries)
        )
          return yield* deny("Initial assignment seal conflicts");
        return {
          batchId: retained.row.batch_id,
          systemText: retained.row.system_text,
          systemTextSha256: retained.row.system_text_sha256,
        };
      }
      const records = owner.authority.state.foundationRecords ?? [];
      const messages = records
        .filter((r) => r.kind === "message")
        .filter((r) => r.status === "queued" && r.recipientId === original.binding.memberId)
        .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
        .slice(0, 128);
      const plan = planMessageDelivery({
        projectId: original.binding.projectId,
        messages,
        candidates: [{ ...owner.recipient, safeTurnBoundary: true }],
      });
      if (!plan.accepted) return yield* deny("Initial mailbox targets are invalid");
      const deliveries: (typeof Manifest.Type)["deliveries"][number][] = [];
      for (const delivery of plan.deliveries) {
        const sender = records.filter(
          (r) => r.kind === "member" && r.recordId === delivery.message.senderId,
        );
        if (sender.length !== 1 || sender[0]?.kind !== "member" || sender[0].status !== "active")
          continue;
        if (deliveries.length === 64) break;
        const candidate = [...deliveries, delivery];
        const candidateBytes = Buffer.byteLength(render(input.baseSystemText, candidate));
        if (
          candidateBytes > 65536 ||
          candidateBytes + Buffer.byteLength(original.intent.request.prompt) > 131072
        )
          continue;
        deliveries.push(delivery);
      }
      const systemText = render(input.baseSystemText, deliveries);
      if (
        Buffer.byteLength(systemText) + Buffer.byteLength(original.intent.request.prompt) >
        131072
      )
        return yield* deny("Initial assignment context exceeds its bound");
      const manifest = yield* decodeManifestValue({
        version: 1,
        operationId: input.operationId,
        environmentId,
        projectId: original.binding.projectId,
        dispatchId: original.snapshot.fence.dispatchId,
        bindingId: original.binding.recordId,
        generation: original.binding.generation,
        claimGeneration: original.snapshot.fence.claimGeneration,
        intentSha256: hash(original.snapshot.intent),
        requestHash: original.row.request_hash,
        workerId: original.row.worker_id,
        baseSystemTextSha256: textHash(input.baseSystemText),
        binding: owner.authority.binding,
        deliveries,
      });
      const manifestJson = canonical(manifest);
      if (Buffer.byteLength(manifestJson) > 262144)
        return yield* deny("Initial assignment manifest exceeds its bound");
      const batchId = idFor("mailbox-batch", environmentId, input.operationId);
      yield* sql`INSERT INTO project_team_mailbox_batch(operation_id,batch_id,environment_id,project_id,dispatch_id,binding_id,generation,manifest_json,manifest_sha256,system_text,system_text_sha256,revision,status)
      VALUES(${input.operationId},${batchId},${environmentId},${manifest.projectId},${manifest.dispatchId},${manifest.bindingId},${manifest.generation},${manifestJson},${textHash(manifestJson)},${systemText},${textHash(systemText)},0,'sealed') ON CONFLICT(operation_id) DO NOTHING`;
      const stored = yield* batch(input.operationId);
      if (
        !stored ||
        stored.row.manifest_json !== manifestJson ||
        stored.row.system_text !== systemText
      )
        return yield* deny("Initial assignment first winner differs");
      const finalOriginal = yield* operation(input.operationId);
      yield* forward(finalOriginal);
      if (canonical(finalOriginal.snapshot.fence) !== canonical(original.snapshot.fence))
        return yield* deny("Original assignment fence changed during sealing");
      const final = yield* current(finalOriginal);
      if (canonical(final.recipient) !== canonical(owner.recipient))
        return yield* deny("Initial assignment owner changed during sealing");
      return { batchId, systemText, systemTextSha256: stored.row.system_text_sha256 };
    });
    const sealInitialAssignment = (input: typeof SealInput.Type) => {
      try {
        return own(sealInside(exact(input, decodeSeal)));
      } catch {
        return own(Effect.fail(deny("Initial assignment input is invalid")));
      }
    };
    const sealContextInside = Effect.fn("mailbox.sealContextInside")(function* (
      input: typeof SealInput.Type,
    ) {
      const { row } = yield* operationRecord(input.operationId);
      if (row.status === "settled" || row.status === "quarantine")
        return yield* deny("Prompt is not held for context transfer");
      const dispatches =
        yield* sql`SELECT dispatch_id FROM project_team_dispatch WHERE environment_id=${environmentId} AND project_id=${row.project_id} AND binding_id=${row.binding_id} AND generation=${row.generation} LIMIT 2`;
      if (dispatches.length === 0) return undefined;
      if (dispatches.length !== 1) return yield* deny("Assignment dispatch is ambiguous");
      return yield* sealInside(input);
    });
    const sealAssignmentContext = (input: typeof SealInput.Type) => {
      try {
        return own(sealContextInside(exact(input, decodeSeal)));
      } catch {
        return own(Effect.fail(deny("Assignment context input is invalid")));
      }
    };
    const selectedCurrent = Effect.fn("mailbox.selectedCurrent")(function* (
      retained: NonNullable<Effect.Success<ReturnType<typeof batch>>>,
      owner: Effect.Success<ReturnType<typeof current>>,
    ) {
      const records = owner.authority.state.foundationRecords ?? [];
      const messages: (typeof ProjectTeamMessage.Type)[] = [];
      for (const selected of retained.manifest.deliveries) {
        const candidates = records.filter(
          (r) => r.kind === "message" && r.recordId === selected.message.recordId,
        );
        const message = candidates[0];
        const senders = records.filter(
          (r) => r.kind === "member" && r.recordId === selected.message.senderId,
        );
        if (
          candidates.length !== 1 ||
          message?.kind !== "message" ||
          senders.length !== 1 ||
          senders[0]?.kind !== "member" ||
          senders[0].status !== "active"
        )
          return yield* deny("Sealed message or sender is unavailable");
        if (canonical(message) !== canonical(selected.message))
          return yield* deny("Sealed message changed before consumption");
        const plan = planMessageDelivery({
          projectId: retained.manifest.projectId,
          messages: [message],
          candidates: [{ ...owner.recipient, safeTurnBoundary: true }],
        });
        if (
          !plan.accepted ||
          plan.deliveries.length !== 1 ||
          canonical(plan.deliveries[0]?.target) !== canonical(selected.target)
        )
          return yield* deny("Sealed delivery target changed");
        messages.push(message);
      }
      return messages;
    });
    const inputRow = Effect.fn("mailbox.inputRow")(function* (reservationId: string) {
      const rows =
        yield* sql`SELECT reservation_id,operation_id,request_id,worker_id,generation,route_id,provider,model,system_text_sha256,encoded_request_sha256
      FROM project_team_mailbox_input WHERE reservation_id=${reservationId} LIMIT 2`;
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) return yield* deny("Mailbox input is ambiguous");
      return yield* decodeBoundInput(rows[0]);
    });
    const bindInside = Effect.fn("mailbox.bindInside")(function* (input: typeof BindInput.Type) {
      const original = yield* operation(input.operationId);
      yield* forward(original);
      const owner = yield* current(original);
      const sealed = yield* batch(input.operationId);
      if (
        !sealed ||
        sealed.manifest.intentSha256 !== hash(original.snapshot.intent) ||
        sealed.manifest.workerId !== original.row.worker_id ||
        sealed.manifest.requestHash !== original.row.request_hash
      )
        return yield* deny("Original assignment has no matching seal");
      yield* selectedCurrent(sealed, owner);
      const reservations =
        yield* sql`SELECT reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,operation_id,request_id,route_id,provider,model,
      maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,capacity_state,CASE WHEN length(CAST(reservation_json AS BLOB)) <= 8192 THEN reservation_json ELSE NULL END AS reservation_json
      FROM project_team_model_request WHERE reservation_id=${input.reservationId} LIMIT 2`;
      if (reservations.length !== 1)
        return yield* deny("Actual reserved input is missing or ambiguous");
      const reservation = yield* decodeReservationRow(reservations[0]);
      const decoded = yield* decodeReservation(reservation.reservation_json);
      const expected = {
        workerId: original.row.worker_id,
        generation: original.row.generation,
        operationId: input.operationId,
        requestId: reservation.request_id,
        routeId: reservation.route_id,
        provider: reservation.provider,
        model: reservation.model,
        maxInputTokens: reservation.maximum_input_tokens,
        maxOutputTokens: reservation.maximum_output_tokens,
        callCount: 1,
        deadlineAtMs: reservation.deadline_at_ms,
      };
      if (
        reservation.environment_id !== environmentId ||
        reservation.project_id !== original.binding.projectId ||
        reservation.root_task_id !== original.row.root_task_id ||
        reservation.run_id !== original.binding.recordId ||
        reservation.attempt_id !== original.binding.attemptId ||
        reservation.worker_id !== original.row.worker_id ||
        reservation.generation !== original.binding.generation ||
        reservation.operation_id !== input.operationId ||
        reservation.model !== original.binding.model ||
        reservation.deadline_at_ms > original.row.deadline_at_ms ||
        reservation.maximum_input_tokens + reservation.maximum_output_tokens >
          original.row.maximum_tokens ||
        canonical(decoded) !== canonical(expected)
      )
        return yield* deny("Reserved input does not belong to original assignment");
      const expectedInput = yield* decodeBoundInput({
        reservation_id: reservation.reservation_id,
        operation_id: input.operationId,
        request_id: reservation.request_id,
        worker_id: reservation.worker_id,
        generation: reservation.generation,
        route_id: reservation.route_id,
        provider: reservation.provider,
        model: reservation.model,
        system_text_sha256: sealed.row.system_text_sha256,
        encoded_request_sha256: input.encodedRequestSha256,
      });
      const existing = yield* inputRow(input.reservationId);
      if (existing) {
        if (canonical(existing) !== canonical(expectedInput))
          return yield* deny("Retained input conflicts with original request");
        return {
          reservationId: input.reservationId,
          encodedRequestSha256: input.encodedRequestSha256,
        };
      }
      if (
        reservation.status !== "held" ||
        reservation.capacity_state !== "held" ||
        original.row.status !== "running" ||
        sealed.row.status !== "sealed"
      )
        return yield* deny("Input must bind before the original transport settles");
      yield* sql`INSERT INTO project_team_mailbox_input(reservation_id,operation_id,request_id,worker_id,generation,route_id,provider,model,system_text_sha256,encoded_request_sha256)
      VALUES(${expectedInput.reservation_id},${expectedInput.operation_id},${expectedInput.request_id},${expectedInput.worker_id},${expectedInput.generation},${expectedInput.route_id},${expectedInput.provider},${expectedInput.model},${expectedInput.system_text_sha256},${expectedInput.encoded_request_sha256}) ON CONFLICT(reservation_id) DO NOTHING`;
      if (canonical(yield* inputRow(input.reservationId)) !== canonical(expectedInput))
        return yield* deny("Retained input first winner differs");
      const finalOriginal = yield* operation(input.operationId);
      yield* forward(finalOriginal);
      if (canonical(finalOriginal.snapshot.fence) !== canonical(original.snapshot.fence))
        return yield* deny("Original assignment fence changed during binding");
      const finalOwner = yield* current(finalOriginal);
      if (canonical(finalOwner.recipient) !== canonical(owner.recipient))
        return yield* deny("Original input owner changed during binding");
      yield* selectedCurrent(sealed, finalOwner);
      return {
        reservationId: input.reservationId,
        encodedRequestSha256: input.encodedRequestSha256,
      };
    });
    const bindRequestInput = (input: typeof BindInput.Type) => {
      try {
        return own(bindInside(exact(input, decodeBind)));
      } catch {
        return own(Effect.fail(deny("Original request input is invalid")));
      }
    };
    const phase = Effect.fn("mailbox.phase")(function* (
      operationId: string,
      status: "uncertain" | "delivered",
    ) {
      const rows =
        yield* sql`SELECT operation_id,phase,CASE WHEN length(CAST(command_json AS BLOB)) <= 262144 THEN command_json ELSE NULL END AS command_json,
      command_sha256,observation_sha256,observed_at,CASE WHEN length(CAST(outcome_json AS BLOB)) <= 262144 THEN outcome_json ELSE NULL END AS outcome_json
      FROM project_team_mailbox_reflection WHERE operation_id=${operationId} AND phase=${status} LIMIT 2`;
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) return yield* deny("Retained reflection is ambiguous");
      const row = yield* decodeReflectionRow(rows[0]);
      const commands = yield* decodeCommands(row.command_json);
      const outcomes = yield* decodeOutcomes(row.outcome_json);
      if (
        row.command_json !== canonical(commands) ||
        row.outcome_json !== canonical(outcomes) ||
        row.command_sha256 !== textHash(row.command_json) ||
        row.phase !== status
      )
        return yield* deny("Retained reflection integrity differs");
      return { row, commands, outcomes };
    });
    const qualifiedInputs = Effect.fn("mailbox.qualifiedInputs")(function* (
      sealed: NonNullable<Effect.Success<ReturnType<typeof batch>>>,
      receipt: ProjectTeamAssignmentReceipt,
    ) {
      const rows =
        yield* sql`SELECT reservation_id,operation_id,request_id,worker_id,generation,route_id,provider,model,system_text_sha256,encoded_request_sha256
      FROM project_team_mailbox_input WHERE operation_id=${sealed.row.operation_id} ORDER BY request_id LIMIT 257`;
      if (
        rows.length === 0 ||
        rows.length > 256 ||
        rows.length !== receipt.terminal.accountingReceipts.length
      )
        return yield* deny("Original consumed input accounting is incomplete");
      const inputs = yield* Effect.forEach(rows, (row) => decodeBoundInput(row));
      const seen = new Set<string>();
      for (const input of inputs) {
        const matches = receipt.terminal.accountingReceipts.filter(
          (r) => r.reservationId === input.reservation_id,
        );
        const accounted = matches[0];
        if (
          seen.has(input.reservation_id) ||
          matches.length !== 1 ||
          !accounted ||
          input.operation_id !== receipt.operation.operationId ||
          input.worker_id !== receipt.identity.workerId ||
          input.generation !== receipt.identity.generation ||
          input.request_id !== accounted.requestId ||
          input.route_id !== accounted.routeId ||
          input.provider !== accounted.provider ||
          input.model !== accounted.model ||
          input.system_text_sha256 !== sealed.row.system_text_sha256
        )
          return yield* deny("Original consumption does not match bound request");
        seen.add(input.reservation_id);
      }
      return inputs;
    });
    const priorMessages = Effect.fn("mailbox.priorMessages")(function* (
      sealed: NonNullable<Effect.Success<ReturnType<typeof batch>>>,
      previous: Effect.Success<ReturnType<typeof phase>>,
    ) {
      if (!previous) return sealed.manifest.deliveries.map((d) => d.message);
      if (
        previous.row.phase !== "uncertain" ||
        previous.outcomes.length !== sealed.manifest.deliveries.length
      )
        return yield* deny("Original uncertainty chain differs");
      for (const [index, selected] of sealed.manifest.deliveries.entries()) {
        const outcome = previous.outcomes[index];
        if (
          !outcome ||
          canonical(outcome) !==
            canonical({
              ...selected.message,
              revision: selected.message.revision + 1,
              status: "uncertain",
              updatedAt: previous.row.observed_at,
              deliveryGeneration: selected.target.deliveryGeneration,
              deliveryCursor: selected.target.deliveryCursor,
            })
        )
          return yield* deny("Original uncertainty message differs");
      }
      return previous.outcomes;
    });
    const verifyPhase = Effect.fn("mailbox.verifyPhase")(function* (
      sealed: NonNullable<Effect.Success<ReturnType<typeof batch>>>,
      saved: NonNullable<Effect.Success<ReturnType<typeof phase>>>,
      previous: Effect.Success<ReturnType<typeof phase>>,
    ) {
      const prior = yield* priorMessages(sealed, previous);
      if (
        saved.outcomes.length !== prior.length ||
        saved.commands.length !== (prior.length === 0 ? 0 : 1)
      )
        return yield* deny("Retained reflection coverage differs");
      for (const [index, message] of prior.entries()) {
        const selected = sealed.manifest.deliveries[index];
        const next = saved.outcomes[index];
        if (
          !selected ||
          !next ||
          canonical(next) !==
            canonical({
              ...message,
              revision: message.revision + 1,
              status: saved.row.phase,
              updatedAt: saved.row.observed_at,
              deliveryGeneration: selected.target.deliveryGeneration,
              deliveryCursor: selected.target.deliveryCursor,
            })
        )
          return yield* deny("Retained reflection outcome differs");
      }
      for (const command of saved.commands) {
        const attribution = {
          actor: { kind: "system", id: "project-team-mailbox-consumption" },
          source: { kind: "system", id: "project-team-mailbox-consumption" },
          recordedAt: saved.row.observed_at,
        };
        if (
          command.type !== "project-work.foundation.commit" ||
          command.commandId !==
            idFor(`mailbox-${saved.row.phase}`, environmentId, sealed.row.operation_id) ||
          command.projectId !== sealed.row.project_id ||
          command.committedAt !== saved.row.observed_at ||
          canonical(command.attribution) !== canonical(attribution) ||
          canonical(command.records) !== canonical(saved.outcomes) ||
          command.guided !== undefined ||
          command.transition !== undefined
        )
          return yield* deny("Retained reflection command differs");
        const receipts = yield* sql<{
          payload_fingerprint: string;
        }>`SELECT payload_fingerprint FROM project_work_command_receipts WHERE project_id=${command.projectId} AND command_id=${command.commandId} LIMIT 2`;
        const fingerprint = projectWorkPayloadFingerprint({
          ...command,
          attribution: { actor: attribution.actor, source: attribution.source },
        });
        if (receipts.length !== 1 || receipts[0]?.payload_fingerprint !== fingerprint)
          return yield* deny("Original reflection commit receipt is missing or changed");
        const events = yield* sql<{
          payload_json: string;
        }>`SELECT CASE WHEN length(CAST(payload_json AS BLOB)) <= 1048576 THEN payload_json ELSE NULL END AS payload_json
        FROM project_work_events WHERE project_id=${command.projectId} AND command_id=${command.commandId} ORDER BY sequence LIMIT 65`;
        if (events.length !== saved.outcomes.length)
          return yield* deny("Original reflection events are incomplete");
        for (const [index, row] of events.entries()) {
          const payload = yield* decodeEventPayload(row.payload_json);
          const event = yield* Effect.try({
            try: () => decodeProjectWorkEvent(payload),
            catch: () => deny("Original reflection event is invalid"),
          });
          if (
            event.type !== "project-work.foundation.recorded" ||
            canonical(event.record) !== canonical(saved.outcomes[index])
          )
            return yield* deny("Original reflection event differs");
        }
      }
    });
    const physicalMessage = Effect.fn("mailbox.physicalMessage")(function* (
      message: typeof ProjectTeamMessage.Type,
    ) {
      const rows =
        yield* sql`SELECT record_id,project_id,status,revision,generation,updated_at,task_id,attempt_id,member_id,source_id,scope_key,slot,unique_key,provider_instance_id,thread_id,session_id,
      CASE WHEN length(CAST(payload_json AS BLOB)) <= 262144 THEN payload_json ELSE NULL END AS payload_json
      FROM project_team_message WHERE record_id=${message.recordId} AND project_id=${message.projectId} LIMIT 2`;
      const row = rows[0];
      if (rows.length !== 1 || !row)
        return yield* deny("Physical mailbox message is missing or ambiguous");
      const payload = yield* decodeMessagePayload(row.payload_json);
      const { payload_json: _, ...columns } = row;
      const expected = {
        record_id: message.recordId,
        project_id: message.projectId,
        status: message.status,
        revision: message.revision,
        generation: message.generation,
        updated_at: message.updatedAt,
        task_id: message.taskId ?? null,
        attempt_id: null,
        member_id: null,
        source_id: null,
        scope_key: null,
        slot: null,
        unique_key: message.commandId,
        provider_instance_id: null,
        thread_id: null,
        session_id: null,
      };
      if (canonical(payload) !== canonical(message) || canonical(columns) !== canonical(expected))
        return yield* deny("Physical mailbox message write was skipped or changed");
    });
    const historicalCurrent = Effect.fn("mailbox.historicalCurrent")(function* (
      sealed: NonNullable<Effect.Success<ReturnType<typeof batch>>>,
      saved: NonNullable<Effect.Success<ReturnType<typeof phase>>>,
    ) {
      const state = yield* readCurrentState(sql, sealed.row.project_id);
      for (const outcome of saved.outcomes) {
        const matches =
          state.foundationRecords?.filter(
            (r) => r.kind === "message" && r.recordId === outcome.recordId,
          ) ?? [];
        const value = matches[0];
        if (
          matches.length !== 1 ||
          value?.kind !== "message" ||
          value.revision < outcome.revision ||
          value.deliveryCursor !== outcome.deliveryCursor ||
          value.deliveryGeneration !== outcome.deliveryGeneration ||
          (value.status !== "delivered" &&
            value.status !== "acknowledged" &&
            value.status !== "resolved" &&
            value.status !== "uncertain")
        )
          return yield* deny("Committed delivery provenance changed");
        const strip = (message: typeof ProjectTeamMessage.Type) => {
          const {
            revision: _,
            status: _status,
            updatedAt: _at,
            acknowledgedAt: _ack,
            resolvedAt: _resolved,
            ...immutable
          } = message;
          return canonical(immutable);
        };
        if (strip(value) !== strip(outcome))
          return yield* deny("Committed message identity changed");
        yield* physicalMessage(value);
      }
    });
    const reflect = (captured: typeof SnapshotInput.Type) =>
      Effect.suspend(() => {
        let result: Reflection | undefined;
        let validate: Effect.Effect<void, ProjectTeamMailboxConsumptionError> = Effect.void;
        return guard.pipe(
          Effect.flatMap(() =>
            repository.executeAtomic(
              Effect.gen(function* () {
                const retainedSnapshot = yield* journal.readRetained(captured.fence.dispatchId);
                if (canonical(retainedSnapshot) !== canonical(captured))
                  return yield* deny("Original assignment snapshot changed");
                const original = yield* operation(
                  retainedSnapshot.intent.request.assignmentOperationId,
                );
                if (canonical(original.snapshot) !== canonical(captured))
                  return yield* deny("Original assignment snapshot changed");
                const sealed = yield* batch(original.row.operation_id);
                if (
                  !sealed ||
                  sealed.manifest.intentSha256 !== hash(original.snapshot.intent) ||
                  sealed.manifest.claimGeneration !== original.snapshot.fence.claimGeneration ||
                  sealed.manifest.requestHash !== original.row.request_hash ||
                  sealed.manifest.workerId !== original.row.worker_id ||
                  immutableBinding(sealed.manifest.binding) !== immutableBinding(original.binding)
                )
                  return yield* deny("Original assignment has no exact retained seal");
                const saved = yield* phase(original.row.operation_id, "delivered");
                const uncertain = yield* phase(original.row.operation_id, "uncertain");
                if (sealed.row.status === "delivered") {
                  if (!saved || sealed.row.revision !== (uncertain ? 2 : 1))
                    return yield* deny("Committed mailbox reflection is missing");
                  const receipt = yield* receipts.readAssignment(original.snapshot);
                  if (!receipt || saved.row.observation_sha256 !== hash(receipt))
                    return yield* deny("Original successful consumption changed");
                  yield* qualifiedInputs(sealed, receipt);
                  if (uncertain) yield* verifyPhase(sealed, uncertain, undefined);
                  yield* verifyPhase(sealed, saved, uncertain);
                  yield* historicalCurrent(sealed, saved);
                  validate = Effect.gen(function* () {
                    yield* verifyPhase(sealed, saved, uncertain);
                    yield* historicalCurrent(sealed, saved);
                  }).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                    Effect.mapError((error) =>
                      isError(error) ? error : deny("Committed mailbox validation is unavailable"),
                    ),
                  );
                  result = { status: "unchanged", receipt };
                  return saved.commands;
                }
                yield* forward(original, true);
                if (
                  saved ||
                  sealed.row.revision !== (uncertain ? 1 : 0) ||
                  sealed.row.status !== (uncertain ? "uncertain" : "sealed")
                )
                  return yield* deny("Mailbox reflection state differs");
                if (
                  original.row.status === "prepared" ||
                  original.row.status === "starting" ||
                  original.row.status === "running"
                ) {
                  result = { status: "pending" };
                  return [];
                }
                const terminals = yield* sql<{
                  terminal_json: string | null;
                }>`SELECT CASE WHEN length(CAST(terminal_json AS BLOB)) <= 262144 THEN terminal_json ELSE NULL END AS terminal_json
        FROM project_team_pi_operation WHERE operation_id=${original.row.operation_id} LIMIT 2`;
                if (terminals.length !== 1 || terminals[0]?.terminal_json == null)
                  return yield* deny("Retained original terminal is missing");
                const terminal = yield* decodeTerminal(terminals[0].terminal_json);
                if (
                  terminal.identity.workerId !== original.row.worker_id ||
                  terminal.identity.generation !== original.row.generation ||
                  terminal.operation.operationId !== original.row.operation_id ||
                  terminal.operation.operationKind !== "prompt"
                )
                  return yield* deny("Retained terminal owner differs");
                const success = original.row.status === "settled" && terminal.outcome === "success";
                const receipt = success
                  ? yield* receipts.readAssignment(original.snapshot)
                  : undefined;
                if (success && !receipt)
                  return yield* deny("Successful original consumption is missing");
                if (receipt) yield* qualifiedInputs(sealed, receipt);
                const owner = yield* current(original);
                if (receipt && receipt.native.sessionId !== owner.authority.binding.sessionId)
                  return yield* deny("Current original native session differs");
                const status = success ? "delivered" : "uncertain";
                if (uncertain) {
                  yield* verifyPhase(sealed, uncertain, undefined);
                  if (!success) {
                    result = { status: "uncertain" };
                    return uncertain.commands;
                  }
                }
                const prior = yield* priorMessages(sealed, uncertain);
                const records = owner.authority.state.foundationRecords ?? [];
                const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
                const outcomes: (typeof ProjectTeamMessage.Type)[] = [];
                for (const [index, selected] of sealed.manifest.deliveries.entries()) {
                  const matches = records.filter(
                    (r) => r.kind === "message" && r.recordId === selected.message.recordId,
                  );
                  const message = matches[0];
                  const senders = records.filter(
                    (r) => r.kind === "member" && r.recordId === selected.message.senderId,
                  );
                  if (
                    matches.length !== 1 ||
                    message?.kind !== "message" ||
                    canonical(message) !== canonical(prior[index]) ||
                    senders.length !== 1 ||
                    senders[0]?.kind !== "member" ||
                    senders[0].status !== "active"
                  )
                    return yield* deny("Original sealed message or sender changed");
                  const transition = applyMessageReceipt({
                    message,
                    current: owner.recipient,
                    recordedTarget: selected.target,
                    receipt: {
                      ...selected.target,
                      expectedMessageRevision: message.revision,
                      status,
                      at,
                    },
                  });
                  if (!transition.accepted || !transition.changed)
                    return yield* deny("Current original delivery target changed");
                  outcomes.push(transition.message);
                }
                const commands =
                  outcomes.length === 0
                    ? []
                    : [
                        yield* decodeFoundationCommand({
                          type: "project-work.foundation.commit",
                          projectId: original.binding.projectId,
                          commandId: idFor(
                            `mailbox-${status}`,
                            environmentId,
                            original.row.operation_id,
                          ),
                          expectedRevision: owner.authority.state.revision,
                          committedAt: at,
                          attribution: {
                            actor: { kind: "system", id: "project-team-mailbox-consumption" },
                            source: { kind: "system", id: "project-team-mailbox-consumption" },
                            recordedAt: at,
                          },
                          records: outcomes,
                        }),
                      ];
                const commandJson = canonical(commands);
                const outcomeJson = canonical(outcomes);
                if (
                  Buffer.byteLength(commandJson) > 262144 ||
                  Buffer.byteLength(outcomeJson) > 262144
                )
                  return yield* deny("Reflection exceeds its retention bound");
                const observation = hash(receipt ?? { status: original.row.status, terminal });
                yield* sql`INSERT INTO project_team_mailbox_reflection(operation_id,phase,command_json,command_sha256,observation_sha256,observed_at,outcome_json)
        VALUES(${original.row.operation_id},${status},${commandJson},${textHash(commandJson)},${observation},${at},${outcomeJson}) ON CONFLICT(operation_id,phase) DO NOTHING`;
                const retained = yield* phase(original.row.operation_id, status);
                if (
                  !retained ||
                  retained.row.command_json !== commandJson ||
                  retained.row.outcome_json !== outcomeJson ||
                  retained.row.observation_sha256 !== observation
                )
                  return yield* deny("Reflection first winner differs");
                validate = Effect.gen(function* () {
                  const finalOriginal = yield* operation(original.row.operation_id);
                  yield* forward(finalOriginal, true);
                  if (
                    canonical(finalOriginal.snapshot.fence) !== canonical(original.snapshot.fence)
                  )
                    return yield* deny("Original assignment fence changed during reflection");
                  const finalOwner = yield* current(finalOriginal);
                  if (canonical(finalOwner.recipient) !== canonical(owner.recipient))
                    return yield* deny("Mailbox owner changed during reflection");
                  for (const outcome of outcomes) {
                    const value = finalOwner.authority.state.foundationRecords?.filter(
                      (r) => r.kind === "message" && r.recordId === outcome.recordId,
                    );
                    if (value?.length !== 1 || canonical(value[0]) !== canonical(outcome))
                      return yield* deny("Mailbox message write was skipped or changed");
                    yield* physicalMessage(outcome);
                    const senders = finalOwner.authority.state.foundationRecords?.filter(
                      (r) => r.kind === "member" && r.recordId === outcome.senderId,
                    );
                    if (
                      senders?.length !== 1 ||
                      senders[0]?.kind !== "member" ||
                      senders[0].status !== "active"
                    )
                      return yield* deny("Mailbox sender changed during reflection");
                  }
                  if (receipt) {
                    const finalReceipt = yield* receipts.readAssignment(finalOriginal.snapshot);
                    if (canonical(finalReceipt) !== canonical(receipt))
                      return yield* deny("Original consumption changed during reflection");
                    yield* qualifiedInputs(sealed, receipt);
                  } else {
                    const finalTerminal = yield* sql<{
                      terminal_json: string | null;
                    }>`SELECT CASE WHEN length(CAST(terminal_json AS BLOB)) <= 262144 THEN terminal_json ELSE NULL END AS terminal_json FROM project_team_pi_operation WHERE operation_id=${original.row.operation_id} LIMIT 2`;
                    if (
                      finalOriginal.row.status !== original.row.status ||
                      finalTerminal.length !== 1 ||
                      finalTerminal[0]?.terminal_json !== terminals[0]?.terminal_json
                    )
                      return yield* deny("Original uncertainty changed during reflection");
                  }
                  yield* verifyPhase(sealed, retained, uncertain);
                  const changed =
                    yield* sql`UPDATE project_team_mailbox_batch SET revision=revision+1,status=${status} WHERE operation_id=${sealed.row.operation_id} AND revision=${sealed.row.revision} AND status=${sealed.row.status} RETURNING operation_id`;
                  if (changed.length !== 1)
                    return yield* deny("Mailbox reflection CAS was skipped or superseded");
                  const finalBatch = yield* batch(sealed.row.operation_id);
                  if (
                    !finalBatch ||
                    finalBatch.row.revision !== sealed.row.revision + 1 ||
                    finalBatch.row.status !== status ||
                    finalBatch.row.manifest_json !== sealed.row.manifest_json
                  )
                    return yield* deny("Mailbox physical reflection CAS differs");
                }).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                  Effect.mapError((error) =>
                    isError(error) ? error : deny("Mailbox final validation is unavailable"),
                  ),
                );
                result = receipt ? { status: "delivered", receipt } : { status: "uncertain" };
                return commands;
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
              Effect.suspend(() => validate),
            ),
          ),
          Effect.flatMap(() =>
            result
              ? Effect.succeed(result)
              : Effect.fail(deny("Mailbox reflection did not commit")),
          ),
          Effect.mapError((error) =>
            isError(error) ? error : deny("Mailbox reflection is unavailable"),
          ),
        );
      });
    const reflectAssignment = (snapshot: ProjectTeamDispatchSnapshot) => {
      try {
        return reflect(exact(snapshot, Schema.decodeUnknownSync(SnapshotInput, strict)));
      } catch {
        return guard.pipe(
          Effect.flatMap(() => Effect.fail(deny("Original assignment snapshot is invalid"))),
        );
      }
    };
    return { sealInitialAssignment, sealAssignmentContext, bindRequestInput, reflectAssignment };
  },
);
