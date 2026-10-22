import { prepareProjectWorkHumanMutation } from "@t3tools/client-runtime/project-work";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  type ProjectTeamIntegrationSourceRef,
  type ProjectTeamRecordRead,
  type ProjectMemorySourceRead,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  canPrepareDelivery,
  deliveryAvailability,
  deliveryProgress,
  gateFreshness,
  planIntegrationRefs,
  proposalAvailability,
  scannedPageState,
  sharedSourceSelection,
  startChoiceProblem,
  type WorkGate,
  type WorkPlan,
  type WorkRecoveryItem,
  integrationCoverage,
  makeDispatchIntent,
  makeMemoryRetractIntent,
  makeMemorySharesIntent,
  makeMessageAttentionIntent,
  messageActions,
  moveIntegrationSource,
  portfolioEntries,
  portfolioPage,
  reviewSummary,
  splitArguments,
  startAvailability,
  startCandidates,
  toggleIntegrationSource,
  type WorkFindingRecord,
  type WorkMemberRecord,
  type WorkMembership,
  type WorkMessageRecord,
  type WorkRoleRecord,
} from "./workPresentation";

const projectId = ProjectId.make("project");
const taskId = ProjectWorkTaskId.make("task");
const at = "2026-10-21T00:00:00.000Z";
const current = {
  environmentId: EnvironmentId.make("env"),
  projectId,
  taskId,
  checkoutPath: "/checkout",
  revision: 7,
  taskRevision: 3,
};
const record = <T>(value: Record<string, unknown>) =>
  ({ recordId: "r", projectId, revision: 2, generation: 0, updatedAt: at, ...value }) as T;

const membership = record<WorkMembership>({
  kind: "task-membership",
  recordId: "membership",
  status: "active",
  taskId,
  executionKind: "managed",
  deliverableKind: "code",
  assignment: { authorizationGateId: "grant", outputDescriptions: ["Patch"] },
  rootConstraints: {
    rootTaskId: taskId,
    providerInstanceId: "codex",
    maximumDelegationDepth: 1,
    repairAllowance: 1,
    environmentModelCalls: 4,
    projectWritableWorkers: 1,
    modelCalls: 4,
  },
});
const gate = (status: string) =>
  record<ProjectTeamRecordRead>({
    kind: "gate",
    recordId: "grant",
    status,
    taskId,
    gate: "assignment",
    specRevision: 1,
    planRevision: 1,
  });
const binding = (status: string) =>
  record<ProjectTeamRecordRead>({ kind: "run-binding", recordId: "binding", status, taskId });

it("starts only from an approved, unused assignment with no live worker", () => {
  const input = { membership, terminal: false };
  expect("plan" in startAvailability({ ...input, records: [gate("approved")] })).toBe(true);
  for (const records of [
    [gate("pending")],
    [gate("consumed")],
    [gate("approved"), binding("running")],
    [],
  ])
    expect(startAvailability({ ...input, records })).toHaveProperty("reason");
  expect(
    startAvailability({
      membership: { ...membership, controlState: "paused" },
      terminal: false,
      records: [gate("approved")],
    }),
  ).toEqual({ reason: "This task is paused. Resume it first." });
  // A finished worker no longer blocks a newly approved assignment.
  expect(
    "plan" in startAvailability({ ...input, records: [gate("approved"), binding("settled")] }),
  ).toBe(true);
});

