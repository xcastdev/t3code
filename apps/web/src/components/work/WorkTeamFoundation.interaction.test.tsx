/* @vitest-environment happy-dom */

import { RegistryContext } from "@effect/atom-react";
import { createProjectWorkEnvironmentAtoms } from "@t3tools/client-runtime/project-work";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  type PreparedConnection,
  type SupervisorConnectionState,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  AVAILABLE_CONNECTION_STATE,
} from "@t3tools/client-runtime/connection";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import {
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type ProjectWorkReadIntent,
  ProjectWorkWriteIntent,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const bridge = vi.hoisted(() => ({ atoms: undefined as unknown, config: undefined as unknown }));
vi.mock("~/state/projectWork", () => ({
  get projectWorkEnvironment() {
    return bridge.atoms;
  },
}));

vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: "connected" } }),
}));
vi.mock("~/state/entities", () => ({ useProject: () => ({ title: "Remote project" }) }));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => bridge.config } }));
vi.mock("./WorkOverview", () => ({ WorkOverview: () => <div>Current overview</div> }));

import { WorkPage } from "./WorkPage";
import { WorkTasks } from "./WorkTasks";
import { WorkTeamFoundation } from "./WorkTeamFoundation";

class TestConnectionError extends Data.TaggedError("TestConnectionError") {
  override readonly message = "connection lost";
}

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const at = "2026-10-01T10:00:00.000Z";
const task = {
  taskId: ProjectWorkTaskId.make("task-1"),
  projectId,
  title: "Investigate reconnect",
  state: "draft",
  watchers: [],
  revision: 4,
  specRevision: 0,
  createdAt: at,
  updatedAt: at,
};
const issue = {
  kind: "issue",
  recordId: "issue-1",
  projectId,
  revision: 2,
  generation: 0,
  updatedAt: at,
  status: "open",
  identity: {
    host: "github.com",
    repositoryNodeId: "repository-1",
    issueNodeId: "github-issue-1",
    number: 1,
  },
  repositoryName: "example/repo",
  title: "Reconnect drops history",
  body: "Keep the conversation",
  sourceRevision: "github-2",
  observedAt: at,
};
const membership = {
  kind: "task-membership",
  recordId: "membership-1",
  projectId,
  revision: 1,
  generation: 0,
  updatedAt: at,
  status: "active",
  taskId: task.taskId,
  executionKind: "managed",
  deliverableKind: "code",
};

