import { RegistryContext } from "@effect/atom-react";
import {
  applyProjectTerminalMetadataEvent,
  EMPTY_PROJECT_TERMINAL_DOCK,
  type ProjectTerminalDockState,
} from "@t3tools/client-runtime/project-terminal-view";
import { createProjectTerminalEnvironmentAtoms } from "@t3tools/client-runtime/state/project-terminals";
import { formatEnvironmentQueryError } from "./query";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, type Atom } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";

export const projectTerminalEnvironment =
  createProjectTerminalEnvironmentAtoms(connectionAtomRuntime);

/**
 * Delivers every value of a shared stream atom while mounted. The atom may
 * outlive an earlier mount, so it is refreshed to start from a new snapshot
 * instead of replaying whatever event it last held.
 */
export function useStreamEvents<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
  onValue: (value: A) => void,
  onError: (message: string) => void,
) {
  const registry = useContext(RegistryContext);
  const handleValue = useEffectEvent(onValue);
  const handleError = useEffectEvent(onError);
  useEffect(() => {
    if (atom === null) return;
    let last: unknown = undefined;
    const unsubscribe = registry.subscribe(atom, (result) => {
      if (result._tag === "Failure") {
        handleError(formatEnvironmentQueryError(result.cause));
        return;
      }
      const value = Option.getOrUndefined(AsyncResult.value(result));
      if (value === undefined || value === last) return;
      last = value;
      handleValue(value);
    });
    registry.refresh(atom);
    return unsubscribe;
  }, [atom, registry]);
}

/** Live project terminal list for one project, isolated from thread terminals. */
export function useProjectTerminalDock(environmentId: EnvironmentId, projectId: ProjectId) {
  const key = `${environmentId}\u0000${projectId}`;
  const [state, setState] = useState<{
    readonly key: string;
    readonly dock: ProjectTerminalDockState;
    readonly error: string | null;
  }>({ key, dock: EMPTY_PROJECT_TERMINAL_DOCK, error: null });
  const atom = projectTerminalEnvironment.metadata({ environmentId, input: projectId });
  const registry = useContext(RegistryContext);
  useStreamEvents(
    atom,
    (event) =>
      setState((current) => {
        const dock = current.key === key ? current.dock : EMPTY_PROJECT_TERMINAL_DOCK;
        return {
          key,
          dock: applyProjectTerminalMetadataEvent(dock, projectId, event),
          error: null,
        };
      }),
    (error) =>
      setState((current) => ({
        key,
        dock: current.key === key ? current.dock : EMPTY_PROJECT_TERMINAL_DOCK,
        error,
      })),
  );
  const current = state.key === key ? state : { dock: EMPTY_PROJECT_TERMINAL_DOCK, error: null };
  return { ...current.dock, error: current.error, retry: () => registry.refresh(atom) };
}
