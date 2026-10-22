import {
  WS_METHODS,
  type EnvironmentId,
  type McpCatalogScope,
  type McpCatalogSessionForThreadInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { subscribe } from "../rpc/client.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export interface McpCatalogTarget {
  readonly environmentId: EnvironmentId;
  readonly scope: McpCatalogScope;
  readonly scopeId: string;
}

export const mcpCatalogScopeKey = (target: McpCatalogTarget): string =>
  JSON.stringify([target.environmentId, target.scope, target.scopeId]);

/** An editor can only submit the revision it loaded for its current destination. */
export const isCurrentMcpCatalogDraft = (
  current: McpCatalogTarget & { readonly revision: number },
  draft: McpCatalogTarget & { readonly revision: number },
): boolean =>
  mcpCatalogScopeKey(current) === mcpCatalogScopeKey(draft) && current.revision === draft.revision;

export function createMcpCatalogEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const signals = Atom.family((key: string) =>
    Atom.make(0).pipe(Atom.withLabel(`mcp-catalog:${key}`)),
  );
  const streamedRevisions = new WeakMap<
    AtomRegistry.AtomRegistry,
    WeakMap<Atom.Atom<number>, number>
  >();
  const sessionForThread = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:mcp-catalog:thread-session",
    subscribe: (input: McpCatalogSessionForThreadInput) =>
      subscribe(WS_METHODS.mcpCatalogSessionSubscribeForThread, input),
    onValue: ({ environmentId }, { snapshot }, registry) =>
      Effect.sync(() => {
        if (snapshot === null) return;
        // The live stream is independent of this signal: refreshing editor reads
        // must not reconnect the subscription that delivered the snapshot.
        const signal = signals(
          mcpCatalogScopeKey({
            environmentId,
            scope: "session",
            scopeId: snapshot.catalogSessionId,
          }),
        );
        let revisions = streamedRevisions.get(registry);
        if (revisions === undefined) {
          revisions = new WeakMap();
          streamedRevisions.set(registry, revisions);
        }
        if (revisions.get(signal) === snapshot.desiredRevision) return;
        revisions.set(signal, snapshot.desiredRevision);
        registry.update(signal, (n) => n + 1);
      }),
    idleTtlMs: 0,
  });
  const oauthChanges = Atom.make(0);
  return {
    sessionForThread,
    oauthStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-catalog:oauth-status",
      tag: WS_METHODS.mcpCatalogOAuthStatus,
      refreshTrigger: () => oauthChanges,
    }),
    secretPrepare: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:secret-prepare",
      tag: WS_METHODS.mcpCatalogSecretPrepare,
    }),
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-catalog:read",
      tag: WS_METHODS.mcpCatalogRead,
      refreshTrigger: ({ environmentId, input }) =>
        signals(mcpCatalogScopeKey({ environmentId, ...input })),
    }),
    sessionGet: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-catalog:session",
      tag: WS_METHODS.mcpCatalogSessionGet,
      refreshTrigger: ({ environmentId, input }) =>
        signals(
          mcpCatalogScopeKey({
            environmentId,
            scope: "session",
            scopeId: input.mcpCatalogSessionId,
          }),
        ),
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:write",
      tag: WS_METHODS.mcpCatalogWrite,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => mcpCatalogScopeKey({ environmentId, ...input }),
      },
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.update(signals(mcpCatalogScopeKey({ environmentId, ...input })), (n) => n + 1);
        }),
    }),
    sessionReset: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:reset",
      tag: WS_METHODS.mcpCatalogSessionReset,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.update(
            signals(
              mcpCatalogScopeKey({
                environmentId,
                scope: "session",
                scopeId: input.mcpCatalogSessionId,
              }),
            ),
            (n) => n + 1,
          );
        }),
    }),
    oauthBegin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:oauth-begin",
      tag: WS_METHODS.mcpCatalogOAuthBegin,
      onSuccess: (_input, registry) =>
        Effect.sync(() => registry.update(oauthChanges, (n) => n + 1)),
    }),
    oauthContinue: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:oauth-continue",
      tag: WS_METHODS.mcpCatalogOAuthContinue,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.update(oauthChanges, (n) => n + 1);
          if (input.threadId !== undefined)
            registry.refresh(
              sessionForThread({ environmentId, input: { threadId: input.threadId } }),
            );
        }),
    }),
    oauthDisconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-catalog:oauth-disconnect",
      tag: WS_METHODS.mcpCatalogOAuthDisconnect,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.update(oauthChanges, (n) => n + 1);
          if (input.threadId !== undefined)
            registry.refresh(
              sessionForThread({ environmentId, input: { threadId: input.threadId } }),
            );
        }),
    }),
  };
}
