import {
  resolvePluginCommand,
  type PluginInstallEntry,
} from "@t3tools/client-runtime/plugins/commands";
import type { PluginOpenCommand } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { openCommandPalette } from "../commandPaletteBus";
import { openPluginPanel, readRouteChatEnvironmentId } from "../plugins/openPluginPanel";
import { enabledPluginInstallsAtom } from "../plugins/pluginInstalls";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { type CommandHandlers, registerCommands } from "./dispatcher";

/**
 * Registers one `plugin.<pluginId>.<commandId>` handler per declared command. The scope is
 * replaced when the set of commands changes; handlers resolve the install when the key is pressed.
 */
export function installPluginCommands(router: AnyRouter): () => void {
  let installs: ReadonlyArray<PluginInstallEntry> = [];
  let signature = "";
  let dispose = () => {};

  const register = () => {
    const commands = new Map<PluginOpenCommand, { pluginId: string; commandId: string }>();
    for (const { record } of installs) {
      for (const command of record.manifest.ui?.commands ?? []) {
        commands.set(`plugin.${record.pluginId}.${command.id}`, {
          pluginId: record.pluginId,
          commandId: command.id,
        });
      }
    }
    const next = [...commands.keys()].toSorted().join("\n");
    if (next === signature) return;
    signature = next;
    dispose();
    const handlers: CommandHandlers = {};
    for (const [name, command] of commands) {
      handlers[name] = (event) => {
        const resolution = resolvePluginCommand(
          command,
          installs,
          readRouteChatEnvironmentId(router),
        );
        if (resolution.kind === "missing") return false;
        event.preventDefault();
        if (resolution.kind === "open") openPluginPanel(router, resolution.key);
        else openCommandPalette({ query: resolution.title });
      };
    }
    dispose = registerCommands(handlers);
  };

  const unsubscribe = appAtomRegistry.subscribe(
    enabledPluginInstallsAtom,
    (value) => {
      installs = value;
      register();
    },
    { immediate: true },
  );
  return () => {
    unsubscribe();
    dispose();
  };
}
