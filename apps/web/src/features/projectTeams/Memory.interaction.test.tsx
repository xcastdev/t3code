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

import { Memory } from "./Memory";

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

  const setup = Effect.gen(function* () {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    records = [source, extraction, observation, indexJob];
    revision = 10;
    pages = new Map();
    reads = [];
    held = undefined;
    fail = false;
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
