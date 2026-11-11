import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";

import type { AgentThreadOwnerKind } from "../features/assistants/useAgentThreadOwner";

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
 * A canonical agent home sends its thread's server-synchronized settings; other chats run in build
 * mode. Unresolved ownership holds (null) any send whose settings differ from the thread's.
 */
export function resolveComposerTurnSettings(input: {
  readonly ownerKind: AgentThreadOwnerKind;
  readonly draft: Partial<TurnSettings>;
  readonly thread: TurnSettings;
}): TurnSettings | null {
  const { draft, thread } = input;
  if (input.ownerKind === "canonical") return thread;
  const settings = {
    modelSelection: draft.modelSelection ?? thread.modelSelection,
    runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  };
  if (composerOwnerAcceptsDraftSettings(input.ownerKind)) return settings;
  return modelSelectionsEqual(settings.modelSelection, thread.modelSelection) &&
    settings.runtimeMode === thread.runtimeMode &&
    settings.interactionMode === thread.interactionMode
    ? settings
    : null;
}
