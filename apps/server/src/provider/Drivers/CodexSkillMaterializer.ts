// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { type ManagedSkillKey } from "@t3tools/contracts";
import { parse as parseYaml } from "yaml";

import {
  ProviderSkillAdapterError,
  type ProviderSkillAdapterError as ProviderSkillAdapterErrorType,
} from "../../skills/ProviderSkillAdapter.ts";
import type {
  SkillMaterializationInput,
  SkillMaterializationResult,
  SkillMaterializationServiceShape,
} from "../../skills/SkillMaterializationService.ts";

/** The authored T3 path is canonical; Codex discovers the mapped path below. */
export const CODEX_CANONICAL_EXTENSION_PATH = "providers/codex/openai.yaml";
export const CODEX_MATERIALIZED_EXTENSION_PATH = "agents/openai.yaml";

// Mirrors the pinned app-server V2SkillsListResponse__SkillInterface shape;
// Codex's authored YAML uses snake_case for these serialized fields.
const CODEX_INTERFACE_KEYS = new Set([
  "brand_color",
  "default_prompt",
  "display_name",
  "icon_large",
  "icon_small",
  "short_description",
]);

const isPlainMapping = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const extensionFailure = (
  code: "codex_extension_invalid" | "codex_extension_collision" | "materialization_failed",
  detail: string,
  cause?: unknown,
) => new ProviderSkillAdapterError({ code, detail, ...(cause === undefined ? {} : { cause }) });
const isProviderSkillAdapterError = Schema.is(ProviderSkillAdapterError);

const readOptionalFileInfo = (filePath: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await NodeFSP.lstat(filePath);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw cause;
      }
    },
    catch: (cause) =>
      extensionFailure("codex_extension_invalid", `Could not inspect '${filePath}'.`, cause),
  });

const validateCodexOpenAiExtension = (bytes: Uint8Array, sourcePath: string) => {
  try {
    const parsed: unknown = parseYaml(new TextDecoder().decode(bytes));
    if (!isPlainMapping(parsed)) {
      throw new Error("The extension must be a YAML mapping.");
    }
    for (const key of Object.keys(parsed)) {
      if (key !== "interface") throw new Error(`Unknown top-level key '${key}'.`);
    }
    const iface = parsed.interface;
    if (iface !== undefined) {
      if (!isPlainMapping(iface)) throw new Error("The interface must be a YAML mapping.");
      for (const [key, value] of Object.entries(iface)) {
        if (!CODEX_INTERFACE_KEYS.has(key)) throw new Error(`Unknown interface key '${key}'.`);
        if (typeof value !== "string")
          throw new Error(`Interface field '${key}' must be a string.`);
      }
    }
  } catch (cause) {
    throw extensionFailure(
      "codex_extension_invalid",
      `Codex extension '${sourcePath}' does not match the pinned OpenAI skill extension shape.`,
      cause,
    );
  }
};

const mapCodexOpenAiExtensions = Effect.fn("CodexSkillMaterializer.mapExtensions")(function* (
  skillPaths: ReadonlyMap<ManagedSkillKey, string>,
): Effect.fn.Return<void, ProviderSkillAdapterErrorType> {
  for (const [key, packagePath] of skillPaths) {
    const sourcePath = NodePath.join(packagePath, CODEX_CANONICAL_EXTENSION_PATH);
    const sourceInfo = yield* readOptionalFileInfo(sourcePath).pipe(
      Effect.mapError((cause) =>
        extensionFailure(
          "codex_extension_invalid",
          `Could not inspect Codex extension for managed skill '${key}'.`,
          cause,
        ),
      ),
    );
    if (sourceInfo === undefined) continue;
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      return yield* extensionFailure(
        "codex_extension_invalid",
        `Codex extension for managed skill '${key}' must be a regular file.`,
      );
    }

    const bytes = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(sourcePath),
      catch: (cause) =>
        extensionFailure(
          "codex_extension_invalid",
          `Could not read Codex extension for managed skill '${key}'.`,
          cause,
        ),
    });
    yield* Effect.try({
      try: () => validateCodexOpenAiExtension(bytes, sourcePath),
      catch: (cause) =>
        isProviderSkillAdapterError(cause)
          ? cause
          : extensionFailure(
              "codex_extension_invalid",
              `Codex extension '${sourcePath}' does not match the pinned OpenAI skill extension shape.`,
              cause,
            ),
    });

    const agentsPath = NodePath.join(packagePath, "agents");
    const destinationPath = NodePath.join(packagePath, CODEX_MATERIALIZED_EXTENSION_PATH);
    const destinationInfo = yield* readOptionalFileInfo(destinationPath).pipe(
      Effect.mapError((cause) =>
        extensionFailure(
          "codex_extension_collision",
          `Could not inspect the Codex extension destination for managed skill '${key}'.`,
          cause,
        ),
      ),
    );
    if (destinationInfo !== undefined) {
      return yield* extensionFailure(
        "codex_extension_collision",
        `Codex extension destination '${CODEX_MATERIALIZED_EXTENSION_PATH}' already exists for managed skill '${key}'.`,
      );
    }

    const agentsInfo = yield* readOptionalFileInfo(agentsPath).pipe(
      Effect.mapError((cause) =>
        extensionFailure(
          "codex_extension_collision",
          `Could not inspect the Codex extension destination for managed skill '${key}'.`,
          cause,
        ),
      ),
    );
    if (agentsInfo !== undefined && (!agentsInfo.isDirectory() || agentsInfo.isSymbolicLink())) {
      return yield* extensionFailure(
        "codex_extension_collision",
        `Codex extension destination directory for managed skill '${key}' is not a real directory.`,
      );
    }
    if (agentsInfo === undefined) {
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(agentsPath),
        catch: (cause) =>
          extensionFailure(
            "codex_extension_collision",
            `Could not create the Codex extension destination for managed skill '${key}'.`,
            cause,
          ),
      });
    }

    yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.open(destinationPath, "wx");
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
      },
      catch: (cause) =>
        extensionFailure(
          "codex_extension_collision",
          `Could not create the Codex extension destination for managed skill '${key}'.`,
          cause,
        ),
    });
  }
});

export const materializeCodexManagedSkills = Effect.fn("CodexSkillMaterializer.materialize")(
  function* (input: {
    readonly materialization: SkillMaterializationServiceShape;
    readonly materializationInput: SkillMaterializationInput;
  }): Effect.fn.Return<SkillMaterializationResult, ProviderSkillAdapterError> {
    const materialized = yield* input.materialization
      .materialize(input.materializationInput)
      .pipe(
        Effect.mapError((cause) =>
          extensionFailure(
            "materialization_failed",
            "Could not materialize managed skills.",
            cause,
          ),
        ),
      );
    const mapped = yield* mapCodexOpenAiExtensions(materialized.skillPaths).pipe(Effect.exit);
    if (Exit.isFailure(mapped)) {
      yield* input.materialization
        .dispose({
          sessionId: input.materializationInput.sessionId,
          providerInstanceId: input.materializationInput.providerInstanceId,
          desiredRevision: input.materializationInput.desiredRevision,
        })
        .pipe(Effect.ignore);
      return yield* Effect.failCause(mapped.cause);
    }
    return materialized;
  },
);

export { mapCodexOpenAiExtensions };
