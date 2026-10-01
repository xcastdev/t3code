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
    const select = host.querySelector<HTMLSelectElement>("select")!;
    select.value = value;
    await act(async () => select.dispatchEvent(new Event("change", { bubbles: true })));
  }

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
