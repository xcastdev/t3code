/* @vitest-environment happy-dom */
import { RegistryContext } from "@effect/atom-react";
import { Atom, AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import {
  canonicalProjectWorkPayload,
  EnvironmentId,
  ProjectId,
  ProjectTeamRecordRead,
  ProjectWorkTaskContext,
  ProjectWorkWriteIntent,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";
const pageBridge = vi.hoisted(() => ({
  config: undefined as unknown,
  presentation: undefined as unknown,
  phase: "connected",
}));
const transport = vi.hoisted(() => ({
  read: vi.fn(),
  refresh: vi.fn(),
  write: vi.fn(),
  environment: {
    verificationJob: vi.fn(),
    page: vi.fn(),
    taskContext: vi.fn(),
    foundationPage: vi.fn(),
    write: Symbol("write"),
    pageSize: 50,
    pageRequestSize: 51,
  },
}));
vi.mock("../../state/projectWork", () => ({ projectWorkEnvironment: transport.environment }));
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: (family: unknown) =>
    family === transport.environment.verificationJob ? transport.read : transport.refresh,
}));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => transport.write }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: pageBridge.phase } }),
}));
vi.mock("../../state/entities", () => ({ useProject: () => ({ title: "Remote project" }) }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => pageBridge.presentation },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => pageBridge.config },
}));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock("../WorkspacePageContainer", () => ({
  WorkspacePageContainer: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
}));
vi.mock("./WorkOverview", () => ({ WorkOverview: () => <p>Current project overview</p> }));
import { WorkPage } from "./WorkPage";
import { WorkTasks } from "./WorkTasks";

import { createGuidedTaskDraftState, type GuidedTaskDraftStore } from "./guidedTaskDraft";
import {
  TaskVerification,
  TaskVerificationDraftContext,
  type TaskVerificationProps,
} from "./TaskVerification";
const at = "2026-10-01T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const environmentId = EnvironmentId.make("environment-1");
const decodeContext = Schema.decodeUnknownSync(ProjectWorkTaskContext);
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecordRead);
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
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

function foundation() {
  const fields = { projectId, revision: 1, generation: 7, updatedAt: at };
  return [
    {
      ...fields,
      kind: "task-membership",
      recordId: "membership",
      status: "active",
      taskId: "task-1",
      executionKind: "managed",
      deliverableKind: "code",
      controlState: "active",
    },
    {
      ...fields,
      kind: "plan-revision",
      recordId: "plan",
      status: "proposed",
      taskId: "task-1",
      specRevision: 2,
      planRevision: 3,
      content: "Exercise remote reconnect",
      contentHash: "b".repeat(64),
      dependencyTaskIds: [],
    },
    {
      ...fields,
      kind: "role-revision",
      recordId: "role",
      status: "retired",
      roleId: "implementer",
      roleRevision: 1,
      role: "implementer",
      model: "model",
      instructions: "Implement",
      skills: [],
      tools: [],
      memoryAccess: "project",
      delegationDepth: 0,
    },
    {
      ...fields,
      kind: "run-binding",
      recordId: "binding",
      status: "settled",
      taskId: "task-1",
      attemptId: "attempt",
      memberId: "member",
      roleRevisionId: "role",
      providerInstanceId: "codex-default",
      threadId: "thread",
      environmentId,
      model: "model",
      configuration: {
        instructionsHash: "hash",
        toolIds: [],
        skillIds: [],
        runtimeVersion: "1",
        maxTokens: 1,
        maxDurationMs: 1,
        paidFallback: false,
      },
      worktree: "/project-worktree",
      branch: "refs/heads/assigned",
      leaseGeneration: 7,
      specRevision: 2,
      planRevision: 3,
    },
  ].map((record) => decodeRecord(record));
}

