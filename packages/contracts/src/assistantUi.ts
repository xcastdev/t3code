import * as Schema from "effect/Schema";

import { AssistantConfigurationRevision } from "./assistants.ts";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AssistantId } from "./memoryOwner.ts";

export const AssistantResolveThreadInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type AssistantResolveThreadInput = typeof AssistantResolveThreadInput.Type;

const ReadStatus = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export const AssistantThreadOwner = Schema.Struct({
  ...AssistantResolveThreadInput.fields,
  assistantId: AssistantId,
  backingProjectId: ProjectId,
  canonicalThreadId: ThreadId,
  configurationRevision: AssistantConfigurationRevision,
  lifecycle: ReadStatus,
  provisioningState: ReadStatus,
  isCanonicalHome: Schema.Boolean,
});
export type AssistantThreadOwner = typeof AssistantThreadOwner.Type;

export const AssistantResolveThreadResult = Schema.NullOr(AssistantThreadOwner);
export type AssistantResolveThreadResult = typeof AssistantResolveThreadResult.Type;
