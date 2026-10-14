import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectWorkTaskId, ThreadId } from "@t3tools/contracts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import type {
  PiModelRequestSettlement,
  PiModelRequestReservation,
} from "../provider/pi/PiModelBroker.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import {
  seed,
  createManagedAssignment,
  decodeRecord,
  projectId,
  threadId,
  providerInstanceId,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepositoryLive, readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { projectTeamSpecificationHash, projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import {
  make,
  ModelAccountingError,
  type ProjectTeamModelAccountingOptions,
  type ProjectTeamPiSubscriptionTestSelection,
} from "./ProjectTeamModelAccounting.ts";

const encodeFixtureJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const decodeFixtureJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

const runtime = (path: string) =>
  Layer.mergeAll(
    Authorization.layer,
    ProjectWorkRepositoryLive,
    ProjectWorkQueryLive,
    ProjectWorkProjectionLive,
  ).pipe(Layer.provideMerge(makeSqlitePersistenceLive(path)));
const fileTest = <A, E, R>(body: (path: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      return yield* body(`${dir}/accounting.sqlite`);
    }),
  ).pipe(Effect.provide(NodeServices.layer));
const request = (requestId = 1): PiModelRequestReservation => ({
  workerId: "worker",
  generation: 0,
  operationId: "prompt",
  requestId,
  routeId: "configured",
  provider: "command-code",
  model: "test",
  maxInputTokens: 100,
  maxOutputTokens: 100,
  callCount: 1,
  deadlineAtMs: 10000,
});
const unknown = (reservationId: string, reservation = request()): PiModelRequestSettlement => ({
  ...reservation,
  reservationId,
  transportDrained: true,
  outcome: "unknown",
  chargedInputTokens: reservation.maxInputTokens,
  chargedOutputTokens: reservation.maxOutputTokens,
});
const reported = (reservationId: string, reservation = request()): PiModelRequestSettlement => ({
  ...reservation,
  reservationId,
  transportDrained: true,
  outcome: "reported",
  chargedInputTokens: 10,
  chargedOutputTokens: 20,
  reportedModel: "test",
  reportedUsage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
});
const denied = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => expect(result._tag).toBe("Failure")),
  );
const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(100);
  const f = yield* seed();
  yield* f.sql`CREATE TABLE model_operation_fixture (binding_id TEXT,worker_id TEXT,operation_id TEXT,root_task_id TEXT,maximum_tokens INTEGER,deadline_at_ms INTEGER)`;
  yield* f.sql`INSERT INTO model_operation_fixture VALUES (${f.binding.recordId},'worker','prompt','root',500,10000)`;
  const options: ProjectTeamModelAccountingOptions = {
    environmentId: "environment",
    routeId: "configured",
    model: "test",
    acceptedReportedModels: ["test"],
    resolveOperation: (authority, reservation) =>
      Effect.gen(function* () {
        const rows = yield* f.sql<{
          worker_id: string;
          operation_id: string;
          root_task_id: string;
          maximum_tokens: number;
          deadline_at_ms: number;
        }>`SELECT * FROM model_operation_fixture WHERE binding_id=${authority.binding.recordId} AND worker_id=${reservation.workerId} AND operation_id=${reservation.operationId}`;
        const row = rows[0];
        if (!row) return yield* new ModelAccountingError({ reason: "Operation unavailable" });
        return {
          workerId: row.worker_id,
          operationId: row.operation_id,
          rootTaskId: row.root_task_id,
          maximumTokens: row.maximum_tokens,
          deadlineAtMs: row.deadline_at_ms,
          operationMaximumTokens: row.maximum_tokens,
          operationDeadlineAtMs: row.deadline_at_ms,
        };
      }).pipe(Effect.mapError(() => new ModelAccountingError({ reason: "Operation unavailable" }))),
  };
  const accounting = yield* make(options);
  const counts = () =>
    f.sql<{
      budgets: number;
      requests: number;
    }>`SELECT (SELECT count(*) FROM project_team_model_budget) AS budgets,(SELECT count(*) FROM project_team_model_request) AS requests`;
  return { ...f, options, accounting, counts };
});

const subscriptionFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const role = decodeRecord({
    ...f.role,
    recordId: "subscription-role",
    roleRevision: 2,
    model: "gpt-6-luna",
  });
  if (role.kind !== "role-revision") return yield* Effect.die("Invalid subscription role fixture");
  const member = decodeRecord({
    ...f.member,
    recordId: "subscription-member",
    roleRevisionId: role.recordId,
  });
  if (member.kind !== "member") return yield* Effect.die("Invalid subscription member fixture");
  yield* f.change(role);
  yield* f.change(member);
  const rootTaskId = ProjectWorkTaskId.make("subscription-root");
  const binding = yield* createManagedAssignment({
    taskId: rootTaskId,
    recordId: "subscription-binding",
    attemptId: "subscription-attempt",
    commandId: "subscription-dispatch",
    providerInstanceId,
    threadId: ThreadId.make("subscription-thread"),
    status: "running",
    role,
    memberId: member.recordId,
    configuration: {
      ...f.binding.configuration,
      runtimeVersion: "0.99.1",
      maxTokens: 64_000,
      maxDurationMs: 300_000,
    },
    sessionId: "subscription-session",
  });
  const authority = yield* f.auth.issueCredential({
    providerInstanceId,
    threadId: binding.threadId,
  });
  if (!authority) return yield* Effect.die("Missing subscription fixture authority");
  const principal = {
    actor: {
      kind: "agent" as const,
      id: Authorization.managedActorId(authority.credential),
    },
    managed: authority.credential,
  };
  const resolved = yield* f.auth.resolve(principal);
  expect(resolved?.binding.recordId).toBe(binding.recordId);
  yield* f.sql`INSERT INTO model_operation_fixture VALUES (${binding.recordId},'subscription-worker','subscription-prompt',${rootTaskId},64000,300100)`;
  const subscriptionTest: ProjectTeamPiSubscriptionTestSelection = {
    projectId,
    rootTaskId,
    model: "gpt-6-luna",
    maximumTokens: 64_000,
    maximumDurationMs: 300_000,
  };
  const options = {
    ...f.options,
    routeId: "openai-subscription-luna",
    model: "gpt-6-luna",
    acceptedReportedModels: ["gpt-6-luna"],
    subscriptionTest,
  } satisfies ProjectTeamModelAccountingOptions;
  const accounting = yield* make(options);
  const reservation = (requestId = 1) => ({
    workerId: "subscription-worker",
    generation: binding.generation,
    operationId: "subscription-prompt",
    requestId,
    routeId: "openai-subscription-luna",
    provider: "openai-codex" as const,
    model: "gpt-6-luna",
    maxInputTokens: 16_384,
    maxOutputTokens: 2_048,
    callCount: 1 as const,
    deadlineAtMs: 300100,
    accountingMode: "openai-subscription-monitored" as const,
    unknownMaximumTokens: 64_000 as const,
  });
  return { ...f, binding, principal, accounting, reservation, rootTaskId, options };
});

