import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, type AssistantId, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import { assistantsEnvironment } from "../../state/assistants";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentQuery } from "../../state/query";
import { describeAssistantFailure } from "@t3tools/client-runtime/assistant-presentation";

export const ROSTER_LIMIT = 100;
export const newAssistantCommandId = () => CommandId.make(uuidv4());

const NO_CONNECTION = Atom.make(
  AsyncResult.initial<{ readonly connected: boolean; readonly epoch: string | null }>(),
);

export function useAssistantConnection(environmentId: EnvironmentId | null) {
  const result = useAtomValue(
    environmentId === null ? NO_CONNECTION : assistantsEnvironment.connection(environmentId),
  );
  return Option.getOrNull(AsyncResult.value(result)) ?? { connected: false, epoch: null };
}

/** One live roster page; mounting the first one keeps this environment's agent reads current. */
export function useAssistantRoster(
  environmentId: EnvironmentId | null,
  includeArchived: boolean,
  cursor?: string,
) {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : assistantsEnvironment.roster({
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

/** Previous/Next over a server cursor; only the current page is held. */
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

/** False once the screen is gone, so a late response can't navigate from a closed form. */
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

/** One action at a time; a refused currentness check is shown, never retried with fresher data. */
export function useAssistantWriter(environmentId: EnvironmentId) {
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
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
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
    const result = await command.run(appAtomRegistry, { environmentId, input });
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
  };
}

export type AssistantWriter = ReturnType<typeof useAssistantWriter>;
