import {
  type ProjectId,
  type ProjectTerminalHandle,
  type ProjectTerminalDockSummary,
  type TerminalSummary,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  applyProjectTerminalAttachStreamEvent,
  applyProjectTerminalMetadataStreamEvent,
  EMPTY_PROJECT_TERMINAL_BUFFER_STATE,
  nextTerminalAttachSeedState,
} from "./terminalSession.ts";

export function createTerminalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const resizeScheduler = createAtomCommandScheduler();
  const terminalThreadKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId]);
  const terminalSessionKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId, input.terminalId ?? null]);
  const lifecycleConcurrency = { mode: "serial" as const, key: terminalThreadKey };
  const subscribeProjectAttach = (input: {
    readonly projectId: ProjectId;
    readonly terminalId: ProjectTerminalHandle["terminalId"];
    readonly attachmentGeneration?: number;
  }) =>
    subscribe(WS_METHODS.projectTerminalAttach, {
      projectId: input.projectId,
      terminalId: input.terminalId,
    }).pipe(
      Stream.scan(
        {
          ...EMPTY_PROJECT_TERMINAL_BUFFER_STATE,
          output: {
            ...EMPTY_PROJECT_TERMINAL_BUFFER_STATE.output,
            generation: input.attachmentGeneration ?? 0,
          },
        },
        applyProjectTerminalAttachStreamEvent,
      ),
    );
  return {
    attach: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:attach",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.terminalAttach>) =>
        Stream.suspend(() =>
          subscribe(WS_METHODS.terminalAttach, input).pipe(
            Stream.scan(nextTerminalAttachSeedState(), applyTerminalAttachStreamEvent),
          ),
        ),
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:events",
      tag: WS_METHODS.subscribeTerminalEvents,
    }),
    metadata: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:metadata",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
          Stream.scan([] as ReadonlyArray<TerminalSummary>, applyTerminalMetadataStreamEvent),
        ),
    }),
    projectMetadata: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:project-metadata",
      subscribe: (input: { readonly projectId: ProjectId }) =>
        subscribe(WS_METHODS.projectTerminalMetadata, input.projectId).pipe(
          Stream.scan(
            {
              terminals: [] as ReadonlyArray<ProjectTerminalDockSummary>,
              nextCursor: null,
              snapshotVersion: 0,
              revision: 0,
              removedTerminalIds: [],
            },
            applyProjectTerminalMetadataStreamEvent,
          ),
        ),
    }),
    projectAttach: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:project-attach",
      idleTtlMs: 0,
      subscribe: (input: {
        readonly projectId: ProjectId;
        readonly terminalId: ProjectTerminalHandle["terminalId"];
        readonly attachmentGeneration?: number;
      }) => Stream.suspend(() => subscribeProjectAttach(input)),
    }),
    projectList: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:project-list",
      tag: WS_METHODS.projectTerminalList,
    }),
    projectWrite: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:project-write",
      tag: WS_METHODS.projectTerminalWrite,
    }),
    projectResize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:project-resize",
      tag: WS_METHODS.projectTerminalResize,
      scheduler: resizeScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.terminalId]),
      },
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:open",
      tag: WS_METHODS.terminalOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:write",
      tag: WS_METHODS.terminalWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:resize",
      tag: WS_METHODS.terminalResize,
      scheduler: resizeScheduler,
      concurrency: { mode: "latest", key: terminalSessionKey },
    }),
    clear: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:clear",
      tag: WS_METHODS.terminalClear,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:restart",
      tag: WS_METHODS.terminalRestart,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:close",
      tag: WS_METHODS.terminalClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
  };
}

export * from "./terminalSession.ts";
