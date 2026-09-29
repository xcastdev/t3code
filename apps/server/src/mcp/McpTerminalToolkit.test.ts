import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TerminalToolError,
  ThreadId,
  type TerminalReadInput,
  type TerminalReadResult,
  type ProjectTerminalSummary,
  type ProjectTerminalCreateInput,
  type ProjectTerminalDockSummary,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectTerminalService from "../terminal/ProjectTerminalService.ts";
import * as ProjectTerminalCompletionService from "../terminal/ProjectTerminalCompletionService.ts";

const projectId = ProjectId.make("project-mcp-terminal-test");
const threadId = ThreadId.make("thread-mcp-terminal-test");
const environmentId = EnvironmentId.make("environment-mcp-terminal-test");
const now = "2026-09-28T00:00:00.000Z";
const fakeMcpEndpointServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["terminal"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-terminal-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-terminal-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-terminal-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const makeHarness = () => {
  const terminals = new Map<string, ProjectTerminalSummary>();
  const outputs = new Map<string, string>();
  const createInputs: Array<ProjectTerminalCreateInput> = [];
  const writes: Array<{ terminalId: string; data: string }> = [];
  const resizes: Array<{ terminalId: string; cols: number; rows: number }> = [];
  const kills: Array<{ projectId: string; terminalId: string; cleanup: boolean }> = [];
  const completionSubscriptions: Array<{
    readonly projectId: ProjectId;
    readonly terminalId: string;
    readonly threadId: ThreadId;
    readonly mode: "notice" | "noticeAndWake";
  }> = [];
  const completionUnsubscriptions: Array<{
    readonly projectId: ProjectId;
    readonly terminalId: string;
    readonly threadId: ThreadId;
  }> = [];

  const unavailable = (operation: "write" | "resize" | "kill", terminalId: string) =>
    new TerminalToolError({ operation, reason: "unavailable", projectId, terminalId });

  const manager = {
    createProject: (input: ProjectTerminalCreateInput) =>
      Effect.sync(() => {
        createInputs.push(input);
        const terminal: ProjectTerminalSummary = {
          projectId: input.projectId,
          terminalId: input.terminalId,
          title: input.title ?? null,
          command: input.command ?? null,
          args: input.args ?? [],
          cwd: input.cwd,
          creatingThreadId: input.creatingThreadId,
          label: input.title ?? input.command ?? "Terminal",
          status: "running",
          pid: 8123,
          exitCode: null,
          exitSignal: null,
          updatedAt: now,
        };
        terminals.set(terminal.terminalId, terminal);
        outputs.set(terminal.terminalId, "retained PTY output\r\n");
        return terminal;
      }),
    listProject: (id: string) =>
      Effect.succeed([...terminals.values()].filter((terminal) => terminal.projectId === id)),
    getProjectCompletionSnapshot: (input: {
      readonly projectId: ProjectId;
      readonly terminalId: string;
    }) => {
      const terminal = terminals.get(input.terminalId);
      if (!terminal || terminal.projectId !== input.projectId) return Effect.succeed(null);
      const dockTerminal: ProjectTerminalDockSummary = {
        projectId: terminal.projectId,
        terminalId: terminal.terminalId,
        creatingThreadId: terminal.creatingThreadId,
        label: terminal.label,
        status: terminal.status,
        cols: 96,
        rows: 32,
        exitCode: terminal.exitCode,
        exitSignal: terminal.exitSignal,
        updatedAt: terminal.updatedAt,
      };
      return Effect.succeed({ generation: "generation-1", terminal: dockTerminal });
    },
    readProject: (input: TerminalReadInput) => {
      const terminal = terminals.get(input.terminalId);
      return terminal
        ? Effect.succeed({
            kind: "stream",
            terminal,
            output: outputs.get(input.terminalId) ?? "",
            nextCursor: "cursor-next",
            hasMore: false,
            truncated: false,
          } satisfies TerminalReadResult)
        : Effect.fail(
            new TerminalToolError({
              operation: "read",
              reason: "unavailable",
              projectId: input.projectId,
              terminalId: input.terminalId,
            }),
          );
    },
    writeProject: (input: { terminalId: string; data: string }) =>
      terminals.has(input.terminalId)
        ? Effect.sync(() => {
            writes.push({ terminalId: input.terminalId, data: input.data });
          })
        : Effect.fail(unavailable("write", input.terminalId)),
    resizeProject: (input: { terminalId: string; cols: number; rows: number }) =>
      terminals.has(input.terminalId)
        ? Effect.sync(() => {
            resizes.push({ terminalId: input.terminalId, cols: input.cols, rows: input.rows });
          })
        : Effect.fail(unavailable("resize", input.terminalId)),
    killProjectTerminal: (input: { projectId: string; terminalId: string; cleanup: boolean }) =>
      terminals.has(input.terminalId)
        ? Effect.sync(() => {
            kills.push(input);
            if (input.cleanup) {
              terminals.delete(input.terminalId);
              outputs.delete(input.terminalId);
            } else {
              const terminal = terminals.get(input.terminalId)!;
              terminals.set(input.terminalId, { ...terminal, status: "killed", exitCode: 0 });
            }
          })
        : Effect.fail(unavailable("kill", input.terminalId)),
    closeProject: () => Effect.void,
    subscribeProjectEvents: () => Effect.succeed(() => undefined),
  } as unknown as TerminalManager.TerminalManager["Service"];

  const snapshots = {
    getThreadShellById: (id: ThreadId) =>
      Effect.succeed(id === threadId ? Option.some({ id: threadId, projectId }) : Option.none()),
    getProjectShellById: (id: ProjectId) =>
      Effect.succeed(
        id === projectId
          ? Option.some({
              id: projectId,
              title: "MCP terminal test",
              workspaceRoot: "/workspace/mcp-terminal-test",
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            })
          : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;

  const crypto = Crypto.make({
    randomBytes: (size) => new Uint8Array(size).fill(7),
    digest: (_algorithm, data) => Effect.succeed(data),
  });

  const completionService = {
    subscribe: (input: (typeof completionSubscriptions)[number]) =>
      Effect.sync(() => {
        completionSubscriptions.push(input);
      }),
    unsubscribe: (input: (typeof completionUnsubscriptions)[number]) =>
      Effect.sync(() => {
        completionUnsubscriptions.push(input);
      }),
    closeProject: () => Effect.void,
    start: () => Effect.void,
    drain: Effect.void,
  } satisfies ProjectTerminalCompletionService.ProjectTerminalCompletionServiceShape;

  const serviceLayer = ProjectTerminalService.ProjectTerminalServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(TerminalManager.TerminalManager, manager),
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots),
        Layer.succeed(Crypto.Crypto, crypto),
        Layer.succeed(
          ProjectTerminalCompletionService.ProjectTerminalCompletionService,
          completionService,
        ),
      ),
    ),
  );

  const layer = McpHttpServer.TerminalToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(serviceLayer),
  );

  return {
    layer,
    serviceLayer,
    terminals,
    outputs,
    createInputs,
    writes,
    resizes,
    kills,
    completionSubscriptions,
    completionUnsubscriptions,
  };
};

