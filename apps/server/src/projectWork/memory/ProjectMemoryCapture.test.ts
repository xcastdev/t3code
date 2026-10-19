import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkComment,
  ProjectWorkDecision,
  ProjectMemoryObservation,
  type ProjectMemorySource,
  ProviderInstanceId,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "../ProjectWorkRepository.ts";
import * as ContentGuard from "../ProjectWorkContentGuard.ts";
import * as Authorization from "../ProjectTeamAuthorization.ts";
import { makeProjectMemoryService, ProjectMemoryServiceError } from "./ProjectMemoryService.ts";
import { readProjectMemoryObservations } from "./ProjectMemoryRetrieval.ts";
import { makeProjectMemoryCapture } from "./ProjectMemoryCapture.ts";
import { compileProjectTeamConfiguration } from "../ProjectTeamConfiguration.ts";
import { ProjectWorkEventBus, ProjectWorkEventBusLive } from "../ProjectWorkEventBus.ts";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService, layer as settingsLayer } from "../../serverSettings.ts";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";

const decodeComment = Schema.decodeUnknownEffect(ProjectWorkComment);
const decodeDecision = Schema.decodeUnknownEffect(ProjectWorkDecision);
const decodeObservation = Schema.decodeUnknownEffect(ProjectMemoryObservation);
const at = "2026-10-06T00:00:00.000Z";
const projectId = ProjectId.make("capture-project");
const taskId = ProjectWorkTaskId.make("capture-task");
const attribution = {
  actor: { kind: "human", id: "maintainer" },
  source: { kind: "web", id: "web" },
  recordedAt: at,
} as const;
const database = Layer.mergeAll(
  ProjectWorkRepositoryLive,
  Authorization.layer,
  ContentGuard.layer,
).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
const captureDatabase = Layer.mergeAll(
  ProjectWorkRepositoryLive.pipe(Layer.provide(ProjectWorkEventBusLive)),
  ProjectWorkEventBusLive,
  Authorization.layer,
  ContentGuard.layer,
  settingsLayer.pipe(Layer.provide(Secrets.layer)),
).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-memory-capture-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Capture project','/fixture/capture','[]',${at},${at})`;
  yield* repository.execute({
    type: "project-work.task.create",
    projectId,
    taskId,
    commandId: CommandId.make("capture-task-create"),
    title: "Investigate parser",
    createdAt: at,
  });
  const comment = yield* decodeComment({
    commentId: "capture-comment",
    projectId,
    taskId,
    body: "The parser retains exact source provenance.",
    revision: 0,
    createdAt: at,
    attribution,
  });
  yield* repository.execute({
    type: "project-work.comment.add",
    projectId,
    commandId: CommandId.make("capture-comment-add"),
    comment,
    attribution,
    addedAt: at,
  });
  return {
    sql,
    repository,
    contentGuard: yield* ContentGuard.ProjectWorkContentGuard,
    authorization: yield* Authorization.ProjectTeamAuthorization,
    environmentId: "capture-environment",
  };
});
const configure = Effect.gen(function* () {
  const repository = yield* ProjectWorkRepository;
  const sql = yield* SqlClient.SqlClient;
  const state = yield* readCurrentState(sql, projectId);
  yield* repository.execute(
    compileProjectTeamConfiguration(
      state,
      {
        type: "project-team.configure",
        commandId: CommandId.make("capture-configure"),
        projectId,
        expectedRevision: state.revision,
        expectedConfigurationGeneration: 0,
        enabled: true,
        providerInstanceId: ProviderInstanceId.make("capture-pi"),
        projectPriority: 0,
        taskPriorities: [],
        profiles: (
          [
            "coordinator",
            "investigator",
            "planner",
            "implementer",
            "reviewer",
            "integrator",
          ] as const
        ).map((role) => ({
          role,
          instructions: "Retain sourced findings",
          skills: [],
          tools: ["pi.read"],
          model: "fixture-model",
          memoryAccess: "project",
          delegationDepth: 0,
        })),
        modelPolicies: [
          { model: "fixture-model", tokenLimit: 4096, durationLimitMs: 60000, modelCalls: 1 },
        ],
      },
      attribution,
    ),
  );
  yield* (yield* ServerSettingsService).updateSettings({
    projectWorkEnabled: true,
    projectTeamExecutionEnabled: true,
  });
});

