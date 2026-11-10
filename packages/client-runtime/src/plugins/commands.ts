import {
  EnvironmentId,
  PluginContributionId,
  PluginId,
  type PluginManifest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type PluginPanelScope = EnvironmentId | "client";
export type PluginPanelKey = `${PluginPanelScope}:${PluginId}:${PluginContributionId}`;

const isEnvironmentId = Schema.is(EnvironmentId);
const isPluginId = Schema.is(PluginId);
const isPluginContributionId = Schema.is(PluginContributionId);

export const pluginPanelKey = (
  scope: PluginPanelScope,
  pluginId: PluginId,
  panelId: PluginContributionId,
): PluginPanelKey => `${scope}:${pluginId}:${panelId}`;

// Plugin and panel ids never contain ":", so the scope is everything before the last two segments.
export const parsePluginPanelKey = (
  key: string,
):
  | {
      readonly scope: PluginPanelScope;
      readonly pluginId: PluginId;
      readonly panelId: PluginContributionId;
    }
  | undefined => {
  const panelSeparator = key.lastIndexOf(":");
  if (panelSeparator === -1) return undefined;
  const pluginSeparator = key.lastIndexOf(":", panelSeparator - 1);
  if (pluginSeparator === -1) return undefined;
  const scope = key.slice(0, pluginSeparator);
  const pluginId = key.slice(pluginSeparator + 1, panelSeparator);
  const panelId = key.slice(panelSeparator + 1);
  if (scope !== "client" && !isEnvironmentId(scope)) return undefined;
  if (!isPluginId(pluginId) || !isPluginContributionId(panelId)) return undefined;
  return { scope, pluginId, panelId };
};

export interface PluginInstallEntry {
  readonly scope: PluginPanelScope;
  /** "On this device" for client installs, otherwise the environment's label. */
  readonly scopeLabel: string;
  readonly record: {
    readonly pluginId: PluginId;
    readonly version: string;
    readonly manifest: PluginManifest;
  };
}

export interface PluginPanelTarget {
  readonly kind: "panel" | "command";
  /** The panel this target opens; a command target names the panel its manifest entry opens. */
  readonly key: PluginPanelKey;
  readonly scope: PluginPanelScope;
  readonly scopeLabel: string;
  readonly pluginId: PluginId;
  readonly pluginName: string;
  readonly title: string;
  readonly commandId?: PluginContributionId;
}

export const CLIENT_PLUGIN_SCOPE_LABEL = "On this device";

const commandPanel = (manifest: PluginManifest, commandId: string) => {
  const command = manifest.ui?.commands.find((entry) => entry.id === commandId);
  if (command === undefined) return undefined;
  const panel = manifest.ui?.panels.find((entry) => entry.id === command.opens.panel);
  return panel === undefined ? undefined : { command, panel };
};

export function listPluginPanelTargets(
  installs: ReadonlyArray<PluginInstallEntry>,
): ReadonlyArray<PluginPanelTarget> {
  return installs.flatMap(({ scope, scopeLabel, record }) => {
    const ui = record.manifest.ui;
    if (ui === undefined) return [];
    const base = { scope, scopeLabel, pluginId: record.pluginId, pluginName: record.manifest.name };
    const panels = ui.panels.map((panel): PluginPanelTarget => ({
      ...base,
      kind: "panel",
      key: pluginPanelKey(scope, record.pluginId, panel.id),
      title: panel.title,
    }));
    const commands = ui.commands.flatMap((entry): ReadonlyArray<PluginPanelTarget> => {
      const resolved = commandPanel(record.manifest, entry.id);
      if (resolved === undefined) return [];
      return [
        {
          ...base,
          kind: "command",
          key: pluginPanelKey(scope, record.pluginId, resolved.panel.id),
          title: entry.title,
          commandId: entry.id,
        },
      ];
    });
    return [...panels, ...commands];
  });
}

export type PluginCommandResolution =
  | { readonly kind: "open"; readonly key: PluginPanelKey }
  | {
      readonly kind: "choose";
      readonly title: string;
      readonly candidates: ReadonlyArray<PluginPanelTarget>;
    }
  | { readonly kind: "missing" };

/**
 * Picks the install a keybinding opens: the chat's environment, then this device, then the
 * only environment that has it. Anything else asks the user to choose.
 */
export function resolvePluginCommand(
  command: { readonly pluginId: string; readonly commandId: string },
  installs: ReadonlyArray<PluginInstallEntry>,
  chatEnvironmentId: string | null,
): PluginCommandResolution {
  const candidates = listPluginPanelTargets(
    installs.filter((install) => install.record.pluginId === command.pluginId),
  ).filter((target) => target.kind === "command" && target.commandId === command.commandId);
  const first = candidates[0];
  if (first === undefined) return { kind: "missing" };
  const pick =
    candidates.find((target) => chatEnvironmentId !== null && target.scope === chatEnvironmentId) ??
    candidates.find((target) => target.scope === "client");
  if (pick !== undefined) return { kind: "open", key: pick.key };
  if (candidates.length === 1) return { kind: "open", key: first.key };
  return { kind: "choose", title: first.title, candidates };
}
