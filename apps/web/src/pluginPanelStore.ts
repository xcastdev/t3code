import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  parsePluginPanelKey,
  pluginPanelKey,
  type PluginInstallEntry,
  type PluginPanelKey,
  type PluginPanelScope,
} from "@t3tools/client-runtime/plugins/commands";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { resolvePluginOpenTarget } from "./plugins/openPluginPanel";
import { type RightPanelSurface, useRightPanelStore } from "./rightPanelStore";

const PLUGIN_PANEL_STORAGE_KEY = "t3code:plugin-panels:v1";

/**
 * `open` lists the docked panels of one scope. `focused` is the panel a chat in that
 * environment shows, which may be a client panel, so it is only read for environment entries.
 */
interface DockedPluginPanels {
  readonly open: ReadonlyArray<PluginPanelKey>;
  readonly focused: PluginPanelKey | null;
}

type ByEnvironment = Readonly<Record<string, DockedPluginPanels>>;

interface PluginPanelStoreState {
  readonly byEnvironment: ByEnvironment;
  /** Panels pinned to the right-panel rail on this device, in pin order. */
  readonly pinned: ReadonlyArray<PluginPanelKey>;
  /** Docks the panel and focuses it for chats in `chatEnvironmentId`. */
  readonly open: (key: PluginPanelKey, chatEnvironmentId: string) => void;
  readonly focus: (key: PluginPanelKey, chatEnvironmentId: string) => void;
  readonly blur: (chatEnvironmentId: string) => void;
  readonly close: (key: PluginPanelKey) => void;
  readonly pin: (key: PluginPanelKey) => void;
  readonly unpin: (key: PluginPanelKey) => void;
  /** Removes every docked and pinned panel of a plugin in one scope, as on uninstall. */
  readonly dropPlugin: (scope: PluginPanelScope, pluginId: string) => void;
}

const EMPTY: DockedPluginPanels = { open: [], focused: null };
const CLIENT_SCOPE: PluginPanelScope = "client";

const scopeOf = (key: PluginPanelKey) => parsePluginPanelKey(key)?.scope;

function withEntry(
  byEnvironment: ByEnvironment,
  environment: string,
  update: (entry: DockedPluginPanels) => DockedPluginPanels,
): ByEnvironment {
  const current = byEnvironment[environment] ?? EMPTY;
  const next = update(current);
  if (next === current) return byEnvironment;
  if (next.open.length === 0 && next.focused === null) {
    const { [environment]: _removed, ...rest } = byEnvironment;
    return rest;
  }
  return { ...byEnvironment, [environment]: next };
}

function removeKeys(byEnvironment: ByEnvironment, removed: (key: PluginPanelKey) => boolean) {
  let next = byEnvironment;
  for (const environment of Object.keys(byEnvironment)) {
    next = withEntry(next, environment, (entry) => {
      const open = entry.open.filter((key) => !removed(key));
      const focused = entry.focused !== null && removed(entry.focused) ? null : entry.focused;
      return open.length === entry.open.length && focused === entry.focused
        ? entry
        : { open, focused };
    });
  }
  return next;
}

/** The panels a chat in `chatEnvironmentId` docks: its environment's, then this device's. */
export function selectDockedPluginPanels(
  byEnvironment: ByEnvironment,
  chatEnvironmentId: string | null,
): DockedPluginPanels {
  if (chatEnvironmentId === null) return EMPTY;
  const environment = byEnvironment[chatEnvironmentId] ?? EMPTY;
  const device = byEnvironment[CLIENT_SCOPE] ?? EMPTY;
  const open = [...environment.open, ...device.open];
  const focused =
    environment.focused !== null && open.includes(environment.focused) ? environment.focused : null;
  return { open, focused };
}

export interface PinnedRailPanel {
  readonly key: PluginPanelKey;
  readonly title: string;
  readonly icon: string | undefined;
}

/** Pins a chat in `chatEnvironmentId` can dock, given the enabled installs. Others stay pinned. */
export function selectPinnedRailPanels(
  pinned: ReadonlyArray<PluginPanelKey>,
  enabledInstalls: ReadonlyArray<PluginInstallEntry>,
  chatEnvironmentId: string | null,
): ReadonlyArray<PinnedRailPanel> {
  if (chatEnvironmentId === null) return [];
  const chat = { environmentId: chatEnvironmentId };
  const panels = new Map<PluginPanelKey, PinnedRailPanel>();
  for (const { scope, record } of enabledInstalls) {
    if (resolvePluginOpenTarget({ scope, chat }) !== "dock") continue;
    for (const panel of record.manifest.ui?.panels ?? []) {
      const key = pluginPanelKey(scope, record.pluginId, panel.id);
      panels.set(key, { key, title: panel.title, icon: panel.icon });
    }
  }
  return pinned.flatMap((key) => panels.get(key) ?? []);
}

// usePanelPresence compares surfaces by identity during render, and a mount has no memo
// cache to fall back on, so plugin surfaces must keep their identity without the compiler.
const pluginSurfaceCache = new Map<string, RightPanelSurface>();
let lastCombinedSurfaces: ReadonlyArray<RightPanelSurface> = [];

export function pluginRightPanelSurface(
  panelKey: PluginPanelKey,
  title: string,
): RightPanelSurface {
  const cacheKey = `${panelKey}\n${title}`;
  const cached = pluginSurfaceCache.get(cacheKey);
  if (cached) return cached;
  const surface: RightPanelSurface = { id: `plugin:${panelKey}`, kind: "plugin", panelKey, title };
  pluginSurfaceCache.set(cacheKey, surface);
  return surface;
}