it.effect(
  "rolls back source, extraction and work when capture permission expires before commit",
  () =>
    Effect.gen(function* () {
      const dependencies = yield* fixture;
      const before = yield* readCurrentState(dependencies.sql, projectId);
      let admitted = false;
      const authorizeCapture = () =>
        Effect.suspend(() => {
          if (admitted)
            return Effect.fail(
              new ProjectMemoryServiceError({ reason: "Capture permission expired" }),
            );
          admitted = true;
          return Effect.void;
        });
      const service = makeProjectMemoryService({ ...dependencies, authorizeCapture });
      const outcome = yield* service
        .captureRetained(projectId, { kind: "comment", retainedId: "capture-comment" })
        .pipe(Effect.result);
      expect(outcome._tag).toBe("Failure");
      expect(yield* dependencies.sql`SELECT * FROM project_team_memory_source`).toHaveLength(0);
      expect(yield* dependencies.sql`SELECT * FROM project_team_memory_extraction`).toHaveLength(0);
      expect(yield* dependencies.sql`SELECT * FROM project_team_memory_job`).toHaveLength(0);
      expect(yield* readCurrentState(dependencies.sql, projectId)).toEqual(before);
    }).pipe(Effect.provide(database)),
);

it.effect("a retained duplicate cannot bypass a newly closed capture gate", () =>
  Effect.gen(function* () {
    const dependencies = yield* fixture;
    let allowed = true;
    const service = makeProjectMemoryService({
      ...dependencies,
      authorizeCapture: () =>
        Effect.suspend(() =>
          allowed
            ? Effect.void
            : Effect.fail(new ProjectMemoryServiceError({ reason: "Capture is disabled" })),
        ),
    });
    const selector = { kind: "comment", retainedId: "capture-comment" };
    const source = yield* service.captureRetained(projectId, selector);
    expect(source.content).toContain("exact source provenance");
    const before = yield* readCurrentState(dependencies.sql, projectId);
    allowed = false;
    expect((yield* service.captureRetained(projectId, selector).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(yield* dependencies.sql`SELECT * FROM project_team_memory_source`).toHaveLength(1);
    expect(yield* dependencies.sql`SELECT * FROM project_team_memory_job`).toHaveLength(1);
    expect(yield* readCurrentState(dependencies.sql, projectId)).toEqual(before);
  }).pipe(Effect.provide(database)),
);

it.effect(
  "startup captures an existing configured finding once and restart does not duplicate queued work",
  () =>
    Effect.gen(function* () {
      const { sql } = yield* fixture;
      yield* configure;
      const first = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" });
      yield* first.ready;
      expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(1);
      expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(1);
      const before = yield* readCurrentState(sql, projectId);
      yield* first.stop;
      const second = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" });
      yield* second.ready;
      expect(yield* readCurrentState(sql, projectId)).toEqual(before);
      expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(1);
      yield* second.stop;
    }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect("committed findings wake capture without capturing its own foundation writes", () =>
  Effect.gen(function* () {
    const { sql, repository } = yield* fixture;
    yield* configure;
    const capture = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" });
    yield* capture.ready;
    const comment = yield* decodeComment({
      commentId: "later-comment",
      projectId,
      taskId,
      body: "The second observation preserves its own provenance.",
      revision: 0,
      createdAt: at,
      attribution,
    });
    yield* repository.execute({
      type: "project-work.comment.add",
      projectId,
      commandId: CommandId.make("later-comment-add"),
      comment,
      attribution,
      addedAt: at,
    });
    const cursor = (yield* sql<{
      cursor: number;
    }>`SELECT MAX(sequence) AS cursor FROM project_work_events`)[0]!.cursor;
    yield* capture.drain(cursor);
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(2);
    expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(2);
    const before = yield* readCurrentState(sql, projectId);
    yield* capture.drain();
    expect(yield* readCurrentState(sql, projectId)).toEqual(before);
    yield* capture.stop;
  }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect(
  "unconfigured projects remain untouched and human configuration catches up their sources",
  () =>
    Effect.gen(function* () {
      const { sql } = yield* fixture;
      yield* (yield* ServerSettingsService).updateSettings({
        projectWorkEnabled: true,
        projectTeamExecutionEnabled: true,
      });
      const capture = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" });
      yield* capture.ready;
      expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(0);
      yield* configure;
      const cursor = (yield* sql<{
        cursor: number;
      }>`SELECT MAX(sequence) AS cursor FROM project_work_events`)[0]!.cursor;
      yield* capture.drain(cursor);
      expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(1);
      yield* capture.stop;
    }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect("disabled capture leaves sources untouched and enabling catches up", () =>
  Effect.gen(function* () {
    const { sql, repository } = yield* fixture;
    yield* configure;
    const settings = yield* ServerSettingsService;
    yield* settings.updateSettings({ projectTeamExecutionEnabled: false });
    const capture = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" });
    yield* capture.ready;
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(0);
    yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
    const comment = yield* decodeComment({
      commentId: "enabled-comment",
      projectId,
      taskId,
      body: "A finding retained after enabling.",
      revision: 0,
      createdAt: at,
      attribution,
    });
    yield* repository.execute({
      type: "project-work.comment.add",
      projectId,
      commandId: CommandId.make("enabled-comment-add"),
      comment,
      attribution,
      addedAt: at,
    });
    yield* capture.drain(
      (yield* sql<{ cursor: number }>`SELECT MAX(sequence) AS cursor FROM project_work_events`)[0]!
        .cursor,
    );
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(2);
    yield* capture.stop;
  }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect("shutdown joins a worker held at server activation without capturing", () =>
  Effect.gen(function* () {
    const { sql } = yield* fixture;
    yield* configure;
    const activation = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const capture = yield* makeProjectMemoryCapture({
      environmentId: "capture-environment",
      ready: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(activation))),
    });
    yield* Deferred.await(entered);
    yield* capture.stop;
    yield* capture.ready;
    yield* capture.drain(999);
    yield* Deferred.succeed(activation, undefined);
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(0);
    expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect(
  "suppresses superseded decisions before replacement acceptance without reviving old observations",
  () =>
    Effect.gen(function* () {
      const dependencies = yield* fixture;
      const { sql, repository } = dependencies;
      const service = makeProjectMemoryService(dependencies);
      const retainObservation = Effect.fn("retainObservation")(function* (
        source: ProjectMemorySource,
      ) {
        yield* repository.executeAtomic(
          Effect.gen(function* () {
            const state = yield* readCurrentState(sql, projectId);
            const extraction = state.foundationRecords!.find(
              (record) =>
                record.kind === "memory-extraction" && record.sourceId === source.recordId,
            );
            if (extraction?.kind !== "memory-extraction")
              return yield* Effect.die("Missing extraction");
            const observation = yield* decodeObservation({
              kind: "memory-observation",
              recordId: `observation:${source.recordId}`,
              projectId,
              revision: 0,
              generation: source.generation,
              updatedAt: at,
              status: "current",
              sourceId: source.recordId,
              sourceRevision: source.sourceRevision,
              sourceGeneration: source.generation,
              extractionId: extraction.recordId,
              observationKey: "strategy",
              body: source.content,
              provenance: source.attribution,
            });
            return yield* service.commit(
              state,
              [
                {
                  ...extraction,
                  revision: extraction.revision + 1,
                  status: "extracted",
                  extractionHash: "fixture-hash",
                  expectedObservationIds: [observation.recordId],
                },
                observation,
              ],
              at,
            );
          }),
        );
      });
      const retrieve = () => readProjectMemoryObservations(sql, projectId, "parser");
      yield* configure;
      const capture = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" });
      yield* capture.ready;
      const decision = yield* decodeDecision({
        decisionId: "capture-decision",
        projectId,
        title: "Parser strategy",
        body: "Retain a stable parser strategy.",
        state: "proposed",
        revision: 0,
        createdAt: at,
        updatedAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.decision.propose",
        projectId,
        commandId: CommandId.make("decision-propose"),
        decision,
        proposedAt: at,
        attribution,
      });
      yield* capture.drain(
        (yield* sql<{
          cursor: number;
        }>`SELECT MAX(sequence) AS cursor FROM project_work_events`)[0]!.cursor,
      );
      expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(1);
      yield* repository.execute({
        type: "project-work.decision.accept",
        projectId,
        commandId: CommandId.make("decision-accept"),
        decisionId: decision.decisionId,
        acceptedAt: at,
        attribution,
      });
      yield* capture.drain(
        (yield* sql<{
          cursor: number;
        }>`SELECT MAX(sequence) AS cursor FROM project_work_events`)[0]!.cursor,
      );
      const original = (yield* readCurrentState(sql, projectId)).foundationRecords!.find(
        (record) => record.kind === "memory-source" && record.sourceKind === "decision",
      );
      expect(original?.kind).toBe("memory-source");
      if (original?.kind !== "memory-source") return yield* Effect.die("Missing original source");
      const unrelated = (yield* readCurrentState(sql, projectId)).foundationRecords!.find(
        (record) => record.kind === "memory-source" && record.sourceKind === "finding",
      );
      if (unrelated?.kind !== "memory-source") return yield* Effect.die("Missing unrelated source");
      yield* retainObservation(original);
      yield* retainObservation(unrelated);
      expect((yield* retrieve()).records.map((record) => record.sourceId).sort()).toEqual(
        [original.recordId, unrelated.recordId].sort(),
      );
      const replacement = yield* decodeDecision({
        ...decision,
        decisionId: "capture-replacement",
        body: "Retain the corrected parser strategy.",
      });
      yield* repository.execute({
        type: "project-work.decision.supersede",
        projectId,
        commandId: CommandId.make("decision-supersede"),
        decisionId: decision.decisionId,
        replacement,
        supersededAt: at,
        attribution,
      });
      yield* capture.drain(
        (yield* sql<{
          cursor: number;
        }>`SELECT MAX(sequence) AS cursor FROM project_work_events`)[0]!.cursor,
      );
      const pending = yield* retrieve();
      expect(pending.status).toBe("available");
      expect(pending.records.map((record) => record.sourceId)).toEqual([unrelated.recordId]);
      const pendingState = yield* readCurrentState(sql, projectId);
      expect(
        pendingState.foundationRecords!.find((record) => record.recordId === original.recordId),
      ).toMatchObject({ status: "superseded" });
      expect(
        pendingState.foundationRecords!.find((record) => record.recordId === unrelated.recordId),
      ).toEqual(unrelated);
      expect(
        pendingState.foundationRecords!.filter(
          (record) => record.kind === "memory-source" && record.sourceKind === "decision",
        ),
      ).toHaveLength(1);
      expect(
        yield* sql`SELECT effect_id FROM project_team_memory_job
        WHERE json_extract(input_json, '$.effect.effectKind')='memory-delete'`,
      ).toHaveLength(1);
      const beforeReplay = pendingState;
      yield* capture.stop;
      const restarted = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" });
      yield* restarted.ready;
      expect(yield* readCurrentState(sql, projectId)).toEqual(beforeReplay);
      yield* repository.execute({
        type: "project-work.decision.accept",
        projectId,
        commandId: CommandId.make("replacement-accept"),
        decisionId: replacement.decisionId,
        acceptedAt: at,
        attribution,
      });
      yield* restarted.drain(
        (yield* sql<{
          cursor: number;
        }>`SELECT MAX(sequence) AS cursor FROM project_work_events`)[0]!.cursor,
      );
      const sources = (yield* readCurrentState(sql, projectId)).foundationRecords!.filter(
        (record) => record.kind === "memory-source" && record.sourceKind === "decision",
      );
      expect(sources).toHaveLength(2);
      expect(sources.find((record) => record.status === "current")).toMatchObject({
        supersedes: original.recordId,
      });
      const accepted = sources.find((record) => record.status === "current");
      if (accepted?.kind !== "memory-source") return yield* Effect.die("Missing accepted source");
      expect(accepted.generation).toBe(original.generation + 1);
      yield* retainObservation(accepted);
      expect((yield* retrieve()).records.map((record) => record.sourceId).sort()).toEqual(
        [accepted.recordId, unrelated.recordId].sort(),
      );
      yield* restarted.drain();
      expect(
        (yield* retrieve()).records.some((record) => record.sourceId === original.recordId),
      ).toBe(false);
      yield* restarted.stop;
    }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect("a newly known secret prevents capture without starving later safe sources", () =>
  Effect.gen(function* () {
    const { sql, repository, contentGuard } = yield* fixture;
    yield* configure;
    yield* contentGuard.registerKnownSecrets(["exact source provenance"]);
    const capture = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" });
    yield* capture.ready;
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(0);
    const comment = yield* decodeComment({
      commentId: "safe-comment",
      projectId,
      taskId,
      body: "The next observation is safe to retain.",
      revision: 0,
      createdAt: at,
      attribution,
    });
    yield* repository.execute({
      type: "project-work.comment.add",
      projectId,
      commandId: CommandId.make("safe-comment-add"),
      comment,
      attribution,
      addedAt: at,
    });
    yield* capture.drain(
      (yield* sql<{ cursor: number }>`SELECT MAX(sequence) AS cursor FROM project_work_events`)[0]!
        .cursor,
    );
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(1);
    expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(1);
    yield* capture.stop;
  }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect("enabling alone wakes retained-source catch-up without a new finding", () =>
  Effect.gen(function* () {
    const { sql } = yield* fixture;
    yield* configure;
    const settings = yield* ServerSettingsService;
    yield* settings.updateSettings({ projectTeamExecutionEnabled: false });
    const capture = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" });
    yield* capture.ready;
    const events = yield* (yield* ProjectWorkEventBus).subscribe;
    const receipt = yield* events.pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "project-work.foundation.recorded" &&
          event.record.kind === "memory-source",
      ),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
    expect((yield* Fiber.join(receipt))._tag).toBe("Some");
    yield* capture.drain();
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(1);
    expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(1);
    yield* capture.stop;
  }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect("a failed SQL capture rolls back and drain retries after storage recovers", () =>
  Effect.gen(function* () {
    const { sql } = yield* fixture;
    yield* configure;
    yield* sql`CREATE TRIGGER fail_capture BEFORE INSERT ON project_team_memory_source
      BEGIN SELECT RAISE(ABORT,'controlled capture storage failure'); END`;
    const capture = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" });
    expect((yield* capture.ready.pipe(Effect.result))._tag).toBe("Failure");
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(0);
    expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(0);
    yield* sql`DROP TRIGGER fail_capture`;
    yield* capture.drain();
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(1);
    expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(1);
    yield* capture.stop;
  }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect("startup drains multiple bounded pages despite its own new committed events", () =>
  Effect.gen(function* () {
    const { sql, repository } = yield* fixture;
    yield* configure;
    for (let index = 0; index < 129; index += 1) {
      const comment = yield* decodeComment({
        commentId: `page-comment-${index}`,
        projectId,
        taskId,
        body: `Retained finding ${index} has an independent source.`,
        revision: 0,
        createdAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.comment.add",
        projectId,
        commandId: CommandId.make(`page-comment-add-${index}`),
        comment,
        attribution,
        addedAt: at,
      });
    }
    const capture = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" });
    yield* capture.ready;
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(130);
    expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(130);
    yield* capture.drain();
    expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(130);
    yield* capture.stop;
  }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect("capture cannot inherit a caller-owned SQL transaction", () =>
  Effect.gen(function* () {
    const { sql } = yield* fixture;
    yield* configure;
    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const capture = yield* makeProjectMemoryCapture({
            environmentId: "capture-environment",
            ready: Effect.never,
          });
          yield* capture.stop;
        }),
      )
      .pipe(Effect.result);
    expect(outcome._tag).toBe("Failure");
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect("disabling during capture rolls back before commit and enabling retries", () =>
  Effect.gen(function* () {
    const { sql, contentGuard } = yield* fixture;
    yield* configure;
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const capture = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" }).pipe(
      Effect.provideService(ContentGuard.ProjectWorkContentGuard, {
        ...contentGuard,
        assertSafe: (value) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(released)),
            Effect.andThen(contentGuard.assertSafe(value)),
          ),
      }),
    );
    yield* Deferred.await(entered);
    const settings = yield* ServerSettingsService;
    yield* settings.updateSettings({ projectTeamExecutionEnabled: false });
    yield* Deferred.succeed(released, undefined);
    yield* capture.ready;
    yield* capture.drain();
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(0);
    expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(0);
    const events = yield* (yield* ProjectWorkEventBus).subscribe;
    const receipt = yield* events.pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "project-work.foundation.recorded" &&
          event.record.kind === "memory-source",
      ),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
    yield* Fiber.join(receipt);
    yield* capture.drain();
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(1);
    expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(1);
    yield* capture.stop;
  }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect("configuration SQL read failure retains capture eligibility after storage recovers", () =>
  Effect.gen(function* () {
    const { sql } = yield* fixture;
    yield* configure;
    yield* sql`ALTER TABLE project_work_reducer_checkpoints RENAME TO held_checkpoints`;
    const capture = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" });
    const initial = yield* capture.ready.pipe(Effect.result);
    yield* capture.drain().pipe(Effect.result);
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(0);
    yield* sql`ALTER TABLE held_checkpoints RENAME TO project_work_reducer_checkpoints`;
    yield* capture.drain();
    expect(initial._tag).toBe("Failure");
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(1);
    expect(yield* sql`SELECT * FROM project_team_memory_job`).toHaveLength(1);
    yield* capture.stop;
  }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

it.effect("a settings read failure inside capture remains retryable", () =>
  Effect.gen(function* () {
    const { sql } = yield* fixture;
    yield* configure;
    const settings = yield* ServerSettingsService;
    let reads = 0;
    let restored = false;
    const capture = yield* makeProjectMemoryCapture({ environmentId: "capture-environment" }).pipe(
      Effect.provideService(ServerSettingsService, {
        ...settings,
        getSettings: Effect.suspend(() => {
          reads += 1;
          if (!restored && reads > 1)
            return Effect.fail(
              new ServerSettingsError({
                settingsPath: "/fixture/capture/settings.json",
                operation: "read-file",
                cause: new Error("Controlled settings read failure"),
              }),
            );
          return settings.getSettings;
        }),
      }),
    );
    const initial = yield* capture.ready.pipe(Effect.result);
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toHaveLength(0);
    restored = true;
    yield* capture.drain();
    expect({
      initial: initial._tag,
      sources: (yield* sql`SELECT * FROM project_team_memory_source`).length,
    }).toEqual({ initial: "Failure", sources: 1 });
    yield* capture.stop;
  }).pipe(Effect.scoped, Effect.provide(captureDatabase)),
);

for (const duplicate of [false, true]) {
  it.effect(
    `late known secrets deny ${duplicate ? "duplicate" : "first"} capture after final authorization`,
    () =>
      Effect.gen(function* () {
        const dependencies = yield* fixture;
        const secret = 'retained boundary\n"private phrase"';
        const comment = yield* decodeComment({
          commentId: "late-secret-comment",
          projectId,
          taskId,
          body: `A captured finding includes ${secret}.`,
          revision: 0,
          createdAt: at,
          attribution,
        });
        yield* dependencies.repository.execute({
          type: "project-work.comment.add",
          projectId,
          commandId: CommandId.make("late-secret-comment-add"),
          comment,
          attribution,
          addedAt: at,
        });
        const selector = { kind: "comment", retainedId: comment.commentId };
        if (duplicate) {
          const original = yield* makeProjectMemoryService(dependencies).captureRetained(
            projectId,
            selector,
          );
          expect(original.content).not.toContain(secret);
        }
        const before = yield* readCurrentState(dependencies.sql, projectId);
        const sources = yield* dependencies.sql`SELECT * FROM project_team_memory_source`;
        const extractions = yield* dependencies.sql`SELECT * FROM project_team_memory_extraction`;
        const jobs = yield* dependencies.sql`SELECT * FROM project_team_memory_job`;
        const events = yield* dependencies.sql`SELECT * FROM project_work_events ORDER BY sequence`;
        expect(sources).toHaveLength(duplicate ? 1 : 0);
        let calls = 0;
        let observedWrites = false;
        const service = makeProjectMemoryService({
          ...dependencies,
          authorizeCapture: () =>
            Effect.gen(function* () {
              expect((yield* Effect.serviceOption(dependencies.sql.transactionService))._tag).toBe(
                "Some",
              );
              calls += 1;
              if (calls === 2) {
                const rows = yield* dependencies.sql<{ payload_json: string }>`
                  SELECT payload_json FROM project_team_memory_source`;
                observedWrites = rows.length === 1;
                expect(rows).toHaveLength(1);
                expect(rows[0]?.payload_json).not.toContain(secret);
                expect(
                  yield* dependencies.sql`SELECT * FROM project_team_memory_extraction`,
                ).toHaveLength(1);
                expect(yield* dependencies.sql`SELECT * FROM project_team_memory_job`).toHaveLength(
                  1,
                );
                yield* dependencies.contentGuard.registerKnownSecrets([secret]);
              }
            }),
        });
        const outcome = yield* service.captureRetained(projectId, selector).pipe(Effect.result);
        expect(calls).toBe(2);
        expect(observedWrites).toBe(true);
        expect(
          (yield* dependencies.contentGuard.assertSafe(comment).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(outcome._tag).toBe("Failure");
        expect(yield* dependencies.sql`SELECT * FROM project_team_memory_source`).toEqual(sources);
        expect(yield* dependencies.sql`SELECT * FROM project_team_memory_extraction`).toEqual(
          extractions,
        );
        expect(yield* dependencies.sql`SELECT * FROM project_team_memory_job`).toEqual(jobs);
        expect(
          yield* dependencies.sql`SELECT * FROM project_work_events ORDER BY sequence`,
        ).toEqual(events);
        expect(yield* readCurrentState(dependencies.sql, projectId)).toEqual(before);
      }).pipe(Effect.provide(database)),
  );
}
