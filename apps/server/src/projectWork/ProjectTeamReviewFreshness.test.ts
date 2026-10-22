import { reviewDigest, reviewCompletionDrafts } from "./ProjectTeamReviewState.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The isolated Git fixture uses synchronous filesystem and subprocess setup before the service runs.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The isolated Git fixture uses synchronous filesystem and subprocess setup before the service runs.
import * as NodePath from "node:path";
import { it, expect } from "@effect/vitest";
import {
  ProjectTeamRunBinding,
  ProjectTeamGuidedIntent,
  ProjectWorkEvidenceId,
  RunId,
  RunAttemptId,
  NodeId,
  ProviderSessionId,
  ProjectTeamReviewFindingIntent,
  ProjectWorkCriterionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Review from "./ProjectTeamReviewFreshness.ts";
import {
  fixture,
  table,
  projectId,
  taskId,
  reviewTaskId,
  at,
} from "./ProjectTeamReviewFreshness.testkit.ts";
const decodeEffectProjectTeamGuidedIntent = Schema.decodeEffect(ProjectTeamGuidedIntent);
const decodeEffectProjectTeamReviewFindingIntent = Schema.decodeEffect(
  ProjectTeamReviewFindingIntent,
);
const decodeEffectProjectTeamRunBinding = Schema.decodeEffect(ProjectTeamRunBinding);
it.live(
  "freezes before execution, survives reread, rejects source, criteria and configuration drift",
  () =>
    Effect.gen(function* () {
      using f = fixture();
      yield* Effect.gen(function* () {
        const sql = yield* table;
        const service = yield* Review.ProjectTeamReviewFreshness;
        const snapshot = yield* sql.withTransaction(
          service.freeze(f.state, { reviewBindingId: f.reviewer.recordId, jobId: "job" }),
        );
        expect(yield* service.read(projectId, f.reviewer.recordId)).toEqual(snapshot);
        yield* service.assertCurrent(f.state, snapshot);
        for (const changed of [
          {
            ...f.state,
            criteria: f.state.criteria.map((c) => ({ ...c, description: "Changed", revision: 1 })),
          },
          {
            ...f.state,
            foundationRecords: f.state.foundationRecords!.map((r) =>
              r.recordId === f.source.recordId ? { ...f.source, revision: 1 } : r,
            ),
          },
          {
            ...f.state,
            foundationRecords: [
              ...f.state.foundationRecords!,
              {
                kind: "member" as const,
                recordId: "new-member",
                projectId,
                revision: 0,
                generation: 2,
                updatedAt: at,
                status: "active" as const,
                name: "Changed",
                coordinator: false,
                roleRevisionId: "other-role",
              },
            ],
          },
          {
            ...f.state,
            foundationRecords: f.state.foundationRecords!.map((r) =>
              r.recordId === f.reviewer.recordId
                ? { ...f.reviewer, generation: 2, leaseGeneration: 2 }
                : r,
            ),
          },
        ])
          expect((yield* service.assertCurrent(changed, snapshot).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
        yield* service.assertPhysical(projectId, "job");
        expect(
          (yield* sql.withTransaction(service.assertPhysical(projectId, "job")).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        NodeFS.writeFileSync(NodePath.join(f.directory, "code"), "changed\n");
        expect((yield* service.assertPhysical(projectId, "job").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        f.git(
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-qam",
          "repair",
        );
        expect((yield* service.assertPhysical(projectId, "job").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      }).pipe(Effect.provide(f.layer));
    }),
);
it.live("refuses self review and freezing an already launched reviewer", () =>
  Effect.gen(function* () {
    using f = fixture();
    yield* Effect.gen(function* () {
      const sql = yield* table;
      const service = yield* Review.ProjectTeamReviewFreshness;
      for (const replacement of [
        { ...f.reviewer, memberId: f.source.memberId },
        { ...f.reviewer, status: "running" as const, runId: RunId.make("review-run") },
      ]) {
        const state = {
          ...f.state,
          foundationRecords: f.state.foundationRecords!.map((r) =>
            r.recordId === f.reviewer.recordId ? replacement : r,
          ),
        };
        expect(
          (yield* sql
            .withTransaction(
              service.freeze(state, { reviewBindingId: f.reviewer.recordId, jobId: "job" }),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
    }).pipe(Effect.provide(f.layer));
  }),
);
it.live(
  "retains the original report and requires independent fresh resolution before completion",
  () =>
    Effect.gen(function* () {
      using f = fixture();
      yield* Effect.gen(function* () {
        const sql = yield* table;
        const service = yield* Review.ProjectTeamReviewFreshness;
        yield* sql.withTransaction(
          service.freeze(f.state, { reviewBindingId: f.reviewer.recordId, jobId: "job" }),
        );
        const reviewer = {
          ...f.reviewer,
          status: "running" as const,
          runId: RunId.make("review-run"),
          runAttemptId: RunAttemptId.make("review-run-attempt"),
          nodeId: NodeId.make("review-node"),
          sessionId: ProviderSessionId.make("review-session"),
        };
        f.state.foundationRecords = f.state.foundationRecords!.map((r) =>
          r.recordId === reviewer.recordId ? reviewer : r,
        );
        const intent = {
          type: "project-team.review.finding.record" as const,
          commandId: "finding-command",
          projectId,
          taskId: reviewTaskId,
          expectedRevision: 0,
          expectedTaskRevision: 0,
          specRevision: 0,
          planRevision: 0,
          findingId: "finding",
          revision: 0,
          severity: "medium" as const,
          criterionIds: [ProjectWorkCriterionId.make("criterion")],
          detail: "Code fails requirement",
          status: "open" as const,
          resolutionArtifactIds: [],
        };
        const command = yield* service.compile(
          f.state,
          yield* decodeEffectProjectTeamReviewFindingIntent(intent),
          f.attribution,
        );
        f.state.foundationRecords!.push(...command.records);
        const resolved = {
          ...intent,
          revision: 1,
          status: "resolved" as const,
          resolutionArtifactIds: ["job:stdout"],
        };
        expect(
          (yield* service
            .compile(
              f.state,
              yield* decodeEffectProjectTeamReviewFindingIntent(resolved),
              f.attribution,
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        f.state.foundationRecords = f.state.foundationRecords!.map((r) =>
          r.kind === "review-finding"
            ? { ...r, originReviewer: { ...r.originReviewer, bindingId: "prior-review-binding" } }
            : r,
        );
        const resolution = yield* service.compile(
          f.state,
          yield* decodeEffectProjectTeamReviewFindingIntent(resolved),
          f.attribution,
        );
        expect(resolution.transition?.kind).toBe("review.resolve");
        if (resolution.transition?.kind !== "review.resolve") throw new Error("missing resolution");
        expect(resolution.transition.proof.attemptId).toBe("verification-attempt");
        expect(resolution.transition.proof.artifacts[0]?.byteCount).toBe(8);
        const completedFinding = resolution.transition.finding;
        f.state.foundationRecords = f.state.foundationRecords!.map((r) =>
          r.kind === "review-finding" ? completedFinding : r,
        );
        const refresh = yield* decodeEffectProjectTeamReviewFindingIntent({
          ...resolved,
          revision: 2,
        });
        expect(
          (yield* service.compile(f.state, refresh, f.attribution).pipe(Effect.result))._tag,
        ).toBe("Failure");
        f.state.foundationRecords = f.state.foundationRecords!.map((r) =>
          r.kind === "review-finding"
            ? { ...r, reportedBy: { ...r.reportedBy, targetSha256: "f".repeat(64) } }
            : r,
        );
        const renewed = yield* service.compile(f.state, refresh, f.attribution);
        expect(renewed.transition?.kind).toBe("review.resolve");

        expect(resolution.transition.finding.target).toEqual(
          command.records[0]?.kind === "review-finding" ? command.records[0].target : undefined,
        );
      }).pipe(Effect.provide(f.layer));
    }),
);
it.live(
  "completion consumes the exact retained report after drain and stales on changed evidence",
  () =>
    Effect.gen(function* () {
      using f = fixture();
      yield* Effect.gen(function* () {
        const sql = yield* table;
        const service = yield* Review.ProjectTeamReviewFreshness;
        yield* sql.withTransaction(
          service.freeze(f.state, { reviewBindingId: f.reviewer.recordId, jobId: "job" }),
        );
        const reviewer = yield* decodeEffectProjectTeamRunBinding({
          ...f.reviewer,
          status: "running",
          runId: "review-run",
          runAttemptId: "review-native-attempt",
          nodeId: "review-node",
          sessionId: "review-session",
        });
        f.state.foundationRecords = f.state.foundationRecords!.map((r) =>
          r.recordId === reviewer.recordId ? reviewer : r,
        );
        f.state.evidence.push({
          evidenceId: ProjectWorkEvidenceId.make("verification-evidence"),
          taskId,
          kind: "observation",
          summary: "Verification passed",
          scopeHash: f.source.scopeHash!,
          recordedAt: at,
          revision: 0,
          attribution: f.attribution,
        });
        const report = yield* decodeEffectProjectTeamGuidedIntent({
          type: "project-team.assignment.report",
          commandId: "report-command",
          projectId,
          taskId: reviewTaskId,
          expectedRevision: 0,
          expectedTaskRevision: 0,
          specRevision: 0,
          planRevision: 0,
          assignmentId: f.assignment.recordId,
          expectedAssignmentRevision: 0,
          summary: "Independent review complete",
          evidenceIds: [],
          outputArtifactIds: [],
          outcome: "complete",
          criterionAssessments: [
            {
              criterionId: "criterion",
              expectedRevision: 0,
              verdict: "met",
              detail: "Checked",
              evidenceIds: ["verification-evidence"],
            },
          ],
        });
        if (report.type !== "project-team.assignment.report") throw new Error("wrong fixture");
        yield* sql.withTransaction(service.propose(f.state, report, f.attribution));
        f.state.revision = 1;
        const join = {
          assignmentOperationId: "assignment",
          assignmentRequestHash: "a".repeat(64),
          assignmentReceiptSha256: "b".repeat(64),
          joinedReceiptId: "canonical-joined-receipt",
          joinedEvidenceSha256: "d".repeat(64),
        };
        const proof = yield* sql.withTransaction(
          service.completeRetained(f.state, reviewer.recordId, join),
        );
        expect(proof.status).toBe("completed");
        if (proof.status !== "completed") throw new Error("expected completion");
        expect(proof.report).toEqual(report);
        expect(proof.proposalSha256).toBe(reviewDigest(report));
        expect(reviewCompletionDrafts(f.state, proof, at)[0]?.taskId).toBe(reviewTaskId);
        f.state.foundationRecords = f.state.foundationRecords!.map((r) =>
          r.recordId === reviewer.recordId ? { ...reviewer, status: "settled" } : r,
        );
        expect(
          (yield* service.completed(f.state, reviewer.recordId).pipe(Effect.result))._tag,
        ).toBe("Failure");
        f.state.tasks = f.state.tasks.map((t) =>
          t.taskId === reviewer.taskId ? { ...t, state: "completed" } : t,
        );
        yield* service.completed(f.state, reviewer.recordId);
        f.state.evidence = f.state.evidence.map((e) => ({
          ...e,
          revision: 1,
          summary: "Changed evidence",
        }));
        expect(
          (yield* service.completed(f.state, reviewer.recordId).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(f.layer));
    }),
);