it.effect("denies ordinary, stale and revoked authority without reserving", () =>
  fileTest((path) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* denied(f.accounting.reserve({ actor: { kind: "human", id: "human" } }, request()));
      yield* denied(
        f.accounting.reserve(
          { ...f.principal, managed: { ...f.principal.managed, generation: 1 } },
          request(),
        ),
      );
      yield* f.change(decodeRecord({ ...f.binding, revision: 2, status: "stopping" }));
      yield* denied(f.accounting.reserve(f.principal, request()));
      expect(yield* f.counts()).toEqual([{ budgets: 0, requests: 0 }]);
    }).pipe(Effect.provide(runtime(path))),
  ),
);

it.effect(
  "reserves for the approved subscription root and records reported usage above its output envelope",
  () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* subscriptionFixture;
        const request = f.reservation();
        const reserved = yield* f.accounting.reserve(f.principal, request);
        expect(reserved.status).toBe("reserved");
        const settlement: PiModelRequestSettlement = {
          ...request,
          reservationId: reserved.reservationId,
          transportDrained: true,
          outcome: "reported",
          chargedInputTokens: 1_024,
          chargedOutputTokens: 3_072,
          reportedModel: "gpt-6-luna",
          reportedUsage: {
            prompt_tokens: 1_024,
            completion_tokens: 3_072,
            total_tokens: 4_096,
          },
        };
        yield* f.accounting.settle(settlement);
        expect(
          yield* f.sql`SELECT status,provider,model,route_id,accounting_mode,unknown_maximum_tokens,charged_input_tokens,charged_output_tokens FROM project_team_model_request WHERE root_task_id=${f.rootTaskId}`,
        ).toEqual([
          {
            status: "reported",
            provider: "openai-codex",
            model: "gpt-6-luna",
            route_id: "openai-subscription-luna",
            accounting_mode: "openai-subscription-monitored",
            unknown_maximum_tokens: 64_000,
            charged_input_tokens: 1024,
            charged_output_tokens: 3072,
          },
        ]);
      }).pipe(Effect.provide(runtime(path))),
    ),
);

it.effect(
  "charges the root threshold once across requests and rejects a successor reservation",
  () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* subscriptionFixture;
        let crossingSettlement: PiModelRequestSettlement | undefined;
        let crossingReceipt: { readonly accountingReceiptId: string } | undefined;
        for (let requestId = 1; requestId <= 4; requestId++) {
          const request = f.reservation(requestId);
          const reserved = yield* f.accounting.reserve(f.principal, request);
          const settlement: PiModelRequestSettlement = {
            ...request,
            reservationId: reserved.reservationId,
            transportDrained: true,
            outcome: "reported",
            chargedInputTokens: 16_384,
            chargedOutputTokens: 2_048,
            reportedModel: "gpt-6-luna",
            reportedUsage: {
              prompt_tokens: 16_384,
              completion_tokens: 2_048,
              total_tokens: 18_432,
            },
          };
          const receipt = yield* f.accounting.settle(settlement);
          if (requestId === 4) {
            crossingSettlement = settlement;
            crossingReceipt = receipt;
          }
        }
        if (!crossingSettlement || !crossingReceipt)
          return yield* Effect.die("Missing threshold-crossing settlement");
        expect(yield* f.accounting.settle(crossingSettlement)).toEqual(crossingReceipt);
        yield* denied(f.accounting.reserve(f.principal, f.reservation(5)));
        expect(
          yield* f.sql`SELECT SUM(charged_input_tokens + charged_output_tokens) AS charged FROM project_team_model_request WHERE root_task_id=${f.rootTaskId}`,
        ).toEqual([{ charged: 73_728 }]);
        expect(
          yield* f.sql`SELECT maximum_tokens,maximum_duration_ms,deadline_at_ms,stopped_at_ms,stop_reason
        FROM project_team_pi_subscription_grant WHERE root_task_id=${f.rootTaskId}`,
        ).toEqual([
          {
            maximum_tokens: 64_000,
            maximum_duration_ms: 300_000,
            deadline_at_ms: 300_100,
            stopped_at_ms: 100,
            stop_reason: "threshold-reached",
          },
        ]);
        expect(yield* f.counts()).toEqual([{ budgets: 1, requests: 4 }]);
      }).pipe(Effect.provide(runtime(path))),
    ),
);

