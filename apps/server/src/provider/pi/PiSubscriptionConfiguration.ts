import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  PiNativeConfigurationUnavailable,
  readPiNativeModelsFile,
} from "./PiNativeConfiguration.ts";

const strict = { onExcessProperty: "error" } as const;
const source = "pi-sdk:0.99.1/openai-codex";
const baseUrl = "https://chatgpt.com/backend-api";
const modelId = "gpt-6-luna";
const provider = "openai-codex";
const api = "openai-codex-responses";
const registered = structuredClone(OPENAI_CODEX_MODELS[modelId]);
const Positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Input = Schema.Struct({
  agentDirectory: Schema.String,
  runtimeVersion: Schema.Literal("0.99.1"),
  nodeVersion: Schema.String.check(
    Schema.isPattern(/^\d+\.\d+\.\d+$/),
    Schema.makeFilter((value) => {
      const [major, minor] = value.split(".").map(Number);
      return (
        major !== undefined && minor !== undefined && (major > 22 || (major === 22 && minor >= 19))
      );
    }),
  ),
  selectedModel: Schema.Struct({
    provider: Schema.Literal(provider),
    model: Schema.Literal(modelId),
  }),
  limits: Schema.Struct({
    maxInputTokens: Positive.check(Schema.isLessThanOrEqualTo(32_768)),
    maxOutputTokens: Schema.Literal(2_048),
    deadlineMs: Positive.check(Schema.isLessThanOrEqualTo(300_000)),
  }),
  reasoningEffort: Schema.Literal("high"),
  serviceTier: Schema.Literal("default"),
});
const NativeModels = Schema.Struct({
  providers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const NativeProvider = Schema.Struct({
  baseUrl: Schema.optional(Schema.Literal(baseUrl)),
  api: Schema.optional(Schema.Literal(api)),
  models: Schema.optional(
    Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).check(Schema.isMaxLength(256)),
  ),
});
const NativeModel = Schema.Struct({
  id: Schema.Literal(modelId),
  name: Schema.optional(Schema.String),
  api: Schema.optional(Schema.Literal(api)),
  baseUrl: Schema.optional(Schema.Literal(baseUrl)),
  reasoning: Schema.optional(Schema.Literal(true)),
  contextWindow: Schema.optional(Positive),
  maxTokens: Schema.optional(Positive),
  input: Schema.optional(
    Schema.Union([
      Schema.Tuple([Schema.Literal("text")]),
      Schema.Tuple([Schema.Literal("text"), Schema.Literal("image")]),
    ]),
  ),
});
const decodeInput = Schema.decodeUnknownEffect(Input, strict);
const decodeNativeModels = Schema.decodeEffect(fromLenientJson(NativeModels));
const decodeProvider = Schema.decodeUnknownEffect(NativeProvider, strict);
const decodeModel = Schema.decodeUnknownEffect(NativeModel, strict);
const unavailable = (reason: PiNativeConfigurationUnavailable["reason"]) =>
  new PiNativeConfigurationUnavailable({ reason });

/** SDK inventory is route metadata, never account entitlement or an upstream output guarantee. */
export const inspectPiSubscriptionConfiguration = Effect.fn("inspectPiSubscriptionConfiguration")(
  function* (input: unknown) {
    const value = yield* decodeInput(input).pipe(
      Effect.mapError(() => unavailable("configuration")),
    );
    if (
      registered.id !== modelId ||
      registered.provider !== provider ||
      registered.api !== api ||
      registered.baseUrl !== baseUrl ||
      !registered.reasoning ||
      registered.thinkingLevelMap?.high !== "high" ||
      !Number.isSafeInteger(registered.contextWindow) ||
      !Number.isSafeInteger(registered.maxTokens) ||
      value.limits.maxInputTokens + value.limits.maxOutputTokens > registered.contextWindow
    )
      return yield* unavailable("configuration");
    const contents = yield* readPiNativeModelsFile(value.agentDirectory);
    if (contents !== undefined) {
      const native = yield* decodeNativeModels(contents).pipe(
        Effect.mapError(() => unavailable("native-configuration")),
      );
      const override = native.providers?.[provider];
      if (override !== undefined) {
        const configured = yield* decodeProvider(override).pipe(
          Effect.mapError(() => unavailable("native-configuration")),
        );
        const selected = configured.models?.filter((entry) => entry.id === modelId) ?? [];
        if (selected.length > 1) return yield* unavailable("native-configuration");
        if (selected[0] !== undefined) {
          const model = yield* decodeModel(selected[0]).pipe(
            Effect.mapError(() => unavailable("native-configuration")),
          );
          if (
            (model.contextWindow !== undefined &&
              model.contextWindow !== registered.contextWindow) ||
            (model.maxTokens !== undefined && model.maxTokens !== registered.maxTokens)
          )
            return yield* unavailable("native-configuration");
        }
      }
    }
    return Object.freeze({
      provider,
      model: modelId,
      api,
      endpoint: `${baseUrl}/codex/responses`,
      contextWindow: registered.contextWindow,
      maxInputTokens: value.limits.maxInputTokens,
      maxOutputTokens: value.limits.maxOutputTokens,
      advertisedMaxOutputTokens: registered.maxTokens,
      deadlineMs: value.limits.deadlineMs,
      reasoning: true as const,
      reasoningEffort: value.reasoningEffort,
      serviceTier: value.serviceTier,
      input: Object.freeze(["text"] as const),
      cost: "unknown" as const,
      catalogue: Object.freeze({ source, fetchedAt: DateTime.formatIso(yield* DateTime.now) }),
    });
  },
);
