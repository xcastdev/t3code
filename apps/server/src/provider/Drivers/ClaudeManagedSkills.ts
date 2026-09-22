import type { Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

const MANAGED_PLUGIN_NAME = "t3-managed";

export const ClaudeManagedSkillPlanPayload = Schema.Struct({
  kind: Schema.Literal("claude-managed-skills"),
  pluginPath: Schema.String,
  collidingNativeKeys: Schema.Array(Schema.String),
  skillKeys: Schema.Array(Schema.String),
});
export type ClaudeManagedSkillPlanPayload = typeof ClaudeManagedSkillPlanPayload.Type;
export const isClaudeManagedSkillPlanPayload = Schema.is(ClaudeManagedSkillPlanPayload);

/** Session-only SDK options used by the managed-skills delivery proof. */
export function buildClaudeManagedSkillSessionOptions(input: {
  readonly pluginPath: string;
  readonly collidingNativeKeys: ReadonlyArray<string>;
}): {
  readonly plugins: NonNullable<ClaudeQueryOptions["plugins"]>;
  readonly settings: { readonly skillOverrides: Readonly<Record<string, "off">> };
} {
  return {
    plugins: [{ type: "local", path: input.pluginPath }],
    settings: {
      skillOverrides: Object.fromEntries(
        input.collidingNativeKeys.map((key) => [key, "off"] as const),
      ),
    },
  };
}

/** Maps portable composer keys to the plugin-qualified identities Claude invokes. */
export function managedClaudeSkillInvocationNames(
  keys: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  return new Map(keys.map((key) => [key, `${MANAGED_PLUGIN_NAME}:${key}`]));
}