it.effect("upgrades a reported subscription receipt to failure without erasing overshoot", () =>
  fileTest((path) =>
    Effect.gen(function* () {
      const f = yield* subscriptionFixture;
      const request = f.reservation();
      const reserved = yield* f.accounting.reserve(f.principal, request);
      const reported: PiModelRequestSettlement = {
        ...request,
        reservationId: reserved.reservationId,
        transportDrained: true,
        outcome: "reported",
        chargedInputTokens: 1_024,
        chargedOutputTokens: 3_072,
        reportedModel: "gpt-6-luna",
        reportedUsage: { prompt_tokens: 1_024, completion_tokens: 3_072, total_tokens: 4_096 },
      };
      const receipt = yield* f.accounting.settle(reported);
      const failed: PiModelRequestSettlement = {
        ...request,
        reservationId: reserved.reservationId,
        outcome: "failed",
        chargedInputTokens: 16_384,
        chargedOutputTokens: 3_072,
      };
      expect(yield* f.accounting.settle(failed)).toEqual(receipt);
      expect(yield* f.accounting.settle(failed)).toEqual(receipt);
      expect(
        yield* f.sql`SELECT status,charged_input_tokens,charged_output_tokens,accounting_receipt_id
        FROM project_team_model_request WHERE reservation_id=${reserved.reservationId}`,
      ).toEqual([
        {
          status: "failed",
          charged_input_tokens: 16_384,
          charged_output_tokens: 3_072,
          accounting_receipt_id: receipt.accountingReceiptId,
        },
      ]);
    }).pipe(Effect.provide(runtime(path))),
  ),
);

it.effect(
  "quarantines unknown subscription usage at its conservative maximum and stops successors",
  () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* subscriptionFixture;
        const request = f.reservation();
        const reserved = yield* f.accounting.reserve(f.principal, request);
        const settlement: PiModelRequestSettlement = {
          ...request,
          reservationId: reserved.reservationId,
          transportDrained: true,
          outcome: "unknown",
          chargedInputTokens: 16_384,
          chargedOutputTokens: 64_000,
        };
        const receipt = yield* f.accounting.settle(settlement);
        expect(yield* f.accounting.settle(settlement)).toEqual(receipt);
        expect(
          yield* f.sql`SELECT status,capacity_state,charged_input_tokens,charged_output_tokens FROM project_team_model_request WHERE root_task_id=${f.rootTaskId}`,
        ).toEqual([
          {
            status: "unknown",
            capacity_state: "quarantine",
            charged_input_tokens: 16_384,
            charged_output_tokens: 64_000,
          },
        ]);
        yield* denied(f.accounting.reserve(f.principal, f.reservation(2)));
        expect(
          yield* f.sql`SELECT stopped_at_ms,stop_reason FROM project_team_pi_subscription_grant
        WHERE root_task_id=${f.rootTaskId}`,
        ).toEqual([{ stopped_at_ms: 100, stop_reason: "unknown-usage" }]);
        expect(yield* f.counts()).toEqual([{ budgets: 1, requests: 1 }]);
      }).pipe(Effect.provide(runtime(path))),
    ),
);

it.effect("requires the private subscription selection to name the genuine current root", () =>
  fileTest((path) =>
    Effect.gen(function* () {
      const f = yield* subscriptionFixture;
      const request = f.reservation();
      const withoutSelection = yield* make({
        environmentId: f.options.environmentId,
        routeId: f.options.routeId,
        model: f.options.model,
        acceptedReportedModels: f.options.acceptedReportedModels,
        resolveOperation: f.options.resolveOperation,
      });
      yield* denied(withoutSelection.reserve(f.principal, request));
      const foreignRoot = yield* make({
        ...f.options,
        subscriptionTest: {
          ...f.options.subscriptionTest,
          rootTaskId: "foreign-subscription-root",
        },
      });
      yield* denied(foreignRoot.reserve(f.principal, request));
      expect(yield* f.counts()).toEqual([{ budgets: 0, requests: 0 }]);
    }).pipe(Effect.provide(runtime(path))),
  ),
);

it.effect(
  "preserves the original cumulative attempt ceiling across separate operation budgets",
  () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        // These are the fixture's trusted operation port records. Root and each
        // operation allow 1600; the genuinely issued binding/attempt allows 1000.
        expect(f.binding.configuration.maxTokens).toBe(1000);
        yield* f.sql`UPDATE model_operation_fixture SET maximum_tokens=1600`;
        yield* f.sql`INSERT INTO model_operation_fixture VALUES(
      ${f.binding.recordId},'successor-worker','successor-operation','root',1600,10000)`;
        const firstRequest = { ...request(), maxInputTokens: 600, maxOutputTokens: 100 };
        const first = yield* f.accounting.reserve(f.principal, firstRequest);
        yield* f.accounting.settle(unknown(first.reservationId, firstRequest));
        const successor = {
          ...request(),
          workerId: "successor-worker",
          operationId: "successor-operation",
          maxInputTokens: 200,
          maxOutputTokens: 200,
        };
        const before = yield* f.sql`SELECT * FROM project_team_model_request`;
        expect((yield* f.accounting.reserve(f.principal, successor).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(before);
        expect(yield* f.sql`SELECT maximum_tokens FROM project_team_model_budget`).toEqual([
          { maximum_tokens: 1600 },
        ]);
        const boundary = { ...successor, maxInputTokens: 150, maxOutputTokens: 150 };
        const next = yield* f.accounting.reserve(f.principal, boundary);
        expect(next.status).toBe("reserved");
        yield* f.accounting.settle(unknown(next.reservationId, boundary));
        expect(
          yield* f.sql`SELECT operation_id,SUM(charged_input_tokens+charged_output_tokens) AS charged
      FROM project_team_model_request GROUP BY operation_id ORDER BY operation_id`,
        ).toEqual([
          { operation_id: "prompt", charged: 700 },
          { operation_id: "successor-operation", charged: 300 },
        ]);
        yield* denied(
          f.accounting.reserve(f.principal, {
            ...boundary,
            requestId: 2,
            maxInputTokens: 1,
            maxOutputTokens: 1,
          }),
        );
      }).pipe(Effect.provide(runtime(path))),
    ),
);

