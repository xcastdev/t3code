import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AnyRouter } from "@tanstack/react-router";
import { create } from "zustand";

import type { EnvironmentId } from "@t3tools/contracts";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useThreadShell } from "../state/entities";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { PluginChatTarget } from "./attachToChat";

/** A scoped thread key or a draft id, with the environment the chat runs in. */
interface RecentChat {
  readonly key: string;
  readonly environmentId: EnvironmentId;
}

interface RecentChatState {
  readonly byEnvironment: Readonly<Record<string, RecentChat>>;
  readonly latest: RecentChat | null;
}

const useRecentChatStore = create<RecentChatState>(() => ({
  byEnvironment: {},
  latest: null,
}));

/** Remembers the last chat viewed per environment, for panels opened away from a chat. */
export function startRecentChatTracking(router: AnyRouter): () => void {
  const record = () => {
    const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    if (target === null) return;
    const chat =
      target.kind === "server"
        ? { key: scopedThreadKey(target.threadRef), environmentId: target.threadRef.environmentId }
        : (() => {
            const session = useComposerDraftStore.getState().getDraftSession(target.draftId);
            return session ? { key: target.draftId, environmentId: session.environmentId } : null;
          })();
    if (chat === null) return;
    const state = useRecentChatStore.getState();
    if (state.latest?.key === chat.key && state.byEnvironment[chat.environmentId]?.key === chat.key)
      return;
    useRecentChatStore.setState({
      latest: chat,
      byEnvironment: { ...state.byEnvironment, [chat.environmentId]: chat },
    });
  };
  record();
  return router.subscribe("onResolved", record);
}

/** The chat a panel attaches into when no chat is showing: same environment, or any for client. */
export function useRecentChatTarget(scope: string): PluginChatTarget {
  const chat = useRecentChatStore((state) =>
    scope === "client" ? state.latest : (state.byEnvironment[scope] ?? null),
  );
  const threadRef = chat === null ? null : (parseScopedThreadKey(chat.key) ?? null);
  const shell = useThreadShell(threadRef);
  if (chat === null) return null;
  const { key, environmentId } = chat;
  if (threadRef === null) {
    return { key, title: "New thread", composerTarget: DraftId.make(key), environmentId };
  }
  return { key, title: shell?.title ?? "Chat", composerTarget: threadRef, environmentId };
}
