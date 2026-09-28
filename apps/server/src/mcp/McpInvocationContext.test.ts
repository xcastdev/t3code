import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports the scoped credential context when preview capability is unavailable", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
    expect(error.message).toBe("MCP credential does not grant the preview capability.");
  });
});

it.effect("reports other missing capabilities with the neutral error", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["preview"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("pull-requests").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({ capability: "pull-requests", threadId: invocation.threadId });

    const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
    expect(scope).toBe(invocation);
  });
});

it.effect("allows terminal calls while browser preview remains unavailable", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-terminal-only"),
    providerSessionId: "provider-session-terminal-only",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["terminal"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const terminalScope = yield* McpInvocationContext.requireMcpCapability("terminal").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
    const previewError = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(terminalScope).toBe(invocation);
    expect(previewError).toBeInstanceOf(PreviewAutomationUnavailableError);
  });
});

it("binds project-work attribution to provider and thread, not a renewed session", () => {
  const base: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-stable"),
    providerSessionId: "session-first",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["project"]),
    issuedAt: 1,
  };
  const renewed = {
    ...base,
    providerSessionId: "session-renewed",
    identity: { kind: "agent" as const, id: "legacy-session-bound-id" },
  };
  expect(McpInvocationContext.projectWorkActorForInvocation(base)).toEqual(
    McpInvocationContext.projectWorkActorForInvocation(renewed),
  );
  const firstSource = McpInvocationContext.projectWorkSourceForInvocation(base);
  const renewedSource = McpInvocationContext.projectWorkSourceForInvocation(renewed);
  expect(firstSource.id).toBe(renewedSource.id);
  expect(firstSource.uri).not.toBe(renewedSource.uri);
  expect(firstSource.uri).toContain("session-first");
  expect(renewedSource.uri).toContain("session-renewed");
});
