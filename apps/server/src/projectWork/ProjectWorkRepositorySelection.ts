import type * as Path from "effect/Path";

import type { TaskFolderPlan } from "../workspace/TaskFolders.ts";

/**
 * The one repository a Work run works in. `repository` is absent for the project folder's own
 * repository, so a single-repository project binds exactly as before.
 */
export type WorkRepositorySelection =
  | { readonly _tag: "selected"; readonly repository?: string }
  | { readonly _tag: "refused"; readonly reason: "repository-required" | "repository-unavailable" };

/**
 * `plan` is the project's default task folder plan, null when it tracks no Git folder. A
 * project folder that is not a repository falls back to its only repository; with several, the
 * dispatch must name one, since review and delivery compare one repository's commits.
 */
export const selectWorkRepository = (
  path: Path.Path,
  input: {
    readonly projectRoot: string;
    readonly plan: Pick<TaskFolderPlan, "projectIsRepository" | "trackedRepositories"> | null;
    readonly requested: string | undefined;
  },
): WorkRepositorySelection => {
  const projectRoot = path.resolve(input.projectRoot);
  const projectIsRepository = input.plan?.projectIsRepository ?? true;
  const repositories = input.plan?.trackedRepositories ?? [];
  if (input.requested === undefined) {
    if (projectIsRepository) return { _tag: "selected" };
    const only = repositories.length === 1 ? repositories[0] : undefined;
    return only === undefined
      ? { _tag: "refused", reason: "repository-required" }
      : { _tag: "selected", repository: only };
  }
  if (!path.isAbsolute(input.requested))
    return { _tag: "refused", reason: "repository-unavailable" };
  const requested = path.resolve(input.requested);
  if (requested === projectRoot)
    return projectIsRepository
      ? { _tag: "selected" }
      : { _tag: "refused", reason: "repository-unavailable" };
  return repositories.includes(requested)
    ? { _tag: "selected", repository: requested }
    : { _tag: "refused", reason: "repository-unavailable" };
};
