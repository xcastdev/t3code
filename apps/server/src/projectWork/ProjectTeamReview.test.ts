import { ProjectId, ProjectWorkTaskId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  evaluateReviewSessionEligibility,
  evaluateReviewFindingTransition,
  type ReviewFinding,
  type ReviewFindingInput,
  type ReviewSessionInput,
  type ReviewTarget,
} from "./ProjectTeamReview.ts";

const target: ReviewTarget = {
  projectId: ProjectId.make("project-a"),
  taskId: ProjectWorkTaskId.make("task-a"),
  specRevision: 2,
  planRevision: 3,
  baseSha: "base-a",
  headSha: "head-a",
};
const reviewer: ReviewSessionInput["reviewer"]["identity"] = {
  memberId: "reviewer",
  runId: "review-run",
  threadId: ThreadId.make("review-thread"),
  providerInstanceId: ProviderInstanceId.make("pi-a"),
  sessionId: "review-session",
};
const implementer: typeof reviewer = {
  memberId: "implementer",
  runId: "implementation-run",
  threadId: ThreadId.make("implementation-thread"),
  providerInstanceId: ProviderInstanceId.make("pi-a"),
  sessionId: "implementation-session",
};
const sessionInput = (): ReviewSessionInput => ({
  target,
  reviewer: { target, identity: reviewer },
  implementers: [implementer],
  sessionObservation: {
    identity: reviewer,
    fresh: true,
    resumed: false,
    conversationHistoryPresent: false,
  },
});

const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  findingId: "finding-a",
  severity: "high",
  criterionIds: ["criterion-a"],
  target,
  revision: 0,
  status: "open",
  detail: "The combined result loses the task selection.",
  resolutionArtifactIds: [],
  ...overrides,
});
const findingInput = (): ReviewFindingInput => ({
  target,
  proposedFinding: finding(),
  currentCriterionIds: ["criterion-a"],
  retainedResolutionEvidence: [],
});

describe("review finding transitions", () => {
  it("resolves the exact named finding revision and recognizes its identical retry", () => {
    const resolved = finding({
      revision: 1,
      status: "resolved",
      resolutionArtifactIds: ["proof-a"],
    });
    const input = {
      ...findingInput(),
      proposedFinding: resolved,
      retainedResolutionEvidence: [
        { artifactId: "proof-a", target, findings: [{ findingId: "finding-a", revision: 1 }] },
      ],
    };
    expect(evaluateReviewFindingTransition({ ...input, currentFinding: finding() })).toEqual({
      status: "accepted",
    });
    expect(evaluateReviewFindingTransition({ ...input, currentFinding: resolved })).toEqual({
      status: "duplicate",
    });
    expect(
      evaluateReviewFindingTransition({
        ...input,
        currentFinding: finding(),
        proposedFinding: { ...resolved, revision: 2 },
        retainedResolutionEvidence: [
          { artifactId: "proof-a", target, findings: [{ findingId: "finding-a", revision: 2 }] },
        ],
      }),
    ).toEqual({ status: "rejected", reason: "invalid-next-revision" });
  });

  it("rejects proof for old finding wording even when its stable ID and head still match", () => {
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        currentFinding: finding(),
        proposedFinding: finding({
          revision: 1,
          status: "resolved",
          detail: "The finding now includes all task links.",
          resolutionArtifactIds: ["proof-a"],
        }),
        retainedResolutionEvidence: [
          { artifactId: "proof-a", target, findings: [{ findingId: "finding-a", revision: 0 }] },
        ],
      }),
    ).toEqual({ status: "rejected", reason: "stale-resolution-finding" });
  });

  it("resolves the original stable finding with explicit evidence for a repaired base and head", () => {
    const repaired = { ...target, baseSha: "base-b", headSha: "head-b" };
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        target: repaired,
        currentFinding: finding(),
        proposedFinding: finding({
          revision: 1,
          status: "resolved",
          resolutionArtifactIds: ["repair-proof"],
        }),
        retainedResolutionEvidence: [
          {
            artifactId: "repair-proof",
            target: repaired,
            findings: [{ findingId: "finding-a", revision: 1 }],
          },
        ],
      }),
    ).toEqual({ status: "accepted" });
  });

  it("accepts a new finding for a current criterion and exact target", () => {
    expect(evaluateReviewFindingTransition(findingInput())).toEqual({ status: "accepted" });
  });

  it("cannot relabel an old finding onto a changed head by increasing its revision", () => {
    const changed = { ...target, headSha: "head-b" };
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        target: changed,
        currentFinding: finding(),
        proposedFinding: finding({ target: changed, revision: 1 }),
      }),
    ).toEqual({ status: "rejected", reason: "stale-finding-target" });
  });
});

