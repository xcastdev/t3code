import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
  ProjectWorkWriteIntent,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

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

import {
  gatewayRuntime,
  seed as seedTeam,
  decodeRecord,
  at,
} from "../../../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import {
  ProjectWorkRepository,
  readCurrentState,
} from "../../../projectWork/ProjectWorkRepository.ts";
import {
  ProjectWorkProjection,
  ProjectWorkProjectionLive,
} from "../../../projectWork/ProjectWorkProjection.ts";
const decodeReplayIntent = Schema.decodeUnknownEffect(ProjectWorkWriteIntent);
it.effect(
  "retains managed MCP replay owner fences across recreated toolkits and projection rebuild",
  () =>
    Effect.gen(function* () {
      const f = yield* seedTeam("implementer");
      const service = yield* ProjectWorkGateway.ProjectWorkGateway;
      const projection = yield* ProjectWorkProjection.pipe(
        Effect.provide(ProjectWorkProjectionLive),
      );
      const repository = yield* ProjectWorkRepository;
      const otherProject = ProjectId.make("mcp-rebuild-other");
      const otherTask = ProjectWorkTaskId.make("mcp-rebuild-other-task");
      yield* f.sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES(${otherProject},'Other project','/workspace/other','[]',${at},${at})`;
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("other-create"),
        projectId: otherProject,
        taskId: otherTask,
        title: "Other task",
        createdAt: at,
      });
      const otherHistory = yield* repository.replay(otherProject);
      const scope = {
        environmentId: EnvironmentId.make("environment"),
        providerInstanceId: f.principal.managed.providerInstanceId,
        threadId: f.principal.managed.threadId,
        providerSessionId: "issued",
        managed: f.principal.managed,
        capabilities: new Set(["project" as const]),
        issuedAt: 0,
      };
      const toolkitEffect = ProjectWorkToolkit.pipe(
        Effect.provide(
          Layer.fresh(ProjectWorkToolkitHandlersLive).pipe(
            Layer.provide(Layer.succeed(ProjectWorkGateway.ProjectWorkGateway, service)),
          ),
        ),
      );
      const originalToolkit = yield* toolkitEffect;
      const input = yield* decodeReplayIntent({
        type: "project-work.comment.add",
        commandId: "mcp-rebuild-comment",
        projectId: f.binding.projectId,
        comment: {
          commentId: "mcp-rebuild-finding",
          projectId: f.binding.projectId,
          taskId: f.binding.taskId,
          body: "Preserve the authenticated finding",
          revision: 0,
          createdAt: at,
        },
        addedAt: at,
      });
      const invoke = (toolkit: typeof originalToolkit, intent: typeof input) =>
        toolkit
          .handle("project_work_write", intent)
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          );
      const before = yield* readCurrentState(f.sql, f.binding.projectId);
      const first = (yield* invoke(originalToolkit, input)).at(-1)?.result;
      expect(first).toMatchObject({ receipt: { status: "accepted", commandId: input.commandId } });
      const accepted = yield* readCurrentState(f.sql, f.binding.projectId);
      const history = yield* repository.replay(f.binding.projectId);
      const receipts =
        yield* f.sql`SELECT * FROM project_work_command_receipts ORDER BY project_id,command_id`;
      const recreated = yield* toolkitEffect;
      expect(recreated).not.toBe(originalToolkit);
      yield* f.sql`DELETE FROM project_work_comments WHERE project_id=${f.binding.projectId}`;
      yield* projection.rebuild(f.binding.projectId);
      expect(yield* readCurrentState(f.sql, f.binding.projectId)).toEqual(accepted);
      expect((yield* invoke(recreated, input)).at(-1)?.result).toEqual(first);
      const read = yield* recreated
        .handle("project_work_read", {
          projectId: f.binding.projectId,
          taskId: f.binding.taskId,
          operation: "task-context",
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        );
      expect(read.at(-1)?.result).toMatchObject({ task: { taskId: f.binding.taskId } });
      for (const rejected of [
        {
          ...input,
          comment: {
            commentId: "mcp-rebuild-finding",
            projectId: f.binding.projectId,
            taskId: f.binding.taskId,
            body: "Changed request",
            revision: 0,
            createdAt: at,
          },
        },
        {
          type: "project-work.comment.add",
          commandId: "mcp-rebuild-stale",
          projectId: f.binding.projectId,
          expectedRevision: before.revision,
          comment: {
            commentId: "mcp-rebuild-stale",
            projectId: f.binding.projectId,
            taskId: f.binding.taskId,
            body: "Stale selection",
            revision: 0,
            createdAt: at,
          },
          addedAt: at,
        },
        {
          type: "project-work.comment.add",
          commandId: "mcp-rebuild-foreign",
          projectId: otherProject,
          comment: {
            commentId: "mcp-rebuild-foreign",
            projectId: otherProject,
            taskId: otherTask,
            body: "Foreign task",
            revision: 0,
            createdAt: at,
          },
          addedAt: at,
        },
      ]) {
        expect(
          (yield* invoke(recreated, yield* decodeReplayIntent(rejected)).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
      expect(yield* repository.replay(f.binding.projectId)).toEqual(history);
      expect(yield* repository.replay(otherProject)).toEqual(otherHistory);
      expect(
        yield* f.sql`SELECT * FROM project_work_command_receipts ORDER BY project_id,command_id`,
      ).toEqual(receipts);
      yield* f.change(
        decodeRecord({ ...f.binding, revision: f.binding.revision + 1, status: "revoked" }),
      );
      const revokedHistory = yield* repository.replay(f.binding.projectId);
      expect((yield* invoke(recreated, input).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* repository.replay(f.binding.projectId)).toEqual(revokedHistory);
      expect(yield* repository.replay(otherProject)).toEqual(otherHistory);
      expect(
        yield* f.sql`SELECT * FROM project_work_command_receipts WHERE project_id=${f.binding.projectId} AND command_id=${input.commandId}`,
      ).toHaveLength(1);
      expect(yield* f.sql`SELECT 1 FROM project_team_pi_operation`).toEqual([]);
      expect(yield* f.sql`SELECT 1 FROM project_team_memory_job`).toEqual([]);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);
it.effect("persists a human question through the actual managed MCP write toolkit", () =>
  Effect.gen(function* () {
    const f = yield* seedTeam("investigator");
    const service = yield* ProjectWorkGateway.ProjectWorkGateway;
    const toolkit = yield* ProjectWorkToolkit.pipe(
      Effect.provide(
        ProjectWorkToolkitHandlersLive.pipe(
          Layer.provide(Layer.succeed(ProjectWorkGateway.ProjectWorkGateway, service)),
        ),
      ),
    );
    const state = yield* readCurrentState(f.sql, f.binding.projectId);
    const task = state.tasks.find((entry) => entry.taskId === f.binding.taskId)!;
    const gate = state.foundationRecords?.find(
      (entry) => entry.kind === "gate" && entry.recordId === f.binding.planGateId,
    );
    if (gate?.kind !== "gate") return yield* Effect.die("Missing original MCP gate");
    const request = {
      type: "project-team.question.request" as const,
      commandId: CommandId.make("mcp-human-question"),
      projectId: f.binding.projectId,
      taskId: f.binding.taskId,
      expectedRevision: state.revision,
      expectedTaskRevision: task.revision,
      specRevision: task.specRevision,
      planRevision: f.binding.planRevision,
      questionId: "mcp-question",
      targetGateId: gate.recordId,
      expectedGateRevision: gate.revision,
      body: "Which original result should remain visible?",
      choices: ["Keep original result"],
    };
    const scope = {
      environmentId: EnvironmentId.make("environment"),
      providerInstanceId: f.principal.managed.providerInstanceId,
      threadId: f.principal.managed.threadId,
      providerSessionId: "issued",
      managed: f.principal.managed,
      capabilities: new Set(["project" as const]),
      issuedAt: 0,
    };
    yield* toolkit
      .handle("project_work_write", request)
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      );
    const after = yield* readCurrentState(f.sql, f.binding.projectId);
    expect(
      after.foundationRecords?.find((entry) => entry.recordId === request.questionId),
    ).toMatchObject({
      kind: "question",
      status: "pending",
      senderId: f.binding.memberId,
      body: request.body,
    });
    expect(after.foundationRecords?.find((entry) => entry.recordId === gate.recordId)).toEqual(
      gate,
    );
  }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect(
  "uses actual gateway task authority for managed toolkit reads, nested writes and revoked duplicate receipts",
  () =>
    Effect.gen(function* () {
      const f = yield* seedTeam("implementer");
      const service = yield* ProjectWorkGateway.ProjectWorkGateway;
      const toolkit = yield* ProjectWorkToolkit.pipe(
        Effect.provide(
          ProjectWorkToolkitHandlersLive.pipe(
            Layer.provide(Layer.succeed(ProjectWorkGateway.ProjectWorkGateway, service)),
          ),
        ),
      );
      const scope = {
        environmentId: EnvironmentId.make("environment"),
        providerInstanceId: f.principal.managed.providerInstanceId,
        threadId: f.principal.managed.threadId,
        providerSessionId: "issued",
        managed: f.principal.managed,
        capabilities: new Set(["project" as const]),
        issuedAt: 0,
      };
      const invoke = <Name extends keyof typeof ProjectWorkToolkit.tools>(
        name: Name,
        input: Parameters<typeof toolkit.handle<Name>>[1],
      ) =>
        toolkit
          .handle(name, input)
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(ProjectWorkGateway.ProjectWorkGateway, service),
          );
      const projectId = f.principal.managed.projectId;
      const taskId = (yield* f.auth.resolve(f.principal))!.binding.taskId;
      const context = yield* invoke("project_work_read", {
        projectId,
        taskId,
        operation: "task-context",
      });
      expect(context.at(-1)?.result).toMatchObject({ task: { taskId } });
      expect(
        (yield* invoke("project_work_read", {
          projectId,
          taskId: ProjectWorkTaskId.make("other-task"),
          operation: "task-context",
        }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      const input = {
        type: "project-work.comment.add" as const,
        commandId: CommandId.make("managed-comment"),
        projectId,
        comment: {
          commentId: "comment" as never,
          projectId,
          taskId,
          body: "Assigned task finding",
          revision: 0,
          createdAt: at,
        },
        addedAt: at,
      };
      expect((yield* invoke("project_work_write", input)).at(-1)?.result).toMatchObject({
        receipt: { status: "accepted" },
      });
      expect((yield* invoke("project_work_write", input)).at(-1)?.result).toMatchObject({
        receipt: { status: "accepted" },
      });
      expect(
        (yield* invoke("project_work_write", {
          ...input,
          commandId: CommandId.make("wrong-target"),
          comment: {
            ...input.comment,
            commentId: "foreign" as never,
            taskId: ProjectWorkTaskId.make("other-task"),
          },
        }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.change(
        decodeRecord({ ...f.binding, revision: f.binding.revision + 1, status: "revoked" }),
      );
      expect((yield* invoke("project_work_write", input).pipe(Effect.result))._tag).toBe("Failure");
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);
