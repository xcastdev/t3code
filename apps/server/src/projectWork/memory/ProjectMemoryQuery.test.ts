import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectTeamMemorySourcesRead,
  ProjectWorkMemoryObservationsRead,
  ProjectMemorySource,
  ProjectId,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as AuthSessions from "../../persistence/AuthSessions.ts";
import * as Authorization from "../ProjectTeamAuthorization.ts";
import * as Repository from "../ProjectWorkRepository.ts";
import * as Memory from "./ProjectMemoryService.ts";
import * as Query from "./ProjectMemoryQuery.ts";
import {
  layer,
  seed,
  scope,
  taskId,
  human,
  env,
  at,
  captureInput,
} from "./ProjectMemoryService.test-utils.ts";
const auth = Layer.mergeAll(AuthSessions.layer, Authorization.layer);
const testLayer = Query.layer.pipe(
  Layer.provideMerge(auth),
  Layer.provideMerge(layer),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(env),
      getDescriptor: Effect.die("unused"),
    }),
  ),
);
const decodeCandidates = Schema.decodeUnknownEffect(ProjectTeamMemorySourcesRead);
const encodeSource = Schema.encodeEffect(Schema.fromJsonString(ProjectMemorySource));
const decodePage = Schema.decodeUnknownEffect(
  Schema.Struct({
    items: Schema.Array(ProjectMemorySource),
    nextCursor: Schema.optionalKey(Schema.String),
  }),
);
const decodeCurrent = Schema.decodeUnknownEffect(
  Schema.Struct({ items: Schema.Array(ProjectMemorySource) }),
);
it.effect(
  "existing Work intents capture exact SQL sources once and expose recall; revoked humans cannot mutate",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const sessions = yield* AuthSessions.AuthSessionRepository;
      yield* sessions.create({
        sessionId: AuthSessionId.make("session"),
        subject: "person",
        scopes: [AuthOrchestrationOperateScope],
        method: "browser-session-cookie",
        client: {
          label: null,
          ipAddress: null,
          userAgent: null,
          deviceType: "unknown",
          os: null,
          browser: null,
        },
        issuedAt: DateTime.makeUnsafe(at),
        expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
      });
      const query = yield* Query.ProjectMemoryQuery;
      const principal = { ...human, environmentId: env, projectId: scope.owner.projectId };
      const candidates = yield* decodeCandidates(
        yield* query.read(
          { operation: "memory-sources", projectId: scope.owner.projectId, taskId },
          principal,
        ),
      );
      assert.equal(candidates.items.length, 1);
      const sql = yield* SqlClient.SqlClient;
      const state = yield* Repository.readCurrentState(sql, scope.owner.projectId);
      const input = {
        type: "project-team.memory.process" as const,
        commandId: CommandId.make("capture-memory"),
        projectId: scope.owner.projectId,
        taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks[0]!.revision,
        specRevision: state.tasks[0]!.specRevision,
        planRevision: 0,
        selection: candidates.items[0]!.selection,
      };
      yield* query.write(input, principal);
      yield* query.write(input, principal);
      assert.equal(
        (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_memory_sources`)[0]?.count,
        1,
      );
      const current = yield* decodeCurrent(
        yield* query.read(
          {
            operation: "memory-recall",
            projectId: scope.owner.projectId,
            taskId,
            query: "focused",
          },
          principal,
        ),
      );
      assert.equal(current.items[0]?.content, "Use focused tests");
      const recipient = ProjectId.make("share-recipient");
      yield* seed(recipient);
      const sharedSource = current.items[0]!;
      const afterCapture = yield* Repository.readCurrentState(sql, scope.owner.projectId);
      const shares = {
        type: "project-team.memory.shares.replace" as const,
        commandId: CommandId.make("shares"),
        projectId: scope.owner.projectId,
        expectedRevision: afterCapture.revision,
        owner: scope.owner,
        ownerRevision: 0,
        sourceRecordId: sharedSource.recordId,
        expectedSourceRecordRevision: sharedSource.revision,
        sourceRevision: sharedSource.sourceRevision,
        sourceGeneration: sharedSource.generation,
        contentHash: sharedSource.contentHash,
        recipients: [{ owner: { kind: "project" as const, projectId: recipient }, revision: 0 }],
      };
      const raced = yield* Effect.all(
        [
          Effect.result(query.write(shares, principal)),
          Effect.result(
            query.write(
              { ...shares, commandId: CommandId.make("raced-shares"), recipients: [] },
              principal,
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(raced.filter((result) => result._tag === "Success").length, 1);
      assert.equal(raced.filter((result) => result._tag === "Failure").length, 1);
      const afterShares = yield* Repository.readCurrentState(sql, scope.owner.projectId);
      assert.equal(
        (yield* Effect.result(
          query.write(
            {
              ...shares,
              expectedRevision: afterShares.revision,
              commandId: CommandId.make("stale-shares"),
              recipients: [],
            },
            principal,
          ),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_memory_grants WHERE revoked_at IS NULL`)[0]
          ?.count,
        raced[0]._tag === "Success" ? 1 : 0,
      );
      const memory = yield* Memory.ProjectMemoryService;
      if (raced[0]._tag !== "Success")
        yield* memory.grant({
          environmentId: env,
          source: {
            owner: scope.owner,
            sourceId: sharedSource.sourceId,
            sourceRevision: sharedSource.sourceRevision,
          },
          ownerRevision: 0,
          recipient: { kind: "project", projectId: recipient },
          recipientRevision: 0,
        });
      const selector = {
        owner: scope.owner,
        ownerRevision: 0,
        sourceRecordId: sharedSource.recordId,
        expectedSourceRecordRevision: sharedSource.revision + 1,
        sourceRevision: sharedSource.sourceRevision,
        sourceGeneration: sharedSource.generation,
        contentHash: sharedSource.contentHash,
      };
      const recipientTaskId = ProjectWorkTaskId.make(`task-${recipient}`);
      const recipientPrincipal = { ...principal, projectId: recipient };
      const sharedRead = {
        operation: "memory-recall" as const,
        projectId: recipient,
        taskId: recipientTaskId,
        query: "focused",
        sharedSource: selector,
      };
      assert.equal(
        (yield* decodeCurrent(yield* query.read(sharedRead, recipientPrincipal))).items[0]?.content,
        "Use focused tests",
      );
      const recipientState = yield* Repository.readCurrentState(sql, recipient);
      yield* query.write(
        {
          type: "project-team.memory.query",
          projectId: recipient,
          taskId: recipientTaskId,
          commandId: CommandId.make("shared-query"),
          expectedRevision: recipientState.revision,
          expectedTaskRevision: recipientState.tasks[0]!.revision,
          specRevision: recipientState.tasks[0]!.specRevision,
          planRevision: 0,
          owner: { kind: "project", projectId: recipient },
          ownerRevision: 0,
          query: "focused",
          sharedSource: selector,
        },
        recipientPrincipal,
      );
      const grants = yield* memory.listGrants({ ...scope, limit: 100 });
      for (const grant of grants) yield* memory.revoke({ ...grant, grantId: grant.id });
      assert.equal(
        (yield* Effect.result(query.read(sharedRead, recipientPrincipal)))._tag,
        "Failure",
      );
      yield* sessions.revoke({
        sessionId: AuthSessionId.make("session"),
        revokedAt: DateTime.makeUnsafe(at),
      });
      const source = { ...current.items[0]!, revision: current.items[0]!.revision + 1 };
      assert.equal(
        (yield* Effect.result(
          query.write(
            {
              type: "project-team.memory.retract",
              commandId: CommandId.make("retract"),
              projectId: scope.owner.projectId,
              expectedRevision: state.revision,
              owner: scope.owner,
              ownerRevision: 0,
              sourceRecordId: source.recordId,
              expectedSourceRecordRevision: source.revision,
              sourceRevision: source.sourceRevision,
              sourceGeneration: source.generation,
              contentHash: source.contentHash,
            },
            principal,
          ),
        ))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(testLayer)),
);
it.effect("oversized first source returns a continuation to later bounded memory", () =>
  Effect.gen(function* () {
    yield* seed();
    const memory = yield* Memory.ProjectMemoryService;
    const source = yield* memory.capture(captureInput());
    const sql = yield* SqlClient.SqlClient;
    const oversized = {
      ...source,
      sourceId: "000-oversized",
      recordId: "oversized",
      attribution: {
        ...source.attribution,
        actor: { ...source.attribution.actor, displayName: "x".repeat(64000) },
      },
    };
    const payload = yield* encodeSource(oversized);
    yield* sql`INSERT INTO t3_workflow_v2_memory_sources SELECT environment_id,owner_kind,owner_id,${oversized.sourceId},source_revision,generation,owner_revision,content_hash,status,work_kind,work_id,work_revision,task_id,${payload} FROM t3_workflow_v2_memory_sources WHERE source_id=${source.sourceId}`;
    const query = yield* Query.ProjectMemoryQuery;
    const input = {
      operation: "memory-current" as const,
      projectId: scope.owner.projectId,
      taskId,
      limit: 1,
    };
    const first = yield* decodePage(yield* query.read(input));
    assert.equal(first.items.length, 0);
    assert.equal(first.nextCursor, "000-oversized");
    const second = yield* decodePage(yield* query.read({ ...input, cursor: first.nextCursor! }));
    assert.equal(second.items[0]?.sourceId, source.sourceId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "promotes only current task-scoped SQL observations through human knowledge receipts",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const sessions = yield* AuthSessions.AuthSessionRepository;
      yield* sessions.create({
        sessionId: AuthSessionId.make("session"),
        subject: "person",
        scopes: [AuthOrchestrationOperateScope],
        method: "browser-session-cookie",
        client: {
          label: null,
          ipAddress: null,
          userAgent: null,
          deviceType: "unknown",
          os: null,
          browser: null,
        },
        issuedAt: DateTime.makeUnsafe(at),
        expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
      });
      const query = yield* Query.ProjectMemoryQuery;
      const memory = yield* Memory.ProjectMemoryService;
      const source = yield* memory.capture(captureInput());
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO t3_workflow_v2_memory_observations(operation_key,observation_key,environment_id,owner_kind,owner_id,owner_revision,source_id,source_revision,generation,content_hash,body,quote,source_start,source_end) VALUES('extraction','fact',${env},'project',${scope.owner.projectId},0,${source.sourceId},${source.sourceRevision},${source.generation},${source.contentHash},'Prefer focused tests','focused tests',4,17)`;
      const principal = { ...human, environmentId: env, projectId: scope.owner.projectId };
      const read = () =>
        query
          .read(
            { operation: "memory-observations", projectId: scope.owner.projectId, taskId },
            principal,
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ProjectWorkMemoryObservationsRead)));
      const page = yield* read();
      assert.equal(page.environmentId, env);
      assert.equal(page.items.length, 1);
      const observation = page.items[0]!;
      const state = yield* Repository.readCurrentState(sql, scope.owner.projectId);
      const input = {
        type: "project-team.memory.promote" as const,
        commandId: CommandId.make("promote-fact"),
        projectId: scope.owner.projectId,
        taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks[0]!.revision,
        specRevision: 0,
        planRevision: 0,
        observationId: observation.observationId,
        expectedObservationRevision: observation.revision,
        expectedSourceRevision: observation.sourceRevision,
        knowledgeId: "remembered-guidance",
        title: "Testing guidance",
      };
      yield* query.write(input, principal);
      yield* query.write(input, principal);
      const updated = yield* Repository.readCurrentState(sql, scope.owner.projectId);
      assert.equal(updated.knowledge!.length, 1);
      assert.equal(updated.knowledge![0]!.body, "Prefer focused tests");
      assert.equal(updated.knowledge![0]!.sourceId, observation.observationId);
      yield* sql`UPDATE t3_workflow_v2_memory_observations SET status='retracted'`;
      assert.equal((yield* read()).items.length, 0);
      assert.equal(
        (yield* Effect.result(
          query.write(
            {
              ...input,
              commandId: CommandId.make("stale-promote"),
              expectedRevision: updated.revision,
              knowledgeId: "stale",
            },
            principal,
          ),
        ))._tag,
        "Failure",
      );
      yield* sessions.revoke({
        sessionId: AuthSessionId.make("session"),
        revokedAt: DateTime.makeUnsafe(at),
      });
      assert.equal((yield* Effect.result(query.write(input, principal)))._tag, "Failure");
    }).pipe(Effect.provide(testLayer)),
);
