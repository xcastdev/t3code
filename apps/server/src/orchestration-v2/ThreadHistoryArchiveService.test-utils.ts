import * as NodeServices from "@effect/platform-node/NodeServices";

import { ThreadId, OrchestrationV2AppThreadJson, OrchestrationV2RunJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { threadHistoryArchiveMigration } from "../persistence/ThreadHistoryArchiveMigration.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Archive from "./ThreadHistoryArchiveService.ts";
export const infrastructure = Layer.mergeAll(
  Sqlite.layerMemory,
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-history-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const git = Layer.merge(GitVcsDriver.layer, VcsDriverRegistry.layer).pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(infrastructure),
);
export const store = CheckpointStore.layer.pipe(Layer.provideMerge(git));
export const testLayer = Archive.layer.pipe(
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(store),
);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const threadId = ThreadId.make("archive-thread");
const decodeThread = Schema.decodeUnknownEffect(OrchestrationV2AppThreadJson);
const decodeRun = Schema.decodeUnknownEffect(OrchestrationV2RunJson);
const encodeThread = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2RunJson));
export const setup = Effect.fn("test.archive.setup")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-history-git-" });
  const command = Effect.fn("test.archive.git")((args: ReadonlyArray<string>) =>
    driver.execute({ operation: "test.archive", cwd, args }),
  );
  yield* command(["init"]);
  yield* command(["config", "user.name", "Test"]);
  yield* command(["config", "user.email", "test@example.com"]);
  yield* fs.writeFileString(`${cwd}/proof.txt`, "before");
  yield* command(["add", "."]);
  yield* command(["commit", "-m", "initial"]);
  yield* command(["update-ref", "refs/t3/test-checkpoint", "HEAD"]);
  const present =
    yield* sql`SELECT 1 FROM sqlite_schema WHERE name='t3_workflow_v2_history_archives'`;
  if (!present.length)
    for (const statement of threadHistoryArchiveMigration.statements) yield* sql.unsafe(statement);
  const seed = Effect.fn("test.archive.seed")(function* (
    table: string,
    row: Record<string, string | number | null>,
  ) {
    const columns = yield* sql.unsafe<{ name: string; notnull: number; dflt_value: unknown }>(
      `PRAGMA table_info(${table})`,
    );
    const values: Record<string, string | number | null> = { ...row };
    for (const column of columns)
      if (column.notnull && column.dflt_value === null && !(column.name in values))
        values[column.name] = column.name.endsWith("_at")
          ? "2026-10-01T00:00:00.000Z"
          : column.name.includes("ordinal")
            ? 0
            : "fixture";
    yield* sql.unsafe(
      `INSERT INTO ${table} (${Object.keys(values).join(",")}) VALUES (${Object.keys(values)
        .map(() => "?")
        .join(",")})`,
      Object.values(values),
    );
  });
  const thread = yield* decodeThread({
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: "archive-project",
    title: "Recovery source",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: cwd,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
  });
  const run = yield* decodeRun({
    id: "archive-run",
    threadId,
    ordinal: 1,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "test" },
    providerThreadId: null,
    userMessageId: "message-stable",
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    queuePosition: null,
    requestedAt: "2026-10-01T00:00:00.000Z",
    startedAt: "2026-10-01T00:00:00.000Z",
    completedAt: "2026-10-01T00:00:00.000Z",
    checkpointId: null,
    contextHandoffId: null,
  });
  yield* seed("orchestration_v2_projection_threads", {
    thread_id: threadId,
    project_id: thread.projectId,
    payload_json: yield* encodeThread(thread),
  });
  yield* seed("orchestration_v2_projection_runs", {
    run_id: run.id,
    thread_id: threadId,
    ordinal: run.ordinal,
    status: run.status,
    payload_json: yield* encodeRun(run),
  });
  yield* seed("orchestration_v2_projection_messages", {
    message_id: "message-stable",
    thread_id: threadId,
    run_id: run.id,
    payload_json: json({
      id: "message-stable",
      text: "retained complete message",
      role: "assistant",
      createdAt: "2026-10-01T00:00:00.000Z",
      attachments: [{ id: "retained-blob" }],
    }),
  });
  yield* seed("orchestration_v2_projection_checkpoint_scopes", {
    scope_id: "scope-stable",
    thread_id: threadId,
    payload_json: json({ id: "scope-stable", cwd }),
  });
  yield* seed("orchestration_v2_projection_checkpoints", {
    checkpoint_id: "checkpoint-stable",
    thread_id: threadId,
    scope_id: "scope-stable",
    status: "ready",
    payload_json: json({ id: "checkpoint-stable", ref: "refs/t3/test-checkpoint" }),
  });
  return { sql, fs, cwd, command, thread, run };
});
