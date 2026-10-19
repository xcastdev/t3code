/* @vitest-environment happy-dom */
import * as NodeCrypto from "node:crypto";
import {
  EnvironmentId,
  ProjectId,
  ProjectTeamRecordRead,
  ProjectWorkAction,
  ProjectWorkTaskContext,
  PullRequestDetail,
  canonicalProjectWorkPayload,
  type ProjectWorkPublicationRequest,
  type ProjectTeamEffect,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { combineProjectWorkFoundationPages } from "@t3tools/client-runtime/project-work";
import * as React from "react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import {
  WorkMergeApproval,
  WorkMergeApprovalSource,
  type MobileMergeRequest,
} from "./WorkMergeApproval";

const transport = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn() }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => transport.read }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => transport.send }));
const callbacks = new Map<string, () => void>();
vi.mock("react-native", async () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./WorkScreens", () => ({
  Notice: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  WorkCard: ({ children, title }: { children: ReactNode; title: string }) => (
    <div>
      {title}
      {children}
    </div>
  ),
  WorkButton: ({
    children,
    disabled,
    onPress,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onPress: () => void;
  }) => {
    callbacks.set(React.Children.toArray(children).join(""), onPress);
    return (
      <button disabled={disabled} onClick={onPress}>
        {children}
      </button>
    );
  },
}));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn(async () => true) }));
vi.mock("./workEnvironment", () => ({ mobileWorkEnvironment: {} }));
const projectId = ProjectId.make("project-a");
const environmentId = EnvironmentId.make("environment-a");
const at = "2026-10-03T10:00:00.000Z";
const decodeContext = Schema.decodeUnknownSync(ProjectWorkTaskContext);
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecordRead);
const actions = Object.fromEntries(
  ProjectWorkAction.literals.map((action) => [action, { available: true }]),
);
const context = decodeContext({
  projectId,
  revision: 10,
  task: {
    taskId: "task-a",
    projectId,
    title: "Repair reconnect",
    state: "specified",
    watchers: [],
    revision: 4,
    specRevision: 2,
    specification: {
      objective: "Keep work",
      scopeIn: "Reconnect",
      scopeOut: "Auth",
      criterionIds: ["criterion"],
      revision: 2,
      protected: false,
    },
    createdAt: at,
    updatedAt: at,
  },
  criteria: [
    {
      criterionId: "criterion",
      taskId: "task-a",
      description: "Retain history",
      required: true,
      status: "unsatisfied",
      satisfiedByEvidenceIds: [],
      revision: 1,
      updatedAt: at,
    },
  ],
  evidence: [],
  relationships: [],
  blockers: [],
  comments: [],
  children: { criteria: [], evidence: [], relationships: [], blockers: [], comments: [] },
  policy: {
    taskId: "task-a",
    readiness: { ready: false, reasons: [] },
    claimability: { claimable: false },
    actions,
    attention: [],
  },
});
const fields = { projectId, revision: 1, generation: 0, updatedAt: at };
const records = [
  {
    ...fields,
    recordId: "membership",
    kind: "task-membership",
    status: "active",
    taskId: "task-a",
    executionKind: "managed",
    deliverableKind: "code",
    controlState: "active",
  },
  {
    ...fields,
    recordId: "spec",
    kind: "gate",
    status: "pending",
    taskId: "task-a",
    gate: "specification",
    specRevision: 2,
    planRevision: 0,
    contentHash: "spec-hash",
    evidenceIds: [],
    attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
  },
  {
    ...fields,
    recordId: "plan",
    kind: "plan-revision",
    status: "proposed",
    taskId: "task-a",
    specRevision: 2,
    planRevision: 3,
    content: "Repair then verify",
    contentHash: "plan-hash",
    dependencyTaskIds: [],
  },
  {
    ...fields,
    recordId: "plan-gate",
    kind: "gate",
    status: "pending",
    taskId: "task-a",
    gate: "plan",
    specRevision: 2,
    planRevision: 3,
    contentHash: "plan-hash",
    evidenceIds: [],
    attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
  },
].map((record) => decodeRecord(record));
const foundation = combineProjectWorkFoundationPages({
  projectId,
  pages: [{ value: { projectId, revision: 10, items: records } }],
});
const current = () => ({
  environmentId,
  projectId,
  taskId: context.task.taskId,
  connected: true,
  enabled: true,
  foundationSupported: true,
  guidedSupported: true,
  fresh: true,
  context,
  foundation,
});

