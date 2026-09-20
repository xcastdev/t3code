import {
  type EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "device" | "pull-requests" | "project";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  /** Stable agent identity; old test and plugin scopes may omit this field. */
  readonly identity?: {
    readonly kind: "agent";
    readonly id: string;
    readonly displayName?: string;
  };
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/** The error a missing capability surfaces as; preview keeps its own so the broker can route it. */
export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    threadId: invocation.threadId,
    providerSessionId: invocation.providerSessionId,
    providerInstanceId: invocation.providerInstanceId,
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  Effect.flatMap(McpInvocationContext, (invocation) =>
    invocation.capabilities.has(capability)
      ? Effect.succeed(invocation)
      : // The conditional type narrows what the literal argument decided at runtime.
        Effect.fail(missingCapability(invocation, capability) as McpCapabilityError<C>),
  ).pipe(Effect.withSpan("mcp.requireCapability"));

export const projectWorkActorForInvocation = (
  invocation: McpInvocationScope,
): { readonly kind: "agent"; readonly id: string; readonly displayName?: string } => ({
  kind: "agent",
  // Provider sessions are renewable credentials. Bind durable project-work
  // attribution to the provider/thread pair so reconnects remain the same
  // agent and command retries can still deduplicate.
  id: `agent:mcp:${invocation.providerInstanceId}:${invocation.threadId}`,
  ...(invocation.identity?.displayName === undefined
    ? {}
    : { displayName: invocation.identity.displayName }),
});

/** Stable source identity plus session-only provenance for audit navigation. */
export const projectWorkSourceForInvocation = (
  invocation: McpInvocationScope,
): {
  readonly kind: "mcp";
  readonly id: string;
  readonly uri: string;
} => ({
  kind: "mcp",
  id: `mcp:${invocation.providerInstanceId}:${invocation.threadId}`,
  uri: `mcp://provider/${encodeURIComponent(String(invocation.providerInstanceId))}/${encodeURIComponent(String(invocation.threadId))}?session=${encodeURIComponent(invocation.providerSessionId)}`,
});
