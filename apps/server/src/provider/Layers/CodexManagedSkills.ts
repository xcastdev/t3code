import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexRpc from "effect-codex-app-server/rpc";

export const CodexManagedSkillPlanPayload = Schema.Struct({
  kind: Schema.Literal("codex-managed-skills"),
  extraRoot: Schema.String,
  skills: Schema.Array(Schema.Struct({ key: Schema.String, path: Schema.String })),
});
export type CodexManagedSkillPlanPayload = typeof CodexManagedSkillPlanPayload.Type;
export const isCodexManagedSkillPlanPayload = Schema.is(CodexManagedSkillPlanPayload);
const isSkillPathRule = Schema.is(Schema.Struct({ path: Schema.String, enabled: Schema.Boolean }));

export interface CodexManagedSkillClient {
  readonly request: <M extends CodexRpc.ClientRequestMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

export const prepareCodexManagedSkillThread = Effect.fn("prepareCodexManagedSkillThread")(
  function* <T extends { readonly config?: Record<string, unknown> | null }>(input: {
    readonly client: CodexManagedSkillClient;
    readonly cwd: string;
    readonly extraRoot: string;
    readonly managedSkills: ReadonlyArray<{ readonly key: string; readonly path: string }>;
    readonly thread: T;
  }) {
    const config = input.thread.config ?? {};
    const skills = config.skills;
    if (
      skills !== undefined &&
      (typeof skills !== "object" || skills === null || Array.isArray(skills))
    ) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidParams(
        "thread config.skills must be an object",
      );
    }
    const skillSettings = skills as Record<string, unknown> | undefined;
    const skillConfig = skillSettings?.config;
    if (skillConfig !== undefined && !Array.isArray(skillConfig)) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidParams(
        "thread config.skills.config must be an array",
      );
    }
    for (const managed of input.managedSkills) {
      const rule: unknown = skillConfig?.findLast(
        (candidate: unknown) => isSkillPathRule(candidate) && candidate.path === managed.path,
      );
      if (isSkillPathRule(rule) && !rule.enabled) {
        return yield* CodexErrors.CodexAppServerRequestError.invalidParams(
          "Thread configuration disables a T3-managed skill path.",
        );
      }
    }

    // This changes process runtime roots and clears the cache; it does not write skill config.
    yield* input.client.request("skills/extraRoots/set", { extraRoots: [input.extraRoot] });
    const listed = yield* input.client.request("skills/list", {
      cwds: [input.cwd],
      forceReload: true,
    });
    const entries = listed.data.filter((entry) => entry.cwd === input.cwd);
    if (entries.length !== 1 || entries[0]!.errors.length > 0) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidParams(
        "Codex did not return one error-free catalog for the session cwd.",
      );
    }
    const discovered = entries[0]!.skills;
    if (
      input.managedSkills.some(
        (managed) =>
          !discovered.some(
            (skill) =>
              skill.name === managed.key && skill.path === managed.path && skill.enabled === true,
          ),
      )
    ) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidParams(
        "Codex did not discover every enabled T3-managed skill.",
      );
    }
    const managedKeys = new Set(input.managedSkills.map((skill) => skill.key));
    const managedPaths = new Set(input.managedSkills.map((skill) => skill.path));
    const nativePaths = [
      ...new Set(
        discovered.flatMap((skill) =>
          managedKeys.has(skill.name) && !managedPaths.has(skill.path) ? [skill.path] : [],
        ),
      ),
    ];

    return {
      ...input.thread,
      config: {
        ...config,
        skills: {
          ...skillSettings,
          config: [
            ...(skillConfig ?? []),
            ...nativePaths.map((path) => ({ path, enabled: false })),
          ],
        },
      },
    };
  },
);

/**
 * Exercises the pinned app-server's session-local managed-skill controls.
 * The caller owns the per-session app-server process and generated skill root.
 */
export const startCodexManagedSkillSession = Effect.fn("startCodexManagedSkillSession")(
  function* (input: {
    readonly client: CodexManagedSkillClient;
    readonly cwd: string;
    readonly extraRoot: string;
    readonly managedSkills: ReadonlyArray<{ readonly key: string; readonly path: string }>;
    readonly threadStart: CodexRpc.ClientRequestParamsByMethod["thread/start"];
  }) {
    const threadStart = yield* prepareCodexManagedSkillThread({
      client: input.client,
      cwd: input.cwd,
      extraRoot: input.extraRoot,
      managedSkills: input.managedSkills,
      thread: input.threadStart,
    });
    // Codex loads config into the session override layer, where later equal
    // path rules win and enabled:false excludes a path from this thread.
    // Codex 678157acaa819d5510adfe359abb5d0392cfe461 loads thread/start.config
    // into the session override layer, where later equal path rules win and
    // enabled:false excludes that path from the per-config skill snapshot:
    // https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/app-server/src/request_processors/thread_processor.rs#L950-L1035
    // https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/app-server/src/request_processors/thread_processor.rs#L1103-L1129
    // https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/app-server/src/config_manager.rs#L187-L244
    // https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/config/src/skills_config.rs#L12-L36
    // https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/core-skills/src/config_rules.rs#L30-L102
    // https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/core-skills/src/service.rs#L119-L230
    return yield* input.client.request("thread/start", threadStart);
  },
);
