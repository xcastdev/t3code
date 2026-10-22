import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTerminalService from "../terminal/ProjectTerminalService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Access from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as Handlers from "./toolkits/terminal/handlers.ts";
import { TerminalToolkit } from "./toolkits/terminal/tools.ts";

const threadId = ThreadId.make("thread:terminal-tools");
const projectId = ProjectId.make("project:mcp-test");
const handle = { projectId, terminalId: "owned-terminal" };

const harness = (
  options: {
    readonly runtimeMode?: "full-access" | "approval-required";
    readonly idle?: boolean;
    readonly client?: boolean;
    readonly capability?: boolean;
  } = {},
) => {
  const calls: Array<string> = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(Invocation.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment:test"),
      issuedAt: 0,
      requestNamespace: "terminal-tests",
      capabilities: new Set(options.capability === false ? [] : ["terminal" as const]),
      thread: options.client
        ? undefined
        : {
            threadId,
            providerSessionId: "session:terminal-tools",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
      client: options.client
        ? { sessionId: "client:test", label: "test", access: "read-only" }
        : undefined,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          liveThreadShell(id, {
            ...(options.runtimeMode === undefined ? {} : { runtimeMode: options.runtimeMode }),
            ...(options.idle ? { activeRunId: null } : {}),
          }),
        ),
    }),
    Layer.mock(ProjectTerminalService.ProjectTerminalService)({
      list: () =>
        Effect.sync(() => {
          calls.push("list");
          return { terminals: [], nextCursor: null };
        }),
      write: () =>
        Effect.sync(() => {
          calls.push("write");
        }),
      kill: () =>
        Effect.sync(() => {
          calls.push("kill");
          return { ...handle, generation: "generation:test", status: "unknown" as const };
        }),
    }),
  );
  return { dependencies, calls };
};

it.effect("native PTY writes cannot escape a provider's approval-required sandbox", () =>
  Effect.gen(function* () {
    const { dependencies, calls } = harness({ runtimeMode: "approval-required" });
    const toolkit = yield* TerminalToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const result = yield* toolkit
      .handle("terminal_write", { ...handle, data: "touch owned-file\r" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
    expect(calls).toEqual([]);
    const listed = yield* toolkit
      .handle("terminal_list", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(listed.at(-1)?.result).toMatchObject({ terminals: [] });
    expect(calls).toEqual(["list"]);
  }),
);

it.effect("old provider credentials cannot read or control terminals after their run ends", () =>
  Effect.gen(function* () {
    const { dependencies, calls } = harness({ idle: true });
    const toolkit = yield* TerminalToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const result = yield* toolkit
      .handle("terminal_list", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
    expect(calls).toEqual([]);
  }),
);

it.effect("external read-only clients cannot claim a terminal caller thread", () =>
  Effect.gen(function* () {
    const { dependencies, calls } = harness({ client: true });
    const toolkit = yield* TerminalToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const result = yield* toolkit
      .handle("terminal_write", { ...handle, data: "x" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({ code: "thread_credential_required" });
    expect(calls).toEqual([]);
  }),
);

it.effect("terminal capability is checked before calling the service", () =>
  Effect.gen(function* () {
    const { dependencies, calls } = harness({ capability: false });
    const toolkit = yield* TerminalToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const result = yield* toolkit
      .handle("terminal_list", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({ _tag: "McpCapabilityUnavailableError" });
    expect(calls).toEqual([]);
  }),
);

it.effect("an uncertain stop stays uncertain in the actual MCP response", () =>
  Effect.gen(function* () {
    const { dependencies, calls } = harness();
    const toolkit = yield* TerminalToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const result = yield* toolkit
      .handle("terminal_kill", handle)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toEqual({
      ...handle,
      generation: "generation:test",
      status: "unknown",
    });
    expect(calls).toEqual(["kill"]);
  }),
);
