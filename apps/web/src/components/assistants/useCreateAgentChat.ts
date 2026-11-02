import type { AssistantSummary } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { newThreadId } from "~/lib/utils";
import { useQuietThreadShells } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

/** Starts a chat under an agent's home, with the agent's model and modes, and opens it. */
export function useCreateAgentChat(onNavigate: () => void) {
  const navigate = useNavigate();
  const threads = useQuietThreadShells();
  const createThread = useOrchestrationCommand(threadEnvironment.create, {
    label: "start a chat",
  });
  return async (agent: AssistantSummary) => {
    const { environmentId } = agent;
    const home = threads.find(
      (thread) =>
        thread.environmentId === environmentId && thread.id === agent.binding.canonicalThreadId,
    );
    if (home === undefined) return;
    const threadId = newThreadId();
    const result = await createThread({
      environmentId,
      input: {
        threadId,
        projectId: agent.binding.backingProjectId,
        title: "New thread",
        modelSelection: home.modelSelection,
        runtimeMode: home.runtimeMode,
        interactionMode: home.interactionMode,
        branch: home.branch,
        worktreePath: home.worktreePath,
        parentThreadId: home.id,
        createdAt: new Date().toISOString(),
      },
    });
    if (result._tag === "Failure") return;
    onNavigate();
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };
}
