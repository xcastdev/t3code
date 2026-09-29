import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { ScopedSettingsTarget } from "../../components/settings/scopedSettings";
import type { ResolvedSettingsScope } from "../../components/settings/settingsScope";

type ResourceScopeTarget = Pick<ScopedSettingsTarget, "environmentId" | "label" | "projectId">;

interface ResourceEnvironmentSnapshot {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: string };
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: {
        readonly globalMcpCatalog?: boolean | undefined;
        readonly projectMcpCatalog?: boolean | undefined;
        readonly projectMcpOverrides?: boolean | undefined;
      };
    };
  } | null;
}

export type ResourceScopeResolution =
  | {
      readonly kind: "ready";
      readonly environment: ResourceEnvironmentSnapshot;
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId | null;
      readonly target: ResourceScopeTarget;
      readonly mcpMode: "global" | "scoped" | "legacy" | "unsupported";
    }
  | { readonly kind: "ambiguous"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

/** Resolve one physical inventory target before any catalog query is constructed. */
export function resolveResourceScope(input: {
  readonly scope: ResolvedSettingsScope;
  readonly environments: readonly ResourceEnvironmentSnapshot[];
  readonly targets: readonly ResourceScopeTarget[];
}): ResourceScopeResolution {
  const { scope, environments, targets } = input;
  if (scope.kind === "unavailable") return { kind: "unavailable", message: scope.message };
  if (scope.kind === "all") {
    return {
      kind: "ambiguous",
      message: "Select one environment or project checkout to view its resources.",
    };
  }

  let environmentId: EnvironmentId;
  let projectId: ProjectId | null;
  if (scope.kind === "environment") {
    environmentId = scope.environmentId;
    projectId = null;
  } else {
    if (scope.members.length !== 1) {
      return {
        kind: "ambiguous",
        message:
          "Select one checkout to view project resources. This project has multiple checkouts in the current scope.",
      };
    }
    environmentId = scope.members[0]!.environmentId;
    projectId = scope.members[0]!.id;
  }

  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  if (!environment) {
    return { kind: "unavailable", message: "The selected environment is no longer available." };
  }
  if (environment.connection.phase !== "connected" || environment.serverConfig === null) {
    return {
      kind: "unavailable",
      message: `Reconnect ${environment.label} to view its resources.`,
    };
  }

  const target = targets.find(
    (candidate) => candidate.environmentId === environmentId && candidate.projectId === projectId,
  );
  if (!target) {
    return { kind: "unavailable", message: "The selected checkout is no longer available." };
  }

  const capabilities = environment.serverConfig.environment.capabilities;
  const mcpMode =
    projectId === null
      ? capabilities.globalMcpCatalog === true
        ? "global"
        : "unsupported"
      : capabilities.projectMcpOverrides === true
        ? "scoped"
        : capabilities.projectMcpCatalog === true
          ? "legacy"
          : "unsupported";
  return { kind: "ready", environment, environmentId, projectId, target, mcpMode };
}
