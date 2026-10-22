import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import type {
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
} from "./baseSchemas.ts";
import { ProjectMemorySource, ProjectMemorySourceRead } from "./projectMemory.ts";
import {
  ProjectTeamMemorySharesReplaceIntent,
  ProjectTeamRecordPage,
  ProjectTeamRecordRead,
  ProjectTeamReviewFindingProvenance,
  ProjectTeamRunBinding,
} from "./projectTeams.ts";
import {
  ProjectWorkAttempt,
  ProjectWorkCheckpointRead,
  ProjectWorkReadIntent,
} from "./projectWork.ts";
import type { ProjectWorkAttemptId } from "./projectWorkCore.ts";

const decodeProjectMemorySource = Schema.decodeUnknownSync(ProjectMemorySource);
const decodeProjectMemorySourceRead = Schema.decodeUnknownSync(ProjectMemorySourceRead);
const decodeProjectTeamMemorySharesReplaceIntent = Schema.decodeUnknownSync(
  ProjectTeamMemorySharesReplaceIntent,
);
const decodeProjectTeamRunBinding = Schema.decodeUnknownSync(ProjectTeamRunBinding);
const decodeProjectTeamRecordRead = Schema.decodeUnknownSync(ProjectTeamRecordRead);
const decodeProjectWorkReadIntent = Schema.decodeUnknownSync(ProjectWorkReadIntent);
const decodeProjectTeamRecordPage = Schema.decodeUnknownSync(ProjectTeamRecordPage);
const decodeProjectWorkCheckpointRead = Schema.decodeUnknownSync(ProjectWorkCheckpointRead);

const hash = "a".repeat(64);
const time = "2026-10-21T00:00:00.000Z";
const owner = { kind: "assistant", assistantId: "same-id" } as const;
const source = {
  recordId: "source-record",
  owner,
  ownerRevision: 2,
  revision: 3,
  generation: 0,
  updatedAt: time,
  kind: "memory-source",
  status: "current",
  sourceKind: "conversation",
  sourceId: "capture-1",
  sourceRevision: 1,
  content: "Prefer focused checks.",
  contentHash: hash,
  contentRevision: 5,
  conversationSpans: [
    {
      threadId: "thread-1",
      messageId: "message-1",
      contentHash: hash,
      contentRevision: 5,
      start: 0,
      end: 22,
    },
  ],
  attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: time },
};
const binding = {
  recordId: "binding-1",
  projectId: "project-1",
  revision: 0,
  generation: 0,
  updatedAt: time,
  kind: "run-binding",
  status: "reserved",
  taskId: "task-1",
  attemptId: "work-attempt-1",
  memberId: "member-1",
  roleRevisionId: "role-1",
  providerInstanceId: "codex",
  threadId: "thread-1",
  environmentId: "environment-1",
  model: "test",
  configuration: {
    instructionsHash: hash,
    toolIds: [],
    skillIds: [],
    runtimeVersion: "test",
    maxTokens: 1,
    maxDurationMs: 1,
    paidFallback: false,
  },
  worktree: "/tmp/test",
  branch: "work/test",
  leaseGeneration: 0,
  specRevision: 0,
  planRevision: 0,
};
const shares = {
  type: "project-team.memory.shares.replace",
  commandId: "command-1",
  projectId: "backing-project",
  expectedRevision: 1,
  sourceRecordId: "source-record",
  expectedSourceRecordRevision: 3,
  sourceRevision: 1,
  sourceGeneration: 0,
  contentHash: hash,
  owner,
  ownerRevision: 2,
  recipients: [{ owner: { kind: "project", projectId: "same-id" }, revision: 1 }],
};

