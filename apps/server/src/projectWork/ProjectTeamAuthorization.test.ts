import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/unstable/http";
import {
  ProjectId,
  ProjectWorkTaskId,
  EnvironmentId,
  ThreadId,
  CommandId,
  ProjectWorkEvidenceId,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Environment from "../environment/ServerEnvironment.ts";

import { ProjectWorkQuery } from "./ProjectWorkQuery.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import { projectTeamSpecificationHash, projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import {
  seed,
  createManagedAssignment,
  restoreHistoricalBinding,
  scoped,
  decodeRecord,
  projectId,
  taskId,
  threadId,
  providerInstanceId,
  gatewayRuntime,
} from "./ProjectTeamAuthorization.testFixtures.ts";

it.effect(
  "records an authenticated guided human criterion waiver and invalidates the old scope",
  () =>
    Effect.gen(function* () {
      const f = yield* seed("implementer", "running", { issueCredential: false });
      const gateway = yield* ProjectWorkGateway;
      const before = yield* readCurrentState(f.sql, projectId);
      const criterion = before.criteria[0]!;
      const task = before.tasks.find((entry) => entry.taskId === taskId)!;
      const input = {
        type: "project-team.criterion.waiver" as const,
        commandId: CommandId.make("human-guided-waiver"),
        projectId,
        taskId,
        expectedRevision: before.revision,
        expectedTaskRevision: task.revision,
        criterionId: criterion.criterionId,
        expectedCriterionRevision: criterion.revision,
        expectedSpecRevision: task.specRevision,
        expectedSpecificationHash: projectTeamSpecificationHash(before, taskId),
        action: { kind: "waive" as const, reason: "Human accepts this exception", evidenceIds: [] },
      };
      const actor = { kind: "human" as const, id: "waiver-human" };
      const source = { kind: "web" as const, id: "waiver-browser" };
      const agent = yield* gateway
        .write(input, f.principal.actor, source, f.principal)
        .pipe(Effect.result);
      expect(agent._tag).toBe("Failure");
      if (agent._tag === "Failure")
        expect(agent.failure).toMatchObject({
          _tag: "ProjectTeamAuthorizationError",
          reason: "Criterion waiver requires authenticated human authority",
        });
      const spoofed = yield* gateway
        .write(input, actor, source, { actor: { kind: "human", id: "another-human" } })
        .pipe(Effect.result);
      expect(spoofed._tag).toBe("Failure");
      if (spoofed._tag === "Failure")
        expect(spoofed.failure).toMatchObject({ reason: "spoofed-attribution" });
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
      const receipt = yield* gateway.write(input, actor, source);
      const after = yield* readCurrentState(f.sql, projectId);
      expect(
        after.criteria.find((entry) => entry.criterionId === criterion.criterionId),
      ).toMatchObject({
        status: "waived",
        revision: criterion.revision + 1,
        waiver: {
          reason: input.action.reason,
          specRevision: task.specRevision,
          attribution: { actor, source },
        },
      });
      expect(
        after.foundationRecords?.find((entry) => entry.recordId === f.binding.recordId),
      ).toMatchObject({ status: "stopping" });
      expect(
        after.foundationRecords?.filter(
          (entry) => entry.kind === "gate" && entry.status === "approved",
        ),
      ).toEqual([]);
      expect(
        after.foundationRecords?.filter(
          (entry) =>
            entry.kind === "gate" && entry.gate === "specification" && entry.status === "pending",
        ),
      ).toHaveLength(1);
      const pending = after.foundationRecords?.find(
        (entry) =>
          entry.kind === "gate" && entry.gate === "specification" && entry.status === "pending",
      );
      expect(pending).toMatchObject({ contentHash: projectTeamSpecificationHash(after, taskId) });
      for (const old of before.foundationRecords ?? []) {
        if (old.kind === "gate" && old.status === "approved")
          expect(
            after.foundationRecords?.find((entry) => entry.recordId === old.recordId),
          ).toMatchObject({ status: "invalidated", contentHash: old.contentHash });
      }
      expect(yield* gateway.write(input, actor, source)).toEqual(receipt);
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(after);
      const revoke = {
        ...input,
        commandId: CommandId.make("human-revoke-waiver"),
        expectedRevision: after.revision,
        expectedCriterionRevision: criterion.revision + 1,
        expectedSpecificationHash: projectTeamSpecificationHash(after, taskId),
        action: { kind: "revoke" as const },
      };
      const revokedReceipt = yield* gateway.write(revoke, actor, source);
      const reversed = yield* readCurrentState(f.sql, projectId);
      expect(
        reversed.criteria.find((entry) => entry.criterionId === criterion.criterionId),
      ).toMatchObject({ status: "unsatisfied", revision: criterion.revision + 2 });
      expect(
        reversed.criteria.find((entry) => entry.criterionId === criterion.criterionId)?.waiver,
      ).toBeUndefined();
      expect(yield* gateway.write(input, actor, source)).toEqual(receipt);
      expect(yield* gateway.write(revoke, actor, source)).toEqual(revokedReceipt);
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(reversed);
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.record.contentHash',${"f".repeat(64)}) WHERE project_id=${projectId} AND command_id=${input.commandId} AND event_type='project-work.foundation.recorded' AND json_extract(payload_json,'$.record.recordId')=${pending!.recordId}`;
      const alteredGate = yield* gateway.write(input, actor, source).pipe(Effect.result);
      expect(alteredGate._tag).toBe("Failure");
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.record.contentHash',${projectTeamSpecificationHash(after, taskId)}) WHERE project_id=${projectId} AND command_id=${input.commandId} AND event_type='project-work.foundation.recorded' AND json_extract(payload_json,'$.record.recordId')=${pending!.recordId}`;
      const retainedRows = yield* f.sql<{
        eventId: string;
        payload: string;
        type: string;
        recordId: string | null;
      }>`
      SELECT event_id AS eventId, payload_json AS payload, event_type AS type,
        json_extract(payload_json,'$.record.recordId') AS recordId FROM project_work_events
      WHERE project_id=${projectId} AND command_id=${input.commandId} ORDER BY sequence ASC`;
      const originalGate = before.foundationRecords?.find(
        (entry) => entry.kind === "gate" && entry.status === "approved",
      );
      expect(originalGate).toBeDefined();
      for (const alteration of [
        {
          recordId: pending!.recordId,
          path: "$.record.attribution.actor.id",
          value: "different-human",
        },
        {
          recordId: originalGate!.recordId,
          path: "$.record.attribution.actor.id",
          value: "different-human",
        },
        {
          recordId: originalGate!.recordId,
          path: "$.record.recordId",
          value: "different-invalidated-gate",
        },
        { recordId: null, path: "$.waiver.attribution.actor.id", value: "different-human" },
        { recordId: null, path: "$.occurredAt", value: "2026-01-02T00:00:00.000Z" },
      ]) {
        const row = retainedRows.find((entry) =>
          alteration.recordId === null
            ? entry.type === "project-work.criterion.waived"
            : entry.recordId === alteration.recordId,
        );
        expect(row).toBeDefined();
        yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,${alteration.path},${alteration.value}) WHERE event_id=${row!.eventId}`;
        const altered = yield* gateway.write(input, actor, source).pipe(Effect.result);
        expect(altered._tag).toBe("Failure");
        if (altered._tag === "Failure")
          expect(altered.failure).toMatchObject({ reason: "Guided receipt target changed" });
        yield* f.sql`UPDATE project_work_events SET payload_json=${row!.payload} WHERE event_id=${row!.eventId}`;
      }
      expect(yield* gateway.write(input, actor, source)).toEqual(receipt);
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(reversed);
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.waiver.reason','corrupted reason') WHERE project_id=${projectId} AND command_id=${input.commandId} AND event_type='project-work.criterion.waived'`;
      const corrupt = yield* gateway.write(input, actor, source).pipe(Effect.result);
      expect(corrupt._tag).toBe("Failure");
      if (corrupt._tag === "Failure")
        expect(corrupt.failure).toMatchObject({ reason: "Guided receipt target changed" });
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect(
  "accepts retained summary-only waiver evidence and rejects stale or foreign guided targets",
  () =>
    Effect.gen(function* () {
      const f = yield* seed("implementer", "running", { issueCredential: false });
      const gateway = yield* ProjectWorkGateway;
      const before = yield* readCurrentState(f.sql, projectId);
      const criterion = before.criteria[0]!;
      const task = before.tasks.find((entry) => entry.taskId === taskId)!;
      const evidenceId = ProjectWorkEvidenceId.make("waiver-reference");
      yield* f.repo.execute({
        type: "project-work.evidence.add",
        projectId,
        commandId: CommandId.make("waiver-reference"),
        addedAt: "2026-01-01T00:00:00.000Z",
        evidence: {
          evidenceId,
          taskId,
          criterionId: criterion.criterionId,
          kind: "observation",
          summary: "Retained explanation",
          uri: "https://example.invalid/exception",
          scopeHash: projectTeamScopeHash(
            before,
            taskId,
            before.foundationRecords?.find((entry) => entry.kind === "plan-revision"),
          ),
          recordedAt: "2026-01-01T00:00:00.000Z",
          revision: 0,
          attribution: {
            actor: { kind: "human", id: "waiver-human" },
            source: { kind: "web", id: "waiver-browser" },
            recordedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      });
      const current = yield* readCurrentState(f.sql, projectId);
      const input = {
        type: "project-team.criterion.waiver" as const,
        commandId: CommandId.make("reference-waiver"),
        projectId,
        taskId,
        expectedRevision: current.revision,
        expectedTaskRevision: task.revision,
        criterionId: criterion.criterionId,
        expectedCriterionRevision: criterion.revision,
        expectedSpecRevision: task.specRevision,
        expectedSpecificationHash: projectTeamSpecificationHash(current, taskId),
        action: { kind: "waive" as const, reason: "Recorded exception", evidenceIds: [evidenceId] },
      };
      const actor = { kind: "human" as const, id: "waiver-human" };
      const source = { kind: "web" as const, id: "waiver-browser" };
      for (const changed of [
        { expectedCriterionRevision: criterion.revision + 1 },
        { expectedSpecRevision: task.specRevision + 1 },
        { expectedSpecificationHash: "b".repeat(64) },
        { taskId: ProjectWorkTaskId.make("another-task") },
        {
          action: {
            ...input.action,
            evidenceIds: [ProjectWorkEvidenceId.make("missing-evidence")],
          },
        },
      ]) {
        expect(
          (yield* gateway.write({ ...input, ...changed }, actor, source).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(current);
      }
      yield* gateway.write(input, actor, source);
      const waived = yield* readCurrentState(f.sql, projectId);
      expect(waived.criteria[0]?.waiver?.evidenceIds).toEqual([evidenceId]);
      expect(waived.evidence).toEqual(current.evidence);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect(
  "rolls back a guided waiver when its owning SQL commit fails before accepting retry",
  () =>
    Effect.gen(function* () {
      const f = yield* seed("implementer", "running", { issueCredential: false });
      const gateway = yield* ProjectWorkGateway;
      const before = yield* readCurrentState(f.sql, projectId);
      const criterion = before.criteria[0]!;
      const task = before.tasks.find((entry) => entry.taskId === taskId)!;
      const input = {
        type: "project-team.criterion.waiver" as const,
        commandId: CommandId.make("commit-waiver"),
        projectId,
        taskId,
        expectedRevision: before.revision,
        expectedTaskRevision: task.revision,
        criterionId: criterion.criterionId,
        expectedCriterionRevision: criterion.revision,
        expectedSpecRevision: task.specRevision,
        expectedSpecificationHash: projectTeamSpecificationHash(before, taskId),
        action: { kind: "waive" as const, reason: "Commit-bound exception", evidenceIds: [] },
      };
      const actor = { kind: "human" as const, id: "waiver-human" };
      const source = { kind: "web" as const, id: "waiver-browser" };
      yield* f.sql`CREATE TEMP TABLE waiver_commit_parent (id INTEGER PRIMARY KEY)`;
      yield* f.sql`CREATE TEMP TABLE waiver_commit_child (id INTEGER REFERENCES waiver_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      const outcome = yield* f.repo
        .executeAtomic(
          Effect.gen(function* () {
            yield* gateway.write(input, actor, source);
            yield* f.sql`INSERT INTO waiver_commit_child (id) VALUES (1)`;
            return [];
          }),
        )
        .pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(
        (yield* gateway.read({ projectId, taskId, operation: "task-context" }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      yield* f.sql`ROLLBACK`;
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
      expect(
        yield* f.sql`SELECT command_id FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${input.commandId}`,
      ).toEqual([]);
      yield* gateway.write(input, actor, source);
      expect((yield* readCurrentState(f.sql, projectId)).criteria[0]?.status).toBe("waived");
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

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
        else if (status === "settled") {
          const historical = decodeRecord({
            ...f.binding,
            revision: f.binding.revision + 1,
            status,
          });
          expect((yield* f.change(historical).pipe(Effect.result))._tag).toBe("Failure");
          yield* restoreHistoricalBinding(historical);
        } else
          yield* f.change(decodeRecord({ ...f.binding, revision: f.binding.revision + 1, status }));
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
        yield* f.change(
          decodeRecord({ ...f.binding, revision: f.binding.revision + 1, status: "running" }),
        );
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
        yield* f.change(
          decodeRecord({ ...f.binding, revision: f.binding.revision + 2, status: "revoked" }),
        );
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
            ...f.role,
            recordId: "aaa-role-" + i.toString().padStart(3, "0"),
            roleId: "unrelated-role-" + i,
          }),
        );
      const query = yield* ProjectWorkQuery;
      const page = yield* query.listFoundationRecords({
        projectId,
        kinds: ["role-revision", "run-binding"],
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
        yield* f.change(
          decodeRecord({ ...f.binding, revision: f.binding.revision + 1, status: "running" }),
        );
        expect((yield* f.auth.resolve(f.principal).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
);
it.effect("denies ambiguous reserved issuance and never refreshes a supplied stale marker", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* seed("implementer", "reserved");
      const otherTask = ProjectWorkTaskId.make("other-task");
      yield* createManagedAssignment({
        taskId: otherTask,
        recordId: "other-binding",
        attemptId: "other-attempt",
        commandId: "other-claim",
        providerInstanceId,
        threadId,
        role: f.role,
        status: "reserved",
        configuration: f.binding.configuration,
      });
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

import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectTerminalService } from "../terminal/ProjectTerminalService.ts";
import { TerminalToolkit } from "../mcp/toolkits/terminal/tools.ts";
import { TerminalToolkitHandlersLive } from "../mcp/toolkits/terminal/handlers.ts";

const decodeInvocationCapability = Schema.decodeUnknownSync(
  Schema.Literals(["terminal", "pull-requests", "preview", "device", "project"]),
);
const fenceRegistry = Registry.__testing.make({ now: () => 1000 }).pipe(
  Effect.provideService(
    HttpServer.HttpServer,
    HttpServer.HttpServer.of({
      address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
      serve: () => Effect.void,
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

for (const timing of ["before", "stale-empty", "stale-fence"] as const)
  it.effect(`durable identity fence rejects ${timing} MCP creation across purge`, () =>
    scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const preseed =
          timing === "before"
            ? yield* seed("implementer", "running", { issueCredential: false })
            : undefined;
        const observed = yield* Deferred.make<number>();
        const release = yield* Deferred.make<void>();
        let intercepted = false;
        const racingSql = new Proxy(sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            if (
              !intercepted &&
              Array.isArray(args[0]) &&
              "raw" in args[0] &&
              statement
                .compile()[0]
                .includes(
                  timing === "stale-fence"
                    ? "SELECT thread_id FROM project_team_identity_fences"
                    : "SELECT DISTINCT project_id AS projectId FROM project_team_run_binding",
                )
            ) {
              intercepted = true;
              return statement.pipe(
                Effect.tap((rows) =>
                  Deferred.succeed(observed, rows.length).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                ),
              );
            }
            return statement;
          },
        });
        const authority = yield* Authorization.ProjectTeamAuthorization.pipe(
          Effect.provide(Layer.fresh(Authorization.layer)),
          Effect.provideService(SqlClient.SqlClient, racingSql),
        );
        const registry = yield* fenceRegistry.pipe(
          Effect.provideService(Authorization.ProjectTeamAuthorization, authority),
        );
        const pending = yield* registry
          .issue({ providerInstanceId, threadId })
          .pipe(Effect.exit, Effect.forkScoped);
        expect(yield* Deferred.await(observed)).toBe(timing === "before" ? 1 : 0);
        const f = preseed ?? (yield* seed("implementer", "running", { issueCredential: false }));
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(pending);
        expect(result._tag).toBe(timing === "before" ? "Success" : "Failure");
        if (result._tag === "Success")
          expect([...result.value.config.capabilities]).toEqual(["project"]);
        yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${projectId}`;
        yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        if (result._tag === "Success")
          expect(
            yield* registry.resolve(result.value.config.authorizationHeader.replace("Bearer ", "")),
          ).toBeUndefined();
        const fresh = yield* Authorization.ProjectTeamAuthorization.pipe(
          Effect.provide(Layer.fresh(Authorization.layer)),
        );
        expect(
          (yield* fresh.issueCredential({ providerInstanceId, threadId }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* fresh.discover({ providerInstanceId, threadId }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* fresh.hasManagedThread(threadId)).toBe(true);
        yield* registry.revokeAll;
      }),
    ),
  );

it.effect(
  "durable identity fence rejects untouched ordinary MCP and held toolkit scopes after purge",
  () =>
    scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const registry = yield* fenceRegistry;
        const issued = yield* registry.issue({ providerInstanceId, threadId });
        const token = issued.config.authorizationHeader.replace("Bearer ", "");
        const held = yield* registry.resolve(token);
        expect(held).toBeDefined();
        const f = yield* seed("implementer", "running", { issueCredential: false });
        yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${projectId}`;
        yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        const fresh = yield* Authorization.ProjectTeamAuthorization.pipe(
          Effect.provide(Layer.fresh(Authorization.layer)),
        );
        let entered = 0;
        const terminal = Layer.mock(ProjectTerminalService)({
          spawn: () => {
            entered++;
            return Effect.die("synthetic terminal sink; no process");
          },
        });
        const toolkit = yield* TerminalToolkit.pipe(
          Effect.provide(TerminalToolkitHandlersLive.pipe(Layer.provide(terminal))),
        );
        const result = yield* toolkit
          .handle("terminal_spawn", { command: "synthetic-no-execution" })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(Invocation.McpInvocationContext, held!),
            Effect.provideService(Authorization.ProjectTeamAuthorization, fresh),
            Effect.provide(terminal),
            Effect.exit,
          );
        expect(result._tag).toBe("Failure");
        expect(entered).toBe(0);
        yield* registry.touch(threadId);
        expect(yield* registry.resolve(token)).toBeUndefined();
        expect((yield* fresh.resolve({ actor: held!.identity! }).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const ordinary = yield* registry.issue({
          providerInstanceId,
          threadId: ThreadId.make("never-managed"),
        });
        expect(
          (yield* registry.resolve(
            ordinary.config.authorizationHeader.replace("Bearer ", ""),
          ))?.capabilities.has("terminal"),
        ).toBe(true);
        yield* registry.revokeAll;
      }),
    ),
);

for (const outcome of ["late-publish", "interruption"] as const)
  it.effect(
    `durable identity fence handles final empty publication observation and ${outcome}`,
    () =>
      scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const sql = yield* SqlClient.SqlClient;
          const observed = yield* Deferred.make<number>();
          const release = yield* Deferred.make<void>();
          let intercepted = false;
          const racingSql = new Proxy(sql, {
            apply(target, _receiver, args) {
              const statement = target(args[0], ...args.slice(1));
              if (
                !intercepted &&
                Array.isArray(args[0]) &&
                "raw" in args[0] &&
                statement.compile()[0].includes("SELECT DISTINCT provider_instance_id AS provider")
              ) {
                intercepted = true;
                return statement.pipe(
                  Effect.tap((rows) =>
                    Deferred.succeed(observed, rows.length).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
                  ),
                );
              }
              return statement;
            },
          });
          const authority = yield* Authorization.ProjectTeamAuthorization.pipe(
            Effect.provide(Layer.fresh(Authorization.layer)),
            Effect.provideService(SqlClient.SqlClient, racingSql),
          );
          const registry = yield* fenceRegistry.pipe(
            Effect.provideService(Authorization.ProjectTeamAuthorization, authority),
          );
          const pending = yield* registry
            .issue({ providerInstanceId, threadId })
            .pipe(Effect.exit, Effect.forkScoped);
          expect(yield* Deferred.await(observed)).toBe(0);
          const f = yield* seed("implementer", "running", { issueCredential: false });
          yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${projectId}`;
          yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
          yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
          if (outcome === "interruption") {
            yield* Fiber.interrupt(pending);
            expect((yield* Fiber.await(pending))._tag).toBe("Failure");
            expect(yield* Deferred.isDone(release)).toBe(false);
          } else {
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.join(pending);
            expect(result._tag).toBe("Success");
            if (result._tag !== "Success") return;
            const config = result.value.config;
            // This scope represents the returned config held unused across transition and purge.
            const held: Invocation.McpInvocationScope = {
              environmentId: config.environmentId,
              threadId,
              providerInstanceId,
              providerSessionId: config.providerSessionId,
              capabilities: new Set(
                [...config.capabilities].map((value) => decodeInvocationCapability(value)),
              ),
              issuedAt: 1000,
              identity: {
                kind: "agent",
                id: Authorization.managedActorId({ providerInstanceId, threadId }),
              },
            };
            const fresh = yield* Authorization.ProjectTeamAuthorization.pipe(
              Effect.provide(Layer.fresh(Authorization.layer)),
            );
            let entered = 0;
            const terminal = Layer.mock(ProjectTerminalService)({
              spawn: () => {
                entered++;
                return Effect.die("synthetic terminal sink; no process");
              },
            });
            const toolkit = yield* TerminalToolkit.pipe(
              Effect.provide(TerminalToolkitHandlersLive.pipe(Layer.provide(terminal))),
            );
            expect(
              (yield* toolkit
                .handle("terminal_spawn", { command: "synthetic-no-execution" })
                .pipe(
                  Stream.unwrap,
                  Stream.runCollect,
                  Effect.provideService(Invocation.McpInvocationContext, held),
                  Effect.provideService(Authorization.ProjectTeamAuthorization, fresh),
                  Effect.provide(terminal),
                  Effect.exit,
                ))._tag,
            ).toBe("Failure");
            expect(entered).toBe(0);
            expect(
              yield* registry.resolve(config.authorizationHeader.replace("Bearer ", "")),
            ).toBeUndefined();
          }
          yield* registry.revokeAll;
          expect((yield* sql`SELECT * FROM project_team_identity_fences`).length).toBe(1);
          // Cancellation releases the real SQL permit and leaves never-managed issuance available.
          expect(
            (yield* registry.issue({
              providerInstanceId,
              threadId: ThreadId.make("ordinary-after-cancellation"),
            })).config.capabilities.has("terminal"),
          ).toBe(true);
          yield* registry.revokeAll;
        }),
      ),
  );

import * as ProxyRegistry from "../mcp/ProjectMcpProxyRegistry.ts";
it.effect("durable identity fence cleans up an untouched ordinary MCP credential on touch", () =>
  scoped(
    Effect.gen(function* () {
      yield* runMigrations();
      let cleaned = 0;
      const registry = yield* fenceRegistry.pipe(
        Effect.provide(
          Layer.mock(ProxyRegistry.ProjectMcpProxyRegistry)({
            revokeProviderSession: () =>
              Effect.sync(() => {
                cleaned++;
              }),
          }),
        ),
      );
      const issued = yield* registry.issue({ providerInstanceId, threadId });
      const f = yield* seed("implementer", "running", { issueCredential: false });
      yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${projectId}`;
      yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
      yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
      yield* registry.touch(threadId);
      expect(cleaned).toBe(1);
      expect(
        yield* registry.resolve(issued.config.authorizationHeader.replace("Bearer ", "")),
      ).toBeUndefined();
      expect(cleaned).toBe(1);
      yield* registry.revokeAll;
    }),
  ),
);