it.effect(
  "intersects effective operation caps with the immutable root budget and current binding",
  () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const accounting = yield* make({
          ...f.options,
          resolveOperation: (authority, reservation) =>
            f.options.resolveOperation(authority, reservation).pipe(
              Effect.map((operation) => ({
                ...operation,
                operationMaximumTokens: 250,
                operationDeadlineAtMs: 5000,
              })),
            ),
        });
        const bounded = { ...request(), deadlineAtMs: 5000 };
        const first = yield* accounting.reserve(f.principal, bounded);
        yield* denied(
          accounting.reserve(f.principal, { ...bounded, requestId: 2, maxInputTokens: 151 }),
        );
        yield* denied(
          accounting.reserve(f.principal, { ...bounded, requestId: 2, deadlineAtMs: 5001 }),
        );
        yield* accounting.settle(unknown(first.reservationId, bounded));
        yield* denied(accounting.reserve(f.principal, { ...bounded, requestId: 2 }));
        expect(
          (yield* accounting.reserve(f.principal, {
            ...bounded,
            requestId: 2,
            maxInputTokens: 25,
            maxOutputTokens: 25,
          })).status,
        ).toBe("reserved");
        yield* denied(accounting.reserve(f.principal, { ...bounded, requestId: 3 }));
        expect(
          yield* f.sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget`,
        ).toEqual([{ maximum_tokens: 500, deadline_at_ms: 10000 }]);
        yield* TestClock.setTime(5000);
        yield* denied(accounting.reserve(f.principal, bounded));
        expect(yield* f.counts()).toEqual([{ budgets: 1, requests: 2 }]);
      }).pipe(Effect.provide(runtime(path))),
    ),
);

it.effect(
  "returns the original receipt for exact requests and rejects changed identity or policy",
  () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const duplicates = yield* Effect.all(
          [
            f.accounting.reserve(f.principal, request()),
            f.accounting.reserve(f.principal, request()),
          ],
          { concurrency: "unbounded" },
        );
        expect(duplicates.map((receipt) => receipt.status).sort()).toEqual([
          "existing",
          "reserved",
        ]);
        const first = duplicates[0]!;

        expect(yield* f.accounting.reserve(f.principal, request())).toEqual({
          ...first,
          status: "existing",
        });
        yield* f.accounting.settle(reported(first.reservationId));
        expect(yield* f.accounting.reserve(f.principal, request())).toEqual({
          ...first,
          status: "existing",
        });
        for (const changed of [
          { ...request(), maxInputTokens: 101 },
          { ...request(), model: "other" },
          { ...request(), routeId: "other" },
          { ...request(), deadlineAtMs: 9999 },
        ])
          yield* denied(f.accounting.reserve(f.principal, changed));
        yield* f.sql`UPDATE model_operation_fixture SET maximum_tokens=600`;
        yield* denied(f.accounting.reserve(f.principal, request(2)));
        expect(yield* f.counts()).toEqual([{ budgets: 1, requests: 1 }]);
      }).pipe(Effect.provide(runtime(path))),
    ),
);

for (const capacity of ["environment", "model"] as const)
  it.effect(`atomically limits ${capacity} callers across projects and keeps expired holds`, () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const projects =
          yield* f.sql`SELECT * FROM projection_projects WHERE project_id=${projectId}`;
        yield* f.sql`INSERT INTO projection_projects ${f.sql.insert({ ...projects[0], project_id: "second-" + projectId })}`;
        const events = yield* f.sql<{
          event_id: string;
          event_type: string;
          occurred_at: string;
          command_id: string;
          payload_json: string;
        }>`SELECT event_id,event_type,occurred_at,command_id,payload_json FROM project_work_events WHERE project_id=${projectId} ORDER BY sequence`;
        for (const event of events) {
          const rename = (value: typeof Schema.Json.Type): typeof Schema.Json.Type => {
            if (Array.isArray(value)) return value.map(rename);
            if (typeof value === "object" && value !== null)
              return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                  key,
                  ["kind", "type", "status", "role"].includes(key) ? item : rename(item),
                ]),
              );
            if (
              typeof value === "string" &&
              [
                projectId,
                "authorization-task",
                threadId,
                "binding",
                "role",
                "member",
                "attempt",
                "criterion",
                event.event_id,
              ].some((id) => value === id || value.startsWith(id + "-"))
            )
              return "second-" + value;
            return value;
          };
          const payload = yield* encodeFixtureJson(
            rename(yield* decodeFixtureJson(event.payload_json)),
          );
          yield* f.sql`INSERT INTO project_work_events(event_id,project_id,event_type,occurred_at,command_id,payload_json) VALUES(${"second-" + event.event_id},${"second-" + projectId},${event.event_type},${event.occurred_at},${"second-" + event.command_id},${payload})`;
        }
        const projection = yield* ProjectWorkProjection;
        yield* projection.rebuild("second-" + projectId);
        const clone = yield* readCurrentState(f.sql, "second-" + projectId);
        const original = yield* readCurrentState(f.sql, projectId);
        const originalPlan = original.foundationRecords?.find((r) => r.kind === "plan-revision");
        const clonePlan = clone.foundationRecords?.find((r) => r.kind === "plan-revision");
        if (originalPlan?.kind !== "plan-revision" || clonePlan?.kind !== "plan-revision")
          return yield* Effect.die("Missing fixture plan");
        const oldSpec = projectTeamSpecificationHash(original, "authorization-task");
        const newSpec = projectTeamSpecificationHash(clone, "second-authorization-task");
        const oldScope = projectTeamScopeHash(original, "authorization-task", originalPlan);
        const newScope = projectTeamScopeHash(clone, "second-authorization-task", clonePlan);
        yield* f.sql`UPDATE project_work_events SET payload_json=replace(replace(payload_json,${oldSpec},${newSpec}),${oldScope},${newScope}) WHERE project_id=${"second-" + projectId}`;
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${"second-" + projectId}`;
        yield* projection.rebuild("second-" + projectId);
        const issued = yield* f.auth.issueCredential({
          providerInstanceId,
          threadId: ThreadId.make("second-" + threadId),
        });
        expect(issued).toBeDefined();
        if (!issued) return yield* Effect.die("Missing fixture authority");
        const otherPrincipal = {
          actor: { kind: "agent" as const, id: Authorization.managedActorId(issued.credential) },
          managed: issued.credential,
        };
        yield* f.sql`INSERT INTO model_operation_fixture VALUES ('second-binding','other-worker','prompt','root',500,10000)`;
        const otherRequest = { ...request(), workerId: "other-worker" };
        const accounting = yield* make({
          ...f.options,
          maximumConcurrentCalls: capacity === "environment" ? 2 : 3,
          maximumConcurrentModelCalls: capacity === "model" ? 2 : 3,
        });
        const competing = yield* Effect.all(
          [
            accounting.reserve(f.principal, request()),
            accounting.reserve(otherPrincipal, otherRequest),
            accounting.reserve(f.principal, request(2)),
          ].map((effect) => Effect.result(effect)),
          { concurrency: "unbounded" },
        );
        expect(competing.filter((result) => result._tag === "Success")).toHaveLength(2);
        expect(competing.filter((result) => result._tag === "Failure")).toHaveLength(1);
        expect(
          yield* f.sql`SELECT COUNT(DISTINCT project_id) AS projects FROM project_team_model_request`,
        ).toEqual([{ projects: 2 }]);
        yield* TestClock.setTime(10001);
        expect(yield* f.sql`SELECT status FROM project_team_model_request`).toEqual([
          { status: "held" },
          { status: "held" },
        ]);
        yield* f.sql`INSERT INTO model_operation_fixture VALUES ('binding','worker','after-expiry','later-root',500,20000)`;
        yield* denied(
          accounting.reserve(f.principal, {
            ...request(3),
            operationId: "after-expiry",
            deadlineAtMs: 20000,
          }),
        );
      }).pipe(Effect.provide(runtime(path))),
    ),
  );

