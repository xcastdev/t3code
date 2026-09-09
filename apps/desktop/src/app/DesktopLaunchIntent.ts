import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  DESKTOP_DEVELOPMENT_SCHEME,
  DESKTOP_PRODUCTION_SCHEME,
} from "../electron/ElectronProtocol.ts";

export const DESKTOP_ATTACH_HOST = "attach-primary";

export type DesktopLaunchIntentPhase = "collecting" | "selecting" | "running" | "aborted";

export type DesktopLaunchIntentRoute =
  | { readonly _tag: "Ignored"; readonly accepted: false }
  | { readonly _tag: "Pending"; readonly accepted: true; readonly pairingUrl: string }
  | { readonly _tag: "Runtime"; readonly accepted: true; readonly pairingUrl: string }
  | { readonly _tag: "Duplicate"; readonly accepted: true; readonly pairingUrl: string };

export interface DesktopStartupSelection {
  readonly selectionId: number;
  readonly pairingUrl: string | null;
}

export type DesktopStartupSelectionCommit =
  | { readonly _tag: "Running" }
  | {
      readonly _tag: "Superseded";
      readonly selectionId: number;
      readonly pairingUrl: string;
    }
  | { readonly _tag: "Aborted" };

type CoordinatorState = {
  phase: DesktopLaunchIntentPhase;
  pendingPairingUrl: string | null;
  activePairingUrl: string | null;
  selectionId: number;
  lastRoutedPairingUrl: string | null;
  runtimeHandler: ((pairingUrl: string) => void) | null;
  runtimeReady: boolean;
};

const makeCoordinatorState = (): CoordinatorState => ({
  phase: "collecting",
  pendingPairingUrl: findDesktopLaunchIntentInArgv(process.argv),
  activePairingUrl: null,
  selectionId: 0,
  lastRoutedPairingUrl: null,
  runtimeHandler: null,
  runtimeReady: false,
});

let coordinatorState = makeCoordinatorState();

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

export function routeDesktopLaunchIntent(raw: string): DesktopLaunchIntentRoute {
  const pairingUrl = parseDesktopLaunchIntent(raw);
  if (pairingUrl === null) return { _tag: "Ignored", accepted: false };

  if (coordinatorState.lastRoutedPairingUrl === pairingUrl) {
    return { _tag: "Duplicate", accepted: true, pairingUrl };
  }
  coordinatorState.lastRoutedPairingUrl = pairingUrl;

  if (coordinatorState.phase === "aborted") {
    return { _tag: "Ignored", accepted: false };
  }
  if (coordinatorState.phase === "running") {
    if (coordinatorState.runtimeReady && coordinatorState.runtimeHandler !== null) {
      coordinatorState.runtimeHandler(pairingUrl);
      return { _tag: "Runtime", accepted: true, pairingUrl };
    }
  }

  coordinatorState.pendingPairingUrl = pairingUrl;
  return { _tag: "Pending", accepted: true, pairingUrl };
}

export function capturePreReadyDesktopLaunchIntent(raw: string): boolean {
  if (parseDesktopLaunchIntent(raw) === null) return false;
  routeDesktopLaunchIntent(raw);
  return true;
}

/** Claims an intent captured by the process-level pre-ready listener. */
export function claimDesktopLaunchIntent(pairingUrl: string): boolean {
  if (coordinatorState.pendingPairingUrl !== pairingUrl) return false;
  coordinatorState.pendingPairingUrl = null;
  return true;
}

/** Discards a stale startup intent before handling a newer second-instance request. */
export function clearDesktopLaunchIntent(): void {
  coordinatorState.pendingPairingUrl = null;
  coordinatorState.lastRoutedPairingUrl = null;
}

export function resetDesktopLaunchIntentCoordinator(): void {
  coordinatorState = makeCoordinatorState();
  coordinatorState.pendingPairingUrl = null;
}

export function registerDesktopRuntimeLaunchIntentHandler(
  handler: (pairingUrl: string) => void,
): () => void {
  coordinatorState.runtimeHandler = handler;
  if (
    coordinatorState.phase === "running" &&
    coordinatorState.runtimeReady &&
    coordinatorState.pendingPairingUrl !== null
  ) {
    const pairingUrl = coordinatorState.pendingPairingUrl;
    coordinatorState.pendingPairingUrl = null;
    handler(pairingUrl);
  }
  return () => {
    if (coordinatorState.runtimeHandler === handler) coordinatorState.runtimeHandler = null;
  };
}

