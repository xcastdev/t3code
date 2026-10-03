import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeUtil from "node:util";
import {
  PiManagedProcessAllocationSchema,
  PiManagedProcessError,
  type PiManagedProcessAllocation,
  type PiManagedProcessOwner,
} from "../provider/pi/PiManagedProcess.ts";
import { makeProjectTeamDispatchJournal } from "../projectWork/ProjectTeamDispatchJournal.ts";
import {
  ProjectManagedSetupError,
  isProjectManagedSetupReceiptValid,
  type ProjectManagedSetupInput,
  type ProjectManagedSetupPorts,
  type ProjectManagedSetupRetained,
} from "./ProjectManagedSetup.ts";

const safe = Schema.Int.check(Schema.makeFilter(Number.isSafeInteger));
const positive = safe.check(Schema.makeFilter((n) => n > 0));
const id = Schema.String.check(Schema.makeFilter((s) => s.length > 0 && s.length <= 4096));
const inputSchema = Schema.Struct({
  setupId: id,
  dispatchId: id,
  bindingId: id,
  generation: safe.check(Schema.makeFilter((n) => n >= 0)),
  threadId: id,
  worktreePath: id,
  deadlineAtMs: positive,
});
const launch = Schema.Struct({
  workspaceRoot: id,
  workspaceAccess: Schema.optional(Schema.Literals(["readonly", "readwrite"])),
  nativeStateRoot: Schema.optional(id),
  protectedWorkspaceEntries: Schema.optional(Schema.Array(id)),
  protectedRoots: Schema.Array(id),
  runtimeFiles: Schema.Array(Schema.Struct({ source: id, target: id })),
  argv: Schema.Array(Schema.String),
  memoryBytes: positive,
  runtimeSeconds: positive,
});
const selectionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("script"),
    scriptId: id,
    scriptRevision: id,
    cwd: id,
    launch,
  }),
]);
const ownerSchema = Schema.Struct({
  type: Schema.Literal("owner"),
  unit: id,
  invocation: id,
  cgroup: id,
  pid: positive,
  memoryBytes: positive,
  swapBytes: safe,
  oomGroup: safe,
  nonce: id,
});
const drainSchema = Schema.Struct({
  unit: id,
  invocation: id,
  cgroup: id,
  ownerPid: Schema.NullOr(positive),
  memoryBytes: positive,
  swapBytes: safe,
  oomGroup: safe,
  launcherPid: positive,
  childPid: Schema.NullOr(positive),
  childExitCode: Schema.NullOr(safe),
  kernel: Schema.String,
});
const reconciliationSchema = Schema.Struct({
  state: Schema.Literals(["absent", "owned", "drained"]),
  unit: id,
  invocation: Schema.NullOr(id),
  cgroup: Schema.NullOr(id),
  kernel: Schema.String,
});
const outputSchema = Schema.Struct({
  text: Schema.String,
  bytes: safe,
  truncated: Schema.Boolean,
  invalidUtf8: Schema.Boolean,
});
const receiptSchema = Schema.Struct({
  outcome: Schema.Literals(["skipped", "succeeded", "failed", "canceled"]),
  selection: selectionSchema,
  allocation: Schema.NullOr(PiManagedProcessAllocationSchema),
  owner: Schema.NullOr(ownerSchema),
  drain: Schema.NullOr(drainSchema),
  reconciliation: Schema.NullOr(reconciliationSchema),
  stdout: Schema.NullOr(outputSchema),
  stderr: Schema.NullOr(outputSchema),
  reason: Schema.NullOr(Schema.String),
});
const retainedSnapshotSchema = Schema.Struct({
  selection: selectionSchema,
  allocation: Schema.NullOr(PiManagedProcessAllocationSchema),
  owner: Schema.NullOr(ownerSchema),
  receipt: Schema.NullOr(receiptSchema),
  activation: Schema.Literals(["unlaunched", "claimed", "owned"]),
});
const uncertaintySchema = Schema.Struct({
  expected: Schema.NullOr(retainedSnapshotSchema),
  selection: Schema.NullOr(selectionSchema),
  allocation: Schema.NullOr(PiManagedProcessAllocationSchema),
  owner: Schema.NullOr(ownerSchema),
  drain: Schema.NullOr(drainSchema),
  reconciliation: Schema.NullOr(reconciliationSchema),
  reason: Schema.String,
});
const rowSchema = Schema.Struct({
  setup_id: id,
  dispatch_id: id,
  unit: Schema.NullOr(id),
  selection_json: Schema.String,
  allocation_json: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "selected",
    "no-script",
    "allocated",
    "claimed",
    "captured",
    "completed",
    "failed",
    "uncertain",
  ]),
  owner_json: Schema.NullOr(Schema.String),
  drain_json: Schema.NullOr(Schema.String),
  input_json: Schema.NullOr(Schema.String),
  activation: Schema.Literals(["unlaunched", "claimed", "owned"]),
  started_pid: Schema.NullOr(positive),
  receipt_json: Schema.NullOr(Schema.String),
  uncertainty_json: Schema.NullOr(Schema.String),
});
const strict = { onExcessProperty: "error" } as const;
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeInput = Schema.decodeUnknownEffect(inputSchema, strict);
const decodeRow = Schema.decodeUnknownEffect(rowSchema, strict);
const decodeInputJson = Schema.decodeUnknownEffect(Schema.fromJsonString(inputSchema), strict);
const decodeSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(selectionSchema), strict);
const decodeAllocation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PiManagedProcessAllocationSchema),
  strict,
);
const decodeOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(ownerSchema), strict);
const decodeDrain = Schema.decodeUnknownEffect(Schema.fromJsonString(drainSchema), strict);
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(receiptSchema), strict);
const decodeUncertainty = Schema.decodeUnknownEffect(
  Schema.fromJsonString(uncertaintySchema),
  strict,
);
const decodeSelectionValue = Schema.decodeUnknownEffect(selectionSchema, strict);
const decodeAllocationValue = Schema.decodeUnknownEffect(PiManagedProcessAllocationSchema, strict);
const decodeOwnerValue = Schema.decodeUnknownEffect(ownerSchema, strict);
const decodeReceiptValue = Schema.decodeUnknownEffect(receiptSchema, strict);
const decodeUncertaintyValue = Schema.decodeUnknownEffect(uncertaintySchema, strict);
const isSetupError = Schema.is(ProjectManagedSetupError);
const failure = (reason: string) => new ProjectManagedSetupError({ reason });
const same = NodeUtil.isDeepStrictEqual;
const bounded = (value: unknown) =>
  Effect.try({
    try: () => {
      const json = encode(value);
      if (Buffer.byteLength(json) > 262144)
        throw failure("Setup evidence exceeds its storage bound");
      return json;
    },
    catch: () => failure("Setup evidence cannot be retained within its storage bound"),
  });
