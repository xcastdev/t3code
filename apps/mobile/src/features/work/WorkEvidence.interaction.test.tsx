import * as NodeCrypto from "node:crypto";
/* @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  canonicalProjectWorkPayload,
  type ProjectWorkPublicationRequest,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectTeamEvidenceApplicability,
  ProjectTeamGate,
  ProjectTeamPlanRevision,
  ProjectTeamEffect,
  ProjectTeamRunBinding,
  ProjectTeamRoleRevision,
  type ProjectTeamRecordRead,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProjectWorkFoundationSnapshot } from "@t3tools/client-runtime/project-work";

const link = vi.hoisted(() => ({ open: vi.fn().mockResolvedValue(true) }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: link.open }));
const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => navigation }));
vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    View: ({ children, className }: { children: ReactNode; className?: string }) =>
      React.createElement("div", { className }, children),
  };
});
vi.mock("../../components/AppText", async () => {
  const React = await import("react");
  return {
    AppText: ({ children, className }: { children: ReactNode; className?: string }) =>
      React.createElement("span", { className }, children),
  };
});
vi.mock("./WorkScreens", async () => {
  const React = await import("react");
  return {
    WorkCard: ({ title, children }: { title: string; children: ReactNode }) =>
      React.createElement("section", {}, React.createElement("h2", {}, title), children),
    Notice: ({ children }: { children: ReactNode }) => React.createElement("p", {}, children),
    WorkButton: ({
      children,
      disabled,
      onPress,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onPress: () => void;
    }) => React.createElement("button", { disabled, onClick: onPress }, children),
  };
});
import { WorkEvidence, type WorkEvidenceProps } from "./WorkEvidence";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const taskId = ProjectWorkTaskId.make("task-1");
const otherTaskId = ProjectWorkTaskId.make("task-2");
const at = "2026-10-01T10:00:00.000Z";
const historyRequest: ProjectWorkPublicationRequest = {
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
const historyReceipt = {
  version: 1,
  kind: "confirmed",
  operationId: historyRequest.operationId,
  requestHash: NodeCrypto.createHash("sha256")
    .update(canonicalProjectWorkPayload(historyRequest))
    .digest("hex"),
  claimGeneration: 1,
  observedAt: at,
  marker: historyRequest.marker,
  repository: historyRequest.repository,
  pullRequest: {
    nodeId: "PR_one",
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    state: "MERGED",
    baseSha: historyRequest.target.baseSha,
    headSha: historyRequest.target.headSha,
    baseRef: "main",
    headRef: "feature",
    headRepositoryNodeId: "R_base",
  },
};
const historyEffect: typeof ProjectTeamEffect.Type = {
  kind: "effect",
  recordId: historyRequest.operationId,
  effectId: historyRequest.operationId,
  projectId,
  revision: 2,
  generation: 0,
  updatedAt: at,
  status: "succeeded",
  effectKind: "publication",
  taskId,
  targetId: "github.com/owner/repo",
  payload: {
    recordIds: historyRequest.authorizationRecordIds,
    expectedRevision: 2,
    summary: canonicalProjectWorkPayload(historyRequest),
  },
  claimGeneration: 1,
  availableAt: at,
  outcome: canonicalProjectWorkPayload(historyReceipt),
};

const base = { projectId, revision: 2, generation: 0, updatedAt: at };
const decodeEvidence = Schema.decodeSync(ProjectTeamEvidenceApplicability);
const decodeGate = Schema.decodeSync(ProjectTeamGate);
const decodePlan = Schema.decodeSync(ProjectTeamPlanRevision);
const decodePublication = Schema.decodeSync(ProjectTeamEffect);
const evidence = decodeEvidence({
  ...base,
  kind: "evidence-applicability",
  recordId: "applicability-1",
  status: "current",
  taskId,
  evidenceId: "evidence-1",
  specRevision: 3,
  planRevision: 4,
  repository: "owner/repository",
  worktree: "/sandbox/worktree",
  testedTree: "tested-tree",
  testedCommit: "tested-commit",
  baseSha: "original-base",
  headSha: "original-head",
  command: "vp test run targeted.test.ts\nnode validate.mjs",
  exitCode: 0,
  artifactId: "raw-artifact",
  environmentSummary: "Linux x64 · Node 26",
  integration: true,
});
const gate = decodeGate({
  ...base,
  kind: "gate",
  recordId: "merge-gate",
  status: "approved",
  taskId,
  gate: "merge",
  specRevision: 3,
  planRevision: 4,
  contentHash: "gate-hash",
  repository: "owner/repository",
  pullRequestNumber: 42,
  headSha: "authorized-old-head",
  targetBranch: "main",
  mergeMethod: "squash",
  evidenceIds: ["evidence-1"],
  attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
});
const plan = decodePlan({
  ...base,
  kind: "plan-revision",
  recordId: "plan-4",
  status: "proposed",
  taskId,
  specRevision: 3,
  planRevision: 4,
  content: "DO NOT HYDRATE PLAN BODY",
  contentHash: "plan-hash",
  dependencyTaskIds: [],
});
const publication = decodePublication({
  ...base,
  kind: "effect",
  recordId: "publication",
  status: "succeeded",
  effectId: "effect-1",
  effectKind: "publication",
  taskId,
  targetId: "merge-gate",
  payload: { recordIds: ["merge-gate"], expectedRevision: 7 },
  claimGeneration: 1,
  availableAt: at,
  outcome: "Recorded receipt",
});
const decodeRun = Schema.decodeSync(ProjectTeamRunBinding);
const decodeRole = Schema.decodeSync(ProjectTeamRoleRevision);
const run = decodeRun({
  ...base,
  kind: "run-binding",
  recordId: "run-1",
  status: "settled",
  taskId,
  attemptId: "attempt-1",
  memberId: "member-1",
  roleRevisionId: "profile-1",
  providerInstanceId: "pi",
  threadId: "thread-1",
  environmentId,
  model: "recorded-model",
  configuration: {
    instructionsHash: "instructions",
    toolIds: [],
    skillIds: [],
    runtimeVersion: "0.99.1",
    maxTokens: 1000,
    maxDurationMs: 1000,
    paidFallback: false,
  },
  worktree: "/sandbox",
  branch: "task",
  leaseGeneration: 1,
  specRevision: 3,
  planRevision: 4,
});
const role = decodeRole({
  ...base,
  kind: "role-revision",
  recordId: "profile-1",
  status: "retired",
  roleId: "role-1",
  roleRevision: 6,
  role: "implementer",
  instructions: "DO NOT HYDRATE ROLE BODY",
  skills: [],
  tools: [],
  model: "profile-model",
  memoryAccess: "project",
  delegationDepth: 2,
});
const snapshot = (
  records: ReadonlyArray<ProjectTeamRecordRead> = [evidence, gate, plan, publication],
): ProjectWorkFoundationSnapshot => ({
  records,
  revision: 10,
  complete: true,
  nextCursor: null,
  error: null,
});

let root: Root;
let host: HTMLDivElement;
let props: WorkEvidenceProps;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  navigation.navigate.mockReset();
  link.open.mockReset().mockResolvedValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = {
    foundationOwner: { environmentId, projectId },
    target: { environmentId, projectId },
    foundation: snapshot(),
    current: true,
    connected: true,
    enabled: true,
    supported: true,
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(overrides: Partial<WorkEvidenceProps> = {}) {
  props = { ...props, ...overrides };
  await act(async () => root.render(<WorkEvidence {...props} />));
}
function button(label: string) {
  const item = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!item) throw new Error("Missing button " + label);
  return item;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

// Removing owner fencing, record validation, page bounds, or the recorded/live wording breaks these observed views.
describe("mounted mobile evidence inspection", () => {
  it("withholds inconsistent and foreign-owner PR links", async () => {
    await render({ foundation: snapshot([{ ...historyEffect, claimGeneration: 2 }]) });
    expect(host.textContent).toContain("PR publication is unconfirmed in this record.");
    expect(
      [...host.querySelectorAll("button")].some((item) => item.textContent === "Open PR #42"),
    ).toBe(false);
    await render({
      foundation: snapshot([historyEffect]),
      foundationOwner: { environmentId: otherEnvironmentId, projectId },
    });
    expect(host.textContent).toContain("Waiting for this environment's snapshot");
    expect(host.textContent).not.toContain("owner/repo #42");
  });

  it("opens a recorded merged PR and handles a failed external link", async () => {
    await render({ foundation: snapshot([historyEffect]) });
    expect(host.textContent).toContain("Recorded PR state: MERGED");
    expect(host.textContent).toContain("owner/repo #42");
    link.open.mockResolvedValueOnce(false);
    await click("Open PR #42");
    expect(link.open).toHaveBeenCalledWith("https://github.com/owner/repo/pull/42", "pull-request");
    expect(host.textContent).toContain("Could not open the pull request. Try again.");
  });
  it("orders offset timestamps by their recorded instants", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-01T15:00:00Z"));
    await render({
      foundation: snapshot([
        { ...evidence, updatedAt: "2026-10-01T09:00:00-05:00" },
        { ...publication, updatedAt: "2026-10-01T12:00:00Z" },
      ]),
    });
    const summary = host.querySelector("section")?.textContent;
    expect(summary).toContain("Last recorded update 2026-10-01T09:00:00-05:00");
    expect(summary).toContain("Recorded age 60 minutes at inspection");
    expect(summary).not.toContain("Recorded age 180 minutes");
    expect(summary).toContain("Complete recorded snapshot");
    expect(host.textContent).toContain("Last recorded update 2026-10-01T12:00:00Z");
  });

  it("keeps malformed raw timestamps visible without claiming complete freshness", async () => {
    await render({ foundation: snapshot([{ ...evidence, updatedAt: "not-a-date" }]) });
    expect(host.textContent).toContain("Last recorded update not-a-date");
    expect(host.textContent).toContain("Recorded age unavailable");
    expect(host.textContent).toContain("Recorded freshness unavailable");
    expect(host.textContent).toContain("Cached or incomplete evidence");
    expect(host.textContent).not.toContain("Complete recorded snapshot");
    expect(host.textContent).not.toContain("NaN");
  });

  it("withholds snapshot age when a valid timestamp is mixed with a malformed one", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-01T15:00:00Z"));
    await render({
      foundation: snapshot([
        { ...evidence, updatedAt: "2026-10-01T14:00:00Z" },
        { ...publication, updatedAt: "not-a-date" },
      ]),
    });
    expect(host.querySelector("section")?.textContent).toContain(
      "Last recorded update 2026-10-01T14:00:00Z",
    );
    expect(host.textContent).toContain("Last recorded update not-a-date");
    expect(host.textContent).toContain("Recorded age unavailable");
    expect(host.textContent).toContain("Recorded freshness unavailable");
    expect(host.textContent).not.toContain("Recorded age 60 minutes");
    expect(host.textContent).not.toContain("Complete recorded snapshot");
    expect(host.textContent).not.toContain("NaN");
  });

  it("shows exact recorded command, tree, artifact and frozen PR metadata without qualification", async () => {
    await render();
    for (const text of [
      "vp test run targeted.test.ts",
      "node validate.mjs",
      "Exit code 0",
      "raw-artifact",
      "tested-tree",
      "tested-commit",
      "original-base",
      "original-head",
      "Spec revision 3",
      "Plan revision 4",
      "Linux x64",
      "Recorded applicability: current",
      "authorized-old-head",
      "PR number 42",
      "plan-hash",
      "gate-hash",
      "Recorded publication status: succeeded",
      "Expected project revision 7",
      "Complete recorded snapshot",
      "does not establish current approval",
      "Publication receipts do not confirm a merge",
      "Source profile and model not recorded",
    ])
      expect(host.textContent).toContain(text);
    expect(host.textContent).not.toContain("DO NOT HYDRATE PLAN BODY");
    expect(host.querySelectorAll("a")).toHaveLength(0);
  });
  for (const status of ["stale", "rejected"] as const)
    it("preserves " + status + " failed-command records", async () => {
      await render({ foundation: snapshot([{ ...evidence, status, exitCode: 1 }]) });
      expect(host.textContent).toContain("Recorded applicability: " + status);
      expect(host.textContent).toContain("Exit code 1");
    });
  for (const status of [
    "pending",
    "claimed",
    "failed",
    "uncertain",
    "succeeded",
    "canceled",
  ] as const)
    it("keeps publication " + status + " distinct from merge success", async () => {
      await render({ foundation: snapshot([{ ...publication, status }]) });
      expect(host.textContent).toContain("Recorded publication status: " + status);
      expect(host.textContent).toContain("Publication receipts do not confirm a merge");
    });
  for (const state of [
    { connected: false },
    { enabled: false },
    { current: false },
    { foundation: { ...snapshot(), complete: false, nextCursor: "more" } },
    { foundation: { ...snapshot(), error: "revision-changed" as const } },
    { foundation: { ...snapshot(), revision: null } },
  ])
    it("marks cached/incomplete state " + JSON.stringify(state), async () => {
      await render(state);
      expect(host.textContent).toContain("Cached or incomplete evidence");
      expect(host.textContent).toContain("Last recorded update " + at);
      expect(host.textContent).toContain("Recorded age");
      expect(host.textContent).not.toContain("Complete recorded snapshot");
      expect(
        [...host.querySelectorAll("button")].some((b) =>
          /approve|merge|publish|retry|refresh/i.test(b.textContent ?? ""),
        ),
      ).toBe(false);
    });
  for (const record of [
    { ...evidence, status: "future-applicability" },
    { ...base, recordId: "future", kind: "future-evidence", status: "unknown" },
    { ...publication, effectKind: "future-publication" },
  ])
    it(
      "shows unsupported metadata without interpreting its payload " +
        record.recordId +
        record.status,
      async () => {
        await render({ foundation: snapshot([record]) });
        expect(host.textContent).toContain("Unsupported workflow record");
        expect(host.textContent).toContain("Applicability is unknown");
        expect(host.textContent).not.toContain("raw-artifact");
      },
    );
  it("filters tasks and returns to all project records", async () => {
    const { taskId: _taskId, ...unowned } = publication;
    await render({
      taskId,
      foundation: snapshot([
        evidence,
        { ...evidence, recordId: "other", taskId: otherTaskId, artifactId: "other-artifact" },
        unowned,
      ]),
    });
    expect(host.textContent).not.toContain("other-artifact");
    expect(host.textContent).not.toContain("effect-1");
    await click("Show all project evidence");
    expect(host.textContent).toContain("other-artifact");
    expect(host.textContent).toContain("effect-1");
    await click("Inspect evidence for task task-2");
    expect(host.textContent).toContain("other-artifact");
    expect(host.textContent).not.toContain("raw-artifact");
  });
  it("navigates to the exact owner task from recorded metadata", async () => {
    await render({
      foundationOwner: { environmentId: otherEnvironmentId, projectId: otherProjectId },
      target: { environmentId: otherEnvironmentId, projectId: otherProjectId },
      foundation: snapshot([{ ...evidence, projectId: otherProjectId }]),
    });
    await click("Open task task-1");
    expect(navigation.navigate).toHaveBeenCalledWith("WorkTask", {
      environmentId: otherEnvironmentId,
      projectId: otherProjectId,
      taskId,
    });
    expect(host.textContent).toContain("raw-artifact");
  });
  it("excludes foreign project records and unrelated frozen plans/gates", async () => {
    await render({
      foundation: snapshot([
        evidence,
        {
          ...evidence,
          projectId: otherProjectId,
          recordId: "foreign",
          artifactId: "foreign-artifact",
        },
        { ...gate, taskId: otherTaskId, headSha: "wrong-task-head" },
        { ...plan, planRevision: 5, contentHash: "wrong-plan-hash" },
        { ...gate, evidenceIds: [], headSha: "unlinked-head" },
      ]),
    });
    for (const text of ["foreign-artifact", "wrong-task-head", "wrong-plan-hash", "unlinked-head"])
      expect(host.textContent).not.toContain(text);
  });
  it("bounds pages to twenty and recovers after records shrink", async () => {
    const records = Array.from({ length: 41 }, (_, i) => ({
      ...evidence,
      recordId: "record-" + i,
      evidenceId: "evidence-" + i,
      artifactId: "artifact[" + i + "]",
    }));
    await render({ foundation: snapshot(records) });
    expect(host.querySelectorAll("section")).toHaveLength(21);
    expect(host.textContent).not.toContain("artifact[20]");
    await click("Next evidence page");
    expect(host.textContent).toContain("artifact[20]");
    expect(host.textContent).not.toContain("artifact[0]");
    await click("Next evidence page");
    expect(host.textContent).toContain("artifact[40]");
    await click("Previous evidence page");
    expect(host.textContent).toContain("artifact[20]");
    await render({ foundation: snapshot([records[0]!]) });
    expect(host.textContent).toContain("artifact[0]");
    expect(host.textContent).toContain("Page 1 of 1");
  });
  it("bounds linked detail to eight gates and eight plans", async () => {
    await render({
      foundation: snapshot([
        evidence,
        ...Array.from({ length: 9 }, (_, i) => ({ ...gate, recordId: "gate[" + i + "]" })),
        ...Array.from({ length: 9 }, (_, i) => ({ ...plan, recordId: "plan[" + i + "]" })),
      ]),
    });
    expect(host.textContent).toContain("gate[7]");
    expect(host.textContent).not.toContain("gate[8]");
    expect(host.textContent).toContain("plan[7]");
    expect(host.textContent).not.toContain("plan[8]");
    expect(host.textContent).toContain("More linked gates");
    expect(host.textContent).toContain("More linked plans");
  });
  it("resets paging and selection synchronously when project ownership changes", async () => {
    const records = Array.from({ length: 21 }, (_, i) => ({
      ...evidence,
      recordId: "r" + i,
      evidenceId: "e" + i,
    }));
    await render({ foundation: snapshot(records), taskId });
    await click("Next evidence page");
    await render({
      foundationOwner: { environmentId, projectId: otherProjectId },
      target: { environmentId, projectId: otherProjectId },
      foundation: snapshot([
        { ...evidence, projectId: otherProjectId, taskId: otherTaskId, evidenceId: "new-owner" },
      ]),
      taskId: undefined,
    });
    expect(host.textContent).toContain("new-owner");
    expect(host.textContent).not.toContain("e20");
    expect(host.textContent).toContain("Page 1 of 1");
    expect(host.textContent).not.toContain("Show all project evidence");
  });
  it("refuses same-project metadata from a different captured environment owner", async () => {
    await render();
    await render({ target: { environmentId: otherEnvironmentId, projectId } });
    expect(host.textContent).not.toContain("raw-artifact");
    expect(host.textContent).toContain("Waiting for this environment's snapshot");
    await render({
      foundationOwner: { environmentId: otherEnvironmentId, projectId },
      foundation: snapshot([{ ...evidence, artifactId: "new-environment-artifact" }]),
    });
    expect(host.textContent).toContain("new-environment-artifact");
  });
  it("resets paging when the supplied task changes", async () => {
    await render({
      foundation: snapshot(
        Array.from({ length: 21 }, (_, i) => ({
          ...evidence,
          recordId: "r" + i,
          taskId: i === 20 ? otherTaskId : taskId,
        })),
      ),
    });
    await click("Next evidence page");
    await render({ taskId });
    expect(host.textContent).toContain("Page 1 of 1");
    expect(host.textContent).toContain("raw-artifact");
  });
  it("shows dirty-tree limitations and changed gate metadata without changing recorded applicability", async () => {
    const { testedCommit: _testedCommit, ...dirty } = evidence;
    await render({
      foundation: snapshot([dirty, { ...gate, status: "invalidated", headSha: "later-head" }]),
    });
    expect(host.textContent).toContain("Tested commit not recorded");
    expect(host.textContent).toContain("A tested tree does not qualify a later commit");
    expect(host.textContent).toContain("Recorded gate status: invalidated");
    expect(host.textContent).toContain("later-head");
    expect(host.textContent).toContain("Recorded applicability: current");
  });
  it("renders unsupported capability without inspecting supplied records", async () => {
    await render({ supported: false });
    expect(host.textContent).toContain("does not support evidence inspection");
    expect(host.textContent).not.toContain("raw-artifact");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });
  it("shows only explicitly referenced same-owner source profile/model", async () => {
    await render({
      foundation: snapshot([
        { ...publication, runId: "run-1", sourceId: "source-1", sourceGeneration: 8 },
        run,
        role,
      ]),
    });
    for (const text of [
      "recorded-model",
      "profile-1",
      "role revision 6",
      "record revision 2",
      "source-1",
      "generation 8",
    ])
      expect(host.textContent).toContain(text);
    expect(host.textContent).not.toContain("DO NOT HYDRATE ROLE BODY");
    expect(host.textContent).toContain("does not qualify delivery");
  });
  for (const wrongRun of [
    { ...run, environmentId: otherEnvironmentId },
    { ...run, projectId: otherProjectId },
    { ...run, taskId: otherTaskId },
    { ...run, recordId: "unreferenced-run" },
  ])
    it(
      "refuses source model from mismatched run " +
        JSON.stringify([
          wrongRun.environmentId,
          wrongRun.projectId,
          wrongRun.taskId,
          wrongRun.recordId,
        ]),
      async () => {
        await render({
          foundation: snapshot([{ ...publication, runId: "run-1" }, wrongRun, role]),
        });
        expect(host.textContent).not.toContain("recorded-model");
        expect(host.textContent).toContain("Source profile and model not recorded");
      },
    );
  it("requires exact captured project ownership before showing any metadata", async () => {
    await render({ foundationOwner: { environmentId, projectId: otherProjectId } });
    expect(host.textContent).not.toContain("raw-artifact");
    expect(host.textContent).not.toContain("Project revision 10");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });
  it("shows unavailable profile metadata without using another profile", async () => {
    await render({
      foundation: snapshot([
        { ...publication, runId: "run-1" },
        run,
        { ...role, recordId: "other-profile" },
      ]),
    });
    expect(host.textContent).toContain("profile metadata unavailable");
    expect(host.textContent).not.toContain("role revision 6");
  });
});
