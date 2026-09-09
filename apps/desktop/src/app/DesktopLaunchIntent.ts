import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  DESKTOP_DEVELOPMENT_SCHEME,
  DESKTOP_PRODUCTION_SCHEME,
} from "../electron/ElectronProtocol.ts";

export const DESKTOP_ATTACH_HOST = "attach-primary";

let pendingPairingUrl = findDesktopLaunchIntentInArgv(process.argv);

export function buildDesktopAttachUrl(
  pairingUrl: string,
  scheme = DESKTOP_PRODUCTION_SCHEME,
): string {
  const url = new URL(`${scheme}://${DESKTOP_ATTACH_HOST}`);
  url.searchParams.set("pairingUrl", pairingUrl.trim());
  return url.toString();
}

export function parseDesktopLaunchIntent(raw: string, scheme?: string): string | null {
  try {
    const url = new URL(raw.trim());
    const acceptedSchemes = scheme
      ? new Set([`${scheme}:`])
      : new Set([`${DESKTOP_PRODUCTION_SCHEME}:`, `${DESKTOP_DEVELOPMENT_SCHEME}:`]);
    if (
      !acceptedSchemes.has(url.protocol) ||
      url.hostname !== DESKTOP_ATTACH_HOST ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.hash.length > 0 ||
      [...url.searchParams.keys()].some((key) => key !== "pairingUrl") ||
      url.searchParams.getAll("pairingUrl").length !== 1
    ) {
      return null;
    }
    const pairingUrl = url.searchParams.get("pairingUrl")?.trim() ?? "";
    const pairing = new URL(pairingUrl);
    return pairing.protocol === "http:" && pairingUrl.length > 0 ? pairingUrl : null;
  } catch {
    return null;
  }
}

export function findDesktopLaunchIntentInArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const intent = parseDesktopLaunchIntent(arg);
    if (intent !== null) return intent;
  }
  return null;
}

export function stripDesktopLaunchIntentsFromArgv(argv: readonly string[]): Array<string> {
  return argv.filter((arg) => parseDesktopLaunchIntent(arg) === null);
}

export function capturePreReadyDesktopLaunchIntent(raw: string): boolean {
  const pairingUrl = parseDesktopLaunchIntent(raw);
  if (pairingUrl === null) return false;
  pendingPairingUrl = pairingUrl;
  return true;
}

/** Claims an intent captured by the process-level pre-ready listener. */
export function claimDesktopLaunchIntent(pairingUrl: string): boolean {
  if (pendingPairingUrl !== pairingUrl) return false;
  pendingPairingUrl = null;
  return true;
}

/** Discards a stale startup intent before handling a newer second-instance request. */
export function clearDesktopLaunchIntent(): void {
  pendingPairingUrl = null;
}

export class DesktopLaunchIntent extends Context.Service<
  DesktopLaunchIntent,
  {
    readonly capture: (raw: string) => Effect.Effect<boolean>;
    readonly captureArgv: (argv: readonly string[]) => Effect.Effect<boolean>;
    readonly consume: Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/desktop/app/DesktopLaunchIntent") {}

export const layer = Layer.effect(
  DesktopLaunchIntent,
  Effect.gen(function* () {
    const capture = (raw: string) =>
      Effect.sync(() => {
        const pairingUrl = parseDesktopLaunchIntent(raw);
        if (pairingUrl === null) return false;
        pendingPairingUrl = pairingUrl;
        return true;
      });
    const captureArgv = (argv: readonly string[]) =>
      Effect.sync(() => {
        const pairingUrl = findDesktopLaunchIntentInArgv(argv);
        if (pairingUrl === null) return false;
        pendingPairingUrl = pairingUrl;
        return true;
      });
    return DesktopLaunchIntent.of({
      capture,
      captureArgv,
      consume: Effect.sync(() => {
        const pairingUrl = pendingPairingUrl;
        pendingPairingUrl = null;
        return Option.fromNullishOr(pairingUrl);
      }),
    });
  }),
);
