/* @vitest-environment happy-dom */

import { RegistryContext } from "@effect/atom-react";
import { createProjectWorkEnvironmentAtoms } from "@t3tools/client-runtime/project-work";
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
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import {
  EnvironmentId,
  ProjectId,
  ProjectTeamEvidenceApplicability,
  ProjectTeamGate,
  ProjectTeamPlanRevision,
  ProjectTeamEffect,
  ProjectWorkReadIntent,
  ProjectWorkTaskId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import type * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const bridge = vi.hoisted((): { atoms: unknown } => ({ atoms: undefined }));
vi.mock("~/state/projectWork", () => ({
  get projectWorkEnvironment() {
    return bridge.atoms;
  },
}));

import { Evidence, type EvidenceViewProps } from "./Evidence";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const taskId = ProjectWorkTaskId.make("task-1");
const otherTaskId = ProjectWorkTaskId.make("task-2");
const decodeRead = Schema.decodeUnknownEffect(ProjectWorkReadIntent);
const at = "2026-10-01T10:00:00.000Z";
const base = { projectId, revision: 2, generation: 0, updatedAt: at };
const evidence = Schema.decodeSync(ProjectTeamEvidenceApplicability)({
  ...base,
  kind: "evidence-applicability",
  recordId: "applicability-1",
  status: "current",
  taskId,
  evidenceId: "evidence-1",
  specRevision: 3,
  planRevision: 4,
  repository: "owner/repository",
  worktree: "/sandbox/tested-worktree",
  testedTree: "tested-tree-identity",
  testedCommit: "tested-commit-identity",
  baseSha: "original-base",
  headSha: "original-head",
  command: "vp test run targeted.test.ts\nnode validate.mjs",
  exitCode: 0,
  artifactId: "raw-artifact-identity",
  environmentSummary: "Linux x64 · Node 26 · isolated dependencies",
  integration: true,
});
const gate = Schema.decodeSync(ProjectTeamGate)({
  ...base,
  kind: "gate",
  recordId: "original-merge-gate",
  status: "approved",
  taskId,
  gate: "merge",
  specRevision: 3,
  planRevision: 4,
  contentHash: "gate-content-identity",
  repository: "owner/repository",
  pullRequestNumber: 42,
  headSha: "authorized-old-head",
  targetBranch: "main",
  mergeMethod: "squash",
  evidenceIds: ["evidence-1"],
  attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
});
const plan = Schema.decodeSync(ProjectTeamPlanRevision)({
  ...base,
  kind: "plan-revision",
  recordId: "plan-4",
  status: "proposed",
  taskId,
  specRevision: 3,
  planRevision: 4,
  content: "Scoped implementation",
  contentHash: "plan-content-identity",
  dependencyTaskIds: [],
});
const publication = Schema.decodeSync(ProjectTeamEffect)({
  ...base,
  kind: "effect",
  recordId: "publication-record",
  status: "uncertain",
  effectId: "original-publication-effect",
  effectKind: "publication",
  taskId,
  targetId: "original-merge-gate",
  payload: { recordIds: ["original-merge-gate"], expectedRevision: 7, summary: "Create task PR" },
  claimGeneration: 1,
  availableAt: at,
  outcome: "Response lost; reconciliation required",
});

describe("Evidence through mounted environment foundation atoms", () => {
  let root: Root;
  let host: HTMLDivElement;
  let registry: AtomRegistry.AtomRegistry;
  let atoms: ReturnType<typeof createProjectWorkEnvironmentAtoms>;
  let records: unknown[];
  let revision: number;
  let pages: Map<string, unknown>;
  let failRead: boolean;
  let holdRead: boolean;
  let started: Promise<void>;
  let start: () => void;
  let released: Promise<void>;
  let release: () => void;
  let reads: { environmentId: EnvironmentId; input: ProjectWorkReadIntent }[];
  let otherRequests: string[];

  const setup = Effect.gen(function* () {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    records = [evidence, gate, plan, publication];
    revision = 10;
    pages = new Map();
    failRead = false;
    holdRead = false;
    started = new Promise<void>((resolve) => {
      start = resolve;
    });
    released = new Promise<void>((resolve) => {
      release = resolve;
    });
    reads = [];
    otherRequests = [];
    const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
    for (const id of [environmentId, otherEnvironmentId]) {
      let respond: (
        message: RpcMessage.FromServer<RpcGroup.Rpcs<typeof WsRpcGroup>>,
      ) => Effect.Effect<void> = () => Effect.die("RPC channel not initialized");
      const channel = yield* RpcClient.makeNoSerialization(WsRpcGroup, {
        onFromClient: ({ message }) =>
          Effect.gen(function* () {
            if (message._tag !== "Request") return;
            if (message.tag !== WS_METHODS.projectWorkRead) {
              otherRequests.push(message.tag);
              return yield* respond({
                _tag: "Exit",
                clientId: 0,
                requestId: message.id,
                exit: Exit.die("Unexpected RPC"),
              });
            }
            const input = yield* decodeRead(message.payload).pipe(Effect.orDie);
            reads.push({ environmentId: id, input });
            if (input.operation !== "foundation-records")
              return yield* Effect.die("Unexpected read operation");
            const value = pages.has(input.cursor ?? "")
              ? pages.get(input.cursor ?? "")
              : { projectId: input.projectId, revision, items: input.cursor ? [] : records };
            if (holdRead) {
              start();
              yield* Effect.promise(() => released);
            }
            yield* respond({
              _tag: "Exit",
              clientId: 0,
              requestId: message.id,
              exit: failRead
                ? Exit.fail({ message: "Foundation read failed" })
                : Exit.succeed(value),
            });
          }),
      });
      respond = channel.write;
      const client = channel.client;
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
    const owner = (id: EnvironmentId) => {
      const supervisor = supervisors.get(id);
      if (!supervisor) throw new Error("Unknown fixture environment");
      return supervisor;
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
      state: (id) => SubscriptionRef.get(owner(id).state),
      stateChanges: (id) => SubscriptionRef.changes(owner(id).state),
      run: (id, effect) => Effect.provideService(effect, EnvironmentSupervisor, owner(id)),
      runStream: (id, stream) => Stream.provideService(stream, EnvironmentSupervisor, owner(id)),
      followStream: (id, stream) => Stream.provideService(stream, EnvironmentSupervisor, owner(id)),
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
    if (root) await act(async () => root.unmount());
    registry?.dispose();
    host?.remove();
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
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label,
    );
  async function render(overrides: Partial<EvidenceViewProps> = {}, wait = true) {
    const props = {
      environmentId,
      projectId,
      connected: true,
      supported: true,
      enabled: true,
      onOpenTask: () => {},
      ...overrides,
    };
    await act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <Evidence {...props} />
        </RegistryContext.Provider>,
      );
      if (wait && props.supported)
        await settle(
          atoms.foundationPage({ environmentId: props.environmentId, projectId: props.projectId }),
        );
    });
  }
  async function refresh() {
    await act(async () => {
      button("Refresh evidence")!.click();
      await settle(atoms.foundationPage({ environmentId, projectId }));
    });
  }
  async function click(label: string) {
    await act(async () => button(label)!.click());
  }

  interaction(
    "inspects exact evidence and original publication/gate identities without approval or delivery claims",
    async () => {
      await render();
      for (const value of [
        "vp test run targeted.test.ts",
        "node validate.mjs",
        "Exit code 0",
        "raw-artifact-identity",
        "tested-tree-identity",
        "tested-commit-identity",
        "original-base",
        "original-head",
        "Spec revision 3",
        "Plan revision 4",
        "Linux x64",
        "Integration evidence: yes",
        "Recorded applicability: current",
        "original-merge-gate",
        "authorized-old-head",
        "gate-content-identity",
        "original-publication-effect",
        "Expected project revision 7",
        "Response lost; reconciliation required",
        "plan-4",
      ])
        expect(host.textContent).toContain(value);
      expect(host.textContent).toContain("Complete recorded snapshot");
      expect(host.textContent).toContain("does not establish current approval or delivery");
      expect(host.querySelectorAll("a")).toHaveLength(0);
      expect(otherRequests).toEqual([]);
      expect(
        reads.every(({ input }) => input.operation === "foundation-records" && input.limit === 128),
      ).toBe(true);
    },
  );
  for (const status of ["stale", "rejected"]) {
    interaction(
      "preserves recorded " + status + " applicability and failed-command evidence",
      async () => {
        records = [{ ...evidence, status, exitCode: 1 }];
        await render();
        expect(host.textContent).toContain("Recorded applicability: " + status);
        expect(host.textContent).toContain("Exit code 1");
        expect(host.textContent).not.toContain("Recorded applicability: current");
      },
    );
  }
  interaction(
    "keeps dirty tested-tree evidence distinct from later commit/head and plan records",
    async () => {
      const dirtyEvidence = { ...evidence };
      delete dirtyEvidence.testedCommit;
      records = [dirtyEvidence, gate, plan];
      await render();
      expect(host.textContent).toContain("Tested commit not recorded");
      expect(host.textContent).toContain("A tested tree does not qualify a later commit");
      records = [
        dirtyEvidence,
        { ...gate, headSha: "later-head", status: "invalidated" },
        { ...plan, recordId: "plan-5", planRevision: 5, contentHash: "changed-plan" },
      ];
      revision = 11;
      await refresh();
      expect(host.textContent).toContain("later-head");
      expect(host.textContent).toContain("original-head");
      expect(host.textContent).toContain("Recorded applicability: current");
      expect(host.textContent).toContain("Recorded gate status: invalidated");
      expect(host.textContent).toContain("Plan revision 5");
      expect(host.textContent).not.toContain("tested-commit-identity");
    },
  );
  for (const status of ["pending", "failed", "uncertain", "succeeded"]) {
    interaction(
      "inspects recorded publication " + status + " without inferring merge success",
      async () => {
        records = [{ ...publication, status }, gate];
        await render();
        expect(host.textContent).toContain("Recorded publication status: " + status);
        expect(host.textContent).toContain("Target original-merge-gate");
        expect(host.textContent).toContain("authorized-old-head");
        expect(host.textContent).toContain("Publication receipts do not confirm a merge");
        expect(host.textContent).toContain("No evidence records in this snapshot");
        expect(otherRequests).toEqual([]);
      },
    );
  }
  interaction(
    "retains cached records through a held/failed refresh and recovers a complete snapshot",
    async () => {
      await render();
      holdRead = true;
      await act(async () => {
        button("Refresh evidence")!.click();
        await started;
      });
      expect(host.textContent).toContain("Cached or incomplete evidence");
      expect(host.textContent).toContain("tested-tree-identity");
      failRead = true;
      await act(async () => {
        holdRead = false;
        release();
        await settle(atoms.foundationPage({ environmentId, projectId }));
      });
      expect(host.textContent).toContain("Could not refresh project work");
      expect(host.textContent).toContain("Cached or incomplete evidence");
      expect(host.textContent).toContain("original-head");
      failRead = false;
      records = [{ ...evidence, status: "stale" }];
      revision = 11;
      await refresh();
      expect(host.textContent).toContain("Complete recorded snapshot");
      expect(host.textContent).toContain("Recorded applicability: stale");
    },
  );
  interaction(
    "shows cached metadata offline and refreshes recorded applicability after reconnect",
    async () => {
      await render();
      await render({ connected: false });
      expect(host.textContent).toContain("Cached or incomplete evidence");
      expect(host.textContent).toContain("Last recorded update " + at);
      expect(button("Refresh evidence")?.disabled).toBe(true);
      records = [{ ...evidence, status: "rejected" }];
      revision = 11;
      await render();
      await refresh();
      expect(host.textContent).toContain("Recorded applicability: rejected");
      expect(host.textContent).toContain("Complete recorded snapshot");
    },
  );
  interaction(
    "marks an unfinished cursor chain incomplete until the final page settles",
    async () => {
      pages.set("", { projectId, revision: 10, items: [evidence], nextCursor: "next" });
      holdRead = true;
      await render({}, false);
      await started;
      expect(host.textContent).toContain("Cached or incomplete evidence");
      pages.set("next", { projectId, revision: 10, items: [publication] });
      await act(async () => {
        holdRead = false;
        release();
        await settle(atoms.foundationPage({ environmentId, projectId }));
      });
      await act(async () =>
        settle(atoms.foundationPage({ environmentId, projectId, cursor: "next" })),
      );
      expect(host.textContent).toContain("Complete recorded snapshot");
      expect(host.textContent).toContain("original-publication-effect");
    },
  );
  interaction("rejects mixed-revision pages and rebuilds a coherent snapshot", async () => {
    pages.set("", { projectId, revision: 10, items: [evidence], nextCursor: "next" });
    pages.set("next", { projectId, revision: 11, items: [publication] });
    await render();
    await act(async () =>
      settle(atoms.foundationPage({ environmentId, projectId, cursor: "next" })),
    );
    expect(host.textContent).toContain("Cached or incomplete evidence");
    expect(host.textContent).not.toContain("original-publication-effect");
    pages.set("", { projectId, revision: 12, items: [{ ...evidence, status: "stale" }] });
    await refresh();
    expect(host.textContent).toContain("Complete recorded snapshot");
    expect(host.textContent).toContain("Recorded applicability: stale");
  });
  for (const malformed of [
    { name: "future applicability", record: { ...evidence, status: "future-applicability" } },
    { name: "invalid exit code", record: { ...evidence, exitCode: "success" } },
    {
      name: "future kind",
      record: { ...base, kind: "future-evidence", recordId: "future", status: "available" },
    },
  ]) {
    interaction("does not qualify " + malformed.name, async () => {
      records = [malformed.record];
      await render();
      expect(host.textContent).toContain("Unsupported or malformed records");
      expect(host.textContent).toContain("Applicability is unknown for those records");
      expect(host.textContent).not.toContain("Recorded applicability: current");
      expect(host.textContent).not.toContain("raw-artifact-identity");
      expect(host.textContent).toContain("Cached or incomplete evidence");
    });
  }
  interaction("rejects a foreign project page instead of displaying its evidence", async () => {
    records = [{ ...evidence, projectId: otherProjectId }];
    await render();
    expect(host.textContent).toContain("Project work changed while loading");
    expect(host.textContent).not.toContain("raw-artifact-identity");
  });
  interaction("clears cached evidence when the environment or project owner changes", async () => {
    await render();
    records = [];
    await render({ environmentId: otherEnvironmentId });
    expect(host.textContent).not.toContain("raw-artifact-identity");
    expect(reads.at(-1)?.environmentId).toBe(otherEnvironmentId);
    await render({ projectId: otherProjectId });
    expect(host.textContent).not.toContain("raw-artifact-identity");
    expect(reads.at(-1)?.input.projectId).toBe(otherProjectId);
  });
  interaction(
    "filters exact task identity and excludes unrelated or missing-owner publication/gates",
    async () => {
      records.push({
        ...evidence,
        recordId: "applicability-other",
        evidenceId: "other-evidence",
        taskId: otherTaskId,
        artifactId: "other-artifact",
      });
      records.push({
        ...gate,
        recordId: "foreign-task-gate",
        taskId: otherTaskId,
        headSha: "foreign-task-head",
      });
      records.push({
        ...publication,
        recordId: "other-publication",
        effectId: "other-effect",
        taskId: otherTaskId,
      });
      const unowned = {
        ...publication,
        recordId: "unowned-publication",
        effectId: "unowned-effect",
      };
      delete unowned.taskId;
      records.push(unowned);
      await render({ taskId });
      expect(host.textContent).toContain("raw-artifact-identity");
      for (const value of ["other-artifact", "foreign-task-head", "other-effect", "unowned-effect"])
        expect(host.textContent).not.toContain(value);
      await render({ taskId: otherTaskId });
      expect(host.textContent).toContain("other-artifact");
      expect(host.textContent).not.toContain("raw-artifact-identity");
    },
  );
  interaction(
    "bounds rendered evidence/publication pages and resets pagination for a task filter",
    async () => {
      const all = Array.from({ length: 129 }, (_, index) => ({
        ...evidence,
        recordId: "evidence-record-" + index,
        evidenceId: "evidence-" + index,
        artifactId: "artifact-" + index,
        taskId: index === 128 ? otherTaskId : taskId,
      }));
      pages.set("", { projectId, revision: 10, items: all.slice(0, 128), nextCursor: "next" });
      pages.set("next", { projectId, revision: 10, items: all.slice(128) });
      await render();
      await act(async () =>
        settle(atoms.foundationPage({ environmentId, projectId, cursor: "next" })),
      );
      expect(host.querySelectorAll("section")).toHaveLength(128);
      expect(host.textContent).not.toContain("artifact-128");
      await click("Next evidence page");
      expect(host.querySelectorAll("section")).toHaveLength(1);
      expect(host.textContent).toContain("artifact-128");
      await render({ taskId });
      expect(host.querySelectorAll("section")).toHaveLength(128);
      expect(host.textContent).not.toContain("artifact-128");
      expect(
        reads.every(({ input }) => input.operation === "foundation-records" && input.limit === 128),
      ).toBe(true);
      expect(otherRequests).toEqual([]);
    },
  );
  interaction("explains unsupported old servers without requesting foundation reads", async () => {
    await render({ supported: false });
    expect(host.textContent).toContain("does not support evidence inspection");
    expect(reads).toEqual([]);
    expect(otherRequests).toEqual([]);
  });
  interaction("labels disabled project work as cached and does not offer refresh", async () => {
    await render();
    await render({ enabled: false });
    expect(host.textContent).toContain("Project Work is disabled");
    expect(host.textContent).toContain("Cached or incomplete evidence");
    expect(button("Refresh evidence")?.disabled).toBe(true);
    expect(otherRequests).toEqual([]);
  });
});
