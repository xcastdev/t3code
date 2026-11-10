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

import { appAtomRegistry } from "../../state/atom-registry";
import { pluginEnvironment } from "../../state/plugins";
import { connectedEnvironmentIdsAtom, environmentPresentations } from "../../state/presentation";
import { clientPluginStore } from "./clientPluginStore";

/** Client-only plugins in this device's storage; refresh after every change. */
export const clientPluginRecordsAtom = Atom.make(
  Effect.promise(() => clientPluginStore.list()),
).pipe(Atom.keepAlive, Atom.withLabel("mobile-plugins:client-records"));

export function refreshClientPlugins(): void {
  appAtomRegistry.refresh(clientPluginRecordsAtom);
}

export const pluginRegistryAtom = (environmentId: EnvironmentId) =>
  pluginEnvironment.registry({ environmentId, input: {} });

const environmentLabel = (get: Atom.AtomContext, environmentId: EnvironmentId): string =>
  get(environmentPresentations.presentationAtom(environmentId))?.entry.target.label ??
  environmentId;

/** Enabled installs on this device and in every connected environment, for entry points. */
const enabledPluginInstallsAtom = Atom.make((get): ReadonlyArray<PluginInstallEntry> => {
  const client = AsyncResult.getOrElse(get(clientPluginRecordsAtom), () => []);
  const entries: PluginInstallEntry[] = client
    .filter((record) => record.enabled)
    .map((record) => ({ scope: "client", scopeLabel: CLIENT_PLUGIN_SCOPE_LABEL, record }));
  for (const environmentId of get(connectedEnvironmentIdsAtom)) {
    const registry = get(pluginRegistryAtom(environmentId));
    if (!AsyncResult.isSuccess(registry)) continue;
    const scopeLabel = environmentLabel(get, environmentId);
    for (const record of registry.value.installed) {
      if (record.enabled) entries.push({ scope: environmentId, scopeLabel, record });
    }
  }
  return entries;
}).pipe(Atom.withLabel("mobile-plugins:enabled-installs"));

export type PluginPanelInstall =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "client"; readonly record: ClientPluginRecord }
  | {
      readonly kind: "environment";
      readonly environmentId: EnvironmentId;
      readonly environmentLabel: string;
      readonly record: PluginInstallRecord;
    };

const MISSING_ATOM = Atom.make<PluginPanelInstall>({ kind: "missing" });

const panelInstallAtom = Atom.family((panelKey: PluginPanelKey) => {
  const parsed = parsePluginPanelKey(panelKey);
  if (parsed === undefined) return MISSING_ATOM;
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
    const registry = get(pluginRegistryAtom(environmentId));
    if (!AsyncResult.isSuccess(registry)) {
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
  return useAtomValue(panelKey === null ? MISSING_ATOM : panelInstallAtom(panelKey));
}

export function useEnabledPluginInstalls(): ReadonlyArray<PluginInstallEntry> {
  return useAtomValue(enabledPluginInstallsAtom);
}
