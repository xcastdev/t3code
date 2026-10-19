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
  ProjectTeamEffect,
  ProjectWorkReadIntent,
  ProjectWorkWriteIntent,
  ProjectWorkWriteResult,
  type ProjectTeamMemoryRetractIntent,
  type ProjectTeamMemorySharesReplaceIntent,
  OrchestrationProjectShell,
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
  const state: { atoms: unknown; projects: unknown } = { atoms: undefined, projects: undefined };
  return state;
});
vi.mock("~/state/projectWork", () => ({
  get projectWorkEnvironment() {
    return bridge.atoms;
  },
}));

vi.mock("~/state/projects", () => ({
  get environmentProjects() {
    return { projectsAtom: bridge.projects };
  },
}));

import { Memory } from "./Memory";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const projectId = ProjectId.make("project-1");
const at = "2026-10-04T10:00:00.000Z";
const decodeRead = Schema.decodeUnknownEffect(ProjectWorkReadIntent);
const decodeWrite = Schema.decodeUnknownEffect(ProjectWorkWriteIntent);
const encodeResult = Schema.encodeEffect(ProjectWorkWriteResult);
const decodeProject = Schema.decodeUnknownSync(OrchestrationProjectShell);
const decodeEffect = Schema.decodeUnknownSync(ProjectTeamEffect);
const isSource = Schema.is(ProjectMemorySource);
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
const extraction = Schema.decodeUnknownSync(ProjectMemoryExtraction)({
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
const indexJob = Schema.decodeUnknownSync(ProjectTeamEffect)({
  ...base,
  kind: "effect",
  recordId: "index-1",
  effectId: "index-1",
  effectKind: "memory-index",
  status: "claimed",
  targetId: source.recordId,
  payload: {
    recordIds: [source.recordId, extraction.recordId],
    expectedRevision: source.sourceRevision,
  },
  claimGeneration: 4,
  availableAt: at,
});

describe("Memory through mounted foundation and encoded RPC transport", () => {
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
  type MemoryWrite = ProjectTeamMemoryRetractIntent | ProjectTeamMemorySharesReplaceIntent;
  let writes: Array<{ environmentId: EnvironmentId; input: MemoryWrite }>;
  const catalogueProject = (id: string, environment = environmentId) => ({
    ...decodeProject({
      id,
      title: id,
      workspaceRoot: `/tmp/${id}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    }),
    environmentId: environment,
  });
  let projects: ReturnType<typeof Atom.make<ReadonlyArray<ReturnType<typeof catalogueProject>>>>;

  let writeMode: "accepted" | "denied" | "mixed" | "lost" | "wrong-project";
  let accepted: Map<string, ProjectWorkWriteResult>;
  let writeCompleted: ReturnType<typeof receipt>;

  const setup = Effect.gen(function* () {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    records = [source, extraction, observation, indexJob];
    revision = 10;
    pages = new Map();
    reads = [];
    held = undefined;
    fail = false;
    writes = [];
    writeMode = "accepted";
    accepted = new Map();
    writeCompleted = receipt();
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
                const input = yield* decodeWrite(request.payload).pipe(Effect.orDie);
                if (
                  input.type !== "project-team.memory.retract" &&
                  input.type !== "project-team.memory.shares.replace"
                )
                  return yield* Effect.die("Unexpected memory action");
                writes.push({ environmentId: id, input });
                if (writeMode === "denied" || writeMode === "mixed") {
                  yield* write(clientId, {
                    _tag: "Exit",
                    requestId: request.id,
                    exit: {
                      _tag: "Failure",
                      cause: [
                        {
                          _tag: "Fail",
                          error: {
                            _tag: "ProjectTeamAuthorizationError",
                            reason: "Human memory write denied",
                          },
                        },
                        ...(writeMode === "mixed"
                          ? [{ _tag: "Die" as const, defect: "Additional transport uncertainty" }]
                          : []),
                      ],
                    },
                  });
                  writeCompleted.resolve();
                  return;
                }
                let result = accepted.get(input.commandId);
                if (result === undefined) {
                  const current = records
                    .filter(isSource)
                    .find((record) => record.recordId === input.sourceRecordId);
                  if (current === undefined)
                    return yield* Effect.die("Selected source unavailable");
                  expect(input).toMatchObject({
                    projectId,
                    expectedRevision: revision,
                    expectedSourceRecordRevision: current.revision,
                    sourceRevision: current.sourceRevision,
                    sourceGeneration: current.generation,
                    contentHash: current.contentHash,
                  });
                  if (input.type === "project-team.memory.shares.replace") {
                    records = records.map((record) =>
                      record === current
                        ? {
                            ...current,
                            revision: current.revision + 1,
                            sharedWithProjectIds: input.sharedWithProjectIds,
                          }
                        : record,
                    );
                  } else {
                    const tombstone = {
                      ...current,
                      status: "retracted" as const,
                      revision: current.revision + 1,
                      generation: current.generation + 1,
                      tombstonedAt: at,
                      sharedWithProjectIds: [],
                    };
                    records = records.map((record) => (record === current ? tombstone : record));
                    records.push(
                      decodeEffect({
                        ...base,
                        recordId: "delete-1",
                        effectId: "delete-1",
                        kind: "effect",
                        effectKind: "memory-delete",
                        status: "pending",
                        targetId: current.recordId,
                        generation: tombstone.generation,
                        claimGeneration: 0,
                        availableAt: at,
                        payload: {
                          recordIds: [current.recordId],
                          expectedRevision: current.sourceRevision,
                        },
                      }),
                    );
                  }
                  revision += 2;
                  result = {
                    projectId,
                    revision,
                    receipt: {
                      projectId,
                      revision,
                      commandId: input.commandId,
                      status: "accepted",
                      eventCount: 2,
                    },
                    delta: {
                      projectId,
                      revision,
                      eventIds: [],
                      changedFields: ["foundationRecords"],
                    },
                  };
                  accepted.set(input.commandId, result);
                }
                if (writeMode === "lost") {
                  yield* write(clientId, {
                    _tag: "Exit",
                    requestId: request.id,
                    exit: {
                      _tag: "Failure",
                      cause: [{ _tag: "Die", defect: "Reply lost after commit" }],
                    },
                  });
                  writeCompleted.resolve();
                  return;
                }
                const response =
                  writeMode === "wrong-project"
                    ? { ...result, projectId: ProjectId.make("foreign-project") }
                    : result;
                yield* write(clientId, {
                  _tag: "Exit",
                  requestId: request.id,
                  exit: {
                    _tag: "Success",
                    value: yield* encodeResult(response).pipe(Effect.orDie),
                  },
                });
                writeCompleted.resolve();
                return;
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
    projects = Atom.make<ReadonlyArray<ReturnType<typeof catalogueProject>>>([
      catalogueProject(projectId),
      catalogueProject("shared-project"),
      catalogueProject("new-project"),
      catalogueProject("foreign-project", otherEnvironmentId),
    ]);
    bridge.projects = projects;
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
    enabled = true,
    supported = true,
    writesSupported = false,
    project = projectId,
    environment = environmentId,
  } = {}) {
    await act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <Memory
            environmentId={environment}
            projectId={project}
            connected={connected}
            enabled={enabled}
            supported={supported}
            writesSupported={writesSupported}
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
    await click("Refresh memory");
    await act(async () => settle());
  }
  async function inspect(id: string) {
    await click(`Inspect ${id}`);
  }
  function hideBodies() {
    expect(host.textContent).not.toContain(source.content);
    expect(host.textContent).not.toContain(observation.body);
  }

  const writableSource = { ...source, contentHash: "1".repeat(64) };
  function prepareRetraction() {
    records = [writableSource, extraction, observation, indexJob];
  }
  async function submit(label = "Retract memory") {
    writeCompleted = receipt();
    await click(label);
    await act(async () => writeCompleted.promise);
  }

  async function reviewSharing() {
    prepareRetraction();
    await render({ writesSupported: true });
    await inspect(source.recordId);
    await click("Review sharing");
  }
  async function toggleGrant(id: string) {
    const checkbox = host.querySelector<HTMLElement>(
      `[role="checkbox"][aria-label="Share with ${id}"]`,
    );
    expect(checkbox).not.toBeNull();
    // Base UI forwards a PointerEvent to its native input; happy-dom does not
    // perform the native checkbox default action for dispatchEvent(PointerEvent).
    const input = checkbox
      ?.closest("label")
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(input).not.toBeNull();
    await act(async () => input?.click());
  }
  interaction("replaces the complete reviewed grant set and explicitly revokes it", async () => {
    await reviewSharing();
    expect(host.querySelector('[aria-label="Share with project-1"]')).toBeNull();
    expect(host.querySelector('[aria-label="Share with foreign-project"]')).toBeNull();
    await toggleGrant("shared-project");
    await toggleGrant("new-project");
    await submit("Apply sharing changes");
    await act(async () => settle());
    expect(writes[0]).toMatchObject({
      environmentId,
      input: {
        type: "project-team.memory.shares.replace",
        projectId,
        expectedRevision: 10,
        sourceRecordId: source.recordId,
        expectedSourceRecordRevision: 1,
        sourceRevision: 3,
        sourceGeneration: 2,
        contentHash: writableSource.contentHash,
        sharedWithProjectIds: ["new-project"],
      },
    });
    expect(host.textContent).toContain("Sharing update recorded");
    await click("Review sharing");
    await click("Clear all grants");
    await submit("Apply sharing changes");
    await act(async () => settle());
    expect(writes[1]?.input).toMatchObject({ sharedWithProjectIds: [], expectedRevision: 12 });
    expect(records.find(isSource)).toMatchObject({
      projectId,
      recordId: source.recordId,
      sharedWithProjectIds: [],
    });
    expect(records.filter(isSource)).toHaveLength(1);
  });
  interaction("requires fresh review when only grants or project revision changed", async () => {
    await reviewSharing();
    records = [{ ...writableSource, sharedWithProjectIds: ["new-project"] }];
    revision++;
    await refresh();
    expect(button("Apply sharing changes")?.disabled).toBe(true);
    await click("Apply sharing changes");
    expect(writes).toEqual([]);
    await click("Review sharing");
    await click("Clear all grants");
    await submit("Apply sharing changes");
    expect(writes[0]?.input).toMatchObject({ expectedRevision: 11, sharedWithProjectIds: [] });
  });
  interaction("rechecks removed catalogue projects before applying reviewed grants", async () => {
    await reviewSharing();
    await toggleGrant("new-project");
    await act(async () => registry.set(projects, [catalogueProject(projectId)]));
    await click("Apply sharing changes");
    expect(writes).toEqual([]);
    expect(host.textContent).toContain("Review the current source and project grants again");
  });
  for (const state of ["disconnected", "disabled", "unsupported"] as const) {
    interaction(`blocks reviewed sharing while ${state}`, async () => {
      await reviewSharing();
      const stale = button("Apply sharing changes");
      await render({
        connected: state !== "disconnected",
        enabled: state !== "disabled",
        writesSupported: state !== "unsupported",
      });
      await act(async () => stale?.click());
      expect(writes).toEqual([]);
    });
  }
  for (const target of ["project", "environment"] as const) {
    interaction(`blocks a retained sharing action after switching ${target}`, async () => {
      await reviewSharing();
      const stale = button("Apply sharing changes");
      await render({
        writesSupported: true,
        ...(target === "project"
          ? { project: ProjectId.make("project-2") }
          : { environment: otherEnvironmentId }),
      });
      await act(async () => stale?.click());
      expect(writes).toEqual([]);
      expect(button("Apply sharing changes")).toBeUndefined();
    });
  }
  for (const state of ["superseded", "retracted", "broken-chain"] as const) {
    interaction(`blocks reviewed sharing after source becomes ${state}`, async () => {
      await reviewSharing();
      records =
        state === "broken-chain"
          ? [{ ...writableSource, supersedes: "missing" }]
          : [{ ...writableSource, status: state }];
      revision++;
      await refresh();
      expect(button("Apply sharing changes")?.disabled).toBe(true);
      expect(button("Review sharing")?.disabled).toBe(true);
      await click("Apply sharing changes");
      expect(writes).toEqual([]);
    });
  }
  for (const mode of ["lost", "wrong-project", "mixed"] as const) {
    interaction(
      `retains exact sharing after ${mode} across refresh and reconciles its receipt`,
      async () => {
        await reviewSharing();
        await click("Clear all grants");
        writeMode = mode;
        await submit("Apply sharing changes");
        const original = writes[0];
        expect(button("Retract memory")?.disabled).toBe(true);
        await refresh();
        expect(button("Retry exact sharing update")).toBeDefined();
        expect(button("Apply sharing changes")?.disabled).toBe(true);
        writeMode = "accepted";
        await submit("Retry exact sharing update");
        await act(async () => settle());
        expect(writes).toEqual([original, original]);
        expect(accepted.size).toBe(1);
        expect(button("Retry exact sharing update")).toBeUndefined();
        expect(host.textContent).toContain("Sharing update recorded");
      },
    );
  }
  interaction(
    "admits one sharing command when apply and retraction are clicked before rerender",
    async () => {
      await reviewSharing();
      await click("Clear all grants");
      const apply = button("Apply sharing changes");
      const retract = button("Retract memory");
      writeCompleted = receipt();
      await act(async () => {
        apply?.click();
        apply?.click();
        retract?.click();
        await writeCompleted.promise;
      });
      await act(async () => settle());
      expect(writes).toHaveLength(1);
      expect(writes[0]?.input.type).toBe("project-team.memory.shares.replace");
    },
  );

  for (const laterState of ["superseded", "retracted"] as const) {
    interaction(
      `reconciles an uncertain accepted share after later ${laterState} without retargeting`,
      async () => {
        await reviewSharing();
        await click("Clear all grants");
        writeMode = "lost";
        await submit("Apply sharing changes");
        const original = writes[0];
        records = [
          {
            ...writableSource,
            revision: 3,
            generation: 3,
            status: laterState,
            ...(laterState === "retracted" ? { tombstonedAt: at } : {}),
          },
        ];
        revision++;
        await refresh();
        expect(button("Review sharing")?.disabled).toBe(true);
        writeMode = "accepted";
        await submit("Retry exact sharing update");
        await act(async () => settle());
        expect(writes).toEqual([original, original]);
        expect(accepted.size).toBe(1);
        expect(button("Retry exact sharing update")).toBeUndefined();
        expect(host.textContent).toContain("Sharing update recorded");
      },
    );
  }

  interaction("clears rejected sharing and requires another explicit review", async () => {
    await reviewSharing();
    writeMode = "denied";
    await submit("Apply sharing changes");
    expect(button("Retry exact sharing update")).toBeUndefined();
    expect(button("Apply sharing changes")).toBeUndefined();
    expect(host.textContent).toContain("Sharing update rejected");
    expect(button("Retract memory")?.disabled).toBe(false);
  });

  interaction(
    "retracts the inspected exact source and hides its cached observation family during held refresh",
    async () => {
      prepareRetraction();
      await render({ writesSupported: true });
      await inspect(source.recordId);
      expect(host.textContent).toContain(source.content);
      held = { cursor: "", started: receipt(), released: receipt() };
      await submit();
      await act(async () => held?.started.promise);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        environmentId,
        input: {
          type: "project-team.memory.retract",
          projectId,
          expectedRevision: 10,
          sourceRecordId: source.recordId,
          expectedSourceRecordRevision: source.revision,
          sourceRevision: source.sourceRevision,
          sourceGeneration: source.generation,
          contentHash: writableSource.contentHash,
        },
      });
      hideBodies();
      expect(host.textContent).toContain("Memory retracted locally. Backend cleanup pending");
      await inspect(observation.recordId);
      hideBodies();
      await act(async () => {
        held?.released.resolve();
        await settle();
      });
      expect(host.textContent).toContain("Backend cleanup requires an approved task");
      expect(host.textContent).toContain("Recorded retracted");
      await inspect("delete-1");
      expect(host.textContent).toContain("Recorded pending");
      expect(host.textContent).toContain("physical cleanup are not verified here");
    },
  );

  interaction(
    "denies a stale inspected source without silently retargeting the refreshed revision",
    async () => {
      prepareRetraction();
      await render({ writesSupported: true });
      await inspect(source.recordId);
      records = [
        { ...writableSource, revision: 2, generation: 3, contentHash: "2".repeat(64) },
        extraction,
        observation,
        indexJob,
      ];
      revision = 11;
      await refresh();
      await click("Retract memory");
      expect(writes).toEqual([]);
      expect(host.textContent).toContain("The inspected source changed");
      expect(button("Retry exact retraction")).toBeUndefined();
    },
  );

  interaction(
    "treats an encoded authorization denial as rejected rather than an uncertain retraction",
    async () => {
      prepareRetraction();
      await render({ writesSupported: true });
      await inspect(source.recordId);
      writeMode = "denied";
      await submit();
      expect(writes).toHaveLength(1);
      expect(revision).toBe(10);
      expect(host.textContent).toContain("Memory retraction was rejected");
      expect(host.textContent).toContain(source.content);
      expect(button("Retry exact retraction")).toBeUndefined();
      expect(button("Retract memory")?.disabled).toBe(false);
    },
  );

  interaction(
    "retains the original retraction for a mixed authorization and transport cause",
    async () => {
      prepareRetraction();
      await render({ writesSupported: true });
      await inspect(source.recordId);
      writeMode = "mixed";
      await submit();
      expect(writes).toHaveLength(1);
      hideBodies();
      expect(button("Retry exact retraction")).toBeDefined();
      expect(host.textContent).not.toContain("Memory retraction was rejected");
      writeMode = "accepted";
      await submit("Retry exact retraction");
      await act(async () => settle());
      expect(writes[1]).toEqual(writes[0]);
      expect(revision).toBe(12);
    },
  );

  for (const mode of ["lost", "wrong-project"] as const) {
    interaction(
      `retries the original retraction after ${mode} receipt without renewing its selection`,
      async () => {
        prepareRetraction();
        await render({ writesSupported: true });
        await inspect(source.recordId);
        writeMode = mode;
        await submit();
        const original = writes[0];
        expect(original).toBeDefined();
        hideBodies();
        expect(button("Retry exact retraction")).toBeDefined();
        await refresh();
        writeMode = "accepted";
        await submit("Retry exact retraction");
        await act(async () => settle());
        expect(writes).toEqual([original, original]);
        expect(revision).toBe(12);
        expect(accepted.size).toBe(1);
        expect(button("Retry exact retraction")).toBeUndefined();
        expect(host.textContent).toContain("Backend cleanup requires an approved task");
        hideBodies();
      },
    );
  }

  for (const state of ["disconnected", "disabled", "unsupported"] as const) {
    interaction(`does not submit human retraction while ${state}`, async () => {
      prepareRetraction();
      await render({ writesSupported: true });
      await inspect(source.recordId);
      await render({
        connected: state !== "disconnected",
        enabled: state !== "disabled",
        writesSupported: state !== "unsupported",
      });
      expect(button("Retract memory")?.disabled).toBe(true);
      await click("Retract memory");
      expect(writes).toEqual([]);
      expect(revision).toBe(10);
    });
  }

  for (const target of ["project", "environment"] as const) {
    interaction(`discards uncertain retraction when the ${target} changes`, async () => {
      prepareRetraction();
      await render({ writesSupported: true });
      await inspect(source.recordId);
      writeMode = "lost";
      await submit();
      expect(button("Retry exact retraction")).toBeDefined();
      records = [];
      await render({
        writesSupported: true,
        ...(target === "project"
          ? { project: ProjectId.make("project-2") }
          : { environment: otherEnvironmentId }),
      });
      expect(button("Retry exact retraction")).toBeUndefined();
      expect(writes).toHaveLength(1);
      expect(host.textContent).not.toContain(`Inspecting ${source.recordId}`);
    });
  }

  interaction(
    "inspects current source text, explicit shares and extracted provenance without other reads",
    async () => {
      await render();
      expect(host.textContent).toContain("Current recorded memory");
      hideBodies();
      await inspect(source.recordId);
      expect(host.textContent).toContain(source.content);
      expect(host.textContent).toContain("shared-project");
      expect(host.textContent).toContain("investigator");
      await inspect(observation.recordId);
      expect(host.textContent).toContain(observation.body);
      expect(host.textContent).not.toContain(source.content);
      expect(host.textContent).toContain("not accepted decisions");
      expect(
        reads.every(({ input }) => input.operation === "foundation-records" && input.limit === 128),
      ).toBe(true);
    },
  );
  interaction(
    "shows extraction models and recorded index/delete outcomes without asserting health",
    async () => {
      records.push({
        ...indexJob,
        recordId: "delete-1",
        effectId: "delete-1",
        effectKind: "memory-delete",
        status: "failed",
        outcome: "Cleanup still pending",
      });
      await render();
      await inspect(extraction.recordId);
      expect(host.textContent).toContain("recorded-extraction-model");
      expect(host.textContent).toContain("recorded-embedding-model");
      expect(host.textContent).toContain("Expected observations 1");
      await inspect("delete-1");
      expect(host.textContent).toContain("Cleanup still pending");
      expect(host.textContent).toContain("physical cleanup are not verified here");
      expect(button("Delete")).toBeUndefined();
    },
  );
  for (const [name, changed, reason] of [
    [
      "source generation",
      { ...observation, sourceGeneration: 1 },
      "Stale source revision or generation",
    ],
    [
      "source revision",
      { ...observation, sourceRevision: 2 },
      "Stale source revision or generation",
    ],
    [
      "extraction generation",
      { ...extraction, sourceGeneration: 1 },
      "Matching successful extraction not available",
    ],
    [
      "extraction source",
      { ...extraction, sourceId: "other-source" },
      "Matching successful extraction not available",
    ],
    [
      "retracted extraction",
      { ...extraction, status: "retracted" },
      "Matching successful extraction not available",
    ],
    [
      "failed extraction",
      { ...extraction, status: "failed" },
      "Matching successful extraction not available",
    ],
    [
      "unrecorded observation",
      { ...extraction, expectedObservationIds: [] },
      "Matching successful extraction not available",
    ],
    [
      "incomplete indexing",
      { ...extraction, status: "indexed", completedObservationIds: [] },
      "Matching successful extraction not available",
    ],
  ] satisfies ReadonlyArray<readonly [string, unknown, string]>) {
    interaction(`hides observation content for stale ${name}`, async () => {
      records = [source, changed, name.startsWith("source") ? extraction : observation];
      await render();
      await inspect(observation.recordId);
      hideBodies();
      expect(host.textContent).toContain(reason);
    });
  }
  for (const status of ["conflicted", "superseded", "retracted"]) {
    interaction(
      `retains ${status} source metadata while hiding source and observation content`,
      async () => {
        records = [{ ...source, status }, extraction, observation];
        await render();
        await inspect(source.recordId);
        hideBodies();
        await inspect(observation.recordId);
        hideBodies();
        expect(host.textContent).toContain(`Recorded ${status}`);
      },
    );
    interaction(`retains ${status} observation metadata while hiding its content`, async () => {
      records = [source, extraction, { ...observation, status }];
      await render();
      await inspect(observation.recordId);
      hideBodies();
    });
  }
  interaction("hides apparently current tombstoned source and observation", async () => {
    records = [{ ...source, tombstonedAt: at }, extraction, { ...observation, tombstonedAt: at }];
    await render();
    await inspect(source.recordId);
    hideBodies();
    await inspect(observation.recordId);
    hideBodies();
    expect(host.textContent).toContain("Retracted at");
  });
  interaction("a retracted correction does not revive an older current source", async () => {
    records.push({
      ...source,
      recordId: "source-2",
      generation: 3,
      status: "retracted",
      supersedes: source.recordId,
      tombstonedAt: at,
    });
    await render();
    await inspect(source.recordId);
    hideBodies();
    await inspect(observation.recordId);
    hideBodies();
    expect(host.textContent).toContain("Superseded");
  });
  interaction(
    "latest logical source and conflicts fence old facts even without a supersedes link",
    async () => {
      records.push({
        ...source,
        recordId: "source-2",
        sourceRevision: 4,
        generation: 3,
        status: "superseded",
      });
      await render();
      await inspect(observation.recordId);
      hideBodies();
      expect(host.textContent).toContain("Newer source version recorded");
      records.push({ ...source, recordId: "source-3", status: "conflicted" });
      await refresh();
      hideBodies();
      expect(host.textContent).toContain("Conflicting source history");
    },
  );
  interaction("a logical tombstone without a link suppresses current content", async () => {
    records.push({
      ...source,
      recordId: "source-tombstone",
      generation: 3,
      status: "retracted",
      tombstonedAt: at,
    });
    await render();
    await inspect(observation.recordId);
    hideBodies();
    expect(host.textContent).toContain("Logical source retracted");
  });
  interaction(
    "observation supersession remains suppressed after its correction is retracted",
    async () => {
      records.push({
        ...observation,
        recordId: "observation-2",
        status: "retracted",
        supersedes: observation.recordId,
      });
      await render();
      await inspect(observation.recordId);
      hideBodies();
      expect(host.textContent).toContain("Superseded");
    },
  );
  for (const supersedes of ["missing", "source-1"]) {
    interaction(`degrades invalid supersession ${supersedes}`, async () => {
      records = [{ ...source, supersedes }, extraction, observation];
      await render();
      await inspect(observation.recordId);
      hideBodies();
      expect(host.textContent).toContain("Invalid or incomplete supersession history");
    });
  }
  interaction(
    "unknown source state keeps readable metadata but withholds current content",
    async () => {
      records = [{ ...source, status: "future-state" }, extraction, observation];
      await render();
      await inspect(source.recordId);
      hideBodies();
      expect(host.textContent).toContain("Recorded future-state");
      expect(host.textContent).toContain("Unsupported records are present");
    },
  );
  interaction("malformed source page cannot publish any content", async () => {
    records = [{ ...source, generation: -1 }, extraction, observation];
    await render();
    hideBodies();
    expect(host.textContent).toContain("Reload the current snapshot");
    expect(button(`Inspect ${observation.recordId}`)).toBeUndefined();
  });
  interaction(
    "malformed source read variants degrade without rendering an invalid provenance object",
    async () => {
      records = [{ ...source, attribution: { actor: null } }, extraction, observation];
      await render();
      hideBodies();
      expect(host.textContent).toContain("Unsupported records are present");
      expect(button(`Inspect ${source.recordId}`)).toBeUndefined();
      await inspect(observation.recordId);
      hideBodies();
    },
  );
  interaction(
    "conflicting observations with the same key cannot expose a current body",
    async () => {
      records.push({ ...observation, recordId: "observation-conflict", status: "conflicted" });
      await render();
      await inspect(observation.recordId);
      hideBodies();
      expect(host.textContent).toContain("Conflicting observation history");
    },
  );
  interaction("other-project records are unavailable even with explicit sharing", async () => {
    records = [source, extraction, { ...observation, projectId: ProjectId.make("other-project") }];
    await render();
    hideBodies();
    expect(host.textContent).toContain("Reload the current snapshot");
  });
  interaction(
    "waits for the complete bounded cursor chain before exposing source or observation content",
    async () => {
      pages.set("", {
        projectId,
        revision,
        items: [source, observation],
        nextCursor: " second page ",
      });
      pages.set(" second page ", { projectId, revision, items: [extraction] });
      held = {
        cursor: " second page ",
        started: receipt(),
        released: receipt(),
      };
      await render();
      await held.started.promise;
      await inspect(observation.recordId);
      hideBodies();
      await act(async () => {
        held?.released.resolve();
        await settle({ environmentId, projectId, cursor: " second page " });
      });
      expect(host.textContent).toContain(observation.body);
      expect(reads.map(({ input }) => input)).toContainEqual({
        projectId,
        operation: "foundation-records",
        limit: 128,
        cursor: " second page ",
      });
    },
  );
  interaction(
    "refresh failure hides cached bodies until a successful complete refresh",
    async () => {
      await render();
      await inspect(observation.recordId);
      expect(host.textContent).toContain(observation.body);
      fail = true;
      await refresh();
      hideBodies();
      expect(host.textContent).toContain("Could not refresh project work");
      fail = false;
      await refresh();
      expect(host.textContent).toContain(observation.body);
    },
  );
  interaction(
    "a refreshed incomplete cursor chain hides a previously displayed cached body",
    async () => {
      await render();
      await inspect(observation.recordId);
      expect(host.textContent).toContain(observation.body);
      pages.set("", {
        projectId,
        revision: 11,
        items: [source, observation],
        nextCursor: "late-page",
      });
      pages.set("late-page", { projectId, revision: 11, items: [extraction] });
      held = {
        cursor: "late-page",
        started: receipt(),
        released: receipt(),
      };
      await click("Refresh memory");
      await held.started.promise;
      hideBodies();
      expect(host.textContent).toContain("Cached or incomplete memory");
      await act(async () => {
        held?.released.resolve();
        await settle({ environmentId, projectId, cursor: "late-page" });
      });
      expect(host.textContent).toContain(observation.body);
    },
  );
  interaction("the foundation page limit leaves recorded content hidden", async () => {
    pages.set("", {
      projectId,
      revision,
      items: [source, extraction, observation],
      nextCursor: "page-1",
    });
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
    await inspect(observation.recordId);
    hideBodies();
    expect(host.textContent).toContain("exceeds the guided view limit");
    expect(reads.some(({ input }) => "cursor" in input && input.cursor === "page-16")).toBe(false);
  });
  interaction(
    "disconnect and reconnect require a new read receipt before cached bodies return",
    async () => {
      await render();
      await inspect(observation.recordId);
      await render({ connected: false });
      hideBodies();
      held = {
        cursor: "",
        started: receipt(),
        released: receipt(),
      };
      await render();
      await held.started.promise;
      hideBodies();
      await act(async () => {
        held?.released.resolve();
        await settle();
      });
      expect(host.textContent).toContain(observation.body);
    },
  );
  interaction("re-enable also requires a fresh receipt and preserves metadata", async () => {
    await render();
    await inspect(observation.recordId);
    await render({ enabled: false });
    hideBodies();
    expect(host.textContent).toContain("Project Work is disabled");
    held = {
      cursor: "",
      started: receipt(),
      released: receipt(),
    };
    await render();
    await held.started.promise;
    hideBodies();
    await act(async () => {
      held?.released.resolve();
      await settle();
    });
    expect(host.textContent).toContain(observation.body);
  });
  interaction(
    "project and environment switches discard the previous inspection and refresh their own authority",
    async () => {
      await render();
      await inspect(observation.recordId);
      records = [];
      await render({ project: ProjectId.make("project-2") });
      hideBodies();
      expect(host.textContent).not.toContain("Inspecting observation-1");
      await render({ environment: otherEnvironmentId });
      hideBodies();
      expect(reads.some((read) => read.environmentId === otherEnvironmentId)).toBe(true);
      records = [source, extraction, observation];
      await render();
      hideBodies();
      await inspect(observation.recordId);
      expect(host.textContent).toContain(observation.body);
    },
  );
  interaction("old servers without the capability perform no foundation read", async () => {
    await render({ supported: false });
    hideBodies();
    expect(host.textContent).toContain("does not support memory inspection");
    expect(reads).toEqual([]);
  });
  interaction("renders a finite page and inspects only one body at a time", async () => {
    records = Array.from({ length: 70 }, (_, index) => ({
      ...source,
      recordId: `source-${index}`,
      sourceId: `logical-${index}`,
      content: `Bounded source text ${index}`,
    }));
    await render();
    expect(host.querySelectorAll("section")).toHaveLength(64);
    await inspect("source-0");
    expect(host.textContent).toContain("Bounded source text 0");
    await click("Next memory page");
    expect(host.querySelectorAll("section")).toHaveLength(6);
    expect(host.textContent).not.toContain("Bounded source text 0");
    await inspect("source-69");
    expect(host.textContent).toContain("Bounded source text 69");
    await click("Close inspection");
    expect(host.textContent).not.toContain("Bounded source text 69");
  });
});
