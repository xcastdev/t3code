import { RegistryContext } from "@effect/atom-react";
import { describeResourceFailure } from "@t3tools/client-runtime/resource-actions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { useContext, useRef, useState } from "react";

/**
 * One mutation at a time per resource panel. Failures stay attached to the
 * action that caused them; an interrupted command is not reported as failed.
 */
export function useResourceCommand(describe: (error: unknown) => string = describeResourceFailure) {
  const registry = useContext(RegistryContext);
  const busy = useRef(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  const run = async <W, A, E>(
    key: string,
    command: AtomCommand<W, A, E>,
    input: W,
  ): Promise<{ readonly ok: true; readonly value: A } | { readonly ok: false }> => {
    if (busy.current) return { ok: false };
    busy.current = true;
    setPendingKey(key);
    setFailure(null);
    const result = await command.run(registry, input);
    busy.current = false;
    setPendingKey(null);
    if (result._tag === "Success") return { ok: true, value: result.value };
    if (!isAtomCommandInterrupted(result))
      setFailure({ key, message: describe(squashAtomCommandFailure(result)) });
    return { ok: false };
  };

  return {
    run,
    pendingKey,
    busy: pendingKey !== null,
    failureFor: (key: string) => (failure?.key === key ? failure.message : null),
    reportFailure: (key: string, message: string) => setFailure({ key, message }),
    dismiss: () => setFailure(null),
  };
}

export type ResourceCommandRunner = ReturnType<typeof useResourceCommand>;
