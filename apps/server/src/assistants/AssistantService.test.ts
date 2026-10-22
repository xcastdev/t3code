import { assert, it } from "@effect/vitest";
import { AssistantConfigurationRevision, CommandId, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Repository from "./AssistantRepository.ts";
import * as Ownership from "./AssistantOwnership.ts";
import * as Service from "./AssistantService.ts";
import * as Provisioning from "./AssistantProvisioning.ts";

import { environmentId, configuration, input, repository } from "./AssistantTestHelpers.ts";
const layer = Service.layer.pipe(
  Layer.provideMerge(Ownership.layer),
  Layer.provideMerge(
    Layer.succeed(Provisioning.AssistantProvisioning, {
      ensure: (record) => Effect.succeed(record),
      reconcile: (record) => Effect.succeed(record),
    }),
  ),
  Layer.provideMerge(repository),
);

it.effect(
  "simultaneous creates reserve one stable home and configuration edits never retire memory ownership",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.AssistantService;
      const repo = yield* Repository.AssistantRepository;
      const owner = yield* Ownership.AssistantOwnership;
      const created = yield* Effect.all([service.create(input), service.create(input)], {
        concurrency: "unbounded",
      });
      assert.equal(created[0].summary.assistantId, created[1].summary.assistantId);
      const summary = created[0].summary;
      assert.equal(
        (yield* service.list({ environmentId, includeArchived: true, limit: 100 })).assistants
          .length,
        1,
      );
      assert.equal(
        (yield* owner.byProject(summary.binding.backingProjectId))?.detail.summary.assistantId,
        summary.assistantId,
      );
      assert.equal(
        (yield* owner.byThread(summary.binding.canonicalThreadId))?.detail.summary.assistantId,
        summary.assistantId,
      );
      const changed = yield* service.updateConfiguration({
        ...summary,
        commandId: CommandId.make("config"),
        expectedRevision: summary.configurationRevision,
        configuration: { ...configuration, name: "Renamed" },
      });
      assert.equal(changed.configuration.revision, 1);
      assert.equal((yield* repo.get(summary)).ownerRevision, 0);
      yield* owner.assertCurrent({
        environmentId,
        owner: { kind: "assistant", assistantId: summary.assistantId },
        ownerRevision: 0,
      });
      const stale = yield* service
        .updateConfiguration({
          ...summary,
          commandId: CommandId.make("stale"),
          expectedRevision: AssistantConfigurationRevision.make(0),
          configuration,
        })
        .pipe(Effect.result);
      assert.equal(stale._tag, "Failure");
      const replay = yield* service.updateConfiguration({
        ...summary,
        commandId: CommandId.make("config"),
        expectedRevision: summary.configurationRevision,
        configuration: { ...configuration, name: "Renamed" },
      });
      assert.equal(replay.configuration.revision, 1);
      const archived = yield* service.lifecycle({
        ...summary,
        commandId: CommandId.make("archive"),
        expectedRevision: changed.configuration.revision,
        action: "archive",
      });
      assert.equal(archived.summary.lifecycle, "archived");
      assert.isNotNull(yield* owner.byProject(summary.binding.backingProjectId));
      assert.equal(
        (yield* service.list({ environmentId, includeArchived: false, limit: 100 })).assistants
          .length,
        0,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "command reuse with another payload and cross-environment requests fail without creating records",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.AssistantService;
      yield* service.create(input);
      assert.equal(
        (yield* service
          .create({ ...input, configuration: { ...configuration, name: "Other" } })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* service
          .create({ ...input, environmentId: EnvironmentId.make("foreign") })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_assistants`).length, 1);
      assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_assistant_admissions`).length, 0);
    }).pipe(Effect.provide(layer)),
);
