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
  ProjectWorkReadIntent,
  WS_METHODS,
  DEFAULT_SERVER_SETTINGS,
  ServerProvider,
  ProviderInstanceConfig,
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
  const state: {
    atoms: unknown;
    environments: ReadonlyArray<unknown>;
    lifecycle: (target: unknown) => unknown;
  } = { atoms: undefined, environments: [], lifecycle: () => undefined };
  return state;
});
vi.mock("~/state/projectWork", () => ({
  get projectWorkEnvironment() {
    return bridge.atoms;
  },
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: bridge.environments }),
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: { lifecycle: (target: unknown) => bridge.lifecycle(target) },
}));

import { ProjectTeamSettings } from "./ProjectTeamSettings";
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
const encodeResult = Schema.encodeEffect(ProjectWorkWriteResult);
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeInstance = Schema.decodeUnknownSync(ProviderInstanceConfig);
const decodeLifecycleTarget = Schema.decodeUnknownSync(
  Schema.Struct({ environmentId: EnvironmentId, input: Schema.Struct({ projectId: ProjectId }) }),
);
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
function hostEnvironment(
  id: EnvironmentId,
  {
    connected = true,
    enabled = true,
    supported = true,
    writesSupported = true,
    providerEnabled = true,
    configured = true,
    models = ["model-a", "model-b"],
  } = {},
) {
  const provider = decodeProvider({
    instanceId: providerId,
    driver: "piAgent",
    enabled: true,
    installed: true,
    version: "0.99.1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: at,
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  });
  return {
    environmentId: id,
    connection: { phase: connected ? "connected" : "disconnected" },
    serverConfig: {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        projectWorkEnabled: enabled,
        providerInstances: configured
          ? { [providerId]: decodeInstance({ driver: "piAgent", enabled: providerEnabled }) }
          : {},
      },
      providers: [provider],
      environment: {
        capabilities: {
          projectTeamFoundationReads: supported,
          projectTeamGuidedWrites: writesSupported,
        },
      },
    },
  };
}

