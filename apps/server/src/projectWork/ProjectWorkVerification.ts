// @effect-diagnostics-next-line nodeBuiltinImport:off -- A durable execution claim needs an opaque server-generated identity.
import * as NodeCrypto from "node:crypto";
import { canonicalProjectWorkPayload, ProjectVerificationJobManifest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ProcessRunner } from "../processRunner.ts";
import {
  captureVerificationExecutable,
  verificationSha256,
} from "./ProjectWorkVerificationExecutable.ts";
import {
  assertVerificationTarget,
  captureVerificationPhysicalValidation,
} from "./ProjectWorkVerificationExecution.ts";
import { ProjectWorkVerificationError, verificationError } from "./ProjectWorkVerificationError.ts";
export { ProjectWorkVerificationError } from "./ProjectWorkVerificationError.ts";

export type VerificationManifestInput = Omit<ProjectVerificationJobManifest, "executable">;
export const VerificationResult = Schema.Struct({
  outcome: Schema.Literals(["success", "failed", "timed-out", "unknown", "stale"]),
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  sha256: Schema.String,
});
export type VerificationResult = typeof VerificationResult.Type;
export interface VerificationReceipt {
  readonly manifest: ProjectVerificationJobManifest;
  readonly manifestHash: string;
  readonly stage: "prepared" | "claimed" | "finished" | "applied";
  readonly claimId?: string;
  readonly result?: VerificationResult;
}
export interface VerificationExecutionAuthority {
  /** Checks current gate approval and exact reducer/V2 provenance under the caller's SQL transaction. */
  readonly assertCurrent: (
    manifest: ProjectVerificationJobManifest,
  ) => Effect.Effect<void, ProjectWorkVerificationError>;
  /** Writes evidence in the same SQL transaction as the application mark. No external effects. */
  readonly applyEvidence: (
    result: VerificationResult,
    manifest: ProjectVerificationJobManifest,
    markApplied: Effect.Effect<void, ProjectWorkVerificationError>,
  ) => Effect.Effect<void, ProjectWorkVerificationError>;
}
export class ProjectWorkVerification extends Context.Service<
  ProjectWorkVerification,
  {
    readonly capture: (
      input: VerificationManifestInput,
      runtimeFiles: ReadonlyArray<string>,
    ) => Effect.Effect<ProjectVerificationJobManifest, ProjectWorkVerificationError>;
    readonly prepare: (
      input: {
        readonly manifest: ProjectVerificationJobManifest;
        readonly runtimeFiles: ReadonlyArray<string>;
      },
      assertCurrent: Effect.Effect<void, ProjectWorkVerificationError>,
    ) => Effect.Effect<VerificationReceipt, ProjectWorkVerificationError>;
    readonly read: (
      projectId: string,
      jobId: string,
    ) => Effect.Effect<Option.Option<VerificationReceipt>, ProjectWorkVerificationError>;
    readonly execute: (
      projectId: string,
      jobId: string,
      authority: VerificationExecutionAuthority,
    ) => Effect.Effect<VerificationReceipt, ProjectWorkVerificationError>;
  }