describe("Work task entrypoint through mounted environment atoms", () => {
  let root: Root;
  let host: HTMLDivElement;
  let registry: AtomRegistry.AtomRegistry;
  let atoms: ReturnType<typeof createProjectWorkEnvironmentAtoms>;
  let records: unknown[];
  let revision: number;
  let taskRevision: number;
  let nextCursor: string | undefined;
  let writes: ProjectWorkWriteIntent[];
  let reads: ProjectWorkReadIntent[];
  let failWrite: boolean;
  let holdWrite: boolean;
  let writeStarted: Promise<void>;
  let startWrite: () => void;
  let writeRelease: Promise<void>;
  let releaseWrite: () => void;
  let foundationFailure: boolean;
  let foundationAttempts: number;
  let foundations: Map<string, unknown>;
  let taskPages: Map<number, unknown>;
  let holdContext: boolean;
  let contextStarted: Promise<void>;
  let startContext: () => void;
  let contextRelease: Promise<void>;
  let releaseContext: () => void;

  const setup = Effect.gen(function* () {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    records = [issue, membership];
    revision = 10;
    taskRevision = 10;
    nextCursor = undefined;
    writes = [];
    reads = [];
    failWrite = false;
    holdWrite = false;
    writeStarted = new Promise<void>((resolve) => {
      startWrite = resolve;
    });
    writeRelease = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    foundationFailure = false;
    foundationAttempts = 0;
    foundations = new Map();
    taskPages = new Map();
    holdContext = false;
    contextStarted = new Promise<void>((resolve) => {
      startContext = resolve;
    });
    contextRelease = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    const children = { criteria: [], evidence: [], relationships: [], blockers: [], comments: [] };
    // This fixture implements only the exercised Project Work protocol methods.
    const client = {
      [WS_METHODS.projectWorkRead]: (input: ProjectWorkReadIntent) =>
        Effect.gen(function* () {
          if (input.operation === "foundation-records") foundationAttempts += 1;
          if (input.operation === "foundation-records" && foundationFailure)
            return yield* new TestConnectionError();
          if (input.operation === "task-context" && holdContext) {
            startContext();
            yield* Effect.promise(() => contextRelease);
          }
          return yield* Effect.sync(() => {
            reads.push(input);
            if (input.operation === "foundation-records" && foundations.has(input.cursor ?? ""))
              return foundations.get(input.cursor ?? "");
            if (input.operation === "foundation-records")
              return {
                projectId: input.projectId,
                revision,
                items: input.cursor ? [] : records,
                ...(input.cursor || nextCursor === undefined ? {} : { nextCursor }),
              };
            if (input.operation === "tasks" && taskPages.has(input.offset ?? 0))
              return taskPages.get(input.offset ?? 0);
            if (input.operation === "task-context")
              return {
                projectId: input.projectId,
                revision: taskRevision,
                task: { ...task, projectId: input.projectId },
                criteria: [],
                evidence: [],
                comments: [],
                relationships: [],
                blockers: [],
                children,
                policy: {
                  taskId: task.taskId,
                  readiness: { ready: false, reasons: [] },
                  claimability: { claimable: false },
                  actions: { reopen: { available: true } },
                  attention: [],
                },
              };
            return {
              projectId: input.projectId,
              revision: taskRevision,
              offset: 0,
              limit: 51,
              hasMore: false,
              items: [{ ...task, projectId: input.projectId }],
            };
          });
        }),
      [WS_METHODS.projectWorkWrite]: (input: ProjectWorkWriteIntent) =>
        Effect.gen(function* () {
          writes.push(input);
          if (holdWrite) {
            startWrite();
            yield* Effect.promise(() => writeRelease);
          }
          return yield* failWrite
            ? Effect.fail(new TestConnectionError())
            : Effect.succeed({
                projectId,
                revision: revision + 1,
                receipt: {
                  commandId: input.commandId,
                  projectId,
                  revision: revision + 1,
                  status: "accepted",
                  eventCount: 1,
                },
                delta: { projectId, revision: revision + 1, eventIds: [], changedFields: [] },
              });
        }),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.never,
      subscribeServerConfig: client.subscribeServerConfig,
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    const supervisor = yield* Effect.gen(function* () {
      return EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "test",
          httpBaseUrl: "http://test",
          wsBaseUrl: "ws://test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
          generation: 1,
        }),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
    });
    const environments = yield* Effect.gen(function* () {
      return EnvironmentRegistry.of({
        entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map(),
        ),
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        start: Effect.void,
        register: () => Effect.die("unused"),
        registerPlatform: () => Effect.die("unused"),
        reconcilePlatform: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
        removeRelayEnvironments: () => Effect.die("unused"),
        retryNow: () => Effect.void,
        setEnabled: () => Effect.die("unused"),
        state: () => SubscriptionRef.get(supervisor.state),
        stateChanges: () => SubscriptionRef.changes(supervisor.state),
        run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        runStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      });
    });
    registry = AtomRegistry.make();
    atoms = createProjectWorkEnvironmentAtoms(
      Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
    );
    bridge.atoms = atoms;
    bridge.config = Atom.make({
      settings: { projectWorkEnabled: true },
      environment: {
        capabilities: {
          projectTeamFoundationReads: true,
          projectTeamGuidedWrites: true,
          projectTeamExecution: false,
        },
      },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  function interaction(name: string, body: () => Promise<void>) {
    it.effect(name, () =>
      Effect.gen(function* () {
        yield* setup;
        yield* Effect.promise(body);
      }),
    );
  }

  afterEach(async () => {
    await act(async () => root.unmount());
    registry.dispose();
    host.remove();
  });

  function settle(atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>) {
    return new Promise<void>((resolve) => {
      let dispose = () => {};
      let settled = false;
      dispose = registry.subscribe(
        atom,
        (value) => {
          if (!AsyncResult.isInitial(value) && !value.waiting) {
            settled = true;
            dispose();
            resolve();
          }
        },
        { immediate: true },
      );
      if (settled) dispose();
    });
  }
  async function render(connected = true, supported = true, target = projectId) {
    await act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <WorkTasks
            environmentId={environmentId}
            projectId={target}
            connected={connected}
            enabled
            teamReadSupported
            guidedWritesSupported={supported}
          />
        </RegistryContext.Provider>,
      );
      await settle(
        atoms.page({ environmentId, projectId: target, collection: "tasks", offset: 0 }),
      );
      await settle(atoms.foundationPage({ environmentId, projectId: target }));
    });
  }
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === text,
    );
  async function click(text: string) {
    await act(async () => button(text)?.click());
  }

  interaction(
    "places canonical intake above managed tasks and removes legacy bypass controls",
    async () => {
      await render();
      expect(host.textContent).toContain("Issue intake");
      expect(host.textContent).toContain(issue.title);
      expect(host.textContent).toContain("Refresh task");
      expect(host.textContent).not.toContain("Define this task");
      expect(button("Claim")).toBeUndefined();
      expect(reads.filter((input) => input.operation === "foundation-records")).toContainEqual({
        projectId,
        operation: "foundation-records",
        limit: 128,
      });
    },
  );

  interaction(
    "requires the current task page and foundation revision before refinement",
    async () => {
      taskRevision = 9;
      await render();
      expect(button("Refine issue")?.disabled).toBe(true);
      expect(writes).toEqual([]);
    },
  );

  interaction("requires every displayed task page to match the complete foundation", async () => {
    taskPages.set(0, { projectId, revision: 10, items: [task], hasMore: true });
    taskPages.set(50, { projectId, revision: 9, items: [], hasMore: false });
    await render();
    await click("Refine issue");
    await click("Load more tasks");
    await act(async () =>
      settle(atoms.page({ environmentId, projectId, collection: "tasks", offset: 50 })),
    );
    expect(button("Save refinement")?.disabled).toBe(true);
    await click("Save refinement");
    expect(writes).toEqual([]);
    taskPages.set(50, { projectId, revision: 10, items: [], hasMore: false });
    await act(async () => {
      registry.refresh(atoms.page({ environmentId, projectId, collection: "tasks", offset: 50 }));
      await settle(atoms.page({ environmentId, projectId, collection: "tasks", offset: 50 }));
    });
    expect(button("Save refinement")?.disabled).toBe(false);
    await click("Save refinement");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.expectedRevision).toBe(10);
  });

  interaction("keeps capability version skew read-only without foundation reads", async () => {
    bridge.config = Atom.make({
      settings: { projectWorkEnabled: true },
      environment: { capabilities: { projectTeamGuidedWrites: true } },
    });
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <WorkPage environmentId={environmentId} projectId={projectId} />
        </RegistryContext.Provider>,
      ),
    );
    await click("Tasks");
    await act(async () =>
      settle(atoms.page({ environmentId, projectId, collection: "tasks", offset: 0 })),
    );
    expect(host.textContent).toContain(task.title);
    expect(button("Save specification")?.disabled).toBe(true);
    expect(reads.some((input) => input.operation === "foundation-records")).toBe(false);
    await click("Save specification");
    expect(writes).toEqual([]);
  });

  interaction("keeps issue records readable without guided write capability", async () => {
    await render(true, false);
    expect(host.textContent).toContain(issue.title);
    expect(button("Refine issue")?.disabled).toBe(true);
  });
  interaction("preserves opaque cursors and waits for the complete foundation chain", async () => {
    const cursor = " cursor-byte-token ";
    nextCursor = cursor;
    await render();
    await act(async () => settle(atoms.foundationPage({ environmentId, projectId, cursor })));
    expect(reads).toContainEqual({
      projectId,
      operation: "foundation-records",
      limit: 128,
      cursor: nextCursor,
    });
    expect(button("Refine issue")?.disabled).toBe(false);
  });

  interaction(
    "refines only on explicit save and retries the identical public request",
    async () => {
      await render();
      await click("Refine issue");
      expect(writes).toEqual([]);
      failWrite = true;
      await click("Save refinement");
      expect(writes).toHaveLength(1);
      const request = decodeWrite(writes[0]);
      expect(request).toMatchObject({
        type: "project-work.issue.refine",
        projectId,
        expectedRevision: 10,
        expectedIssueRevision: 2,
      });
      expect(host.textContent).toContain("connection lost");
      failWrite = false;
      await click("Retry exact command");
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
    },
  );

  interaction(
    "sends actual issue-scoped investigation with no implementation approval",
    async () => {
      records = [{ ...issue, taskId: task.taskId }, membership];
      await render();
      await click("Start investigation");
      expect(writes).toHaveLength(1);
      expect(decodeWrite(writes[0])).toMatchObject({
        type: "project-team.investigation.start",
        projectId,
        taskId: task.taskId,
        expectedRevision: 10,
        expectedTaskRevision: 4,
        issueRecordId: issue.recordId,
        expectedIssueRevision: 2,
      });
      expect(
        writes.some(
          (intent) =>
            intent.type === "project-team.execution.start" ||
            intent.type === "project-team.gate.respond",
        ),
      ).toBe(false);
    },
  );

  interaction("retries uncertain investigation with its original command identity", async () => {
    records = [{ ...issue, taskId: task.taskId }, membership];
    failWrite = true;
    await render();
    await click("Start investigation");
    expect(host.textContent).toContain("connection lost");
    failWrite = false;
    await click("Start investigation");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
  });

  interaction("keeps detached issues read-only", async () => {
    records = [{ ...issue, status: "detached" }, membership];
    await render();
    expect(host.textContent).toContain(issue.title);
    expect(button("Refine issue")?.disabled).toBe(true);
  });

  interaction("makes unknown future foundation variants read-only", async () => {
    records.push({
      kind: "future-record",
      recordId: "future",
      projectId,
      revision: 1,
      generation: 0,
      updatedAt: at,
      status: "future",
    });
    await render();
    expect(host.textContent).toContain(issue.title);
    expect(button("Refine issue")?.disabled).toBe(true);
    expect(host.textContent).not.toContain("Define this task");
  });

  interaction(
    "retains legacy lifecycle forms when membership explicitly remains legacy",
    async () => {
      records = [issue, { ...membership, executionKind: "legacy" }];
      await render();
      expect(host.textContent).toContain("Define this task");
      expect(host.textContent).not.toContain("Investigation objective");
    },
  );

  interaction(
    "retains the local refinement draft on disconnect and re-enables after reconnect",
    async () => {
      await render();
      await click("Refine issue");
      const title = host.querySelector<HTMLInputElement>('input[value="Reconnect drops history"]');
      expect(title).not.toBeNull();
      await render(false);
      expect(button("Save refinement")?.disabled).toBe(true);
      expect(
        host.querySelector<HTMLInputElement>('input[value="Reconnect drops history"]'),
      ).not.toBeNull();
      await render();
      expect(button("Save refinement")?.disabled).toBe(false);
    },
  );

  interaction("rejects a previously enabled action after a live atom becomes stale", async () => {
    await render();
    await click("Refine issue");
    const save = button("Save refinement")!;
    await act(async () => {
      revision = 11;
      registry.refresh(atoms.foundationPage({ environmentId, projectId }));
      await settle(atoms.foundationPage({ environmentId, projectId }));
      save.click();
    });
    expect(writes).toEqual([]);
  });

  interaction(
    "keeps cached intake readable after a refresh error and permits explicit recovery",
    async () => {
      await render();
      foundationFailure = true;
      await act(async () => {
        registry.refresh(atoms.foundationPage({ environmentId, projectId }));
        await settle(atoms.foundationPage({ environmentId, projectId }));
      });
      expect(host.textContent).toContain(issue.title);
      expect(button("Refine issue")?.disabled).toBe(true);
      expect(host.textContent).toContain("Could not refresh project work");
      foundationFailure = false;
      await click("Retry");
      expect(button("Refine issue")?.disabled).toBe(false);
    },
  );

  interaction(
    "does not silently attach the first source issue to a multi-issue task investigation",
    async () => {
      records = [
        { ...issue, taskId: task.taskId },
        {
          ...issue,
          recordId: "issue-2",
          identity: { ...issue.identity, issueNodeId: "second", number: 2 },
          taskId: task.taskId,
        },
        membership,
      ];
      await render();
      await act(async () =>
        settle(atoms.taskContext({ environmentId, projectId, taskId: task.taskId })),
      );
      const starts = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(
        (item) => item.textContent?.trim() === "Start investigation",
      );
      await act(async () => starts.at(-1)?.click());
      expect(writes).toHaveLength(1);
      expect(writes[0]).not.toHaveProperty("issueRecordId");
    },
  );

  interaction(
    "fences the previous project while investigation awaits its task context",
    async () => {
      records = [{ ...issue, taskId: task.taskId }, membership];
      await render();
      holdContext = true;
      await act(async () => {
        button("Start investigation")?.click();
        await contextStarted;
      });
      const second = ProjectId.make("project-2");
      await render(true, true, second);
      await act(async () => {
        releaseContext();
      });
      expect(writes).toEqual([]);
      expect(host.textContent).not.toContain(issue.title);
    },
  );

  interaction("stops a nonterminal foundation chain at sixteen bounded pages", async () => {
    for (let index = 0; index < 16; index++)
      foundations.set(index === 0 ? "" : String(index), {
        projectId,
        revision: 10,
        items: index === 0 ? records : [],
        nextCursor: String(index + 1),
      });
    await render();
    for (let index = 1; index < 16; index++)
      await act(async () =>
        settle(atoms.foundationPage({ environmentId, projectId, cursor: String(index) })),
      );
    expect(host.textContent).toContain("exceeds the guided view limit");
    expect(button("Refine issue")?.disabled).toBe(true);
    expect(reads.filter((input) => input.operation === "foundation-records")).toHaveLength(16);
    expect(
      reads.some((input) => input.operation === "foundation-records" && input.cursor === "16"),
    ).toBe(false);
  });

  interaction(
    "retains local drafts while a changing paginated snapshot reloads coherently",
    async () => {
      nextCursor = "second";
      await render();
      await act(async () =>
        settle(atoms.foundationPage({ environmentId, projectId, cursor: "second" })),
      );
      await click("Refine issue");
      foundations.set("second", { projectId, revision: 10, items: [] });
      revision = 11;
      await act(async () => {
        registry.refresh(atoms.foundationPage({ environmentId, projectId }));
        await settle(atoms.foundationPage({ environmentId, projectId }));
      });
      expect(
        host.querySelector<HTMLInputElement>('input[value="Reconnect drops history"]'),
      ).not.toBeNull();
      expect(button("Save refinement")?.disabled).toBe(true);
      foundations.set("second", { projectId, revision: 11, items: [] });
      taskRevision = 11;
      await act(async () => {
        registry.refresh(atoms.foundationPage({ environmentId, projectId, cursor: "second" }));
        registry.refresh(atoms.page({ environmentId, projectId, collection: "tasks", offset: 0 }));
        await settle(atoms.foundationPage({ environmentId, projectId, cursor: "second" }));
        await settle(atoms.page({ environmentId, projectId, collection: "tasks", offset: 0 }));
      });
      expect(
        host.querySelector<HTMLInputElement>('input[value="Reconnect drops history"]'),
      ).not.toBeNull();
      await click("Save refinement");
      expect(writes).toEqual([]);
      expect(host.textContent).toContain("Project work changed");
    },
  );

  for (const action of ["defer", "reopen"])
    interaction(`routes human ${action} through the managed controls`, async () => {
      if (action === "reopen") records = [issue, { ...membership, controlState: "deferred" }];
      await render();
      await act(async () =>
        settle(atoms.taskContext({ environmentId, projectId, taskId: task.taskId })),
      );
      const select = host.querySelector<HTMLSelectElement>('[aria-label="Task control action"]')!;
      await act(async () => {
        select.value = action;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const reason = host.querySelector<HTMLTextAreaElement>('[aria-label="Control reason"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      await act(async () => {
        setter?.call(reason, "Human reviewed this work");
        reason.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Apply " + action);
      expect(writes).toHaveLength(1);
      expect(decodeWrite(writes[0])).toMatchObject({
        type: "project-team.task.control",
        expectedRevision: 10,
        expectedTaskRevision: 4,
        control: { action, reason: "Human reviewed this work" },
      });
      expect(host.textContent).not.toContain("Define this task");
    });

  interaction(
    "opens real intake from the Work page while managed execution remains disabled",
    async () => {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <WorkPage environmentId={environmentId} projectId={projectId} />
          </RegistryContext.Provider>,
        ),
      );
      expect(host.textContent).toContain("Current overview");
      await click("Tasks");
      await act(async () => {
        await settle(atoms.foundationPage({ environmentId, projectId }));
        await settle(atoms.page({ environmentId, projectId, collection: "tasks", offset: 0 }));
      });
      expect(host.textContent).toContain("Issue intake");
      expect(button("Refine issue")?.disabled).toBe(false);
      expect(writes).toEqual([]);
    },
  );

  interaction("preserves the Work disabled state without reading foundation records", async () => {
    bridge.config = Atom.make({
      settings: { projectWorkEnabled: false },
      environment: {
        capabilities: { projectTeamFoundationReads: true, projectTeamGuidedWrites: true },
      },
    });
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <WorkPage environmentId={environmentId} projectId={projectId} />
        </RegistryContext.Provider>,
      ),
    );
    expect(host.textContent).toContain("Project Work is turned off");
    expect(reads).toEqual([]);
  });
  function changeValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  for (const kind of ["new-capture", "refinement"]) {
    interaction(
      "regression: native " + kind + " click refuses a current page refresh before React commit",
      async () => {
        await render();
        let action: HTMLButtonElement;
        if (kind === "new-capture") {
          await click("New task");
          const input = host.querySelector<HTMLInputElement>(
            'input[placeholder="e.g. Document the release checklist"]',
          )!;
          await act(async () => changeValue(input, "Review the current queue"));
          action = button("Create draft")!;
        } else {
          await click("Refine issue");
          action = button("Save refinement")!;
        }
        expect(action.disabled).toBe(false);
        const page = atoms.page({ environmentId, projectId, collection: "tasks", offset: 0 });
        const observations: Array<{ revision: number; disabled: boolean; waiting: boolean }> = [];
        let clicked!: () => void;
        const observed = new Promise<void>((resolve) => {
          clicked = resolve;
        });
        let dispose = () => {};
        dispose = registry.subscribe(page, (current) => {
          const value = Option.getOrNull(AsyncResult.value(current));
          if (
            typeof value !== "object" ||
            value === null ||
            !("revision" in value) ||
            value.revision !== 9 ||
            current.waiting ||
            observations.length > 0
          )
            return;
          observations.push({
            revision: value.revision,
            disabled: action.disabled,
            waiting: current.waiting,
          });
          action.click();
          clicked();
        });
        await act(async () => {
          taskRevision = 9;
          registry.refresh(page);
          await observed;
        });
        dispose();
        expect(observations).toEqual([{ revision: 9, disabled: false, waiting: false }]);
        expect(writes, JSON.stringify({ observations, writes })).toEqual([]);
      },
    );
  }

  interaction("regression: current capture remains compatible", async () => {
    await render();
    await click("New task");
    const input = host.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Document the release checklist"]',
    )!;
    await act(async () => changeValue(input, "Human draft"));
    await click("Create draft");
    expect(writes).toHaveLength(1);
    expect(decodeWrite(writes[0])).toMatchObject({
      type: "project-work.task.create",
      projectId,
      title: "Human draft",
    });
  });

  interaction(
    "retries guarded ordinary capture with the same command after a connection failure",
    async () => {
      await render();
      await click("New task");
      const input = host.querySelector<HTMLInputElement>(
        'input[placeholder="e.g. Document the release checklist"]',
      )!;
      await act(async () => changeValue(input, "Keep my capture"));
      failWrite = true;
      await click("Create draft");
      expect(writes).toHaveLength(1);
      const original = writes[0];
      expect(decodeWrite(original)).toMatchObject({
        type: "project-work.task.create",
        projectId,
        title: "Keep my capture",
      });
      await render(false);
      expect(input.value).toBe("Keep my capture");
      expect(button("Create draft")?.disabled).toBe(true);
      await click("Create draft");
      expect(writes).toHaveLength(1);
      failWrite = false;
      await render();
      await click("Create draft");
      expect(writes).toEqual([original, original]);
      expect(host.textContent).not.toContain("New draft task");
    },
  );

  for (const legacy of ["explicit", "unmanaged"]) {
    interaction(
      "regression: " +
        legacy +
        " legacy specification draft survives foundation failure and recovery",
      async () => {
        records =
          legacy === "explicit" ? [issue, { ...membership, executionKind: "legacy" }] : [issue];
        await render();
        const input = host.querySelector<HTMLTextAreaElement>(
          'textarea[placeholder="What outcome should exist?"]',
        )!;
        expect(input).not.toBeNull();
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
            input,
            "Retain my specification draft",
          );
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(input.value).toBe("Retain my specification draft");
        foundationFailure = true;
        await act(async () => {
          registry.refresh(atoms.foundationPage({ environmentId, projectId }));
          await settle(atoms.foundationPage({ environmentId, projectId }));
        });
        const afterError = host.querySelector<HTMLTextAreaElement>(
          'textarea[placeholder="What outcome should exist?"]',
        );
        expect(afterError).toBe(input);
        expect(afterError?.disabled).toBe(true);
        foundationFailure = false;
        await act(async () => {
          registry.refresh(atoms.foundationPage({ environmentId, projectId }));
          await settle(atoms.foundationPage({ environmentId, projectId }));
        });
        const recovered = host.querySelector<HTMLTextAreaElement>(
          'textarea[placeholder="What outcome should exist?"]',
        );
        expect(recovered).toBe(input);
        expect(recovered?.disabled).toBe(false);
        const observation = {
          afterError: afterError?.value ?? null,
          afterRecovery: recovered?.value ?? null,
          writes,
        };
        expect(observation).toEqual({
          afterError: "Retain my specification draft",
          afterRecovery: "Retain my specification draft",
          writes: [],
        });
      },
    );
  }
  const legacyRecords = () => [issue, { ...membership, executionKind: "legacy" }];
  async function fillLegacySpecification() {
    await act(async () => {
      for (const field of host.querySelectorAll<HTMLTextAreaElement>("textarea")) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
          field,
          "Current human scope",
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const criterion = host.querySelector<HTMLInputElement>(
        'input[placeholder="How will we know it is done?"]',
      )!;
      changeValue(criterion, "A meaningful criterion");
    });
  }
  for (const action of ["legacy-specification", "legacy-lifecycle", "managed-refinement"]) {
    interaction(
      "independent: native foundation refresh before React commit for " + action,
      async () => {
        records = action === "managed-refinement" ? [issue, membership] : legacyRecords();
        await render();
        await act(async () =>
          settle(atoms.taskContext({ environmentId, projectId, taskId: task.taskId })),
        );
        if (action === "legacy-specification") await fillLegacySpecification();
        if (action === "managed-refinement") await click("Refine issue");
        const control = button(
          action === "legacy-specification"
            ? "Save specification"
            : action === "legacy-lifecycle"
              ? "Reopen"
              : "Save refinement",
        )!;
        expect(control.disabled).toBe(false);
        const foundation = atoms.foundationPage({ environmentId, projectId });
        let notify!: () => void;
        const observed = new Promise<void>((resolve) => {
          notify = resolve;
        });
        let once = false;
        const observations: unknown[] = [];
        const dispose = registry.subscribe(foundation, (value) => {
          const raw = Option.getOrNull(AsyncResult.value(value));
          if (
            value._tag !== "Success" ||
            value.waiting ||
            once ||
            typeof raw !== "object" ||
            raw === null ||
            !("items" in raw) ||
            !Array.isArray(raw.items) ||
            !raw.items.some((item) => item.kind === "future-record")
          )
            return;
          once = true;
          observations.push({ disabled: control.disabled, waiting: value.waiting });
          control.click();
          notify();
        });
        await act(async () => {
          records.push({
            kind: "future-record",
            recordId: "future",
            projectId,
            revision: 1,
            generation: 0,
            updatedAt: at,
            status: "future",
          });
          registry.refresh(foundation);
          await observed;
        });
        dispose();
        expect(observations).toEqual([{ disabled: false, waiting: false }]);
        const expected = 0;
        expect(writes).toHaveLength(expected);
        if (expected > 0) expect(writes[0]?.expectedRevision).toBe(10);
      },
    );
  }
  interaction("independent: committed unknown foundation blocks legacy specification", async () => {
    records = legacyRecords();
    await render();
    await fillLegacySpecification();
    const control = button("Save specification")!;
    records.push({
      kind: "future-record",
      recordId: "future",
      projectId,
      revision: 1,
      generation: 0,
      updatedAt: at,
      status: "future",
    });
    await act(async () => {
      registry.refresh(atoms.foundationPage({ environmentId, projectId }));
      await settle(atoms.foundationPage({ environmentId, projectId }));
    });
    expect(control.disabled).toBe(true);
    await act(async () => control.click());
    expect(writes).toEqual([]);
  });
  for (const kind of ["legacy-specification", "managed-refinement"]) {
    interaction("independent: repeated native clicks in one event for " + kind, async () => {
      records = kind === "legacy-specification" ? legacyRecords() : [issue, membership];
      await render();
      if (kind === "legacy-specification") await fillLegacySpecification();
      else await click("Refine issue");
      const control = button(
        kind === "legacy-specification" ? "Save specification" : "Save refinement",
      )!;
      expect(control.disabled).toBe(false);
      await act(async () => {
        control.click();
        control.click();
      });
      const expected = kind === "legacy-specification" ? 2 : 1;
      expect(writes).toHaveLength(expected);
      if (kind === "legacy-specification") {
        const firstStages = writes.filter(
          (intent) => intent.type === "project-work.criterion.upsert",
        );
        expect(firstStages).toHaveLength(1);
        expect(writes.filter((intent) => intent.type === "project-work.task.specify")).toHaveLength(
          1,
        );
        expect(firstStages.every((intent) => intent.expectedRevision === 10)).toBe(true);
      }
    });
  }

  interaction(
    "independent compatibility: ordinary legacy work survives absent guided-write capability",
    async () => {
      records = [issue, { ...membership, executionKind: "legacy" }];
      await render(true, false);
      expect(host.textContent).toContain("Define this task");
      expect(button("New task")?.disabled).toBe(false);
      expect(
        host.querySelector<HTMLTextAreaElement>(
          'textarea[placeholder="What outcome should exist?"]',
        )?.disabled,
      ).toBe(false);
      expect(writes).toEqual([]);
      await act(async () => {
        root.render(
          <RegistryContext.Provider value={registry}>
            <WorkTasks
              environmentId={environmentId}
              projectId={projectId}
              connected
              enabled
              teamReadSupported={false}
              guidedWritesSupported={false}
            />
          </RegistryContext.Provider>,
        );
        await settle(atoms.page({ environmentId, projectId, collection: "tasks", offset: 0 }));
      });
      expect(button("New task")?.disabled).toBe(false);
      expect(
        host.querySelector<HTMLTextAreaElement>(
          'textarea[placeholder="What outcome should exist?"]',
        )?.disabled,
      ).toBe(false);
      await click("New task");
      const input = host.querySelector<HTMLInputElement>(
        'input[placeholder="e.g. Document the release checklist"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          "Ordinary legacy capture",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Create draft");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.type).toBe("project-work.task.create");
    },
  );
  for (const guided of [false, undefined]) {
    interaction(
      "legacy specification remains writable with foundation reads and guided capability " +
        String(guided),
      async () => {
        records = legacyRecords();
        bridge.config = Atom.make({
          settings: { projectWorkEnabled: true },
          environment: {
            capabilities: {
              projectTeamFoundationReads: true,
              ...(guided === undefined ? {} : { projectTeamGuidedWrites: guided }),
            },
          },
        });
        await act(async () =>
          root.render(
            <RegistryContext.Provider value={registry}>
              <WorkPage environmentId={environmentId} projectId={projectId} />
            </RegistryContext.Provider>,
          ),
        );
        await click("Tasks");
        await act(async () => {
          await settle(atoms.foundationPage({ environmentId, projectId }));
          await settle(atoms.page({ environmentId, projectId, collection: "tasks", offset: 0 }));
        });
        expect(button("New task")?.disabled).toBe(false);
        expect(button("Refine issue")?.disabled).toBe(true);
        await fillLegacySpecification();
        await click("Save specification");
        expect(
          writes.map((command) => [
            command.type,
            "expectedRevision" in command ? command.expectedRevision : null,
          ]),
        ).toEqual([
          ["project-work.criterion.upsert", 10],
          ["project-work.task.specify", 11],
        ]);
      },
    );
  }

  interaction(
    "rechecks live eligibility after the criterion receipt and resumes its exact specification",
    async () => {
      records = legacyRecords();
      await render();
      await fillLegacySpecification();
      const objective = host.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder="What outcome should exist?"]',
      )!;
      holdWrite = true;
      await act(async () => {
        button("Save specification")!.click();
        await writeStarted;
      });
      expect(writes).toHaveLength(1);
      records.push({
        kind: "future-record",
        recordId: "future",
        projectId,
        revision: 1,
        generation: 0,
        updatedAt: at,
        status: "future",
      });
      await act(async () => {
        registry.refresh(atoms.foundationPage({ environmentId, projectId }));
        await settle(atoms.foundationPage({ environmentId, projectId }));
        holdWrite = false;
        releaseWrite();
      });
      expect(writes).toHaveLength(1);
      expect(host.querySelector('textarea[placeholder="What outcome should exist?"]')).toBe(
        objective,
      );
      expect(objective.value).toBe("Current human scope");
      records = legacyRecords();
      revision = 11;
      taskRevision = 11;
      await act(async () => {
        registry.refresh(atoms.foundationPage({ environmentId, projectId }));
        registry.refresh(atoms.page({ environmentId, projectId, collection: "tasks", offset: 0 }));
        await settle(atoms.foundationPage({ environmentId, projectId }));
        await settle(atoms.page({ environmentId, projectId, collection: "tasks", offset: 0 }));
      });
      await click("Save specification");
      expect(writes).toHaveLength(2);
      expect(writes[1]).toMatchObject({
        type: "project-work.task.specify",
        expectedRevision: 11,
        specification: { objective: "Current human scope" },
      });
      expect(
        writes.filter((command) => command.type === "project-work.criterion.upsert"),
      ).toHaveLength(1);
    },
  );

  for (const action of ["capture", "ready", "lifecycle"]) {
    interaction("synchronously fences repeated legacy " + action + " clicks", async () => {
      records = legacyRecords();
      if (action === "ready")
        taskPages.set(0, {
          projectId,
          revision: 10,
          items: [{ ...task, state: "specified" }],
          hasMore: false,
        });
      await render();
      let label = "Reopen";
      if (action === "capture") {
        await click("New task");
        const input = host.querySelector<HTMLInputElement>(
          'input[placeholder="e.g. Document the release checklist"]',
        )!;
        await act(async () => changeValue(input, "Once only"));
        label = "Create draft";
      } else if (action === "ready") {
        await act(async () =>
          [...host.querySelectorAll<HTMLButtonElement>("button")]
            .find((button) => button.textContent?.includes(task.title))!
            .click(),
        );
        label = "Mark ready";
      } else {
        await act(async () =>
          settle(atoms.taskContext({ environmentId, projectId, taskId: task.taskId })),
        );
      }
      const control = button(label)!;
      expect(control).not.toBeUndefined();
      await act(async () => {
        control.click();
        control.click();
      });
      expect(writes).toHaveLength(1);
    });
  }
  interaction(
    "nonpolling foundation still pages and explicitly refreshes without interval reads",
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        nextCursor = "second";
        let refresh = () => {};
        await act(async () => {
          root.render(
            <RegistryContext.Provider value={registry}>
              <WorkTeamFoundation
                environmentId={environmentId}
                projectId={projectId}
                connected
                enabled
                supported
                poll={false}
              >
                {(view) => {
                  refresh = view.refresh;
                  return (
                    <div>
                      {view.snapshot.complete ? "Complete retained foundation" : "Incomplete"}
                    </div>
                  );
                }}
              </WorkTeamFoundation>
            </RegistryContext.Provider>,
          );
          await settle(atoms.foundationPage({ environmentId, projectId, poll: false }));
        });
        await act(async () =>
          settle(atoms.foundationPage({ environmentId, projectId, cursor: "second", poll: false })),
        );
        expect(host.textContent).toContain("Complete retained foundation");
        expect(foundationAttempts).toBe(2);
        await act(async () => vi.advanceTimersByTimeAsync(46_000));
        expect(foundationAttempts).toBe(2);
        await act(async () => {
          refresh();
          await settle(atoms.foundationPage({ environmentId, projectId, poll: false }));
          await settle(
            atoms.foundationPage({ environmentId, projectId, cursor: "second", poll: false }),
          );
        });
        expect(foundationAttempts).toBe(4);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  for (const revoked of ["connected", "enabled", "supported", "owner"] as const) {
    interaction("fences a held foundation refresh after " + revoked + " revocation", async () => {
      let heldRefresh = () => {};
      const mount = async (eligible: boolean) =>
        act(async () =>
          root.render(
            <RegistryContext.Provider value={registry}>
              {revoked === "owner" && !eligible ? (
                <div>Other owner</div>
              ) : (
                <WorkTeamFoundation
                  environmentId={environmentId}
                  projectId={projectId}
                  connected={revoked !== "connected" || eligible}
                  enabled={revoked !== "enabled" || eligible}
                  supported={revoked !== "supported" || eligible}
                  poll={false}
                >
                  {(view) => {
                    if (eligible) heldRefresh = view.refresh;
                    return <div>Foundation inspection</div>;
                  }}
                </WorkTeamFoundation>
              )}
            </RegistryContext.Provider>,
          ),
        );
      await mount(true);
      await act(async () =>
        settle(atoms.foundationPage({ environmentId, projectId, poll: false })),
      );
      const before = foundationAttempts;
      await mount(false);
      await act(async () => heldRefresh());
      expect(foundationAttempts).toBe(before);
      if (revoked !== "owner") {
        await mount(true);
        await act(async () => {
          heldRefresh();
          await settle(atoms.foundationPage({ environmentId, projectId, poll: false }));
        });
        expect(foundationAttempts).toBe(before + 1);
      }
    });
  }
  interaction("built-in foundation Retry cannot refresh after disconnect", async () => {
    foundationFailure = true;
    const mount = async (connected: boolean) =>
      act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <WorkTeamFoundation
              environmentId={environmentId}
              projectId={projectId}
              connected={connected}
              enabled
              supported
              poll={false}
            >
              {() => <div>Inspection</div>}
            </WorkTeamFoundation>
          </RegistryContext.Provider>,
        ),
      );
    await mount(true);
    await act(async () => settle(atoms.foundationPage({ environmentId, projectId, poll: false })));
    expect(button("Retry")).toBeDefined();
    const before = foundationAttempts;
    await mount(false);
    foundationFailure = false;
    await click("Retry");
    expect(foundationAttempts).toBe(before);
    await mount(true);
    await click("Retry");
    await act(async () => settle(atoms.foundationPage({ environmentId, projectId, poll: false })));
    expect(foundationAttempts).toBe(before + 1);
  });
});