it.effect("rolls back root budget, request and slots when SQL fails", () =>
  fileTest((path) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`CREATE TRIGGER fail_model_request BEFORE INSERT ON project_team_model_request BEGIN SELECT RAISE(ABORT,'fixture'); END`;
      yield* denied(f.accounting.reserve(f.principal, request()));
      expect(yield* f.counts()).toEqual([{ budgets: 0, requests: 0 }]);
      yield* f.sql`DROP TRIGGER fail_model_request`;
      expect((yield* f.accounting.reserve(f.principal, request())).status).toBe("reserved");
    }).pipe(Effect.provide(runtime(path))),
  ),
);

for (const capacity of ["environment", "model"] as const)
  for (const transportDrained of [undefined, false, true])
    it.effect(
      `retains ${capacity} transport capacity independently of unknown usage: ${transportDrained}`,
      () =>
        fileTest((path) =>
          Effect.gen(function* () {
            const f = yield* fixture;
            const accounting = yield* make({
              ...f.options,
              maximumConcurrentCalls: capacity === "environment" ? 1 : 2,
              maximumConcurrentModelCalls: capacity === "model" ? 1 : 2,
            });
            const reservation = yield* accounting.reserve(f.principal, request());
            const settlement = unknown(reservation.reservationId);
            if (transportDrained === undefined)
              Reflect.deleteProperty(settlement, "transportDrained");
            else Reflect.set(settlement, "transportDrained", transportDrained);
            const receipt = yield* accounting.settle(settlement);
            expect(yield* accounting.settle(settlement)).toEqual(receipt);
            if (transportDrained === true) {
              const next = yield* accounting.reserve(f.principal, request(2));
              yield* accounting.settle(unknown(next.reservationId, request(2)));
              yield* denied(accounting.reserve(f.principal, request(3)));
            } else {
              yield* denied(accounting.reserve(f.principal, request(2)));
            }
            // A duplicate reporting a later drain cannot release the original quarantine.
            expect(yield* accounting.settle({ ...settlement, transportDrained: true })).toEqual(
              receipt,
            );
            if (transportDrained !== true)
              yield* denied(accounting.reserve(f.principal, request(2)));
            expect(
              yield* f.sql`SELECT status,capacity_state,charged_input_tokens,charged_output_tokens,accounting_receipt_id FROM project_team_model_request WHERE reservation_id=${reservation.reservationId}`,
            ).toEqual([
              {
                status: "unknown",
                capacity_state: transportDrained === true ? "released" : "quarantine",
                charged_input_tokens: 100,
                charged_output_tokens: 100,
                accounting_receipt_id: receipt.accountingReceiptId,
              },
            ]);
            expect(yield* accounting.reserve(f.principal, request())).toEqual({
              reservationId: reservation.reservationId,
              status: "existing",
            });
          }).pipe(Effect.provide(runtime(path))),
        ),
    );

