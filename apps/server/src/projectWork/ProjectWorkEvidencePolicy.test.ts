import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ProjectTeamEvidenceApplicability, ProjectWorkTaskId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  evaluateCommittedEvidence,
  type CommittedEvidenceTarget,
} from "./ProjectWorkEvidencePolicy.ts";

const target: CommittedEvidenceTarget = {
  projectId: ProjectId.make("project-1"),
  taskId: ProjectWorkTaskId.make("task-1"),
  specRevision: 3,
  planRevision: 5,
  repository: "github.com/team/repo",
  worktree: "/work/implementation",
  testedTree: "tree-1",
  testedCommit: "commit-1",
  baseSha: "base-1",
  headSha: "head-1",
  environmentSummary: "Linux; Node 24; installed dependencies digest-1",
};
const evidence = Schema.decodeUnknownSync(ProjectTeamEvidenceApplicability)({
  kind: "evidence-applicability",
  recordId: "applicability-1",
  projectId: "project-1",
  revision: 1,
  generation: 0,
  updatedAt: "2026-09-30T00:00:00Z",
  status: "current",
  taskId: "task-1",
  evidenceId: "evidence-1",
  specRevision: 3,
  planRevision: 5,
  repository: "github.com/team/repo",
  worktree: "/work/implementation",
  testedTree: "tree-1",
  testedCommit: "commit-1",
  baseSha: "base-1",
  headSha: "head-1",
  command: "vp test run apps/server/src/feature.test.ts",
  exitCode: 0,
  artifactId: "raw-result-1",
  environmentSummary: "Linux; Node 24; installed dependencies digest-1",
  integration: false,
});
const input = {
  evidence,
  target,
  retainedArtifactIds: new Set(["raw-result-1"]),
  requireIntegration: false,
};