const taskId = context.task.taskId;
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
    state: "OPEN",
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

const detail = Schema.decodeUnknownSync(PullRequestDetail)({
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
  mergeCapabilities: { merge: true, squash: true, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    actions: ["merge"],
    mergeMethods: ["merge", "squash"],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: ["merge"],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
});
let root: Root;
let host: HTMLDivElement;
let value = current();
let requests: ReadonlyArray<MobileMergeRequest>;
let read: ReturnType<typeof vi.fn<(input: unknown) => Promise<unknown>>>;
let send: ReturnType<typeof vi.fn<(input: unknown) => Promise<void>>>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  callbacks.clear();
  requests = [];
  value = { ...current(), foundation: { ...foundation, records: [...records, historyEffect] } };
  read = vi.fn(async () => detail);
  send = vi.fn(async () => {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function Harness() {
  const [, changed] = React.useState(0);
  return (
    <WorkMergeApproval
      current={value}
      readCurrent={() => value}
      store={{
        snapshot: requests,
        read: () => requests,
        write: (entries) => {
          requests = entries;
          changed((n) => n + 1);
        },
      }}
      readPullRequest={read}
      send={send}
      onRefresh={() => {}}
    />
  );
}
function Source() {
  const [, changed] = React.useState(0);
  return (
    <WorkMergeApprovalSource
      current={value}
      readCurrent={() => value}
      store={{
        snapshot: requests,
        read: () => requests,
        write: (entries) => {
          requests = entries;
          changed((n) => n + 1);
        },
      }}
      onRefresh={() => {}}
    />
  );
}
async function render() {
  await act(async () => root.render(<Harness />));
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!button) throw Error("Missing " + label);
  await act(async () => button.click());
}
const inspectLabel = "Review merge of owner/repo #42";

it("requires explicit review and the chosen method before calling the existing merge path", async () => {
  await render();
  expect(send).not.toHaveBeenCalled();
  await click(inspectLabel);
  expect(send).not.toHaveBeenCalled();
  expect(host.textContent).toContain("b".repeat(40));
  await click("Approve squash merge now");
  expect(send).toHaveBeenCalledExactlyOnceWith({
    projectId,
    host: "github.com",
    repository: "owner/repo",
    number: 42,
    action: "merge",
    mergeMethod: "squash",
  });
  expect(requests[0]?.status).toBe("accepted");
  expect(host.textContent).toContain("does not confirm a merge");
});

it.each(["head", "base", "permission", "repository", "closed", "draft"])(
  "rejects %s changes during host review",
  async (change) => {
    read.mockResolvedValue({
      ...detail,
      ...(change === "head"
        ? { headRevision: "c".repeat(40) }
        : change === "base"
          ? { baseRevision: "c".repeat(40) }
          : change === "permission"
            ? { viewerPermissions: { ...detail.viewerPermissions, actions: [] } }
            : change === "repository"
              ? { repository: "other/repo" }
              : change === "closed"
                ? { state: "closed" }
                : { isDraft: true }),
    });
    await render();
    await click(inspectLabel);
    expect(host.textContent).toContain("changed");
    expect(send).not.toHaveBeenCalled();
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent === "Approve merge now",
      ),
    ).toBe(false);
  },
);

it("blocks a retained approval callback after revision, disconnect or environment changes", async () => {
  await render();
  await click(inspectLabel);
  const held = callbacks.get("Approve squash merge now");
  expect(held).toBeDefined();
  const original = value;
  for (const changed of [
    { ...original, connected: false },
    { ...original, environmentId: EnvironmentId.make("foreign") },
    {
      ...original,
      context: { ...context, revision: 11 },
      foundation: { ...original.foundation, revision: 11 },
    },
  ]) {
    value = changed;
    await act(async () => held?.());
    expect(send).not.toHaveBeenCalled();
  }
});

