import {
  canonicalProjectWorkPayload,
  ProjectVerificationJobManifest,
  ProjectTeamGate,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  PiManagedProcessAllocationSchema,
  PiManagedProcessError,
  type PiManagedProcessPersistence,
  type PiManagedProcessReconciliation,
} from "../provider/pi/PiManagedProcess.ts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { makeProjectTaskResources } from "./ProjectTaskResources.ts";
import { ProjectWorkArtifactApplicability } from "./ProjectWorkArtifacts.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import {
  assertVerificationEvidence,
  prepareVerificationEvidence,
} from "./ProjectWorkVerificationEvidence.ts";

const strict = { onExcessProperty: "error" as const };
const Id = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter((s) => !s.includes("\0")),
);
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Signed = Schema.Int.check(
  Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
);
const Text = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter((s) => !s.includes("\0")),
);
export const verificationExecutionHash = (input: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(input)).digest("hex");
const bytesHash = (input: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(input).digest("hex");
const same = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);
const freeze = <A>(input: A): A => {
  if (input !== null && typeof input === "object") {
    for (const value of Object.values(input)) freeze(value);
    Object.freeze(input);
  }
  return input;
};
export class ProjectWorkVerificationExecutionError extends Schema.TaggedError<ProjectWorkVerificationExecutionError>()(
  "ProjectWorkVerificationExecutionError",
  { reason: Schema.String },
) {}
const deny = (reason: string) => new ProjectWorkVerificationExecutionError({ reason });
function capture<A>(decode: (input: unknown) => A, input: unknown): A {
  const owned: unknown = structuredClone(input);
  const value = decode(owned);
  if (!same(owned, value)) throw deny("Verification input changed during decoding");
  return freeze(value);
}
const Receipt = Schema.Struct({ manifest: ProjectVerificationJobManifest, sha256: Digest });
export const ProjectWorkVerificationExecutionSelection = Schema.Struct({
  receipt: Receipt,
  gate: ProjectTeamGate,
});
export const ProjectWorkVerificationExecutionIntent = Schema.Struct({
  ...ProjectWorkVerificationExecutionSelection.fields,
  allocation: PiManagedProcessAllocationSchema,
  deadlineAtMs: Safe,
}).check(
  Schema.makeFilter((value) => Buffer.byteLength(canonicalProjectWorkPayload(value)) <= 262144),
);
export type VerificationExecutionIntent = typeof ProjectWorkVerificationExecutionIntent.Type;
const decodeId = Schema.decodeUnknownSync(Id);
const decodeIntent = Schema.decodeUnknownSync(ProjectWorkVerificationExecutionIntent, strict);
export const VerificationExecutionOwner = Schema.Struct({
  type: Schema.Literal("owner"),
  unit: Id,
  invocation: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  cgroup: Text,
  pid: Safe.check(Schema.isGreaterThanOrEqualTo(1)),
  memoryBytes: Safe,
  swapBytes: Safe,
  oomGroup: Safe,
  nonce: Id,
});
export const VerificationExecutionDrain = Schema.Struct({
  unit: Id,
  invocation: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  cgroup: Text,
  ownerPid: Schema.NullOr(Safe.check(Schema.isGreaterThanOrEqualTo(1))),
  memoryBytes: Safe,
  swapBytes: Safe,
  oomGroup: Safe,
  launcherPid: Safe.check(Schema.isGreaterThanOrEqualTo(1)),
  childPid: Schema.NullOr(Safe.check(Schema.isGreaterThanOrEqualTo(1))),
  childExitCode: Schema.NullOr(Signed),
  kernel: Text,
});
const ArtifactReceipt = Schema.Struct({
  artifactId: Id,
  sourceId: Id,
  applicability: ProjectWorkArtifactApplicability,
  sha256: Digest,
  byteCount: Safe.check(Schema.isLessThanOrEqualTo(1048576)),
});
export const ProjectWorkVerificationExecutionResult = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Id,
  attemptId: Id,
  manifestHash: Digest,
  allocationHash: Digest,
  outcome: Schema.Literals([
    "success",
    "failed",
    "timed-out",
    "overflow",
    "canceled",
    "revoked",
    "abandoned",
  ]),
  exitCode: Schema.NullOr(Signed),
  outputComplete: Schema.Boolean,
  stdout: ArtifactReceipt,
  stderr: ArtifactReceipt,
  drain: Schema.NullOr(VerificationExecutionDrain),
  reconciliation: Schema.optionalKey(Schema.Struct({ unit: Id, nonce: Id, kernel: Text })),
  drainHash: Digest,
  environmentSummary: Text.check(Schema.isMinLength(1)),
  finishedAtMs: Safe,
}).check(
  Schema.makeFilter((value) => Buffer.byteLength(canonicalProjectWorkPayload(value)) <= 65536),
);
export type RetainedVerificationResult = typeof ProjectWorkVerificationExecutionResult.Type;
const decodeResult = Schema.decodeUnknownSync(ProjectWorkVerificationExecutionResult, strict);
export interface VerificationClaim {
  readonly attemptId: string;
  readonly intent: VerificationExecutionIntent;
}
export type VerificationClaimOutcome =
  | { readonly _tag: "Claimed"; readonly claim: VerificationClaim }
  | { readonly _tag: "Active" }
  | { readonly _tag: "Retained"; readonly result: RetainedVerificationResult }
  | { readonly _tag: "Uncertain"; readonly reason: string };
