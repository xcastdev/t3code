/* @vitest-environment happy-dom */
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ProjectTeamRecord,
  ProjectWorkTask,
  ProjectWorkAttentionRead,
  ProjectWorkReadIntent,
  ProjectWorkWriteIntent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  registry: undefined as unknown,
  foundationPage: vi.fn(),
  page: vi.fn(),
  taskContext: vi.fn(),
  dispatch: vi.fn(),
  writesSupported: true,
  focused: true,
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
      const text = Array.isArray(label) ? label.join("") : label;
      if (typeof text === "string") fixture.callbacks.set(text, onPress);
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
  useProject: ({ projectId, environmentId }: { projectId: string; environmentId: string }) =>
    fixture.available ? { id: projectId, environmentId, title: projectId } : null,
  useProjects: () => [],
  useEnvironmentServerConfig: () => ({
    settings: { projectWorkEnabled: fixture.enabled },
    environment: {
      capabilities: {
        projectTeamFoundationReads: fixture.supported,
        projectTeamGuidedWrites: fixture.writesSupported,
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
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixture.command }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => `fixture-command-${fixture.sequence++}` }));
vi.mock("./workEnvironment", () => ({
  mobileWorkEnvironment: {
    foundationPage: fixture.foundationPage,
    page: fixture.page,
    taskContext: fixture.taskContext,
    pageSize: 50,
    pageRequestSize: 51,
  },
}));

import { ProjectWorkScreen } from "./WorkScreens";
import { projectWorkPageInput } from "@t3tools/client-runtime/project-work";
import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  emptyProjectWorkReducerState,
} from "../../../../server/src/projectWork/ProjectWorkDecider";
const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const at = "2026-10-01T10:00:00.000Z";
const decodeTask = Schema.decodeUnknownSync(ProjectWorkTask);
const decodeTeam = Schema.decodeUnknownSync(Schema.Array(ProjectTeamRecord));
const decodeAttention = Schema.decodeUnknownSync(ProjectWorkAttentionRead);
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const decodeRead = Schema.decodeUnknownSync(ProjectWorkReadIntent);
const notice = (taskId = "attention-task", overrides: Record<string, unknown> = {}) =>
  decodeAttention({
    taskId,
    reason: "failed",
    detail: "Retained failure needs review",
    revision: 3,
    ...overrides,
  });
const envelope = (items: ReadonlyArray<unknown> = [notice()], offset = 0, revision = 10) => ({
  projectId,
  revision,
  offset,
  limit: 51,
  hasMore: items.length > 50,
  items,
});
let root: Root;
let host: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
const makePages = (values: Map<string, unknown>) =>
  Atom.family((pageKey: string) =>
    Atom.make<AsyncResult.AsyncResult<unknown>>(
      AsyncResult.success(values.get(pageKey) ?? envelope([], 0)),
    ),
  );
let pages: ReturnType<typeof makePages>;
let presentation: ReturnType<typeof Atom.make<unknown>>;
let ownProject: ReturnType<typeof Atom.make<{ id: ProjectId; environmentId: EnvironmentId }>>;
let emitted: ProjectWorkWriteIntent[];
let incoming: Map<string, unknown>;
const key = (owner: string = environmentId, project: string = projectId, offset = 0) =>
  JSON.stringify([owner, project, offset]);
