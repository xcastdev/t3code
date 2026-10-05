import {
  EnvironmentId,
  ProjectId,
  ProjectTeamRecord,
  ProjectTeamSupervisionSummary,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { runMigrations, runForkMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import { seed } from "./ProjectTeamAuthorization.testFixtures.ts";
import * as Briefing from "./ProjectWorkBriefing.ts";
import * as Gateway from "./ProjectWorkGateway.ts";
import * as Narrative from "./ProjectWorkNarrative.ts";
import * as Projection from "./ProjectWorkProjection.ts";
import * as Query from "./ProjectWorkQuery.ts";
import * as Repository from "./ProjectWorkRepository.ts";
import * as Search from "./ProjectWorkSearch.ts";
import { persistProjectTeamProjections } from "./ProjectTeamsPersistence.ts";

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("supervision-project");
const principal = { actor: { kind: "human", id: "fixture-human" } } as const;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRecord = Schema.decodeUnknownEffect(ProjectTeamRecord);
const isAuthorizationError = Schema.is(Authorization.ProjectTeamAuthorizationError);
const decodeWire = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectTeamSupervisionSummary));
const services = Layer.mergeAll(
  Authorization.layer,
  Repository.ProjectWorkRepositoryLive,
  Projection.ProjectWorkProjectionLive,
  Query.ProjectWorkQueryLive,
  Search.ProjectWorkSearchLive,
  Narrative.ProjectWorkNarrativeLive,
  Briefing.ProjectWorkBriefingLive.pipe(Layer.provide(Query.ProjectWorkQueryLive)),
);
const auth = EnvironmentAuth.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-supervision-gateway-" })),
);
const runtime = (enabled = true) =>
  Gateway.ProjectWorkGatewayLive.pipe(
    Layer.provideMerge(services),
    Layer.provideMerge(auth),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettings.layerTest({ projectWorkEnabled: enabled })),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture-environment")),
      }),
    ),
  );
const fixture = Effect.fn("supervisionGatewayFixture")(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Project','/disposable','[]',${at},${at})`;
  yield* sql`INSERT INTO project_work_events(event_id,project_id,event_type,occurred_at,command_id,payload_json)
    VALUES ('fixture',${projectId},'fixture',${at},'fixture',${yield* encodeJson({ projectId, revision: 20 })})`;
  return sql;
});
const read = Effect.fn("readSupervisionWire")(function* (id = projectId) {
  const gateway = yield* Gateway.ProjectWorkGateway;
  const response = yield* gateway.read({ projectId: id, operation: "supervision" }, principal);
  return yield* decodeWire(yield* encodeJson(response));
});

it.layer(NodeServices.layer)("ProjectTeamSupervisionGateway", (it) => {
  it.effect(
    "reads real migrated metadata through the public wire codec without private bodies",
    () =>
      Effect.gen(function* () {
        const sql = yield* fixture();
        for (const [id, state] of [
          ["ready-task", "ready"],
          ["unknown-task", "future"],
        ] as const) {
          yield* sql`INSERT INTO project_work_tasks(task_id,project_id,title,state,revision,spec_revision,created_at,updated_at)
          VALUES (${id},${projectId},'PRIVATE TASK BODY',${state},1,1,${at},${at})`;
        }
        const records = [];
        for (let i = 0; i < 7; i++)
          records.push(
            yield* decodeRecord({
              kind: "mission",
              recordId: `mission-${i}`,
              projectId,
              revision: 1,
              generation: 0,
              updatedAt: at,
              status: "active",
              title: "Mission",
              objective: "PRIVATE OBJECTIVE",
              requiredTaskIds: [],
            }),
          );
        yield* persistProjectTeamProjections(sql, projectId, records, []);
        const value = yield* read();
        expect(value.availability).toBe("available");
        if (value.availability !== "available") return yield* Effect.die("Expected summary");
        expect(value.revision).toBe(20);
        expect(value.taskCounts.ready).toBe(1);
        expect(value.taskCounts.unknown).toBe(1);
        expect(value.taskCounts.total).toBe(2);
        expect(value.missions.items).toHaveLength(5);
        expect(value.missions.hasMore).toBe(true);
        const wire = yield* encodeJson(value);
        expect(wire).not.toContain("PRIVATE");
        expect(wire).not.toContain("objective");
        expect(wire).not.toContain("requiredTaskIds");
      }).pipe(Effect.provide(runtime())),
  );

  it.effect("redacts retained secrets in metadata before returning the summary", () =>
    Effect.gen(function* () {
      const sql = yield* fixture();
      const record = yield* decodeRecord({
        kind: "mission",
        recordId: "mission",
        projectId,
        revision: 1,
        generation: 0,
        updatedAt: at,
        status: "active",
        title: "Bearer abcdefghijklmnopqrstuvwxyz123456",
        objective: "private",
        requiredTaskIds: [],
      });
      yield* persistProjectTeamProjections(sql, projectId, [record], []);
      const wire = yield* encodeJson(yield* read());
      expect(wire).toContain("REDACTED_SECRET");
      expect(wire).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    }).pipe(Effect.provide(runtime())),
  );

  it.effect("returns missing for an unknown project", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const missing = ProjectId.make("missing-project");
      expect(yield* read(missing)).toEqual({ projectId: missing, availability: "missing" });
    }).pipe(Effect.provide(runtime())),
  );

  for (const availability of ["deleted", "archived", "tombstoned", "unsupported"] as const) {
    it.effect(`returns only availability for ${availability} projects`, () =>
      Effect.gen(function* () {
        const sql = yield* fixture();
        if (availability === "deleted") {
          yield* sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id=${projectId}`;
        } else {
          if (availability === "unsupported") yield* sql`PRAGMA ignore_check_constraints=ON`;
          yield* sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at)
            VALUES (${projectId},${availability === "unsupported" ? "future" : availability},'/disposable',3,${at})`;
        }
        expect(yield* read()).toEqual({ projectId, availability });
      }).pipe(Effect.provide(runtime())),
    );
  }

  it.effect("returns unsupported while disabled without touching project projections", () =>
    Effect.gen(function* () {
      // Deliberately no migrations: querying project tables would fail.
      expect(yield* read()).toEqual({ projectId, availability: "unsupported" });
    }).pipe(Effect.provide(runtime(false))),
  );

  it.effect("keeps invalid revision history a typed failure rather than an empty success", () =>
    Effect.gen(function* () {
      const sql = yield* fixture();
      yield* sql`UPDATE project_work_events SET payload_json=${yield* encodeJson({ projectId, revision: -1 })} WHERE project_id=${projectId}`;
      const result = yield* read().pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          _tag: "PersistenceSqlError",
          operation: "ProjectWorkGateway.read",
          cause: { _tag: "PersistenceDecodeError" },
        });
    }).pipe(Effect.provide(runtime())),
  );

  for (const enabled of [true, false]) {
    it.effect(
      `does not grant managed coordinators supervision authority when enabled=${enabled}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* seed("coordinator");
          yield* runForkMigrations();
          const gateway = yield* Gateway.ProjectWorkGateway;
          const result = yield* gateway
            .read(
              { projectId: fixture.binding.projectId, operation: "supervision" },
              fixture.principal,
            )
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(isAuthorizationError(result.failure)).toBe(true);
        }).pipe(Effect.provide(runtime(enabled))),
    );
  }
});
