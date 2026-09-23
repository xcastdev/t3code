import {
  type ManagedTextResourceChanged,
  type ManagedTextResourceCatalogListInput,
  type ManagedTextResourceRpcError,
  ManagedTextResourceRpcError as ManagedTextResourceRpcErrorSchema,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";

export interface ManagedTextResourceScopeInput {
  readonly threadId?: ThreadId | undefined;
  readonly projectId?: ProjectId | undefined;
}

export interface ManagedTextResourceScopeProjection<E> {
  readonly getThreadShellById: (threadId: ThreadId) => Effect.Effect<
    Option.Option<{
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
    }>,
    E
  >;
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<{ readonly id: ProjectId; readonly workspaceRoot: string }>, E>;
}

export interface ResolvedManagedTextResourceScope {
  readonly projectId?: ProjectId;
  readonly projectRoot?: string;
  readonly threadId?: ThreadId;
}

const rpcError = (code: ManagedTextResourceRpcError["code"], message: string) =>
  new ManagedTextResourceRpcErrorSchema({ code, message });

/** Resolve project and thread identifiers against this server's projection. */
export const resolveAuthoritativeManagedTextResourceScope = Effect.fn(
  "resolveAuthoritativeManagedTextResourceScope",
)(function* <E>(
  projection: ManagedTextResourceScopeProjection<E>,
  input: ManagedTextResourceScopeInput,
) {
  const thread = input.threadId
    ? yield* projection.getThreadShellById(input.threadId)
    : Option.none();
  if (input.threadId !== undefined && Option.isNone(thread)) {
    return yield* rpcError("not-found", "The requested thread was not found.");
  }
  if (
    Option.isSome(thread) &&
    input.projectId !== undefined &&
    thread.value.projectId !== input.projectId
  ) {
    return yield* rpcError(
      "invalid-override",
      "The thread does not belong to the requested project.",
    );
  }

  const projectId = Option.isSome(thread) ? thread.value.projectId : input.projectId;
  if (projectId === undefined) return { ...input } as ResolvedManagedTextResourceScope;

  const project = yield* projection.getProjectShellById(projectId);
  if (Option.isNone(project)) {
    return yield* rpcError("not-found", "The requested project was not found in this environment.");
  }
  const projectRoot = Option.isSome(thread)
    ? resolveThreadWorkspaceCwd({ thread: thread.value, projects: [project.value] })
    : project.value.workspaceRoot;
  if (projectRoot === undefined) {
    return yield* rpcError(
      "invalid-override",
      "The authoritative project workspace is unavailable.",
    );
  }
  return {
    ...input,
    projectId,
    projectRoot,
  } as ResolvedManagedTextResourceScope;
});

export function managedTextResourceChangeAffectsScope(
  scope: ResolvedManagedTextResourceScope,
  change: ManagedTextResourceChanged,
): boolean {
  switch (change.scope) {
    case "environment":
      return true;
    case "project":
      return scope.projectId !== undefined && scope.projectId === change.scopeId;
    case "thread":
      return scope.threadId !== undefined && scope.threadId === change.scopeId;
  }
}

export const managedTextResourceListScope = (
  input: ManagedTextResourceCatalogListInput,
  resolved: ResolvedManagedTextResourceScope,
) => ({
  ...resolved,
  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
});
