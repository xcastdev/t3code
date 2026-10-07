import {
  CommandId,
  ProjectId,
  ProjectWorkDecisionId,
  ProjectWorkKnowledgeId,
  ProjectWorkTaskId,
  ProjectWorkWriteIntent,
  ProjectWorkBriefing as BriefingRecord,
  type ProjectWorkAttribution,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import {
  buildProjectWorkBriefing,
  PROJECT_WORK_BRIEFING_BOUNDS,
  ProjectWorkBriefing,
  ProjectWorkBriefingLive,
} from "./ProjectWorkBriefing.ts";
import { ProjectWorkQuery, ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import type { ProjectWorkSnapshot } from "./ProjectWorkQuery.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { gatewayRuntime } from "./ProjectTeamAuthorization.testFixtures.ts";

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("briefing-project");
const decodeBriefingIntent = Schema.decodeUnknownEffect(ProjectWorkWriteIntent, {
  onExcessProperty: "error",
});
const decodeBriefingRecord = Schema.decodeUnknownEffect(BriefingRecord);

const correctionFixture = Effect.fn("briefingTest.correctionFixture")(function* () {
  const gateway = yield* ProjectWorkGateway;
  const sql = yield* SqlClient.SqlClient;
  const briefing = yield* ProjectWorkBriefing;
  const query = yield* ProjectWorkQuery;
  const owner = ProjectId.make("briefing-correction-project");
  const actor = { kind: "human" as const, id: "correction-maintainer" };
  const source = { kind: "web" as const, id: "correction-browser" };
  const write = (input: unknown) =>
    decodeBriefingIntent(input).pipe(
      Effect.flatMap((intent) => gateway.write(intent, actor, source)),
    );
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${owner},'Corrections','/corrections','[]',${at},${at})`;
  yield* write({
    type: "project-work.task.create",
    projectId: owner,
    commandId: "correction-task-create",
    taskId: "correction-task",
    title: "Keep the required task",
    createdAt: at,
  });
  yield* write({
    type: "project-work.decision.propose",
    projectId: owner,
    commandId: "correction-decision-propose",
    proposedAt: at,
    decision: {
      decisionId: "correction-decision",
      projectId: owner,
      title: "Keep the accepted constraint",
      body: "Required decisions survive optional knowledge failures.",
      state: "proposed",
      revision: 0,
      createdAt: at,
      updatedAt: at,
    },
  });
  yield* write({
    type: "project-work.decision.accept",
    projectId: owner,
    commandId: "correction-decision-accept",
    decisionId: "correction-decision",
    acceptedAt: at,
  });
  const promote = (id: string, previous?: string, updatedAt = at, createdAt = at) =>
    write({
      type: "project-work.knowledge.promote",
      projectId: owner,
      commandId: "correction-promote-" + id,
      promotedAt: at,
      knowledge: {
        knowledgeId: id,
        projectId: owner,
        title: id,
        body: "Body for " + id,
        sourceKind: "manual",
        sourceId: actor.id,
        revision: 0,
        createdAt,
        updatedAt,
        ...(previous === undefined ? {} : { supersedesKnowledgeId: previous }),
      },
    });
  return { gateway, sql, briefing, query, owner, promote };
});
const withCorrectionGateway = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(gatewayRuntime)));

const snapshot = (taskCount: number): ProjectWorkSnapshot => ({
  projectId,
  revision: 7,
  tasks: Array.from({ length: taskCount }, (_, index) => ({
    taskId: ProjectWorkTaskId.make(`task-${String(index).padStart(2, "0")}`),
    projectId,
    title: `Task ${index}`,
    summary: "A concise durable task summary.",
    state: index === 0 ? "in-progress" : "draft",
    watchers: [],
    revision: index + 1,
    specRevision: 0,
    createdAt: at,
    updatedAt: at,
  })),
  attempts: [],
  criteria: [],
  evidence: [],
  relationships: [],
  blockers: [],
  attention: [],
  activities: [],
  checkpoints: [],
  knowledge: [
    {
      knowledgeId: ProjectWorkKnowledgeId.make("knowledge-1"),
      projectId,
      title: "Durable fact",
      body: "This survives a source thread deletion.",
      sourceKind: "manual",
      sourceId: "manual-source",
      revision: 7,
      createdAt: at,
      updatedAt: at,
    },
  ],
  decisions: [],
  comments: [],
});

describe("ProjectWorkBriefing", () => {
  it("builds deterministic bounded levels without requiring narrative generation", () => {
    const compact = buildProjectWorkBriefing(snapshot(12), {
      projectId,
      kind: "compact",
      generatedAt: at,
    });
    expect(compact.text.length).toBeLessThanOrEqual(
      PROJECT_WORK_BRIEFING_BOUNDS.compact.maxCharacters,
    );
    expect(compact.includedTaskIds).toHaveLength(PROJECT_WORK_BRIEFING_BOUNDS.compact.maxTasks);
    expect(compact.omittedReasons).toContain("task-bound");
    expect(compact.narrative).toBeUndefined();
    expect(
      buildProjectWorkBriefing(snapshot(12), {
        projectId,
        kind: "compact",
        generatedAt: at,
      }).text,
    ).toBe(compact.text);
  });

  it("reports character omissions and clamps caller-provided bounds", () => {
    const detailed = buildProjectWorkBriefing(snapshot(2), {
      projectId,
      kind: "detailed",
      generatedAt: at,
      maxTasks: 1_000_000,
      maxKnowledge: 1_000_000,
      maxCharacters: 32,
    });
    expect(detailed.text.length).toBeLessThanOrEqual(32);
    expect(detailed.omittedReasons).toContain("character-bound");
  });
});

const sqlLayer = it.layer(NodeSqliteClient.layerMemory());

describe("current knowledge briefing", () => {
  it.effect(
    "retains only the terminal correction through Gateway reads before display truncation",
    () =>
      withCorrectionGateway(
        Effect.gen(function* () {
          const f = yield* correctionFixture();
          yield* f.promote("correction-a", undefined, "2026-01-03T00:00:00.000Z");
          yield* f.promote("correction-b", "correction-a");
          yield* f.promote("correction-c", "correction-b");
          const bounded = yield* f.briefing.generate({
            projectId: f.owner,
            kind: "compact",
            maxKnowledge: 1,
          });
          expect(bounded.includedKnowledgeIds).toEqual(["correction-c"]);
          expect(bounded.text).toContain("Body for correction-c");
          expect(bounded.text).not.toContain("Body for correction-a");
          expect(bounded.text).not.toContain("Body for correction-b");
          expect(bounded.omittedReasons).not.toContain("knowledge-bound");
          const remote = yield* f.gateway
            .read({ projectId: f.owner, operation: "briefing", kind: "compact" })
            .pipe(Effect.flatMap(decodeBriefingRecord));
          expect(remote.includedKnowledgeIds).toEqual(["correction-c"]);
          expect(remote.text).toContain("Keep the required task");
          expect(remote.text).toContain("Keep the accepted constraint");
          expect(
            (yield* f.query.listKnowledge({ projectId: f.owner }))
              .map((record) => record.knowledgeId)
              .toSorted(),
          ).toEqual(["correction-a", "correction-b", "correction-c"]);
        }),
      ),
  );

  it.effect("preserves valid offset timestamps in selected knowledge records", () =>
    withCorrectionGateway(
      Effect.gen(function* () {
        const f = yield* correctionFixture();
        const createdAt = "2025-12-31T19:00:00-05:00";
        const updatedAt = "2026-01-01T02:30:00+02:30";
        yield* f.promote("correction-offset", undefined, updatedAt, createdAt);
        const current = yield* f.query.briefingSnapshot(f.owner, 2);
        expect(current.knowledge).toHaveLength(1);
        expect(current.knowledge[0]?.createdAt).toBe(createdAt);
        expect(current.knowledge[0]?.updatedAt).toBe(updatedAt);
        expect(current.knowledgeOmittedReason).toBeUndefined();
        const result = yield* f.briefing.generate({ projectId: f.owner, kind: "compact" });
        expect(result.includedKnowledgeIds).toEqual(["correction-offset"]);
        expect(result.text).toContain("Body for correction-offset");
        expect(result.text).toContain("Keep the required task");
        expect(result.text).toContain("Keep the accepted constraint");
      }),
    ),
  );

  for (const invalid of ["missing", "foreign", "self", "fork", "cycle"] as const) {
    it.effect(
      `omits ${invalid} correction history while preserving required task and decisions`,
      () =>
        withCorrectionGateway(
          Effect.gen(function* () {
            const f = yield* correctionFixture();
            if (invalid === "foreign") {
              const foreign = ProjectId.make("foreign-correction-project");
              yield* f.sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
            VALUES (${foreign},'Foreign','/foreign','[]',${at},${at})`;
              yield* f.sql`INSERT INTO project_work_knowledge
            (knowledge_id,project_id,title,body,source_kind,source_id,revision,created_at,updated_at)
            VALUES ('foreign-knowledge',${foreign},'Foreign body','Private knowledge','manual','human',0,${at},${at})`;
              yield* f.promote("correction-a", "foreign-knowledge");
            } else if (invalid === "missing") yield* f.promote("correction-a", "absent-knowledge");
            else if (invalid === "self") yield* f.promote("correction-a", "correction-a");
            else if (invalid === "fork") {
              yield* f.promote("correction-a");
              yield* f.promote("correction-b", "correction-a");
              yield* f.promote("correction-c", "correction-a");
            } else {
              yield* f.promote("correction-a", "correction-b");
              yield* f.promote("correction-b", "correction-a");
            }
            const result = yield* f.briefing.generate({ projectId: f.owner, kind: "compact" });
            expect(result.includedKnowledgeIds).toEqual([]);
            expect(result.omittedReasons).toContain("knowledge-closure-invalid");
            expect(result.text).toContain("Knowledge omitted");
            expect(result.text).toContain("Keep the required task");
            expect(result.text).toContain("Keep the accepted constraint");
            expect(result.text).not.toContain("Body for correction-a");
            expect(result.text).not.toContain("Private knowledge");
          }),
        ),
    );
  }

  for (const field of [
    "source",
    "createdAt",
    "updatedAt",
    "attribution",
    "revision",
    "body-bound",
    "metadata-bound",
    "revision-bound",
  ] as const) {
    it.effect(`degrades ${field} knowledge corruption without hiding required briefing`, () =>
      withCorrectionGateway(
        Effect.gen(function* () {
          const f = yield* correctionFixture();
          yield* f.promote("correction-a");
          if (field === "source")
            yield* f.sql`UPDATE project_work_knowledge SET source_kind='unknown' WHERE project_id=${f.owner}`;
          else if (field === "createdAt")
            yield* f.sql`UPDATE project_work_knowledge SET created_at='not-a-time' WHERE project_id=${f.owner}`;
          else if (field === "updatedAt")
            yield* f.sql`UPDATE project_work_knowledge SET updated_at='not-a-time' WHERE project_id=${f.owner}`;
          else if (field === "attribution")
            yield* f.sql`UPDATE project_work_knowledge SET attribution_json='{}' WHERE project_id=${f.owner}`;
          else if (field === "revision")
            yield* f.sql`UPDATE project_work_knowledge SET revision='invalid-revision' WHERE project_id=${f.owner}`;
          else if (field === "body-bound")
            yield* f.sql`UPDATE project_work_knowledge SET body=${"x".repeat(262145)} WHERE project_id=${f.owner}`;
          else if (field === "revision-bound")
            yield* f.sql`UPDATE project_work_knowledge SET revision=${"x".repeat(262145)} WHERE project_id=${f.owner}`;
          else
            yield* f.sql`UPDATE project_work_knowledge SET source_id=${"x".repeat(262145)} WHERE project_id=${f.owner}`;
          const physical = yield* f.sql<{
            sourceKind: string;
            createdAt: string;
            updatedAt: string;
            attribution: string;
            bodyBytes: number;
            sourceBytes: number;
            revisionType: string;
            revisionBytes: number;
          }>`SELECT source_kind AS sourceKind,created_at AS createdAt,updated_at AS updatedAt,
          attribution_json AS attribution,length(CAST(body AS BLOB)) AS bodyBytes,length(CAST(source_id AS BLOB)) AS sourceBytes
          ,typeof(revision) AS revisionType,length(CAST(revision AS BLOB)) AS revisionBytes
          FROM project_work_knowledge WHERE knowledge_id='correction-a' AND project_id=${f.owner}`;
          expect(physical).toHaveLength(1);
          if (field === "source") expect(physical[0]?.sourceKind).toBe("unknown");
          else if (field === "createdAt") expect(physical[0]?.createdAt).toBe("not-a-time");
          else if (field === "updatedAt") expect(physical[0]?.updatedAt).toBe("not-a-time");
          else if (field === "attribution") expect(physical[0]?.attribution).toBe("{}");
          else if (field === "revision" || field === "revision-bound") {
            expect(physical[0]?.revisionType).toBe("text");
            expect(physical[0]?.revisionBytes).toBe(
              field === "revision-bound" ? 262145 : "invalid-revision".length,
            );
          } else if (field === "body-bound") expect(physical[0]?.bodyBytes).toBe(262145);
          else expect(physical[0]?.sourceBytes).toBe(262145);
          const result = yield* f.briefing.generate({ projectId: f.owner, kind: "compact" });
          expect(result.includedKnowledgeIds).toEqual([]);
          expect(result.omittedReasons).toContain(
            field.endsWith("bound") ? "knowledge-closure-bound" : "knowledge-unavailable",
          );
          expect(result.text).toContain("Keep the required task");
          expect(result.text).toContain("Keep the accepted constraint");
        }),
      ),
    );
  }

  it.effect("omits overfull knowledge closure independently of the display count", () =>
    withCorrectionGateway(
      Effect.gen(function* () {
        const f = yield* correctionFixture();
        yield* f.sql`WITH RECURSIVE generated(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM generated WHERE value<257)
        INSERT INTO project_work_knowledge (knowledge_id,project_id,title,body,source_kind,source_id,revision,created_at,updated_at)
        SELECT printf('overflow-%03d',value),${f.owner},'Overflow','Optional body','manual','human',0,${at},${at} FROM generated`;
        const result = yield* f.briefing.generate({
          projectId: f.owner,
          kind: "compact",
          maxKnowledge: 1,
        });
        expect(result.includedKnowledgeIds).toEqual([]);
        expect(result.omittedReasons).toContain("knowledge-closure-bound");
        expect(result.text).toContain("Keep the required task");
        expect(result.text).toContain("Keep the accepted constraint");
      }),
    ),
  );

  it.effect("omits unavailable knowledge storage while surfacing required storage failures", () =>
    withCorrectionGateway(
      Effect.gen(function* () {
        const f = yield* correctionFixture();
        yield* f.sql`DROP TABLE project_work_knowledge`;
        const result = yield* f.briefing.generate({ projectId: f.owner, kind: "compact" });
        expect(result.includedKnowledgeIds).toEqual([]);
        expect(result.omittedReasons).toContain("knowledge-unavailable");
        expect(result.text).toContain("Keep the required task");
        expect(result.text).toContain("Keep the accepted constraint");
        yield* f.sql`DROP TABLE project_work_decisions`;
        expect(
          (yield* f.briefing.generate({ projectId: f.owner, kind: "compact" }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      }),
    ),
  );

  it("omits duplicate and incomplete private snapshot closures without a timestamp winner", () => {
    const base = snapshot(1);
    const record = base.knowledge[0];
    expect(record).toBeDefined();
    if (record === undefined) return;
    for (const invalid of [
      { ...base, knowledge: [record, { ...record, updatedAt: "2026-01-02T00:00:00.000Z" }] },
      { ...base, knowledgeOmittedReason: "knowledge-closure-bound" },
    ]) {
      const result = buildProjectWorkBriefing(invalid, {
        projectId,
        kind: "compact",
        generatedAt: at,
      });
      expect(result.includedKnowledgeIds).toEqual([]);
      expect(result.text).toContain("Task 0");
      expect(result.text).toContain("Knowledge omitted");
    }
  });
});

sqlLayer("ProjectWorkBriefing service", (it) => {
  it.effect("bounds accepted decisions independently and excludes other projects and states", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const sql = yield* SqlClient.SqlClient;
      const briefing = yield* ProjectWorkBriefing;
      const query = yield* ProjectWorkQuery;
      const p = ProjectId.make("briefing-decision-boundary");
      yield* sql`
        INSERT INTO project_work_decisions
          (decision_id, project_id, title, body, state, revision, created_at, updated_at)
        VALUES
          ('decision-001', ${p}, 'First recorded choice', 'First body', 'accepted', 1, ${at}, ${at}),
          ('decision-proposed', ${p}, 'Pending choice', 'Pending body', 'proposed', 1, ${at}, ${at}),
          ('decision-rejected', ${p}, 'Rejected choice', 'Rejected body', 'rejected', 1, ${at}, ${at}),
          ('decision-superseded', ${p}, 'Superseded choice', 'Old body', 'superseded', 1, ${at}, ${at}),
          ('decision-unknown', ${p}, 'Unknown choice', 'Unknown body', 'future-state', 1, ${at}, ${at}),
          ('decision-foreign', 'other-decision-project', 'Foreign choice', 'Foreign body', 'accepted', 1, ${at}, ${at})
      `;
      const zero = yield* briefing.generate({ projectId: p, kind: "compact", maxKnowledge: 0 });
      expect(zero.text).not.toContain("First recorded choice");
      expect(zero.omittedReasons).toContain("decision-bound");
      expect(zero.omittedReasons).not.toContain("knowledge-bound");
      const exact = yield* briefing.generate({ projectId: p, kind: "compact", maxKnowledge: 1 });
      expect(exact.text).toContain("First recorded choice");
      expect(exact.omittedReasons).not.toContain("decision-bound");
      for (const excluded of [
        "Pending choice",
        "Rejected choice",
        "Superseded choice",
        "Unknown choice",
        "Foreign choice",
      ])
        expect(exact.text).not.toContain(excluded);

      yield* sql`
        INSERT INTO project_work_decisions
          (decision_id, project_id, title, body, state, revision, created_at, updated_at)
        VALUES ('decision-002', ${p}, 'Second recorded choice', 'Second body', 'accepted', 2,
          ${at}, '2026-01-02T00:00:00.000Z')
      `;
      const onePast = yield* briefing.generate({ projectId: p, kind: "compact", maxKnowledge: 1 });
      expect(onePast.text).toContain("Second recorded choice");
      expect(onePast.text).not.toContain("First recorded choice");
      expect(onePast.omittedReasons).toContain("decision-bound");
      yield* sql`
        WITH RECURSIVE generated(value) AS (
          SELECT 3 UNION ALL SELECT value + 1 FROM generated WHERE value < 51
        )
        INSERT INTO project_work_decisions
          (decision_id, project_id, title, body, state, revision, created_at, updated_at)
        SELECT printf('decision-%03d', value), ${p}, printf('Recorded choice %03d', value),
          'Body', 'accepted', value, ${at}, ${at}
        FROM generated
      `;
      expect((yield* query.briefingSnapshot(p, 5)).decisions).toHaveLength(5);
      for (const kind of ["compact", "standard", "detailed"] as const) {
        const result = yield* briefing.generate({ projectId: p, kind });
        const decisionLines = result.text
          .split("\n")
          .filter((line) => line.startsWith("- [decision-"));
        expect(decisionLines).toHaveLength(PROJECT_WORK_BRIEFING_BOUNDS[kind].maxKnowledge);
        expect(result.omittedReasons).toContain("decision-bound");
        expect(result.text.length).toBeLessThanOrEqual(
          PROJECT_WORK_BRIEFING_BOUNDS[kind].maxCharacters,
        );
      }
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectWorkQueryLive,
          ProjectWorkBriefingLive.pipe(Layer.provide(ProjectWorkQueryLive)),
        ),
      ),
    ),
  );

  it.effect(
    "shares the character budget with tasks and knowledge and reports omitted decisions",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toForkMigrationInclusive: 8 });
        yield* runForkMigrations(9);
        const sql = yield* SqlClient.SqlClient;
        const briefing = yield* ProjectWorkBriefing;
        const p = ProjectId.make("briefing-decision-characters");
        yield* sql`
        INSERT INTO project_work_tasks
          (task_id, project_id, title, state, watchers_json, revision, spec_revision, created_at, updated_at)
        VALUES ('decision-budget-task', ${p}, 'Active task', 'in-progress', '[]', 1, 0, ${at}, ${at})
      `;
        yield* sql`
        INSERT INTO project_work_knowledge
          (knowledge_id, project_id, title, body, source_kind, source_id, revision, created_at, updated_at)
        VALUES ('decision-budget-knowledge', ${p}, 'Known fact', 'Known body', 'manual', 'a', 1, ${at}, ${at})
      `;
        yield* sql`
        INSERT INTO project_work_decisions
          (decision_id, project_id, title, body, state, revision, created_at, updated_at)
        VALUES ('decision-budget', ${p}, 'Recorded choice', 'Complete decision body', 'accepted', 3, ${at}, ${at})
      `;
        const full = yield* briefing.generate({ projectId: p, kind: "compact" });
        expect(full.text).toContain("Active task");
        expect(full.text).toContain("Known fact");
        expect(full.text).toContain("Complete decision body");
        const exact = yield* briefing.generate({
          projectId: p,
          kind: "compact",
          maxCharacters: full.text.length,
        });
        expect(exact.text).toBe(full.text);
        expect(exact.omittedReasons).not.toContain("character-bound");
        const short = yield* briefing.generate({
          projectId: p,
          kind: "compact",
          maxCharacters: full.text.length - 1,
        });
        expect(short.text.length).toBeLessThanOrEqual(full.text.length - 1);
        expect(short.text).toContain("Active task");
        expect(short.text).toContain("Known fact");
        expect(short.text).not.toContain("Complete decision body");
        expect(short.omittedReasons).toContain("character-bound");
        expect(short.omittedReasons).not.toContain("decision-bound");
        const empty = yield* briefing.generate({ projectId: p, kind: "compact", maxCharacters: 0 });
        expect(empty.text).toBe("");
        expect(empty.omittedReasons).toContain("character-bound");
      }).pipe(Effect.provide(ProjectWorkBriefingLive.pipe(Layer.provide(ProjectWorkQueryLive)))),
  );

  it.effect("reconstructs accepted decisions after human acceptance and supersession", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const briefing = yield* ProjectWorkBriefing;
      const p = ProjectId.make("briefing-decision-lifecycle");
      const originalId = ProjectWorkDecisionId.make("briefing-original-decision");
      const replacementId = ProjectWorkDecisionId.make("briefing-replacement-decision");
      const rejectedId = ProjectWorkDecisionId.make("briefing-rejected-decision");
      const attribution: ProjectWorkAttribution = {
        actor: { kind: "human", id: "maintainer", displayName: "Maintainer" },
        source: { kind: "web", id: "decision-client" },
        recordedAt: at,
      };
      const original = {
        decisionId: originalId,
        projectId: p,
        title: "Keep the parser",
        body: "Use the shared parser for every client.",
        state: "proposed" as const,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      };
      const read = () => briefing.generate({ projectId: p, kind: "compact", generatedAt: at });
      yield* repository.execute({
        type: "project-work.decision.propose",
        commandId: CommandId.make("briefing-original-propose"),
        projectId: p,
        decision: original,
        proposedAt: at,
        attribution,
      });
      expect((yield* read()).text).not.toContain(original.title);
      yield* repository.execute({
        type: "project-work.decision.accept",
        commandId: CommandId.make("briefing-original-accept"),
        projectId: p,
        decisionId: originalId,
        acceptedAt: at,
        attribution,
      });
      const accepted = yield* read();
      expect(accepted.sourceRevision).toBe(2);
      expect(accepted.text).toContain("Recorded decisions");
      expect(accepted.text).toContain("briefing-original-decision; revision 1");
      expect(accepted.text).toContain(original.title);
      expect(accepted.text).toContain(original.body);
      expect(accepted.text).toContain("human/maintainer");
      expect(accepted.text).toContain("Maintainer");
      expect(accepted.text).toContain("web/decision-client");
      expect(accepted.text).toContain(at);

      yield* repository.execute({
        type: "project-work.decision.propose",
        commandId: CommandId.make("briefing-rejected-propose"),
        projectId: p,
        decision: { ...original, decisionId: rejectedId, title: "Use a private parser" },
        proposedAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.decision.reject",
        commandId: CommandId.make("briefing-rejected-reject"),
        projectId: p,
        decisionId: rejectedId,
        reason: "Keep one parser",
        rejectedAt: at,
        attribution,
      });
      expect((yield* read()).text).not.toContain("Use a private parser");
      yield* repository.execute({
        type: "project-work.decision.supersede",
        commandId: CommandId.make("briefing-original-supersede"),
        projectId: p,
        decisionId: originalId,
        replacement: {
          ...original,
          decisionId: replacementId,
          title: "Replace the parser",
          body: "Migrate every client to the new shared parser.",
        },
        supersededAt: at,
        attribution,
      });
      const pendingReplacement = yield* read();
      expect(pendingReplacement.text).not.toContain(original.title);
      expect(pendingReplacement.text).not.toContain("Replace the parser");
      yield* repository.execute({
        type: "project-work.decision.accept",
        commandId: CommandId.make("briefing-replacement-accept"),
        projectId: p,
        decisionId: replacementId,
        acceptedAt: at,
        attribution,
      });
      const replaced = yield* read();
      expect(replaced.sourceRevision).toBe(6);
      expect(replaced.text).not.toContain(original.title);
      expect(replaced.text).toContain("briefing-replacement-decision; revision 1");
      expect(replaced.text).toContain("Replace the parser");
      expect(replaced.text).toContain("Migrate every client to the new shared parser.");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ProjectWorkRepositoryLive,
          ProjectWorkQueryLive,
          ProjectWorkBriefingLive.pipe(Layer.provide(ProjectWorkQueryLive)),
        ),
      ),
    ),
  );

  it.effect("distinguishes zero, exact, and one-past knowledge bounds", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const sql = yield* SqlClient.SqlClient;
      const briefing = yield* ProjectWorkBriefing;
      const boundaryProjectId = ProjectId.make("briefing-knowledge-boundary");
      yield* sql`
        INSERT INTO project_work_knowledge
          (knowledge_id, project_id, title, body, source_kind, source_id, revision,
            created_at, updated_at)
        VALUES
          ('briefing-knowledge-a', ${boundaryProjectId}, 'A', 'First', 'manual', 'a', 1,
            ${at}, ${at})
      `;

      const zero = yield* briefing.generate({
        projectId: boundaryProjectId,
        kind: "compact",
        generatedAt: at,
        maxKnowledge: 0,
      });
      expect(zero.includedKnowledgeIds).toEqual([]);
      expect(zero.omittedReasons).toContain("knowledge-bound");

      const exact = yield* briefing.generate({
        projectId: boundaryProjectId,
        kind: "compact",
        generatedAt: at,
        maxKnowledge: 1,
      });
      expect(exact.includedKnowledgeIds).toHaveLength(1);
      expect(exact.omittedReasons).not.toContain("knowledge-bound");

      yield* sql`
        INSERT INTO project_work_knowledge
          (knowledge_id, project_id, title, body, source_kind, source_id, revision,
            created_at, updated_at)
        VALUES
          ('briefing-knowledge-b', ${boundaryProjectId}, 'B', 'Second', 'manual', 'b', 2,
            ${at}, '2026-01-02T00:00:00.000Z')
      `;
      const onePast = yield* briefing.generate({
        projectId: boundaryProjectId,
        kind: "compact",
        generatedAt: at,
        maxKnowledge: 1,
      });
      expect(onePast.includedKnowledgeIds).toHaveLength(1);
      expect(onePast.omittedReasons).toContain("knowledge-bound");
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectWorkQueryLive,
          ProjectWorkBriefingLive.pipe(Layer.provide(ProjectWorkQueryLive)),
        ),
      ),
    ),
  );

  it.effect("loads complete supporting collections without inferred page omissions", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const sql = yield* SqlClient.SqlClient;
      const briefing = yield* ProjectWorkBriefing;
      const completeProjectId = ProjectId.make("briefing-complete-collection");
      yield* sql`
        WITH RECURSIVE generated(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM generated WHERE value < 1001
        )
        INSERT INTO project_work_tasks
          (task_id, project_id, title, state, watchers_json, revision, spec_revision,
            created_at, updated_at)
        SELECT printf('briefing-task-%04d', value), ${completeProjectId},
          printf('Task %04d', value), 'draft', '[]', value, 0, ${at}, ${at}
        FROM generated
      `;
      const result = yield* briefing.generate({
        projectId: completeProjectId,
        kind: "detailed",
        generatedAt: at,
      });
      expect(result.includedTaskIds).toHaveLength(PROJECT_WORK_BRIEFING_BOUNDS.detailed.maxTasks);
      expect(result.omittedReasons).toContain("task-bound");
      expect(result.omittedReasons.some((reason) => reason.endsWith("-page-bound"))).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectWorkQueryLive,
          ProjectWorkBriefingLive.pipe(Layer.provide(ProjectWorkQueryLive)),
        ),
      ),
    ),
  );
});
