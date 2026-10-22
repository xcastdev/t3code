import type { DesktopBridge, DesktopPrimaryBackendState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

type DesktopPrimaryBackendBridge = Pick<DesktopBridge, "getPrimaryBackendState">;

class DesktopPrimaryBackendUnavailableError extends Schema.TaggedError<DesktopPrimaryBackendUnavailableError>()(
  "DesktopPrimaryBackendUnavailableError",
  {},
) {
  override get message(): string {
    return "Primary server ownership is only available in the desktop app.";
  }
}

class DesktopPrimaryBackendLoadError extends Schema.TaggedError<DesktopPrimaryBackendLoadError>()(
  "DesktopPrimaryBackendLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Couldn't read which server this app uses.";
  }
}

function createDesktopPrimaryBackendStateAtom(
  getBridge: () => DesktopPrimaryBackendBridge | undefined,
) {
  // Read from the main process, not the server, so it stays available while the
  // attached server is offline and Settings is the only way to recover.
  const load = Effect.fn("loadDesktopPrimaryBackendState")(function* () {
    const bridge = getBridge();
    if (!bridge) {
      return yield* new DesktopPrimaryBackendUnavailableError();
    }
    return yield* Effect.tryPromise({
      try: (): Promise<DesktopPrimaryBackendState> => bridge.getPrimaryBackendState(),
      catch: (cause) => new DesktopPrimaryBackendLoadError({ cause }),
    });
  });

  return Atom.make(load()).pipe(
    Atom.keepAlive,
    Atom.withLabel("desktop:primary-backend-state:load"),
  );
}

export const desktopPrimaryBackendStateAtom = createDesktopPrimaryBackendStateAtom(() =>
  typeof window === "undefined" ? undefined : window.desktopBridge,
);

export function refreshDesktopPrimaryBackendState(): void {
  appAtomRegistry.refresh(desktopPrimaryBackendStateAtom);
}

export type DesktopPrimaryCredentialExpiry =
  | { readonly kind: "valid"; readonly expiresAt: Date }
  | { readonly kind: "expired"; readonly expiresAt: Date }
  | { readonly kind: "unknown" };

export function desktopPrimaryCredentialExpiry(
  bearerExpiresAt: string,
  nowEpochMs: number,
): DesktopPrimaryCredentialExpiry {
  const expiresAt = new Date(bearerExpiresAt);
  if (Number.isNaN(expiresAt.getTime())) return { kind: "unknown" };
  return expiresAt.getTime() <= nowEpochMs
    ? { kind: "expired", expiresAt }
    : { kind: "valid", expiresAt };
}
