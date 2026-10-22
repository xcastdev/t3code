import type { MemoryProcessingConfiguration } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { ServerConfig } from "../../config.ts";
import * as Backend from "./MemoryBackend.ts";
import { companionPathOutsideArchive } from "./ProjectMemoryCompanion.ts";
import { ProjectMemoryError, type MemoryScope } from "./ProjectMemoryRepository.ts";

const isMemoryError = Schema.is(ProjectMemoryError);
export class MemoryProcessingDestination extends Context.Service<
  MemoryProcessingDestination,
  {
    readonly prepare: (
      scope: MemoryScope,
      configuration: MemoryProcessingConfiguration,
    ) => Effect.Effect<Backend.MemoryCompanionDestination | undefined, ProjectMemoryError>;
  }
>()("t3/projectWork/memory/MemoryProcessingDestination") {}
export const makeMemoryProcessingDestination = Effect.gen(function* () {
  const paths = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const pythonPath = yield* Config.String("T3CODE_MEMORY_PYTHON").pipe(
    Config.withDefault("python3"),
  );
  return Effect.fn("MemoryProcessingDestination.prepare")(
    function* (scope: MemoryScope, configuration: MemoryProcessingConfiguration) {
      if (!configuration.destination) return undefined;
      const root = paths.join(config.stateDir, "memory-index");
      const cwd = paths.join(root, "cwd");
      yield* fs.makeDirectory(cwd, { recursive: true, mode: 0o700 });
      for (const directory of [root, cwd]) {
        if (
          (yield* fs.realPath(directory)) !== directory ||
          ((yield* fs.stat(directory)).mode & 0o077) !== 0
        )
          return yield* new ProjectMemoryError({ reason: "forbidden" });
      }
      const embeddingRoute = configuration.destination.embeddingRoute;
      return Backend.mem0Destination({
        environmentId: scope.environmentId,
        owner: scope.owner,
        pythonPath,
        scriptPath: companionPathOutsideArchive(
          (yield* HostProcess.IsExecutable)
            ? paths.join(
                paths.dirname(yield* HostProcess.ExecutablePath),
                "companion",
                "mem0_backend.py",
              )
            : yield* paths.fromFileUrl(new URL("./companion/mem0_backend.py", import.meta.url)),
        ),
        storeRoot: paths.join(root, "store"),
        cwd,
        embeddingRoute,
      });
    },
    Effect.mapError((cause) =>
      isMemoryError(cause) ? cause : new ProjectMemoryError({ reason: "unavailable", cause }),
    ),
  );
});
export const layer = Layer.effect(
  MemoryProcessingDestination,
  makeMemoryProcessingDestination.pipe(
    Effect.map((prepare) => MemoryProcessingDestination.of({ prepare })),
  ),
);
