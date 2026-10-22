import { AuthSessionId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AssistantRoutineGateway } from "../../../assistants/AssistantRoutineGateway.ts";
import * as Access from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { AssistantRoutineToolkit } from "./tools.ts";
const failure = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Assistant routines require current authorized canonical ownership.",
  });
export const layer = Access.toLayer(AssistantRoutineToolkit, {
  t3_assistant_routines_read: Access.reads((input) =>
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const gateway = yield* AssistantRoutineGateway;
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
  t3_assistant_routines_write: Access.writes((input) =>
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const gateway = yield* AssistantRoutineGateway;
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