export interface VerificationExecutionSnapshot {
  readonly rowId: string;
  readonly attemptId: string;
  readonly intent: VerificationExecutionIntent;
  readonly phase: "claimed" | "activating" | "owner-captured" | "terminal" | "quarantine";
  readonly owner: typeof VerificationExecutionOwner.Type | null;
  readonly result: RetainedVerificationResult | null;
  readonly reason: string | null;
}
interface Options {
  readonly environmentId: string;
  readonly assertCurrent: (
    intent: VerificationExecutionIntent,
    state: ProjectWorkReducerState,
    phase: "approved" | "consumed",
    attemptId: string,
  ) => Effect.Effect<void, ProjectWorkVerificationExecutionError, SqlClient.SqlClient>;
  readonly consumeApproval: (
    intent: VerificationExecutionIntent,
    attemptId: string,
    state: ProjectWorkReducerState,
  ) => Effect.Effect<
    readonly ProjectWorkCommand[],
    ProjectWorkVerificationExecutionError,
    SqlClient.SqlClient
  >;
  readonly verifyResult: (
    intent: VerificationExecutionIntent,
    result: RetainedVerificationResult,
  ) => Effect.Effect<void, ProjectWorkVerificationExecutionError>;
}
const Row = Schema.Struct({
  row_id: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u)),
  environment_id: Id,
  job_id: Id,
  project_id: Id,
  task_id: Id,
  attempt_id: Id,
  manifest_hash: Digest,
  gate_id: Id,
  gate_revision: Safe,
  intent_json: Schema.String,
  intent_hash: Digest,
  allocation_hash: Digest,
  deadline_at_ms: Safe,
  phase: Schema.Literals(["claimed", "activating", "owner-captured", "terminal", "quarantine"]),
  revision: Safe,
  owner_json: Schema.NullOr(Schema.String),
  result_json: Schema.NullOr(Schema.String),
  result_hash: Schema.NullOr(Digest),
  reason: Schema.NullOr(Text),
});
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(Row).check(Schema.isMaxLength(1)),
  strict,
);
const decodeOwner = Schema.decodeUnknownSync(VerificationExecutionOwner, strict);
const decodeStoredIntent = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProjectWorkVerificationExecutionIntent),
  strict,
);
const decodeStoredResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProjectWorkVerificationExecutionResult),
  strict,
);
const decodeStoredOwner = Schema.decodeUnknownSync(
  Schema.fromJsonString(VerificationExecutionOwner),
  strict,
);

