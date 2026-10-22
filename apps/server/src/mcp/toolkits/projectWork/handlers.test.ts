import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
  type AuthMcpClientAccess,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Gateway from "../../../projectWork/ProjectWorkGateway.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import * as Testkit from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { ProjectWorkToolkit } from "./tools.ts";

const scope = (access?: AuthMcpClientAccess): Invocation.McpInvocationScope => ({
  environmentId: EnvironmentId.make("test-environment"),
  requestNamespace: "test-session",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread:
    access === undefined
      ? {
          threadId: ThreadId.make("caller-thread"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: "actual-provider-session",
        }
      : undefined,
  client:
    access === undefined
      ? undefined
      : { sessionId: "actual-client-session", label: "test", access },
});

it.effect("binds a thread tool read to its actual environment, project and session", () =>
  Effect.gen(function* () {
    const principals: Array<Gateway.ProjectWorkPrincipal | undefined> = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(Gateway.ProjectWorkGateway)({
        read: (_input, principal) => {
          principals.push(principal);
          return Effect.succeed([]);
        },
      }),
      Testkit.liveThreadsLayer,
      Layer.succeed(Invocation.McpInvocationContext, scope()),
    );
    const toolkit = yield* ProjectWorkToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    yield* toolkit
      .handle("t3_project_work_read", {
        projectId: ProjectId.make("project:mcp-test"),
        operation: "tasks",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.deepStrictEqual(principals, [
      {
        environmentId: EnvironmentId.make("test-environment"),
        projectId: ProjectId.make("project:mcp-test"),
        actor: { kind: "agent", id: "caller-thread" },
        source: { kind: "mcp", id: "actual-provider-session" },
      },
    ]);
  }),
);

import * as Stream from "effect/Stream";

it.effect("denies a read-only MCP client before a Work mutation reaches the gateway", () =>
  Effect.gen(function* () {
    let writes = 0;
    const dependencies = Layer.mergeAll(
      Layer.mock(Gateway.ProjectWorkGateway)({
        write: () => {
          writes++;
          return Effect.die("must not write");
        },
      }),
      Testkit.liveThreadsLayer,
      Layer.succeed(Invocation.McpInvocationContext, scope("read-only")),
    );
    const toolkit = yield* ProjectWorkToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const result = yield* toolkit
      .handle("t3_project_work_write", {
        intent: {
          type: "project-work.task.create",
          commandId: CommandId.make("write"),
          projectId: ProjectId.make("project:mcp-test"),
          taskId: ProjectWorkTaskId.make("task"),
          title: "Denied",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.strictEqual(writes, 0);
    assert.strictEqual(result[0]?.isFailure, true);
  }),
);

it.effect("an outside MCP writer stays an agent from its authenticated session", () =>
  Effect.gen(function* () {
    const principals: Array<Gateway.ProjectWorkPrincipal> = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(Gateway.ProjectWorkGateway)({
        write: (input, principal) => {
          principals.push(principal);
          return Effect.succeed({
            projectId: input.projectId,
            revision: 1,
            receipt: {
              commandId: input.commandId,
              projectId: input.projectId,
              revision: 1,
              status: "accepted" as const,
              eventCount: 1,
            },
            delta: { projectId: input.projectId, revision: 1, eventIds: [], changedFields: [] },
          });
        },
      }),
      Testkit.liveThreadsLayer,
      Layer.succeed(Invocation.McpInvocationContext, scope("full-access")),
    );
    const toolkit = yield* ProjectWorkToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    yield* toolkit
      .handle("t3_project_work_write", {
        intent: {
          type: "project-work.task.create",
          commandId: CommandId.make("write"),
          projectId: ProjectId.make("project:mcp-test"),
          taskId: ProjectWorkTaskId.make("task"),
          title: "Plan",
          createdAt: "2026-01-01T00:00:00.000Z",
          attribution: {
            actor: { kind: "human", id: "forged" },
            source: { kind: "web" },
            recordedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.deepStrictEqual(principals[0]?.actor, { kind: "agent", id: "actual-client-session" });
    assert.deepStrictEqual(principals[0]?.source, { kind: "mcp", id: "actual-client-session" });
  }),
);