const identityConsistent = (value: { readonly dev: number; readonly ino: number }) =>
  Number.isSafeInteger(value.dev) &&
  value.dev >= 0 &&
  Number.isSafeInteger(value.ino) &&
  value.ino > 0;
const allocationConsistent = (a: PiManagedProcessAllocation) =>
  a.unit === `t3-pi-managed-${a.nonce}.service` &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.nonce) &&
  a.policy.memoryBytes === a.launch.memoryBytes &&
  a.policy.runtimeSeconds === a.launch.runtimeSeconds &&
  Number.isSafeInteger(a.launch.memoryBytes) &&
  a.launch.memoryBytes >= 16777216 &&
  a.launch.memoryBytes <= 2147483648 &&
  Number.isSafeInteger(a.launch.runtimeSeconds) &&
  a.launch.runtimeSeconds >= 1 &&
  a.launch.runtimeSeconds <= 3600 &&
  a.launch.workspace.path === a.launch.workspaceRoot &&
  identityConsistent(a.launch.workspace) &&
  (a.launch.nativeState === undefined || identityConsistent(a.launch.nativeState)) &&
  a.launch.protectedRoots.length > 0 &&
  a.launch.protectedRoots.length <= 64 &&
  a.launch.protectedWorkspaceEntries.length <= 16 &&
  a.launch.protectedWorkspaceEntries.every(identityConsistent) &&
  a.launch.runtimeFiles.length > 0 &&
  a.launch.runtimeFiles.length <= 256 &&
  a.launch.runtimeFiles.every(identityConsistent) &&
  a.launch.argv.length > 0 &&
  a.launch.argv.length <= 256 &&
  !a.launch.argv.some((arg) => arg.includes("\0")) &&
  Buffer.byteLength(encode(a.launch.argv)) <= 16384;
