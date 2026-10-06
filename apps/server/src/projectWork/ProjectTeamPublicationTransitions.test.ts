import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectTeamEffect,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkPublicationRequest,
  canonicalProjectWorkPayload,
  type ProjectWorkPublicationOutcome,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  emptyProjectWorkReducerState,
} from "./ProjectWorkDecider.ts";
import { deriveProjectWorkTaskPolicy } from "./ProjectWorkPolicy.ts";

const decodeEffect = Schema.decodeUnknownSync(ProjectTeamEffect);
const decodeCommand = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const at = "2026-10-05T00:00:00.000Z";
const projectId = ProjectId.make("publication-project");
const taskId = ProjectWorkTaskId.make("publication-task");
const attribution = {
  actor: { kind: "system", id: "project-work-github-outbox" },
  source: { kind: "system", id: "project-work-github-outbox" },
  recordedAt: at,
} as const;
const request = Schema.decodeUnknownSync(ProjectWorkPublicationRequest)({
  version: 1,
  kind: "create-pr",
  operationId: "publication",
  marker: "opaque_marker_123456789",
  repository: { host: "github.com", nodeId: "repo-node", nameWithOwner: "owner/repo" },
  target: {
    projectId,
    taskId,
    specRevision: 1,
    planRevision: 2,
    scopeHash: "scope",
    baseSha: "base",
    headSha: "head",
    baseRef: "main",
    headRef: "task",
    headRepositoryNodeId: "fork-node",
    headSelector: "owner:task",
  },
  expectedTaskRevision: 0,
  authorizationRecordIds: ["review"],
  title: "Task PR",
  body: "Task work",
});
const requestHash = NodeCrypto.createHash("sha256")
  .update(canonicalProjectWorkPayload(request))
  .digest("hex");
