import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderInstanceId,
  type ServerSettings as ServerSettingsSchema,
} from "@t3tools/contracts";
import type { ImageDescriptionInput } from "@t3tools/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ViewImageMcpService from "./ViewImageMcpService.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const visionModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4-mini",
};

/** A workspace with T3's data dir inside it, an image outside it, and the service over both. */
const setup = (settings: Partial<ServerSettingsSchema> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sandbox = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-view-image-" }),
    );
    const root = path.join(sandbox, "repo");
    const outside = path.join(sandbox, "outside");
    yield* fs.makeDirectory(path.join(root, "docs"), { recursive: true });
    yield* fs.makeDirectory(outside);
    yield* fs.writeFile(path.join(root, "docs", "screen.png"), PNG);
    yield* fs.writeFile(path.join(outside, "secret.png"), PNG);
    yield* fs.symlink(path.join(outside, "secret.png"), path.join(root, "docs", "link.png"));
    yield* fs.writeFileString(path.join(root, "notes.txt"), "plain text");
    yield* fs.writeFileString(path.join(root, "renamed.png"), "GIF? no, just text");
    yield* fs.writeFile(path.join(root, "huge.png"), PNG);
    yield* fs.truncate(path.join(root, "huge.png"), PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);

    const calls: Array<ImageDescriptionInput> = [];
    const context = yield* Layer.build(
      ViewImageMcpService.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerConfig.layerTest(root, path.join(root, ".t3")),
            ServerSettings.layerTest({
              viewImageToolEnabled: true,
              visionModelSelection,
              ...settings,
            }),
            Layer.mock(TextGeneration.TextGeneration)({
              describeImage: (input) =>
                Effect.sync(() => {
                  calls.push(input);
                  return { description: "A sign-in form with a red error banner." };
                }),
            }),
          ),
        ),
      ),
    );
    const config = Context.get(context, ServerConfig.ServerConfig);
    const internal = path.join(config.attachmentsDir, "shot.png");
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFile(internal, PNG);
    return {
      root,
      outside,
      internal,
      calls,
      view: (requested: string) =>
        Context.get(context, ViewImageMcpService.ViewImageMcpService).view({
          root,
          path: requested,
          instructions: "Read the error banner.",
        }),
    };
  });

it.effect("sends a workspace image and the instructions to the vision model", () =>
  Effect.gen(function* () {
    const { root, calls, view } = yield* setup();
    const path = yield* Path.Path;

    expect(yield* view("docs/screen.png")).toEqual({
      description: "A sign-in form with a red error banner.",
    });
    yield* view(path.join(root, "docs", "screen.png"));

    const sent = {
      cwd: root,
      imagePath: path.join(root, "docs", "screen.png"),
      mimeType: "image/png",
      instructions: "Read the error banner.",
      modelSelection: visionModelSelection,
    };
    expect(calls).toEqual([sent, sent]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses paths outside the workspace, T3's own data, and files that are not images", () =>
  Effect.gen(function* () {
    const { outside, internal, calls, view } = yield* setup();
    const refusals = {
      "../outside/secret.png": "outside this thread's workspace",
      [`${outside}/secret.png`]: "outside this thread's workspace",
      "docs/link.png": "outside this thread's workspace",
      [internal]: "T3 Code's own data",
      "missing.png": "No file at",
      docs: "is not a file",
      "notes.txt": "is not a PNG, JPEG, WebP or GIF image",
      "renamed.png": "is not a PNG, JPEG, WebP or GIF image",
      "huge.png": "larger than the 10 MiB limit",
    };
    for (const [requested, message] of Object.entries(refusals)) {
      const failure = yield* Effect.flip(view(requested));
      expect({ requested, code: failure.code, message: failure.message }).toEqual({
        requested,
        code: "invalid_request",
        message: expect.stringContaining(message),
      });
    }
    expect(calls).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails clearly while the tool is off or has no vision model", () =>
  Effect.gen(function* () {
    const off = yield* setup({ viewImageToolEnabled: false });
    expect(yield* Effect.flip(off.view("docs/screen.png"))).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("Viewing images is off"),
    });

    const noModel = yield* setup({ visionModelSelection: null });
    expect(yield* Effect.flip(noModel.view("docs/screen.png"))).toMatchObject({
      code: "model_unavailable",
      message: expect.stringContaining("No vision model is chosen"),
    });
    expect([...off.calls, ...noModel.calls]).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