describe("review session independence", () => {
  it("accepts a fresh independent session for the exact review target", () => {
    expect(evaluateReviewSessionEligibility(sessionInput())).toEqual({ status: "eligible" });
  });

  it("rejects an implementer session even under different member, run and thread IDs", () => {
    const input = sessionInput();
    expect(
      evaluateReviewSessionEligibility({
        ...input,
        implementers: [{ ...implementer, sessionId: reviewer.sessionId }],
      }),
    ).toEqual({ status: "rejected", reason: "implementer-session" });
  });
});

describe("review policy boundaries", () => {
  const invalidFindingReferences = [
    undefined,
    [],
    [{ findingId: "finding-a", revision: -1 }],
    [{ findingId: "finding-a", revision: 0.5 }],
    [{ findingId: "finding-a", revision: Number.MAX_SAFE_INTEGER + 1 }],
    [{ findingId: "finding-a" }],
    [
      { findingId: "finding-a", revision: 0 },
      { findingId: "finding-a", revision: 1 },
    ],
    Array.from({ length: 65 }, (_, revision) => ({ findingId: `finding-${revision}`, revision })),
  ];
  it.each(invalidFindingReferences.map((findings) => ({ findings })))(
    "requires unambiguous bounded finding revision references",
    ({ findings }) => {
      expect(
        evaluateReviewFindingTransition({
          ...findingInput(),
          proposedFinding: finding({ status: "resolved", resolutionArtifactIds: ["proof-a"] }),
          retainedResolutionEvidence: [{ artifactId: "proof-a", target, findings }],
        }),
      ).toEqual({ status: "rejected", reason: "invalid-input" });
    },
  );

  it("does not accept the old bare finding-ID proof format", () => {
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        proposedFinding: finding({ status: "resolved", resolutionArtifactIds: ["proof-a"] }),
        retainedResolutionEvidence: [{ artifactId: "proof-a", target, findingIds: ["finding-a"] }],
      }),
    ).toEqual({ status: "rejected", reason: "invalid-input" });
  });

  it.each([
    ["memberId", "implementer-member"],
    ["runId", "implementer-run"],
    ["threadId", "implementer-thread"],
  ] as const)("rejects reused implementer %s", (key, reason) => {
    expect(
      evaluateReviewSessionEligibility({
        ...sessionInput(),
        implementers: [{ ...implementer, [key]: reviewer[key] }],
      }),
    ).toEqual({ status: "rejected", reason });
  });

  it("compares native session IDs within their provider instance", () => {
    expect(
      evaluateReviewSessionEligibility({
        ...sessionInput(),
        implementers: [
          { ...implementer, providerInstanceId: "pi-b", sessionId: reviewer.sessionId },
        ],
      }),
    ).toEqual({ status: "eligible" });
  });

  it("checks historical implementers as well as the latest one", () => {
    expect(
      evaluateReviewSessionEligibility({
        ...sessionInput(),
        implementers: [implementer, { ...implementer, threadId: reviewer.threadId }],
      }),
    ).toEqual({ status: "rejected", reason: "implementer-thread" });
  });

  it.each([
    ["projectId", "project-b"],
    ["taskId", "task-b"],
    ["specRevision", 4],
    ["planRevision", 4],
    ["baseSha", "base-b"],
    ["headSha", "head-b"],
  ])("requires the reviewer to have the current %s", (key, value) => {
    expect(
      evaluateReviewSessionEligibility({
        ...sessionInput(),
        reviewer: { identity: reviewer, target: { ...target, [key]: value } },
      }),
    ).toEqual({ status: "rejected", reason: "stale-review-target" });
  });

  it.each(["memberId", "runId", "threadId", "providerInstanceId", "sessionId"])(
    "binds host freshness proof to the exact %s",
    (key) => {
      const input = sessionInput();
      expect(
        evaluateReviewSessionEligibility({
          ...input,
          sessionObservation: {
            ...input.sessionObservation,
            identity: { ...reviewer, [key]: "other" },
          },
        }),
      ).toEqual({ status: "rejected", reason: "session-observation-mismatch" });
    },
  );

  it.each([{ fresh: false }, { resumed: true }, { conversationHistoryPresent: true }])(
    "rejects nonfresh sessions %j",
    (change) => {
      const input = sessionInput();
      expect(
        evaluateReviewSessionEligibility({
          ...input,
          sessionObservation: { ...input.sessionObservation, ...change },
        }),
      ).toEqual({ status: "rejected", reason: "fresh-session-required" });
    },
  );

  it.each([undefined, null, {}, { fresh: true }, "fresh"])(
    "requires explicit complete host observations %j",
    (sessionObservation) => {
      expect(evaluateReviewSessionEligibility({ ...sessionInput(), sessionObservation })).toEqual({
        status: "rejected",
        reason: "invalid-input",
      });
    },
  );

  it.each([undefined, "true", 1, null])("does not infer freshness from %j", (fresh) => {
    const input = sessionInput();
    expect(
      evaluateReviewSessionEligibility({
        ...input,
        sessionObservation: { ...input.sessionObservation, fresh },
      }),
    ).toEqual({ status: "rejected", reason: "invalid-input" });
  });

  it.each([undefined, "", " ", " session", "session ", "s".repeat(257)])(
    "requires an exact bounded native session ID",
    (sessionId) => {
      const input = sessionInput();
      const identity = { ...reviewer, sessionId };
      expect(
        evaluateReviewSessionEligibility({
          ...input,
          reviewer: { target, identity },
          sessionObservation: { ...input.sessionObservation, identity },
        }),
      ).toEqual({ status: "rejected", reason: "invalid-input" });
    },
  );

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe target revisions %s",
    (specRevision) => {
      const invalid = { ...target, specRevision };
      expect(
        evaluateReviewSessionEligibility({
          ...sessionInput(),
          target: invalid,
          reviewer: { identity: reviewer, target: invalid },
        }),
      ).toEqual({ status: "rejected", reason: "invalid-input" });
    },
  );

  it("bounds the complete implementer set without dropping the last entry", () => {
    const implementers = Array.from({ length: 256 }, (_, index) => ({
      ...implementer,
      memberId: `member-${index}`,
    }));
    expect(evaluateReviewSessionEligibility({ ...sessionInput(), implementers })).toEqual({
      status: "eligible",
    });
    expect(
      evaluateReviewSessionEligibility({
        ...sessionInput(),
        implementers: [...implementers, implementer],
      }),
    ).toEqual({ status: "rejected", reason: "invalid-input" });
  });

  it("preserves a stable finding ID while revising its detail and severity", () => {
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        currentFinding: finding(),
        proposedFinding: finding({
          revision: 1,
          severity: "critical",
          detail: "The same selection failure affects all task links.",
        }),
      }),
    ).toEqual({ status: "accepted" });
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        currentFinding: finding(),
        proposedFinding: finding({ revision: 1, findingId: "replacement" }),
      }),
    ).toEqual({ status: "rejected", reason: "finding-identity-mismatch" });
  });

  it("recognizes an identical finding retry", () => {
    expect(
      evaluateReviewFindingTransition({ ...findingInput(), currentFinding: finding() }),
    ).toEqual({ status: "duplicate" });
  });

  it.each([
    { severity: "low" },
    { detail: "Changed conclusion" },
    { criterionIds: ["criterion-b"] },
  ])("rejects conflicting same-revision content %j", (change) => {
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        currentCriterionIds: ["criterion-a", "criterion-b"],
        currentFinding: finding(),
        proposedFinding: { ...finding(), ...change },
      }),
    ).toEqual({ status: "rejected", reason: "conflicting-finding-replay" });
  });

  it.each([1, 2, Number.MAX_SAFE_INTEGER])(
    "requires revision zero for a new finding %s",
    (revision) => {
      expect(
        evaluateReviewFindingTransition({
          ...findingInput(),
          proposedFinding: finding({ revision }),
        }),
      ).toEqual({ status: "rejected", reason: "invalid-initial-revision" });
    },
  );

  it.each([0, 1, 4, Number.MAX_SAFE_INTEGER])(
    "rejects revision %s after revision 2",
    (revision) => {
      expect(
        evaluateReviewFindingTransition({
          ...findingInput(),
          currentFinding: finding({ revision: 2 }),
          proposedFinding: finding({ revision }),
        }),
      ).toEqual({ status: "rejected", reason: "invalid-next-revision" });
    },
  );

  it("does not overflow a maximum-safe revision", () => {
    const currentFinding = finding({ revision: Number.MAX_SAFE_INTEGER });
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        currentFinding,
        proposedFinding: currentFinding,
      }),
    ).toEqual({ status: "duplicate" });
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        currentFinding,
        proposedFinding: finding(),
      }),
    ).toEqual({ status: "rejected", reason: "invalid-next-revision" });
  });

  it("does not use a finding to add an unknown criterion", () => {
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        proposedFinding: finding({ criterionIds: ["new-scope"] }),
      }),
    ).toEqual({ status: "rejected", reason: "unknown-criterion" });
  });

  it("requires every resolution artifact to remain retained even on an identical retry", () => {
    const resolved = finding({ status: "resolved", resolutionArtifactIds: ["proof-a", "proof-b"] });
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        currentFinding: resolved,
        proposedFinding: resolved,
        retainedResolutionEvidence: [
          { artifactId: "proof-a", target, findings: [{ findingId: "finding-a", revision: 0 }] },
        ],
      }),
    ).toEqual({ status: "rejected", reason: "resolution-artifact-not-retained" });
  });

  it("requires nonempty evidence naming the finding to resolve it", () => {
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        proposedFinding: finding({ status: "resolved" }),
      }),
    ).toEqual({ status: "rejected", reason: "resolution-evidence-required" });
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        proposedFinding: finding({ status: "resolved", resolutionArtifactIds: ["proof-a"] }),
        retainedResolutionEvidence: [
          {
            artifactId: "proof-a",
            target,
            findings: [{ findingId: "another-finding", revision: 0 }],
          },
        ],
      }),
    ).toEqual({ status: "rejected", reason: "resolution-finding-mismatch" });
  });

  it.each([
    ["projectId", "project-b"],
    ["taskId", "task-b"],
    ["specRevision", 4],
    ["planRevision", 4],
    ["baseSha", "base-b"],
    ["headSha", "head-b"],
  ])("rejects resolution proof with the wrong current %s", (key, value) => {
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        proposedFinding: finding({ status: "resolved", resolutionArtifactIds: ["proof-a"] }),
        retainedResolutionEvidence: [
          {
            artifactId: "proof-a",
            target: { ...target, [key]: value },
            findings: [{ findingId: "finding-a", revision: 0 }],
          },
        ],
      }),
    ).toEqual({ status: "rejected", reason: "stale-resolution-evidence" });
  });

  it.each([
    ["projectId", "project-b"],
    ["taskId", "task-b"],
    ["specRevision", 4],
    ["planRevision", 4],
  ])("never resolves old scope after %s changes", (key, value) => {
    const changed = { ...target, [key]: value };
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        target: changed,
        currentFinding: finding(),
        proposedFinding: finding({
          revision: 1,
          status: "resolved",
          resolutionArtifactIds: ["proof-a"],
        }),
        retainedResolutionEvidence: [
          {
            artifactId: "proof-a",
            target: changed,
            findings: [{ findingId: "finding-a", revision: 0 }],
          },
        ],
      }),
    ).toEqual({ status: "rejected", reason: "stale-finding-target" });
  });

  it("rejects missing or old proof after repair and never relabels the finding's origin", () => {
    const repaired = { ...target, headSha: "head-b" };
    const input = {
      ...findingInput(),
      target: repaired,
      currentFinding: finding(),
      proposedFinding: finding({
        revision: 1,
        status: "resolved",
        resolutionArtifactIds: ["proof-a"],
      }),
    };
    expect(evaluateReviewFindingTransition(input)).toEqual({
      status: "rejected",
      reason: "resolution-artifact-not-retained",
    });
    expect(
      evaluateReviewFindingTransition({
        ...input,
        retainedResolutionEvidence: [
          { artifactId: "proof-a", target, findings: [{ findingId: "finding-a", revision: 0 }] },
        ],
      }),
    ).toEqual({ status: "rejected", reason: "stale-resolution-evidence" });
    expect(
      evaluateReviewFindingTransition({
        ...input,
        proposedFinding: { ...input.proposedFinding, target: repaired },
        retainedResolutionEvidence: [
          {
            artifactId: "proof-a",
            target: repaired,
            findings: [{ findingId: "finding-a", revision: 0 }],
          },
        ],
      }),
    ).toEqual({ status: "rejected", reason: "stale-finding-target" });
    expect(
      evaluateReviewFindingTransition({ ...input, proposedFinding: finding({ revision: 1 }) }),
    ).toEqual({ status: "rejected", reason: "stale-finding-target" });
  });

  it("rejects ambiguous duplicate artifact applicability", () => {
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        retainedResolutionEvidence: [
          { artifactId: "proof-a", target, findings: [{ findingId: "finding-a", revision: 0 }] },
          {
            artifactId: "proof-a",
            target: { ...target, headSha: "old-head" },
            findings: [{ findingId: "finding-a", revision: 0 }],
          },
        ],
      }),
    ).toEqual({ status: "rejected", reason: "invalid-input" });
  });

  it("allows reopening with a new revision and no resolution claim", () => {
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        currentFinding: finding({ status: "resolved", resolutionArtifactIds: ["proof-a"] }),
        proposedFinding: finding({ revision: 1, detail: "The failure is reproducible again." }),
      }),
    ).toEqual({ status: "accepted" });
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        proposedFinding: finding({ resolutionArtifactIds: ["proof-a"] }),
      }),
    ).toEqual({ status: "rejected", reason: "invalid-resolution-state" });
  });

  it.each([
    "findingId",
    "detail",
    "severity",
    "criterionIds",
    "revision",
    "status",
    "resolutionArtifactIds",
  ])("requires finding field %s", (key) => {
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        proposedFinding: { ...finding(), [key]: undefined },
      }),
    ).toEqual({ status: "rejected", reason: "invalid-input" });
  });

  it.each(["", " ", "\n\t", "d".repeat(32_001)])(
    "requires nonempty bounded finding detail",
    (detail) => {
      expect(
        evaluateReviewFindingTransition({
          ...findingInput(),
          proposedFinding: finding({ detail }),
        }),
      ).toEqual({ status: "rejected", reason: "invalid-input" });
    },
  );

  it.each([
    { criterionIds: [] },
    { criterionIds: ["criterion-a", "criterion-a"] },
    { resolutionArtifactIds: ["proof-a", "proof-a"] },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { revision: -1 },
    { revision: 0.5 },
    { severity: "urgent" },
    { findingId: "f".repeat(257) },
    { findingId: " finding-a " },
  ])("rejects malformed finding fields %j", (change) => {
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        proposedFinding: { ...finding(), ...change },
      }),
    ).toEqual({ status: "rejected", reason: "invalid-input" });
  });

  it("accepts approved field limits and rejects oversized or duplicate criterion sets", () => {
    const criteria = Array.from({ length: 256 }, (_, index) => `criterion-${index}`);
    const bounded = { ...target, baseSha: "b".repeat(4_000), headSha: "h".repeat(4_000) };
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        target: bounded,
        currentCriterionIds: criteria,
        proposedFinding: finding({
          target: bounded,
          findingId: "f".repeat(256),
          detail: "d".repeat(32_000),
          criterionIds: criteria.slice(0, 64),
        }),
      }),
    ).toEqual({ status: "accepted" });
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        currentCriterionIds: [...criteria, "extra"],
      }),
    ).toEqual({ status: "rejected", reason: "invalid-input" });
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        currentCriterionIds: ["criterion-a", "criterion-a"],
      }),
    ).toEqual({ status: "rejected", reason: "invalid-input" });
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        proposedFinding: finding({ criterionIds: criteria.slice(0, 65) }),
        currentCriterionIds: criteria,
      }),
    ).toEqual({ status: "rejected", reason: "invalid-input" });
  });

  it("bounds referenced artifacts and authoritative resolution applicability", () => {
    const records = Array.from({ length: 256 }, (_, index) => ({
      artifactId: `proof-${index}`,
      target,
      findings: [{ findingId: "finding-a", revision: 0 }],
    }));
    const resolved = finding({
      status: "resolved",
      resolutionArtifactIds: records.slice(0, 64).map((r) => r.artifactId),
    });
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        proposedFinding: resolved,
        retainedResolutionEvidence: records,
      }),
    ).toEqual({ status: "accepted" });
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        proposedFinding: {
          ...resolved,
          resolutionArtifactIds: records.slice(0, 65).map((r) => r.artifactId),
        },
        retainedResolutionEvidence: records,
      }),
    ).toEqual({ status: "rejected", reason: "invalid-input" });
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        retainedResolutionEvidence: [
          ...records,
          { artifactId: "extra", target, findings: [{ findingId: "finding-a", revision: 0 }] },
        ],
      }),
    ).toEqual({ status: "rejected", reason: "invalid-input" });
  });

  it("does not trim opaque refs or identity values", () => {
    const invalid = { ...target, baseSha: " base-a " };
    expect(
      evaluateReviewFindingTransition({
        ...findingInput(),
        target: invalid,
        proposedFinding: finding({ target: invalid }),
      }),
    ).toEqual({ status: "rejected", reason: "invalid-input" });
  });

  it("leaves all supplied snapshots unchanged on acceptance, rejection and duplicate", () => {
    const session = sessionInput();
    const input = findingInput();
    const before = structuredClone({ session, input });
    evaluateReviewSessionEligibility(session);
    evaluateReviewFindingTransition(input);
    evaluateReviewSessionEligibility({ ...session, implementers: [reviewer] });
    evaluateReviewFindingTransition({ ...input, currentFinding: input.proposedFinding });
    expect({ session, input }).toEqual(before);
  });
});
