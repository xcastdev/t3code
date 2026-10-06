import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  canonicalProjectWorkPayload,
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkAttemptId,
  ProviderInstanceId,
  ThreadId,
  EnvironmentId,
  ProjectTeamRunBinding,
  type ProjectTeamEffect,
  type ProjectWorkPublicationRequest,
  type ProjectWorkPublicationOutcome,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import { PROJECT_WORK_CHECKPOINT_VERSION } from "./ProjectTeamsPersistence.ts";
import { publicationRequestHash } from "./github/ProjectWorkGitHubOutbox.ts";
import * as Links from "./ProjectWorkPublicationLinks.ts";

type RunBinding = typeof ProjectTeamRunBinding.Type;
type PublicationEffect = typeof ProjectTeamEffect.Type;
const at = "2026-10-05T00:00:00.000Z";
const decodeBinding = Schema.decodeUnknownEffect(ProjectTeamRunBinding);
const projectId = ProjectId.make("publication-links-project");
const taskId = ProjectWorkTaskId.make("publication-links-task");
const threadId = ThreadId.make("publication-links-thread");
const request: ProjectWorkPublicationRequest = {
  version: 1,
  kind: "create-pr",
  operationId: "publication-one",
  marker: "opaque-marker-one",
  repository: { host: "github.com", nodeId: "R_base", nameWithOwner: "owner/repo" },
  target: {
    projectId,
    taskId,
    specRevision: 2,
    planRevision: 3,
    scopeHash: "scope-one",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    baseRef: "main",
    headRef: "feature",
    headRepositoryNodeId: "R_base",
    headSelector: "feature",
  },
  expectedTaskRevision: 0,
  authorizationRecordIds: ["proof-one"],
  threadId,
  title: "Repair task",
  body: "Verified change.",
};
const binding: RunBinding = {
  kind: "run-binding",
  recordId: "run-one",
  projectId,
  revision: 1,
  generation: 1,
  updatedAt: at,
  status: "settled",
  taskId,
  attemptId: ProjectWorkAttemptId.make("attempt-one"),
  memberId: "member",
  roleRevisionId: "role",
  providerInstanceId: ProviderInstanceId.make("pi"),
  threadId,
  environmentId: EnvironmentId.make("synthetic-environment"),
  model: "synthetic-model",
  configuration: {
    instructionsHash: "instructions",
    toolIds: [],
    skillIds: [],
    runtimeVersion: "test",
    maxTokens: 1000,
    maxDurationMs: 1000,
    paidFallback: false,
  },
  worktree: "/disposable/assigned",
  branch: "feature",
  leaseGeneration: 1,
  specRevision: 2,
  planRevision: 3,
  scopeHash: "scope-one",
};
const outcome = (
  input = request,
): Extract<ProjectWorkPublicationOutcome, { kind: "confirmed" }> => ({
  version: 1,
  operationId: input.operationId,
  requestHash: publicationRequestHash(input),
  claimGeneration: 1,
  observedAt: at,
  kind: "confirmed",
  marker: input.marker,
  repository: input.repository,
  pullRequest: {
    nodeId: "PR_one",
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    state: "OPEN",
    baseSha: input.target.baseSha,
    headSha: input.target.headSha,
    baseRef: input.target.baseRef,
    headRef: input.target.headRef,
    headRepositoryNodeId: input.target.headRepositoryNodeId,
  },
});
const effect = (input = request): PublicationEffect => ({
  kind: "effect",
  recordId: input.operationId,
  effectId: input.operationId,
  projectId,
  revision: 2,
  generation: 0,
  updatedAt: at,
  status: "succeeded",
  effectKind: "publication",
  taskId,
  targetId: "github.com/owner/repo",
  payload: {
    recordIds: input.authorizationRecordIds,
    expectedRevision: input.expectedTaskRevision,
    summary: canonicalProjectWorkPayload(input),
  },
  claimGeneration: 1,
  availableAt: at,
  outcome: canonicalProjectWorkPayload(outcome(input)),
});
const layer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  ProjectWorkRepositoryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(
    ServerConfig.layerTest("/disposable/publication", { prefix: "t3-publication-links-test-" }),
  ),
  Layer.provide(NodeServices.layer),
);
const seedEffect = Effect.fn("publicationLinksTest.seedEffect")(function* (
  record: PublicationEffect,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_team_effect (record_id,project_id,status,revision,generation,updated_at,unique_key,payload_json)
    VALUES (${record.recordId},${record.projectId},${record.status},${record.revision},${record.generation},${at},${record.effectId},${canonicalProjectWorkPayload(record)})`;
});
const setup = Effect.fn("publicationLinksTest.setup")(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("project-create"),
    projectId,
    title: "Publication",
    workspaceRoot: "/disposable/publication",
    createdAt: at,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("thread-create"),
    threadId,
    projectId,
    title: "Implementation",
    modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "synthetic-model" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    createdAt: at,
  });
  const repository = yield* ProjectWorkRepository;
  yield* repository.execute({
    type: "project-work.task.create",
    commandId: CommandId.make("task-create"),
    projectId,
    taskId,
    title: "Repair",
    createdAt: at,
  });
  const sql = yield* SqlClient.SqlClient;
  const state = yield* readCurrentState(sql, projectId);
  // Retained assignment fixture, independent of admission/launch policy.
  yield* sql`UPDATE project_work_reducer_checkpoints SET state_json=${canonicalProjectWorkPayload({
    ...state,
    checkpointVersion: PROJECT_WORK_CHECKPOINT_VERSION,
    foundationRecords: [binding],
  })} WHERE project_id=${projectId}`;
  yield* seedEffect(effect());
  return { engine, repository, sql, query: yield* ProjectionSnapshotQuery };
});

it.effect("links a confirmed managed publication through the ordinary thread PR projection", () =>
  Effect.gen(function* () {
    const { query } = yield* setup();
    const service = yield* Links.make;
    expect(yield* service.link(request.operationId)).toMatchObject({ status: "attempted" });
    const thread = yield* query.getThreadShellById(threadId);
    expect(Option.getOrThrow(thread).pullRequests).toContainEqual(
      expect.objectContaining({
        host: "github.com",
        repository: "owner/repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        source: "created",
      }),
    );
  }).pipe(Effect.provide(layer)),
);

const replaceEffect = Effect.fn("publicationLinksTest.replaceEffect")(function* (record: unknown) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE project_team_effect SET payload_json=${canonicalProjectWorkPayload(record)} WHERE unique_key=${request.operationId}`;
});
const replaceBindings = Effect.fn("publicationLinksTest.replaceBindings")(function* (
  bindings: ReadonlyArray<RunBinding>,
) {
  const sql = yield* SqlClient.SqlClient;
  const state = yield* readCurrentState(sql, projectId);
  yield* sql`UPDATE project_work_reducer_checkpoints SET state_json=${canonicalProjectWorkPayload({
    ...state,
    checkpointVersion: PROJECT_WORK_CHECKPOINT_VERSION,
    foundationRecords: bindings,
  })} WHERE project_id=${projectId}`;
});
const expectNoLink = Effect.fn("publicationLinksTest.expectNoLink")(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const thread = yield* query.getThreadShellById(threadId);
  if (Option.isSome(thread)) expect(thread.value.pullRequests).toEqual([]);
});

