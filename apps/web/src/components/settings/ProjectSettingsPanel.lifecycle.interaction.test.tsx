/* @vitest-environment happy-dom */

import { RegistryContext } from "@effect/atom-react";
import { afterEach, expect, it } from "@effect/vitest";
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
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectWorkEnvironmentAtoms } from "@t3tools/client-runtime/project-work";
import { makeWsRpcProtocolClient, type RpcSession } from "@t3tools/client-runtime/rpc";
import {
  ClientOrchestrationCommand,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProjectLifecycleMutationResult,
  ProjectLifecyclePermanentDeleteInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vite-plus/test";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { StackedThreadToastOptions } from "../ui/toastHelpers";

const state = vi.hoisted(() => {
  const groups: SidebarProjectSnapshot[] = [];
  const notices: Array<StackedThreadToastOptions & { commandId: string }> = [];
  const projects: unknown = undefined;
  const work: unknown = undefined;
  return {
    groups,
    notices,
    commandId: "",
    projects,
    work,
    navigate: vi.fn(),
    clearDraft: vi.fn(),
    clearProject: vi.fn(),
    releaseUploads: vi.fn(),
    notice: () => {},
    finished: () => {},
  };
});
vi.mock("../../state/projects", () => ({
  get projectEnvironment() {
    return state.projects;
  },
}));
vi.mock("../../state/projectWork", () => ({
  get projectWorkEnvironment() {
    return state.work;
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: "/settings" }),
}));
vi.mock("./useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => state.groups }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("cleanup-host"),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: EnvironmentId.make("cleanup-host"),
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
        connection: { phase: "connected" },
        serverConfig: null,
        displayUrl: null,
      },
    ],
  }),
}));
vi.mock("../../connection/useDesktopLocalBootstraps", () => ({
  useDesktopLocalBootstraps: () => [],
}));
vi.mock("../../state/entities", () => ({
  useThreadShells: () => [
    {
      environmentId: EnvironmentId.make("cleanup-host"),
      projectId: ProjectId.make("cleanup-project"),
      id: "retained-thread",
    },
  ],
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: async () => true } }),
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getDraftThreadByProjectRef: () => ({ draftId: "retained-draft" }),
      clearDraftThread: state.clearDraft,
      clearProjectDraftThreadId: (...args: unknown[]) => {
        state.clearProject(...args);
        state.finished();
      },
    }),
  },
}));
vi.mock("../../lib/composerDraftUploads", () => ({
  releaseProjectDraftUploads: state.releaseUploads,
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (notice: StackedThreadToastOptions) => notice,
  toastManager: {
    add: (notice: StackedThreadToastOptions) => {
      state.notices.push({ ...notice, commandId: state.commandId });
      state.notice();
    },
  },
}));
vi.mock("./useScopedSettings", () => ({ useScopedSettings: () => true }));
vi.mock("./ProjectActionsSettings", () => ({ ProjectActionsSettings: () => null }));
vi.mock("./ProjectMcpSettings", () => ({ ProjectMcpSettings: () => null }));
vi.mock("./ProjectTeamSettings", () => ({ ProjectTeamSettings: () => null }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./ProjectFaviconPickerDialog", () => ({
  ProjectFaviconPickerDialog: () => null,
  canPickExternalProjectFavicon: () => false,
}));
vi.mock("./ProjectIconPickerDialog", () => ({ ProjectIconPickerDialog: () => null }));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ title, control }: { title: ReactNode; control: ReactNode }) => (
    <div>
      {title}
      {control}
    </div>
  ),
  SettingResetButton: () => null,
}));

import { ProjectSettingsPanel } from "./ProjectSettingsPanel";

const environmentId = EnvironmentId.make("cleanup-host");
const projectId = ProjectId.make("cleanup-project");
const at = "2026-10-08T00:00:00.000Z";
const decodeDelete = Schema.decodeUnknownEffect(ProjectLifecyclePermanentDeleteInput);
const decodeCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const encodeResult = Schema.encodeEffect(ProjectLifecycleMutationResult);
function receipt() {
  let resolve = () => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let registry: AtomRegistry.AtomRegistry | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  registry?.dispose();
  host?.remove();
});