it("builds a dispatch the shared guard accepts, bound to the reviewed revision", () => {
  const available = startAvailability({ membership, terminal: false, records: [gate("approved")] });
  if (!("plan" in available)) throw new Error("expected a start plan");
  const role = record<WorkRoleRecord>({
    kind: "role-revision",
    recordId: "role",
    status: "available",
    role: "implementer",
    model: "gpt-5",
  });
  const member = record<WorkMemberRecord>({
    kind: "member",
    recordId: "member",
    status: "active",
    name: "Ada",
    roleRevisionId: "role",
  });
  const retired = record<WorkMemberRecord>({ ...member, recordId: "old", status: "retired" });
  const [candidate] = startCandidates([retired, member], [role], available.plan);
  expect(candidate?.member.recordId).toBe("member");
  expect(candidate?.preferred).toBe(true);
  const intent = makeDispatchIntent(
    {
      commandId: CommandId.make("dispatch"),
      projectId,
      taskId,
      expectedRevision: 7,
      expectedTaskRevision: 3,
    },
    { plan: available.plan, member, role, workspace: { type: "worktree", baseRef: "main" } },
  );
  expect(prepareProjectWorkHumanMutation({ selected: current, current, intent })).toEqual(intent);
  expect(intent.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5" });
  expect(
    prepareProjectWorkHumanMutation({
      selected: current,
      current: { ...current, taskRevision: 4 },
      intent,
    }),
  ).toBeNull();
});

it("keeps a way out of every open message and never closes uncertain delivery blind", () => {
  const message = (status: string) => record<WorkMessageRecord>({ kind: "message", status });
  expect(messageActions(message("delivered"))).toEqual(["acknowledge", "resolve"]);
  expect(messageActions(message("acknowledged"))).toEqual(["resolve"]);
  expect(messageActions(message("uncertain"))).toEqual([]);
  expect(messageActions(message("resolved"))).toEqual([]);
  const intent = makeMessageAttentionIntent(
    { commandId: CommandId.make("seen"), projectId, expectedRevision: 7 },
    record<WorkMessageRecord>({ kind: "message", recordId: "message", status: "delivered" }),
    "acknowledge",
  );
  const { taskId: _task, ...project } = { ...current, taskRevision: 0 };
  expect(prepareProjectWorkHumanMutation({ selected: project, current: project, intent })).toEqual(
    intent,
  );
});

it("treats gates and findings from older revisions as out of date", () => {
  const now = { specRevision: 2, planRevision: 3 };
  expect(gateFreshness({ specRevision: 2, planRevision: 3, status: "pending" }, now)).toBe(
    "current",
  );
  expect(gateFreshness({ specRevision: 1, planRevision: 3, status: "pending" }, now)).toBe("stale");
  expect(gateFreshness({ specRevision: 2, planRevision: 3, status: "invalidated" }, now)).toBe(
    "stale",
  );
  expect(
    gateFreshness(
      { specRevision: 2, planRevision: 3, status: "pending" },
      { ...now, planRevision: null },
    ),
  ).toBe("uncertain");
  const finding = (status: string, specRevision: number) =>
    record<WorkFindingRecord>({ status, target: { specRevision, planRevision: 3 } });
  expect(
    reviewSummary([finding("open", 2), finding("open", 1), finding("resolved", 1)], now),
  ).toEqual({ open: 1, stale: 1, resolved: 1 });
});

it("keeps integration inputs in the user's order and reports uncovered dependencies", () => {
  const ref = (id: string) => ({ taskId: id }) as ProjectTeamIntegrationSourceRef;
  let selected = toggleIntegrationSource([], ref("a"));
  selected = toggleIntegrationSource(selected, ref("b"));
  selected = toggleIntegrationSource(selected, ref("c"));
  selected = moveIntegrationSource(selected, 2, -1);
  expect(selected.map((entry) => entry.taskId)).toEqual(["a", "c", "b"]);
  expect(moveIntegrationSource(selected, 0, -1)).toEqual(selected);
  selected = toggleIntegrationSource(selected, ref("a"));
  expect(selected.map((entry) => entry.taskId)).toEqual(["c", "b"]);
  expect(integrationCoverage(selected, ["a", "b"])).toEqual({ missing: ["a"], extra: 1 });
});

it("forgets and shares memory by exact source revision, with an empty share list as the way back", () => {
  const source = {
    recordId: "memory",
    owner: { kind: "project", projectId },
    ownerRevision: 0,
    revision: 4,
    generation: 2,
    sourceRevision: 1,
    contentHash: "a".repeat(64),
  } as unknown as ProjectMemorySourceRead;
  const base = { commandId: CommandId.make("forget"), projectId, expectedRevision: 7 };
  const { taskId: _task, ...project } = { ...current, taskRevision: 0 };
  const retract = makeMemoryRetractIntent(base, source);
  expect(
    prepareProjectWorkHumanMutation({ selected: project, current: project, intent: retract }),
  ).not.toBeNull();
  expect(retract).toMatchObject({ expectedSourceRecordRevision: 4, sourceGeneration: 2 });
  const revoke = makeMemorySharesIntent(base, source, []);
  expect(
    prepareProjectWorkHumanMutation({ selected: project, current: project, intent: revoke }),
  ).not.toBeNull();
});

it("pages the portfolio by replacing one bounded window", () => {
  const entries = Array.from({ length: 400 }, (_, index) => ({
    environmentId: index % 2 ? "b" : "a",
    projectId: `p${index}`,
    title: `Project ${String(index).padStart(3, "0")}`,
    checkoutPath: `/p${index}`,
  }));
  const first = portfolioPage(entries, 0);
  expect(first.shown.map((entry) => entry.projectId)).toEqual(
    Array.from({ length: 8 }, (_, index) => `p${index}`),
  );
  const third = portfolioPage(entries, 2);
  expect(third.shown).toHaveLength(8);
  expect(third.first).toBe(16);
  expect(third.shown[0]?.projectId).toBe("p16");
  // Past the end clamps to the last full window instead of mounting more.
  const last = portfolioPage(entries, 999);
  expect(last.page).toBe(49);
  expect(last.shown).toHaveLength(8);
});

it("keeps assistant backing and scratch workspaces out of portfolio pages", () => {
  const project = (
    index: number,
    extra: { isScratch?: true; assistantId?: string | null } = {},
  ) => ({
    environmentId: "env",
    id: `p${index}`,
    title: `Project ${String(index).padStart(2, "0")}`,
    workspaceRoot: `/p${index}`,
    ...extra,
  });
  const ordinary = Array.from({ length: 8 }, (_, index) => project(index));
  const projects = [
    project(90, { assistantId: "assistant-1" }),
    ...ordinary.slice(0, 4),
    project(91, { assistantId: "assistant-2" }),
    project(92, { isScratch: true }),
    ...ordinary.slice(4),
    project(93, { assistantId: null }),
  ];
  const page = portfolioPage(portfolioEntries(projects), 0);
  // Exactly one full page of ordinary projects: no failed rows, no second page.
  expect(page.total).toBe(9);
  expect(page.pageCount).toBe(2);
  expect(page.shown.map((entry) => entry.projectId)).toEqual(
    Array.from({ length: 8 }, (_, index) => `p${index}`),
  );
  expect(portfolioPage(portfolioEntries(projects), 1).shown.map((e) => e.projectId)).toEqual([
    "p93",
  ]);
});

it("splits arguments without a shell", () => {
  expect(splitArguments('test --filter "a b" $HOME')).toEqual(["test", "--filter", "a b", "$HOME"]);
});

const role = (id: string, kind: string) =>
  record<WorkRoleRecord>({
    kind: "role-revision",
    recordId: id,
    status: "available",
    role: kind,
    model: "m",
  });
const member = (id: string, roleId: string) =>
  record<WorkMemberRecord>({
    kind: "member",
    recordId: id,
    status: "active",
    name: id,
    roleRevisionId: roleId,
  });

it("only offers members and workspaces the server can start for this grant", () => {
  const roles = [role("impl", "implementer"), role("rev", "reviewer")];
  const members = [member("reviewer", "rev"), member("coder", "impl")];
  const exact = startCandidates(members, roles, {
    role: "implementer",
    exactRole: true,
    successorId: null,
  });
  expect(exact.map((entry) => [entry.member.recordId, entry.ineligible === null])).toEqual([
    ["coder", true],
    ["reviewer", false],
  ]);
  const coder = exact[0]!;
  // A writing role never runs in the project checkout.
  expect(startChoiceProblem(coder, { type: "root" })).toMatch(/worktree/);
  expect(startChoiceProblem(coder, { type: "worktree", baseRef: " " })).not.toBeNull();
  expect(startChoiceProblem(coder, { type: "worktree", baseRef: "main" })).toBeNull();
  // Switching to an ineligible member re-checks even with a valid workspace.
  expect(startChoiceProblem(exact[1]!, { type: "worktree", baseRef: "main" })).not.toBeNull();
  const successor = startCandidates(members, roles, {
    role: "implementer",
    exactRole: false,
    successorId: "reviewer",
  });
  expect(successor.find((entry) => entry.member.recordId === "coder")?.ineligible).toMatch(
    /requested/,
  );
});

const approval = (id: string, kind: string, status: string, extra: Record<string, unknown> = {}) =>
  record<WorkGate>({
    kind: "gate",
    recordId: id,
    status,
    taskId,
    gate: kind,
    specRevision: 1,
    planRevision: 1,
    ...extra,
  });
const plan = record<WorkPlan>({
  kind: "plan-revision",
  recordId: "plan",
  status: "proposed",
  taskId,
  planRevision: 1,
  specRevision: 1,
});

it("proposes work only from current approvals, and never as a start", () => {
  const { assignment: _assignment, ...unassigned } = membership;
  const base = {
    terminal: false,
    controlState: "active",
    membership: unassigned,
    specGate: approval("spec", "specification", "approved"),
    plan,
    planCurrent: true,
    planGate: approval("plangate", "plan", "approved"),
    hasSpecification: true,
  };
  const ready = proposalAvailability(base, []);
  expect(ready.execution).toBeNull();
  expect(ready.implementation).toBeNull();
  expect(ready.planning).toMatch(/already has a plan/);
  const pendingPlan = proposalAvailability(
    { ...base, planGate: approval("plangate", "plan", "pending") },
    [],
  );
  expect(pendingPlan.execution).toMatch(/Approve the current plan/);
  expect(pendingPlan.review).toMatch(/Approve the current plan/);
  expect(proposalAvailability({ ...base, plan: null, planGate: null }, []).planning).toBeNull();
  // An authorization that already exists is started, not proposed again.
  const authorized = proposalAvailability({ ...base, membership }, [
    approval("grant", "execution", "approved"),
  ]);
  expect(authorized.execution).toMatch(/Start a worker/);
  expect(proposalAvailability(base, [binding("stopping")]).execution).toMatch(/hasn't finished/);
  expect(proposalAvailability({ ...base, terminal: true }, []).investigation).toMatch(/Reopen/);
});

const preview = (id: string, kind: "create-pr" | "merge", gateId: string, publication?: string) =>
  ({
    request: {
      operation: "preview",
      input: {
        commandId: id,
        kind,
        ...(publication ? { publicationOperationId: publication } : {}),
      },
    },
    result: { operationId: id, kind: "preview", stage: "proposed", gateId },
    gateId,
    baseRef: "main",
  }) as unknown as WorkRecoveryItem;
const operation = (id: string, op: "publish" | "merge", stage: string, publication?: string) =>
  ({
    request: {
      operation: op,
      input: { operationId: id, ...(publication ? { publicationOperationId: publication } : {}) },
    },
    result: { operationId: id, kind: op === "publish" ? "create-pr" : "merge", stage },
    gateId: `g-${id}`,
    baseRef: "main",
  }) as unknown as WorkRecoveryItem;

it("rebuilds delivery after reload and only re-prepares when nothing was sent", () => {
  const rejected = deliveryProgress(
    [preview("a", "create-pr", "ga")],
    [approval("ga", "publication", "rejected")],
  );
  expect(rejected.publication.phase).toBe("superseded");
  expect(canPrepareDelivery(rejected.publication.phase)).toBe(true);
  // A newer live preview wins over an older rejected one, regardless of row order.
  const replaced = deliveryProgress(
    [preview("b", "create-pr", "gb"), preview("a", "create-pr", "ga")],
    [
      approval("ga", "publication", "rejected", { updatedAt: "2026-10-21T00:00:01.000Z" }),
      approval("gb", "publication", "approved", { updatedAt: "2026-10-21T00:00:00.000Z" }),
    ],
  );
  expect(replaced.publication.preview?.result.operationId).toBe("b");
  expect(replaced.publication.phase).toBe("ready");
  // A sent write stays on its original request even if its gate is later revoked.
  const uncertain = deliveryProgress(
    [preview("a", "create-pr", "ga"), operation("a", "publish", "uncertain")],
    [approval("ga", "publication", "invalidated")],
  );
  expect(uncertain.publication.phase).toBe("reconcile");
  expect(uncertain.publication.operation?.result.operationId).toBe("a");
  expect(canPrepareDelivery(uncertain.publication.phase)).toBe(false);
  // Merge follows only the confirmed publication; a rejected merge can be prepared again.
  const merging = deliveryProgress(
    [
      operation("a", "publish", "confirmed"),
      preview("m", "merge", "gm", "a"),
      preview("x", "merge", "gx", "other"),
    ],
    [approval("gm", "merge", "rejected"), approval("gx", "merge", "approved")],
  );
  expect(merging.publication.phase).toBe("confirmed");
  expect(merging.merge.preview?.result.operationId).toBe("m");
  expect(merging.merge.phase).toBe("superseded");
  const merged = deliveryProgress(
    [operation("a", "publish", "confirmed"), operation("m", "merge", "confirmed", "a")],
    [],
  );
  expect(merged.merge.phase).toBe("confirmed");
});

it("keeps retained delivery reachable after the reviewed source drifts", () => {
  // Uncertain publish, then the spec changed: integration-sources has no current ownSource.
  const publishing = [preview("a", "create-pr", "ga"), operation("a", "publish", "uncertain")];
  const stale = deliveryAvailability({ source: "missing", recovery: { items: publishing } });
  expect(stale.showTracks).toBe(true);
  expect(stale.prepareBlocked).not.toBeNull();
  const progress = deliveryProgress(publishing, [approval("ga", "publication", "invalidated")]);
  expect(progress.publication.phase).toBe("reconcile");
  expect(progress.publication.operation?.result.operationId).toBe("a");
  // A confirmed merge keeps its receipt row visible without a current source.
  const merged = [
    operation("a", "publish", "confirmed"),
    operation("m", "merge", "confirmed", "a"),
  ];
  expect(deliveryAvailability({ source: "missing", recovery: { items: merged } }).showTracks).toBe(
    true,
  );
  expect(deliveryProgress(merged, []).merge.phase).toBe("confirmed");
  // Retained history past the read bound still renders but blocks anything new.
  const truncated = deliveryAvailability({
    source: "current",
    recovery: { items: publishing, nextCursor: "c" },
  });
  expect(truncated.showTracks).toBe(true);
  expect(truncated.prepareBlocked).not.toBeNull();
  // Only a new preview needs the current source.
  expect(deliveryAvailability({ source: "current", recovery: { items: [] } })).toEqual({
    showTracks: true,
    prepareBlocked: null,
  });
  expect(deliveryAvailability({ source: "missing", recovery: { items: [] } }).showTracks).toBe(
    false,
  );
  expect(
    deliveryAvailability({ source: "checking", recovery: null }).prepareBlocked,
  ).not.toBeNull();
});

it("keeps paging shared sources past an empty scanned page", () => {
  expect(scannedPageState({ items: [], nextCursor: "c" }, false)).toBe("empty-scanned");
  expect(scannedPageState({ items: [] }, true)).toBe("end");
  expect(scannedPageState({ items: [] }, false)).toBe("hidden");
  expect(scannedPageState({ items: [1] }, false)).toBe("items");
});

it("keeps a plan's ordered inputs and refuses a changed shared grant", () => {
  const source = (taskIdValue: string) => ({
    taskId: taskIdValue,
    bindingId: "b",
    bindingRevision: 1,
    generation: 1,
    reviewDispatchId: "d",
    reviewProposalSha256: "a".repeat(64),
    jobId: "j",
    manifestHash: "m",
    branchRef: "branch",
    baseSha: "base",
    headSha: "head",
    testedTree: "tree",
  });
  const withInputs = {
    ...plan,
    integrationSources: { sources: [source("second"), source("first")] },
  } as unknown as WorkPlan;
  expect(planIntegrationRefs(withInputs).map((ref) => ref.taskId)).toEqual(["second", "first"]);
  expect(planIntegrationRefs(null)).toEqual([]);
  const selector = {
    owner: { kind: "project" as const, projectId },
    ownerRevision: 0,
    sourceRecordId: "s",
    expectedSourceRecordRevision: 1,
    sourceRevision: 1,
    sourceGeneration: 1,
    contentHash: "c".repeat(64),
  };
  expect(sharedSourceSelection(selector, [{ selection: selector }])).toBe("current");
  expect(sharedSourceSelection(selector, [])).toBe("current");
  expect(
    sharedSourceSelection(selector, [{ selection: { ...selector, sourceGeneration: 2 } }]),
  ).toBe("changed");
  expect(sharedSourceSelection(undefined, [])).toBe("none");
});
