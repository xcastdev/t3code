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
  ProjectTeamRecord,
  ProjectWorkTask,
  type ProjectWorkAttention,
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
vi.mock("../../components/work/WorkOverview", () => ({
  WorkOverview: () => <div>Current overview</div>,
}));

import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  emptyProjectWorkReducerState,
  type ProjectWorkReducerState,
} from "../../../../server/src/projectWork/ProjectWorkDecider";

import { WorkPage } from "../../components/work/WorkPage";
import { Inbox } from "./Inbox";
import { Team } from "./Team";

class TestDeniedError extends Data.TaggedError("TestDeniedError") {
  readonly code = "permission-denied";
  override readonly message = "Human credential cannot answer this question";
}

class TestConnectionError extends Data.TaggedError("TestConnectionError") {
  override readonly message = "connection lost";
}

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const decodeTask = Schema.decodeUnknownSync(ProjectWorkTask);
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

const baseRecord = { projectId, revision: 2, generation: 0, updatedAt: at };
const member = {
  ...baseRecord,
  kind: "member",
  recordId: "member-1",
  status: "active",
  name: "Investigator",
  coordinator: false,
  roleRevisionId: "role-1",
};
const role = {
  ...baseRecord,
  kind: "role-revision",
  recordId: "role-1",
  status: "available",
  roleId: "investigator",
  roleRevision: 1,
  role: "investigator",
  instructions: "Investigate",
  skills: [],
  tools: [],
  model: "configured-model",
  memoryAccess: "project",
  delegationDepth: 0,
};
const binding = {
  ...baseRecord,
  kind: "run-binding",
  recordId: "run-1",
  status: "running",
  taskId: task.taskId,
  attemptId: "attempt-1",
  memberId: member.recordId,
  roleRevisionId: role.recordId,
  providerInstanceId: "pi",
  threadId: "worker-thread",
  environmentId,
  model: "actual-model",
  configuration: {
    instructionsHash: "hash",
    toolIds: [],
    skillIds: [],
    runtimeVersion: "version",
    maxTokens: 10,
    maxDurationMs: 10,
    paidFallback: false,
  },
  worktree: "/sandbox/work",
  branch: "investigate",
  leaseGeneration: 1,
  specRevision: 0,
  planRevision: 0,
};
const gate = {
  ...baseRecord,
  kind: "gate",
  recordId: "gate-1",
  status: "pending",
  taskId: task.taskId,
  gate: "investigation",
  specRevision: 0,
  planRevision: 0,
  contentHash: "hash",
  attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
  evidenceIds: [],
};
const question = {
  ...baseRecord,
  kind: "question",
  recordId: "question-1",
  status: "pending",
  taskId: task.taskId,
  senderId: member.recordId,
  targetGateId: gate.recordId,
  targetRevision: 2,
  body: "Which reconnect behavior is intended?",
  choices: ["Keep history", "Start fresh"],
};

