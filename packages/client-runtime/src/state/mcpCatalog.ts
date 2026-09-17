import { WS_METHODS, type EnvironmentId, type McpCatalogSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { AtomCommandConcurrency } from "./runtime.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import { Atom } from "effect/unstable/reactivity";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";

const catalogInvalidationAtom = Atom.family((key: string) =>
  Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`mcp-catalog-invalidation:${key}`)),
);

const globalRefresh = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly scopeId: string };
}) =>
  catalogInvalidationAtom(
    mcpCatalogScopeKey({
      environmentId: target.environmentId,
      scope: "global",
      scopeId: target.input.scopeId,
    }),
  );
const projectRefresh = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly scopeId: string };
}) =>
  catalogInvalidationAtom(
    mcpCatalogScopeKey({
      environmentId: target.environmentId,
      scope: "project",
      scopeId: target.input.scopeId,
    }),
  );
const sessionRefresh = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly mcpCatalogSessionId: string };
}) =>
  catalogInvalidationAtom(
    mcpCatalogScopeKey({
      environmentId: target.environmentId,
      scope: "session",
      scopeId: target.input.mcpCatalogSessionId,
    }),
  );

/** Stable scope key used to serialize catalog mutations without blocking other scopes. */
export const mcpCatalogScopeKey = (input: {
  readonly environmentId: EnvironmentId;
  readonly scope: string;
  readonly scopeId: string;
}): string => `${input.environmentId}:${input.scope}:${input.scopeId}`;

const scheduler = createAtomCommandScheduler();
const serialScope: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: unknown;
}> = {
  mode: "serial",
  key: (value) => {
    const input = value.input as Record<string, unknown>;
    const scope =
      typeof input.scope === "string"
        ? input.scope
        : input.mcpCatalogSessionId !== undefined
          ? "session"
          : "oauth";
    const scopeId =
      typeof input.scopeId === "string"
        ? input.scopeId
        : String(input.mcpCatalogSessionId ?? input.projectId ?? "global");
    return mcpCatalogScopeKey({ environmentId: value.environmentId, scope, scopeId });
  },
};

/**
 * RPC-backed atoms for the global, project, and logical-session MCP catalogs.
 * All writes for one scope are queued in arrival order; unrelated projects and
 * environments remain independent. The catalog subscription is intentionally
 * exposed alongside queries so surfaces can refresh on cross-device changes.
 */
export function createMcpCatalogEnvironmentAtoms<R, E>(
  runtime: import("effect/unstable/reactivity").Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    globalList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-catalog:global-list",
      tag: WS_METHODS.mcpCatalogGlobalList,
      refreshTrigger: globalRefresh,
    }),
    globalState: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-catalog:global-state",
      tag: WS_METHODS.mcpCatalogGlobalStateList,
      refreshTrigger: globalRefresh,
    }),
    projectList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-catalog:project-list",
      tag: WS_METHODS.mcpCatalogProjectList,
      refreshTrigger: projectRefresh,
    }),
    projectState: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-catalog:project-state",
      tag: WS_METHODS.mcpCatalogProjectStateList,
      refreshTrigger: projectRefresh,
    }),
    sessionGet: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-catalog:session-get",
      tag: WS_METHODS.mcpCatalogSessionGet,
      refreshTrigger: sessionRefresh,
    }),
    globalCreate: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:global-create",
      tag: WS_METHODS.mcpCatalogGlobalCreate,
      scheduler,
      concurrency: serialScope,
    }),
    globalUpdate: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:global-update",
      tag: WS_METHODS.mcpCatalogGlobalUpdate,
      scheduler,
      concurrency: serialScope,
    }),
    globalRemove: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:global-remove",
      tag: WS_METHODS.mcpCatalogGlobalRemove,
      scheduler,
      concurrency: serialScope,
    }),
    projectCreate: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:project-create",
      tag: WS_METHODS.mcpCatalogProjectCreate,
      scheduler,
      concurrency: serialScope,
    }),
    projectUpdate: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:project-update",
      tag: WS_METHODS.mcpCatalogProjectUpdate,
      scheduler,
      concurrency: serialScope,
    }),
    projectRemove: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:project-remove",
      tag: WS_METHODS.mcpCatalogProjectRemove,
      scheduler,
      concurrency: serialScope,
    }),
    projectOverride: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:project-override",
      tag: WS_METHODS.mcpCatalogProjectOverride,
      scheduler,
      concurrency: serialScope,
    }),
    projectDeleteOverride: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:project-delete-override",
      tag: WS_METHODS.mcpCatalogProjectDeleteOverride,
      scheduler,
      concurrency: serialScope,
    }),
    sessionCreate: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:session-create",
      tag: WS_METHODS.mcpCatalogSessionCreate,
      scheduler,
      concurrency: serialScope,
    }),
    sessionUpdate: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:session-update",
      tag: WS_METHODS.mcpCatalogSessionUpdate,
      scheduler,
      concurrency: serialScope,
    }),
    sessionRemove: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:session-remove",
      tag: WS_METHODS.mcpCatalogSessionRemove,
      scheduler,
      concurrency: serialScope,
    }),
    sessionReset: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:session-reset",
      tag: WS_METHODS.mcpCatalogSessionReset,
      scheduler,
      concurrency: serialScope,
    }),
    oauthBegin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:oauth-begin",
      tag: WS_METHODS.mcpCatalogOAuthBegin,
      scheduler,
      concurrency: serialScope,
    }),
    oauthContinue: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:oauth-continue",
      tag: WS_METHODS.mcpCatalogOAuthContinue,
      scheduler,
      concurrency: serialScope,
    }),
    oauthDisconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:oauth-disconnect",
      tag: WS_METHODS.mcpCatalogOAuthDisconnect,
      scheduler,
      concurrency: serialScope,
    }),
    changes: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:mcp-catalog:changes",
      idleTtlMs: 5 * 60_000,
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.mcpCatalogSubscribe>) =>
        subscribe(WS_METHODS.mcpCatalogSubscribe, input),
      onValue: (target, value, registry) =>
        Effect.sync(() => {
          registry.update(
            catalogInvalidationAtom(
              mcpCatalogScopeKey({
                environmentId: target.environmentId,
                scope: value.scope,
                scopeId: value.scopeId,
              }),
            ),
            (revision) => revision + 1,
          );
        }),
    }),
  };
}

/** A helper for callers that need to form a session query without string casts. */
export const mcpCatalogSessionTarget = (
  environmentId: EnvironmentId,
  threadId: string,
  mcpCatalogSessionId: McpCatalogSessionId,
) => ({ environmentId, input: { threadId, mcpCatalogSessionId } });
