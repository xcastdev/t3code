import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  TextGenerationError,
  MemoryExtractionResult,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { MemoryExtractionInput } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Hosts from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Text from "./TextGeneration.ts";
const makeInstance = (
  id: string,
  extract: (
    input: MemoryExtractionInput,
  ) => Effect.Effect<MemoryExtractionResult, TextGenerationError>,
): ProviderInstance => {
  const instanceId = ProviderInstanceId.make(id);
  const driverKind = ProviderDriverKind.make("codex");
  const unsupported = () =>
    Effect.fail(
      new TextGenerationError({ operation: "unrelated", detail: "Unexpected text operation." }),
    );
  return {
    instanceId,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: id },
    displayName: undefined,
    enabled: true,
    get snapshot(): never {
      throw new Error("Extraction must not discover another instance.");
    },
    get orchestrationAdapter(): never {
      throw new Error("Extraction must not start a coding turn.");
    },
    textGeneration: {
      extractMemoryFacts: extract,
      generateBranchName: unsupported,
      generateCommitMessage: unsupported,
      generatePrContent: unsupported,
      generateThreadTitle: unsupported,
      generateReviewGuide: unsupported,
    },
  };
};
const service = (instances: readonly ProviderInstance[]) =>
  Text.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Registry.ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.succeed(instances.find((instance) => instance.instanceId === id)),
        }),
        Layer.mock(Hosts.SourceControlProviderRegistry)({ resolveLink: () => undefined }),
      ),
    ),
  );
it.effect("extracts through the selected native instance with its model options", () =>
  Effect.gen(function* () {
    const calls: MemoryExtractionInput[] = [];
    const chosen = makeInstance("chosen", (input) =>
      Effect.sync(() => {
        calls.push(input);
        return {
          facts: [{ key: "preference", body: "Use focused tests", quote: "focused tests" }],
        };
      }),
    );
    const other = makeInstance("other", () =>
      Effect.die(new Error("Another instance cannot provide fallback credentials.")),
    );
    const input: MemoryExtractionInput = {
      cwd: "/project",
      sourceText: "Prefer focused tests",
      modelSelection: {
        instanceId: chosen.instanceId,
        model: "native-model",
        options: [{ id: "thinkingLevel", value: "high" }],
      },
    };
    const result = yield* Text.TextGeneration.use((text) => text.extractMemoryFacts(input)).pipe(
      Effect.provide(service([chosen, other])),
    );
    assert.deepStrictEqual(
      result.facts.map((fact) => fact.key),
      ["preference"],
    );
    assert.deepStrictEqual(calls, [input]);
  }),
);

it.effect("missing selected instance never falls back to another account", () =>
  Effect.gen(function* () {
    const other = makeInstance("other", () =>
      Effect.die(new Error("No fallback account may run.")),
    );
    const outcome = yield* Text.TextGeneration.use((text) =>
      text.extractMemoryFacts({
        cwd: "/project",
        sourceText: "A fact",
        modelSelection: { instanceId: ProviderInstanceId.make("missing"), model: "model" },
      }),
    ).pipe(Effect.provide(service([other])), Effect.result);
    assert.equal(outcome._tag, "Failure");
    if (outcome._tag === "Failure") assert.equal(outcome.failure.operation, "extractMemoryFacts");
  }),
);
it.effect("unsupported native extraction remains an explicit error", () =>
  Effect.gen(function* () {
    const instance = makeInstance("selected", () =>
      Effect.fail(
        new TextGenerationError({
          operation: "extractMemoryFacts",
          detail: "Provider does not support native extraction.",
        }),
      ),
    );
    const outcome = yield* Text.TextGeneration.use((text) =>
      text.extractMemoryFacts({
        cwd: "/project",
        sourceText: "A fact",
        modelSelection: { instanceId: instance.instanceId, model: "model" },
      }),
    ).pipe(Effect.provide(service([instance])), Effect.result);
    assert.equal(outcome._tag, "Failure");
    if (outcome._tag === "Failure") assert.equal(outcome.failure.operation, "extractMemoryFacts");
  }),
);
it.effect("fact schema refuses malformed duplicate and oversized native results", () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(MemoryExtractionResult), {
      onExcessProperty: "error",
    });
    for (const input of [
      "{bad",
      '{"facts":[{"key":"a","body":"body","quote":"quote"},{"key":"a","body":"other","quote":"quote"}]}',
      '{"facts":[],"authority":"approved"}',
      `{"facts":[{"key":"fact","body":"${"x".repeat(8001)}","quote":"quote"}]}`,
    ]) {
      assert.equal((yield* decode(input).pipe(Effect.result))._tag, "Failure");
    }
  }),
);
