import { ProjectId, ProjectWorkTaskId, ProjectWorkRpcError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as Authority from "./ProjectWorkPublicationAuthorization.ts";
import * as Host from "./ProjectWorkPublicationHost.ts";
import * as Journal from "./ProjectWorkPublicationJournal.ts";
import type { ProjectWorkPrincipal } from "./ProjectWorkGateway.ts";
export const at = "2026-01-01T00:00:00.000Z";
export const principal: ProjectWorkPrincipal = {
  actor: { kind: "human", id: "human" },
  source: { kind: "web", id: "session" },
};
export const decision: Journal.PublicationDecision = {
  providerId: "github",
  account: { credentialFingerprint: "fingerprint", accountId: "1", viewer: "human" },
  cwd: "/owned/workspace",
  request: {
    version: 1,
    kind: "create-pr",
    operationId: "publish",
    marker: "publication_marker_12345",
    repository: { host: "github.com", nodeId: "repository", nameWithOwner: "owner/repo" },
    target: {
      projectId: ProjectId.make("project"),
      taskId: ProjectWorkTaskId.make("task"),
      specRevision: 0,
      planRevision: 0,
      scopeHash: "a".repeat(64),
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
      baseRef: "main",
      headRef: "feature",
      headRepositoryNodeId: "repository",
      headSelector: "feature",
    },
    expectedTaskRevision: 0,
    authorizationRecordIds: ["gate"],
    title: "Title",
    body: "Body",
  },
  gate: {
    kind: "gate",
    recordId: "gate",
    projectId: ProjectId.make("project"),
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "approved",
    taskId: ProjectWorkTaskId.make("task"),
    gate: "merge",
    specRevision: 0,
    planRevision: 0,
    contentHash: "a".repeat(64),
    attribution: { ...principal, recordedAt: at },
    repository: "owner/repo",
    headSha: "c".repeat(40),
    targetBranch: "main",
    mergeMethod: "squash",
    pullRequestNumber: 1,
    evidenceIds: [],
  },
  source: {
    taskId: ProjectWorkTaskId.make("task"),
    bindingId: "binding",
    bindingRevision: 0,
    generation: 0,
    dispatchId: "dispatch",
    workspaceReceiptSha256: "a".repeat(64),
    specRevision: 0,
    planRevision: 0,
    scopeHash: "a".repeat(64),
    branchRef: "feature",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    testedTree: "d".repeat(40),
    reviewDispatchId: "review",
    reviewProposalSha256: "a".repeat(64),
    joinedReceiptId: "receipt",
    jobId: "job",
    manifestHash: "a".repeat(64),
    attemptId: "attempt",
    resultHash: "a".repeat(64),
  },
  sourceRef: {
    taskId: ProjectWorkTaskId.make("task"),
    bindingId: "binding",
    expectedBindingRevision: 0,
    generation: 0,
    reviewDispatchId: "review",
    expectedReviewProposalSha256: "a".repeat(64),
    verificationJobId: "job",
    expectedManifestHash: "a".repeat(64),
    expectedBranchRef: "feature",
    expectedBaseSha: "b".repeat(40),
    expectedHeadSha: "c".repeat(40),
    expectedTestedTree: "d".repeat(40),
  },
};
export const input: Authority.PublicationInput = {
  operationId: "publish",
  projectId: decision.request.target.projectId,
  taskId: decision.request.target.taskId,
  gateId: "gate",
  sourceRef: decision.sourceRef,
  title: "Title",
  body: "Body",
};
export const outcome = (
  operation: Journal.DeliveryOperation,
): import("@t3tools/contracts").ProjectWorkPublicationOutcome => ({
  version: 1,
  operationId: operation.operationId,
  requestHash: Journal.publicationHash(operation.decision.request),
  claimGeneration: 1,
  observedAt: at,
  kind: "confirmed",
  marker: operation.decision.request.marker,
  repository: decision.request.repository,
  pullRequest: {
    nodeId: "pull",
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    state: "OPEN",
    baseSha: decision.source.baseSha,
    headSha: decision.source.headSha,
    baseRef: "main",
    headRef: "feature",
    headRepositoryNodeId: "repository",
  },
});
export const confirmation: Journal.MergeConfirmation = {
  providerId: "github",
  host: "github.com",
  repositoryNodeId: "repository",
  repository: "owner/repo",
  number: 1,
  authorizedHeadSha: decision.source.headSha,
  baseSha: decision.source.baseSha,
  baseRef: "main",
  mergedCommitSha: "e".repeat(40),
  mergedAt: at,
};
export const operation = (
  kind: "create-pr" | "merge" = "create-pr",
  stage: Journal.DeliveryOperation["stage"] = "approved",
): Journal.DeliveryOperation => {
  const value: Journal.DeliveryOperation = {
    operationId: kind === "merge" ? "merge" : "publish",
    kind,
    decision,
    decisionHash: Journal.publicationHash(decision),
    principal: { actor: principal.actor, source: principal.source },
    stage,
    ...(kind === "merge" ? { publicationOperationId: "publish" } : {}),
  };
  return kind === "merge" ? { ...value, publication: outcome(value) } : value;
};
export function dependencies(
  options: {
    authorization?: Authorization.ProjectTeamAuthorization["Service"];
    assertHuman?: Authorization.ProjectTeamAuthorization["Service"]["assertHuman"];
    assertCurrent?: Authority.ProjectWorkPublicationAuthorization["Service"]["assertCurrent"];
    host?: Partial<Host.ProjectWorkPublicationHost["Service"]>;
  } = {},
) {
  const unsupported = new Journal.PublicationError({ reason: "unsupported" });
  return Layer.mergeAll(
    Layer.succeed(
      Authorization.ProjectTeamAuthorization,
      options.authorization ?? {
        assertHuman: options.assertHuman ?? (() => Effect.void),
        assertHumanSourceControl: options.assertHuman ?? (() => Effect.void),
        assertManaged: () =>
          Effect.fail(new ProjectWorkRpcError({ operation: "write", reason: "forbidden" })),
        compile: () =>
          Effect.fail(new ProjectWorkRpcError({ operation: "write", reason: "forbidden" })),
      },
    ),
    Layer.succeed(Authority.ProjectWorkPublicationAuthorization, {
      prepare: () => Effect.succeed(decision),
      assertCurrent: options.assertCurrent ?? (() => Effect.void),
      assertReviewed: options.assertCurrent ?? (() => Effect.void),
    }),
    Layer.succeed(Host.ProjectWorkPublicationHost, {
      capture: () => Effect.fail(unsupported),
      assertCurrent: () => Effect.void,
      create: () => Effect.fail(unsupported),
      reconcilePublication: () => Effect.fail(unsupported),
      supportsExactMerge: () => Effect.succeed(false),
      mergeExact: () => Effect.fail(unsupported),
      reconcileMerge: () => Effect.succeed(undefined),
      ...options.host,
    }),
  );
}
