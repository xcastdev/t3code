import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OmpRpcError, OmpRpcTimeoutError } from "./rpc.ts";
import { availableCommands } from "./commands.ts";
export interface OmpRequester {
  readonly request: (record: {
    type: string;
    [key: string]: unknown;
  }) => Effect.Effect<unknown, OmpRpcError | OmpRpcTimeoutError>;
}
const Model = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  name: Schema.optional(Schema.String),
  contextWindow: Schema.optional(Schema.Number),
  reasoning: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(Schema.Struct({ efforts: Schema.Array(Schema.String) })),
});
const Commands = Schema.Struct({
  commands: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      aliases: Schema.optional(Schema.Array(Schema.String)),
      description: Schema.optional(Schema.String),
      source: Schema.Unknown,
    }),
  ),
});
const decodeThinkingLevels = Schema.decodeUnknownEffect(
  Schema.Struct({ levels: Schema.Array(Schema.String) }),
);
export const decodeOmpCommands = Schema.decodeUnknownEffect(Commands);
const State = Schema.Struct({
  sessionId: Schema.String,
  model: Schema.optional(Model),
  thinkingLevel: Schema.optional(Schema.String),
  isSettled: Schema.Boolean,
});
export const discoverOmp = Effect.fn("Omp.discover")(function* (rpc: OmpRequester) {
  const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        (cause) =>
          new OmpRpcError({
            operation: "discovery",
            detail: "Required pinned native capability returned an incompatible response",
            cause,
          }),
      ),
    );
  const models = yield* rpc
    .request({ type: "get_available_models" })
    .pipe(Effect.flatMap((v) => decode(Schema.Struct({ models: Schema.Array(Model) }), v)));
  const levels = yield* rpc
    .request({ type: "get_available_thinking_levels" })
    .pipe(Effect.flatMap((v) => decode(Schema.Struct({ levels: Schema.Array(Schema.String) }), v)));
  const commands = yield* rpc
    .request({ type: "get_available_commands" })
    .pipe(Effect.flatMap((v) => decode(Commands, v)));
  const state = yield* rpc
    .request({ type: "get_state" })
    .pipe(Effect.flatMap((v) => decode(State, v)));
  return {
    models: models.models.map((m) => ({ ...m, nativeId: m.id, id: `${m.provider}/${m.id}` })),
    thinking: levels.levels,
    defaultThinking: state.thinkingLevel,
    defaultModel: state.model ? `${state.model.provider}/${state.model.id}` : undefined,
    commands: availableCommands(commands.commands),
    nativeCommands: commands.commands,
    state,
  };
});

export type OmpDiscovery = Effect.Success<ReturnType<typeof discoverOmp>>;
export function projectOmpDiscovery(discovery: OmpDiscovery) {
  const thinkingDescriptors = (levels: readonly string[], current?: string) =>
    levels.length
      ? [
          {
            id: "thinking",
            label: "Thinking",
            type: "select" as const,
            role: "reasoning" as const,
            options: levels.map((id) => ({
              id,
              label: id,
              ...(id === current ? { isDefault: true } : {}),
            })),
            ...(current && levels.includes(current) ? { currentValue: current } : {}),
          },
        ]
      : [];
  const descriptors = thinkingDescriptors(discovery.thinking, discovery.defaultThinking);
  return {
    models: discovery.models.map((model) => ({
      slug: model.id,
      name: model.name?.trim() || model.id,
      subProvider: model.provider,
      isCustom: false,
      isDefault: model.id === discovery.defaultModel,
      capabilities: {
        optionDescriptors:
          model.id === discovery.defaultModel
            ? descriptors
            : thinkingDescriptors([
                "off",
                ...(model.reasoning ? (model.thinking?.efforts ?? []) : []),
              ]),
      },
    })),
    slashCommands: discovery.commands.flatMap((c) =>
      [c.name, ...(c.aliases ?? [])].map((name) => ({
        name,
        ...(c.description?.trim() ? { description: c.description.trim() } : {}),
      })),
    ),
    skills: discovery.commands
      .filter((c) => c.source === "skill")
      .map((c) => ({
        name: c.name.replace(/^skill:/, ""),
        path: `omp:skill:${c.name.replace(/^skill:/, "")}`,
        enabled: true,
        ...(c.description?.trim() ? { description: c.description.trim() } : {}),
      })),
    optionDescriptors: descriptors,
  };
}
export const applyOmpSelection = Effect.fn("Omp.applySelection")(function* (
  rpc: OmpRequester,
  selection: { model: string; options?: readonly { id: string; value: string | boolean }[] },
  baseline: OmpDiscovery,
) {
  const slug = selection.model === "default" ? baseline.defaultModel : selection.model;
  const model = baseline.models.find((m) => m.id === slug);
  if (!model)
    return yield* new OmpRpcError({
      operation: "selection",
      detail: "Native model is unavailable or has no credentials",
    });
  for (const option of selection.options ?? [])
    if (option.id !== "thinking" || typeof option.value !== "string")
      return yield* new OmpRpcError({
        operation: "selection",
        detail: "Unsupported native model option",
      });
  yield* rpc.request({ type: "set_model", provider: model.provider, modelId: model.nativeId });
  const response = yield* rpc.request({ type: "get_available_thinking_levels" });
  const levels = yield* decodeThinkingLevels(response).pipe(
    Effect.mapError((cause) => new OmpRpcError({ operation: "selection", cause })),
  );
  const thinking =
    selection.options?.find((o) => o.id === "thinking")?.value ??
    (model.id === baseline.defaultModel ? baseline.defaultThinking : undefined);
  if (thinking !== undefined) {
    if (typeof thinking !== "string" || !levels.levels.includes(thinking))
      return yield* new OmpRpcError({
        operation: "selection",
        detail: "Thinking choice is unavailable for native model",
      });
    yield* rpc.request({ type: "set_thinking_level", level: thinking });
  }
});

import type { OmpSettings } from "../settings.ts";
import { makeOmpProviderSession } from "./session.ts";
import * as Stream from "effect/Stream";
export const discoverOmpWorkspace = Effect.fn("Omp.discoverWorkspace")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  cacheDir: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* makeOmpProviderSession({
        binaryPath: settings.binaryPath,
        launchArgs: settings.launchArgs,
        env: environment,
        cacheDir,
        config: { cwd, mode: "approval-required", environment: "omp-discovery", project: cwd },
        onUiRequest: (record, send) =>
          send({ type: "extension_ui_response", id: record.id, cancelled: true }),
      });
      yield* Stream.fromQueue(connection.events).pipe(
        Stream.runDrain,
        Effect.ignore,
        Effect.forkScoped,
      );
      const discovered = yield* discoverOmp(connection);
      yield* connection.terminate;
      return discovered;
    }),
  );
});
