import { useEffect } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import {
  type CommandPaletteUiAction,
  type CommandPaletteUiState,
  reduceCommandPaletteUiState,
} from "./components/CommandPalette.logic";
import { getWorkspaceFocusRequestVersion } from "./lib/workspaceFocus";

const INITIAL_STATE: CommandPaletteUiState = {
  open: false,
  mode: "command",
  openIntent: null,
  session: 0,
};

export const useCommandPaletteStore = create<CommandPaletteUiState>(() => INITIAL_STATE);

let pendingFilePick: ((path: string | null) => void) | null = null;

/** Hands the open file pick its result; a later call or a closed palette has nothing to settle. */
export function settleFilePick(path: string | null): void {
  const resolve = pendingFilePick;
  pendingFilePick = null;
  resolve?.(path);
}

/** Opens the palette to choose a file on `environmentId`. Resolves null when it closes unpicked. */
export function beginFilePick(environmentId: EnvironmentId): Promise<string | null> {
  settleFilePick(null);
  return new Promise((resolve) => {
    pendingFilePick = resolve;
    dispatchCommandPalette({ _tag: "OpenPickFile", environmentId });
  });
}

// Closing the palette, or another kind of intent replacing the pick, ends it unpicked. A new
// pick settled the old one in beginFilePick, before its own resolver took the slot.
useCommandPaletteStore.subscribe((state, previous) => {
  if (previous.openIntent?.kind === "pick-file" && state.openIntent?.kind !== "pick-file") {
    settleFilePick(null);
  }
});

let returnFocus: { element: HTMLElement | null; href: string; focusRequest: number } | null = null;

export function dispatchCommandPalette(action: CommandPaletteUiAction): void {
  const state = useCommandPaletteStore.getState();
  const next = reduceCommandPaletteUiState(state, action);
  if (!state.open && next.open) {
    // The workspace turns inert before the popup mounts, which blurs the opener.
    returnFocus = {
      element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      href: window.location.href,
      focusRequest: getWorkspaceFocusRequestVersion(),
    };
  }
  useCommandPaletteStore.setState(next, true);
}

/**
 * Where the closing palette should return focus: `false` when a command navigated or asked
 * for workspace focus (the destination owns it), else the opener, or `true` for the default.
 */
export function getCommandPaletteReturnFocus(): HTMLElement | boolean {
  if (
    !returnFocus ||
    window.location.href !== returnFocus.href ||
    getWorkspaceFocusRequestVersion() !== returnFocus.focusRequest
  )
    return false;
  const { element } = returnFocus;
  return element?.isConnected && !element.matches(":disabled") ? element : true;
}

/** The element the palette opened from, while focus is still inside the palette. */
export function getCommandPaletteOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (!returnFocus || !active?.closest("[data-command-palette]")) return null;
  return returnFocus.element;
}

// The palette is only mounted on app-shell routes (not /pair, sign-in or
// landings), so its shortcuts must stay inert elsewhere.
let mountedPalettes = 0;

export function isCommandPaletteMounted(): boolean {
  return mountedPalettes > 0;
}

/**
 * Marks the palette as mounted while the calling component is. An unmounted
 * palette cannot stay open, so the last unmount resets the store.
 */
export function useCommandPaletteMount(): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The palette's mount gates its global shortcuts, and leaving the route while it is open calls no close handler, so only unmount can reset the store.
  useEffect(() => {
    mountedPalettes += 1;
    return () => {
      mountedPalettes -= 1;
      if (mountedPalettes === 0) {
        useCommandPaletteStore.setState(
          (state) => ({ ...INITIAL_STATE, session: state.session + 1 }),
          true,
        );
      }
    };
  }, []);
}
