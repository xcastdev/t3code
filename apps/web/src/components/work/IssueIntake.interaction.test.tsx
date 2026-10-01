/* @vitest-environment happy-dom */

import {
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkIssueRefineCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { IssueIntake, type IssueIntakeProps } from "./IssueIntake";

const decodeRefinement = Schema.decodeSync(ProjectWorkIssueRefineCommand);

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const issue: IssueIntakeProps["issues"][number] = {
  kind: "issue",
  recordId: "issue-1",
  projectId,
  revision: 3,
  generation: 0,
  updatedAt: "2026-10-01T12:00:00.000Z",
  status: "open",
  identity: {
    host: "github.com",
    repositoryNodeId: "repo-node-1",
    issueNodeId: "issue-node-1",
    number: 42,
  },
  repositoryName: "t3tools/t3code",
  title: "Improve project intake",
  body: "Keep issue identity and human decisions visible.",
  sourceRevision: "source-3",
  observedAt: "2026-10-01T12:00:00.000Z",
};
const task: IssueIntakeProps["tasks"][number] = {
  taskId: ProjectWorkTaskId.make("task-1"),
  projectId,
  title: "Existing investigation",
  state: "draft",
  watchers: [],
  revision: 8,
  specRevision: 0,
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-01T12:00:00.000Z",
};
const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

// These tests exercise rendered form events; action responses are UI unit fixtures.
describe("IssueIntake interactions", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: IssueIntakeProps;
  const refine = vi.fn<(command: ProjectWorkIssueRefineCommand) => Promise<void>>();
  const investigate = vi.fn<(issue: IssueIntakeProps["issues"][number]) => Promise<void>>();
  const loadMore = vi.fn<() => void>();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    refine.mockReset().mockResolvedValue(undefined);
    investigate.mockReset().mockResolvedValue(undefined);
    loadMore.mockReset();
    props = {
      environmentId,
      projectId,
      issues: [issue],
      tasks: [task],
      projectRevision: 10,
      connected: true,
      enabled: true,
      supported: true,
      hasMore: false,
      onLoadMore: loadMore,
      onRefine: refine,
      onInvestigate: investigate,
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(patch: Partial<IssueIntakeProps> = {}) {
    props = { ...props, ...patch };
    await act(async () =>
      root.render(
        <StrictMode>
          <IssueIntake {...props} />
        </StrictMode>,
      ),
    );
  }
  function button(text: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === text,
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  }
  async function click(text: string) {
    await act(async () => button(text).click());
  }
  function field(label: string) {
    const found = [...host.querySelectorAll("label")].find(
      (candidate) => candidate.firstChild?.textContent === label,
    );
    const control = found?.querySelector<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("input, textarea, select");
    if (!control) throw new Error(`Missing field: ${label}`);
    return control;
  }
  async function fill(label: string, value: string) {
    const control = field(label);
    const prototype =
      control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : control instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
    await act(async () =>
      control.dispatchEvent(
        new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
      ),
    );
  }
  function submitted(index = 0) {
    const command = refine.mock.calls[index]?.[0];
    if (!command) throw new Error("No refinement submitted");
    return command;
  }

  it("creates one bounded command for an explicit new task, and locks concurrent submission", async () => {
    const receipt = deferred();
    refine.mockReturnValue(receipt.promise);
    await render();
    expect(refine).not.toHaveBeenCalled();
    expect(investigate).not.toHaveBeenCalled();
    await click("Refine issue");
    await fill("Title", "  Investigate bounded intake  ");
    await fill("Summary", "A".repeat(32_000));
    await fill("Deliverable", "research");
    await act(async () => {
      button("Save refinement").click();
      button("Save refinement").click();
    });
    expect(refine).toHaveBeenCalledTimes(1);
    expect(button("Saving…").disabled).toBe(true);
    const command = submitted();
    expect(decodeRefinement(command)).toEqual(command);
    expect(command).toMatchObject({
      projectId,
      expectedRevision: 10,
      issueRecordId: "issue-1",
      expectedIssueRevision: 3,
      target: {
        kind: "new-task",
        title: "Investigate bounded intake",
        deliverableKind: "research",
        summary: "A".repeat(32_000),
      },
    });
    expect(command.target.kind === "new-task" && command.target.taskId).toBeTruthy();
    await act(async () => receipt.resolve());
    expect(host.querySelector("form")).toBeNull();
    expect(host.textContent).toContain("Refinement saved");
    expect(investigate).not.toHaveBeenCalled();
  });

  it("retains original revisions and draft after conflict, then refreshes only by explicit review", async () => {
    refine.mockRejectedValueOnce({
      code: "stale-revision",
      message: "Project changed",
      details: { currentRevision: 11 },
    });
    await render();
    await click("Refine issue");
    await fill("Title", "My retained title");
    await fill("Summary", "My retained details");
    await render({
      projectRevision: 11,
      issues: [{ ...issue, revision: 4, title: "Changed external title" }],
    });
    expect(host.textContent).toContain("expected revisions are retained");
    await click("Save refinement");
    expect(submitted()).toMatchObject({ expectedRevision: 10, expectedIssueRevision: 3 });
    expect(field("Title").value).toBe("My retained title");
    expect(field("Summary").value).toBe("My retained details");
    expect(button("Retry exact command").disabled).toBe(true);
    await click("I reviewed the changes · Use current revisions");
    await click("Save refinement");
    expect(submitted(1)).toMatchObject({
      expectedRevision: 11,
      expectedIssueRevision: 4,
      target: { title: "My retained title", summary: "My retained details" },
    });
    expect(submitted(1).commandId).not.toBe(submitted().commandId);
  });

  it("retries uncertain submissions with identical bytes, IDs and timestamp, even after a source update", async () => {
    refine.mockRejectedValueOnce(new Error("Response lost"));
    await render();
    await click("Refine issue");
    await click("Save refinement");
    const bytes = JSON.stringify(submitted());
    expect(field("Title").closest("fieldset")?.disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    await render({ projectRevision: 12, issues: [{ ...issue, revision: 5 }] });
    await click("Retry exact command");
    expect(JSON.stringify(submitted(1))).toBe(bytes);
    expect(submitted(1)).toBe(submitted());
  });

  it.each(["completed", "canceled"])(
    "retries an uncertain existing-task command unchanged after the task becomes %s",
    async (state) => {
      refine.mockRejectedValueOnce(new Error("Response lost"));
      await render();
      await click("Refine issue");
      await fill("Refine into", "existing-task");
      await fill("Task", task.taskId);
      await click("Save refinement");
      const original = submitted();
      const bytes = JSON.stringify(original);
      await render({ projectRevision: 12, tasks: [{ ...task, state, revision: 9 }] });
      expect(field("Task").closest("fieldset")?.disabled).toBe(true);
      expect(button("Retry exact command").disabled).toBe(false);
      await click("Retry exact command");
      expect(refine).toHaveBeenCalledTimes(2);
      expect(submitted(1)).toBe(original);
      expect(submitted(1).commandId).toBe(original.commandId);
      expect(JSON.stringify(submitted(1))).toBe(bytes);
      expect(submitted(1).target).toEqual({
        kind: "existing-task",
        taskId: task.taskId,
        expectedTaskRevision: 8,
      });
    },
  );

  it("allows an acknowledged draft edit after uncertainty without silently updating revisions", async () => {
    refine.mockRejectedValueOnce(new Error("Response lost"));
    await render();
    await click("Refine issue");
    await click("Save refinement");
    await render({ projectRevision: 12 });
    await click("I checked the result · Edit draft");
    await fill("Title", "Revised human intent");
    await click("Save refinement");
    expect(submitted(1)).toMatchObject({
      expectedRevision: 10,
      target: { title: "Revised human intent" },
    });
    expect(submitted(1).commandId).not.toBe(submitted().commandId);
  });

  it("captures existing task revision at selection and retains it while the task changes", async () => {
    await render();
    await click("Refine issue");
    await fill("Refine into", "existing-task");
    expect(button("Save refinement").disabled).toBe(true);
    await fill("Task", "task-1");
    await render({ tasks: [{ ...task, revision: 9 }] });
    await click("Save refinement");
    expect(submitted().target).toEqual({
      kind: "existing-task",
      taskId: task.taskId,
      expectedTaskRevision: 8,
    });
  });

  it("refreshes the chosen task revision only after conflict review without losing title or body", async () => {
    refine.mockRejectedValueOnce({ code: "stale-revision", message: "Task changed" });
    await render();
    await click("Refine issue");
    await fill("Title", "Keep this draft title");
    await fill("Summary", "Keep these details");
    await fill("Refine into", "existing-task");
    await fill("Task", "task-1");
    await render({ projectRevision: 11, tasks: [{ ...task, revision: 9 }] });
    await click("Save refinement");
    expect(submitted().target).toMatchObject({ expectedTaskRevision: 8 });
    await click("I reviewed the changes · Use current revisions");
    await fill("Refine into", "new-task");
    expect(field("Title").value).toBe("Keep this draft title");
    expect(field("Summary").value).toBe("Keep these details");
    await fill("Refine into", "existing-task");
    await click("Save refinement");
    expect(submitted(1)).toMatchObject({
      expectedRevision: 11,
      target: { kind: "existing-task", taskId: task.taskId, expectedTaskRevision: 9 },
    });
  });

  it("retains drafts when another client links the issue and prevents a second refinement", async () => {
    await render();
    await click("Refine issue");
    await fill("Title", "A preserved local draft");
    await render({ issues: [{ ...issue, revision: 4, taskId: task.taskId }] });
    expect(field("Title").value).toBe("A preserved local draft");
    expect(button("Save refinement").disabled).toBe(true);
    await act(async () =>
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(refine).not.toHaveBeenCalled();
  });

  it("ignores a late failed refinement after source ownership changes", async () => {
    const receipt = deferred();
    refine.mockReturnValueOnce(receipt.promise);
    await render();
    await click("Refine issue");
    await click("Save refinement");
    await render({
      issues: [{ ...issue, identity: { ...issue.identity, issueNodeId: "other-source" } }],
    });
    await click("Refine issue");
    await act(async () => receipt.reject(new Error("Old owner failure")));
    expect(host.textContent).not.toContain("Old owner failure");
    expect(button("Save refinement").disabled).toBe(false);
  });

  it.each(["completed", "canceled"])(
    "blocks a selected task that becomes %s and retains valid draft and failed choices",
    async (state) => {
      const draftTask = {
        ...task,
        taskId: ProjectWorkTaskId.make("draft-task"),
        title: "Valid draft task",
      };
      const failedTask = {
        ...task,
        taskId: ProjectWorkTaskId.make("failed-task"),
        title: "Valid failed task",
        state: "failed",
      };
      await render({ tasks: [task, draftTask, failedTask] });
      await click("Refine issue");
      await fill("Refine into", "existing-task");
      await fill("Task", task.taskId);
      await render({ tasks: [{ ...task, state, revision: 9 }, draftTask, failedTask] });
      const choices = [...field("Task").querySelectorAll("option")].map((option) => option.value);
      expect(choices).toEqual(["", draftTask.taskId, failedTask.taskId]);
      expect(button("Save refinement").disabled).toBe(true);
      await act(async () =>
        host
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(refine).not.toHaveBeenCalled();
      await fill("Task", draftTask.taskId);
      expect(button("Save refinement").disabled).toBe(false);
      await fill("Task", failedTask.taskId);
      await click("Save refinement");
      expect(submitted().target).toEqual({
        kind: "existing-task",
        taskId: failedTask.taskId,
        expectedTaskRevision: failedTask.revision,
      });
    },
  );

  it("keeps unknown-state and foreign-project tasks out of the existing-task selector", async () => {
    await render({
      tasks: [
        { ...task, state: "future-task-state" },
        {
          ...task,
          taskId: ProjectWorkTaskId.make("foreign-task"),
          projectId: ProjectId.make("foreign-project"),
        },
      ],
    });
    await click("Refine issue");
    await fill("Refine into", "existing-task");
    expect(field("Task").querySelectorAll("option")).toHaveLength(1);
    expect(button("Save refinement").disabled).toBe(true);
  });

  it("preserves mission title and objective through rejection", async () => {
    refine.mockRejectedValueOnce(new Error("Unavailable"));
    await render();
    await click("Refine issue");
    await fill("Refine into", "mission");
    await fill("Title", "Project supervision");
    await fill("Objective", "Compare two projects and retain decisions.");
    await click("Save refinement");
    expect(submitted().target).toEqual({
      kind: "mission",
      title: "Project supervision",
      objective: "Compare two projects and retain decisions.",
    });
    expect(field("Objective").value).toBe("Compare two projects and retain decisions.");
  });

  it.each(["environment", "project", "issue"])(
    "ignores a late receipt after %s ownership changes",
    async (owner) => {
      const receipt = deferred();
      refine.mockReturnValueOnce(receipt.promise);
      await render();
      await click("Refine issue");
      await fill("Title", "Old owner draft");
      await click("Save refinement");
      const nextProject = owner === "project" ? ProjectId.make("project-2") : projectId;
      const nextIssue = {
        ...issue,
        projectId: nextProject,
        ...(owner === "issue"
          ? {
              recordId: "issue-2",
              identity: { ...issue.identity, issueNodeId: "issue-node-2", number: 43 },
            }
          : {}),
      };
      await render({
        projectId: nextProject,
        environmentId:
          owner === "environment" ? EnvironmentId.make("environment-2") : environmentId,
        issues: [nextIssue],
        tasks: [],
      });
      expect(host.querySelector("form")).toBeNull();
      await click("Refine issue");
      await fill("Title", "New owner draft");
      await act(async () => receipt.resolve());
      expect(field("Title").value).toBe("New owner draft");
      expect(host.textContent).not.toContain("Refinement saved");
      await click("Save refinement");
      expect(submitted(1)).toMatchObject({
        projectId: nextProject,
        issueRecordId: nextIssue.recordId,
        target: { title: "New owner draft" },
      });
    },
  );

  it.each([
    { connected: false },
    { enabled: false },
    { supported: false },
    { projectRevision: null },
    { projectRevision: Number.NaN },
    { issues: [{ ...issue, revision: -1 }] },
  ])(
    "keeps source reads but disables refinement when authority is unavailable: %j",
    async (patch) => {
      await render(patch);
      expect(host.textContent).toContain(issue.title);
      expect(button("Refine issue").disabled).toBe(true);
      await click("Refine issue");
      expect(host.querySelector("form")).toBeNull();
      expect(refine).not.toHaveBeenCalled();
      expect(investigate).not.toHaveBeenCalled();
    },
  );

  it("retains the editor across disconnect and blocks retry until connected", async () => {
    refine.mockRejectedValueOnce(new Error("Response lost"));
    await render();
    await click("Refine issue");
    await fill("Title", "Retained offline draft");
    await click("Save refinement");
    await render({ connected: false });
    expect(field("Title").value).toBe("Retained offline draft");
    expect(button("Retry exact command").disabled).toBe(true);
    await render({ connected: true });
    await click("Retry exact command");
    expect(submitted(1)).toBe(submitted());
  });

  it.each(["detached", "future-source-state"])(
    "preserves %s source views without refinement",
    async (status) => {
      await render({ issues: [{ ...issue, status }] });
      expect(host.textContent).toContain(`GitHub: ${status}`);
      expect(button("Refine issue").disabled).toBe(true);
      expect(host.textContent).toContain("read-only");
    },
  );

  it("shows source and linked task state separately and investigates only on human action", async () => {
    const receipt = deferred();
    investigate.mockReturnValue(receipt.promise);
    await render({ issues: [{ ...issue, status: "closed", taskId: task.taskId }] });
    expect(host.textContent).toContain("GitHub: closed");
    expect(host.textContent).toContain("Linked task: Existing investigation");
    expect(host.textContent).toContain("Draft");
    expect(host.textContent).not.toContain("Refine issue");
    expect(investigate).not.toHaveBeenCalled();
    await act(async () => {
      button("Start investigation").click();
      button("Start investigation").click();
    });
    expect(investigate).toHaveBeenCalledTimes(1);
    expect(refine).not.toHaveBeenCalled();
    await act(async () => receipt.resolve());
    expect(button("Investigation requested").disabled).toBe(true);
  });

  it("preserves unknown and missing linked task views without authorizing investigation", async () => {
    await render({
      issues: [{ ...issue, taskId: task.taskId }],
      tasks: [{ ...task, state: "future-task-state" }],
    });
    expect(host.textContent).toContain("Future Task State");
    expect(button("Start investigation").disabled).toBe(true);
    await render({ tasks: [] });
    expect(host.textContent).toContain(task.taskId);
    expect(button("Start investigation").disabled).toBe(true);
    expect(investigate).not.toHaveBeenCalled();
  });

  it.each([
    { connected: false },
    { supported: false },
    { enabled: false },
    { projectRevision: null },
  ])("blocks investigation with unavailable authority: %j", async (patch) => {
    await render({ ...patch, issues: [{ ...issue, taskId: task.taskId }] });
    expect(button("Start investigation").disabled).toBe(true);
    await click("Start investigation");
    expect(investigate).not.toHaveBeenCalled();
    expect(host.textContent).toContain(task.title);
  });

  it("settles investigation failure and keeps it visible without dispatching on rerender", async () => {
    investigate.mockRejectedValueOnce(new Error("Investigation unavailable"));
    await render({ issues: [{ ...issue, taskId: task.taskId }] });
    await click("Start investigation");
    expect(host.textContent).toContain("Investigation unavailable");
    expect(button("Start investigation").disabled).toBe(false);
    await render({ projectRevision: 11 });
    expect(investigate).toHaveBeenCalledTimes(1);
  });

  it("preserves a linked mission without a refine or investigation action", async () => {
    await render({ issues: [{ ...issue, missionId: "mission-1" }] });
    expect(host.textContent).toContain("Linked mission: mission-1");
    expect(host.querySelector("button")).toBeNull();
  });

  it("uses authoritative page availability and disables offline loading", async () => {
    await render();
    expect(host.textContent).not.toContain("Load more issues");
    await render({ hasMore: true });
    await click("Load more issues");
    expect(loadMore).toHaveBeenCalledTimes(1);
    await render({ connected: false });
    expect(button("Load more issues").disabled).toBe(true);
    await click("Load more issues");
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("bounds the initial body, expands on request, and refuses unsafe source anchors", async () => {
    const body = "x".repeat(500) + "BODY-END";
    await render({
      issues: [{ ...issue, body, identity: { ...issue.identity, host: "javascript:alert(1)" } }],
    });
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).not.toContain("BODY-END");
    await click("Read issue body");
    expect(host.textContent).toContain("BODY-END");
    await click("Show less");
    expect(host.textContent).not.toContain("BODY-END");
    await render({ issues: [issue] });
    expect(host.querySelector("a")?.href).toBe("https://github.com/t3tools/t3code/issues/42");
  });

  it("refuses an oversized draft even when a scripted input bypasses maxLength", async () => {
    await render();
    await click("Refine issue");
    await fill("Title", "x".repeat(4_001));
    expect(button("Save refinement").disabled).toBe(true);
    await act(async () =>
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(refine).not.toHaveBeenCalled();
  });
});
