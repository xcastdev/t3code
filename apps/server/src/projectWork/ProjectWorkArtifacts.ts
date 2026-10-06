import { canonicalProjectWorkPayload, ProjectTeamEvidenceApplicability } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const maximumBytes = 1_048_576;
const maximumManifestBytes = 65_536;
const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const fields = ProjectTeamEvidenceApplicability.fields;
export const ProjectWorkArtifactApplicability = Schema.Struct({
  projectId: fields.projectId.check(Schema.isMaxLength(256)),
  taskId: fields.taskId.check(Schema.isMaxLength(256)),
  specRevision: Safe,
  planRevision: Safe,
  repository: fields.repository,
  worktree: fields.worktree,
  testedTree: fields.testedTree,
  testedCommit: fields.testedCommit,
  baseSha: fields.baseSha,
  headSha: fields.headSha,
  command: fields.command,
  exitCode: fields.exitCode.check(
    Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  environmentSummary: fields.environmentSummary,
  integration: fields.integration,
});
export type ProjectWorkArtifactApplicability = typeof ProjectWorkArtifactApplicability.Type;
const Manifest = Schema.Struct({
  artifactId: Id,
  sourceId: Id,
  applicability: ProjectWorkArtifactApplicability,
});
const Retain = Schema.Struct({ ...Manifest.fields, bytes: Schema.Uint8Array });
const Options = Schema.Struct({
  environmentId: Id,
  maximumArtifactBytes: Safe.check(Schema.isBetween({ minimum: 1, maximum: maximumBytes })),
});
const Selection = Schema.Struct({
  applicability: ProjectWorkArtifactApplicability,
  artifactIds: Schema.Array(Id).check(
    Schema.isMaxLength(128),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length, {
      message: "Artifact IDs must be unique",
    }),
  ),
});
const strict = { onExcessProperty: "error" as const };
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest), strict);
const decodeRetain = Schema.decodeUnknownSync(Retain, strict);
const decodeOptions = Schema.decodeUnknownSync(Options, strict);
const decodeSelection = Schema.decodeUnknownSync(Selection, strict);
const decodeId = Schema.decodeUnknownSync(Id);
const isBytes = Schema.is(Schema.Uint8Array);
const Row = Schema.Struct({
  environment_id: Id,
  artifact_id: Id,
  project_id: Id,
  task_id: Id,
  source_id: Id,
  manifest_json: Schema.String.check(Schema.isMinLength(1)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  byte_count: Safe.check(Schema.isLessThanOrEqualTo(maximumBytes)),
  actual_byte_count: Safe.check(Schema.isLessThanOrEqualTo(maximumBytes)),
  blob_type: Schema.Literal("blob"),
  raw_bytes: Schema.Uint8Array,
});
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(Row).check(Schema.isMaxLength(1)),
  strict,
);
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export class ProjectWorkArtifactError extends Schema.TaggedError<ProjectWorkArtifactError>()(
  "ProjectWorkArtifactError",
  { reason: Schema.String },
) {}
const deny = (reason: string) => new ProjectWorkArtifactError({ reason });

function exact<A>(decode: (input: unknown) => A, value: unknown): A {
  const captured: unknown = structuredClone(value);
  const decoded = decode(captured);
  if (canonicalProjectWorkPayload(captured) !== canonicalProjectWorkPayload(decoded))
    throw deny("Artifact input must match its exact decoded values");
  return decoded;
}

export type ProjectWorkArtifactReceipt = typeof Manifest.Type & {
  readonly sha256: string;
  readonly byteCount: number;
};
export type ProjectWorkRetainedArtifact = ProjectWorkArtifactReceipt & {
  readonly bytes: Uint8Array;
};

