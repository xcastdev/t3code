/* @vitest-environment happy-dom */
import * as NodeCrypto from "node:crypto";
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ProjectTeamRecordRead,
  ProjectWorkTaskContext,
  ProjectWorkWriteIntent,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, input: string) =>
    NodeCrypto.createHash("sha256").update(input).digest("hex"),
}));

const fixture = vi.hoisted(() => ({
  registry: undefined as unknown,
  foundationPage: vi.fn(),
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
  useIsFocused: () => true,
  useNavigation: () => ({
    navigate: fixture.navigate,
    goBack: vi.fn(),
    isFocused: () => true,
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
    page: fixture.page,
    taskContext: fixture.taskContext,
  },
}));

import { ProjectWorkScreen, WorkTaskScreen } from "./WorkScreens";
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
      threadId: "worker-thread",
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

function member(revision = 7) {
  return decodeRecord({
    projectId,
    revision,
    generation: 0,
    updatedAt: at,
    recordId: "successor",
    kind: "member",
    status: "active",
    name: "Next worker",
    coordinator: true,
    roleRevisionId: "any-role",
  });
}
function membership(controlState = "active", requested?: string) {
  return decodeRecord({
    projectId,
    revision: 1,
    generation: 0,
    updatedAt: at,
    recordId: "membership",
    kind: "task-membership",
    status: "active",
    taskId: "task-1",
    executionKind: "managed",
    deliverableKind: "code",
    controlState,
    ...(requested ? { requestedSuccessorMemberId: requested } : {}),
  });
}
let root: Root;
let host: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
let foundation: ReturnType<typeof Atom.make<AsyncResult.AsyncResult<unknown>>>;
let task: ReturnType<typeof Atom.make<AsyncResult.AsyncResult<unknown>>>;
let presentation: ReturnType<typeof Atom.make<unknown>>;
let emitted: ProjectWorkWriteIntent[];
let current = context();
let records: ProjectTeamRecordRead[];
const config = () => ({
  settings: { projectWorkEnabled: fixture.enabled },
  environment: {
    capabilities: {
      projectTeamFoundationReads: fixture.supported,
      projectTeamGuidedWrites: fixture.supported,
    },
  },
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.connected = fixture.enabled = fixture.supported = fixture.available = true;
  fixture.callbacks.clear();
  fixture.sequence = 0;
  fixture.command.mockReset();
  emitted = [];
  current = context();
  records = [membership(), member()];
  registry = AtomRegistry.make();
  fixture.registry = registry;
  foundation = Atom.make<AsyncResult.AsyncResult<unknown>>(
    AsyncResult.success({ projectId, revision: 10, items: records }),
  );
  task = Atom.make<AsyncResult.AsyncResult<unknown>>(AsyncResult.success(current));
  fixture.contextAtom = task;
  registry.mount(task);
  presentation = Atom.make<unknown>({
    entry: { enabled: true },
    connection: { phase: "connected" },
    serverConfig: config(),
  });
  fixture.presentationAtom = presentation;
  fixture.projectAtom = Atom.make({ id: projectId, environmentId });
  fixture.foundationPage.mockImplementation(() => foundation);
  fixture.taskContext.mockImplementation(() => task);
  fixture.query = { data: current, error: null, isPending: false, refresh: vi.fn() };
  fixture.command.mockImplementation(
    async ({
      environmentId: owner,
      input,
    }: {
      environmentId: EnvironmentId;
      input: ProjectWorkWriteIntent;
    }) => {
      expect(owner).toBe(environmentId);
      emitted.push(decodeWrite(input));
      return { _tag: "Success" };
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  registry.dispose();
  vi.unstubAllGlobals();
});
async function render(owner: string = environmentId, project: string = projectId) {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <WorkTaskScreen
          route={{ params: { environmentId: owner, projectId: project, taskId: "task-1" } }}
        />
      </RegistryContext.Provider>,
    ),
  );
}
function button(label: string) {
  const entry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
  if (!entry) throw Error("Missing button " + label);
  return entry;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill(label: string, text: string) {
  const field = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
  if (!field) throw Error("Missing input " + label);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
  await act(async () => field.dispatchEvent(new Event("input", { bubbles: true })));
}
async function selectWaiverCriterion() {
  const label = "Select criterion: Retain the conversation";
  expect(button(label).disabled).toBe(false);
  const press = fixture.callbacks.get(label);
  expect(press).toBeDefined();
  await act(async () => await press?.());
}
async function snapshot(items = records, revision = current.revision) {
  records = items;
  if (host.childElementCount === 0)
    foundation = Atom.make<AsyncResult.AsyncResult<unknown>>(
      AsyncResult.success({ projectId, revision, items }),
    );
  else
    await act(async () =>
      registry.set(foundation, AsyncResult.success({ projectId, revision, items })),
    );
}

describe("mounted task lifecycle", () => {
  it("waives a selected criterion through the actual mobile task action session", async () => {
    await render();
    await selectWaiverCriterion();
    await fill("Waiver reason", "Accept this documented mobile exception");
    await click("Waive selected criterion");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "project-team.criterion.waiver",
      projectId,
      taskId: "task-1",
      expectedRevision: 10,
      expectedTaskRevision: 4,
      criterionId: "criterion-1",
      expectedCriterionRevision: 3,
      expectedSpecRevision: 2,
      action: { kind: "waive", reason: "Accept this documented mobile exception", evidenceIds: [] },
    });
    expect(host.textContent).toContain("Approvals must be renewed");
    expect(button("Waive selected criterion").disabled).toBe(true);
  });

  it("revokes only the selected recorded waiver through the mobile screen", async () => {
    current = decodeContext({
      ...current,
      criteria: current.criteria.map((criterion) => ({
        ...criterion,
        status: "waived",
        waiver: {
          reason: "Original exception",
          evidenceIds: [],
          specRevision: 2,
          waivedAt: at,
          attribution: { actor: { kind: "human" }, source: { kind: "mobile" }, recordedAt: at },
        },
      })),
    });
    fixture.query.data = current;
    registry.set(task, AsyncResult.success(current));
    await render();
    await selectWaiverCriterion();
    await click("Revoke selected waiver");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "project-team.criterion.waiver",
      criterionId: "criterion-1",
      action: { kind: "revoke" },
    });
  });

  it("retries the original mobile waiver after lost response and changed criterion history", async () => {
    fixture.command.mockImplementationOnce(async ({ input }: { input: ProjectWorkWriteIntent }) => {
      emitted.push(decodeWrite(input));
      throw Error("Lost waiver response");
    });
    await render();
    await selectWaiverCriterion();
    await fill("Waiver reason", "Keep the original exception");
    await click("Waive selected criterion");
    const original = emitted[0];
    expect(original).toBeDefined();
    current = decodeContext({
      ...current,
      revision: 11,
      criteria: current.criteria.map((criterion) => ({
        ...criterion,
        revision: criterion.revision + 1,
      })),
    });
    fixture.query.data = current;
    registry.set(task, AsyncResult.success(current));
    await snapshot([membership("paused"), member()], 11);
    await render();
    await click("Retry exact command");
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual(original);
    expect(fixture.sequence).toBe(1);
  });

  it.each(["owner", "disconnect", "criterion", "cancel"] as const)(
    "withholds a mobile waiver after %s changes",
    async (change) => {
      await render();
      await selectWaiverCriterion();
      await fill("Waiver reason", "Review this definition first");
      const held = fixture.callbacks.get("Waive selected criterion");
      if (change === "owner") await render("environment-2");
      if (change === "disconnect") {
        fixture.connected = false;
        registry.mount(presentation);
        await act(async () =>
          registry.set(presentation, {
            entry: { enabled: true },
            connection: { phase: "disconnected" },
            serverConfig: config(),
          }),
        );
        await render();
      }
      if (change === "criterion") {
        current = decodeContext({
          ...current,
          criteria: current.criteria.map((criterion) => ({
            ...criterion,
            revision: criterion.revision + 1,
          })),
        });
        fixture.query.data = current;
        registry.set(task, AsyncResult.success(current));
        await render();
      }
      if (change === "cancel") await click("Cancel waiver change");
      if (change === "disconnect")
        expect(registry.get(presentation)).toMatchObject({ connection: { phase: "disconnected" } });
      await act(async () => held?.());
      expect(emitted).toEqual([]);
    },
  );

  it("directs a protected mobile specification to the approved revision process", async () => {
    current = decodeContext({
      ...current,
      task: { ...current.task, specification: { ...current.task.specification, protected: true } },
    });
    fixture.query.data = current;
    registry.set(task, AsyncResult.success(current));
    await render();
    expect(host.textContent).toContain("approved specification revision process");
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent === "Select criterion: Retain the conversation",
      ),
    ).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("requests the selected successor revision through the actual task screen", async () => {
    await render();
    await click("Select recipient Next worker · successor · revision 7");
    await fill("Task control reason", "Continue with the available teammate");
    await click("Request reassignment");
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
  it.each([
    "revision",
    "missing",
    "inactive",
    "duplicate",
    "incomplete",
    "disconnected",
    "foreign",
  ])("withholds a new reassignment after %s changes", async (change) => {
    await render();
    await click("Select recipient Next worker · successor · revision 7");
    await fill("Task control reason", "Review changed work");
    const retained = fixture.callbacks.get("Request reassignment");
    expect(retained).toBeDefined();
    if (change === "revision") await snapshot([membership(), member(8)]);
    if (change === "missing") await snapshot([membership()]);
    if (change === "inactive")
      await snapshot([membership(), decodeRecord({ ...member(), status: "paused" })]);
    if (change === "duplicate") await snapshot([...records, member()]);
    if (change === "incomplete")
      await act(async () => registry.set(foundation, AsyncResult.initial()));
    if (change === "disconnected") {
      fixture.connected = false;
      registry.set(presentation, {
        entry: { enabled: true },
        connection: { phase: "disconnected" },
        serverConfig: config(),
      });
    }
    if (change === "foreign")
      registry.set(
        task,
        AsyncResult.success(
          decodeContext({
            ...current,
            projectId: "foreign",
            task: { ...current.task, projectId: "foreign" },
          }),
        ),
      );
    await act(async () => retained?.());
    expect(emitted).toEqual([]);
    if (change === "revision") {
      expect(host.textContent).toContain("reviewed revision 7");
      await click("Select recipient Next worker · successor · revision 8");
      await click("Request reassignment");
      expect(emitted[0]).toMatchObject({ control: { expectedMemberRevision: 8 } });
    }
  });
  it.each(["paused", "deferred"])(
    "shows recorded %s ownership and permits a separate Resume request",
    async (stopped) => {
      await snapshot([membership(stopped, "successor"), member()]);
      await render();
      expect(host.textContent).toContain(`Recorded control state: ${stopped}`);
      expect(host.textContent).toContain("Requested successor: Next worker · successor");
      expect(button("Start investigation").disabled).toBe(true);
      expect(host.textContent).not.toContain("Approve specification");
      await fill("Task control reason", "Resume after ownership review");
      expect(button("Resume task").disabled).toBe(false);
      await click("Resume task");
      expect(emitted[0]).toMatchObject({
        type: "project-team.task.control",
        control: { action: "resume", reason: "Resume after ownership review" },
      });
      expect(emitted.some((intent) => intent.type === "project-team.execution.start")).toBe(false);
    },
  );
  it("withholds Resume until the requested successor can be resolved uniquely", async () => {
    await snapshot([membership("paused", "missing-member")]);
    await render();
    await fill("Task control reason", "Resume reviewed work");
    expect(host.textContent).toContain("Requested successor: missing-member");
    expect(button("Resume task").disabled).toBe(true);
    await act(async () => fixture.callbacks.get("Resume task")?.());
    expect(emitted).toEqual([]);
  });
  it("replays the exact lost-response envelope after recorded reassignment pauses work", async () => {
    fixture.command.mockImplementationOnce(async ({ input }: { input: ProjectWorkWriteIntent }) => {
      emitted.push(decodeWrite(input));
      throw Error("lost response");
    });
    await render();
    await click("Select recipient Next worker · successor · revision 7");
    await fill("Task control reason", "Preserve retained ownership");
    await click("Request reassignment");
    const original = emitted[0];
    expect(original).toBeDefined();
    current = decodeContext({ ...current, revision: 11, task: { ...current.task, revision: 5 } });
    fixture.query.data = current;
    registry.set(task, AsyncResult.success(current));
    await snapshot([membership("paused", "successor"), member(8)], 11);
    await render();
    expect(button("Retry exact command").disabled).toBe(false);
    expect(button("Request reassignment").disabled).toBe(true);
    await click("Retry exact command");
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual(original);
    expect(fixture.sequence).toBe(1);
  });
  it("denies held old-owner actions after a route switch", async () => {
    await render();
    await click("Select recipient Next worker · successor · revision 7");
    await fill("Task control reason", "Review scope");
    const held = fixture.callbacks.get("Request reassignment");
    expect(held).toBeDefined();
    await render("environment-2");
    await act(async () => held?.());
    expect(emitted).toEqual([]);
    expect(host.textContent).not.toContain("Selected recipient successor");
  });
  it("keeps the reason after the server refuses Resume without claiming execution", async () => {
    await snapshot([membership("paused", "successor"), member()]);
    fixture.command.mockImplementationOnce(async () => {
      throw {
        _tag: "ProjectTeamAuthorizationError",
        reason: "Assignment grant is no longer current",
      };
    });
    await render();
    await fill("Task control reason", "Resume exact reviewed work");
    await click("Resume task");
    expect(host.textContent).toContain("The server denied this action");
    expect(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task control reason"]')?.value,
    ).toBe("Resume exact reviewed work");
    expect(emitted).toEqual([]);
    expect(host.textContent).not.toContain("Execution enabled");
  });

  it("keeps the original settled worker history beside requested successor state", async () => {
    await snapshot([
      membership("paused", "successor"),
      member(),
      ...workerRecords({ status: "settled" }),
    ]);
    await render();
    expect(host.textContent).toContain("Requested successor: Next worker · successor");
    expect(host.textContent).toContain("frozen-model · settled");
    await click("Open worker thread worker-thread");
    expect(fixture.dispatch).toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });
  it.each(["writer", "attempt", "failure", "repair", "inactive", "duplicate"])(
    "withholds Resume for unresolved %s",
    async (caseName) => {
      let items = [membership("paused", "successor"), member()];
      if (caseName === "writer") items = [...items, ...workerRecords()];
      if (caseName === "attempt") {
        current = decodeContext({
          ...current,
          reclaimableAttempt: {
            attemptId: "undrained",
            taskId: "task-1",
            state: "failed",
            revision: 1,
            checkpointIds: [],
          },
        });
        fixture.query.data = current;
        registry.set(task, AsyncResult.success(current));
      }
      if (caseName === "failure") {
        current = decodeContext({ ...current, task: { ...current.task, state: "failed" } });
        fixture.query.data = current;
        registry.set(task, AsyncResult.success(current));
      }
      if (caseName === "repair")
        items.push(
          decodeRecord({
            projectId,
            recordId: "repair",
            kind: "repair-episode",
            status: "exhausted",
            taskId: "task-1",
            revision: 1,
            generation: 0,
            updatedAt: at,
            failureFingerprint: "failure",
            relevantRevision: "r1",
            allowance: 2,
            semanticRepairs: 2,
            transportRetries: 0,
            timeoutCount: 0,
            attemptIds: [],
          }),
        );
      if (caseName === "inactive")
        items = [
          membership("paused", "successor"),
          decodeRecord({ ...member(), status: "retired" }),
        ];
      if (caseName === "duplicate") items.push(member());
      await snapshot(items);
      await render();
      await fill("Task control reason", "Resume after exact review");
      expect(button("Resume task").disabled).toBe(true);
      await act(async () => fixture.callbacks.get("Resume task")?.());
      expect(emitted).toEqual([]);
    },
  );
  it.each(["disabled", "capability", "wrong-project"])(
    "denies a held new action after %s is revoked",
    async (caseName) => {
      await render();
      await click("Select recipient Next worker · successor · revision 7");
      await fill("Task control reason", "Review access");
      const held = fixture.callbacks.get("Request reassignment");
      if (caseName === "wrong-project")
        fixture.projectAtom = Atom.make({ id: ProjectId.make("foreign"), environmentId });
      else {
        const config = {
          settings: { projectWorkEnabled: caseName !== "disabled" },
          environment: {
            capabilities: {
              projectTeamFoundationReads: true,
              projectTeamGuidedWrites: caseName !== "capability",
            },
          },
        };
        registry.set(presentation, {
          entry: { enabled: true },
          connection: { phase: "connected" },
          serverConfig: config,
        });
      }
      await act(async () => held?.());
      expect(emitted).toEqual([]);
    },
  );
  it("bounds member choices and resets selection and paging on an owner switch", async () => {
    await snapshot([
      membership(),
      ...Array.from({ length: 11 }, (_, index) =>
        decodeRecord({ ...member(), recordId: `member-${index}`, name: `Worker-${index}` }),
      ),
    ]);
    await render();
    expect(host.textContent).not.toContain("Select recipient Worker-10");
    await click("Next recipients");
    await click("Select recipient Worker-10 · member-10 · revision 7");
    expect(host.textContent).toContain("Selected recipient member-10");
    await render("environment-2");
    expect(host.textContent).not.toContain("Selected recipient member-10");
    expect(host.textContent).toContain("Select recipient Worker-0");
  });
});