const applicability = (intent: VerificationExecutionIntent, result: RetainedVerificationResult) => {
  const job = intent.receipt.manifest;
  return {
    projectId: job.projectId,
    taskId: job.taskId,
    specRevision: job.specRevision,
    planRevision: job.planRevision,
    repository: job.target.repository,
    worktree: job.target.worktree,
    testedTree: job.target.testedTree,
    testedCommit: job.target.testedCommit,
    baseSha: job.target.baseSha,
    headSha: job.target.headSha,
    command: canonicalProjectWorkPayload({
      executable: job.command.executable,
      argv: job.command.argv,
    }),
    exitCode: result.exitCode ?? -1,
    environmentSummary: result.environmentSummary,
    integration: job.integration === true,
  };
};
const validateResult = (
  value: VerificationExecutionSnapshot,
  result: RetainedVerificationResult,
) => {
  const intent = value.intent;
  const allocation = intent.allocation;
  const drain = result.drain;
  if (
    result.jobId !== intent.receipt.manifest.jobId ||
    result.attemptId !== value.attemptId ||
    result.manifestHash !== intent.receipt.sha256 ||
    result.allocationHash !== verificationExecutionHash(allocation) ||
    result.drainHash !== verificationExecutionHash(drain)
  )
    throw deny("Verification result identity changed");
  if (drain === null) {
    if (
      result.outcome === "success" ||
      result.exitCode !== null ||
      !result.reconciliation ||
      result.reconciliation.unit !== allocation.unit ||
      result.reconciliation.nonce !== allocation.nonce ||
      (result.reconciliation.kernel !== "not-created" &&
        result.reconciliation.kernel !== "removed" &&
        !result.reconciliation.kernel.split("\n").includes("populated 0"))
    )
      throw deny("Verification recovery cannot infer success or an exit");
  } else {
    if (
      result.reconciliation !== undefined ||
      drain.unit !== allocation.unit ||
      drain.memoryBytes !== allocation.policy.memoryBytes ||
      drain.swapBytes !== 0 ||
      drain.oomGroup !== 1 ||
      drain.childExitCode !== result.exitCode ||
      (drain.kernel !== "removed" && !drain.kernel.split("\n").includes("populated 0"))
    )
      throw deny("Verification drain identity changed");
    if (
      value.owner &&
      (drain.invocation !== value.owner.invocation ||
        drain.cgroup !== value.owner.cgroup ||
        drain.ownerPid !== value.owner.pid)
    )
      throw deny("Verification drain does not match its captured owner");
  }
  if (
    result.outcome === "success" &&
    ((value.phase !== "owner-captured" && value.phase !== "terminal") ||
      !value.owner ||
      !drain ||
      drain.ownerPid === null ||
      drain.childPid === null ||
      !result.outputComplete ||
      result.exitCode !== 0 ||
      result.finishedAtMs >= intent.deadlineAtMs)
  )
    throw deny("Verification success requires an owned exact completed drain");
};
const makeVerificationExecutionStorage = (sql: SqlClient.SqlClient, environmentId: string) => {
  const read = Effect.fn("VerificationExecutionJournal.read")(function* (jobId: string) {
    const rows =
      yield* sql`SELECT CAST(rowid AS TEXT) AS row_id,environment_id,job_id,project_id,task_id,attempt_id,manifest_hash,gate_id,gate_revision,
      CASE WHEN length(CAST(intent_json AS BLOB))<=262144 THEN intent_json END AS intent_json,intent_hash,allocation_hash,deadline_at_ms,phase,revision,
      CASE WHEN length(CAST(owner_json AS BLOB))<=16384 THEN owner_json END AS owner_json,
      CASE WHEN length(CAST(result_json AS BLOB))<=65536 THEN result_json END AS result_json,result_hash,reason
      FROM project_work_verification_execution WHERE environment_id=${environmentId} AND job_id=${jobId} LIMIT 2`;
    const decoded = yield* decodeRows(rows).pipe(
      Effect.mapError(() => deny("Corrupt verification execution row")),
    );
    const row = decoded[0];
    if (!row) return undefined;
    return yield* Effect.try({
      try: () => {
        const intent = freeze(decodeStoredIntent(row.intent_json));
        const result =
          row.result_json === null ? null : freeze(decodeStoredResult(row.result_json));
        const owner = row.owner_json === null ? null : freeze(decodeStoredOwner(row.owner_json));
        if (
          row.environment_id !== environmentId ||
          row.job_id !== jobId ||
          intent.receipt.manifest.environmentId !== environmentId ||
          intent.receipt.manifest.jobId !== jobId ||
          intent.receipt.manifest.projectId !== row.project_id ||
          intent.receipt.manifest.taskId !== row.task_id ||
          intent.receipt.sha256 !== row.manifest_hash ||
          verificationExecutionHash(intent.receipt.manifest) !== row.manifest_hash ||
          intent.gate.recordId !== row.gate_id ||
          intent.gate.revision !== row.gate_revision ||
          intent.deadlineAtMs !== row.deadline_at_ms ||
          canonicalProjectWorkPayload(intent) !== row.intent_json ||
          verificationExecutionHash(intent) !== row.intent_hash ||
          verificationExecutionHash(intent.allocation) !== row.allocation_hash ||
          (result !== null &&
            (canonicalProjectWorkPayload(result) !== row.result_json ||
              verificationExecutionHash(result) !== row.result_hash ||
              result.attemptId !== row.attempt_id ||
              result.jobId !== jobId ||
              result.manifestHash !== row.manifest_hash ||
              result.allocationHash !== row.allocation_hash)) ||
          (result === null && row.result_hash !== null) ||
          (row.phase === "terminal" && result === null) ||
          (row.phase !== "terminal" && result !== null) ||
          (row.phase === "owner-captured" && owner === null) ||
          (owner !== null &&
            (owner.unit !== intent.allocation.unit || owner.nonce !== intent.allocation.nonce))
        )
          throw deny("Verification execution identity changed");
        const snapshot = freeze({
          rowId: row.row_id,
          attemptId: row.attempt_id,
          intent,
          phase: row.phase,
          owner,
          result,
          reason: row.reason,
        });
        if (result !== null) validateResult(snapshot, result);
        return { row, snapshot };
      },
      catch: () => deny("Corrupt verification execution identity"),
    });
  });
  const verifyArtifacts = Effect.fn("VerificationExecutionJournal.verifyArtifacts")(function* (
    intent: VerificationExecutionIntent,
    result: RetainedVerificationResult,
  ) {
    const expected = applicability(intent, result);
    if (
      result.stdout.byteCount + result.stderr.byteCount >
      intent.receipt.manifest.command.limits.maxOutputBytes
    )
      return yield* deny("Verification output exceeds its approved bound");
    for (const [channel, receipt] of [
      ["stdout", result.stdout],
      ["stderr", result.stderr],
    ] as const) {
      if (
        receipt.artifactId !== result.attemptId + ":" + channel ||
        receipt.sourceId !== result.attemptId ||
        !same(receipt.applicability, expected)
      )
        return yield* deny("Verification artifact applicability changed");
      const rows =
        yield* sql`SELECT environment_id,artifact_id,project_id,task_id,source_id,sha256,byte_count,length(raw_bytes) AS actual_byte_count,typeof(raw_bytes) AS blob_type,
        CASE WHEN length(CAST(manifest_json AS BLOB))<=65536 THEN manifest_json END AS manifest_json,
        CASE WHEN length(raw_bytes)<=${intent.receipt.manifest.command.limits.maxOutputBytes} THEN raw_bytes END AS raw_bytes
        FROM project_work_artifacts WHERE environment_id=${environmentId} AND artifact_id=${receipt.artifactId} LIMIT 2`;
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            environment_id: Id,
            artifact_id: Id,
            project_id: Id,
            task_id: Id,
            source_id: Id,
            sha256: Digest,
            byte_count: Safe,
            actual_byte_count: Safe,
            blob_type: Schema.Literal("blob"),
            manifest_json: Schema.String,
            raw_bytes: Schema.Uint8Array,
          }),
        ).check(Schema.isMaxLength(1)),
        strict,
      )(rows).pipe(Effect.mapError(() => deny("Invalid retained verification artifact")));
      const row = decoded[0];
      if (
        !row ||
        row.environment_id !== environmentId ||
        row.artifact_id !== receipt.artifactId ||
        row.project_id !== expected.projectId ||
        row.task_id !== expected.taskId ||
        row.source_id !== receipt.sourceId ||
        row.sha256 !== receipt.sha256 ||
        row.byte_count !== receipt.byteCount ||
        row.actual_byte_count !== receipt.byteCount ||
        row.raw_bytes.byteLength !== receipt.byteCount ||
        bytesHash(row.raw_bytes) !== receipt.sha256 ||
        row.manifest_json !==
          canonicalProjectWorkPayload({
            artifactId: receipt.artifactId,
            sourceId: receipt.sourceId,
            applicability: expected,
          })
      )
        return yield* deny("Retained verification bytes or manifest changed");
    }
  });
  const readVerified = Effect.fn("VerificationExecutionStorage.readVerified")(function* (
    jobId: string,
  ) {
    const retained = yield* read(jobId);
    if (!retained) return freeze({ _tag: "Missing" as const });
    const { snapshot, row } = retained;
    if (!snapshot.result) return freeze({ _tag: "Pending" as const, snapshot });
    yield* verifyArtifacts(snapshot.intent, snapshot.result);
    return freeze({
      _tag: "Terminal" as const,
      snapshot,
      result: snapshot.result,
      metadata: {
        intentHash: row.intent_hash,
        manifestHash: row.manifest_hash,
        allocationHash: row.allocation_hash,
        resultHash: verificationExecutionHash(snapshot.result),
        revision: row.revision,
      },
    });
  });
  return { read, verifyArtifacts, readVerified };
};
const ResultReaderOptions = Schema.Struct({ environmentId: Id });
const ResultReaderInput = Schema.Struct({ jobId: Id, expectedManifestHash: Digest });
const decodeResultReaderOptions = Schema.decodeUnknownSync(ResultReaderOptions, strict);
const decodeResultReaderInput = Schema.decodeUnknownSync(ResultReaderInput, strict);

