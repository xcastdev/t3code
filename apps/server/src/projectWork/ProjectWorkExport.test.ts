import { ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildProjectWorkJsonExport, buildProjectWorkMarkdownExport } from "./ProjectWorkExport.ts";
import type { ProjectWorkSnapshot } from "./ProjectWorkQuery.ts";

const projectId = ProjectId.make("export-project");
const snapshot = {
  projectId,
  revision: 7,
  tasks: [
    {
      taskId: ProjectWorkTaskId.make("task-1"),
      projectId,
      title: "Export task",
      summary: "A safe summary",
      state: "ready" as const,
      watchers: [],
      approval: {
        approvalId: "approval-1" as never,
        taskId: ProjectWorkTaskId.make("task-1"),
        specRevision: 1,
        approvedAt: "2026-01-01T00:00:00.000Z",
        attribution: {
          actor: { kind: "human" as const, id: "reviewer-1" },
          source: { kind: "web" as const, id: "work-page" },
          recordedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      revision: 2,
      specRevision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  attempts: [
    {
      attemptId: "attempt-1" as never,
      taskId: ProjectWorkTaskId.make("task-1"),
      state: "leased" as const,
      leaseToken: "must-not-export" as never,
      leasedUntil: "2026-01-01T00:15:00.000Z",
      checkpointIds: [],
      revision: 1,
    },
  ],
  criteria: [],
  evidence: [],
  relationships: [],
  blockers: [],
  attention: [],
  activities: [],
  checkpoints: [],
  knowledge: [],
  decisions: [],
  comments: [],
} satisfies ProjectWorkSnapshot;

describe("ProjectWorkExport", () => {
  it("emits a versioned JSON snapshot with redactions and no lease tokens", () => {
    const exported = buildProjectWorkJsonExport(snapshot, {
      environmentId: "environment-1",
      exportedAt: "2026-01-01T00:00:00.000Z",
      knownSecrets: ["safe summary"],
    });
    expect(exported.schemaVersion).toBe(1);
    expect(exported.projectRevision).toBe(7);
    expect(exported.attempts[0]).not.toHaveProperty("leaseToken");
    expect(exported.attempts[0]?.leasedUntil).toBe("2026-01-01T00:15:00.000Z");
    expect(exported.tasks[0]?.approval?.approvalId).toBe("approval-1");
    expect(exported.tasks[0]?.approval?.attribution.actor.id).toBe("reviewer-1");
    expect(exported.tasks[0]?.summary).toBe("A [REDACTED_SECRET]");
    expect(exported.redactions).toContain("$.tasks[0].summary");
    expect(exported.checkpoints).toEqual([]);
    expect(exported.attention).toEqual([]);
  });

  it("keeps complete history and proof metadata while removing nested credentials", () => {
    const history = Array.from({ length: 1_005 }, (_, revision) => ({
      revision,
      payload: {
        label: `event-${revision}`,
        authToken: `token-${revision}`,
        approvalId: `approval-${revision}`,
        approval: { approvedAt: "2026-01-01T00:00:00.000Z" },
        attribution: { actor: { id: "agent-1" } },
        provenance: { sourceId: "task-1" },
        nested: {
          password: `password-${revision}`,
          approval_token: `approval-token-${revision}`,
          "lease-token": `lease-token-${revision}`,
          apiKey: `api-key-${revision}`,
          client_secret: `client-secret-${revision}`,
          credentials: { username: "user", password: "nested-password" },
        },
      },
    }));
    const exported = buildProjectWorkJsonExport(snapshot, {
      environmentId: "environment-1",
      exportedAt: "2026-01-01T00:00:00.000Z",
      history,
    });
    expect(exported.history).toHaveLength(1_005);
    expect(exported.history?.[0]).toEqual({
      revision: 0,
      payload: {
        label: "event-0",
        approvalId: "approval-0",
        approval: { approvedAt: "2026-01-01T00:00:00.000Z" },
        attribution: { actor: { id: "agent-1" } },
        provenance: { sourceId: "task-1" },
        nested: {},
      },
    });
    expect(exported.redactions).toContain("$.history[0].payload.authToken");
    expect(exported.redactions).toContain("$.history[0].payload.nested.password");
    expect(exported.redactions).toContain("$.history[0].payload.nested.approval_token");
    expect(exported.redactions).toContain("$.history[0].payload.nested.lease-token");
    expect(exported.redactions).toContain("$.history[0].payload.nested.apiKey");
    expect(exported.redactions).toContain("$.history[0].payload.nested.client_secret");
    expect(exported.redactions).toContain("$.history[0].payload.nested.credentials");
  });

  it("redacts known secret values without dropping their non-credential field", () => {
    const exported = buildProjectWorkJsonExport(snapshot, {
      environmentId: "environment-1",
      exportedAt: "2026-01-01T00:00:00.000Z",
      knownSecrets: ["known-export-secret"],
      history: [{ revision: 7, payload: { note: "contains known-export-secret" } }],
    });
    expect(exported.history?.[0]).toEqual({
      revision: 7,
      payload: { note: "contains [REDACTED_SECRET]" },
    });
    expect(exported.redactions).toContain("$.history[0].payload.note");
  });

  it("marks Markdown as non-authoritative and warns that it cannot be imported", () => {
    const exported = buildProjectWorkMarkdownExport(snapshot, {
      exportedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(exported.authoritative).toBe(false);
    expect(exported.contents).toContain("non-authoritative");
    expect(exported.contents).toContain("cannot be imported");
    expect(exported.contents).toContain("Export task");
    expect(exported.contents).toContain("A safe summary");
  });
});
