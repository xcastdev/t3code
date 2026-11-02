import type { AssistantId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { AtomRegistry } from "effect/reactivity";

import { newThreadId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { assistantsEnvironment } from "~/state/assistants";
import { useQuietThreadShells } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { toastManager } from "../ui/toast";

/**
 * Starts a chat under an agent's Home and opens it. A chat starts from the agent's configured
 * model and modes, not from overrides Home may have picked up.
 */
export function useCreateAgentChat(onNavigate: () => void) {
  const navigate = useNavigate();
  const threads = useQuietThreadShells();
  const createThread = useOrchestrationCommand(threadEnvironment.create, {
    label: "start a chat",
  });
  return async (agent: {
    readonly environmentId: EnvironmentId;
    readonly assistantId: AssistantId;
    readonly canonicalThreadId: ThreadId;
  }) => {
    const { environmentId, assistantId } = agent;
    const home = threads.find(
      (thread) => thread.environmentId === environmentId && thread.id === agent.canonicalThreadId,
    );
    if (home === undefined) return;
    const detail = await Effect.runPromiseExit(
      AtomRegistry.getResult(
        appAtomRegistry,
        assistantsEnvironment.detail({ environmentId, input: { environmentId, assistantId } }),
        { suspendOnWaiting: true },
      ),
    );
    if (Exit.isFailure(detail)) {
      toastManager.add({
        type: "error",
        title: "Could not start a chat",
        description: "The agent's configuration could not be read. Try again.",
      });
      return;
    }
    const defaults = detail.value.configuration.configuration;
    const threadId = newThreadId();
    const result = await createThread({
      environmentId,
      input: {
        threadId,
        projectId: home.projectId,
        title: "New thread",
        modelSelection: defaults.modelSelection,
        runtimeMode: defaults.runtimeMode,
        interactionMode: defaults.interactionMode,
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
