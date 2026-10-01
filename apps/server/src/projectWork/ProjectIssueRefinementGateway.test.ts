import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkIssueRefineCommand,
  ProjectTeamCredential,
  ProjectWorkWriteIntent,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { decodeRecord, gatewayRuntime } from "./ProjectTeamAuthorization.testFixtures.ts";

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("issue-refinement-project");
const taskId = ProjectWorkTaskId.make("issue-refinement-task");
const human = { kind: "human", id: "authenticated-human" } as const;
const source = { kind: "web", id: "authenticated-browser" } as const;
const decodeRefine = Schema.decodeUnknownSync(ProjectWorkIssueRefineCommand);
const decodeCredential = Schema.decodeUnknownSync(ProjectTeamCredential);
const decodeRpc = Schema.decodeUnknownEffect(
  WsRpcGroup.requests.get("projectWork.write")!.payloadSchema,
);
const decodeWrite = Schema.decodeUnknownEffect(ProjectWorkWriteIntent);
const command = decodeRefine({
  type: "project-work.issue.refine",
  commandId: "refine-one-issue",
  projectId,
  expectedRevision: 1,
  issueRecordId: "intake-original",
  expectedIssueRevision: 0,
  target: { kind: "new-task", taskId, title: "Investigate the issue", deliverableKind: "code" },
  refinedAt: at,
});
const setup = Effect.fn("issueRefinementTest.setup")(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Refinement','/workspace','[]',${at},${at})`;
  const repository = yield* ProjectWorkRepository;
  const issue = decodeRecord({
    kind: "issue",
    recordId: "intake-original",
    projectId,
    revision: 0,
    generation: 3,
    updatedAt: at,
    status: "open",
    identity: {
      host: "github.com",
      repositoryNodeId: "repository-node",
      issueNodeId: "issue-node",
      number: 7,
    },
    repositoryName: "owner/repository",
    title: "Original issue",
    body: "Retained source body",
    sourceRevision: "2026-01-01T00:00:00Z",
    observedAt: at,
  });
  yield* repository.execute({
    type: "project-work.foundation.commit",
    commandId: CommandId.make("seed-intake"),
    projectId,
    expectedRevision: 0,
    attribution: {
      actor: { kind: "system", id: "intake" },
      source: { kind: "import", id: "intake" },
      recordedAt: at,
    },
    records: [issue],
    committedAt: at,
  });
  return { sql, repository, gateway: yield* ProjectWorkGateway, issue };
});
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(gatewayRuntime)));

it.effect("refines through the RPC schema once and retains the original intake identity", () =>
  scoped(
    Effect.gen(function* () {
      const { sql, gateway, issue } = yield* setup();
      const decoded = yield* decodeWrite(yield* decodeRpc(command));
      const first = yield* gateway.write(decoded, human, source, { actor: human });
      expect(yield* gateway.write(decoded, human, source, { actor: human })).toEqual(first);
      const state = yield* readCurrentState(sql, projectId);
      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0]).toMatchObject({
        taskId,
        state: "draft",
        specRevision: 0,
        attribution: { actor: human, source },
      });
      expect(state.foundationRecords?.find((r) => r.kind === "issue")).toEqual({
        ...issue,
        revision: 1,
        updatedAt: at,
        taskId,
      });
      expect(state.foundationRecords?.filter((r) => r.kind === "task-membership")).toHaveLength(1);
      expect(
        state.foundationRecords?.some(
          (r) => r.kind === "gate" || r.kind === "effect" || r.kind === "run-binding",
        ),
      ).toBe(false);
      expect(state.attempts).toHaveLength(0);
      expect(
        yield* sql`SELECT command_id FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${command.commandId}`,
      ).toHaveLength(1);
      expect(
        yield* sql`SELECT event_id FROM project_work_events WHERE project_id=${projectId} AND command_id=${command.commandId}`,
      ).toHaveLength(3);
    }),
  ),
);

