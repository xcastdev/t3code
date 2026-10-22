import type { EnvironmentId, MemoryOwner, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AssistantError, type AssistantRecord } from "./AssistantRepository.ts";
import * as Repository from "./AssistantRepository.ts";

export class AssistantOwnership extends Context.Service<
  AssistantOwnership,
  {
    readonly byProject: (
      projectId: ProjectId,
    ) => Effect.Effect<AssistantRecord | null, AssistantError>;
    readonly byThread: (
      threadId: ThreadId,
    ) => Effect.Effect<AssistantRecord | null, AssistantError>;
    readonly assertCurrent: (scope: {
      readonly environmentId: EnvironmentId;
      readonly owner: MemoryOwner;
      readonly ownerRevision: number;
    }) => Effect.Effect<void, AssistantError>;
  }
>()("t3/assistants/AssistantOwnership") {}
const make = Effect.gen(function* () {
  const repository = yield* Repository.AssistantRepository;
  const assertCurrent = Effect.fn("AssistantOwnership.assertCurrent")(function* (scope: {
    readonly environmentId: EnvironmentId;
    readonly owner: MemoryOwner;
    readonly ownerRevision: number;
  }) {
    if (scope.owner.kind !== "assistant") return yield* new AssistantError({ reason: "forbidden" });
    const record = yield* repository.get({
      environmentId: scope.environmentId,
      assistantId: scope.owner.assistantId,
    });
    // Configuration changes never retire the owner's retained memory namespace.
    if (record.ownerRevision !== scope.ownerRevision)
      return yield* new AssistantError({ reason: "conflict" });
  });
  return AssistantOwnership.of({
    byProject: repository.findByProject,
    byThread: repository.findByThread,
    assertCurrent,
  });
});
export const layer = Layer.effect(AssistantOwnership, make);
