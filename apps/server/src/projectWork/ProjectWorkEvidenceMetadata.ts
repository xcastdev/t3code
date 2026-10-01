import { ProjectWorkEvidence } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeMetadata = Schema.decodeUnknownSync(
  Schema.Struct({
    scopeHash: ProjectWorkEvidence.fields.scopeHash,
    outputArtifactIds: ProjectWorkEvidence.fields.outputArtifactIds,
  }),
);

/** Legacy rows omit these columns; scoped records require validated retained metadata. */
export const readProjectWorkEvidenceMetadata = (row: Record<string, unknown>) =>
  decodeMetadata({
    ...(row.scope_hash == null ? {} : { scopeHash: row.scope_hash }),
    ...(row.output_artifact_ids_json == null
      ? {}
      : {
          outputArtifactIds: decodeJson(row.output_artifact_ids_json),
        }),
  });
