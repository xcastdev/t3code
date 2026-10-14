import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProviderOptionSelection,
  ProjectTeamRunBinding,
  ProjectTeamRoleRevision,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  isPiBrokerManagedModel,
  piBrokerModelRoute as piBrokerModelRouteFor,
} from "../provider/pi/PiManagedModels.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  MAX_PI_RUNTIME_FILES,
  PiManagedProcessAllocationSchema,
  type PiManagedProcessAllocation,
} from "../provider/pi/PiManagedProcess.ts";
import {
  PiNativeReference,
  PiWorkerIdentity,
  PiWorkerOperation,
} from "../provider/pi/PiWorkerProtocol.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import type { ProjectTeamDispatchSnapshot } from "./ProjectTeamDispatch.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import { auditProjectMemoryOperationLedger } from "./memory/ProjectMemoryModelAccounting.ts";

const strict = { onExcessProperty: "error" } as const;
const encode = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(encode(value)).digest("hex");
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Safe.check(Schema.isGreaterThan(0));
const bounded = (bytes: number) =>
  Schema.String.check(Schema.makeFilter((value) => Buffer.byteLength(value) <= bytes));
const OperationLimits = Schema.Struct({ maximumTokens: Positive, deadlineAtMs: Positive });
const RootBudget = Schema.Struct({ rootTaskId: Id, ...OperationLimits.fields });
const Usage = Schema.Struct({
  prompt_tokens: Safe,
  completion_tokens: Safe,
  total_tokens: Safe,
  prompt_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        audio_tokens: Schema.optional(Safe),
        cached_tokens: Schema.optional(Safe),
        cache_write_tokens: Schema.optional(Safe),
        cache_creation_input_tokens: Schema.optional(Safe),
        cache_read_input_tokens: Schema.optional(Safe),
        text_tokens: Schema.optional(Safe),
        image_tokens: Schema.optional(Safe),
        video_tokens: Schema.optional(Safe),
      }),
    ),
  ),
  completion_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        reasoning_tokens: Schema.optional(Safe),
        accepted_prediction_tokens: Schema.optional(Safe),
        rejected_prediction_tokens: Schema.optional(Safe),
        audio_tokens: Schema.optional(Safe),
      }),
    ),
  ),
  prompt_cache_hit_tokens: Schema.optional(Safe),
  prompt_cache_miss_tokens: Schema.optional(Safe),
  cached_tokens: Schema.optional(Safe),
});

const Drain = Schema.Struct({
  unit: Schema.String,
  invocation: Schema.String,
  cgroup: Schema.String,
  ownerPid: Schema.NullOr(Positive),
  memoryBytes: Positive,
  swapBytes: Schema.Literal(0),
  oomGroup: Schema.Literal(1),
  launcherPid: Positive,
  childPid: Schema.NullOr(Positive),
  childExitCode: Schema.NullOr(Schema.Int),
  kernel: Schema.String,
});
const decodeTerminal = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      identity: PiWorkerIdentity,
      operation: PiWorkerOperation,
      outcome: Schema.Literals(["success", "failed", "canceled", "quarantine"]),
      ownerCaptured: Schema.Boolean,
      native: Schema.NullOr(PiNativeReference),
      drain: Schema.NullOr(Drain),
      accountingReceipts: Schema.Array(
        Schema.Struct({
          requestId: Positive,
          reservationId: Schema.String,
          accountingReceiptId: Schema.String,
          routeId: Schema.String,
          provider: Schema.Literals(["command-code", "openai-codex"]),
          model: Schema.String,
          reportedModel: Schema.String,
          usage: Usage,
        }),
      ).check(Schema.isMaxLength(256)),
      failureCode: Schema.optionalKey(Schema.String),
    }),
  ),
  { onExcessProperty: "error" },
);

const validKernelDrain = (kernel: string) => {
  if (kernel === "removed") return true;
  if (kernel.length > 128) return false;
  const lines = kernel.endsWith("\n") ? kernel.slice(0, -1).split("\n") : kernel.split("\n");
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^(populated|frozen) ([01])$/.exec(line);
    if (!match || fields.has(match[1]!)) return false;
    fields.set(match[1]!, match[2]!);
  }
  return fields.get("populated") === "0";
};
// Validate historical descriptor values without checking removed staging files.
const nodePaths = process.getBuiltinModule("path");
const canonicalPath = (path: string) =>
  path.length <= 4096 &&
  /^\/[^\0\r\n]+$/.test(path) &&
  nodePaths.posix.normalize(path) === path &&
  path !== "/";
