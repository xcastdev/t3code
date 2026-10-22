import { AuthSessionId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AssistantMemoryGateway } from "../../../assistants/AssistantMemoryGateway.ts";
import * as Access from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { AssistantMemoryToolkit } from "./tools.ts";
const failure = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Assistant memory requires current authorized canonical ownership.",
  });
export const layer = Access.toLayer(AssistantMemoryToolkit, {
  t3_assistant_memory_read: Access.reads((input) =>
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const gateway = yield* AssistantMemoryGateway;
      if (input.environmentId !== scope.environmentId) return yield* failure();
      if (scope.thread !== undefined)
        return yield* gateway.readNative(input, {
          threadId: scope.thread.threadId,
          providerSessionId: scope.thread.providerSessionId,
        });
      if (scope.client === undefined) return yield* failure();
      return yield* gateway.read(input, AuthSessionId.make(scope.client.sessionId));
    }).pipe(Effect.mapError(failure)),
  ),
  t3_assistant_memory_write: Access.writes((input) =>
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const gateway = yield* AssistantMemoryGateway;
      if (input.environmentId !== scope.environmentId) return yield* failure();
      if (scope.thread !== undefined)
        return yield* gateway.writeNative(input, {
          threadId: scope.thread.threadId,
          providerSessionId: scope.thread.providerSessionId,
        });
      if (scope.client === undefined) return yield* failure();
      return yield* gateway.write(input, AuthSessionId.make(scope.client.sessionId));
    }).pipe(Effect.mapError(failure)),
  ),
});