it.effect(
  "retry and a new service instance preserve one ordinary PR link without task advancement",
  () =>
    Effect.gen(function* () {
      const { repository, engine, query } = yield* setup();
      const before = yield* repository.replay(projectId);
      const head = yield* engine.latestSequence;
      yield* (yield* Links.make).link(request.operationId);
      const afterFirst = yield* engine.latestSequence;
      yield* (yield* Links.make).link(request.operationId);
      expect(yield* engine.latestSequence).toBe(afterFirst);
      expect(afterFirst).toBe(head + 1);
      expect(
        Option.getOrThrow(yield* query.getThreadShellById(threadId)).pullRequests,
      ).toHaveLength(1);
      expect(yield* repository.replay(projectId)).toEqual(before);
    }).pipe(Effect.provide(layer)),
);

for (const state of ["CLOSED", "MERGED"] as const)
  it.effect(`retains a confirmed ${state.toLowerCase()} PR as linked history`, () =>
    Effect.gen(function* () {
      yield* setup();
      const receipt = outcome();
      yield* replaceEffect({
        ...effect(),
        outcome: canonicalProjectWorkPayload({
          ...receipt,
          pullRequest: { ...receipt.pullRequest, state },
        }),
      });
      expect(yield* (yield* Links.make).link(request.operationId)).toEqual({ status: "attempted" });
      const query = yield* ProjectionSnapshotQuery;
      expect(
        Option.getOrThrow(yield* query.getThreadShellById(threadId)).pullRequests,
      ).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );

for (const status of ["pending", "claimed", "uncertain", "failed", "canceled"] as const)
  it.effect(`does not link a ${status} publication`, () =>
    Effect.gen(function* () {
      const { sql } = yield* setup();
      yield* replaceEffect({ ...effect(), status });
      yield* sql`UPDATE project_team_effect SET status=${status} WHERE unique_key=${request.operationId}`;
      expect(yield* (yield* Links.make).link(request.operationId)).toMatchObject({
        status: "skipped",
        reason: "not-confirmed",
      });
      yield* expectNoLink();
    }).pipe(Effect.provide(layer)),
  );

const invalidRecords: ReadonlyArray<readonly [string, () => unknown]> = [
  ["operation ID", () => ({ ...effect(), effectId: "another-operation" })],
  ["project", () => ({ ...effect(), projectId: "foreign-project" })],
  ["task", () => ({ ...effect(), taskId: "foreign-task" })],
  ["target repository", () => ({ ...effect(), targetId: "github.com/owner/foreign" })],
  [
    "authorization records",
    () => ({ ...effect(), payload: { ...effect().payload, recordIds: ["foreign-proof"] } }),
  ],
  [
    "expected task revision",
    () => ({ ...effect(), payload: { ...effect().payload, expectedRevision: 9 } }),
  ],
  [
    "request hash",
    () => ({
      ...effect(),
      outcome: canonicalProjectWorkPayload({ ...outcome(), requestHash: "c".repeat(64) }),
    }),
  ],
  [
    "claim generation",
    () => ({
      ...effect(),
      outcome: canonicalProjectWorkPayload({ ...outcome(), claimGeneration: 2 }),
    }),
  ],
  [
    "zero claim",
    () => ({
      ...effect(),
      claimGeneration: 0,
      outcome: canonicalProjectWorkPayload({ ...outcome(), claimGeneration: 0 }),
    }),
  ],
  [
    "marker",
    () => ({
      ...effect(),
      outcome: canonicalProjectWorkPayload({ ...outcome(), marker: "foreign-marker-one" }),
    }),
  ],
  [
    "repository node",
    () => ({
      ...effect(),
      outcome: canonicalProjectWorkPayload({
        ...outcome(),
        repository: { ...outcome().repository, nodeId: "R_foreign" },
      }),
    }),
  ],
  ...(["baseSha", "headSha", "baseRef", "headRef", "headRepositoryNodeId", "url"] as const).map(
    (field) =>
      [
        `PR ${field}`,
        () => ({
          ...effect(),
          outcome: canonicalProjectWorkPayload({
            ...outcome(),
            pullRequest: { ...outcome().pullRequest, [field]: "foreign-value" },
          }),
        }),
      ] as const,
  ),
  [
    "uncertain receipt under succeeded status",
    () => ({
      ...effect(),
      outcome: canonicalProjectWorkPayload({
        version: 1,
        kind: "uncertain",
        operationId: request.operationId,
        requestHash: publicationRequestHash(request),
        claimGeneration: 1,
        observedAt: at,
        reason: "missing-match",
      }),
    }),
  ],
  [
    "noncanonical request",
    () => ({
      ...effect(),
      payload: { ...effect().payload, summary: ` ${canonicalProjectWorkPayload(request)}` },
    }),
  ],
  [
    "padded request field",
    () => {
      const changed = { ...request, title: " padded title " };
      return {
        ...effect(),
        payload: { ...effect().payload, summary: canonicalProjectWorkPayload(changed) },
        outcome: canonicalProjectWorkPayload(outcome(changed)),
      };
    },
  ],
  [
    "oversized request",
    () => {
      const changed = { ...request, body: "x".repeat(32000) };
      return {
        ...effect(),
        payload: { ...effect().payload, summary: canonicalProjectWorkPayload(changed) },
        outcome: canonicalProjectWorkPayload(outcome(changed)),
      };
    },
  ],
  ["oversized outcome", () => ({ ...effect(), outcome: "x".repeat(4001) })],
  [
    "excess receipt fields",
    () => ({
      ...effect(),
      outcome: canonicalProjectWorkPayload({ ...outcome(), extra: "untrusted" }),
    }),
  ],
];
for (const [description, record] of invalidRecords)
  it.effect(`rejects a retained publication with mismatched ${description}`, () =>
    Effect.gen(function* () {
      yield* setup();
      yield* replaceEffect(record());
      expect((yield* (yield* Links.make).link(request.operationId).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      yield* expectNoLink();
    }).pipe(Effect.provide(layer)),
  );

for (const status of ["reserved", "revoked", "quarantined"] as const)
  it.effect(`does not link ownership with a ${status} binding`, () =>
    Effect.gen(function* () {
      yield* setup();
      yield* replaceBindings([{ ...binding, status }]);
      expect(yield* (yield* Links.make).link(request.operationId)).toMatchObject({
        status: "skipped",
        reason: "unbound-thread",
      });
      yield* expectNoLink();
    }).pipe(Effect.provide(layer)),
  );
for (const field of [
  "projectId",
  "taskId",
  "threadId",
  "scopeHash",
  "specRevision",
  "planRevision",
] as const)
  it.effect(`does not link a binding with a foreign ${field}`, () =>
    Effect.gen(function* () {
      yield* setup();
      const changed =
        field === "specRevision" || field === "planRevision"
          ? { ...binding, [field]: 99 }
          : { ...binding, [field]: "foreign" };
      // Encode/decode the deliberately altered persisted fixture rather than casting branded IDs.
      const decoded = yield* decodeBinding(changed);
      yield* replaceBindings([decoded]);
      expect(yield* (yield* Links.make).link(request.operationId)).toMatchObject({
        status: "skipped",
        reason: "unbound-thread",
      });
      yield* expectNoLink();
    }).pipe(Effect.provide(layer)),
  );
for (const bindings of [[], [binding, { ...binding, recordId: "duplicate-run" }]])
  it.effect(
    `rejects ${bindings.length === 0 ? "absent" : "ambiguous"} retained run ownership`,
    () =>
      Effect.gen(function* () {
        yield* setup();
        yield* replaceBindings(bindings);
        expect(yield* (yield* Links.make).link(request.operationId)).toMatchObject({
          status: "skipped",
          reason: "unbound-thread",
        });
        yield* expectNoLink();
      }).pipe(Effect.provide(layer)),
  );

for (const deleted of ["thread", "project"] as const)
  it.effect(`does not attach a dangling link after ${deleted} deletion`, () =>
    Effect.gen(function* () {
      const { engine } = yield* setup();
      yield* engine.dispatch(
        deleted === "thread"
          ? { type: "thread.delete", commandId: CommandId.make("delete-thread"), threadId }
          : {
              type: "project.delete",
              commandId: CommandId.make("delete-project"),
              projectId,
              force: true,
            },
      );
      expect(yield* (yield* Links.make).link(request.operationId)).toMatchObject({
        status: "skipped",
      });
      yield* expectNoLink();
    }).pipe(Effect.provide(layer)),
  );

it.effect("an absent optional thread is skipped without creating any thread", () =>
  Effect.gen(function* () {
    const { engine } = yield* setup();
    const { threadId: _threadId, ...withoutThread } = request;
    yield* replaceEffect(effect(withoutThread));
    const before = yield* engine.latestSequence;
    expect(yield* (yield* Links.make).link(request.operationId)).toMatchObject({
      status: "skipped",
      reason: "no-thread",
    });
    expect(yield* engine.latestSequence).toBe(before);
    yield* expectNoLink();
  }).pipe(Effect.provide(layer)),
);

it.effect("reports attempted honestly when the existing helper swallows a dispatch failure", () =>
  Effect.gen(function* () {
    const { engine } = yield* setup();
    const service = yield* Links.make.pipe(
      Effect.provideService(OrchestrationEngineService, {
        ...engine,
        dispatch: () => Effect.die("Synthetic link-write failure"),
      }),
    );
    expect(yield* service.link(request.operationId)).toEqual({ status: "attempted" });
    yield* expectNoLink();
  }).pipe(Effect.provide(layer)),
);

it.effect("recovers beyond one keyset page while isolating malformed and irrelevant effects", () =>
  Effect.gen(function* () {
    const { sql } = yield* setup();
    const { threadId: _threadId, ...withoutThread } = request;
    for (let i = 0; i < 130; i++)
      yield* seedEffect(
        effect({ ...withoutThread, operationId: `recover-${String(i).padStart(3, "0")}` }),
      );
    yield* seedEffect({
      ...effect(),
      recordId: "irrelevant",
      effectId: "irrelevant",
      effectKind: "memory-index",
    });
    yield* seedEffect({ ...effect(), recordId: "broken", effectId: "broken" });
    yield* sql`UPDATE project_team_effect SET payload_json='{' WHERE record_id='broken'`;
    expect(yield* (yield* Links.make).recoverAll()).toEqual({
      observed: 132,
      attempted: 1,
      skipped: 130,
      failed: 1,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects inherited SQL transactions without committing a thread PR link", () =>
  Effect.gen(function* () {
    const { sql, engine } = yield* setup();
    const service = yield* Links.make;
    const before = yield* engine.latestSequence;
    expect(
      (yield* sql.withTransaction(service.link(request.operationId)).pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect((yield* sql.withTransaction(service.recoverAll()).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(yield* engine.latestSequence).toBe(before);
    yield* expectNoLink();
  }).pipe(Effect.provide(layer)),
);

for (const lifecycle of ["archived", "tombstoned"] as const)
  it.effect(`does not link a project with ${lifecycle} lifecycle while its shell remains`, () =>
    Effect.gen(function* () {
      const { sql } = yield* setup();
      yield* sql`INSERT INTO project_lifecycle (project_id,state,workspace_root,revision,changed_at)
        VALUES (${projectId},${lifecycle},'/disposable/publication',1,${at})`;
      expect(yield* (yield* Links.make).link(request.operationId)).toMatchObject({
        status: "skipped",
        reason: "missing-project",
      });
      yield* expectNoLink();
    }).pipe(Effect.provide(layer)),
  );

it.effect("rejects a foreign thread shell even when a local retained binding names it", () =>
  Effect.gen(function* () {
    const { engine, query } = yield* setup();
    const foreignProject = ProjectId.make("foreign-project");
    const foreignThread = ThreadId.make("foreign-thread");
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("foreign-project-create"),
      projectId: foreignProject,
      title: "Foreign",
      workspaceRoot: "/disposable/foreign",
      createdAt: at,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("foreign-thread-create"),
      threadId: foreignThread,
      projectId: foreignProject,
      title: "Foreign",
      modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "synthetic-model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "feature",
      worktreePath: null,
      createdAt: at,
    });
    yield* replaceEffect(effect({ ...request, threadId: foreignThread }));
    yield* replaceBindings([{ ...binding, threadId: foreignThread }]);
    expect(yield* (yield* Links.make).link(request.operationId)).toMatchObject({
      status: "skipped",
      reason: "missing-thread",
    });
    expect(Option.getOrThrow(yield* query.getThreadShellById(foreignThread)).pullRequests).toEqual(
      [],
    );
    yield* expectNoLink();
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves valid non-ASCII envelopes under the existing character budget", () =>
  Effect.gen(function* () {
    yield* setup();
    yield* replaceEffect(effect({ ...request, body: "界".repeat(25000) }));
    expect(yield* (yield* Links.make).link(request.operationId)).toEqual({ status: "attempted" });
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects an oversized retained payload before JSON decoding", () =>
  Effect.gen(function* () {
    const { sql } = yield* setup();
    yield* sql`UPDATE project_team_effect SET payload_json=${" ".repeat(262145)} WHERE unique_key=${request.operationId}`;
    expect(yield* (yield* Links.make).link(request.operationId).pipe(Effect.flip)).toMatchObject({
      reason: "invalid-record",
    });
    yield* expectNoLink();
  }).pipe(Effect.provide(layer)),
);
