import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/unstable/http";
import {
  CommandId,
  ProjectWorkAttemptId,
  ProjectWorkCriterionId,
  ProjectId,
  ProjectWorkTaskId,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Environment from "../environment/ServerEnvironment.ts";

import { ProjectWorkQuery } from "./ProjectWorkQuery.ts";
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
