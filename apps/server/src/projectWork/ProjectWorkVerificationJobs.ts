import { canonicalProjectWorkPayload, ProjectVerificationJobManifest } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const maximumManifestBytes = 65_536;
const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Options = Schema.Struct({ environmentId: Id });
const strict = { onExcessProperty: "error" as const };
const decodeOptions = Schema.decodeUnknownSync(Options, strict);
const decodeManifest = Schema.decodeUnknownSync(ProjectVerificationJobManifest, strict);
const decodeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProjectVerificationJobManifest),
  strict,
);
const decodeId = Schema.decodeUnknownSync(Id);
const Row = Schema.Struct({
  environment_id: Id,
  job_id: Id,
  project_id: Id,
  task_id: Id,
  manifest_json: Schema.String.check(Schema.isMinLength(1)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(Row).check(Schema.isMaxLength(1)),
  strict,
);
const hash = (manifestJson: string) =>
  NodeCrypto.createHash("sha256").update(manifestJson).digest("hex");

export class ProjectWorkVerificationJobError extends Schema.TaggedError<ProjectWorkVerificationJobError>()(
  "ProjectWorkVerificationJobError",
  { reason: Schema.String },
) {}
const deny = (reason: string) => new ProjectWorkVerificationJobError({ reason });

function exact<A>(decode: (input: unknown) => A, input: unknown): A {
  const captured: unknown = structuredClone(input);
  const decoded = decode(captured);
  if (canonicalProjectWorkPayload(captured) !== canonicalProjectWorkPayload(decoded))
    throw deny("Prepared manifest input must match its exact decoded values");
  return decoded;
}

export type ProjectWorkPreparedVerificationReceipt = {
  readonly manifest: ProjectVerificationJobManifest;
  readonly sha256: string;
};

/** Private PREPARED retention only; these receipts confer no host provenance, approval or execution authority. */
export function makeProjectWorkVerificationJobs(input: typeof Options.Type) {
  let options: typeof Options.Type;
  try {
    options = exact(decodeOptions, input);
  } catch {
    return Effect.fail(deny("Invalid prepared store options"));
  }
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const assertTransactionOwner = Effect.gen(function* () {
      const currentClient = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isSome(currentClient) && currentClient.value !== sql)
        return yield* deny("Prepared jobs must use their captured SQL client");
      // A caller transaction could roll back a manifest after its receipt has escaped.
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* deny("Prepared jobs must own their SQL transaction");
    });
    const read = Effect.fn("ProjectWorkVerificationJobs.read")(function* (jobId: string) {
      const rows = yield* sql`SELECT environment_id,job_id,project_id,task_id,sha256,
        CASE WHEN length(CAST(manifest_json AS BLOB)) <= ${maximumManifestBytes} THEN manifest_json ELSE NULL END AS manifest_json
        FROM project_work_verification_jobs WHERE environment_id=${options.environmentId} AND job_id=${jobId} LIMIT 2`;
      const decoded = yield* decodeRows(rows).pipe(
        Effect.mapError(() => deny("Corrupt prepared manifest row")),
      );
      const row = decoded[0];
      if (!row) return undefined;
      return yield* Effect.try({
        try: () => {
          const manifest = decodeJson(row.manifest_json);
          if (
            canonicalProjectWorkPayload(manifest) !== row.manifest_json ||
            Buffer.byteLength(row.manifest_json) > maximumManifestBytes ||
            hash(row.manifest_json) !== row.sha256 ||
            manifest.jobId !== jobId ||
            manifest.jobId !== row.job_id ||
            manifest.environmentId !== options.environmentId ||
            manifest.environmentId !== row.environment_id ||
            manifest.projectId !== row.project_id ||
            manifest.taskId !== row.task_id
          )
            throw deny("Corrupt prepared manifest binding or hash");
          return { manifest, sha256: row.sha256 };
        },
        catch: () => deny("Corrupt prepared manifest binding or hash"),
      });
    });
    const readPrepared = (jobId: string) => {
      try {
        // BEGIN also fences a physical transaction left open after a failed COMMIT.
        return Effect.andThen(
          assertTransactionOwner,
          sql.withTransaction(read(exact(decodeId, jobId))),
        );
      } catch {
        return Effect.fail(deny("Invalid prepared job ID"));
      }
    };
    // Context owns COMMIT and must not expose this private read before it succeeds.
    const readPreparedInTransaction = (jobId: string) => {
      let capturedId: string;
      try {
        capturedId = exact(decodeId, jobId);
      } catch {
        return Effect.fail(deny("Invalid prepared job ID"));
      }
      return Effect.gen(function* () {
        const currentClient = yield* Effect.serviceOption(SqlClient.SqlClient);
        if (Option.isNone(currentClient) || currentClient.value !== sql)
          return yield* deny("Prepared context reads require their captured SQL client");
        if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
          return yield* deny("Prepared context reads require the caller-owned transaction");
        return yield* read(capturedId);
      });
    };
    const retainPrepared = (input: ProjectVerificationJobManifest) => {
      let manifest: ProjectVerificationJobManifest;
      let manifestJson: string;
      let sha256: string;
      try {
        manifest = exact(decodeManifest, input);
        manifestJson = canonicalProjectWorkPayload(manifest);
        if (
          manifest.environmentId !== options.environmentId ||
          Buffer.byteLength(manifestJson) > maximumManifestBytes
        )
          return Effect.fail(deny("Prepared manifest owner or byte bound mismatch"));
        sha256 = hash(manifestJson);
      } catch {
        return Effect.fail(deny("Invalid prepared manifest"));
      }
      return Effect.andThen(
        assertTransactionOwner,
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO project_work_verification_jobs
          (environment_id,job_id,project_id,task_id,manifest_json,sha256)
          VALUES (${options.environmentId},${manifest.jobId},${manifest.projectId},${manifest.taskId},${manifestJson},${sha256})
          ON CONFLICT(environment_id,job_id) DO NOTHING`;
            const retained = yield* read(manifest.jobId);
            if (
              !retained ||
              retained.sha256 !== sha256 ||
              canonicalProjectWorkPayload(retained.manifest) !== manifestJson
            )
              return yield* deny("Prepared job ID already has a different immutable winner");
            return retained;
          }),
        ),
      );
    };
    return { retainPrepared, readPrepared, readPreparedInTransaction };
  });
}
