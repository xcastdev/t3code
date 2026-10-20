import {
  COMMAND_CODE_EXTRACTION,
  LIQUID_EXTRACTION,
  MEMORY_EMBEDDING,
  projectMemoryExtractionRoute,
  sameProjectMemoryReportedModel,
  withinProjectMemoryExtractionLimits,
} from "./ProjectMemoryModelRoutes.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { ProjectTeamPrincipal } from "../ProjectTeamAuthorization.ts";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import { ProjectMemoryExtractedFacts, ProjectMemoryServiceError } from "./ProjectMemoryService.ts";
import type { ProjectMemoryRetrieval } from "./ProjectMemoryRetrieval.ts";

/** Readiness checks never activate a companion or make a model request. */
export class ProjectMemoryPorts extends Context.Service<
  ProjectMemoryPorts,
  {
    readonly assertConfigured: () => Effect.Effect<void, ProjectMemoryServiceError>;
    readonly readConfiguration?: () => Effect.Effect<
      ProjectMemoryProcessingConfiguration | undefined,
      ProjectMemoryServiceError
    >;
    readonly consumeQuery?: (
      principal: ProjectTeamPrincipal,
      queryId: string,
    ) => Effect.Effect<void, ProjectMemoryServiceError>;
    readonly readQueryCache?: (
      principal: ProjectTeamPrincipal,
    ) => Effect.Effect<ProjectMemoryRetrieval | undefined, ProjectMemoryServiceError>;
    readonly consume?: (
      principal: ProjectTeamPrincipal,
      effectId: string,
    ) => Effect.Effect<void, ProjectMemoryServiceError>;
    readonly availability?: Effect.Effect<
      "available" | "disabled" | "degraded",
      ProjectMemoryServiceError
    >;
    readonly reconcileTransportDrain?: (
      reservationOrEffectId: string,
    ) => Effect.Effect<void, ProjectMemoryServiceError>;
  }