const fixture = (status: "pending" | "claimed" | "uncertain" | "succeeded" = "claimed") => {
  const empty = emptyProjectWorkReducerState(projectId);
  const created = applyProjectWorkEvents(
    empty,
    decideProjectWorkCommand(empty, {
      type: "project-work.task.create",
      projectId,
      taskId,
      commandId: CommandId.make("task-create"),
      title: "Task",
      createdAt: at,
    }),
  );
  const effect = decodeEffect({
    kind: "effect",
    recordId: request.operationId,
    effectId: request.operationId,
    projectId,
    taskId,
    revision: 1,
    generation: 0,
    updatedAt: at,
    effectKind: "publication",
    status,
    targetId: "github.com/owner/repo",
    payload: {
      recordIds: request.authorizationRecordIds,
      expectedRevision: request.expectedTaskRevision,
      summary: canonicalProjectWorkPayload(request),
    },
    claimGeneration: status === "pending" ? 0 : 1,
    availableAt: at,
  });
  const state = { ...created, revision: 10, foundationRecords: [effect] };
  const receipt: ProjectWorkPublicationOutcome = {
    version: 1,
    kind: "confirmed",
    operationId: request.operationId,
    requestHash,
    claimGeneration: 1,
    observedAt: at,
    marker: request.marker,
    repository: request.repository,
    pullRequest: {
      nodeId: "pr-node",
      number: 3,
      url: "https://github.com/owner/repo/pull/3",
      state: "OPEN",
      baseSha: "base",
      headSha: "head",
      baseRef: "main",
      headRef: "task",
      headRepositoryNodeId: "fork-node",
    },
  };
  const command = decodeCommand({
    type: "project-work.foundation.commit",
    projectId,
    commandId: "publication-reflect",
    expectedRevision: state.revision,
    records: [],
    attribution,
    committedAt: at,
    transition: {
      kind: "publication.reflect",
      effectId: effect.effectId,
      expectedEffectRevision: effect.revision,
      claimGeneration: 1,
      receipt,
    },
  });
  return { state, effect, receipt, command };
};
describe("private publication transitions", () => {
  it("claims a pending request once without changing its immutable envelope", () => {
    const f = fixture("pending");
    const command = {
      ...f.command,
      transition: {
        kind: "publication.claim" as const,
        effectId: f.effect.effectId,
        expectedEffectRevision: f.effect.revision,
        expectedClaimGeneration: 0,
      },
    };
    const next = applyProjectWorkEvents(f.state, decideProjectWorkCommand(f.state, command));
    expect(next.foundationRecords?.[0]).toMatchObject({
      status: "claimed",
      revision: 2,
      claimGeneration: 1,
      payload: f.effect.payload,
    });
    expect(() =>
      decideProjectWorkCommand(next, { ...command, expectedRevision: next.revision }),
    ).toThrow();
  });
  for (const status of ["claimed", "uncertain"] as const)
    it(`confirms an exact ${status} publication without completing the task`, () => {
      const f = fixture(status);
      const next = applyProjectWorkEvents(f.state, decideProjectWorkCommand(f.state, f.command));
      expect(next.foundationRecords?.[0]).toMatchObject({
        status: "succeeded",
        revision: 2,
        claimGeneration: 1,
        outcome: canonicalProjectWorkPayload(f.receipt),
      });
      expect(next.tasks).toEqual(f.state.tasks);
    });
  it("retains uncertainty instead of enabling another send", () => {
    const f = fixture();
    const receipt: ProjectWorkPublicationOutcome = {
      version: 1,
      kind: "uncertain",
      operationId: request.operationId,
      requestHash,
      claimGeneration: 1,
      observedAt: at,
      reason: "missing-match",
    };
    const next = applyProjectWorkEvents(
      f.state,
      decideProjectWorkCommand(f.state, {
        ...f.command,
        transition: {
          ...f.command.transition!,
          kind: "publication.reflect",
          effectId: f.effect.effectId,
          expectedEffectRevision: 1,
          claimGeneration: 1,
          receipt,
        },
      }),
    );
    expect(next.foundationRecords?.[0]).toMatchObject({
      status: "uncertain",
      outcome: canonicalProjectWorkPayload(receipt),
    });
    expect(deriveProjectWorkTaskPolicy(next, taskId).attention[0]).toMatchObject({
      reason: "blocked",
      detail:
        "PR publication 'publication' has an uncertain outcome. Review the remote result before retrying.",
    });
    const confirmed = applyProjectWorkEvents(
      next,
      decideProjectWorkCommand(next, {
        ...f.command,
        commandId: CommandId.make("confirm-publication"),
        expectedRevision: next.revision,
        transition: {
          kind: "publication.reflect",
          effectId: f.effect.effectId,
          expectedEffectRevision: 2,
          claimGeneration: 1,
          receipt: f.receipt,
        },
      }),
    );
    expect(deriveProjectWorkTaskPolicy(confirmed, taskId).attention).toEqual([]);
  });
  for (const field of ["marker", "requestHash", "operationId", "claimGeneration"] as const)
    it(`rejects changed receipt ${field}`, () => {
      const f = fixture();
      const receipt = {
        ...f.receipt,
        [field]:
          field === "claimGeneration" ? 2 : field === "requestHash" ? "0".repeat(64) : "wrong",
      };
      expect(() =>
        decideProjectWorkCommand(
          f.state,
          decodeCommand({
            ...f.command,
            transition: { ...f.command.transition, receipt },
          }),
        ),
      ).toThrow();
    });
  for (const field of [
    "baseSha",
    "headSha",
    "baseRef",
    "headRef",
    "headRepositoryNodeId",
    "url",
  ] as const)
    it(`rejects changed remote ${field}`, () => {
      const f = fixture();
      if (f.receipt.kind !== "confirmed") throw new Error("fixture");
      const receipt = { ...f.receipt, pullRequest: { ...f.receipt.pullRequest, [field]: "wrong" } };
      expect(() =>
        decideProjectWorkCommand(
          f.state,
          decodeCommand({
            ...f.command,
            transition: { ...f.command.transition, receipt },
          }),
        ),
      ).toThrow();
    });
  it("rejects terminal reflection and claims of uncertain work", () => {
    const f = fixture("succeeded");
    expect(() => decideProjectWorkCommand(f.state, f.command)).toThrow();
    const uncertain = fixture("uncertain");
    expect(() =>
      decideProjectWorkCommand(uncertain.state, {
        ...uncertain.command,
        transition: {
          kind: "publication.claim",
          effectId: "publication",
          expectedEffectRevision: 1,
          expectedClaimGeneration: 1,
        },
      }),
    ).toThrow();
  });
  it("requires unmixed dedicated system attribution", () => {
    const f = fixture();
    for (const command of [
      {
        ...f.command,
        attribution: { ...attribution, actor: { kind: "human" as const, id: "reviewer" } },
      },
      { ...f.command, records: [f.effect] },
      { ...f.command, expectedRevision: 9 },
    ])
      expect(() => decideProjectWorkCommand(f.state, command)).toThrow();
  });
  it("plain outcome text cannot settle a publication, including one whose response is uncertain", () => {
    for (const status of ["claimed", "uncertain"] as const) {
      const f = fixture(status);
      const generic = decodeCommand({
        type: "project-work.foundation.commit",
        commandId: "plain-text",
        projectId,
        expectedRevision: f.state.revision,
        committedAt: at,
        attribution,
        records: [{ ...f.effect, status: "succeeded", revision: 2, outcome: "PR created" }],
      });
      expect(() => decideProjectWorkCommand(f.state, generic)).toThrow(/typed private transition/);
    }
  });
});
