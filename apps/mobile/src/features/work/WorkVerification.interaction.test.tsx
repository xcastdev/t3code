/* @vitest-environment happy-dom */
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  EnvironmentAuthorizationError,
  ProjectId,
  ProjectTeamRecordRead,
  ProjectWorkTaskContext,
  ProjectWorkWriteIntent,
  ProjectWorkReadIntent,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  registry: undefined as unknown,
  foundationPage: vi.fn(),
  verificationJob: vi.fn(),
  focused: true,
  page: vi.fn(),
  taskContext: vi.fn(),
  dispatch: vi.fn(),
  query: { data: null as unknown, error: null, isPending: false, refresh: vi.fn() },
  navigate: vi.fn(),
  command: vi.fn(),
  enabled: true,
  supported: true,
  connected: true,
  available: true,
  contextAtom: undefined as unknown,
  projectAtom: undefined as unknown,
  presentationAtom: undefined as unknown,
  callbacks: new Map<string, () => void>(),
  sequence: 0,
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => fixture.focused,
  useNavigation: () => ({
    navigate: fixture.navigate,
    goBack: vi.fn(),
    isFocused: () => fixture.focused,
    dispatch: fixture.dispatch,
  }),
  CommonActions: {
    navigate: (name: string, params: unknown) => ({ type: "NAVIGATE", payload: { name, params } }),
  },
  StackActions: { push: vi.fn() },
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  const container = ({ children }: { children: ReactNode }) =>
    React.createElement("div", {}, children);
  return {
    Platform: { OS: "ios" },
    View: container,
    ScrollView: container,
    Pressable: ({
      children,
      onPress,
      disabled,
    }: {
      children: ReactNode;
      onPress: () => void;
      disabled?: boolean;
    }) => {
      const label = React.isValidElement<{ children: ReactNode }>(children)
        ? children.props.children
        : children;
      if (typeof label === "string") fixture.callbacks.set(label, onPress);
      return React.createElement("button", { onClick: onPress, disabled }, children);
    },
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/AppText", async () => {
  const React = await import("react");
  return {
    AppText: ({ children }: { children: ReactNode }) => React.createElement("span", {}, children),
    AppTextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
      editable,
    }: {
      value: string;
      onChangeText: (text: string) => void;
      accessibilityLabel: string;
      editable: boolean;
    }) =>
      React.createElement("textarea", {
        value,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
          onChangeText(event.target.value),
        "aria-label": accessibilityLabel,
        disabled: !editable,
      }),
  };
});
vi.mock("../../components/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../state/entities", () => ({
  useProject: ({ projectId }: { projectId: string }) =>
    fixture.available ? { title: projectId } : null,
  useProjects: () => [],
  useEnvironmentServerConfig: () => ({
    settings: { projectWorkEnabled: fixture.enabled },
    environment: {
      capabilities: {
        projectTeamFoundationReads: fixture.supported,
        projectTeamGuidedWrites: fixture.supported,
      },
    },
  }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
  useRemoteEnvironmentRuntime: () => ({
    connectionState: fixture.connected ? "connected" : "disconnected",
  }),
}));
vi.mock("../../state/atom-registry", () => ({
  get appAtomRegistry() {
    return fixture.registry;
  },
}));
vi.mock("../../state/projects", () => ({
  environmentProjects: { projectAtom: () => fixture.projectAtom },
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => fixture.presentationAtom },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => fixture.query,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixture.command }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => `fixture-command-${fixture.sequence++}` }));
vi.mock("./workEnvironment", () => ({
  mobileWorkEnvironment: {
    foundationPage: fixture.foundationPage,
    verificationJob: fixture.verificationJob,
    page: fixture.page,
    taskContext: fixture.taskContext,
  },
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, input: string) =>
    NodeCrypto.createHash("sha256").update(input).digest("hex"),
}));
import { WorkTaskScreen } from "./WorkScreens";
const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const at = "2026-10-01T10:00:00.000Z";
const decodeContext = Schema.decodeUnknownSync(ProjectWorkTaskContext);
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecordRead);
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
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
    children: { criteria: [], evidence: [], relationships: [], blockers: [], comments: [] },
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

