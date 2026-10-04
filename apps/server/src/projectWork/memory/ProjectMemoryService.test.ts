import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkComment,
  ProjectWorkDecision,
  ProjectWorkDecisionId,
  ThreadId,
  ProjectWorkFoundationCommitCommand,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "../ProjectWorkRepository.ts";
import * as ContentGuard from "../ProjectWorkContentGuard.ts";
import * as Authorization from "../ProjectTeamAuthorization.ts";
import {
  makeProjectMemoryService,
  makeProjectMemoryManifestStore,
  type ProjectMemoryModelPorts,
  projectMemoryHash,
} from "./ProjectMemoryService.ts";
import * as ManagedFixture from "../ProjectTeamAuthorization.testFixtures.ts";
import { hydrateProjectMemoryHits } from "./ProjectMemoryHitHydration.ts";

export const memoryTestAt = "2026-10-03T00:00:00.000Z";
const attribution = {
  actor: { kind: "system", id: "retained-fixture" },
  source: { kind: "system", id: "retained-fixture" },
  recordedAt: memoryTestAt,
} as const;
const decisionFixture = Schema.decodeUnknownSync(ProjectWorkDecision);
const commentFixture = Schema.decodeUnknownSync(ProjectWorkComment);
const commitFixture = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const services = Layer.mergeAll(ProjectWorkRepositoryLive, Authorization.layer).pipe(
  Layer.provideMerge(ContentGuard.layer),
);
export const withMemoryDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(services.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()))));
export const memorySetup = Effect.fn("memoryTest.setup")(function* (
  models?: ProjectMemoryModelPorts,
) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const contentGuard = yield* ContentGuard.ProjectWorkContentGuard;
  const authorization = yield* Authorization.ProjectTeamAuthorization;
  for (const projectId of ["memory-project", "shared-project"])
    yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},${projectId},${`/fixture/${projectId}`},'[]',${memoryTestAt},${memoryTestAt})`;
  const projectId = ProjectId.make("memory-project");
  const taskId = ProjectWorkTaskId.make("memory-task");
  yield* repository.execute({
    type: "project-work.task.create",
    projectId,
    taskId,
    commandId: CommandId.make("memory-task-create"),
    title: "Retained investigation",
    createdAt: memoryTestAt,
  });
  const comment = commentFixture({
    commentId: "memory-comment",
    projectId,
    taskId,
    body: "The parser preserves the source revision and exact provenance.",
    revision: 0,
    createdAt: memoryTestAt,
    attribution,
  });
  yield* repository.execute({
    type: "project-work.comment.add",
    projectId,
    commandId: CommandId.make("memory-comment-add"),
    comment,
    attribution,
    addedAt: memoryTestAt,
  });
  const service = makeProjectMemoryService({
    sql,
    repository,
    contentGuard,
    authorization,
    environmentId: "fixture-environment",
    ...(models === undefined ? {} : { models }),
  });
  return { sql, repository, contentGuard, authorization, service, projectId, taskId, comment };
});
export const memoryCommit = Effect.fn("memoryTest.commit")(function* (
  projectId: string,
  changed: ReadonlyArray<ProjectTeamRecord>,
) {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const state = yield* readCurrentState(sql, projectId);
  yield* repository.execute(
    commitFixture({
      type: "project-work.foundation.commit",
      projectId,
      commandId: `fixture-commit-${state.revision}`,
      expectedRevision: state.revision,
      committedAt: memoryTestAt,
      attribution,
      records: changed,
    }),
  );
});
export const memoryModels = (
  facts: unknown = [
    { key: "parser", body: "The parser retains source provenance.", quote: "exact provenance" },
  ],
): ProjectMemoryModelPorts => ({
  extract: () => Effect.succeed(facts),
  embed: (input) =>
    Effect.succeed(input.bodies.map(() => Array.from({ length: 2048 }, () => 0.125))),
});

it.effect(
  "captures trusted retained content/provenance once and commits physical work before any model call",
  () =>
    withMemoryDatabase(
      Effect.gen(function* () {
        const { service, sql, comment, projectId } = yield* memorySetup();
        const source = yield* service.captureRetained(projectId, {
          kind: "comment",
          retainedId: comment.commentId,
        });
        expect(source).toMatchObject({
          sourceKind: "finding",
          sourceRevision: 0,
          attribution: comment.attribution,
          sharedWithProjectIds: [],
        });
        expect(source.content).toContain(comment.body);
        const before = yield* sql`SELECT * FROM project_work_events`;
        const duplicate = yield* service.captureRetained(projectId, {
          kind: "comment",
          retainedId: comment.commentId,
        });
        expect(duplicate).toEqual(source);
        expect(yield* sql`SELECT * FROM project_work_events`).toEqual(before);
        expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(1);
      }),
    ),
);

for (const selector of [
  { kind: "comment", retainedId: "missing" },
  { kind: "comment", retainedId: "memory-comment", projectId: "other", actor: "claimed" },
  { kind: "artifact", retainedId: "raw-tool-stream" },
])
  it.effect(`rejects unsafe capture selector ${JSON.stringify(selector)}`, () =>
    withMemoryDatabase(
      Effect.gen(function* () {
        const { service, sql, projectId } = yield* memorySetup();
        expect((yield* service.captureRetained(projectId, selector).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(0);
        expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(0);
      }),
    ),
  );

it.effect("uses actual known-secret guard before retaining memory", () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      const { service, contentGuard, sql, projectId } = yield* memorySetup();
      yield* contentGuard.registerKnownSecrets(["exact provenance"]);
      expect(
        (yield* service
          .captureRetained(projectId, { kind: "comment", retainedId: "memory-comment" })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(0);
    }),
  ),
);

it.effect("rejects agent actor/project claims without current issued managed authority", () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      const { service, sql } = yield* memorySetup();
      expect(
        (yield* service
          .capture(
            { actor: { kind: "agent", id: "pretend" } },
            { kind: "comment", retainedId: "memory-comment" },
          )
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(0);
    }),
  ),
);

it.effect(
  "retains extraction and stable observation IDs before vector work, rejects malformed extraction",
  () =>
    withMemoryDatabase(
      Effect.gen(function* () {
        const { service, sql, projectId } = yield* memorySetup(memoryModels());
        const source = yield* service.captureRetained(projectId, {
          kind: "comment",
          retainedId: "memory-comment",
        });
        const work = (yield* readCurrentState(sql, projectId)).foundationRecords!.find(
          (record) => record.kind === "effect" && record.effectKind === "memory-index",
        )!;
        if (work.kind !== "effect") return yield* Effect.die("missing effect");
        const owner = yield* service.claim(projectId, work.effectId);
        expect(owner).toBe(1);
        yield* service.extract(projectId, work.effectId, owner!);
        const retained = yield* service.readWork(projectId, work.effectId);
        expect(retained.extraction).toMatchObject({
          status: "extracted",
          expectedObservationIds: [retained.observations[0]!.recordId],
        });
        expect(retained.observations[0]).toMatchObject({
          sourceId: source.recordId,
          provenance: source.attribution,
        });
        expect(yield* sql`SELECT * FROM project_team_memory_manifest`).toHaveLength(0);
        yield* service.extract(projectId, work.effectId, owner!);
        expect((yield* service.readWork(projectId, work.effectId)).observations).toEqual(
          retained.observations,
        );
        const manifest = yield* service.prepareManifest(projectId, work.effectId, owner!);
        expect(manifest?.observations[0]?.vector).toHaveLength(2048);
        expect(
          yield* makeProjectMemoryManifestStore(sql).load(retained.extraction!.recordId),
        ).toEqual(manifest);
      }),
    ),
);

for (const facts of [
  [{ key: "false", body: "invented", quote: "This is absent" }],
  [
    {
      key: "secret",
      body: "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
      quote: "exact provenance",
    },
  ],
  [{ key: "a", body: "body", quote: "exact provenance", acceptedDecision: true }],
  [
    { key: "a", body: "body", quote: "exact provenance" },
    { key: "a", body: "duplicate", quote: "exact provenance" },
  ],
])
  it.effect(`rejects extracted facts ${JSON.stringify(facts)}`, () =>
    withMemoryDatabase(
      Effect.gen(function* () {
        const { service, sql, projectId } = yield* memorySetup(memoryModels(facts));
        yield* service.captureRetained(projectId, {
          kind: "comment",
          retainedId: "memory-comment",
        });
        const work = (yield* readCurrentState(sql, projectId)).foundationRecords!.find(
          (record) => record.kind === "effect",
        )!;
        if (work.kind !== "effect") return yield* Effect.die("missing effect");
        const owner = yield* service.claim(projectId, work.effectId);
        expect(
          (yield* service.extract(projectId, work.effectId, owner!).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* sql`SELECT * FROM project_team_memory_observation`).toHaveLength(0);
      }),
    ),
  );

it.effect(
  "retraction suppresses hydrated observations immediately, clears shares and retains deletion across purge",
  () =>
    withMemoryDatabase(
      Effect.gen(function* () {
        const { service, sql, projectId } = yield* memorySetup(memoryModels());
        const source = yield* service.captureRetained(projectId, {
          kind: "comment",
          retainedId: "memory-comment",
        });
        const state = yield* readCurrentState(sql, projectId);
        const work = state.foundationRecords!.find((record) => record.kind === "effect")!;
        if (work.kind !== "effect") return yield* Effect.die("missing effect");
        const owner = yield* service.claim(projectId, work.effectId);
        yield* service.extract(projectId, work.effectId, owner!);
        const ids = (yield* service.readWork(projectId, work.effectId)).observations.map(
          (record) => record.recordId,
        );
        expect((yield* hydrateProjectMemoryHits(sql, { projectId, hitIds: ids })).status).toBe(
          "accepted",
        );
        yield* service.retract(projectId, source.recordId);
        expect(
          (yield* readCurrentState(sql, projectId)).foundationRecords!.find(
            (record) => record.recordId === source.recordId,
          ),
        ).toMatchObject({
          content: source.content,
          contentHash: source.contentHash,
          attribution: source.attribution,
          generation: source.generation + 1,
        });
        const hydrated = yield* hydrateProjectMemoryHits(sql, { projectId, hitIds: ids });
        expect(hydrated.selected).toEqual([]);
        expect(
          (yield* service.prepareManifest(projectId, work.effectId, owner!).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        const jobs = yield* sql`SELECT * FROM project_team_memory_job`;
        expect(jobs).toHaveLength(2);
        yield* sql`DELETE FROM project_team_memory_source WHERE project_id=${projectId}`;
        expect(yield* sql`SELECT * FROM project_team_memory_job`).toEqual(jobs);
        expect(
          (yield* service
            .captureRetained(projectId, { kind: "comment", retainedId: "memory-comment" })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect(
  "explicit share revocation creates a fenced version and suppresses old shared views without changing decisions",
  () =>
    withMemoryDatabase(
      Effect.gen(function* () {
        const { service, sql, projectId } = yield* memorySetup();
        const source = yield* service.captureRetained(projectId, {
          kind: "comment",
          retainedId: "memory-comment",
        });
        yield* service.replaceShares(projectId, source.recordId, ["shared-project"]);
        const shared = (yield* readCurrentState(sql, projectId)).foundationRecords!.find(
          (record) => record.kind === "memory-source" && record.status === "current",
        )!;
        if (shared.kind !== "memory-source") return yield* Effect.die("missing source");
        expect(shared.recordId).not.toBe(source.recordId);
        yield* service.replaceShares(projectId, shared.recordId, []);
        const versions = (yield* readCurrentState(sql, projectId)).foundationRecords!.filter(
          (record) => record.kind === "memory-source",
        );
        expect(versions).toHaveLength(3);
        expect(
          versions.every(
            (record) => record.kind === "memory-source" && record.sharedWithProjectIds.length === 0,
          ),
        ).toBe(true);
        expect(
          yield* sql`SELECT * FROM project_team_memory_job WHERE json_extract(input_json,'$.effect.effectKind')='memory-delete'`,
        ).toHaveLength(2);
      }),
    ),
);

it.effect(
  "accepted decision corrections retain a logical source while rotating fenced backend namespaces",
  () =>
    withMemoryDatabase(
      Effect.gen(function* () {
        const f = yield* memorySetup(
          memoryModels([
            { key: "decision", body: "Accepted decision observation.", quote: "retained decision" },
          ]),
        );
        const decision = decisionFixture({
          decisionId: "memory-decision",
          projectId: f.projectId,
          title: "Parser behavior",
          body: "Original retained decision",
          state: "proposed",
          revision: 0,
          createdAt: memoryTestAt,
          updatedAt: memoryTestAt,
          attribution,
        });
        yield* f.repository.execute({
          type: "project-work.decision.propose",
          projectId: f.projectId,
          commandId: CommandId.make("memory-decision-propose"),
          decision,
          proposedAt: memoryTestAt,
          attribution,
        });
        expect(
          (yield* f.service
            .captureRetained(f.projectId, { kind: "decision", retainedId: decision.decisionId })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        yield* f.repository.execute({
          type: "project-work.decision.accept",
          projectId: f.projectId,
          commandId: CommandId.make("memory-decision-accept"),
          decisionId: decision.decisionId,
          acceptedAt: memoryTestAt,
          attribution,
        });
        const original = yield* f.service.captureRetained(f.projectId, {
          kind: "decision",
          retainedId: decision.decisionId,
        });
        expect(original.sourceKind).toBe("decision");
        const firstEffect = (yield* readCurrentState(f.sql, f.projectId)).foundationRecords!.find(
          (record) => record.kind === "effect" && record.effectKind === "memory-index",
        )!;
        const oldOwner = yield* f.service.claim(f.projectId, firstEffect.recordId);
        const replacement = {
          ...decision,
          decisionId: ProjectWorkDecisionId.make("replacement-decision"),
          body: "Corrected retained decision",
        };
        yield* f.repository.execute({
          type: "project-work.decision.supersede",
          projectId: f.projectId,
          commandId: CommandId.make("memory-decision-supersede"),
          decisionId: decision.decisionId,
          replacement,
          supersededAt: memoryTestAt,
          attribution,
        });
        yield* f.repository.execute({
          type: "project-work.decision.accept",
          projectId: f.projectId,
          commandId: CommandId.make("replacement-decision-accept"),
          decisionId: replacement.decisionId,
          acceptedAt: memoryTestAt,
          attribution,
        });
        const corrected = yield* f.service.captureRetained(f.projectId, {
          kind: "decision",
          retainedId: replacement.decisionId,
        });
        expect(corrected.sourceId).toBe(original.sourceId);
        expect(corrected.recordId).not.toBe(original.recordId);
        expect(corrected).toMatchObject({
          generation: original.generation + 1,
          supersedes: original.recordId,
        });
        expect(
          (yield* f.service.extract(f.projectId, firstEffect.recordId, oldOwner!).pipe(Effect.exit))
            ._tag,
        ).toBe("Failure");
        const state = yield* readCurrentState(f.sql, f.projectId);
        expect(
          state.foundationRecords!.find((record) => record.recordId === original.recordId)?.status,
        ).toBe("superseded");
        const nextEffect = state.foundationRecords!.find(
          (record) =>
            record.kind === "effect" &&
            record.effectKind === "memory-index" &&
            record.targetId === corrected.recordId,
        )!;
        const owner = yield* f.service.claim(f.projectId, nextEffect.recordId);
        yield* f.service.extract(f.projectId, nextEffect.recordId, owner!);
        const work = yield* f.service.readWork(f.projectId, nextEffect.recordId);
        expect(work.observations).toHaveLength(1);
        expect(work.observations[0]!.sourceId).toBe(corrected.recordId);
        expect(
          (yield* readCurrentState(f.sql, f.projectId)).decisions!.find(
            (entry) => entry.decisionId === replacement.decisionId,
          )?.state,
        ).toBe("accepted");
        yield* f.service.retract(f.projectId, original.recordId);
        expect(
          (yield* f.service
            .captureRetained(f.projectId, { kind: "decision", retainedId: replacement.decisionId })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect(
  "derives managed project/task scope from current durable authority and denies retired roles",
  () =>
    ManagedFixture.scoped(
      Effect.gen(function* () {
        const f = yield* ManagedFixture.seed();
        const role = ManagedFixture.decodeRecord({
          ...f.role,
          recordId: "memory-enabled-role",
          memoryAccess: "project",
        });
        if (role.kind !== "role-revision") return yield* Effect.die("Invalid role fixture");
        yield* f.change(role);
        yield* f.change(
          ManagedFixture.decodeRecord({
            ...f.member,
            recordId: "memory-enabled-member",
            roleRevisionId: role.recordId,
          }),
        );
        const taskId = ProjectWorkTaskId.make("managed-memory-task");
        const threadId = ThreadId.make("managed-memory-thread");
        const binding = yield* ManagedFixture.createManagedAssignment({
          taskId,
          recordId: "managed-memory-binding",
          sessionId: "fixture-managed-memory-session",
          attemptId: "managed-memory-attempt",
          commandId: "managed-memory-dispatch",
          providerInstanceId: f.binding.providerInstanceId,
          threadId,
          memberId: "memory-enabled-member",
          role,
          status: "running",
          configuration: f.binding.configuration,
        });
        const issued = yield* f.auth.issueCredential({
          providerInstanceId: binding.providerInstanceId,
          threadId,
        });
        expect(issued).toBeDefined();
        const principal = {
          actor: { kind: "agent" as const, id: Authorization.managedActorId(issued!.credential) },
          managed: issued!.credential,
        };
        const comment = commentFixture({
          commentId: "managed-memory-comment",
          projectId: binding.projectId,
          taskId,
          body: "Current managed task finding",
          revision: 0,
          createdAt: memoryTestAt,
          attribution,
        });
        yield* f.repo.execute({
          type: "project-work.comment.add",
          projectId: binding.projectId,
          commandId: CommandId.make("managed-memory-comment-add"),
          comment,
          addedAt: memoryTestAt,
          attribution,
        });
        const contentGuard = yield* ContentGuard.ProjectWorkContentGuard;
        const service = makeProjectMemoryService({
          sql: f.sql,
          repository: f.repo,
          authorization: f.auth,
          contentGuard,
          environmentId: "fixture-environment",
        });
        const source = yield* service.capture(principal, {
          kind: "comment",
          retainedId: comment.commentId,
        });
        expect(source.projectId).toBe(binding.projectId);
        expect(source.attribution).toEqual(comment.attribution);
        const wrongTaskComment = {
          ...comment,
          commentId: "other-task-comment",
          taskId: f.binding.taskId,
        };
        yield* f.repo.execute({
          type: "project-work.comment.add",
          projectId: binding.projectId,
          commandId: CommandId.make("other-task-comment-add"),
          comment: commentFixture(wrongTaskComment),
          addedAt: memoryTestAt,
          attribution,
        });
        expect(
          (yield* service
            .capture(principal, { kind: "comment", retainedId: wrongTaskComment.commentId })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        yield* f.change(ManagedFixture.decodeRecord({ ...role, revision: 1, status: "retired" }));
        expect(
          (yield* service
            .capture(principal, { kind: "comment", retainedId: comment.commentId })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* f.sql`SELECT * FROM project_team_memory_source`).toHaveLength(1);
      }).pipe(Effect.provide(ContentGuard.layer)),
    ),
);

it.effect(
  "uses the live repository guard to reject unsafe replay and retain an authorized redacted tombstone",
  () =>
    withMemoryDatabase(
      Effect.gen(function* () {
        const f = yield* memorySetup();
        const source = yield* f.service.captureRetained(f.projectId, {
          kind: "comment",
          retainedId: f.comment.commentId,
        });
        const original = yield* f.sql<{
          payload: string;
        }>`SELECT input_json AS payload FROM project_team_memory_job`;
        yield* f.contentGuard.registerKnownSecrets(["exact provenance"]);
        expect(
          (yield* memoryCommit(f.projectId, [
            {
              ...source,
              status: "retracted",
              revision: source.revision + 1,
              generation: source.generation + 1,
              tombstonedAt: memoryTestAt,
              updatedAt: memoryTestAt,
            },
          ]).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(
          (yield* readCurrentState(f.sql, f.projectId)).foundationRecords!.find(
            (record) => record.recordId === source.recordId,
          )?.status,
        ).toBe("current");
        yield* f.service.retract(f.projectId, source.recordId);
        const current = (yield* readCurrentState(f.sql, f.projectId)).foundationRecords!.find(
          (record) => record.recordId === source.recordId,
        );
        if (current?.kind !== "memory-source") return yield* Effect.die("Missing source tombstone");
        expect(current).toMatchObject({
          status: "retracted",
          sourceId: source.sourceId,
          sourceRevision: source.sourceRevision,
          generation: source.generation + 1,
          attribution: source.attribution,
          sharedWithProjectIds: [],
        });
        expect(current.content).not.toContain("exact provenance");
        expect(current.content).toContain("[REDACTED_SECRET]");
        expect(current.contentHash).toBe(projectMemoryHash(current.content));
        expect(current.contentHash).not.toBe(source.contentHash);
        expect(yield* f.contentGuard.assertSafe(current).pipe(Effect.exit)).toMatchObject({
          _tag: "Success",
        });
        const retained = yield* f.sql<{
          payload: string;
        }>`SELECT input_json AS payload FROM project_team_memory_job WHERE input_json=${original[0]!.payload}`;
        expect(retained).toEqual(original);
        expect(original[0]!.payload).toContain("exact provenance");
        expect(yield* f.sql`SELECT * FROM project_team_memory_job`).toHaveLength(2);
        expect(
          (yield* f.service
            .captureRetained(f.projectId, { kind: "comment", retainedId: f.comment.commentId })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect("fences and redacts newly known secrets hidden by cached JSON escaping", () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      let calls = 0;
      const base = memoryModels();
      const f = yield* memorySetup({
        ...base,
        extract: (input) => {
          calls++;
          return base.extract(input);
        },
      });
      const secret = 'line one\n"quoted" line two';
      const comment = commentFixture({
        ...f.comment,
        commentId: "escaped-secret-comment",
        body: `A retained finding contains ${secret}.`,
      });
      yield* f.repository.execute({
        type: "project-work.comment.add",
        projectId: f.projectId,
        commandId: CommandId.make("escaped-secret-comment-add"),
        comment,
        attribution,
        addedAt: memoryTestAt,
      });
      const source = yield* f.service.captureRetained(f.projectId, {
        kind: "comment",
        retainedId: comment.commentId,
      });
      expect(source.content).not.toContain(secret);
      const effect = (yield* readCurrentState(f.sql, f.projectId)).foundationRecords!.find(
        (record) => record.kind === "effect" && record.targetId === source.recordId,
      )!;
      const owner = yield* f.service.claim(f.projectId, effect.recordId);
      yield* f.contentGuard.registerKnownSecrets([secret]);
      expect(
        (yield* f.service.extract(f.projectId, effect.recordId, owner!).pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect(calls).toBe(0);
      yield* f.service.retract(f.projectId, source.recordId);
      const current = (yield* readCurrentState(f.sql, f.projectId)).foundationRecords!.find(
        (record) => record.recordId === source.recordId,
      );
      if (current?.kind !== "memory-source")
        return yield* Effect.die("Missing escaped-secret tombstone");
      expect(current.status).toBe("retracted");
      expect(current.content).toContain("[REDACTED_SECRET]");
      expect(current.content).not.toContain("quoted");
      expect(current.contentHash).toBe(projectMemoryHash(current.content));
      expect(current.attribution).toEqual(source.attribution);
    }),
  ),
);

for (const scenario of ["live", "guard-expiry", "after-writes-expiry", "duplicate-expiry"] as const)
  it.effect(`repair capture final authority ${scenario}`, () =>
    ManagedFixture.scoped(
      Effect.gen(function* () {
        const f = yield* ManagedFixture.seed();
        const role = ManagedFixture.decodeRecord({
          ...f.role,
          recordId: "repair-memory-role",
          memoryAccess: "project",
        });
        if (role.kind !== "role-revision") return yield* Effect.die("Invalid repair role");
        yield* f.change(role);
        yield* f.change(
          ManagedFixture.decodeRecord({
            ...f.member,
            recordId: "repair-memory-member",
            roleRevisionId: role.recordId,
          }),
        );
        const taskId = ProjectWorkTaskId.make("repair-managed-task");
        const threadId = ThreadId.make("repair-managed-thread");
        const binding = yield* ManagedFixture.createManagedAssignment({
          taskId,
          threadId,
          recordId: "repair-managed-binding",
          attemptId: "repair-managed-attempt",
          commandId: "repair-managed-dispatch",
          providerInstanceId: f.binding.providerInstanceId,
          memberId: "repair-memory-member",
          role,
          status: "running",
          configuration: f.binding.configuration,
          sessionId: "repair-managed-session",
        });
        const issued = yield* f.auth.issueCredential({
          providerInstanceId: binding.providerInstanceId,
          threadId,
        });
        const principal = {
          actor: { kind: "agent" as const, id: Authorization.managedActorId(issued!.credential) },
          managed: issued!.credential,
        };
        const comment = commentFixture({
          commentId: "repair-managed-comment",
          projectId: binding.projectId,
          taskId,
          body: "Current scoped finding",
          revision: 0,
          createdAt: memoryTestAt,
          attribution,
        });
        yield* f.repo.execute({
          type: "project-work.comment.add",
          projectId: binding.projectId,
          commandId: CommandId.make("repair-managed-comment-add"),
          comment,
          attribution,
          addedAt: memoryTestAt,
        });
        const originalGuard = yield* ContentGuard.ProjectWorkContentGuard;
        const dependencies = {
          sql: f.sql,
          repository: f.repo,
          contentGuard: originalGuard,
          authorization: f.auth,
          environmentId: "fixture-environment",
        };
        const selector = { kind: "comment", retainedId: comment.commentId };
        if (scenario === "duplicate-expiry")
          yield* makeProjectMemoryService(dependencies).capture(principal, selector);
        const beforeEvents = yield* f.sql`SELECT * FROM project_work_events`;
        const beforeState = yield* readCurrentState(f.sql, binding.projectId);
        const beforeJobs = yield* f.sql`SELECT * FROM project_team_memory_job`;
        const beforeSources = yield* f.sql`SELECT * FROM project_team_memory_source`;
        const beforeExtractions = yield* f.sql`SELECT * FROM project_team_memory_extraction`;
        let finalObservedWrites = false;
        const repository: typeof f.repo = {
          ...f.repo,
          executeAtomic: (prepare, finalValidate) =>
            f.repo.executeAtomic(
              prepare,
              Effect.gen(function* () {
                // Observe real command and journal writes inside the repository-owned transaction.
                const jobs = yield* f.sql`SELECT * FROM project_team_memory_job`.pipe(
                  Effect.mapError(toPersistenceSqlError("repair.finalObservation")),
                );
                const state = yield* readCurrentState(f.sql, binding.projectId).pipe(
                  Effect.mapError(toPersistenceSqlError("repair.finalObservation")),
                );
                finalObservedWrites =
                  jobs.length === 1 &&
                  state.foundationRecords!.some((record) => record.kind === "memory-source");
                if (scenario === "after-writes-expiry")
                  yield* TestClock.setTime(Date.parse("2031-01-01T00:00:00.000Z"));
                if (finalValidate !== undefined) yield* finalValidate;
              }),
            ),
        };
        const contentGuard = {
          ...originalGuard,
          assertSafe: (value: unknown) =>
            Effect.gen(function* () {
              yield* originalGuard.assertSafe(value);
              if (scenario === "guard-expiry" || scenario === "duplicate-expiry")
                yield* TestClock.setTime(Date.parse("2031-01-01T00:00:00.000Z"));
            }),
        };
        const service = makeProjectMemoryService({ ...dependencies, repository, contentGuard });
        const result = yield* service.capture(principal, selector).pipe(Effect.exit);
        expect(finalObservedWrites).toBe(true);
        if (scenario === "live") {
          expect(result._tag).toBe("Success");
          expect(yield* f.sql`SELECT * FROM project_team_memory_job`).toHaveLength(1);
          expect((yield* f.auth.resolve(principal).pipe(Effect.exit))._tag).toBe("Success");
        } else {
          expect((yield* f.auth.resolve(principal).pipe(Effect.exit))._tag).toBe("Failure");
          expect(result._tag).toBe("Failure");
          expect(yield* f.sql`SELECT * FROM project_work_events`).toEqual(beforeEvents);
          expect(yield* readCurrentState(f.sql, binding.projectId)).toEqual(beforeState);
          expect(yield* f.sql`SELECT * FROM project_team_memory_job`).toEqual(beforeJobs);
          expect(yield* f.sql`SELECT * FROM project_team_memory_source`).toEqual(beforeSources);
          expect(yield* f.sql`SELECT * FROM project_team_memory_extraction`).toEqual(
            beforeExtractions,
          );
        }
      }).pipe(Effect.provide(ContentGuard.layer)),
    ),
  );

for (const scenario of ["plain", "escaped", "absent", "metadata"] as const)
  it.effect(`repair extraction quotes use original text ${scenario}`, () =>
    withMemoryDatabase(
      Effect.gen(function* () {
        const escaped = 'line one\n"quoted" line \\two';
        const quote =
          scenario === "plain"
            ? "source provenance"
            : scenario === "escaped"
              ? escaped
              : scenario === "metadata"
                ? "repair-quote-comment"
                : "genuinely absent quote";
        const f = yield* memorySetup(
          memoryModels([{ key: "quoted", body: "Sourced retained finding.", quote }]),
        );
        const comment = commentFixture({
          ...f.comment,
          commentId: "repair-quote-comment",
          body: `A retained finding preserves source provenance and ${escaped}.`,
        });
        yield* f.repository.execute({
          type: "project-work.comment.add",
          projectId: f.projectId,
          commandId: CommandId.make("repair-quote-comment-add"),
          comment,
          attribution,
          addedAt: memoryTestAt,
        });
        const source = yield* f.service.captureRetained(f.projectId, {
          kind: "comment",
          retainedId: comment.commentId,
        });
        const effect = (yield* readCurrentState(f.sql, f.projectId)).foundationRecords!.find(
          (record) => record.kind === "effect" && record.targetId === source.recordId,
        )!;
        const owner = yield* f.service.claim(f.projectId, effect.recordId);
        const result = yield* f.service
          .extract(f.projectId, effect.recordId, owner!)
          .pipe(Effect.exit);
        const success = scenario === "plain" || scenario === "escaped";
        expect(result._tag).toBe(success ? "Success" : "Failure");
        const work = yield* f.service.readWork(f.projectId, effect.recordId);
        expect(work.observations).toHaveLength(success ? 1 : 0);
        expect(work.source.contentHash).toBe(projectMemoryHash(work.source.content));
        expect(work.source.sourceRevision).toBe(comment.revision);
        expect(work.source.attribution).toEqual(comment.attribution);
      }),
    ),
  );
