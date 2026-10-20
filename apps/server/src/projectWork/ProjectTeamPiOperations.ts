import * as Stream from "effect/Stream";
import { ProjectWorkEventBus } from "./ProjectWorkEventBus.ts";
import {
  notifyCompactCallerChange,
  subscribeCompactCallerChanges,
  type CompactCallerRequest,
  type CompactCallerReservation,
} from "./ProjectTeamCompactCaller.ts";
import { projectTeamAssignmentProfile } from "./ProjectTeamPolicy.ts";
import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  GitCommandError,
  ProjectTeamRunBinding,
  ProjectTeamRoleRevision,
  ProjectTeamMember,
  CommandId,
  MessageId,
  ThreadId,
  ModelSelection,
  ProviderInstanceId,
  SkillCatalogRevision,
  SkillApplicationMode,
  ManagedSkillKey,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ManagedGit from "../git/ManagedGitExecution.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  isPiBrokerManagedModel,
  piBrokerModelRoute as piBrokerModelRouteFor,
} from "../provider/pi/PiManagedModels.ts";
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
import {
  auditProjectTeamRecordedPiModelRow,
  decodeProjectTeamRecordedModelRow,
  ModelAccountingError,
} from "./ProjectTeamModelAccounting.ts";
import {
  ProjectMemoryOperationIdentity,
  ProjectMemoryTaskOwner,
  auditProjectMemoryOperationLedger,
} from "./memory/ProjectMemoryModelAccounting.ts";
import {
  ProjectTeamAuthorization,
  inspectProjectTeamSessionAuthority,
  managedActorId,
  type ProjectTeamAuthority,
  type ProjectTeamPrincipal,
} from "./ProjectTeamAuthorization.ts";
import {
  ProjectTeamReviewTarget,
  makeProjectTeamReviewTargets,
} from "./ProjectTeamReviewTargets.ts";
import { readCurrentState, ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamWorkspaceReceipt,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";

const encode = canonicalProjectWorkPayload;
const decodeAllocationReviewTarget = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamReviewTarget),
  { onExcessProperty: "error" },
);
const decodeReviewWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamWorkspaceReceipt),
  { onExcessProperty: "error" },
);
const decodeCompactAuthorityRecords = Schema.decodeUnknownEffect(
  Schema.Struct({
    binding: ProjectTeamRunBinding,
    role: ProjectTeamRoleRevision,
    member: ProjectTeamMember,
  }),
  { onExcessProperty: "error" },
);
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
const decodeMemoryIdentity = Schema.decodeUnknownEffect(ProjectMemoryOperationIdentity, {
  onExcessProperty: "error",
});
const decodeMemoryTaskOwner = Schema.decodeUnknownEffect(ProjectMemoryTaskOwner, {
  onExcessProperty: "error",
});
const decodeMemoryAllocation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PiManagedProcessAllocationSchema),
  { onExcessProperty: "error" },
);
const decodeMemoryProcessOwner = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("owner"),
      unit: Schema.String,
      nonce: Schema.String,
      invocation: Schema.String,
      cgroup: Schema.String,
      pid: Schema.Int,
      memoryBytes: Schema.Int,
      swapBytes: Schema.Literal(0),
      oomGroup: Schema.Literal(1),
    }),
  ),
  { onExcessProperty: "error" },
);
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Safe.check(Schema.isGreaterThan(0));
const OperationLimits = Schema.Struct({ maximumTokens: Positive, deadlineAtMs: Positive });
const RootBudget = Schema.Struct({ rootTaskId: Schema.String, ...OperationLimits.fields });
const decodeCompactBudgetContext = Schema.decodeUnknownEffect(
  Schema.Struct({
    provenanceSha256: ResourceIdentity,
    textSha256: ResourceIdentity,
    sourceRevision: Safe,
  }),
  { onExcessProperty: "error" },
);
const CompactAssociation = Schema.Struct({
  version: Schema.Literal(1),
  requestId: MessageId,
  dispatchId: Schema.String,
  dispatchIntentSha256: ResourceIdentity,
  claimGeneration: Positive,
  fenceRevision: Safe,
  predecessorOperationId: Schema.String,
  predecessorOrdinal: Safe,
  predecessorReceiptSha256: ResourceIdentity,
  contextProvenanceSha256: ResourceIdentity,
  contextTextSha256: ResourceIdentity,
});
const decodeCompactAssociation = Schema.decodeUnknownEffect(CompactAssociation);
const decodeCompactMessageId = Schema.decodeUnknownEffect(MessageId);
const decodeCompactIdentity = Schema.decodeUnknownEffect(
  Schema.Struct({ kind: Schema.Literal("compact"), requestId: MessageId }),
);
const CompactAnchor = Schema.Struct({
  operationId: Schema.String,
  operationOrdinal: Safe,
  receiptSha256: ResourceIdentity,
  native: PiNativeReference,
});
export type PiCompactionAnchor = typeof CompactAnchor.Type;
type PiCompactReplayHead = {
  readonly operation: PiWorkerOperation;
  readonly native: PiNativeReference;
  readonly nativeState: NonNullable<PiManagedProcessAllocation["launch"]["nativeState"]>;
  readonly resourceHash: string;
  readonly deadlineAtMs: number;
};
const StoredRequestFields = {
  threadId: ThreadId,
  operationId: Schema.String,
  runtimeMode: Schema.optionalKey(Schema.Literal("approval-required")),
  cwd: Schema.optionalKey(Schema.String),
  modelSelection: Schema.optionalKey(ModelSelection),
  resumeCursor: Schema.optionalKey(Schema.Unknown),
  skillPlan: Schema.optionalKey(
    Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      desiredRevision: SkillCatalogRevision,
      applicationMode: SkillApplicationMode,
      skillKeys: Schema.Array(ManagedSkillKey),
      payload: Schema.Unknown,
    }),
  ),
};
const decodeStoredRequest = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({ ...StoredRequestFields, kind: Schema.Literal("initialize") }),
    Schema.Struct({
      ...StoredRequestFields,
      kind: Schema.Literal("prompt"),
      prompt: Schema.String,
    }),
    Schema.Struct({
      ...StoredRequestFields,
      kind: Schema.Literal("compact"),
      requestId: MessageId,
    }),
  ]),
  { onExcessProperty: "error" },
);
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
      compaction: Schema.optional(CompactAssociation),
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
      compaction: Schema.optional(CompactAssociation),
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
      compaction: Schema.optional(CompactAssociation),
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
  const target = launch.reviewTarget;
  if (
    target &&
    (!canonicalPath(target.source) ||
      !physicalIdentity(target) ||
      target.target !== "/review-target" ||
      overlaps(target.source, launch.workspaceRoot) ||
      (native && overlaps(target.source, native.path)) ||
      launch.protectedRoots.some((root) => overlaps(root, target.source)) ||
      launch.runtimeFiles.some((file) => overlaps(file.source, target.source)))
  )
    return false;
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
const immutableRole = (value: typeof ProjectTeamRoleRevision.Type) => {
  const { revision: _, status: _status, updatedAt: _at, ...immutable } = value;
  return encode(immutable);
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
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(encode(value)).digest("hex");
const compactOperationId = (
  snapshot: ProjectTeamDispatchSnapshot,
  binding: typeof ProjectTeamRunBinding.Type,
  requestId: MessageId,
) =>
  "compact_" +
  digest({
    environmentId: binding.environmentId,
    dispatchId: snapshot.fence.dispatchId,
    bindingId: binding.recordId,
    generation: binding.generation,
    providerInstanceId: binding.providerInstanceId,
    threadId: binding.threadId,
    requestId,
  });
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
import { makeProjectTaskResources } from "./ProjectTaskResources.ts";

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

export interface ProjectTeamPiUsageHistory {
  readonly bindingId: string;
  readonly generation: number;
  readonly taskId: string;
  readonly attemptId: string;
  readonly rootTaskId: string;
  readonly rootMaximumTokens: number;
  readonly rootDeadlineAtMs: number;
  readonly attemptMaximumTokens: number;
  readonly attemptDeadlineAtMs: number;
  readonly operations: ReadonlyArray<{
    readonly operationId: string;
    readonly workerId: string;
    readonly maximumTokens: number;
    readonly deadlineAtMs: number;
    readonly ordinal: number;
    readonly terminalAccounting?: PiSessionTerminal["accountingReceipts"];
  }>;
}

export const makeProjectTeamPiOperations = Effect.fn("makeProjectTeamPiOperations")(
  function* (options: { readonly environmentId: string }) {
    const sql = yield* SqlClient.SqlClient;
    const taskResources = yield* makeProjectTaskResources(options.environmentId);
    const clock = yield* Clock.Clock;
    const authorization = yield* ProjectTeamAuthorization;
    const repository = yield* ProjectWorkRepository;
    const reviewTargets = yield* makeProjectTeamReviewTargets({
      environmentId: options.environmentId,
      maximumEnvironmentModelCalls: 128,
    });
    const workflow = yield* Effect.serviceOption(GitWorkflowService);
    const filesystem = yield* Effect.serviceOption(FileSystem.FileSystem);
    const path = yield* Effect.serviceOption(Path.Path);
    const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
    const platform = yield* HostProcessPlatform;
    // These retained reads validate intent, claim receipts and stage history only.
    // The schema maximum is unused by them and grants no model-call capacity.
    const {
      inspect: inspectDispatch,
      readRetained,
      readStageReceipts,
      readHistoricalInTransaction,
    } = yield* makeProjectTeamDispatchJournal({
      environmentId: options.environmentId,
      maximumEnvironmentModelCalls: 128,
    });
    const assertReviewAllocation = Effect.fn("ProjectTeamPiOperations.assertReviewAllocation")(
      function* (binding: ProjectTeamAuthority["binding"], allocation: PiManagedProcessAllocation) {
        const rows = yield* sql<{ manifest_json: string | null; sha256: string }>`SELECT
        CASE WHEN length(CAST(manifest_json AS BLOB))<=65536 THEN manifest_json END AS manifest_json,sha256
        FROM project_team_review_target WHERE environment_id=${options.environmentId} AND project_id=${binding.projectId}
        AND binding_id=${binding.recordId} AND generation=${binding.generation} LIMIT 2`;
        const mounted = allocation.launch.reviewTarget;
        if (!rows.length && !mounted) return;
        if (
          rows.length !== 1 ||
          typeof rows[0]?.manifest_json !== "string" ||
          !mounted ||
          !validRetainedAllocation(allocation)
        )
          return yield* deny("Retained review allocation target is unavailable");
        const target = yield* decodeAllocationReviewTarget(rows[0].manifest_json).pipe(
          Effect.mapError(() => deny("Retained review allocation target is invalid")),
        );
        const hash = (value: unknown) =>
          NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
        const job = target.prepared.manifest;
        if (
          canonicalProjectWorkPayload(target) !== rows[0].manifest_json ||
          hash(target) !== rows[0].sha256 ||
          mounted.targetHash !== rows[0].sha256 ||
          mounted.manifestHash !== target.prepared.sha256 ||
          hash(job) !== mounted.manifestHash ||
          mounted.source !== job.target.worktree ||
          mounted.testedCommit !== job.target.testedCommit ||
          mounted.testedTree !== job.target.testedTree ||
          target.reviewer.bindingId !== binding.recordId ||
          target.reviewer.generation !== binding.generation ||
          target.reviewer.taskId !== binding.taskId
        )
          return yield* deny("Retained review allocation target identity changed");
        return target;
      },
    );
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
        !isPiBrokerManagedModel(found.binding.model)
      )
        return yield* deny("Current managed Pi binding required");
      if (!initialize && (found.binding.status !== "running" || !found.binding.sessionId))
        return yield* deny("Running native Pi session required");
      return found;
    });
    const inheritedHumanRoot = Effect.fn("ProjectTeamPiOperations.inheritedHumanRoot")(function* (
      authority: ProjectTeamAuthority,
      rootTaskId: string,
      maximumTokens: number,
      deadlineAtMs: number,
    ) {
      const binding = authority.binding;
      const records = authority.state.foundationRecords ?? [];
      const membership = records.find(
        (record) => record.kind === "task-membership" && record.taskId === binding.taskId,
      );
      const grant = records.find(
        (record) => record.kind === "gate" && record.recordId === binding.authorizationGateId,
      );
      if (
        binding.parentRunId !== undefined ||
        binding.taskId === rootTaskId ||
        membership?.kind !== "task-membership" ||
        membership.parentTaskId === undefined ||
        membership.assignment?.authorizationGateId !== binding.authorizationGateId ||
        grant?.kind !== "gate" ||
        grant.gate !== "assignment" ||
        grant.status !== "consumed" ||
        grant.consumedByRunId !== binding.recordId ||
        grant.attribution?.actor.kind !== "human" ||
        grant.assignmentAuthorization?.parentTaskId !== membership.parentTaskId ||
        membership.deliverableKind !==
          projectTeamAssignmentProfile(grant.assignmentAuthorization.assignmentKind)
            .deliverableKind ||
        authority.role.role !==
          projectTeamAssignmentProfile(grant.assignmentAuthorization.assignmentKind).role ||
        binding.configuration.toolIds.some(
          (tool) =>
            !projectTeamAssignmentProfile(
              grant.assignmentAuthorization!.assignmentKind,
            ).tools.includes(tool),
        )
      )
        return yield* deny("Pi root run is orphaned");
      // This retained root is budget evidence. Current forward authority belongs to the human-approved child.
      const children = yield* sql<{
        dispatch_id: string | null;
      }>`SELECT CASE WHEN typeof(dispatch_id)='text' AND length(CAST(dispatch_id AS BLOB))<=256 THEN dispatch_id ELSE NULL END AS dispatch_id
        FROM project_team_dispatch WHERE environment_id=${options.environmentId} AND binding_id=${binding.recordId} AND generation=${binding.generation} LIMIT 2`;
      if (children.length !== 1 || !children[0]?.dispatch_id)
        return yield* deny("Pi human child requires its original dispatch");
      const child = yield* inspectDispatch(children[0].dispatch_id, { requireClaim: true });
      yield* readStageReceipts(child.fence.dispatchId);
      const childClaim = child.intent.compiledClaim.transition;
      if (
        childClaim?.kind !== "claim" ||
        immutableBinding(childClaim.binding) !== immutableBinding(binding) ||
        child.intent.limits.rootTaskId !== rootTaskId ||
        child.fence.stage === "stopping" ||
        child.fence.stage === "quarantine" ||
        child.fence.stage === "settled"
      )
        return yield* deny("Pi human child dispatch changed");
      const budgets = yield* sql<{
        maximum_tokens: number | null;
        deadline_at_ms: number | null;
      }>`SELECT
        CASE WHEN typeof(maximum_tokens)='integer' THEN maximum_tokens ELSE NULL END AS maximum_tokens,
        CASE WHEN typeof(deadline_at_ms)='integer' THEN deadline_at_ms ELSE NULL END AS deadline_at_ms
        FROM project_team_model_budget WHERE environment_id=${options.environmentId} AND project_id=${binding.projectId} AND root_task_id=${rootTaskId}`;
      const anchors = yield* sql<{
        dispatch_id: string | null;
      }>`SELECT CASE WHEN typeof(dispatch_id)='text' AND length(CAST(dispatch_id AS BLOB))<=256 THEN dispatch_id ELSE NULL END AS dispatch_id
        FROM project_team_dispatch WHERE environment_id=${options.environmentId} AND project_id=${binding.projectId} AND root_task_id=${rootTaskId} ORDER BY created_at,dispatch_id LIMIT 1`;
      if (budgets.length !== 1 || !anchors[0]?.dispatch_id)
        return yield* deny("Pi human child has no retained root budget");
      const original = yield* readRetained(anchors[0].dispatch_id);
      yield* readStageReceipts(original.fence.dispatchId);
      const claim = original.intent.compiledClaim.transition;
      const root = claim?.kind === "claim" ? claim.binding : undefined;
      const retained = records.filter(
        (record) => record.kind === "run-binding" && record.recordId === root?.recordId,
      );
      const currentRoot = retained[0];
      const rootRole = records.find(
        (record) => record.kind === "role-revision" && record.recordId === root?.roleRevisionId,
      );
      const rootGrant = records.find(
        (record) => record.kind === "gate" && record.recordId === root?.authorizationGateId,
      );
      const rootTask = authority.state.tasks.find((task) => task.taskId === rootTaskId);
      const rootMembership = records.find(
        (record) => record.kind === "task-membership" && record.taskId === rootTaskId,
      );
      if (
        !root ||
        root.taskId !== rootTaskId ||
        root.parentRunId !== undefined ||
        root.projectId !== binding.projectId ||
        root.environmentId !== options.environmentId ||
        original.intent.limits.rootTaskId !== rootTaskId ||
        original.fence.claimGeneration <= 0 ||
        original.fence.stage === "stopping" ||
        original.fence.stage === "quarantine" ||
        ![
          "setup-complete",
          "session-bound",
          "assignment-intent",
          "assignment-observed",
          "settled",
        ].includes(original.fence.stage) ||
        retained.length !== 1 ||
        currentRoot?.kind !== "run-binding" ||
        immutableBinding(currentRoot) !== immutableBinding(root) ||
        currentRoot.status === "revoked" ||
        currentRoot.status === "stopping" ||
        currentRoot.status === "quarantined" ||
        rootRole?.kind !== "role-revision" ||
        rootRole.projectId !== binding.projectId ||
        rootRole.model !== root.model ||
        root.configuration.instructionsHash !==
          NodeCrypto.createHash("sha256").update(rootRole.instructions).digest("hex") ||
        rootGrant?.kind !== "gate" ||
        rootGrant.taskId !== rootTaskId ||
        rootGrant.status !== "consumed" ||
        rootGrant.consumedByRunId !== root.recordId ||
        records.some(
          (record) =>
            record.kind === "effect" &&
            record.effectKind === "setup" &&
            record.runId === root.recordId &&
            record.status !== "succeeded",
        ) ||
        !rootTask ||
        rootTask.state === "canceled" ||
        rootMembership?.kind !== "task-membership" ||
        rootTask.specRevision !== root.specRevision ||
        rootMembership.parentTaskId !== undefined ||
        rootMembership.status !== "active" ||
        (rootMembership.controlState !== undefined && rootMembership.controlState !== "active") ||
        budgets[0]?.maximum_tokens !== original.intent.limits.maximumTokens ||
        budgets[0]?.deadline_at_ms !== original.intent.limits.rootDeadlineAtMs ||
        child.intent.limits.maximumTokens !== original.intent.limits.maximumTokens ||
        child.intent.limits.rootDeadlineAtMs !== original.intent.limits.rootDeadlineAtMs ||
        encode(child.intent.rootCaps) !== encode(original.intent.rootCaps) ||
        (yield* Clock.currentTimeMillis) >= original.intent.limits.rootDeadlineAtMs
      )
        return yield* deny("Pi human child retained root changed");
      const caps = original.intent.rootCaps;
      const changed = yield* sql`SELECT 1 FROM project_team_dispatch
        WHERE environment_id=${options.environmentId} AND project_id=${binding.projectId} AND root_task_id=${rootTaskId}
        AND (root_maximum_tokens <> ${original.intent.limits.maximumTokens} OR root_deadline_at_ms <> ${original.intent.limits.rootDeadlineAtMs}
          OR json_extract(intent_json,'$.rootCaps.maximumDelegationDepth') IS NOT ${caps.maximumDelegationDepth}
          OR json_extract(intent_json,'$.rootCaps.repairAllowance') IS NOT ${caps.repairAllowance}
          OR json_extract(intent_json,'$.rootCaps.environmentModelCalls') IS NOT ${caps.environmentModelCalls}
          OR json_extract(intent_json,'$.rootCaps.projectWritableWorkers') IS NOT ${caps.projectWritableWorkers}
          OR json_extract(intent_json,'$.rootCaps.modelCalls') IS NOT ${caps.modelCalls}) LIMIT 1`;
      if (changed.length) return yield* deny("Pi human child original root caps changed");
      return {
        root,
        rootTaskId,
        maximumTokens: Math.min(maximumTokens, original.intent.limits.maximumTokens),
        deadlineAtMs: Math.min(
          deadlineAtMs,
          original.intent.limits.rootDeadlineAtMs,
          child.intent.limits.deadlineAtMs,
        ),
      };
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
          if (binding.taskId !== rootTaskId)
            return yield* inheritedHumanRoot(initial, rootTaskId, maximumTokens, deadline);
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
      authority: Pick<ProjectTeamAuthority, "binding" | "state">,
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
    // Historical display reads do not resolve current execution authority or extend a lease.
    const readUsageHistoryInTransaction = Effect.fn(
      "ProjectTeamPiOperations.readUsageHistoryInTransaction",
    )(function* (bindingId: string, generation: number, snapshot?: ProjectTeamAuthority["state"]) {
      const suppliedSql = yield* Effect.serviceOption(SqlClient.SqlClient);
      const suppliedRepository = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(suppliedSql) ||
        suppliedSql.value !== sql ||
        Option.isNone(suppliedRepository) ||
        suppliedRepository.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Historical Pi usage requires its captured transaction");
      const bindingRows = yield* sql<{ projectId: string | null }>`SELECT
          CASE WHEN length(CAST(project_id AS BLOB))<=1024 THEN project_id END AS projectId
          FROM project_team_run_binding WHERE record_id=${bindingId} LIMIT 2`;
      const projectId = bindingRows[0]?.projectId;
      if (bindingRows.length !== 1 || !projectId)
        return yield* deny("Historical binding unavailable");
      const state = snapshot ?? (yield* readCurrentState(sql, projectId));
      if (
        state.projectId !== projectId ||
        !Array.isArray(state.foundationRecords) ||
        !Array.isArray(state.tasks) ||
        !Array.isArray(state.attempts)
      )
        return yield* deny("Historical project authority unavailable");
      const bindings = (state.foundationRecords ?? []).filter(
        (record) => record.kind === "run-binding" && record.recordId === bindingId,
      );
      const binding = bindings[0];
      if (
        bindings.length !== 1 ||
        binding?.kind !== "run-binding" ||
        binding.environmentId !== options.environmentId ||
        binding.generation !== generation ||
        state.tasks.filter((task) => task.taskId === binding.taskId && task.projectId === projectId)
          .length !== 1 ||
        state.attempts.filter(
          (attempt) => attempt.attemptId === binding.attemptId && attempt.taskId === binding.taskId,
        ).length !== 1
      )
        return yield* deny("Historical task owner differs");
      const metadata = yield* sql<{ bytes: number }>`SELECT
          length(CAST(operation_id AS BLOB))+length(CAST(environment_id AS BLOB))+
          length(CAST(project_id AS BLOB))+length(CAST(binding_id AS BLOB))+
          length(CAST(generation AS BLOB))+length(CAST(provider_instance_id AS BLOB))+
          length(CAST(thread_id AS BLOB))+length(CAST(worker_id AS BLOB))+
          length(CAST(operation_ordinal AS BLOB))+length(CAST(operation_kind AS BLOB))+
          length(CAST(request_hash AS BLOB))+length(CAST(root_binding_id AS BLOB))+
          length(CAST(root_task_id AS BLOB))+length(CAST(maximum_tokens AS BLOB))+
          length(CAST(deadline_at_ms AS BLOB))+length(CAST(status AS BLOB))+
          COALESCE(length(CAST(native_json AS BLOB)),0)+COALESCE(length(CAST(terminal_json AS BLOB)),0)+
          length(CAST(intent_json AS BLOB)) AS bytes FROM project_team_pi_operation
          WHERE binding_id=${bindingId} AND generation=${generation} ORDER BY operation_ordinal LIMIT 131`;
      if (
        metadata.length > 130 ||
        metadata.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 1048576) ||
        metadata.reduce((total, row) => total + row.bytes, 0) > 4194304
      )
        return yield* deny("Historical Pi usage exceeds its retained bound");
      const rows = yield* sql<Row>`SELECT * FROM project_team_pi_operation
          WHERE binding_id=${bindingId} AND generation=${generation} ORDER BY operation_ordinal LIMIT 131`;
      if (rows.length !== metadata.length)
        return yield* deny("Historical Pi operations unavailable");
      const first = rows[0];
      const dispatches = yield* sql<{ dispatchId: string | null }>`SELECT
          CASE WHEN length(CAST(dispatch_id AS BLOB))<=1024 THEN dispatch_id END AS dispatchId
          FROM project_team_dispatch WHERE binding_id=${bindingId} AND generation=${generation} LIMIT 2`;
      if (dispatches.length > 1) return yield* deny("Historical dispatch is ambiguous");
      const dispatchId = dispatches[0]?.dispatchId;
      if (dispatches.length && !dispatchId)
        return yield* deny("Historical dispatch identity unavailable");
      const dispatch = dispatchId
        ? (yield* readHistoricalInTransaction(dispatchId, state)).snapshot
        : undefined;
      const transition = dispatch?.intent.compiledClaim.transition;
      if (
        dispatch &&
        (transition?.kind !== "claim" ||
          immutableBinding(transition.binding) !== immutableBinding(binding))
      )
        return yield* deny("Historical dispatch binding differs");
      if (!dispatch && !first) return yield* deny("Historical Pi operation unavailable");
      const budget = dispatch
        ? {
            rootTaskId: dispatch.intent.limits.rootTaskId,
            maximumTokens: dispatch.intent.limits.maximumTokens,
            deadlineAtMs: dispatch.intent.limits.rootDeadlineAtMs,
          }
        : first
          ? yield* standaloneBudget({ binding, state }, first.root_task_id)
          : undefined;
      if (!budget) return yield* deny("Historical original budget unavailable");
      const firstIntent = first ? yield* decodeBudgetIntent(first.intent_json) : undefined;
      const attemptMaximumTokens =
        dispatch?.intent.limits.attemptMaximumTokens ??
        firstIntent?.binding.configuration.maxTokens;
      const attemptDeadlineAtMs =
        dispatch?.intent.limits.deadlineAtMs ?? firstIntent?.operationLimits.deadlineAtMs;
      if (attemptMaximumTokens === undefined || attemptDeadlineAtMs === undefined)
        return yield* deny("Historical original attempt unavailable");
      const operations: Array<ProjectTeamPiUsageHistory["operations"][number]> = [];
      for (const row of rows) {
        const intent = yield* decodeBudgetIntent(row.intent_json);
        const processes = yield* sql<{
          unit: string;
          allocation: string;
        }>`SELECT unit,allocation_json AS allocation
            FROM project_team_pi_process WHERE operation_id=${row.operation_id} LIMIT 2`;
        const process = processes[0];
        if (
          processes.length !== 1 ||
          !process ||
          process.unit !== intent.allocation.unit ||
          encode(yield* decodeReplayAllocation(process.allocation)) !== encode(intent.allocation)
        )
          return yield* deny("Historical original allocation differs");
        const roles = (state.foundationRecords ?? []).filter(
          (record) => record.kind === "role-revision" && record.recordId === intent.role.recordId,
        );
        const role = roles[0];
        const rootBinding = state.foundationRecords.find(
          (record) => record.kind === "run-binding" && record.recordId === row.root_binding_id,
        );
        if (
          row.environment_id !== options.environmentId ||
          row.project_id !== projectId ||
          row.binding_id !== bindingId ||
          row.generation !== generation ||
          row.provider_instance_id !== binding.providerInstanceId ||
          row.thread_id !== binding.threadId ||
          rootBinding?.kind !== "run-binding" ||
          rootBinding.taskId !== budget.rootTaskId ||
          rootBinding.projectId !== projectId ||
          rootBinding.environmentId !== options.environmentId ||
          rootBinding.parentRunId !== undefined ||
          immutableBinding(intent.binding) !== immutableBinding(binding) ||
          roles.length !== 1 ||
          role?.kind !== "role-revision" ||
          immutableRole(role) !== immutableRole(intent.role) ||
          !validRetainedAllocation(intent.allocation) ||
          intent.allocation.launch.workspaceRoot !== binding.worktree ||
          !isWorkerIdentity({ workerId: row.worker_id, generation: row.generation }) ||
          !isWorkerOperation({
            operationId: row.operation_id,
            operationKind: row.operation_kind,
          }) ||
          !Number.isSafeInteger(row.operation_ordinal) ||
          row.operation_ordinal < 0 ||
          intent.request.kind !== row.operation_kind ||
          intent.request.threadId !== binding.threadId ||
          (intent.request.operationId !== undefined &&
            (intent.request.operationId !== row.operation_id ||
              digest(intent.request) !== row.request_hash)) ||
          encode(intent.rootBudget) !== encode(budget) ||
          row.root_task_id !== budget.rootTaskId ||
          intent.operationLimits.maximumTokens !== row.maximum_tokens ||
          intent.operationLimits.deadlineAtMs !== row.deadline_at_ms ||
          !Number.isSafeInteger(row.maximum_tokens) ||
          row.maximum_tokens < 1 ||
          row.maximum_tokens > Math.min(budget.maximumTokens, attemptMaximumTokens) ||
          !Number.isSafeInteger(row.deadline_at_ms) ||
          row.deadline_at_ms < 1 ||
          row.deadline_at_ms > Math.min(budget.deadlineAtMs, attemptDeadlineAtMs)
        )
          return yield* deny("Historical Pi intent or original ceilings differ");
        let terminalAccounting: ProjectTeamPiUsageHistory["operations"][number]["terminalAccounting"];
        if (row.terminal_json) {
          const terminal = yield* decodeTerminal(row.terminal_json);
          if (
            terminal.identity.workerId !== row.worker_id ||
            terminal.identity.generation !== generation ||
            terminal.operation.operationId !== row.operation_id ||
            terminal.operation.operationKind !== row.operation_kind
          )
            return yield* deny("Historical terminal owner differs");
          terminalAccounting = terminal.accountingReceipts;
        }
        operations.push({
          operationId: row.operation_id,
          workerId: row.worker_id,
          maximumTokens: row.maximum_tokens,
          deadlineAtMs: row.deadline_at_ms,
          ordinal: row.operation_ordinal,
          ...(terminalAccounting === undefined ? {} : { terminalAccounting }),
        });
      }
      return {
        bindingId,
        generation,
        taskId: binding.taskId,
        attemptId: binding.attemptId,
        rootTaskId: budget.rootTaskId,
        rootMaximumTokens: budget.maximumTokens,
        rootDeadlineAtMs: budget.deadlineAtMs,
        attemptMaximumTokens,
        attemptDeadlineAtMs,
        operations,
      } satisfies ProjectTeamPiUsageHistory;
    });
    const readUsageHistoryBatchInTransaction = Effect.fn(
      "ProjectTeamPiOperations.readUsageHistoryBatchInTransaction",
    )(function* (projectId: string, owners: readonly { bindingId: string; generation: number }[]) {
      if (owners.length === 0 || owners.length > 128)
        return yield* deny("Historical usage owner batch exceeds its bound");
      const suppliedSql = yield* Effect.serviceOption(SqlClient.SqlClient);
      const suppliedRepository = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(suppliedSql) ||
        suppliedSql.value !== sql ||
        Option.isNone(suppliedRepository) ||
        suppliedRepository.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Historical usage batch requires its captured transaction");
      const state = yield* readCurrentState(sql, projectId);
      const histories: ProjectTeamPiUsageHistory[] = [];
      for (const owner of owners)
        histories.push(
          yield* readUsageHistoryInTransaction(owner.bindingId, owner.generation, state),
        );
      return histories;
    });
    const readJoinedQuarantinedFailureInTransaction = Effect.fn(
      "ProjectTeamPiOperations.readJoinedQuarantinedFailureInTransaction",
    )(function* (snapshot: ProjectTeamDispatchSnapshot) {
      const suppliedSql = yield* Effect.serviceOption(SqlClient.SqlClient);
      const suppliedRepository = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(suppliedSql) ||
        suppliedSql.value !== sql ||
        Option.isNone(suppliedRepository) ||
        suppliedRepository.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Pi failure proof requires its captured transaction");
      const transition = snapshot.intent.compiledClaim.transition;
      if (transition?.kind !== "claim") return yield* deny("Original Pi binding is unavailable");
      const binding = transition.binding;
      const dispatches = yield* sql<{
        dispatch_id: string | null;
        project_id: string | null;
        task_id: string | null;
        root_task_id: string | null;
      }>`SELECT
        CASE WHEN typeof(dispatch_id)='text' AND length(CAST(dispatch_id AS BLOB)) BETWEEN 1 AND 256 THEN dispatch_id END AS dispatch_id,
        CASE WHEN typeof(project_id)='text' AND length(CAST(project_id AS BLOB)) BETWEEN 1 AND 256 THEN project_id END AS project_id,
        CASE WHEN typeof(task_id)='text' AND length(CAST(task_id AS BLOB)) BETWEEN 1 AND 256 THEN task_id END AS task_id,
        CASE WHEN typeof(root_task_id)='text' AND length(CAST(root_task_id AS BLOB)) BETWEEN 1 AND 256 THEN root_task_id END AS root_task_id
        FROM project_team_dispatch WHERE environment_id=${options.environmentId}
        AND dispatch_id=${snapshot.fence.dispatchId} AND binding_id=${binding.recordId}
        AND generation=${binding.generation} LIMIT 2`;
      if (
        dispatches.length !== 1 ||
        dispatches[0]?.dispatch_id !== snapshot.fence.dispatchId ||
        dispatches[0].project_id !== binding.projectId ||
        dispatches[0].task_id !== binding.taskId ||
        dispatches[0].root_task_id !== snapshot.intent.limits.rootTaskId
      )
        return yield* deny("Original Pi dispatch identity differs");
      const operationCount = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
        FROM project_team_pi_operation WHERE environment_id=${options.environmentId}
        AND binding_id=${binding.recordId} AND generation=${binding.generation}`;
      if (
        operationCount.length !== 1 ||
        !Number.isSafeInteger(operationCount[0]?.count) ||
        operationCount[0]!.count < 0
      )
        return yield* deny("Original Pi operation count is unavailable");
      if (operationCount[0]!.count === 0) return undefined;
      if (operationCount[0]!.count > 130)
        return yield* deny("Original Pi failure history exceeds its bound");
      const history = yield* readUsageHistoryInTransaction(binding.recordId, binding.generation);
      if (
        history.taskId !== binding.taskId ||
        history.attemptId !== binding.attemptId ||
        history.rootTaskId !== snapshot.intent.limits.rootTaskId
      )
        return yield* deny("Original Pi task owner differs");
      const operations = yield* sql<{
        operation_id: string;
        operation_kind: string;
        status: string;
        native_json: string | null;
        terminal_json: string | null;
      }>`SELECT operation_id,operation_kind,status,native_json,terminal_json FROM project_team_pi_operation
        WHERE environment_id=${options.environmentId} AND binding_id=${binding.recordId}
        AND generation=${binding.generation} ORDER BY operation_ordinal LIMIT 131`;
      if (operations.length !== operationCount[0]!.count || operations.length > 130)
        return yield* deny("Original Pi failure history changed");
      if (operations.length !== history.operations.length)
        return yield* deny("Original Pi operation history differs");
      const operation = history.operations.at(-1);
      if (!operation) return undefined;
      const row = operations.find((candidate) => candidate.operation_id === operation.operationId);
      if (!row || row.status !== "settled" || !row.terminal_json)
        return yield* deny("Final original Pi operation has no qualified terminal");
      const terminal = yield* decodeTerminal(row.terminal_json).pipe(
        Effect.mapError(() => deny("Original Pi terminal is unavailable")),
      );
      if (terminal.outcome === "quarantine")
        return yield* deny("Final original Pi terminal is not authoritatively joined");
      if (
        !terminal.ownerCaptured ||
        !terminal.drain ||
        terminal.identity.workerId !== operation.workerId ||
        terminal.identity.generation !== binding.generation ||
        terminal.operation.operationId !== operation.operationId ||
        terminal.operation.operationKind !== row.operation_kind ||
        (row.native_json === null) !== (terminal.native === null) ||
        (row.native_json !== null &&
          encode(yield* decodeNative(row.native_json)) !== encode(terminal.native)) ||
        (terminal.outcome === "success" && terminal.native === null)
      )
        return yield* deny("Original Pi terminal owner differs");
      const memoryLedger = yield* auditProjectMemoryOperationLedger(sql, {
        environmentId: options.environmentId,
        projectId: binding.projectId,
        bindingId: binding.recordId,
        generation: binding.generation,
        operationId: operation.operationId,
      });
      if (!memoryLedger.settled) return yield* deny("Original Pi memory transport is not settled");
      const bounds = yield* sql<{ count: number; bytes: number }>`SELECT COUNT(*) AS count,
          COALESCE(SUM(
            length(CAST(reservation_id AS BLOB))+length(CAST(environment_id AS BLOB))+
            length(CAST(project_id AS BLOB))+length(CAST(root_task_id AS BLOB))+
            length(CAST(run_id AS BLOB))+length(CAST(attempt_id AS BLOB))+
            length(CAST(worker_id AS BLOB))+length(CAST(generation AS BLOB))+
            length(CAST(operation_id AS BLOB))+length(CAST(request_lane AS BLOB))+
            length(CAST(request_scope AS BLOB))+length(CAST(request_id AS BLOB))+
            length(CAST(route_id AS BLOB))+length(CAST(provider AS BLOB))+
            length(CAST(model AS BLOB))+length(CAST(environment_slot AS BLOB))+
            length(CAST(model_slot AS BLOB))+length(CAST(maximum_input_tokens AS BLOB))+
            length(CAST(maximum_output_tokens AS BLOB))+length(CAST(deadline_at_ms AS BLOB))+
            length(CAST(status AS BLOB))+length(CAST(capacity_state AS BLOB))+
            length(CAST(charged_input_tokens AS BLOB))+length(CAST(charged_output_tokens AS BLOB))+
            COALESCE(length(CAST(accounting_receipt_id AS BLOB)),0)+
            length(CAST(accounting_mode AS BLOB))+
            COALESCE(length(CAST(unknown_maximum_tokens AS BLOB)),0)+
            length(CAST(reservation_json AS BLOB))+
            COALESCE(length(CAST(settlement_json AS BLOB)),0)
          ),0) AS bytes FROM project_team_model_request
          WHERE operation_id=${operation.operationId} AND request_lane='pi' AND request_scope=''`;
      if (
        bounds.length !== 1 ||
        !Number.isSafeInteger(bounds[0]?.count) ||
        bounds[0]!.count < 0 ||
        bounds[0]!.count > 256 ||
        !Number.isSafeInteger(bounds[0]?.bytes) ||
        bounds[0]!.bytes < 0 ||
        bounds[0]!.bytes > 4_194_304
      )
        return yield* deny("Original Pi accounting exceeds its retained bound");
      if (bounds[0]!.count === 0) {
        if (terminal.outcome === "success" && terminal.accountingReceipts.length > 0)
          return yield* deny("Successful Pi terminal has unretained accounting receipts");
        return undefined;
      }
      const requests = yield* sql`SELECT reservation_id,environment_id,project_id,root_task_id,
          run_id,attempt_id,worker_id,generation,operation_id,request_lane,request_scope,request_id,
          route_id,provider,model,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,capacity_state,
          charged_input_tokens,charged_output_tokens,accounting_mode,unknown_maximum_tokens,
          accounting_receipt_id,reservation_json,settlement_json FROM project_team_model_request
          WHERE operation_id=${operation.operationId} AND request_lane='pi' AND request_scope=''
          ORDER BY request_id LIMIT 257`;
      if (requests.length !== bounds[0]!.count || requests.length > 256)
        return yield* deny("Original Pi accounting rows changed");
      let quarantined = false;
      const requestReferences: Array<{ reservationId: string; requestId: number }> = [];
      const requestStatuses: Array<string> = [];
      for (const value of requests) {
        const request = yield* decodeProjectTeamRecordedModelRow(value).pipe(
          Effect.mapError(() => deny("Original Pi accounting row is invalid")),
        );
        if (
          request.environment_id !== options.environmentId ||
          request.project_id !== binding.projectId ||
          request.root_task_id !== history.rootTaskId ||
          request.run_id !== binding.recordId ||
          request.attempt_id !== binding.attemptId ||
          request.worker_id !== operation.workerId ||
          request.generation !== binding.generation ||
          request.operation_id !== operation.operationId
        )
          return yield* deny("Original Pi accounting owner differs");
        if (request.status === "held")
          return yield* deny("Original Pi accounting still has a held request");
        if (request.accounting_mode === "openai-subscription-monitored") {
          const budgets = yield* sql<{
            maximum_tokens: number | null;
            deadline_at_ms: number | null;
          }>`SELECT
                CASE WHEN typeof(maximum_tokens)='integer' AND maximum_tokens BETWEEN 1 AND 64000 THEN maximum_tokens END AS maximum_tokens,
                CASE WHEN typeof(deadline_at_ms)='integer' AND deadline_at_ms BETWEEN 1 AND 9007199254740991 THEN deadline_at_ms END AS deadline_at_ms
              FROM project_team_model_budget
              WHERE environment_id=${options.environmentId} AND project_id=${binding.projectId}
              AND root_task_id=${history.rootTaskId} LIMIT 2`;
          const grants = yield* sql<{
            model: string | null;
            route_id: string | null;
            maximum_tokens: number | null;
            maximum_duration_ms: number | null;
            deadline_at_ms: number | null;
            stopped_at_ms: number | null;
            stopped_at_valid: number;
            stop_reason: string | null;
            stop_reason_valid: number;
          }>`SELECT
                CASE WHEN typeof(model)='text' AND length(CAST(model AS BLOB)) BETWEEN 1 AND 256 THEN model END AS model,
                CASE WHEN typeof(route_id)='text' AND length(CAST(route_id AS BLOB)) BETWEEN 1 AND 256 THEN route_id END AS route_id,
                CASE WHEN typeof(maximum_tokens)='integer' AND maximum_tokens BETWEEN 1 AND 9007199254740991 THEN maximum_tokens END AS maximum_tokens,
                CASE WHEN typeof(maximum_duration_ms)='integer' AND maximum_duration_ms BETWEEN 1 AND 9007199254740991 THEN maximum_duration_ms END AS maximum_duration_ms,
                CASE WHEN typeof(deadline_at_ms)='integer' AND deadline_at_ms BETWEEN 1 AND 9007199254740991 THEN deadline_at_ms END AS deadline_at_ms,
                CASE WHEN stopped_at_ms IS NULL THEN NULL
                  WHEN typeof(stopped_at_ms)='integer' AND stopped_at_ms BETWEEN 1 AND 9007199254740991 THEN stopped_at_ms END AS stopped_at_ms,
                CASE WHEN stopped_at_ms IS NULL OR
                  (typeof(stopped_at_ms)='integer' AND stopped_at_ms BETWEEN 1 AND 9007199254740991)
                  THEN 1 ELSE 0 END AS stopped_at_valid,
                CASE WHEN typeof(stop_reason)='text' AND length(CAST(stop_reason AS BLOB)) BETWEEN 1 AND 64 THEN stop_reason END AS stop_reason,
                CASE WHEN stop_reason IS NULL OR
                  (typeof(stop_reason)='text' AND length(CAST(stop_reason AS BLOB)) BETWEEN 1 AND 64
                    AND stop_reason IN ('unknown-usage','threshold-reached'))
                  THEN 1 ELSE 0 END AS stop_reason_valid
              FROM project_team_pi_subscription_grant WHERE environment_id=${options.environmentId}
              AND project_id=${binding.projectId} AND root_task_id=${history.rootTaskId} LIMIT 2`;
          if (
            budgets.length !== 1 ||
            grants.length !== 1 ||
            !budgets[0] ||
            !grants[0] ||
            budgets[0].maximum_tokens === null ||
            !Number.isSafeInteger(budgets[0].maximum_tokens) ||
            budgets[0].maximum_tokens <= 0 ||
            budgets[0].maximum_tokens > 64_000 ||
            budgets[0].deadline_at_ms === null ||
            !Number.isSafeInteger(budgets[0].deadline_at_ms) ||
            budgets[0].deadline_at_ms <= 0 ||
            grants[0].model !== "gpt-6-luna" ||
            grants[0].route_id !== "openai-subscription-luna" ||
            grants[0].maximum_tokens === null ||
            !Number.isSafeInteger(grants[0].maximum_tokens) ||
            grants[0].maximum_tokens !== 64_000 ||
            grants[0].maximum_duration_ms === null ||
            !Number.isSafeInteger(grants[0].maximum_duration_ms) ||
            grants[0].maximum_duration_ms !== 300_000 ||
            grants[0].deadline_at_ms === null ||
            !Number.isSafeInteger(grants[0].deadline_at_ms) ||
            grants[0].deadline_at_ms <= 0 ||
            grants[0].deadline_at_ms !== budgets[0].deadline_at_ms ||
            grants[0].stopped_at_valid !== 1 ||
            grants[0].stop_reason_valid !== 1 ||
            (grants[0].stopped_at_ms === null) !== (grants[0].stop_reason === null) ||
            (grants[0].stopped_at_ms !== null &&
              (!Number.isSafeInteger(grants[0].stopped_at_ms) || grants[0].stopped_at_ms <= 0)) ||
            (request.status === "unknown" &&
              (grants[0].stopped_at_ms === null || grants[0].stop_reason !== "unknown-usage")) ||
            request.model !== grants[0].model ||
            request.route_id !== grants[0].route_id ||
            request.unknown_maximum_tokens !== 64_000
          )
            return yield* deny("Original Pi subscription accounting grant differs");
        }
        requestReferences.push({
          reservationId: request.reservation_id,
          requestId: request.request_id,
        });
        requestStatuses.push(request.status);
        yield* auditProjectTeamRecordedPiModelRow(request, terminal.accountingReceipts).pipe(
          Effect.mapError(() => deny("Original Pi accounting proof is unavailable")),
        );
        quarantined ||= request.status === "unknown" && request.capacity_state === "quarantine";
      }
      if (terminal.outcome === "success") {
        if (
          requests.length !== terminal.accountingReceipts.length ||
          requestStatuses.some((status) => status !== "reported")
        )
          return yield* deny("Successful Pi terminal has incomplete original accounting");
        return undefined;
      }
      if (terminal.outcome !== "failed" && terminal.outcome !== "canceled") return undefined;
      if (!quarantined) return undefined;
      const fingerprint = NodeCrypto.createHash("sha256")
        .update(
          encode({
            rootTaskId: history.rootTaskId,
            bindingId: binding.recordId,
            generation: binding.generation,
            operationId: operation.operationId,
            outcome: terminal.outcome,
            requests: requestReferences,
          }),
        )
        .digest("hex");
      return { fingerprint, operationId: operation.operationId };
    });
    const rootBudget = Effect.fn("ProjectTeamPiOperations.rootBudget")(function* (
      authority: ProjectTeamAuthority,
      root: Effect.Success<ReturnType<typeof roots>>,
      operation: PiWorkerOperation,
      frozen?: typeof RootBudget.Type,
      request?: unknown,
      resourceHash?: string,
      compaction?: typeof CompactAssociation.Type,
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
        if (operation.operationKind === "compact") {
          const requested = yield* decodeCompactIdentity(request);
          if (
            !compaction ||
            compaction.requestId !== requested.requestId ||
            compaction.dispatchId !== snapshot.fence.dispatchId ||
            compaction.dispatchIntentSha256 !== digest(snapshot.intent) ||
            compaction.claimGeneration !== snapshot.fence.claimGeneration ||
            compaction.fenceRevision !== snapshot.fence.revision ||
            snapshot.fence.stage !== "assignment-observed" ||
            operation.operationId !== compactOperationId(snapshot, binding, requested.requestId)
          )
            return yield* deny("Compaction has no original retained assignment association");
          const predecessor = yield* getRow(compaction.predecessorOperationId);
          const terminal = predecessor.terminal_json
            ? yield* decodeTerminal(predecessor.terminal_json)
            : undefined;
          const native = predecessor.native_json
            ? yield* decodeNative(predecessor.native_json)
            : undefined;
          const ordinals = yield* sql<{ ordinal: number }>`SELECT operation_ordinal AS ordinal
            FROM project_team_pi_operation WHERE operation_id=${operation.operationId}`;
          if (
            predecessor.binding_id !== binding.recordId ||
            predecessor.generation !== binding.generation ||
            predecessor.operation_ordinal !== compaction.predecessorOrdinal ||
            predecessor.status !== "settled" ||
            !terminal ||
            !native ||
            terminal.outcome !== "success" ||
            !terminal.ownerCaptured ||
            !terminal.drain ||
            terminal.failureCode !== undefined ||
            digest({ operation: terminal.operation, terminal, native }) !==
              compaction.predecessorReceiptSha256 ||
            (ordinals[0] !== undefined && ordinals[0].ordinal !== compaction.predecessorOrdinal + 1)
          )
            return yield* deny("Compaction predecessor receipt changed");
          maximumTokens = Math.min(maximumTokens, predecessor.maximum_tokens);
          deadlineAtMs = Math.min(deadlineAtMs, predecessor.deadline_at_ms);
        } else if (operation.operationId !== originalOperationId) {
          const validateMailbox = Effect.gen(function* () {
            const decision = yield* mailboxDecisions
              .readInTransaction({ operationId: operation.operationId })
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
        intent.compaction,
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
      publishingCompact = false,
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
        (!settled &&
          !publishingCompact &&
          row.operation_kind === "compact" &&
          row.terminal_json !== null) ||
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
      yield* assertReviewAllocation(binding, captured.allocation);
      yield* operationBudget(authority, root, row);
      yield* clockCheck(row.deadline_at_ms);
      return authority;
    });
    // Successful receipts are observations of the original target, not permission
    // to replay after its retained ownership or physical Git identity changes.
    const assertReviewReplay = Effect.fn("ProjectTeamPiOperations.assertReviewReplay")(function* (
      authority: ProjectTeamAuthority,
      allocation: PiManagedProcessAllocation,
      retained: ProjectTeamReviewTarget,
    ) {
      if (
        authority.role.role !== "reviewer" ||
        Option.isNone(filesystem) ||
        Option.isNone(path) ||
        Option.isNone(spawner)
      )
        return yield* deny("Stable review target host is unavailable");
      const fs = filesystem.value;
      const binding = authority.binding;
      const mounted = allocation.launch.reviewTarget;
      if (!mounted) return yield* deny("Stable review target allocation is missing");
      const reviewer = yield* readRetained(retained.dispatchId);
      const revalidate = Effect.gen(function* () {
        const fresh = yield* current({
          providerInstanceId: binding.providerInstanceId,
          threadId: binding.threadId,
        });
        if (
          immutableBinding(fresh.binding) !== immutableBinding(binding) ||
          fresh.binding.sessionId !== binding.sessionId ||
          encode(fresh.role) !== encode(authority.role) ||
          encode(yield* reviewTargets.readForDispatch(reviewer)) !== encode(retained)
        )
          return yield* deny("Stable review target authority changed", "conflict");
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "review.replay",
              command: "/usr/bin/git",
              cwd: mounted.source,
              detail: "Original review target authority changed",
              cause,
            }),
        ),
      );
      const job = retained.prepared.manifest;
      const implementation = yield* readRetained(job.dispatchId);
      yield* readStageReceipts(job.dispatchId);
      const claim = implementation.intent.compiledClaim.transition;
      if (
        implementation.fence.stage !== "settled" ||
        claim?.kind !== "claim" ||
        claim.binding.environmentId !== options.environmentId ||
        claim.binding.projectId !== job.projectId ||
        claim.binding.taskId !== job.taskId ||
        claim.binding.recordId !== job.bindingId ||
        claim.binding.generation !== job.generation
      )
        return yield* deny("Stable review implementation authority changed", "conflict");
      const rows = yield* sql<{
        receipt_json: string | null;
        assignment_json: string | null;
      }>`SELECT
        CASE WHEN length(CAST(receipt_json AS BLOB))<=262144 THEN receipt_json END AS receipt_json,
        CASE WHEN length(CAST(assignment_json AS BLOB))<=262144 THEN assignment_json END AS assignment_json
        FROM project_team_workspace_receipt WHERE environment_id=${options.environmentId} AND dispatch_id=${job.dispatchId}
        AND binding_id=${job.bindingId} AND generation=${job.generation} AND claim_generation=${implementation.fence.claimGeneration} LIMIT 2`;
      if (
        rows.length !== 1 ||
        typeof rows[0]?.receipt_json !== "string" ||
        rows[0].assignment_json !== encode(implementation.intent.request.git)
      )
        return yield* deny("Stable review implementation workspace is unavailable", "conflict");
      const receipt = yield* decodeReviewWorkspace(rows[0].receipt_json);
      if (
        digest(receipt) !== job.workspaceReceiptHash ||
        encode(receipt.assignment) !== encode(implementation.intent.request.git)
      )
        return yield* deny("Stable review implementation workspace changed", "conflict");
      yield* Effect.gen(function* () {
        const managed = yield* ManagedGit.make({
          assignment: implementation.intent.request.git,
          priorReceipt: receipt,
          revalidate,
          persistWorkspace: () =>
            Effect.fail(
              new GitCommandError({
                operation: "review.replay",
                command: "/usr/bin/git",
                cwd: mounted.source,
                detail: "Review replay cannot create a workspace",
              }),
            ),
        });
        yield* ManagedGit.withManagedVerificationTarget(managed, (target) =>
          Effect.gen(function* () {
            if (
              target.cwd !== mounted.source ||
              target.cwd !== job.target.worktree ||
              target.baseSha !== job.target.baseSha ||
              target.headSha !== job.target.headSha ||
              target.testedCommit !== mounted.testedCommit ||
              target.testedTree !== mounted.testedTree ||
              encode(target.receipt) !== encode(receipt) ||
              (yield* fs.realPath(target.cwd)) !== target.cwd
            )
              return yield* deny("Stable committed review target changed", "conflict");
            const stat = yield* fs.stat(target.cwd);
            if (
              stat.type !== "Directory" ||
              Option.isNone(stat.ino) ||
              stat.dev !== mounted.dev ||
              stat.ino.value !== mounted.ino
            )
              return yield* deny("Stable review target physical identity changed", "conflict");
          }),
        );
        yield* revalidate;
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path.value),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner.value),
        Effect.provideService(HostProcessPlatform, platform),
      );
    });
    // A stable dispatch ID is a receipt locator, never permission to execute again.
    const lookupInside = Effect.fn("ProjectTeamPiOperations.lookupInside")(function* (
      identity: { readonly providerInstanceId: ProviderInstanceId; readonly threadId: ThreadId },
      request: PiManagedOperationRequest,
      requestHash: string,
      resourceHash: string,
      historical = false,
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
      const retainedReview = yield* assertReviewAllocation(binding, allocation);
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
        accounting_mode: string;
        unknown_maximum_tokens: number | null;
      }>`SELECT * FROM project_team_model_request WHERE operation_id=${row.operation_id}
        AND request_lane='pi' AND request_scope='' LIMIT 257`;
      const memoryLedger = yield* auditProjectMemoryOperationLedger(sql, {
        environmentId: row.environment_id,
        projectId: row.project_id,
        bindingId: row.binding_id,
        generation: row.generation,
        operationId: row.operation_id,
      });
      if (!memoryLedger.settled)
        return yield* deny(
          "Stable Pi operation has active or quarantined memory transport",
          "uncertain",
        );
      if (requests.length !== terminal.accountingReceipts.length || requests.length > 256)
        return yield* deny("Stable Pi accounting receipt incomplete", "uncertain");
      const reservations = new Set<string>();
      const accountingReceipts = new Set<string>();
      const requestIds = new Set<number>();
      let chargedTokens = 0;
      for (const receipt of terminal.accountingReceipts) {
        const requestRow = requests.find((entry) => entry.reservation_id === receipt.reservationId);
        if (requestRow?.accounting_mode === "openai-subscription-monitored") {
          const rootBudgets = yield* sql<{
            maximum_tokens: number;
            deadline_at_ms: number;
          }>`SELECT maximum_tokens,deadline_at_ms
            FROM project_team_model_budget WHERE environment_id=${requestRow.environment_id}
            AND project_id=${requestRow.project_id} AND root_task_id=${requestRow.root_task_id}`;
          const grants = yield* sql<{
            model: string;
            route_id: string;
            maximum_tokens: number;
            maximum_duration_ms: number;
            deadline_at_ms: number;
            stopped_at_ms: number | null;
          }>`SELECT model,route_id,maximum_tokens,maximum_duration_ms,deadline_at_ms,stopped_at_ms
            FROM project_team_pi_subscription_grant WHERE environment_id=${requestRow.environment_id}
            AND project_id=${requestRow.project_id} AND root_task_id=${requestRow.root_task_id}`;
          const grant = grants[0];
          if (
            !grant ||
            grant.model !== "gpt-6-luna" ||
            grant.route_id !== "openai-subscription-luna" ||
            grant.maximum_tokens !== 64_000 ||
            grant.maximum_duration_ms !== 300_000 ||
            rootBudgets.length !== 1 ||
            !rootBudgets[0] ||
            rootBudgets[0].maximum_tokens > 64_000 ||
            grant.deadline_at_ms !== rootBudgets[0]?.deadline_at_ms ||
            requestRow.unknown_maximum_tokens !== 64_000
          )
            return yield* deny("Stable subscription grant differs", "uncertain");
        }
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
          !isPiBrokerManagedModel(binding.model) ||
          (requestRow.accounting_mode === "openai-subscription-monitored") !==
            (binding.model === "gpt-6-luna" && receipt.provider === "openai-codex") ||
          requestRow.route_id !== piBrokerModelRouteFor(binding.model).routeId ||
          receipt.routeId !== requestRow.route_id ||
          requestRow.provider !== receipt.provider ||
          requestRow.model !== binding.model ||
          requestRow.unknown_maximum_tokens !==
            (requestRow.accounting_mode === "openai-subscription-monitored" ? 64_000 : null) ||
          receipt.model !== binding.model ||
          !piBrokerModelRouteFor(binding.model).acceptedReportedModels.some(
            (model) => model === receipt.reportedModel,
          ) ||
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
          (requestRow.accounting_mode !== "openai-subscription-monitored" &&
            (receipt.usage.prompt_tokens > requestRow.maximum_input_tokens ||
              receipt.usage.completion_tokens > requestRow.maximum_output_tokens)) ||
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
          ...(requestRow.accounting_mode === "openai-subscription-monitored"
            ? { accountingMode: "openai-subscription-monitored", unknownMaximumTokens: 64_000 }
            : {}),
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
              ...(requestRow.accounting_mode === "openai-subscription-monitored"
                ? { accountingMode: "openai-subscription-monitored", unknownMaximumTokens: 64_000 }
                : {}),
            }) ||
          receipt.usage.total_tokens !==
            receipt.usage.prompt_tokens + receipt.usage.completion_tokens ||
          requestRow.charged_input_tokens !== receipt.usage.prompt_tokens ||
          requestRow.charged_output_tokens !== receipt.usage.completion_tokens
        )
          return yield* deny("Stable Pi accounting evidence differs", "uncertain");
        // Released calls consume actual usage, not each sequential reservation's ceiling.
        chargedTokens += receipt.usage.total_tokens;
        if (
          !Number.isSafeInteger(chargedTokens) ||
          (chargedTokens > row.maximum_tokens &&
            requestRow.accounting_mode !== "openai-subscription-monitored")
        )
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
      let compactionAnchor: PiCompactionAnchor | undefined;
      let replayHead: PiCompactReplayHead | undefined;
      if (
        !historical &&
        !active.length &&
        latest[0]?.ordinal !== row.operation_ordinal &&
        request.kind === "prompt"
      )
        compactionAnchor = yield* compactBridge(identity, row.operation_id);
      if (
        !historical &&
        !active.length &&
        latest[0]?.ordinal !== row.operation_ordinal &&
        request.kind === "compact"
      )
        replayHead = yield* compactReplayHead(identity, row.operation_id);
      if (
        !historical &&
        (active.length ||
          (latest[0]?.ordinal !== row.operation_ordinal && !compactionAnchor && !replayHead))
      )
        return yield* deny("Stable Pi native receipt has a successor", "conflict");
      yield* current(identity);
      if (retainedReview) yield* assertReviewReplay(authority, allocation, retainedReview);
      yield* clockCheck(row.deadline_at_ms);
      return {
        operation,
        terminal,
        native,
        authority,
        workspace: allocation.launch.workspace,
        nativeState,
        deadlineAtMs: row.deadline_at_ms,
        ...(compactionAnchor === undefined ? {} : { compactionAnchor }),
        ...(replayHead === undefined ? {} : { replayHead }),
      };
    });
    const compactReplayHead: (
      identity: { readonly providerInstanceId: ProviderInstanceId; readonly threadId: ThreadId },
      afterOperationId: string,
    ) => Effect.Effect<PiCompactReplayHead, PiManagedRuntimeError> = (identity, afterOperationId) =>
      guard(
        Effect.gen(function* () {
          const first = yield* getRow(afterOperationId);
          const successors = yield* sql<{
            operation_id: string;
            operation_ordinal: number;
            operation_kind: string;
          }>`SELECT operation_id,operation_ordinal,operation_kind FROM project_team_pi_operation
          WHERE environment_id=${options.environmentId} AND binding_id=${first.binding_id}
          AND generation=${first.generation} AND operation_ordinal>${first.operation_ordinal}
          ORDER BY operation_ordinal LIMIT 129`;
          const latest = yield* sql<{ ordinal: number }>`SELECT MAX(operation_ordinal) AS ordinal
          FROM project_team_pi_operation WHERE environment_id=${options.environmentId}
          AND provider_instance_id=${identity.providerInstanceId} AND thread_id=${identity.threadId}`;
          if (
            !successors.length ||
            successors.length > 128 ||
            successors.at(-1)?.operation_ordinal !== latest[0]?.ordinal
          )
            return yield* deny("Compaction replay successor boundary changed", "conflict");
          let previous = first;
          let head: PiCompactReplayHead | undefined;
          for (const metadata of successors) {
            if (
              metadata.operation_ordinal !== previous.operation_ordinal + 1 ||
              (metadata.operation_kind !== "compact" && metadata.operation_kind !== "prompt")
            )
              return yield* deny("Compaction replay has an unrelated successor", "conflict");
            const row = yield* getRow(metadata.operation_id);
            const intent = yield* decodeReplayIntent(row.intent_json);
            const request = yield* decodeStoredRequest(intent.request);
            if (
              request.kind === "compact" &&
              (!intent.compaction ||
                intent.compaction.predecessorOperationId !== previous.operation_id ||
                intent.compaction.predecessorOrdinal !== previous.operation_ordinal)
            )
              return yield* deny("Compaction replay successor association changed", "uncertain");
            const checked = yield* lookupInside(
              identity,
              request,
              row.request_hash,
              intent.resourceHash,
              true,
            );
            if (!checked)
              return yield* deny("Compaction replay successor receipt missing", "uncertain");
            head = {
              operation: checked.operation,
              native: checked.native,
              nativeState: checked.nativeState,
              resourceHash: intent.resourceHash,
              deadlineAtMs: checked.deadlineAtMs,
            };
            previous = row;
          }
          const active = yield* sql`SELECT operation_id FROM project_team_pi_operation
          WHERE environment_id=${options.environmentId} AND provider_instance_id=${identity.providerInstanceId}
          AND thread_id=${identity.threadId} AND status IN ('prepared','starting','running','quarantine') LIMIT 1`;
          if (active.length || !head)
            return yield* deny(
              "Compaction replay has an active or uncertain successor",
              "uncertain",
            );
          return head;
        }),
      );
    const compactBridge: (
      identity: { readonly providerInstanceId: ProviderInstanceId; readonly threadId: ThreadId },
      afterOperationId: string,
      throughOperationId?: string,
    ) => Effect.Effect<PiCompactionAnchor | undefined, PiManagedRuntimeError> = (
      identity,
      afterOperationId,
      throughOperationId,
    ) =>
      guard(
        Effect.gen(function* () {
          const first = yield* getRow(afterOperationId);
          const last =
            throughOperationId === undefined ? undefined : yield* getRow(throughOperationId);
          const rows = yield* sql<{
            operation_id: string;
            operation_ordinal: number;
            operation_kind: string;
          }>`
          SELECT operation_id,operation_ordinal,operation_kind FROM project_team_pi_operation
          WHERE environment_id=${options.environmentId} AND binding_id=${first.binding_id}
          AND generation=${first.generation} AND operation_ordinal>${first.operation_ordinal}
          ${last === undefined ? sql`` : sql`AND operation_ordinal<=${last.operation_ordinal}`}
          ORDER BY operation_ordinal LIMIT 129`;
          if (
            rows.length > 128 ||
            (last &&
              (last.operation_ordinal <= first.operation_ordinal ||
                rows.at(-1)?.operation_id !== last.operation_id))
          )
            return yield* deny("Compaction chain exceeds its retained boundary", "uncertain");
          if (rows.length === 0) return undefined;
          const firstIntent = yield* decodeReplayIntent(first.intent_json);
          const firstRequest = yield* decodeStoredRequest(firstIntent.request);
          const firstReceipt = yield* lookupInside(
            identity,
            firstRequest,
            first.request_hash,
            firstIntent.resourceHash,
            true,
          );
          if (!firstReceipt || firstRequest.kind !== "prompt")
            return yield* deny(
              "Compaction bridge requires an original successful prompt",
              "uncertain",
            );
          let previous = first;
          let anchor: PiCompactionAnchor | undefined;
          for (const metadata of rows) {
            if (
              metadata.operation_kind !== "compact" ||
              metadata.operation_ordinal !== previous.operation_ordinal + 1
            )
              return yield* deny(
                "A non-compaction operation superseded the native boundary",
                "conflict",
              );
            const row = yield* getRow(metadata.operation_id);
            const intent = yield* decodeReplayIntent(row.intent_json);
            const request = yield* decodeStoredRequest(intent.request);
            if (
              !intent.compaction ||
              intent.compaction.predecessorOperationId !== previous.operation_id ||
              intent.compaction.predecessorOrdinal !== previous.operation_ordinal ||
              request.kind !== "compact"
            )
              return yield* deny("Compaction chain association differs", "uncertain");
            const checked = yield* lookupInside(
              identity,
              request,
              row.request_hash,
              intent.resourceHash,
              true,
            );
            if (!checked) return yield* deny("Compaction chain receipt missing", "uncertain");
            anchor = {
              operationId: row.operation_id,
              operationOrdinal: row.operation_ordinal,
              receiptSha256: digest({
                operation: checked.operation,
                terminal: checked.terminal,
                native: checked.native,
              }),
              native: checked.native,
            };
            previous = row;
          }
          if (throughOperationId === undefined) {
            const active = yield* sql`SELECT operation_id FROM project_team_pi_operation
            WHERE environment_id=${options.environmentId} AND provider_instance_id=${identity.providerInstanceId}
            AND thread_id=${identity.threadId} AND status IN ('prepared','starting','running','quarantine') LIMIT 1`;
            if (active.length)
              return yield* deny("Compaction chain has an active or uncertain owner", "uncertain");
          }
          return anchor;
        }),
      );
    const assertHistoryCapacity = Effect.fn("ProjectTeamPiOperations.historyCapacity")(function* (
      bindingId: string,
      generation: number,
    ) {
      // ExecutionHost can reconcile at most 130 owners for this binding, including compacts.
      const occupied = yield* sql`SELECT 1 AS occupied FROM project_team_pi_operation
        WHERE environment_id=${options.environmentId} AND binding_id=${bindingId} AND generation=${generation}
        LIMIT 130`;
      if (occupied.length >= 130)
        return yield* deny(
          "Pi owned operation history has reached its cleanup bound",
          "unavailable",
        );
    });
    type CallerRow = {
      dispatch_id: string;
      binding_id: string;
      generation: number;
      request_id: MessageId;
      request_json: string;
      predecessor_operation_id: string;
      authority_json: string;
      admission_revision: number;
      claim_generation: number;
      deadline_at_ms: number;
      status: "pending" | "consumed" | "released";
      operation_id: string | null;
    };
    const callerRequest = (request: CompactCallerRequest): CompactCallerRequest => ({
      threadId: request.threadId,
      requestId: request.requestId,
      ...(request.modelSelection === undefined ? {} : { modelSelection: request.modelSelection }),
    });
    const callerRows = (identity: Parameters<typeof current>[0], request: CompactCallerRequest) =>
      sql<CallerRow>`SELECT * FROM project_team_compact_caller
        WHERE environment_id=${options.environmentId} AND provider_instance_id=${identity.providerInstanceId}
        AND thread_id=${identity.threadId} AND request_id=${request.requestId} LIMIT 2`;
    const callerResult = (row: CallerRow, created: boolean): CompactCallerReservation => ({
      dispatchId: row.dispatch_id,
      bindingId: row.binding_id,
      generation: row.generation,
      requestId: row.request_id,
      predecessorOperationId: row.predecessor_operation_id,
      deadlineAtMs: row.deadline_at_ms,
      created,
    });
    const callerAuthority = (
      original: ProjectTeamDispatchSnapshot,
      authority: ProjectTeamAuthority,
    ) =>
      encode({
        intentSha256: digest(original.intent),
        binding: immutableBinding(authority.binding),
        role: authority.role,
      });
    const abandonCompaction = Effect.fn("ProjectTeamPiOperations.abandonCompaction")(function* (
      identity: Parameters<typeof current>[0],
      request: CompactCallerRequest,
    ) {
      yield* ownTransaction();
      if (request.threadId !== identity.threadId)
        return yield* deny("Compact caller thread differs");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* callerRows(identity, request);
          if (rows.length > 1) return yield* deny("Compact caller identity is ambiguous");
          const row = rows[0];
          if (!row) return;
          if (row.request_json !== encode(callerRequest(request)))
            return yield* deny("Compact caller request changed", "conflict");
          if (row.status === "pending")
            yield* sql`UPDATE project_team_compact_caller SET status='released'
          WHERE environment_id=${options.environmentId} AND dispatch_id=${row.dispatch_id}
          AND request_id=${request.requestId} AND status='pending'`;
        }),
      );
      yield* notifyCompactCallerChange;
    });
    // Invalid durable authority can be released by any observer. Readiness errors
    // and waiter interruption do not themselves transfer caller ownership.
    const releaseInvalidCompaction = Effect.fn("ProjectTeamPiOperations.releaseInvalidCompaction")(
      function* (identity: Parameters<typeof current>[0], request: CompactCallerRequest) {
        yield* ownTransaction();
        const released = yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* callerRows(identity, request);
            const caller = rows[0];
            if (
              rows.length !== 1 ||
              !caller ||
              caller.status !== "pending" ||
              request.threadId !== identity.threadId ||
              caller.request_json !== encode(callerRequest(request))
            )
              return false;
            let invalid = (yield* Clock.currentTimeMillis) >= caller.deadline_at_ms;
            if (!invalid) {
              const original = yield* readRetained(caller.dispatch_id);
              const claim = original.intent.compiledClaim.transition;
              if (
                claim?.kind !== "claim" ||
                claim.binding.recordId !== caller.binding_id ||
                claim.binding.generation !== caller.generation ||
                claim.binding.providerInstanceId !== identity.providerInstanceId ||
                claim.binding.threadId !== identity.threadId
              )
                return false;
              const state = yield* readCurrentState(sql, claim.binding.projectId);
              const records = state.foundationRecords ?? [];
              const bindings = records.filter((record) => record.recordId === caller.binding_id);
              const roles = records.filter(
                (record) => record.recordId === claim.binding.roleRevisionId,
              );
              const members = records.filter(
                (record) => record.recordId === claim.binding.memberId,
              );
              if (bindings.length !== 1 || roles.length !== 1 || members.length !== 1) return false;
              // Checkpoints intentionally tolerate unknown statuses. Invalidation
              // needs strict, unique, related records before interpreting a status.
              const { binding, role, member } = yield* decodeCompactAuthorityRecords({
                binding: bindings[0],
                role: roles[0],
                member: members[0],
              });
              if (
                binding.projectId !== claim.binding.projectId ||
                binding.environmentId !== options.environmentId ||
                binding.providerInstanceId !== identity.providerInstanceId ||
                binding.threadId !== identity.threadId ||
                binding.roleRevisionId !== role.recordId ||
                binding.memberId !== member.recordId ||
                member.roleRevisionId !== role.recordId ||
                role.projectId !== binding.projectId ||
                member.projectId !== binding.projectId
              )
                return false;
              const authority = yield* current(identity).pipe(Effect.result);
              if (authority._tag === "Failure") {
                // Failed discovery grants nothing. Only validated durable changes
                // below can release; error classes and messages supply no proof.
                invalid =
                  binding.status !== "running" ||
                  member.status !== "active" ||
                  immutableBinding(binding) !== immutableBinding(claim.binding) ||
                  caller.authority_json !==
                    encode({
                      intentSha256: digest(original.intent),
                      binding: immutableBinding(binding),
                      role,
                    });
              } else {
                const latest = yield* sql<{
                  operation_id: string;
                }>`SELECT operation_id FROM project_team_pi_operation
                  WHERE environment_id=${options.environmentId} AND binding_id=${caller.binding_id}
                  AND generation=${caller.generation} ORDER BY operation_ordinal DESC LIMIT 1`;
                invalid =
                  caller.binding_id !== authority.success.binding.recordId ||
                  caller.generation !== authority.success.binding.generation ||
                  caller.authority_json !== callerAuthority(original, authority.success) ||
                  caller.claim_generation !== original.fence.claimGeneration ||
                  (caller.admission_revision !== original.fence.revision &&
                    caller.admission_revision + 1 !== original.fence.revision) ||
                  (original.fence.stage !== "assignment-intent" &&
                    original.fence.stage !== "assignment-observed") ||
                  latest[0]?.operation_id !== caller.predecessor_operation_id;
              }
            }
            if (!invalid) return false;
            const changed = yield* sql`UPDATE project_team_compact_caller SET status='released'
          WHERE environment_id=${options.environmentId} AND dispatch_id=${caller.dispatch_id}
          AND request_id=${request.requestId} AND status='pending' RETURNING request_id`;
            return changed.length === 1;
          }),
        );
        if (released) yield* notifyCompactCallerChange;
      },
    );
    const reserveCompaction = Effect.fn("ProjectTeamPiOperations.reserveCompaction")(function* (
      identity: Parameters<typeof current>[0],
      supplied: CompactCallerRequest,
    ) {
      yield* ownTransaction();
      const request = callerRequest(supplied);
      yield* decodeCompactMessageId(request.requestId);
      if (request.threadId !== identity.threadId)
        return yield* deny("Compact caller thread differs");
      const result = yield* withCompactionPermit(
        identity,
        sql.withTransaction(
          Effect.gen(function* () {
            const authority = yield* current(identity);
            if (
              request.modelSelection !== undefined &&
              (request.modelSelection.instanceId !== identity.providerInstanceId ||
                request.modelSelection.model !== authority.binding.model)
            )
              return yield* deny("Compact caller model differs");
            const rows = yield* sql<{
              dispatch_id: string;
              cleanup_claim_revision: number | null;
            }>`SELECT dispatch_id,cleanup_claim_revision
          FROM project_team_dispatch WHERE environment_id=${options.environmentId}
          AND binding_id=${authority.binding.recordId} AND generation=${authority.binding.generation} LIMIT 2`;
            if (rows.length !== 1 || !rows[0])
              return yield* deny("Compact caller requires one original dispatch");
            const original = yield* inspectDispatch(rows[0].dispatch_id, { requireClaim: true });
            const transition = original.intent.compiledClaim.transition;
            if (
              transition?.kind !== "claim" ||
              immutableBinding(transition.binding) !== immutableBinding(authority.binding) ||
              (original.fence.stage !== "assignment-intent" &&
                original.fence.stage !== "assignment-observed")
            )
              return yield* deny("Compact caller requires its original assignment");
            const existing = yield* callerRows(identity, request);
            if (existing.length > 1) return yield* deny("Compact caller identity is ambiguous");
            const saved = existing[0];
            if (saved) {
              if (
                saved.binding_id !== authority.binding.recordId ||
                saved.generation !== authority.binding.generation ||
                saved.request_json !== encode(request) ||
                saved.authority_json !== callerAuthority(original, authority) ||
                saved.claim_generation !== original.fence.claimGeneration ||
                saved.status === "released"
              )
                return yield* deny("Compact caller reservation changed or released", "conflict");
              yield* clockCheck(saved.deadline_at_ms);
              return callerResult(saved, false);
            }
            if (rows[0].cleanup_claim_revision !== null)
              return yield* deny("Original dispatch has claimed cleanup", "conflict");
            yield* assertHistoryCapacity(authority.binding.recordId, authority.binding.generation);
            const pending =
              yield* sql`SELECT 1 FROM project_team_compact_caller WHERE environment_id=${options.environmentId}
          AND binding_id=${authority.binding.recordId} AND generation=${authority.binding.generation} AND status='pending' LIMIT 1`;
            if (pending.length)
              return yield* deny("Another compact caller owns this assignment", "conflict");
            const predecessors = yield* sql<Row>`SELECT * FROM project_team_pi_operation
          WHERE environment_id=${options.environmentId} AND binding_id=${authority.binding.recordId}
          AND generation=${authority.binding.generation} ORDER BY operation_ordinal DESC LIMIT 1`;
            const predecessor = predecessors[0];
            if (
              !predecessor ||
              (predecessor.operation_kind !== "prompt" &&
                predecessor.operation_kind !== "compact") ||
              predecessor.status === "quarantine"
            )
              return yield* deny("Compact caller predecessor unavailable");
            if (
              original.fence.stage === "assignment-observed" ||
              predecessor.status === "settled"
            ) {
              const intent = yield* decodeReplayIntent(predecessor.intent_json);
              const checked = yield* lookupInside(
                identity,
                yield* decodeStoredRequest(intent.request),
                predecessor.request_hash,
                intent.resourceHash,
              );
              if (!checked) return yield* deny("Compact caller predecessor receipt unavailable");
            }
            const root = yield* roots(authority);
            yield* operationBudget(authority, root, predecessor);
            const deadline = Math.min(
              predecessor.deadline_at_ms,
              original.intent.limits.deadlineAtMs,
              original.intent.limits.rootDeadlineAtMs,
              root.deadlineAtMs,
            );
            yield* clockCheck(deadline);
            const inserted = yield* sql<CallerRow>`INSERT INTO project_team_compact_caller
          (environment_id,dispatch_id,binding_id,generation,provider_instance_id,thread_id,request_id,request_json,
          predecessor_operation_id,authority_json,admission_revision,claim_generation,deadline_at_ms,status)
          VALUES (${options.environmentId},${original.fence.dispatchId},${authority.binding.recordId},${authority.binding.generation},
          ${identity.providerInstanceId},${identity.threadId},${request.requestId},${encode(request)},${predecessor.operation_id},
          ${callerAuthority(original, authority)},${original.fence.revision},${original.fence.claimGeneration},${deadline},'pending') RETURNING *`;
            if (!inserted[0]) return yield* deny("Compact caller admission lost", "conflict");
            return callerResult(inserted[0], true);
          }),
        ),
      ).pipe(
        Effect.catch((error) =>
          releaseInvalidCompaction(identity, request).pipe(
            Effect.ignore,
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
      yield* notifyCompactCallerChange;
      return result;
    });
    const compactInside = Effect.fn("ProjectTeamPiOperations.compactInside")(function* (
      identity: { readonly providerInstanceId: ProviderInstanceId; readonly threadId: ThreadId },
      request: PiManagedOperationRequest,
    ) {
      if (request.kind !== "compact" || request.requestId === undefined)
        return yield* deny("Compaction requires its original durable request identity");
      yield* decodeCompactMessageId(request.requestId);
      const authority = yield* current(identity);
      const dispatches = yield* sql<{
        dispatch_id: string;
        cleanup_claim_revision: number | null;
      }>`SELECT dispatch_id,cleanup_claim_revision FROM project_team_dispatch
        WHERE environment_id=${options.environmentId} AND binding_id=${authority.binding.recordId}
        AND generation=${authority.binding.generation} LIMIT 2`;
      if (dispatches.length !== 1 || !dispatches[0])
        return yield* deny("Compaction requires one original dispatch");
      const original = yield* inspectDispatch(dispatches[0].dispatch_id, { requireClaim: true });
      yield* readStageReceipts(original.fence.dispatchId);
      const claim = original.intent.compiledClaim.transition;
      if (
        claim?.kind !== "claim" ||
        immutableBinding(claim.binding) !== immutableBinding(authority.binding) ||
        original.fence.stage !== "assignment-observed" ||
        original.fence.claimGeneration <= 0
      )
        return yield* deny("Compaction requires its approved successful assignment boundary");
      const operationId = compactOperationId(original, authority.binding, request.requestId);
      if (request.operationId !== undefined && request.operationId !== operationId)
        return yield* deny("Compaction operation identity differs", "conflict");
      const saved = yield* sql<{
        operation_id: string;
      }>`SELECT operation_id FROM project_team_pi_operation WHERE operation_id=${operationId}`;
      if (saved.length === 0) {
        if (dispatches[0].cleanup_claim_revision !== null)
          return yield* deny("Original dispatch has claimed cleanup", "conflict");
        yield* assertHistoryCapacity(authority.binding.recordId, authority.binding.generation);
      }
      const rows = yield* sql<{
        operation_id: string;
      }>`SELECT operation_id FROM project_team_pi_operation
        WHERE environment_id=${options.environmentId} AND binding_id=${authority.binding.recordId}
        AND generation=${authority.binding.generation} ORDER BY operation_ordinal DESC LIMIT 1`;
      const callers = yield* callerRows(
        identity,
        callerRequest({ ...request, requestId: request.requestId }),
      );
      if (callers.length > 1) return yield* deny("Compact caller identity is ambiguous");
      const caller = callers[0];
      if (!saved.length) {
        if (
          !caller ||
          caller.status !== "pending" ||
          caller.request_json !==
            encode(callerRequest({ ...request, requestId: request.requestId })) ||
          caller.authority_json !== callerAuthority(original, authority) ||
          caller.claim_generation !== original.fence.claimGeneration ||
          (caller.admission_revision !== original.fence.revision &&
            caller.admission_revision + 1 !== original.fence.revision) ||
          caller.predecessor_operation_id !== rows[0]?.operation_id
        )
          return yield* deny(
            "Compaction requires its exact pending caller and predecessor",
            "conflict",
          );
        yield* clockCheck(caller.deadline_at_ms);
      }
      const selectedId = saved[0]?.operation_id ?? caller?.predecessor_operation_id;
      if (!selectedId) return yield* deny("Compaction predecessor unavailable");
      const row = yield* getRow(selectedId);
      const intent = yield* decodeReplayIntent(row.intent_json);
      const storedRequest = yield* decodeStoredRequest(intent.request);
      if (storedRequest.kind !== "prompt" && storedRequest.kind !== "compact")
        return yield* deny("Compaction requires a successful task operation");
      const checked = yield* lookupInside(
        identity,
        storedRequest,
        row.request_hash,
        intent.resourceHash,
      );
      if (!checked) return yield* deny("Compaction predecessor receipt unavailable");
      if (saved.length && (!intent.compaction || intent.compaction.requestId !== request.requestId))
        return yield* deny("Original compaction association unavailable", "uncertain");
      if (saved.length && requestDigest({ ...request, operationId }) !== row.request_hash)
        return yield* deny("Original compaction request changed", "conflict");
      return {
        operationId,
        original,
        caller,
        predecessor: {
          operationId: row.operation_id,
          ordinal: row.operation_ordinal,
          receiptSha256: digest({
            operation: checked.operation,
            terminal: checked.terminal,
            native: checked.native,
          }),
          resourceHash: intent.resourceHash,
        },
        ...(saved.length && intent.compaction ? { association: intent.compaction } : {}),
      };
    });
    const associateCompaction = (
      boundary: Effect.Success<ReturnType<typeof compactInside>>,
      requestId: MessageId,
      context: { readonly provenanceSha256: string; readonly textSha256: string },
    ) =>
      decodeCompactAssociation({
        version: 1,
        requestId,
        dispatchId: boundary.original.fence.dispatchId,
        dispatchIntentSha256: digest(boundary.original.intent),
        claimGeneration: boundary.original.fence.claimGeneration,
        fenceRevision: boundary.original.fence.revision,
        predecessorOperationId: boundary.predecessor.operationId,
        predecessorOrdinal: boundary.predecessor.ordinal,
        predecessorReceiptSha256: boundary.predecessor.receiptSha256,
        contextProvenanceSha256: context.provenanceSha256,
        contextTextSha256: context.textSha256,
      });
    const withCompactionPermit = <A, E, R>(
      identity: Parameters<typeof current>[0],
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const targets = yield* sql<{ manifest_json: string | null; sha256: string }>`SELECT
          CASE WHEN length(CAST(t.manifest_json AS BLOB))<=65536 THEN t.manifest_json END AS manifest_json,t.sha256
          FROM project_team_review_target t JOIN project_team_run_binding b ON b.record_id=t.binding_id
          JOIN project_team_dispatch d ON d.binding_id=t.binding_id AND d.generation=t.generation AND d.environment_id=t.environment_id
          WHERE t.environment_id=${options.environmentId} AND json_extract(b.payload_json,'$.providerInstanceId')=${identity.providerInstanceId}
          AND json_extract(b.payload_json,'$.threadId')=${identity.threadId} LIMIT 2`;
        if (!targets.length) return yield* effect;
        if (
          targets.length !== 1 ||
          typeof targets[0]?.manifest_json !== "string" ||
          Option.isNone(workflow)
        )
          return yield* deny("Stable review target repository is unavailable");
        const target = yield* decodeAllocationReviewTarget(targets[0].manifest_json);
        if (
          encode(target) !== targets[0].manifest_json ||
          digest(target) !== targets[0].sha256 ||
          target.environmentId !== options.environmentId
        )
          return yield* deny("Stable review target repository changed", "conflict");
        return yield* workflow.value.withRepositoryPermit(
          "review.replay",
          target.prepared.manifest.target.repository,
          effect,
        );
      });
    const readCompaction = Effect.fn("ProjectTeamPiOperations.readCompaction")(function* (
      identity: { readonly providerInstanceId: ProviderInstanceId; readonly threadId: ThreadId },
      request: PiManagedOperationRequest,
    ) {
      yield* ownTransaction();
      return yield* withCompactionPermit(
        identity,
        sql.withTransaction(compactInside(identity, request)),
      );
    });
    const assertCompactionReady = Effect.fn("ProjectTeamPiOperations.assertCompactionReady")(
      function* (identity: Parameters<typeof current>[0], request: CompactCallerRequest) {
        yield* ownTransaction();
        // Subscribe before the first SQL read, so observation committed between the
        // read and pull remains queued. No permit, SQL loan or assets survive a pull.
        const hints = yield* subscribeCompactCallerChanges;
        const bus = yield* Effect.serviceOption(ProjectWorkEventBus);
        const controls = Option.isSome(bus) ? yield* bus.value.subscribe : Stream.empty;
        const pull = yield* Stream.toPull(
          Stream.merge(hints, controls.pipe(Stream.map(() => undefined))),
        );
        return yield* Effect.gen(function* () {
          for (;;) {
            const checked = yield* withCompactionPermit(
              identity,
              sql.withTransaction(
                Effect.gen(function* () {
                  const authority = yield* current(identity);
                  const rows = yield* callerRows(identity, request);
                  const caller = rows[0];
                  if (
                    rows.length !== 1 ||
                    !caller ||
                    caller.status === "released" ||
                    caller.binding_id !== authority.binding.recordId ||
                    caller.generation !== authority.binding.generation ||
                    caller.request_json !== encode(callerRequest(request))
                  )
                    return yield* deny("Compact caller reservation is unavailable", "conflict");
                  const original = yield* inspectDispatch(caller.dispatch_id, {
                    requireClaim: true,
                  });
                  if (
                    caller.authority_json !== callerAuthority(original, authority) ||
                    caller.claim_generation !== original.fence.claimGeneration ||
                    (caller.admission_revision !== original.fence.revision &&
                      caller.admission_revision + 1 !== original.fence.revision)
                  )
                    return yield* deny("Compact caller authority changed", "conflict");
                  yield* clockCheck(caller.deadline_at_ms);
                  if (original.fence.stage === "assignment-intent" && caller.status === "pending") {
                    const latest = yield* sql<{
                      operation_id: string;
                    }>`SELECT operation_id FROM project_team_pi_operation
                WHERE environment_id=${options.environmentId} AND binding_id=${caller.binding_id}
                AND generation=${caller.generation} ORDER BY operation_ordinal DESC LIMIT 1`;
                    if (latest[0]?.operation_id !== caller.predecessor_operation_id)
                      return yield* deny("Compact caller predecessor changed", "conflict");
                    const predecessor = yield* getRow(caller.predecessor_operation_id);
                    const intent = yield* decodeReplayIntent(predecessor.intent_json);
                    const qualified = yield* lookupInside(
                      identity,
                      yield* decodeStoredRequest(intent.request),
                      predecessor.request_hash,
                      intent.resourceHash,
                    );
                    if (!qualified) return yield* deny("Compact caller predecessor is not ready");
                    return { caller, ready: false };
                  }
                  const boundary = yield* compactInside(identity, {
                    threadId: request.threadId,
                    requestId: request.requestId,
                    kind: "compact",
                    ...(request.modelSelection === undefined
                      ? {}
                      : { modelSelection: request.modelSelection }),
                  });
                  if (!boundary.caller)
                    return yield* deny("Compact caller reservation is unavailable");
                  return { caller, ready: true };
                }),
              ),
            );
            if (checked.ready) return callerResult(checked.caller, false);
            const remaining = checked.caller.deadline_at_ms - (yield* Clock.currentTimeMillis);
            if (remaining <= 0) return yield* deny("Pi operation deadline expired");
            yield* pull.pipe(
              Effect.timeoutOrElse({
                duration: remaining,
                orElse: () => Effect.fail(deny("Pi operation deadline expired")),
              }),
            );
          }
        }).pipe(
          Effect.catch((error) =>
            releaseInvalidCompaction(identity, request).pipe(
              Effect.ignore,
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
      },
      Effect.scoped,
    );
    const lookup = Effect.fn("ProjectTeamPiOperations.lookup")(function* (
      identity: Parameters<typeof lookupInside>[0],
      request: PiManagedOperationRequest,
      requestHash: string,
      resourceHash: string,
    ) {
      yield* ownTransaction();
      if (request.operationId === undefined) return undefined;
      // Acquire the repository permit before the SQL loan: workspace writers
      // persist their receipts in the opposite direction, under that permit.
      const targets = yield* sql<{ manifest_json: string | null; sha256: string }>`SELECT
        CASE WHEN length(CAST(t.manifest_json AS BLOB))<=65536 THEN t.manifest_json END AS manifest_json,t.sha256
        FROM project_team_pi_operation p JOIN project_team_review_target t ON t.environment_id=p.environment_id
        AND t.project_id=p.project_id AND t.binding_id=p.binding_id AND t.generation=p.generation
        WHERE p.operation_id=${request.operationId} AND p.environment_id=${options.environmentId}
        AND p.provider_instance_id=${identity.providerInstanceId} AND p.thread_id=${identity.threadId} LIMIT 2`;
      const lookupReceipt = sql.withTransaction(
        lookupInside(identity, request, requestHash, resourceHash),
      );
      if (targets.length === 0) return yield* lookupReceipt;
      if (
        targets.length !== 1 ||
        typeof targets[0]?.manifest_json !== "string" ||
        Option.isNone(workflow)
      )
        return yield* deny("Stable review target repository is unavailable");
      const target = yield* decodeAllocationReviewTarget(targets[0].manifest_json);
      if (
        encode(target) !== targets[0].manifest_json ||
        digest(target) !== targets[0].sha256 ||
        target.environmentId !== options.environmentId
      )
        return yield* deny("Stable review target repository changed", "conflict");
      return yield* workflow.value.withRepositoryPermit(
        "review.replay",
        target.prepared.manifest.target.repository,
        lookupReceipt,
      );
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
    // Inherited transaction readers cannot acquire a repository permit. Their
    // ManagedGit capture still checks the clean target both before and after use.
    const lookupInTransaction = (...args: Parameters<typeof lookup>) => {
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
        readonly compactContext?: {
          readonly provenanceSha256: string;
          readonly textSha256: string;
        };
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
      const result = yield* withCompactionPermit(
        identity,
        sql.withTransaction(
          Effect.gen(function* () {
            const authority = yield* current(identity, request.kind === "initialize");
            const cleanup = yield* sql`SELECT dispatch_id FROM project_team_dispatch
            WHERE environment_id=${options.environmentId} AND binding_id=${authority.binding.recordId}
            AND generation=${authority.binding.generation} AND cleanup_claim_revision IS NOT NULL LIMIT 1`;
            if (cleanup.length)
              return yield* deny("Original dispatch has claimed cleanup", "conflict");
            if (allocation.launch.workspaceRoot !== authority.binding.worktree)
              return yield* deny("Allocated workspace differs from durable assignment");
            yield* assertReviewAllocation(authority.binding, allocation);
            const root = yield* roots(authority);
            yield* clockCheck(root.deadlineAtMs);
            let compaction: typeof CompactAssociation.Type | undefined;
            if (request.kind === "compact") {
              const boundary = yield* compactInside(identity, request);
              if (
                !allocated.compactContext ||
                boundary.association ||
                boundary.operationId !== operationId ||
                resourceHash !== boundary.predecessor.resourceHash
              )
                return yield* deny(
                  "Compaction requires its frozen current context and predecessor",
                );
              compaction = yield* associateCompaction(
                boundary,
                yield* decodeCompactMessageId(request.requestId),
                allocated.compactContext,
              );
            }
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
            yield* assertHistoryCapacity(authority.binding.recordId, authority.binding.generation);
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
              compaction,
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
              ...(compaction === undefined ? {} : { compaction }),
              ...(resourceHash === undefined ? {} : { resourceHash }),
            });
            yield* sql`INSERT INTO project_team_pi_operation (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json) VALUES (${operationId},${options.environmentId},${authority.binding.projectId},${authority.binding.recordId},${authority.binding.generation},${identity.providerInstanceId},${identity.threadId},${workerId},${ordinal},${request.kind},${requestHash},${root.root.recordId},${root.root.taskId},${maximumTokens},${deadlineAtMs},'prepared',${intent})`;
            yield* sql`INSERT INTO project_team_pi_process(unit,operation_id,allocation_json,status) VALUES(${allocation.unit},${operationId},${encode(allocation)},'allocated')`;
            if (request.kind === "compact") {
              const consumed =
                yield* sql`UPDATE project_team_compact_caller SET status='consumed',operation_id=${operationId}
              WHERE environment_id=${options.environmentId} AND binding_id=${authority.binding.recordId}
              AND generation=${authority.binding.generation} AND request_id=${request.requestId} AND status='pending' RETURNING request_id`;
              if (consumed.length !== 1)
                return yield* deny("Compact caller consumption lost", "conflict");
            }
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
        ),
      );
      yield* notifyCompactCallerChange;
      yield* authorize(result);
      return result;
    });
    const persistence = (captured: PiDurableOperation) => ({
      allocation: captured.allocation,
      deadlineAtMs: captured.deadlineAtMs,
      afterDrain: (drain: import("../provider/pi/PiManagedProcess.ts").PiManagedDrain) =>
        sql
          .withTransaction(
            taskResources
              .pi(captured.operation.operationId, captured.allocation)
              .cleanupDrain(drain),
          )
          .pipe(
            Effect.mapError(
              (cause) => new PiManagedProcessError({ phase: "quarantine", message: String(cause) }),
            ),
          ),
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
                yield* taskResources.pi(captured.operation.operationId, allocation).reserve;
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
                yield* taskResources
                  .pi(captured.operation.operationId, captured.allocation)
                  .capture(owner);
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
      publishingCompact = false,
    ) {
      const authority = yield* authorize(captured, settled, publishingCompact);
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
    // A successful compact retains its writer fence until the first caller's final
    // publication transaction. A crash in this gap remains unfinished for reconciliation.
    const publication = Effect.fn("ProjectTeamPiOperations.publication")(function* (
      captured: PiDurableOperation,
      terminal: PiSessionTerminal,
      compactPublication?: {
        readonly resourceHash: string;
        readonly check: (authority: ProjectTeamAuthority) => void;
      },
    ) {
      yield* ownTransaction();
      const publishingCompact = captured.operation.operationKind === "compact";
      if (publishingCompact && !compactPublication)
        return yield* deny("Compact publication requires its final caller fence");
      if (terminal.outcome !== "success" || !terminal.native)
        return yield* deny("Successful native Pi terminal required");
      const native = terminal.native;
      let publicationDeadlineAtMs = captured.deadlineAtMs;
      const validate = Effect.fn("ProjectTeamPiOperations.validatePublication")(function* (
        settled: boolean,
      ) {
        const authority = yield* nativeAuthority(captured, native, settled, publishingCompact);
        const row = yield* getRow(captured.operation.operationId);
        if (
          row.terminal_json !== encode(terminal) ||
          row.operation_kind !== captured.operation.operationKind ||
          row.operation_ordinal !== captured.ordinal
        )
          return yield* deny("Pi terminal publication receipt changed");
        if (publishingCompact) {
          const intent = yield* decodeReplayIntent(row.intent_json);
          const request = yield* decodeStoredRequest(intent.request);
          if (
            request.kind !== "compact" ||
            request.requestId === undefined ||
            !intent.compaction ||
            intent.resourceHash !== compactPublication!.resourceHash ||
            encode(intent.allocation) !== encode(captured.allocation) ||
            row.request_hash !== requestDigest(request)
          )
            return yield* deny("Compact publication resource or request changed");
          const callers = yield* callerRows(
            {
              providerInstanceId: authority.binding.providerInstanceId,
              threadId: authority.binding.threadId,
            },
            { ...request, requestId: request.requestId },
          );
          const caller = callers[0];
          const original = yield* readRetained(intent.compaction.dispatchId);
          const cleanup = yield* sql`SELECT 1 FROM project_team_dispatch
            WHERE dispatch_id=${original.fence.dispatchId} AND cleanup_claim_revision IS NOT NULL`;
          const process = yield* sql<{
            status: string;
            allocation_json: string;
            owner_json: string | null;
            drain_json: string | null;
          }>`
            SELECT status,allocation_json,owner_json,drain_json FROM project_team_pi_process
            WHERE operation_id=${row.operation_id} AND unit=${captured.allocation.unit} LIMIT 2`;
          const owner = process[0]?.owner_json
            ? yield* decodeMemoryProcessOwner(process[0].owner_json)
            : undefined;
          const drain = terminal.drain;
          if (
            !owner ||
            !drain ||
            owner.unit !== captured.allocation.unit ||
            owner.nonce !== captured.allocation.nonce ||
            owner.invocation !== drain.invocation ||
            owner.pid !== drain.ownerPid ||
            owner.cgroup !== drain.cgroup ||
            owner.memoryBytes !== drain.memoryBytes ||
            owner.swapBytes !== drain.swapBytes ||
            owner.oomGroup !== drain.oomGroup ||
            cleanup.length ||
            callers.length !== 1 ||
            !caller ||
            caller.status !== "consumed" ||
            caller.operation_id !== row.operation_id ||
            caller.dispatch_id !== original.fence.dispatchId ||
            caller.binding_id !== row.binding_id ||
            caller.generation !== row.generation ||
            caller.predecessor_operation_id !== intent.compaction.predecessorOperationId ||
            caller.request_json !==
              encode(callerRequest({ ...request, requestId: request.requestId })) ||
            caller.authority_json !== callerAuthority(original, authority) ||
            caller.claim_generation !== original.fence.claimGeneration ||
            (caller.admission_revision !== original.fence.revision &&
              caller.admission_revision + 1 !== original.fence.revision) ||
            process.length !== 1 ||
            process[0]?.status !== "drained" ||
            process[0]?.allocation_json !== encode(captured.allocation) ||
            process[0]?.drain_json !== encode(terminal.drain)
          )
            return yield* deny("Compact publication owner or drain changed");
          publicationDeadlineAtMs = Math.min(publicationDeadlineAtMs, caller.deadline_at_ms);
          yield* clockCheck(caller.deadline_at_ms);
        }
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
      if (!publishingCompact) {
        yield* sql.withTransaction(validate(true));
        return yield* validate(true);
      }
      // Keep commit and its wake in one interruption mask; the transaction body
      // stays interruptible and rolls back if the caller is canceled before publication.
      return yield* Effect.uninterruptibleMask((restore) =>
        sql
          .withTransaction(
            restore(
              Effect.gen(function* () {
                yield* validate(false);
                const changed = yield* sql`UPDATE project_team_pi_operation SET status='settled'
          WHERE operation_id=${captured.operation.operationId} AND status='running'
          AND terminal_json=${encode(terminal)} RETURNING operation_id`;
                if (changed.length !== 1)
                  return yield* deny("Compact publication already released", "conflict");
                const current = yield* validate(true);
                yield* Effect.try({
                  try: () => {
                    compactPublication!.check(current);
                    if (clock.currentTimeMillisUnsafe() >= publicationDeadlineAtMs)
                      throw deny("Pi operation deadline expired");
                  },
                  catch: (error) =>
                    isRuntimeError(error)
                      ? error
                      : deny("Compact final caller fence changed", "conflict"),
                });
                return current;
              }),
            ),
          )
          .pipe(Effect.tap(() => notifyCompactCallerChange)),
      );
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
          if (row.status === "settled" || row.status === "quarantine" || row.terminal_json !== null)
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
            environment_id: string;
            project_id: string;
            root_task_id: string;
            run_id: string;
            attempt_id: string;
            worker_id: string;
            generation: number;
            operation_id: string;
            request_id: number;
            reservation_id: string;
            accounting_receipt_id: string | null;
            status: string;
            capacity_state: string;
            route_id: string;
            provider: string;
            model: string;
            maximum_input_tokens: number;
            maximum_output_tokens: number;
            deadline_at_ms: number;
            accounting_mode: string;
            unknown_maximum_tokens: number | null;
            charged_input_tokens: number;
            charged_output_tokens: number;
            reservation_json: string;
            settlement_json: string | null;
          }>`SELECT * FROM project_team_model_request WHERE worker_id=${captured.workerId} AND operation_id=${row.operation_id} AND generation=${row.generation}
            AND request_lane='pi' AND request_scope=''`;
          const memoryLedger = yield* auditProjectMemoryOperationLedger(sql, {
            environmentId: row.environment_id,
            projectId: row.project_id,
            bindingId: row.binding_id,
            generation: row.generation,
            operationId: row.operation_id,
          });
          const receipts = new Set<string>();
          for (const receipt of terminal.accountingReceipts) {
            const request = requests.find(
              (request) => request.reservation_id === receipt.reservationId,
            );
            if (request?.accounting_mode === "openai-subscription-monitored") {
              const budgets = yield* sql<{
                maximum_tokens: number;
                deadline_at_ms: number;
              }>`SELECT maximum_tokens,deadline_at_ms
                FROM project_team_model_budget WHERE environment_id=${request.environment_id}
                AND project_id=${request.project_id} AND root_task_id=${request.root_task_id}`;
              const grants = yield* sql<{
                model: string;
                route_id: string;
                maximum_tokens: number;
                maximum_duration_ms: number;
                deadline_at_ms: number;
              }>`SELECT model,route_id,maximum_tokens,maximum_duration_ms,deadline_at_ms
                FROM project_team_pi_subscription_grant WHERE environment_id=${request.environment_id}
                AND project_id=${request.project_id} AND root_task_id=${request.root_task_id}`;
              const grant = grants[0];
              if (
                !grant ||
                budgets.length !== 1 ||
                !budgets[0] ||
                budgets[0].maximum_tokens > 64_000 ||
                grant.model !== "gpt-6-luna" ||
                grant.route_id !== "openai-subscription-luna" ||
                grant.maximum_tokens !== 64_000 ||
                grant.maximum_duration_ms !== 300_000 ||
                grant.deadline_at_ms !== budgets[0]?.deadline_at_ms ||
                request.unknown_maximum_tokens !== 64_000
              )
                return yield* deny("Pi subscription terminal grant differs", "uncertain");
            }
            if (
              !request ||
              request.status !== "reported" ||
              receipts.has(receipt.reservationId) ||
              request.accounting_receipt_id !== receipt.accountingReceiptId ||
              request.request_id !== receipt.requestId ||
              request.environment_id !== options.environmentId ||
              request.project_id !== row.project_id ||
              request.root_task_id !== row.root_task_id ||
              request.run_id !== captured.authority.binding.recordId ||
              request.attempt_id !== captured.authority.binding.attemptId ||
              request.route_id !== receipt.routeId ||
              request.provider !== receipt.provider ||
              request.model !== receipt.model ||
              request.accounting_mode !==
                (receipt.provider === "openai-codex" ? "openai-subscription-monitored" : "hard") ||
              !isPiBrokerManagedModel(captured.authority.binding.model) ||
              request.model !== captured.authority.binding.model ||
              request.route_id !==
                piBrokerModelRouteFor(captured.authority.binding.model).routeId ||
              !piBrokerModelRouteFor(captured.authority.binding.model).acceptedReportedModels.some(
                (model) => model === receipt.reportedModel,
              ) ||
              request.unknown_maximum_tokens !==
                (request.accounting_mode === "openai-subscription-monitored" ? 64_000 : null) ||
              (request.accounting_mode === "openai-subscription-monitored"
                ? receipt.model !== "gpt-6-luna" ||
                  receipt.routeId !== "openai-subscription-luna" ||
                  receipt.reportedModel !== "gpt-6-luna"
                : request.maximum_input_tokens < receipt.usage.prompt_tokens ||
                  request.maximum_output_tokens < receipt.usage.completion_tokens) ||
              receipt.usage.total_tokens !==
                receipt.usage.prompt_tokens + receipt.usage.completion_tokens ||
              request.charged_input_tokens !== receipt.usage.prompt_tokens ||
              request.charged_output_tokens !== receipt.usage.completion_tokens ||
              request.capacity_state !== "released" ||
              !request.settlement_json
            )
              return yield* deny("Pi accounting receipt mismatch", "uncertain");
            const reservationFields = {
              workerId: request.worker_id,
              generation: request.generation,
              operationId: request.operation_id,
              requestId: request.request_id,
              routeId: request.route_id,
              provider: request.provider,
              model: request.model,
              maxInputTokens: request.maximum_input_tokens,
              maxOutputTokens: request.maximum_output_tokens,
              callCount: 1,
              deadlineAtMs: request.deadline_at_ms,
              ...(request.accounting_mode === "openai-subscription-monitored"
                ? { accountingMode: "openai-subscription-monitored", unknownMaximumTokens: 64_000 }
                : {}),
            };
            const savedReservation = yield* decodeJson(request.reservation_json).pipe(
              Effect.mapError(() => deny("Pi terminal reservation is malformed", "uncertain")),
            );
            const savedSettlement = yield* decodeJson(request.settlement_json).pipe(
              Effect.mapError(() => deny("Pi terminal settlement is malformed", "uncertain")),
            );
            if (
              canonicalProjectWorkPayload(savedReservation) !==
                canonicalProjectWorkPayload(reservationFields) ||
              canonicalProjectWorkPayload(savedSettlement) !==
                canonicalProjectWorkPayload({
                  ...reservationFields,
                  reservationId: receipt.reservationId,
                  outcome: "reported",
                  transportDrained: true,
                  chargedInputTokens: request.charged_input_tokens,
                  chargedOutputTokens: request.charged_output_tokens,
                  reportedModel: receipt.reportedModel,
                  reportedUsage: receipt.usage,
                })
            )
              return yield* deny("Pi terminal usage journal differs from its receipt", "uncertain");
            receipts.add(receipt.reservationId);
          }
          const pendingAccounting =
            requests.some(
              (request) => request.status === "reserved" || !request.accounting_receipt_id,
            ) || !memoryLedger.settled;
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
          if (drain)
            yield* taskResources
              .pi(captured.operation.operationId, captured.allocation)
              .cleanupDrain(drain);
          yield* sql`UPDATE project_team_pi_process SET status=${uncertain ? "quarantine" : "drained"},drain_json=${drain ? encode(drain) : null} WHERE operation_id=${row.operation_id}`;
          // Clock and authority are sampled after the final SQL write receipt while still in the transaction.
          yield* sql`UPDATE project_team_pi_operation SET terminal_json=${encode(terminal)} WHERE operation_id=${row.operation_id}`;
          if (terminal.outcome === "success") yield* authorize(captured, false, true);
          const awaitingPublication =
            row.operation_kind === "compact" && terminal.outcome === "success";
          yield* sql`UPDATE project_team_pi_operation SET status=${uncertain ? "quarantine" : awaitingPublication ? "running" : "settled"} WHERE operation_id=${row.operation_id}`;
          if (terminal.outcome === "success") {
            yield* clockCheck(captured.deadlineAtMs);
            yield* current({
              providerInstanceId: captured.authority.binding.providerInstanceId,
              threadId: captured.authority.binding.threadId,
            });
          }
          if (terminal.outcome !== "success" || uncertain)
            yield* sql`UPDATE project_team_compact_caller SET status='released'
              WHERE environment_id=${options.environmentId} AND binding_id=${row.binding_id}
              AND generation=${row.generation} AND predecessor_operation_id=${row.operation_id} AND status='pending'`;
          return uncertain ? ("uncertain" as const) : ("drained" as const);
        }),
      );
      yield* notifyCompactCallerChange;
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
    /** Fresh initialization is a read-only classification of untouched original dispatch ownership. */
    const sessionForStart = Effect.fn("ProjectTeamPiOperations.sessionForStart")(
      function* (identity: {
        readonly providerInstanceId: ProviderInstanceId;
        readonly threadId: ThreadId;
      }) {
        yield* ownTransaction();
        const initial = yield* inspectProjectTeamSessionAuthority(authorization, identity);
        if (
          !initial ||
          initial.binding.environmentId !== options.environmentId ||
          !isPiBrokerManagedModel(initial.binding.model)
        )
          return yield* deny("Current managed Pi binding required");
        if (initial.binding.status === "running") {
          yield* nativeFor(identity);
          return { kind: "existing" as const };
        }
        const sameAuthority = Effect.gen(function* () {
          const authority = yield* inspectProjectTeamSessionAuthority(authorization, identity);
          if (
            !authority ||
            encode(authority.binding) !== encode(initial.binding) ||
            encode(authority.role) !== encode(initial.role) ||
            authority.binding.status !== "reserved" ||
            authority.binding.sessionId !== undefined
          )
            return yield* deny("Fresh Pi start authority changed");
          return authority;
        });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const authority = yield* sameAuthority;
            const binding = authority.binding;
            const history = yield* sql`SELECT operation_id FROM project_team_pi_operation
          WHERE environment_id=${options.environmentId} AND binding_id=${binding.recordId} AND generation=${binding.generation} LIMIT 1`;
            if (history.length)
              return yield* deny(
                "Reserved Pi initialization history belongs to original recovery",
                "conflict",
              );
            const owners = yield* sql`SELECT operation_id FROM project_team_pi_operation
          WHERE environment_id=${options.environmentId} AND provider_instance_id=${identity.providerInstanceId} AND thread_id=${identity.threadId}
          AND status <> 'settled' LIMIT 1`;
            const processes =
              yield* sql`SELECT p.unit FROM project_team_pi_process p JOIN project_team_pi_operation o ON o.operation_id=p.operation_id
          WHERE o.environment_id=${options.environmentId} AND o.provider_instance_id=${identity.providerInstanceId} AND o.thread_id=${identity.threadId}
          AND p.status <> 'drained' LIMIT 1`;
            if (owners.length || processes.length)
              return yield* deny("Fresh Pi start has an active or uncertain owner", "uncertain");
            const dispatches = yield* sql<{
              dispatch_id: string;
            }>`SELECT dispatch_id FROM project_team_dispatch
          WHERE environment_id=${options.environmentId} AND binding_id=${binding.recordId} AND generation=${binding.generation} LIMIT 2`;
            if (dispatches.length !== 1 || !dispatches[0])
              return yield* deny("Fresh Pi start requires one original dispatch");
            const snapshot = yield* inspectDispatch(dispatches[0].dispatch_id, {
              requireClaim: true,
            });
            yield* readStageReceipts(snapshot.fence.dispatchId);
            const claim = snapshot.intent.compiledClaim.transition;
            if (
              snapshot.fence.stage !== "setup-complete" ||
              snapshot.fence.claimGeneration < 1 ||
              claim?.kind !== "claim" ||
              immutableBinding(claim.binding) !== immutableBinding(binding) ||
              claim.binding.status !== "reserved" ||
              claim.binding.sessionId !== undefined
            )
              return yield* deny("Fresh Pi start requires its exact setup-complete original claim");
            const root = yield* roots(authority);
            const budgets = yield* sql<{
              maximum_tokens: number;
              deadline_at_ms: number;
            }>`SELECT maximum_tokens,deadline_at_ms
          FROM project_team_model_budget WHERE environment_id=${options.environmentId} AND project_id=${binding.projectId} AND root_task_id=${root.rootTaskId} LIMIT 2`;
            if (
              snapshot.intent.limits.rootTaskId !== root.rootTaskId ||
              budgets.length !== 1 ||
              budgets[0]?.maximum_tokens !== snapshot.intent.limits.maximumTokens ||
              budgets[0]?.deadline_at_ms !== snapshot.intent.limits.rootDeadlineAtMs
            )
              return yield* deny("Fresh Pi start original root budget changed");
            yield* clockCheck(
              Math.min(
                root.deadlineAtMs,
                snapshot.intent.limits.deadlineAtMs,
                snapshot.intent.limits.rootDeadlineAtMs,
              ),
            );
            yield* sameAuthority;
          }),
        );
        yield* sameAuthority;
        return { kind: "fresh" as const };
      },
    );
    const readMemoryOperationOwnerInTransaction = Effect.fn(
      "ProjectTeamPiOperations.readMemoryOperationOwnerInTransaction",
    )(function* (
      supplied: typeof ProjectMemoryOperationIdentity.Type,
      principal: ProjectTeamPrincipal,
    ) {
      const client = yield* Effect.serviceOption(SqlClient.SqlClient);
      const suppliedRepository = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(client) ||
        client.value !== sql ||
        Option.isNone(suppliedRepository) ||
        suppliedRepository.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Memory owner requires the captured SQL, repository and transaction");
      const identity = yield* decodeMemoryIdentity(supplied);
      const authority = yield* authorization.resolve(principal);
      if (
        authority === undefined ||
        authority.role.memoryAccess === "none" ||
        authority.binding.status !== "running" ||
        !authority.binding.sessionId ||
        !authority.role.tools.includes("project-work.write") ||
        !authority.binding.configuration.toolIds.includes("project-work.write") ||
        authority.binding.environmentId !== identity.environmentId ||
        authority.binding.projectId !== identity.projectId ||
        authority.binding.taskId !== identity.taskId ||
        authority.binding.recordId !== identity.bindingId ||
        authority.binding.generation !== identity.generation ||
        authority.binding.providerInstanceId !== identity.providerInstanceId ||
        authority.binding.threadId !== identity.threadId
      )
        return yield* deny("Memory processing requires its original running task owner");
      const row = yield* getRow(identity.operationId);
      if (
        row.status !== "running" ||
        row.worker_id !== identity.workerId ||
        row.operation_ordinal !== identity.ordinal ||
        row.operation_kind !== "prompt"
      )
        return yield* deny("Memory processing cannot inherit an inactive or different operation");
      const root = yield* roots(authority);
      const budget = yield* operationBudget(authority, root, row);
      const dispatches = yield* sql<{ dispatchId: string }>`SELECT dispatch_id AS dispatchId
        FROM project_team_dispatch WHERE environment_id=${options.environmentId}
        AND binding_id=${identity.bindingId} AND generation=${identity.generation} LIMIT 2`;
      if (dispatches.length > 1) return yield* deny("Memory owner dispatch is ambiguous");
      const dispatch =
        dispatches[0] === undefined ? undefined : yield* readRetained(dispatches[0].dispatchId);
      const processes = yield* sql<{
        allocation: string | null;
        owner: string | null;
        unit: string;
      }>`SELECT unit,
        CASE WHEN length(CAST(allocation_json AS BLOB))<=262144 THEN allocation_json END AS allocation,
        CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner
        FROM project_team_pi_process WHERE operation_id=${identity.operationId}
        AND status='captured' LIMIT 2`;
      const process = processes[0];
      if (
        processes.length !== 1 ||
        process === undefined ||
        process.allocation === null ||
        process.owner === null
      )
        return yield* deny("Memory processing requires the original captured process");
      const allocation = yield* decodeMemoryAllocation(process.allocation);
      const capturedOwner = yield* decodeMemoryProcessOwner(process.owner);
      if (
        allocation.unit !== process.unit ||
        capturedOwner.pid < 1 ||
        capturedOwner.unit !== allocation.unit ||
        capturedOwner.nonce !== allocation.nonce ||
        capturedOwner.memoryBytes !== allocation.policy.memoryBytes ||
        !capturedOwner.cgroup.startsWith("/sys/fs/cgroup/") ||
        capturedOwner.cgroup.split("/").some((part) => part === "." || part === "..") ||
        !capturedOwner.cgroup.endsWith("/" + allocation.unit) ||
        !/^[a-f0-9]{32}$/u.test(capturedOwner.invocation)
      )
        return yield* deny("Memory original process ownership is inconsistent");
      const attempt = authority.state.attempts.find(
        (entry) => entry.attemptId === authority.binding.attemptId,
      );
      const currentLeaseDeadlineAtMs = Option.getOrElse(
        DateTime.make(attempt?.leasedUntil ?? "").pipe(Option.map(DateTime.toEpochMillis)),
        () => 0,
      );
      const originalClaim = dispatch?.intent.compiledClaim.transition;
      if (originalClaim !== undefined && originalClaim.kind !== "claim")
        return yield* deny("Memory original dispatch has no task claim");
      const originalLeaseDeadlineAtMs =
        originalClaim?.kind === "claim"
          ? Date.parse(originalClaim.claim.leasedUntil)
          : row.deadline_at_ms;
      const leaseDeadlineAtMs = Math.min(currentLeaseDeadlineAtMs, originalLeaseDeadlineAtMs);
      yield* clockCheck(Math.min(row.deadline_at_ms, leaseDeadlineAtMs));
      return yield* decodeMemoryTaskOwner({
        ...identity,
        version: 1,
        attemptId: authority.binding.attemptId,
        rootBindingId: row.root_binding_id,
        rootTaskId: budget.rootTaskId,
        rootMaximumTokens: budget.maximumTokens,
        rootDeadlineAtMs: budget.deadlineAtMs,
        attemptMaximumTokens:
          dispatch?.intent.limits.attemptMaximumTokens ?? authority.binding.configuration.maxTokens,
        attemptDeadlineAtMs: dispatch?.intent.limits.deadlineAtMs ?? row.deadline_at_ms,
        operationMaximumTokens: row.maximum_tokens,
        operationDeadlineAtMs: row.deadline_at_ms,
        leaseDeadlineAtMs,
        roleSha256: digest(authority.role),
        configurationSha256: digest(authority.binding.configuration),
        requestSha256: row.request_hash,
        allocation,
      });
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
    const readRootBudget = Effect.fn("ProjectTeamPiOperations.readRootBudget")(function* (
      authority: ProjectTeamAuthority,
      operation: PiWorkerOperation,
      request: unknown,
      resourceHash: string,
      compactContext?: {
        readonly provenanceSha256: string;
        readonly textSha256: string;
        readonly sourceRevision: number;
      },
    ) {
      yield* ownTransaction();
      const identity = {
        providerInstanceId: authority.binding.providerInstanceId,
        threadId: authority.binding.threadId,
      };
      return yield* withCompactionPermit(
        identity,
        sql.withTransaction(
          Effect.gen(function* () {
            let currentAuthority = authority;
            let compaction: typeof CompactAssociation.Type | undefined;
            let callerDeadline = Number.MAX_SAFE_INTEGER;
            if (operation.operationKind === "compact") {
              if (!compactContext)
                return yield* deny("Compact budget requires its verified current context");
              const verifiedContext = yield* decodeCompactBudgetContext(compactContext);
              const supplied = yield* decodeStoredRequest(request);
              if (supplied.kind !== "compact" || supplied.requestId === undefined)
                return yield* deny("Compact budget requires its original request");
              currentAuthority = yield* current(identity);
              if (
                immutableBinding(currentAuthority.binding) !==
                  immutableBinding(authority.binding) ||
                encode(currentAuthority.role) !== encode(authority.role)
              )
                return yield* deny("Compact budget authority changed", "conflict");
              if (currentAuthority.state.revision !== verifiedContext.sourceRevision)
                return yield* deny("Compact budget current context changed", "conflict");
              const boundary = yield* compactInside(identity, supplied);
              if (
                boundary.association ||
                boundary.operationId !== operation.operationId ||
                resourceHash !== boundary.predecessor.resourceHash ||
                !boundary.caller
              )
                return yield* deny(
                  "Compact budget requires its pending caller and exact predecessor",
                  "conflict",
                );
              compaction = yield* associateCompaction(
                boundary,
                supplied.requestId,
                verifiedContext,
              );
              callerDeadline = boundary.caller.deadline_at_ms;
            }
            const root = yield* roots(currentAuthority);
            const limits = yield* rootBudget(
              currentAuthority,
              root,
              operation,
              undefined,
              request,
              resourceHash,
              compaction,
            );
            yield* clockCheck(Math.min(limits.deadlineAtMs, callerDeadline));
            return limits.rootBudget;
          }),
        ),
      );
    });
    const mailboxDecisions = yield* makeProjectTeamMailboxTurnDecisionReader({
      environmentId: options.environmentId,
    });
    return {
      assertIndependent: () => guard(ownTransaction()),
      current: (...args: Parameters<typeof current>) =>
        guard(ownTransaction().pipe(Effect.andThen(current(...args)))),
      admitCurrent,
      readRootBudget: (...args: Parameters<typeof readRootBudget>) =>
        guard(readRootBudget(...args)),
      lookup: (...args: Parameters<typeof lookup>) => guard(lookup(...args)),
      lookupInTransaction,
      reserveCompaction: (...args: Parameters<typeof reserveCompaction>) =>
        guard(reserveCompaction(...args)),
      assertCompactionReady: (...args: Parameters<typeof assertCompactionReady>) =>
        guard(assertCompactionReady(...args)),
      abandonCompaction: (...args: Parameters<typeof abandonCompaction>) =>
        guard(abandonCompaction(...args)),
      readCompaction: (...args: Parameters<typeof readCompaction>) =>
        guard(readCompaction(...args)),
      readCompactionAnchorInTransaction: (
        identity: Parameters<typeof compactBridge>[0],
        afterOperationId: string,
        throughOperationId?: string,
      ) =>
        guard(
          lookupTransaction.pipe(
            Effect.andThen(compactBridge(identity, afterOperationId, throughOperationId)),
          ),
        ),
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
      sessionForStart: (...args: Parameters<typeof sessionForStart>) =>
        guard(sessionForStart(...args)),
      resolveOperation,
      readUsageHistoryInTransaction: (bindingId: string, generation: number) =>
        guard(readUsageHistoryInTransaction(bindingId, generation)),
      readJoinedQuarantinedFailureInTransaction: (snapshot: ProjectTeamDispatchSnapshot) =>
        guard(readJoinedQuarantinedFailureInTransaction(snapshot)),
      readUsageHistoryBatchInTransaction: (
        ...args: Parameters<typeof readUsageHistoryBatchInTransaction>
      ) => guard(readUsageHistoryBatchInTransaction(...args)),
      readMemoryOperationOwnerInTransaction: (
        ...args: Parameters<typeof readMemoryOperationOwnerInTransaction>
      ) => guard(readMemoryOperationOwnerInTransaction(...args)),
    };
  },
);
export class ProjectTeamPiOperations extends Context.Service<
  ProjectTeamPiOperations,
  Effect.Success<ReturnType<typeof makeProjectTeamPiOperations>>
>()("t3/projectWork/ProjectTeamPiOperations") {}
