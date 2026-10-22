import {
  AssistantMemory,
  AssistantMemorySources,
  makeAssistantMemorySourceAuthority,
  layer as memoryLayer,
  layerFactPolicy,
  type AssistantMemoryEvidence,
} from "./AssistantMemory.ts";
import * as Repository from "./AssistantRepository.ts";
import { repository, input, environmentId } from "./AssistantTestHelpers.ts";
import {
  MessageId,
  RunId,
  RunAttemptId,
  type MemoryExtractionResult,
  type MemoryProcessingConfiguration,
} from "@t3tools/contracts";
import {
  ProjectMemoryService,
  ProjectMemoryOwnerAuthority,
  layer as authorityLayer,
} from "../projectWork/memory/ProjectMemoryService.ts";
import {
  ProjectMemoryProcessing,
  layer as processingLayer,
} from "../projectWork/memory/ProjectMemoryProcessing.ts";
import { ProjectMemoryConfiguration } from "../projectWork/memory/ProjectMemoryConfiguration.ts";
import { ProjectMemoryModelRoutes } from "../projectWork/memory/ProjectMemoryModelRoutes.ts";
import { MemoryBackend } from "../projectWork/memory/MemoryBackend.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { ProjectMemoryError } from "../projectWork/memory/ProjectMemoryRepository.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { projectMemoryMigration } from "../persistence/ProjectMemoryMigration.ts";
import { projectMemoryProcessingMigration } from "../persistence/ProjectMemoryProcessingMigration.ts";
import { assistantMemoryMigration } from "../persistence/AssistantMemoryMigration.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Crypto from "@effect/platform-node/NodeCrypto";

export const fixture = (
  extract: (input: { sourceText: string }) => Effect.Effect<MemoryExtractionResult> = (input) =>
    Effect.succeed({
      facts: [{ key: "editor.preference", body: input.sourceText, quote: input.sourceText }],
    }),
  processingConfiguration: MemoryProcessingConfiguration = {},
  discover?: AssistantMemorySources["Service"]["discover"],
) => {
  const base = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const migration of [
        projectMemoryMigration,
        projectMemoryProcessingMigration,
        assistantMemoryMigration,
      ])
        for (const statement of migration.statements) yield* sql.unsafe(statement);
    }),
  ).pipe(Layer.provideMerge(repository));
  const sources = Layer.succeed(AssistantMemorySources, {
    verify: (e) =>
      e.content.startsWith("ASSISTANT:")
        ? Effect.fail(new ProjectMemoryError({ reason: "forbidden" }))
        : Effect.void,
    discover: discover ?? (() => Effect.succeed({ items: [], nextCursor: null })),
  });
  const bridge = Layer.effect(
    ProjectMemoryOwnerAuthority,
    Effect.gen(function* () {
      const authority = yield* makeAssistantMemorySourceAuthority;
      const repo = yield* Repository.AssistantRepository;
      return ProjectMemoryOwnerAuthority.of({
        ...authority,
        assertCurrent: Effect.fn("MemoryTest.assertCurrent")(
          function* (scope) {
            if (scope.owner.kind !== "assistant")
              return yield* new ProjectMemoryError({ reason: "forbidden" });
            const record = yield* repo.get({
              environmentId: scope.environmentId,
              assistantId: scope.owner.assistantId,
            });
            if (record.ownerRevision !== scope.ownerRevision)
              return yield* new ProjectMemoryError({ reason: "stale" });
          },
          Effect.mapError((cause) => new ProjectMemoryError({ reason: "forbidden", cause })),
        ),
      });
    }),
  ).pipe(Layer.provideMerge(sources), Layer.provideMerge(base));
  const policy = layerFactPolicy.pipe(Layer.provideMerge(base));
  const authority = authorityLayer.pipe(
    Layer.provideMerge(policy),
    Layer.provideMerge(bridge),
    Layer.provide(Crypto.layer),
    Layer.provideMerge(
      Layer.succeed(Environment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("unused"),
      }),
    ),
    Layer.provide(ProjectStore.layer.pipe(Layer.provide(base))),
  );
  const unused = () => Effect.die("external route must not run");
  const processing = processingLayer.pipe(
    Layer.provideMerge(authority),
    Layer.provideMerge(policy),
    Layer.provide(
      Layer.succeed(TextGeneration, {
        generateCommitMessage: unused,
        generateBranchName: unused,
        generateThreadTitle: unused,
        generatePrContent: unused,
        generateReviewGuide: unused,
        extractMemoryFacts: extract,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectMemoryConfiguration, {
        read: () => Effect.succeed({ revision: 0, configuration: processingConfiguration }),
        set: unused,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectMemoryModelRoutes, {
        extract: (_scope, _route, sourceText) => extract({ sourceText }),
        embed: unused,
      }),
    ),
    Layer.provide(Layer.succeed(MemoryBackend, { execute: unused })),
  );
  return memoryLayer.pipe(Layer.provideMerge(processing));
};
export const seed = Effect.fn("MemoryTest.seed")(function* () {
  const repo = yield* Repository.AssistantRepository;
  const record = yield* repo.create(input);
  const binding = record.detail.summary.binding;
  const evidence: AssistantMemoryEvidence = {
    environmentId,
    assistantId: binding.assistantId,
    ownerRevision: 0,
    configurationRevision: 0,
    threadId: binding.canonicalThreadId,
    messageId: MessageId.make("message-1"),
    runId: RunId.make("run-1"),
    runAttemptId: RunAttemptId.make("attempt-1"),
    content: "I prefer the dark editor theme.",
    settledAt: "2026-01-01T00:00:00.000Z",
    modelSelection: input.configuration.modelSelection,
    cwd: "/tmp/assistant",
  };
  return {
    record,
    evidence,
    memory: yield* AssistantMemory,
    authority: yield* ProjectMemoryService,
    processing: yield* ProjectMemoryProcessing,
  };
});
