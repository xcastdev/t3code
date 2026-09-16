/* @vitest-environment happy-dom */

import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { EnvironmentCacheStore } from "@t3tools/client-runtime/platform";
import { createReviewEnvironmentAtoms } from "@t3tools/client-runtime/state/review";
import { createSourceControlWorkspaceEnvironmentAtoms } from "@t3tools/client-runtime/state/sourceControlWorkspace";
import { EnvironmentId, ProjectId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";

import type {
  PreparedConnection,
  SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";

const runtimeState = vi.hoisted(() => ({
  configAtom: undefined as unknown,
  review: undefined as Record<string, unknown> | undefined,
  workspace: undefined as Record<string, unknown> | undefined,
}));
const routeRef = vi.hoisted(() => ({
  environmentId: "environment",
  threadId: "thread",
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: ({ select }: { select: (params: unknown) => unknown }) => select(routeRef),
}));
vi.mock("~/threadRoutes", () => ({ resolveThreadRouteRef: () => routeRef }));
vi.mock("~/state/entities", () => ({
  useThread: () => ({
    id: ThreadId.make("thread"),
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
    worktreePath: null,
    checkpoints: [],
  }),
  useProject: () => ({ workspaceRoot: "/repo", repositoryIdentity: { rootPath: "/repo" } }),
}));
// These adapters remain production atom/query/command boundaries. The test
// swaps only their transport runtime, allowing request counts below the cache.
vi.mock("~/state/sourceControl", () => ({
  get sourceControlWorkspaceEnvironment() {
    return runtimeState.workspace;
  },
}));
vi.mock("~/state/review", () => ({
  get reviewEnvironment() {
    return runtimeState.review;
  },
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => runtimeState.configAtom,
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => ({
    diffLayout: "unified",
    wordWrap: false,
    diffIgnoreWhitespace: false,
    diffFilesCollapsed: false,
    timestampFormat: "relative",
  }),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: (initial: unknown) => [initial, vi.fn()],
}));
vi.mock("~/hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: () => ({ turnDiffSummaries: [], inferredCheckpointTurnCountByTurnId: {} }),
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({
  useWorkspaceMutationRefresh: () => undefined,
}));
vi.mock("~/lib/checkpointDiffState", () => ({
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false }),
}));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("./DiffPanelShell", () => ({
  DiffPanelLoadingState: () => <div>Loading diff</div>,
  DiffPanelShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./diffs/AnnotatableCodeView", () => ({
  AnnotatableCodeView: ({ files }: { files: ReadonlyArray<unknown> }) => (
    <div>{files.length > 0 ? <div data-title="">README.md</div> : null}</div>
  ),
}));

import DiffPanel from "./DiffPanel";
import { SecondaryPaneDiffPanel } from "./workspace/SecondaryPaneDiffPanel";
import { useRightPanelStore } from "~/rightPanelStore";
import { useDiffPanelStore } from "~/diffPanelStore";
import { selectThreadSecondaryPaneState, useSecondaryPaneStore } from "~/secondaryPaneStore";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const threadRef = scopeThreadRef(environmentId, threadId);
const roots: Root[] = [];

type TransportCounts = {
  statusSubscriptions: number;
  previewRequests: number;
  refsRequests: number;
  fileComparisons: number;
};

