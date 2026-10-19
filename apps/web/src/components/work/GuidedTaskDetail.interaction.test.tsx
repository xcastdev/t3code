/* @vitest-environment happy-dom */

import {
  EnvironmentId,
  ProjectId,
  ProjectTeamRecordRead,
  ProjectWorkTaskContext,
  ProjectWorkWriteIntent,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import * as Schema from "effect/Schema";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const callbacks = vi.hoisted(() => new Map<string, () => void>());
vi.mock("../ui/button", async (original) => {
  const actual = await original<typeof import("../ui/button")>();
  return {
    ...actual,
    Button: (props: React.ComponentProps<typeof actual.Button>) => {
      const label = Array.isArray(props.children) ? props.children.join("") : props.children;
      if (typeof label === "string" && props.onClick)
        callbacks.set(label, () => props.onClick?.({} as React.MouseEvent<HTMLButtonElement>));
      return <actual.Button {...props} />;
    },
  };
});

import { GuidedTaskDetail } from "./GuidedTaskDetail";

const at = "2026-10-01T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const environmentId = EnvironmentId.make("environment-1");
const decodeContext = Schema.decodeUnknownSync(ProjectWorkTaskContext);
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecordRead);
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const hash = (value: unknown) =>
  [...sha256(new TextEncoder().encode(canonicalProjectWorkPayload(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const attribution = { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at };
const emptyChildren = { criteria: [], evidence: [], relationships: [], blockers: [], comments: [] };
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

function context(revision = 10, taskId = "task-1") {
  return decodeContext({
    projectId,
    revision,
    task: {
      taskId,
      projectId,
      title: "Fix remote reconnect",
      summary: "Preserve reconnect history",
      state: "specified",
      watchers: [],
      revision: 4,
      specRevision: 2,
      specification: {
        objective: "Restore the connection",
        scopeIn: "Reconnect the remote client",
        scopeOut: "Authentication changes",
        criterionIds: ["criterion-1"],
        revision: 2,
        protected: false,
      },
      createdAt: at,
      updatedAt: at,
    },
    criteria: [
      {
        criterionId: "criterion-1",
        taskId,
        description: "Retain the conversation",
        required: true,
        status: "satisfied",
        satisfiedByEvidenceIds: ["evidence-1"],
        revision: 3,
        updatedAt: at,
      },
    ],
    evidence: [],
    comments: [],
    relationships: [],
    blockers: [],
    children: emptyChildren,
    policy: {
      taskId,
      readiness: { ready: false, reasons: ["approval-required"] },
      claimability: { claimable: false },
      actions,
      attention: [],
    },
  });
}

function records(current: ProjectWorkTaskContext, gateStatus = "pending") {
  const fields = { projectId, revision: 1, generation: 0, updatedAt: at };
  const specHash = hash({
    specification: current.task.specification,
    criteria: current.criteria.map(({ criterionId, description, required, waiver }) => ({
      criterionId,
      description,
      required,
      waiver,
    })),
  });
  const planHash = hash({
    content: "Implement reconnect, then exercise a remote disconnect",
    dependencyTaskIds: [],
  });
  return [
    {
      ...fields,
      recordId: "membership",
      kind: "task-membership",
      status: "active",
      taskId: current.task.taskId,
      executionKind: "managed",
      deliverableKind: "code",
      controlState: "active",
    },
    {
      ...fields,
      recordId: "plan",
      kind: "plan-revision",
      status: "proposed",
      taskId: current.task.taskId,
      specRevision: current.task.specRevision,
      planRevision: 3,
      content: "Implement reconnect, then exercise a remote disconnect",
      contentHash: planHash,
      dependencyTaskIds: [],
    },
    {
      ...fields,
      recordId: "spec-gate",
      kind: "gate",
      status: gateStatus,
      taskId: current.task.taskId,
      gate: "specification",
      specRevision: current.task.specRevision,
      planRevision: 0,
      contentHash: specHash,
      evidenceIds: [],
      attribution,
    },
    {
      ...fields,
      recordId: "plan-gate",
      kind: "gate",
      status: gateStatus,
      taskId: current.task.taskId,
      gate: "plan",
      specRevision: current.task.specRevision,
      planRevision: 3,
      contentHash: planHash,
      evidenceIds: [],
      attribution,
    },
  ].map((record) => decodeRecord(record));
}

function workerRecords(overrides: Record<string, unknown> = {}) {
  const fields = { projectId, revision: 1, generation: 0, updatedAt: at };
  return [
    decodeRecord({
      ...fields,
      kind: "role-revision",
      recordId: "worker-role",
      status: "retired",
      roleId: "implementation",
      roleRevision: 1,
      role: "implementer",
      model: "profile-model",
      instructions: "Implement the task",
      skills: [],
      tools: [],
      memoryAccess: "project",
      delegationDepth: 0,
    }),
    decodeRecord({
      ...fields,
      kind: "run-binding",
      recordId: "worker-run",
      status: "running",
      taskId: "task-1",
      attemptId: "attempt-1",
      memberId: "worker-member",
      roleRevisionId: "worker-role",
      providerInstanceId: "pi-local",
      threadId: "worker/thread",
      environmentId,
      model: "frozen-model",
      configuration: {
        instructionsHash: "hash",
        toolIds: [],
        skillIds: [],
        runtimeVersion: "pi",
        maxTokens: 100,
        maxDurationMs: 1000,
        paidFallback: false,
      },
      worktree: "/fixture",
      branch: "worker",
      leaseGeneration: 0,
      specRevision: 1,
      planRevision: 1,
      ...overrides,
    }),
  ];
}

function repairEpisode(overrides: Record<string, unknown> = {}) {
  return decodeRecord({
    projectId,
    revision: 6,
    generation: 0,
    updatedAt: at,
    recordId: "repair-episode",
    kind: "repair-episode",
    status: "exhausted",
    taskId: "task-1",
    failureFingerprint: "opaque-failure-fingerprint",
    relevantRevision: "relevant-revision-6",
    allowance: 2,
    semanticRepairs: 2,
    transportRetries: 1,
    timeoutCount: 0,
    attemptIds: [],
    ...overrides,
  });
}

function linkedRepairBlocker() {
  return {
    blockerId: "repair-blocker",
    taskId: "task-1",
    reason: "The last repair left the reconnect check failing",
    resolver: "Review the failed reconnect check and choose the next step",
    referenceIds: ["repair-episode"],
    attention: true,
    revision: 3,
  };
}

function deferred() {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("GuidedTaskDetail human interactions", () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: ProjectWorkTaskContext;
  let foundation: ReadonlyArray<ProjectTeamRecordRead>;
  let write: ReturnType<typeof vi.fn<(intent: ProjectWorkWriteIntent) => Promise<void>>>;
  let refresh: ReturnType<typeof vi.fn<() => void>>;
  let emitted: ProjectWorkWriteIntent[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    callbacks.clear();
    current = context();
    foundation = records(current);
    emitted = [];
    write = vi.fn(async (intent) => {
      emitted.push(decodeWrite(intent));
    });
    refresh = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<React.ComponentProps<typeof GuidedTaskDetail>> = {}) {
    await act(async () =>
      root.render(
        <StrictMode>
          <GuidedTaskDetail
            environmentId={environmentId}
            projectId={projectId}
            taskContext={current}
            foundationRecords={foundation}
            foundationRevision={current.revision}
            foundationComplete
            connected
            enabled
            supported
            onWrite={write}
            onRefresh={refresh}
            {...overrides}
          />
        </StrictMode>,
      ),
    );
  }
  function button(label: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === label,
    );
    if (!found) throw Error(`Missing button ${label}`);
    return found;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }
  async function fill(label: string, value: string) {
    const field = [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].find(
      (item) => item.getAttribute("aria-label") === label,
    );
    if (!field) throw Error(`Missing field ${label}`);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field,
      value,
    );
    await act(async () => field.dispatchEvent(new Event("input", { bubbles: true })));
  }
  async function action(value: string) {
    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Task control action"]',
    )!;
    select.value = value;
    await act(async () => select.dispatchEvent(new Event("change", { bubbles: true })));
  }

  async function repairDecision(value: string) {
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Repair decision"]');
    if (!select) throw Error("Missing repair decision");
    select.value = value;
    await act(async () => select.dispatchEvent(new Event("change", { bubbles: true })));
  }

  it("shows the linked exhausted repair and submits an explicit decision for its exact episode", async () => {
    current = decodeContext({ ...current, blockers: [linkedRepairBlocker()] });
    foundation = [...records(current), repairEpisode()];
    await render();

    expect(host.textContent).toContain("The last repair left the reconnect check failing");
    expect(host.textContent).toContain(
      "Review the failed reconnect check and choose the next step",
    );
    expect(host.textContent).toMatch(/2\s*(of|\/)\s*2/);

    await repairDecision("approve-one-repair");
    expect(button("Resolve repair decision").disabled).toBe(true);
    expect(emitted).toEqual([]);
    await fill("Repair reason", "Approve one repair attempt after reviewing the failing check");
    await click("Resolve repair decision");

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "project-team.repair.resolve",
      projectId,
      taskId: "task-1",
      expectedRevision: 10,
      expectedTaskRevision: 4,
      episodeId: "repair-episode",
      expectedEpisodeRevision: 6,
      failureFingerprint: "opaque-failure-fingerprint",
      relevantRevision: "relevant-revision-6",
      decision: "approve-one-repair",
      reason: "Approve one repair attempt after reviewing the failing check",
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(["diagnose", "revise-scope", "abandon"])(
    "submits the explicit %s repair decision",
    async (decision) => {
      current = decodeContext({ ...current, blockers: [linkedRepairBlocker()] });
      foundation = [...records(current), repairEpisode()];
      await render();
      await repairDecision(decision);
      await fill("Repair reason", "Human reviewed the exhausted repair");
      await click("Resolve repair decision");
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "project-team.repair.resolve",
        decision,
        episodeId: "repair-episode",
        expectedEpisodeRevision: 6,
      });
    },
  );

  it("withholds repair decisions when linked blockers are ambiguous", async () => {
    const blocker = linkedRepairBlocker();
    current = decodeContext({
      ...current,
      blockers: [blocker, { ...blocker, blockerId: "another-blocker" }],
    });
    foundation = [...records(current), repairEpisode()];
    await render();
    expect(host.querySelector('select[aria-label="Repair decision"]')).toBeNull();
    expect(emitted).toEqual([]);
  });

  it("asks for refreshed blocker details instead of inferring a reason from an exhausted episode", async () => {
    foundation = [...records(current), repairEpisode()];
    await render();

    expect(host.textContent?.toLowerCase()).toContain("blocker");
    expect(host.textContent?.toLowerCase()).toContain("refresh");
    expect(host.textContent).not.toContain("opaque-failure-fingerprint");
    expect(host.querySelector('select[aria-label="Repair decision"]')).toBeNull();
    expect(emitted).toEqual([]);
  });

  it("fences a retained repair decision when its captured episode changes and keeps the blocker visible", async () => {
    current = decodeContext({ ...current, blockers: [linkedRepairBlocker()] });
    foundation = [...records(current), repairEpisode()];
    await render();
    await repairDecision("diagnose");
    await fill("Repair reason", "Diagnose the retained reconnect failure");
    const retained = callbacks.get("Resolve repair decision");
    expect(retained).toBeDefined();

    foundation = [
      ...records(current),
      repairEpisode({
        revision: 7,
        failureFingerprint: "new-failure-fingerprint",
        relevantRevision: "relevant-revision-7",
      }),
    ];
    await render();
    await act(async () => retained?.());
    expect(button("Resolve repair decision").disabled).toBe(true);
    await act(async () => callbacks.get("Resolve repair decision")?.());

    expect(emitted).toEqual([]);
    expect(host.textContent).toContain("The last repair left the reconnect check failing");
    expect(host.textContent).not.toContain("opaque-failure-fingerprint");
  });

  it("starts a linked independent review against the exact approved specification and plan", async () => {
    foundation = records(current, "approved");
    await render();
    await fill(
      "Review objective",
      "Check the implemented reconnect and retained verification evidence",
    );
    await fill("Expected review findings (one per line)", "Review findings\nCriterion assessments");
    await click("Start independent review");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "project-team.assignment.start",
      assignmentKind: "review",
      projectId,
      taskId: current.task.taskId,
      expectedRevision: 10,
      expectedTaskRevision: 4,
      objective: "Check the implemented reconnect and retained verification evidence",
      outputDescriptions: ["Review findings", "Criterion assessments"],
      specRevision: 2,
      specificationGateId: "spec-gate",
      expectedSpecificationGateRevision: 1,
      parentPlan: {
        recordId: "plan",
        expectedRecordRevision: 1,
        planRevision: 3,
        gateId: "plan-gate",
        expectedGateRevision: 1,
      },
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("retains a review draft and refuses its changed plan target until explicitly reviewed", async () => {
    foundation = records(current, "approved");
    await render();
    await fill("Review objective", "Check the original approved plan");
    current = context(11);
    foundation = records(current, "approved").map((record) =>
      record.recordId === "plan" ? decodeRecord({ ...record, revision: 2 }) : record,
    );
    await render();
    expect(button("Start independent review").disabled).toBe(true);
    await act(async () => callbacks.get("Start independent review")?.());
    expect(emitted).toEqual([]);
    expect(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review objective"]')?.value,
    ).toBe("Check the original approved plan");
  });

  it("refuses review creation while the parent plan is unapproved, including a retained callback", async () => {
    foundation = records(current, "approved").map((record) =>
      record.recordId === "plan-gate" ? decodeRecord({ ...record, status: "pending" }) : record,
    );
    await render();
    expect(button("Start independent review").disabled).toBe(true);
    await act(async () => callbacks.get("Start independent review")?.());
    expect(emitted).toEqual([]);
  });

  it("waives the selected criterion through the mounted guided task with exact definition revisions", async () => {
    await render();
    await fill("Waiver reason", "Accept the documented reconnect exception");
    await click("Waive selected criterion");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "project-team.criterion.waiver",
      projectId,
      taskId: current.task.taskId,
      expectedRevision: current.revision,
      expectedTaskRevision: current.task.revision,
      criterionId: current.criteria[0]!.criterionId,
      expectedCriterionRevision: current.criteria[0]!.revision,
      expectedSpecRevision: current.task.specRevision,
      expectedSpecificationHash: hash({
        specification: current.task.specification,
        criteria: current.criteria.map(({ criterionId, description, required, waiver }) => ({
          criterionId,
          description,
          required,
          waiver,
        })),
      }),
      action: {
        kind: "waive",
        reason: "Accept the documented reconnect exception",
        evidenceIds: [],
      },
    });
    expect(host.textContent).toContain("Approvals must be renewed");
  });

  it("revokes a recorded selected waiver without submitting a replacement reason", async () => {
    current = decodeContext({
      ...current,
      criteria: current.criteria.map((criterion) => ({
        ...criterion,
        status: "waived",
        waiver: {
          reason: "Original human exception",
          evidenceIds: [],
          specRevision: 2,
          waivedAt: at,
          attribution,
        },
      })),
    });
    foundation = records(current);
    await render();
    await click("Revoke selected waiver");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "project-team.criterion.waiver",
      criterionId: "criterion-1",
      action: { kind: "revoke" },
    });
    expect(emitted[0]?.type === "project-team.criterion.waiver" && emitted[0].action).toEqual({
      kind: "revoke",
    });
  });

  it("retries the exact uncertain waiver after refreshed criterion history changes", async () => {
    write.mockImplementationOnce(async (intent) => {
      emitted.push(decodeWrite(intent));
      throw Error("Lost waiver response");
    });
    await render();
    await fill("Waiver reason", "Keep this original human decision");
    await click("Waive selected criterion");
    const original = emitted[0];
    current = decodeContext({
      ...current,
      revision: 11,
      criteria: current.criteria.map((criterion) => ({
        ...criterion,
        revision: criterion.revision + 1,
      })),
    });
    foundation = records(current, "invalidated");
    await render();
    await click("Retry exact request");
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual(original);
    expect(button("Waive selected criterion").disabled).toBe(true);
  });

  it.each(["criterion", "hash", "owner", "disconnect"] as const)(
    "denies a drafted waiver after %s changes",
    async (change) => {
      await render();
      await fill("Waiver reason", "Review this captured definition");
      const held = callbacks.get("Waive selected criterion");
      if (change === "criterion")
        current = decodeContext({
          ...current,
          criteria: current.criteria.map((criterion) => ({
            ...criterion,
            revision: criterion.revision + 1,
          })),
        });
      if (change === "hash")
        current = decodeContext({
          ...current,
          criteria: current.criteria.map((criterion) => ({
            ...criterion,
            description: "Changed acceptance definition",
          })),
        });
      await render(
        change === "owner"
          ? { environmentId: EnvironmentId.make("environment-2") }
          : change === "disconnect"
            ? { connected: false }
            : {},
      );
      await act(async () => held?.());
      expect(emitted).toEqual([]);
      if (change === "criterion" || change === "hash")
        expect(button("Waive selected criterion").disabled).toBe(true);
    },
  );

  it("cancels a local waiver and directs protected criteria to specification revision", async () => {
    await render();
    await fill("Waiver reason", "Do not send this canceled draft");
    await click("Cancel waiver change");
    expect(emitted).toEqual([]);
    expect(button("Waive selected criterion").disabled).toBe(true);
    current = decodeContext({
      ...current,
      task: { ...current.task, specification: { ...current.task.specification, protected: true } },
    });
    foundation = records(current);
    await render();
    expect(host.textContent).toContain("approved specification revision process");
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent === "Waive selected criterion",
      ),
    ).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("offers only retained evidence matching the selected current scope for waiver references", async () => {
    const specificationHash = hash({
      specification: current.task.specification,
      criteria: current.criteria.map(({ criterionId, description, required, waiver }) => ({
        criterionId,
        description,
        required,
        waiver,
      })),
    });
    const contentHash = hash({
      content: "Implement reconnect, then exercise a remote disconnect",
      dependencyTaskIds: [],
    });
    const scopeHash = hash({
      specificationHash,
      plan: { planRevision: 3, contentHash, dependencyTaskIds: [] },
    });
    current = decodeContext({
      ...current,
      evidence: [
        {
          evidenceId: "current-reference",
          taskId: current.task.taskId,
          criterionId: "criterion-1",
          kind: "observation",
          summary: "Current retained explanation",
          scopeHash,
          recordedAt: at,
          revision: 0,
        },
        {
          evidenceId: "old-reference",
          taskId: current.task.taskId,
          kind: "observation",
          summary: "Old scope explanation",
          scopeHash: "f".repeat(64),
          recordedAt: at,
          revision: 0,
        },
      ],
    });
    await render();
    const reference = host.querySelector<HTMLInputElement>(
      'input[aria-label="Reference Current retained explanation"]',
    );
    expect(reference).not.toBeNull();
    expect(host.querySelector('input[aria-label="Reference Old scope explanation"]')).toBeNull();
    await fill("Waiver reason", "Use the retained explanation");
    await act(async () => reference!.click());
    await click("Waive selected criterion");
    expect(emitted[0]).toMatchObject({ action: { evidenceIds: ["current-reference"] } });
  });

  it("requests reassignment with the explicitly selected member revision and human reason", async () => {
    foundation = [
      ...foundation,
      decodeRecord({
        projectId,
        revision: 7,
        generation: 0,
        updatedAt: at,
        recordId: "successor",
        kind: "member",
        status: "active",
        name: "Next worker",
        coordinator: true,
        roleRevisionId: "unrestricted-role",
      }),
    ];
    await render();
    await action("reassign");
    const recipient = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Reassignment recipient"]',
    );
    expect(recipient).not.toBeNull();
    if (!recipient) return;
    recipient.value = JSON.stringify(["successor", 7]);
    await act(async () => recipient.dispatchEvent(new Event("change", { bubbles: true })));
    await fill("Control reason", "Continue with the available teammate");
    await click("Apply reassign");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "project-team.task.control",
      expectedRevision: 10,
      expectedTaskRevision: 4,
      control: {
        action: "reassign",
        reason: "Continue with the available teammate",
        recipientMemberId: "successor",
        expectedMemberRevision: 7,
      },
    });
  });

  it("denies a retained task control callback after disconnect and owner replacement", async () => {
    await render();
    await action("pause");
    await fill("Control reason", "Review the ownership");
    const retained = callbacks.get("Apply pause");
    expect(retained).toBeDefined();
    await render({ connected: false });
    await act(async () => retained?.());
    expect(emitted).toEqual([]);
    await render({ environmentId: EnvironmentId.make("other-owner") });
    await act(async () => retained?.());
    expect(emitted).toEqual([]);
  });

  async function selectMember(revision = 7) {
    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Reassignment recipient"]',
    );
    if (!select) throw Error("Missing reassignment recipient");
    select.value = JSON.stringify(["successor", revision]);
    await act(async () => select.dispatchEvent(new Event("change", { bubbles: true })));
  }
  function member(revision = 7, status = "active") {
    return decodeRecord({
      projectId,
      revision,
      generation: 0,
      updatedAt: at,
      recordId: "successor",
      kind: "member",
      status,
      name: "Next worker",
      coordinator: true,
      roleRevisionId: "any-role",
    });
  }
  it.each([
    "revision",
    "missing",
    "inactive",
    "duplicate",
    "incomplete",
    "disconnected",
    "foreign",
  ])("requires recipient review after %s changes", async (change) => {
    foundation = [...foundation, member()];
    await render();
    await action("reassign");
    await selectMember();
    await fill("Control reason", "Preserve ownership history");
    const retained = callbacks.get("Apply reassign");
    expect(retained).toBeDefined();
    if (change === "revision") foundation = [...records(current), member(8)];
    if (change === "missing") foundation = records(current);
    if (change === "inactive") foundation = [...records(current), member(7, "paused")];
    if (change === "duplicate") foundation = [...foundation, member()];
    if (change === "foreign")
      foundation = [...records(current), decodeRecord({ ...member(), projectId: "foreign" })];
    await render({
      foundationComplete: change !== "incomplete",
      connected: change !== "disconnected",
    });
    await act(async () => retained?.());
    expect(button("Apply reassign").disabled).toBe(true);
    await click("Apply reassign");
    expect(emitted).toEqual([]);
    if (change === "revision") {
      expect(host.textContent).toContain("Recipient changed");
      await selectMember(8);
      expect(button("Apply reassign").disabled).toBe(true);
      await click("Keep edits against reviewed revisions");
      await click("Apply reassign");
      expect(emitted[0]).toMatchObject({
        control: {
          recipientMemberId: "successor",
          expectedMemberRevision: 8,
          reason: "Preserve ownership history",
        },
      });
    }
  });
  it("shows retained requested ownership beside settled worker history and withholds unresolved Resume", async () => {
    foundation = records(current).map((record) =>
      record.kind === "task-membership"
        ? decodeRecord({
            ...record,
            controlState: "paused",
            requestedSuccessorMemberId: "successor",
          })
        : record,
    );
    foundation = [...foundation, member(), ...workerRecords({ status: "settled" })];
    await render();
    expect(host.textContent).toContain("Task controls · paused");
    expect(host.textContent).toContain("Requested successor: Next worker · successor");
    expect(host.textContent).toContain("frozen-model · settled");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/environment-1/worker%2Fthread");
    await action("resume");
    await fill("Control reason", "Review after drain");
    expect(button("Apply resume").disabled).toBe(false);
    foundation = foundation.filter((record) => record.recordId !== "successor");
    await render();
    expect(host.textContent).toContain("Requested successor: successor · successor");
    expect(button("Apply resume").disabled).toBe(true);
    const retained = callbacks.get("Apply resume");
    await act(async () => retained?.());
    expect(emitted).toEqual([]);
  });
  it("retries the original reassignment envelope after its response is lost and paused history arrives", async () => {
    foundation = [...foundation, member()];
    write.mockImplementationOnce(async (intent) => {
      emitted.push(decodeWrite(intent));
      throw Error("lost response");
    });
    await render();
    await action("reassign");
    await selectMember();
    await fill("Control reason", "Preserve history");
    await click("Apply reassign");
    const original = emitted[0];
    current = decodeContext({ ...current, revision: 11, task: { ...current.task, revision: 5 } });
    foundation = [
      ...records(current).map((record) =>
        record.kind === "task-membership"
          ? decodeRecord({
              ...record,
              controlState: "paused",
              requestedSuccessorMemberId: "successor",
            })
          : record,
      ),
      member(8),
    ];
    await render();
    await click("Retry exact request");
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual(original);
  });

  it("shows recorded running and settled workers with frozen configuration and thread links", async () => {
    foundation = [
      ...foundation,
      ...workerRecords(),
      workerRecords({ recordId: "old-run", status: "settled", threadId: "old-thread" })[1]!,
    ];
    await render();
    expect(host.textContent).toContain("Recorded workers");
    expect(host.textContent).toContain("implementer · frozen-model · running");
    expect(host.textContent).toContain("implementer · frozen-model · settled");
    expect(host.textContent).not.toContain("profile-model");
    expect(host.textContent).toContain("Specification 1 · plan 1");
    expect(host.textContent).toContain("/fixture · worker");
    expect([...host.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "/environment-1/worker%2Fthread",
      "/environment-1/old-thread",
    ]);
    expect(write).not.toHaveBeenCalled();
  });

  it("pages through settled history and resets the worker page on a task change", async () => {
    const role = workerRecords()[0]!;
    foundation = [
      ...foundation,
      role,
      ...Array.from(
        { length: 11 },
        (_, index) =>
          workerRecords({
            recordId: `run-${index}`,
            threadId: `thread-${index}`,
            status: "settled",
          })[1]!,
      ),
    ];
    await render();
    expect(host.querySelectorAll("a")).toHaveLength(10);
    expect(host.textContent).not.toContain("Worker thread thread-10");
    await click("Next workers");
    expect(host.querySelectorAll("a")).toHaveLength(1);
    expect(host.textContent).toContain("Worker thread thread-10");
    await click("Previous workers");
    expect(host.querySelectorAll("a")).toHaveLength(10);
    await click("Next workers");
    current = context(10, "task-2");
    foundation = [
      role,
      ...Array.from(
        { length: 11 },
        (_, index) =>
          workerRecords({
            recordId: `next-run-${index}`,
            taskId: "task-2",
            threadId: `next-thread-${index}`,
            status: "settled",
          })[1]!,
      ),
    ];
    await render();
    expect(host.querySelectorAll("a")).toHaveLength(10);
    expect(host.textContent).toContain("Worker thread next-thread-0");
    expect(host.textContent).not.toContain("Worker thread thread-");
  });

  it.each(["environment", "project", "task", "duplicate", "future", "malformed"])(
    "withholds %s worker navigation",
    async (variant) => {
      const overrides =
        variant === "environment"
          ? { environmentId: "foreign" }
          : variant === "project"
            ? { projectId: "foreign" }
            : variant === "task"
              ? { taskId: "other-task" }
              : variant === "future"
                ? { status: "future-running" }
                : variant === "malformed"
                  ? { threadId: undefined }
                  : {};
      const workers = workerRecords(overrides);
      foundation = [...foundation, ...workers, ...(variant === "duplicate" ? [workers[1]!] : [])];
      await render();
      expect(host.querySelector("a")).toBeNull();
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("keeps settled worker links in saved work while offline and removes them on owner changes", async () => {
    foundation = [...foundation, ...workerRecords({ status: "settled" })];
    await render({ connected: false, foundationComplete: false });
    expect(host.textContent).toContain("Showing saved work while disconnected");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/environment-1/worker%2Fthread");
    await render({ environmentId: EnvironmentId.make("environment-2") });
    expect(host.querySelector("a")).toBeNull();
    await render({ projectId: ProjectId.make("project-2") });
    expect(host.querySelector("a")).toBeNull();
    current = context(10, "task-2");
    await render();
    expect(host.querySelector("a")).toBeNull();
  });

  it("starts only explicit linked investigation with exact task, project, and issue revisions", async () => {
    foundation = [
      ...foundation,
      decodeRecord({
        kind: "issue",
        recordId: "issue",
        projectId,
        revision: 8,
        generation: 0,
        updatedAt: at,
        status: "open",
        identity: { host: "github.com", repositoryNodeId: "repo", issueNodeId: "node", number: 5 },
        repositoryName: "t3tools/t3code",
        title: "Reconnect",
        body: "Details",
        sourceRevision: "source-1",
        observedAt: at,
        taskId: current.task.taskId,
      }),
    ];
    await render();
    expect(write).not.toHaveBeenCalled();
    await fill("Investigation objective", "Trace the lost reconnect state");
    await fill("Expected findings (one per line)", "Find the transition\nRetain sources");
    await click("Start investigation");
    expect(emitted[0]).toMatchObject({
      type: "project-team.investigation.start",
      projectId,
      taskId: "task-1",
      expectedRevision: 10,
      expectedTaskRevision: 4,
      issueRecordId: "issue",
      expectedIssueRevision: 8,
      objective: "Trace the lost reconnect state",
      outputDescriptions: ["Find the transition", "Retain sources"],
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(button("Start investigation").disabled).toBe(true);
  });

  it.each([
    ["investigation", "Start investigation", "project-team.investigation.start"],
    ["specification", "Propose specification", "project-team.specification.propose"],
    ["plan", "Propose plan", "project-team.plan.propose"],
    ["approval", "Approve specification revision 2", "project-team.gate.respond"],
    ["rejection", "Reject plan revision 3", "project-team.gate.respond"],
    ["execution", "Start execution", "project-team.execution.start"],
    ["control", "Apply pause", "project-team.task.control"],
  ] as const)(
    "keeps %s available when two distinct issues link to the same task",
    async (flow, label, type) => {
      foundation = [
        ...records(current, flow === "execution" ? "approved" : "pending"),
        ...[1, 2].map((number) =>
          decodeRecord({
            kind: "issue",
            recordId: `issue-${number}`,
            projectId,
            revision: number,
            generation: 0,
            updatedAt: at,
            status: "open",
            identity: {
              host: "github.com",
              repositoryNodeId: "repo",
              issueNodeId: `node-${number}`,
              number,
            },
            repositoryName: "t3tools/t3code",
            title: `Reconnect report ${number}`,
            body: "One shared deliverable",
            sourceRevision: `source-${number}`,
            observedAt: at,
            taskId: current.task.taskId,
          }),
        ),
      ];
      await render();
      if (flow === "control") {
        await action("pause");
        await fill("Control reason", "Review both reports");
      }
      await click(label);
      expect(write).toHaveBeenCalledOnce();
      const intent = emitted[0];
      expect(intent).toMatchObject({
        type,
        projectId,
        taskId: current.task.taskId,
        expectedRevision: current.revision,
        expectedTaskRevision: current.task.revision,
      });
      if (flow === "investigation") {
        expect(intent).not.toHaveProperty("issueRecordId");
        expect(intent).not.toHaveProperty("expectedIssueRevision");
      }
    },
  );

  it("proposes a revised specification with retained criterion identities and fresh unsatisfied snapshots", async () => {
    await render();
    await fill("Specification objective", "Reconnect without losing history");
    await fill("Acceptance criterion 1", "Retain all messages after reconnect");
    await click("Add acceptance criterion");
    await fill("Additional criterion 1", "Show a reconnect failure");
    await click("Propose specification");
    const intent = emitted[0];
    expect(intent?.type).toBe("project-team.specification.propose");
    if (intent?.type !== "project-team.specification.propose")
      throw Error("Expected specification");
    expect(intent.specification).toMatchObject({
      revision: 3,
      protected: false,
      objective: "Reconnect without losing history",
    });
    expect(intent.criterionSnapshots).toHaveLength(2);
    expect(intent.criterionSnapshots[0]).toMatchObject({
      criterionId: "criterion-1",
      revision: 3,
      status: "unsatisfied",
      satisfiedByEvidenceIds: [],
      description: "Retain all messages after reconnect",
    });
    expect(intent.criterionSnapshots[1]).toMatchObject({
      revision: 0,
      status: "unsatisfied",
      required: true,
    });
    expect(intent.criterionSnapshots[0]).not.toHaveProperty("waiver");
  });

  it("retains and proposes all 64 legal criterion snapshots without exceeding the draft field limit", async () => {
    const criteria = Array.from({ length: 64 }, (_, index) => ({
      ...current.criteria[0],
      criterionId: `criterion-${index + 1}`,
      description: `Outcome ${index + 1}`,
    }));
    current = decodeContext({
      ...current,
      criteria,
      task: {
        ...current.task,
        specification: {
          ...current.task.specification,
          criterionIds: criteria.map((criterion) => criterion.criterionId),
        },
      },
    });
    foundation = records(current).filter((record) => record.kind === "task-membership");
    await render();
    await fill("Specification objective", "Preserve every approved outcome");
    await fill("Acceptance criterion 64", "Retain the final outcome");
    await click("Propose specification");
    const intent = emitted[0];
    if (intent?.type !== "project-team.specification.propose")
      throw Error("Expected specification");
    expect(intent.criterionSnapshots).toHaveLength(64);
    expect(intent.criterionSnapshots[63]).toMatchObject({
      criterionId: "criterion-64",
      revision: 3,
      description: "Retain the final outcome",
    });
  });

  it("requires visible scope and acceptance criteria for a first specification", async () => {
    const { specification: _specification, ...unspecifiedTask } = current.task;
    current = decodeContext({
      ...current,
      task: { ...unspecifiedTask, specRevision: 0, state: "draft" },
      criteria: [],
    });
    foundation = records(current).filter((item) => item.kind === "task-membership");
    await render();
    await click("Propose specification");
    expect(write).not.toHaveBeenCalled();
    await fill("Included scope", "Remote reconnect");
    await fill("Excluded scope", "Auth changes");
    await fill("Acceptance criterion 1", "Retain history");
    await click("Propose specification");
    expect(emitted[0]).toMatchObject({
      type: "project-team.specification.propose",
      expectedSpecRevision: 0,
      specification: { revision: 1 },
    });
  });

  it("proposes a plan against the exact previous plan record and current specification", async () => {
    await render();
    await fill(
      "Implementation and validation plan",
      "Keep the reconnect cursor and test its restoration",
    );
    await click("Propose plan");
    expect(emitted[0]).toMatchObject({
      type: "project-team.plan.propose",
      expectedRevision: 10,
      expectedTaskRevision: 4,
      specRevision: 2,
      previousPlanId: "plan",
      expectedPreviousPlanRevision: 1,
      content: "Keep the reconnect cursor and test its restoration",
    });
  });

  it.each(["Approve", "Reject"])("%s responds to the exact specification gate", async (choice) => {
    await render();
    await click(`${choice} specification revision 2`);
    expect(emitted[0]).toMatchObject({
      type: "project-team.gate.respond",
      gateId: "spec-gate",
      expectedGateRevision: 1,
      expectedRevision: 10,
      expectedTaskRevision: 4,
      specRevision: 2,
      planRevision: 0,
      response: choice === "Approve" ? "approved" : "rejected",
    });
  });

  it("approves the exact plan gate and starts only with both current human approvals", async () => {
    await render();
    expect(button("Start execution").disabled).toBe(true);
    await click("Approve plan revision 3");
    expect(emitted[0]).toMatchObject({
      type: "project-team.gate.respond",
      gateId: "plan-gate",
      planRevision: 3,
    });
    current = { ...current, revision: 11 };
    foundation = records(current, "approved");
    await render();
    await click("Start execution");
    expect(emitted[1]).toMatchObject({
      type: "project-team.execution.start",
      expectedRevision: 11,
      specGateId: "spec-gate",
      expectedSpecGateRevision: 1,
      planId: "plan",
      expectedPlanRecordRevision: 1,
      planRevision: 3,
      planGateId: "plan-gate",
      expectedPlanGateRevision: 1,
    });
  });

  it("retains edits on conflicts and requires explicit review before rebasing onto newer criterion targets", async () => {
    write.mockRejectedValueOnce({
      code: "stale-revision",
      message: "Project changed",
      details: { currentRevision: 11 },
    });
    await render();
    await fill("Acceptance criterion 1", "Keep my local criterion");
    await click("Propose specification");
    current = {
      ...current,
      revision: 11,
      criteria: current.criteria.map((criterion) => ({
        ...criterion,
        description: "New remote criterion",
        revision: 4,
      })),
    };
    foundation = records(current);
    await render();
    expect(button("Propose specification").disabled).toBe(true);
    expect(host.textContent).toContain("New remote criterion");
    expect(
      host.querySelector<HTMLTextAreaElement>('[aria-label="Acceptance criterion 1"]')?.value,
    ).toBe("Keep my local criterion");
    await click("Keep edits against reviewed revisions");
    await click("Propose specification");
    expect(emitted).toHaveLength(1);
    const retried = decodeWrite(write.mock.calls[1]![0]);
    expect(retried).toMatchObject({
      expectedRevision: 11,
      criterionSnapshots: [
        { criterionId: "criterion-1", revision: 4, description: "Keep my local criterion" },
      ],
    });
    expect(write.mock.calls[0]![0].commandId).not.toBe(retried.commandId);
  });

  it("retains a refused plan draft until the human explicitly reviews and resubmits it", async () => {
    write.mockRejectedValueOnce({ code: "invalid-state", message: "Task paused" });
    await render();
    await fill("Implementation and validation plan", "My retained plan");
    await click("Propose plan");
    expect(host.textContent).toContain("Task paused");
    expect(host.textContent).not.toContain("Retry exact request");
    expect(button("Propose plan").disabled).toBe(true);
    await click("Keep edits against reviewed revisions");
    await click("Propose plan");
    expect(decodeWrite(write.mock.calls[1]![0])).toMatchObject({ content: "My retained plan" });
    expect(write.mock.calls[1]![0].commandId).not.toBe(write.mock.calls[0]![0].commandId);
  });

  it("detects refreshed targets before any submission and retains plan edits until reviewed", async () => {
    await render();
    await fill("Implementation and validation plan", "My retained plan");
    current = { ...current, revision: 11 };
    foundation = records(current);
    await render();
    expect(button("Propose plan").disabled).toBe(true);
    expect(write).not.toHaveBeenCalled();
    await click("Keep edits against reviewed revisions");
    await click("Propose plan");
    expect(emitted[0]).toMatchObject({ content: "My retained plan", expectedRevision: 11 });
  });

  it("retries an uncertain execution request with identical command bytes after approval invalidation", async () => {
    foundation = records(current, "approved");
    write.mockRejectedValueOnce(new Error("Connection closed after sending"));
    await render();
    await click("Start execution");
    const first = write.mock.calls[0]![0];
    current = { ...current, revision: 11 };
    foundation = records(current, "invalidated");
    await render();
    expect(host.textContent).toContain("no longer authorizes execution");
    expect(button("Start execution").disabled).toBe(true);
    expect(button("Discard local draft").disabled).toBe(true);
    await click("Retry exact request");
    expect(write.mock.calls[1]![0]).toEqual(first);
    expect(decodeWrite(write.mock.calls[1]![0])).toMatchObject({
      type: "project-team.execution.start",
      expectedRevision: 10,
    });
  });

  it("prevents duplicate sends while pending, including repeated clicks in one event", async () => {
    const held = deferred();
    write.mockImplementation(() => held.promise);
    await render();
    const start = button("Start investigation");
    await act(async () => {
      start.click();
      start.click();
    });
    expect(write).toHaveBeenCalledOnce();
    expect(button("Propose specification").disabled).toBe(true);
    await act(async () => held.resolve());
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(["task", "environment", "project"])(
    "ignores late results after %s ownership changes",
    async (owner) => {
      const held = deferred();
      write.mockImplementationOnce(() => held.promise);
      await render();
      await fill("Investigation objective", "Old unsaved objective");
      await click("Start investigation");
      if (owner === "task") {
        current = context(10, "task-2");
        foundation = records(current);
      }
      const nextProject = ProjectId.make("project-2");
      if (owner === "project") {
        current = decodeContext({
          ...current,
          projectId: nextProject,
          task: { ...current.task, projectId: nextProject },
        });
        foundation = foundation.map((record) =>
          decodeRecord({ ...record, projectId: nextProject }),
        );
      }
      await render({
        ...(owner === "environment" ? { environmentId: EnvironmentId.make("environment-2") } : {}),
        ...(owner === "project" ? { projectId: nextProject } : {}),
      });
      await act(async () => held.reject(new Error("Late failure")));
      expect(refresh).not.toHaveBeenCalled();
      expect(host.textContent).not.toContain("Late failure");
      expect(host.textContent).not.toContain("Retry exact request");
      await click("Start investigation");
      expect(write).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { supported: false },
    { enabled: false },
    { connected: false },
    { foundationComplete: false },
    { foundationRevision: 9 },
  ])("keeps writes disabled without current read and explicit capability: %j", async (override) => {
    await render(override);
    await click("Start investigation");
    await click("Approve specification revision 2");
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    "future-task",
    "future-record",
    "missing-membership",
    "ambiguous-plan",
    "missing-criterion",
    "wrong-project",
  ])("refuses incomplete or unsupported state: %s", async (variant) => {
    if (variant === "future-task")
      current = { ...current, task: { ...current.task, state: "future-ready" } };
    if (variant === "future-record")
      foundation = [
        ...foundation,
        decodeRecord({
          kind: "future-record",
          status: "active",
          recordId: "future",
          projectId,
          revision: 1,
          generation: 0,
          updatedAt: at,
        }),
      ];
    if (variant === "missing-membership")
      foundation = foundation.filter((record) => record.kind !== "task-membership");
    if (variant === "ambiguous-plan")
      foundation = [
        ...foundation,
        ...foundation
          .filter((record) => record.kind === "plan-revision")
          .map((record) => decodeRecord({ ...record, recordId: "second-plan" })),
      ];
    if (variant === "missing-criterion") current = { ...current, criteria: [] };
    if (variant === "wrong-project")
      current = { ...current, projectId: ProjectId.make("elsewhere") };
    await render();
    await click("Start investigation");
    expect(write).not.toHaveBeenCalled();
    expect(button("Start execution").disabled).toBe(true);
  });

  it("does not offer approval for mismatched hashes or duplicate gates", async () => {
    foundation = foundation.map((record) =>
      record.recordId === "spec-gate"
        ? decodeRecord({ ...record, contentHash: "wrong-content" })
        : record,
    );
    await render();
    expect(host.textContent).not.toContain("Approve specification revision 2");
    foundation = records(current);
    foundation = [
      ...foundation,
      decodeRecord({ ...foundation[2], recordId: "ambiguous-spec-gate" }),
    ];
    await render();
    expect(host.textContent).not.toContain("Approve specification revision 2");
  });

  it("shows each retained finding once across task and child collections", async () => {
    const comment = {
      commentId: "finding-once",
      projectId,
      taskId: "task-1",
      body: "A retained investigation finding",
      createdAt: at,
      revision: 1,
    };
    const evidence = {
      evidenceId: "evidence-once",
      taskId: "task-1",
      kind: "observation",
      summary: "A retained validation result",
      detail: "The observed transition succeeded",
      recordedAt: at,
      revision: 1,
    };
    current = decodeContext({
      ...current,
      comments: [comment],
      evidence: [evidence],
      children: {
        ...emptyChildren,
        comments: [
          comment,
          {
            ...comment,
            commentId: "child-finding",
            taskId: "research-child",
            body: "A distinct child finding",
          },
        ],
        evidence: [
          evidence,
          {
            ...evidence,
            evidenceId: "child-evidence",
            taskId: "research-child",
            summary: "A distinct child result",
          },
        ],
      },
    });
    foundation = records(current);
    await render();
    expect(
      [...host.querySelectorAll("p")].filter((element) => element.textContent === comment.body),
    ).toHaveLength(1);
    expect(
      [...host.querySelectorAll("summary")].filter(
        (element) => element.textContent === evidence.summary,
      ),
    ).toHaveLength(1);
    expect(host.textContent).toContain("A distinct child finding");
    expect(host.textContent).toContain("A distinct child result");
  });

  it("shows linked findings and preserves execution invalidation history", async () => {
    current = decodeContext({
      ...current,
      comments: [
        {
          commentId: "finding",
          projectId,
          taskId: "task-1",
          body: "Reconnect discarded the cursor",
          createdAt: at,
          revision: 1,
        },
      ],
      children: {
        ...emptyChildren,
        evidence: [
          {
            evidenceId: "child-evidence",
            taskId: "research-child",
            kind: "observation",
            summary: "Found the lost transition",
            detail: "The cursor clears before reconnect",
            recordedAt: at,
            revision: 1,
          },
        ],
      },
    });
    foundation = [
      ...records(current),
      decodeRecord({
        kind: "gate",
        recordId: "old-execution",
        projectId,
        revision: 2,
        generation: 0,
        updatedAt: at,
        status: "invalidated",
        taskId: "task-1",
        gate: "execution",
        specRevision: 1,
        planRevision: 2,
        contentHash: "old-scope",
        evidenceIds: [],
        attribution,
      }),
    ];
    await render();
    expect(host.textContent).toContain("Reconnect discarded the cursor");
    expect(host.textContent).toContain("research-child");
    expect(host.textContent).toContain("The cursor clears before reconnect");
    expect(host.textContent).toContain("execution · invalidated");
  });

  it.each(["defer", "reopen", "pause", "resume", "cancel"])(
    "sends %s through guided task control with the human reason",
    async (control) => {
      await render();
      await action(control);
      await fill("Control reason", "Wait for the incident review");
      await click(`Apply ${control}`);
      expect(emitted[0]).toMatchObject({
        type: "project-team.task.control",
        expectedRevision: 10,
        expectedTaskRevision: 4,
        control: { action: control, reason: "Wait for the incident review" },
      });
    },
  );

  it("holds resume while a prior worker remains active", async () => {
    current = decodeContext({
      ...current,
      activeAttempt: {
        attemptId: "attempt",
        taskId: "task-1",
        state: "running",
        revision: 1,
        checkpointIds: [],
        leasedUntil: "2026-10-02T10:00:00.000Z",
      },
    });
    await render();
    await action("resume");
    await fill("Control reason", "Continue after investigation");
    expect(button("Apply resume").disabled).toBe(true);
    expect(button("Start execution").disabled).toBe(true);
  });
});
