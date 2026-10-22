import { assert, it } from "@effect/vitest";
import {
  AssistantConfigurationRevision,
  CommandId,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Environment from "../environment/ServerEnvironment.ts";
import * as Repository from "./AssistantRepository.ts";
import * as OwnerRead from "./AssistantThreadOwnerRead.ts";
import { configuration, environmentId, input, repository } from "./AssistantTestHelpers.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const layer = OwnerRead.layer.pipe(
  Layer.provideMerge(repository),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("unused"),
    }),
  ),
);
const createProjectionTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT,deleted_at TEXT,archived_at TEXT,payload_json TEXT)`;
  yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
});

it.effect(
  "resolves the exact home beyond the first roster page and returns the current archived configuration revision",
  () =>
    Effect.gen(function* () {
      const repo = yield* Repository.AssistantRepository;
      const read = yield* OwnerRead.AssistantThreadOwnerRead;
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.forEach(
        Array.from({ length: 103 }, (_, index) => index),
        (index) =>
          repo.create({
            ...input,
            commandId: CommandId.make(`create-${index}`),
          }),
        { discard: true },
      );
      const firstPage = yield* repo.list({ environmentId, includeArchived: true, limit: 100 });
      const tail = yield* repo.list({
        environmentId,
        includeArchived: true,
        limit: 100,
        cursor: firstPage[99]!.detail.summary.assistantId,
      });
      const target = tail[2]!;
      const binding = target.detail.summary.binding;
      assert.isFalse(
        firstPage.some((record) => record.detail.summary.assistantId === binding.assistantId),
      );
      yield* repo.updateConfiguration({
        ...binding,
        commandId: CommandId.make("configure-tail"),
        expectedRevision: AssistantConfigurationRevision.make(0),
        configuration: { ...configuration, name: "Current tail" },
      });
      const archived = yield* repo.lifecycle({
        ...binding,
        commandId: CommandId.make("archive-tail"),
        expectedRevision: AssistantConfigurationRevision.make(1),
        action: "archive",
      });
      yield* repo.setProvisioning(binding, {
        state: "needs-repair",
        binding,
        reason: "Retained home changed.",
      });
      const commandCount = (yield* sql`SELECT command_id FROM t3_workflow_v2_assistant_commands`)
        .length;
      assert.deepStrictEqual(
        yield* read.resolve({ environmentId, threadId: binding.canonicalThreadId }),
        {
          environmentId,
          threadId: binding.canonicalThreadId,
          assistantId: binding.assistantId,
          backingProjectId: binding.backingProjectId,
          canonicalThreadId: binding.canonicalThreadId,
          configurationRevision: archived.detail.summary.configurationRevision,
          lifecycle: "archived",
          provisioningState: "needs-repair",
          isCanonicalHome: true,
        },
      );
      assert.equal(
        (yield* sql`SELECT command_id FROM t3_workflow_v2_assistant_commands`).length,
        commandCount,
      );
      assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_assistant_admissions`).length, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "children require current retained lineage and a live backing home; ordinary or detached conversations never inherit ownership",
  () =>
    Effect.gen(function* () {
      yield* createProjectionTables;
      const repo = yield* Repository.AssistantRepository;
      const read = yield* OwnerRead.AssistantThreadOwnerRead;
      const sql = yield* SqlClient.SqlClient;
      const record = yield* repo.create(input);
      const binding = record.detail.summary.binding;
      yield* repo.setProvisioning(binding, { state: "ready", binding }, "/owned");
      yield* sql`INSERT INTO projection_projects VALUES(${binding.backingProjectId},'/owned',NULL)`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES(${binding.canonicalThreadId},${binding.backingProjectId},NULL,NULL,${encode({ lineage: { parentThreadId: null } })})`;
      const child = ThreadId.make("current-child");
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES(${child},${binding.backingProjectId},NULL,NULL,${encode({ lineage: { parentThreadId: binding.canonicalThreadId } })})`;
      const resolved = yield* read.resolve({ environmentId, threadId: child });
      assert.equal(resolved?.assistantId, binding.assistantId);
      assert.equal(resolved?.isCanonicalHome, false);
      const ordinary = ThreadId.make("ordinary-in-backing-project");
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES(${ordinary},${binding.backingProjectId},NULL,NULL,${encode({ lineage: { parentThreadId: null } })})`;
      assert.isNull(yield* read.resolve({ environmentId, threadId: ordinary }));
      assert.isNull(yield* read.resolve({ environmentId, threadId: ThreadId.make("unknown") }));
      yield* sql`INSERT INTO t3_workflow_v2_assistant_admissions VALUES(${child},'retained-child-run',${binding.assistantId},0,'{}','2026-10-21')`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${encode({ lineage: { parentThreadId: null } })} WHERE thread_id=${child}`;
      assert.isNull(yield* read.resolve({ environmentId, threadId: child }));
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${encode({ lineage: { parentThreadId: child } })} WHERE thread_id=${child}`;
      assert.isNull(yield* read.resolve({ environmentId, threadId: child }));
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${encode({ lineage: { parentThreadId: binding.canonicalThreadId } })} WHERE thread_id=${child}`;
      yield* sql`UPDATE projection_projects SET workspace_root='/rebound'`;
      assert.isNull(yield* read.resolve({ environmentId, threadId: child }));
      yield* sql`UPDATE projection_projects SET workspace_root='/owned'`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at='2026-10-22' WHERE thread_id=${binding.canonicalThreadId}`;
      assert.isNull(yield* read.resolve({ environmentId, threadId: child }));
      assert.equal(
        (yield* read.resolve({ environmentId, threadId: binding.canonicalThreadId }))
          ?.isCanonicalHome,
        true,
      );
      const foreign = yield* read
        .resolve({
          environmentId: EnvironmentId.make("other-environment"),
          threadId: binding.canonicalThreadId,
        })
        .pipe(Effect.result);
      assert.equal(foreign._tag, "Failure");
      if (foreign._tag === "Failure") assert.equal(foreign.failure.reason, "forbidden");
    }).pipe(Effect.provide(layer)),
);

it.effect("conflicting retained owners fail closed instead of choosing one assistant", () =>
  Effect.gen(function* () {
    yield* createProjectionTables;
    const repo = yield* Repository.AssistantRepository;
    const read = yield* OwnerRead.AssistantThreadOwnerRead;
    const sql = yield* SqlClient.SqlClient;
    const first = yield* repo.create(input);
    const second = yield* repo.create({ ...input, commandId: CommandId.make("second-owner") });
    const threadId = ThreadId.make("ambiguous-child");
    for (const record of [first, second])
      yield* sql`INSERT INTO t3_workflow_v2_assistant_admissions VALUES(${threadId},${record.detail.summary.assistantId},${record.detail.summary.assistantId},0,'{}','2026-10-21')`;
    const result = yield* read.resolve({ environmentId, threadId }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "conflict");
  }).pipe(Effect.provide(layer)),
);
