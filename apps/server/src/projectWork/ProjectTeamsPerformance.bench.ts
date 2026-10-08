import { afterAll, beforeAll, bench, describe, expect } from "vite-plus/test";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProjectTeamRecord,
  ProjectTeamRecordPage,
  ProjectTeamSupervisionSummary,
  ProjectWorkKnowledge,
  ProjectWorkTask,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";
import { ProjectWorkQuery, ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { readProjectTeamSupervision } from "./ProjectTeamSupervisionRead.ts";
import { persistProjectTeamProjections } from "./ProjectTeamsPersistence.ts";

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("team-scale");
const foreignProjectId = ProjectId.make("team-scale-foreign");
const taskCount = 2_000;
const knowledgeCount = 8_000;
const pageSize = 128;
const warmups = 5;
const samples = 50;
const attribution = {
  actor: { kind: "system" as const, id: "read-shape-fixture" },
  source: { kind: "system" as const, id: "read-shape-fixture" },
  recordedAt: at,
};
const key = (owner: string, kind: string, index: number) =>
  `${owner}-${kind}-${String(index).padStart(4, "0")}`;
const taskInput = (owner: string, index: number) => ({
  projectId: owner,
  taskId: key(owner, "task", index),
  title: `Read-shape task ${index}`,
  state: "draft",
  watchers: [],
  revision: 0,
  specRevision: 0,
  createdAt: at,
  updatedAt: at,
});
const decodeTask = Schema.decodeUnknownEffect(ProjectWorkTask);
const decodeKnowledge = Schema.decodeUnknownEffect(ProjectWorkKnowledge);
const decodeRecords = Schema.decodeUnknownEffect(Schema.Array(ProjectTeamRecord));
const decodeSummary = Schema.decodeUnknownEffect(ProjectTeamSupervisionSummary);
const decodePage = Schema.decodeUnknownEffect(ProjectTeamRecordPage);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const runtime = ManagedRuntime.make(
  ProjectWorkQueryLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeSqliteClient.layerMemory(),
        Layer.succeed(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("scale-environment")),
        }),
      ),
    ),
  ),
);

