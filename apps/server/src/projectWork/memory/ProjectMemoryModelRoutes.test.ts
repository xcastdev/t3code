import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  type MemoryExtractionRoute,
  type MemoryEmbeddingRoute,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as Routes from "./ProjectMemoryModelRoutes.ts";

const scope = {
  environmentId: EnvironmentId.make("env"),
  owner: { kind: "project" as const, projectId: ProjectId.make("project") },
  ownerRevision: 0,
};
const extraction: MemoryExtractionRoute = {
  ...scope,
  enabled: true,
  provider: "liquid",
  endpoint: "https://example.test/chat/completions",
  model: "configured-model",
  secretName: "memory-route",
};
const embedding: MemoryEmbeddingRoute = {
  ...scope,
  enabled: true,
  endpoint: "https://example.test/embeddings",
  model: "configured-embedding",
  secretName: "memory-route",
  dimensions: 3,
};
const fixture = (onRequest: (request: HttpClientRequestForTest) => Response) =>
  Routes.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, onRequest(request))),
        ),
      ),
    ),
    Layer.provide(
      Layer.succeed(Secrets.ServerSecretStore, {
        get: () => Effect.succeed(Option.some(new TextEncoder().encode("private-key"))),
        set: () => Effect.void,
        create: () => Effect.void,
        getOrCreateRandom: () => Effect.die("unused"),
        remove: () => Effect.void,
      }),
    ),
  );
type HttpClientRequestForTest = Parameters<Parameters<typeof HttpClient.make>[0]>[0];
it.effect(
  "does not request external inference from available credentials until owner explicitly selects a route",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* Routes.ProjectMemoryModelRoutes.pipe(
        Effect.provide(
          fixture(() => {
            calls++;
            return new Response("{}");
          }),
        ),
      );
      assert.equal(calls, 0);
    }),
);
it.effect(
  "rejects a route belonging to another owner before reading a credential or making a request",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* Effect.gen(function* () {
        const routes = yield* Routes.ProjectMemoryModelRoutes;
        const result = yield* routes
          .extract(
            scope,
            { ...extraction, owner: { kind: "project", projectId: ProjectId.make("foreign") } },
            "source",
          )
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }).pipe(
        Effect.provide(
          fixture(() => {
            calls++;
            return new Response("{}");
          }),
        ),
      );
      assert.equal(calls, 0);
    }),
);
it.effect("uses only the selected endpoint/model and rejects unsupported factual output", () =>
  Effect.gen(function* () {
    const routes = yield* Routes.ProjectMemoryModelRoutes;
    const result = yield* routes.extract(scope, extraction, "Known source").pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }).pipe(
    Effect.provide(
      fixture((request) => {
        assert.equal(request.url, extraction.endpoint);
        assert.equal(request.headers.authorization, "Bearer private-key");
        return Response.json({
          model: extraction.model,
          choices: [
            {
              message: {
                content:
                  '{"facts":[{"key":"same","body":"a","quote":"Known"},{"key":"same","body":"b","quote":"Known"}]}',
              },
            },
          ],
        });
      }),
    ),
  ),
);
it.effect("validates embedding cardinality, index order and configured dimensions", () =>
  Effect.gen(function* () {
    const routes = yield* Routes.ProjectMemoryModelRoutes;
    assert.deepStrictEqual(yield* routes.embed(scope, embedding, ["first", "second"]), [
      [1, 2, 3],
      [4, 5, 6],
    ]);
  }).pipe(
    Effect.provide(
      fixture(() =>
        Response.json({
          model: embedding.model,
          data: [
            { index: 1, embedding: [4, 5, 6] },
            { index: 0, embedding: [1, 2, 3] },
          ],
        }),
      ),
    ),
  ),
);