describe("committed code evidence applicability", () => {
  it("qualifies an exact successful retained result for its trusted snapshot", () => {
    expect(evaluateCommittedEvidence(input)).toEqual({ status: "accepted" });
  });

  it("qualifies integration evidence only when the combined snapshot matches", () => {
    const integration = {
      ...input,
      evidence: { ...evidence, integration: true },
      requireIntegration: true,
    };
    expect(evaluateCommittedEvidence(integration)).toEqual({ status: "accepted" });
    expect(
      evaluateCommittedEvidence({
        ...integration,
        target: { ...target, baseSha: "base-2", headSha: "head-2" },
      }),
    ).toEqual({ status: "rejected", reasons: ["base-mismatch", "head-mismatch"] });
  });

  it("never promotes a dirty tested tree to a later commit even when head and command match", () => {
    const { testedCommit: _testedCommit, ...dirty } = evidence;
    expect(evaluateCommittedEvidence({ ...input, evidence: dirty })).toEqual({
      status: "rejected",
      reasons: ["tested-commit-missing"],
    });
    expect(
      evaluateCommittedEvidence({
        ...input,
        evidence: dirty,
        target: { ...target, testedCommit: target.headSha, testedTree: "committed-tree-2" },
      }),
    ).toEqual({ status: "rejected", reasons: ["tested-tree-mismatch", "tested-commit-missing"] });
  });

  for (const [name, changedTarget, reason] of [
    ["project", { ...target, projectId: ProjectId.make("project-2") }, "project-mismatch"],
    ["task", { ...target, taskId: ProjectWorkTaskId.make("task-2") }, "task-mismatch"],
    ["specification", { ...target, specRevision: 4 }, "spec-mismatch"],
    ["plan", { ...target, planRevision: 6 }, "plan-mismatch"],
    ["repository", { ...target, repository: "github.com/team/repo-other" }, "repository-mismatch"],
    ["worktree", { ...target, worktree: "/work/implementation-other" }, "worktree-mismatch"],
    ["tree", { ...target, testedTree: "tree-2" }, "tested-tree-mismatch"],
    ["tested commit", { ...target, testedCommit: "commit-2" }, "tested-commit-mismatch"],
    ["base", { ...target, baseSha: "base-2" }, "base-mismatch"],
    ["PR head", { ...target, headSha: "head-2" }, "head-mismatch"],
    [
      "environment",
      { ...target, environmentSummary: "Linux; Node 24; installed dependencies digest-2" },
      "environment-mismatch",
    ],
  ] as const) {
    it(`invalidates evidence when the current ${name} changes`, () => {
      expect(evaluateCommittedEvidence({ ...input, target: changedTarget })).toEqual({
        status: "rejected",
        reasons: [reason],
      });
    });
  }

  it("compares identities exactly without trimming, case folding or path normalization", () => {
    for (const changedTarget of [
      { ...target, repository: "GitHub.com/team/repo" },
      { ...target, repository: "github.com/team/repo " },
      { ...target, worktree: "/work/implementation/" },
      { ...target, testedCommit: "commit-1-longer" },
    ])
      expect(evaluateCommittedEvidence({ ...input, target: changedTarget }).status).toBe(
        "rejected",
      );
  });

  it("does not infer a tested commit from the current head or a tested tree from a commit", () => {
    expect(
      evaluateCommittedEvidence({ ...input, target: { ...target, testedCommit: target.headSha } }),
    ).toEqual({ status: "rejected", reasons: ["tested-commit-mismatch"] });
    expect(
      evaluateCommittedEvidence({ ...input, evidence: { ...evidence, testedTree: "dirty-tree" } }),
    ).toEqual({ status: "rejected", reasons: ["tested-tree-mismatch"] });
  });

  for (const status of ["stale", "rejected"] as const) {
    it(`never qualifies ${status} evidence even with an exact snapshot and retained artifact`, () => {
      expect(evaluateCommittedEvidence({ ...input, evidence: { ...evidence, status } })).toEqual({
        status: "rejected",
        reasons: ["evidence-not-current"],
      });
    });
  }

  it("requires a successful command with retained raw output", () => {
    expect(evaluateCommittedEvidence({ ...input, evidence: { ...evidence, exitCode: 1 } })).toEqual(
      { status: "rejected", reasons: ["command-failed"] },
    );
    expect(
      evaluateCommittedEvidence({ ...input, evidence: { ...evidence, command: " \n\t" } }),
    ).toEqual({ status: "rejected", reasons: ["command-missing"] });
    expect(
      evaluateCommittedEvidence({
        ...input,
        retainedArtifactIds: new Set(["raw-result-1-other", "raw-result-"]),
      }),
    ).toEqual({ status: "rejected", reasons: ["artifact-not-retained"] });
  });

  it("rejects blank artifact and environment references even if they are retained or equal", () => {
    expect(
      evaluateCommittedEvidence({
        ...input,
        evidence: { ...evidence, artifactId: "   " },
        retainedArtifactIds: new Set(["   "]),
      }),
    ).toEqual({ status: "rejected", reasons: ["artifact-missing"] });
    expect(
      evaluateCommittedEvidence({ ...input, evidence: { ...evidence, environmentSummary: "  " } }),
    ).toEqual({ status: "rejected", reasons: ["environment-missing", "environment-mismatch"] });
    expect(
      evaluateCommittedEvidence({ ...input, target: { ...target, environmentSummary: "  " } }),
    ).toEqual({ status: "rejected", reasons: ["invalid-target"] });
  });

  it("requires integration evidence when requested but allows it for a normal check", () => {
    expect(evaluateCommittedEvidence({ ...input, requireIntegration: true })).toEqual({
      status: "rejected",
      reasons: ["integration-required"],
    });
    expect(
      evaluateCommittedEvidence({ ...input, evidence: { ...evidence, integration: true } }),
    ).toEqual({ status: "accepted" });
  });

  it("rejects malformed records and incomplete target snapshots without echoing their values", () => {
    for (const invalidEvidence of [
      { ...evidence, exitCode: NaN },
      { ...evidence, artifactId: "" },
      { ...evidence, environmentSummary: "" },
      { ...evidence, command: "sensitive".repeat(4001) },
    ])
      expect(evaluateCommittedEvidence({ ...input, evidence: invalidEvidence })).toEqual({
        status: "rejected",
        reasons: ["invalid-evidence"],
      });
    expect(
      evaluateCommittedEvidence({ ...input, target: { ...target, testedCommit: "" } }),
    ).toEqual({ status: "rejected", reasons: ["invalid-target"] });
  });

  it("reports all mismatches in a deterministic bounded order with no command or environment echo", () => {
    const result = evaluateCommittedEvidence({
      ...input,
      evidence: {
        ...evidence,
        status: "stale",
        command: "secret-placeholder-command",
        exitCode: 2,
        integration: false,
      },
      target: {
        ...target,
        taskId: ProjectWorkTaskId.make("task-2"),
        specRevision: 9,
        environmentSummary: "secret-placeholder-environment",
      },
      retainedArtifactIds: new Set(),
      requireIntegration: true,
    });
    expect(result).toEqual({
      status: "rejected",
      reasons: [
        "evidence-not-current",
        "command-failed",
        "artifact-not-retained",
        "task-mismatch",
        "spec-mismatch",
        "environment-mismatch",
        "integration-required",
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret-placeholder");
  });

  it("does not mutate supplied evidence, target or retained IDs on either result", () => {
    const frozen = {
      ...input,
      evidence: Object.freeze({ ...evidence }),
      target: Object.freeze({ ...target }),
      retainedArtifactIds: Object.freeze(new Set(["raw-result-1", "unrelated"])),
    };
    const before = {
      evidence: { ...frozen.evidence },
      target: { ...frozen.target },
      retained: [...frozen.retainedArtifactIds],
    };
    expect(evaluateCommittedEvidence(frozen)).toEqual({ status: "accepted" });
    expect(evaluateCommittedEvidence({ ...frozen, requireIntegration: true })).toEqual({
      status: "rejected",
      reasons: ["integration-required"],
    });
    expect(frozen.evidence).toEqual(before.evidence);
    expect(frozen.target).toEqual(before.target);
    expect([...frozen.retainedArtifactIds]).toEqual(before.retained);
    expect(evaluateCommittedEvidence(frozen)).toEqual({ status: "accepted" });
  });
});