let root: Root;
let host: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
let task: ReturnType<typeof Atom.make<AsyncResult.AsyncResult<unknown>>>;
let team: ReturnType<typeof Atom.make<AsyncResult.AsyncResult<unknown>>>;
let project: ReturnType<typeof Atom.make<{ id: ProjectId; environmentId: EnvironmentId }>>;
let presentation: ReturnType<typeof Atom.make<unknown>>;
let previewAtom: ReturnType<typeof Atom.make<AsyncResult.AsyncResult<unknown>>>;
let emitted: ProjectWorkWriteIntent[];
let reads: ProjectWorkReadIntent[];
let current = context();
const decodeRead = Schema.decodeUnknownSync(ProjectWorkReadIntent);
const config = () => ({
  settings: { projectWorkEnabled: true },
  environment: {
    capabilities: { projectTeamFoundationReads: true, projectTeamGuidedWrites: true },
  },
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.connected =
    fixture.enabled =
    fixture.supported =
    fixture.available =
    fixture.focused =
      true;
  fixture.sequence = 0;
  fixture.callbacks.clear();
  fixture.command.mockReset();
  fixture.verificationJob.mockReset();
  current = context();
  emitted = [];
  reads = [];
  registry = AtomRegistry.make();
  fixture.registry = registry;
  task = Atom.make<AsyncResult.AsyncResult<unknown>>(AsyncResult.success(current));
  fixture.contextAtom = task;
  team = Atom.make<AsyncResult.AsyncResult<unknown>>(
    AsyncResult.success({ projectId, revision: 10, items: foundation() }),
  );
  presentation = Atom.make<unknown>({
    entry: { enabled: true },
    connection: { phase: "connected" },
    serverConfig: config(),
  });
  fixture.presentationAtom = presentation;
  project = Atom.make({ id: projectId, environmentId });
  fixture.projectAtom = project;
  fixture.foundationPage.mockReturnValue(team);
  fixture.taskContext.mockReturnValue(task);
  fixture.query = { data: current, error: null, isPending: false, refresh: vi.fn() };
  previewAtom = Atom.make<AsyncResult.AsyncResult<unknown>>(AsyncResult.success(preview));
  fixture.verificationJob.mockImplementation((target) => {
    expect(target.environmentId).toBe(environmentId);
    reads.push(
      decodeRead({
        operation: "verification-job",
        projectId: target.projectId,
        taskId: target.taskId,
        verificationJobId: target.verificationJobId,
      }),
    );
    return previewAtom;
  });
  fixture.command.mockImplementation(async ({ environmentId: owner, input }) => {
    expect(owner).toBe(environmentId);
    emitted.push(decodeWrite(input));
    return AsyncResult.success({ projectId, revision: 11 });
  });
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
async function render(
  taskId = "task-1",
  owner: string = environmentId,
  project: string = projectId,
) {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <WorkTaskScreen route={{ params: { environmentId: owner, projectId: project, taskId } }} />
      </RegistryContext.Provider>,
    ),
  );
}
function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === label,
  );
  if (!found) throw Error("Missing mounted control " + label);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill(label: string, value: string) {
  const field = host.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`);
  if (!field) throw Error("Missing input " + label);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
  await act(async () => field.dispatchEvent(new Event("input", { bubbles: true })));
}
async function prepare() {
  await click("Select settled implementation binding");
  await fill("Verification executable", "/opt/test runner");
  await fill("Verification arguments", '["", "  preserved  ", "$(literal); *", "line\\nbreak"]');
  await click("Cover Retain the conversation");
}
async function pendingGate() {
  team = Atom.make<AsyncResult.AsyncResult<unknown>>(
    AsyncResult.success({ projectId, revision: 10, items: [...foundation(), gate()] }),
  );
  fixture.foundationPage.mockReturnValue(team);
  await render();
}
describe("mounted mobile verification", () => {
  it("loads the exact retained preview and approves its current gate through the typed API", async () => {
    await pendingGate();
    expect(button("Approve prepared verification").disabled).toBe(true);
    await click("Review prepared verification");
    expect(reads).toEqual([
      {
        operation: "verification-job",
        projectId,
        taskId: "task-1",
        verificationJobId: "verification-1",
      },
    ]);
    expect(host.textContent).toContain(preview.sha256);
    expect(host.textContent).toContain("$(literal); *");
    expect(host.textContent).toContain("ffffffffffffffffffffffffffffffffffffffff");
    await click("Approve prepared verification");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "project-team.gate.respond",
      gateId: "verification-gate",
      expectedGateRevision: 2,
      expectedRevision: 10,
      expectedTaskRevision: 4,
      specRevision: 2,
      planRevision: 3,
      response: "approved",
    });
  });
  it("rejects a current pending gate even when its proposed plan is no longer available", async () => {
    team = Atom.make<AsyncResult.AsyncResult<unknown>>(
      AsyncResult.success({
        projectId,
        revision: 10,
        items: [...foundation().filter((row) => row.kind !== "plan-revision"), gate()],
      }),
    );
    fixture.foundationPage.mockReturnValue(team);
    await render();
    await click("Reject prepared verification");
    expect(reads).toEqual([]);
    expect(emitted[0]).toMatchObject({
      type: "project-team.gate.respond",
      response: "rejected",
      planRevision: 3,
    });
  });
  it("allows rejection without a preview or host read", async () => {
    await pendingGate();
    await click("Reject prepared verification");
    expect(reads).toEqual([]);
    expect(emitted[0]).toMatchObject({ type: "project-team.gate.respond", response: "rejected" });
  });
  it.each([
    "project-work",
    "guided-writes",
    "disconnected",
    "disabled-entry",
    "foreign-project",
    "blurred",
  ])(
    "denies old mounted proposal and preview callbacks after %s changes before React commits",
    async (change) => {
      await render();
      await prepare();
      const propose = fixture.callbacks.get("Propose verification")!;
      await act(async () =>
        registry.set(
          team,
          AsyncResult.success({ projectId, revision: 10, items: [...foundation(), gate()] }),
        ),
      );
      await render();
      const review = fixture.callbacks.get("Review prepared verification")!;
      await act(async () => {
        if (change === "foreign-project")
          registry.set(project, {
            id: ProjectId.make("foreign"),
            environmentId,
          });
        else if (change === "blurred") fixture.focused = false;
        else
          registry.set(presentation, {
            entry: { enabled: change !== "disabled-entry" },
            connection: { phase: change === "disconnected" ? "disconnected" : "connected" },
            serverConfig: {
              settings: { projectWorkEnabled: change !== "project-work" },
              environment: {
                capabilities: {
                  projectTeamFoundationReads: true,
                  projectTeamGuidedWrites: change !== "guided-writes",
                },
              },
            },
          });
        propose();
        review();
      });
      expect(emitted).toEqual([]);
      expect(reads).toEqual([]);
    },
  );
  it("denies approval when settings are revoked before the current mounted callback runs", async () => {
    await pendingGate();
    await click("Review prepared verification");
    const approve = fixture.callbacks.get("Approve prepared verification")!;
    await act(async () => {
      registry.set(presentation, {
        entry: { enabled: true },
        connection: { phase: "connected" },
        serverConfig: { ...config(), settings: { projectWorkEnabled: false } },
      });
      approve();
    });
    expect(emitted).toEqual([]);
  });
  it("does not publish a held preview after access is revoked", async () => {
    await pendingGate();
    previewAtom = Atom.make<AsyncResult.AsyncResult<unknown>>(AsyncResult.initial());
    act(() => button("Review prepared verification").click());
    expect(reads).toHaveLength(1);
    await act(async () => {
      registry.set(presentation, {
        entry: { enabled: true },
        connection: { phase: "disconnected" },
        serverConfig: config(),
      });
      registry.set(previewAtom, AsyncResult.success(preview));
    });
    expect(button("Approve prepared verification").disabled).toBe(true);
    expect(host.textContent).not.toContain("Prepared manifest ");
    expect(emitted).toEqual([]);
  });
  it.each(["hash", "foreign-owner", "criteria", "binding", "plan", "command-mutation"])(
    "refuses unusable %s previews while rejection remains available",
    async (change) => {
      const altered = structuredClone(preview);
      if (change === "hash") altered.sha256 = "0".repeat(64);
      if (change === "foreign-owner") altered.manifest.environmentId = "foreign";
      if (change === "criteria") altered.manifest.criteria[0]!.revision = 4;
      if (change === "binding") altered.manifest.generation = 8;
      if (change === "plan") altered.manifest.planHash = "0".repeat(64);
      if (change === "command-mutation") altered.manifest.command.argv.push("unreviewed");
      if (["criteria", "binding", "plan"].includes(change))
        altered.sha256 = NodeCrypto.createHash("sha256")
          .update(canonicalProjectWorkPayload(altered.manifest))
          .digest("hex");
      const changedGate = { ...gate(), contentHash: altered.sha256 };
      team = Atom.make<AsyncResult.AsyncResult<unknown>>(
        AsyncResult.success({ projectId, revision: 10, items: [...foundation(), changedGate] }),
      );
      fixture.foundationPage.mockReturnValue(team);
      previewAtom = Atom.make<AsyncResult.AsyncResult<unknown>>(AsyncResult.success(altered));
      await render();
      await click("Review prepared verification");
      expect(button("Approve prepared verification").disabled).toBe(true);
      await click("Reject prepared verification");
      expect(emitted[0]).toMatchObject({ response: "rejected" });
    },
  );
  it("requires another review when the current criterion changes after a valid preview", async () => {
    await pendingGate();
    await click("Review prepared verification");
    const approve = fixture.callbacks.get("Approve prepared verification")!;
    await act(async () => {
      registry.set(
        task,
        AsyncResult.success({
          ...current,
          criteria: current.criteria.map((c) => ({ ...c, revision: c.revision + 1 })),
        }),
      );
      approve();
    });
    expect(emitted).toEqual([]);
  });
  it("retains and retries the exact lost proposal across owning-screen route visits without resubmitting automatically", async () => {
    fixture.command.mockImplementation(async ({ environmentId: owner, input }) => {
      expect(owner).toBe(environmentId);
      emitted.push(decodeWrite(input));
      return AsyncResult.failure(Cause.fail(Error("lost response")));
    });
    await render();
    await prepare();
    await click("Propose verification");
    const original = structuredClone(emitted[0]);
    expect(button("Retry exact verification request").disabled).toBe(false);
    await render("other-task");
    expect(host.textContent).not.toContain("Retry exact verification request");
    expect(emitted).toHaveLength(1);
    await render();
    expect(emitted).toHaveLength(1);
    await click("Retry exact verification request");
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual(original);
  });
  it("retains an uncertain approval across visits but requires reloading the exact current preview before retry", async () => {
    await pendingGate();
    await click("Review prepared verification");
    fixture.command.mockImplementation(async ({ input }) => {
      emitted.push(decodeWrite(input));
      return AsyncResult.failure(Cause.fail(Error("lost response")));
    });
    await click("Approve prepared verification");
    const original = structuredClone(emitted[0]);
    await render("other-task");
    await render();
    await click("Retry exact verification request");
    expect(emitted).toHaveLength(1);
    await click("Review prepared verification");
    await click("Retry exact verification request");
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual(original);
  });
  it("fences a lost proposal retry after binding revision changes", async () => {
    fixture.command.mockImplementation(async ({ input }) => {
      emitted.push(decodeWrite(input));
      return AsyncResult.failure(Cause.fail(Error("lost")));
    });
    await render();
    await prepare();
    await click("Propose verification");
    await act(async () =>
      registry.set(
        team,
        AsyncResult.success({
          projectId,
          revision: 10,
          items: foundation().map((row) =>
            row.kind === "run-binding" ? { ...row, revision: 2 } : row,
          ),
        }),
      ),
    );
    await render();
    await click("Retry exact verification request");
    expect(emitted).toHaveLength(1);
    expect(host.textContent).toContain("Verification target changed");
  });
  it("keeps late original acknowledgements uncertain when access is revoked and never retargets another task", async () => {
    const held = Promise.withResolvers<ReturnType<typeof AsyncResult.success>>();
    fixture.command.mockImplementation(({ input }) => {
      emitted.push(decodeWrite(input));
      return held.promise;
    });
    await render();
    await prepare();
    await click("Propose verification");
    await render("other-task");
    await act(async () => {
      registry.set(presentation, {
        entry: { enabled: true },
        connection: { phase: "disconnected" },
        serverConfig: config(),
      });
      held.resolve(AsyncResult.success({ projectId, revision: 11 }));
    });
    expect(emitted).toHaveLength(1);
    expect(host.textContent).not.toContain("Response recorded");
    await act(async () =>
      registry.set(presentation, {
        entry: { enabled: true },
        connection: { phase: "connected" },
        serverConfig: config(),
      }),
    );
    await render();
    expect(host.textContent).toContain("Access changed");
    expect(button("Retry exact verification request").disabled).toBe(false);
  });
  it("completes proposal, refreshed exact prepared preview and approval without claiming execution", async () => {
    await render();
    await prepare();
    await click("Propose verification");
    const proposed = emitted[0];
    if (proposed?.type !== "project-team.verification.propose") throw Error("Missing proposal");
    const prepared = structuredClone(preview);
    prepared.manifest.jobId = proposed.jobId;
    prepared.manifest.command = { ...proposed.command, argv: [...proposed.command.argv] };
    prepared.manifest.executable.target = proposed.command.executable;
    prepared.sha256 = NodeCrypto.createHash("sha256")
      .update(canonicalProjectWorkPayload(prepared.manifest))
      .digest("hex");
    previewAtom = Atom.make<AsyncResult.AsyncResult<unknown>>(AsyncResult.success(prepared));
    current = decodeContext({ ...current, revision: 11 });
    fixture.query = { ...fixture.query, data: current };
    task = Atom.make<AsyncResult.AsyncResult<unknown>>(AsyncResult.success(current));
    fixture.taskContext.mockReturnValue(task);
    await act(async () => {
      registry.set(task, AsyncResult.success(current));
      registry.set(
        team,
        AsyncResult.success({
          projectId,
          revision: 11,
          items: [
            ...foundation(),
            { ...gate(), verificationJobId: proposed.jobId, contentHash: prepared.sha256 },
          ],
        }),
      );
    });
    await render();
    await click("Review prepared verification");
    expect(reads[0]).toMatchObject({ verificationJobId: proposed.jobId });
    await click("Approve prepared verification");
    expect(emitted[1]).toMatchObject({
      type: "project-team.gate.respond",
      expectedRevision: 11,
      response: "approved",
    });
    await act(async () =>
      registry.set(
        team,
        AsyncResult.success({
          projectId,
          revision: 11,
          items: [
            ...foundation(),
            {
              ...gate("approved"),
              verificationJobId: proposed.jobId,
              contentHash: prepared.sha256,
            },
          ],
        }),
      ),
    );
    await render();
    expect(host.textContent).toContain("approved");
    expect(host.textContent).not.toContain("Verification passed");
    expect(emitted).toHaveLength(2);
  });
  it("denies a stale task revision before the rendered proposal callback can submit", async () => {
    await render();
    await prepare();
    const propose = fixture.callbacks.get("Propose verification")!;
    await act(async () => {
      registry.set(
        task,
        AsyncResult.success({ ...current, task: { ...current.task, revision: 5 } }),
      );
      propose();
    });
    expect(emitted).toEqual([]);
  });
  it("discards a held preview callback when the owning task route changes", async () => {
    await pendingGate();
    previewAtom = Atom.make<AsyncResult.AsyncResult<unknown>>(AsyncResult.initial());
    act(() => button("Review prepared verification").click());
    await render("other-task");
    await act(async () => registry.set(previewAtom, AsyncResult.success(preview)));
    expect(host.textContent).not.toContain("Prepared manifest");
    expect(emitted).toEqual([]);
    await render();
    expect(button("Approve prepared verification").disabled).toBe(true);
  });
  it("keeps human authorization failures definitive instead of offering an unsafe retry", async () => {
    fixture.command.mockImplementation(async ({ input }) => {
      emitted.push(decodeWrite(input));
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: "orchestration:operate",
            message: "Human session revoked",
          }),
        ),
      );
    });
    await render();
    await prepare();
    await click("Propose verification");
    expect(emitted).toHaveLength(1);
    expect(host.textContent).not.toContain("Retry exact verification request");
  });
  it("proposes exact current implementation, ordered literal arguments and criterion coverage through the typed task API", async () => {
    await render();
    await prepare();
    await click("Propose verification");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
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
        argv: ["", "  preserved  ", "$(literal); *", "line\nbreak"],
        environment: "clean",
        limits: { maxDurationMs: 120000, maxOutputBytes: 65536 },
      },
    });
    expect(host.textContent).not.toContain("Verification passed");
    expect(reads).toEqual([]);
  });
});
