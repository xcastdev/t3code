import type { ManagedSkillKey, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  SkillMaterializationService,
  type SkillMaterializationInput,
} from "../../skills/SkillMaterializationService.ts";
import { ProviderSkillAdapterError } from "../../skills/ProviderSkillAdapter.ts";
import type { ClaudeManagedSkillPlanPayload } from "./ClaudeManagedSkills.ts";

export const materializeClaudeManagedPlugin = Effect.fn("ClaudeSkillMaterializer.materialize")(
  function* (
    input: SkillMaterializationInput & {
      readonly collidingNativeKeys: ReadonlyArray<ManagedSkillKey>;
    },
  ): Effect.fn.Return<
    ClaudeManagedSkillPlanPayload,
    ProviderSkillAdapterError,
    SkillMaterializationService | FileSystem.FileSystem | Path.Path
  > {
    const service = yield* SkillMaterializationService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const materialized = yield* service.materialize(input).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSkillAdapterError({
            code: "materialization_failed",
            detail: cause.detail,
            cause,
          }),
      ),
    );
    // Keep generated Claude scaffolding outside the portable managed-key namespace.
    // A managed skill is allowed to use `plugin` as its key, so the scaffold must
    // never share a path with a copied source package.
    const pluginPath = path.join(materialized.root, ".t3-claude-plugin");
    const pluginResult = yield* Effect.gen(function* () {
      yield* fs.makeDirectory(path.join(pluginPath, ".claude-plugin"), { recursive: true });
      yield* fs.makeDirectory(path.join(pluginPath, "skills"), { recursive: true });
      yield* fs.writeFileString(
        path.join(pluginPath, ".claude-plugin", "plugin.json"),
        '{"name":"t3-managed","version":"0.0.0"}',
      );
      for (const [key, source] of materialized.skillPaths) {
        yield* fs.copy(source, path.join(pluginPath, "skills", key));
      }
    }).pipe(Effect.exit);
    if (Exit.isFailure(pluginResult)) {
      yield* service
        .dispose({
          sessionId: input.sessionId,
          providerInstanceId: input.providerInstanceId,
          desiredRevision: input.desiredRevision,
        })
        .pipe(Effect.ignore);
      return yield* new ProviderSkillAdapterError({
        code: "materialization_failed",
        detail: "Could not build the Claude managed-skill plugin.",
        cause: pluginResult.cause,
      });
    }
    return {
      kind: "claude-managed-skills",
      pluginPath,
      collidingNativeKeys: [...input.collidingNativeKeys],
      skillKeys: input.packages.map((item) => item.key),
    };
  },
);

export const disposeClaudeManagedPlugin = (input: {
  readonly sessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly desiredRevision: number;
}) =>
  SkillMaterializationService.pipe(
    Effect.flatMap((service) => service.dispose(input)),
    Effect.mapError(
      (cause) =>
        new ProviderSkillAdapterError({
          code: "cleanup_failed",
          detail: cause.detail,
          cause,
        }),
    ),
  );