const overlaps = (left: string, right: string) =>
  left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
const physicalIdentity = (value: { readonly dev: number; readonly ino: number }) =>
  Number.isSafeInteger(value.dev) &&
  value.dev >= 0 &&
  Number.isSafeInteger(value.ino) &&
  value.ino > 0;
const validRetainedAllocation = (allocation: PiManagedProcessAllocation) => {
  const launch = allocation.launch;
  const native = launch.nativeState;
  if (
    !native ||
    !canonicalPath(launch.workspaceRoot) ||
    !canonicalPath(native.path) ||
    launch.nativeStateRoot !== native.path ||
    launch.workspace.path !== launch.workspaceRoot ||
    !physicalIdentity(launch.workspace) ||
    !physicalIdentity(native) ||
    overlaps(native.path, launch.workspaceRoot) ||
    launch.workspaceAccess === undefined ||
    !Number.isSafeInteger(launch.memoryBytes) ||
    launch.memoryBytes < 16777216 ||
    launch.memoryBytes > 2147483648 ||
    !Number.isSafeInteger(launch.runtimeSeconds) ||
    launch.runtimeSeconds < 1 ||
    launch.runtimeSeconds > 3600 ||
    allocation.policy.memoryBytes !== launch.memoryBytes ||
    allocation.policy.runtimeSeconds !== launch.runtimeSeconds ||
    launch.protectedRoots.length < 1 ||
    launch.protectedRoots.length > 64 ||
    launch.runtimeFiles.length < 1 ||
    launch.runtimeFiles.length > MAX_PI_RUNTIME_FILES ||
    launch.protectedWorkspaceEntries.length > 16 ||
    launch.argv.length < 1 ||
    launch.argv.length > 256 ||
    launch.argv.some((arg) => arg.includes("\0")) ||
    Buffer.byteLength(encode(launch.argv)) > 16384 ||
    !launch.runtimeFiles.some((file) => file.target === launch.argv[0])
  )
    return false;
  if (
    launch.protectedRoots.some(
      (root) =>
        !canonicalPath(root) || overlaps(root, launch.workspaceRoot) || overlaps(root, native.path),
    )
  )
    return false;
  for (const [index, file] of launch.runtimeFiles.entries()) {
    if (
      !canonicalPath(file.source) ||
      !canonicalPath(file.target) ||
      !physicalIdentity(file) ||
      !/^\/(?:runtime|bin|lib|lib64|usr\/lib|usr\/lib64)\//.test(file.target) ||
      overlaps(file.source, launch.workspaceRoot) ||
      overlaps(file.source, native.path) ||
      launch.protectedRoots.some((root) => overlaps(root, file.source)) ||
      launch.runtimeFiles.slice(0, index).some((other) => overlaps(other.target, file.target))
    )
      return false;
  }
  for (const [index, entry] of launch.protectedWorkspaceEntries.entries()) {
    const relative = entry.target.slice("/workspace/".length);
    if (
      !entry.target.startsWith("/workspace/") ||
      !canonicalPath(entry.target) ||
      !canonicalPath(entry.source) ||
      entry.source !== launch.workspaceRoot + "/" + relative ||
      !physicalIdentity(entry) ||
      launch.protectedWorkspaceEntries
        .slice(0, index)
        .some((other) => overlaps(other.target, entry.target))
    )
      return false;
  }
  return true;
};
const immutableBinding = (binding: typeof ProjectTeamRunBinding.Type) => {
  const {
    revision: _,
    status: _status,
    sessionId: _session,
    updatedAt: _at,
    ...immutable
  } = binding;
  return encode(immutable);
};

