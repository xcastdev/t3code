import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkTaskContext,
} from "@t3tools/contracts";
import { combineProjectWorkFoundationPages } from "@t3tools/client-runtime/project-work";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createMobileWorkRequest, reviewMobileWork } from "./workActions";

// Node-only fixtures load at runtime to avoid compiling the server with Expo's mobile globals.
const serverRoot = "../../../../server/src/";
const { runMigrations } = await import(serverRoot + "persistence/Migrations.ts");
const { ProjectWorkGateway } = await import(serverRoot + "projectWork/ProjectWorkGateway.ts");
const { readCurrentState } = await import(serverRoot + "projectWork/ProjectWorkRepository.ts");
const { ProjectWorkProjectionLive } = await import(
  serverRoot + "projectWork/ProjectWorkProjection.ts"
);
const { gatewayRuntime } = await import(
  serverRoot + "projectWork/ProjectTeamAuthorization.testFixtures.ts"
);

const environmentId = EnvironmentId.make("mobile-request-environment");
const projectId = ProjectId.make("mobile-request-project");
const taskId = ProjectWorkTaskId.make("mobile-request-task");
const at = "2026-10-19T00:00:00.000Z";
const decodeContext = Schema.decodeUnknownSync(ProjectWorkTaskContext);
const gatewayLayer = ProjectWorkProjectionLive.pipe(Layer.provideMerge(gatewayRuntime));

it.effect(
  "creates guided mobile code work and accepts investigation through the real gateway",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const gateway = yield* ProjectWorkGateway;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${projectId},'Mobile request','/fixture/mobile-request','[]',${at},${at})`;
      const actor = { kind: "human", id: "mobile-supervisor" };
      const source = { kind: "web", id: "mobile-client" };
      const create = createMobileWorkRequest({
        commandId: CommandId.make("mobile-create"),
        projectId,
        taskId,
        expectedRevision: 0,
        title: "Investigate reconnect",
        createdAt: at,
      });
      expect((yield* gateway.write(create, actor, source)).receipt.status).toBe("accepted");
      const state = yield* readCurrentState(sql, projectId);
      expect(state.foundationRecords).toContainEqual(
        expect.objectContaining({
          kind: "task-membership",
          taskId,
          executionKind: "managed",
          deliverableKind: "code",
          controlState: "active",
        }),
      );
      const context = decodeContext(
        yield* gateway.read({ projectId, taskId, operation: "task-context" }),
      );
      const foundation = combineProjectWorkFoundationPages({
        projectId,
        pages: [{ value: { projectId, revision: state.revision, items: state.foundationRecords } }],
      });
      const review = reviewMobileWork({
        environmentId,
        projectId,
        taskId,
        connected: true,
        enabled: true,
        foundationSupported: true,
        guidedSupported: true,
        fresh: true,
        context,
        foundation,
      });
      expect(review.reason).toBeNull();
      expect(review.canInvestigate).toBe(true);
      expect(
        (yield* gateway.write(
          {
            type: "project-team.investigation.start",
            commandId: CommandId.make("mobile-investigate"),
            projectId,
            taskId,
            expectedRevision: context.revision,
            expectedTaskRevision: context.task.revision,
            objective: "Find the reconnect failure",
            outputDescriptions: ["Sourced findings"],
          },
          actor,
          source,
        )).receipt.status,
      ).toBe("accepted");
      const investigated = yield* readCurrentState(sql, projectId);
      expect(investigated.foundationRecords).toContainEqual(
        expect.objectContaining({
          kind: "task-membership",
          parentTaskId: taskId,
          deliverableKind: "research",
          assignment: expect.objectContaining({ authorizationGateId: expect.any(String) }),
        }),
      );
    }).pipe(Effect.provide(gatewayLayer)),
);
