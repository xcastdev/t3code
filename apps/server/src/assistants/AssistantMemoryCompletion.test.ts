import { assert, it } from "@effect/vitest";
import { AssistantId, CommandId, EnvironmentId, MessageId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { sourceTuple } from "../projectWork/memory/ProjectMemoryRepository.ts";
import { AssistantRepository } from "./AssistantRepository.ts";
import { input } from "./AssistantTestHelpers.ts";
import { fixture, seed } from "./AssistantMemory.test-utils.ts";

it.effect(
  "empty assistant and project recipients have authoritative revision metadata and accept explicit grants",
  () =>
    Effect.gen(function* () {
      const { memory, evidence } = yield* seed();
      const repository = yield* AssistantRepository;
      const empty = yield* repository.create({
        ...input,
        commandId: CommandId.make("empty-recipient"),
      });
      const recipient = {
        kind: "assistant" as const,
        assistantId: empty.detail.summary.assistantId,
      };
      const metadata = yield* memory.recipientMetadata({
        environmentId: evidence.environmentId,
        owner: recipient,
      });
      assert.equal(metadata.ownerRevision, 0);
      const first = yield* memory.capture(evidence);
      yield* memory.process(first.operationKey);
      const grant = {
        environmentId: evidence.environmentId,
        ownerRevision: 0,
        source: {
          owner: first.source.owner,
          sourceId: first.source.sourceId,
          sourceRevision: first.source.sourceRevision,
        },
        recipient,
        recipientRevision: metadata.ownerRevision,
      };
      yield* memory.grant(grant);
      assert.include((yield* memory.context(empty)).text, "dark editor");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_memory_sources WHERE owner_id=${recipient.assistantId}`)[0]
          ?.n,
        0,
      );
      yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace_root TEXT NOT NULL,default_model_selection_json TEXT,default_thread_env_mode TEXT,auto_pull INTEGER NOT NULL DEFAULT 0,favicon_path TEXT,project_icon_json TEXT,scripts_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT)`;
      const project = { kind: "project" as const, projectId: ProjectId.make("empty-project") };
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,created_at,updated_at) VALUES(${project.projectId},'Empty project','/tmp/empty-project',${evidence.settledAt},${evidence.settledAt})`;
      const projectMetadata = yield* memory.recipientMetadata({
        environmentId: evidence.environmentId,
        owner: project,
      });
      assert.equal(projectMetadata.title, "Empty project");
      yield* memory.grant({
        ...grant,
        recipient: project,
        recipientRevision: projectMetadata.ownerRevision,
      });
      assert.equal(
        (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_memory_grants WHERE recipient_kind='project'`)[0]
          ?.n,
        1,
      );
      yield* sql`INSERT INTO t3_workflow_v2_memory_owners VALUES(${evidence.environmentId},'project',${project.projectId},1,0)`;
      assert.equal(
        (yield* Effect.result(
          memory.grant({
            ...grant,
            recipient: project,
            recipientRevision: projectMetadata.ownerRevision,
          }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          memory.recipientMetadata({
            environmentId: EnvironmentId.make("foreign"),
            owner: project,
          }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          memory.recipientMetadata({
            environmentId: evidence.environmentId,
            owner: { kind: "project", projectId: empty.detail.summary.binding.backingProjectId },
          }),
        ))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "a reviewed fresh pending source can be confirmed without clearing forgotten lineage or reviving old sources",
  () =>
    Effect.gen(function* () {
      const { memory, evidence, record } = yield* seed();
      const first = yield* memory.capture(evidence);
      const scope = {
        environmentId: evidence.environmentId,
        owner: first.source.owner,
        ownerRevision: 0,
      };
      yield* memory.forget(sourceTuple(scope, first.source));
      const pending = yield* memory.capture({
        ...evidence,
        messageId: MessageId.make("fresh-pending"),
        settledAt: "2099-01-01T00:00:00.000Z",
        content: "My preferred shell is zsh.",
      });
      yield* memory.process(pending.operationKey);
      assert.equal((yield* memory.context(record)).text, "");
      const candidates = yield* memory.confirmations({ ...scope, limit: 32 });
      assert.deepStrictEqual(
        candidates.items.map((source) => source.sourceId),
        [pending.source.sourceId],
      );
      const reviewed = sourceTuple(scope, candidates.items[0]!);
      assert.equal(
        (yield* Effect.result(memory.confirm({ ...reviewed, contentHash: "0".repeat(64) })))._tag,
        "Failure",
      );
      const confirmed = yield* memory.confirm(reviewed);
      assert.equal(confirmed.source.sourceRevision, pending.source.sourceRevision + 1);
      yield* memory.process(confirmed.operationKey);
      assert.include((yield* memory.context(record)).text, "zsh");
      assert.equal((yield* memory.status(scope)).unresolvedForgottenSources, 1);
      assert.deepStrictEqual((yield* memory.confirmations({ ...scope, limit: 32 })).items, []);
      const repeated = yield* memory.confirm(sourceTuple(scope, confirmed.source));
      assert.equal(repeated.operationKey, confirmed.operationKey);
      assert.equal((yield* Effect.result(memory.confirm(reviewed)))._tag, "Failure");
      assert.equal(
        (yield* Effect.result(memory.confirm(sourceTuple(scope, first.source))))._tag,
        "Failure",
      );
      const automatic = yield* memory.capture({
        ...evidence,
        messageId: MessageId.make("automatic-after-confirm"),
        content: "A dark theme is what I like.",
      });
      yield* memory.process(automatic.operationKey);
      assert.notInclude((yield* memory.context(record)).text, "dark theme");
    }).pipe(Effect.provide(fixture())),
);

it.effect("pre-forget and foreign-owner sources are never confirmation candidates", () =>
  Effect.gen(function* () {
    const { memory, evidence } = yield* seed();
    const old = yield* memory.capture({
      ...evidence,
      messageId: MessageId.make("old-still-current"),
      settledAt: "1969-12-31T23:59:59.000Z",
    });
    const forgotten = yield* memory.capture(evidence);
    const scope = {
      environmentId: evidence.environmentId,
      owner: old.source.owner,
      ownerRevision: 0,
    };
    yield* memory.forget(sourceTuple(scope, forgotten.source));
    assert.deepStrictEqual((yield* memory.confirmations({ ...scope, limit: 32 })).items, []);
    assert.equal(
      (yield* Effect.result(memory.confirm(sourceTuple(scope, old.source))))._tag,
      "Failure",
    );
    assert.equal(
      (yield* Effect.result(
        memory.confirm({
          ...sourceTuple(scope, old.source),
          owner: { kind: "assistant", assistantId: AssistantId.make("sibling") },
        }),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(fixture())),
);