it("owns an uncertain exact merge request through rerender and refuses retry after scope changes", async () => {
  send.mockRejectedValueOnce(Error("lost response"));
  await render();
  await click(inspectLabel);
  await click("Approve squash merge now");
  expect(requests[0]?.status).toBe("uncertain");
  const captured = requests[0]?.input;
  value = { ...value, connected: false };
  await render();
  await act(async () => callbacks.get("Retry exact merge request")?.());
  expect(send).toHaveBeenCalledTimes(1);
  value = { ...value, connected: true };
  await render();
  await click("Retry exact merge request");
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]?.[0]).toEqual(captured);
  expect(requests[0]?.status).toBe("accepted");
});

it("blocks review completed after the owning work changed", async () => {
  read.mockImplementation(async () => {
    value = { ...value, fresh: false };
    return detail;
  });
  await render();
  await click(inspectLabel);
  expect(send).not.toHaveBeenCalled();
  expect(host.textContent).toContain("changed");
});

it("routes human approval through the selected environment's existing pull request RPC", async () => {
  transport.read.mockResolvedValue({ _tag: "Success", value: detail });
  transport.send.mockResolvedValue({ _tag: "Success" });

  await act(async () => root.render(<Source />));
  await click(inspectLabel);
  expect(transport.read).toHaveBeenCalledWith({
    environmentId,
    input: {
      projectId,
      host: "github.com",
      repository: "owner/repo",
      number: 42,
      allowStale: false,
    },
  });
  await click("Approve merge now");
  expect(transport.send).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      projectId,
      host: "github.com",
      repository: "owner/repo",
      number: 42,
      action: "merge",
      mergeMethod: "merge",
    },
  });
});

it("keeps merge inputs immutable if the transport detail object later changes", async () => {
  const mutable = { ...detail, mergeCapabilities: { ...detail.mergeCapabilities } };
  read.mockResolvedValue(mutable);
  await render();
  await click(inspectLabel);
  mutable.headRevision = "c".repeat(40);
  mutable.mergeCapabilities.squash = false;
  await click("Approve squash merge now");
  expect(send).toHaveBeenCalledTimes(1);
  expect(requests[0]?.review.detail.headRevision).toBe("b".repeat(40));
  expect(requests[0]?.review.detail.mergeCapabilities.squash).toBe(true);
});

it("excludes a publication from an earlier specification and unsupported guided writes", async () => {
  value = {
    ...value,
    context: {
      ...context,
      task: {
        ...context.task,
        specRevision: 3,
        specification: context.task.specification
          ? { ...context.task.specification, revision: 3 }
          : undefined,
      },
    },
  };
  await render();
  expect(host.textContent).toContain("No current confirmed publication");
  expect(read).not.toHaveBeenCalled();
  value = { ...current(), guidedSupported: false };
  await render();
  expect(host.textContent).toContain("No current confirmed publication");
  expect(send).not.toHaveBeenCalled();
});

it("does not qualify held host detail after a strict refresh fails", async () => {
  transport.read.mockResolvedValueOnce({ _tag: "Success", value: detail });
  transport.send.mockClear();
  await act(async () => root.render(<Source />));
  await click(inspectLabel);
  const heldApproval = callbacks.get("Approve merge now");
  transport.read.mockImplementation(async ({ input }: { input: { allowStale?: boolean } }) => {
    if (input.allowStale === false) throw Error("host refresh failed");
    return { _tag: "Success", value: detail };
  });
  await click(inspectLabel);
  await act(async () => heldApproval?.());
  expect(transport.send).not.toHaveBeenCalled();
  expect(host.textContent).toContain("host refresh failed");
});

