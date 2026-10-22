import { assert, it } from "@effect/vitest";
import { CommandId, McpDefinitionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { AssistantNativeResources, layer } from "./AssistantNativeResources.ts";
import { AssistantRepository } from "./AssistantRepository.ts";
import { input, configuration, repository } from "./AssistantTestHelpers.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
it.effect("native tools require both retained run selection and current assistant selection", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,deleted_at TEXT,archived_at TEXT,payload_json TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,provider_thread_id TEXT,status TEXT,ordinal INTEGER)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT,thread_id TEXT,provider_session_id TEXT)`;
    yield* sql`CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT)`;
    const repo = yield* AssistantRepository;
    const record = yield* repo.create({
      ...input,
      configuration: {
        ...configuration,
        resources: {
          ...configuration.resources,
          mcpTools: [
            { definitionId: McpDefinitionId.make("definition"), toolNames: ["read", "write"] },
          ],
        },
      },
    });
    const binding = record.detail.summary.binding;
    yield* repo.setProvisioning(binding, { state: "ready", binding }, "/owned");
    yield* sql`INSERT INTO projection_projects VALUES(${binding.backingProjectId},'/owned',NULL)`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES(${binding.canonicalThreadId},${binding.backingProjectId},NULL,NULL,'{}')`;
    yield* sql`INSERT INTO t3_workflow_v2_assistant_admissions VALUES(${binding.canonicalThreadId},'run',${binding.assistantId},0,${encode({ snapshot: { configurationHash: "config", resourceRevision: "resources", memoryEpoch: 0, roleInstructions: "rules", toolIds: ["definition:read"], skillIds: [] } })},'2026-01-01')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES('run',${binding.canonicalThreadId},'provider-thread','running',1)`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES('provider-thread',${binding.canonicalThreadId},'native')`;
    const policy = yield* AssistantNativeResources;
    assert.deepEqual(yield* policy.tools(binding.canonicalThreadId, "native"), ["definition:read"]);
    assert.equal(yield* policy.tools(ThreadId.make("ordinary"), "ordinary-native"), undefined);
    yield* sql`INSERT INTO t3_workflow_v2_assistant_admissions VALUES(${binding.canonicalThreadId},'queued',${binding.assistantId},0,${encode({ snapshot: { configurationHash: "queued", resourceRevision: "resources", memoryEpoch: 0, roleInstructions: "rules", toolIds: ["definition:write"], skillIds: [] } })},'2026-01-02')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES('queued',${binding.canonicalThreadId},'provider-thread','queued',2)`;
    assert.deepEqual(yield* policy.tools(binding.canonicalThreadId, "native"), ["definition:read"]);
    yield* sql`UPDATE projection_projects SET workspace_root='/changed'`;
    assert.deepEqual(yield* policy.tools(binding.canonicalThreadId, "native"), []);
    yield* sql`UPDATE projection_projects SET workspace_root='/owned'`;
    const child = ThreadId.make("retained-child");
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES(${child},${binding.backingProjectId},NULL,NULL,${encode({ lineage: { parentThreadId: binding.canonicalThreadId } })})`;
    yield* sql`INSERT INTO t3_workflow_v2_assistant_admissions SELECT ${child},'child-run',assistant_id,configuration_revision,configuration_json,created_at FROM t3_workflow_v2_assistant_admissions WHERE run_id='run'`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES('child-run',${child},'child-provider-thread','running',1)`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES('child-provider-thread',${child},'child-native')`;
    assert.deepEqual(yield* policy.tools(child, "child-native"), ["definition:read"]);
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json='{"lineage":{"parentThreadId":null}}' WHERE thread_id=${child}`;
    assert.deepEqual(yield* policy.tools(child, "child-native"), []);
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${encode({ lineage: { parentThreadId: binding.canonicalThreadId } })} WHERE thread_id=${child}`;
    assert.deepEqual(yield* policy.tools(child, "child-native"), ["definition:read"]);
    yield* sql`UPDATE orchestration_v2_projection_threads SET project_id='ordinary' WHERE thread_id=${child}`;
    assert.deepEqual(yield* policy.tools(child, "child-native"), []);
    yield* repo.updateConfiguration({
      ...binding,
      commandId: CommandId.make("revoke-tools"),
      expectedRevision: record.detail.configuration.revision,
      configuration: {
        ...configuration,
        resources: {
          ...configuration.resources,
          mcpTools: [{ definitionId: McpDefinitionId.make("definition"), toolNames: ["write"] }],
        },
      },
    });
    assert.deepEqual(yield* policy.tools(binding.canonicalThreadId, "native"), []);
    yield* sql`UPDATE t3_workflow_v2_assistants SET payload_json='broken'`;
    assert.deepEqual(yield* policy.tools(binding.canonicalThreadId, "native"), []);
  }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(repository)))),
);
