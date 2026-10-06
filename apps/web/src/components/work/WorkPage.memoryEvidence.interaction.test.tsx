/* @vitest-environment happy-dom */

import { RegistryContext } from "@effect/atom-react";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { createProjectWorkEnvironmentAtoms } from "@t3tools/client-runtime/project-work";
import { makeWsRpcProtocolClient, type RpcSession } from "@t3tools/client-runtime/rpc";
import {
  EnvironmentId,
  ProjectId,
  ProjectMemoryExtraction,
  ProjectMemoryObservation,
  ProjectMemorySource,
  ProjectWorkReadIntent,
  ProjectTeamEvidenceApplicability,
  ProjectWorkTaskId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { act, Profiler, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vite-plus/test";

const bridge = vi.hoisted(() => {
  const state: { atoms: unknown; config: unknown; phase: string } = {
    atoms: undefined,
    config: undefined,
    phase: "connected",
  };
  return state;
});
vi.mock("~/state/projectWork", () => ({
  get projectWorkEnvironment() {
    return bridge.atoms;
  },
}));

vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: bridge.phase } }),
}));
vi.mock("~/state/entities", () => ({ useProject: () => ({ title: "Remote project" }) }));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => bridge.config } }));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock("../WorkspacePageContainer", () => ({
  WorkspacePageContainer: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
}));

