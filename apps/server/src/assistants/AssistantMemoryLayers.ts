import { makeAssistantHistoryPolicy } from "./AssistantHistoryPolicy.ts";
import * as Destination from "../projectWork/memory/MemoryProcessingDestination.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { ContextHandoffEpoch } from "../orchestration-v2/ContextHandoffEpoch.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ProjectMemoryOwnerAuthority,
  layer as memoryLayer,
} from "../projectWork/memory/ProjectMemoryService.ts";
import { ProjectMemoryError } from "../projectWork/memory/ProjectMemoryRepository.ts";
import * as Processing from "../projectWork/memory/ProjectMemoryProcessing.ts";
import * as Configuration from "../projectWork/memory/ProjectMemoryConfiguration.ts";
import * as Backend from "../projectWork/memory/MemoryBackend.ts";
import * as Routes from "../projectWork/memory/ProjectMemoryModelRoutes.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Repository from "./AssistantRepository.ts";
import * as Ownership from "./AssistantOwnership.ts";
import * as Sources from "./AssistantMemorySources.ts";
import * as Memory from "./AssistantMemory.ts";
import { AssistantInstructionEpoch, assistantMemoryContextHash } from "./AssistantResources.ts";
import { AssistantError } from "./AssistantRepository.ts";

export const layerSources = Sources.layer.pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provide(Projection.layer),
);
export const layerOwnerAuthority = Layer.effect(
  ProjectMemoryOwnerAuthority,
  Effect.gen(function* () {
    const ownership = yield* Ownership.AssistantOwnership;
    const authority = yield* Memory.makeAssistantMemorySourceAuthority;
    return ProjectMemoryOwnerAuthority.of({
      ...authority,
      assertCurrent: (scope) =>
        ownership
          .assertCurrent(scope)
          .pipe(Effect.mapError((cause) => new ProjectMemoryError({ reason: "forbidden", cause }))),
    });
  }),
).pipe(Layer.provideMerge(Ownership.layer), Layer.provideMerge(layerSources));
export const layerSharedMemory = memoryLayer.pipe(
  Layer.provide(ProjectStore.layer),
  Layer.provide(layerOwnerAuthority),
  Layer.provideMerge(Memory.layerFactPolicy),
);
export const layerProcessing = Processing.layer.pipe(
  Layer.provideMerge(layerSharedMemory),
  Layer.provideMerge(Memory.layerFactPolicy),
  Layer.provideMerge(Configuration.layer),
  Layer.provideMerge(Backend.layer.pipe(Layer.provideMerge(Routes.layer))),
);
export const layer = Memory.layer.pipe(
  Layer.provide(Destination.layer),
  Layer.provideMerge(layerProcessing),
  Layer.provideMerge(Memory.layerFactPolicy),
  Layer.provideMerge(layerSources),
);
export const layerInstructionContext = Layer.effect(
  AssistantInstructionEpoch,
  Effect.gen(function* () {
    const context = yield* Memory.makeAssistantMemoryContext;
    return AssistantInstructionEpoch.of({
      context: (record) =>
        context(record).pipe(
          Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })),
        ),
    });
  }),
).pipe(
  Layer.provideMerge(layerSharedMemory),
  Layer.provideMerge(Memory.layerFactPolicy),
  Layer.provideMerge(Repository.layer),
);

export const layerHandoffEpoch = Layer.effect(
  ContextHandoffEpoch,
  Effect.gen(function* () {
    const repository = yield* Repository.AssistantRepository;
    const context = yield* Memory.makeAssistantMemoryContext;
    const capture = yield* makeAssistantHistoryPolicy;
    return ContextHandoffEpoch.of({
      capture,
      current: Effect.fn("AssistantMemory.handoffEpoch")(function* (threadId) {
        const record = yield* repository.findByThread(threadId);
        if (record === null) return undefined;
        const current = yield* context(record).pipe(
          Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })),
        );
        return {
          memoryEpoch: current.memoryEpoch,
          memoryContextHash: assistantMemoryContextHash(current.text),
        };
      }),
    });
  }),
).pipe(
  Layer.provideMerge(layerSharedMemory),
  Layer.provideMerge(Memory.layerFactPolicy),
  Layer.provideMerge(Repository.layer),
);