it.each([false, true])(
  "mounted independent review sends the current human-approved specification and plan (refresh: %s)",
  async (refreshTarget) => {
    const hash = (value: unknown) =>
      NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
    const specHash = hash({
      specification: current.task.specification,
      criteria: current.criteria
        .map(({ criterionId, description, required, waiver }) => ({
          criterionId,
          description,
          required,
          waiver,
        }))
        .sort((a, b) =>
          a.criterionId < b.criterionId ? -1 : a.criterionId > b.criterionId ? 1 : 0,
        ),
    });
    const planHash = hash({ content: "Review exact work", dependencyTaskIds: [] });
    const fields = {
      projectId,
      taskId: current.task.taskId,
      revision: 1,
      generation: 0,
      updatedAt: at,
    };
    const attribution = { actor: { kind: "human" }, source: { kind: "mobile" }, recordedAt: at };
    await snapshot([
      membership(),
      decodeRecord({
        ...fields,
        recordId: "review-spec",
        kind: "gate",
        gate: "specification",
        status: "approved",
        specRevision: 2,
        planRevision: 0,
        contentHash: specHash,
        evidenceIds: [],
        attribution,
      }),
      decodeRecord({
        ...fields,
        recordId: "review-plan",
        kind: "plan-revision",
        status: "proposed",
        specRevision: 2,
        planRevision: 1,
        content: "Review exact work",
        contentHash: planHash,
        dependencyTaskIds: [],
      }),
      decodeRecord({
        ...fields,
        recordId: "review-plan-gate",
        kind: "gate",
        gate: "plan",
        status: "approved",
        specRevision: 2,
        planRevision: 1,
        contentHash: planHash,
        evidenceIds: [],
        attribution,
      }),
    ]);
    await render();
    expect(button("Start independent review").disabled).toBe(false);
    await fill("Review objective", "Inspect approved code and evidence");
    await fill("Expected review findings, one per line", "Findings");
    if (refreshTarget) {
      await snapshot(
        records.map((record) =>
          record.kind === "plan-revision" ? decodeRecord({ ...record, revision: 2 }) : record,
        ),
      );
      await click("Start independent review");
      expect(emitted).toHaveLength(0);
      expect(button("Review refreshed work").disabled).toBe(false);
      expect(
        host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review objective"]')?.value,
      ).toBe("Inspect approved code and evidence");
      await click("Review refreshed work");
    }
    await click("Start independent review");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "project-team.assignment.start",
      assignmentKind: "review",
      objective: "Inspect approved code and evidence",
      specificationGateId: "review-spec",
      parentPlan: {
        recordId: "review-plan",
        gateId: "review-plan-gate",
        planRevision: 1,
        expectedRecordRevision: refreshTarget ? 2 : 1,
      },
    });
    expect(button("Start independent review").disabled).toBe(true);
  },
);
it("mounted independent review withholds the action without approved parent targets", async () => {
  await render();
  expect(button("Start independent review").disabled).toBe(true);
  await click("Start independent review");
  expect(emitted).toHaveLength(0);
});

