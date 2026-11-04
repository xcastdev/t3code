import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ServerSettings as ServerSettingsSchema,
  TextGenerationError,
} from "@t3tools/contracts";
import type { WebSearchInput, WebSearchResult } from "@t3tools/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as WebSearchMcpService from "./WebSearchMcpService.ts";

const webSearchModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "m" };
const sourced = {
  answer: "Node 26 is the current release.",
  sources: [{ title: "Releases", url: "https://nodejs.org/en/about/previous-releases" }],
};

const setup = (
  settings: Partial<ServerSettingsSchema> = {},
  webSearch: (input: WebSearchInput) => Effect.Effect<WebSearchResult, TextGenerationError> = () =>
    Effect.succeed(sourced),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-web-search-" });
    const calls: Array<WebSearchInput> = [];
    const context = yield* Layer.build(
      WebSearchMcpService.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerConfig.layerTest(root, path.join(root, ".t3")),
            ServerSettings.layerTest({
              webSearchToolEnabled: true,
              webSearchModelSelection,
              ...settings,
            }),
            Layer.mock(TextGeneration.TextGeneration)({
              webSearch: (input) =>
                Effect.suspend(() => {
                  calls.push(input);
                  return webSearch(input);
                }),
            }),
          ),
        ),
      ),
    );
    const service = Context.get(context, WebSearchMcpService.WebSearchMcpService);
    return {
      calls,
      stateDir: Context.get(context, ServerConfig.ServerConfig).stateDir,
      search: () => service.search({ query: "Current Node?", instructions: "LTS" }),
    };
  });

it.effect(
  "searches in a fresh directory under T3's state, removed after, and returns sources",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { calls, search, stateDir } = yield* setup({}, (input) =>
        fs.readDirectory(input.cwd).pipe(
          Effect.map((entries) => {
            expect(entries).toEqual([]);
            return sourced;
          }),
          Effect.orDie,
        ),
      );
      expect(yield* search()).toEqual(sourced);
      expect(calls).toEqual([
        {
          cwd: expect.stringContaining(path.join(stateDir, "web-search")),
          query: "Current Node?",
          instructions: "LTS",
          modelSelection: webSearchModelSelection,
        },
      ]);
      expect(yield* fs.exists(calls[0]!.cwd)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails clearly while off, without a model, or when the model cannot search", () =>
  Effect.gen(function* () {
    const off = yield* setup({ webSearchToolEnabled: false });
    expect(yield* Effect.flip(off.search())).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("Settings → Threads → Web search"),
    });

    const noModel = yield* setup({ webSearchModelSelection: null });
    expect(yield* Effect.flip(noModel.search())).toMatchObject({
      code: "model_unavailable",
      message: expect.stringContaining("No web search model is chosen"),
    });
    expect([...off.calls, ...noModel.calls]).toEqual([]);

    const ineligible = yield* setup({}, () =>
      Effect.fail(
        new TextGenerationError({
          operation: "webSearch",
          detail: "'cursor' runs cursor, which cannot search the web.",
        }),
      ),
    );
    expect(yield* Effect.flip(ineligible.search())).toMatchObject({
      code: "model_unavailable",
      message: expect.stringContaining("cannot search the web"),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
