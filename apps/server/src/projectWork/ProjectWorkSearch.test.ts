import {
  CommandId,
  ProjectId,
  ProjectWorkKnowledgeId,
  ProjectWorkRelationshipId,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import {
  ProjectWorkSearch,
  ProjectWorkSearchLive,
  toProjectWorkFtsQuery,
} from "./ProjectWorkSearch.ts";

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-search");

const layer = it.layer(Layer.fresh(Layer.mergeAll(NodeSqliteClient.layerMemory())));

layer("ProjectWorkSearch", (it) => {
  it.effect("returns bounded snippets, provenance, filters, and stable pages", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const search = yield* ProjectWorkSearch;
      const taskId = ProjectWorkTaskId.make("search-task");
      const otherTaskId = ProjectWorkTaskId.make("other-task");
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("search-create-1"),
        projectId,
        taskId,
        title: "Lease fence implementation",
        summary: "The lease fence keeps attempts safe and durable.",
        createdAt: at,
      });
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("search-create-2"),
        projectId,
        taskId: otherTaskId,
        title: "src/server.ts integration task",
        summary: "A different piece of work.",
        createdAt: at,
      });
      yield* repository.execute({
        type: "project-work.knowledge.promote",
        commandId: CommandId.make("search-knowledge"),
        projectId,
        knowledge: {
          knowledgeId: ProjectWorkKnowledgeId.make("search-knowledge"),
          projectId,
          title: "Lease decision",
          body: "Lease fence evidence is retained after expiry.",
          sourceKind: "task",
          sourceId: taskId,
          revision: 0,
          createdAt: at,
          updatedAt: at,
        },
        promotedAt: at,
      });
      const first = yield* search.search({
        projectId,
        query: "lease fence",
        limit: 1,
        snippetCharacters: 40,
      });
      expect(first.items).toHaveLength(1);
      expect(first.total).toBeGreaterThanOrEqual(2);
      expect(first.hasMore).toBe(true);
      expect(first.nextOffset).toBe(1);
      expect(first.items[0]?.snippet.length).toBeLessThanOrEqual(40);
      expect(first.items[0]?.provenance).toMatchObject({});
      const knowledge = yield* search.search({
        projectId,
        query: "lease",
        recordKinds: ["knowledge"],
        sourceKind: "task",
      });
      expect(knowledge.items.map((item) => item.recordId)).toEqual(["search-knowledge"]);
      const task = yield* search.search({ projectId, query: "lease", taskId });
      expect(task.items.every((item) => item.provenance.taskId === String(taskId))).toBe(true);
      const hiddenActivity = yield* search.search({ projectId, query: "task" });
      expect(hiddenActivity.items.some((item) => item.recordKind === "activity")).toBe(false);
      const visibleActivity = yield* search.search({
        projectId,
        query: "task",
        includeActivity: true,
      });
      expect(visibleActivity.items.some((item) => item.recordKind === "activity")).toBe(true);

      expect(toProjectWorkFtsQuery("src/server.ts")).toBe('"src" AND "server" AND "ts"');
      const path = yield* search.search({ projectId, query: "src/server.ts" });
      expect(path.items.map((item) => item.recordId)).toContain(String(otherTaskId));

      const matchAllFirst = yield* search.search({ projectId, query: "  *  ", limit: 1 });
      const matchAllSecond = yield* search.search({
        projectId,
        query: "*",
        limit: 1,
        offset: 1,
      });
      expect(matchAllFirst.total).toBeGreaterThanOrEqual(3);
      expect(matchAllFirst.items.some((item) => item.recordKind === "activity")).toBe(false);
      expect(matchAllFirst.items[0]?.recordId).not.toBe(matchAllSecond.items[0]?.recordId);
      expect(matchAllFirst.items[0]?.snippet.length).toBeLessThanOrEqual(320);
    }).pipe(Effect.provide(Layer.merge(ProjectWorkRepositoryLive, ProjectWorkSearchLive))),
  );

  it.effect("traverses relationships with depth and cycle guards", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const search = yield* ProjectWorkSearch;
      const root = ProjectWorkTaskId.make("traverse-root");
      const middle = ProjectWorkTaskId.make("traverse-middle");
      const leaf = ProjectWorkTaskId.make("traverse-leaf");
      for (const [id, title, command] of [
        [root, "Root", "traverse-create-root"],
        [middle, "Middle", "traverse-create-middle"],
        [leaf, "Leaf", "traverse-create-leaf"],
      ] as const)
        yield* repository.execute({
          type: "project-work.task.create",
          commandId: CommandId.make(command),
          projectId,
          taskId: id,
          title,
          createdAt: at,
        });
      for (const [id, fromTaskId, toTaskId] of [
        ["traverse-relation-1", root, middle],
        ["traverse-relation-2", middle, leaf],
        ["traverse-relation-3", leaf, root],
      ] as const)
        yield* repository.execute({
          type: "project-work.relationship.link",
          commandId: CommandId.make(`${id}-command`),
          projectId,
          relationship: {
            relationshipId: ProjectWorkRelationshipId.make(id),
            projectId,
            fromTaskId,
            toTaskId,
            kind: "relates-to",
            revision: 0,
            createdAt: at,
          },
          linkedAt: at,
        });
      const traversal = yield* search.traverseRelationships({
        projectId,
        taskId: root,
        depth: 8,
        limit: 10,
      });
      expect(traversal.taskIds.map(String)).toEqual([String(root), String(middle), String(leaf)]);
      expect(traversal.relationships).toHaveLength(3);
      expect(traversal.truncated).toBe(false);
    }).pipe(Effect.provide(Layer.merge(ProjectWorkRepositoryLive, ProjectWorkSearchLive))),
  );
});