it.each(["Pause task", "Cancel task"])("sends %s from the actual task screen", async (label) => {
  await render();
  await fill("Task control reason", "Stop this work for review");
  await click(label);
  expect(emitted[0]).toMatchObject({
    type: "project-team.task.control",
    expectedRevision: 10,
    expectedTaskRevision: 4,
    control: {
      action: label === "Pause task" ? "pause" : "cancel",
      reason: "Stop this work for review",
    },
  });
  expect(button(label).disabled).toBe(true);
});

it("reopens terminal work and blocks a held reopen after a worker becomes active", async () => {
  current = decodeContext({ ...current, task: { ...current.task, state: "canceled" } });
  fixture.query.data = current;
  registry.set(task, AsyncResult.success(current));
  await render();
  await fill("Task control reason", "Return this task to review");
  expect(button("Reopen task").disabled).toBe(false);
  const held = fixture.callbacks.get("Reopen task");
  expect(held).toBeDefined();
  await snapshot([...records, ...workerRecords()]);
  await act(async () => held?.());
  expect(emitted).toEqual([]);
  await snapshot(
    records.filter((record) => record.kind !== "run-binding" && record.kind !== "role-revision"),
  );
  await click("Reopen task");
  expect(emitted[0]).toMatchObject({
    type: "project-team.task.control",
    control: { action: "reopen", reason: "Return this task to review" },
  });
});