function makeRuntime(counts: TransportCounts) {
  return Effect.gen(function* () {
    const status = yield* SubscriptionRef.make({
      _tag: "snapshot" as const,
      local: {
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "feature",
        headCommit: "a".repeat(40),
        indexTree: "i".repeat(40),
        hasWorkingTreeChanges: true,
        workingTree: { files: [], insertions: 1, deletions: 0, snapshotId: "worktree-1" },
      },
      remote: null,
    });
    const protocol: WsRpcProtocolClient = {
      [WS_METHODS.subscribeVcsStatus]: () => {
        counts.statusSubscriptions += 1;
        return SubscriptionRef.changes(status);
      },
      [WS_METHODS.reviewGetDiffPreview]: () =>
        Effect.sync(() => {
          counts.previewRequests += 1;
          return {
            cwd: "/repo",
            sources: [
              {
                id: "working-tree",
                kind: "working-tree" as const,
                title: "Against base branch",
                baseRef: "origin/main",
                headRef: "feature",
                baseRevision: "b".repeat(40),
                headRevision: "a".repeat(40),
                diffHash: "aggregate-a",
                truncated: false,
                diff: [
                  "diff --git a/README.md b/README.md",
                  "--- a/README.md",
                  "+++ b/README.md",
                  "@@ -1 +1 @@",
                  "-before",
                  "+after",
                ].join("\n"),
              },
            ],
          };
        }),
      [WS_METHODS.vcsListRefs]: () =>
        Effect.sync(() => {
          counts.refsRequests += 1;
          return {
            refs: [],
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 0,
          };
        }),
      [WS_METHODS.gitCompareRepositoryFile]: () =>
        Effect.sync(() => {
          counts.fileComparisons += 1;
          return { oldContents: "before", newContents: "after", binary: false, available: true };
        }),
    } as unknown as WsRpcProtocolClient;
    const supervisor = EnvironmentSupervisor.of({
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "test",
        httpBaseUrl: "http://test",
        wsBaseUrl: "ws://test",
      }),
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
        generation: 1,
      }),
      session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
        Option.some({
          client: protocol,
          initialConfig: Effect.never,
          subscribeServerConfig: protocol.subscribeServerConfig,
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        }),
      ),
      prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor);
    const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor);
    const runtime = Atom.runtime(
      Layer.merge(
        Layer.succeed(EnvironmentRegistry, { run, followStream } as EnvironmentRegistry["Service"]),
        Layer.succeed(
          EnvironmentCacheStore,
          EnvironmentCacheStore.of({
            loadShell: () => Effect.succeed(Option.none()),
            saveShell: () => Effect.void,
            loadThread: () => Effect.succeed(Option.none()),
            saveThread: () => Effect.void,
            removeThread: () => Effect.void,
            loadServerConfig: () => Effect.succeed(Option.none()),
            saveServerConfig: () => Effect.void,
            loadVcsRefs: () => Effect.succeed(Option.none()),
            saveVcsRefs: () => Effect.void,
            removeVcsRefs: () => Effect.void,
            clearVcsRefs: () => Effect.void,
            clear: () => Effect.void,
          }),
        ),
      ),
    );
    return { registry: AtomRegistry.make(), runtime };
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ sourceControlRepositoryRootByThreadKey: {} });
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  useSecondaryPaneStore.setState({ byThreadKey: {} });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.effect(
  "opens an aggregate file through the rendered path without duplicating its live repository queries",
  () =>
    Effect.gen(function* () {
      const counts: TransportCounts = {
        statusSubscriptions: 0,
        previewRequests: 0,
        refsRequests: 0,
        fileComparisons: 0,
      };
      const { registry, runtime } = yield* makeRuntime(counts);
      const configAtom = Atom.make({
        environment: { capabilities: { sourceControlWorkspace: true } },
        availableEditors: [],
      });
      runtimeState.configAtom = configAtom;
      runtimeState.workspace = createSourceControlWorkspaceEnvironmentAtoms(runtime, {
        capabilities: (activeRegistry) => activeRegistry.get(configAtom).environment.capabilities,
      });
      runtimeState.review = createReviewEnvironmentAtoms(runtime);
      // Persist the aggregate selection before subscribing through Zustand; the
      // empty-store fallback is intentionally a freshly derived value.
      useDiffPanelStore.getState().selectGitScope(threadRef, "unstaged", "/repo");

      const aggregateContainer = document.createElement("div");
      const secondaryContainer = document.createElement("div");
      document.body.append(aggregateContainer, secondaryContainer);
      const aggregateRoot = createRoot(aggregateContainer);
      const secondaryRoot = createRoot(secondaryContainer);
      roots.push(aggregateRoot, secondaryRoot);
      yield* Effect.promise(() =>
        act(async () => {
          aggregateRoot.render(
            <RegistryContext.Provider value={registry}>
              <DiffPanel
                mode="embedded"
                composerDraftTarget={threadRef}
                initialGitScope="unstaged"
                workspaceMutationId={null}
              />
            </RegistryContext.Provider>,
          );
          await Promise.resolve();
          await Promise.resolve();
        }),
      );
      expect(counts.previewRequests).toBe(1);
      expect(counts.statusSubscriptions).toBe(1);
      const aggregateRequests = {
        statusSubscriptions: counts.statusSubscriptions,
        previewRequests: counts.previewRequests,
        refsRequests: counts.refsRequests,
      };

      const filename = aggregateContainer.querySelector<HTMLElement>("[data-title]");
      expect(filename?.textContent).toBe("README.md");
      yield* Effect.promise(() =>
        act(async () => {
          filename!.click();
        }),
      );
      const surface = selectThreadSecondaryPaneState(
        useSecondaryPaneStore.getState().byThreadKey,
        threadRef,
      ).surfaces.find((candidate) => candidate.kind === "diff");
      expect(surface).toMatchObject({
        kind: "diff",
        comparison: "working-tree",
        descriptor: { kind: "working-tree", liveSnapshotId: "worktree-1" },
        repositoryRoot: "/repo",
        newPath: "README.md",
      });
      if (!surface || surface.kind !== "diff")
        throw new Error("Expected the rendered aggregate click to open a diff tab.");

      yield* Effect.promise(() =>
        act(async () => {
          secondaryRoot.render(
            <RegistryContext.Provider value={registry}>
              <SecondaryPaneDiffPanel
                environmentId={environmentId}
                cwd="/wrong"
                surface={surface}
              />
            </RegistryContext.Provider>,
          );
          await Promise.resolve();
          await Promise.resolve();
        }),
      );
      expect(secondaryContainer.textContent).toContain("before");
      expect(secondaryContainer.textContent).toContain("after");
      expect(counts.fileComparisons).toBe(1);
      // This would fail if opening the real secondary tab remounted/refreshed the
      // aggregate's status or preview query; file contents are the only allowed
      // distinct transport request below the production cache.
      expect({
        statusSubscriptions: counts.statusSubscriptions,
        previewRequests: counts.previewRequests,
        refsRequests: counts.refsRequests,
      }).toEqual(aggregateRequests);
    }),
);