>()("t3/projectWork/ProjectWorkVerification") {}
interface Row {
  project_id: string;
  job_id: string;
  manifest_hash: string;
  manifest_json: string;
  runtime_files_json: string;
  stage: VerificationReceipt["stage"];
  claim_id: string | null;
  result_json: string | null;
}
const decodeManifestValue = Schema.decodeUnknownSync(ProjectVerificationJobManifest);
const isVerificationError = Schema.is(ProjectWorkVerificationError);
const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProjectVerificationJobManifest),
);
const decodeFiles = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(VerificationResult));
const result = (input: Omit<VerificationResult, "sha256">): VerificationResult => ({
  ...input,
  sha256: verificationSha256(canonicalProjectWorkPayload(input)),
});
const unknownResult = () =>
  result({
    outcome: "unknown",
    exitCode: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
const mapped = (cause: unknown) =>
  isVerificationError(cause) ? cause : verificationError("storage");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runner = yield* ProcessRunner;
  const noTransaction = Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* verificationError("transaction");
  });
  const readRow = Effect.fn("ProjectWorkVerification.readRow")(function* (
    projectId: string,
    jobId: string,
  ) {
    return (yield* sql<Row>`SELECT project_id,job_id,manifest_hash,manifest_json,runtime_files_json,stage,claim_id,result_json FROM t3_workflow_v2_verification_jobs WHERE project_id=${projectId} AND job_id=${jobId}`)[0];
  });
  const receipt = (row: Row): VerificationReceipt => {
    const manifest = decodeManifest(row.manifest_json);
    const parsed = row.result_json === null ? undefined : decodeResult(row.result_json);
    if (
      manifest.projectId !== row.project_id ||
      manifest.jobId !== row.job_id ||
      verificationSha256(canonicalProjectWorkPayload(manifest)) !== row.manifest_hash
    )
      throw verificationError("storage");
    if (
      (row.stage === "prepared" && (row.claim_id !== null || parsed !== undefined)) ||
      (row.stage !== "prepared" && row.claim_id === null) ||
      ((row.stage === "finished" || row.stage === "applied") && parsed === undefined) ||
      (row.stage === "applied" && parsed?.outcome !== "success")
    )
      throw verificationError("storage");
    if (parsed !== undefined) {
      const { sha256, ...payload } = parsed;
      if (result(payload).sha256 !== sha256) throw verificationError("storage");
    }
    return {
      manifest,
      manifestHash: row.manifest_hash,
      stage: row.stage,
      ...(row.claim_id === null ? {} : { claimId: row.claim_id }),
      ...(parsed === undefined ? {} : { result: parsed }),
    };
  };
  const read = Effect.fn("ProjectWorkVerification.read")(function* (
    projectId: string,
    jobId: string,
  ) {
    const row = yield* readRow(projectId, jobId);
    return row === undefined
      ? Option.none()
      : Option.some(yield* Effect.try({ try: () => receipt(row), catch: mapped }));
  }, Effect.mapError(mapped));
  const capture = Effect.fn("ProjectWorkVerification.capture")(function* (
    input: VerificationManifestInput,
    runtimeFiles: ReadonlyArray<string>,
  ) {
    const executable = yield* captureVerificationExecutable(input.command.executable, runtimeFiles);
    const manifest = yield* Effect.try({
      try: () => decodeManifestValue({ ...input, executable }),
      catch: () => verificationError("invalid-manifest"),
    });
    yield* assertVerificationTarget(manifest.target).pipe(
      Effect.provideService(ProcessRunner, runner),
    );
    return manifest;
  });
  const check = Effect.fn("ProjectWorkVerification.check")(function* (
    manifest: ProjectVerificationJobManifest,
    files: ReadonlyArray<string>,
  ) {
    const executable = yield* captureVerificationExecutable(manifest.command.executable, files);
    if (
      canonicalProjectWorkPayload(executable) !== canonicalProjectWorkPayload(manifest.executable)
    )
      return yield* verificationError("changed-executable");
    yield* assertVerificationTarget(manifest.target).pipe(
      Effect.provideService(ProcessRunner, runner),
    );
    const validatePhysical = yield* captureVerificationPhysicalValidation(
      manifest.target,
      files,
      manifest.executable,
    ).pipe(Effect.provideService(ProcessRunner, runner));
    yield* validatePhysical;
  });
  const prepare = Effect.fn("ProjectWorkVerification.prepare")(function* (
    input: {
      readonly manifest: ProjectVerificationJobManifest;
      readonly runtimeFiles: ReadonlyArray<string>;
    },
    assertCurrent: Effect.Effect<void, ProjectWorkVerificationError>,
  ) {
    yield* noTransaction;
    const manifest = yield* Effect.try({
      try: () => decodeManifestValue(structuredClone(input.manifest)),
      catch: () => verificationError("invalid-manifest"),
    });
    const files = [...input.runtimeFiles].sort();
    yield* check(manifest, files);
    const json = canonicalProjectWorkPayload(manifest);
    const fingerprint = verificationSha256(json);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertCurrent;
        const prior = yield* readRow(manifest.projectId, manifest.jobId);
        if (prior !== undefined) {
          if (
            prior.manifest_hash !== fingerprint ||
            prior.runtime_files_json !== canonicalProjectWorkPayload(files)
          )
            return yield* verificationError("conflict");
          return receipt(prior);
        }
        yield* sql`INSERT INTO t3_workflow_v2_verification_jobs(project_id,job_id,manifest_hash,manifest_json,runtime_files_json,stage) VALUES(${manifest.projectId},${manifest.jobId},${fingerprint},${json},${canonicalProjectWorkPayload(files)},'prepared')`;
        return { manifest, manifestHash: fingerprint, stage: "prepared" as const };
      }),
    );
  }, Effect.mapError(mapped));
  const execute = Effect.fn("ProjectWorkVerification.execute")(function* (
    projectId: string,
    jobId: string,
    authority: VerificationExecutionAuthority,
  ) {
    yield* noTransaction;
    const row = yield* readRow(projectId, jobId);
    if (row === undefined) return yield* verificationError("missing");
    const prepared = yield* Effect.try({ try: () => receipt(row), catch: mapped });
    // A retained claim, including one left by a crash, is never permission to run again.
    if (row.stage !== "prepared") return prepared;
    const files = yield* Effect.try({
      try: () => decodeFiles(row.runtime_files_json),
      catch: mapped,
    });
    yield* check(prepared.manifest, files);
    const claimId = NodeCrypto.randomUUID();
    const claimed = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* authority.assertCurrent(prepared.manifest);
        const updated =
          yield* sql`UPDATE t3_workflow_v2_verification_jobs SET stage='claimed',claim_id=${claimId} WHERE project_id=${projectId} AND job_id=${jobId} AND manifest_hash=${prepared.manifestHash} AND stage='prepared' RETURNING job_id`;
        return updated.length === 1;
      }),
    );
    if (!claimed) {
      const current = yield* read(projectId, jobId);
      if (Option.isNone(current)) return yield* verificationError("missing");
      return current.value;
    }
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const execution = yield* restore(
          Effect.gen(function* () {
            // Capture-to-claim can race host changes; check once more immediately before spawning.
            yield* check(prepared.manifest, files);
            yield* sql.withTransaction(authority.assertCurrent(prepared.manifest));
            const output = yield* runner.run({
              command: prepared.manifest.command.executable,
              args: prepared.manifest.command.argv,
              cwd: prepared.manifest.target.worktree,
              env: {
                PATH: "",
                LANG: "C",
                LC_ALL: "C",
                TZ: "UTC",
                PWD: prepared.manifest.target.worktree,
              },
              extendEnv: false,
              timeout: prepared.manifest.command.limits.maxDurationMs,
              maxOutputBytes: prepared.manifest.command.limits.maxOutputBytes,
              outputMode: "truncate",
              timeoutBehavior: "timedOutResult",
            });
            return result({
              outcome: output.timedOut
                ? "timed-out"
                : output.code === 0 &&
                    !output.stdoutTruncated &&
                    !output.stderrTruncated &&
                    !output.stdoutInvalidUtf8 &&
                    !output.stderrInvalidUtf8
                  ? "success"
                  : "failed",
              exitCode: output.code,
              stdout: output.stdout,
              stderr: output.stderr,
              stdoutTruncated: output.stdoutTruncated,
              stderrTruncated: output.stderrTruncated,
            });
          }),
        ).pipe(Effect.exit);
        const observed = Exit.isSuccess(execution) ? execution.value : unknownResult();
        yield* sql`UPDATE t3_workflow_v2_verification_jobs SET stage='finished',result_json=${canonicalProjectWorkPayload(observed)} WHERE project_id=${projectId} AND job_id=${jobId} AND stage='claimed' AND claim_id=${claimId}`;
        if (observed.outcome === "success") {
          const application = yield* restore(
            Effect.gen(function* () {
              yield* check(prepared.manifest, files);
              const validatePhysical = yield* captureVerificationPhysicalValidation(
                prepared.manifest.target,
                files,
                prepared.manifest.executable,
              ).pipe(Effect.provideService(ProcessRunner, runner));
              const markApplied = Effect.gen(function* () {
                if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
                  return yield* verificationError("transaction");
                yield* validatePhysical;
                yield* authority.assertCurrent(prepared.manifest);
                const changed =
                  yield* sql`UPDATE t3_workflow_v2_verification_jobs SET stage='applied' WHERE project_id=${projectId} AND job_id=${jobId} AND stage='finished' AND claim_id=${claimId} AND result_json=${canonicalProjectWorkPayload(observed)} RETURNING job_id`;
                if (changed.length !== 1) return yield* verificationError("conflict");
              }).pipe(Effect.mapError(mapped));
              yield* sql.withTransaction(authority.assertCurrent(prepared.manifest));
              yield* authority.applyEvidence(observed, prepared.manifest, markApplied);
              const applied = yield* readRow(projectId, jobId);
              if (applied?.stage !== "applied" || applied.claim_id !== claimId)
                return yield* verificationError("conflict");
            }),
          ).pipe(Effect.exit);
          if (Exit.isFailure(application)) {
            const { sha256: _digest, ...payload } = observed;
            const stale = result({ ...payload, outcome: "stale" });
            yield* sql`UPDATE t3_workflow_v2_verification_jobs SET result_json=${canonicalProjectWorkPayload(stale)} WHERE project_id=${projectId} AND job_id=${jobId} AND stage='finished' AND claim_id=${claimId}`;
          }
        }
        const current = yield* read(projectId, jobId);
        if (Option.isNone(current)) return yield* verificationError("missing");
        return current.value;
      }),
    );
  }, Effect.mapError(mapped));
  return ProjectWorkVerification.of({ capture, prepare, read, execute });
});
export const layer = Layer.effect(ProjectWorkVerification, make);
