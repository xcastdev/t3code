import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectTeamRunBinding,
  ProjectTeamRoleRevision,
  CommandId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  PiManagedProcessError,
  PiManagedProcessAllocationSchema,
  MAX_PI_RUNTIME_FILES,
  type PiManagedProcessAllocation,
  type PiManagedProcessOwner,
} from "../provider/pi/PiManagedProcess.ts";
import {
  PiManagedRuntimeError,
  type PiManagedOperationRequest,
} from "../provider/pi/PiManagedRuntime.ts";
import {
  PiNativeReference,
  PiWorkerIdentity,
  PiWorkerOperation,
} from "../provider/pi/PiWorkerProtocol.ts";
import type { PiSessionTerminal } from "../provider/pi/PiSessionRuntime.ts";
import type { PiModelRequestReservation } from "../provider/pi/PiModelBroker.ts";
import { ModelAccountingError } from "./ProjectTeamModelAccounting.ts";
import {
  ProjectTeamAuthorization,
  managedActorId,
  type ProjectTeamAuthority,
  type ProjectTeamPrincipal,
} from "./ProjectTeamAuthorization.ts";
import { readCurrentState, ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";

const encode = canonicalProjectWorkPayload;
const isRuntimeError = Schema.is(PiManagedRuntimeError);
const isWorkerIdentity = Schema.is(PiWorkerIdentity);
const isWorkerOperation = Schema.is(PiWorkerOperation);
const decodeNativeInput = Schema.decodeUnknownEffect(PiNativeReference, {
  onExcessProperty: "error",
});
const decodeOwner = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      invocation: Schema.String,
      cgroup: Schema.String,
      pid: Schema.Int,
    }),
  ),
);
const ResourceIdentity = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const decodeResourceIdentity = Schema.decodeUnknownEffect(ResourceIdentity);
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Safe.check(Schema.isGreaterThan(0));
const OperationLimits = Schema.Struct({ maximumTokens: Positive, deadlineAtMs: Positive });
const RootBudget = Schema.Struct({ rootTaskId: Schema.String, ...OperationLimits.fields });
const decodeIntent = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      request: Schema.optional(Schema.Json),
      binding: Schema.Struct({
        recordId: Schema.String,
        generation: Schema.Int,
        worktree: Schema.String,
        branch: Schema.String,
        model: Schema.String,
        configuration: Schema.Unknown,
      }),
      role: Schema.Unknown,
      resourceHash: Schema.optional(ResourceIdentity),
      rootBudget: Schema.optional(RootBudget),
      operationLimits: Schema.optional(OperationLimits),
    }),
  ),
);
const decodeNative = Schema.decodeEffect(Schema.fromJsonString(PiNativeReference), {
  onExcessProperty: "error",
});
const decodeReadIdentity = Schema.decodeUnknownEffect(
  Schema.Struct({
    operationId: Schema.String,
    native: PiNativeReference,
    resourceHash: Schema.NullOr(ResourceIdentity),
  }),
  { onExcessProperty: "error" },
);
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
          accountingReceiptId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          routeId: Schema.String,
          provider: Schema.Literal("command-code"),
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
const decodeReplayIntent = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      request: Schema.Json,
      binding: ProjectTeamRunBinding,
      role: Schema.Json,
      allocation: PiManagedProcessAllocationSchema,
      resourceHash: ResourceIdentity,
      rootBudget: RootBudget,
      operationLimits: OperationLimits,
    }),
  ),
  { onExcessProperty: "error" },
);
const decodeBudgetIntent = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      request: Schema.JsonObject,
      binding: ProjectTeamRunBinding,
      role: ProjectTeamRoleRevision,
      allocation: PiManagedProcessAllocationSchema,
      resourceHash: Schema.optional(ResourceIdentity),
      rootBudget: RootBudget,
      operationLimits: OperationLimits,
    }),
  ),
  { onExcessProperty: "error" },
);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));
const decodeReplayAllocation = Schema.decodeEffect(
  Schema.fromJsonString(PiManagedProcessAllocationSchema),
  { onExcessProperty: "error" },
);
const decodeReplayOwner = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("owner"),
      unit: Schema.String,
      nonce: Schema.String,
      invocation: Schema.String,
      cgroup: Schema.String,
      pid: Positive,
      memoryBytes: Positive,
      swapBytes: Schema.Literal(0),
      oomGroup: Schema.Literal(1),
    }),
  ),
  { onExcessProperty: "error" },
);
const decodeReplayDrain = Schema.decodeEffect(Schema.fromJsonString(Drain), {
  onExcessProperty: "error",
});
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
const requestDigest = (request: PiManagedOperationRequest) =>
  NodeCrypto.createHash("sha256").update(encode(request)).digest("hex");
const decodeOperation = Schema.decodeUnknownEffect(PiWorkerOperation, {
  onExcessProperty: "error",
});
const deny = (detail: string, code: PiManagedRuntimeError["code"] = "denied") =>
  new PiManagedRuntimeError({ code, detail });
const guard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      isRuntimeError(error) ? error : deny("Durable Pi operation unavailable", "unavailable"),
    ),
  );

import { makeProjectTeamMailboxTurnDecisionReader } from "./ProjectTeamMailboxTurns.ts";

type Row = {
  operation_id: string;
  environment_id: string;
  project_id: string;
  binding_id: string;
  generation: number;
  provider_instance_id: string;
  thread_id: string;
  worker_id: string;
  operation_ordinal: number;
  operation_kind: PiWorkerOperation["operationKind"];
  request_hash: string;
  root_binding_id: string;
  root_task_id: string;
  maximum_tokens: number;
  deadline_at_ms: number;
  status: "prepared" | "starting" | "running" | "settled" | "quarantine";
  native_json: string | null;
  terminal_json: string | null;
  intent_json: string;
};
export interface PiDurableOperation {
  readonly operation: PiWorkerOperation;
  readonly workerId: string;
  readonly ordinal: number;
  readonly authority: ProjectTeamAuthority;
  readonly principal: ProjectTeamPrincipal;
  readonly maximumTokens: number;
  readonly deadlineAtMs: number;
  readonly allocation: PiManagedProcessAllocation;
}

