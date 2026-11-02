import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import * as ViewImageMcpService from "../../ViewImageMcpService.ts";
import { ViewImageToolkit } from "./tools.ts";

const callerRoot = Effect.gen(function* () {
  const { caller } = yield* loadCaller();
  if (caller === undefined) return yield* unavailable();
  if (caller.worktreePath !== null) return caller.worktreePath;
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects.getById(caller.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "This thread's project was not found.",
    });
  }
  return project.value.workspaceRoot;
});

export const layer = McpToolAccess.toLayer(ViewImageToolkit, {
  t3_view_image: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* ViewImageMcpService.ViewImageMcpService;
      return yield* service.view({
        root: yield* callerRoot,
        path: input.path,
        instructions: input.instructions,
      });
    }),
  ),
});
