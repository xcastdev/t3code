import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProjectMemoryExtraction } from "./projectMemory.ts";

const decodeExtraction = Schema.decodeUnknownSync(ProjectMemoryExtraction);
it("persists an explicit no-facts extraction and bounded complete manifest", () => {
  const extraction = {
    kind: "memory-extraction",
    recordId: "extraction",
    projectId: "project",
    revision: 0,
    generation: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "no-facts",
    engine: "mem0",
    engineVersion: "2.2.1",
    sourceId: "source",
    sourceRevision: 0,
    sourceGeneration: 0,
    extractionModel: "commandcode/ling",
    embeddingModel: "openrouter/nvidia",
    embeddingDimensions: 2048,
    expectedObservationIds: [],
    completedObservationIds: [],
  };
  expect(decodeExtraction(extraction).status).toBe("no-facts");
  expect(() => decodeExtraction({ ...extraction, embeddingDimensions: 1024 })).toThrow();
  expect(() =>
    decodeExtraction({
      ...extraction,
      expectedObservationIds: Array(257).fill("id"),
    }),
  ).toThrow();
});
