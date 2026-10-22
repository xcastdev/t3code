import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Project sessions are observed without opening a shell or borrowing a thread terminal. */
export function createProjectTerminalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const resizeScheduler = createAtomCommandScheduler();
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:project-terminal:list",
      tag: WS_METHODS.projectTerminalList,
      staleTimeMs: 0,
    }),
    attach: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:project-terminal:attach",
      tag: WS_METHODS.projectTerminalAttach,
      // A hidden viewer must not keep a live PTY stream open after its last reader unmounts.
      idleTtlMs: 0,
    }),
    metadata: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:project-terminal:metadata",
      tag: WS_METHODS.projectTerminalMetadata,
      idleTtlMs: 0,
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-terminal:write",
      tag: WS_METHODS.projectTerminalWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-terminal:resize",
      tag: WS_METHODS.projectTerminalResize,
      scheduler: resizeScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.terminalId]),
      },
    }),
    kill: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-terminal:kill",
      tag: WS_METHODS.projectTerminalKill,
    }),
  };
}