/** Historical storage validation inside the caller's transaction grants no execution permission. */
export const makeProjectWorkVerificationResultReader = (input: typeof ResultReaderOptions.Type) => {
  let options: typeof ResultReaderOptions.Type;
  try {
    options = capture(decodeResultReaderOptions, input);
  } catch {
    return Effect.fail(deny("Invalid verification result reader options"));
  }
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const storage = makeVerificationExecutionStorage(sql, options.environmentId);
    const caller = Effect.gen(function* () {
      const client = yield* Effect.serviceOption(SqlClient.SqlClient);
      const suppliedRepository = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(client) ||
        client.value !== sql ||
        Option.isNone(suppliedRepository) ||
        suppliedRepository.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny(
          "Verification result reader requires its original SQL, repository and caller transaction",
        );
    });
    const readInside = Effect.fn("VerificationResultReader.readInside")(function* (
      selected: typeof ResultReaderInput.Type,
    ) {
      const result = yield* storage.readVerified(selected.jobId);
      if (
        result._tag !== "Missing" &&
        result.snapshot.intent.receipt.sha256 !== selected.expectedManifestHash
      )
        return yield* deny("Verification result manifest does not match expected target");
      return result;
    });
    return {
      readInTransaction(input: typeof ResultReaderInput.Type) {
        let selected: typeof ResultReaderInput.Type;
        try {
          selected = capture(decodeResultReaderInput, input);
        } catch {
          return Effect.fail(deny("Invalid retained verification result request"));
        }
        return Effect.andThen(caller, readInside(selected));
      },
    };
  });
};