const config = () => ({
  settings: { projectWorkEnabled: fixture.enabled },
  environment: {
    capabilities: {
      projectTeamFoundationReads: fixture.supported,
      projectTeamGuidedWrites: fixture.writesSupported,
    },
  },
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.connected =
    fixture.enabled =
    fixture.supported =
    fixture.writesSupported =
    fixture.available =
    fixture.focused =
      true;
  fixture.callbacks.clear();
  fixture.sequence = 0;
  fixture.page.mockReset();
  fixture.command.mockReset();
  fixture.navigate.mockReset();
  emitted = [];
  registry = AtomRegistry.make();
  fixture.registry = registry;
  incoming = new Map([[key(), envelope()]]);
  pages = makePages(incoming);
  fixture.page.mockImplementation(
    (target: {
      environmentId: EnvironmentId;
      projectId: ProjectId;
      collection: "tasks" | "attention";
      offset: number;
      poll?: boolean;
    }) => {
      const input = decodeRead(projectWorkPageInput(target));
      if (input.operation === "attention")
        return pages(key(target.environmentId, target.projectId, target.offset));
      return Atom.make(
        AsyncResult.success({
          projectId: target.projectId,
          revision: 10,
          offset: target.offset,
          limit: 51,
          hasMore: false,
          items: [],
        }),
      );
    },
  );
  fixture.foundationPage.mockReturnValue(
    Atom.make(AsyncResult.success({ projectId, revision: 10, items: [] })),
  );
  presentation = Atom.make<unknown>({
    entry: { enabled: true },
    connection: { phase: "connected" },
    serverConfig: config(),
  });
  registry.mount(presentation);
  fixture.presentationAtom = presentation;
  ownProject = Atom.make({ id: projectId, environmentId });
  fixture.projectAtom = ownProject;
  registry.mount(ownProject);
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
        <ProjectWorkScreen route={{ params: { environmentId: owner, projectId: project } }} />
      </RegistryContext.Provider>,
    ),
  );
}
function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
  if (!found) throw Error("Missing button " + label);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function update(
  value: unknown,
  owner: string = environmentId,
  project: string = projectId,
  offset = 0,
) {
  await act(async () => {
    const atom = pages(key(owner, project, offset));
    registry.mount(atom);
    registry.set(atom, AsyncResult.success(value));
  });
}

describe("mobile task attention", () => {
  it("shows retained task attention in project Work and sends acknowledgment only", async () => {
    await render();
    expect(host.textContent).toContain("Task attention");
    expect(host.textContent).toContain("Retained failure needs review");
    await click("Open attention task attention-task");
    expect(fixture.navigate).toHaveBeenLastCalledWith("WorkTask", {
      environmentId,
      projectId,
      taskId: "attention-task",
    });
    await click("Review task attention attention-task");
    await click("Mark task attention seen");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "project-work.attention.seen",
      projectId,
      taskId: "attention-task",
      expectedRevision: 10,
    });
    expect(host.textContent).toContain("Resolution is unchanged");
  });
});

