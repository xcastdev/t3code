import type { DesktopBridge, DesktopPrimaryBackendState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

const DESKTOP_PRIMARY_BACKEND_STATE_STALE_TIME_MS = 30_000;

type DesktopPrimaryBackendStateBridge = Pick<DesktopBridge, "getPrimaryBackendState">;

class DesktopPrimaryBackendStateUnavailableError extends Schema.TaggedErrorClass<DesktopPrimaryBackendStateUnavailableError>()(
  "DesktopPrimaryBackendStateUnavailableError",
  {},
) {
  override get message(): string {
    return "Desktop primary backend state is unavailable.";
  }
}

class DesktopPrimaryBackendStateLoadError extends Schema.TaggedErrorClass<DesktopPrimaryBackendStateLoadError>()(
  "DesktopPrimaryBackendStateLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load the desktop primary backend state.";
  }
}

function getDesktopPrimaryBackendStateBridge(): DesktopPrimaryBackendStateBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopPrimaryBackendStateAtom(
  getBridge: () => DesktopPrimaryBackendStateBridge | undefined,
) {
  const loadState = Effect.fn("loadDesktopPrimaryBackendState")(function* () {
    const bridge = getBridge();
    if (!bridge) {
      return yield* new DesktopPrimaryBackendStateUnavailableError();
    }
    return yield* Effect.tryPromise({
      try: (): Promise<DesktopPrimaryBackendState> => bridge.getPrimaryBackendState(),
      catch: (cause) => new DesktopPrimaryBackendStateLoadError({ cause }),
    });
  });

  return Atom.make(loadState()).pipe(
    Atom.swr({
      staleTime: DESKTOP_PRIMARY_BACKEND_STATE_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.keepAlive,
    Atom.withLabel("desktop:primary-backend-state"),
  );
}

export const desktopPrimaryBackendStateAtom = createDesktopPrimaryBackendStateAtom(
  getDesktopPrimaryBackendStateBridge,
);

export function refreshDesktopPrimaryBackendState(): void {
  appAtomRegistry.refresh(desktopPrimaryBackendStateAtom);
}
