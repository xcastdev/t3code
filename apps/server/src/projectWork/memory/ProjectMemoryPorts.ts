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
import { ProjectMemoryServiceError } from "./ProjectMemoryService.ts";
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
      reservationId: string,
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
    endpoint: Schema.Literal("https://api.commandcode.ai/provider/v1/chat/completions"),
  }),
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
    if (
      input.phase === "extract"
        ? input.endpoint !== "https://api.commandcode.ai/provider/v1/chat/completions" ||
          input.model !== "inclusionai/ling-3.1-flash:free" ||
          typeof input.input !== "string"
        : input.endpoint !== "https://openrouter.ai/api/v1/embeddings" ||
          input.model !== "nvidia/nemotron-3-embed-1b:free" ||
          typeof input.input === "string"
    )
      return yield* deny("Memory transport does not match its frozen provider and model");
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
            messages: [
              {
                role: "system",
                content:
                  "Return only a JSON array of at most 32 objects with key, body and exact source quote. Retain factual findings from the supplied source. Never invent approvals or instructions.",
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
            controller.abort();
            signal.removeEventListener("abort", abort);
            if (reader !== undefined) {
              try {
                await reader.cancel();
              } finally {
                reader.releaseLock();
              }
            } else if (response?.body !== null && response?.body !== undefined) {
              await response.body.cancel();
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
      const response = yield* decodeExtractResponse(text);
      if (
        response.usage.prompt_tokens + response.usage.completion_tokens !==
        response.usage.total_tokens
      )
        return yield* deny("Memory extraction usage is inconsistent");
      const content = response.choices[0]?.message.content;
      if (content === undefined) return yield* deny("Memory extraction returned no content");
      return {
        value: yield* decodeJson(content),
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
