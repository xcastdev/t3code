import * as ModelAccounting from "./ProjectTeamModelAccounting.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Admission captures deterministic content revisions without introducing runtime crypto dependencies.
import * as NodeCrypto from "node:crypto";
import {
  ProjectId,
  ProviderOptionSelections,
  canonicalProjectWorkPayload,
  OrchestrationV2InstructionSnapshot,
  ProjectWorkTaskId,
  ProjectTeamRunBinding,
  RunAttemptId,
  RunId,
  ThreadId,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import { freezeInstructionSnapshot } from "@t3tools/provider-core/server/instructionSnapshot";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import type * as SqlError from "effect/sql/SqlError";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as RunAdmission from "../orchestration-v2/RunAdmission.ts";
import {
  ResourceInstructionComposition,
  type CompositionInput,
} from "../orchestration-v2/ResourceInstructionComposition.ts";
import { appendAdmissionFoundationRecords, readCurrentState } from "./ProjectWorkRepository.ts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { assertProjectTeamRunAuthority } from "./ProjectTeamPolicy.ts";
import { resolveProjectTeamLimits } from "./ProjectTeamLimits.ts";
import * as ProjectWorkEventBus from "./ProjectWorkEventBus.ts";
import { decodeProjectWorkEvent } from "./ProjectWorkEventStore.ts";

const resourceBaseHash = (input: CompositionInput) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(input)).digest("hex");

const configurationJson = Schema.fromJsonString(
  Schema.Struct({
    providerInstanceId: Schema.String,
    model: Schema.String,
    options: Schema.optionalKey(ProviderOptionSelections),
    instructionsHash: Schema.String,
    instructionSnapshot: Schema.optionalKey(OrchestrationV2InstructionSnapshot),
    roleInstructions: Schema.optionalKey(Schema.String),
    roleRevisionId: Schema.optionalKey(Schema.String),
    roleRevision: Schema.optionalKey(Schema.Number),
    toolIds: Schema.Array(Schema.String),
    skillIds: Schema.Array(Schema.String),
    runtimeVersion: Schema.String,
    maxTokens: Schema.Number,
    maxDurationMs: Schema.Number,
    paidFallback: Schema.Literal(false),
  }),
);
const limitsJson = Schema.fromJsonString(
  Schema.Struct({
    rootTaskId: ProjectWorkTaskId,
    rootBindingId: Schema.String,
    maximumTokens: Schema.Number,
    maximumDelegationDepth: Schema.Number,
    repairAllowance: Schema.Number,
    environmentModelCalls: Schema.Number,
    projectWritableWorkers: Schema.Number,
    modelCalls: Schema.Number,
  }),
);
const lineageJson = Schema.fromJsonString(
  Schema.Struct({
    lineage: Schema.optionalKey(
      Schema.Struct({ parentThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)) }),
    ),
  }),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeConfiguration = Schema.decodeUnknownSync(configurationJson);
const encodeConfiguration = Schema.encodeEffect(configurationJson);
const decodeLimits = Schema.decodeUnknownEffect(limitsJson);
const encodeLimits = Schema.encodeEffect(limitsJson);
const decodeLineage = Schema.decodeUnknownEffect(lineageJson);
const decodePreparedWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ branch: Schema.NullOr(Schema.String) })),
);
const decodeBindings = Schema.decodeUnknownEffect(
  Schema.Array(Schema.fromJsonString(ProjectTeamRunBinding)),
);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
type StorageError =
  | Schema.SchemaError
  | SqlError.SqlError
  | ProjectWorkPolicyError
  | ProjectionRepositoryError
  | RunAdmission.RunAdmissionError;
interface ThreadRow {
  readonly worktree_path: string | null;
  readonly project_id: string;
  readonly archived_at: string | null;
  readonly deleted_at: string | null;
  readonly payload_json: string;
}
type Binding = Extract<ProjectTeamRecord, { kind: "run-binding" }>;
type Row = {
  admission_id: string;
  project_id: string;
  binding_id: string;
  root_id: string;
  root_task_id: string;
  thread_id: string;
  run_id: string | null;
  run_attempt_id: string | null;
  generation: number;
  fence: number;
  command_id: string;
  phase: string;
  depth: number;
  writable: number;
  root_deadline: string;
  expires_at: string;
  control_id: string | null;
  control_thread_id: string | null;
  snapshot_json: string;
  limits_json: string;
  parent_admission_id: string | null;
  uncertain: number;
  native_terminal: number;
};
const workTaskLineage = (state: ProjectWorkReducerState, taskId: ProjectWorkTaskId) => {
  const memberships: Array<Extract<ProjectTeamRecord, { kind: "task-membership" }>> = [];
  const seen = new Set<string>();
  let current = taskId;
  while (true) {
    if (seen.has(current) || seen.size >= 9) return undefined;
    seen.add(current);
    const tasks = state.tasks.filter(
      (task) => task.taskId === current && task.projectId === state.projectId,
    );
    const matches = (state.foundationRecords ?? []).filter(
      (record): record is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
        record.kind === "task-membership" && record.taskId === current,
    );
    const membership = matches[0];
    if (
      tasks.length !== 1 ||
      tasks[0]?.state === "canceled" ||
      tasks[0]?.state === "completed" ||
      matches.length !== 1 ||
      membership === undefined ||
      membership.projectId !== state.projectId ||
      membership.status !== "active" ||
      (membership.controlState !== undefined && membership.controlState !== "active")
    )
      return undefined;
    memberships.push(membership);
    if (membership.parentTaskId === undefined) break;
    current = membership.parentTaskId;
  }
  if (
    memberships.some(
      (membership) =>
        membership.rootConstraints !== undefined &&
        membership.rootConstraints.rootTaskId !== current,
    )
  )
    return undefined;
  return { rootTaskId: current, depth: memberships.length - 1 };
};
const denied = (reason: string): RunAdmission.AdmissionResult => ({ _tag: "denied", reason });
const ownerFor = (row: Row): RunAdmission.AdmittedOwner => ({
  projectId: ProjectId.make(row.project_id),
  bindingId: row.binding_id,
  rootId: row.root_id,
  generation: row.generation,
  fence: row.fence,
  threadId: ThreadId.make(row.thread_id),
  ...(row.run_id === null ? {} : { runId: RunId.make(row.run_id) }),
  ...(row.run_attempt_id === null ? {} : { runAttemptId: RunAttemptId.make(row.run_attempt_id) }),
  expiresAt: row.expires_at,
  configuration: decodeConfiguration(row.snapshot_json),
});
const controlFor = (row: Row): RunAdmission.OwnerDeadlineControl | undefined =>
  row.run_id === null || row.control_id === null || row.control_thread_id === null
    ? undefined
    : {
        controlId: row.control_id,
        controlThreadId: ThreadId.make(row.control_thread_id),
        projectId: ProjectId.make(row.project_id),
        bindingId: row.binding_id,
        rootId: row.root_id,
        generation: row.generation,
        fence: row.fence,
        targetThreadId: ThreadId.make(row.thread_id),
        targetRunId: RunId.make(row.run_id),
        expiresAt: row.expires_at,
      };

