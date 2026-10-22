import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Configuration from "./ProjectMemoryConfiguration.ts";
const scope = {
  environmentId: EnvironmentId.make("env"),
  owner: { kind: "project" as const, projectId: ProjectId.make("project") },
  ownerRevision: 0,
};
const layer = Configuration.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(scope.environmentId),
      getDescriptor: Effect.die("unused"),
    }),
  ),
);
it.effect(
  "defaults every owner to native/off and uses configuration CAS inside the caller transaction",
  () =>
    Effect.gen(function* () {
      const configuration = yield* Configuration.ProjectMemoryConfiguration;
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* configuration.read(scope), { revision: 0, configuration: {} });
      assert.equal(yield* sql.withTransaction(configuration.set(scope, 0, {})), 1);
      assert.equal((yield* configuration.set(scope, 0, {}).pipe(Effect.result))._tag, "Failure");
      assert.equal(yield* configuration.set(scope, 1, {}), 2);
      assert.deepStrictEqual(yield* configuration.read(scope), { revision: 2, configuration: {} });
    }).pipe(Effect.provide(layer)),
);
it.effect("refuses foreign route authority and stale owner revisions", () =>
  Effect.gen(function* () {
    const configuration = yield* Configuration.ProjectMemoryConfiguration;
    const sql = yield* SqlClient.SqlClient;
    assert.equal(
      (yield* configuration
        .set(scope, 0, {
          extractionRoute: {
            environmentId: scope.environmentId,
            owner: { kind: "project", projectId: ProjectId.make("other") },
            enabled: true,
            provider: "command-code",
            endpoint: "https://example.test/chat",
            model: "chosen",
            secretName: "memory-key",
          },
        })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    yield* sql`INSERT INTO t3_workflow_v2_memory_owners VALUES('env','project','project',1,0)`;
    assert.equal((yield* configuration.set(scope, 0, {}).pipe(Effect.result))._tag, "Failure");
    assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_memory_configuration`).length, 0);
  }).pipe(Effect.provide(layer)),
);