const allocationMatchesSelection = (
  selection: typeof selectionSchema.Type,
  allocation: PiManagedProcessAllocation,
) =>
  selection.kind === "script" &&
  selection.cwd === allocation.launch.workspaceRoot &&
  selection.launch.workspaceRoot === allocation.launch.workspaceRoot &&
  (selection.launch.workspaceAccess ?? "readwrite") ===
    (allocation.launch.workspaceAccess ?? "readwrite") &&
  selection.launch.nativeStateRoot === allocation.launch.nativeStateRoot &&
  selection.launch.memoryBytes === allocation.launch.memoryBytes &&
  selection.launch.runtimeSeconds === allocation.launch.runtimeSeconds &&
  same(selection.launch.argv, allocation.launch.argv) &&
  same(selection.launch.protectedRoots, allocation.launch.protectedRoots) &&
  same(
    selection.launch.runtimeFiles,
    allocation.launch.runtimeFiles.map(({ source, target }) => ({ source, target })),
  ) &&
  same(
    selection.launch.protectedWorkspaceEntries ?? [],
    allocation.launch.protectedWorkspaceEntries.map(({ target }) =>
      target.slice("/workspace/".length),
    ),
  ) &&
  allocation.launch.protectedWorkspaceEntries.every(
    ({ source, target }) =>
      target.startsWith("/workspace/") &&
      source === allocation.launch.workspaceRoot + target.slice("/workspace".length),
  );
const ownerConsistent = (owner: PiManagedProcessOwner, allocation: PiManagedProcessAllocation) =>
  owner.unit === allocation.unit &&
  owner.nonce === allocation.nonce &&
  owner.memoryBytes === allocation.policy.memoryBytes &&
  owner.swapBytes === 0 &&
  owner.oomGroup === 1 &&
  /^[a-f0-9]{32}$/.test(owner.invocation) &&
  owner.pid <= 2147483647 &&
  owner.cgroup.startsWith("/sys/fs/cgroup/") &&
  owner.cgroup.endsWith(`/${allocation.unit}`) &&
  !owner.cgroup.split("/").some((part) => part === "." || part === "..");

// Cleanup may lack a recovered start or child exit. Two known child identities must agree.
const receiptMatchesStart = (receipt: typeof receiptSchema.Type, startedPid: number | null) =>
  (startedPid === null ||
    receipt.drain?.childPid == null ||
    receipt.drain.childPid === startedPid) &&
  (receipt.outcome !== "succeeded" ||
    (startedPid !== null && receipt.drain?.childPid === startedPid)) &&
  (receipt.outcome !== "skipped" || startedPid === null);
const receiptStatus = (receipt: typeof receiptSchema.Type) =>
  receipt.outcome === "skipped"
    ? "no-script"
    : receipt.outcome === "succeeded"
      ? "completed"
      : "failed";

