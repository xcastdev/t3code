/* @vitest-environment happy-dom */
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskContext,
  ProjectWorkTaskId,
  PullRequestDetailView,
  canonicalProjectWorkPayload,
  type PullRequestRef,
  type ProjectWorkPublicationRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { sha256 } from "@noble/hashes/sha2";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const bridge = vi.hoisted(() => ({
  atoms: undefined as unknown,
  config: undefined as unknown,
  connected: true,
  available: true,
}));
vi.mock("~/state/projectWork", () => ({
  get projectWorkEnvironment() {
    return bridge.atoms;
  },
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => bridge.config } }));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    connection: { phase: bridge.connected ? "connected" : "disconnected" },
  }),
}));
vi.mock("~/state/entities", () => ({
  useProject: (ref: { environmentId: string; projectId: string }) =>
    bridge.available
      ? { id: ref.projectId, environmentId: ref.environmentId, title: "Project" }
      : null,
}));
import { PullRequestProjectWork } from "./PullRequestProjectWork";
const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const at = "2026-10-01T10:00:00.000Z";
const reference: PullRequestRef = {
  projectId,
  host: "github.com",
  repository: "owner/repo",
  number: 42,
};
const detail = Schema.decodeUnknownSync(PullRequestDetailView)({
  provider: "github",
  projectId,
  projectTitle: "Scoped project",
  workspaceRoot: "/fixture",
  repository: "owner/repo",
  number: 42,
  title: "Reconnect",
  body: "PR description remains visible",
  url: "https://github.com/owner/repo/pull/42",
  author: null,
  state: "open",
  isDraft: false,
  mergeability: "unknown",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  baseRevision: "a".repeat(40),
  headRevision: "b".repeat(40),
  createdAt: at,
  updatedAt: at,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    actions: [],
    mergeMethods: [],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
});
function publication(taskId = "task-1", operationId = "publication-1") {
  const request: ProjectWorkPublicationRequest = {
    version: 1,
    kind: "create-pr",
    operationId,
    marker: "marker_" + operationId,
    repository: { host: "github.com", nodeId: "R_base", nameWithOwner: "owner/repo" },
    target: {
      projectId,
      taskId: ProjectWorkTaskId.make(taskId),
      specRevision: 2,
      planRevision: 3,
      scopeHash: "scope",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      baseRef: "main",
      headRef: "feature",
      headRepositoryNodeId: "R_base",
      headSelector: "feature",
    },
    expectedTaskRevision: 4,
    authorizationRecordIds: ["proof"],
    title: "Reconnect",
    body: "Retained publication",
  };
  const summary = canonicalProjectWorkPayload(request);
  const outcome = {
    version: 1,
    kind: "confirmed",
    operationId,
    marker: request.marker,
    repository: request.repository,
    requestHash: [...sha256(new TextEncoder().encode(summary))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
    claimGeneration: 1,
    observedAt: at,
    pullRequest: {
      nodeId: "PR_one",
      number: 42,
      url: detail.url,
      state: "OPEN",
      baseSha: request.target.baseSha,
      headSha: request.target.headSha,
      baseRef: "main",
      headRef: "feature",
      headRepositoryNodeId: "R_base",
    },
  };
  return {
    kind: "effect",
    recordId: operationId,
    effectId: operationId,
    projectId,
    taskId,
    revision: 2,
    generation: 0,
    updatedAt: at,
    status: "succeeded",
    effectKind: "publication",
    targetId: "github.com/owner/repo",
    payload: { recordIds: ["proof"], expectedRevision: 4, summary },
    claimGeneration: 1,
    availableAt: at,
    outcome: canonicalProjectWorkPayload(outcome),
  };
}
const actions = Object.fromEntries(
  [
    "specify",
    "ready",
    "claim",
    "complete",
    "fail",
    "resolve-failure",
    "revise-protected-specification",
    "reclaim",
    "takeover",
    "block",
    "resolve-blocker",
    "reopen",
    "cancel",
    "duplicate",
    "approve",
    "assign",
    "watch",
    "unwatch",
    "protect-specification",
    "waive-criterion",
    "add-evidence",
    "link-relationship",
    "unlink-relationship",
  ].map((action) => [action, { available: true }]),
);
const decodeTaskFixture = Schema.decodeUnknownSync(ProjectWorkTaskContext);
function context(taskId: string, project = projectId) {
  const criterion = {
    criterionId: "criterion-1",
    taskId,
    description: "Preserve reconnect history",
    required: true,
    status: "unsatisfied",
    satisfiedByEvidenceIds: [],
    revision: 1,
    updatedAt: at,
  };
  return decodeTaskFixture({
    projectId: project,
    revision: 10,
    task: {
      taskId,
      projectId: project,
      title: "Task " + taskId,
      state: "specified",
      revision: 4,
      specRevision: 2,
      watchers: [],
      createdAt: at,
      updatedAt: at,
      specification: {
        objective: "Keep reconnect state",
        scopeIn: "Remote reconnect",
        scopeOut: "Authentication",
        criterionIds: [criterion.criterionId],
        revision: 2,
        protected: false,
      },
    },
    criteria: [criterion],
    evidence: [
      {
        evidenceId: "evidence-1",
        taskId,
        kind: "observation",
        summary: "Recorded reconnect observation",
        recordedAt: at,
        revision: 1,
      },
    ],
    comments: [],
    relationships: [],
    blockers: [],
    children: { criteria: [], evidence: [], relationships: [], blockers: [], comments: [] },
    policy: {
      taskId,
      readiness: { ready: false, reasons: [] },
      claimability: { claimable: false },
      actions,
      attention: [],
    },
  });
}

let root: Root;
let host: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
let records: unknown[];
let task: unknown;
let foundationReads: number;
let taskReads: number;
type InspectionConfig = {
  settings: { projectWorkEnabled: boolean };
  environment: { capabilities: { projectTeamFoundationReads: boolean } };
};
let config: ReturnType<typeof Atom.make<InspectionConfig>>;
let incomplete: boolean;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bridge.connected = bridge.available = true;
  records = [publication()];
  task = context("task-1");
  foundationReads = taskReads = 0;
  incomplete = false;
  registry = AtomRegistry.make();
  config = Atom.make<InspectionConfig>({
    settings: { projectWorkEnabled: true },
    environment: { capabilities: { projectTeamFoundationReads: true } },
  });
  bridge.config = config;
  const foundation = Atom.family((key: string) =>
    Atom.make(() => {
      foundationReads += 1;
      const target = JSON.parse(key) as { projectId: string };
      return AsyncResult.success({
        projectId: target.projectId,
        revision: 10,
        items: records,
        ...(incomplete ? { nextCursor: "more" } : {}),
      });
    }),
  );
  const contexts = Atom.family((key: string) =>
    Atom.make(() => {
      taskReads += 1;
      return AsyncResult.success(task);
    }).pipe(Atom.withLabel(key)),
  );
  bridge.atoms = {
    foundationPage: (target: unknown) => foundation(JSON.stringify(target)),
    taskContext: (target: unknown) => contexts(JSON.stringify(target)),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  host.remove();
  vi.unstubAllGlobals();
});
async function render(ref = reference, view = detail) {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <PullRequestProjectWork environmentId={environmentId} reference={ref} detail={view} />
      </RegistryContext.Provider>,
    ),
  );
}
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!button) throw Error("Missing " + label);
  await act(async () => button.click());
}
describe("retained PR task inspection", () => {
  it.each(["future", "duplicate", "foreign-project", "malformed", "unconfirmed", "incomplete"])(
    "cannot establish a task relation from %s records",
    async (variant) => {
      if (variant === "future") records = [{ ...publication(), status: "future-success" }];
      if (variant === "duplicate") records = [publication(), publication()];
      if (variant === "foreign-project")
        records = [{ ...publication(), projectId: "other-project" }];
      if (variant === "malformed") records = [{ ...publication(), outcome: "not-json" }];
      if (variant === "unconfirmed") records = [{ ...publication(), status: "uncertain" }];
      if (variant === "incomplete") incomplete = true;
      await render();
      expect(host.textContent).toContain("No verified retained task relation");
      expect(host.querySelector("a")).toBeNull();
      expect(taskReads).toBe(0);
    },
  );
  it.each(["host", "repository", "number"])(
    "does not match coherent history to a foreign PR %s",
    async (variant) => {
      const ref = {
        ...reference,
        ...(variant === "host"
          ? { host: "enterprise.test" }
          : variant === "repository"
            ? { repository: "other/repo" }
            : { number: 43 }),
      };
      const view = {
        ...detail,
        repository: ref.repository,
        number: ref.number,
        url: `https://${ref.host}/${ref.repository}/pull/${ref.number}`,
      };
      await render(ref, view);
      expect(host.textContent).toContain("No verified retained task relation");
      expect(taskReads).toBe(0);
      expect(host.querySelector("a")).toBeNull();
    },
  );
  it.each(["project", "disabled", "unsupported", "PR-identity"])(
    "makes no read for unavailable %s",
    async (variant) => {
      if (variant === "project") bridge.available = false;
      if (variant === "disabled")
        config = Atom.make<InspectionConfig>({
          settings: { projectWorkEnabled: false },
          environment: { capabilities: { projectTeamFoundationReads: true } },
        });
      if (variant === "unsupported")
        config = Atom.make<InspectionConfig>({
          settings: { projectWorkEnabled: true },
          environment: { capabilities: { projectTeamFoundationReads: false } },
        });
      bridge.config = config;
      await render(
        reference,
        variant === "PR-identity" ? { ...detail, projectId: ProjectId.make("foreign") } : detail,
      );
      expect(foundationReads).toBe(0);
      expect(taskReads).toBe(0);
      expect(host.querySelector("a")).toBeNull();
    },
  );
  it.each(["project", "task", "future", "duplicate-criterion", "malformed"])(
    "withholds task navigation for %s task context",
    async (variant) => {
      const value = context("task-1");
      if (variant === "project") task = context("task-1", ProjectId.make("other"));
      if (variant === "task") task = context("foreign-task");
      if (variant === "future") task = { ...value, task: { ...value.task, state: "future-state" } };
      if (variant === "duplicate-criterion")
        task = { ...value, criteria: [...value.criteria, ...value.criteria] };
      if (variant === "malformed") task = { projectId };
      await render();
      await click("Inspect task task-1");
      expect(host.textContent).toContain("could not be verified");
      expect(host.querySelector("a")).toBeNull();
    },
  );
  it("pages current criteria and evidence references without loading another task", async () => {
    const value = context("task-1");
    const criteria = Array.from({ length: 21 }, (_, index) => ({
      ...value.criteria[0],
      criterionId: "criterion-" + index,
      description: "Outcome " + index,
    }));
    const evidence = Array.from({ length: 21 }, (_, index) => ({
      ...value.evidence[0],
      evidenceId: "evidence-" + index,
      summary: "Observation " + index,
    }));
    task = {
      ...value,
      criteria,
      evidence,
      task: {
        ...value.task,
        specification: {
          ...value.task.specification,
          criterionIds: criteria.map((row) => row.criterionId),
        },
      },
    };
    await render();
    await click("Inspect task task-1");
    expect(host.textContent).not.toContain("Outcome 10");
    expect(host.textContent).not.toContain("Observation 10");
    await click("Next current criteria");
    await click("Next recorded evidence references");
    expect(host.textContent).toContain("Outcome 10");
    expect(host.textContent).toContain("Observation 10");
    expect(taskReads).toBe(1);
  });
  it("removes task content and links when Project Work is disabled after selection", async () => {
    await render();
    await click("Inspect task task-1");
    expect(host.querySelector("a")).not.toBeNull();
    const reads = taskReads;
    await act(async () =>
      registry.set(config, {
        settings: { projectWorkEnabled: false },
        environment: { capabilities: { projectTeamFoundationReads: true } },
      }),
    );
    expect(host.textContent).not.toContain("Keep reconnect state");
    expect(host.querySelector("a")).toBeNull();
    expect(taskReads).toBe(reads);
  });
  it("bounds visible task choices and loads no task until a paged choice is selected", async () => {
    records = Array.from({ length: 11 }, (_, index) =>
      publication("task-" + index, "publication-" + index),
    );
    task = context("task-10");
    await render();
    expect(host.textContent).not.toContain("Inspect task task-10");
    expect(taskReads).toBe(0);
    await click("Next related tasks");
    expect(host.textContent).toContain("Inspect task task-10");
    expect(taskReads).toBe(0);
    await click("Inspect task task-10");
    expect(host.textContent).toContain("Keep reconnect state");
    expect(taskReads).toBe(1);
  });
});