import { WorkPage } from "./WorkPage";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const projectId = ProjectId.make("project-1");
const at = "2026-10-04T10:00:00.000Z";
const decodeRead = Schema.decodeUnknownEffect(ProjectWorkReadIntent);
function receipt() {
  let resolve = () => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const base = { projectId, revision: 1, generation: 2, updatedAt: at };
const attribution = {
  actor: { kind: "agent", id: "investigator" },
  source: { kind: "mcp", id: "finding-1" },
  recordedAt: at,
};
const source = Schema.decodeUnknownSync(ProjectMemorySource)({
  ...base,
  kind: "memory-source",
  recordId: "source-1",
  status: "current",
  sourceKind: "finding",
  sourceId: "logical-finding",
  sourceRevision: 3,
  content: "Current retained source text",
  contentHash: "source-hash",
  attribution,
  sharedWithProjectIds: ["shared-project"],
});
const extraction = Schema.decodeSync(ProjectMemoryExtraction)({
  ...base,
  kind: "memory-extraction",
  recordId: "extraction-1",
  status: "extracted",
  engine: "mem0",
  engineVersion: "2.2.1",
  sourceId: source.recordId,
  sourceRevision: source.sourceRevision,
  sourceGeneration: source.generation,
  extractionModel: "recorded-extraction-model",
  embeddingModel: "recorded-embedding-model",
  embeddingDimensions: 2048,
  expectedObservationIds: ["observation-1"],
  completedObservationIds: [],
  extractionHash: "extraction-hash",
});
const observation = Schema.decodeUnknownSync(ProjectMemoryObservation)({
  ...base,
  kind: "memory-observation",
  recordId: "observation-1",
  status: "current",
  sourceId: source.recordId,
  sourceRevision: source.sourceRevision,
  sourceGeneration: source.generation,
  extractionId: extraction.recordId,
  observationKey: "fact-1",
  body: "Current extracted observation text",
  provenance: attribution,
});
const taskId = ProjectWorkTaskId.make("task-1");
const otherTaskId = ProjectWorkTaskId.make("task-2");
const task = {
  projectId,
  taskId,
  title: "Actual linked task detail",
  state: "draft",
  watchers: [],
  revision: 1,
  specRevision: 0,
  createdAt: at,
  updatedAt: at,
};
const evidence = Schema.decodeSync(ProjectTeamEvidenceApplicability)({
  ...base,
  kind: "evidence-applicability",
  recordId: "evidence-record-1",
  status: "current",
  taskId,
  evidenceId: "evidence-1",
  specRevision: 0,
  planRevision: 0,
  repository: "owner/repo",
  worktree: "/sandbox/tested",
  testedTree: "tested-tree",
  baseSha: "base",
  headSha: "head",
  command: "vp test run focused.test.ts",
  exitCode: 0,
  artifactId: "actual-raw-evidence",
  environmentSummary: "controlled fixture",
  integration: false,
});

type FixtureConfig = {
  settings: { projectWorkEnabled: boolean };
  environment: {
    capabilities: {
      projectTeamFoundationReads?: boolean;
      projectTeamGuidedWrites: boolean;
      projectWorkStream: boolean;
    };
  };
};

describe("WorkPage mounts real Memory and Evidence over encoded generated RPC", () => {
  let root: Root;
  let host: HTMLDivElement;
  let registry: AtomRegistry.AtomRegistry;
  let atoms: ReturnType<typeof createProjectWorkEnvironmentAtoms>;
  let records: unknown[];
  let revision: number;
  let pages: Map<string, unknown>;
  let reads: Array<{
    readonly environmentId: EnvironmentId;
    readonly input: ProjectWorkReadIntent;
  }>;
  let held:
    | {
        readonly cursor: string;
        readonly started: ReturnType<typeof receipt>;
        readonly released: ReturnType<typeof receipt>;
      }
    | undefined;
  let fail: boolean;
  let otherRequests: string[];
  let config: Atom.Writable<FixtureConfig>;
  let committedText: string[];

  const setup = Effect.gen(function* () {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    records = [source, extraction, observation, evidence];
    revision = 10;
    pages = new Map();
    reads = [];
    held = undefined;
    fail = false;
    otherRequests = [];
    committedText = [];
    bridge.phase = "connected";
    config = Atom.make<FixtureConfig>({
      settings: { projectWorkEnabled: true },
      environment: {
        capabilities: {
          projectTeamFoundationReads: true,
          projectTeamGuidedWrites: false,
          projectWorkStream: false,
        },
      },
    });
    bridge.config = config;
    const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
    for (const id of [environmentId, otherEnvironmentId]) {
      // Use the actual generated client, decoding every request through its wire schema.
      const protocol = yield* RpcClient.Protocol.make((write) =>
        Effect.succeed({
          codecFor: RpcSerialization.json.codecFor,
          supportsAck: false,
          supportsTransferables: false,
          send: (clientId, request) =>
            Effect.gen(function* () {
              if (request._tag !== "Request") return;
              if (request.tag !== WS_METHODS.projectWorkRead) {
                otherRequests.push(request.tag);
                return yield* Effect.die("Unexpected RPC method");
              }
              const input = yield* decodeRead(request.payload).pipe(Effect.orDie);

              reads.push({ environmentId: id, input });
              const value =
                input.operation === "foundation-records"
                  ? (pages.get(input.cursor ?? "") ?? {
                      projectId: input.projectId,
                      revision,
                      items: input.cursor ? [] : records,
                    })
                  : input.operation === "briefing"
                    ? {
                        projectId: input.projectId,
                        text: `Overview for ${id}/${input.projectId}`,
                        sourceRevision: revision,
                        includedTaskIds: [],
                        includedKnowledgeIds: [],
                        omittedReasons: [],
                      }
                    : input.operation === "task-context"
                      ? {
                          projectId: input.projectId,
                          revision,
                          task: { ...task, projectId: input.projectId, taskId: input.taskId },
                          policy: {
                            taskId: input.taskId,
                            readiness: { ready: false, reasons: [] },
                            claimability: { claimable: false },
                            actions: {},
                            attention: [],
                          },
                          children: {
                            criteria: [],
                            evidence: [],
                            relationships: [],
                            blockers: [],
                            comments: [],
                          },
                          criteria: [],
                          evidence: [],
                          relationships: [],
                          blockers: [],
                          comments: [],
                        }
                      : input.operation === "tasks"
                        ? { projectId: input.projectId, revision, items: [], hasMore: false }
                        : input.operation === "attention"
                          ? (pages.get(`attention:${input.offset ?? 0}`) ?? {
                              projectId: input.projectId,
                              revision,
                              offset: input.offset ?? 0,
                              limit: input.limit,
                              hasMore: false,
                              items: [],
                            })
                          : input.operation === "knowledge"
                            ? {
                                projectId: input.projectId,
                                revision,
                                items: [
                                  {
                                    projectId: input.projectId,
                                    knowledgeId: "knowledge-1",
                                    title: "Existing project knowledge",
                                    body: "Retained manual knowledge",
                                    sourceKind: "manual",
                                    updatedAt: at,
                                  },
                                ],
                              }
                            : [];
              const gate = held;
              if (
                input.operation === "foundation-records" &&
                gate?.cursor === (input.cursor ?? "")
              ) {
                gate.started.resolve();
                yield* Effect.promise(() => gate.released.promise);
              }
              return yield* write(clientId, {
                _tag: "Exit",
                requestId: request.id,
                exit: fail
                  ? { _tag: "Failure", cause: [{ _tag: "Die", defect: "connection lost" }] }
                  : { _tag: "Success", value },
              });
            }),
        }),
      );
      const client = yield* makeWsRpcProtocolClient.pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      );
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: client.subscribeServerConfig,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      supervisors.set(
        id,
        EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: "test",
            httpBaseUrl: "http://test",
            wsBaseUrl: "ws://test",
          }),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
            generation: 1,
          }),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        }),
      );
    }
    const supervisorFor = (id: EnvironmentId) => {
      const value = supervisors.get(id);
      if (!value) throw new Error("Unknown test environment");
      return value;
    };
    const environments = EnvironmentRegistry.of({
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
      state: (id) => SubscriptionRef.get(supervisorFor(id).state),
      stateChanges: (id) => SubscriptionRef.changes(supervisorFor(id).state),
      run: (id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisorFor(id)),
      runStream: (id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor, supervisorFor(id)),
      followStream: (id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor, supervisorFor(id)),
    });
    registry = AtomRegistry.make();
    atoms = createProjectWorkEnvironmentAtoms(
      Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
    );
    bridge.atoms = atoms;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  function interaction(name: string, body: () => Promise<void>) {
    it.effect(name, () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setup;
          yield* Effect.promise(body);
        }),
      ),
    );
  }
  afterEach(async () => {
    held?.released.resolve();
    if (root) await act(async () => root.unmount());
    registry?.dispose();
    host?.remove();
  });
  function settle(
    target: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly cursor?: string;
    } = { environmentId, projectId },
  ) {
    const atom = atoms.foundationPage(target);
    return new Promise<void>((resolve) => {
      let dispose = () => {};
      let done = false;
      dispose = registry.subscribe(
        atom,
        (value) => {
          if (!AsyncResult.isInitial(value) && !value.waiting) {
            done = true;
            dispose();
            resolve();
          }
        },
        { immediate: true },
      );
      if (done) dispose();
    });
  }
  async function render({
    connected = true,
    project = projectId,
    environment = environmentId,
  } = {}) {
    bridge.phase = connected ? "connected" : "disconnected";
    await act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <Profiler id="work" onRender={() => committedText.push(host.textContent ?? "")}>
            <WorkPage environmentId={environment} projectId={project} />
          </Profiler>
        </RegistryContext.Provider>,
      );
    });
  }
  async function configure({
    enabled = true,
    supported = true,
  }: { enabled?: boolean; supported?: boolean } = {}) {
    await act(async () =>
      registry.set(config, {
        settings: { projectWorkEnabled: enabled },
        environment: {
          capabilities: {
            ...(supported ? { projectTeamFoundationReads: true } : {}),
            projectTeamGuidedWrites: false,
            projectWorkStream: false,
          },
        },
      }),
    );
  }
  async function navigate(label: string, owner = { environmentId, projectId }, wait = true) {
    const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (item) => item.textContent?.trim() === label,
    );
    expect(tab).toBeDefined();
    await act(async () => tab?.click());
    if (wait && ["Memory", "Evidence", "Inbox", "Team"].includes(label))
      await act(async () => settle(owner));
  }
  function noWrites() {
    expect(otherRequests).toEqual([]);
    expect(
      reads.every(({ input }) =>
        [
          "foundation-records",
          "briefing",
          "task-context",
          "tasks",
          "knowledge",
          "decisions",
          "attention",
        ].includes(input.operation),
      ),
    ).toBe(true);
  }
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === label,
    );
  async function click(label: string) {
    const item = button(label);
    expect(item).toBeDefined();
    await act(async () => item?.click());
  }
  async function inspect(id: string) {
    await click(`Inspect ${id}`);
  }
  function hideBodies() {
    expect(host.textContent).not.toContain(source.content);
    expect(host.textContent).not.toContain(observation.body);
  }

  interaction(
    "lazily opens memory metadata and freshly recorded bodies while retaining Knowledge",
    async () => {
      await render();
      expect(reads.some(({ input }) => input.operation === "foundation-records")).toBe(false);
      await navigate("Memory");
      expect(host.textContent).toContain("Current recorded memory");
      hideBodies();
      await inspect(source.recordId);
      expect(host.textContent).toContain(source.content);
      await inspect(observation.recordId);
      expect(host.textContent).toContain(observation.body);
      await navigate("Knowledge");
      await act(async () =>
        settleAtom(atoms.page({ environmentId, projectId, collection: "knowledge", offset: 0 })),
      );
      expect(host.textContent).toContain("Existing project knowledge");
      expect(host.textContent).not.toContain("Inspecting observation-1");
      await navigate("Memory");
      hideBodies();
      expect(host.textContent).not.toContain("Inspecting observation-1");
      noWrites();
    },
  );
  interaction(
    "withholds memory bodies during a held refresh until the encoded receipt completes",
    async () => {
      await render();
      await navigate("Memory");
      await inspect(observation.recordId);
      held = { cursor: "", started: receipt(), released: receipt() };
      await click("Refresh memory");
      await held.started.promise;
      hideBodies();
      expect(host.textContent).toContain("Cached or incomplete memory");
      await act(async () => {
        held?.released.resolve();
        await settle();
      });
      expect(host.textContent).toContain(observation.body);
      noWrites();
    },
  );
  for (const [name, changed, notice] of [
    ["tombstoned source", { ...source, tombstonedAt: at }, "Retracted at"],
    [
      "unknown source status",
      { ...source, status: "future-state" },
      "Unsupported records are present",
    ],
  ] satisfies ReadonlyArray<readonly [string, unknown, string]>) {
    interaction(`mounted Memory handles ${name} without publishing bodies`, async () => {
      records = [changed, extraction, observation];
      await render();
      await navigate("Memory");
      await inspect(source.recordId);
      hideBodies();
      expect(host.textContent).toContain(notice);
      await inspect(observation.recordId);
      hideBodies();
      noWrites();
    });
  }
  interaction(
    "opens actual selected task detail from Evidence and returns to full-project Evidence",
    async () => {
      records.push({
        ...evidence,
        recordId: "evidence-record-2",
        evidenceId: "evidence-2",
        taskId: otherTaskId,
        artifactId: "second-task-evidence",
      });
      await render();
      await navigate("Evidence");
      expect(host.textContent).toContain("actual-raw-evidence");
      expect(host.textContent).toContain("second-task-evidence");
      await click(`Open task ${taskId}`);
      await act(async () => settleAtom(atoms.taskContext({ environmentId, projectId, taskId })));
      expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
        "Tasks",
      );
      expect(host.textContent).toContain(task.title);
      expect(reads).toContainEqual({
        environmentId,
        input: { projectId, operation: "task-context", taskId },
      });
      await navigate("Evidence");
      expect(host.textContent).toContain("second-task-evidence");
      noWrites();
    },
  );
  for (const label of ["Memory", "Evidence"]) {
    interaction(
      `${label} uses explicit capability negotiation and performs no unavailable read`,
      async () => {
        await render();
        await configure({ supported: false });
        await navigate(label, undefined, false);
        expect(host.textContent).toContain(`does not support ${label.toLowerCase()} inspection`);
        expect(reads.some(({ input }) => input.operation === "foundation-records")).toBe(false);
        await configure();
        await act(async () => settle());
        expect(host.textContent).toContain(
          label === "Memory" ? "Current recorded memory" : "actual-raw-evidence",
        );
        noWrites();
      },
    );
    interaction(
      `${label} reflects disconnect and disabled Work without authoritative actions`,
      async () => {
        await render();
        await navigate(label);
        if (label === "Memory") await inspect(observation.recordId);
        await render({ connected: false });
        expect(host.textContent).toContain("Offline view");
        expect(button(`Refresh ${label.toLowerCase()}`)?.disabled).toBe(true);
        if (label === "Memory") hideBodies();
        else expect(host.textContent).toContain("actual-raw-evidence");
        await configure({ enabled: false });
        expect(host.textContent).toContain("Project Work is turned off");
        expect(host.textContent).not.toContain("actual-raw-evidence");
        await configure();
        await render();
        await act(async () => settle());
        noWrites();
      },
    );
  }
  for (const changed of ["environment", "project"]) {
    interaction(
      `${changed} switching resets Memory before any new-owner commit and ignores held old replies`,
      async () => {
        await render();
        await navigate("Memory");
        await inspect(observation.recordId);
        held = { cursor: "", started: receipt(), released: receipt() };
        await click("Refresh memory");
        await held.started.promise;
        const gate = held;
        held = undefined;
        records = [];
        const owner = {
          environmentId: changed === "environment" ? otherEnvironmentId : environmentId,
          projectId: changed === "project" ? ProjectId.make("project-2") : projectId,
        };
        committedText = [];
        await render({ environment: owner.environmentId, project: owner.projectId });
        expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
          "Overview",
        );
        expect(
          committedText.every(
            (text) =>
              !text.includes("Inspecting observation-1") &&
              !text.includes(source.content) &&
              !text.includes(observation.body),
          ),
        ).toBe(true);
        await navigate("Memory", owner);
        await act(async () => gate.released.resolve());
        hideBodies();
        expect(host.textContent).not.toContain("observation-1");
        expect(
          reads.some(
            (read) =>
              read.environmentId === owner.environmentId &&
              read.input.projectId === owner.projectId &&
              read.input.operation === "foundation-records",
          ),
        ).toBe(true);
        noWrites();
      },
    );
    interaction(
      `${changed} switching clears the selected task and cannot read that task under the new owner`,
      async () => {
        await render();
        await navigate("Evidence");
        await click(`Open task ${taskId}`);
        await act(async () => settleAtom(atoms.taskContext({ environmentId, projectId, taskId })));
        const owner = {
          environmentId: changed === "environment" ? otherEnvironmentId : environmentId,
          projectId: changed === "project" ? ProjectId.make("project-2") : projectId,
        };
        records = [];
        reads = [];
        committedText = [];
        await render({ environment: owner.environmentId, project: owner.projectId });
        expect(committedText.every((text) => !text.includes(task.title))).toBe(true);
        await navigate("Tasks", owner);
        await act(async () => settleAtom(atoms.page({ ...owner, collection: "tasks", offset: 0 })));
        expect(host.textContent).not.toContain(task.title);
        expect(reads.some(({ input }) => input.operation === "task-context")).toBe(false);
        noWrites();
      },
    );
  }
  interaction(
    "leaving Evidence drops its view and old reply without changing the current section",
    async () => {
      held = { cursor: "", started: receipt(), released: receipt() };
      await render();
      await navigate("Evidence", undefined, false);
      await held.started.promise;
      await navigate("Overview");
      await act(async () => held?.released.resolve());
      expect(host.textContent).not.toContain("actual-raw-evidence");
      expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
        "Overview",
      );
      noWrites();
    },
  );
  interaction(
    "Inbox draft survives task attention navigation and Memory and Evidence visits without a dispatch",
    async () => {
      records.push(
        {
          ...base,
          kind: "gate",
          recordId: "question-gate",
          status: "pending",
          taskId,
          gate: "investigation",
          specRevision: 0,
          planRevision: 0,
          contentHash: "question-hash",
          evidenceIds: [],
          attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
        },
        {
          ...base,
          kind: "question",
          recordId: "question-1",
          status: "pending",
          taskId,
          senderId: "investigator",
          targetGateId: "question-gate",
          targetRevision: 1,
          body: "Which behavior is intended?",
          choices: ["Keep history", "Start fresh"],
        },
      );
      pages.set("attention:0", {
        projectId,
        revision: 10,
        offset: 0,
        limit: 51,
        hasMore: false,
        items: [
          { taskId, reason: "blocked", detail: "Retained uncertain publication", revision: 1 },
        ],
      });
      await render();
      await navigate("Inbox");
      await act(async () =>
        settleAtom(atoms.page({ environmentId, projectId, collection: "attention", offset: 0 })),
      );
      expect(host.textContent).toContain("Retained uncertain publication");
      await click("Answer question");
      await click("Keep history");
      expect(button("Keep history")?.getAttribute("aria-pressed")).toBe("true");
      const attentionCard = [...host.querySelectorAll("section")].find((item) =>
        item.textContent?.includes("Retained uncertain publication"),
      );
      await act(async () => attentionCard?.querySelector<HTMLButtonElement>("button")?.click());
      await act(async () => settleAtom(atoms.taskContext({ environmentId, projectId, taskId })));
      expect(host.textContent).toContain(task.title);
      expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
        "Tasks",
      );
      await navigate("Inbox");
      expect(button("Keep history")?.getAttribute("aria-pressed")).toBe("true");
      await navigate("Memory");
      await inspect(source.recordId);
      await navigate("Evidence");
      await navigate("Inbox");
      expect(button("Keep history")?.getAttribute("aria-pressed")).toBe("true");
      noWrites();
    },
  );
  for (const changed of ["environment", "project"]) {
    interaction(
      `${changed} switching discards held Evidence before the new owner renders`,
      async () => {
        await render();
        await navigate("Evidence");
        held = { cursor: "", started: receipt(), released: receipt() };
        await click("Refresh evidence");
        await held.started.promise;
        const gate = held;
        held = undefined;
        records = [];
        const owner = {
          environmentId: changed === "environment" ? otherEnvironmentId : environmentId,
          projectId: changed === "project" ? ProjectId.make("project-2") : projectId,
        };
        committedText = [];
        await render({ environment: owner.environmentId, project: owner.projectId });
        expect(
          committedText.every(
            (text) => !text.includes("actual-raw-evidence") && !text.includes("Open task task-1"),
          ),
        ).toBe(true);
        await navigate("Evidence", owner);
        await act(async () => gate.released.resolve());
        expect(host.textContent).not.toContain("actual-raw-evidence");
        expect(button(`Open task ${taskId}`)).toBeUndefined();
        noWrites();
      },
    );
  }
  function settleAtom(atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>) {
    return new Promise<void>((resolve) => {
      let dispose = () => {};
      let done = false;
      dispose = registry.subscribe(
        atom,
        (value) => {
          if (!AsyncResult.isInitial(value) && !value.waiting) {
            done = true;
            dispose();
            resolve();
          }
        },
        { immediate: true },
      );
      if (done) dispose();
    });
  }
});
