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
  canonicalProjectWorkPayload,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskContext,
  ProjectWorkTaskId,
  ProjectWorkReadIntent,
  PullRequestDetailView,
  WS_METHODS,
  WsRpcGroup,
  type PullRequestRef,
  type ProjectWorkPublicationRequest,
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
import { sha256 } from "@noble/hashes/sha2";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
const bridge = vi.hoisted(() => ({
  atoms: undefined as unknown,
  config: undefined as unknown,
  connected: true,
  project: true,
  commands: vi.fn(),
}));
vi.mock("~/state/projectWork", () => ({
  get projectWorkEnvironment() {
    return bridge.atoms;
  },
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => bridge.config } }));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    connection: { phase: bridge.connected ? "connected" : "disconnected" },
  }),
}));
vi.mock("~/state/entities", () => ({
  useProject: (ref: { environmentId: string; projectId: string }) =>
    bridge.project
      ? { id: ref.projectId, environmentId: ref.environmentId, title: "Scoped project" }
      : null,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => bridge.commands }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("./pullRequestMutationApproval", () => ({ usePullRequestMutationApproval: () => null }));
vi.mock("./PullRequestMarkdown", () => ({
  PullRequestMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.mock("./PullRequestMarkdownEditor", () => ({ PullRequestMarkdownEditor: () => null }));
vi.mock("./PullRequestLabelPicker", () => ({ PullRequestLabelPicker: () => null }));
vi.mock("./PullRequestReviewerPicker", () => ({ PullRequestReviewerPicker: () => null }));
vi.mock("./PullRequestReactions", () => ({ PullRequestReactionBar: () => null }));
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const projectId = ProjectId.make("project-1");
const at = "2026-10-01T10:00:00.000Z";
const read = Schema.decodeUnknownEffect(ProjectWorkReadIntent);
const readJson = Schema.fromJsonString(ProjectWorkReadIntent);
const encodeRead = Schema.encodeSync(readJson);
const decodeRead = Schema.decodeUnknownEffect(readJson);
const encodeWire = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeWire = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const reference: PullRequestRef = {
  projectId,
  host: "github.com",
  repository: "owner/repo",
  number: 42,
};
const detail = Schema.decodeUnknownSync(PullRequestDetailView)({
  provider: "github",
  projectId,
  projectTitle: "Scoped project",
  workspaceRoot: "/fixture",
  repository: "owner/repo",
  number: 42,
  title: "Reconnect",
  body: "PR description remains visible",
  url: "https://github.com/owner/repo/pull/42",
  author: null,
  state: "open",
  isDraft: false,
  mergeability: "unknown",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  baseRevision: "a".repeat(40),
  headRevision: "b".repeat(40),
  createdAt: at,
  updatedAt: at,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    actions: [],
    mergeMethods: [],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
});
function publication(taskId = "task-1", operationId = "publication-1") {
  const request: ProjectWorkPublicationRequest = {
    version: 1,
    kind: "create-pr",
    operationId,
    marker: "marker_" + operationId,
    repository: { host: "github.com", nodeId: "R_base", nameWithOwner: "owner/repo" },
    target: {
      projectId,
      taskId: ProjectWorkTaskId.make(taskId),
      specRevision: 2,
      planRevision: 3,
      scopeHash: "scope",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      baseRef: "main",
      headRef: "feature",
      headRepositoryNodeId: "R_base",
      headSelector: "feature",
    },
    expectedTaskRevision: 4,
    authorizationRecordIds: ["proof"],
    title: "Reconnect",
    body: "Retained publication",
  };
  const summary = canonicalProjectWorkPayload(request);
  const outcome = {
    version: 1,
    kind: "confirmed",
    operationId,
    marker: request.marker,
    repository: request.repository,
    requestHash: [...sha256(new TextEncoder().encode(summary))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
    claimGeneration: 1,
    observedAt: at,
    pullRequest: {
      nodeId: "PR_one",
      number: 42,
      url: detail.url,
      state: "OPEN",
      baseSha: request.target.baseSha,
      headSha: request.target.headSha,
      baseRef: "main",
      headRef: "feature",
      headRepositoryNodeId: "R_base",
    },
  };
  return {
    kind: "effect",
    recordId: operationId,
    effectId: operationId,
    projectId,
    taskId,
    revision: 2,
    generation: 0,
    updatedAt: at,
    status: "succeeded",
    effectKind: "publication",
    targetId: "github.com/owner/repo",
    payload: { recordIds: ["proof"], expectedRevision: 4, summary },
    claimGeneration: 1,
    availableAt: at,
    outcome: canonicalProjectWorkPayload(outcome),
  };
}
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
const decodeTaskFixture = Schema.decodeUnknownSync(ProjectWorkTaskContext);
function context(taskId: string, project = projectId) {
  const criterion = {
    criterionId: "criterion-1",
    taskId,
    description: "Preserve reconnect history",
    required: true,
    status: "unsatisfied",
    satisfiedByEvidenceIds: [],
    revision: 1,
    updatedAt: at,
  };
  return decodeTaskFixture({
    projectId: project,
    revision: 10,
    task: {
      taskId,
      projectId: project,
      title: "Task " + taskId,
      state: "specified",
      revision: 4,
      specRevision: 2,
      watchers: [],
      createdAt: at,
      updatedAt: at,
      specification: {
        objective: "Keep reconnect state",
        scopeIn: "Remote reconnect",
        scopeOut: "Authentication",
        criterionIds: [criterion.criterionId],
        revision: 2,
        protected: false,
      },
    },
    criteria: [criterion],
    evidence: [
      {
        evidenceId: "evidence-1",
        taskId,
        kind: "observation",
        summary: "Recorded reconnect observation",
        recordedAt: at,
        revision: 1,
      },
    ],
    comments: [],
    relationships: [],
    blockers: [],
    children: { criteria: [], evidence: [], relationships: [], blockers: [], comments: [] },
    policy: {
      taskId,
      readiness: { ready: false, reasons: [] },
      claimability: { claimable: false },
      actions,
      attention: [],
    },
  });
}
describe("PR Summary Project Work through generated environment RPC atoms", () => {
  let root: Root;
  let host: HTMLDivElement;
  let registry: AtomRegistry.AtomRegistry;
  let atoms: ReturnType<typeof createProjectWorkEnvironmentAtoms>;
  let records: unknown[];
  let requests: { environmentId: EnvironmentId; input: ProjectWorkReadIntent }[];
  let unexpected: string[];
  let taskValue: unknown;
  let hold: boolean;
  let started: Promise<void>;
  let start: () => void;
  let released: Promise<void>;
  let release: () => void;
  const setup = Effect.gen(function* () {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    bridge.connected = bridge.project = true;
    bridge.commands.mockReset();
    records = [publication()];
    requests = [];
    unexpected = [];
    taskValue = context("task-1");
    hold = false;
    started = new Promise<void>((resolve) => (start = resolve));
    released = new Promise<void>((resolve) => (release = resolve));
    const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
    for (const id of [environmentId, otherEnvironmentId]) {
      let respond: (
        message: RpcMessage.FromServer<RpcGroup.Rpcs<typeof WsRpcGroup>>,
      ) => Effect.Effect<void> = () => Effect.die("RPC not initialized");
      const channel = yield* RpcClient.makeNoSerialization(WsRpcGroup, {
        onFromClient: ({ message }) =>
          Effect.gen(function* () {
            if (message._tag !== "Request") return;
            if (message.tag !== WS_METHODS.projectWorkRead) {
              unexpected.push(message.tag);
              return yield* respond({
                _tag: "Exit",
                clientId: 0,
                requestId: message.id,
                exit: Exit.die("Unexpected RPC"),
              });
            }
            const decoded = yield* read(message.payload).pipe(Effect.orDie);
            const input = yield* decodeRead(encodeRead(decoded)).pipe(Effect.orDie);
            requests.push({ environmentId: id, input });
            const value =
              input.operation === "foundation-records"
                ? { projectId: input.projectId, revision: 10, items: records }
                : taskValue;
            if (input.operation === "task-context" && hold) {
              start();
              yield* Effect.promise(() => released);
            }
            yield* respond({
              _tag: "Exit",
              clientId: 0,
              requestId: message.id,
              exit: Exit.succeed(decodeWire(encodeWire(value))),
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
      const found = supervisors.get(id);
      if (!found) throw Error("Unknown owner");
      return found;
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
    bridge.config = Atom.make({
      settings: { projectWorkEnabled: true },
      environment: { capabilities: { projectTeamFoundationReads: true } },
    });
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
    vi.unstubAllGlobals();
  });
  const settle = (atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>) =>
    new Promise<void>((resolve) => {
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
  async function render(owner = environmentId, ref = reference, view = detail) {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <PullRequestSummaryTab
            environmentId={owner}
            reference={ref}
            detail={view}
            threadRef={null}
            activityPending={false}
            activityError={null}
            onRefresh={() => {}}
          />
        </RegistryContext.Provider>,
      ),
    );
  }
  async function click(label: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.trim() === label,
    );
    if (!button) throw Error("Missing button " + label);
    await act(async () => button.click());
  }
  async function expand(owner = environmentId, ref = reference) {
    await click("Project Work");
    await act(async () =>
      settle(atoms.foundationPage({ environmentId: owner, projectId: ref.projectId, poll: false })),
    );
  }
  async function select(taskId = "task-1", owner = environmentId, ref = reference) {
    await click("Inspect task " + taskId);
    await act(async () =>
      settle(
        atoms.taskContext({
          environmentId: owner,
          projectId: ref.projectId,
          taskId: ProjectWorkTaskId.make(taskId),
          poll: false,
        }),
      ),
    );
  }
  interaction(
    "reads nothing until expanded, then loads only the explicitly selected task",
    async () => {
      await render();
      expect(requests).toEqual([]);
      expect(host.textContent).toContain("PR description remains visible");
      await expand();
      expect(requests.map((row) => row.input.operation)).toEqual(["foundation-records"]);
      await select();
      expect(host.textContent).toContain("Keep reconnect state");
      expect(host.textContent).toContain("Preserve reconnect history");
      expect(host.textContent).toContain("Recorded reconnect observation");
      expect(host.textContent).toContain("Current task specification 2");
      expect(
        host.querySelector('a[href="/work/environment-1/project-1?tab=tasks&taskId=task-1"]'),
      ).not.toBeNull();
      expect(requests.map((row) => row.input.operation)).toEqual([
        "foundation-records",
        "task-context",
      ]);
      expect(unexpected).toEqual([]);
      expect(bridge.commands).not.toHaveBeenCalled();
    },
  );
  interaction("requires an explicit choice among multiple retained task relations", async () => {
    records = [publication(), publication("task-2", "publication-2")];
    await render();
    await expand();
    expect(requests.every((row) => row.input.operation === "foundation-records")).toBe(true);
    expect(host.textContent).not.toContain("Keep reconnect state");
    taskValue = context("task-2");
    await select("task-2");
    expect(host.textContent).toContain("Task task-2");
    expect(host.textContent).not.toContain("Task task-1");
    expect(
      requests
        .filter((row) => row.input.operation === "task-context")
        .map((row) => row.input.taskId),
    ).toEqual(["task-2"]);
  });
  interaction(
    "keeps historical commits and revisions separate when the PR head and task have advanced",
    async () => {
      const updated = context("task-1");
      taskValue = {
        ...updated,
        task: {
          ...updated.task,
          revision: 8,
          specRevision: 5,
          specification: { ...updated.task.specification, revision: 5 },
        },
      };
      await render(environmentId, reference, { ...detail, headRevision: "c".repeat(40) });
      await expand();
      await select();
      expect(host.textContent).toContain("Retained publication head " + "b".repeat(40));
      expect(host.textContent).toContain("Current PR head " + "c".repeat(40));
      expect(host.textContent).toContain("differs from the retained publication");
      expect(host.textContent).toContain("Current task specification 5");
      expect(host.textContent).toContain("publication specification 2");
      expect(host.textContent).toContain("Current criteria are not frozen publication evidence");
    },
  );
  interaction(
    "removes old selections on PR and environment changes, including a held task response",
    async () => {
      await render();
      await expand();
      hold = true;
      await click("Inspect task task-1");
      await started;
      await render(
        otherEnvironmentId,
        { ...reference, number: 43 },
        { ...detail, number: 43, url: "https://github.com/owner/repo/pull/43" },
      );
      expect(host.textContent).not.toContain("Retained publication");
      expect(host.textContent).not.toContain("Keep reconnect state");
      await act(async () => {
        release();
        await settle(
          atoms.taskContext({
            environmentId,
            projectId,
            taskId: ProjectWorkTaskId.make("task-1"),
            poll: false,
          }),
        );
      });
      expect(host.textContent).not.toContain("Keep reconnect state");
      expect(host.querySelector('a[href*="taskId="]')).toBeNull();
    },
  );
  interaction("collapses and reopens without retaining a previous task selection", async () => {
    await render();
    await expand();
    await select();
    await click("Project Work");
    expect(host.textContent).not.toContain("Keep reconnect state");
    await click("Project Work");
    expect(host.textContent).not.toContain("Keep reconnect state");
    expect(host.textContent).toContain("Inspect task task-1");
    expect(bridge.commands).not.toHaveBeenCalled();
  });
  interaction(
    "keeps cached inspection honest while disconnected and refuses explicit refresh",
    async () => {
      await render();
      await expand();
      await select();
      const count = requests.length;
      bridge.connected = false;
      await render();
      expect(host.textContent).toContain("Cached or disconnected");
      expect(host.textContent).toContain("Keep reconnect state");
      expect(host.textContent).toContain(at);
      await click("Refresh Project Work");
      expect(requests).toHaveLength(count);
      expect(bridge.commands).not.toHaveBeenCalled();
    },
  );
  for (const invalid of [
    "host",
    "repository",
    "number",
    "foreign-record",
    "duplicate",
    "malformed",
    "future",
  ] as const) {
    interaction(
      "rejects " + invalid + " retained history through the actual Summary RPC path",
      async () => {
        let ref = reference;
        let view = detail;
        if (invalid === "host" || invalid === "repository" || invalid === "number") {
          ref = {
            ...reference,
            ...(invalid === "host"
              ? { host: "enterprise.test" }
              : invalid === "repository"
                ? { repository: "foreign/repo" }
                : { number: 43 }),
          };
          view = {
            ...detail,
            repository: ref.repository,
            number: ref.number,
            url: `https://${ref.host}/${ref.repository}/pull/${ref.number}`,
          };
        }
        if (invalid === "foreign-record")
          records = [{ ...publication(), projectId: "foreign-project" }];
        if (invalid === "duplicate") records = [publication(), publication()];
        if (invalid === "malformed") records = [{ ...publication(), outcome: "not-json" }];
        if (invalid === "future") records = [{ ...publication(), status: "future-success" }];
        await render(environmentId, ref, view);
        await expand(environmentId, ref);
        expect(host.textContent).toContain("No verified retained task relation");
        expect(host.querySelector('a[href*="taskId="]')).toBeNull();
        expect(requests.every((row) => row.input.operation === "foundation-records")).toBe(true);
        expect(unexpected).toEqual([]);
        expect(bridge.commands).not.toHaveBeenCalled();
      },
    );
  }
  for (const change of ["environment", "project", "repository", "number"] as const) {
    interaction(
      "clears a held task response when only the PR " + change + " owner changes",
      async () => {
        await render();
        await expand();
        hold = true;
        await click("Inspect task task-1");
        await started;
        const ref = {
          ...reference,
          ...(change === "project"
            ? { projectId: ProjectId.make("project-2") }
            : change === "repository"
              ? { repository: "other/repo" }
              : change === "number"
                ? { number: 43 }
                : {}),
        };
        const owner = change === "environment" ? otherEnvironmentId : environmentId;
        const view = {
          ...detail,
          projectId: ref.projectId,
          repository: ref.repository,
          number: ref.number,
          url: `https://github.com/${ref.repository}/pull/${ref.number}`,
        };
        await render(owner, ref, view);
        expect(host.textContent).not.toContain("Retained publication head");
        await act(async () => {
          release();
          await settle(
            atoms.taskContext({
              environmentId,
              projectId,
              taskId: ProjectWorkTaskId.make("task-1"),
              poll: false,
            }),
          );
        });
        expect(host.textContent).not.toContain("Keep reconnect state");
        expect(host.querySelector('a[href*="taskId="]')).toBeNull();
      },
    );
  }
  interaction(
    "refreshes only the selected task and bounded foundation while eligible",
    async () => {
      await render();
      await expand();
      await select();
      const before = requests.length;
      await click("Refresh Project Work");
      await act(async () => {
        await settle(atoms.foundationPage({ environmentId, projectId, poll: false }));
        await settle(
          atoms.taskContext({
            environmentId,
            projectId,
            taskId: ProjectWorkTaskId.make("task-1"),
            poll: false,
          }),
        );
      });
      expect(
        requests
          .slice(before)
          .map((row) => row.input.operation)
          .sort(),
      ).toEqual(["foundation-records", "task-context"]);
      expect(unexpected).toEqual([]);
      expect(bridge.commands).not.toHaveBeenCalled();
    },
  );
});