it.effect("blocks a legacy environment despite historical reuse of a settled slot", () =>
  fileTest((path) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const reservation = yield* f.accounting.reserve(f.principal, request());
      const settlement = reported(reservation.reservationId);
      const receipt = yield* f.accounting.settle(settlement);
      // Represent pre-upgrade settlements: no trusted drain evidence, and their slots were reused.
      const rows =
        yield* f.sql`SELECT * FROM project_team_model_request WHERE reservation_id=${reservation.reservationId}`;
      const historical = { ...rows[0], capacity_state: "legacy" };
      yield* f.sql`UPDATE project_team_model_request SET capacity_state='legacy' WHERE reservation_id=${reservation.reservationId}`;
      yield* f.sql`INSERT INTO project_team_model_request ${f.sql.insert({
        ...historical,
        reservation_id: "legacy-second",
        worker_id: "legacy-worker",
      })}`;
      yield* denied(f.accounting.reserve(f.principal, request(2)));
      yield* denied(f.accounting.reserve(f.principal, request()));
      expect(yield* f.accounting.settle(settlement)).toEqual(receipt);
      yield* denied(f.accounting.reserve(f.principal, request(2)));
      expect(
        yield* f.sql`SELECT capacity_state FROM project_team_model_request ORDER BY reservation_id`,
      ).toEqual([{ capacity_state: "legacy" }, { capacity_state: "legacy" }]);
      expect(yield* f.counts()).toEqual([{ budgets: 1, requests: 2 }]);
    }).pipe(Effect.provide(runtime(path))),
  ),
);

for (const outcome of ["reported", "failed"] as const)
  for (const transportDrained of [false, true])
    it.effect(`preserves ${outcome} charges and transport capacity: ${transportDrained}`, () =>
      fileTest((path) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const accounting = yield* make({
            ...f.options,
            maximumConcurrentCalls: 1,
            maximumConcurrentModelCalls: 1,
          });
          const reservation = yield* accounting.reserve(f.principal, request());
          const report = {
            ...reported(reservation.reservationId),
            transportDrained,
            ...(outcome === "failed"
              ? {
                  outcome,
                  failureCode: "AUTHORIZATION_REJECTED" as const,
                  chargedInputTokens: 100,
                  chargedOutputTokens: 100,
                }
              : {}),
          };
          const receipt = yield* accounting.settle(report);
          const failed: PiModelRequestSettlement = {
            ...report,
            transportDrained: true,
            outcome: "failed",
            failureCode: "AUTHORIZATION_REJECTED",
            chargedInputTokens: 100,
            chargedOutputTokens: 100,
          };
          expect(yield* accounting.settle(failed)).toEqual(receipt);
          expect(yield* accounting.settle(failed)).toEqual(receipt);
          if (transportDrained) {
            expect((yield* accounting.reserve(f.principal, request(2))).status).toBe("reserved");
          } else {
            yield* denied(accounting.reserve(f.principal, request(2)));
          }
          expect(
            yield* f.sql`SELECT status,capacity_state,charged_input_tokens,charged_output_tokens FROM project_team_model_request WHERE reservation_id=${reservation.reservationId}`,
          ).toEqual([
            {
              status: "failed",
              capacity_state: transportDrained ? "released" : "quarantine",
              charged_input_tokens: 100,
              charged_output_tokens: 100,
            },
          ]);
        }).pipe(Effect.provide(runtime(path))),
      ),
    );

it.effect(
  "checks Clock after operation authority and after the actual request insert receipt",
  () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const expired = yield* make({
          ...f.options,
          resolveOperation: (authority, reservation) =>
            f.options
              .resolveOperation(authority, reservation)
              .pipe(Effect.tap(() => TestClock.setTime(10000))),
        });
        yield* denied(expired.reserve(f.principal, request()));
        expect(yield* f.counts()).toEqual([{ budgets: 0, requests: 0 }]);
        yield* TestClock.setTime(100);
        let insertReceipts = 0;
        const wrapped = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            return statement.compile()[0].includes("INSERT INTO project_team_model_request")
              ? statement.pipe(
                  Effect.tap(() => {
                    insertReceipts++;
                    return TestClock.setTime(10000);
                  }),
                )
              : statement;
          },
        });
        const accounting = yield* make(f.options).pipe(
          Effect.provideService(SqlClient.SqlClient, wrapped),
        );
        yield* denied(
          accounting
            .reserve(f.principal, request())
            .pipe(Effect.provideService(SqlClient.SqlClient, wrapped)),
        );
        expect(insertReceipts).toBe(1);
        expect(yield* f.counts()).toEqual([{ budgets: 0, requests: 0 }]);
      }).pipe(Effect.provide(runtime(path))),
    ),
);

