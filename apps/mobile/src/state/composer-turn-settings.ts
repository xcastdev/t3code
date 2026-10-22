import type {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";

import type { AgentThreadOwnerKind } from "../features/assistants/useAgentThreadOwner";
import { resolveProviderInteractionMode } from "./legacy-plan-mode";

interface TurnSettings {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** Only a chat positively known to be ordinary or an agent's child accepts local setting overrides. */
export function composerOwnerAcceptsDraftSettings(kind: AgentThreadOwnerKind): boolean {
  return kind === "ordinary" || kind === "child";
}

/**
 * The settings a send uses. A canonical agent home always uses its thread's settings, which the
 * server keeps synchronized with the agent's configuration, so stale local overrides are ignored.
 * Other chats get the provider's mode normalization. While ownership is unresolved, outgoing
 * settings that differ from the thread (an override, or normalization dropping a saved Plan mode)
 * could be a canonical conflict, so the send waits (null) instead of guessing.
 */
export function resolveComposerTurnSettings(input: {
  readonly ownerKind: AgentThreadOwnerKind;
  readonly draft: Partial<TurnSettings>;
  readonly thread: TurnSettings;
  readonly providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "showInteractionModeToggle">
  >;
}): TurnSettings | null {
  const { draft, thread } = input;
  if (input.ownerKind === "canonical") return thread;
  const modelSelection = draft.modelSelection ?? thread.modelSelection;
  const settings = {
    modelSelection,
    runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
    interactionMode: resolveProviderInteractionMode(
      input.providers.find((provider) => provider.instanceId === modelSelection.instanceId),
      draft.interactionMode ?? thread.interactionMode,
    ),
  };
  if (composerOwnerAcceptsDraftSettings(input.ownerKind)) return settings;
  return modelSelectionsEqual(settings.modelSelection, thread.modelSelection) &&
    settings.runtimeMode === thread.runtimeMode &&
    settings.interactionMode === thread.interactionMode
    ? settings
    : null;
}