/** Private byte retention; a receipt does not qualify evidence or authorize any task transition. */
export function makeProjectWorkArtifacts(input: typeof Options.Type) {
  let options: typeof Options.Type;
  try {
    options = exact(decodeOptions, input);
  } catch {
    return Effect.fail(deny("Invalid artifact store options"));
  }
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const assertTransactionOwner = Effect.gen(function* () {
      const currentClient = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isSome(currentClient) && currentClient.value !== sql)
        return yield* deny("Artifacts must use their captured SQL client");
      // An enclosing transaction can roll back bytes after a retention receipt is returned.
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* deny("Artifacts must own their SQL transaction");
    });
    const read = Effect.fn("ProjectWorkArtifacts.read")(function* (artifactId: string) {
      // Bound physical values before fetching a possibly corrupt retained blob or manifest.
      const rows = yield* sql`SELECT environment_id, artifact_id, project_id, task_id, source_id,
        CASE WHEN length(CAST(manifest_json AS BLOB)) <= ${maximumManifestBytes} THEN manifest_json ELSE NULL END AS manifest_json,
        sha256, byte_count, length(raw_bytes) AS actual_byte_count, typeof(raw_bytes) AS blob_type,
        CASE WHEN length(raw_bytes) <= ${options.maximumArtifactBytes} THEN raw_bytes ELSE NULL END AS raw_bytes
        FROM project_work_artifacts WHERE environment_id=${options.environmentId} AND artifact_id=${artifactId} LIMIT 2`;
      const decoded = yield* decodeRows(rows).pipe(
        Effect.mapError(() => deny("Corrupt retained artifact row")),
      );
      const row = decoded[0];
      if (!row) return undefined;
      return yield* Effect.try({
        try: () => {
          const manifest = decodeManifest(row.manifest_json);
          if (
            canonicalProjectWorkPayload(manifest) !== row.manifest_json ||
            Buffer.byteLength(row.manifest_json) > maximumManifestBytes ||
            manifest.artifactId !== artifactId ||
            manifest.artifactId !== row.artifact_id ||
            manifest.sourceId !== row.source_id ||
            manifest.applicability.projectId !== row.project_id ||
            manifest.applicability.taskId !== row.task_id ||
            row.environment_id !== options.environmentId ||
            row.byte_count > options.maximumArtifactBytes ||
            row.byte_count !== row.actual_byte_count ||
            row.raw_bytes.byteLength !== row.byte_count
          )
            throw deny("Corrupt retained artifact binding");
          const bytes = new Uint8Array(row.raw_bytes);
          if (hash(bytes) !== row.sha256) throw deny("Corrupt retained artifact hash");
          return { ...manifest, sha256: row.sha256, byteCount: row.byte_count, bytes };
        },
        catch: () => deny("Corrupt retained artifact manifest or bytes"),
      });
    });
    const readRetained = (artifactId: string) => {
      try {
        // BEGIN also fences a physical transaction left open after a failed COMMIT.
        return Effect.andThen(
          assertTransactionOwner,
          sql.withTransaction(read(exact(decodeId, artifactId))),
        );
      } catch {
        return Effect.fail(deny("Invalid artifact ID"));
      }
    };
    const retain = (input: typeof Retain.Type) => {
      let captured: typeof Retain.Type;
      let bytes: Uint8Array;
      let manifestJson: string;
      let sha256: string;
      try {
        if (!isBytes(input.bytes) || input.bytes.byteLength > options.maximumArtifactBytes)
          return Effect.fail(deny("Artifact bytes exceed the configured limit"));
        captured = exact(decodeRetain, input);
        bytes = new Uint8Array(captured.bytes);
        manifestJson = canonicalProjectWorkPayload({
          artifactId: captured.artifactId,
          sourceId: captured.sourceId,
          applicability: captured.applicability,
        });
        if (Buffer.byteLength(manifestJson) > maximumManifestBytes)
          return Effect.fail(deny("Artifact manifest exceeds the byte limit"));
        sha256 = hash(bytes);
      } catch {
        return Effect.fail(deny("Invalid artifact retention input"));
      }
      return Effect.andThen(
        assertTransactionOwner,
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO project_work_artifacts
          (environment_id, artifact_id, project_id, task_id, source_id, manifest_json, sha256, byte_count, raw_bytes)
          VALUES (${options.environmentId},${captured.artifactId},${captured.applicability.projectId},${captured.applicability.taskId},${captured.sourceId},${manifestJson},${sha256},${bytes.byteLength},${bytes})
          ON CONFLICT(environment_id,artifact_id) DO NOTHING`;
            const retained = yield* read(captured.artifactId);
            if (
              !retained ||
              canonicalProjectWorkPayload({
                artifactId: retained.artifactId,
                sourceId: retained.sourceId,
                applicability: retained.applicability,
              }) !== manifestJson ||
              retained.sha256 !== sha256 ||
              retained.byteCount !== bytes.byteLength ||
              !Buffer.from(retained.bytes).equals(bytes)
            )
              return yield* deny("Artifact ID already has a different immutable winner");
            const { bytes: _bytes, ...receipt } = retained;
            return receipt;
          }),
        ),
      );
    };
    const retainedIdsFor = (input: typeof Selection.Type) => {
      let captured: typeof Selection.Type;
      try {
        captured = exact(decodeSelection, input);
      } catch {
        return Effect.fail(deny("Invalid artifact selection"));
      }
      return Effect.andThen(
        assertTransactionOwner,
        sql.withTransaction(
          Effect.gen(function* () {
            const ids: string[] = [];
            const applicability = canonicalProjectWorkPayload(captured.applicability);
            for (const artifactId of captured.artifactIds) {
              const retained = yield* read(artifactId);
              if (retained && canonicalProjectWorkPayload(retained.applicability) === applicability)
                ids.push(artifactId);
            }
            return ids;
          }),
        ),
      );
    };
    return { retain, readRetained, retainedIdsFor };
  });
}