const admitted = (row: Row): RunAdmission.AdmissionResult => {
  const control = controlFor(row);
  return { _tag: "admitted", owner: ownerFor(row), ...(control === undefined ? {} : { control }) };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const accounting = yield* ModelAccounting.make;
  const resourceComposition = yield* Effect.serviceOption(ResourceInstructionComposition);
  const eventBus = yield* Effect.serviceOption(ProjectWorkEventBus.ProjectWorkEventBus);
  const rowsForThread = (threadId: string) =>
    sql<Row>`SELECT * FROM t3_workflow_v2_run_admissions WHERE thread_id = ${threadId} ORDER BY generation DESC`;
  const storedThread = (threadId: string) =>
    sql<ThreadRow>`SELECT project_id,archived_at,deleted_at,payload_json,json_extract(payload_json,'$.worktreePath') AS worktree_path FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
  const bindingFor = Effect.fn("ProjectWorkRunAdmission.bindingFor")(function* (
    threadId: string,
    projectId?: string,
  ) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM t3_workflow_v2_team_records WHERE kind = 'run-binding' AND json_extract(payload_json,'$.threadId')=${threadId}`;
    const bindings = (yield* decodeBindings(rows.map((row) => row.payload_json))).filter(
      (binding) =>
        binding.threadId === threadId &&
        (projectId === undefined || binding.projectId === projectId),
    );
    return bindings.sort(
      (a, b) => b.leaseGeneration - a.leaseGeneration || b.revision - a.revision,
    )[0];
  });
  const hasStoredOwner = Effect.fn("ProjectWorkRunAdmission.hasStoredOwner")(function* (
    threadId: string,
  ) {
    const seen = new Set<string>();
    let current: string | undefined = threadId;
    while (current !== undefined) {
      if (seen.has(current)) return true;
      seen.add(current);
      if ((yield* rowsForThread(current)).length > 0 || (yield* bindingFor(current)) !== undefined)
        return true;
      const threads: ReadonlyArray<ThreadRow> = yield* storedThread(current);
      const thread: ThreadRow | undefined = threads[0];
      const parent: ThreadId | null | undefined =
        thread === undefined
          ? undefined
          : (yield* decodeLineage(thread.payload_json)).lineage?.parentThreadId;
      current = parent ?? undefined;
    }
    return false;
  });
  const live = Effect.fn("ProjectWorkRunAdmission.live")(function* (
    row: Row,
    now: string,
    historical = false,
  ): Effect.fn.Return<RunAdmission.AdmissionResult, StorageError> {
    const owner = ownerFor(row);
    if (!Number.isFinite(Date.parse(now))) return denied("invalid-time");
    const seen = new Set<string>();
    const state = yield* readCurrentState(sql, row.project_id);
    let current: Row | undefined = row;
    while (current !== undefined) {
      if (seen.has(current.admission_id) || seen.size >= 9)
        return denied("owner-target-lineage-mismatch");
      seen.add(current.admission_id);
      if (current.project_id !== row.project_id || current.root_id !== row.root_id)
        return denied("owner-target-lineage-mismatch");
      const thread: ThreadRow | undefined = (yield* storedThread(current.thread_id))[0];
      const project = yield* sql<{
        project_id: string;
        workspace_root: string;
      }>`SELECT project_id,workspace_root FROM projection_projects WHERE project_id=${current.project_id} AND deleted_at IS NULL`;
      if (
        thread === undefined ||
        thread.project_id !== current.project_id ||
        thread.archived_at !== null ||
        thread.deleted_at !== null ||
        project.length === 0
      )
        return denied("owner-target-unavailable");
      const bindingId = current.binding_id;
      const binding = (state.foundationRecords ?? []).find(
        (record): record is Binding =>
          record.kind === "run-binding" && record.recordId === bindingId,
      );
      const role = (state.foundationRecords ?? []).find(
        (record) => record.kind === "role-revision" && record.recordId === binding?.roleRevisionId,
      );
      if (
        binding === undefined ||
        role?.kind !== "role-revision" ||
        binding.leaseGeneration !== current.fence
      )
        return denied("owner-fence-stale");
      try {
        assertProjectTeamRunAuthority(state, binding, role, binding.status === "reserved");
      } catch {
        return denied("owner-authority-revoked");
      }
      if (
        (state.foundationRecords ?? []).some(
          (record) =>
            record.kind === "limits" &&
            record.model === binding.model &&
            record.status === "disabled",
        )
      )
        return denied("owner-configuration-disabled");
      if (
        binding.workspaceState === "ready" &&
        (thread.worktree_path ?? project[0]?.workspace_root) !== binding.worktree
      )
        return denied("owner-target-workspace-changed");
      const workLineage = workTaskLineage(state, binding.taskId);
      const frozen = yield* decodeLimits(current.limits_json);
      if (
        workLineage === undefined ||
        workLineage.rootTaskId !== current.root_task_id ||
        frozen.rootTaskId !== current.root_task_id ||
        frozen.rootBindingId !== current.root_id
      )
        return denied("owner-target-lineage-mismatch");
      if (
        current.phase === "stopping" ||
        (current.admission_id === row.admission_id && current.phase === "settled" && !historical)
      )
        return denied("owner-not-active");
      if (Date.parse(current.expires_at) <= Date.parse(now)) return { _tag: "expired", owner };
      if (current.parent_admission_id === null) {
        if (current.depth !== workLineage.depth || binding.threadId !== current.thread_id)
          return denied("owner-target-lineage-mismatch");
        break;
      }
      const parent: Row | undefined =
        (yield* sql<Row>`SELECT * FROM t3_workflow_v2_run_admissions WHERE admission_id=${current.parent_admission_id}`)[0];
      const lineage = yield* decodeLineage(thread.payload_json);
      if (
        parent === undefined ||
        lineage.lineage?.parentThreadId !== parent.thread_id ||
        current.depth !== parent.depth + 1
      )
        return denied("owner-target-lineage-mismatch");
      current = parent;
    }
    return { _tag: "admitted", owner };
  });

  const originThread = Effect.fn("ProjectWorkRunAdmission.originThread")(function* (
    threadId?: ThreadId,
    sessionId?: string,
  ) {
    if (sessionId === undefined) return threadId;
    const sessions = yield* sql<{
      thread_id: string | null;
    }>`SELECT thread_id FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id = ${sessionId}`;
    const actual = sessions[0]?.thread_id;
    if (actual === undefined || actual === null) return threadId;
    if (threadId !== undefined && actual !== threadId) return null;
    return ThreadId.make(actual);
  });
  const retainControl = Effect.fn("ProjectWorkRunAdmission.retainControl")(function* (row: Row) {
    const control = controlFor(row);
    if (control !== undefined) {
      const payloadJson = yield* encodeJson(control);
      yield* sql`INSERT INTO t3_workflow_v2_admission_controls(control_id,admission_id,payload_json) VALUES (${control.controlId},${row.admission_id},${payloadJson}) ON CONFLICT(control_id) DO NOTHING`;
    }
  });
  const checkRetainedOwner = Effect.fn("ProjectWorkRunAdmission.checkRetainedOwner")(function* (
    threadId: ThreadId,
    expected: RunAdmission.RetainedOwnerConstraint,
    now: string,
  ): Effect.fn.Return<RunAdmission.AdmissionResult, StorageError> {
    const targetRows = yield* rowsForThread(threadId);
    const retained = targetRows.find((row) => row.run_id === expected.runId);
    const currentBinding = yield* bindingFor(threadId);
    const latest = yield* sql<{
      binding_id: string;
      root_id: string;
    }>`SELECT binding_id,root_id FROM t3_workflow_v2_run_admissions WHERE thread_id=${threadId} ORDER BY rowid DESC LIMIT 1`;
    if (
      expected.threadId !== threadId ||
      retained === undefined ||
      retained.project_id !== expected.projectId ||
      retained.binding_id !== expected.bindingId ||
      retained.root_id !== expected.rootId ||
      retained.generation !== expected.generation ||
      retained.fence !== expected.fence ||
      retained.expires_at !== expected.expiresAt ||
      retained.run_attempt_id !== expected.runAttemptId ||
      (currentBinding !== undefined && currentBinding.recordId !== expected.bindingId) ||
      latest[0]?.binding_id !== expected.bindingId ||
      latest[0]?.root_id !== expected.rootId
    )
      return denied("retained-owner-changed");
    return yield* live(retained, now, true);
  });
  // Resolve authority twice so filesystem preparation cannot hold a SQL write transaction or outlive a changed frozen base.
  const commit = Effect.fn("ProjectWorkRunAdmission.commit")(function* (
    input: RunAdmission.CommitInput,
    prepareCapture?: (
      input: CompositionInput,
    ) => Effect.Effect<void, RunAdmission.RunAdmissionError>,
  ): Effect.fn.Return<RunAdmission.AdmissionResult, StorageError> {
    if (
      prepareCapture === undefined &&
      Option.isNone(yield* Effect.serviceOption(sql.transactionService))
    )
      return yield* Effect.fail(
        new ProjectWorkPolicyError("invalid-state", "Admission requires the V2 transaction"),
      );
    const persisted = (yield* storedThread(input.threadId))[0];
    const targetRows = yield* rowsForThread(input.threadId);
    if (input.retainedOwner === null && (yield* hasStoredOwner(input.threadId)))
      return denied("retained-owner-changed");
    if (input.retainedOwner !== undefined && input.retainedOwner !== null) {
      const retainedAuthority = yield* checkRetainedOwner(
        input.threadId,
        input.retainedOwner,
        input.now,
      );
      if (retainedAuthority._tag !== "admitted") return retainedAuthority;
    }
    const existing = targetRows.find(
      (row) => input.runId === undefined || row.run_id === input.runId,
    );
    const origin = yield* originThread(input.originThreadId, input.originSessionId);
    if (origin === null) return denied("origin-session-mismatch");
    const lineageParent =
      persisted === undefined
        ? undefined
        : ((yield* decodeLineage(persisted.payload_json)).lineage?.parentThreadId ?? undefined);
    if (
      origin !== undefined &&
      origin !== input.threadId &&
      lineageParent !== undefined &&
      lineageParent !== origin
    )
      return denied("owner-target-lineage-mismatch");
    const parentThreadId = lineageParent ?? (origin === input.threadId ? undefined : origin);
    const parentRows = parentThreadId === undefined ? [] : yield* rowsForThread(parentThreadId);
    const parent = parentRows[0];
    const inherited = targetRows[0];
    const binding = yield* bindingFor(input.threadId);
    if (
      parentThreadId !== undefined &&
      parent === undefined &&
      (yield* hasStoredOwner(parentThreadId))
    )
      return denied("origin-run-not-admitted");
    if (
      inherited !== undefined &&
      persisted !== undefined &&
      inherited.parent_admission_id !== null
    ) {
      const retainedParent =
        (yield* sql<Row>`SELECT * FROM t3_workflow_v2_run_admissions WHERE admission_id=${inherited.parent_admission_id}`)[0];
      if (retainedParent === undefined || retainedParent.thread_id !== lineageParent)
        return denied("owner-target-lineage-mismatch");
    }
    if (input.operation === "bind-thread" && existing !== undefined)
      return yield* live(existing, input.now, true);
    if (
      existing === undefined &&
      inherited === undefined &&
      binding === undefined &&
      parent === undefined
    )
      return { _tag: "ordinary" };
    if (input.retainedOwner === null) return denied("retained-owner-changed");
    if (
      input.operation !== "bind-thread" &&
      input.operation !== "create" &&
      (input.runId === undefined || existing === undefined || existing.run_id === null)
    )
      return denied("run-not-admitted");
    if (
      prepareCapture === undefined &&
      persisted === undefined &&
      input.operation !== "bind-thread" &&
      !targetRows.some((row) => row.phase === "prepared")
    )
      return denied("owner-target-unavailable");
    if (
      input.preparedBindingId !== undefined &&
      input.preparedBindingId !==
        (existing?.binding_id ?? binding?.recordId ?? inherited?.binding_id ?? parent?.binding_id)
    )
      return denied("prepared-binding-mismatch");
    if (
      persisted !== undefined &&
      (persisted.archived_at !== null || persisted.deleted_at !== null)
    )
      return denied("owner-target-unavailable");
    let finalized = existing;
    if (
      existing !== undefined &&
      binding?.workspaceState === "pending" &&
      input.operation === "promote"
    ) {
      if (persisted === undefined) return denied("owner-target-unavailable");
      const fields = yield* decodePreparedWorkspace(persisted.payload_json);
      const projects = yield* sql<{
        workspace_root: string;
      }>`SELECT workspace_root FROM projection_projects WHERE project_id=${binding.projectId} AND deleted_at IS NULL`;
      const root = persisted.worktree_path ?? projects[0]?.workspace_root;
      if (
        root === undefined ||
        (binding.workspaceKind === "worktree" &&
          (persisted.worktree_path === null || fields.branch === null))
      )
        return denied("workspace-preparation-pending");
      const configuration = decodeConfiguration(existing.snapshot_json);
      const compositionInput: CompositionInput = {
        resourceRoot: root,
        projectId: binding.projectId,
        threadId: input.threadId,
        providerInstanceId: configuration.providerInstanceId,
        configuration,
        roleRevisionId: configuration.roleRevisionId ?? binding.roleRevisionId,
        roleRevision: configuration.roleRevision ?? 0,
        roleInstructions:
          configuration.roleInstructions ??
          configuration.instructionSnapshot?.roleInstructions ??
          "",
      };
      if (prepareCapture !== undefined) {
        if (configuration.skillIds.length > 0) yield* prepareCapture(compositionInput);
        return admitted(existing);
      }
      if (configuration.skillIds.length > 0) {
        if (
          input.preparedResources === undefined ||
          input.preparedResources.baseHash !== resourceBaseHash(compositionInput)
        )
          return denied("managed-resource-authority-changed");
        const catalog = yield* sql<{
          revision: number;
        }>`SELECT revision FROM t3_workflow_v2_skill_catalog_revision WHERE id=1`;
        if (catalog[0]?.revision !== input.preparedResources.catalogRevision)
          return denied("managed-resource-revision-changed");
      }
      const nextConfiguration = {
        ...configuration,
        ...(input.preparedResources === undefined
          ? {}
          : { instructionSnapshot: input.preparedResources.snapshot }),
      };
      const payload = yield* encodeConfiguration(nextConfiguration);
      yield* sql`UPDATE t3_workflow_v2_run_admissions SET snapshot_json=${payload} WHERE admission_id=${existing.admission_id}`;
      yield* appendAdmissionFoundationRecords(
        sql,
        binding.projectId,
        input.commandId,
        [
          {
            ...binding,
            workspaceState: "ready",
            worktree: root,
            branch: fields.branch,
            revision: binding.revision + 1,
            updatedAt: input.now,
          },
        ],
        input.now,
      );
      finalized = { ...existing, snapshot_json: payload };
    }
    if (prepareCapture !== undefined && existing !== undefined) return admitted(finalized!);
    if (finalized !== undefined && finalized.run_id !== null) {
      const existing = finalized;
      const result = yield* live(existing, input.now);
      if (result._tag !== "admitted") return result;
      const retained = yield* decodeLimits(existing.limits_json);
      const usage = yield* accounting.checkAdmission({
        projectId: ProjectId.make(existing.project_id),
        rootTaskId: retained.rootTaskId,
        maximumTokens: retained.maximumTokens,
        deadlineAtMs: Date.parse(existing.root_deadline),
        nowMs: Date.parse(input.now),
      });
      if (usage._tag === "Blocked") return denied(usage.reason);
      if (
        input.runAttemptId !== undefined &&
        existing.run_attempt_id !== null &&
        input.runAttemptId !== existing.run_attempt_id &&
        input.operation !== "restart"
      )
        return denied("run-attempt-mismatch");
      if (input.operation === "restart" && existing.command_id !== input.commandId) {
        if (existing.uncertain === 1) return denied("native-acceptance-uncertain");
        const generation = existing.generation + 1;
        const controlId = `workflow-owner-deadline:${existing.admission_id}:${generation}`;
        const lane = `workflow-owner-control:${existing.root_id}:${existing.admission_id}:${generation}`;
        yield* sql`UPDATE t3_workflow_v2_run_admissions SET command_id=${input.commandId},generation=${generation},run_attempt_id=${input.runAttemptId ?? existing.run_attempt_id},phase='admitted',control_id=${controlId},control_thread_id=${lane} WHERE admission_id=${existing.admission_id}`;
        const next = {
          ...existing,
          command_id: input.commandId,
          generation,
          run_attempt_id: input.runAttemptId ?? existing.run_attempt_id,
          phase: "admitted",
          control_id: controlId,
          control_thread_id: lane,
        };
        yield* retainControl(next);
        return admitted(next);
      }
      if (input.operation === "promote")
        yield* sql`UPDATE t3_workflow_v2_run_admissions SET phase='admitted' WHERE admission_id=${existing.admission_id}`;
      return admitted(existing);
    }
    const source =
      inherited?.phase === "prepared"
        ? binding !== undefined
          ? undefined
          : (parent ?? inherited)
        : (inherited ?? parent);
    if (binding === undefined && source !== undefined) {
      const result = yield* live(source, input.now, true);
      if (result._tag !== "admitted") return result;
    }
    if (parent !== undefined) {
      if (parent.run_id === null) return denied("origin-run-not-admitted");
      const result = yield* live(parent, input.now, true);
      if (result._tag !== "admitted") return result;
      if (persisted !== undefined && persisted.project_id !== parent.project_id)
        return denied("owner-project-escape");
    }
    const projectId = source?.project_id ?? binding!.projectId;
    const project = yield* sql<{
      project_id: string;
      workspace_root: string;
    }>`SELECT project_id,workspace_root FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`;
    if (
      project.length === 0 ||
      (persisted !== undefined && persisted.project_id !== projectId) ||
      (input.projectId !== undefined && input.projectId !== projectId)
    )
      return denied("owner-target-unavailable");
    const state = yield* readCurrentState(sql, projectId);
    const rootBinding =
      binding ??
      (state.foundationRecords ?? []).find(
        (record): record is Binding =>
          record.kind === "run-binding" && record.recordId === source?.binding_id,
      );
    if (rootBinding === undefined) return denied("owner-binding-unavailable");
    const role = (state.foundationRecords ?? []).find(
      (record) => record.kind === "role-revision" && record.recordId === rootBinding.roleRevisionId,
    );
    if (role?.kind !== "role-revision") return denied("owner-role-unavailable");
    try {
      assertProjectTeamRunAuthority(state, rootBinding, role, rootBinding.status === "reserved");
    } catch {
      return denied("owner-authority-revoked");
    }
    const prior =
      yield* sql<Row>`SELECT * FROM t3_workflow_v2_run_admissions WHERE binding_id=${rootBinding.recordId} ORDER BY generation DESC LIMIT 1`;
    const workLineage = workTaskLineage(state, rootBinding.taskId);
    if (workLineage === undefined) return denied("owner-target-lineage-mismatch");
    const rootTaskId = workLineage.rootTaskId;
    const rootHistory =
      yield* sql<Row>`SELECT * FROM t3_workflow_v2_run_admissions WHERE project_id=${projectId} AND root_task_id=${rootTaskId} AND phase <> 'prepared' ORDER BY root_deadline ASC LIMIT 1`;
    const retainedRoot = rootHistory[0];
    const rootLimits = source === undefined ? retainedRoot : source;
    const retainedLimits =
      rootLimits === undefined ? undefined : yield* decodeLimits(rootLimits.limits_json);
    const now = Date.parse(input.now);
    const policy = resolveProjectTeamLimits({
      state,
      taskId: rootBinding.taskId,
      roleRevisionId: rootBinding.roleRevisionId,
      nowMs: now,
      environmentModelCalls: 128,
      writable: ["implementer", "integrator"].includes(role.role),
      attemptConfiguration: rootBinding.configuration,
      rootBudget: {
        rootTaskId: retainedLimits?.rootTaskId ?? rootTaskId,
        maximumTokens: retainedLimits?.maximumTokens ?? rootBinding.configuration.maxTokens,
        deadlineAtMs:
          rootLimits === undefined
            ? Math.min(
                now + rootBinding.configuration.maxDurationMs,
                Date.parse(
                  state.attempts.find((attempt) => attempt.attemptId === rootBinding.attemptId)
                    ?.leasedUntil ??
                    DateTime.formatIso(
                      DateTime.makeUnsafe(now + rootBinding.configuration.maxDurationMs),
                    ),
                ),
              )
            : Date.parse(rootLimits.root_deadline),
        ...retainedLimits,
      },
    });
    if (policy._tag === "Blocked") return denied(policy.reason);
    const usage = yield* accounting.checkAdmission({
      projectId: ProjectId.make(projectId),
      rootTaskId,
      maximumTokens: policy.frozen.maximumTokens,
      deadlineAtMs: policy.frozen.rootDeadlineAtMs,
      nowMs: now,
    });
    if (usage._tag === "Blocked") return denied(usage.reason);
    const depth =
      inherited?.depth ?? (parent === undefined ? policy.frozen.delegationDepth : parent.depth + 1);
    if (depth > policy.frozen.maximumDelegationDepth) return denied("delegation-depth-exceeded");
    const active =
      yield* sql<Row>`SELECT * FROM t3_workflow_v2_run_admissions WHERE phase IN ('queued','admitted','launched','stopping')`;
    if (input.operation !== "bind-thread") {
      if (
        active.length >= policy.frozen.environmentModelCalls ||
        active.filter(
          (row) =>
            row.project_id === projectId && ownerFor(row).configuration.model === rootBinding.model,
        ).length >= policy.frozen.modelCalls
      )
        return denied("model-capacity-exhausted");
      if (
        policy.frozen.writable &&
        active.filter((row) => row.project_id === projectId && row.writable === 1).length >=
          policy.frozen.projectWritableWorkers
      )
        return denied("writable-capacity-exhausted");
    }
    const generation = Math.max(-1, ...prior.map((row) => row.generation)) + 1;
    const rootId = source?.root_id ?? retainedRoot?.root_id ?? rootBinding.recordId;
    const rootDeadline =
      source?.root_deadline ??
      retainedRoot?.root_deadline ??
      DateTime.formatIso(DateTime.makeUnsafe(policy.frozen.rootDeadlineAtMs));
    const expiresAt = DateTime.formatIso(
      DateTime.makeUnsafe(
        Math.min(
          Date.parse(rootDeadline),
          policy.frozen.deadlineAtMs,
          input.retainedOwner === undefined || input.retainedOwner === null
            ? Number.POSITIVE_INFINITY
            : Date.parse(input.retainedOwner.expiresAt ?? ""),
        ),
      ),
    );
    const admissionId = `${rootBinding.recordId}:${input.threadId}:${input.runId ?? "prepared"}`;
    const controlId =
      input.runId === undefined ? null : `workflow-owner-deadline:${admissionId}:${generation}`;
    const lane =
      input.runId === undefined
        ? null
        : `workflow-owner-control:${rootId}:${admissionId}:${generation}`;
    const priorConfigurationRow = [source, inherited, existing].find(
      (row) => row?.binding_id === rootBinding.recordId,
    );
    const priorConfiguration =
      priorConfigurationRow === undefined
        ? undefined
        : decodeConfiguration(priorConfigurationRow.snapshot_json);
    const configuration =
      priorConfiguration === undefined
        ? {
            ...rootBinding.configuration,
            providerInstanceId: rootBinding.providerInstanceId,
            model: rootBinding.model,
          }
        : {
            providerInstanceId: priorConfiguration.providerInstanceId,
            model: priorConfiguration.model,
            ...(priorConfiguration.options === undefined
              ? {}
              : { options: priorConfiguration.options }),
            instructionsHash: priorConfiguration.instructionsHash,
            toolIds: priorConfiguration.toolIds,
            skillIds: priorConfiguration.skillIds,
            runtimeVersion: priorConfiguration.runtimeVersion,
            maxTokens: priorConfiguration.maxTokens,
            maxDurationMs: priorConfiguration.maxDurationMs,
            paidFallback: priorConfiguration.paidFallback,
          };
    const baseRoleInstructions =
      priorConfiguration === undefined
        ? role.instructions
        : (priorConfiguration.roleInstructions ??
          (priorConfiguration.skillIds.length === 0
            ? priorConfiguration.instructionSnapshot?.roleInstructions
            : undefined));
    if (baseRoleInstructions === undefined) return denied("frozen-role-base-unavailable");
    const baseRoleRevisionId = priorConfiguration?.roleRevisionId ?? role.recordId;
    const baseRoleRevision = priorConfiguration?.roleRevision ?? role.revision;
    const snapshotSource = [source, inherited, existing].find(
      (row) =>
        row?.binding_id === rootBinding.recordId &&
        row.run_id !== null &&
        row.run_id === input.runId,
    );
    const retainedSnapshot =
      snapshotSource === undefined
        ? undefined
        : decodeConfiguration(snapshotSource.snapshot_json).instructionSnapshot;
    if (
      persisted !== undefined &&
      input.proposedWorktreePath !== undefined &&
      input.proposedWorktreePath !== persisted.worktree_path
    )
      return denied("managed-resource-target-changed");
    const resourceRoot =
      (persisted === undefined ? input.proposedWorktreePath : persisted.worktree_path) ??
      project[0]!.workspace_root;
    const compositionInput: CompositionInput = {
      resourceRoot,
      projectId: ProjectId.make(projectId),
      threadId: input.threadId,
      providerInstanceId: configuration.providerInstanceId,
      configuration,
      roleRevisionId: baseRoleRevisionId,
      roleRevision: baseRoleRevision,
      roleInstructions: baseRoleInstructions,
    };
    const needsResources =
      input.runId !== undefined &&
      snapshotSource === undefined &&
      binding?.workspaceState !== "pending" &&
      configuration.skillIds.length > 0;
    if (prepareCapture !== undefined) {
      if (needsResources) yield* prepareCapture(compositionInput);
      return denied("resource-preflight-only");
    }
    let composedSnapshot: OrchestrationV2InstructionSnapshot | undefined;
    if (needsResources) {
      const prepared = input.preparedResources;
      if (prepared === undefined) return denied("managed-resource-preparation-unavailable");
      if (prepared.baseHash !== resourceBaseHash(compositionInput))
        return denied("managed-resource-authority-changed");
      const current = yield* sql<{
        revision: number;
      }>`SELECT revision FROM t3_workflow_v2_skill_catalog_revision WHERE id=1`;
      if (current[0]?.revision !== prepared.catalogRevision)
        return denied("managed-resource-revision-changed");
      composedSnapshot = prepared.snapshot;
    }
    const instructionSnapshot =
      retainedSnapshot ??
      composedSnapshot ??
      (snapshotSource === undefined
        ? {
            configurationHash: NodeCrypto.createHash("sha256")
              .update(
                canonicalProjectWorkPayload({ configuration, instructions: baseRoleInstructions }),
              )
              .digest("hex"),
            resourceRevision: NodeCrypto.createHash("sha256")
              .update(
                canonicalProjectWorkPayload({
                  roleRevisionId: baseRoleRevisionId,
                  revision: baseRoleRevision,
                  tools: configuration.toolIds,
                  skills: configuration.skillIds,
                  runtimeVersion: configuration.runtimeVersion,
                }),
              )
              .digest("hex"),
            memoryEpoch: 0,
            roleInstructions: baseRoleInstructions,
            toolIds: configuration.toolIds,
            skillIds: configuration.skillIds,
          }
        : undefined);
    const snapshotJson = yield* encodeConfiguration({
      ...configuration,
      roleInstructions: baseRoleInstructions,
      roleRevisionId: baseRoleRevisionId,
      roleRevision: baseRoleRevision,
      ...(instructionSnapshot === undefined ? {} : { instructionSnapshot }),
    });
    const limitsPayloadJson = yield* encodeLimits({ ...policy.frozen, rootBindingId: rootId });
    const row: Row = {
      admission_id: admissionId,
      project_id: projectId,
      binding_id: rootBinding.recordId,
      root_id: rootId,
      root_task_id: rootTaskId,
      thread_id: input.threadId,
      run_id: input.runId ?? null,
      run_attempt_id: input.runAttemptId ?? null,
      generation,
      fence: rootBinding.leaseGeneration,
      command_id: input.commandId,
      phase: input.runId === undefined ? "prepared" : input.queued ? "queued" : "admitted",
      depth,
      writable: policy.frozen.writable ? 1 : 0,
      root_deadline: rootDeadline,
      expires_at: expiresAt,
      control_id: controlId,
      control_thread_id: lane,
      snapshot_json: snapshotJson,
      limits_json: limitsPayloadJson,
      parent_admission_id: inherited?.parent_admission_id ?? parent?.admission_id ?? null,
      uncertain: 0,
      native_terminal: 0,
    };
    if (Date.parse(expiresAt) <= now) return { _tag: "expired", owner: ownerFor(row) };
    yield* sql`INSERT INTO t3_workflow_v2_run_admissions ${sql.insert(row)}`;
    yield* retainControl(row);
    if (input.runId !== undefined && binding !== undefined && binding.runId === undefined) {
      yield* appendAdmissionFoundationRecords(
        sql,
        projectId,
        input.commandId,
        [
          {
            ...binding,
            status: "running",
            runId: input.runId,
            ...(input.runAttemptId === undefined ? {} : { runAttemptId: input.runAttemptId }),
            revision: binding.revision + 1,
            updatedAt: input.now,
          },
        ],
        input.now,
      );
    }
    return admitted(row);
  });
  const check = Effect.fn("ProjectWorkRunAdmission.check")(function* (
    input: RunAdmission.CheckInput,
  ): Effect.fn.Return<RunAdmission.AdmissionResult, StorageError> {
    if (input.retainedOwner === null)
      return (yield* hasStoredOwner(input.threadId))
        ? denied("retained-owner-changed")
        : { _tag: "ordinary" };
    if (input.retainedOwner !== undefined) {
      if (input.operation !== "completion" || input.runId !== input.retainedOwner.runId)
        return denied("retained-owner-changed");
      return yield* checkRetainedOwner(input.threadId, input.retainedOwner, input.now);
    }
    const origin = yield* originThread(input.threadId, input.originSessionId);
    if (origin === null) return denied("origin-session-mismatch");
    const rows = yield* rowsForThread(input.threadId);
    const row = rows.find(
      (candidate) => input.runId === undefined || candidate.run_id === input.runId,
    );
    if (row === undefined) {
      const knownOwner = yield* hasStoredOwner(input.threadId);
      return knownOwner
        ? denied(input.operation === "escape" ? "owner-escape-forbidden" : "run-not-admitted")
        : { _tag: "ordinary" };
    }
    if (input.operation === "escape") return denied("owner-escape-forbidden");
    if (row.run_id === null) return denied("run-not-admitted");
    const nativeTarget = input.nativeTarget;
    if (input.operation === "completion") {
      if (input.runId === undefined || nativeTarget === undefined)
        return denied("completion-target-required");
      if (row.run_attempt_id !== nativeTarget.runAttemptId) return denied("native-target-stale");
      return yield* live(row, input.now, true);
    }
    if (nativeTarget !== undefined) {
      if (row.run_attempt_id !== nativeTarget.runAttemptId) return denied("native-target-stale");
      const current = yield* sql`SELECT r.run_id FROM orchestration_v2_projection_runs r
        JOIN orchestration_v2_projection_run_attempts a ON a.run_id=r.run_id AND a.thread_id=r.thread_id AND a.attempt_id=${nativeTarget.runAttemptId}
        JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=a.provider_thread_id AND p.thread_id=r.thread_id
        JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id=p.provider_session_id AND s.thread_id=r.thread_id
        WHERE r.run_id=${row.run_id} AND r.thread_id=${input.threadId}
          AND json_extract(r.payload_json,'$.activeAttemptId')=${nativeTarget.runAttemptId}
          AND p.provider_thread_id=${nativeTarget.providerThreadId} AND p.provider_session_id=${nativeTarget.providerSessionId}
          AND r.completed_at IS NULL AND r.status IN ('starting','running','waiting')
          AND a.status IN ('pending','running') AND p.status IN ('idle','active')
          AND s.status IN ('starting','ready','running','waiting')`;
      if (current.length !== 1) return denied("native-target-stale");
      if (nativeTarget.providerTurnId !== undefined) {
        const turns =
          yield* sql`SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns
          WHERE provider_turn_id=${nativeTarget.providerTurnId} AND thread_id=${input.threadId}
            AND provider_thread_id=${nativeTarget.providerThreadId} AND run_attempt_id=${nativeTarget.runAttemptId}
            AND completed_at IS NULL AND status IN ('pending','running')`;
        if (turns.length !== 1) return denied("native-target-stale");
      }
      if (nativeTarget.nodeId !== undefined) {
        const nodes =
          yield* sql`SELECT n.node_id FROM orchestration_v2_projection_nodes n WHERE n.node_id=${nativeTarget.nodeId}
          AND n.thread_id=${input.threadId} AND n.run_id=${row.run_id} AND n.provider_thread_id=${nativeTarget.providerThreadId}
          AND (${nativeTarget.providerTurnId ?? null} IS NULL OR n.provider_turn_id=${nativeTarget.providerTurnId ?? null})
          AND ((n.completed_at IS NULL AND n.status IN ('idle','pending','running','waiting'))
            OR (n.kind IN ('approval_request','user_input_request') AND n.status IN ('completed','cancelled') AND n.completed_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests q
                WHERE q.runtime_request_id=n.runtime_request_id AND q.node_id=n.node_id AND q.thread_id=n.thread_id
                  AND q.provider_turn_id=n.provider_turn_id AND q.status='resolved' AND q.resolved_at IS NOT NULL
                  AND json_extract(q.payload_json,'$.responseCapability.type')='live'
                  AND json_extract(q.payload_json,'$.responseCapability.providerSessionId')=${nativeTarget.providerSessionId})))`;
        if (nodes.length !== 1) return denied("native-target-stale");
      }
    }
    const authority = yield* live(row, input.now);
    if (authority._tag !== "admitted") return authority;
    if (input.operation === "preparation") return authority;
    const binding = yield* bindingFor(input.threadId);
    if (binding?.workspaceState === "pending") return denied("workspace-preparation-pending");
    const frozen = yield* decodeLimits(row.limits_json);
    const usage = yield* accounting.checkAdmission({
      projectId: ProjectId.make(row.project_id),
      rootTaskId: frozen.rootTaskId,
      maximumTokens: frozen.maximumTokens,
      deadlineAtMs: Date.parse(row.root_deadline),
      nowMs: Date.parse(input.now),
    });
    if (usage._tag === "Blocked") return denied(usage.reason);
    return authority;
  });
  const reconcileNative = Effect.fn("ProjectWorkRunAdmission.reconcileNative")(function* (input: {
    threadId: ThreadId;
    runId: RunId;
    now: string;
    accepted: boolean;
    uncertain: boolean;
    runAttemptId?: RunAttemptId;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const result = yield* check(input);
        const rows = yield* rowsForThread(input.threadId);
        const row = rows.find((candidate) => candidate.run_id === input.runId);
        if (row?.native_terminal === 1) return result;
        if (
          row !== undefined &&
          input.runAttemptId !== undefined &&
          row.run_attempt_id !== input.runAttemptId
        )
          return denied("run-attempt-mismatch");
        if (row !== undefined)
          yield* sql`UPDATE t3_workflow_v2_run_admissions SET uncertain=${input.uncertain || (input.accepted && result._tag !== "admitted") ? 1 : 0},phase=${result._tag === "admitted" && input.accepted ? "launched" : result._tag !== "admitted" && (input.accepted || input.uncertain) ? "stopping" : row.phase} WHERE admission_id=${row.admission_id}`;
        return result;
      }),
    );
  });
  const deadline = Effect.fn("ProjectWorkRunAdmission.deadline")(function* (
    input: RunAdmission.OwnerDeadlineControl & { now: string },
  ): Effect.fn.Return<RunAdmission.DeadlineResult, StorageError> {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* rowsForThread(input.targetThreadId);
        const row = rows.find(
          (candidate) =>
            candidate.run_id === input.targetRunId &&
            candidate.binding_id === input.bindingId &&
            candidate.generation === input.generation &&
            candidate.fence === input.fence &&
            candidate.control_id === input.controlId &&
            candidate.control_thread_id === input.controlThreadId &&
            candidate.expires_at === input.expiresAt &&
            candidate.root_id === input.rootId &&
            candidate.project_id === input.projectId,
        );
        if (row === undefined || row.phase === "settled") return { _tag: "stale" as const };
        if (Date.parse(row.expires_at) > Date.parse(input.now))
          return { _tag: "early" as const, availableAt: row.expires_at };
        const targets =
          yield* sql<Row>`SELECT * FROM t3_workflow_v2_run_admissions WHERE root_id=${row.root_id} AND phase IN ('queued','admitted','launched','stopping')`;
        const descendants = new Set([row.admission_id]);
        for (const target of [...targets].sort((a, b) => a.depth - b.depth)) {
          if (target.parent_admission_id !== null && descendants.has(target.parent_admission_id))
            descendants.add(target.admission_id);
        }
        const selected = targets.filter((target) => descendants.has(target.admission_id));
        for (const target of selected)
          yield* sql`UPDATE t3_workflow_v2_run_admissions SET phase='stopping' WHERE admission_id=${target.admission_id}`;
        return {
          _tag: "stop" as const,
          targets: selected.flatMap((target) => {
            const control = controlFor(target);
            return control === undefined ? [] : [control];
          }),
        };
      }),
    );
  });
  const validateDeadlineStop = Effect.fn("ProjectWorkRunAdmission.validateDeadlineStop")(function* (
    input: RunAdmission.OwnerDeadlineControl & { now: string },
  ) {
    const rows = yield* rowsForThread(input.targetThreadId);
    const state = yield* readCurrentState(sql, input.projectId);
    const explicit = (state.foundationRecords ?? []).some(
      (record) =>
        record.kind === "run-binding" &&
        record.recordId === input.bindingId &&
        ["stopping", "quarantined"].includes(record.status) &&
        record.leaseGeneration === input.fence,
    );
    return rows.some(
      (row) =>
        row.run_id === input.targetRunId &&
        row.binding_id === input.bindingId &&
        row.root_id === input.rootId &&
        row.project_id === input.projectId &&
        row.generation === input.generation &&
        row.fence === input.fence &&
        row.control_id === input.controlId &&
        row.control_thread_id === input.controlThreadId &&
        row.expires_at === input.expiresAt &&
        row.phase !== "settled" &&
        (explicit || Date.parse(row.expires_at) <= Date.parse(input.now)),
    );
  });
  const settle = Effect.fn("ProjectWorkRunAdmission.settle")(function* (input: {
    threadId: ThreadId;
    runId: RunId;
    now: string;
    uncertain?: boolean;
  }) {
    const rows = yield* rowsForThread(input.threadId);
    const row = rows.find((candidate) => candidate.run_id === input.runId);
    if (row === undefined || row.uncertain === 1 || input.uncertain === true) return [];
    yield* sql`UPDATE t3_workflow_v2_run_admissions SET phase='settled' WHERE admission_id=${row.admission_id}`;
    const controls = yield* sql<{
      control_id: string;
    }>`SELECT control_id FROM t3_workflow_v2_admission_controls WHERE admission_id=${row.admission_id}`;
    return controls.map((control) => control.control_id);
  });
  const observeNativeTurn = Effect.fn("ProjectWorkRunAdmission.observeNativeTurn")(
    function* (input: {
      threadId: ThreadId;
      runId: RunId;
      runAttemptId: RunAttemptId;
      now: string;
      terminal: boolean;
    }) {
      const rows = yield* rowsForThread(input.threadId);
      const row = rows.find((candidate) => candidate.run_id === input.runId);
      if (row === undefined)
        return { stop: (yield* bindingFor(input.threadId)) !== undefined, cancelControlIds: [] };
      if (row.run_attempt_id !== input.runAttemptId) return { stop: true, cancelControlIds: [] };
      if (input.terminal) {
        yield* sql`UPDATE t3_workflow_v2_run_admissions SET uncertain=0,native_terminal=1 WHERE admission_id=${row.admission_id}`;
        return { stop: false, cancelControlIds: yield* settle({ ...input, uncertain: false }) };
      }
      if (row.native_terminal === 1) return { stop: false, cancelControlIds: [] };
      const result = yield* live(row, input.now);
      if (result._tag !== "admitted") {
        yield* sql`UPDATE t3_workflow_v2_run_admissions SET uncertain=1,phase='stopping' WHERE admission_id=${row.admission_id}`;
        return { stop: true, cancelControlIds: [] };
      }
      return { stop: false, cancelControlIds: [] };
    },
  );
  const publishCommitted = Effect.fn("ProjectWorkRunAdmission.publishCommitted")(function* (
    commandId: string,
  ) {
    if (Option.isNone(eventBus)) return;
    const rows = yield* sql<{
      sequence: number;
      payload_json: string;
    }>`SELECT sequence,payload_json FROM t3_workflow_v2_work_events WHERE command_id=${`admission:${commandId}`} ORDER BY sequence`;
    yield* eventBus.value.publish(
      rows.map((row) => ({
        cursor: row.sequence,
        event: decodeProjectWorkEvent(decodeJson(row.payload_json)),
      })),
    );
  });
  const wrap = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) => new RunAdmission.RunAdmissionError({ operation, cause })),
    );
  return RunAdmission.RunAdmission.of({
    prepareResources: (input) =>
      wrap(
        "prepareResources",
        Effect.gen(function* () {
          if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
            return yield* new RunAdmission.RunAdmissionError({
              operation: "prepareResources",
              cause: "Resource preparation must run outside SQL transactions.",
            });
          let prepared: RunAdmission.PreparedResourceInstructions | undefined;
          yield* commit(
            input,
            Effect.fn("ProjectWorkRunAdmission.captureResources")(function* (compositionInput) {
              if (Option.isNone(resourceComposition)) return;
              const captured = yield* resourceComposition.value
                .compose(compositionInput)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new RunAdmission.RunAdmissionError({ operation: "prepareResources", cause }),
                  ),
                );
              prepared = Object.freeze({
                ...captured,
                snapshot: freezeInstructionSnapshot(captured.snapshot),
                baseHash: resourceBaseHash(compositionInput),
              });
            }),
          );
          return prepared;
        }),
      ),
    commit: (input) => wrap("commit", commit(input)),
    check: (input) => wrap("check", sql.withTransaction(check(input))),
    reconcileNative: (input) => wrap("reconcileNative", reconcileNative(input)),
    deadline: (input) => wrap("deadline", deadline(input)),
    settle: (input) => wrap("settle", settle(input)),
    validateDeadlineStop: (input) => wrap("validateDeadlineStop", validateDeadlineStop(input)),
    observeNativeTurn: (input) => wrap("observeNativeTurn", observeNativeTurn(input)),
    publishCommitted: (commandId) => publishCommitted(commandId).pipe(Effect.ignore),
  });
});
export const layer = Layer.effect(RunAdmission.RunAdmission, make);
