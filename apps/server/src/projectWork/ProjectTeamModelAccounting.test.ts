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
  outcome: "unknown",
  chargedInputTokens: reservation.maxInputTokens,
  chargedOutputTokens: reservation.maxOutputTokens,
});
const reported = (reservationId: string, reservation = request()): PiModelRequestSettlement => ({
  ...reservation,
  reservationId,
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