const RequestFields = {
  operationId: Id,
  threadId: ThreadId,
  runtimeMode: Schema.optionalKey(Schema.Literal("approval-required")),
  cwd: Schema.optionalKey(bounded(4096)),
  modelSelection: Schema.optionalKey(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      model: Id,
      options: Schema.optionalKey(Schema.Array(ProviderOptionSelection)),
    }),
  ),
  resumeCursor: Schema.optionalKey(Schema.NullOr(PiNativeReference)),
  skillPlan: Schema.optionalKey(Schema.JsonObject),
};
const Request = Schema.Union([
  Schema.Struct({ ...RequestFields, kind: Schema.Literal("initialize") }),
  Schema.Struct({ ...RequestFields, kind: Schema.Literal("prompt"), prompt: bounded(131072) }),
]);
const Intent = Schema.Struct({
  request: Request,
  binding: ProjectTeamRunBinding,
  role: ProjectTeamRoleRevision,
  allocation: PiManagedProcessAllocationSchema,
  resourceHash: Digest,
  rootBudget: RootBudget,
  operationLimits: OperationLimits,
});
const OperationRow = Schema.Struct({
  operation_id: Id,
  environment_id: Id,
  project_id: Id,
  binding_id: Id,
  generation: Safe,
  provider_instance_id: Id,
  thread_id: Id,
  worker_id: Id,
  operation_ordinal: Safe,
  operation_kind: Schema.Literals(["initialize", "prompt", "compact"]),
  request_hash: Digest,
  root_binding_id: Id,
  root_task_id: Id,
  maximum_tokens: Positive,
  deadline_at_ms: Positive,
  status: Schema.Literals(["prepared", "starting", "running", "settled", "quarantine"]),
  intent_json: bounded(1048576),
  native_json: Schema.NullOr(bounded(8192)),
  terminal_json: Schema.NullOr(bounded(262144)),
});
const ProcessRow = Schema.Struct({
  unit: Id,
  operation_id: Id,
  status: Schema.Literals(["allocated", "claimed", "captured", "drained", "quarantine"]),
  allocation_json: bounded(262144),
  owner_json: Schema.NullOr(bounded(262144)),
  drain_json: Schema.NullOr(bounded(262144)),
});
const Owner = Schema.Struct({
  type: Schema.Literal("owner"),
  unit: Id,
  nonce: Id,
  invocation: Id,
  cgroup: bounded(4096),
  pid: Positive,
  memoryBytes: Positive,
  swapBytes: Schema.Literal(0),
  oomGroup: Schema.Literal(1),
});
const AccountingRow = Schema.Struct({
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
  provider: Schema.Literals(["command-code", "openai-codex"]),
  model: Id,
  status: Schema.Literals(["held", "reported", "failed", "unknown"]),
  capacity_state: Schema.Literals(["held", "released", "quarantine", "legacy"]),
  accounting_receipt_id: Schema.NullOr(Id),
  settlement_json: Schema.NullOr(bounded(16384)),
  reservation_json: bounded(8192),
  maximum_input_tokens: Positive,
  maximum_output_tokens: Positive,
  deadline_at_ms: Positive,
  charged_input_tokens: Safe,
  charged_output_tokens: Safe,
  accounting_mode: Schema.Literals(["hard", "openai-subscription-monitored"]),
  unknown_maximum_tokens: Schema.NullOr(Schema.Literal(64_000)),
});
const decodeRow = Schema.decodeUnknownEffect(OperationRow, strict);
const decodeIntent = Schema.decodeUnknownEffect(Schema.fromJsonString(Intent), strict);
const decodeProcess = Schema.decodeUnknownEffect(ProcessRow, strict);
const decodeAllocation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PiManagedProcessAllocationSchema),
  strict,
);
const decodeOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(Owner), strict);
const decodeDrain = Schema.decodeUnknownEffect(Schema.fromJsonString(Drain), strict);
const decodeNative = Schema.decodeUnknownEffect(Schema.fromJsonString(PiNativeReference), strict);
const decodeAccounting = Schema.decodeUnknownEffect(AccountingRow, strict);
const decodeTransport = Schema.decodeUnknownEffect(
  Schema.Struct({ transportDrained: Schema.Literal(true) }),
);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json), strict);
const immutableRole = (role: typeof ProjectTeamRoleRevision.Type) => {
  const {
    revision: _,
    status: _status,
    generation: _generation,
    updatedAt: _at,
    ...original
  } = role;
  return encode(original);
};
export class ProjectTeamSessionReceiptError extends Schema.TaggedError<ProjectTeamSessionReceiptError>()(
  "ProjectTeamSessionReceiptError",
  {
    code: Schema.Literals(["denied", "uncertain", "unavailable"]),
    reason: Schema.String,
  },
) {}
const deny = (reason: string, code: ProjectTeamSessionReceiptError["code"] = "uncertain") =>
  new ProjectTeamSessionReceiptError({ code, reason });
