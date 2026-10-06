import { expect, it } from "@effect/vitest";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { scoped, at } from "../../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import { verificationFixture } from "../../projectWork/ProjectWorkVerification.testFixtures.ts";
import {
  ProjectWorkVerificationExecutionIntent,
  ProjectWorkVerificationExecutionResult,
  verificationExecutionHash,
} from "../../projectWork/ProjectWorkVerificationExecutionJournal.ts";
import { makeProjectWorkArtifacts } from "../../projectWork/ProjectWorkArtifacts.ts";
import { canReleasePiVerificationRuntime } from "./PiVerificationRuntimeRetention.ts";

const decodeIntent = Schema.decodeUnknownEffect(ProjectWorkVerificationExecutionIntent);
const decodeResult = Schema.decodeUnknownEffect(ProjectWorkVerificationExecutionResult);
const fixture = Effect.gen(function* () {
  const f = yield* verificationFixture;
  const nonce = "11111111-1111-4111-8111-111111111111";
  const unit = `t3-pi-managed-${nonce}.service`;
  const intent = yield* decodeIntent({
    receipt: f.prepared,
    gate: {
      kind: "gate",
      projectId: f.selection.projectId,
      recordId: "gate",
      revision: 0,
      generation: 0,
      updatedAt: at,
      status: "approved",
      taskId: f.selection.taskId,
      gate: "verification",
      specRevision: f.selection.specRevision,
      planRevision: f.selection.planRevision,
      contentHash: f.prepared.sha256,
      verificationJobId: f.selection.jobId,
      attribution: {
        actor: { kind: "human", id: "maintainer" },
        source: { kind: "web", id: "browser" },
        recordedAt: at,
      },
      evidenceIds: [],
    },
    allocation: {
      version: 1,
      unit,
      nonce,
      policy: { memoryBytes: 2147483648, runtimeSeconds: 1 },
      launch: {
        workspaceRoot: "/workspace-assigned",
        workspaceAccess: "readonly",
        protectedRoots: ["/protected"],
        runtimeFiles: [{ source: "/published/bash", target: "/bin/bash", dev: 1, ino: 10 }],
        argv: ["/bin/bash", "-n", "test.sh"],
        memoryBytes: 2147483648,
        runtimeSeconds: 1,
        workspace: { path: "/workspace-assigned", dev: 1, ino: 2 },
        protectedWorkspaceEntries: [],
      },
    },
    deadlineAtMs: 1000,
  });
  yield* f.sql`INSERT INTO project_work_verification_execution (environment_id,job_id,project_id,task_id,attempt_id,manifest_hash,gate_id,gate_revision,intent_json,intent_hash,allocation_hash,deadline_at_ms,phase,revision)
    VALUES ('environment',${f.selection.jobId},${f.selection.projectId},${f.selection.taskId},'attempt',${f.prepared.sha256},'gate',0,${canonicalProjectWorkPayload(intent)},${verificationExecutionHash(intent)},${verificationExecutionHash(intent.allocation)},1000,'claimed',0)`;
  const store = yield* makeProjectWorkArtifacts({
    environmentId: "environment",
    maximumArtifactBytes: 4096,
  });
  const job = intent.receipt.manifest;
  const applicability = {
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
    exitCode: -1,
    environmentSummary: "controlled cleanup",
    integration: false,
  };
  const stdout = yield* store.retain({
    artifactId: "stdout",
    sourceId: "attempt",
    applicability,
    bytes: new Uint8Array(),
  });
  const stderr = yield* store.retain({
    artifactId: "stderr",
    sourceId: "attempt",
    applicability,
    bytes: new Uint8Array(),
  });
  const result = yield* decodeResult({
    version: 1,
    jobId: job.jobId,
    attemptId: "attempt",
    manifestHash: intent.receipt.sha256,
    allocationHash: verificationExecutionHash(intent.allocation),
    outcome: "abandoned",
    exitCode: null,
    outputComplete: false,
    stdout,
    stderr,
    drain: null,
    reconciliation: { unit, nonce, kernel: "removed" },
    drainHash: verificationExecutionHash(null),
    environmentSummary: "controlled cleanup",
    finishedAtMs: 1000,
  });
  return {
    ...f,
    intent,
    result,
    stage: { directory: "/published", files: [{ source: "/published/bash", dev: 1, ino: 10 }] },
  };
});
it.effect("retained verification ownership blocks stage release, including inode aliases", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(yield* canReleasePiVerificationRuntime(f.stage)).toBe(false);
      expect(
        yield* canReleasePiVerificationRuntime({
          directory: "/different-stage",
          files: [{ source: "/alias/bash", dev: 1, ino: 10 }],
        }),
      ).toBe(false);
      expect(
        yield* canReleasePiVerificationRuntime({
          directory: "/other",
          files: [{ source: "/other/bash", dev: 2, ino: 20 }],
        }),
      ).toBe(true);
    }),
  ),
);
it.effect("only matching immutable terminal cleanup permits release", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE project_work_verification_execution SET phase='terminal',result_json=${canonicalProjectWorkPayload(f.result)},result_hash=${verificationExecutionHash(f.result)},revision=1`;
      expect(yield* canReleasePiVerificationRuntime(f.stage)).toBe(true);
    }),
  ),
);
for (const [kernel, expected] of [
  ["not-created", true],
  ["populated 1", false],
  ["unknown", false],
] as const)
  it.effect(
    `terminal null-drain reconciliation ${kernel} releases runtime files: ${expected}`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const result = {
            ...f.result,
            reconciliation: {
              unit: f.intent.allocation.unit,
              nonce: f.intent.allocation.nonce,
              kernel,
            },
          };
          yield* f.sql`UPDATE project_work_verification_execution SET phase='terminal',result_json=${canonicalProjectWorkPayload(result)},result_hash=${verificationExecutionHash(result)},revision=1`;
          expect(yield* canReleasePiVerificationRuntime(f.stage)).toBe(expected);
        }),
      ),
  );

it.effect("a terminal cleanup receipt for another unit cannot release runtime files", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = {
        ...f.result,
        reconciliation: { ...f.result.reconciliation, unit: "other-unit" },
      };
      yield* f.sql`UPDATE project_work_verification_execution SET phase='terminal',result_json=${canonicalProjectWorkPayload(result)},result_hash=${verificationExecutionHash(result)},revision=1`;
      expect(yield* canReleasePiVerificationRuntime(f.stage)).toBe(false);
    }),
  ),
);