// Derived rows and a synthetic revision fence exercise read shape only. They
// provide no accepted history, dispatch, grant, model budget or execution proof.
const seed = Effect.fn("ProjectTeamsPerformance.seed")(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const owner of [projectId, foreignProjectId]) {
        const large = owner === projectId;
        const tasks = large ? taskCount : 1;
        const knowledge = large ? knowledgeCount : 1;
        yield* sql`INSERT INTO projection_projects
          (project_id,title,workspace_root,scripts_json,created_at,updated_at)
          VALUES (${owner},${owner},'/read-shape-only','[]',${at},${at})`;
        for (let offset = 0; offset < tasks; offset += pageSize) {
          const decoded = yield* Effect.forEach(
            Array.from({ length: Math.min(pageSize, tasks - offset) }, (_, i) => offset + i),
            (index) => decodeTask(taskInput(owner, index)),
          );
          yield* sql`INSERT INTO project_work_tasks ${sql.insert(
            decoded.map((task) => ({
              task_id: task.taskId,
              project_id: task.projectId,
              title: task.title,
              state: task.state,
              watchers_json: encodeJson(task.watchers),
              revision: task.revision,
              spec_revision: task.specRevision,
              created_at: task.createdAt,
              updated_at: task.updatedAt,
            })),
          )}`;
        }
        for (let offset = 0; offset < knowledge; offset += pageSize) {
          const decoded = yield* Effect.forEach(
            Array.from({ length: Math.min(pageSize, knowledge - offset) }, (_, i) => offset + i),
            (index) =>
              decodeKnowledge({
                knowledgeId: key(owner, "knowledge", index),
                projectId: owner,
                title: `Retained knowledge ${index}`,
                body: "PRIVATE RETAINED KNOWLEDGE",
                sourceKind: "task",
                sourceId: key(owner, "task", index % tasks),
                revision: 1,
                createdAt: at,
                updatedAt: at,
                attribution,
              }),
          );
          yield* sql`INSERT INTO project_work_knowledge ${sql.insert(
            decoded.map((item) => ({
              knowledge_id: item.knowledgeId,
              project_id: item.projectId,
              title: item.title,
              body: item.body,
              source_kind: item.sourceKind,
              source_id: item.sourceId,
              revision: item.revision,
              created_at: item.createdAt,
              updated_at: item.updatedAt,
              attribution_json: encodeJson(item.attribution),
            })),
          )}`;
        }
        const fence = {
          eventId: EventId.make(`${owner}-synthetic-fence`),
          projectId: owner,
          revision: 1,
          type: "project-work.task.created",
          occurredAt: at,
          task: yield* decodeTask(taskInput(owner, 0)),
        } satisfies ProjectWorkEvent;
        yield* sql`INSERT INTO project_work_events
          (event_id,project_id,event_type,occurred_at,command_id,payload_json)
          VALUES (${fence.eventId},${owner},${fence.type},${at},${owner + "-synthetic-fence"},${encodeJson(fence)})`;
        const common = { projectId: owner, revision: 1, generation: 0, updatedAt: at };
        const records: unknown[] = [];
        if (large) {
          records.push({
            ...common,
            kind: "role-revision",
            recordId: key(owner, "role", 0),
            status: "available",
            roleId: "scale-profile",
            roleRevision: 1,
            role: "implementer",
            model: "public-profile-model",
            instructions: "PRIVATE ROLE INSTRUCTIONS",
            skills: [],
            tools: [],
            memoryAccess: "project",
            delegationDepth: 1,
          });
          for (let index = 0; index < 9; index++) {
            records.push(
              {
                ...common,
                kind: "mission",
                recordId: key(owner, "mission", index),
                status: "active",
                title: `Public mission ${index}`,
                objective: "PRIVATE MISSION OBJECTIVE",
                requiredTaskIds: [],
              },
              {
                ...common,
                kind: "member",
                recordId: key(owner, "member", index),
                status: "active",
                name: `Public member ${index}`,
                coordinator: index === 0,
                roleRevisionId: key(owner, "role", 0),
              },
              {
                ...common,
                kind: "run-binding",
                recordId: key(owner, "binding", index),
                status: "running",
                taskId: key(owner, "task", index),
                attemptId: key(owner, "attempt", index),
                memberId: key(owner, "member", index),
                roleRevisionId: key(owner, "role", 0),
                providerInstanceId: "pi",
                threadId: key(owner, "thread", index),
                environmentId: "scale-environment",
                model: "public-binding-model",
                worktree: "PRIVATE WORKTREE",
                branch: "PRIVATE BRANCH",
                leaseGeneration: 0,
                specRevision: 1,
                planRevision: 1,
                configuration: {
                  instructionsHash: "PRIVATE CONFIGURATION",
                  toolIds: [],
                  skillIds: [],
                  runtimeVersion: "read-shape-only",
                  maxTokens: 100,
                  maxDurationMs: 100,
                  paidFallback: false,
                },
              },
            );
            yield* sql`INSERT INTO project_work_attempts
              (attempt_id,project_id,task_id,state,checkpoint_ids_json,revision,updated_at)
              VALUES (${key(owner, "attempt", index)},${owner},${key(owner, "task", index)},'running','[]',1,${at})`;
            yield* sql`INSERT INTO projection_threads
              (thread_id,project_id,title,model_selection_json,created_at,updated_at)
              VALUES (${key(owner, "thread", index)},${owner},'Read-shape worker','{"provider":"pi","model":"public-binding-model"}',${at},${at})`;
          }
          for (let index = 0; index < 6; index++) {
            records.push(
              {
                ...common,
                kind: "gate",
                recordId: key(owner, "gate", index),
                status: "pending",
                taskId: key(owner, "task", index),
                gate: "execution",
                specRevision: 1,
                planRevision: 1,
                contentHash: "read-shape-only",
                evidenceIds: [],
                attribution,
              },
              {
                ...common,
                kind: "question",
                recordId: key(owner, "question", index),
                status: "pending",
                taskId: key(owner, "task", index),
                senderId: key(owner, "member", index),
                targetGateId: key(owner, "gate", index),
                targetRevision: 1,
                body: "PRIVATE QUESTION BODY",
                choices: [],
              },
            );
            yield* sql`INSERT INTO project_work_blockers
              (blocker_id,project_id,task_id,reason,resolver,reference_ids_json,attention,revision)
              VALUES (${key(owner, "blocker", index)},${owner},${key(owner, "task", index)},'Public blocker','human','[]',1,1)`;
          }
        }
        for (let index = 0; index < tasks; index++)
          records.push({
            ...common,
            kind: "message",
            recordId: key(owner, "message", index),
            status: "queued",
            commandId: key(owner, "message-command", index),
            senderId: key(owner, "member", 0),
            recipientId: key(owner, "member", 1),
            taskId: key(owner, "task", index),
            body: `Public message ${index}`,
            evidenceIds: [],
            deliveryGeneration: 0,
            deliveryCursor: 0,
          });
        yield* persistProjectTeamProjections(sql, owner, yield* decodeRecords(records), []);
        for (const [table, expected] of [
          ["project_work_tasks", tasks],
          ["project_work_knowledge", knowledge],
          ["project_team_message", tasks],
          ["project_team_run_binding", large ? 9 : 0],
        ] as const) {
          const rows = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM ${sql(table)} WHERE project_id=${owner}`;
          expect(rows[0]?.count, `${owner}/${table}`).toBe(expected);
        }
      }
    }),
  );
});

const summaryRead = Effect.fn("ProjectTeamsPerformance.summary")(function* (owner = projectId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeSummary(yield* readProjectTeamSupervision(sql, { projectId: owner }));
});
const messageRead = Effect.fn("ProjectTeamsPerformance.messages")(function* (
  cursor?: string,
  owner = projectId,
) {
  const query = yield* ProjectWorkQuery;
  return yield* decodePage(
    yield* query.listFoundationRecords({
      projectId: owner,
      kinds: ["message"],
      limit: pageSize,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
});
const inertState = Effect.fn("ProjectTeamsPerformance.inertState")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const counts = [];
  for (const table of [
    "project_work_command_receipts",
    "project_team_pi_operation",
    "project_team_model_request",
    "project_team_memory_job",
  ])
    counts.push(yield* sql`SELECT COUNT(*) AS count FROM ${sql(table)}`);
  return { counts, events: yield* sql`SELECT * FROM project_work_events ORDER BY sequence` };
});
let summaryReads = 0;
let messageReads = 0;
const runSummary = () => {
  summaryReads++;
  return runtime.runPromise(summaryRead());
};
const runMessages = (cursor?: string, owner = projectId) => {
  messageReads++;
  return runtime.runPromise(messageRead(cursor, owner));
};
const runInertState = () => runtime.runPromise(inertState());
let initialInertState: Awaited<ReturnType<typeof runInertState>> | undefined;
const bytes = (value: unknown) => Buffer.byteLength(encodeJson(value));

const measure = async <A>(
  label: string,
  operation: () => Promise<A>,
  validate: (value: A) => void,
) => {
  const started = performance.now();
  const first = await operation();
  const firstReadMs = performance.now() - started;
  validate(first);
  for (let i = 0; i < warmups; i++) await operation();
  const durations: number[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    const result = await operation();
    durations.push(performance.now() - start);
    sizes.push(bytes(result));
  }
  durations.sort((a, b) => a - b);
  await runtime.runPromise(
    Effect.logInfo("project teams read-shape measurement", {
      operation: label,
      firstReadMs,
      medianMs: durations[Math.ceil(samples * 0.5) - 1],
      warmP95Ms: durations[Math.ceil(samples * 0.95) - 1],
      maxMs: durations.at(-1),
      firstEncodedBytes: bytes(first),
      minEncodedBytes: Math.min(...sizes),
      maxEncodedBytes: Math.max(...sizes),
      warmups,
      samples,
      taskCount,
      knowledgeCount,
      messageCount: taskCount,
      pageSize,
    }),
  );
  return first;
};

beforeAll(async () => {
  await runtime.runPromise(seed());
  const before = await runInertState();
  initialInertState = before;
  expect(before.counts).toEqual(Array.from({ length: 4 }, () => [{ count: 0 }]));
  await measure("supervision reader + public decode", runSummary, (summary) => {
    expect(summary.availability).toBe("available");
    if (summary.availability !== "available") throw new Error("Read-shape summary unavailable");
    expect(summary.taskCounts.total).toBe(taskCount);
    expect(summary.revision).toBe(1);
    for (const [page, bound] of [
      [summary.missions, 5],
      [summary.bindings, 8],
      [summary.blockers, 5],
      [summary.questions, 5],
    ] as const) {
      expect(page.items).toHaveLength(bound);
      expect(page.hasMore).toBe(true);
      for (const item of page.items)
        expect(item.recordId).toMatch(/^team-scale-(mission|binding|blocker|question)-/);
    }
    for (const item of summary.bindings.items) {
      expect(item.status).toBe("running");
      expect("accounting" in item ? item.accounting?.availability : undefined).toBe("not-admitted");
    }
    const encoded = encodeJson(summary);
    for (const hidden of ["PRIVATE", "Public message", "read-shape-only"])
      expect(encoded).not.toContain(hidden);
    expect(encoded).toContain("public-binding-model");
  });
  const firstPage = await measure("message page reader + public decode", runMessages, (page) => {
    expect(page.projectId).toBe(projectId);
    expect(page.items).toHaveLength(pageSize);
    expect(page.nextCursor).toBeDefined();
    expect(encodeJson(page)).toContain("Public message 0");
  });
  const traversalStart = performance.now();
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let traversalBytes = 0;
  let readerMs = 0;
  do {
    const readStart = performance.now();
    const page = await runMessages(cursor);
    readerMs += performance.now() - readStart;
    expect(page.projectId).toBe(projectId);
    expect(page.items.length).toBeLessThanOrEqual(pageSize);
    expect(page.revision).toBe(1);
    const pageIds = page.items.map((item) => item.recordId);
    expect(pageIds).toEqual([...pageIds].sort());
    for (const item of page.items) {
      expect(item.kind).toBe("message");
      expect(item.projectId).toBe(projectId);
      expect(seen.has(item.recordId)).toBe(false);
      seen.add(item.recordId);
    }
    if (cursor !== undefined && pageIds[0] !== undefined)
      expect("message:" + pageIds[0] > cursor).toBe(true);
    ids.push(...pageIds);
    pages++;
    traversalBytes += bytes(page);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  expect(ids).toEqual(
    Array.from({ length: taskCount }, (_, index) => key(projectId, "message", index)),
  );
  expect(pages).toBe(Math.ceil(taskCount / pageSize));
  expect(await runMessages()).toEqual(firstPage);
  const foreign = await runMessages(undefined, foreignProjectId);
  expect(foreign.items.map((item) => item.recordId)).toEqual([key(foreignProjectId, "message", 0)]);
  expect(foreign.nextCursor).toBeUndefined();
  expect(await runInertState()).toEqual(before);
  await runtime.runPromise(
    Effect.logInfo("project teams message traversal", {
      projectId,
      pages,
      records: ids.length,
      encodedBytes: traversalBytes,
      readerMs,
      elapsedWithValidationMs: performance.now() - traversalStart,
      fixedMeasurementReadsPerOperation: 1 + warmups + samples,
    }),
  );
}, 120_000);

afterAll(async () => {
  try {
    if (initialInertState !== undefined) expect(await runInertState()).toEqual(initialInertState);
    await runtime.runPromise(
      Effect.logInfo("project teams completed reader calls", { summaryReads, messageReads }),
    );
  } finally {
    await runtime.dispose();
  }
});

describe("Project teams representative bounded read scale", () => {
  const options = { warmupIterations: 5, warmupTime: 0, iterations: 50, time: 0 };
  bench(
    "supervision metadata at 2,000 tasks / 8,000 knowledge",
    async () => {
      await runSummary();
    },
    options,
  );
  bench(
    "128-record message page at 2,000 messages",
    async () => {
      await runMessages();
    },
    options,
  );
});
