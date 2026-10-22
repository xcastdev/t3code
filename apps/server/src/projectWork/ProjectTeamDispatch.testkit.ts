import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { vi } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as WorkAdmission from "./ProjectWorkRunAdmission.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export const projectId = ProjectId.make("project:launch-test");
export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

export interface HarnessOptions {
  readonly closeAndDrain?: TerminalManager.TerminalManager["Service"]["closeAndDrain"];
  readonly closeTerminal?: TerminalManager.TerminalManager["Service"]["close"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly providers: ReadonlyArray<ServerProvider>;
}

export function makeHarness(options: HarnessOptions) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest();
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const createWorktree = vi.fn<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>(
    (input) =>
      Effect.succeed({
        worktree: {
          path: "/repo-worktrees/feature",
          refName: input.newRefName ?? "test-worktree-branch",
        },
      }),
  );
  const runSetup = vi.fn<
    ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
  >(options.runSetup ?? (() => Effect.succeed({ status: "no-script" })));
  const closeTerminal = vi.fn<TerminalManager.TerminalManager["Service"]["close"]>(
    options.closeTerminal ?? (() => Effect.void),
  );
  const closeAndDrain = vi.fn<TerminalManager.TerminalManager["Service"]["closeAndDrain"]>(
    options.closeAndDrain ?? (() => Effect.void),
  );
  const renameBranch = vi.fn<GitWorkflow.GitWorkflowService["Service"]["renameBranch"]>((input) =>
    Effect.succeed({ branch: input.newBranch }),
  );
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({
      close: closeTerminal,
      closeAndDrain,
      closeProjectOwner: () => Effect.void,
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch,
      fetchWorktreeBaseCommit: () =>
        Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
      hasCommit: () => Effect.succeed(false),
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "main" }),
      remoteExists: () => Effect.succeed(true),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree: () => Effect.void,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
      generateBranchName:
        options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(options.providers),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
      folderForThread: () => Effect.succeed(Option.none()),
    }),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        WorkAdmission.layer.pipe(Layer.provide(layerDatabase)),
        IdAllocator.layer,
      ),
    ),
  );
  return {
    layerOrchestrator,
    layer: Layer.mergeAll(
      layerLaunch,
      layerReceipts,
      layerRegistry,
      layerThreadManagement,
      layerDatabase,
      ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
      layerExternalServices,
    ),
    createWorktree,
    runSetup,
    closeTerminal,
    closeAndDrain,
    renameBranch,
  };
}