it.effect("denies every non-human actor and forged human attribution before receipts", () =>
  scoped(
    Effect.gen(function* () {
      const { sql, gateway } = yield* setup();
      for (const actor of [
        { kind: "agent", id: "agent" },
        { kind: "adapter", id: "adapter" },
        { kind: "system", id: "system" },
      ] as const) {
        const result = yield* gateway.write(command, actor, source, { actor }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({ reason: "agent-approval-required" });
      }
      expect(
        (yield* gateway
          .write(
            {
              ...command,
              attribution: { actor: { ...human, id: "invented-human" }, source, recordedAt: at },
            },
            human,
            source,
            { actor: human },
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* gateway
          .write(command, human, source, {
            actor: human,
            managed: decodeCredential({
              projectId,
              bindingId: "invented-binding",
              generation: 0,
              providerInstanceId: "pi",
              threadId: "invented-thread",
            }),
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* readCurrentState(sql, projectId)).tasks).toHaveLength(0);
      expect(
        yield* sql`SELECT command_id FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${command.commandId}`,
      ).toHaveLength(0);
    }),
  ),
);

it.effect("rolls back the task, membership, issue link and events on a final receipt failure", () =>
  scoped(
    Effect.gen(function* () {
      const { sql, gateway, issue } = yield* setup();
      yield* sql`CREATE TRIGGER reject_issue_refinement BEFORE INSERT ON project_work_command_receipts
      WHEN NEW.command_id='refine-one-issue' BEGIN SELECT RAISE(ABORT,'refinement receipt'); END`;
      expect(
        (yield* gateway.write(command, human, source, { actor: human }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      const rolledBack = yield* readCurrentState(sql, projectId);
      expect(rolledBack.revision).toBe(1);
      expect(rolledBack.tasks).toHaveLength(0);
      expect(rolledBack.foundationRecords).toEqual([issue]);
      expect(
        yield* sql`SELECT event_id FROM project_work_events WHERE project_id=${projectId} AND command_id=${command.commandId}`,
      ).toHaveLength(0);
      yield* sql`DROP TRIGGER reject_issue_refinement`;
      yield* gateway.write(command, human, source, { actor: human });
      expect((yield* readCurrentState(sql, projectId)).tasks).toHaveLength(1);
    }),
  ),
);

it.effect("links an existing task with its exact revision without changing its specification", () =>
  scoped(
    Effect.gen(function* () {
      const { sql, gateway, repository, issue } = yield* setup();
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("existing-task"),
        projectId,
        taskId,
        title: "Existing task",
        createdAt: at,
      });
      const before = yield* readCurrentState(sql, projectId);
      const linking = decodeRefine({
        ...command,
        expectedRevision: before.revision,
        target: { kind: "existing-task", taskId, expectedTaskRevision: 0 },
      });
      expect(
        (yield* gateway
          .write(
            { ...linking, target: { kind: "existing-task", taskId, expectedTaskRevision: 1 } },
            human,
            source,
            { actor: human },
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* gateway.write(linking, human, source, { actor: human });
      const after = yield* readCurrentState(sql, projectId);
      expect(after.tasks).toEqual(before.tasks);
      expect(after.foundationRecords).toEqual([{ ...issue, revision: 1, taskId }]);
      expect(after.attempts).toEqual(before.attempts);
    }),
  ),
);

it.effect("creates a mission without a task or grant and replays one immutable receipt", () =>
  scoped(
    Effect.gen(function* () {
      const { sql, gateway, issue } = yield* setup();
      const missionCommand = decodeRefine({
        ...command,
        target: {
          kind: "mission",
          title: "Larger work",
          objective: "Deliver several related outcomes",
        },
      });
      const first = yield* gateway.write(missionCommand, human, source, { actor: human });
      expect(yield* gateway.write(missionCommand, human, source, { actor: human })).toEqual(first);
      const state = yield* readCurrentState(sql, projectId);
      const mission = state.foundationRecords?.find((r) => r.kind === "mission");
      expect(mission).toMatchObject({
        status: "draft",
        title: "Larger work",
        objective: "Deliver several related outcomes",
        requiredTaskIds: [],
      });
      expect(state.foundationRecords?.find((r) => r.kind === "issue")).toEqual({
        ...issue,
        revision: 1,
        missionId: mission?.recordId,
      });
      expect(state.tasks).toHaveLength(0);
      expect(state.attempts).toHaveLength(0);
      expect(state.foundationRecords).toHaveLength(2);
    }),
  ),
);

it.effect("rejects competing refinements and duplicate command payload changes", () =>
  scoped(
    Effect.gen(function* () {
      const { sql, gateway } = yield* setup();
      yield* gateway.write(command, human, source, { actor: human });
      for (const candidate of [
        { ...command, commandId: CommandId.make("competing-device") },
        {
          ...command,
          target: {
            kind: "mission" as const,
            title: "Different work",
            objective: "Different target",
          },
        },
      ])
        expect(
          (yield* gateway.write(candidate, human, source, { actor: human }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      expect((yield* readCurrentState(sql, projectId)).tasks).toHaveLength(1);
      expect(
        yield* sql`SELECT command_id FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id='competing-device'`,
      ).toHaveLength(0);
    }),
  ),
);

it.effect("rechecks archive and deletion fences even for an already committed receipt", () =>
  scoped(
    Effect.gen(function* () {
      const { sql, gateway } = yield* setup();
      const first = yield* gateway.write(command, human, source, { actor: human });
      yield* sql`INSERT INTO project_lifecycle (project_id,state,workspace_root,revision,changed_at)
      VALUES (${projectId},'archived','/workspace',1,${at})`;
      expect(
        (yield* gateway.write(command, human, source, { actor: human }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* sql`UPDATE project_lifecycle SET state='active',revision=2 WHERE project_id=${projectId}`;
      expect(yield* gateway.write(command, human, source, { actor: human })).toEqual(first);
      yield* sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id=${projectId}`;
      expect(
        (yield* gateway.write(command, human, source, { actor: human }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* readCurrentState(sql, projectId)).tasks).toHaveLength(1);
    }),
  ),
);

it.effect("rejects secret content without partially creating a task or linking an issue", () =>
  scoped(
    Effect.gen(function* () {
      const { sql, gateway } = yield* setup();
      const unsafe = decodeRefine({
        ...command,
        target: {
          kind: "new-task",
          taskId,
          title: "Investigate",
          summary: "api_key=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
          deliverableKind: "code",
        },
      });
      expect(
        (yield* gateway.write(unsafe, human, source, { actor: human }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      const state = yield* readCurrentState(sql, projectId);
      expect(state.tasks).toHaveLength(0);
      expect(state.foundationRecords?.find((r) => r.kind === "issue")).not.toHaveProperty("taskId");
    }),
  ),
);