function acceptedMergeRevision() {
  const gate = decodeRecord({
    ...records[1],
    recordId: "accepted-merge",
    gate: "merge",
    status: "approved",
    revision: 11,
    repository: "github.com/owner/repo",
    pullRequestNumber: 42,
    headSha: detail.headRevision,
    targetBranch: "main",
    mergeMethod: "squash",
  });
  const contextAfter = decodeContext({
    ...context,
    revision: 12,
    task: { ...context.task, revision: 5 },
    evidence: [
      {
        evidenceId: "merge-permission",
        taskId,
        kind: "observation",
        summary: "Human approved the exact reviewed pull request merge",
        detail: canonicalProjectWorkPayload({
          kind: "project-work.human-merge",
          input: requests[0]?.input,
        }),
        recordedAt: at,
        revision: 12,
      },
    ],
  });
  value = {
    ...value,
    context: contextAfter,
    foundation: { ...value.foundation, revision: 12, records: [...value.foundation.records, gate] },
  };
}

it("replays only the exact uncertain request after its own approval and evidence advance revisions", async () => {
  send.mockImplementationOnce(async () => {
    acceptedMergeRevision();
    throw Error("accepted, response lost");
  });
  await render();
  await click(inspectLabel);
  await click("Approve squash merge now");
  expect(requests[0]?.status).toBe("uncertain");
  expect(value.context?.revision).toBe(12);
  expect(value.context?.evidence[0]?.summary).toContain("Human approved");
  expect(JSON.parse(value.context?.evidence[0]?.detail ?? "null").input).toEqual(
    send.mock.calls[0]?.[0],
  );
  await render();
  const captured = requests[0]?.input;
  await click("Approve merge now");
  expect(send).toHaveBeenCalledTimes(1);
  await click("Retry exact merge request");
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]?.[0]).toEqual(captured);
  expect(read).toHaveBeenCalledTimes(2);
  expect(requests[0]?.status).toBe("accepted");
});

it.each(["head", "repository", "number", "environment", "project"])(
  "does not replay an uncertain merge against a changed %s",
  async (change) => {
    send.mockImplementationOnce(async () => {
      acceptedMergeRevision();
      throw Error("accepted, response lost");
    });
    await render();
    await click(inspectLabel);
    await click("Approve squash merge now");
    read.mockResolvedValue({
      ...detail,
      ...(change === "head"
        ? { headRevision: "c".repeat(40) }
        : change === "repository"
          ? { repository: "foreign/repo" }
          : change === "number"
            ? { number: 43 }
            : {}),
    });
    if (change === "environment")
      value = { ...value, environmentId: EnvironmentId.make("foreign") };
    if (change === "project") value = { ...value, projectId: ProjectId.make("foreign") };
    await render();
    await act(async () => callbacks.get("Retry exact merge request")?.());
    expect(send).toHaveBeenCalledTimes(1);
    expect(requests[0]?.status).toBe("uncertain");
  },
);

it("reconciles the captured request for an already merged target without reusing fresh merge permission", async () => {
  send.mockImplementationOnce(async () => {
    acceptedMergeRevision();
    throw Error("accepted, response lost");
  });
  await render();
  await click(inspectLabel);
  await click("Approve squash merge now");
  const captured = requests[0]?.input;
  read.mockResolvedValue({
    ...detail,
    state: "merged",
    viewerPermissions: { ...detail.viewerPermissions, actions: [] },
    mergeCapabilities: { merge: false, squash: false, rebase: false },
  });
  await render();
  await click("Retry exact merge request");
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]?.[0]).toEqual(captured);
  expect(requests[0]?.status).toBe("accepted");
});

it.each(["failed read", "disconnect during read"])(
  "retains the exact uncertain request after %s",
  async (failure) => {
    send.mockImplementationOnce(async () => {
      acceptedMergeRevision();
      throw Error("accepted, response lost");
    });
    await render();
    await click(inspectLabel);
    await click("Approve squash merge now");
    const captured = requests[0]?.input;
    read.mockImplementation(async () => {
      if (failure === "failed read") throw Error("host unavailable");
      value = { ...value, connected: false };
      return detail;
    });
    await render();
    await click("Retry exact merge request");
    expect(send).toHaveBeenCalledTimes(1);
    expect(requests[0]?.status).toBe("uncertain");
    expect(requests[0]?.input).toEqual(captured);
  },
);
