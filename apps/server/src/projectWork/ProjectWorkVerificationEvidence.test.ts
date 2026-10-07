import { expect, it } from "@effect/vitest";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { scoped } from "./ProjectTeamAuthorization.testFixtures.ts";
import { makeProjectWorkArtifacts } from "./ProjectWorkArtifacts.ts";
import { evaluateCommittedEvidence } from "./ProjectWorkEvidencePolicy.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { makeVerificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import type { RetainedVerificationResult } from "./ProjectWorkVerificationExecutionJournal.ts";
import {
  assertVerificationEvidence,
  prepareVerificationEvidence,
} from "./ProjectWorkVerificationEvidence.ts";

// These controls exercise private command construction and the real decider /
// projector. The journal tests separately prove original host-observed custody.
const makeConstruction = Effect.fn("makeConstruction")(function* (
  role: "implementer" | "integrator" = "implementer",
) {
  const f = yield* makeVerificationFixture(role);
  const receipt = yield* f.preparation.prepare(
    {
      ...f.selection,
      jobId: "j".repeat(256),
      command: { ...f.selection.command, argv: ["-n", "literal;$(anything)", " spaced "] },
    },
    f.principal,
  );
  const job = receipt.manifest;
  const store = yield* makeProjectWorkArtifacts({
    environmentId: "environment",
    maximumArtifactBytes: 4096,
  });
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
    exitCode: 0,
    environmentSummary: "controlled-linux clean readonly",
    integration: job.integration === true,
  };
  const stdout = yield* store.retain({
    artifactId: "construction:stdout",
    sourceId: "construction",
    applicability,
    bytes: new Uint8Array([0, 255]),
  });
  const stderr = yield* store.retain({
    artifactId: "construction:stderr",
    sourceId: "construction",
    applicability,
    bytes: new Uint8Array([]),
  });
  const result: RetainedVerificationResult = {
    version: 1,
    jobId: job.jobId,
    attemptId: "construction",
    manifestHash: receipt.sha256,
    allocationHash: "a".repeat(64),
    outcome: "success",
    exitCode: 0,
    outputComplete: true,
    stdout,
    stderr,
    // This builder control grants no execution custody; it never calls complete.
    drain: null,
    drainHash: "b".repeat(64),
    environmentSummary: applicability.environmentSummary,
    finishedAtMs: yield* Clock.currentTimeMillis,
  };
  return { ...f, intent: { receipt }, result };
});

for (const role of ["implementer", "integrator"] as const)
  it.effect(
    `${role} verification retains literal command applicability through durable replay`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* makeConstruction(role);
          const repository = yield* ProjectWorkRepository;
          const before = yield* readCurrentState(f.sql, f.selection.projectId);
          const prepared = prepareVerificationEvidence(before, f.intent, f.result);
          yield* repository.executeAtomic(
            Effect.succeed([prepared.evidence, prepared.applicability]),
          );
          const after = yield* readCurrentState(f.sql, f.selection.projectId);
          assertVerificationEvidence(after, prepared, f.intent, f.result);
          expect(after.evidence[0]?.outputArtifactIds).toEqual([
            "construction:stdout",
            "construction:stderr",
          ]);
          const record = after.foundationRecords?.find((r) => r.kind === "evidence-applicability");
          expect(record).toMatchObject({
            integration: role === "integrator",
            command: '{"argv":["-n","literal;$(anything)"," spaced "],"executable":"/bin/bash"}',
            testedCommit: "c".repeat(40),
            testedTree: "d".repeat(40),
          });
          if (record?.kind !== "evidence-applicability")
            return yield* Effect.die("Missing applicability");
          const job = f.intent.receipt.manifest;
          const verdict = evaluateCommittedEvidence({
            evidence: record,
            target: {
              projectId: job.projectId,
              taskId: job.taskId,
              specRevision: job.specRevision,
              planRevision: job.planRevision,
              ...job.target,
              environmentSummary: f.result.environmentSummary,
            },
            retainedArtifactIds: new Set([f.result.stdout.artifactId, f.result.stderr.artifactId]),
            requireIntegration: true,
          });
          expect(verdict).toEqual(
            role === "integrator"
              ? { status: "accepted" }
              : { status: "rejected", reasons: ["integration-required"] },
          );
          expect(after.criteria).toEqual(before.criteria);
          expect(after.tasks).toEqual(before.tasks);
          expect(after.evidence[0]?.scopeHash).not.toBe(f.intent.receipt.sha256);
          const ids = [
            prepared.evidence.commandId,
            prepared.applicability.commandId,
            after.evidence[0]!.evidenceId,
            record!.recordId,
          ];
          expect(new Set(ids).size).toBe(4);
          for (const id of ids) expect(id.length).toBeLessThanOrEqual(256);
          expect(Buffer.byteLength(after.evidence[0]!.detail!)).toBeLessThan(2048);
          expect(
            (yield* repository.replay(f.selection.projectId)).filter(
              (e) => e.type === "project-work.evidence.added",
            ),
          ).toHaveLength(1);
        }),
      ),
  );

for (const role of ["implementer", "integrator"] as const)
  it.effect(
    `final ${role} evidence validation denies changed output links, applicability, and semantic scope`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* makeConstruction(role);
          const repository = yield* ProjectWorkRepository;
          const prepared = prepareVerificationEvidence(
            yield* readCurrentState(f.sql, f.selection.projectId),
            f.intent,
            f.result,
          );
          yield* repository.executeAtomic(
            Effect.succeed([prepared.evidence, prepared.applicability]),
          );
          const after = yield* readCurrentState(f.sql, f.selection.projectId);
          for (const changed of [
            {
              ...after,
              evidence: after.evidence.map((e) => ({
                ...e,
                outputArtifactIds: ["foreign-output"],
              })),
            },
            {
              ...after,
              foundationRecords: (after.foundationRecords ?? []).map((r) =>
                r.kind === "evidence-applicability"
                  ? { ...r, integration: role !== "integrator" }
                  : r,
              ),
            },
            {
              ...after,
              criteria: after.criteria.map((c) => ({ ...c, description: "Changed specification" })),
            },
          ])
            expect(() => assertVerificationEvidence(changed, prepared, f.intent, f.result)).toThrow(
              "Verification evidence changed",
            );
          assertVerificationEvidence(after, prepared, f.intent, f.result);
        }),
      ),
  );
