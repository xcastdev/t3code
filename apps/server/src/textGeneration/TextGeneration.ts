import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelSelection, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
  VISION_MODEL_DRIVERS,
  WEB_SEARCH_MODEL_DRIVERS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import { fallbackTextGenerationModelSelection } from "@t3tools/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";
import * as TextGenerators from "./TextGenerators.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
  MemoryExtractionInput,
  TranscriptionPostProcessingInput,
  TranscriptionPostProcessingResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide"
  | "generateTranscriptionPostProcessing"
  | "extractMemoryFacts"
  | "describeImage"
  | "webSearch";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      !instance
        ? Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          )
        : operation === "describeImage" && !VISION_MODEL_DRIVERS.has(instance.driverKind)
          ? Effect.fail(
              new TextGenerationError({
                operation,
                detail: `'${instanceId}' runs ${instance.driverKind}, which cannot look at images. Choose a Codex or OpenCode vision model.`,
              }),
            )
          : operation === "webSearch" && !WEB_SEARCH_MODEL_DRIVERS.has(instance.driverKind)
            ? Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: `'${instanceId}' runs ${instance.driverKind}, which cannot search the web. Choose a Claude or Codex web search model.`,
                }),
              )
            : Effect.succeed(instance.textGeneration),
    ),
  );

// Review guides investigate the checkout read-only; the other drivers reject that request.
const INVESTIGATING_DRIVERS = new Set(["codex", "claudeAgent"]);

// Text generators only complete prompts; these operations need an agent's tools.
const AGENT_ONLY_OPERATIONS: Partial<Record<TextGenerationOp, string>> = {
  generateReviewGuide:
    "Review guides need a coding agent that can read the checkout. None is ready. Pick Codex or Claude as the review guide model in Settings → Source control & issues.",
  describeImage:
    "Looking at images needs a vision model from a coding agent. None is ready. Choose a Codex or OpenCode vision model.",
  webSearch:
    "Web search needs a coding agent that can search the web. None is ready. Choose a Claude or Codex web search model.",
};

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const installationGate = yield* ProviderInstallationGate.ProviderInstallationGate;
  const textGenerators = yield* TextGenerators.TextGenerators;
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    selection: ModelSelection,
    projectId: ProjectId | null | undefined,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    const textGenerator = yield* textGenerators.runner(selection.instanceId);
    const textGeneratorId = selection.instanceId;
    const agentOnlyDetail = AGENT_ONLY_OPERATIONS[operation];
    const textGeneratorCannotRun = textGenerator !== undefined && agentOnlyDetail !== undefined;
    if (textGenerator !== undefined && !textGeneratorCannotRun) {
      return yield* invoke(
        TextGenerationOperations.fromRunner("TextGenerator", textGenerator),
        selection,
      );
    }
    const snapshots = yield* registry.listInstances.pipe(
      Effect.flatMap((instances) =>
        Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
      ),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const selected = snapshots.find((provider) => provider.instanceId === selection.instanceId);
    // Only a failed probe counts: a pending one is also not installed yet.
    const unusable =
      textGeneratorCannotRun ||
      (selected?.enabled === true &&
        (!isProviderTextGenerationCapable(selected) ||
          selected.models.find((model) => model.slug === selection.model)
            ?.supportsTextGeneration === false ||
          (selected.status === "error" &&
            (!selected.installed || selected.auth.status === "unauthenticated"))));
    if (unusable || exhaustedUsageWindow(selected, now, selection.model)) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Could not read fallback model settings.",
              cause,
            }),
        ),
      );
      selection =
        fallbackTextGenerationModelSelection(
          settings.providerInstances,
          (instanceId, driver, model) => {
            const provider = snapshots.find((candidate) => candidate.instanceId === instanceId);
            return (
              instanceId !== selection.instanceId &&
              provider?.enabled === true &&
              resolveProjectProviderInstanceEnabled(settings, projectId ?? null, instanceId) &&
              provider.installed &&
              provider.auth.status !== "unauthenticated" &&
              provider.status !== "error" &&
              isProviderAvailable(provider) &&
              isProviderTextGenerationCapable(provider) &&
              (operation !== "generateReviewGuide" || INVESTIGATING_DRIVERS.has(driver)) &&
              (operation !== "describeImage" || VISION_MODEL_DRIVERS.has(driver)) &&
              (operation !== "webSearch" || WEB_SEARCH_MODEL_DRIVERS.has(driver)) &&
              !exhaustedUsageWindow(provider, now, model)
            );
          },
          { defaultModelSelection: settings.defaultModelSelection },
        ) ?? selection;
    }
    if (
      agentOnlyDetail !== undefined &&
      textGeneratorCannotRun &&
      selection.instanceId === textGeneratorId
    ) {
      return yield* new TextGenerationError({ operation, detail: agentOnlyDetail });
    }
    return yield* installationGate.execute(
      selection.instanceId,
      resolveInstance(registry, operation, selection.instanceId).pipe(
        Effect.flatMap((service) => invoke(service, selection)),
      ),
    );
  });
  return TextGeneration.of({
    extractMemoryFacts: Effect.fn("TextGeneration.extractMemoryFacts")(function* (input) {
      const textGenerator = yield* textGenerators.runner(input.modelSelection.instanceId);
      const service =
        textGenerator !== undefined
          ? TextGenerationOperations.fromRunner("TextGenerator", textGenerator)
          : yield* resolveInstance(registry, "extractMemoryFacts", input.modelSelection.instanceId);
      return yield* service.extractMemoryFacts(input);
    }),
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate(
        "generateCommitMessage",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate(
        "generatePrContent",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate(
        "generateBranchName",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate(
        "generateReviewGuide",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    generateTranscriptionPostProcessing: Effect.fn(
      "TextGeneration.generateTranscriptionPostProcessing",
    )(function (input) {
      return generate(
        "generateTranscriptionPostProcessing",
        input.modelSelection,
        null,
        (service, modelSelection) =>
          service.generateTranscriptionPostProcessing({ ...input, modelSelection }),
      );
    }),
    describeImage: Effect.fn("TextGeneration.describeImage")(function (input) {
      return generate("describeImage", input.modelSelection, null, (service, modelSelection) =>
        service.describeImage({ ...input, modelSelection }),
      );
    }),
    webSearch: Effect.fn("TextGeneration.webSearch")(function (input) {
      return generate("webSearch", input.modelSelection, null, (service, modelSelection) =>
        service.webSearch({ ...input, modelSelection }),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return generate(
        "generateThreadTitle",
        input.modelSelection,
        input.projectId,
        (textGeneration, modelSelection) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({
              ...input,
              linkedContext,
              modelSelection,
            });
          }),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make).pipe(
  Layer.provideMerge(TextGenerators.layer),
);