async function accessChange(change: () => void) {
  await act(async () => {
    change();
    registry.set(presentation, {
      entry: { enabled: fixture.available },
      connection: { phase: fixture.connected ? "connected" : "disconnected" },
      serverConfig: config(),
    });
  });
  await render();
}
function held(label: string) {
  const value = fixture.callbacks.get(label);
  if (!value) throw Error("Missing held callback " + label);
  return value;
}
async function call(callback: () => void) {
  await act(async () => callback());
}
function deferred() {
  let resolve!: (value: { _tag: "Success" }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ _tag: "Success" }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("mobile attention ownership and retained occurrences", () => {
  it("keeps seen unresolved occurrences visible and distinguishes resolved and unsupported reasons", async () => {
    await update(
      envelope([
        notice("seen", { seenAt: at }),
        notice("resolved", { resolvedAt: at }),
        notice("future", { reason: "future-reason" }),
      ]),
    );
    await render();
    expect(host.textContent).toContain("Seen " + at + " · unresolved");
    expect(host.textContent).toContain("unsupported attention reason");
    expect(host.textContent).not.toContain("resolved · failed");
    expect(host.textContent).not.toContain("Review task attention seen");
    expect(host.textContent).not.toContain("Review task attention future");
    await click("Show resolved attention");
    expect(host.textContent).toContain("Resolved " + at);
    await click("Hide resolved attention");
    expect(host.textContent).not.toContain("Resolved " + at);
    expect(emitted).toEqual([]);
  });
  it("reaches later bounded SQL pages when the visible first page is empty after filtering", async () => {
    await update(
      envelope(
        Array.from({ length: 51 }, (_, index) => notice(`resolved-${index}`, { resolvedAt: at })),
      ),
    );
    await update(envelope([notice("later")], 50), environmentId, projectId, 50);
    await render();
    expect(host.textContent).toContain("No unresolved task attention on this page.");
    await click("Next attention");
    expect(host.textContent).toContain("later · failed");
    const attentionTargets = fixture.page.mock.calls
      .map(([target]) => target)
      .filter((target) => target.collection === "attention");
    expect(
      attentionTargets.some(
        (target) =>
          JSON.stringify(decodeRead(projectWorkPageInput(target))) ===
          JSON.stringify({
            projectId,
            operation: "attention",
            limit: 51,
            offset: 50,
            envelope: true,
          }),
      ),
    ).toBe(true);
    await click("Previous attention");
    expect(host.textContent).toContain("Attention page 1");
    expect(emitted).toEqual([]);
  });
  it.each([
    ["foreign project", { ...envelope(), projectId: "project-other" }],
    ["foreign record project", envelope([{ ...notice(), projectId: "project-other" }])],
    ["foreign record environment", envelope([{ ...notice(), environmentId: "environment-other" }])],
    ["duplicate task", envelope([notice(), notice()])],
    ["malformed record", envelope([{ taskId: "attention-task", reason: "failed", revision: -1 }])],
    ["wrong offset", { ...envelope(), offset: 50 }],
    ["unbounded limit", { ...envelope(), limit: 500 }],
    ["too many rows", envelope(Array.from({ length: 52 }, (_, i) => notice(`task-${i}`)))],
    ["future record revision", envelope([notice("attention-task", { revision: 11 })])],
  ])("denies links and acknowledgments for %s", async (_name, value) => {
    await update(value);
    await render();
    expect(host.textContent).toContain("unsupported or ambiguous attention page");
    expect(host.textContent).not.toContain("Open attention task");
    expect(host.textContent).not.toContain("Review task attention");
    expect(emitted).toEqual([]);
  });
  it.each([
    ["occurrence", envelope([notice("attention-task", { revision: 4 })])],
    ["project revision", envelope([notice()], 0, 11)],
    ["removed occurrence", envelope([])],
    ["already seen", envelope([notice("attention-task", { seenAt: at })])],
    ["resolved", envelope([notice("attention-task", { resolvedAt: at })])],
  ])("captures occurrence and project revision and rejects a changed %s", async (_name, value) => {
    await render();
    await click("Review task attention attention-task");
    expect(host.textContent).toContain("occurrence revision 3 · project revision 10");
    const submit = held("Mark task attention seen");
    await update(value);
    await call(submit);
    expect(emitted).toEqual([]);
    expect(host.textContent).toContain("Task attention changed");
  });
  it.each([
    "connection",
    "feature",
    "read capability",
    "write capability",
    "focus",
    "project owner",
    "entry",
  ])("re-reads registry and fences a held submit after %s revocation", async (kind) => {
    await render();
    await click("Review task attention attention-task");
    const submit = held("Mark task attention seen");
    await act(async () => {
      if (kind === "project owner")
        registry.set(ownProject, { id: ProjectId.make("wrong-project"), environmentId });
      else if (kind === "focus") fixture.focused = false;
      else
        registry.set(presentation, {
          entry: { enabled: kind !== "entry" },
          connection: { phase: kind === "connection" ? "disconnected" : "connected" },
          serverConfig: {
            settings: { projectWorkEnabled: kind !== "feature" },
            environment: {
              capabilities: {
                projectTeamFoundationReads: kind !== "read capability",
                projectTeamGuidedWrites: kind !== "write capability",
              },
            },
          },
        });
      submit();
    });
    expect(emitted).toEqual([]);
  });
  it("retains exact uncertain retry through same-owner access interludes and changed recorded state", async () => {
    const requests: Array<{ environmentId: EnvironmentId; input: ProjectWorkWriteIntent }> = [];
    fixture.command.mockImplementation(
      async (request: { environmentId: EnvironmentId; input: ProjectWorkWriteIntent }) => {
        requests.push(request);
        if (requests.length === 1) throw Error("reply lost");
        return { _tag: "Success" };
      },
    );
    await render();
    await click("Review task attention attention-task");
    await click("Mark task attention seen");
    expect(host.textContent).toContain("outcome is unknown");
    const original = requests[0];
    await accessChange(() => {
      fixture.connected = fixture.enabled = fixture.supported = fixture.writesSupported = false;
    });
    expect(button("Retry task attention acknowledgment").disabled).toBe(true);
    await call(held("Retry task attention acknowledgment"));
    expect(requests).toHaveLength(1);
    await update(envelope([notice("attention-task", { revision: 4, seenAt: at })], 0, 11));
    await accessChange(() => {
      fixture.connected = fixture.enabled = fixture.supported = fixture.writesSupported = true;
    });
    await click("Retry task attention acknowledgment");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(original);
    expect(requests[1]?.input).toBe(original?.input);
    expect(host.textContent).toContain("Resolution is unchanged");
  });
  it("preserves an uncertain original command when a retry receives an explicit rejection", async () => {
    const requests: ProjectWorkWriteIntent[] = [];
    fixture.command.mockImplementation(async ({ input }: { input: ProjectWorkWriteIntent }) => {
      requests.push(input);
      throw requests.length === 1
        ? Error("reply lost")
        : { _tag: "ProjectWorkPolicyError", code: "stale-revision", message: "stale" };
    });
    await render();
    await click("Review task attention attention-task");
    await click("Mark task attention seen");
    await click("Retry task attention acknowledgment");
    expect(requests[1]).toBe(requests[0]);
    expect(host.textContent).toContain("outcome is unknown");
    expect(host.textContent).not.toContain("Cancel task attention review");
  });
  it("fences the old owner callbacks and late success after switching environment or project", async () => {
    const waiting = deferred();
    fixture.command.mockImplementation(() => waiting.promise);
    await render();
    await click("Review task attention attention-task");
    const submit = held("Mark task attention seen");
    const open = held("Open attention task attention-task");
    await click("Mark task attention seen");
    expect(fixture.command).toHaveBeenCalledTimes(1);
    await render("environment-other", "project-other");
    expect(host.textContent).not.toContain("Retained failure needs review");
    await call(open);
    await call(submit);
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.command).toHaveBeenCalledTimes(1);
    await act(async () => waiting.resolve({ _tag: "Success" }));
    expect(host.textContent).not.toContain("Resolution is unchanged");
    expect(host.textContent).not.toContain("Review attention-task");
  });
  it("keeps cached read age honest offline and routes retained task inspection without enabling acknowledgment", async () => {
    const recordedAt = Date.parse("2026-09-30T08:00:00.000Z");
    await act(async () => {
      registry.mount(pages(key()));
      registry.set(pages(key()), AsyncResult.success(envelope(), { timestamp: recordedAt }));
    });
    await render();
    await accessChange(() => {
      fixture.connected = false;
    });
    expect(host.textContent).toContain("Disconnected · cached task attention");
    expect(host.textContent).toContain(
      "Last recorded attention read: 2026-09-30T08:00:00.000Z · cached",
    );
    expect(button("Review task attention attention-task").disabled).toBe(true);
    await click("Open attention task attention-task");
    expect(fixture.navigate).toHaveBeenCalledWith("WorkTask", {
      environmentId,
      projectId,
      taskId: "attention-task",
    });
    expect(emitted).toEqual([]);
    expect(
      fixture.page.mock.calls.some(
        ([target]) => target.collection === "attention" && target.poll === false,
      ),
    ).toBe(true);
  });
  it("does not navigate a held task link when the same-owner page becomes foreign", async () => {
    await render();
    const open = held("Open attention task attention-task");
    await update({ ...envelope(), projectId: "project-other" });
    await call(open);
    expect(fixture.navigate).not.toHaveBeenCalled();
  });
  it("keeps the acknowledgment draft while inspecting other project Work views", async () => {
    fixture.command.mockRejectedValue(Error("reply lost"));
    await render();
    await click("Review task attention attention-task");
    await click("Mark task attention seen");
    await click("Show evidence");
    expect(host.textContent).toContain("Retry task attention acknowledgment");
    await click("Show project work");
    expect(host.textContent).toContain("Retry task attention acknowledgment");
    expect(fixture.command).toHaveBeenCalledTimes(1);
  });
  it("applies the submitted acknowledgment through the real decider and reducer without resolving or executing", async () => {
    await render();
    await click("Review task attention attention-task");
    await click("Mark task attention seen");
    const input = emitted[0];
    if (input?.type !== "project-work.attention.seen") throw Error("Expected acknowledgment");
    const task = decodeTask({
      taskId: "attention-task",
      projectId,
      title: "Failed guided task",
      state: "failed",
      watchers: [],
      revision: 3,
      specRevision: 2,
      createdAt: at,
      updatedAt: at,
    });
    const records = decodeTeam([
      {
        recordId: "membership",
        projectId,
        kind: "task-membership",
        revision: 1,
        generation: 0,
        updatedAt: at,
        status: "active",
        taskId: task.taskId,
        executionKind: "managed",
        deliverableKind: "code",
        controlState: "paused",
      },
      {
        recordId: "question",
        projectId,
        kind: "question",
        revision: 2,
        generation: 0,
        updatedAt: at,
        status: "pending",
        taskId: task.taskId,
        senderId: "member",
        targetGateId: "gate",
        targetRevision: 1,
        body: "Which fix?",
        choices: ["repair", "investigate"],
      },
    ]);
    const state = {
      ...emptyProjectWorkReducerState(projectId),
      revision: 10,
      tasks: [task],
      foundationRecords: [...records],
      attention: [{ taskId: task.taskId, reason: "failed" as const, revision: 3 }],
    };
    const events = decideProjectWorkCommand(state, input);
    expect(events.map((event) => event.type)).toEqual(["project-work.attention.seen"]);
    const next = applyProjectWorkEvents(state, events);
    expect(next.tasks).toEqual(state.tasks);
    expect(next.foundationRecords).toEqual(records);
    expect(next.attempts).toEqual([]);
    expect(next.attention[0]).toMatchObject({ seenAt: input.seenAt, revision: 4 });
    expect(next.attention[0]?.resolvedAt).toBeUndefined();
    expect(state.attention).toEqual([{ taskId: task.taskId, reason: "failed", revision: 3 }]);
  });
});