export const makeProjectTeamPiOperations = Effect.fn("makeProjectTeamPiOperations")(
  function* (options: { readonly environmentId: string }) {
    const sql = yield* SqlClient.SqlClient;
    const clock = yield* Clock.Clock;
    const mailboxDecisions = yield* makeProjectTeamMailboxTurnDecisionReader({
      environmentId: options.environmentId,
    });
    const authorization = yield* ProjectTeamAuthorization;
    const repository = yield* ProjectWorkRepository;
    // These retained reads validate intent, claim receipts and stage history only.
    // The schema maximum is unused by them and grants no model-call capacity.
    const { readRetained, readStageReceipts } = yield* makeProjectTeamDispatchJournal({
      environmentId: options.environmentId,
      maximumEnvironmentModelCalls: 128,
    });
    const ownTransaction = Effect.fn("ProjectTeamPiOperations.ownTransaction")(function* () {
      const supplied = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isSome(supplied) && supplied.value !== sql)
        return yield* deny("Pi operations must use captured SQL client");
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* deny("Pi operations require an independent commit");
    });
    const current = Effect.fn("ProjectTeamPiOperations.current")(function* (
      identity: { readonly providerInstanceId: ProviderInstanceId; readonly threadId: ThreadId },
      initialize = false,
    ) {
      const found = initialize
        ? yield* authorization.issueCredential(identity)
        : yield* Effect.gen(function* () {
            const credential = yield* authorization.discover(identity);
            if (!credential) return undefined;
            return yield* authorization.resolve({
              actor: { kind: "agent", id: managedActorId(credential) },
              managed: credential,
            });
          });
      if (
        !found ||
        found.binding.environmentId !== options.environmentId ||
        found.binding.model !== "inclusionai/ling-3.1-flash:free"
      )
        return yield* deny("Current managed Pi binding required");
      if (!initialize && (found.binding.status !== "running" || !found.binding.sessionId))
        return yield* deny("Running native Pi session required");
      return found;
    });
    const roots = Effect.fn("ProjectTeamPiOperations.roots")(function* (
      initial: ProjectTeamAuthority,
    ) {
      let authority = initial;
      let maximumTokens = initial.binding.configuration.maxTokens;
      let deadline = Number.MAX_SAFE_INTEGER;
      const records = initial.state.foundationRecords ?? [];
      const tasks = new Set<string>();
      let rootTaskId = initial.binding.taskId;
      for (;;) {
        if (tasks.has(rootTaskId) || tasks.size >= 9)
          return yield* deny("Invalid Pi task ancestry");
        tasks.add(rootTaskId);
        const memberships = records.filter(
          (r) => r.kind === "task-membership" && r.taskId === rootTaskId,
        );
        const membership = memberships[0];
        if (
          memberships.length !== 1 ||
          membership?.kind !== "task-membership" ||
          membership.projectId !== initial.binding.projectId ||
          membership.status !== "active" ||
          membership.executionKind === "legacy" ||
          initial.state.tasks.filter(
            (t) => t.taskId === rootTaskId && t.projectId === initial.binding.projectId,
          ).length !== 1
        )
          return yield* deny("Pi task ancestor unavailable");
        if (!membership.parentTaskId) break;
        rootTaskId = membership.parentTaskId;
      }
      const seen = new Set<string>();
      while (true) {
        const binding = authority.binding;
        if (seen.has(binding.recordId) || seen.size >= 9) return yield* deny("Invalid Pi ancestry");
        seen.add(binding.recordId);
        if (binding.recordId !== initial.binding.recordId) {
          const dispatches = yield* sql<{
            dispatch_id: string;
          }>`SELECT dispatch_id FROM project_team_dispatch WHERE environment_id=${options.environmentId} AND binding_id=${binding.recordId} AND generation=${binding.generation} LIMIT 2`;
          if (dispatches.length > 1) return yield* deny("Pi ancestor dispatch is ambiguous");
          if (dispatches[0]) {
            const snapshot = yield* readRetained(dispatches[0].dispatch_id);
            yield* readStageReceipts(dispatches[0].dispatch_id);
            const transition = snapshot.intent.compiledClaim.transition;
            if (
              transition?.kind !== "claim" ||
              immutableBinding(transition.binding) !== immutableBinding(binding) ||
              snapshot.fence.stage === "stopping" ||
              snapshot.fence.stage === "quarantine" ||
              snapshot.fence.stage === "settled"
            )
              return yield* deny("Frozen Pi ancestor changed");
          }
          const operations = yield* sql<{
            intent_json: string;
          }>`SELECT intent_json FROM project_team_pi_operation WHERE environment_id=${options.environmentId} AND binding_id=${binding.recordId} AND generation=${binding.generation} ORDER BY operation_ordinal LIMIT 1`;
          if (operations[0]) {
            const intent = yield* decodeIntent(operations[0].intent_json);
            if (
              !intent.rootBudget ||
              !intent.operationLimits ||
              intent.binding.recordId !== binding.recordId ||
              intent.binding.generation !== binding.generation ||
              intent.binding.worktree !== binding.worktree ||
              intent.binding.branch !== binding.branch ||
              intent.binding.model !== binding.model ||
              encode(intent.binding.configuration) !== encode(binding.configuration) ||
              encode(intent.role) !== encode(authority.role)
            )
              return yield* deny("Pi ancestor intent changed");
          }
        }
        if (
          authority.state.foundationRecords?.some(
            (entry) =>
              entry.kind === "effect" &&
              entry.effectKind === "setup" &&
              entry.runId === binding.recordId &&
              entry.status !== "succeeded",
          )
        )
          return yield* deny("Pi setup ownership is unfinished", "uncertain");
        const attempt = authority.state.attempts.find(
          (entry) => entry.attemptId === binding.attemptId,
        );
        const started = Date.parse(binding.updatedAt);
        const lease = Date.parse(attempt?.leasedUntil ?? "");
        const duration = binding.configuration.maxDurationMs;
        if (
          !Number.isSafeInteger(started) ||
          !Number.isSafeInteger(lease) ||
          !Number.isSafeInteger(started + duration)
        )
          return yield* deny("Missing durable Pi limits");
        maximumTokens = Math.min(maximumTokens, binding.configuration.maxTokens);
        deadline = Math.min(deadline, lease, started + duration);
        if (!tasks.has(binding.taskId)) return yield* deny("Pi run and task ancestry differ");
        if (!binding.parentRunId) {
          if (binding.taskId !== rootTaskId) return yield* deny("Pi root run is orphaned");
          return { root: binding, rootTaskId, maximumTokens, deadlineAtMs: deadline };
        }
        const parents = authority.state.foundationRecords?.filter(
          (entry) => entry.kind === "run-binding" && entry.recordId === binding.parentRunId,
        );
        const parent = parents?.[0];
        const membership = records.find(
          (r) => r.kind === "task-membership" && r.taskId === binding.taskId,
        );
        if (
          parents?.length !== 1 ||
          parent?.kind !== "run-binding" ||
          parent.projectId !== initial.binding.projectId ||
          parent.environmentId !== options.environmentId ||
          (parent.taskId !== binding.taskId &&
            (membership?.kind !== "task-membership" || parent.taskId !== membership.parentTaskId))
        )
          return yield* deny("Pi ancestor unavailable");
        const credential = {
          projectId: parent.projectId,
          bindingId: parent.recordId,
          generation: parent.generation,
          providerInstanceId: parent.providerInstanceId,
          threadId: parent.threadId,
        };
        const resolved = yield* authorization.resolve({
          actor: { kind: "agent", id: managedActorId(credential) },
          managed: credential,
        });
        if (!resolved) return yield* deny("Pi ancestor authority unavailable");
        authority = resolved;
      }
    });
    const standaloneBudget = Effect.fn("ProjectTeamPiOperations.standaloneBudget")(function* (
      authority: ProjectTeamAuthority,
      rootTaskId: string,
    ) {
      const rows =
        yield* sql<Row>`SELECT * FROM project_team_pi_operation WHERE environment_id=${options.environmentId} AND project_id=${authority.binding.projectId} AND root_task_id=${rootTaskId} ORDER BY rowid LIMIT 1`;
      const row = rows[0];
      if (!row) return yield* deny("Pi root budget requires trusted legacy reconciliation");
      const intent = yield* decodeBudgetIntent(row.intent_json);
      const original = intent.binding;
      const processes = yield* sql<{
        unit: string;
        allocation_json: string;
      }>`SELECT unit,allocation_json FROM project_team_pi_process WHERE operation_id=${row.operation_id} LIMIT 2`;
      const process = processes[0];
      if (
        processes.length !== 1 ||
        !process ||
        process.unit !== intent.allocation.unit ||
        encode(yield* decodeReplayAllocation(process.allocation_json)) !== encode(intent.allocation)
      )
        return yield* deny("Original standalone Pi allocation proof changed");
      if (row.terminal_json) {
        const terminal = yield* decodeTerminal(row.terminal_json);
        if (
          terminal.identity.workerId !== row.worker_id ||
          terminal.identity.generation !== row.generation ||
          terminal.operation.operationId !== row.operation_id ||
          terminal.operation.operationKind !== row.operation_kind
        )
          return yield* deny("Original standalone Pi terminal owner changed");
      }
      const bindings = authority.state.foundationRecords?.filter(
        (r) => r.kind === "run-binding" && r.recordId === original.recordId,
      );
      const retained = bindings?.[0];
      const roles = authority.state.foundationRecords?.filter(
        (r) => r.kind === "role-revision" && r.recordId === original.roleRevisionId,
      );
      const role = roles?.[0];
      const immutableRole = (value: typeof ProjectTeamRoleRevision.Type) => {
        const { revision: _, status: _status, updatedAt: _at, ...immutable } = value;
        return encode(immutable);
      };
      const started = Date.parse(original.updatedAt);
      const durationDeadline = started + original.configuration.maxDurationMs;
      // The first standalone operation captured the effective lease/duration cap.
      // Later lease or binding timestamps cannot reconstruct or extend that cap.
      if (
        row.environment_id !== options.environmentId ||
        row.project_id !== authority.binding.projectId ||
        row.project_id !== original.projectId ||
        row.binding_id !== original.recordId ||
        row.root_binding_id !== original.recordId ||
        row.root_task_id !== rootTaskId ||
        original.taskId !== rootTaskId ||
        original.environmentId !== options.environmentId ||
        original.parentRunId !== undefined ||
        row.generation !== original.generation ||
        row.provider_instance_id !== original.providerInstanceId ||
        row.thread_id !== original.threadId ||
        row.operation_kind !== "initialize" ||
        !Number.isSafeInteger(row.operation_ordinal) ||
        row.operation_ordinal < 0 ||
        !isWorkerIdentity({ workerId: row.worker_id, generation: row.generation }) ||
        !isWorkerOperation({
          operationId: row.operation_id,
          operationKind: row.operation_kind,
        }) ||
        intent.request.kind !== row.operation_kind ||
        intent.request.threadId !== row.thread_id ||
        (intent.request.operationId !== undefined &&
          (intent.request.operationId !== row.operation_id ||
            NodeCrypto.createHash("sha256").update(encode(intent.request)).digest("hex") !==
              row.request_hash ||
            !intent.resourceHash)) ||
        bindings?.length !== 1 ||
        retained?.kind !== "run-binding" ||
        immutableBinding(retained) !== immutableBinding(original) ||
        roles?.length !== 1 ||
        role?.kind !== "role-revision" ||
        intent.role.recordId !== original.roleRevisionId ||
        intent.role.projectId !== original.projectId ||
        immutableRole(role) !== immutableRole(intent.role) ||
        original.configuration.instructionsHash !==
          NodeCrypto.createHash("sha256").update(intent.role.instructions).digest("hex") ||
        !validRetainedAllocation(intent.allocation) ||
        intent.allocation.launch.workspaceRoot !== original.worktree ||
        intent.rootBudget.rootTaskId !== rootTaskId ||
        intent.rootBudget.maximumTokens !== intent.operationLimits.maximumTokens ||
        intent.rootBudget.deadlineAtMs !== intent.operationLimits.deadlineAtMs ||
        intent.operationLimits.maximumTokens !== row.maximum_tokens ||
        intent.operationLimits.deadlineAtMs !== row.deadline_at_ms ||
        row.maximum_tokens > original.configuration.maxTokens ||
        !Number.isSafeInteger(started) ||
        !Number.isSafeInteger(durationDeadline) ||
        row.deadline_at_ms <= started ||
        row.deadline_at_ms > durationDeadline
      )
        return yield* deny("Original standalone Pi budget proof changed");
      return intent.rootBudget;
    });
    const rootBudget = Effect.fn("ProjectTeamPiOperations.rootBudget")(function* (
      authority: ProjectTeamAuthority,
      root: Effect.Success<ReturnType<typeof roots>>,
      operation: PiWorkerOperation,
      frozen?: typeof RootBudget.Type,
      request?: unknown,
      resourceHash?: string,
    ) {
      const binding = authority.binding;
      const budgets = yield* sql<{
        maximum_tokens: number;
        deadline_at_ms: number;
      }>`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget WHERE environment_id=${options.environmentId} AND project_id=${binding.projectId} AND root_task_id=${root.rootTaskId}`;
      const dispatches = yield* sql<{
        dispatch_id: string;
      }>`SELECT dispatch_id FROM project_team_dispatch WHERE environment_id=${options.environmentId} AND binding_id=${binding.recordId} AND generation=${binding.generation} LIMIT 2`;
      const anchors = yield* sql<{
        dispatch_id: string;
      }>`SELECT dispatch_id FROM project_team_dispatch WHERE environment_id=${options.environmentId} AND project_id=${binding.projectId} AND root_task_id=${root.rootTaskId} ORDER BY created_at,dispatch_id LIMIT 1`;
      let anchor = frozen;
      let maximumTokens = root.maximumTokens;
      let deadlineAtMs = root.deadlineAtMs;
      if (dispatches.length > 1) return yield* deny("Pi dispatch identity is ambiguous");
      if (anchors[0]) {
        const original = yield* readRetained(anchors[0].dispatch_id);
        yield* readStageReceipts(anchors[0].dispatch_id);
        const originalBudget = {
          rootTaskId: original.intent.limits.rootTaskId,
          maximumTokens: original.intent.limits.maximumTokens,
          deadlineAtMs: original.intent.limits.rootDeadlineAtMs,
        };
        if (anchor && encode(anchor) !== encode(originalBudget))
          return yield* deny("Original Pi root budget changed");
        anchor = originalBudget;
        if (!dispatches[0]) return yield* deny("Journal root requires its admitted Pi dispatch");
      }
      if (dispatches[0]) {
        const snapshot = yield* readRetained(dispatches[0].dispatch_id);
        yield* readStageReceipts(dispatches[0].dispatch_id);
        const transition = snapshot.intent.compiledClaim.transition;
        const limits = snapshot.intent.limits;
        if (
          transition?.kind !== "claim" ||
          immutableBinding(transition.binding) !== immutableBinding(binding) ||
          limits.rootTaskId !== root.rootTaskId ||
          !anchor ||
          anchor.maximumTokens !== limits.maximumTokens ||
          anchor.deadlineAtMs !== limits.rootDeadlineAtMs ||
          snapshot.fence.stage === "stopping" ||
          snapshot.fence.stage === "quarantine" ||
          snapshot.fence.stage === "settled"
        )
          return yield* deny("Pi operation differs from its admitted dispatch");
        const originalOperationId =
          operation.operationKind === "initialize"
            ? snapshot.intent.request.initializeOperationId
            : snapshot.intent.request.assignmentOperationId;
        if (operation.operationId !== originalOperationId) {
          const validateMailbox = Effect.gen(function* () {
            const decision = yield* mailboxDecisions
              .readInTransaction({ dispatchId: snapshot.fence.dispatchId })
              .pipe(Effect.mapError(() => deny("Mailbox operation association is unavailable")));
            if (
              operation.operationKind !== "prompt" ||
              snapshot.fence.stage !== "assignment-observed" ||
              !decision ||
              decision.kind !== "one" ||
              decision.request.operationId !== operation.operationId ||
              !request ||
              encode(decision.request) !== encode(request) ||
              decision.resourceHash !== resourceHash ||
              immutableBinding(decision.binding) !== immutableBinding(binding) ||
              encode(decision.rootBudget) !== encode(anchor) ||
              decision.attemptLimits.maximumTokens !== limits.attemptMaximumTokens ||
              decision.attemptLimits.deadlineAtMs !== limits.deadlineAtMs
            )
              return yield* deny("Pi operation differs from its retained mailbox decision");
            yield* mailboxDecisions
              .verifyOriginalInTransaction(snapshot, decision)
              .pipe(Effect.mapError(() => deny("Original mailbox boundary receipt differs")));
          });
          yield* Option.isSome(yield* Effect.serviceOption(sql.transactionService))
            ? validateMailbox
            : sql.withTransaction(validateMailbox);
        }
        maximumTokens = Math.min(maximumTokens, limits.attemptMaximumTokens);
        deadlineAtMs = Math.min(deadlineAtMs, limits.deadlineAtMs);
      }
      if (!anchors[0] && budgets[0]) {
        const original = yield* standaloneBudget(authority, root.rootTaskId);
        if (anchor && encode(anchor) !== encode(original))
          return yield* deny("Original standalone Pi root budget changed");
        anchor = original;
      }
      if (!anchor && binding.recordId !== root.root.recordId)
        return yield* deny("Pi child requires an original root budget");
      if (!anchor) anchor = { rootTaskId: root.rootTaskId, maximumTokens, deadlineAtMs };
      if (
        anchor.rootTaskId !== root.rootTaskId ||
        (budgets[0] &&
          (budgets[0].maximum_tokens !== anchor.maximumTokens ||
            budgets[0].deadline_at_ms !== anchor.deadlineAtMs)) ||
        (frozen && budgets.length !== 1)
      )
        return yield* deny("Frozen Pi root budget changed");
      return {
        rootBudget: anchor,
        maximumTokens: Math.min(maximumTokens, anchor.maximumTokens),
        deadlineAtMs: Math.min(deadlineAtMs, anchor.deadlineAtMs),
        exists: budgets.length === 1,
      };
    });
    const operationBudget = Effect.fn("ProjectTeamPiOperations.operationBudget")(function* (
      authority: ProjectTeamAuthority,
      root: Effect.Success<ReturnType<typeof roots>>,
      row: Row,
    ) {
      const intent = yield* decodeIntent(row.intent_json);
      if (
        !intent.rootBudget ||
        !intent.operationLimits ||
        row.environment_id !== options.environmentId ||
        row.project_id !== authority.binding.projectId ||
        row.binding_id !== authority.binding.recordId ||
        row.generation !== authority.binding.generation ||
        row.provider_instance_id !== authority.binding.providerInstanceId ||
        row.thread_id !== authority.binding.threadId ||
        row.root_task_id !== root.rootTaskId ||
        row.root_binding_id !== root.root.recordId ||
        intent.binding.recordId !== authority.binding.recordId ||
        intent.binding.generation !== authority.binding.generation ||
        intent.binding.worktree !== authority.binding.worktree ||
        intent.binding.branch !== authority.binding.branch ||
        intent.binding.model !== authority.binding.model ||
        encode(intent.binding.configuration) !== encode(authority.binding.configuration) ||
        encode(intent.role) !== encode(authority.role) ||
        intent.operationLimits.maximumTokens !== row.maximum_tokens ||
        intent.operationLimits.deadlineAtMs !== row.deadline_at_ms
      )
        return yield* deny("Pi forward operation has no frozen budget proof");
      const limits = yield* rootBudget(
        authority,
        root,
        { operationId: row.operation_id, operationKind: row.operation_kind },
        intent.rootBudget,
        intent.request,
        intent.resourceHash,
      );
      if (row.maximum_tokens > limits.maximumTokens || row.deadline_at_ms > limits.deadlineAtMs)
        return yield* deny("Frozen Pi operation policy changed");
      return limits.rootBudget;
    });
    const clockCheck = Effect.fn("ProjectTeamPiOperations.clockCheck")(function* (
      deadline: number,
    ) {
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* deny("Pi operation deadline expired");
    });
    // Admission and a durable stop share the captured client's transaction order.
    // The callback is synchronous so no receipt follows the final time/workspace fence.
    const admitCurrent = <A>(
      identity: { readonly providerInstanceId: ProviderInstanceId; readonly threadId: ThreadId },
      admit: (authority: ProjectTeamAuthority) => A,
      expectedNative?: {
        readonly operationId: string;
        readonly native: PiNativeReference;
        readonly resourceHash: string | null;
      },
    ) =>
      guard(
        ownTransaction().pipe(
          Effect.andThen(
            sql.withTransaction(
              Effect.gen(function* () {
                const expected = expectedNative
                  ? yield* decodeReadIdentity({
                      operationId: expectedNative.operationId,
                      native: expectedNative.native,
                      resourceHash: expectedNative.resourceHash,
                    }).pipe(Effect.mapError(() => deny("Invalid Pi native read identity")))
                  : undefined;
                const authority = yield* current(identity, expected === undefined);
                const root = yield* roots(authority);
                if (expected) {
                  const active = yield* sql<Row>`SELECT * FROM project_team_pi_operation
                    WHERE environment_id=${options.environmentId}
                      AND provider_instance_id=${identity.providerInstanceId}
                      AND thread_id=${identity.threadId}
                      AND status IN ('prepared','starting','running','quarantine')`;
                  if (active.length)
                    return yield* deny(
                      "Pi native read has an active or uncertain writer",
                      "uncertain",
                    );
                  const rows = yield* sql<Row>`SELECT * FROM project_team_pi_operation
                    WHERE environment_id=${options.environmentId}
                      AND binding_id=${authority.binding.recordId}
                      AND generation=${authority.binding.generation}
                      AND status='settled' AND native_json IS NOT NULL
                    ORDER BY operation_ordinal DESC LIMIT 1`;
                  const row = rows[0];
                  if (!row?.native_json || row.operation_id !== expected.operationId)
                    return yield* deny("Pi native read revision changed", "conflict");
                  const native = yield* decodeNative(row.native_json).pipe(
                    Effect.mapError(() => deny("Pi native identity unavailable", "uncertain")),
                  );
                  const intent = yield* decodeIntent(row.intent_json).pipe(
                    Effect.mapError(() =>
                      deny("Pi native resource identity unavailable", "uncertain"),
                    ),
                  );
                  if (
                    native.sessionId !== authority.binding.sessionId ||
                    encode(native) !== encode(expected.native) ||
                    (intent.resourceHash ?? null) !== expected.resourceHash
                  )
                    return yield* deny("Pi native read identity changed", "conflict");
                  yield* operationBudget(authority, root, row);
                }
                return yield* Effect.try({
                  try: () => {
                    if (clock.currentTimeMillisUnsafe() >= root.deadlineAtMs)
                      throw deny("Pi admission deadline expired");
                    const admitted = admit(authority);
                    if (clock.currentTimeMillisUnsafe() >= root.deadlineAtMs)
                      throw deny("Pi admission deadline expired during its final fence");
                    return admitted;
                  },
                  catch: (error) =>
                    isRuntimeError(error) ? error : deny("Pi admission fence unavailable"),
                });
              }),
            ),
          ),
        ),
      );
    const getRow = Effect.fn("ProjectTeamPiOperations.getRow")(function* (operationId: string) {
      const rows =
        yield* sql<Row>`SELECT * FROM project_team_pi_operation WHERE operation_id=${operationId} AND environment_id=${options.environmentId}`;
      if (rows.length !== 1) return yield* deny("Pi operation missing");
      return rows[0]!;
    });
    const authorize = Effect.fn("ProjectTeamPiOperations.authorize")(function* (
      captured: PiDurableOperation,
      settled = false,
    ) {
      const authority = yield* current(
        {
          providerInstanceId: captured.authority.binding.providerInstanceId,
          threadId: captured.authority.binding.threadId,
        },
        captured.operation.operationKind === "initialize",
      );
      const binding = authority.binding;
      const previous = captured.authority.binding;
      if (
        binding.recordId !== previous.recordId ||
        binding.generation !== previous.generation ||
        binding.worktree !== previous.worktree ||
        binding.branch !== previous.branch ||
        binding.model !== previous.model ||
        encode(binding.configuration) !== encode(previous.configuration) ||
        encode(authority.role) !== encode(captured.authority.role)
      )
        return yield* deny("Frozen Pi authority changed");
      const root = yield* roots(authority);
      const row = yield* getRow(captured.operation.operationId);
      if (
        (settled ? row.status !== "settled" : row.status === "settled") ||
        row.status === "quarantine" ||
        row.worker_id !== captured.workerId ||
        row.binding_id !== binding.recordId ||
        row.generation !== binding.generation ||
        row.root_binding_id !== root.root.recordId ||
        row.root_task_id !== root.root.taskId ||
        row.maximum_tokens !== captured.maximumTokens ||
        row.deadline_at_ms !== captured.deadlineAtMs ||
        root.maximumTokens < row.maximum_tokens ||
        root.deadlineAtMs < row.deadline_at_ms
      )
        return yield* deny("Pi operation owner changed");
      yield* operationBudget(authority, root, row);
      yield* clockCheck(row.deadline_at_ms);
      return authority;
    });
    // A stable dispatch ID is a receipt locator, never permission to execute again.
    const lookupInside = Effect.fn("ProjectTeamPiOperations.lookupInside")(function* (
      identity: { readonly providerInstanceId: ProviderInstanceId; readonly threadId: ThreadId },
      request: PiManagedOperationRequest,
      requestHash: string,
      resourceHash: string,
    ) {
      if (request.operationId === undefined) return undefined;
      const operation = yield* decodeOperation({
        operationId: request.operationId,
        operationKind: request.kind,
      }).pipe(Effect.mapError(() => deny("Invalid stable Pi operation identity")));
      yield* decodeResourceIdentity(resourceHash).pipe(
        Effect.mapError(() => deny("Invalid Pi resource identity")),
      );
      if (request.threadId !== identity.threadId || requestHash !== requestDigest(request))
        return yield* deny("Stable Pi request identity differs", "conflict");
      const authority = yield* current(identity, request.kind === "initialize");
      const binding = authority.binding;
      const root = yield* roots(authority);
      yield* clockCheck(root.deadlineAtMs);
      const rows =
        yield* sql<Row>`SELECT * FROM project_team_pi_operation WHERE operation_id=${operation.operationId}`;
      const row = rows[0];
      if (!row) return undefined;
      const intent = yield* decodeReplayIntent(row.intent_json).pipe(
        Effect.mapError(() => deny("Stable Pi intent unavailable", "uncertain")),
      );
      if (
        row.environment_id !== options.environmentId ||
        row.project_id !== binding.projectId ||
        row.binding_id !== binding.recordId ||
        row.generation !== binding.generation ||
        row.provider_instance_id !== identity.providerInstanceId ||
        row.thread_id !== identity.threadId ||
        row.operation_kind !== request.kind ||
        row.request_hash !== requestHash ||
        encode(intent.request) !== encode(request) ||
        immutableBinding(intent.binding) !== immutableBinding(binding) ||
        encode(intent.role) !== encode(authority.role) ||
        intent.resourceHash !== resourceHash ||
        row.root_binding_id !== root.root.recordId ||
        row.root_task_id !== root.root.taskId ||
        !Number.isSafeInteger(row.operation_ordinal) ||
        row.operation_ordinal < 0 ||
        !Number.isSafeInteger(row.maximum_tokens) ||
        row.maximum_tokens < 1 ||
        row.maximum_tokens > root.maximumTokens ||
        !Number.isSafeInteger(row.deadline_at_ms) ||
        row.deadline_at_ms > root.deadlineAtMs
      )
        return yield* deny("Stable Pi operation identity changed", "conflict");
      yield* clockCheck(row.deadline_at_ms);
      if (row.status !== "settled")
        return yield* deny(
          "Stable Pi operation requires reconciliation",
          row.status === "prepared" ? "conflict" : "uncertain",
        );
      if (!row.terminal_json || !row.native_json)
        return yield* deny("Stable Pi receipt incomplete", "uncertain");
      const terminal = yield* decodeTerminal(row.terminal_json).pipe(
        Effect.mapError(() => deny("Stable Pi terminal unavailable", "uncertain")),
      );
      const native = yield* decodeNative(row.native_json).pipe(
        Effect.mapError(() => deny("Stable Pi native unavailable", "uncertain")),
      );
      if (
        terminal.outcome !== "success" ||
        !terminal.ownerCaptured ||
        !terminal.native ||
        !terminal.drain ||
        terminal.failureCode !== undefined ||
        !native.persisted ||
        native.sessionId !== binding.sessionId ||
        encode(terminal.native) !== encode(native) ||
        encode(terminal.operation) !== encode(operation) ||
        terminal.identity.workerId !== row.worker_id ||
        terminal.identity.generation !== row.generation
      )
        return yield* deny("Stable Pi successful receipt differs", "uncertain");
      const processes = yield* sql<{
        unit: string;
        allocation_json: string;
        status: string;
        owner_json: string | null;
        drain_json: string | null;
      }>`SELECT * FROM project_team_pi_process WHERE operation_id=${row.operation_id}`;
      const process = processes[0];
      if (
        processes.length !== 1 ||
        !process ||
        process.status !== "drained" ||
        !process.owner_json ||
        !process.drain_json
      )
        return yield* deny("Stable Pi process receipt incomplete", "uncertain");
      const allocationJson = yield* decodeReplayAllocation(process.allocation_json).pipe(
        Effect.mapError(() => deny("Stable Pi allocation unavailable", "uncertain")),
      );
      const owner = yield* decodeReplayOwner(process.owner_json).pipe(
        Effect.mapError(() => deny("Stable Pi owner unavailable", "uncertain")),
      );
      const drain = yield* decodeReplayDrain(process.drain_json).pipe(
        Effect.mapError(() => deny("Stable Pi drain unavailable", "uncertain")),
      );
      const allocation = intent.allocation;
      const nativeState = allocation.launch.nativeState;
      if (
        !nativeState ||
        !validRetainedAllocation(allocation) ||
        encode(allocationJson) !== encode(allocation) ||
        process.unit !== allocation.unit ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          allocation.nonce,
        ) ||
        allocation.unit !== `t3-pi-managed-${allocation.nonce}.service` ||
        allocation.launch.workspaceRoot !== binding.worktree ||
        allocation.launch.workspace.path !== binding.worktree ||
        allocation.policy.memoryBytes !== allocation.launch.memoryBytes ||
        allocation.policy.runtimeSeconds !== allocation.launch.runtimeSeconds ||
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
        return yield* deny("Stable Pi process receipts differ", "uncertain");
      yield* operationBudget(authority, root, row).pipe(
        Effect.mapError(() => deny("Stable Pi original budget changed", "uncertain")),
      );
      const requests = yield* sql<{
        reservation_id: string;
        environment_id: string;
        project_id: string;
        root_task_id: string;
        run_id: string;
        attempt_id: string;
        worker_id: string;
        generation: number;
        operation_id: string;
        request_id: number;
        route_id: string;
        provider: string;
        model: string;
        status: string;
        capacity_state: string;
        accounting_receipt_id: string | null;
        settlement_json: string | null;
        reservation_json: string;
        maximum_input_tokens: number;
        maximum_output_tokens: number;
        deadline_at_ms: number;
        charged_input_tokens: number;
        charged_output_tokens: number;
      }>`SELECT * FROM project_team_model_request WHERE operation_id=${row.operation_id} LIMIT 257`;
      if (requests.length !== terminal.accountingReceipts.length || requests.length > 256)
        return yield* deny("Stable Pi accounting receipt incomplete", "uncertain");
      const reservations = new Set<string>();
      const accountingReceipts = new Set<string>();
      const requestIds = new Set<number>();
      let chargedTokens = 0;
      for (const receipt of terminal.accountingReceipts) {
        const requestRow = requests.find((entry) => entry.reservation_id === receipt.reservationId);
        if (
          !requestRow ||
          reservations.has(receipt.reservationId) ||
          accountingReceipts.has(receipt.accountingReceiptId) ||
          requestIds.has(receipt.requestId) ||
          requestRow.capacity_state !== "released" ||
          requestRow.status !== "reported" ||
          requestRow.environment_id !== row.environment_id ||
          requestRow.project_id !== row.project_id ||
          requestRow.root_task_id !== row.root_task_id ||
          requestRow.run_id !== binding.recordId ||
          requestRow.attempt_id !== binding.attemptId ||
          requestRow.worker_id !== row.worker_id ||
          requestRow.generation !== row.generation ||
          requestRow.request_id !== receipt.requestId ||
          requestRow.accounting_receipt_id !== receipt.accountingReceiptId ||
          requestRow.route_id !== "command-code-ling-free" ||
          receipt.routeId !== requestRow.route_id ||
          requestRow.provider !== receipt.provider ||
          requestRow.model !== binding.model ||
          receipt.model !== binding.model ||
          ![binding.model, "inclusionai/ling-3.1-flash"].includes(receipt.reportedModel) ||
          !requestRow.settlement_json ||
          !Number.isSafeInteger(requestRow.maximum_input_tokens) ||
          requestRow.maximum_input_tokens < 1 ||
          !Number.isSafeInteger(requestRow.maximum_output_tokens) ||
          requestRow.maximum_output_tokens < 1 ||
          !Number.isSafeInteger(
            requestRow.maximum_input_tokens + requestRow.maximum_output_tokens,
          ) ||
          requestRow.maximum_input_tokens + requestRow.maximum_output_tokens > row.maximum_tokens ||
          !Number.isSafeInteger(requestRow.deadline_at_ms) ||
          requestRow.deadline_at_ms < 1 ||
          requestRow.deadline_at_ms > row.deadline_at_ms ||
          receipt.usage.prompt_tokens > requestRow.maximum_input_tokens ||
          receipt.usage.completion_tokens > requestRow.maximum_output_tokens ||
          Object.values(receipt.usage.prompt_tokens_details ?? {}).some(
            (value) => value !== undefined && value > receipt.usage.prompt_tokens,
          ) ||
          Object.values(receipt.usage.completion_tokens_details ?? {}).some(
            (value) => value !== undefined && value > receipt.usage.completion_tokens,
          ) ||
          [
            receipt.usage.prompt_cache_hit_tokens,
            receipt.usage.prompt_cache_miss_tokens,
            receipt.usage.cached_tokens,
          ].some((value) => value !== undefined && value > receipt.usage.prompt_tokens)
        )
          return yield* deny("Stable Pi accounting identity differs", "uncertain");
        const fields = {
          workerId: row.worker_id,
          operationId: row.operation_id,
          generation: row.generation,
          requestId: receipt.requestId,
          routeId: receipt.routeId,
          provider: receipt.provider,
          model: receipt.model,
          maxInputTokens: requestRow.maximum_input_tokens,
          maxOutputTokens: requestRow.maximum_output_tokens,
          callCount: 1,
          deadlineAtMs: requestRow.deadline_at_ms,
        };
        const reservation = yield* decodeJson(requestRow.reservation_json).pipe(
          Effect.mapError(() => deny("Stable Pi reservation unavailable", "uncertain")),
        );
        const settlement = yield* decodeJson(requestRow.settlement_json).pipe(
          Effect.mapError(() => deny("Stable Pi settlement unavailable", "uncertain")),
        );
        if (
          encode(reservation) !== encode(fields) ||
          encode(settlement) !==
            encode({
              ...fields,
              reservationId: receipt.reservationId,
              outcome: "reported",
              transportDrained: true,
              chargedInputTokens: requestRow.charged_input_tokens,
              chargedOutputTokens: requestRow.charged_output_tokens,
              reportedModel: receipt.reportedModel,
              reportedUsage: receipt.usage,
            }) ||
          receipt.usage.total_tokens !==
            receipt.usage.prompt_tokens + receipt.usage.completion_tokens ||
          requestRow.charged_input_tokens !== receipt.usage.prompt_tokens ||
          requestRow.charged_output_tokens !== receipt.usage.completion_tokens
        )
          return yield* deny("Stable Pi accounting evidence differs", "uncertain");
        // Released calls consume actual usage, not each sequential reservation's ceiling.
        chargedTokens += receipt.usage.total_tokens;
        if (!Number.isSafeInteger(chargedTokens) || chargedTokens > row.maximum_tokens)
          return yield* deny("Stable Pi accounting exceeds original budget", "uncertain");
        reservations.add(receipt.reservationId);
        accountingReceipts.add(receipt.accountingReceiptId);
        requestIds.add(receipt.requestId);
      }
      const active =
        yield* sql`SELECT operation_id FROM project_team_pi_operation WHERE environment_id=${options.environmentId} AND provider_instance_id=${identity.providerInstanceId} AND thread_id=${identity.threadId} AND status IN ('prepared','starting','running','quarantine')`;
      const latest = yield* sql<{
        ordinal: number;
      }>`SELECT MAX(operation_ordinal) AS ordinal FROM project_team_pi_operation WHERE environment_id=${options.environmentId} AND provider_instance_id=${identity.providerInstanceId} AND thread_id=${identity.threadId}`;
      if (active.length || latest[0]?.ordinal !== row.operation_ordinal)
        return yield* deny("Stable Pi native receipt has a successor", "conflict");
      yield* current(identity);
      yield* clockCheck(row.deadline_at_ms);
      return {
        operation,
        terminal,
        native,
        authority,
        workspace: allocation.launch.workspace,
        nativeState,
        deadlineAtMs: row.deadline_at_ms,
      };
    });
    const lookup = Effect.fn("ProjectTeamPiOperations.lookup")(function* (
      ...args: Parameters<typeof lookupInside>
    ) {
      yield* ownTransaction();
      if (args[1].operationId === undefined) return undefined;
      return yield* sql.withTransaction(lookupInside(...args));
    });
    const lookupTransaction = Effect.gen(function* () {
      const supplied = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (
        Option.isNone(supplied) ||
        supplied.value !== sql ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Pi receipt lookup requires its captured SQL transaction");
    });
    const lookupInTransaction = (...args: Parameters<typeof lookupInside>) => {
      const captured = structuredClone(args);
      return guard(lookupTransaction.pipe(Effect.andThen(lookupInside(...captured))));
    };
    const prepare = Effect.fn("ProjectTeamPiOperations.prepare")(function* (
      identity: { readonly providerInstanceId: ProviderInstanceId; readonly threadId: ThreadId },
      request: PiManagedOperationRequest,
      requestHash: string,
      allocated: {
        readonly allocation: PiManagedProcessAllocation;
        readonly workerId: string;
        readonly operationId: string;
        readonly resourceHash?: string;
      },
    ) {
      const { allocation, workerId, operationId } = allocated;
      if (request.operationId !== undefined) {
        yield* decodeOperation({
          operationId: request.operationId,
          operationKind: request.kind,
        }).pipe(Effect.mapError(() => deny("Invalid stable Pi operation identity")));
        if (
          request.operationId !== operationId ||
          request.threadId !== identity.threadId ||
          requestHash !== requestDigest(request) ||
          allocated.resourceHash === undefined
        )
          return yield* deny("Stable Pi allocation request identity differs", "conflict");
      }
      const resourceHash =
        allocated.resourceHash === undefined
          ? undefined
          : yield* decodeResourceIdentity(allocated.resourceHash);
      yield* ownTransaction();
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const authority = yield* current(identity, request.kind === "initialize");
          if (allocation.launch.workspaceRoot !== authority.binding.worktree)
            return yield* deny("Allocated workspace differs from durable assignment");
          const root = yield* roots(authority);
          yield* clockCheck(root.deadlineAtMs);
          if (request.operationId !== undefined) {
            const existing =
              yield* sql<Row>`SELECT * FROM project_team_pi_operation WHERE operation_id=${operationId}`;
            if (existing.length)
              return yield* deny(
                "Stable Pi operation already recorded; lookup required",
                "conflict",
              );
          }
          const active =
            yield* sql<Row>`SELECT * FROM project_team_pi_operation WHERE environment_id=${options.environmentId} AND provider_instance_id=${identity.providerInstanceId} AND thread_id=${identity.threadId} AND status IN ('prepared','starting','running','quarantine')`;
          if (active.length)
            return yield* deny(
              active[0]?.request_hash === requestHash
                ? "Duplicate Pi operation cannot replay"
                : "Pi thread already has an owner",
              active[0]?.status === "quarantine" ? "uncertain" : "conflict",
            );
          const previous = yield* sql<{
            ordinal: number;
          }>`SELECT COALESCE(MAX(operation_ordinal),-1)+1 AS ordinal FROM project_team_pi_operation WHERE environment_id=${options.environmentId} AND provider_instance_id=${identity.providerInstanceId} AND thread_id=${identity.threadId}`;
          const ordinal = previous[0]?.ordinal;
          if (ordinal === undefined || !Number.isSafeInteger(ordinal))
            return yield* deny("Pi operation ordinal exhausted");
          const operation = { operationId, operationKind: request.kind };
          const limits = yield* rootBudget(
            authority,
            root,
            operation,
            undefined,
            request,
            resourceHash,
          );
          const { maximumTokens, deadlineAtMs } = limits;
          yield* clockCheck(deadlineAtMs);
          if (!limits.exists)
            yield* sql`INSERT INTO project_team_model_budget VALUES(${options.environmentId},${authority.binding.projectId},${root.rootTaskId},${limits.rootBudget.maximumTokens},${limits.rootBudget.deadlineAtMs})`;
          const principal = {
            actor: { kind: "agent" as const, id: managedActorId(authority.credential) },
            managed: authority.credential,
          };
          const intent = encode({
            request,
            binding: authority.binding,
            role: authority.role,
            allocation,
            rootBudget: limits.rootBudget,
            operationLimits: { maximumTokens, deadlineAtMs },
            ...(resourceHash === undefined ? {} : { resourceHash }),
          });
          yield* sql`INSERT INTO project_team_pi_operation (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json) VALUES (${operationId},${options.environmentId},${authority.binding.projectId},${authority.binding.recordId},${authority.binding.generation},${identity.providerInstanceId},${identity.threadId},${workerId},${ordinal},${request.kind},${requestHash},${root.root.recordId},${root.root.taskId},${maximumTokens},${deadlineAtMs},'prepared',${intent})`;
          yield* sql`INSERT INTO project_team_pi_process(unit,operation_id,allocation_json,status) VALUES(${allocation.unit},${operationId},${encode(allocation)},'allocated')`;
          const captured = {
            operation,
            workerId,
            ordinal,
            authority,
            principal,
            maximumTokens,
            deadlineAtMs,
            allocation,
          };
          yield* authorize(captured);
          return captured;
        }),
      );
      yield* authorize(result);
      return result;
    });
    const persistence = (captured: PiDurableOperation) => ({
      allocation: captured.allocation,
      claimActivation: (allocation: PiManagedProcessAllocation) =>
        guard(
          Effect.gen(function* () {
            yield* ownTransaction();
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* authorize(captured);
                if (encode(allocation) !== encode(captured.allocation))
                  return yield* deny("Pi allocation changed");
                const rows = yield* sql<{
                  status: string;
                  allocation_json: string;
                }>`SELECT status,allocation_json FROM project_team_pi_process WHERE unit=${allocation.unit} AND operation_id=${captured.operation.operationId}`;
                if (
                  rows[0]?.status !== "allocated" ||
                  rows[0].allocation_json !== encode(allocation)
                )
                  return yield* deny("Pi allocation already consumed", "conflict");
                yield* sql`UPDATE project_team_pi_process SET status='claimed' WHERE unit=${allocation.unit}`;
                yield* sql`UPDATE project_team_pi_operation SET status='starting' WHERE operation_id=${captured.operation.operationId}`;
                yield* authorize(captured);
              }),
            );
            yield* authorize(captured);
          }),
        ).pipe(
          Effect.mapError(
            () =>
              new PiManagedProcessError({
                phase: "startup",
                message: "Pi activation ownership denied",
              }),
          ),
        ),
      beforeStart: (owner: PiManagedProcessOwner) =>
        guard(
          Effect.gen(function* () {
            yield* ownTransaction();
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* authorize(captured);
                if (
                  owner.unit !== captured.allocation.unit ||
                  owner.nonce !== captured.allocation.nonce ||
                  !/^[a-f0-9]{32}$/.test(owner.invocation) ||
                  !Number.isSafeInteger(owner.pid) ||
                  owner.pid < 1 ||
                  !owner.cgroup.startsWith("/sys/fs/cgroup/") ||
                  !owner.cgroup.endsWith(`/${owner.unit}`) ||
                  owner.cgroup.split("/").some((part) => part === "." || part === "..") ||
                  owner.memoryBytes !== captured.allocation.policy.memoryBytes ||
                  owner.swapBytes !== 0 ||
                  owner.oomGroup !== 1
                )
                  return yield* deny("Pi process owner mismatch");
                const rows = yield* sql<{
                  status: string;
                }>`SELECT status FROM project_team_pi_process WHERE unit=${owner.unit} AND operation_id=${captured.operation.operationId}`;
                if (rows[0]?.status !== "claimed")
                  return yield* deny("Pi owner already captured", "conflict");
                yield* sql`UPDATE project_team_pi_process SET status='captured',owner_json=${encode(owner)} WHERE unit=${owner.unit}`;
                yield* sql`UPDATE project_team_pi_operation SET status='running' WHERE operation_id=${captured.operation.operationId}`;
                yield* authorize(captured);
              }),
            );
            yield* authorize(captured);
          }),
        ).pipe(
          Effect.mapError(
            () =>
              new PiManagedProcessError({
                phase: "startup",
                message: "Pi captured ownership denied",
              }),
          ),
        ),
    });
    const nativeAuthority = Effect.fn("ProjectTeamPiOperations.nativeAuthority")(function* (
      captured: PiDurableOperation,
      native: PiNativeReference,
      settled = false,
    ) {
      const authority = yield* authorize(captured, settled);
      const row = yield* getRow(captured.operation.operationId);
      if (
        authority.binding.status !== "running" ||
        authority.binding.sessionId !== native.sessionId ||
        row.native_json !== encode(native)
      )
        return yield* deny("Native Pi session identity changed");
      const state = yield* readCurrentState(sql, authority.binding.projectId);
      if (state.revision !== authority.state.revision)
        return yield* deny("Native Pi authority receipt changed");
      yield* clockCheck(row.deadline_at_ms);
      return authority;
    });
    // Terminal persistence releases the durable writer fence. Publication must still belong
    // to this exact completed operation and its current native session.
    const publication = Effect.fn("ProjectTeamPiOperations.publication")(function* (
      captured: PiDurableOperation,
      terminal: PiSessionTerminal,
    ) {
      yield* ownTransaction();
      if (terminal.outcome !== "success" || !terminal.native)
        return yield* deny("Successful native Pi terminal required");
      const native = terminal.native;
      const validate = Effect.gen(function* () {
        const authority = yield* nativeAuthority(captured, native, true);
        const row = yield* getRow(captured.operation.operationId);
        if (row.terminal_json !== encode(terminal))
          return yield* deny("Pi terminal publication receipt changed");
        const latest = yield* sql<{
          ordinal: number;
        }>`SELECT MAX(operation_ordinal) AS ordinal FROM project_team_pi_operation WHERE environment_id=${options.environmentId} AND provider_instance_id=${authority.binding.providerInstanceId} AND thread_id=${authority.binding.threadId}`;
        if (latest[0]?.ordinal !== captured.ordinal)
          return yield* deny("Pi operation publication owner changed");
        const state = yield* readCurrentState(sql, authority.binding.projectId);
        if (state.revision !== authority.state.revision)
          return yield* deny("Pi publication authority receipt changed");
        yield* clockCheck(captured.deadlineAtMs);
        return authority;
      });
      yield* sql.withTransaction(validate);
      return yield* validate;
    });
    const persistNative = Effect.fn("ProjectTeamPiOperations.persistNative")(function* (
      captured: PiDurableOperation,
      input: PiNativeReference,
    ) {
      yield* ownTransaction();
      const native = yield* decodeNativeInput(input);
      yield* repository.executeAtomic(
        Effect.gen(function* () {
          const authority = yield* authorize(captured);
          if (authority.binding.sessionId && authority.binding.sessionId !== native.sessionId)
            return yield* deny("Native Pi session identity changed");
          yield* sql`UPDATE project_team_pi_operation SET native_json=${encode(native)} WHERE operation_id=${captured.operation.operationId}`;
          if (authority.binding.status === "running") return [];
          const at = DateTime.formatIso(yield* DateTime.now);
          return [
            {
              type: "project-work.foundation.commit" as const,
              projectId: authority.binding.projectId,
              commandId: CommandId.make(`pi-native-${captured.operation.operationId}`),
              expectedRevision: authority.state.revision,
              records: [
                {
                  ...authority.binding,
                  revision: authority.binding.revision + 1,
                  status: "running" as const,
                  sessionId: native.sessionId,
                  updatedAt: at,
                },
              ],
              committedAt: at,
              attribution: {
                actor: { kind: "system" as const, id: "pi-runtime" },
                source: { kind: "system" as const, id: "pi-runtime" },
                recordedAt: at,
              },
            },
          ];
        }),
        nativeAuthority(captured, native).pipe(Effect.asVoid),
      );
      return yield* nativeAuthority(captured, native);
    });
    const persistControl = Effect.fn("ProjectTeamPiOperations.persistControl")(function* (
      captured: PiDurableOperation,
      receipt: {
        readonly controlId: number;
        readonly kind: "steer" | "follow-up" | "interrupt";
        readonly status: "received" | "unresolved";
      },
    ) {
      yield* ownTransaction();
      if (!Number.isSafeInteger(receipt.controlId) || receipt.controlId < 1)
        return yield* deny("Invalid Pi control ID");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (receipt.status === "received") yield* authorize(captured);
          const row = yield* getRow(captured.operation.operationId);
          if (
            row.worker_id !== captured.workerId ||
            row.generation !== captured.authority.binding.generation
          )
            return yield* deny("Control owner mismatch");
          const previous = yield* sql<{
            receipt_json: string;
          }>`SELECT receipt_json FROM project_team_pi_control WHERE operation_id=${row.operation_id} AND control_id=${receipt.controlId}`;
          if (previous.length && previous[0]?.receipt_json !== encode(receipt))
            return yield* deny("Pi control receipt changed");
          if (!previous.length)
            yield* sql`INSERT INTO project_team_pi_control VALUES(${row.operation_id},${receipt.controlId},${receipt.kind},${receipt.status},${encode(receipt)})`;
          if (receipt.status === "received") yield* authorize(captured);
        }),
      );
      if (receipt.status === "received") yield* authorize(captured);
    });
    const persistTerminal = Effect.fn("ProjectTeamPiOperations.persistTerminal")(function* (
      captured: PiDurableOperation,
      terminal: PiSessionTerminal,
    ) {
      yield* ownTransaction();
      if (
        terminal.identity.workerId !== captured.workerId ||
        terminal.identity.generation !== captured.authority.binding.generation ||
        encode(terminal.operation) !== encode(captured.operation)
      )
        return yield* deny("Terminal Pi owner mismatch");
      const disposition = yield* sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* getRow(captured.operation.operationId);
          if (row.status === "settled" || row.status === "quarantine")
            return yield* deny("Pi terminal already recorded", "conflict");
          if (terminal.outcome === "success") yield* authorize(captured);
          const process = yield* sql<{
            status: string;
            owner_json: string | null;
          }>`SELECT status,owner_json FROM project_team_pi_process WHERE operation_id=${row.operation_id} AND unit=${captured.allocation.unit}`;
          const owner = process[0]?.owner_json ? decodeOwner(process[0].owner_json) : undefined;
          const drain = terminal.drain;
          if (
            drain &&
            (!owner ||
              drain.unit !== captured.allocation.unit ||
              drain.invocation !== owner.invocation ||
              drain.cgroup !== owner.cgroup ||
              drain.ownerPid !== owner.pid ||
              !Number.isSafeInteger(drain.launcherPid) ||
              drain.launcherPid < 1 ||
              drain.memoryBytes !== captured.allocation.policy.memoryBytes ||
              drain.swapBytes !== 0 ||
              drain.oomGroup !== 1 ||
              (drain.kernel !== "removed" && !drain.kernel.split("\n").includes("populated 0")))
          )
            return yield* deny("Pi drain receipt mismatch", "uncertain");
          const requests = yield* sql<{
            request_id: number;
            reservation_id: string;
            accounting_receipt_id: string | null;
            status: string;
            route_id: string;
            provider: string;
            model: string;
          }>`SELECT request_id,reservation_id,accounting_receipt_id,status,route_id,provider,model FROM project_team_model_request WHERE worker_id=${captured.workerId} AND operation_id=${row.operation_id} AND generation=${row.generation}`;
          const receipts = new Set<string>();
          for (const receipt of terminal.accountingReceipts) {
            const request = requests.find(
              (request) => request.reservation_id === receipt.reservationId,
            );
            if (
              !request ||
              request.status !== "reported" ||
              receipts.has(receipt.reservationId) ||
              request.accounting_receipt_id !== receipt.accountingReceiptId ||
              request.request_id !== receipt.requestId ||
              request.route_id !== receipt.routeId ||
              request.provider !== receipt.provider ||
              request.model !== receipt.model
            )
              return yield* deny("Pi accounting receipt mismatch", "uncertain");
            receipts.add(receipt.reservationId);
          }
          const pendingAccounting = requests.some(
            (request) => request.status === "reserved" || !request.accounting_receipt_id,
          );
          const uncertain =
            pendingAccounting ||
            terminal.outcome === "quarantine" ||
            (process[0]?.status !== "allocated" && !drain);
          if (
            terminal.outcome === "success" &&
            (pendingAccounting || requests.length !== receipts.size)
          )
            return yield* deny("Pi success requires settled accounting", "uncertain");
          if (
            terminal.outcome === "success" &&
            (!drain || !terminal.native || row.native_json !== encode(terminal.native))
          )
            return yield* deny("Pi success requires durable native and drained owner", "uncertain");
          yield* sql`UPDATE project_team_pi_process SET status=${uncertain ? "quarantine" : "drained"},drain_json=${drain ? encode(drain) : null} WHERE operation_id=${row.operation_id}`;
          // Clock and authority are sampled after the final SQL write receipt while still in the transaction.
          yield* sql`UPDATE project_team_pi_operation SET terminal_json=${encode(terminal)} WHERE operation_id=${row.operation_id}`;
          if (terminal.outcome === "success") yield* authorize(captured);
          yield* sql`UPDATE project_team_pi_operation SET status=${uncertain ? "quarantine" : "settled"} WHERE operation_id=${row.operation_id}`;
          if (terminal.outcome === "success") {
            yield* clockCheck(captured.deadlineAtMs);
            yield* current({
              providerInstanceId: captured.authority.binding.providerInstanceId,
              threadId: captured.authority.binding.threadId,
            });
          }
          return uncertain ? ("uncertain" as const) : ("drained" as const);
        }),
      );
      if (terminal.outcome === "success") {
        yield* current({
          providerInstanceId: captured.authority.binding.providerInstanceId,
          threadId: captured.authority.binding.threadId,
        });
        yield* clockCheck(captured.deadlineAtMs);
      }
      return disposition;
    });
    const nativeFor = Effect.fn("ProjectTeamPiOperations.nativeFor")(function* (identity: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
    }) {
      yield* ownTransaction();
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const authority = yield* current(identity);
          const active =
            yield* sql`SELECT operation_id FROM project_team_pi_operation WHERE environment_id=${options.environmentId} AND provider_instance_id=${identity.providerInstanceId} AND thread_id=${identity.threadId} AND status IN ('prepared','starting','running','quarantine')`;
          if (active.length)
            return yield* deny("Pi native session has an active or uncertain writer", "uncertain");
          const rows =
            yield* sql<Row>`SELECT * FROM project_team_pi_operation WHERE environment_id=${options.environmentId} AND binding_id=${authority.binding.recordId} AND generation=${authority.binding.generation} AND status='settled' AND native_json IS NOT NULL ORDER BY operation_ordinal DESC LIMIT 1`;
          const row = rows[0];
          if (!row?.native_json)
            return yield* deny("No durable Pi native reference", "unavailable");
          const native = yield* decodeNative(row.native_json).pipe(
            Effect.mapError(() => deny("Durable Pi native identity unavailable", "uncertain")),
          );
          const intent = yield* decodeIntent(row.intent_json).pipe(
            Effect.mapError(() => deny("Durable Pi resource identity unavailable", "uncertain")),
          );
          if (native.sessionId !== authority.binding.sessionId)
            return yield* deny("Pi native binding mismatch");
          yield* operationBudget(authority, yield* roots(authority), row).pipe(
            Effect.mapError(() => deny("Pi native budget proof unavailable", "uncertain")),
          );
          yield* current(identity);
          return {
            authority,
            native,
            operationId: row.operation_id,
            resourceHash: intent.resourceHash ?? null,
          };
        }),
      );
      yield* current(identity);
      return result;
    });
    const resolveOperation = Effect.fn("ProjectTeamPiOperations.resolveOperation")(function* (
      authority: ProjectTeamAuthority,
      reservation: PiModelRequestReservation,
    ) {
      const client = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (
        Option.isNone(client) ||
        client.value !== sql ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* new ModelAccountingError({
          reason: "Pi accounting must read captured transaction",
        });
      const row = yield* getRow(reservation.operationId).pipe(
        Effect.mapError(
          () => new ModelAccountingError({ reason: "Pi accounting operation unavailable" }),
        ),
      );
      const intent = yield* decodeIntent(row.intent_json).pipe(
        Effect.mapError(
          () => new ModelAccountingError({ reason: "Pi accounting intent unavailable" }),
        ),
      );
      if (
        intent.binding.recordId !== authority.binding.recordId ||
        intent.binding.generation !== authority.binding.generation ||
        intent.binding.worktree !== authority.binding.worktree ||
        intent.binding.branch !== authority.binding.branch ||
        intent.binding.model !== authority.binding.model ||
        encode(intent.binding.configuration) !== encode(authority.binding.configuration) ||
        encode(intent.role) !== encode(authority.role)
      )
        return yield* new ModelAccountingError({
          reason: "Frozen Pi accounting authority changed",
        });
      const root = yield* roots(authority).pipe(
        Effect.mapError(
          () => new ModelAccountingError({ reason: "Pi accounting ancestry unavailable" }),
        ),
      );
      if (
        row.status !== "running" ||
        row.binding_id !== authority.binding.recordId ||
        row.generation !== reservation.generation ||
        row.worker_id !== reservation.workerId ||
        row.root_binding_id !== root.root.recordId ||
        row.root_task_id !== root.root.taskId ||
        row.maximum_tokens > root.maximumTokens ||
        row.deadline_at_ms > root.deadlineAtMs
      )
        return yield* new ModelAccountingError({ reason: "Pi accounting operation mismatch" });
      const budget = yield* operationBudget(authority, root, row).pipe(
        Effect.mapError(
          () => new ModelAccountingError({ reason: "Pi accounting budget unavailable" }),
        ),
      );
      return {
        workerId: row.worker_id,
        operationId: row.operation_id,
        rootTaskId: budget.rootTaskId,
        maximumTokens: budget.maximumTokens,
        deadlineAtMs: budget.deadlineAtMs,
        operationMaximumTokens: row.maximum_tokens,
        operationDeadlineAtMs: row.deadline_at_ms,
      };
    });
    return {
      assertIndependent: () => guard(ownTransaction()),
      current: (...args: Parameters<typeof current>) =>
        guard(ownTransaction().pipe(Effect.andThen(current(...args)))),
      admitCurrent,
      lookup: (...args: Parameters<typeof lookup>) => guard(lookup(...args)),
      lookupInTransaction,
      prepare: (...args: Parameters<typeof prepare>) => guard(prepare(...args)),
      authorize: (operation: PiDurableOperation) => guard(authorize(operation)),
      persistence,
      publication: (...args: Parameters<typeof publication>) => guard(publication(...args)),
      persistNative: (...args: Parameters<typeof persistNative>) => guard(persistNative(...args)),
      persistControl: (...args: Parameters<typeof persistControl>) =>
        guard(persistControl(...args)),
      persistTerminal: (...args: Parameters<typeof persistTerminal>) =>
        guard(persistTerminal(...args)),
      nativeFor: (...args: Parameters<typeof nativeFor>) => guard(nativeFor(...args)),
      resolveOperation,
    };
  },
);
export class ProjectTeamPiOperations extends Context.Service<
  ProjectTeamPiOperations,
  Effect.Success<ReturnType<typeof makeProjectTeamPiOperations>>
>()("t3/projectWork/ProjectTeamPiOperations") {}