type McpServerService = McpServer.McpServer["Service"];

const callTool = (
  server: McpServerService,
  name: string,
  args: Record<string, unknown>,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["terminal"],
) =>
  server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provideService(McpSchema.McpServerClient, client),
    );

const postMcp = (
  client: HttpClient.HttpClient,
  authorization: string,
  request: unknown,
  sessionId?: string,
) =>
  client.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      authorization,
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      ...(sessionId === undefined ? {} : { "mcp-protocol-version": "2025-06-18" }),
    },
    body: HttpBody.text(JSON.stringify(request), "application/json"),
  });

const parseMcpResponse = (body: string) => {
  const eventData = body
    .split(/\r?\n/)
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(eventData ?? body) as {
    readonly result?: {
      readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
      readonly structuredContent?: unknown;
      readonly isError?: boolean;
    };
    readonly error?: unknown;
  };
};

const makeAuthenticatedMcpLayer = (
  harness: ReturnType<typeof makeHarness>,
  registry: McpSessionRegistry.McpSessionRegistry["Service"],
) =>
  Layer.mergeAll(
    McpHttpServer.TerminalToolkitRegistrationLive,
    McpHttpServer.PreviewToolkitRegistrationLive,
  ).pipe(
    Layer.provideMerge(McpHttpServer.McpTransportLive),
    Layer.provideMerge(PreviewAutomationBroker.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-terminal-http-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(harness.serviceLayer),
    Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
  );

it.effect("registers project completion tools with read and lifecycle annotations", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const names = server.tools.map(({ tool }) => tool.name).toSorted();
    expect(names).toEqual([
      "terminal_kill",
      "terminal_list",
      "terminal_read",
      "terminal_resize",
      "terminal_spawn",
      "terminal_subscribe_completion",
      "terminal_unsubscribe_completion",
      "terminal_write",
    ]);

    for (const entry of server.tools) {
      expect(entry.tool.inputSchema).toMatchObject({ type: "object" });
    }

    const spawn = server.tools.find(({ tool }) => tool.name === "terminal_spawn")?.tool;
    expect(spawn?.annotations?.idempotentHint).toBe(false);
    expect(spawn?.annotations?.destructiveHint).toBe(true);
    expect(spawn?.description).toContain("Arguments are passed unchanged");

    const read = server.tools.find(({ tool }) => tool.name === "terminal_read")?.tool;
    expect(read?.annotations?.readOnlyHint).toBe(true);
    expect(read?.description).toContain("literal");

    const write = server.tools.find(({ tool }) => tool.name === "terminal_write")?.tool;
    expect(write?.annotations?.idempotentHint).toBe(false);
    expect(write?.description).toContain("No newline is appended");

    const kill = server.tools.find(({ tool }) => tool.name === "terminal_kill")?.tool;
    expect(kill?.annotations?.destructiveHint).toBe(true);
    expect(kill?.description).toContain("stopping");
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "routes calls through the authenticated project service and retains logs by default",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const spawned = yield* callTool(server, "terminal_spawn", {
        title: "shared shell",
        command: "node",
        args: ["-e", "process.stdin.resume()"],
        cols: 96,
        rows: 32,
      });
      expect(spawned.isError).toBe(false);
      expect(spawned.structuredContent).toMatchObject({
        projectId,
        title: "shared shell",
        command: "node",
        args: ["-e", "process.stdin.resume()"],
        cwd: "/workspace/mcp-terminal-test",
        creatingThreadId: threadId,
      });
      expect(harness.createInputs).toHaveLength(1);
      expect(harness.createInputs[0]).toMatchObject({ projectId, creatingThreadId: threadId });
      const handle = {
        projectId,
        terminalId: (spawned.structuredContent as ProjectTerminalSummary).terminalId,
      };

      const subscribed = yield* callTool(server, "terminal_subscribe_completion", {
        ...handle,
        mode: "noticeAndWake",
      });
      expect(subscribed.isError).toBe(false);
      expect(subscribed.structuredContent).toMatchObject({ subscribed: true });
      expect(harness.completionSubscriptions).toEqual([
        { ...handle, threadId, mode: "noticeAndWake" },
      ]);

      const unsubscribed = yield* callTool(server, "terminal_unsubscribe_completion", handle);
      expect(unsubscribed.isError).toBe(false);
      expect(unsubscribed.structuredContent).toMatchObject({ unsubscribed: true });
      expect(harness.completionUnsubscriptions).toEqual([{ ...handle, threadId }]);

      const listed = yield* callTool(server, "terminal_list", { limit: 20 });
      expect(listed.isError).toBe(false);
      expect(listed.structuredContent).toMatchObject({ terminals: [handle] });

      const text = "printf 'one\\ntwo'\r\n\u0003";
      const written = yield* callTool(server, "terminal_write", { ...handle, data: text });
      expect(written.isError).toBe(false);
      expect(written.structuredContent).toMatchObject({ acknowledged: true });
      expect(harness.writes).toEqual([{ terminalId: handle.terminalId, data: text }]);

      const resized = yield* callTool(server, "terminal_resize", {
        ...handle,
        cols: 120,
        rows: 40,
      });
      expect(resized.isError).toBe(false);
      expect(harness.resizes).toEqual([{ terminalId: handle.terminalId, cols: 120, rows: 40 }]);

      const stopped = yield* callTool(server, "terminal_kill", handle);
      expect(stopped.isError).toBe(false);
      expect(stopped.structuredContent).toMatchObject({ requested: true, cleanup: false });
      expect(harness.kills).toEqual([{ projectId, terminalId: handle.terminalId, cleanup: false }]);

      const retained = yield* callTool(server, "terminal_read", handle);
      expect(retained.isError).toBe(false);
      expect(retained.structuredContent).toMatchObject({
        kind: "stream",
        terminal: { terminalId: handle.terminalId, status: "killed" },
        output: "retained PTY output\r\n",
      });

      const cleaned = yield* callTool(server, "terminal_kill", { ...handle, cleanup: true });
      expect(cleaned.isError).toBe(false);
      expect(harness.kills.at(-1)).toEqual({
        projectId,
        terminalId: handle.terminalId,
        cleanup: true,
      });
      expect(harness.terminals.has(handle.terminalId)).toBe(false);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("rejects missing capability and unavailable handles without spawning", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const denied = yield* callTool(server, "terminal_spawn", {}, []);
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual([
      { type: "text", text: "MCP credential does not grant the terminal capability." },
    ]);
    expect(harness.createInputs).toHaveLength(0);

    const deniedCompletion = yield* callTool(
      server,
      "terminal_subscribe_completion",
      { projectId, terminalId: "unknown-terminal", mode: "notice" },
      [],
    );
    expect(deniedCompletion.isError).toBe(true);
    expect(deniedCompletion.content).toEqual([
      { type: "text", text: "MCP credential does not grant the terminal capability." },
    ]);

    const unavailable = yield* callTool(server, "terminal_write", {
      projectId,
      terminalId: "unknown-terminal",
      data: "pwd\n",
    });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.content).toEqual([
      { type: "text", text: "Project terminal write failed (unavailable)." },
    ]);
    expect(harness.createInputs).toHaveLength(0);

    const oversizedPage = yield* Effect.result(callTool(server, "terminal_list", { limit: 101 }));
    expect(oversizedPage._tag).toBe("Failure");

    const oversizedRead = yield* Effect.result(
      callTool(server, "terminal_read", {
        projectId,
        terminalId: "unknown-terminal",
        maxBytes: 65_537,
      }),
    );
    expect(oversizedRead._tag).toBe("Failure");

    const incompatibleTail = yield* Effect.result(
      callTool(server, "terminal_read", {
        projectId,
        terminalId: "unknown-terminal",
        tailLines: 20,
        cursor: "opaque-cursor",
      }),
    );
    expect(incompatibleTail._tag).toBe("Failure");
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "keeps a project terminal across credential renewal and denies preview without that capability",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeHarness();
        const registry: McpSessionRegistry.McpSessionRegistryShape =
          yield* McpSessionRegistry.__testing
            .make({ now: () => 1_000 })
            .pipe(
              Effect.provideService(HttpServer.HttpServer, fakeMcpEndpointServer),
              Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
              Effect.provide(NodeServices.layer),
            );
        yield* Effect.addFinalizer(() => registry.revokeAll);

        const terminalOnlyCredential = yield* registry.issue({
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          includePreview: false,
        });
        yield* HttpRouter.serve(makeAuthenticatedMcpLayer(harness, registry), {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);
        const httpClient = yield* HttpClient.HttpClient;

        const initialized = yield* postMcp(
          httpClient,
          terminalOnlyCredential.config.authorizationHeader,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "terminal-renewal-test", version: "1.0.0" },
            },
          },
        );
        expect(initialized.status).toBe(200);
        const sessionId = initialized.headers["mcp-session-id"];
        expect(sessionId).toBeTruthy();
        yield* postMcp(
          httpClient,
          terminalOnlyCredential.config.authorizationHeader,
          { jsonrpc: "2.0", method: "notifications/initialized" },
          sessionId,
        );

        const callHttpTool = (authorization: string, id: number, name: string, args: unknown) =>
          Effect.gen(function* () {
            const response = yield* postMcp(
              httpClient,
              authorization,
              {
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: { name, arguments: args },
              },
              sessionId,
            );
            const body = yield* response.text;
            return { response, body, parsed: body.length === 0 ? {} : parseMcpResponse(body) };
          });

        const spawned = yield* callHttpTool(
          terminalOnlyCredential.config.authorizationHeader,
          2,
          "terminal_spawn",
          { title: "renewal shell", command: "node", args: ["-e", "process.stdin.resume()"] },
        );
        expect(spawned.response.status).toBe(200);
        expect(spawned.parsed.result?.isError).toBe(false);
        const spawnedTerminal = spawned.parsed.result?.structuredContent as ProjectTerminalSummary;
        expect(spawnedTerminal.status).toBe("running");
        expect(harness.createInputs).toHaveLength(1);

        yield* registry.revokeProviderSession(terminalOnlyCredential.config.providerSessionId);
        const rejectedOldCredential = yield* postMcp(
          httpClient,
          terminalOnlyCredential.config.authorizationHeader,
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "terminal_list", arguments: {} },
          },
          sessionId,
        );
        expect(rejectedOldCredential.status).toBe(401);

        const replacementCredential = yield* registry.issue({
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          includePreview: false,
        });
        expect(replacementCredential.config.providerSessionId).not.toBe(
          terminalOnlyCredential.config.providerSessionId,
        );
        const readAfterRenewal = yield* callHttpTool(
          replacementCredential.config.authorizationHeader,
          4,
          "terminal_read",
          { projectId, terminalId: spawnedTerminal.terminalId },
        );
        expect(readAfterRenewal.response.status).toBe(200);
        expect(readAfterRenewal.parsed.result?.isError).toBe(false);
        expect(readAfterRenewal.parsed.result?.structuredContent).toMatchObject({
          kind: "stream",
          terminal: { terminalId: spawnedTerminal.terminalId, status: "running" },
          output: "retained PTY output\r\n",
        });
        expect(harness.createInputs).toHaveLength(1);

        const writtenAfterRenewal = yield* callHttpTool(
          replacementCredential.config.authorizationHeader,
          5,
          "terminal_write",
          { projectId, terminalId: spawnedTerminal.terminalId, data: "echo renewed\n" },
        );
        expect(writtenAfterRenewal.parsed.result?.isError).toBe(false);
        expect(harness.writes).toEqual([
          { terminalId: spawnedTerminal.terminalId, data: "echo renewed\n" },
        ]);

        const deniedPreview = yield* callHttpTool(
          replacementCredential.config.authorizationHeader,
          6,
          "preview_status",
          {},
        );
        expect(deniedPreview.response.status).toBe(200);
        expect(deniedPreview.parsed.result?.isError).toBe(true);
        expect(deniedPreview.parsed.result?.content).toEqual([
          { type: "text", text: "MCP credential does not grant the preview capability." },
        ]);

        const stopped = yield* callHttpTool(
          replacementCredential.config.authorizationHeader,
          7,
          "terminal_kill",
          { projectId, terminalId: spawnedTerminal.terminalId },
        );
        expect(stopped.parsed.result?.structuredContent).toMatchObject({
          requested: true,
          cleanup: false,
        });
        const readAfterKill = yield* callHttpTool(
          replacementCredential.config.authorizationHeader,
          8,
          "terminal_read",
          { projectId, terminalId: spawnedTerminal.terminalId },
        );
        expect(readAfterKill.parsed.result?.structuredContent).toMatchObject({
          kind: "stream",
          terminal: { terminalId: spawnedTerminal.terminalId, status: "killed" },
          output: "retained PTY output\r\n",
        });
        const cleaned = yield* callHttpTool(
          replacementCredential.config.authorizationHeader,
          9,
          "terminal_kill",
          { projectId, terminalId: spawnedTerminal.terminalId, cleanup: true },
        );
        expect(cleaned.parsed.result?.structuredContent).toMatchObject({
          requested: true,
          cleanup: true,
        });
        expect(harness.terminals.has(spawnedTerminal.terminalId)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
