/// <reference types="node" />
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
  CommandId,
  ProviderInstanceId,
  ProjectWorkTaskId,
  ProjectTeamRecord,
  ProjectTeamConfigurationIntent,
  ProjectWorkWriteIntent,
  ProjectWorkWriteResult,
  canonicalProjectWorkPayload,
  type ProviderDriverKind,
  ProjectWorkReadIntent,
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
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vite-plus/test";

const bridge = vi.hoisted(() => {
  const state: { atoms: unknown } = { atoms: undefined };
  return state;
});
vi.mock("~/state/projectWork", () => ({
  get projectWorkEnvironment() {
    return bridge.atoms;
  },
}));

import { Configuration } from "./Configuration";
import {
  compileProjectTeamConfiguration,
  assertProjectTeamConfigurationReplay,
} from "../../../../server/src/projectWork/ProjectTeamConfiguration";
import { emptyProjectWorkReducerState } from "../../../../server/src/projectWork/ProjectWorkDecider";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const projectId = ProjectId.make("project-1");
const at = "2026-10-04T10:00:00.000Z";
const decodeRead = Schema.decodeUnknownEffect(ProjectWorkReadIntent);
const decodeWrite = Schema.decodeUnknownEffect(ProjectWorkWriteIntent);
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
const knownRecord = Schema.is(ProjectTeamRecord);
const encodeResult = Schema.encodeEffect(ProjectWorkWriteResult);
function receipt() {
  let resolve = () => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const attribution = { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at } as const;
const roles = [
  "coordinator",
  "investigator",
  "planner",
  "implementer",
  "reviewer",
  "integrator",
] as const;
const task = {
  taskId: ProjectWorkTaskId.make("task-1"),
  projectId,
  title: "Current task",
  state: "draft",
  watchers: [],
  revision: 0,
  specRevision: 0,
  createdAt: at,
  updatedAt: at,
} as const;
const providerId = ProviderInstanceId.make("pi-selected");
const catalogue = [
  {
    instanceId: providerId,
    driverKind: "piAgent" as ProviderDriverKind,
    enabled: true,
    label: "Selected Pi",
    models: ["model-a", "model-b", "model-c"],
  },
  {
    instanceId: ProviderInstanceId.make("claude"),
    driverKind: "claudeAgent" as ProviderDriverKind,
    enabled: true,
    label: "Claude",
    models: ["claude-model"],
  },
];
const configuration = Schema.decodeUnknownSync(ProjectTeamConfigurationIntent)({
  type: "project-team.configure",
  commandId: CommandId.make("seed"),
  projectId,
  expectedRevision: 0,
  expectedConfigurationGeneration: 0,
  enabled: true,
  providerInstanceId: providerId,
  projectPriority: 3,
  taskPriorities: [{ taskId: task.taskId, priority: -2 }],
  profiles: roles.map((role, index) => ({
    role,
    instructions: `Instructions for ${role}`,
    skills: ["selected-skill"],
    tools: ["pi.read"],
    model: index < 3 ? "model-a" : "model-b",
    memoryAccess: "project",
    delegationDepth: index % 2,
  })),
  modelPolicies: [
    { model: "model-b", tokenLimit: 2000, durationLimitMs: 40000, modelCalls: 3 },
    { model: "model-a", tokenLimit: 1000, durationLimitMs: 20000, modelCalls: 2 },
  ],
  environmentModelCalls: 4,
  projectWritableWorkers: 2,
  delegationDepth: 3,
  repairAllowance: 4,
});
describe("Configuration through mounted foundation, shared atoms and encoded RPC", () => {
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

  let writes: ProjectTeamConfigurationIntent[];
  let receipts: Map<
    string,
    {
      input: ProjectTeamConfigurationIntent;
      records: ReadonlyArray<ProjectTeamRecord>;
      result: ProjectWorkWriteResult;
    }
  >;
  let deny: boolean;
  let lose: "none" | "before" | "after";
  let installed: boolean;
  let holdWrite:
    | { started: ReturnType<typeof receipt>; released: ReturnType<typeof receipt> }
    | undefined;
  const state = () => ({
    ...emptyProjectWorkReducerState(projectId),
    revision,
    foundationRecords: records.map((record) => decodeRecord(record)),
    tasks: [task],
  });
  function install(input: ProjectTeamConfigurationIntent) {
    const command = compileProjectTeamConfiguration(state(), input, attribution);
    const next = new Map(
      records.map((record) => {
        const parsed = decodeRecord(record);
        return [parsed.recordId, parsed];
      }),
    );
    for (const record of command.records) next.set(record.recordId, record);
    records = [...next.values()];
    revision += 1;
    return command.records;
  }
  const setup = Effect.gen(function* () {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    records = [];
    writes = [];
    receipts = new Map();
    deny = false;
    lose = "none";
    holdWrite = undefined;
    installed = true;
    revision = 10;
    pages = new Map();
    reads = [];
    held = undefined;
    fail = false;
    if (installed) install({ ...configuration, expectedRevision: revision });
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
              if (request.tag === WS_METHODS.projectWorkWrite) {
                const decoded = yield* decodeWrite(request.payload).pipe(Effect.orDie);
                if (decoded.type !== "project-team.configure")
                  return yield* Effect.die("Unexpected write intent");
                writes.push(decoded);
                const gate = holdWrite;
                if (gate) {
                  gate.started.resolve();
                  yield* Effect.promise(() => gate.released.promise);
                }
                let value: ProjectWorkWriteResult | undefined;
                let defect: unknown;
                try {
                  if (deny)
                    throw {
                      code: "permission-denied",
                      message: "Human credential cannot configure this team",
                    };
                  if (lose === "before") throw { message: "connection lost" };
                  const previous = receipts.get(decoded.commandId);
                  if (previous) {
                    if (
                      canonicalProjectWorkPayload(decoded) !==
                      canonicalProjectWorkPayload(previous.input)
                    )
                      throw new Error("Command payload changed");
                    assertProjectTeamConfigurationReplay(state(), previous.records);
                    value = previous.result;
                  } else {
                    const installedRecords = install(decoded);
                    value = {
                      projectId,
                      revision,
                      receipt: {
                        projectId,
                        revision,
                        commandId: decoded.commandId,
                        status: "accepted",
                        eventCount: installedRecords.length,
                      },
                      delta: { projectId, revision, eventIds: [], changedFields: [] },
                    };
                    receipts.set(decoded.commandId, {
                      input: decoded,
                      records: installedRecords,
                      result: value,
                    });
                  }
                  if (lose === "after") throw { message: "connection lost after commit" };
                } catch (error) {
                  defect = error;
                }
                const encoded = value ? yield* encodeResult(value).pipe(Effect.orDie) : undefined;
                return yield* write(clientId, {
                  _tag: "Exit",
                  requestId: request.id,
                  exit: defect
                    ? {
                        _tag: "Failure",
                        cause: deny ? [{ _tag: "Fail", error: defect }] : [{ _tag: "Die", defect }],
                      }
                    : { _tag: "Success", value: encoded },
                });
              }
              if (request.tag !== WS_METHODS.projectWorkRead)
                return yield* Effect.die("Unexpected RPC method");
              const input = yield* decodeRead(request.payload).pipe(Effect.orDie);
              if (input.operation !== "foundation-records")
                return yield* Effect.die("Unexpected project work read");
              reads.push({ environmentId: id, input });
              const gate = held;
              if (gate?.cursor === (input.cursor ?? "")) {
                gate.started.resolve();
                yield* Effect.promise(() => gate.released.promise);
              }
              const value = pages.get(input.cursor ?? "") ?? {
                projectId: input.projectId,
                revision,
                items: input.cursor ? [] : records,
              };
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
    holdWrite?.released.resolve();
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
    enabled = true,
    supported = true,
    writesSupported = true,
    providers = catalogue,
    project = projectId,
    environment = environmentId,
  } = {}) {
    await act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <Configuration
            environmentId={environment}
            projectId={project}
            connected={connected}
            enabled={enabled}
            supported={supported}
            writesSupported={writesSupported}
            providers={providers}
          />
        </RegistryContext.Provider>,
      );
    });
    if (supported && !held)
      await act(async () => settle({ environmentId: environment, projectId: project }));
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
  async function refresh() {
    await click("Refresh configuration");
    await act(async () => settle());
  }
  const input = (label: string) => {
    const item = host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[aria-label="${label}"]`,
    );
    expect(item).not.toBeNull();
    return item!;
  };
  async function change(label: string, value: string) {
    await act(async () => {
      const item = input(label);
      const proto =
        item instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : item instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(item, value);
      item.dispatchEvent(
        new Event(item instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
      );
    });
  }
  async function edit() {
    await click("Edit configuration");
  }
  async function save() {
    await click("Save configuration");
    await act(async () => settle());
  }
  const locked = () => expect(button("Save configuration")?.disabled).toBe(true);

  interaction(
    "roundtrips six immutable profiles and both model policies through the actual compiler",
    async () => {
      await render();
      await edit();
      expect(input("reviewer model").value).toBe("model-b");
      expect(input("model-a Token limit").value).toBe("1000");
      expect(input("model-b Token limit").value).toBe("2000");
      await change("Project priority", "7");
      await save();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        type: "project-team.configure",
        expectedRevision: 11,
        expectedConfigurationGeneration: 1,
        projectPriority: 7,
        providerInstanceId: providerId,
        taskPriorities: configuration.taskPriorities,
        profiles: configuration.profiles,
      });
      expect(writes[0]!.modelPolicies).toEqual(configuration.modelPolicies);
      expect(host.textContent).toContain("Configuration saved in the recorded project");
      expect(
        records.filter(
          (record) =>
            knownRecord(record) && record.kind === "role-revision" && record.status === "retired",
        ),
      ).toHaveLength(6);
      expect(records.some((record) => knownRecord(record) && record.kind === "run-binding")).toBe(
        false,
      );
    },
  );
  interaction(
    "initial setup requires explicit selected provider, every role model and positive budgets",
    async () => {
      records = [];
      revision = 0;
      await render();
      await click("Set up team");
      locked();
      expect(input("Pi provider").value).toBe("");
      await change("Pi provider", providerId);
      for (const role of roles) await change(`${role} model`, "model-c");
      locked();
      await change("model-c Token limit", "6000");
      await change("model-c Time limit (ms)", "80000");
      await change("model-c Concurrent model calls", "1");
      await save();
      expect(writes[0]).toMatchObject({
        expectedConfigurationGeneration: 0,
        expectedRevision: 0,
        enabled: false,
      });
      expect(writes[0]!.profiles.every((profile) => profile.model === "model-c")).toBe(true);
    },
  );
  interaction(
    "disable and re-enable only install configurations without run bindings or effects",
    async () => {
      await render();
      await edit();
      await act(async () => input("Enable team").click());
      await save();
      expect(writes[0]!.enabled).toBe(false);
      expect(
        records
          .filter(knownRecord)
          .filter((record) => record.kind === "limits")
          .every((record) => record.status === "disabled"),
      ).toBe(true);
      await act(async () => input("Enable team").click());
      await save();
      expect(writes[1]).toMatchObject({ enabled: true, expectedConfigurationGeneration: 2 });
      expect(
        records.some(
          (record) => knownRecord(record) && ["effect", "run-binding"].includes(record.kind),
        ),
      ).toBe(false);
    },
  );
  interaction(
    "edits profile instructions, lists, memory and per-task priorities without replacing models",
    async () => {
      await render();
      await edit();
      await change("investigator instructions", "New sourced investigation");
      await change("investigator skills", "first\nsecond");
      await change("investigator tools", "pi.read\npi.search");
      const memory = host.querySelector('select[aria-label="investigator memory access"]');
      // The accessible name must contain the visible "Memory access" label (WCAG label in name).
      expect(memory?.closest("label")?.firstChild?.textContent?.trim()).toBe("Memory access");
      expect(memory?.getAttribute("aria-label")?.toLowerCase()).toContain("memory access");
      await change("investigator memory access", "shared");
      await change("Task priorities", "task-1: 42");
      await change("investigator delegation depth", "4");
      await save();
      expect(writes[0]!.profiles[1]).toMatchObject({
        instructions: "New sourced investigation",
        skills: ["first", "second"],
        tools: ["pi.read", "pi.search"],
        memoryAccess: "shared",
        delegationDepth: 4,
        model: "model-a",
      });
      expect(writes[0]!.taskPriorities).toEqual([{ taskId: task.taskId, priority: 42 }]);
    },
  );
  interaction(
    "changing one role model retains other policies and requires the new model budget",
    async () => {
      await render();
      await edit();
      await change("reviewer model", "model-c");
      locked();
      await change("model-c Token limit", "7000");
      await change("model-c Time limit (ms)", "60000");
      await change("model-c Concurrent model calls", "2");
      await save();
      expect(writes[0]!.profiles[4]!.model).toBe("model-c");
      expect(writes[0]!.modelPolicies).toHaveLength(3);
      expect(
        writes[0]!.modelPolicies.find((policy) => policy.model === "model-b")!.tokenLimit,
      ).toBe(2000);
    },
  );
  for (const [label, value] of [
    ["Project writable workers", "65"],
    ["Environment model calls", "129"],
    ["Team delegation depth", "9"],
    ["Repair allowance", "17"],
    ["model-a Token limit", "0"],
    ["model-a Time limit (ms)", "0"],
    ["model-a Concurrent model calls", "129"],
    ["Project priority", "9007199254740992"],
    ["Task priorities", "task-1: 1\ntask-1: 2"],
    ["reviewer tools", "pi.read\npi.read"],
  ]) {
    interaction(`schema disables invalid ${label}`, async () => {
      await render();
      await edit();
      await change(label!, value!);
      locked();
      expect(writes).toEqual([]);
    });
  }
  for (const flag of ["connected", "enabled", "writesSupported"] as const) {
    interaction(`preserves metadata and disables all writes when ${flag} is false`, async () => {
      await render();
      await edit();
      await render({ [flag]: false });
      locked();
      expect(host.textContent).toContain("Last recorded update");
      expect(writes).toEqual([]);
    });
  }
  interaction(
    "permission denial leaves editable draft and does not claim a saved configuration",
    async () => {
      await render();
      await edit();
      deny = true;
      await save();
      expect(host.textContent).toContain("Human credential cannot configure");
      expect(button("Reconcile original command")).toBeUndefined();
      expect(host.textContent).not.toContain("Configuration saved in the recorded project");
      expect(button("Save configuration")!.disabled).toBe(false);
    },
  );
  for (const mode of ["before", "after"] as const)
    interaction(
      `lost response ${mode} commit reconciles exact original command and payload`,
      async () => {
        await render();
        await edit();
        lose = mode;
        await save();
        locked();
        expect(host.textContent).toContain("outcome is uncertain");
        const original = writes[0];
        lose = "none";
        await refresh();
        await click("Reconcile original command");
        await act(async () => settle());
        expect(writes).toHaveLength(2);
        expect(writes[1]).toEqual(original);
        expect(host.textContent).toContain("Configuration saved in the recorded project");
      },
    );
  interaction(
    "unrelated revision after lost response cannot blind retry a changed draft",
    async () => {
      await render();
      await edit();
      lose = "before";
      await save();
      revision++;
      lose = "none";
      await refresh();
      await click("Reconcile original command");
      expect(writes).toHaveLength(1);
      locked();
      expect(input("Project priority").closest("fieldset")!.disabled).toBe(true);
    },
  );
  interaction(
    "revision changes preserve draft and require explicit reload before new saves",
    async () => {
      await render();
      await edit();
      await change("Project priority", "8");
      revision++;
      await refresh();
      locked();
      expect(input("Project priority").value).toBe("8");
      await click("Reload configuration");
      expect(input("Project priority").value).toBe("3");
      await save();
      expect(writes[0]!.expectedRevision).toBe(12);
    },
  );
  interaction(
    "same-revision generation mutation is rechecked immediately before saving",
    async () => {
      await render();
      await edit();
      const atom = atoms.foundationPage({ environmentId, projectId });
      const changedRecords = records.map((record) => {
        const item = decodeRecord(record);
        return item.kind === "limits" ? { ...item, generation: 2 } : item;
      });
      await act(async () => {
        records = changedRecords;
        registry.refresh(atom);
        await settle();
        button("Save configuration")!.click();
      });
      expect(writes).toEqual([]);
    },
  );
  interaction("successful receipt remains pending until complete recorded refresh", async () => {
    await render();
    await edit();
    held = { cursor: "", started: receipt(), released: receipt() };
    await click("Save configuration");
    await held.started.promise;
    locked();
    expect(host.textContent).toContain("Waiting for the complete recorded configuration");
    expect(host.textContent).not.toContain("Configuration saved in the recorded project");
    await act(async () => {
      held?.released.resolve();
      await settle();
    });
    expect(host.textContent).toContain("Configuration saved in the recorded project");
  });
  interaction("overlapping clicks share one pending command", async () => {
    await render();
    await edit();
    holdWrite = { started: receipt(), released: receipt() };
    await act(async () => {
      button("Save configuration")!.click();
      button("Save configuration")!.click();
    });
    await holdWrite.started.promise;
    expect(writes).toHaveLength(1);
    await act(async () => {
      holdWrite?.released.resolve();
    });
    await act(async () => settle());
  });
  interaction("late write results and drafts are fenced after environment switch", async () => {
    await render();
    await edit();
    await change("Project priority", "9");
    holdWrite = { started: receipt(), released: receipt() };
    await click("Save configuration");
    await holdWrite.started.promise;
    await render({ environment: otherEnvironmentId });
    await act(async () => holdWrite?.released.resolve());
    await act(async () => settle({ environmentId: otherEnvironmentId, projectId }));
    expect(host.textContent).not.toContain("Configuration saved in the recorded project");
    expect(button("Save configuration")).toBeUndefined();
    expect(writes).toHaveLength(1);
  });
  interaction("project changes discard old editor and read only the selected project", async () => {
    await render();
    await edit();
    records = [];
    await render({ project: ProjectId.make("other-project") });
    expect(button("Save configuration")).toBeUndefined();
    expect(reads.at(-1)!.input.projectId).toBe("other-project");
  });
  interaction("old unsupported servers perform no reads or writes", async () => {
    await render({ supported: false });
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
    expect(host.textContent).toContain("does not support team configuration");
  });
  interaction("unknown states and malformed pages never enable configuration actions", async () => {
    const first = decodeRecord(records[0]);
    records[0] = { ...first, status: "future-state" };
    await render();
    expect(button("Set up team")!.disabled).toBe(true);
    records[0] = { ...first, generation: -1 };
    await refresh();
    expect(button("Set up team")!.disabled).toBe(true);
  });
  interaction(
    "incomplete profile references block edits instead of guessing historical bindings",
    async () => {
      records = records.filter(
        (record) =>
          !knownRecord(record) || record.kind !== "role-revision" || record.role !== "reviewer",
      );
      await render();
      expect(button("Set up team")!.disabled).toBe(true);
      expect(host.textContent).toContain("lineage is incomplete");
    },
  );
  interaction("missing catalogue keeps saved models visible without fallback", async () => {
    await render({ providers: [] });
    await edit();
    expect(input("reviewer model").value).toBe("model-b");
    locked();
    expect(host.textContent).toContain("Pi model catalogue unavailable");
  });
  interaction("other providers and disabled Pi cannot be selected", async () => {
    await render({
      providers: catalogue.map((item) => ({ ...item, enabled: item.driverKind !== "piAgent" })),
    });
    await edit();
    locked();
    expect(
      [...input("Pi provider").querySelectorAll("option")].map((option) => option.textContent),
    ).not.toContain("Claude");
  });
  interaction("a sixteen-page incomplete snapshot leaves edits unavailable", async () => {
    pages.set("", { projectId, revision, items: records, nextCursor: "page-1" });
    for (let index = 1; index < 16; index++)
      pages.set(`page-${index}`, {
        projectId,
        revision,
        items: [],
        nextCursor: `page-${index + 1}`,
      });
    await render();
    for (let index = 1; index < 16; index++)
      await act(async () => settle({ environmentId, projectId, cursor: `page-${index}` }));
    expect(button("Edit configuration")!.disabled).toBe(true);
    expect(host.textContent).toContain("exceeds the guided view limit");
  });
  for (const flag of ["connected", "enabled", "writesSupported"] as const)
    interaction(`restoring ${flag} waits for a new read receipt`, async () => {
      await render();
      await edit();
      await render({ [flag]: false });
      held = { cursor: "", started: receipt(), released: receipt() };
      await render();
      await held.started.promise;
      locked();
      await act(async () => {
        held?.released.resolve();
        await settle();
      });
      expect(button("Save configuration")!.disabled).toBe(false);
    });
  interaction("missing current members make configuration incomplete", async () => {
    records = records.filter(
      (record) => !knownRecord(record) || record.kind !== "member" || record.coordinator,
    );
    await render();
    expect(button("Set up team")!.disabled).toBe(true);
    expect(writes).toEqual([]);
  });
  interaction(
    "conflicting latest model policies cannot be reconstructed as one policy",
    async () => {
      records = records.map((record) =>
        knownRecord(record) && record.kind === "limits" && record.model === "model-b"
          ? { ...record, projectPriority: 999 }
          : record,
      );
      await render();
      expect(button("Set up team")!.disabled).toBe(true);
      expect(writes).toEqual([]);
    },
  );
  interaction(
    "held capacity prevents edits even when profiles and policies are current",
    async () => {
      records.push({
        projectId,
        recordId: "held-slot",
        revision: 1,
        generation: 1,
        updatedAt: at,
        kind: "reservation",
        status: "held",
        environmentId,
        scope: "project",
        resourceKey: projectId,
        slot: 0,
        runId: "owned-run",
        taskId: task.taskId,
        attemptId: "attempt-1",
        maximumTokens: 1000,
        consumedTokens: 0,
      });
      await render();
      expect(button("Edit configuration")!.disabled).toBe(true);
      expect(host.textContent).toContain("Stop and drain");
    },
  );
  interaction(
    "an accepted configuration replaced before refresh can reload the newer generation",
    async () => {
      await render();
      await edit();
      held = { cursor: "", started: receipt(), released: receipt() };
      await click("Save configuration");
      await held.started.promise;
      install({
        ...configuration,
        commandId: CommandId.make("other-device"),
        expectedRevision: revision,
        expectedConfigurationGeneration: 2,
        projectPriority: 99,
      });
      await act(async () => {
        held?.released.resolve();
        await settle();
      });
      expect(host.textContent).toContain("replaced by a newer recorded generation");
      await click("Reload configuration");
      expect(input("Project priority").value).toBe("99");
      expect(button("Save configuration")!.disabled).toBe(false);
    },
  );
});