describe("Project team Settings through real configuration and encoded RPC", () => {
  let lifecycleState: string;
  let lifecycleQueries: unknown[];
  let lifecycleAtoms = Atom.family((key: string) =>
    Atom.make(AsyncResult.success({ state: "active", key })),
  );
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
  let writeEnvironments: EnvironmentId[];
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
    writeEnvironments = [];
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
                writeEnvironments.push(id);
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
    lifecycleQueries = [];
    lifecycleState = "active";
    lifecycleAtoms = Atom.family((key: string) =>
      Atom.make(AsyncResult.success({ state: lifecycleState, key })),
    );
    bridge.lifecycle = (raw) => {
      const target = decodeLifecycleTarget(raw);
      lifecycleQueries.push(target);
      return lifecycleAtoms(JSON.stringify([target.environmentId, target.input.projectId]));
    };
    bridge.environments = [hostEnvironment(environmentId), hostEnvironment(otherEnvironmentId)];
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

  const first = {
    environmentId,
    id: projectId,
    environmentLabel: "First machine",
    workspaceRoot: "/first",
  };
  const second = {
    ...first,
    environmentId: otherEnvironmentId,
    environmentLabel: "Second machine",
    workspaceRoot: "/second",
  };
  async function render(items: ReadonlyArray<typeof first> = [first]) {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ProjectTeamSettings checkouts={items} />
        </RegistryContext.Provider>,
      ),
    );
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
  async function choose(item: typeof first) {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Team checkout"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
        select,
        JSON.stringify([item.environmentId, item.id]),
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => settle({ environmentId: item.environmentId, projectId: item.id }));
  }
  async function edit() {
    await act(async () => settle());
    await click("Edit configuration");
  }
  interaction(
    "a grouped project selects no implicit team and makes no reads or writes",
    async () => {
      await render([first, second]);
      expect(reads).toEqual([]);
      expect(lifecycleQueries).toEqual([]);
      expect(writes).toEqual([]);
      expect(host.textContent).toContain("Choose one checkout");
    },
  );
  interaction(
    "one checkout mounts the actual configuration and saves only its environment-local project",
    async () => {
      await render();
      await edit();
      await click("Save configuration");
      await act(async () => settle());
      expect(writes).toHaveLength(1);
      expect(writes[0]!.projectId).toBe(projectId);
      expect(writeEnvironments).toEqual([environmentId]);
      expect(
        reads.every(
          (read) => read.environmentId === environmentId && read.input.projectId === projectId,
        ),
      ).toBe(true);
      expect(host.textContent).toContain("Configuration saved in the recorded project");
    },
  );
  interaction(
    "choosing a grouped checkout reads only that exact environment and project",
    async () => {
      await render([first, second]);
      await choose(second);
      expect(
        reads.every(
          (read) => read.environmentId === otherEnvironmentId && read.input.projectId === projectId,
        ),
      ).toBe(true);
      expect(writes).toEqual([]);
    },
  );
  interaction(
    "switching checkout discards the previous editable draft and pending result",
    async () => {
      await render([first, second]);
      await choose(first);
      await click("Edit configuration");
      holdWrite = { started: receipt(), released: receipt() };
      await click("Save configuration");
      await holdWrite.started.promise;
      await choose(second);
      await act(async () => holdWrite?.released.resolve());
      expect(host.textContent).not.toContain("Configuration saved in the recorded project");
      expect(button("Save configuration")).toBeUndefined();
      expect(writes).toHaveLength(1);
    },
  );
  interaction("removing the selected checkout leaves no form or implicit substitute", async () => {
    const third = { ...second, id: ProjectId.make("third-project"), workspaceRoot: "/third" };
    await render([first, second, third]);
    await choose(first);
    await click("Edit configuration");
    await render([second, third]);
    expect(button("Save configuration")).toBeUndefined();
    expect(host.textContent).toContain("Choose one checkout");
    expect(writes).toEqual([]);
  });
  for (const state of ["archived", "future-state"])
    interaction(`${state} project lifecycle never enables configuration edits`, async () => {
      lifecycleState = state;
      await render();
      await act(async () => settle());
      expect(button("Edit configuration")?.disabled).toBe(true);
      expect(writes).toEqual([]);
    });
  interaction(
    "older servers render unsupported without any lifecycle or foundation reads",
    async () => {
      bridge.environments = [hostEnvironment(environmentId, { supported: false })];
      await render();
      expect(reads).toEqual([]);
      expect(lifecycleQueries).toEqual([]);
      expect(host.textContent).toContain("does not support team configuration");
    },
  );
  for (const flag of ["connected", "enabled", "writesSupported"] as const)
    interaction(`a checkout with ${flag} false keeps configuration read-only`, async () => {
      bridge.environments = [hostEnvironment(environmentId, { [flag]: false })];
      await render();
      await act(async () => settle());
      expect(button("Edit configuration")?.disabled).toBe(true);
      expect(writes).toEqual([]);
    });
  for (const options of [{ providerEnabled: false }, { configured: false }])
    interaction(
      `current settings reject stale enabled provider snapshots: ${JSON.stringify(options)}`,
      async () => {
        bridge.environments = [hostEnvironment(environmentId, options)];
        await render();
        await edit();
        expect(button("Save configuration")?.disabled).toBe(true);
        expect(host.textContent).toContain("catalogue unavailable");
        expect(writes).toEqual([]);
      },
    );
  interaction(
    "same instance IDs in different environments never mix model catalogues",
    async () => {
      bridge.environments = [
        hostEnvironment(environmentId),
        hostEnvironment(otherEnvironmentId, { models: ["only-second-model"] }),
      ];
      await render([first, second]);
      await choose(second);
      await click("Edit configuration");
      expect(button("Save configuration")?.disabled).toBe(true);
      const options = [
        ...host.querySelectorAll<HTMLSelectElement>('[aria-label="reviewer model"] option'),
      ].map((item) => item.textContent);
      expect(options).toContain("only-second-model");
      expect(options).toContain("model-b (unavailable)");
      expect(options).not.toContain("model-a");
      expect(writes).toEqual([]);
    },
  );
  interaction(
    "grouped configuration saves through only the explicitly selected environment",
    async () => {
      await render([first, second]);
      await choose(second);
      await click("Edit configuration");
      await click("Save configuration");
      await act(async () => settle({ environmentId: otherEnvironmentId, projectId }));
      expect(writes).toHaveLength(1);
      expect(writeEnvironments).toEqual([otherEnvironmentId]);
      expect(writes[0]!.projectId).toBe(projectId);
      expect(host.textContent).toContain("Configuration saved in the recorded project");
    },
  );
  interaction("removing a grouped selection requires choosing the singleton survivor", async () => {
    await render([first, second]);
    await choose(first);
    await click("Edit configuration");
    const before = reads.length;
    await render([second]);
    expect(host.textContent).toContain("Choose one checkout");
    expect(button("Edit configuration")).toBeUndefined();
    expect(reads.slice(before)).toEqual([]);
    await choose(second);
    await click("Edit configuration");
    await click("Save configuration");
    await act(async () => settle({ environmentId: otherEnvironmentId, projectId }));
    expect(writeEnvironments).toEqual([otherEnvironmentId]);
  });
  interaction("an unselected group narrowing to one checkout still requires a choice", async () => {
    await render([first, second]);
    await render([second]);
    expect(host.textContent).toContain("Choose one checkout");
    expect(reads).toEqual([]);
    expect(lifecycleQueries).toEqual([]);
    expect(writes).toEqual([]);
  });
  interaction("a group passing through zero checkouts never selects a new singleton", async () => {
    await render([first, second]);
    await render([]);
    await render([second]);
    expect(host.textContent).toContain("Choose one checkout");
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });
  interaction(
    "an initial single checkout cannot be substituted by a different singleton",
    async () => {
      await render();
      await edit();
      const before = reads.length;
      await render([second]);
      expect(host.textContent).toContain("Choose one checkout");
      expect(button("Save configuration")).toBeUndefined();
      expect(reads.slice(before)).toEqual([]);
      expect(writes).toEqual([]);
    },
  );
  interaction(
    "an explicitly selected owner retains its draft when only that checkout remains",
    async () => {
      await render([first, second]);
      await choose(first);
      await click("Edit configuration");
      await render([first]);
      expect(button("Save configuration")).toBeDefined();
      await click("Save configuration");
      await act(async () => settle());
      expect(writeEnvironments).toEqual([environmentId]);
    },
  );
});
