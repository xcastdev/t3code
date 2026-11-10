import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShell } from "../../state/entities";

interface RecentThread {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

interface RecentChatState {
  readonly byEnvironment: Readonly<Record<string, RecentThread>>;
  readonly latest: RecentThread | null;
}

const recentChatAtom = Atom.make<RecentChatState>({ byEnvironment: {}, latest: null }).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-plugins:recent-chat"),
);

/** The thread a plugin panel attaches into: its composer draft key, title and environment. */
export interface PluginChatThread {
  readonly key: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
}

/** Remembers the thread on screen, for plugin panels opened away from it. */
export function useRecordRecentPluginChat(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): void {
  useFocusEffect(
    useCallback(() => {
      if (environmentId === null || threadId === null) return;
      const state = appAtomRegistry.get(recentChatAtom);
      if (state.latest?.environmentId === environmentId && state.latest.threadId === threadId) {
        return;
      }
      const thread = { environmentId, threadId };
      appAtomRegistry.set(recentChatAtom, {
        latest: thread,
        byEnvironment: { ...state.byEnvironment, [environmentId]: thread },
      });
    }, [environmentId, threadId]),
  );
}

/** The most recently viewed thread in the panel's environment, or in any for client panels. */
export function useRecentPluginChat(scope: string): PluginChatThread | null {
  const state = useAtomValue(recentChatAtom);
  const recent = scope === "client" ? state.latest : (state.byEnvironment[scope] ?? null);
  const shell = useThreadShell(
    recent === null ? null : scopeThreadRef(recent.environmentId, recent.threadId),
  );
  if (recent === null) return null;
  return {
    key: scopedThreadKey(recent.environmentId, recent.threadId),
    title: shell?.title || "Untitled thread",
    environmentId: recent.environmentId,
  };
}