it.effect(
  "charges cumulative root usage and full unknown usage without resetting on children or replacement",
  () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.accounting.reserve(f.principal, request());
        yield* f.accounting.settle(unknown(first.reservationId));
        const second = yield* f.accounting.reserve(f.principal, request(2));
        yield* f.accounting.settle(unknown(second.reservationId, request(2)));
        yield* denied(f.accounting.reserve(f.principal, request(3)));
        for (const kind of ["child", "replacement"] as const) {
          const binding = yield* createManagedAssignment({
            taskId: ProjectWorkTaskId.make(kind + "-task"),
            recordId: kind + "-binding",
            attemptId: kind + "-attempt",
            commandId: kind + "-dispatch",
            providerInstanceId,
            threadId: ThreadId.make(kind + "-thread"),
            status: "running",
            role: f.role,
            configuration: f.binding.configuration,
            sessionId: kind + "-session",
            ...(kind === "child" ? { parentRunId: f.binding.recordId } : {}),
          });
          const authority = yield* f.auth.issueCredential({
            providerInstanceId,
            threadId: binding.threadId,
          });
          if (!authority) return yield* Effect.die("Missing fixture authority");
          const principal = {
            actor: {
              kind: "agent" as const,
              id: Authorization.managedActorId(authority.credential),
            },
            managed: authority.credential,
          };
          yield* f.sql`INSERT INTO model_operation_fixture VALUES (${binding.recordId},${kind + "-worker"},'prompt','root',500,10000)`;
          const reservation = { ...request(), workerId: kind + "-worker" };
          yield* denied(f.accounting.reserve(principal, reservation));
          if (kind === "child") {
            const smaller = { ...reservation, maxInputTokens: 50, maxOutputTokens: 50 };
            const receipt = yield* f.accounting.reserve(principal, smaller);
            yield* f.accounting.settle(reported(receipt.reservationId, smaller));
          }
        }
        yield* f.sql`UPDATE model_operation_fixture SET deadline_at_ms=20000`;
        yield* denied(f.accounting.reserve(f.principal, { ...request(3), deadlineAtMs: 20000 }));
        expect(
          yield* f.sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget`,
        ).toEqual([{ maximum_tokens: 500, deadline_at_ms: 10000 }]);
      }).pipe(Effect.provide(runtime(path))),
    ),
);

it.effect(
  "settles after revocation/deadline, upgrades reported charges once and rejects rewrites",
  () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const reservation = yield* f.accounting.reserve(f.principal, request());
        const report = reported(reservation.reservationId);
        const receipt = yield* f.accounting.settle(report);
        yield* f.change(decodeRecord({ ...f.binding, revision: 2, status: "stopping" }));
        yield* TestClock.setTime(20000);
        const failed: PiModelRequestSettlement = {
          ...report,
          outcome: "failed",
          chargedInputTokens: 100,
          chargedOutputTokens: 100,
          failureCode: "AUTHORIZATION_REJECTED",
        };
        expect(yield* f.accounting.settle(failed)).toEqual(receipt);
        expect(yield* f.accounting.settle(failed)).toEqual(receipt);
        yield* denied(f.accounting.settle(report));
        yield* denied(f.accounting.settle({ ...failed, outcome: "unknown" }));
        yield* denied(f.accounting.settle({ ...failed, chargedInputTokens: 0 }));
        yield* denied(f.accounting.settle({ ...failed, reservationId: "missing" }));
        yield* denied(f.accounting.settle({ ...failed, operationId: "changed" }));
        yield* denied(
          f.accounting.settle({
            ...failed,
            reportedUsage: { prompt_tokens: 11, completion_tokens: 20, total_tokens: 31 },
          }),
        );
        expect(
          yield* f.sql`SELECT status,charged_input_tokens,charged_output_tokens FROM project_team_model_request`,
        ).toEqual([{ status: "failed", charged_input_tokens: 100, charged_output_tokens: 100 }]);
      }).pipe(Effect.provide(runtime(path))),
    ),
);

it.effect("rejects invalid usage and missing or unsafe policy without losing the hold", () =>
  fileTest((path) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const maximumConcurrentCalls of [0, -1, 129, 1.5])
        yield* denied(make({ ...f.options, maximumConcurrentCalls }));
      yield* denied(make({ ...f.options, acceptedReportedModels: [] }));
      yield* denied(
        f.accounting.reserve(f.principal, {
          ...request(),
          maxInputTokens: Number.MAX_SAFE_INTEGER,
        }),
      );
      const reservation = yield* f.accounting.reserve(f.principal, request());
      const report = reported(reservation.reservationId);
      const invalidDrain = { ...report };
      Reflect.set(invalidDrain, "transportDrained", "true");
      yield* denied(f.accounting.settle(invalidDrain));
      for (const invalid of [
        { ...report, reportedModel: "other" },
        {
          ...report,
          reportedUsage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 31 },
        },
        {
          ...report,
          reportedUsage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
            prompt_cache_hit_tokens: 11,
          },
        },
        { ...report, chargedInputTokens: 11 },
      ])
        yield* denied(f.accounting.settle(invalid));
      expect(yield* f.sql`SELECT status FROM project_team_model_request`).toEqual([
        { status: "held" },
      ]);
    }).pipe(Effect.provide(runtime(path))),
  ),
);

it.effect(
  "retains journals across rebuild and file-backed restart with stable settlement receipts",
  () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const saved = yield* Effect.gen(function* () {
          const f = yield* fixture;
          const reservation = yield* f.accounting.reserve(f.principal, request());
          const settlement = unknown(reservation.reservationId);
          yield* f.change(decodeRecord({ ...f.binding, revision: 2, status: "stopping" }));
          const projection = yield* ProjectWorkProjection;
          yield* projection.rebuild(projectId);
          expect(yield* f.counts()).toEqual([{ budgets: 1, requests: 1 }]);
          const receipt = yield* f.accounting.settle(settlement);
          return { settlement, receipt, options: f.options };
        }).pipe(Effect.provide(Layer.fresh(runtime(path))));
        yield* Effect.gen(function* () {
          yield* runMigrations();
          const accounting = yield* make({
            ...saved.options,
            resolveOperation: () =>
              Effect.fail(new ModelAccountingError({ reason: "Revoked operation" })),
          });
          expect(yield* accounting.settle(saved.settlement)).toEqual(saved.receipt);
          const sql = yield* SqlClient.SqlClient;
          expect(
            yield* sql`SELECT charged_input_tokens,charged_output_tokens FROM project_team_model_request`,
          ).toEqual([{ charged_input_tokens: 100, charged_output_tokens: 100 }]);
        }).pipe(Effect.provide(Layer.fresh(runtime(path))));
      }),
    ),
);

const independentAccountingRows = (path: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const budgets = yield* sql`SELECT root_task_id FROM project_team_model_budget`;
    const requests =
      yield* sql`SELECT reservation_id,status,charged_input_tokens,charged_output_tokens,accounting_receipt_id FROM project_team_model_request`;
    return { budgets, requests };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: path, readonly: true })));

it.effect(
  "rejects reserve in an enclosing transaction before writes or dispatch permission escape",
  () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let escaped:
          | { readonly reservationId: string; readonly status: "reserved" | "existing" }
          | undefined;
        let dispatches = 0;
        const outer = yield* f.sql
          .withTransaction(
            Effect.gen(function* () {
              const result = yield* f.accounting.reserve(f.principal, request()).pipe(
                Effect.tap((receipt) =>
                  Effect.sync(() => {
                    escaped = receipt;
                    if (receipt.status === "reserved") dispatches++;
                  }),
                ),
                Effect.result,
              );
              expect(result._tag).toBe("Failure");
              expect(escaped).toBeUndefined();
              expect(dispatches).toBe(0);
              expect(yield* f.counts()).toEqual([{ budgets: 0, requests: 0 }]);
              expect(yield* independentAccountingRows(path)).toEqual({ budgets: [], requests: [] });
              return yield* Effect.fail("fixture outer rollback");
            }),
          )
          .pipe(Effect.result);
        expect(outer._tag).toBe("Failure");
        expect(yield* independentAccountingRows(path)).toEqual({ budgets: [], requests: [] });
        const reservation = yield* f.accounting.reserve(f.principal, request());
        expect(reservation.status).toBe("reserved");
        expect((yield* independentAccountingRows(path)).requests).toEqual([
          {
            reservation_id: reservation.reservationId,
            status: "held",
            charged_input_tokens: 0,
            charged_output_tokens: 0,
            accounting_receipt_id: null,
          },
        ]);
        expect(yield* f.accounting.reserve(f.principal, request())).toEqual({
          ...reservation,
          status: "existing",
        });
      }).pipe(Effect.provide(runtime(path))),
    ),
);

it.effect(
  "rejects settle in an enclosing transaction before writes or an accounting receipt escapes",
  () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const reservation = yield* f.accounting.reserve(f.principal, request());
        const settlement = unknown(reservation.reservationId);
        const before = yield* independentAccountingRows(path);
        let escaped: { readonly accountingReceiptId: string } | undefined;
        const outer = yield* f.sql
          .withTransaction(
            Effect.gen(function* () {
              const result = yield* f.accounting.settle(settlement).pipe(
                Effect.tap((receipt) =>
                  Effect.sync(() => {
                    escaped = receipt;
                  }),
                ),
                Effect.result,
              );
              expect(result._tag).toBe("Failure");
              expect(escaped).toBeUndefined();
              expect(
                yield* f.sql`SELECT status,accounting_receipt_id FROM project_team_model_request`,
              ).toEqual([{ status: "held", accounting_receipt_id: null }]);
              expect(yield* independentAccountingRows(path)).toEqual(before);
              return yield* Effect.fail("fixture outer rollback");
            }),
          )
          .pipe(Effect.result);
        expect(outer._tag).toBe("Failure");
        expect(yield* independentAccountingRows(path)).toEqual(before);
        const receipt = yield* f.accounting.settle(settlement);
        expect((yield* independentAccountingRows(path)).requests).toEqual([
          {
            reservation_id: reservation.reservationId,
            status: "unknown",
            charged_input_tokens: 100,
            charged_output_tokens: 100,
            accounting_receipt_id: receipt.accountingReceiptId,
          },
        ]);
        expect(yield* f.accounting.settle(settlement)).toEqual(receipt);
      }).pipe(Effect.provide(runtime(path))),
    ),
);

for (const failureCode of [
  ...[401, 403, 429, 500].map((status) => `TRANSPORT_RESPONSE_HTTP_${status}` as const),
  "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING",
  "TRANSPORT_RESPONSE_CONTENT_TYPE_JSON",
  "TRANSPORT_RESPONSE_CONTENT_TYPE_HTML",
  "TRANSPORT_RESPONSE_CONTENT_TYPE_TEXT",
  "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_JSON_PREFIX",
  "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_HTML_PREFIX",
  "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_SSE_MARKER_PREFIX",
  "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_OTHER_PREFIX",
  "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_EMPTY",
] as const)
  it.effect(`retains bounded response diagnostic accounting ${failureCode}`, () =>
    fileTest((path) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const reservation = yield* f.accounting.reserve(f.principal, request());
        const value = {
          ...unknown(reservation.reservationId),
          failureCode,
          transportDrained: false,
        };
        const receipt = yield* f.accounting.settle(value);
        expect(yield* f.accounting.settle(value)).toEqual(receipt);
        const rows = yield* f.sql<{
          settlement_json: string;
          capacity_state: string;
          charged_input_tokens: number;
          charged_output_tokens: number;
        }>`SELECT settlement_json,capacity_state,charged_input_tokens,charged_output_tokens FROM project_team_model_request WHERE reservation_id=${reservation.reservationId}`;
        expect(yield* decodeFixtureJson(rows[0]!.settlement_json)).toMatchObject({ failureCode });
        expect(rows[0]).toMatchObject({
          capacity_state: "quarantine",
          charged_input_tokens: 100,
          charged_output_tokens: 100,
        });
      }).pipe(Effect.provide(runtime(path))),
    ),
  );

it.effect("rejects unbounded or unrelated numeric accounting diagnostics", () =>
  fileTest((path) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const reservation = yield* f.accounting.reserve(f.principal, request());
      for (const failureCode of [
        "TRANSPORT_RESPONSE_HTTP_099",
        "TRANSPORT_RESPONSE_HTTP_600",
        "TRANSPORT_RESPONSE_HTTP_401_SECRET",
        "ERROR_123",
        "Bearer secret",
        "A".repeat(65),
      ])
        yield* denied(
          f.accounting.settle({
            ...unknown(reservation.reservationId),
            failureCode: failureCode as NonNullable<PiModelRequestSettlement["failureCode"]>,
          }),
        );
      expect(
        yield* f.sql`SELECT status,capacity_state FROM project_team_model_request WHERE reservation_id=${reservation.reservationId}`,
      ).toEqual([{ status: "held", capacity_state: "held" }]);
      yield* f.accounting.settle({
        ...unknown(reservation.reservationId),
        failureCode: "TRANSPORT_RESPONSE_REJECTED",
      });
    }).pipe(Effect.provide(runtime(path))),
  ),
);
