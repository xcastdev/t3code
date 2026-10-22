import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  RunId,
  RunAttemptId,
  NodeId,
  CheckpointId,
  CheckpointScopeId,
} from "./baseSchemas.ts";
import { ProjectWorkCriterionId, ProjectWorkTaskId } from "./projectWorkCore.ts";

const Argument = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => !value.includes("\0")),
);
const Executable = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/])/u),
  Schema.makeFilter((value) => !/[\0\r\n]/u.test(value)),
);
const encodedSize = new TextEncoder();

/** A selection is a proposal. The host must resolve its executable and capture
 * the exact workspace target before it can be presented for approval. */
export const ProjectVerificationCommandSelection = Schema.Struct({
  executable: Executable,
  argv: Schema.Array(Argument).check(
    Schema.isMaxLength(64),
    Schema.makeFilter(
      (values) =>
        values.reduce((size, value) => size + encodedSize.encode(value).byteLength, 0) <= 16_384,
    ),
  ),
  limits: Schema.Struct({
    maxDurationMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600_000 })),
    maxOutputBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_048_576 })),
  }),
  environment: Schema.Literal("clean"),
});
export type ProjectVerificationCommandSelection = typeof ProjectVerificationCommandSelection.Type;

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const GitOid = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));

/** Host-captured preview data. Decoding this shape establishes no provenance or
 * approval; only the server's retained capture and human response can do that. */
export const ProjectVerificationJobManifest = Schema.Struct({
  version: Schema.Literal(1),
  integration: Schema.optionalKey(Schema.Literal(true)),
  integrationCoverage: Schema.optionalKey(
    Schema.Struct({
      version: Schema.Literal(1),
      selectionSha256: Digest,
      combinationSha256: Digest,
    }),
  ),
  jobId: Id,
  environmentId: EnvironmentId.check(Schema.isMaxLength(256)),
  projectId: ProjectId.check(Schema.isMaxLength(256)),
  taskId: ProjectWorkTaskId.check(Schema.isMaxLength(256)),
  specRevision: NonNegativeInt,
  specificationHash: Digest,
  planRevision: NonNegativeInt,
  planHash: Digest,
  criteria: Schema.Array(
    Schema.Struct({
      criterionId: ProjectWorkCriterionId.check(Schema.isMaxLength(256)),
      revision: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
    }),
  ).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.makeFilter(
      (criteria) => new Set(criteria.map((item) => item.criterionId)).size === criteria.length,
    ),
  ),
  runId: RunId,
  runAttemptId: RunAttemptId,
  nodeId: NodeId,
  checkpointId: Schema.optionalKey(CheckpointId),
  checkpointScopeId: CheckpointScopeId,
  dispatchId: Id,
  bindingId: Id,
  generation: NonNegativeInt,
  workspaceReceiptHash: Digest,
  command: ProjectVerificationCommandSelection,
  target: Schema.Struct({
    repository: Executable,
    worktree: Executable,
    branchRef: Schema.String.check(
      Schema.isMaxLength(4_096),
      Schema.isPattern(/^refs\/heads\/\S+$/u),
    ),
    baseSha: GitOid,
    headSha: GitOid,
    testedCommit: GitOid,
    testedTree: GitOid,
    workspaceState: Schema.Literal("clean-committed"),
  }),
  executable: Schema.Struct({
    target: Executable,
    sha256: Digest,
    runtimeClosureSha256: Digest,
  }),
}).check(
  Schema.makeFilter((manifest) => manifest.target.testedCommit === manifest.target.headSha),
  Schema.makeFilter((manifest) => manifest.executable.target === manifest.command.executable),
  Schema.makeFilter(
    (manifest) => encodedSize.encode(JSON.stringify(manifest)).byteLength <= 65_536,
  ),
);
export type ProjectVerificationJobManifest = typeof ProjectVerificationJobManifest.Type;
