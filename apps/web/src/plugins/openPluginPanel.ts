import { parsePluginPanelKey, type PluginPanelKey } from "@t3tools/client-runtime/plugins/commands";
import type { AnyRouter } from "@tanstack/react-router";

import { useComposerDraftStore } from "../composerDraftStore";
import { usePluginPanelStore } from "../pluginPanelStore";
import { resolveThreadRouteTarget } from "../threadRoutes";

/** Docks beside a chat that can show the panel; anything else opens the standalone page. */
export function resolvePluginOpenTarget(input: {
  readonly scope: string;
  readonly chat: { readonly environmentId: string } | null;
}): "dock" | "page" {
  if (input.chat === null) return "page";
  return input.scope === "client" || input.scope === input.chat.environmentId ? "dock" : "page";
}

/** The environment of the chat the current route shows, thread or draft. */
export function readRouteChatEnvironmentId(router: AnyRouter): string | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  if (target === null) return null;
  if (target.kind === "server") return target.threadRef.environmentId;
  return useComposerDraftStore.getState().getDraftSession(target.draftId)?.environmentId ?? null;
}

export function openPluginPanel(router: AnyRouter, key: PluginPanelKey): void {
  const parsed = parsePluginPanelKey(key);
  if (parsed === undefined) return;
  const chatEnvironmentId = readRouteChatEnvironmentId(router);
  const chat = chatEnvironmentId === null ? null : { environmentId: chatEnvironmentId };
  if (chat !== null && resolvePluginOpenTarget({ scope: parsed.scope, chat }) === "dock") {
    usePluginPanelStore.getState().open(key, chat.environmentId);
    return;
  }
  void router.navigate({
    to: "/plugins/$scope/$pluginId/$panelId",
    params: { scope: parsed.scope, pluginId: parsed.pluginId, panelId: parsed.panelId },
  });
}
