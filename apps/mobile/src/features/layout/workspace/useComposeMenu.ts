import { useAtomValue } from "@effect/atom-react";
import { agentsPinnedFirst } from "@t3tools/client-runtime/state/agents-list";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { steadyNavigationThreadShellsAtom } from "../../../state/threads";
import { workspaceConnections } from "../../../state/workspace";
import type { WorkspaceEnvironment } from "../../../state/workspaceModel";
import { useAllAgents } from "../../assistants/useAssistants";
import { useAgentNavigation } from "../../home/useAgentNavigation";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import {
  COMPOSE_NEW_AGENT,
  COMPOSE_NEW_CHAT,
  composeMenuActions,
  composeMenuAgent,
} from "./compose-menu";

type PinnedHome = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "pinnedAt" | "pinOrderKey"
>;

// Selectors return strings, so the button re-renders when a connection or pin changes, not on
// every thread update.
const connectedEnvironmentsKey = (environments: ReadonlyArray<WorkspaceEnvironment>) =>
  environments
    .filter((environment) => environment.isEnabled && environment.connectionState === "connected")
    .map((environment) => environment.environmentId)
    .join("\n");

const pinnedThreadsKey = (threads: ReadonlyArray<EnvironmentThreadShell>) =>
  JSON.stringify(
    threads.flatMap((thread): PinnedHome[] =>
      thread.pinnedAt == null
        ? []
        : [
            {
              id: thread.id,
              environmentId: thread.environmentId,
              createdAt: thread.createdAt,
              pinnedAt: thread.pinnedAt,
              pinOrderKey: thread.pinOrderKey,
            },
          ],
    ),
  );

/** The compose button's long-press menu; `enabled` false while the button is hidden. */
export function useComposeMenu(enabled: boolean) {
  const environmentsKey = useAtomValue(
    workspaceConnections.environmentsAtom,
    connectedEnvironmentsKey,
  );
  const environmentIds =
    enabled && environmentsKey !== ""
      ? environmentsKey.split("\n").map((id) => EnvironmentId.make(id))
      : [];
  const { agents } = useAllAgents(environmentIds);
  const pinnedKey = useAtomValue(steadyNavigationThreadShellsAtom, pinnedThreadsKey);
  const ordered = useMemo(
    () => agentsPinnedFirst(agents, JSON.parse(pinnedKey) as PinnedHome[]),
    [agents, pinnedKey],
  );
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  const agentNavigation = useAgentNavigation();
  const actions = useMemo(() => composeMenuActions(ordered), [ordered]);
  return {
    actions,
    onSelect: (id: string) => {
      if (id === COMPOSE_NEW_CHAT) return startNewTask();
      // As on the Agents list: the only connected environment, or the form's own picker.
      if (id === COMPOSE_NEW_AGENT)
        return agentNavigation.openNewAgent(
          environmentIds.length === 1 ? environmentIds[0]! : null,
        );
      const agent = composeMenuAgent(ordered, id);
      if (agent) agentNavigation.openAgent(agent);
    },
  };
}
