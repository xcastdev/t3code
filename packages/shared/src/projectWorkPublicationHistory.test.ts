import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  canonicalProjectWorkPayload,
  ProjectId,
  ProjectWorkTaskId,
  type ProjectTeamEffect,
  type ProjectWorkPublicationRequest,
} from "@t3tools/contracts";
import { readProjectWorkPublicationHistory } from "./projectWorkPublicationHistory.ts";

const projectId = ProjectId.make("history-project");
const taskId = ProjectWorkTaskId.make("history-task");
const at = "2026-10-06T00:00:00.000Z";
const request: ProjectWorkPublicationRequest = {
  version: 1,
  kind: "create-pr",
  operationId: "publication-one",
  marker: "publication_marker_one",
  repository: { host: "github.com", nodeId: "R_base", nameWithOwner: "owner/repo" },
  target: {
    projectId,
    taskId,
    specRevision: 2,
    planRevision: 3,
    scopeHash: "scope-one",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    baseRef: "main",
    headRef: "feature",
    headRepositoryNodeId: "R_base",
    headSelector: "feature",
  },
  expectedTaskRevision: 2,
  authorizationRecordIds: ["proof-one"],
  title: "Repair task",
  body: "Verified change.",
};
const receipt = {
  version: 1,
  kind: "confirmed",
  operationId: request.operationId,
  requestHash: NodeCrypto.createHash("sha256")
    .update(canonicalProjectWorkPayload(request))
    .digest("hex"),
  claimGeneration: 1,
  observedAt: at,
  marker: request.marker,
  repository: request.repository,
  pullRequest: {
    nodeId: "PR_one",
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    state: "MERGED",
    baseSha: request.target.baseSha,
    headSha: request.target.headSha,
    baseRef: "main",
    headRef: "feature",
    headRepositoryNodeId: "R_base",
  },
};
const effect: typeof ProjectTeamEffect.Type = {
  kind: "effect",
  recordId: request.operationId,
  effectId: request.operationId,
  projectId,
  revision: 2,
  generation: 0,
  updatedAt: at,
  status: "succeeded",
  effectKind: "publication",
  taskId,
  targetId: "github.com/owner/repo",
  payload: {
    recordIds: request.authorizationRecordIds,
    expectedRevision: 2,
    summary: canonicalProjectWorkPayload(request),
  },
  claimGeneration: 1,
  availableAt: at,
  outcome: canonicalProjectWorkPayload(receipt),
};

describe("recorded publication history", () => {
  it("keeps a confirmed merged PR readable with its frozen commit identities", () => {
    expect(readProjectWorkPublicationHistory(effect)).toEqual(receipt);
  });
  it.each([
    { ...effect, status: "uncertain" },
    { ...effect, projectId: ProjectId.make("other-project") },
    { ...effect, claimGeneration: 2 },
    { ...effect, outcome: "not JSON" },
    {
      ...effect,
      outcome: canonicalProjectWorkPayload({ ...receipt, requestHash: "0".repeat(64) }),
    },
    {
      ...effect,
      outcome: canonicalProjectWorkPayload({
        ...receipt,
        pullRequest: { ...receipt.pullRequest, url: "https://other.example/pull/42" },
      }),
    },
    {
      ...effect,
      outcome: canonicalProjectWorkPayload({
        ...receipt,
        pullRequest: { ...receipt.pullRequest, headSha: "later-head" },
      }),
    },
    { ...effect, outcome: canonicalProjectWorkPayload({ ...receipt, unexpected: true }) },
  ] satisfies (typeof ProjectTeamEffect.Type)[])(
    "withholds confirmation for inconsistent retained records %#",
    (record) => {
      expect(readProjectWorkPublicationHistory(record)).toBeUndefined();
    },
  );
});