it("creates a project-scoped draft and retains an exact uncertain request across disconnect", async () => {
  let first = true;
  fixture.command.mockImplementation(async ({ input }: { input: ProjectWorkWriteIntent }) => {
    emitted.push(decodeWrite(input));
    if (first) {
      first = false;
      throw Error("response lost");
    }
    return { _tag: "Success" };
  });
  const show = async () =>
    act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ProjectWorkScreen route={{ params: { environmentId, projectId } }} />
        </RegistryContext.Provider>,
      ),
    );
  await show();
  await fill("Requested task title", "Review remote supervision");
  await click("Create draft task");
  expect(emitted[0]).toMatchObject({
    type: "project-work.task.create",
    projectId,
    expectedRevision: 10,
    title: "Review remote supervision",
  });
  expect(emitted[0]).not.toHaveProperty("attribution");
  await click("Show evidence");
  expect(button("Retry exact work request").disabled).toBe(false);
  await click("Show project work");
  fixture.connected = false;
  registry.set(presentation, {
    entry: { enabled: true },
    connection: { phase: "disconnected" },
    serverConfig: config(),
  });
  await show();
  await act(async () => fixture.callbacks.get("Retry exact work request")?.());
  expect(emitted).toHaveLength(1);
  fixture.connected = true;
  registry.set(presentation, {
    entry: { enabled: true },
    connection: { phase: "connected" },
    serverConfig: config(),
  });
  await show();
  await click("Retry exact work request");
  expect(emitted).toHaveLength(2);
  expect(emitted[1]).toEqual(emitted[0]);
  expect(host.textContent).toContain("Draft task recorded");
});
