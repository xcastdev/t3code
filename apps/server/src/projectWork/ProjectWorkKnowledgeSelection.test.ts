import { ProjectId, ProjectWorkKnowledgeId, type ProjectWorkKnowledge } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  PROJECT_WORK_KNOWLEDGE_CLOSURE_LIMIT,
  selectCurrentProjectWorkKnowledge,
} from "./ProjectWorkKnowledgeSelection.ts";

const record = (id: string, supersedes?: string): ProjectWorkKnowledge => ({
  knowledgeId: ProjectWorkKnowledgeId.make(id),
  projectId: ProjectId.make("project"),
  title: id,
  body: "Finding",
  sourceKind: "manual",
  sourceId: "human-1",
  revision: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...(supersedes === undefined
    ? {}
    : { supersedesKnowledgeId: ProjectWorkKnowledgeId.make(supersedes) }),
});

it("selects current knowledge through complete supersession chains without mutating history", () => {
  const records = [
    record("old"),
    record("new", "old"),
    record("latest", "new"),
    record("independent"),
  ];
  expect(
    selectCurrentProjectWorkKnowledge({ projectId: "project", records, complete: true }),
  ).toEqual({ status: "available", records: [records[3], records[2]] });
  expect(records.map((entry) => entry.knowledgeId)).toEqual([
    "old",
    "new",
    "latest",
    "independent",
  ]);
});

it("refuses incomplete and oversized closures before displaying partial knowledge", () => {
  expect(
    selectCurrentProjectWorkKnowledge({
      projectId: "project",
      records: [record("old")],
      complete: false,
    }),
  ).toMatchObject({ status: "degraded", reason: "knowledge-closure-bound", records: [] });
  const records = Array.from({ length: PROJECT_WORK_KNOWLEDGE_CLOSURE_LIMIT + 1 }, (_, index) =>
    record(String(index)),
  );
  expect(
    selectCurrentProjectWorkKnowledge({ projectId: "project", records, complete: true }),
  ).toMatchObject({ status: "degraded", reason: "knowledge-closure-bound", records: [] });
});

it.each([
  [record("same"), record("same")],
  [record("self", "self")],
  [record("new", "absent")],
  [record("old"), record("first", "old"), record("second", "old")],
  [record("a", "b"), record("b", "a")],
  [{ ...record("foreign"), projectId: ProjectId.make("other") }],
])("refuses ambiguous, cyclic and foreign knowledge closure %#", (...records) => {
  expect(
    selectCurrentProjectWorkKnowledge({ projectId: "project", records, complete: true }),
  ).toMatchObject({ status: "degraded", reason: "knowledge-closure-invalid", records: [] });
});
