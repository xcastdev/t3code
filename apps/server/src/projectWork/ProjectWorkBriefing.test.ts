import { ProjectId, ProjectWorkKnowledgeId, ProjectWorkTaskId } from "@t3tools/contracts";
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
import { ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import type { ProjectWorkSnapshot } from "./ProjectWorkQuery.ts";

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
