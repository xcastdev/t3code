import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ProjectWorkVerificationExecutionIntent,
  ProjectWorkVerificationExecutionResult,
  VerificationExecutionOwner,
  verificationExecutionHash,
} from "../../projectWork/ProjectWorkVerificationExecutionJournal.ts";

const strict = { onExcessProperty: "error" as const };
const decodeIntent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkVerificationExecutionIntent),
  strict,
);
const decodeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkVerificationExecutionResult),
  strict,
);
const decodeOwner = Schema.decodeUnknownEffect(
  Schema.NullOr(Schema.fromJsonString(VerificationExecutionOwner)),
  strict,
);
const empty = (kernel: string) =>
  kernel === "removed" || kernel.split("\n").includes("populated 0");

/** A retained verification allocation also owns its runtime files. The private
 * producer persists a terminal observation only after the original process drains.
 */
export const canReleasePiVerificationRuntime = Effect.fn(
  "PiVerificationRuntimeRetention.canRelease",
)(
  function* (stage: {
    readonly directory: string;
    readonly files: readonly {
      readonly source: string;
      readonly dev: number;
      readonly ino: number;
    }[];
  }) {
    const sql = yield* SqlClient.SqlClient;
    const identities = new Set(stage.files.map((file) => `${file.dev}:${file.ino}`));
    let cursor = 0;
    let matched = 0;
    while (true) {
      const rows =
        yield* sql`SELECT rowid AS cursor,environment_id,job_id,attempt_id,phase,intent_hash,result_hash,
        CASE WHEN length(CAST(intent_json AS BLOB))<=262144 THEN intent_json ELSE NULL END AS intent,
        CASE WHEN length(CAST(owner_json AS BLOB))<=16384 THEN owner_json ELSE NULL END AS owner,
        CASE WHEN length(CAST(result_json AS BLOB))<=65536 THEN result_json ELSE NULL END AS result
        FROM project_work_verification_execution WHERE rowid>${cursor} ORDER BY rowid LIMIT 16`;
      for (const row of rows) {
        if (
          !Number.isSafeInteger(row.cursor) ||
          typeof row.cursor !== "number" ||
          row.cursor <= cursor
        )
          return false;
        cursor = row.cursor;
        const intent = yield* decodeIntent(row.intent);
        if (
          canonicalProjectWorkPayload(intent) !== row.intent ||
          verificationExecutionHash(intent) !== row.intent_hash ||
          verificationExecutionHash(intent.receipt.manifest) !== intent.receipt.sha256 ||
          intent.receipt.manifest.environmentId !== row.environment_id ||
          intent.receipt.manifest.jobId !== row.job_id
        )
          return false;
        const files = intent.allocation.launch.runtimeFiles;
        if (
          !files.some(
            (file) =>
              identities.has(`${file.dev}:${file.ino}`) ||
              file.source.startsWith(stage.directory + "/"),
          )
        )
          continue;
        if (++matched > 1024 || row.phase !== "terminal" || row.result === null) return false;
        const result = yield* decodeResult(row.result);
        if (
          canonicalProjectWorkPayload(result) !== row.result ||
          verificationExecutionHash(result) !== row.result_hash ||
          result.attemptId !== row.attempt_id ||
          result.jobId !== row.job_id ||
          result.manifestHash !== intent.receipt.sha256 ||
          result.allocationHash !== verificationExecutionHash(intent.allocation)
        )
          return false;
        if (result.drain === null) {
          if (
            result.outcome === "success" ||
            result.exitCode !== null ||
            !result.reconciliation ||
            result.reconciliation.unit !== intent.allocation.unit ||
            result.reconciliation.nonce !== intent.allocation.nonce ||
            !(result.reconciliation.kernel === "not-created" || empty(result.reconciliation.kernel))
          )
            return false;
        } else {
          const owner = yield* decodeOwner(row.owner);
          const drain = result.drain;
          if (
            !owner ||
            owner.unit !== intent.allocation.unit ||
            owner.nonce !== intent.allocation.nonce ||
            drain.unit !== owner.unit ||
            drain.invocation !== owner.invocation ||
            drain.cgroup !== owner.cgroup ||
            drain.ownerPid !== owner.pid ||
            owner.memoryBytes !== intent.allocation.policy.memoryBytes ||
            owner.swapBytes !== 0 ||
            owner.oomGroup !== 1 ||
            drain.memoryBytes !== intent.allocation.policy.memoryBytes ||
            drain.swapBytes !== 0 ||
            drain.oomGroup !== 1 ||
            verificationExecutionHash(drain) !== result.drainHash ||
            !empty(drain.kernel)
          )
            return false;
        }
      }
      if (rows.length < 16) return true;
    }
  },
  Effect.catch(() => Effect.succeed(false)),
);