describe("mobile attention current query checks", () => {
  it("denies new acknowledgment while a retained success is refreshing and allows deliberate review after refresh", async () => {
    await render();
    await click("Review task attention attention-task");
    const submit = held("Mark task attention seen");
    await act(async () =>
      registry.set(pages(key()), AsyncResult.success(envelope(), { waiting: true })),
    );
    await call(submit);
    expect(emitted).toEqual([]);
    expect(host.textContent).toContain("Task attention changed");
    await update(envelope([notice("attention-task", { revision: 4 })], 0, 11));
    await click("Review task attention attention-task");
    await click("Mark task attention seen");
    expect(emitted[0]).toMatchObject({ expectedRevision: 11, type: "project-work.attention.seen" });
  });
  it("fences a held review on the current registry rather than retargeting a changed occurrence", async () => {
    await render();
    const review = held("Review task attention attention-task");
    await act(async () => {
      registry.set(
        pages(key()),
        AsyncResult.success(envelope([notice("attention-task", { revision: 4 })], 0, 11)),
      );
      review();
    });
    expect(host.textContent).toContain("Task attention changed");
    expect(host.textContent).not.toContain("Mark task attention seen");
    expect(emitted).toEqual([]);
  });
  it("sends once when the same held submit is called twice before React commits", async () => {
    const waiting = deferred();
    fixture.command.mockImplementation(() => waiting.promise);
    await render();
    await click("Review task attention attention-task");
    const submit = held("Mark task attention seen");
    await act(async () => {
      submit();
      submit();
    });
    expect(fixture.command).toHaveBeenCalledTimes(1);
    await act(async () => waiting.resolve({ _tag: "Success" }));
  });
  it("cancels an unsent review and permits a new deliberate review", async () => {
    await render();
    await click("Review task attention attention-task");
    await click("Cancel task attention review");
    expect(host.textContent).not.toContain("Mark task attention seen");
    await click("Review task attention attention-task");
    await click("Mark task attention seen");
    expect(emitted).toHaveLength(1);
  });
  it("denies old owner navigation after current registry owner revocation", async () => {
    await render();
    const open = held("Open attention task attention-task");
    await act(async () => {
      registry.set(ownProject, {
        id: projectId,
        environmentId: EnvironmentId.make("environment-other"),
      });
      open();
    });
    expect(fixture.navigate).not.toHaveBeenCalled();
  });
});

describe("mobile attention retained read repair", () => {
  it("retains the recorded page and original age after a same-owner query reset while offline", async () => {
    registry.mount(pages(key()));
    await act(async () =>
      registry.set(pages(key()), AsyncResult.success(envelope(), { timestamp: Date.parse(at) })),
    );
    await render();
    await accessChange(() => {
      fixture.connected = false;
    });
    await act(async () => registry.set(pages(key()), AsyncResult.initial(false)));
    expect(host.textContent).toContain("Retained failure needs review");
    expect(host.textContent).toContain("Last recorded attention read: " + at + " · cached");
    expect(button("Review task attention attention-task").disabled).toBe(true);
    await click("Open attention task attention-task");
    expect(fixture.navigate).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([]);
  });
  it("fences a held link against a foreign current registry page before React commits", async () => {
    await render();
    const open = held("Open attention task attention-task");
    await act(async () => {
      registry.set(
        pages(key()),
        AsyncResult.success({ ...envelope(), projectId: "project-other" }),
      );
      open();
    });
    expect(fixture.navigate).not.toHaveBeenCalled();
  });
});