const isReceiptError = Schema.is(ProjectTeamSessionReceiptError);
const corrupt = () => deny("Retained Pi evidence is invalid or incomplete");

/** Historical evidence only. Root separately owns current authority and executor admission. */
export const makeProjectTeamSessionReceipts = Effect.fn("makeProjectTeamSessionReceipts")(
  function* (options: {
    readonly environmentId: string;
    readonly maximumEnvironmentModelCalls: number;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* makeProjectTeamDispatchJournal(options);
    const retained = Effect.fn("ProjectTeamSessionReceipts.retained")(function* (
      snapshot: ProjectTeamDispatchSnapshot,
    ) {
      const supplied = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isSome(supplied) && supplied.value !== sql)
        return yield* deny("Receipt reads must use captured SQL client", "denied");
      const original = yield* journal.readRetained(snapshot.fence.dispatchId);
      yield* journal.readStageReceipts(snapshot.fence.dispatchId);
      if (encode(original) !== encode(snapshot) || original.fence.claimGeneration < 1)
        return yield* deny("Original claimed dispatch snapshot differs", "denied");
      const transition = original.intent.compiledClaim.transition;
      if (transition?.kind !== "claim")
        return yield* deny("Original dispatch has no claim", "denied");
      return { snapshot: original, binding: transition.binding };
    });
    const readOperation = Effect.fn("ProjectTeamSessionReceipts.readOperation")(function* (
      context: Effect.Success<ReturnType<typeof retained>>,
      kind: "initialize" | "prompt",
    ) {
      const { snapshot, binding } = context;
      const operationId =
        kind === "initialize"
          ? snapshot.intent.request.initializeOperationId
          : snapshot.intent.request.assignmentOperationId;
      const rows = yield* sql<
        Record<string, unknown>
      >`SELECT * FROM project_team_pi_operation WHERE operation_id=${operationId} LIMIT 2`;
      if (rows.length === 0) {
        const displaced =
          yield* sql`SELECT operation_id FROM project_team_pi_operation WHERE environment_id=${options.environmentId} AND binding_id=${binding.recordId} AND generation=${binding.generation} AND operation_kind=${kind} LIMIT 1`;
        if (displaced.length > 0)
          return yield* deny("Original Pi operation is missing amid correlated history");
        return undefined;
      }
      if (rows.length !== 1) return yield* deny("Original Pi operation is ambiguous");
      const row = yield* decodeRow(rows[0]).pipe(Effect.mapError(corrupt));
      const intent = yield* decodeIntent(row.intent_json).pipe(Effect.mapError(corrupt));
      const request = intent.request;
      const limits = snapshot.intent.limits;
      if (
        row.operation_id !== operationId ||
        row.environment_id !== options.environmentId ||
        row.project_id !== binding.projectId ||
        row.binding_id !== binding.recordId ||
        row.generation !== binding.generation ||
        row.provider_instance_id !== binding.providerInstanceId ||
        row.thread_id !== binding.threadId ||
        row.operation_kind !== kind ||
        request.kind !== kind ||
        request.operationId !== operationId ||
        request.threadId !== binding.threadId ||
        row.request_hash !== hash(request) ||
        immutableBinding(intent.binding) !== immutableBinding(binding) ||
        (request.cwd !== undefined && request.cwd !== binding.worktree) ||
        (request.modelSelection !== undefined &&
          (request.modelSelection.instanceId !== binding.providerInstanceId ||
            request.modelSelection.model !== binding.model)) ||
        (request.kind === "prompt" && request.prompt !== snapshot.intent.request.assignment) ||
        (request.kind === "initialize" &&
          request.resumeCursor !== undefined &&
          request.resumeCursor !== null) ||
        intent.role.recordId !== binding.roleRevisionId ||
        intent.role.projectId !== binding.projectId ||
        intent.role.model !== binding.model ||
        NodeCrypto.createHash("sha256").update(intent.role.instructions).digest("hex") !==
          binding.configuration.instructionsHash ||
        binding.configuration.toolIds.some((id) => !intent.role.tools.includes(id)) ||
        binding.configuration.skillIds.some((id) => !intent.role.skills.includes(id)) ||
        row.root_task_id !== limits.rootTaskId ||
        (!binding.parentRunId && row.root_binding_id !== binding.recordId) ||
        encode(intent.rootBudget) !==
          encode({
            rootTaskId: limits.rootTaskId,
            maximumTokens: limits.maximumTokens,
            deadlineAtMs: limits.rootDeadlineAtMs,
          }) ||
        intent.operationLimits.maximumTokens !== row.maximum_tokens ||
        intent.operationLimits.deadlineAtMs !== row.deadline_at_ms ||
        row.maximum_tokens > limits.attemptMaximumTokens ||
        row.deadline_at_ms > limits.deadlineAtMs
      )
        return yield* deny("Original Pi request or binding identity differs", "denied");
      const budgets = yield* sql<{
        maximum_tokens: number;
        deadline_at_ms: number;
      }>`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget WHERE environment_id=${options.environmentId} AND project_id=${binding.projectId} AND root_task_id=${limits.rootTaskId} LIMIT 2`;
      if (
        budgets.length !== 1 ||
        budgets[0]?.maximum_tokens !== limits.maximumTokens ||
        budgets[0]?.deadline_at_ms !== limits.rootDeadlineAtMs
      )
        return yield* deny("Original Pi root budget is missing or contradictory");
      // Read frozen provenance without checking whether this run still has execution authority.
      const state = yield* readCurrentState(sql, binding.projectId);
      const roles = (state.foundationRecords ?? []).filter(
        (r) => r.kind === "role-revision" && r.recordId === binding.roleRevisionId,
      );
      const role = roles[0];
      if (
        roles.length !== 1 ||
        role?.kind !== "role-revision" ||
        immutableRole(role) !== immutableRole(intent.role)
      )
        return yield* deny("Original Pi role provenance is missing or changed");
      let ancestor = binding;
      const seen = new Set<string>();
      while (ancestor.parentRunId !== undefined) {
        if (seen.has(ancestor.recordId) || seen.size >= 8)
          return yield* deny("Original Pi ancestry is ambiguous");
        seen.add(ancestor.recordId);
        const parents = (state.foundationRecords ?? []).filter(
          (r) => r.kind === "run-binding" && r.recordId === ancestor.parentRunId,
        );
        const parent = parents[0];
        if (
          parents.length !== 1 ||
          parent?.kind !== "run-binding" ||
          parent.environmentId !== options.environmentId ||
          parent.projectId !== binding.projectId
        )
          return yield* deny("Original Pi ancestor is missing or foreign");
        ancestor = parent;
      }
      if (row.root_binding_id !== ancestor.recordId || ancestor.taskId !== row.root_task_id)
        return yield* deny("Original Pi root binding differs");
      if (row.status !== "settled")
        return yield* deny(
          "Original Pi operation requires reconciliation; redispatch is forbidden",
        );
      if (!row.native_json || !row.terminal_json) return yield* corrupt();
      const native = yield* decodeNative(row.native_json).pipe(Effect.mapError(corrupt));
      const terminal = yield* decodeTerminal(row.terminal_json).pipe(Effect.mapError(corrupt));
      if (
        terminal.outcome !== "success" ||
        !terminal.ownerCaptured ||
        !terminal.native ||
        !terminal.drain ||
        terminal.failureCode !== undefined ||
        !native.persisted ||
        encode(terminal.native) !== encode(native) ||
        terminal.identity.workerId !== row.worker_id ||
        terminal.identity.generation !== row.generation ||
        terminal.operation.operationId !== operationId ||
        terminal.operation.operationKind !== kind
      )
        return yield* deny("Original Pi terminal does not prove successful completion");
      const processes = yield* sql<
        Record<string, unknown>
      >`SELECT * FROM project_team_pi_process WHERE operation_id=${operationId} LIMIT 2`;
      if (processes.length !== 1) return yield* deny("Original Pi process is missing or ambiguous");
      const process = yield* decodeProcess(processes[0]).pipe(Effect.mapError(corrupt));
      if (process.status !== "drained" || !process.owner_json || !process.drain_json)
        return yield* deny("Original Pi process has no retained drain");
      const allocation = yield* decodeAllocation(process.allocation_json).pipe(
        Effect.mapError(corrupt),
      );
      const owner = yield* decodeOwner(process.owner_json).pipe(Effect.mapError(corrupt));
      const drain = yield* decodeDrain(process.drain_json).pipe(Effect.mapError(corrupt));
      const nativeState = allocation.launch.nativeState;
      if (
        !nativeState ||
        !validRetainedAllocation(allocation) ||
        encode(allocation) !== encode(intent.allocation) ||
        process.unit !== allocation.unit ||
        process.operation_id !== operationId ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          allocation.nonce,
        ) ||
        allocation.unit !== `t3-pi-managed-${allocation.nonce}.service` ||
        allocation.launch.workspaceRoot !== binding.worktree ||
        owner.unit !== allocation.unit ||
        owner.nonce !== allocation.nonce ||
        !/^[a-f0-9]{32}$/.test(owner.invocation) ||
        owner.memoryBytes !== allocation.policy.memoryBytes ||
        !owner.cgroup.startsWith("/sys/fs/cgroup/") ||
        !owner.cgroup.endsWith(`/${owner.unit}`) ||
        owner.cgroup.split("/").some((part) => part === "." || part === "..") ||
        drain.unit !== owner.unit ||
        drain.invocation !== owner.invocation ||
        drain.cgroup !== owner.cgroup ||
        drain.ownerPid !== owner.pid ||
        drain.memoryBytes !== owner.memoryBytes ||
        drain.childExitCode !== 0 ||
        !drain.childPid ||
        !validKernelDrain(drain.kernel) ||
        encode(drain) !== encode(terminal.drain)
      )
        return yield* deny("Original Pi process/native ownership differs");
      const rawRequests = yield* sql<
        Record<string, unknown>
      >`SELECT reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,operation_id,request_id,route_id,provider,model,status,capacity_state,accounting_receipt_id,settlement_json,reservation_json,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,charged_input_tokens,charged_output_tokens,accounting_mode,unknown_maximum_tokens FROM project_team_model_request WHERE operation_id=${operationId}
        AND request_lane='pi' AND request_scope='' LIMIT 257`;
      const memoryLedger = yield* auditProjectMemoryOperationLedger(sql, {
        environmentId: options.environmentId,
        projectId: binding.projectId,
        bindingId: binding.recordId,
        generation: row.generation,
        operationId,
      });
      if (!memoryLedger.settled)
        return yield* deny("Original memory model transport is not settled and drained");
      if (
        rawRequests.length > 256 ||
        rawRequests.length !== terminal.accountingReceipts.length ||
        rawRequests.reduce((bytes, row) => bytes + Buffer.byteLength(encode(row)), 0) > 16777216
      )
        return yield* deny("Original Pi accounting is incomplete");
      const requests = yield* Effect.forEach(rawRequests, (r) =>
        decodeAccounting(r).pipe(Effect.mapError(corrupt)),
      );
      const seenReceipts = new Set<string>();
      const seenAccountingReceipts = new Set<string>();
      const seenRequests = new Set<number>();
      let chargedTokens = 0;
      for (const receipt of terminal.accountingReceipts) {
        const r = requests.find((r) => r.reservation_id === receipt.reservationId);
        if (r?.accounting_mode === "openai-subscription-monitored") {
          const grants = yield* sql<{
            model: string;
            route_id: string;
            maximum_tokens: number;
            maximum_duration_ms: number;
            deadline_at_ms: number;
            stopped_at_ms: number | null;
          }>`SELECT model,route_id,maximum_tokens,maximum_duration_ms,deadline_at_ms,stopped_at_ms
            FROM project_team_pi_subscription_grant WHERE environment_id=${r.environment_id}
            AND project_id=${r.project_id} AND root_task_id=${r.root_task_id}`;
          const grant = grants[0];
          if (
            !grant ||
            grant.model !== "gpt-6-luna" ||
            grant.route_id !== "openai-subscription-luna" ||
            grant.maximum_tokens !== 64_000 ||
            grant.maximum_duration_ms !== 300_000 ||
            grant.deadline_at_ms !== limits.rootDeadlineAtMs ||
            r.unknown_maximum_tokens !== 64_000
          )
            return yield* deny("Original subscription grant differs");
        }
        if (
          !r ||
          seenReceipts.has(receipt.reservationId) ||
          seenAccountingReceipts.has(receipt.accountingReceiptId) ||
          seenRequests.has(receipt.requestId) ||
          r.status !== "reported" ||
          r.capacity_state !== "released" ||
          r.environment_id !== options.environmentId ||
          r.project_id !== binding.projectId ||
          r.root_task_id !== row.root_task_id ||
          r.run_id !== binding.recordId ||
          r.attempt_id !== binding.attemptId ||
          r.operation_id !== operationId ||
          r.worker_id !== row.worker_id ||
          r.generation !== row.generation ||
          r.request_id !== receipt.requestId ||
          r.accounting_receipt_id !== receipt.accountingReceiptId ||
          !isPiBrokerManagedModel(binding.model) ||
          (r.accounting_mode === "openai-subscription-monitored") !==
            (binding.model === "gpt-6-luna" && receipt.provider === "openai-codex") ||
          r.route_id !== piBrokerModelRouteFor(binding.model).routeId ||
          r.route_id !== receipt.routeId ||
          r.provider !== receipt.provider ||
          r.model !== binding.model ||
          r.unknown_maximum_tokens !==
            (r.accounting_mode === "openai-subscription-monitored" ? 64_000 : null) ||
          receipt.model !== binding.model ||
          !piBrokerModelRouteFor(binding.model).acceptedReportedModels.some(
            (model) => model === receipt.reportedModel,
          ) ||
          !r.settlement_json ||
          r.maximum_input_tokens + r.maximum_output_tokens > row.maximum_tokens ||
          r.deadline_at_ms > row.deadline_at_ms ||
          (r.accounting_mode !== "openai-subscription-monitored" &&
            (receipt.usage.prompt_tokens > r.maximum_input_tokens ||
              receipt.usage.completion_tokens > r.maximum_output_tokens)) ||
          Object.values(receipt.usage.prompt_tokens_details ?? {}).some(
            (v) => v !== undefined && v > receipt.usage.prompt_tokens,
          ) ||
          Object.values(receipt.usage.completion_tokens_details ?? {}).some(
            (v) => v !== undefined && v > receipt.usage.completion_tokens,
          ) ||
          [
            receipt.usage.prompt_cache_hit_tokens,
            receipt.usage.prompt_cache_miss_tokens,
            receipt.usage.cached_tokens,
          ].some((v) => v !== undefined && v > receipt.usage.prompt_tokens)
        )
          return yield* deny("Original Pi accounting identity differs");
        const fields = {
          workerId: row.worker_id,
          operationId,
          generation: row.generation,
          requestId: receipt.requestId,
          routeId: receipt.routeId,
          provider: receipt.provider,
          model: receipt.model,
          maxInputTokens: r.maximum_input_tokens,
          maxOutputTokens: r.maximum_output_tokens,
          callCount: 1,
          deadlineAtMs: r.deadline_at_ms,
          ...(r.accounting_mode === "openai-subscription-monitored"
            ? { accountingMode: "openai-subscription-monitored", unknownMaximumTokens: 64_000 }
            : {}),
        };
        const reservation = yield* decodeJson(r.reservation_json).pipe(Effect.mapError(corrupt));
        const settlement = yield* decodeJson(r.settlement_json).pipe(Effect.mapError(corrupt));
        const transport = yield* decodeTransport(settlement).pipe(Effect.mapError(corrupt));
        if (
          encode(reservation) !== encode(fields) ||
          encode(settlement) !==
            encode({
              ...fields,
              ...transport,
              reservationId: receipt.reservationId,
              outcome: "reported",
              chargedInputTokens: r.charged_input_tokens,
              chargedOutputTokens: r.charged_output_tokens,
              reportedModel: receipt.reportedModel,
              reportedUsage: receipt.usage,
              ...(r.accounting_mode === "openai-subscription-monitored"
                ? { accountingMode: "openai-subscription-monitored", unknownMaximumTokens: 64_000 }
                : {}),
            }) ||
          receipt.usage.total_tokens !==
            receipt.usage.prompt_tokens + receipt.usage.completion_tokens ||
          r.charged_input_tokens !== receipt.usage.prompt_tokens ||
          r.charged_output_tokens !== receipt.usage.completion_tokens
        )
          return yield* deny("Original Pi accounting payload differs");
        const requestCharge = r.charged_input_tokens + r.charged_output_tokens;
        const totalCharge = chargedTokens + requestCharge;
        if (
          !Number.isSafeInteger(requestCharge) ||
          !Number.isSafeInteger(totalCharge) ||
          (totalCharge > row.maximum_tokens &&
            r.accounting_mode !== "openai-subscription-monitored")
        )
          return yield* deny("Original Pi aggregate accounting exceeds operation limit");
        chargedTokens = totalCharge;
        seenReceipts.add(receipt.reservationId);
        seenAccountingReceipts.add(receipt.accountingReceiptId);
        seenRequests.add(receipt.requestId);
      }
      return {
        request,
        intent,
        receipt: Object.freeze({
          dispatchId: snapshot.fence.dispatchId,
          claimCommandId: snapshot.intent.compiledClaim.commandId,
          claimGeneration: snapshot.fence.claimGeneration,
          environmentId: options.environmentId,
          projectId: binding.projectId,
          bindingId: binding.recordId,
          generation: binding.generation,
          providerInstanceId: binding.providerInstanceId,
          threadId: binding.threadId,
          operation: terminal.operation,
          identity: terminal.identity,
          ordinal: row.operation_ordinal,
          requestHash: row.request_hash,
          resourceHash: intent.resourceHash,
          native,
          workspace: allocation.launch.workspace,
          nativeState,
          owner,
          drain,
          terminal,
        }),
      };
    });
    const readInitialization = Effect.fn("ProjectTeamSessionReceipts.readInitialization")(
      function* (snapshot: ProjectTeamDispatchSnapshot) {
        return (yield* readOperation(yield* retained(snapshot), "initialize"))?.receipt;
      },
    );
    const readAssignment = Effect.fn("ProjectTeamSessionReceipts.readAssignment")(function* (
      snapshot: ProjectTeamDispatchSnapshot,
    ) {
      const context = yield* retained(snapshot);
      const assigned = yield* readOperation(context, "prompt");
      if (!assigned) return undefined;
      const initialized = yield* readOperation(context, "initialize");
      if (!initialized) return yield* deny("Original assignment has no initialization receipt");
      const original = initialized.receipt;
      const current = assigned.receipt;
      if (
        current.ordinal <= original.ordinal ||
        current.native.sessionId !== original.native.sessionId ||
        current.native.sessionReference !== original.native.sessionReference ||
        current.resourceHash !== original.resourceHash ||
        encode(current.workspace) !== encode(original.workspace) ||
        encode(current.nativeState) !== encode(original.nativeState) ||
        immutableBinding(assigned.intent.binding) !==
          immutableBinding(initialized.intent.binding) ||
        immutableRole(assigned.intent.role) !== immutableRole(initialized.intent.role) ||
        encode(assigned.request.skillPlan) !== encode(initialized.request.skillPlan) ||
        (assigned.request.resumeCursor !== undefined &&
          encode(assigned.request.resumeCursor) !== encode(original.native))
      )
        return yield* deny("Original assignment changed initialized native identity");
      return current;
    });
    const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.mapError((error) =>
            isReceiptError(error)
              ? error
              : deny("Durable session evidence unavailable", "unavailable"),
          ),
        );
    return {
      readInitialization: (snapshot: ProjectTeamDispatchSnapshot) =>
        read(readInitialization(snapshot)),
      readAssignment: (snapshot: ProjectTeamDispatchSnapshot) => read(readAssignment(snapshot)),
    };
  },
);
export type ProjectTeamInitializationReceipt = NonNullable<
  Effect.Success<
    ReturnType<
      Effect.Success<ReturnType<typeof makeProjectTeamSessionReceipts>>["readInitialization"]
    >
  >
>;
export type ProjectTeamAssignmentReceipt = NonNullable<
  Effect.Success<
    ReturnType<Effect.Success<ReturnType<typeof makeProjectTeamSessionReceipts>>["readAssignment"]>
  >
>;
