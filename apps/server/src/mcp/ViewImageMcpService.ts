import { OrchestratorMcpFailure, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { fileHeaderMimeType } from "../workspace/fileHeaderMimeType.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const SETTINGS_PATH = "Settings → Threads → Image viewing";

export interface ViewImageInput {
  /** The calling thread's checkout: its worktree, or its project's folder. */
  readonly root: string;
  readonly path: string;
  readonly instructions: string;
}

export class ViewImageMcpService extends Context.Service<
  ViewImageMcpService,
  {
    readonly view: (
      input: ViewImageInput,
    ) => Effect.Effect<{ readonly description: string }, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ViewImageMcpService") {}

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const isServerInternalPath = yield* makeIsServerInternalPath;

  const realPath = (value: string) => fileSystem.realPath(value).pipe(Effect.option);

  const resolveImage = Effect.fn("ViewImageMcpService.resolveImage")(function* (
    root: string,
    requested: string,
  ) {
    const realRoot = yield* realPath(root);
    if (Option.isNone(realRoot)) {
      return yield* refuse("This thread's workspace folder is missing.");
    }
    const outside = refuse(`${requested} is outside this thread's workspace (${root}).`);
    const absolute = path.resolve(root, requested);
    // Refuse before touching the disk, so the tool cannot probe paths outside the workspace.
    if (!isWithinRoot(path, absolute, root) && !isWithinRoot(path, absolute, realRoot.value)) {
      return yield* outside;
    }
    const file = yield* realPath(absolute);
    if (Option.isNone(file)) return yield* refuse(`No file at ${requested}.`);
    if (!isWithinRoot(path, file.value, realRoot.value)) return yield* outside;
    const stateDir = yield* realPath(config.stateDir);
    if (
      (yield* isServerInternalPath(file.value)) ||
      (Option.isSome(stateDir) && isWithinRoot(path, file.value, stateDir.value))
    ) {
      return yield* refuse(`${requested} is T3 Code's own data, which this tool does not read.`);
    }
    const info = yield* fileSystem.stat(file.value).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") {
      return yield* refuse(`${requested} is not a file.`);
    }
    if (Number(info.value.size) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return yield* refuse(
        `${requested} is larger than the ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 1024 / 1024} MiB limit.`,
      );
    }
    const header = yield* fileSystem.open(file.value, { flag: "r" }).pipe(
      Effect.flatMap((handle) => handle.readAlloc(16)),
      Effect.scoped,
      Effect.map(Option.getOrElse(() => new Uint8Array())),
      Effect.orElseSucceed(() => new Uint8Array()),
    );
    const mimeType = fileHeaderMimeType(header);
    if (mimeType === undefined || !IMAGE_MIME_TYPES.has(mimeType)) {
      return yield* refuse(`${requested} is not a PNG, JPEG, WebP or GIF image.`);
    }
    return { path: file.value, mimeType };
  });

  const view = Effect.fn("ViewImageMcpService.view")(function* (input: ViewImageInput) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "T3 Code could not read its settings.",
          }),
      ),
    );
    if (!settings.viewImageToolEnabled) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: `Viewing images is off. The user can turn it on in ${SETTINGS_PATH}.`,
      });
    }
    const modelSelection = settings.visionModelSelection;
    if (modelSelection === null) {
      return yield* new OrchestratorMcpFailure({
        code: "model_unavailable",
        message: `No vision model is chosen. The user can choose one in ${SETTINGS_PATH}.`,
      });
    }
    const image = yield* resolveImage(input.root, input.path);
    return yield* textGeneration
      .describeImage({
        cwd: input.root,
        imagePath: image.path,
        mimeType: image.mimeType,
        instructions: input.instructions,
        modelSelection,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "model_unavailable",
              message: `The vision model could not describe the image: ${error.detail}`,
            }),
        ),
      );
  });

  return ViewImageMcpService.of({ view });
});

export const layer = Layer.effect(ViewImageMcpService, make);