const previewManifest = {
  version: 1,
  jobId: "verification-1",
  environmentId: "environment-1",
  projectId: "project-1",
  taskId: "task-1",
  specRevision: 2,
  specificationHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  planRevision: 3,
  planHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  criteria: [
    {
      criterionId: "criterion-1",
      revision: 3,
    },
  ],
  dispatchId: "original-implementation",
  bindingId: "binding",
  generation: 7,
  workspaceReceiptHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  command: {
    executable: "/opt/project tools/test runner",
    argv: ["", "  preserved  ", "--filter", "$(literal); *", "line\nbreak"],
    limits: {
      maxDurationMs: 120000,
      maxOutputBytes: 65536,
    },
    environment: "clean",
  },
  target: {
    repository: "/project",
    worktree: "/project-worktree",
    branchRef: "refs/heads/assigned",
    baseSha: "dddddddddddddddddddddddddddddddddddddddd",
    headSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    testedCommit: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    testedTree: "ffffffffffffffffffffffffffffffffffffffff",
    workspaceState: "clean-committed",
  },
  executable: {
    target: "/opt/project tools/test runner",
    sha256: "1111111111111111111111111111111111111111111111111111111111111111",
    runtimeClosureSha256: "2222222222222222222222222222222222222222222222222222222222222222",
  },
};
const preview = {
  kind: "verification-job",
  manifest: previewManifest,
  sha256: "8f6827b531a1084ce0856362ce0ee9058c8c86187d2c9974fdcb99d812e56cd9",
};
function gate(status = "pending") {
  return decodeRecord({
    kind: "gate",
    recordId: "verification-gate",
    projectId,
    revision: 2,
    generation: 7,
    updatedAt: at,
    status,
    taskId: "task-1",
    gate: "verification",
    specRevision: 2,
    planRevision: 3,
    contentHash: preview.sha256,
    verificationJobId: previewManifest.jobId,
    evidenceIds: [],
    attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
  });
}
describe("human task verification", () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: ReturnType<typeof context>;
  let records: ReturnType<typeof foundation>;
  let write: Mock<TaskVerificationProps["onWrite"]>;
  let props: TaskVerificationProps;
  let presentation: ReturnType<typeof Atom.make<unknown>>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    presentation = Atom.make<unknown>({
      entry: { enabled: true, target: { environmentId } },
      connection: { phase: "connected" },
    });
    pageBridge.presentation = presentation;
    transport.refresh.mockReset();
    transport.write.mockReset();
    transport.read.mockReset();
    transport.read.mockResolvedValue({ _tag: "Success", value: preview });
    current = context();
    records = foundation();
    write = vi.fn(async (intent: ProjectWorkWriteIntent) => {
      decodeWrite(intent);
    });
    props = {
      environmentId,
      projectId,
      context: current,
      records,
      current: true,
      connected: true,
      enabled: true,
      supported: true,
      verify: () => ({ context: current, records }),
      onWrite: write,
      onRefresh: vi.fn(),
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
  });
  async function render(overrides: Partial<TaskVerificationProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () =>
      root.render(
        <StrictMode>
          <TaskVerification {...props} />
        </StrictMode>,
      ),
    );
  }
  async function fill(label: string, value: string) {
    const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[aria-label="${label}"]`,
    )!;
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    await act(async () => field.dispatchEvent(new Event("input", { bubbles: true })));
  }
  async function click(label: string) {
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.textContent === label)
        ?.click(),
    );
  }

  async function prepare() {
    await fill("Verification executable", "/opt/test runner");
    await fill("Verification arguments", '["", "  literal  ", "$(literal); *"]');
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Completed assignment"]')!;
    await act(async () => {
      select.value = "binding";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      host.querySelector<HTMLInputElement>('[aria-label="Cover Retain the conversation"]')!.click(),
    );
  }
  it("proposes verification for an original completed integrator assignment", async () => {
    records = records.map((record) =>
      record.kind === "role-revision" ? decodeRecord({ ...record, role: "integrator" }) : record,
    );
    await render({ records });
    await prepare();
    await click("Propose verification");
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      type: "project-team.verification.propose",
      bindingId: "binding",
    });
    expect(Object.hasOwn(write.mock.calls[0]![0], "integration")).toBe(false);
  });

  it.each([
    ["integrator", true, true],
    ["implementer", true, false],
    ["integrator", false, false],
  ] as const)(
    "checks %s role against integration=%s before approval",
    async (role, integration, allowed) => {
      const manifest = integration ? { ...previewManifest, integration: true } : previewManifest;
      const prepared = {
        ...preview,
        manifest,
        sha256: NodeCrypto.createHash("sha256")
          .update(canonicalProjectWorkPayload(manifest))
          .digest("hex"),
      };
      records = records.map((record) =>
        record.kind === "role-revision" ? decodeRecord({ ...record, role }) : record,
      );
      records.push(decodeRecord({ ...gate(), contentHash: prepared.sha256 }));
      transport.read.mockResolvedValue({ _tag: "Success", value: prepared });
      await render({ records });
      await click("Load verification preview");
      expect(
        host.querySelector<HTMLButtonElement>('[aria-label="Approve verification"]')?.disabled,
      ).toBe(!allowed);
      if (allowed) expect(host.textContent).toContain("Integration verification");
      await click("Approve verification");
      expect(write).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it("proposes current settled implementation and criterion coverage with literal process arguments", async () => {
    await render();
    expect(host.textContent).toContain("Propose verification");
    await fill("Verification executable", "/opt/test runner");
    await fill("Verification arguments", '["", "  literal  ", "$(literal); *", "line\\nbreak"]');
    const binding = host.querySelector<HTMLSelectElement>('[aria-label="Completed assignment"]')!;
    await act(async () => {
      binding.value = "binding";
      binding.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      host.querySelector<HTMLInputElement>('[aria-label="Cover Retain the conversation"]')!.click(),
    );
    await click("Propose verification");
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      type: "project-team.verification.propose",
      projectId,
      taskId: "task-1",
      expectedRevision: 10,
      expectedTaskRevision: 4,
      specRevision: 2,
      planRevision: 3,
      bindingId: "binding",
      expectedBindingRevision: 1,
      generation: 7,
      criterionIds: ["criterion-1"],
      command: {
        executable: "/opt/test runner",
        argv: ["", "  literal  ", "$(literal); *", "line\nbreak"],
        environment: "clean",
        limits: { maxDurationMs: 120_000, maxOutputBytes: 65_536 },
      },
    });
    expect(host.textContent).toContain("prepared preview");
    expect(host.textContent).not.toContain("Verification passed");
  });

  it("loads the exact prepared preview before approval and displays captured code, arguments and limits", async () => {
    records = [...records, gate()];
    await render({ records });
    expect(write).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Prepared · waiting for approval");
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Approve verification"]')?.disabled,
    ).toBe(true);
    await click("Load verification preview");
    expect(transport.read).toHaveBeenCalledWith({
      environmentId,
      projectId,
      taskId: "task-1",
      verificationJobId: "verification-1",
    });
    for (const text of [
      "/opt/project tools/test runner",
      "$(literal); *",
      "/project-worktree",
      "refs/heads/assigned",
      "d".repeat(40),
      "e".repeat(40),
      "f".repeat(40),
      "120000",
      "65536",
      "criterion-1",
      preview.sha256,
    ])
      expect(host.textContent).toContain(text);
    await click("Approve verification");
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      type: "project-team.gate.respond",
      projectId,
      taskId: "task-1",
      expectedRevision: 10,
      expectedTaskRevision: 4,
      specRevision: 2,
      planRevision: 3,
      gateId: "verification-gate",
      expectedGateRevision: 2,
      response: "approved",
    });
    expect(host.textContent).not.toContain("Verification passed");
  });
  it("rejects a pending gate without loading a preview or depending on the host executable", async () => {
    records = [...records, gate()];
    await render({ records });
    await click("Reject verification");
    expect(transport.read).not.toHaveBeenCalled();
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      type: "project-team.gate.respond",
      gateId: "verification-gate",
      response: "rejected",
    });
  });

  it("retries an uncertain proposal with the identical job, command and complete envelope", async () => {
    write.mockRejectedValueOnce(new Error("Response lost"));
    await render();
    await prepare();
    await click("Propose verification");
    const first = structuredClone(write.mock.calls[0]?.[0]);
    expect(host.textContent).toContain("Response lost");
    await click("Retry exact verification request");
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0]).toEqual(first);
  });
  it("rereads current settled ownership at submission and retains the form when the binding changes", async () => {
    await render();
    await prepare();
    records = records.map((r) =>
      r.recordId === "binding"
        ? decodeRecord({ ...r, revision: 2, generation: 8, leaseGeneration: 8 })
        : r,
    );
    await click("Propose verification");
    expect(write).not.toHaveBeenCalled();
    expect(host.textContent).toContain("target changed");
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="Verification executable"]')?.value,
    ).toBe("/opt/test runner");
  });
  it("refuses approval when fresh task or criterion revisions changed after review even before a rerender", async () => {
    records = [...records, gate()];
    await render({ records });
    await click("Load verification preview");
    current = decodeContext({
      ...current,
      criteria: current.criteria.map((c) => ({ ...c, revision: c.revision + 1 })),
    });
    await click("Approve verification");
    expect(write).not.toHaveBeenCalled();
    expect(host.textContent).toContain("current verification preview");
  });
  it.each(["environment", "project", "task", "job", "hash", "command", "criteria", "future"])(
    "rejects an unusable %s preview without enabling approval",
    async (change) => {
      const fields = {
        environment: { environmentId: "foreign" },
        project: { projectId: "foreign" },
        task: { taskId: "foreign" },
        job: { jobId: "foreign" },
        command: { command: { ...previewManifest.command, executable: "/other" } },
        criteria: { criteria: [] },
        future: { version: 2 },
        hash: {},
      };
      transport.read.mockResolvedValue({
        _tag: "Success",
        value: {
          ...preview,
          ...(change === "hash" ? { sha256: "9".repeat(64) } : {}),
          manifest: { ...previewManifest, ...fields[change as keyof typeof fields] },
        },
      });
      records = [...records, gate()];
      await render({ records });
      await click("Load verification preview");
      await click("Approve verification");
      expect(write).not.toHaveBeenCalled();
      expect(
        host.querySelector<HTMLButtonElement>('[aria-label="Approve verification"]')?.disabled,
      ).toBe(true);
      expect(host.textContent).toContain("preview is unavailable");
    },
  );
  it.each([{ connected: false }, { enabled: false }, { supported: false }, { current: false }])(
    "disables preview and responses when current access changes: %j",
    async (access) => {
      records = [...records, gate()];
      await render({ records });
      await click("Load verification preview");
      await render(access);
      await click("Approve verification");
      await click("Reject verification");
      await click("Load verification preview");
      expect(write).not.toHaveBeenCalled();
      expect(transport.read).toHaveBeenCalledOnce();
      expect(host.textContent).not.toContain("/opt/project tools/test runner");
    },
  );
  it("fences a late preview response after switching to another task", async () => {
    let resolve: (value: unknown) => void = () => {};
    const reply = new Promise((done) => {
      resolve = done;
    });
    transport.read.mockReturnValue(reply);
    records = [...records, gate()];
    await render({ records });
    await click("Load verification preview");
    current = context(10, "task-2");
    await render({ context: current, records: [] });
    await act(async () => resolve({ _tag: "Success", value: preview }));
    expect(host.textContent).not.toContain("/opt/project tools/test runner");
    expect(write).not.toHaveBeenCalled();
  });
  it("does not publish success or refresh another owner after a late proposal response", async () => {
    let resolve: () => void = () => {};
    write.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    await render();
    await prepare();
    await click("Propose verification");
    current = context(10, "task-2");
    await render({ context: current, records: [] });
    await act(async () => resolve());
    expect(props.onRefresh).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Verification proposed");
  });
  it("preserves a definitive server permission denial without claiming an uncertain approval", async () => {
    write.mockRejectedValue({ code: "permission-denied", message: "Human permission revoked" });
    records = [...records, gate()];
    await render({ records });
    await click("Reject verification");
    expect(host.textContent).toContain("Human permission revoked");
    expect(host.textContent).not.toContain("Response recorded");
    expect(host.textContent).not.toContain("Retry exact verification request");
  });
  it("shows approved status from the retained gate without reporting execution or success", async () => {
    records = [...records, gate("approved")];
    await render({ records });
    expect(host.textContent).toContain("Approved");
    expect(host.textContent).not.toContain("Approve verification");
    expect(host.textContent).not.toContain("Verification passed");
    expect(write).not.toHaveBeenCalled();
  });

  it("retries an uncertain approval using the reviewed original response and command ID", async () => {
    write.mockRejectedValueOnce(new Error("Response lost"));
    records = [...records, gate()];
    await render({ records });
    await click("Load verification preview");
    await click("Approve verification");
    const first = structuredClone(write.mock.calls[0]?.[0]);
    await click("Retry exact verification request");
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0]).toEqual(first);
  });
  it("keeps later pending gates reachable after a full page of retained rejected gates", async () => {
    const histories = Array.from({ length: 8 }, (_, index) =>
      decodeRecord({
        ...gate("rejected"),
        recordId: `history-${index}`,
        verificationJobId: `historical-job-${index}`,
      }),
    );
    records = [...records, ...histories, gate()];
    await render({ records });
    expect(host.textContent).not.toContain("Reject verification");
    await click("Next verification gates");
    expect(host.textContent).toContain("Prepared · waiting for approval");
    await click("Reject verification");
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      gateId: "verification-gate",
      response: "rejected",
    });
  });
  it.each([
    ["Verification executable", "runner"],
    ["Verification arguments", "runner --filter all"],
    ["Verification arguments", '["bad\\u0000arg"]'],
    ["Verification timeout", "0"],
    ["Verification timeout", "3600001"],
    ["Verification output limit", "0"],
    ["Verification output limit", "1048577"],
  ])("denies invalid command selection %s=%j without a transport write", async (field, value) => {
    await render();
    await prepare();
    await fill(field, value);
    await click("Propose verification");
    expect(write).not.toHaveBeenCalled();
    expect(host.textContent).toContain("absolute executable path");
  });
  const accessConfig = (revoked?: "enabled" | "reads" | "writes") => ({
    settings: { projectWorkEnabled: revoked !== "enabled" },
    environment: {
      capabilities: {
        projectTeamFoundationReads: revoked !== "reads",
        projectTeamGuidedWrites: revoked !== "writes",
      },
    },
  });
  async function accessPage(
    withGate: boolean,
    run: (
      registry: AtomRegistry.AtomRegistry,
      config: ReturnType<typeof Atom.make<ReturnType<typeof accessConfig>>>,
    ) => Promise<void>,
  ) {
    const registry = AtomRegistry.make();
    if (withGate) records = [...records, gate()];
    const config = Atom.make(accessConfig());
    pageBridge.config = config;
    pageBridge.phase = "connected";
    transport.environment.taskContext.mockReturnValue(Atom.make(AsyncResult.success(current)));
    transport.environment.foundationPage.mockReturnValue(
      Atom.make(AsyncResult.success({ projectId, revision: 10, items: records })),
    );
    transport.environment.page.mockReturnValue(
      Atom.make(
        AsyncResult.success({
          projectId,
          revision: 10,
          offset: 0,
          limit: 50,
          hasMore: false,
          items: [current.task],
        }),
      ),
    );
    transport.write.mockResolvedValue({ _tag: "Success", value: { projectId, revision: 11 } });
    try {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <WorkPage
              environmentId={environmentId}
              projectId={projectId}
              selection={{ tab: "tasks", taskId: current.task.taskId }}
            />
          </RegistryContext.Provider>,
        ),
      );
      await run(registry, config);
    } finally {
      await act(async () => root.unmount());
      registry.dispose();
      root = createRoot(host);
    }
  }
  function heldButton(label: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === label,
    );
    if (!button) throw Error("Missing mounted control: " + label);
    return button;
  }
  it.each(["enabled", "reads", "writes"] as const)(
    "fresh registry %s revocation denies proposal before React commits",
    async (kind) => {
      await accessPage(false, async (registry, config) => {
        await prepare();
        const held = heldButton("Propose verification");
        expect(held.disabled).toBe(false);
        await act(async () => {
          registry.set(config, accessConfig(kind));
          held.click();
        });
        expect(transport.write).not.toHaveBeenCalled();
      });
    },
  );
  it.each(["enabled", "reads", "writes"] as const)(
    "fresh registry %s revocation denies preview before React commits",
    async (kind) => {
      await accessPage(true, async (registry, config) => {
        const held = heldButton("Load verification preview");
        await act(async () => {
          registry.set(config, accessConfig(kind));
          held.click();
        });
        expect(transport.read).not.toHaveBeenCalled();
        expect(transport.write).not.toHaveBeenCalled();
      });
    },
  );
  it.each(["Approve verification", "Reject verification"])(
    "fresh registry revocation denies %s before React commits",
    async (choice) => {
      await accessPage(true, async (registry, config) => {
        if (choice === "Approve verification") await click("Load verification preview");
        const held = heldButton(choice);
        expect(held.disabled).toBe(false);
        await act(async () => {
          registry.set(config, accessConfig("writes"));
          held.click();
        });
        expect(transport.write).not.toHaveBeenCalled();
      });
    },
  );
  it("fresh registry revocation denies an exact uncertain retry before React commits", async () => {
    await accessPage(false, async (registry, config) => {
      transport.write.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Response lost") });
      await prepare();
      await click("Propose verification");
      const held = heldButton("Retry exact verification request");
      await act(async () => {
        registry.set(config, accessConfig("writes"));
        held.click();
      });
      expect(transport.write).toHaveBeenCalledOnce();
    });
  });
  it("fresh presentation disconnection denies proposal before React commits", async () => {
    await accessPage(false, async (registry) => {
      await prepare();
      const held = heldButton("Propose verification");
      await act(async () => {
        registry.set(presentation, {
          entry: { enabled: true, target: { environmentId } },
          connection: { phase: "offline" },
        });
        held.click();
      });
      expect(transport.write).not.toHaveBeenCalled();
    });
  });
  it("late preview checks current registry access before revealing the captured command", async () => {
    let resolve: (value: unknown) => void = () => {};
    await accessPage(true, async (registry, config) => {
      transport.read.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      await click("Load verification preview");
      await act(async () => {
        registry.set(config, accessConfig("writes"));
        resolve({ _tag: "Success", value: preview });
      });
      expect(host.textContent).not.toContain(previewManifest.command.executable);
      expect(transport.write).not.toHaveBeenCalled();
    });
  });
  it("late acknowledged write with revoked registry access retains the request without publishing success or refreshing", async () => {
    let resolve: (value: unknown) => void = () => {};
    await accessPage(false, async (registry, config) => {
      transport.write.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      await prepare();
      await click("Propose verification");
      const original = structuredClone(transport.write.mock.calls[0]?.[0]);
      await act(async () => {
        registry.set(config, accessConfig("writes"));
        resolve({ _tag: "Success", value: { projectId, revision: 11 } });
      });
      expect(host.textContent).not.toContain("Verification proposed.");
      expect(host.textContent).toContain("Access changed.");
      expect(transport.refresh).not.toHaveBeenCalled();
      expect(transport.write).toHaveBeenCalledOnce();
      await act(async () => registry.set(config, accessConfig()));
      expect(host.textContent).toContain("Retry exact verification request");
      expect(transport.write).toHaveBeenCalledOnce();
      expect(transport.write.mock.calls[0]?.[0]).toEqual(original);
    });
  });
  it.each(["proposal", "approval", "rejection"])(
    "retains an uncertain %s through real WorkPage tab and task visits without resubmitting",
    async (choice) => {
      if (choice !== "proposal") records = [...records, gate()];
      const registry = AtomRegistry.make();
      const taskAtom = Atom.make(AsyncResult.success(current));
      const foundationAtom = Atom.make(
        AsyncResult.success({ projectId, revision: 10, items: records }),
      );
      const tasksAtom = Atom.make(
        AsyncResult.success({
          projectId,
          revision: 10,
          offset: 0,
          limit: 50,
          hasMore: false,
          items: [current.task],
        }),
      );
      pageBridge.config = Atom.make({
        settings: { projectWorkEnabled: true },
        environment: {
          capabilities: { projectTeamFoundationReads: true, projectTeamGuidedWrites: true },
        },
      });
      pageBridge.phase = "connected";
      transport.environment.taskContext.mockImplementation(({ taskId }) =>
        taskId === "task-1" ? taskAtom : Atom.make(AsyncResult.success(context(10, "task-2"))),
      );
      transport.environment.foundationPage.mockReturnValue(foundationAtom);
      transport.environment.page.mockReturnValue(tasksAtom);
      transport.write.mockResolvedValue({ _tag: "Failure", error: new Error("Response lost") });
      const visit = async (tab: "tasks" | "overview", taskId = current.task.taskId) => {
        await act(async () =>
          root.render(
            <RegistryContext.Provider value={registry}>
              <WorkPage
                environmentId={environmentId}
                projectId={projectId}
                selection={{ tab, taskId }}
              />
            </RegistryContext.Provider>,
          ),
        );
      };
      try {
        await visit("tasks");
        if (choice === "proposal") {
          await prepare();
          await click("Propose verification");
        } else {
          if (choice === "approval") await click("Load verification preview");
          await click(choice === "approval" ? "Approve verification" : "Reject verification");
        }
        const original = structuredClone(transport.write.mock.calls[0]?.[0]);
        await visit("overview");
        expect(host.textContent).toContain("Current project overview");
        await visit("tasks", context(10, "task-2").task.taskId);
        expect(host.textContent).not.toContain("Retry exact verification request");
        await visit("tasks");
        expect(transport.write).toHaveBeenCalledOnce();
        expect(host.textContent).toContain("Retry exact verification request");
        pageBridge.phase = "disconnected";
        await visit("tasks");
        await click("Retry exact verification request");
        expect(transport.write).toHaveBeenCalledOnce();
        pageBridge.phase = "connected";
        await visit("tasks");
        if (choice === "approval") {
          await click("Retry exact verification request");
          expect(transport.write).toHaveBeenCalledOnce();
          await click("Load verification preview");
        }
        await act(async () =>
          registry.set(
            foundationAtom,
            AsyncResult.success({
              projectId,
              revision: 10,
              items: records.map((r) =>
                (
                  choice === "proposal"
                    ? r.recordId === "binding"
                    : r.recordId === "verification-gate"
                )
                  ? decodeRecord(
                      choice === "proposal"
                        ? { ...r, generation: 8, leaseGeneration: 8 }
                        : { ...r, revision: 3 },
                    )
                  : r,
              ),
            }),
          ),
        );
        await click("Retry exact verification request");
        expect(transport.write).toHaveBeenCalledOnce();
        expect(host.textContent).toContain("target changed");
        await act(async () =>
          registry.set(
            foundationAtom,
            AsyncResult.success({ projectId, revision: 10, items: records }),
          ),
        );
        transport.write.mockResolvedValue({ _tag: "Success", value: { projectId, revision: 11 } });
        await click("Retry exact verification request");
        expect(transport.write).toHaveBeenCalledTimes(2);
        expect(transport.write.mock.calls[1]?.[0]).toEqual(original);
      } finally {
        await act(async () => root.unmount());
        registry.dispose();
        root = createRoot(host);
      }
    },
  );
  it("retains an uncertain receipt for its original owner after unmount, without affecting another task or auto-retrying", async () => {
    let reject: (failure: Error) => void = () => {};
    write.mockReturnValue(
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
    );
    let state = createGuidedTaskDraftState();
    const store: GuidedTaskDraftStore = {
      get snapshot() {
        return state;
      },
      read: () => state,
      write: (next) => {
        state = next;
      },
    };
    const mount = async () =>
      act(async () =>
        root.render(
          <TaskVerificationDraftContext.Provider value={store}>
            <TaskVerification {...props} />
          </TaskVerificationDraftContext.Provider>,
        ),
      );
    await mount();
    await prepare();
    await click("Propose verification");
    const original = structuredClone(write.mock.calls[0]?.[0]);
    await act(async () => root.render(<p>Other tab</p>));
    await act(async () => reject(new Error("Response lost")));
    expect(state.entries[0]?.pending?.status).toBe("uncertain");
    expect(props.onRefresh).not.toHaveBeenCalled();
    const owned = props;
    props = { ...props, context: context(10, "task-2"), records: [] };
    await mount();
    expect(host.textContent).not.toContain("Retry exact verification request");
    expect(write).toHaveBeenCalledOnce();
    props = owned;
    await mount();
    expect(host.textContent).toContain("Retry exact verification request");
    expect(write).toHaveBeenCalledOnce();
    write.mockResolvedValue(undefined);
    await click("Retry exact verification request");
    expect(write.mock.calls[1]?.[0]).toEqual(original);
  });
  it("proposes verification from the mounted task entry using the actual fresh task and foundation registry guards", async () => {
    const registry = AtomRegistry.make();
    const taskAtom = Atom.make(AsyncResult.success(current));
    const foundationAtom = Atom.make(
      AsyncResult.success({ projectId, revision: 10, items: records }),
    );
    const tasksAtom = Atom.make(
      AsyncResult.success({
        projectId,
        revision: 10,
        offset: 0,
        limit: 50,
        hasMore: false,
        items: [current.task],
      }),
    );
    transport.environment.taskContext.mockReturnValue(taskAtom);
    transport.environment.foundationPage.mockReturnValue(foundationAtom);
    transport.environment.page.mockReturnValue(tasksAtom);
    transport.write.mockImplementation(async ({ input }) => {
      decodeWrite(input);
      return { _tag: "Success", value: { projectId, revision: 11 } };
    });
    try {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <WorkTasks
              environmentId={environmentId}
              projectId={projectId}
              connected
              enabled
              teamReadSupported
              guidedWritesSupported
              targetTaskId={current.task.taskId}
            />
          </RegistryContext.Provider>,
        ),
      );
      expect(host.textContent).toContain("Propose verification");
      await prepare();
      await click("Propose verification");
      expect(transport.write).toHaveBeenCalledOnce();
      expect(transport.write.mock.calls[0]?.[0]).toMatchObject({
        environmentId,
        input: {
          type: "project-team.verification.propose",
          expectedRevision: 10,
          expectedTaskRevision: 4,
          bindingId: "binding",
          generation: 7,
        },
      });
    } finally {
      await act(async () => root.unmount());
      registry.dispose();
      root = createRoot(host);
    }
  });
});