/** Private exact-job storage; journal-affine claims confer no evidence qualification. */
export function makeProjectWorkVerificationExecutionJournal(input: Options) {
  const options = { ...input, environmentId: decodeId(input.environmentId) };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const taskResources = yield* makeProjectTaskResources(options.environmentId);
    const repository = yield* ProjectWorkRepository;
    const claims = new WeakMap<VerificationClaim, VerificationExecutionIntent>();
    const recovery = new WeakSet<VerificationExecutionSnapshot>();
    const { read, verifyArtifacts, readVerified } = makeVerificationExecutionStorage(
      sql,
      options.environmentId,
    );
    const own = Effect.gen(function* () {
      const client = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isSome(client) && client.value !== sql)
        return yield* deny("Verification SQL client changed");
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* deny("Verification execution must own its SQL transaction");
    });
    const prepared = Effect.fn("VerificationExecutionJournal.prepared")(function* (
      intent: VerificationExecutionIntent,
    ) {
      const job = intent.receipt.manifest;
      const rows =
        yield* sql`SELECT manifest_json,sha256 FROM project_work_verification_jobs WHERE environment_id=${options.environmentId} AND job_id=${job.jobId} AND project_id=${job.projectId} AND task_id=${job.taskId} AND length(CAST(manifest_json AS BLOB))<=65536 LIMIT 2`;
      if (
        rows.length !== 1 ||
        rows[0]?.manifest_json !== canonicalProjectWorkPayload(job) ||
        rows[0]?.sha256 !== intent.receipt.sha256
      )
        return yield* deny("Prepared verification target changed");
    });
    const current = Effect.fn("VerificationExecutionJournal.current")(function* (
      intent: VerificationExecutionIntent,
      attemptId: string,
      phase: "approved" | "consumed",
    ) {
      yield* prepared(intent);
      const state = yield* readCurrentState(sql, intent.receipt.manifest.projectId);
      yield* options.assertCurrent(intent, state, phase, attemptId);
      return state;
    });
    const bind = (attemptId: string, intent: VerificationExecutionIntent) => {
      const claim = freeze({ attemptId, intent });
      claims.set(claim, intent);
      return claim;
    };
    const affinity = (claim: VerificationClaim) =>
      claims.get(claim) === claim.intent
        ? Effect.void
        : Effect.fail(deny("Verification claim does not belong to this journal"));
    const get = Effect.fn("VerificationExecutionJournal.get")(function* (claim: VerificationClaim) {
      yield* affinity(claim);
      const value = yield* read(claim.intent.receipt.manifest.jobId);
      if (
        !value ||
        value.row.attempt_id !== claim.attemptId ||
        !same(value.snapshot.intent, claim.intent)
      )
        return yield* deny("Verification claim changed");
      return value;
    });
    const assertCurrent = Effect.fn("VerificationExecutionJournal.assertCurrent")(function* (
      claim: VerificationClaim,
    ) {
      yield* own;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const value = yield* get(claim);
          if (value.row.phase === "terminal" || value.row.phase === "quarantine")
            return yield* deny("Verification claim is no longer active");
          if ((yield* Clock.currentTimeMillis) >= claim.intent.deadlineAtMs)
            return yield* deny("Verification deadline expired");
          yield* current(claim.intent, claim.attemptId, "consumed");
        }),
      );
    });
    const claim = (input: VerificationExecutionIntent) => {
      let intent: VerificationExecutionIntent;
      try {
        intent = capture(decodeIntent, input);
        const { manifest, sha256 } = intent.receipt;
        const launch = intent.allocation.launch;
        if (
          manifest.environmentId !== options.environmentId ||
          verificationExecutionHash(manifest) !== sha256 ||
          intent.gate.kind !== "gate" ||
          intent.gate.gate !== "verification" ||
          intent.gate.status !== "approved" ||
          intent.gate.projectId !== manifest.projectId ||
          intent.gate.taskId !== manifest.taskId ||
          intent.gate.verificationJobId !== manifest.jobId ||
          intent.gate.contentHash !== sha256 ||
          intent.gate.attribution.actor.kind !== "human" ||
          !same(launch.argv, [manifest.command.executable, ...manifest.command.argv]) ||
          launch.workspaceRoot !== manifest.target.worktree ||
          launch.workspaceAccess !== "readonly" ||
          launch.nativeStateRoot !== undefined ||
          launch.nativeState !== undefined ||
          launch.workspace.path !== manifest.target.worktree ||
          launch.runtimeFiles.filter((f) => f.target === manifest.command.executable).length !==
            1 ||
          launch.protectedRoots.length === 0 ||
          launch.memoryBytes < 16777216 ||
          launch.memoryBytes > 2147483648 ||
          intent.allocation.policy.memoryBytes !== launch.memoryBytes ||
          intent.allocation.policy.runtimeSeconds !== launch.runtimeSeconds ||
          launch.runtimeSeconds !== Math.ceil(manifest.command.limits.maxDurationMs / 1000) ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
            intent.allocation.nonce,
          ) ||
          intent.allocation.unit !== `t3-pi-managed-${intent.allocation.nonce}.service`
        )
          throw deny("Invalid verification launch identity");
      } catch {
        return Effect.fail(deny("Invalid verification execution intent"));
      }
      const attemptId =
        "verification:" +
        verificationExecutionHash({
          environmentId: options.environmentId,
          jobId: intent.receipt.manifest.jobId,
          manifestHash: intent.receipt.sha256,
          allocation: intent.allocation,
        });
      return Effect.gen(function* () {
        yield* own;
        let outcome: VerificationClaimOutcome | undefined;
        yield* repository.executeAtomic(
          Effect.gen(function* () {
            const existing = yield* read(intent.receipt.manifest.jobId);
            if (existing) {
              if (
                existing.row.manifest_hash !== intent.receipt.sha256 ||
                existing.row.project_id !== intent.receipt.manifest.projectId ||
                existing.row.task_id !== intent.receipt.manifest.taskId ||
                existing.row.gate_id !== intent.gate.recordId ||
                existing.row.gate_revision !== intent.gate.revision
              )
                return yield* deny("Verification job already has a different immutable attempt");
              outcome = existing.snapshot.result
                ? { _tag: "Retained", result: existing.snapshot.result }
                : existing.row.phase === "quarantine"
                  ? {
                      _tag: "Uncertain",
                      reason:
                        existing.row.reason ?? "Retained verification requires reconciliation",
                    }
                  : { _tag: "Active" };
              return [];
            }
            const now = yield* Clock.currentTimeMillis;
            if (
              intent.deadlineAtMs <= now ||
              intent.deadlineAtMs - now > intent.receipt.manifest.command.limits.maxDurationMs
            )
              return yield* deny("Invalid verification deadline");
            yield* current(intent, attemptId, "approved");
            const job = intent.receipt.manifest;
            yield* sql`INSERT INTO project_work_verification_execution(environment_id,job_id,project_id,task_id,attempt_id,manifest_hash,gate_id,gate_revision,intent_json,intent_hash,allocation_hash,deadline_at_ms,phase,revision) VALUES(${options.environmentId},${job.jobId},${job.projectId},${job.taskId},${attemptId},${intent.receipt.sha256},${intent.gate.recordId},${intent.gate.revision},${canonicalProjectWorkPayload(intent)},${verificationExecutionHash(intent)},${verificationExecutionHash(intent.allocation)},${intent.deadlineAtMs},'claimed',0)`;
            return yield* options.consumeApproval(
              intent,
              attemptId,
              yield* readCurrentState(sql, job.projectId),
            );
          }),
          Effect.gen(function* () {
            if (outcome !== undefined) return;
            yield* current(intent, attemptId, "consumed");
            const retained = yield* read(intent.receipt.manifest.jobId);
            if (
              !retained ||
              retained.row.phase !== "claimed" ||
              !same(retained.snapshot.intent, intent)
            )
              return yield* deny("Verification claim did not persist its exact allocation");
          }),
        );
        return outcome ?? { _tag: "Claimed" as const, claim: bind(attemptId, intent) };
      });
    };
    const capturedSql = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.andThen(own, work.pipe(Effect.provideService(SqlClient.SqlClient, sql)));
    const persistence = (claim: VerificationClaim): PiManagedProcessPersistence => ({
      allocation: claim.intent.allocation,
      deadlineAtMs: claim.intent.deadlineAtMs,
      afterDrain: (drain) =>
        sql
          .withTransaction(
            taskResources
              .verification(claim.attemptId, claim.intent.allocation)
              .cleanupDrain(drain),
          )
          .pipe(
            Effect.mapError(
              (cause) => new PiManagedProcessError({ phase: "quarantine", message: String(cause) }),
            ),
          ),
      claimActivation: (allocation) => {
        let captured: typeof PiManagedProcessAllocationSchema.Type;
        try {
          captured = capture(
            Schema.decodeUnknownSync(PiManagedProcessAllocationSchema, strict),
            allocation,
          );
        } catch {
          return Effect.fail(
            new PiManagedProcessError({
              phase: "startup",
              message: "Invalid verification activation",
            }),
          );
        }
        return Effect.gen(function* () {
          yield* own;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const value = yield* get(claim);
              yield* taskResources.verification(claim.attemptId, captured).reserve;
              if (value.row.phase !== "claimed" || !same(captured, claim.intent.allocation))
                return yield* deny("Verification allocation already activated or changed");
              if ((yield* Clock.currentTimeMillis) >= claim.intent.deadlineAtMs)
                return yield* deny("Verification deadline expired");
              yield* current(claim.intent, claim.attemptId, "consumed");
              const changed =
                yield* sql`UPDATE project_work_verification_execution SET phase='activating',revision=revision+1 WHERE environment_id=${options.environmentId} AND job_id=${claim.intent.receipt.manifest.jobId} AND phase='claimed' AND revision=${value.row.revision} RETURNING job_id`;
              if (changed.length !== 1)
                return yield* deny("Verification activation was not persisted");
              yield* current(claim.intent, claim.attemptId, "consumed");
              const retained = yield* get(claim);
              if (
                retained.row.phase !== "activating" ||
                retained.row.revision !== value.row.revision + 1
              )
                return yield* deny("Verification activation changed before permission returned");
            }),
          );
        }).pipe(
          capturedSql,
          Effect.mapError(
            () =>
              new PiManagedProcessError({
                phase: "startup",
                message: "Verification activation denied",
              }),
          ),
        );
      },
      beforeStart: (input) => {
        let owner: typeof VerificationExecutionOwner.Type;
        try {
          owner = capture(decodeOwner, input);
        } catch {
          return Effect.fail(
            new PiManagedProcessError({ phase: "startup", message: "Invalid verification owner" }),
          );
        }
        return Effect.gen(function* () {
          yield* own;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const value = yield* get(claim);
              const allocation = claim.intent.allocation;
              if (
                value.row.phase !== "activating" ||
                owner.unit !== allocation.unit ||
                owner.nonce !== allocation.nonce ||
                owner.memoryBytes !== allocation.policy.memoryBytes ||
                owner.swapBytes !== 0 ||
                owner.oomGroup !== 1 ||
                !owner.cgroup.startsWith("/sys/fs/cgroup/") ||
                !owner.cgroup.endsWith("/" + owner.unit) ||
                owner.cgroup.split("/").some((part) => part === "." || part === "..")
              )
                return yield* deny("Verification owner changed");
              yield* current(claim.intent, claim.attemptId, "consumed");
              if ((yield* Clock.currentTimeMillis) >= claim.intent.deadlineAtMs)
                return yield* deny("Verification deadline expired");
              yield* taskResources.verification(claim.attemptId, allocation).capture(owner);
              const changed =
                yield* sql`UPDATE project_work_verification_execution SET phase='owner-captured',owner_json=${canonicalProjectWorkPayload(owner)},revision=revision+1 WHERE environment_id=${options.environmentId} AND job_id=${claim.intent.receipt.manifest.jobId} AND phase='activating' AND revision=${value.row.revision} RETURNING job_id`;
              if (changed.length !== 1) return yield* deny("Verification owner was not persisted");
              yield* current(claim.intent, claim.attemptId, "consumed");
              const retained = yield* get(claim);
              if (
                retained.row.phase !== "owner-captured" ||
                retained.row.revision !== value.row.revision + 1 ||
                !same(retained.snapshot.owner, owner)
              )
                return yield* deny("Verification owner changed before permission returned");
            }),
          );
        }).pipe(
          capturedSql,
          Effect.mapError(
            () =>
              new PiManagedProcessError({
                phase: "startup",
                message: "Verification owner persistence denied",
              }),
          ),
        );
      },
    });
    const readResult = (input: string) => {
      let jobId: string;
      try {
        jobId = capture(Schema.decodeUnknownSync(Id), input);
      } catch {
        return Effect.fail(deny("Invalid verification job ID"));
      }
      return Effect.andThen(
        own,
        sql.withTransaction(
          readVerified(jobId).pipe(
            Effect.map((value) => (value._tag === "Terminal" ? value.result : undefined)),
          ),
        ),
      );
    };
    const readRecoveryPage = (input: { readonly afterRowId?: string; readonly limit: number }) => {
      let selected: { readonly afterRowId?: string; readonly limit: number };
      try {
        selected = capture(
          Schema.decodeUnknownSync(
            Schema.Struct({
              afterRowId: Schema.optionalKey(
                Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u)),
              ),
              limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
            }),
            strict,
          ),
          input,
        );
      } catch {
        return Effect.fail(deny("Invalid verification recovery cursor"));
      }
      return Effect.andThen(
        own,
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              job_id: string;
              row_id: string;
            }>`SELECT job_id,CAST(rowid AS TEXT) AS row_id FROM project_work_verification_execution WHERE environment_id=${options.environmentId} AND phase!='terminal' AND rowid>CAST(${selected.afterRowId ?? "0"} AS INTEGER) ORDER BY rowid LIMIT ${selected.limit + 1}`;
            const snapshots: VerificationExecutionSnapshot[] = [];
            for (const row of rows.slice(0, selected.limit)) {
              const retained = yield* read(row.job_id);
              if (!retained || retained.row.row_id !== row.row_id)
                return yield* deny("Verification recovery position changed");
              snapshots.push(retained.snapshot);
              recovery.add(retained.snapshot);
            }
            return {
              items: snapshots,
              next: rows.length > selected.limit ? rows[selected.limit - 1]!.row_id : undefined,
            };
          }),
        ),
      );
    };
    const complete = (claim: VerificationClaim, input: RetainedVerificationResult) => {
      let result: RetainedVerificationResult;
      try {
        result = capture(decodeResult, input);
      } catch {
        return Effect.fail(deny("Invalid verification result"));
      }
      return Effect.gen(function* () {
        yield* own;
        yield* affinity(claim);
        let evidence: ReturnType<typeof prepareVerificationEvidence> | undefined;
        yield* repository.executeAtomic(
          Effect.gen(function* () {
            const retained = yield* get(claim);
            yield* Effect.try({
              try: () => validateResult(retained.snapshot, result),
              catch: () => deny("Verification result does not match its exact owner and target"),
            });
            yield* verifyArtifacts(claim.intent, result);
            if (retained.snapshot.result) {
              if (!same(retained.snapshot.result, result))
                return yield* deny("Verification terminal winner cannot change");
              return [];
            }
            yield* options.verifyResult(claim.intent, result);
            if (retained.snapshot.owner && result.drain)
              yield* taskResources
                .verification(claim.attemptId, claim.intent.allocation)
                .cleanupDrain(result.drain);
            if (result.outcome === "success") {
              const state = yield* current(claim.intent, claim.attemptId, "consumed");
              evidence = yield* Effect.try({
                try: () => prepareVerificationEvidence(state, claim.intent, result),
                catch: () => deny("Verification evidence cannot qualify this result"),
              });
            }
            const changed =
              yield* sql`UPDATE project_work_verification_execution SET phase='terminal',result_json=${canonicalProjectWorkPayload(result)},result_hash=${verificationExecutionHash(result)},revision=revision+1 WHERE environment_id=${options.environmentId} AND job_id=${result.jobId} AND attempt_id=${claim.attemptId} AND phase=${retained.row.phase} AND revision=${retained.row.revision} RETURNING job_id`;
            if (changed.length !== 1)
              return yield* deny("Verification result owner was superseded");
            return evidence ? [evidence.evidence, evidence.applicability] : [];
          }),
          Effect.gen(function* () {
            yield* verifyArtifacts(claim.intent, result);
            if (result.outcome === "success") {
              yield* options.verifyResult(claim.intent, result);
              const state = yield* current(claim.intent, claim.attemptId, "consumed");
              if (evidence) {
                const prepared = evidence;
                yield* Effect.try({
                  try: () => assertVerificationEvidence(state, prepared, claim.intent, result),
                  catch: () => deny("Verification evidence did not persist exactly"),
                });
              }
            }
            const retained = yield* get(claim);
            if (!same(retained.snapshot.result, result))
              return yield* deny("Verification result did not persist exactly");
          }),
        );
        return result;
      });
    };
    const quarantine = Effect.fn("VerificationExecutionJournal.quarantine")(function* (
      claim: VerificationClaim,
      reason: string,
    ) {
      yield* own;
      yield* affinity(claim);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const retained = yield* get(claim);
          if (retained.row.phase === "terminal" || retained.row.phase === "quarantine") return;
          const changed =
            yield* sql`UPDATE project_work_verification_execution SET phase='quarantine',reason=${reason},revision=revision+1 WHERE environment_id=${options.environmentId} AND job_id=${claim.intent.receipt.manifest.jobId} AND attempt_id=${claim.attemptId} AND revision=${retained.row.revision} RETURNING job_id`;
          if (changed.length !== 1) return yield* deny("Verification uncertainty owner changed");
        }),
      );
    });
    const recordUncertain = (claim: VerificationClaim, input: string) => {
      let reason: string;
      try {
        reason = capture(
          Schema.decodeUnknownSync(
            Text.check(
              Schema.isMinLength(1),
              Schema.makeFilter((value) => Buffer.byteLength(value) <= 4096),
            ),
          ),
          input,
        );
      } catch {
        return Effect.fail(deny("Invalid verification uncertainty reason"));
      }
      return quarantine(claim, reason);
    };
    const persistReconciliation = (
      snapshot: VerificationExecutionSnapshot,
      observed: PiManagedProcessReconciliation,
    ) =>
      Effect.gen(function* () {
        if (!recovery.has(snapshot))
          return yield* deny("Verification recovery belongs to another journal");
        yield* own;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const retained = yield* read(snapshot.intent.receipt.manifest.jobId);
            if (!retained || !same(retained.snapshot, snapshot))
              return yield* deny("Verification recovery snapshot changed");
            if (snapshot.owner)
              yield* taskResources
                .verification(snapshot.attemptId, snapshot.intent.allocation)
                .cleanupDrain(observed);
          }),
        );
      });
    const finishRecovery = (
      snapshot: VerificationExecutionSnapshot,
      input: RetainedVerificationResult,
    ) =>
      Effect.gen(function* () {
        if (!recovery.has(snapshot) || input.outcome === "success")
          return yield* deny("Recovery cannot create forward authority or success");
        yield* own;
        const retained = yield* sql.withTransaction(read(snapshot.intent.receipt.manifest.jobId));
        if (!retained || !same(retained.snapshot, snapshot))
          return yield* deny("Verification recovery snapshot changed");
        return yield* complete(bind(snapshot.attemptId, snapshot.intent), input);
      });
    const quarantineRecovery = (snapshot: VerificationExecutionSnapshot, reason: string) =>
      Effect.gen(function* () {
        if (!recovery.has(snapshot))
          return yield* deny("Verification recovery belongs to another journal");
        yield* own;
        const retained = yield* sql.withTransaction(read(snapshot.intent.receipt.manifest.jobId));
        if (!retained || !same(retained.snapshot, snapshot))
          return yield* deny("Verification recovery snapshot changed");
        yield* recordUncertain(bind(snapshot.attemptId, snapshot.intent), reason);
      });
    return {
      claim,
      assertCurrent,
      persistence,
      readResult,
      readRecoveryPage,
      complete,
      recordUncertain,
      finishRecovery,
      persistReconciliation,
      quarantineRecovery,
    };
  });
}

export type VerificationExecutionSelection = typeof ProjectWorkVerificationExecutionSelection.Type;
export type VerificationExecutionJournal = Effect.Success<
  ReturnType<typeof makeProjectWorkVerificationExecutionJournal>
>;
