import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Gateway from "../../../projectWork/ProjectWorkGateway.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { ProjectWorkToolkit } from "./tools.ts";

const authority = Effect.gen(function* () {
  const { scope, caller } = yield* readCaller();
  const sessionId = scope.thread?.providerSessionId ?? scope.client?.sessionId;
  if (sessionId === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Project Work requires an authenticated caller session.",
    });
  return {
    environmentId: scope.environmentId,
    ...(caller === undefined ? {} : { projectId: caller.projectId }),
    actor: { kind: "agent" as const, id: scope.thread?.threadId ?? sessionId },
    source: { kind: "mcp" as const, id: sessionId },
  } satisfies Gateway.ProjectWorkPrincipal;
});
const mapFailure = (error: import("@t3tools/contracts").ProjectWorkRpcError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "forbidden"
        ? "capability_denied"
        : error.reason === "invalid-request" || error.reason === "rejected"
          ? "invalid_request"
          : "orchestration_error",
    message: error.message,
  });
export const layer = McpToolAccess.toLayer(ProjectWorkToolkit, {
  t3_project_work_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const principal = yield* authority;
      const gateway = yield* Gateway.ProjectWorkGateway;
      return yield* gateway.read(input, principal).pipe(Effect.mapError(mapFailure));
    }),
  ),
  t3_project_work_write: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const principal = yield* authority;
      const gateway = yield* Gateway.ProjectWorkGateway;
      return yield* gateway.write(input.intent, principal).pipe(Effect.mapError(mapFailure));
    }),
  ),
});
