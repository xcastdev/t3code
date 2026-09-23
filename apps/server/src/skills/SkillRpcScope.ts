import {
  type ProjectId,
  SkillRpcError,
  type ProviderInstanceId,
  type ThreadId,
  type SkillCatalogChanged,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";

export interface SkillScopeInput {
  readonly threadId?: ThreadId | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}

export interface SkillScopeProjection<E> {
  readonly getThreadShellById: (threadId: ThreadId) => Effect.Effect<
    Option.Option<{
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
      readonly session?: { readonly providerInstanceId?: ProviderInstanceId | undefined } | null;
    }>,
    E
  >;
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<{ readonly id: ProjectId; readonly workspaceRoot: string }>, E>;
}

export interface ResolvedSkillScope {
  readonly projectId?: ProjectId;
  readonly projectRoot?: string;
  readonly threadId?: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
}

export function skillChangeAffectsScope(
  scope: ResolvedSkillScope,
  change: SkillCatalogChanged,
): boolean {
  switch (change.scope) {
    case "global":
      return true;
    case "project":
      return scope.projectId === change.scopeId;
    case "session":
      return scope.threadId === change.scopeId;
    case "provider":
      return scope.providerInstanceId === undefined || scope.providerInstanceId === change.scopeId;
  }
}

/** Resolves opaque IDs against the server projection; no client path participates. */
export const resolveAuthoritativeSkillScope = Effect.fn("resolveAuthoritativeSkillScope")(
  function* <E>(projection: SkillScopeProjection<E>, input: SkillScopeInput) {
    const thread = input.threadId
      ? yield* projection.getThreadShellById(input.threadId)
      : Option.none();
    if (input.threadId && Option.isNone(thread)) {
      return yield* new SkillRpcError({
        code: "thread_not_found",
        message: "The requested thread was not found.",
      });
    }
    if (
      Option.isSome(thread) &&
      input.projectId !== undefined &&
      thread.value.projectId !== input.projectId
    ) {
      return yield* new SkillRpcError({
        code: "scope_mismatch",
        message: "The thread does not belong to the requested project.",
      });
    }
    if (
      Option.isSome(thread) &&
      input.providerInstanceId !== undefined &&
      thread.value.session?.providerInstanceId !== undefined &&
      thread.value.session.providerInstanceId !== input.providerInstanceId
    ) {
      return yield* new SkillRpcError({
        code: "scope_mismatch",
        message: "The provider does not match the thread's authoritative session.",
      });
    }
    const projectId = Option.isSome(thread) ? thread.value.projectId : input.projectId;
    if (projectId === undefined) return { ...input } as ResolvedSkillScope;

    const project = yield* projection.getProjectShellById(projectId);
    if (Option.isNone(project)) {
      return yield* new SkillRpcError({
        code: "project_not_found",
        message: "The requested project was not found.",
      });
    }
    const projectRoot = Option.isSome(thread)
      ? resolveThreadWorkspaceCwd({ thread: thread.value, projects: [project.value] })
      : project.value.workspaceRoot;
    if (projectRoot === undefined) {
      return yield* new SkillRpcError({
        code: "workspace_unavailable",
        message: "The authoritative project workspace is unavailable.",
      });
    }
    return { ...input, projectId, projectRoot } as ResolvedSkillScope;
  },
);
