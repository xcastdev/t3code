import { useAtomValue } from "@effect/atom-react";
import type { ClientPluginRecord } from "@t3tools/client-runtime/plugins/client-packages";
import {
  CLIENT_PLUGIN_SCOPE_LABEL,
  parsePluginPanelKey,
  type PluginInstallEntry,
  type PluginPanelKey,
} from "@t3tools/client-runtime/plugins/commands";
import type { EnvironmentId, PluginInstallRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations, environmentSummaries } from "../state/presentation";
import { pluginEnvironment } from "../state/plugins";
import { clientPluginStore } from "./clientPluginStore";

/** Client-only plugins in this browser's storage; refresh after every change. */
export const clientPluginRecordsAtom = Atom.make(
  Effect.promise(() => clientPluginStore.list()),
).pipe(Atom.keepAlive, Atom.withLabel("web-plugins:client-records"));

/** Plugins whose client-install panel state outlives their package on this device. */
export const leftoverClientPluginStateAtom = Atom.make(
  Effect.promise(async () => {
    const [records, owners] = await Promise.all([
      clientPluginStore.list(),
      clientPluginStore.listStateOwners(),
    ]);
    return owners.flatMap((owner) =>
      owner.scope === "client" && !records.some((record) => record.pluginId === owner.pluginId)
        ? [owner.pluginId]
        : [],
    );
  }),
).pipe(Atom.keepAlive, Atom.withLabel("web-plugins:leftover-client-state"));

export function refreshClientPlugins(): void {
  appAtomRegistry.refresh(clientPluginRecordsAtom);
  appAtomRegistry.refresh(leftoverClientPluginStateAtom);
}

const registryAtom = (environmentId: EnvironmentId) =>
  pluginEnvironment.registry({ environmentId, input: {} });

const environmentLabel = (get: Atom.AtomContext, environmentId: EnvironmentId): string =>
  get(environmentPresentations.presentationAtom(environmentId))?.entry.target.label ??
  environmentId;

/** Enabled installs on this device and in every connected environment, for entry points. */
const collectPluginInstalls = (
  get: Atom.AtomContext,
  enabledOnly: boolean,
): ReadonlyArray<PluginInstallEntry> => {
  const client = AsyncResult.getOrElse(get(clientPluginRecordsAtom), () => []);
  const entries: PluginInstallEntry[] = client
    .filter((record) => !enabledOnly || record.enabled)
    .map((record) => ({ scope: "client", scopeLabel: CLIENT_PLUGIN_SCOPE_LABEL, record }));
  for (const environmentId of get(environmentSummaries.connectedEnvironmentIdsAtom)) {
    const registry = get(registryAtom(environmentId));
    if (!AsyncResult.isSuccess(registry)) continue;
    const scopeLabel = environmentLabel(get, environmentId);
    for (const record of registry.value.installed) {
      if (!enabledOnly || record.enabled)
        entries.push({ scope: environmentId, scopeLabel, record });
    }
  }
  return entries;
};

export const enabledPluginInstallsAtom = Atom.make((get) => collectPluginInstalls(get, true)).pipe(
  Atom.withLabel("web-plugins:enabled-installs"),
);

// Tab titles need disabled installs too: their docked panels stay open showing Enable.
const allPluginInstallsAtom = Atom.make((get) => collectPluginInstalls(get, false)).pipe(
  Atom.withLabel("web-plugins:all-installs"),
);

export type PluginPanelInstall =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "disconnected"; readonly environmentLabel: string }
  | { readonly kind: "client"; readonly record: ClientPluginRecord }
  | {
      readonly kind: "environment";
      readonly environmentId: EnvironmentId;
      readonly environmentLabel: string;
      readonly record: PluginInstallRecord;
    };

const LOADING_ATOM = Atom.make<PluginPanelInstall>({ kind: "loading" });

const panelInstallAtom = Atom.family((panelKey: PluginPanelKey) => {
  const parsed = parsePluginPanelKey(panelKey);
  if (parsed === undefined) return Atom.make<PluginPanelInstall>({ kind: "missing" });
  return Atom.make((get): PluginPanelInstall => {
    const hasPanel = (manifest: PluginInstallRecord["manifest"]) =>
      manifest.ui?.panels.some((panel) => panel.id === parsed.panelId) === true;
    if (parsed.scope === "client") {
      const records = get(clientPluginRecordsAtom);
      if (!AsyncResult.isSuccess(records)) {
        return AsyncResult.isFailure(records) ? { kind: "missing" } : { kind: "loading" };
      }
      const record = records.value.find((entry) => entry.pluginId === parsed.pluginId);
      return record !== undefined && hasPanel(record.manifest)
        ? { kind: "client", record }
        : { kind: "missing" };
    }
    const environmentId = parsed.scope;
    const registry = get(registryAtom(environmentId));
    if (!AsyncResult.isSuccess(registry)) {
      const presentation = get(environmentPresentations.presentationAtom(environmentId));
      const phase = presentation?.connection.phase;
      if (phase !== "connected" && phase !== "connecting") {
        return presentation === null && !get(environmentCatalog.catalogValueAtom).isReady
          ? { kind: "loading" }
          : { kind: "disconnected", environmentLabel: environmentLabel(get, environmentId) };
      }
      return AsyncResult.isFailure(registry) ? { kind: "missing" } : { kind: "loading" };
    }
    const record = registry.value.installed.find((entry) => entry.pluginId === parsed.pluginId);
    return record !== undefined && hasPanel(record.manifest)
      ? {
          kind: "environment",
          environmentId,
          environmentLabel: environmentLabel(get, environmentId),
          record,
        }
      : { kind: "missing" };
  });
});

export function usePluginPanelInstall(panelKey: PluginPanelKey | null): PluginPanelInstall {
  return useAtomValue(panelKey === null ? LOADING_ATOM : panelInstallAtom(panelKey));
}

export function useEnabledPluginInstalls(): ReadonlyArray<PluginInstallEntry> {
  return useAtomValue(enabledPluginInstallsAtom);
}

export function useAllPluginInstalls(): ReadonlyArray<PluginInstallEntry> {
  return useAtomValue(allPluginInstallsAtom);
}
