import type { AssistantSelection } from "@t3tools/client-runtime/state/assistants";
import type { AssistantDetail, EnvironmentId } from "@t3tools/contracts";

import type { AssistantWriter } from "./useAssistants";

export interface MobileAgentContext {
  readonly environmentId: EnvironmentId;
  readonly detail: AssistantDetail;
  readonly connected: boolean;
  readonly epoch: string | null;
  readonly selection: AssistantSelection | null;
  readonly latestSelection: () => AssistantSelection | null;
  readonly writer: AssistantWriter;
}

export function agentBlockedReason(context: MobileAgentContext, allowed: boolean) {
  if (!context.connected || context.selection === null) return "Reconnect to make changes.";
  return allowed ? null : "This connection isn't allowed to do that.";
}
