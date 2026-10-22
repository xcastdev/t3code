import { useAtomMount } from "@effect/atom-react";
import { createManagedTextResourcesEnvironmentAtoms } from "@t3tools/client-runtime/state/managedTextResources";
import { createMcpCatalogEnvironmentAtoms } from "@t3tools/client-runtime/state/mcp-catalog";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { createSkillsEnvironmentAtoms } from "@t3tools/client-runtime/state/skills";
import {
  WS_METHODS,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const skillsEnvironment = createSkillsEnvironmentAtoms(connectionAtomRuntime);
export const managedTextEnvironment =
  createManagedTextResourcesEnvironmentAtoms(connectionAtomRuntime);
export const mcpCatalogEnvironment = createMcpCatalogEnvironmentAtoms(connectionAtomRuntime);

export const issueSearchEnvironment = {
  search: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:issues:search",
    tag: WS_METHODS.issuesSearch,
    idleTtlMs: 60_000,
  }),
};

export interface ResourceTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
}

const NO_SUBSCRIPTION = Atom.make(null).pipe(Atom.withLabel("web-resource-subscription:none"));

const catalogInput = (target: ResourceTarget) => ({
  ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
  ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
});

/**
 * Keeps the skill and managed text change streams open for one destination
 * while a view is mounted. Their shared signals refresh the catalogs, so views
 * never poll or invalidate on their own.
 */
export function useResourceCatalogSubscriptions(target: ResourceTarget | null) {
  useAtomMount(
    target === null
      ? NO_SUBSCRIPTION
      : skillsEnvironment.changes({
          environmentId: target.environmentId,
          input: catalogInput(target),
        }),
  );
  useAtomMount(
    target === null
      ? NO_SUBSCRIPTION
      : managedTextEnvironment.changes({
          environmentId: target.environmentId,
          input: catalogInput(target),
        }),
  );
}

/**
 * The one change stream an open composer menu reads from, released when the
 * menu closes. Skill catalogs are provider-specific, so switching the provider
 * follows the new provider's stream.
 */
export function useComposerResourceSubscriptions(
  request: {
    readonly target: ResourceTarget;
    readonly kind: "skills" | "text";
    readonly providerInstanceId?: ProviderInstanceId;
  } | null,
) {
  useAtomMount(
    request?.kind === "skills"
      ? skillsEnvironment.changes({
          environmentId: request.target.environmentId,
          input: {
            ...catalogInput(request.target),
            ...(request.providerInstanceId === undefined
              ? {}
              : { providerInstanceId: request.providerInstanceId }),
          },
        })
      : NO_SUBSCRIPTION,
  );
  useAtomMount(
    request?.kind === "text"
      ? managedTextEnvironment.changes({
          environmentId: request.target.environmentId,
          input: catalogInput(request.target),
        })
      : NO_SUBSCRIPTION,
  );
}

export { catalogInput as resourceCatalogInput };