describe("owner-scoped memory and V2 Work contracts", () => {
  it("retains stable message capture identity without relying on an event cursor", () => {
    const decoded = decodeProjectMemorySource(source);
    expect(decoded.owner).toEqual(owner);
    expect(decoded.conversationSpans[0]).toEqual(source.conversationSpans[0]);
    expect(() => decodeProjectMemorySource({ ...source, conversationSpans: [] })).toThrow();
    expect(() =>
      decodeProjectMemorySource({
        ...source,
        conversationSpans: [
          { ...source.conversationSpans[0], messageId: undefined, eventSequence: 123 },
        ],
      }),
    ).toThrow();
  });

  it("rejects reversed spans and invalid content hashes", () => {
    const decode = decodeProjectMemorySource;
    expect(() =>
      decode({ ...source, conversationSpans: [{ ...source.conversationSpans[0], start: 23 }] }),
    ).toThrow();
    expect(() => decode({ ...source, contentHash: "unhashed-content" })).toThrow();
  });

  it("keeps future source statuses readable while writes stay strict", () => {
    const future = { ...source, status: "awaiting-new-engine" };
    expect(decodeProjectMemorySourceRead(future).status).toBe("awaiting-new-engine");
    expect(() => decodeProjectMemorySource(future)).toThrow();
    expect(() =>
      decodeProjectMemorySourceRead({ ...future, content: "x".repeat(32_001) }),
    ).toThrow();
  });

  it("distinguishes assistant and project owners with the same raw ID", () => {
    const decoded = decodeProjectTeamMemorySharesReplaceIntent(shares);
    expect(decoded.recipients[0]?.owner.kind).toBe("project");
    expect(() =>
      decodeProjectTeamMemorySharesReplaceIntent({
        ...shares,
        recipients: [{ owner, revision: 2 }],
      }),
    ).toThrow();
    expect(() =>
      decodeProjectTeamMemorySharesReplaceIntent({
        ...shares,
        recipients: [...shares.recipients, ...shares.recipients],
      }),
    ).toThrow();
  });

  it("revokes all shares with an empty set but requires explicit source owner authority", () => {
    const decode = decodeProjectTeamMemorySharesReplaceIntent;
    expect(decode({ ...shares, recipients: [] }).recipients).toEqual([]);
    expect(() => decode({ ...shares, owner: undefined })).toThrow();
    expect(() => decode({ ...shares, ownerRevision: undefined })).toThrow();
  });

  it("keeps a reservation unbound and requires V2 lineage once admitted", () => {
    const decode = decodeProjectTeamRunBinding;
    expect(decode(binding).runId).toBeUndefined();
    expect(() => decode({ ...binding, status: "running" })).toThrow();
    expect(
      decode({ ...binding, status: "running", runId: "run-queued" }).runAttemptId,
    ).toBeUndefined();
    expect(() => decode({ ...binding, runAttemptId: "orphan-attempt" })).toThrow();
    const admitted = decode({
      ...binding,
      status: "running",
      runId: "run-1",
      runAttemptId: "v2-attempt-1",
      nodeId: "node-1",
      sessionId: "session-1",
    });
    expect(admitted.attemptId).toBe("work-attempt-1");
    expect(admitted.runAttemptId).toBe("v2-attempt-1");
  });

  it("does not hide malformed known records behind the future-record read fallback", () => {
    const decode = decodeProjectTeamRecordRead;
    expect(() => decode({ ...binding, status: "running" })).toThrow();
    expect(() => decode({ ...binding, runAttemptId: "orphan-attempt" })).toThrow();
    expect(() => decode({ ...source, contentHash: "broken" })).toThrow();
    expect(
      decode({
        recordId: "future",
        projectId: "project-1",
        revision: 0,
        generation: 0,
        updatedAt: time,
        kind: "future-kind",
        status: "future-status",
      }).kind,
    ).toBe("future-kind");
  });

  it("bounds detail pages and prevents unbounded memory source reads", () => {
    const decode = decodeProjectWorkReadIntent;
    expect(() => decode({ projectId: "project-1", operation: "tasks", limit: 129 })).toThrow();
    expect(() =>
      decode({ projectId: "project-1", operation: "memory-sources", taskId: "task-1", limit: 33 }),
    ).toThrow();
    expect(() =>
      decode({ projectId: "project-1", operation: "memory-sources", limit: 1 }),
    ).toThrow();
    expect(() =>
      decodeProjectTeamRecordPage({
        projectId: "project-1",
        revision: 0,
        items: Array.from({ length: 129 }, () => binding),
      }),
    ).toThrow();
  });

  it("requires checkpoint scope and preserves distinct V2 execution brands", () => {
    expect(() =>
      decodeProjectWorkCheckpointRead({
        checkpointId: "checkpoint-1",
        projectId: "project-1",
        taskId: "task-1",
        attemptId: "work-attempt-1",
        capturedAt: time,
        revision: 0,
      }),
    ).toThrow();
    expectTypeOf<ProjectWorkAttempt["attemptId"]>().toEqualTypeOf<ProjectWorkAttemptId>();
    expectTypeOf<ProjectWorkAttempt["runId"]>().toEqualTypeOf<RunId | undefined>();
    expectTypeOf<ProjectWorkAttempt["runAttemptId"]>().toEqualTypeOf<RunAttemptId | undefined>();
    expectTypeOf<ProjectWorkAttempt["nodeId"]>().toEqualTypeOf<NodeId | undefined>();
    expectTypeOf<ProjectWorkCheckpointRead["checkpointId"]>().toEqualTypeOf<CheckpointId>();
    expectTypeOf<
      ProjectWorkCheckpointRead["checkpointScopeId"]
    >().toEqualTypeOf<CheckpointScopeId>();
    expectTypeOf<
      ProjectTeamReviewFindingProvenance["sessionId"]
    >().toEqualTypeOf<ProviderSessionId>();
    expectTypeOf<ProjectWorkAttemptId>().not.toEqualTypeOf<RunAttemptId>();
  });
});