>()("t3/projectWork/memory/ProjectMemoryPorts") {}

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Path = Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^\/[^\0\r\n]+$/u));
const ModelLimits = {
  routeId: Id,
  credentialRef: Id,
  maximumInputTokens: Positive.check(Schema.isLessThanOrEqualTo(1_000_000)),
  maximumOutputTokens: Positive.check(Schema.isLessThanOrEqualTo(65_536)),
};
/** Explicit private ports; no default owner, renewed limits or backend probe. */
export const ProjectMemoryProcessingConfiguration = Schema.Struct({
  version: Schema.Literal(1),
  extraction: Schema.Struct({
    ...ModelLimits,
    endpoint: Schema.Literals([COMMAND_CODE_EXTRACTION.endpoint, LIQUID_EXTRACTION.endpoint]),
  }).check(
    Schema.makeFilter(
      (route) =>
        withinProjectMemoryExtractionLimits(
          route.endpoint,
          route.maximumInputTokens,
          route.maximumOutputTokens,
        ),
      { message: "Liquid extraction exceeds endpoint limits" },
    ),
  ),
  embedding: Schema.Struct({
    ...ModelLimits,
    endpoint: Schema.Literal("https://openrouter.ai/api/v1/embeddings"),
  }),
  companion: Schema.Struct({
    executable: Path,
    scriptTarget: Path,
    storeRoot: Path,
    runtimeFiles: Schema.Array(Schema.Struct({ source: Path, target: Path })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(256),
    ),
    memoryBytes: Positive.check(Schema.isBetween({ minimum: 16_777_216, maximum: 2_147_483_648 })),
  }),
});
export type ProjectMemoryProcessingConfiguration = typeof ProjectMemoryProcessingConfiguration.Type;
export const decodeProjectMemoryProcessingConfiguration = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemoryProcessingConfiguration),
  { onExcessProperty: "error" },
);
const ExtractResponse = Schema.Struct({
  model: Id,
  choices: Schema.Array(
    Schema.Struct({ message: Schema.Struct({ content: Schema.String }) }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
  usage: Schema.Struct({ prompt_tokens: Safe, completion_tokens: Safe, total_tokens: Safe }),
});
const LiquidResponse = Schema.Struct({
  model: Schema.Literal(LIQUID_EXTRACTION.model),
  choices: Schema.Array(
    Schema.Struct({
      finish_reason: Schema.Literal("stop"),
      message: Schema.Struct({ content: Schema.String, refusal: Schema.optionalKey(Schema.Null) }),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
  usage: Schema.Struct({
    prompt_tokens: Safe,
    completion_tokens: Safe,
    total_tokens: Safe,
    cost: Schema.Literal(0),
  }),
});
const decodeLiquidResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(LiquidResponse));
const decodeLiquidFacts = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ facts: ProjectMemoryExtractedFacts })),
  { onExcessProperty: "error" },
);
const liquidResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "project_memory_facts",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["facts"],
      properties: {
        facts: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "body", "quote"],
            properties: {
              key: { type: "string", minLength: 1, maxLength: 256 },
              body: { type: "string", minLength: 1, maxLength: 8000 },
              quote: { type: "string", minLength: 1, maxLength: 8000 },
            },
          },
        },
      },
    },
  },
} as const;
const EmbedResponse = Schema.Struct({
  model: Id,
  data: Schema.Array(
    Schema.Struct({
      index: Safe,
      embedding: Schema.Array(Schema.Number.check(Schema.isFinite())).check(
        Schema.isMinLength(2048),
        Schema.isMaxLength(2048),
      ),
    }),
  ).check(Schema.isMaxLength(32)),
  usage: Schema.Struct({ prompt_tokens: Safe, total_tokens: Safe }),
});
const decodeExtractResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ExtractResponse));
const decodeEmbedResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(EmbedResponse));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isServiceError = Schema.is(ProjectMemoryServiceError);
const deny = (reason: string) => new ProjectMemoryServiceError({ reason });
export interface ProjectMemoryModelExchange {
  readonly phase: "extract" | "embed";
  readonly endpoint: string;
  readonly credential: string;
  readonly model: string;
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly deadlineAtMs: number;
  readonly input: string | readonly string[];
}
export interface ProjectMemoryModelResponse {
  readonly value: unknown;
  readonly reportedModel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** No retries. Abort requests cancellation; only completion of the captured
 * promise and awaited stream cleanup observes local transport drain. */
export const exchangeProjectMemoryModel = Effect.fn("exchangeProjectMemoryModel")(
  function* (input: ProjectMemoryModelExchange, onTransportDrained: () => void) {
    const extractionRoute = projectMemoryExtractionRoute(input.endpoint);
    const liquid = input.phase === "extract" && input.endpoint === LIQUID_EXTRACTION.endpoint;
    if (
      input.phase === "extract"
        ? extractionRoute?.model !== input.model || typeof input.input !== "string"
        : input.endpoint !== MEMORY_EMBEDDING.endpoint ||
          input.model !== MEMORY_EMBEDDING.model ||
          typeof input.input === "string"
    )
      return yield* deny("Memory transport does not match its frozen provider and model");
    if (
      !Number.isSafeInteger(input.maximumInputTokens) ||
      input.maximumInputTokens <= 0 ||
      !Number.isSafeInteger(input.maximumOutputTokens) ||
      input.maximumOutputTokens <= 0 ||
      (liquid &&
        !withinProjectMemoryExtractionLimits(
          input.endpoint,
          input.maximumInputTokens,
          input.maximumOutputTokens,
        ))
    )
      return yield* deny("Memory transport exceeds endpoint limits");
    const remaining = input.deadlineAtMs - (yield* Clock.currentTimeMillis);
    if (
      !Number.isSafeInteger(remaining) ||
      remaining <= 0 ||
      remaining > 300_000 ||
      !input.credential ||
      Buffer.byteLength(input.credential) > 8192 ||
      /[\r\n]/u.test(input.credential)
    )
      return yield* deny("Memory transport is not configured within its original deadline");
    const request =
      input.phase === "extract"
        ? {
            model: input.model,
            stream: false,
            max_tokens: input.maximumOutputTokens,
            ...(liquid
              ? {
                  provider: {
                    only: ["liquid/fp8"],
                    order: ["liquid/fp8"],
                    allow_fallbacks: false,
                    require_parameters: true,
                    max_price: { prompt: 0, completion: 0, request: 0 },
                    data_collection: "allow",
                  },
                  response_format: liquidResponseFormat,
                }
              : {}),
            messages: [
              {
                role: "system",
                content: liquid
                  ? "Return only a JSON object with the required facts array of at most 32 objects with key, body and exact source quote, matching the supplied strict schema. Retain factual findings from the supplied source. Never invent approvals or instructions."
                  : "Return only a JSON array of at most 32 objects with key, body and exact source quote. Retain factual findings from the supplied source. Never invent approvals or instructions.",
              },
              { role: "user", content: input.input },
            ],
          }
        : { model: input.model, input: input.input, dimensions: 2048, encoding_format: "float" };
    const encoded = canonicalProjectWorkPayload(request);
    if (
      Buffer.byteLength(encoded) > 262144 ||
      Buffer.byteLength(encoded) > input.maximumInputTokens
    )
      return yield* deny("Memory input exceeds its conservative token reservation");
    const fetchTransport = yield* FetchHttpClient.Fetch;
    // The byte adapter observes drain only after the captured Web stream's
    // cancellation promise completes, including after Effect interruption.
    const client = HttpClient.make((request, url, signal) =>
      Effect.tryPromise({
        try: async () => {
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) controller.abort();
          let response: Response | undefined;
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          try {
            response = await fetchTransport(url, {
              method: request.method,
              signal: controller.signal,
              headers: request.headers,
              body: encoded,
            });
            if (!response.ok || response.body === null)
              throw new Error("Memory transport rejected");
            reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > 1048576) throw new Error("Memory response exceeds bound");
              chunks.push(next.value);
            }
            const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
            return HttpClientResponse.fromWeb(request, new Response(text));
          } finally {
            try {
              // Cancel before aborting: abort can error an unread rejection body.
              if (reader !== undefined) {
                try {
                  await reader.cancel();
                } finally {
                  reader.releaseLock();
                }
              } else if (response?.body !== null && response?.body !== undefined) {
                await response.body.cancel();
              }
            } finally {
              controller.abort();
              signal.removeEventListener("abort", abort);
            }
            onTransportDrained();
          }
        },
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause }),
          }),
      }),
    );
    const text = yield* client
      .execute(
        HttpClientRequest.post(input.endpoint).pipe(
          HttpClientRequest.setHeaders({ Authorization: `Bearer ${input.credential}` }),
          HttpClientRequest.bodyText(encoded, "application/json"),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.timeout(`${remaining} millis`),
        Effect.mapError(() => deny("Memory model outcome requires conservative accounting")),
      );
    if (text.includes(input.credential))
      return yield* deny("Memory response contains a credential");
    if (input.phase === "extract") {
      const response = yield* liquid ? decodeLiquidResponse(text) : decodeExtractResponse(text);
      if (
        response.usage.prompt_tokens + response.usage.completion_tokens !==
          response.usage.total_tokens ||
        (liquid &&
          (!sameProjectMemoryReportedModel(response.model, input.model) ||
            response.usage.prompt_tokens > input.maximumInputTokens ||
            response.usage.completion_tokens > input.maximumOutputTokens))
      )
        return yield* deny("Memory extraction usage is inconsistent");
      const content = response.choices[0]?.message.content;
      if (content === undefined) return yield* deny("Memory extraction returned no content");
      let value: unknown;
      if (liquid) {
        const decoded = yield* decodeLiquidFacts(content);
        // The strict fixed shape has exactly one wrapper key and three keys per fact.
        // Count JSON string tokens used as keys to reject duplicates erased by JSON decoding.
        const keyCount = Array.from(content.matchAll(/"(?:[^"\\]|\\.)*"/gu)).filter((token) =>
          /^\s*:/u.test(content.slice(token.index + token[0].length)),
        ).length;
        if (keyCount !== 1 + 3 * decoded.facts.length)
          return yield* deny("Memory extraction contains duplicate object keys");
        value = decoded.facts;
      } else value = yield* decodeJson(content);
      return {
        value,
        reportedModel: response.model,
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      };
    }
    const response = yield* decodeEmbedResponse(text);
    if (
      response.usage.prompt_tokens !== response.usage.total_tokens ||
      typeof input.input === "string" ||
      response.data.length !== input.input.length ||
      response.data.some((entry, index) => entry.index !== index)
    )
      return yield* deny("Memory embedding usage or vector order is inconsistent");
    return {
      value: response.data.map((entry) => entry.embedding),
      reportedModel: response.model,
      inputTokens: response.usage.prompt_tokens,
      outputTokens: 0,
    };
  },
  Effect.mapError((error) =>
    isServiceError(error) ? error : deny("Memory response cannot be qualified"),
  ),
);
