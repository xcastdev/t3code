import { OrchestratorMcpFailure } from "@t3tools/contracts";
import type { WebSearchResult } from "@t3tools/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

const SETTINGS_PATH = "Settings → Threads → Web search";
/** Each search runs a model with live web access for minutes; agents in a loop should queue. */
const CONCURRENT_SEARCHES = 2;

export interface WebSearchInput {
  readonly query: string;
  readonly instructions?: string | undefined;
}

export class WebSearchMcpService extends Context.Service<
  WebSearchMcpService,
  {
    readonly search: (
      input: WebSearchInput,
    ) => Effect.Effect<WebSearchResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/WebSearchMcpService") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const permits = yield* Semaphore.make(CONCURRENT_SEARCHES);
  const searchesDir = path.join(config.stateDir, "web-search");

  // Not /tmp or a checkout: an AGENTS.md or CLAUDE.md there or above it could steer the search.
  const freshDirectory = fileSystem.makeDirectory(searchesDir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.makeTempDirectoryScoped({ directory: searchesDir })),
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "T3 Code could not create a directory for the search.",
        }),
    ),
  );

  const search = Effect.fn("WebSearchMcpService.search")(function* (input: WebSearchInput) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "T3 Code could not read its settings.",
          }),
      ),
    );
    if (!settings.webSearchToolEnabled) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: `Web search is off. The user can turn it on in ${SETTINGS_PATH}.`,
      });
    }
    const modelSelection = settings.webSearchModelSelection;
    if (modelSelection === null) {
      return yield* new OrchestratorMcpFailure({
        code: "model_unavailable",
        message: `No web search model is chosen. The user can choose one in ${SETTINGS_PATH}.`,
      });
    }
    return yield* freshDirectory.pipe(
      Effect.flatMap((cwd) =>
        textGeneration
          .webSearch({ cwd, query: input.query, instructions: input.instructions, modelSelection })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "model_unavailable",
                  message: `The web search model could not answer: ${error.detail} Check the model in ${SETTINGS_PATH}.`,
                }),
            ),
          ),
      ),
      Effect.scoped,
      permits.withPermits(1),
    );
  });

  return WebSearchMcpService.of({ search });
});

export const layer = Layer.effect(WebSearchMcpService, make);
