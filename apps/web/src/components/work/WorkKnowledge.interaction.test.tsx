/* @vitest-environment happy-dom */
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  write: vi.fn(),
  refresh: vi.fn(),
  read: null as unknown,
  briefing: null as unknown,
  environment: {
    page: vi.fn((target: unknown) => target),
    briefing: vi.fn(() => "briefing"),
    search: vi.fn(),
    pageSize: 50,
    write: Symbol("write"),
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "briefing" ? state.briefing : state.read),
}));
vi.mock("~/state/projectWork", () => ({ projectWorkEnvironment: state.environment }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.write }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.refresh }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { cause?: unknown }) =>
    result.cause ?? new Error("Connection lost"),
}));
import { WorkKnowledge } from "./WorkKnowledge";

const previous = {
  knowledgeId: "old",
  projectId: "project-1",
  title: "Release steps",
  body: "Old procedure",
  sourceKind: "manual",
  sourceId: "notes",
  revision: 3,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const replacement = {
  ...previous,
  knowledgeId: "current",
  title: "Current steps",
  supersedesKnowledgeId: "old",
};
const page = (
  items: ReadonlyArray<typeof previous & { supersedesKnowledgeId?: string }> = [previous],
  revision = 4,
  hasMore = false,
) => ({
  projectId: "project-1",
  revision,
  offset: 0,
  limit: 51,
  hasMore,
  items,
});
const briefing = (sourceRevision = 4) => ({
  text: "Briefing",
  sourceRevision,
  includedTaskIds: [],
  includedKnowledgeIds: [],
  omittedReasons: [],
});

describe("retained knowledge correction", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.write.mockReset().mockResolvedValue({ _tag: "Success" });
    state.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: page() });
    state.read = AsyncResult.success(page());
    state.briefing = AsyncResult.success(briefing());
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  async function render(
    overrides: {
      connected?: boolean;
      canWrite?: boolean;
      environmentId?: EnvironmentId;
      projectId?: ProjectId;
    } = {},
  ) {
    await act(async () =>
      root.render(
        <WorkKnowledge
          environmentId={EnvironmentId.make("env-1")}
          projectId={ProjectId.make("project-1")}
          connected
          canWrite
          {...overrides}
        />,
      ),
    );
  }
  function button(text: string) {
    return [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
      entry.textContent?.includes(text),
    );
  }
  async function click(text: string) {
    const entry = button(text);
    expect(entry).toBeDefined();
    await act(async () => entry!.click());
  }
  async function fill(selector: string, value: string) {
    const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    Object.getOwnPropertyDescriptor(
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(field, value);
    await act(async () => field.dispatchEvent(new Event("input", { bubbles: true })));
  }
  async function edit() {
    await render();
    await click("Correct or replace");
    await fill('[placeholder="Durable project context"]', "Correct procedure");
    await fill('[placeholder="Source record ID"]', "human-correction");
  }

  it("saves a distinct replacement while retaining the selected predecessor", async () => {
    await edit();
    await click("Save replacement");
    expect(state.write).toHaveBeenCalledTimes(1);
    const request = state.write.mock.calls[0]![0];
    expect(request.environmentId).toBe("env-1");
    expect(request.input).toMatchObject({
      type: "project-work.knowledge.promote",
      expectedRevision: 4,
      projectId: "project-1",
      knowledge: {
        supersedesKnowledgeId: "old",
        body: "Correct procedure",
        sourceKind: "manual",
        sourceId: "human-correction",
      },
    });
    expect(request.input.knowledge.knowledgeId).not.toBe("old");
  });
  it("distinguishes the predecessor and replacement on the visible page", async () => {
    state.read = AsyncResult.success(page([previous, replacement]));
    await render();
    expect(host.textContent).toContain("Superseded");
    expect(host.textContent).toContain("Replaces old");
    expect(host.querySelectorAll<HTMLButtonElement>("button")[1]!.disabled).toBe(true);
  });
  it("rejects a successor found on a later page", async () => {
    await edit();
    state.refresh
      .mockResolvedValueOnce({ _tag: "Success", value: page([previous], 4, true) })
      .mockResolvedValueOnce({ _tag: "Success", value: page([replacement]) });
    await click("Save replacement");
    expect(state.write).not.toHaveBeenCalled();
    expect(host.textContent).toContain("is superseded");
  });
  it.each([
    page([previous], 5),
    page([{ ...previous, projectId: "foreign" }]),
    page([previous, previous]),
    page([{ ...previous, supersedesKnowledgeId: "old" }]),
  ])("blocks an inconsistent closure %#", async (value) => {
    await edit();
    state.refresh.mockResolvedValue({ _tag: "Success", value });
    await click("Save replacement");
    expect(state.write).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Cannot confirm");
  });
  it("retries an uncertain outcome with the exact command and freezes edits", async () => {
    state.write.mockResolvedValueOnce({ _tag: "Failure" });
    await edit();
    await click("Save replacement");
    const original = state.write.mock.calls[0]![0];
    expect(host.querySelector<HTMLInputElement>('[placeholder="Title"]')!.disabled).toBe(true);
    expect(button("Rebase on latest")).toBeUndefined();
    state.briefing = AsyncResult.initial();
    await render();
    await click("Retry exact command");
    expect(state.write.mock.calls[1]![0]).toEqual(original);
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
  it("rebases only an explicit revision conflict, retaining the replacement identity", async () => {
    state.write.mockResolvedValueOnce({
      _tag: "Failure",
      cause: { code: "stale-revision", message: "Changed" },
    });
    await edit();
    await click("Save replacement");
    const original = state.write.mock.calls[0]![0].input;
    state.refresh
      .mockResolvedValueOnce({ _tag: "Success", value: briefing(9) })
      .mockResolvedValue({ _tag: "Success", value: page([previous], 9) });
    await click("Rebase on latest");
    await click("Save replacement");
    const rebased = state.write.mock.calls[1]![0].input;
    expect(rebased.expectedRevision).toBe(9);
    expect(rebased.commandId).not.toBe(original.commandId);
    expect(rebased.knowledge).toEqual(original.knowledge);
  });
  it("does not rebase onto a superseded predecessor", async () => {
    state.write.mockResolvedValueOnce({ _tag: "Failure", cause: { code: "stale-revision" } });
    await edit();
    await click("Save replacement");
    state.refresh
      .mockResolvedValueOnce({ _tag: "Success", value: briefing(9) })
      .mockResolvedValue({ _tag: "Success", value: page([previous, replacement], 9) });
    await click("Rebase on latest");
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("is superseded");
  });
  it.each([
    { environmentId: EnvironmentId.make("env-2") },
    { projectId: ProjectId.make("project-2") },
  ])("clears a draft when its context changes %#", async (overrides) => {
    await edit();
    await render(overrides);
    expect(button("Save replacement")).toBeUndefined();
    expect(state.write).not.toHaveBeenCalled();
  });
  it("blocks correction and exact retry while disconnected", async () => {
    state.write.mockResolvedValue({ _tag: "Failure" });
    await edit();
    await click("Save replacement");
    await render({ connected: false });
    await click("Retry exact command");
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(button("Correct or replace")!.disabled).toBe(true);
  });
  it("does not write after disconnecting during validation", async () => {
    await edit();
    let resolve!: (value: unknown) => void;
    state.refresh.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await click("Save replacement");
    await render({ connected: false });
    await act(async () => resolve({ _tag: "Success", value: page() }));
    expect(state.write).not.toHaveBeenCalled();
  });
  it("keeps an uncertain command selected until explicit discard", async () => {
    state.write.mockResolvedValue({ _tag: "Failure" });
    await edit();
    await click("Save replacement");
    expect(button("Promote knowledge")!.disabled).toBe(true);
    expect(button("Correct or replace")!.disabled).toBe(true);
    await click("Discard");
    expect(host.querySelector<HTMLInputElement>('[placeholder="Title"]')!.disabled).toBe(false);
    expect(button("Promote knowledge")!.disabled).toBe(false);
  });
  it.each(["reconnect", "revision", "project", "permission"])(
    "invalidates in-flight validation after %s changes",
    async (change) => {
      await edit();
      let resolve!: (value: unknown) => void;
      state.refresh.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await click("Save replacement");
      if (change === "reconnect") {
        await render({ connected: false });
        await render();
      }
      if (change === "revision") {
        state.briefing = AsyncResult.success(briefing(9));
        await render();
      }
      if (change === "project") await render({ projectId: ProjectId.make("project-2") });
      if (change === "permission") await render({ canWrite: false });
      await act(async () => resolve({ _tag: "Success", value: page() }));
      expect(state.write).not.toHaveBeenCalled();
    },
  );
  it("stops at the bounded closure instead of accepting an incomplete history", async () => {
    await edit();
    state.refresh.mockImplementation(async (target: { offset: number }) => ({
      _tag: "Success",
      value: page(
        Array.from({ length: 50 }, (_, index) => ({
          ...previous,
          knowledgeId: `record-${target.offset + index}`,
        })),
        4,
        true,
      ),
    }));
    await click("Save replacement");
    expect(state.refresh).toHaveBeenCalledTimes(6);
    expect(state.write).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Cannot confirm");
  });
  it("blocks a failed current-state read", async () => {
    await edit();
    state.refresh.mockResolvedValue({ _tag: "Failure" });
    await click("Save replacement");
    expect(state.write).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Cannot confirm");
  });
});
