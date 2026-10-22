import type { AssistantSelection } from "./state/assistants.ts";
import {
  AssistantConfigurationRevision,
  AssistantId,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PROCESSING_ROUTE,
  processingDraftConfiguration,
  processingDraftFrom,
} from "./assistantPresentation.ts";

const selected: AssistantSelection = {
  environmentId: EnvironmentId.make("env-1"),
  assistantId: AssistantId.make("agent-1"),
  backingProjectId: ProjectId.make("project-1"),
  canonicalThreadId: ThreadId.make("thread-1"),
  configurationRevision: AssistantConfigurationRevision.make(2),
  connectionEpoch: "1",
};

const route = {
  endpoint: "https://memory.example.com/v1",
  model: "extractor",
  secretName: "MEMORY_KEY",
};

describe("memory processing drafts", () => {
  it("keeps processing built-in when nothing is turned on", () => {
    expect(processingDraftConfiguration({ extraction: null, index: null }, selected)).toEqual({
      configuration: {},
    });
  });

  it("builds routes private to this agent and round-trips them", () => {
    const built = processingDraftConfiguration(
      {
        extraction: { ...route, provider: "liquid" },
        index: { ...route, model: "embedder", dimensions: "768" },
      },
      selected,
    );
    if ("error" in built) throw new Error(built.error);
    const owner = { kind: "assistant", assistantId: "agent-1" };
    expect(built.configuration.extractionRoute).toMatchObject({
      environmentId: EnvironmentId.make("env-1"),
      owner,
      provider: "liquid",
      secretName: "MEMORY_KEY",
    });
    expect(built.configuration.destination?.embeddingRoute).toMatchObject({
      owner,
      dimensions: 768,
    });
    expect(processingDraftFrom(built.configuration)).toEqual({
      extraction: { ...route, provider: "liquid" },
      index: { ...route, model: "embedder", dimensions: "768" },
    });
  });

  it("refuses endpoints that are not plain https and incomplete routes", () => {
    for (const endpoint of [
      "http://memory.example.com",
      "https://user:pass@memory.example.com",
      "https://memory.example.com/?key=1",
      "not a url",
    ])
      expect(
        processingDraftConfiguration(
          { extraction: { ...route, endpoint, provider: "command-code" }, index: null },
          selected,
        ),
      ).toHaveProperty("error");
    expect(
      processingDraftConfiguration(
        { extraction: null, index: { ...EMPTY_PROCESSING_ROUTE, dimensions: "1" } },
        selected,
      ),
    ).toHaveProperty("error");
    expect(
      processingDraftConfiguration(
        { extraction: null, index: { ...route, dimensions: "0" } },
        selected,
      ),
    ).toHaveProperty("error");
  });
});
