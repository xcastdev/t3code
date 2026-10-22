import { memoryOwnerEquals, MemoryProcessingConfiguration } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../../environment/ServerEnvironment.ts";
import { ProjectMemoryError, ownerId, type MemoryScope } from "./ProjectMemoryRepository.ts";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(MemoryProcessingConfiguration));
const encode = Schema.encodeEffect(Schema.fromJsonString(MemoryProcessingConfiguration));
const isMemoryError = Schema.is(ProjectMemoryError);
const unavailable = (cause: unknown) =>
  isMemoryError(cause) ? cause : new ProjectMemoryError({ reason: "unavailable", cause });
export class ProjectMemoryConfiguration extends Context.Service<
  ProjectMemoryConfiguration,
  {
    readonly read: (
      scope: MemoryScope,
    ) => Effect.Effect<
      { readonly revision: number; readonly configuration: MemoryProcessingConfiguration },
      ProjectMemoryError
    >;
    readonly set: (
      scope: MemoryScope,
      expectedRevision: number,
      configuration: MemoryProcessingConfiguration,
    ) => Effect.Effect<number, ProjectMemoryError>;
  }
>()("t3/projectWork/memory/ProjectMemoryConfiguration") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environment = yield* Environment.ServerEnvironment;
  const assertScope = Effect.fn("ProjectMemoryConfiguration.assertScope")(function* (
    scope: MemoryScope,
  ) {
    if (scope.environmentId !== (yield* environment.getEnvironmentId))
      return yield* new ProjectMemoryError({ reason: "forbidden" });
    const rows = yield* sql<{
      revision: number;
      deleted: number;
    }>`SELECT revision,deleted FROM t3_workflow_v2_memory_owners WHERE environment_id=${scope.environmentId} AND owner_kind=${scope.owner.kind} AND owner_id=${ownerId(scope.owner)}`;
    if ((rows[0]?.revision ?? 0) !== scope.ownerRevision || rows[0]?.deleted === 1)
      return yield* new ProjectMemoryError({ reason: "stale" });
  });
  const read = Effect.fn("ProjectMemoryConfiguration.read")(function* (scope: MemoryScope) {
    yield* assertScope(scope);
    const row = (yield* sql<{
      payload_json: string;
      revision: number;
    }>`SELECT payload_json,revision FROM t3_workflow_v2_memory_configuration WHERE environment_id=${scope.environmentId} AND owner_kind=${scope.owner.kind} AND owner_id=${ownerId(scope.owner)} AND owner_revision=${scope.ownerRevision}`)[0];
    return row
      ? { revision: row.revision, configuration: yield* decode(row.payload_json) }
      : { revision: 0, configuration: {} };
  }, Effect.mapError(unavailable));
  const set = Effect.fn("ProjectMemoryConfiguration.set")(function* (
    scope: MemoryScope,
    expectedRevision: number,
    configuration: MemoryProcessingConfiguration,
  ) {
    const payload = yield* encode(configuration);
    const validated = yield* decode(payload);
    for (const route of [validated.extractionRoute, validated.destination?.embeddingRoute]) {
      if (
        route &&
        (route.environmentId !== scope.environmentId ||
          !memoryOwnerEquals(route.owner, scope.owner))
      )
        return yield* new ProjectMemoryError({ reason: "forbidden" });
    }
    const write = Effect.gen(function* () {
      yield* assertScope(scope);
      const existing = yield* read(scope);
      if (existing.revision !== expectedRevision)
        return yield* new ProjectMemoryError({ reason: "stale" });
      const rows =
        yield* sql`INSERT INTO t3_workflow_v2_memory_configuration(environment_id,owner_kind,owner_id,owner_revision,payload_json,revision) VALUES(${scope.environmentId},${scope.owner.kind},${ownerId(scope.owner)},${scope.ownerRevision},${payload},1) ON CONFLICT(environment_id,owner_kind,owner_id,owner_revision) DO UPDATE SET payload_json=excluded.payload_json,revision=revision+1 WHERE revision=${expectedRevision} RETURNING revision`;
      if (rows.length !== 1 || expectedRevision < 0 || !Number.isSafeInteger(expectedRevision))
        return yield* new ProjectMemoryError({ reason: "stale" });
    });
    const transaction = yield* Effect.serviceOption(sql.transactionService);
    yield* transaction._tag === "Some" ? write : sql.withTransaction(write);
    return expectedRevision + 1;
  }, Effect.mapError(unavailable));
  return ProjectMemoryConfiguration.of({ read, set });
});
export const layer = Layer.effect(ProjectMemoryConfiguration, make);