describe("Team and Inbox through mounted authenticated environment atoms", () => {
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
  let denyWrite: boolean;
  let contextOverride: unknown;
  let holdWrite: boolean;
  let writeStarted: Promise<void>;
  let startWrite: () => void;
  let writeRelease: Promise<void>;
  let releaseWrite: () => void;
  let foundationFailure: boolean;
  let foundations: Map<string, unknown>;
  let taskPages: Map<number, unknown>;
  let attentionPages: Map<number, unknown>;
  let attention: ProjectWorkAttention[];
  let attentionFailure: boolean;
  let workState: ProjectWorkReducerState | undefined;
  let openedTasks: string[];
  let holdContext: boolean;
  let contextStarted: Promise<void>;
  let startContext: () => void;
  let contextRelease: Promise<void>;
  let releaseContext: () => void;

  const setup = Effect.gen(function* () {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    records = [member, role, binding, membership, gate, question];
    revision = 10;
    taskRevision = 10;
    nextCursor = undefined;
    writes = [];
    reads = [];
    failWrite = false;
    denyWrite = false;
    contextOverride = undefined;
    holdWrite = false;
    writeStarted = new Promise<void>((resolve) => {
      startWrite = resolve;
    });
    writeRelease = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    foundationFailure = false;
    foundations = new Map();
    taskPages = new Map();
    attentionPages = new Map();
    attention = [];
    attentionFailure = false;
    workState = undefined;
    openedTasks = [];
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
          if (input.operation === "attention" && attentionFailure)
            return yield* new TestConnectionError();
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
            if (input.operation === "attention")
              return (
                attentionPages.get(input.offset ?? 0) ?? {
                  projectId: input.projectId,
                  revision: workState?.revision ?? revision,
                  offset: input.offset ?? 0,
                  limit: input.limit,
                  hasMore: false,
                  items: workState?.attention ?? attention,
                }
              );
            if (input.operation === "tasks" && taskPages.has(input.offset ?? 0))
              return taskPages.get(input.offset ?? 0);
            if (input.operation === "task-context" && contextOverride !== undefined)
              return contextOverride;
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
          if (denyWrite) return yield* new TestDeniedError();
          if (workState && input.type === "project-work.attention.seen") {
            workState = applyProjectWorkEvents(
              workState,
              decideProjectWorkCommand(workState, input),
            );
            revision = taskRevision = workState.revision;
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

  async function render(
    connected = true,
    supported = true,
    target = projectId,
    env = environmentId,
  ) {
    await act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <Inbox
            environmentId={env}
            projectId={target}
            connected={connected}
            enabled
            supported={supported}
            writesSupported={supported}
            onOpenTask={(taskId) => openedTasks.push(taskId)}
          />
        </RegistryContext.Provider>,
      );
      await settle(atoms.foundationPage({ environmentId: env, projectId: target }));
      await settle(
        atoms.page({ environmentId: env, projectId: target, collection: "attention", offset: 0 }),
      );
    });
  }
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === label,
    );
  async function click(label: string) {
    const control = button(label);
    expect(control, label).toBeDefined();
    await act(async () => control!.click());
  }
  async function openAnswer() {
    await click("Answer question");
    await act(async () =>
      settle(atoms.taskContext({ environmentId, projectId, taskId: task.taskId })),
    );
  }
  async function refresh() {
    await act(async () => {
      registry.refresh(atoms.foundationPage({ environmentId, projectId }));
      registry.refresh(atoms.taskContext({ environmentId, projectId, taskId: task.taskId }));
      await settle(atoms.foundationPage({ environmentId, projectId }));
      await settle(atoms.taskContext({ environmentId, projectId, taskId: task.taskId }));
    });
  }
  interaction(
    "uncertain publication is visible with no questions and opening its task does not acknowledge it",
    async () => {
      records = [member, role, binding, membership, gate];
      attention = [
        {
          taskId: task.taskId,
          reason: "needs-review",
          detail: "PR publication response is uncertain. Review the retained operation.",
          revision: 4,
        },
      ];
      await render();
      expect(host.textContent).toContain("Task attention");
      expect(host.textContent).toContain("PR publication response is uncertain");
      expect(host.textContent).toContain("No pending questions recorded");
      await click("Open task " + task.taskId);
      expect(openedTasks).toEqual([task.taskId]);
      expect(writes).toEqual([]);
    },
  );

  interaction(
    "marking task attention seen retains its unresolved occurrence and cannot advance managed work",
    async () => {
      const publication = decodeRecord({
        ...baseRecord,
        kind: "effect",
        recordId: "publication-1",
        status: "uncertain",
        effectId: "effect-1",
        effectKind: "publication",
        targetId: "publication-1",
        taskId: task.taskId,
        payload: { recordIds: [], expectedRevision: 10 },
        claimGeneration: 1,
        availableAt: at,
        outcome: "Publication uncertain",
      });
      records.push(publication);
      workState = {
        ...emptyProjectWorkReducerState(projectId),
        revision: 10,
        tasks: [decodeTask(task)],
        foundationRecords: records.map((record) => decodeRecord(record)),
        attention: [
          {
            taskId: task.taskId,
            reason: "blocked",
            detail:
              "PR publication 'publication-1' has an uncertain outcome. Review the remote result before retrying.",
            revision: 4,
          },
        ],
      };
      const before = {
        tasks: workState.tasks,
        attempts: workState.attempts,
        foundationRecords: workState.foundationRecords,
      };
      await render();
      await click("Review task attention");
      await click("Mark task attention seen");
      await act(async () =>
        settle(atoms.page({ environmentId, projectId, collection: "attention", offset: 0 })),
      );
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        type: "project-work.attention.seen",
        taskId: task.taskId,
        expectedRevision: 10,
      });
      expect(workState.attention).toEqual([
        {
          taskId: task.taskId,
          reason: "blocked",
          detail:
            "PR publication 'publication-1' has an uncertain outcome. Review the remote result before retrying.",
          revision: 5,
          seenAt: expect.any(String),
        },
      ]);
      expect({
        tasks: workState.tasks,
        attempts: workState.attempts,
        foundationRecords: workState.foundationRecords,
      }).toEqual(before);
      expect(
        workState.foundationRecords?.find((item) => item.recordId === question.recordId),
      ).not.toHaveProperty("seenAt");
      expect(host.textContent).toContain("Unresolved");
      expect(host.textContent).toContain("has an uncertain outcome");
      expect(host.textContent).toContain("Seen ");
    },
  );

  const notice: ProjectWorkAttention = {
    taskId: task.taskId,
    reason: "blocked",
    detail: "Review retained publication",
    revision: 4,
  };
  async function refreshAttention(offset = 0) {
    await act(async () => {
      const atom = atoms.page({ environmentId, projectId, collection: "attention", offset });
      registry.refresh(atom);
      await settle(atom);
    });
  }
  interaction(
    "a new attention revision and detail require another review before acknowledgment",
    async () => {
      attention = [notice];
      await render();
      await click("Review task attention");
      attention = [{ ...notice, detail: "Different retained operation", revision: 5 }];
      revision = 11;
      await refreshAttention();
      expect(button("Mark task attention seen")?.disabled).toBe(true);
      expect(host.textContent).toContain("Task attention changed");
      await click("Mark task attention seen");
      expect(writes).toEqual([]);
      await click("Review task attention");
      await click("Mark task attention seen");
      expect(writes[0]).toMatchObject({ expectedRevision: 11 });
    },
  );
  interaction(
    "the registry fences a changed occurrence before React commits the new page",
    async () => {
      attention = [notice];
      await render();
      await click("Review task attention");
      const control = button("Mark task attention seen")!;
      const atom = atoms.page({ environmentId, projectId, collection: "attention", offset: 0 });
      attention = [{ ...notice, detail: "Another occurrence", revision: 5 }];
      revision = 11;
      const dispose = registry.subscribe(atom, (value) => {
        if (
          AsyncResult.isSuccess(value) &&
          !value.waiting &&
          typeof value.value === "object" &&
          value.value !== null &&
          "revision" in value.value &&
          value.value.revision === 11
        )
          control.click();
      });
      await refreshAttention();
      dispose();
      expect(writes).toEqual([]);
      expect(host.textContent).toContain("Task attention changed");
    },
  );
  for (const denial of [
    "disconnected",
    "stale-read",
    "foreign-project",
    "foreign-row",
    "wrong-offset",
    "overflow",
    "unsafe-revision",
    "future-row-revision",
    "malformed-row",
    "duplicate-task",
  ]) {
    interaction("task attention acknowledgment denies " + denial, async () => {
      attention = [notice];
      await render();
      await click("Review task attention");
      if (denial === "disconnected") await render(false);
      else if (denial === "stale-read") {
        attentionFailure = true;
        await refreshAttention();
      } else {
        const envelope = {
          projectId,
          revision: 10,
          offset: 0,
          limit: 51,
          hasMore: false,
          items: [notice],
        };
        attentionPages.set(
          0,
          denial === "foreign-project"
            ? { ...envelope, projectId: "foreign" }
            : denial === "foreign-row"
              ? { ...envelope, items: [{ ...notice, projectId: "foreign" }] }
              : denial === "wrong-offset"
                ? { ...envelope, offset: 50 }
                : denial === "overflow"
                  ? { ...envelope, items: Array.from({ length: 52 }, () => notice) }
                  : denial === "unsafe-revision"
                    ? { ...envelope, revision: Number.MAX_SAFE_INTEGER + 1 }
                    : denial === "future-row-revision"
                      ? { ...envelope, items: [{ ...notice, revision: 11 }] }
                      : denial === "duplicate-task"
                        ? { ...envelope, items: [notice, { ...notice, revision: 5 }] }
                        : { ...envelope, items: [{ ...notice, seenAt: "invalid" }] },
        );
        await refreshAttention();
      }
      expect(button("Mark task attention seen")?.disabled).toBe(true);
      await click("Mark task attention seen");
      expect(writes).toEqual([]);
      expect(host.textContent).not.toContain("No unresolved task attention on this page");
    });
  }
  interaction(
    "resolved rows and unsupported reasons cannot hide a later unresolved attention page",
    async () => {
      records = [];
      const resolved = Array.from({ length: 51 }, (_, index) => ({
        ...notice,
        taskId: "resolved-" + index,
        resolvedAt: at,
      }));
      attentionPages.set(0, {
        projectId,
        revision: 10,
        offset: 0,
        limit: 51,
        hasMore: false,
        items: resolved,
      });
      attentionPages.set(50, {
        projectId,
        revision: 10,
        offset: 50,
        limit: 51,
        hasMore: false,
        items: [
          resolved[50],
          { ...notice, reason: "future-reason", taskId: "unsupported-task" },
          notice,
        ],
      });
      await render();
      expect(host.textContent).toContain("No unresolved task attention on this page");
      expect(button("Next attention page")?.disabled).toBe(false);
      await click("Next attention page");
      await act(async () =>
        settle(atoms.page({ environmentId, projectId, collection: "attention", offset: 50 })),
      );
      expect(host.textContent).toContain("Review retained publication");
      expect(host.textContent).toContain("Unsupported attention reason: future-reason");
      expect(host.textContent).not.toContain("Resolved " + at);
      await click("Include resolved attention");
      expect(host.textContent).toContain("Resolved " + at);
      expect(
        [...host.querySelectorAll("button")].filter(
          (item) => item.textContent === "Review task attention",
        ),
      ).toHaveLength(1);
      expect(reads.filter((input) => input.operation === "attention")).toMatchObject([
        { projectId, operation: "attention", limit: 51, offset: 0, envelope: true },
        { projectId, operation: "attention", limit: 51, offset: 50, envelope: true },
      ]);
      expect(writes).toEqual([]);
    },
  );
  interaction(
    "uncertain task attention acknowledgment retries its exact original envelope",
    async () => {
      attention = [notice];
      await render();
      await click("Review task attention");
      failWrite = true;
      await click("Mark task attention seen");
      const original = writes[0];
      expect(button("Retry exact task attention seen")?.disabled).toBe(false);
      attention = [{ ...notice, detail: "New occurrence after uncertainty", revision: 5 }];
      revision = 11;
      await refreshAttention();
      failWrite = false;
      await click("Retry exact task attention seen");
      expect(writes).toHaveLength(2);
      expect(writes[1]).toBe(original);
      expect(host.textContent).toContain("Resolution is unchanged");
    },
  );
  interaction(
    "another project's late task attention receipt cannot change the new Inbox owner",
    async () => {
      attention = [notice];
      await render();
      await click("Review task attention");
      holdWrite = true;
      await act(async () => {
        button("Mark task attention seen")!.click();
        await writeStarted;
      });
      attention = [];
      await render(true, true, ProjectId.make("other-project"));
      await act(async () => releaseWrite());
      expect(host.textContent).not.toContain("Task attention marked seen");
      expect(host.textContent).not.toContain("Review retained publication");
      expect(writes).toHaveLength(1);
    },
  );
  interaction(
    "an uncertain attention receipt survives a same-owner capability interlude",
    async () => {
      attention = [notice];
      await render();
      await click("Review task attention");
      holdWrite = true;
      await act(async () => {
        button("Mark task attention seen")!.click();
        await writeStarted;
      });
      await render(true, false);
      failWrite = true;
      await act(async () => releaseWrite());
      await render();
      expect(button("Retry exact task attention seen")?.disabled).toBe(false);
      const original = writes[0];
      failWrite = false;
      await click("Retry exact task attention seen");
      expect(writes[1]).toBe(original);
    },
  );

  interaction(
    "answers the exact recorded question and gate through the real command atom",
    async () => {
      await render();
      expect(host.textContent).toContain(question.body);
      expect(host.textContent).toContain("Mark seen is unavailable");
      await openAnswer();
      await click("Keep history");
      await click("Submit answer");
      expect(writes).toHaveLength(1);
      expect(decodeWrite(writes[0])).toMatchObject({
        type: "project-team.question.answer",
        projectId,
        taskId: task.taskId,
        expectedRevision: 10,
        expectedTaskRevision: 4,
        specRevision: 0,
        planRevision: 0,
        questionId: question.recordId,
        expectedQuestionRevision: 2,
        expectedGateRevision: 2,
        answer: "Keep history",
      });
      expect(writes[0]).not.toHaveProperty("actor");
    },
  );
  interaction(
    "preserves the answer and original command through uncertainty and reconnect",
    async () => {
      await render();
      await openAnswer();
      await click("Keep history");
      failWrite = true;
      await click("Submit answer");
      const original = writes[0];
      expect(original).toBeDefined();
      await render(false);
      expect(button("Retry exact answer")?.disabled).toBe(true);
      await render();
      failWrite = false;
      await click("Retry exact answer");
      expect(writes).toEqual([original, original]);
    },
  );
  interaction("fences repeated native clicks while an actual write is held", async () => {
    await render();
    await openAnswer();
    await click("Keep history");
    holdWrite = true;
    const submit = button("Submit answer")!;
    await act(async () => {
      submit.click();
      submit.click();
      await writeStarted;
    });
    expect(writes).toHaveLength(1);
    await act(async () => {
      releaseWrite();
    });
    expect(writes).toHaveLength(1);
  });
  interaction("keeps a conflict draft when another device revises the question", async () => {
    await render();
    await openAnswer();
    await click("Keep history");
    records = records.map((item) =>
      typeof item === "object" &&
      item !== null &&
      "recordId" in item &&
      item.recordId === question.recordId
        ? { ...question, revision: 3 }
        : item,
    );
    revision = 11;
    taskRevision = 11;
    await refresh();
    expect(host.textContent).toContain("Question changed");
    expect(button("Submit answer")?.disabled).toBe(true);
    expect(writes).toEqual([]);
    await click("Use current question");
    await click("Submit answer");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      expectedQuestionRevision: 3,
      answer: "Keep history",
      expectedRevision: 11,
    });
  });
  interaction("shows answered and canceled history without answer controls", async () => {
    records = [
      member,
      role,
      binding,
      membership,
      gate,
      { ...question, status: "answered", answer: "Keep history", seenAt: at },
      { ...question, recordId: "canceled-question", status: "canceled", body: "Canceled question" },
    ];
    await render();
    await click("Answered");
    expect(host.textContent).toContain("Keep history");
    expect(host.textContent).toContain("Seen");
    expect(button("Answer question")).toBeUndefined();
    await click("Canceled");
    expect(host.textContent).toContain("Canceled question");
    expect(writes).toEqual([]);
  });
  for (const change of ["gate", "member", "binding", "unknown", "scope"]) {
    interaction(
      "blocks an answer when current " + change + " data changes before React commits",
      async () => {
        await render();
        await openAnswer();
        await click("Keep history");
        const submit = button("Submit answer")!;
        let notify!: () => void;
        const clicked = new Promise<void>((resolve) => {
          notify = resolve;
        });
        let once = false;
        const dispose = registry.subscribe(
          atoms.foundationPage({ environmentId, projectId }),
          (value) => {
            const raw = Option.getOrNull(AsyncResult.value(value));
            if (
              once ||
              value._tag !== "Success" ||
              value.waiting ||
              typeof raw !== "object" ||
              raw === null ||
              !("revision" in raw) ||
              raw.revision !== 11
            )
              return;
            once = true;
            submit.click();
            notify();
          },
        );
        records =
          change === "gate"
            ? records.map((item) => (item === gate ? { ...gate, revision: 3 } : item))
            : change === "member"
              ? records.filter((item) => item !== member)
              : change === "binding"
                ? records.map((item) =>
                    item === binding ? { ...binding, environmentId: "foreign" } : item,
                  )
                : change === "scope"
                  ? records.map((item) =>
                      item === question ? { ...question, projectId: "foreign" } : item,
                    )
                  : [
                      ...records,
                      {
                        ...baseRecord,
                        kind: "future-record",
                        recordId: "future",
                        status: "future",
                      },
                    ];
        revision = 11;
        await act(async () => {
          registry.refresh(atoms.foundationPage({ environmentId, projectId }));
          await clicked;
        });
        dispose();
        expect(writes).toEqual([]);
      },
    );
  }
  interaction("does not carry drafts or pending completions into a different project", async () => {
    await render();
    await openAnswer();
    await click("Keep history");
    holdWrite = true;
    await act(async () => {
      button("Submit answer")!.click();
      await writeStarted;
    });
    records = [];
    await render(true, true, ProjectId.make("project-2"));
    await act(async () => releaseWrite());
    expect(host.textContent).not.toContain(question.body);
    expect(host.textContent).not.toContain("Answer submitted");
    expect(writes).toHaveLength(1);
  });
  interaction(
    "shows recorded run activity and links the actual task without opening transcripts",
    async () => {
      await act(async () => {
        root.render(
          <RegistryContext.Provider value={registry}>
            <WorkPage environmentId={environmentId} projectId={projectId} />
          </RegistryContext.Provider>,
        );
      });
      await click("Team");
      await act(async () => settle(atoms.foundationPage({ environmentId, projectId })));
      expect(host.textContent).toContain("actual-model");
      expect(host.textContent).toContain("Waiting for human answer");
      expect(
        host.querySelector<HTMLAnchorElement>('a[href="/environment-1/worker-thread"]'),
      ).not.toBeNull();
      taskPages.set(0, { projectId, revision: 10, items: [], hasMore: false });
      await click("Open task task-1");
      await act(async () => {
        await settle(atoms.page({ environmentId, projectId, collection: "tasks", offset: 0 }));
        await settle(atoms.taskContext({ environmentId, projectId, taskId: task.taskId }));
      });
      expect(host.textContent).toContain(task.title);
      await act(async () => {
        const control =
          host.querySelector<HTMLSelectElement>('select[aria-label="Task action"]') ??
          host.querySelector<HTMLSelectElement>("select");
        expect(control).not.toBeNull();
        control!.value = "pause";
        control!.dispatchEvent(new Event("change", { bubbles: true }));
        const reason = host.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Control reason"]',
        );
        expect(reason).not.toBeNull();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
          reason,
          "Human reviewed the assignment",
        );
        reason!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(button("Apply pause")?.disabled).toBe(false);
      expect(writes).toEqual([]);
      await click("Apply pause");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        type: "project-team.task.control",
        taskId: task.taskId,
        control: { action: "pause" },
      });
    },
  );
  interaction(
    "keeps an original uncertain answer when another device records its receipt",
    async () => {
      await render();
      await openAnswer();
      await click("Keep history");
      failWrite = true;
      await click("Submit answer");
      const original = writes[0];
      records = records.map((item) =>
        item === question
          ? { ...question, status: "answered", answer: "Keep history", revision: 3 }
          : item,
      );
      revision = 11;
      taskRevision = 11;
      await refresh();
      failWrite = false;
      await click("Retry exact answer");
      expect(writes).toEqual([original, original]);
      expect(host.textContent).toContain("Answer submitted");
    },
  );
  interaction(
    "shows an authoritative permission rejection without mutating question state",
    async () => {
      await render();
      await openAnswer();
      await click("Keep history");
      denyWrite = true;
      await click("Submit answer");
      expect(writes).toHaveLength(1);
      expect(host.textContent).toContain("Human credential cannot answer");
      expect(button("Retry exact answer")?.disabled).toBe(true);
      expect(host.textContent).toContain("pending");
    },
  );
  interaction(
    "retains the exact uncertain command when visiting Team and returning to Inbox",
    async () => {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <WorkPage environmentId={environmentId} projectId={projectId} />
          </RegistryContext.Provider>,
        ),
      );
      await click("Inbox");
      await act(async () => settle(atoms.foundationPage({ environmentId, projectId })));
      await openAnswer();
      await click("Keep history");
      failWrite = true;
      await click("Submit answer");
      const original = writes[0];
      await click("Team");
      await click("Inbox");
      failWrite = false;
      await click("Retry exact answer");
      expect(writes).toEqual([original, original]);
    },
  );
  interaction(
    "preserves a freeform draft through a failed read and a complete recovery",
    async () => {
      records = records.map((item) => (item === question ? { ...question, choices: [] } : item));
      await render();
      await openAnswer();
      const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your answer"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
          input,
          "Keep durable history",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      foundationFailure = true;
      await refresh();
      expect(host.querySelector('textarea[aria-label="Your answer"]')).toBe(input);
      expect(input.value).toBe("Keep durable history");
      expect(button("Submit answer")?.disabled).toBe(true);
      foundationFailure = false;
      await refresh();
      await click("Submit answer");
      expect(writes[0]).toMatchObject({ answer: "Keep durable history" });
    },
  );
  interaction("does not reuse a question draft after changing environments", async () => {
    await render();
    await openAnswer();
    await click("Keep history");
    await render(true, true, projectId, EnvironmentId.make("environment-2"));
    expect(button("Submit answer")).toBeUndefined();
    await click("Answer question");
    await act(async () =>
      settle(
        atoms.taskContext({
          environmentId: EnvironmentId.make("environment-2"),
          projectId,
          taskId: task.taskId,
        }),
      ),
    );
    expect(button("Submit answer")?.disabled).toBe(true);
    expect(button("Keep history")?.getAttribute("aria-pressed")).toBe("false");
    expect(writes).toEqual([]);
  });
  for (const broken of [
    "missing-member",
    "foreign-binding",
    "wrong-task-context",
    "deleted-task",
  ]) {
    interaction("disables rendered answers for " + broken, async () => {
      if (broken === "missing-member") records = records.filter((item) => item !== member);
      if (broken === "foreign-binding")
        records = records.map((item) =>
          item === binding ? { ...binding, environmentId: "foreign" } : item,
        );
      if (broken === "wrong-task-context")
        contextOverride = {
          projectId: "foreign",
          revision: 10,
          task: { ...task, projectId: "foreign" },
          criteria: [],
          evidence: [],
          comments: [],
          relationships: [],
          blockers: [],
        };
      if (broken === "deleted-task") contextOverride = null;
      await render();
      await openAnswer();
      await click("Keep history");
      expect(button("Submit answer")?.disabled).toBe(true);
      await click("Submit answer");
      expect(writes).toEqual([]);
    });
  }
  interaction(
    "pages a complete question snapshot while bounding each read and rendered list",
    async () => {
      const questions = Array.from({ length: 129 }, (_, index) => ({
        ...question,
        recordId: "question-" + index,
        body: "Question " + index,
      }));
      const all = [member, role, binding, membership, gate, ...questions];
      foundations.set("", {
        projectId,
        revision: 10,
        items: all.slice(0, 128),
        nextCursor: "next",
      });
      foundations.set("next", { projectId, revision: 10, items: all.slice(128) });
      await render();
      await act(async () =>
        settle(atoms.foundationPage({ environmentId, projectId, cursor: "next" })),
      );
      expect(host.querySelectorAll("section")).toHaveLength(128);
      expect(
        reads
          .filter((input) => input.operation === "foundation-records")
          .every((input) => input.limit === 128),
      ).toBe(true);
      expect(reads.some((input) => input.operation === "task-context")).toBe(false);
      await click("Next question page");
      expect(host.querySelectorAll("section")).toHaveLength(1);
      expect(host.textContent).toContain("Question 128");
      expect(writes).toEqual([]);
    },
  );
  for (const status of ["reserved", "stopping", "quarantined", "failed", "disconnected"]) {
    interaction("renders recorded team " + status + " activity", async () => {
      records = [
        member,
        role,
        membership,
        {
          ...binding,
          status: status === "failed" || status === "disconnected" ? "running" : status,
        },
      ];
      if (status === "failed")
        records.push({
          ...baseRecord,
          kind: "effect",
          recordId: "effect-1",
          status: "failed",
          effectId: "effect-id",
          effectKind: "dispatch",
          taskId: task.taskId,
          runId: binding.recordId,
          targetId: binding.recordId,
          payload: { recordIds: [], expectedRevision: 10 },
          claimGeneration: 1,
          availableAt: at,
          outcome: "Worker start rejected",
        });
      await act(async () => {
        root.render(
          <RegistryContext.Provider value={registry}>
            <Team
              environmentId={environmentId}
              projectId={projectId}
              connected={status !== "disconnected"}
              enabled
              supported
              onOpenTask={() => {}}
            />
          </RegistryContext.Provider>,
        );
        await settle(atoms.foundationPage({ environmentId, projectId }));
      });
      expect(host.textContent).toContain(
        status === "reserved"
          ? "Queued"
          : status === "failed"
            ? "Effect failed"
            : status[0]!.toUpperCase() + status.slice(1),
      );
      if (status === "failed") expect(host.textContent).toContain("Worker start rejected");
      if (status === "disconnected")
        expect(host.textContent).toContain("Last recorded update " + at);
      expect(reads.every((input) => input.operation === "foundation-records")).toBe(true);
      expect(writes).toEqual([]);
    });
  }
  interaction("keeps a held answer owned by its editor until its command settles", async () => {
    records.push({ ...question, recordId: "question-2", body: "Another decision" });
    await render();
    await openAnswer();
    await click("Keep history");
    holdWrite = true;
    await act(async () => {
      button("Submit answer")!.click();
      await writeStarted;
    });
    const other = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(
      (item) => item.textContent === "Answer question",
    )[1]!;
    expect(other.disabled).toBe(true);
    await act(async () => {
      other.click();
      releaseWrite();
    });
    expect(host.textContent).toContain("Answer submitted");
    expect(writes).toHaveLength(1);
  });
  interaction("cannot answer while a fresh task context read is held", async () => {
    await render();
    holdContext = true;
    await act(async () => {
      button("Answer question")!.click();
      await contextStarted;
    });
    await click("Keep history");
    expect(button("Submit answer")?.disabled).toBe(true);
    await act(async () => {
      holdContext = false;
      releaseContext();
      await settle(atoms.taskContext({ environmentId, projectId, taskId: task.taskId }));
    });
    expect(button("Submit answer")?.disabled).toBe(false);
    await click("Submit answer");
    expect(writes).toHaveLength(1);
  });

  for (const status of ["approved", "consumed", "rejected", "invalidated", "future-gate"]) {
    interaction("uses recorded " + status + " gate answerability", async () => {
      records = records.map((item) => (item === gate ? { ...gate, status } : item));
      await render();
      await openAnswer();
      await click("Keep history");
      const allowed = status === "approved" || status === "consumed";
      expect(button("Submit answer")?.disabled).toBe(!allowed);
      await click("Submit answer");
      expect(writes).toHaveLength(allowed ? 1 : 0);
    });
  }
  const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
  const checkRecords = () => records.forEach((record) => decodeRecord(record));
  async function renderTeam(connected = true) {
    checkRecords();
    await act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <Team
            environmentId={environmentId}
            projectId={projectId}
            connected={connected}
            enabled
            supported
            onOpenTask={() => {}}
          />
        </RegistryContext.Provider>,
      );
      await settle(atoms.foundationPage({ environmentId, projectId }));
    });
  }
  async function beginHeldAnswer() {
    checkRecords();
    await render();
    await openAnswer();
    await click("Keep history");
    holdWrite = true;
    await act(async () => {
      button("Submit answer")!.click();
      await writeStarted;
    });
    expect(writes).toHaveLength(1);
  }
  interaction(
    "control: a held answer keeps its receipt across a same-owner disconnect",
    async () => {
      await beginHeldAnswer();
      await render(false);
      await act(async () => releaseWrite());
      await render();
      expect(host.textContent).toContain("Answer submitted");
      expect(host.textContent).not.toContain("Sending answer…");
    },
  );
  interaction(
    "R1: a held receipt survives a same-owner unsupported capability interlude",
    async () => {
      await beginHeldAnswer();
      await render(true, false);
      expect(host.textContent).toContain("does not support the question inbox");
      await act(async () => releaseWrite());
      await render();
      await openAnswer();
      expect(host.textContent).toContain("Answer submitted");
      expect(host.textContent).not.toContain("Sending answer…");
    },
  );
  interaction("R1b: a temporarily unknown question cannot strand a completed write", async () => {
    await beginHeldAnswer();
    records = records.map((item) =>
      item === question ? { ...question, status: "future-question-status" } : item,
    );
    revision = taskRevision = 11;
    await refresh();
    expect(host.textContent).toContain("selected question is no longer available");
    await act(async () => releaseWrite());
    records = records.map((item) =>
      typeof item === "object" &&
      item !== null &&
      "recordId" in item &&
      item.recordId === question.recordId
        ? question
        : item,
    );
    checkRecords();
    revision = taskRevision = 12;
    await refresh();
    expect(host.textContent).toContain("Answer submitted");
    expect(host.textContent).not.toContain("Sending answer…");
  });
  interaction(
    "control: foundation read failure preserves a held editor and success receipt",
    async () => {
      await beginHeldAnswer();
      foundationFailure = true;
      await refresh();
      await act(async () => releaseWrite());
      foundationFailure = false;
      await refresh();
      expect(host.textContent).toContain("Answer submitted");
      expect(writes).toHaveLength(1);
    },
  );
  interaction(
    "R2: a settled run keeps its terminal badge while a task question is pending",
    async () => {
      records = records.map((item) =>
        item === binding ? { ...binding, status: "settled" } : item,
      );
      await renderTeam();
      const card = host.querySelector("section")!;
      expect(card.textContent).toContain("Recorded state settled");
      expect(card.textContent).not.toContain("Waiting for human answer");
    },
  );
  interaction(
    "R2b: another member's pending question does not put a running member into waiting",
    async () => {
      records.push({ ...member, recordId: "member-2", name: "Second worker" });
      records.push({
        ...binding,
        recordId: "run-2",
        memberId: "member-2",
        attemptId: "attempt-2",
        threadId: "thread-2",
      });
      await renderTeam();
      const other = [...host.querySelectorAll("section")].find((item) =>
        item.textContent?.includes("Second worker"),
      )!;
      expect(other.textContent).toContain("Recorded state running");
      expect(other.textContent).not.toContain("Waiting for human answer");
    },
  );

  interaction("control: another project's late receipt cannot reach a fresh owner", async () => {
    await beginHeldAnswer();
    records = [];
    await render(true, true, ProjectId.make("other-project"));
    await act(async () => releaseWrite());
    expect(host.textContent).not.toContain("Answer submitted");
    expect(host.textContent).not.toContain(question.body);
    expect(writes).toHaveLength(1);
  });
  interaction(
    "R1 current receipt: answered state cannot strand another pending question",
    async () => {
      records.push({ ...question, recordId: "other-question", body: "Another current request" });
      await beginHeldAnswer();
      await render(true, false);
      records = records.map((item) =>
        item === question
          ? { ...question, status: "answered", answer: "Keep history", revision: 3 }
          : item,
      );
      revision = taskRevision = 11;
      checkRecords();
      await act(async () => releaseWrite());
      await render();
      await refresh();
      const other = button("Answer question")!;
      expect(other.disabled).toBe(false);
      expect(host.textContent).not.toContain("Sending answer…");
      await click("Answer question");
      await click("Keep history");
      await click("Submit answer");
      expect(writes).toHaveLength(2);
      expect(writes[1]?.type).toBe("project-team.question.answer");
      expect(writes[1] && "questionId" in writes[1] ? writes[1].questionId : undefined).toBe(
        "other-question",
      );
    },
  );
  interaction(
    "R1 uncertain receipt: temporary editor unmount must retain a retryable exact command",
    async () => {
      await beginHeldAnswer();
      await render(true, false);
      failWrite = true;
      await act(async () => releaseWrite());
      await render();
      await openAnswer();
      expect(button("Retry exact answer")?.disabled).toBe(false);
      expect(host.textContent).not.toContain("Sending answer…");
      const original = writes[0];
      failWrite = false;
      await click("Retry exact answer");
      expect(writes).toHaveLength(2);
      expect(writes[1]).toBe(original);
      expect(host.textContent).toContain("Answer submitted");
    },
  );

  interaction("R1 unknown question retains uncertainty and retries its exact command", async () => {
    await beginHeldAnswer();
    const original = writes[0];
    records = records.map((item) =>
      item === question ? { ...question, status: "future-question-status" } : item,
    );
    revision = taskRevision = 11;
    await refresh();
    failWrite = true;
    await act(async () => releaseWrite());
    records = [member, role, binding, membership, gate, question];
    revision = taskRevision = 12;
    await refresh();
    expect(button("Retry exact answer")?.disabled).toBe(false);
    failWrite = false;
    await click("Retry exact answer");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(original);
    expect(host.textContent).toContain("Answer submitted");
  });
  for (const status of ["settled", "revoked", "reserved"]) {
    interaction(
      "R2 preserves recorded " + status + " over a sender's pending question",
      async () => {
        records = records.map((item) =>
          item === binding
            ? { ...binding, status }
            : item === membership && status !== "reserved"
              ? { ...membership, controlState: "canceling" }
              : item,
        );
        await renderTeam();
        expect(host.textContent).toContain("Recorded state " + status);
        expect(host.textContent).not.toContain("Waiting for human answer");
        if (status !== "reserved") expect(host.textContent).not.toContain("Stopping");
        else expect(host.textContent).toContain("Queued");
      },
    );
  }
});
