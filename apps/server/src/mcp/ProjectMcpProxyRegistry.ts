import type { ResolvedMcpCatalogEntry } from "@t3tools/contracts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { makeProjectMcpTransport } from "./ProjectMcpTransport.ts";
import { connectProjectMcp } from "./ProjectMcpConnection.ts";
import * as Secrets from "./ProjectMcpSecretStore.ts";
import * as OAuth from "./ProjectMcpOAuth.ts";

export class ProjectMcpConnectionError extends Error {
  readonly _tag = "ProjectMcpConnectionError";
  constructor() {
    super("MCP upstream connection failed.");
  }
}

export interface ProjectMcpConnection {
  readonly entry: ResolvedMcpCatalogEntry;
  readonly client: Client;
}
export class ProjectMcpProxyRegistry extends Context.Service<
  ProjectMcpProxyRegistry,
  {
    readonly connect: (
      entry: ResolvedMcpCatalogEntry,
    ) => Effect.Effect<ProjectMcpConnection, ProjectMcpConnectionError, Scope.Scope>;
  }
>()("t3/mcp/ProjectMcpProxyRegistry") {}
const make = Effect.gen(function* () {
  const secrets = yield* Secrets.ProjectMcpSecretStore;
  const oauth = yield* OAuth.ProjectMcpOAuth;
  return ProjectMcpProxyRegistry.of({
    connect: Effect.fn("ProjectMcpProxyRegistry.connect")(
      function* (entry) {
        const owner = Secrets.credentialOwnerIdForDefinition(
          entry.logicalServerId,
          entry.transportDefinitionId,
        );
        const lease = yield* secrets.acquireLease(
          owner,
          Secrets.credentialIdsForTransport(entry.transport),
        );
        const resolved = new Map<string, string>();
        for (const ref of Secrets.credentialIdsForTransport(entry.transport))
          resolved.set(ref, yield* lease.resolve(ref));
        const binding = yield* OAuth.resolveServerBinding(
          { id: owner, transport: entry.transport },
          (_id, ref) => lease.resolve(ref),
        );
        const provider =
          binding === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                yield* secrets.ensureOAuthStateOwner(owner);
                const state = yield* secrets.acquireOAuthStateLease(owner);
                return yield* oauth.providerFor(owner, binding, state);
              });
        const client = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              connectProjectMcp(
                makeProjectMcpTransport({
                  serverId: owner,
                  transport: entry.transport,
                  resolveSecret: (ref) => resolved.get(ref),
                  ...(provider ? { oauthProvider: provider } : {}),
                }),
              ),
            catch: () => new ProjectMcpConnectionError(),
          }),
          (value) =>
            Effect.promise(() => value.close().catch(() => undefined)).pipe(
              Effect.interruptible,
              Effect.timeoutOption("5 seconds"),
            ),
        );
        return { entry, client };
      },
      Effect.mapError(() => new ProjectMcpConnectionError()),
    ),
  });
});
export const layer = Layer.effect(ProjectMcpProxyRegistry, make);