/** One authoritative SQL journal supplies setup persistence; native execution remains the isolated owner. */
export const makeProjectManagedSetupJournal = Effect.fn("makeProjectManagedSetupJournal")(
  function* (options: {
    readonly environmentId: string;
    readonly maximumEnvironmentModelCalls: number;
    readonly validateSelection: ProjectManagedSetupPorts["validateCurrent"];
  }) {
    const sql = yield* SqlClient.SqlClient;
    const clock = yield* Clock.Clock;
    const dispatch = yield* makeProjectTeamDispatchJournal(options);
    const read = Effect.fn("ProjectManagedSetupJournal.read")(function* (
      raw: ProjectManagedSetupInput,
    ) {
      const input = yield* decodeInput(raw);
      const rows = yield* sql`SELECT setup.* FROM project_team_setup_process setup
      JOIN project_team_dispatch dispatch ON dispatch.dispatch_id=setup.dispatch_id
      WHERE setup.setup_id=${input.setupId} AND dispatch.environment_id=${options.environmentId}`;
      if (!rows[0]) return null;
      if (rows.length !== 1) return yield* failure("Setup identity is ambiguous");
      const row = yield* decodeRow(rows[0]);
      if (!row.input_json)
        return yield* failure(
          "Legacy setup retains cleanup knowledge; launch input is unavailable",
        );
      if (
        row.dispatch_id !== input.dispatchId ||
        !same(yield* decodeInputJson(row.input_json), input)
      )
        return yield* failure("Setup input does not match its original assignment");
      const selection = yield* decodeSelection(row.selection_json);
      const allocation =
        row.allocation_json === null ? null : yield* decodeAllocation(row.allocation_json);
      const owner = row.owner_json === null ? null : yield* decodeOwner(row.owner_json);
      const receipt = row.receipt_json === null ? null : yield* decodeReceipt(row.receipt_json);
      const uncertainty =
        row.uncertainty_json === null ? null : yield* decodeUncertainty(row.uncertainty_json);
      if (
        allocation &&
        (!allocationConsistent(allocation) ||
          !allocationMatchesSelection(selection, allocation) ||
          row.unit !== allocation.unit)
      )
        return yield* failure("Retained setup allocation is inconsistent");
      if (
        owner &&
        (!allocation || row.activation !== "owned" || !ownerConsistent(owner, allocation))
      )
        return yield* failure("Retained setup owner is inconsistent");
      const retained: ProjectManagedSetupRetained = {
        selection,
        allocation,
        owner,
        receipt,
        activation: row.activation,
        uncertain: row.status === "uncertain" || row.uncertainty_json !== null,
      };
      if (
        receipt &&
        (!isProjectManagedSetupReceiptValid(retained) ||
          !receiptMatchesStart(receipt, row.started_pid) ||
          (row.status !== "uncertain" && row.status !== receiptStatus(receipt)))
      )
        return yield* failure("Retained setup receipt contradicts its recorded lifecycle");
      if (
        row.drain_json !== null &&
        (!receipt?.drain || !same(yield* decodeDrain(row.drain_json), receipt.drain))
      )
        return yield* failure("Retained setup drain copies contradict one another");
      return { row, retained, uncertainty };
    });
    const current = Effect.fn("ProjectManagedSetupJournal.current")(function* (
      raw: ProjectManagedSetupInput,
      selection: Parameters<ProjectManagedSetupPorts["validateCurrent"]>[1],
      phase: Parameters<ProjectManagedSetupPorts["validateCurrent"]>[2],
    ) {
      const input = yield* decodeInput(raw);
      const snapshot = yield* dispatch.inspect(input.dispatchId);
      const claim = snapshot.intent.compiledClaim.transition;
      if (
        snapshot.fence.stage !== "workspace-ready" &&
        !(
          phase === "completion" &&
          ["setup-complete", "session-bound", "assignment-intent", "assignment-observed"].includes(
            snapshot.fence.stage,
          )
        )
      )
        return yield* failure("Setup has no admitted durable workspace stage");
      if (
        claim?.kind !== "claim" ||
        snapshot.intent.request.setupId !== input.setupId ||
        snapshot.intent.request.git.runId !== input.bindingId ||
        snapshot.intent.request.git.generation !== input.generation ||
        claim.binding.threadId !== input.threadId ||
        snapshot.intent.request.git.worktreePath !== input.worktreePath ||
        snapshot.intent.limits.deadlineAtMs !== input.deadlineAtMs
      )
        return yield* failure("Setup is not the exact current dispatch");
      yield* options.validateSelection(input, selection, phase);
      yield* dispatch.inspect(input.dispatchId);
      const leases = yield* sql<{
        lease_token: string | null;
        leased_until: string | null;
        state: string;
      }>`
        SELECT attempt.lease_token,attempt.leased_until,attempt.state
        FROM project_work_attempts attempt JOIN project_work_tasks task
          ON task.active_attempt_id=attempt.attempt_id AND task.task_id=attempt.task_id
        WHERE attempt.project_id=${claim.binding.projectId}
          AND attempt.attempt_id=${claim.binding.attemptId} AND attempt.task_id=${claim.binding.taskId}`;
      const lease = leases[0];
      const leaseUntil =
        lease?.leased_until === null || lease?.leased_until === undefined
          ? NaN
          : Date.parse(lease.leased_until);
      const now = clock.currentTimeMillisUnsafe();
      if (
        leases.length !== 1 ||
        !lease ||
        lease.lease_token !== claim.claim.leaseToken ||
        (lease.state !== "leased" && lease.state !== "running") ||
        !Number.isSafeInteger(leaseUntil) ||
        now >= leaseUntil ||
        now >= input.deadlineAtMs
      )
        return yield* failure("Setup lease or deadline expired");
    });
    const freezeSelection = Effect.fn("ProjectManagedSetupJournal.freezeSelection")(function* (
      input: ProjectManagedSetupInput,
      selection: typeof selectionSchema.Type,
    ) {
      const selectionJson = yield* bounded(yield* decodeSelectionValue(selection));
      const inputJson = yield* bounded(yield* decodeInput(input));
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* current(input, selection, "allocation");
          const old = yield* read(input);
          if (old) return old.retained;
          yield* sql`INSERT INTO project_team_setup_process
        (setup_id,dispatch_id,unit,selection_json,allocation_json,status,owner_json,drain_json,
          input_json,activation,started_pid,receipt_json,uncertainty_json)
        VALUES (${input.setupId},${input.dispatchId},NULL,${selectionJson},NULL,
          ${selection.kind === "none" ? "no-script" : "selected"},NULL,NULL,${inputJson},'unlaunched',NULL,NULL,NULL)`;
          return (yield* read(input))!.retained;
        }).pipe(Effect.tap(() => current(input, selection, "allocation"))),
      );
    });
    const freezeAllocation = Effect.fn("ProjectManagedSetupJournal.freezeAllocation")(function* (
      input: ProjectManagedSetupInput,
      selection: typeof selectionSchema.Type,
      raw: PiManagedProcessAllocation,
    ) {
      const allocation = yield* decodeAllocationValue(raw);
      if (!allocationConsistent(allocation) || !allocationMatchesSelection(selection, allocation))
        return yield* failure("Setup allocation does not match the frozen selection");
      const allocationJson = yield* bounded(allocation);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* current(input, selection, "allocation");
          const old = yield* read(input);
          if (!old || !same(old.retained.selection, selection) || selection.kind !== "script")
            return yield* failure("Setup selection was not frozen");
          if (old.retained.allocation) return old.retained;
          if (old.row.status !== "selected" || old.retained.uncertain)
            return yield* failure("Setup allocation requires reconciliation");
          yield* sql`UPDATE project_team_setup_process SET allocation_json=${allocationJson},unit=${allocation.unit},status='allocated'
        WHERE setup_id=${input.setupId} AND status='selected' AND allocation_json IS NULL`;
          return (yield* read(input))!.retained;
        }).pipe(Effect.tap(() => current(input, selection, "allocation"))),
      );
    });
    const claimActivation = Effect.fn("ProjectManagedSetupJournal.claimActivation")(
      function* (
        input: ProjectManagedSetupInput,
        selection: typeof selectionSchema.Type,
        allocation: PiManagedProcessAllocation,
      ) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* current(input, selection, "activation");
            const old = yield* read(input);
            if (
              !old ||
              !same(old.retained.selection, selection) ||
              !same(old.retained.allocation, allocation)
            )
              return yield* failure("Setup activation does not match its frozen allocation");
            if (old.retained.activation !== "unlaunched") return "already-claimed" as const;
            if (old.retained.uncertain || old.retained.receipt || old.row.status !== "allocated")
              return yield* failure("Setup activation is fenced for reconciliation");
            const changed =
              yield* sql`UPDATE project_team_setup_process SET activation='claimed',status='claimed'
        WHERE setup_id=${input.setupId} AND activation='unlaunched' AND status='allocated' RETURNING setup_id`;
            return changed.length === 1 ? ("claimed" as const) : ("already-claimed" as const);
          }).pipe(Effect.tap(() => current(input, selection, "activation"))),
        );
      },
      Effect.mapError(
        (cause) => new PiManagedProcessError({ phase: "validation", message: String(cause) }),
      ),
    );
    const persistOwner = Effect.fn("ProjectManagedSetupJournal.persistOwner")(
      function* (
        input: ProjectManagedSetupInput,
        allocation: PiManagedProcessAllocation,
        raw: Parameters<ProjectManagedSetupPorts["persistOwner"]>[2],
      ) {
        const owner = yield* decodeOwnerValue(raw);
        if (!ownerConsistent(owner, allocation))
          return yield* failure("Setup owner contradicts its frozen allocation");
        const ownerJson = yield* bounded(owner);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Ownership is recorded even if authority was revoked after native allocation.
            const old = yield* read(input);
            if (
              !old ||
              !same(old.retained.allocation, allocation) ||
              old.retained.activation === "unlaunched"
            )
              return yield* failure("Setup owner has no original activation claim");
            if (old.retained.owner) {
              if (!same(old.retained.owner, owner))
                return yield* failure("Setup owner identity was replaced");
              return;
            }
            if (old.retained.receipt || old.retained.uncertain)
              return yield* failure("Setup owner capture requires reconciliation");
            yield* sql`UPDATE project_team_setup_process SET owner_json=${ownerJson},activation='owned',status='captured'
        WHERE setup_id=${input.setupId} AND activation='claimed' AND owner_json IS NULL`;
            if (!same((yield* read(input))?.retained.owner, owner))
              return yield* failure("Setup owner capture did not commit");
          }),
        );
      },
      Effect.mapError(
        (cause) => new PiManagedProcessError({ phase: "validation", message: String(cause) }),
      ),
    );
    const persistStarted = Effect.fn("ProjectManagedSetupJournal.persistStarted")(function* (
      input: ProjectManagedSetupInput,
      allocation: PiManagedProcessAllocation,
      owner: Parameters<ProjectManagedSetupPorts["persistStarted"]>[2],
      childPid: number,
    ) {
      if (!Number.isSafeInteger(childPid) || childPid < 1 || childPid > 2147483647)
        return yield* failure("Setup child PID is invalid");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const old = yield* read(input);
          if (
            !old ||
            old.retained.activation !== "owned" ||
            !same(old.retained.allocation, allocation) ||
            !same(old.retained.owner, owner) ||
            old.retained.receipt ||
            old.retained.uncertain
          )
            return yield* failure("Setup start does not match its retained native owner");
          if (old.row.started_pid !== null && old.row.started_pid !== childPid)
            return yield* failure("Setup native start identity was replaced");
          yield* sql`UPDATE project_team_setup_process SET started_pid=${childPid}
        WHERE setup_id=${input.setupId} AND activation='owned' AND (started_pid IS NULL OR started_pid=${childPid})`;
        }),
      );
    });
    const persistReceipt = Effect.fn("ProjectManagedSetupJournal.persistReceipt")(function* (
      input: ProjectManagedSetupInput,
      raw: Parameters<ProjectManagedSetupPorts["persistReceipt"]>[1],
    ) {
      const receipt = yield* decodeReceiptValue(raw);
      const receiptJson = yield* bounded(receipt);
      const drainJson = receipt.drain === null ? null : yield* bounded(receipt.drain);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const old = yield* read(input);
          if (
            !old ||
            !isProjectManagedSetupReceiptValid({ ...old.retained, receipt }) ||
            !receiptMatchesStart(receipt, old.row.started_pid)
          )
            return yield* failure(
              "Setup completion contradicts retained physical ownership or start",
            );
          if (old.retained.receipt) {
            if (!same(old.retained.receipt, receipt))
              return yield* failure("Setup completion identity was reused");
            return;
          }
          if (receipt.outcome === "succeeded" || receipt.outcome === "skipped") {
            yield* current(input, receipt.selection, "completion");
            if (old.retained.uncertain)
              return yield* failure("Successful setup requires certain retained ownership");
          }
          const status = receiptStatus(receipt);
          yield* sql`UPDATE project_team_setup_process SET receipt_json=${receiptJson},drain_json=${drainJson},status=${status}
        WHERE setup_id=${input.setupId} AND receipt_json IS NULL`;
          if (!same((yield* read(input))?.retained.receipt, receipt))
            return yield* failure("Setup completion receipt did not commit");
        }).pipe(
          Effect.tap(() =>
            receipt.outcome === "succeeded" || receipt.outcome === "skipped"
              ? current(input, receipt.selection, "completion")
              : Effect.void,
          ),
        ),
      );
    });
    const markUncertain = Effect.fn("ProjectManagedSetupJournal.markUncertain")(function* (
      input: ProjectManagedSetupInput,
      held: Parameters<ProjectManagedSetupPorts["markUncertain"]>[1],
    ) {
      const decoded = yield* decodeUncertaintyValue(held);
      const knowledge = yield* bounded(decoded);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const old = yield* read(input);
          if (!old || !held.expected)
            return yield* failure("Uncertainty has no original setup snapshot");
          const { uncertain: _uncertain, ...actual } = old.retained;
          const captured = held.owner === null ? null : yield* decodeOwnerValue(held.owner);
          if (captured && (!actual.allocation || !ownerConsistent(captured, actual.allocation)))
            return yield* failure("Uncertainty does not retain the original native owner");
          // A lost owner-write response may be reconciled only to the exact owner we captured.
          const expected =
            held.owner &&
            held.expected.owner === null &&
            held.expected.activation === "claimed" &&
            same(old.retained.owner, held.owner)
              ? { ...held.expected, owner: held.owner, activation: "owned" as const }
              : held.expected;
          const captureMissingOwner =
            actual.owner === null &&
            actual.activation === "claimed" &&
            captured !== null &&
            held.expected.owner === null;
          if (
            !same(actual, expected) ||
            !same(actual.selection, held.selection) ||
            !same(actual.allocation, held.allocation) ||
            (!same(actual.owner, held.owner) && !captureMissingOwner)
          )
            return yield* failure("Uncertainty snapshot was superseded by another setup owner");
          if (old.row.uncertainty_json !== null) {
            if (old.row.uncertainty_json !== knowledge)
              return yield* failure(
                "Setup uncertainty already retains different cleanup knowledge",
              );
            return;
          }
          const ownerJson = captureMissingOwner ? yield* bounded(captured) : old.row.owner_json;
          yield* sql`UPDATE project_team_setup_process SET status='uncertain',uncertainty_json=${knowledge},
        owner_json=${ownerJson},activation=${captureMissingOwner ? "owned" : old.row.activation}
        WHERE setup_id=${input.setupId} AND uncertainty_json IS NULL`;
        }),
      );
    });
    const setupError = (cause: unknown) => (isSetupError(cause) ? cause : failure(String(cause)));
    return {
      read: (input: ProjectManagedSetupInput) =>
        read(input).pipe(
          Effect.map((value) => value?.retained ?? null),
          Effect.mapError(setupError),
        ),
      validateCurrent: (...args: Parameters<typeof current>) =>
        current(...args).pipe(Effect.mapError(setupError)),
      freezeSelection: (...args: Parameters<typeof freezeSelection>) =>
        freezeSelection(...args).pipe(Effect.mapError(setupError)),
      freezeAllocation: (...args: Parameters<typeof freezeAllocation>) =>
        freezeAllocation(...args).pipe(Effect.mapError(setupError)),
      claimActivation,
      persistOwner,
      persistStarted: (...args: Parameters<typeof persistStarted>) =>
        persistStarted(...args).pipe(Effect.mapError(setupError)),
      persistReceipt: (...args: Parameters<typeof persistReceipt>) =>
        persistReceipt(...args).pipe(Effect.mapError(setupError)),
      markUncertain: (...args: Parameters<typeof markUncertain>) =>
        markUncertain(...args).pipe(Effect.mapError(setupError)),
      readOwnership: (input: ProjectManagedSetupInput) =>
        read(input).pipe(
          Effect.map((value) =>
            value === null
              ? null
              : {
                  retained: value.retained,
                  startedPid: value.row.started_pid,
                  uncertainty: value.uncertainty,
                },
          ),
          Effect.mapError(setupError),
        ),
    };
  },
  Effect.mapError((cause) => failure(String(cause))),
);
