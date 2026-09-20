import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectWorkGateway from "../../../projectWork/ProjectWorkGateway.ts";
import { ProjectWorkToolkitHandlersLive } from "./handlers.ts";
import { ProjectWorkToolkit } from "./tools.ts";

const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const gateway = Layer.succeed(
  ProjectWorkGateway.ProjectWorkGateway,
  ProjectWorkGateway.ProjectWorkGateway.of({
    read: (input) => Effect.succeed({ projectId: input.projectId, operation: input.operation }),
    write: ((command: ProjectWorkCommand) =>
      Effect.succeed({
        projectId: command.projectId,
        revision: 1,
        receipt: {
          commandId: command.commandId,
          status: "accepted" as const,
          projectId: command.projectId,
          revision: 1,
          eventCount: 0,
        },
        delta: {
          projectId: command.projectId,
          revision: 1,
          eventIds: [],
          changedFields: [],
        },
      })) as unknown as ProjectWorkGateway.ProjectWorkGatewayShape["write"],
  }),
);

const call = <Name extends keyof typeof ProjectWorkToolkit.tools>(
  name: Name,
  params: unknown,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
) =>
  ProjectWorkToolkit.pipe(
    Effect.flatMap((toolkit) =>
      toolkit.handle(name, params as never).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((chunk) => chunk.at(-1)?.result),
      ),
    ),
    Effect.provide(ProjectWorkToolkitHandlersLive.pipe(Layer.provide(gateway))),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
  );

it.effect("routes project-work reads through the shared gateway", () =>
  Effect.gen(function* () {
    const result = yield* call(
      "project_work_read",
      {
        projectId: ProjectId.make("project-1"),
        operation: "snapshot",
      },
      ["project"],
    );
    expect(result).toMatchObject({
      projectId: "project-1",
      operation: "snapshot",
    });
  }),
);

it.effect("rejects project-work reads without the scoped capability", () =>
  Effect.gen(function* () {
    const result = yield* call(
      "project_work_read",
      {
        projectId: ProjectId.make("project-1"),
        operation: "snapshot",
      },
      [],
    ).pipe(
      Effect.as("accepted" as const),
      Effect.catch(() => Effect.succeed("rejected" as const)),
    );
    expect(result).toBe("rejected");
  }),
);

it.effect("routes project-work writes through the shared gateway", () =>
  Effect.gen(function* () {
    const result = yield* call(
      "project_work_write",
      {
        type: "project-work.task.create",
        commandId: CommandId.make("mcp-project-work-create"),
        projectId: ProjectId.make("project-1"),
        taskId: ProjectWorkTaskId.make("task-1"),
        title: "MCP task",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      ["project"],
    );
    expect(result).toMatchObject({
      receipt: { status: "accepted" },
      delta: { projectId: "project-1", revision: 1 },
    });
  }),
);
