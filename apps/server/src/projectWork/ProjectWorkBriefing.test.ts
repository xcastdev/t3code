import {
  CommandId,
  ProjectId,
  ProjectWorkDecisionId,
  ProjectWorkKnowledgeId,
  ProjectWorkTaskId,
  type ProjectWorkAttribution,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("briefing-project");

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