it.effect(
  "keeps local work on an encoded cleanup refusal, opens its Memory workflow and deletes only after a healthy retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        state.navigate.mockReset();
        state.clearDraft.mockReset();
        state.clearProject.mockReset();
        state.releaseUploads.mockReset();
        state.notices.length = 0;
        let blocked = true;
        const writes: ProjectLifecyclePermanentDeleteInput[] = [];
        const legacy: ClientOrchestrationCommand[] = [];
        const project = {
          environmentId,
          projectId,
          state: "active" as const,
          workspaceRoot: "/workspace/cleanup",
          revision: 0,
          changedAt: at,
        };
        const protocol = yield* RpcClient.Protocol.make((write) =>
          Effect.succeed({
            codecFor: RpcSerialization.json.codecFor,
            supportsAck: false,
            supportsTransferables: false,
            send: (clientId, request) =>
              Effect.gen(function* () {
                if (request._tag !== "Request") return;
                if (request.tag === WS_METHODS.projectLifecycleGet)
                  return yield* write(clientId, {
                    _tag: "Exit",
                    requestId: request.id,
                    exit: { _tag: "Success", value: project },
                  });
                if (request.tag === WS_METHODS.projectLifecyclePermanentDelete) {
                  const input = yield* decodeDelete(request.payload).pipe(Effect.orDie);
                  writes.push(input);
                  state.commandId = input.commandId;
                  if (blocked)
                    return yield* write(clientId, {
                      _tag: "Exit",
                      requestId: request.id,
                      exit: {
                        _tag: "Failure",
                        cause: [
                          {
                            _tag: "Fail",
                            error: {
                              _tag: "ProjectLifecycleError",
                              reason: "memory-cleanup-required",
                              projectId,
                              detail: "Cleanup is not complete",
                            },
                          },
                        ],
                      },
                    });
                  const result = yield* encodeResult({
                    project: { ...project, state: "tombstoned", revision: 1 },
                    tombstone: {
                      environmentId,
                      projectId,
                      workspaceRoot: project.workspaceRoot,
                      tombstonedAt: at,
                      reason: "permanent-local-delete",
                      externalDataPreserved: true,
                    },
                    filesDeleted: false,
                    externalDataPreserved: true,
                  }).pipe(Effect.orDie);
                  return yield* write(clientId, {
                    _tag: "Exit",
                    requestId: request.id,
                    exit: { _tag: "Success", value: result },
                  });
                }
                if (request.tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
                  legacy.push(yield* decodeCommand(request.payload).pipe(Effect.orDie));
                  return yield* write(clientId, {
                    _tag: "Exit",
                    requestId: request.id,
                    exit: { _tag: "Success", value: { sequence: 1 } },
                  });
                }
                return yield* Effect.die("Unexpected Settings RPC");
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
        const supervisor = EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Cleanup",
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
        });
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
          state: () => SubscriptionRef.get(supervisor.state),
          stateChanges: () => SubscriptionRef.changes(supervisor.state),
          run: (id, effect) =>
            id === environmentId
              ? Effect.provideService(effect, EnvironmentSupervisor, supervisor)
              : Effect.die("Foreign Settings environment"),
          runStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        });
        const runtime = Atom.runtime(
          Layer.mergeAll(
            Layer.succeed(EnvironmentRegistry, environments),
            Layer.succeed(
              Crypto.Crypto,
              Crypto.make({
                randomBytes: (size) => new Uint8Array(size),
                digest: (_algorithm, data) => Effect.succeed(data),
              }),
            ),
          ),
        );
        const atoms = createProjectEnvironmentAtoms(runtime);
        state.projects = atoms;
        state.work = createProjectWorkEnvironmentAtoms(runtime);
        state.groups.splice(
          0,
          state.groups.length,
          ...buildSidebarProjectSnapshots({
            projects: [
              {
                id: projectId,
                environmentId,
                title: "Cleanup project",
                workspaceRoot: project.workspaceRoot,
                repositoryIdentity: null,
                defaultModelSelection: null,
                scripts: [],
                createdAt: at,
                updatedAt: at,
              },
            ],
            settings: {
              sidebarProjectGroupingMode: "separate",
              sidebarProjectGroupingOverrides: {},
            },
            primaryEnvironmentId: environmentId,
            resolveEnvironmentLabel: () => "Cleanup host",
          }),
        );
        const group = state.groups[0];
        if (group === undefined) return yield* Effect.die("Missing selected Settings group");
        registry = AtomRegistry.make();
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
        const atomRegistry = registry;
        const lifecycle = atoms.lifecycle({ environmentId, input: { projectId } });
        const loaded = receipt();
        const unsubscribe = atomRegistry.subscribe(
          lifecycle,
          (value) => {
            if (!AsyncResult.isInitial(value) && !value.waiting) loaded.resolve();
          },
          { immediate: true },
        );
        yield* Effect.promise(async () => {
          await act(async () => {
            await loaded.promise;
          });
          unsubscribe();
          const render = async () =>
            act(async () =>
              root?.render(
                <RegistryContext.Provider value={atomRegistry}>
                  <ProjectSettingsPanel
                    projectKey={group.projectKey}
                    environmentId={environmentId}
                  />
                  {state.notices.map((notice) => (
                    <aside key={notice.commandId}>
                      {notice.title}
                      {notice.description}
                      <button {...notice.actionProps} />
                    </aside>
                  ))}
                </RegistryContext.Provider>,
              ),
            );
          await render();
          const action = () =>
            [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
              (button) => button.textContent?.trim() === "Delete project permanently",
            );
          const refused = receipt();
          state.notice = refused.resolve;
          await act(async () => {
            action()?.click();
            await refused.promise;
          });
          await render();
          expect(writes).toHaveLength(1);
          expect(writes[0]).toMatchObject({
            projectId,
            workspaceRoot: project.workspaceRoot,
            confirmation: "permanent-local-delete",
          });
          expect(legacy).toEqual([]);
          expect(state.clearDraft).not.toHaveBeenCalled();
          expect(state.clearProject).not.toHaveBeenCalled();
          expect(state.releaseUploads).not.toHaveBeenCalled();
          expect(host?.textContent).toContain("remaining budget");
          expect(host?.textContent).toContain("threads are still available");
          const open = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
            (button) => button.textContent === "Open Memory",
          );
          expect(open).toBeDefined();
          await act(async () => open?.click());
          expect(state.navigate).toHaveBeenCalledWith({
            to: "/work/$environmentId/$projectId",
            params: { environmentId, projectId },
            search: { tab: "memory" },
          });
          blocked = false;
          const finished = receipt();
          state.finished = finished.resolve;
          await act(async () => {
            action()?.click();
            await finished.promise;
          });
          expect(writes).toHaveLength(2);
          expect(legacy).toMatchObject([{ type: "project.delete", projectId, force: true }]);
          expect(state.clearDraft).toHaveBeenCalledWith("retained-draft");
          expect(state.clearProject).toHaveBeenCalledWith({ environmentId, projectId });
          expect(state.releaseUploads).toHaveBeenCalledTimes(1);
          expect(state.navigate).toHaveBeenLastCalledWith({ to: "/", replace: true });
        });
      }),
    ),
);