export function combineRightPanelSurfaces(
  threadSurfaces: ReadonlyArray<RightPanelSurface>,
  pluginSurfaces: ReadonlyArray<RightPanelSurface>,
): ReadonlyArray<RightPanelSurface> {
  if (pluginSurfaces.length === 0) return threadSurfaces;
  const next = [...threadSurfaces, ...pluginSurfaces];
  const unchanged =
    next.length === lastCombinedSurfaces.length &&
    next.every((surface, index) => surface === lastCombinedSurfaces[index]);
  if (!unchanged) lastCombinedSurfaces = next;
  return lastCombinedSurfaces;
}

function sanitizePinned(persisted: unknown): ReadonlyArray<PluginPanelKey> {
  const raw =
    persisted && typeof persisted === "object" && "pinned" in persisted
      ? (persisted as { pinned: unknown }).pinned
      : null;
  if (!Array.isArray(raw)) return [];
  const keys = raw.filter(
    (key): key is PluginPanelKey =>
      typeof key === "string" && parsePluginPanelKey(key) !== undefined,
  );
  return [...new Set(keys)];
}

function sanitize(persisted: unknown): ByEnvironment {
  const raw =
    persisted && typeof persisted === "object" && "byEnvironment" in persisted
      ? (persisted as { byEnvironment: unknown }).byEnvironment
      : null;
  if (!raw || typeof raw !== "object") return {};
  const next: Record<string, DockedPluginPanels> = {};
  for (const [environment, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { open, focused } = entry as { open?: unknown; focused?: unknown };
    const keys = (Array.isArray(open) ? open : []).filter(
      (key): key is PluginPanelKey =>
        typeof key === "string" && scopeOf(key as PluginPanelKey) === environment,
    );
    const focusedKey =
      typeof focused === "string" && parsePluginPanelKey(focused) !== undefined
        ? (focused as PluginPanelKey)
        : null;
    if (keys.length > 0 || focusedKey !== null) {
      next[environment] = { open: [...new Set(keys)], focused: focusedKey };
    }
  }
  return next;
}

export const usePluginPanelStore = create<PluginPanelStoreState>()(
  persist(
    (set) => ({
      byEnvironment: {},
      pinned: [],
      open: (key, chatEnvironmentId) =>
        set((state) => {
          const scope = scopeOf(key);
          if (scope === undefined) return state;
          const docked = withEntry(state.byEnvironment, scope, (entry) =>
            entry.open.includes(key) ? entry : { ...entry, open: [...entry.open, key] },
          );
          return {
            byEnvironment: withEntry(docked, chatEnvironmentId, (entry) =>
              entry.focused === key ? entry : { ...entry, focused: key },
            ),
          };
        }),
      focus: (key, chatEnvironmentId) =>
        set((state) => ({
          byEnvironment: withEntry(state.byEnvironment, chatEnvironmentId, (entry) =>
            entry.focused === key ? entry : { ...entry, focused: key },
          ),
        })),
      blur: (chatEnvironmentId) =>
        set((state) => ({
          byEnvironment: withEntry(state.byEnvironment, chatEnvironmentId, (entry) =>
            entry.focused === null ? entry : { ...entry, focused: null },
          ),
        })),
      close: (key) =>
        set((state) => ({
          byEnvironment: removeKeys(state.byEnvironment, (entry) => entry === key),
        })),
      pin: (key) =>
        set((state) =>
          state.pinned.includes(key) || parsePluginPanelKey(key) === undefined
            ? state
            : { pinned: [...state.pinned, key] },
        ),
      unpin: (key) =>
        set((state) =>
          state.pinned.includes(key)
            ? { pinned: state.pinned.filter((entry) => entry !== key) }
            : state,
        ),
      dropPlugin: (scope, pluginId) =>
        set((state) => {
          const removed = (key: PluginPanelKey) => {
            const parsed = parsePluginPanelKey(key);
            return parsed?.scope === scope && parsed.pluginId === pluginId;
          };
          const pinned = state.pinned.filter((key) => !removed(key));
          return {
            byEnvironment: removeKeys(state.byEnvironment, removed),
            pinned: pinned.length === state.pinned.length ? state.pinned : pinned,
          };
        }),
    }),
    {
      name: PLUGIN_PANEL_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      // v1 had no pins; merge sanitizes whatever shape arrives.
      migrate: (persisted) => persisted,
      partialize: (state) => ({ byEnvironment: state.byEnvironment, pinned: state.pinned }),
      merge: (persisted, current) => ({
        ...current,
        byEnvironment: sanitize(persisted),
        pinned: sanitizePinned(persisted),
      }),
    },
  ),
);

// Choosing anything in a thread's own panel (a tab, open, close) takes over from a docked plugin.
useRightPanelStore.subscribe((next, previous) => {
  if (next.userActionRevisionByThreadKey === previous.userActionRevisionByThreadKey) return;
  for (const [threadKey, revision] of Object.entries(next.userActionRevisionByThreadKey)) {
    if (revision === previous.userActionRevisionByThreadKey[threadKey]) continue;
    const environmentId = parseScopedThreadKey(threadKey)?.environmentId;
    if (environmentId !== undefined) usePluginPanelStore.getState().blur(environmentId);
  }
});
