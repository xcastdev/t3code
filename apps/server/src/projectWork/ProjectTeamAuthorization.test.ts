import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/unstable/http";
import {
  CommandId,
  ProjectWorkAttemptId,
  ProjectWorkCriterionId,
  ProjectId,
  ProjectWorkTaskId,
  EnvironmentId,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Environment from "../environment/ServerEnvironment.ts";

import { ProjectWorkQuery } from "./ProjectWorkQuery.ts";
import {
  seed,
  scoped,
  decodeRecord,
  projectId,
  taskId,
  threadId,
  providerInstanceId,
} from "./ProjectTeamAuthorization.testFixtures.ts";

it.effect(
  "checks actual durable authority beyond public page bounds and rejects frozen-role operational grants",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* seed();
        expect(yield* f.auth.resolve(f.principal)).toBeDefined();
        expect((yield* f.auth.capability(f.principal, "terminal").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* f.auth.capability(f.principal, "pull-requests").pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* f.auth.read(f.principal, { projectId, taskId, operation: "task-context" });
        for (const input of [
          { projectId: ProjectId.make("other"), taskId, operation: "task" as const },
          { projectId, taskId: ProjectWorkTaskId.make("other-task"), operation: "task" as const },
          { projectId, operation: "foundation-records" as const },
        ])
          expect((yield* f.auth.read(f.principal, input).pipe(Effect.result))._tag).toBe("Failure");
        const newer = decodeRecord({ ...f.role, recordId: "new-role", roleRevision: 2 });
        yield* f.change(newer);
        yield* f.change(decodeRecord({ ...f.member, revision: 1, roleRevisionId: "new-role" }));
        expect(yield* f.auth.resolve(f.principal)).toMatchObject({
          role: { recordId: "role", roleRevision: 1 },
        });
        yield* f.change(
          decodeRecord({ ...f.member, revision: 2, roleRevisionId: "new-role", status: "paused" }),
        );
        expect((yield* f.auth.resolve(f.principal).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
);

for (const status of [
  "retired",
  "revoked",
  "stopping",
  "settled",
  "quarantined",
  "expired",
  "deleted",
  "generation",
] as const)
  it.effect(`rejects managed credential after ${status}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* seed("implementer");
        if (status === "retired")
          yield* f.change(decodeRecord({ ...f.role, revision: 1, status: "retired" }));
        else if (status === "expired")
          yield* TestClock.setTime(Date.parse("2031-01-01T00:00:00.000Z"));
        else if (status === "deleted") {
          yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
          yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${projectId}`;
          yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        } else if (status === "generation")
          expect(
            (yield* f.auth
              .resolve({ ...f.principal, managed: { ...f.principal.managed, generation: 1 } })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        else yield* f.change(decodeRecord({ ...f.binding, revision: 1, status }));
        if (status !== "generation")
          expect((yield* f.auth.resolve(f.principal).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
  );

it.effect(
  "mints reserved credentials without tool authority, preserves native identity and does not upgrade legacy tokens",
  () =>
    scoped(
      Effect.gen(function* () {
        const auth = yield* Authorization.ProjectTeamAuthorization;
        const makeRegistry = Registry.__testing.make({ now: () => 1000 }).pipe(
          Effect.provideService(
            HttpServer.HttpServer,
            HttpServer.HttpServer.of({
              address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
              serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
            }),
          ),
          Effect.provideService(
            Environment.ServerEnvironment,
            Environment.ServerEnvironment.of({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
              getDescriptor: Effect.die("unused"),
            }),
          ),
        );
        const registry = yield* makeRegistry;
        // Tables exist before managed history discovery; no managed run is present.
        yield* runMigrations();
        const legacy = yield* registry.issue({
          providerInstanceId,
          threadId,
          capabilities: new Set(["terminal", "pull-requests"]),
        });
        const legacyToken = legacy.config.authorizationHeader.replace("Bearer ", "");
        const untouchedLegacy = yield* registry.issue({ providerInstanceId, threadId });
        const untouchedToken = untouchedLegacy.config.authorizationHeader.replace("Bearer ", "");
        const heldLegacyScope = yield* registry.resolve(legacyToken);
        expect(heldLegacyScope).toBeDefined();
        const f = yield* seed("implementer", "reserved");
        expect(yield* registry.resolve(legacyToken)).toBeUndefined();
        const issued = yield* registry.issue({
          providerInstanceId,
          threadId,
          capabilities: new Set(["terminal", "pull-requests"]),
        });
        const token = issued.config.authorizationHeader.replace("Bearer ", "");
        expect(issued.config.providerSessionId).not.toBe("native-pi-session");
        expect(yield* registry.resolve(token)).toBeUndefined();
        yield* f.change(decodeRecord({ ...f.binding, revision: 1, status: "running" }));
        const scope = yield* registry.resolve(token);
        expect(scope?.managed).toEqual(f.principal.managed);
        expect(yield* registry.resolve(untouchedToken)).toBeUndefined();
        expect(
          (yield* Invocation.requireMcpCapability("terminal").pipe(
            Effect.provideService(Invocation.McpInvocationContext, heldLegacyScope!),
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(yield* auth.resolve(f.principal)).toBeDefined();
        yield* f.change(decodeRecord({ ...f.binding, revision: 2, status: "revoked" }));
        yield* registry.touch(threadId);
        expect(yield* registry.resolve(token)).toBeUndefined();
        yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${projectId}`;
        yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        const restartedRegistry = yield* makeRegistry;
        expect(yield* restartedRegistry.resolve(token)).toBeUndefined();
        expect(yield* registry.resolve(untouchedToken)).toBeUndefined();
        expect(
          (yield* Invocation.requireMcpCapability("terminal").pipe(
            Effect.provideService(Invocation.McpInvocationContext, heldLegacyScope!),
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* registry.issue({ providerInstanceId, threadId }).pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect("permits bounded coordinator discovery while rejecting memory/config collections", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* seed("coordinator");
      yield* f.auth.read(f.principal, { projectId, operation: "tasks", limit: 10 });
      yield* f.auth.read(f.principal, {
        projectId,
        operation: "foundation-records",
        recordKinds: ["member", "message"],
        limit: 10,
      });
      for (const kinds of [["memory-source"], ["role-revision"], ["effect"]])
        expect(
          (yield* f.auth
            .read(f.principal, {
              projectId,
              operation: "foundation-records",
              recordKinds: kinds,
              limit: 10,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
    }),
  ),
);

it.effect("uses complete indexed binding authority beyond the 128-record public page", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* seed();
      for (let i = 0; i < 130; i++)
        yield* f.change(
          decodeRecord({
            ...f.binding,
            recordId: "aaa-binding-" + i.toString().padStart(3, "0"),
            status: "settled",
          }),
        );
      const query = yield* ProjectWorkQuery;
      const page = yield* query.listFoundationRecords({
        projectId,
        kinds: ["run-binding"],
        limit: 128,
      });
      expect(page.items).toHaveLength(128);
      expect(page.items.some((record) => record.recordId === "binding")).toBe(false);
      expect(yield* f.auth.resolve(f.principal)).toMatchObject({
        binding: { recordId: "binding" },
      });
      const plan =
        yield* f.sql`EXPLAIN QUERY PLAN SELECT project_id FROM project_team_run_binding WHERE provider_instance_id=${providerInstanceId} AND thread_id=${threadId}`;
      expect(plan.some((row) => String(row.detail).includes("project_team_binding_session"))).toBe(
        true,
      );
    }),
  ),
);

it.effect(
  "reserved issuance may omit native session but running invocation fails closed without it",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* seed("implementer", "reserved", { nativeSessionId: null });
        expect(
          (yield* f.auth.issueCredential({ providerInstanceId, threadId }))?.credential,
        ).toEqual(f.principal.managed);
        yield* f.change(decodeRecord({ ...f.binding, revision: 1, status: "running" }));
        expect((yield* f.auth.resolve(f.principal).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
);
it.effect("denies ambiguous reserved issuance and never refreshes a supplied stale marker", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* seed("implementer", "reserved");
      const otherTask = ProjectWorkTaskId.make("other-task");
      const otherAttempt = ProjectWorkAttemptId.make("other-attempt");
      const criterion = ProjectWorkCriterionId.make("other-criterion");
      const at = "2026-01-01T00:00:00.000Z";
      yield* f.repo.execute({
        type: "project-work.task.create",
        projectId,
        taskId: otherTask,
        commandId: CommandId.make("other-create"),
        title: "Other task",
        createdAt: at,
      });
      yield* f.repo.execute({
        type: "project-work.criterion.upsert",
        projectId,
        taskId: otherTask,
        commandId: CommandId.make("other-criterion"),
        criterion: {
          criterionId: criterion,
          taskId: otherTask,
          description: "Other scope",
          required: false,
          status: "unsatisfied",
          satisfiedByEvidenceIds: [],
          revision: 0,
          updatedAt: at,
        },
        updatedAt: at,
      });
      yield* f.repo.execute({
        type: "project-work.task.specify",
        projectId,
        taskId: otherTask,
        commandId: CommandId.make("other-spec"),
        specification: {
          objective: "Other scope",
          scopeIn: "Other",
          scopeOut: "Assigned task",
          criterionIds: [criterion],
          revision: 1,
          protected: false,
        },
        updatedAt: at,
      });
      yield* f.repo.execute({
        type: "project-work.task.ready",
        projectId,
        taskId: otherTask,
        commandId: CommandId.make("other-ready"),
        updatedAt: at,
      });
      yield* f.repo.execute({
        type: "project-work.task.claim",
        projectId,
        taskId: otherTask,
        commandId: CommandId.make("other-claim"),
        attemptId: otherAttempt,
        leaseToken: "other-lease",
        leasedUntil: "2030-01-01T00:00:00.000Z",
        claimedAt: at,
      });
      yield* f.change(
        decodeRecord({
          ...f.binding,
          recordId: "other-binding",
          taskId: otherTask,
          attemptId: otherAttempt,
        }),
      );
      expect(
        (yield* f.auth.issueCredential({ providerInstanceId, threadId }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.auth.issueCredential({ providerInstanceId, threadId, bindingId: "binding" }))
          ?.credential,
      ).toEqual(f.principal.managed);
      expect(
        (yield* f.auth
          .resolve({
            ...f.principal,
            managed: { ...f.principal.managed, bindingId: "other-binding", generation: 1 },
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);
