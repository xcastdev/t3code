import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { AssistantId, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { assistantsEnvironment } from "../../state/assistants";
import { useEnvironmentQuery } from "../../state/query";
import { describeAssistantFailure } from "@t3tools/client-runtime/assistant-presentation";

export const ROSTER_LIMIT = 100;

/** Connected plus the opaque epoch of the live RPC session; null epoch while disconnected. */
export function useAssistantConnection(environmentId: EnvironmentId | null) {
  const result = useAtomValue(
    environmentId === null ? NO_CONNECTION : assistantsEnvironment.connection(environmentId),
  );
  const value = Option.getOrNull(AsyncResult.value(result));
  return value ?? { connected: false, epoch: null };
}

const NO_CONNECTION = Atom.make(
  AsyncResult.initial<{ readonly connected: boolean; readonly epoch: string | null }>(),
);

/** One live roster page. Mounting the first page is what keeps details and memory on screen current. */
export function useAssistantRoster(
  environmentId: EnvironmentId,
  includeArchived: boolean,
  cursor?: string,
) {
  return useEnvironmentQuery(
    assistantsEnvironment.roster({
      environmentId,
      input: {
        environmentId,
        includeArchived,
        limit: ROSTER_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  );
}

export function useAssistantDetail(environmentId: EnvironmentId, assistantId: AssistantId) {
  return useEnvironmentQuery(
    assistantsEnvironment.detail({ environmentId, input: { environmentId, assistantId } }),
  );
}

/**
 * Previous/Next over a server cursor. Only the current page is ever held; the
 * stack keeps the cursors that lead back to earlier pages.
 */
export function useCursorPages() {
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  return {
    cursor: cursors.at(-1),
    hasPrevious: cursors.length > 0,
    previous: () => setCursors((current) => current.slice(0, -1)),
    next: (cursor: string | null) => {
      if (cursor !== null) setCursors((current) => [...current, cursor]);
    },
  };
}

/** False once the component is gone, so a late response can't act on a closed form. */
export function useMountedRef() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

export const STALE_MESSAGE =
  "This changed after you reviewed it, or the connection was replaced. Nothing was sent; review the current version.";

export interface AssistantWriteFailure {
  readonly key: string;
  readonly message: string;
}

/**
 * One action at a time per page. A null prepared input means the shared
 * currentness guard refused it; that is shown, never retried with fresher data.
 */
export function useAssistantWriter(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const permissions = {
    create: useAtomValue(assistantsEnvironment.create.permissionAtom(environmentId)),
    configure: useAtomValue(
      assistantsEnvironment.updateConfiguration.permissionAtom(environmentId),
    ),
    lifecycle: useAtomValue(assistantsEnvironment.lifecycle.permissionAtom(environmentId)),
    memory: useAtomValue(assistantsEnvironment.memoryWrite.permissionAtom(environmentId)),
    routines: useAtomValue(assistantsEnvironment.routineWrite.permissionAtom(environmentId)),
    webhook: useAtomValue(assistantsEnvironment.routineWebhook.permissionAtom(environmentId)),
    stop: useAtomValue(assistantsEnvironment.stop.permissionAtom(environmentId)),
  };
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<AssistantWriteFailure | null>(null);
  const busy = useRef(false);

  async function run<I, A, E>(
    key: string,
    command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
    input: I | null,
  ): Promise<A | null> {
    if (busy.current) return null;
    if (input === null) {
      setFailure({ key, message: STALE_MESSAGE });
      return null;
    }
    busy.current = true;
    setPendingKey(key);
    setFailure(null);
    const result = await command.run(registry, { environmentId, input });
    busy.current = false;
    setPendingKey(null);
    if (result._tag === "Success") return result.value;
    if (!isAtomCommandInterrupted(result))
      setFailure({ key, message: describeAssistantFailure(squashAtomCommandFailure(result)) });
    return null;
  }

  return {
    permissions,
    pendingKey,
    run,
    failureFor: (key: string) => (failure?.key === key ? failure.message : null),
    reportStale: (key: string) => setFailure({ key, message: STALE_MESSAGE }),
    dismiss: () => setFailure(null),
  };
}

export type AssistantWriter = ReturnType<typeof useAssistantWriter>;

export function newAssistantCommandId() {
  return randomUUID();
}