export function activateDesktopRuntimeLaunchIntents(): void {
  if (coordinatorState.phase !== "running") return;
  coordinatorState.runtimeReady = true;
  const pairingUrl = coordinatorState.pendingPairingUrl;
  if (pairingUrl === null || coordinatorState.runtimeHandler === null) return;
  coordinatorState.pendingPairingUrl = null;
  coordinatorState.runtimeHandler(pairingUrl);
}

export function claimDesktopStartupSelection(): DesktopStartupSelection {
  if (coordinatorState.phase === "collecting") {
    coordinatorState.phase = "selecting";
    coordinatorState.activePairingUrl = coordinatorState.pendingPairingUrl;
    coordinatorState.pendingPairingUrl = null;
    coordinatorState.selectionId += 1;
  }
  return {
    selectionId: coordinatorState.selectionId,
    pairingUrl: coordinatorState.activePairingUrl,
  };
}

export function claimPendingDesktopStartupIntent(selectionId: number): string | null {
  if (coordinatorState.phase !== "selecting" || coordinatorState.selectionId !== selectionId) {
    return null;
  }
  const pairingUrl = coordinatorState.pendingPairingUrl;
  if (pairingUrl === null) return null;
  coordinatorState.pendingPairingUrl = null;
  coordinatorState.activePairingUrl = pairingUrl;
  return pairingUrl;
}

export function commitDesktopStartupSelection(selectionId: number): DesktopStartupSelectionCommit {
  if (coordinatorState.phase !== "selecting" || coordinatorState.selectionId !== selectionId) {
    return { _tag: "Aborted" };
  }
  if (coordinatorState.pendingPairingUrl !== null) {
    const pairingUrl = coordinatorState.pendingPairingUrl;
    coordinatorState.pendingPairingUrl = null;
    coordinatorState.activePairingUrl = pairingUrl;
    return { _tag: "Superseded", selectionId, pairingUrl };
  }
  coordinatorState.phase = "running";
  coordinatorState.runtimeReady = false;
  coordinatorState.activePairingUrl = null;
  return { _tag: "Running" };
}

export function abortDesktopStartupSelection(): void {
  coordinatorState.phase = "aborted";
  coordinatorState.pendingPairingUrl = null;
  coordinatorState.activePairingUrl = null;
  coordinatorState.runtimeReady = false;
  coordinatorState.lastRoutedPairingUrl = null;
}

export class DesktopLaunchIntent extends Context.Service<
  DesktopLaunchIntent,
  {
    readonly capture: (raw: string) => Effect.Effect<boolean>;
    readonly captureArgv: (argv: readonly string[]) => Effect.Effect<boolean>;
    readonly consume: Effect.Effect<Option.Option<string>>;
    readonly claimForStartup: Effect.Effect<DesktopStartupSelection>;
    readonly claimPendingForStartup: (selectionId: number) => Effect.Effect<Option.Option<string>>;
    readonly commitStartupSelection: (
      selectionId: number,
    ) => Effect.Effect<DesktopStartupSelectionCommit>;
    readonly activateRuntime: Effect.Effect<void>;
    readonly abortStartupSelection: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLaunchIntent") {}

const capture = (raw: string) =>
  Effect.sync(() => {
    return routeDesktopLaunchIntent(raw).accepted;
  });

const captureArgv = (argv: readonly string[]) =>
  Effect.sync(() => {
    const pairingUrl = findDesktopLaunchIntentInArgv(argv);
    if (pairingUrl === null) return false;
    const raw = argv.find((arg) => parseDesktopLaunchIntent(arg) === pairingUrl);
    return raw !== undefined && routeDesktopLaunchIntent(raw).accepted;
  });

export const layer = Layer.succeed(
  DesktopLaunchIntent,
  DesktopLaunchIntent.of({
    capture,
    captureArgv,
    consume: Effect.sync(() => {
      const pairingUrl = coordinatorState.pendingPairingUrl;
      coordinatorState.pendingPairingUrl = null;
      return Option.fromNullishOr(pairingUrl);
    }),
    claimForStartup: Effect.sync(claimDesktopStartupSelection),
    claimPendingForStartup: (selectionId) =>
      Effect.sync(() => Option.fromNullishOr(claimPendingDesktopStartupIntent(selectionId))),
    commitStartupSelection: (selectionId) =>
      Effect.sync(() => commitDesktopStartupSelection(selectionId)),
    activateRuntime: Effect.sync(activateDesktopRuntimeLaunchIntents),
    abortStartupSelection: Effect.sync(abortDesktopStartupSelection),
  }),
);
