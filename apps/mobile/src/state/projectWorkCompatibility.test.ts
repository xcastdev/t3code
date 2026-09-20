import type { OrchestrationProjectShell, OrchestrationThreadShell } from "@t3tools/contracts";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { MobileOrchestrationShellSnapshot } from "./projectWorkCompatibility";

const project: OrchestrationProjectShell = {
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/workspaces/project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-17T15:00:00.000Z",
  updatedAt: "2026-09-17T15:00:00.000Z",
};

const thread: OrchestrationThreadShell = {
  id: ThreadId.make("thread-1"),
  projectId: project.id,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-09-17T15:00:00.000Z",
  updatedAt: "2026-09-17T15:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

describe("mobile project-work compatibility", () => {
  it("keeps the legacy orchestration shell while ignoring additive work metadata", () => {
    const decoded = Schema.decodeUnknownSync(MobileOrchestrationShellSnapshot)({
      snapshotSequence: 1,
      projects: [{ ...project, projectWork: { revision: 4 } }],
      threads: [{ ...thread, projectWork: { pendingTasks: 2 } }],
      projectWork: { enabled: true },
      updatedAt: "2026-09-17T15:00:00.000Z",
    });

    expect(decoded.projects[0]).toEqual(project);
    expect(decoded.threads[0]).toEqual(thread);
    expect("projectWork" in decoded).toBe(false);
  });
});
