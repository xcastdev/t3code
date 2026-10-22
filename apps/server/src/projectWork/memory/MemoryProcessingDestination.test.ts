import { assert, it } from "@effect/vitest";
import { AssistantId, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "../../config.ts";
import { MemoryProcessingDestination, layer } from "./MemoryProcessingDestination.ts";
const infrastructure = Config.layerTest("/tmp", { prefix: "p14-memory-destination-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const fixture = layer.pipe(Layer.provideMerge(infrastructure));
const scope = {
  environmentId: EnvironmentId.make("env"),
  owner: { kind: "assistant" as const, assistantId: AssistantId.make("private-assistant") },
  ownerRevision: 0,
};
it.effect(
  "default has no external destination or filesystem side effect; explicit owner route prepares only its selected backend",
  () =>
    Effect.gen(function* () {
      const destinations = yield* MemoryProcessingDestination;
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const config = yield* Config.ServerConfig;
      assert.isUndefined(yield* destinations.prepare(scope, {}));
      assert.isFalse(yield* fs.exists(paths.join(config.stateDir, "memory-index")));
      const route = {
        environmentId: scope.environmentId,
        owner: scope.owner,
        enabled: true as const,
        endpoint: "https://example.test/embed",
        model: "owner-selected",
        secretName: "private-key",
        dimensions: 3,
      };
      const selected = yield* destinations.prepare(scope, {
        destination: {
          enabled: true,
          embeddingEnabled: true,
          backend: "mem0",
          embeddingRoute: route,
        },
      });
      assert.deepStrictEqual(selected?.owner, scope.owner);
      assert.deepStrictEqual(selected?.embeddingRoute, route);
      assert.equal(selected?.backend, "mem0");
      assert.include(selected?.args ?? [], "3");
      assert.equal(
        (yield* fs.stat(paths.join(config.stateDir, "memory-index", "cwd"))).mode & 0o077,
        0,
      );
    }).pipe(Effect.provide(fixture)),
);
