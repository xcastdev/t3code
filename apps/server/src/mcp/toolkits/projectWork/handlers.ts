import { type ProjectWorkReadIntent, type ProjectWorkWriteIntent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectWorkGateway from "../../../projectWork/ProjectWorkGateway.ts";
import { ProjectWorkToolkit, ProjectWorkToolError } from "./tools.ts";

const toolError = (cause: unknown): ProjectWorkToolError =>
  new ProjectWorkToolError({
    // Tool failures are public MCP output. Keep a bounded diagnostic while
    // avoiding the original cause, which may contain credentials or SQL.
    message: (cause instanceof Error ? cause.message : "Project-work request failed.").slice(
      0,
      4_000,
    ),
  });

const make = Effect.gen(function* () {
  const gateway = yield* ProjectWorkGateway.ProjectWorkGateway;
  const read = (input: ProjectWorkReadIntent) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireMcpCapability(
        "project",
        input.projectId,
      );
      return yield* gateway
        .read(input, {
          actor: McpInvocationContext.projectWorkActorForInvocation(invocation),
          ...(invocation.managed === undefined ? {} : { managed: invocation.managed }),
        })
        .pipe(Effect.mapError(toolError));
    });
  const write = (command: ProjectWorkWriteIntent) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireMcpCapability(
        "project",
        command.projectId,
      );
      const actor = McpInvocationContext.projectWorkActorForInvocation(invocation);
      return yield* gateway
        .write(command, actor, McpInvocationContext.projectWorkSourceForInvocation(invocation), {
          actor,
          ...(invocation.managed === undefined ? {} : { managed: invocation.managed }),
        })
        .pipe(Effect.mapError(toolError));
    });

  return ProjectWorkToolkit.of({
    project_work_read: read,
    project_work_write: write,
  });
});

export const ProjectWorkToolkitHandlersLive = ProjectWorkToolkit.toLayer(make);
