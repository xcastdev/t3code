import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2InstructionSnapshot,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { OpenCodeEvent } from "@opencode/protocol/groups/event";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import * as Adapter from "./adapter.ts";

const decodeNativeEvent = Schema.decodeUnknownSync(OpenCodeEvent);

const snapshot: OrchestrationV2InstructionSnapshot = {
  configurationHash: "config-2",
  resourceRevision: "resources-2",
  memoryEpoch: 0,
  roleInstructions: "Review the task and report findings to the human.",
  toolIds: ["report"],
  skillIds: [],
};
const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer({ cwd: "/workspace" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const fixture = Effect.fn("OpenCode2Test.fixture")(function* (
  options: {
    external?: boolean;
    failedTransition?: boolean;
    catalogStatus?: "connected" | "failed";
    rejectCatalog?: boolean;
    failFirstCatalogStatus?: boolean;
    failFirstCatalogPut?: boolean;
    freshNativeThread?: boolean;
    beforeCatalogResponse?: Effect.Effect<void>;
    rejectInstructions?: boolean;
    rejectPrompt?: boolean;
    interrupted?: boolean;
    running?: boolean;
    delayFirstPrompt?: boolean;
  } = {},
) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const nativeConfigurations = new Map<string, { config: string; connections: number }>();
  const disconnect = yield* Deferred.make<void>();
  const firstReleased = yield* Deferred.make<void>();
  let connections = 0;
  const nativeEvents = yield* Queue.unbounded<{
    event: OpenCode2Client.OpenCode2StreamEvent;
    done: Deferred.Deferred<void>;
  }>();
  const nativeStream = Stream.fromQueue(nativeEvents).pipe(
    Stream.flatMap(({ event, done }) =>
      Stream.concat(
        Stream.make(event),
        Stream.drain(Stream.fromEffect(Deferred.succeed(done, undefined))),
      ),
    ),
  );
  const publish = (event: OpenCode2Client.OpenCode2StreamEvent) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      yield* Queue.offer(nativeEvents, { event, done });
      yield* Deferred.await(done);
    });
  const commandEntered = yield* Deferred.make<void>();
  const commandRelease = yield* Deferred.make<void>();
  const firstPromptSubmitted = yield* Deferred.make<void>();
  const firstPromptRelease = yield* Deferred.make<void>();
  const nativeSession = (id = "ses_root") => ({
    id,
    location: { directory: "/workspace" },
    projectID: "global",
    title: "Test",
    agent: "build",
    model: { id: "model", providerID: "provider", variant: "default" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    permissions: [],
  });
  const http = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const body: unknown =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      calls.push({ path: url.pathname, method: request.method, body });
      let data: unknown = null;
      let status = 200;
      if (url.pathname.startsWith("/api/experimental/mcp/")) {
        status =
          options.failedTransition &&
          (request.method === "DELETE" ||
            (request.method === "PUT" &&
              url.pathname.endsWith("_catalog") &&
              calls.filter((call) => call.method === "PUT" && call.path.endsWith("_catalog"))
                .length === 2))
            ? 500
            : (options.rejectCatalog ||
                  (options.failFirstCatalogPut &&
                    calls.filter((call) => call.method === "PUT" && call.path.endsWith("_catalog"))
                      .length === 1)) &&
                url.pathname.endsWith("_catalog") &&
                request.method === "PUT"
              ? 500
              : 204;
      } else if (url.pathname === "/api/mcp") {
        if (
          options.failFirstCatalogStatus &&
          calls.filter((call) => call.path === "/api/mcp").length === 1
        )
          status = 500;
        data = {
          location: { directory: "/workspace" },
          data: [...nativeConfigurations.keys()].map((path) => ({
            name: path.split("/").at(-1),
            status:
              options.catalogStatus === "failed"
                ? { status: "failed", error: "unavailable" }
                : { status: "connected" },
          })),
        };
      } else if (url.pathname === "/api/command")
        data = { data: [], location: { directory: "/workspace" } };
      else if (url.pathname === "/api/model" || url.pathname === "/api/agent")
        data = { data: [], location: { directory: "/workspace" } };
      else if (url.pathname === "/api/session/active")
        data = { data: options.running ? { ses_root: { type: "running" } } : {} };
      else if (url.pathname === "/api/session" && request.method === "GET")
        data = {
          data: url.searchParams.get("parentID") === "ses_root" ? [nativeSession("ses_child")] : [],
          cursor: {},
        };
      else if (url.pathname.endsWith("/message")) data = { data: [], cursor: {} };
      else if (url.pathname.endsWith("/permission") || url.pathname.endsWith("/form"))
        data = { data: [] };
      else if (
        url.pathname === "/api/session" ||
        url.pathname === "/api/session/ses_root" ||
        url.pathname === "/api/session/ses_second"
      )
        data = {
          data: nativeSession(
            options.freshNativeThread &&
              calls.filter((call) => call.path === "/api/session" && call.method === "POST")
                .length > 1
              ? "ses_second"
              : "ses_root",
          ),
        };
      else if (url.pathname.endsWith("/interrupt"))
        data = { interrupted: options.interrupted ?? true };
      else if (url.pathname.includes("/instructions/")) {
        status = options.rejectInstructions ? 500 : 204;
      } else if (url.pathname.endsWith("/prompt")) {
        status = options.rejectPrompt ? 500 : 200;
        data = {
          data: {
            id: "msg_user",
            sessionID: "ses_root",
            time: { created: 1 },
            type: "user",
            payload: { text: "hello" },
            delivery: "steer",
          },
        };
      } else throw new Error(`Unexpected fake OpenCode request ${request.method} ${url.pathname}`);
      if (url.pathname.startsWith("/api/experimental/mcp/") && status === 204) {
        if (request.method === "DELETE") nativeConfigurations.delete(url.pathname);
        else if (request.method === "PUT") {
          const config = JSON.stringify(body);
          const old = nativeConfigurations.get(url.pathname);
          if (old?.config !== config)
            nativeConfigurations.set(url.pathname, {
              config,
              connections: (old?.connections ?? 0) + 1,
            });
        }
      }
      const response =
        status === 204
          ? new Response(null, { status })
          : new Response(JSON.stringify(data), {
              status,
              headers: { "content-type": "application/json" },
            });
      return HttpClientResponse.fromWeb(request, response);
    }).pipe(
      Effect.tap(() =>
        url.pathname.startsWith("/api/experimental/mcp/") &&
        url.pathname.endsWith("_catalog") &&
        request.method === "PUT"
          ? (options.beforeCatalogResponse ?? Effect.void)
          : Effect.void,
      ),
      Effect.tap(() =>
        url.pathname === "/api/command"
          ? Deferred.succeed(commandEntered, undefined).pipe(
              Effect.andThen(Deferred.await(commandRelease)),
            )
          : Effect.void,
      ),
      Effect.tap(() =>
        options.delayFirstPrompt &&
        url.pathname.endsWith("/prompt") &&
        calls.filter((c) => c.path.endsWith("/prompt")).length === 1
          ? Deferred.succeed(firstPromptSubmitted, undefined).pipe(
              Effect.andThen(Deferred.await(firstPromptRelease)),
            )
          : Effect.void,
      ),
    ),
  );
  const api = yield* Effect.gen(function* () {
    return yield* (yield* OpenCode2Client.OpenCode2Client).connect({
      baseUrl: "http://opencode.test",
      password: "test",
    });
  }).pipe(
    Effect.provide(OpenCode2Client.layer),
    Effect.provideService(HttpClient.HttpClient, http),
  );
  const server = OpenCode2Server.OpenCode2Server.of({
    withConnection: (use) =>
      Effect.gen(function* () {
        const ordinal = ++connections;
        yield* Effect.addFinalizer(() =>
          ordinal === 1 ? Deferred.succeed(firstReleased, undefined) : Effect.void,
        );
        return yield* use({
          ...api,
          events: Effect.succeed(
            ordinal === 1
              ? nativeStream.pipe(Stream.interruptWhen(Deferred.await(disconnect)))
              : nativeStream,
          ),
          external: options.external ?? true,
          url: "http://opencode.test",
          version: "2.0.28",
        });
      }).pipe(Effect.scoped),
  });
  const instanceId = ProviderInstanceId.make("opencode-test");
  const threadId = ThreadId.make("opencode-thread");
  const modelSelection = { instanceId, model: "provider/model" };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: "/workspace",
  });
  const adapter = yield* Adapter.make(instanceId).pipe(
    Effect.provideService(OpenCode2Server.OpenCode2Server, server),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("opencode-session"),
    modelSelection,
    runtimePolicy,
  });
  let providerThread = yield* runtime.ensureThread({
    threadId,
    title: "Test",
    modelSelection,
    runtimePolicy,
  });
  const now = yield* DateTime.now;
  let attempt = 0;
  const start = (
    instructions?: OrchestrationV2InstructionSnapshot,
    continuation = false,
    text = "hello",
  ) =>
    runtime.startTurn({
      ...(instructions === undefined ? {} : { instructionSnapshot: instructions }),
      appThread: {
        id: threadId,
        projectId: ProjectId.make("project"),
        title: "Test",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make("run"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt-${++attempt}`),
      rootNodeId: NodeId.make("node"),
      providerThread,
      message: {
        createdBy: continuation ? "agent" : "user",
        creationSource: continuation ? "provider" : "web",
        messageId: MessageId.make("message"),
        text,
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });
  return {
    publish,
    replaceThread: Effect.gen(function* () {
      providerThread = yield* runtime.ensureThread({
        threadId,
        title: "Replacement",
        modelSelection,
        runtimePolicy,
      });
    }),
    commandEntered: Deferred.await(commandEntered),
    commandRelease: Deferred.succeed(commandRelease, undefined),
    firstPromptSubmitted: Deferred.await(firstPromptSubmitted),
    firstPromptRelease: Deferred.succeed(firstPromptRelease, undefined),
    runtime,
    providerThread,
    calls,
    nativeConfigurations,
    start,
    disconnect: Deferred.succeed(disconnect, undefined),
    firstReleased: Deferred.await(firstReleased),
  };
});

it.effect(
  "OpenCode 2 shutdown detaches active external work without interrupting roots or descendants",
  () =>
    Effect.gen(function* () {
      const calls = yield* Effect.gen(function* () {
        const test = yield* fixture();
        assert.equal(test.runtime.detachThreadPolicy, "detach");
        yield* test.start();
        return test.calls;
      }).pipe(Effect.scoped);
      assert.isFalse(calls.some((call) => call.path.endsWith("/interrupt")));
      assert.isFalse(calls.some((call) => call.path.includes("mcp")));
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["accepted", "instructions-rejected", "prompt-rejected"] as const)(
  "OpenCode 2 acknowledges actual instruction write and prompt: %s",
  (mode) =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rejectInstructions: mode === "instructions-rejected",
        rejectPrompt: mode === "prompt-rejected",
      });
      const start = test.start(snapshot);
      if (mode === "accepted") yield* start;
      else yield* start.pipe(Effect.flip);
      const receipt = yield* test.runtime.getAppliedInstructions!({
        providerThread: test.providerThread,
      });
      assert.deepEqual(receipt, mode === "accepted" ? snapshot : undefined);
      const write = test.calls.findIndex((call) => call.path.includes("/instructions/"));
      const prompt = test.calls.findIndex((call) => call.path.endsWith("/prompt"));
      assert.isAtLeast(write, 0);
      assert.include(JSON.stringify(test.calls[write]!.body), snapshot.roleInstructions);
      assert.notInclude(JSON.stringify(test.calls[write]!.body), "delegate_task");
      if (mode === "instructions-rejected") assert.equal(prompt, -1);
      else assert.isAbove(prompt, write);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([true, false])(
  "OpenCode 2 explicit termination confirms every native descendant, confirmed=%s",
  (confirmed) =>
    Effect.gen(function* () {
      const test = yield* fixture({ interrupted: confirmed, running: !confirmed });
      if (confirmed) yield* test.runtime.terminateSession!;
      else yield* test.runtime.terminateSession!.pipe(Effect.flip);
      const stops = test.calls
        .filter((call) => call.path.endsWith("/interrupt"))
        .map((call) => call.path);
      assert.deepEqual(
        stops,
        confirmed
          ? ["/api/session/ses_root/interrupt", "/api/session/ses_child/interrupt"]
          : ["/api/session/ses_root/interrupt"],
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "OpenCode 2 reconnect closes the old external subscription without aborting native work",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture({ running: true });
      yield* test.start(snapshot);
      yield* test.disconnect;
      yield* test.firstReleased;
      assert.isFalse(test.calls.some((call) => call.path.endsWith("/interrupt")));
      assert.deepEqual(
        yield* test.runtime.getAppliedInstructions!({ providerThread: test.providerThread }),
        snapshot,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("OpenCode 2 rewrites a changed revision before accepting the next prompt", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* test.start(snapshot);
    const terminal = yield* test.runtime.events.pipe(
      Stream.filter((event) => event.type === "turn.terminal"),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* test.disconnect;
    yield* Fiber.join(terminal);
    const next = {
      ...snapshot,
      configurationHash: "config-next",
      resourceRevision: "resources-next",
      roleInstructions: "Use the updated role for this turn.",
    };
    yield* test.start(next);
    const writes = test.calls.filter((call) => call.path.includes("/instructions/"));
    assert.equal(writes.length, 2);
    assert.include(JSON.stringify(writes[1]!.body), next.roleInstructions);
    assert.notInclude(JSON.stringify(writes[1]!.body), snapshot.roleInstructions);
    assert.deepEqual(
      yield* test.runtime.getAppliedInstructions!({ providerThread: test.providerThread }),
      next,
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "OpenCode 2 rejected Stop retains the active turn and never submits a replacement prompt",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture({ interrupted: false, running: true });
      yield* test.start(snapshot);
      const active = yield* test.runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        ),
        Stream.runHead,
      );
      assert.equal(active._tag, "Some");
      if (active._tag !== "Some" || active.value.type !== "provider_turn.updated")
        throw new Error("Missing active turn");
      yield* test.runtime
        .interruptTurn({
          providerThread: test.providerThread,
          providerTurnId: active.value.providerTurn.id,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.flip);
      yield* test.start({ ...snapshot, resourceRevision: "replacement" }).pipe(Effect.flip);
      assert.equal(test.calls.filter((call) => call.path.endsWith("/prompt")).length, 1);
      assert.deepEqual(
        yield* test.runtime.getAppliedInstructions!({ providerThread: test.providerThread }),
        snapshot,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("OpenCode 2 clears a previous receipt before a rejected same-revision turn", () =>
  Effect.gen(function* () {
    const options = { rejectPrompt: false };
    const test = yield* fixture(options);
    yield* test.start(snapshot);
    const terminal = yield* test.runtime.events.pipe(
      Stream.filter((e) => e.type === "turn.terminal"),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* test.disconnect;
    yield* Fiber.join(terminal);
    options.rejectPrompt = true;
    yield* test.start(snapshot).pipe(Effect.flip);
    assert.isUndefined(
      yield* test.runtime.getAppliedInstructions!({ providerThread: test.providerThread }),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
it.effect("OpenCode 2 ignores a stale Stop targeting a different active turn", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* test.start(snapshot);
    yield* test.runtime.interruptTurn({
      providerThread: test.providerThread,
      providerTurnId: ProviderTurnId.make("old-turn"),
      requestRuntimeRestart: true,
    });
    assert.deepEqual(
      test.calls.filter((c) => c.path.endsWith("/interrupt")),
      [],
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
it.effect(
  "OpenCode 2 ignores an older delayed prompt acknowledgement after a newer turn starts",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture({ delayFirstPrompt: true });
      const first = yield* test.start(snapshot).pipe(Effect.forkScoped);
      yield* test.firstPromptSubmitted;
      const terminal = yield* test.runtime.events.pipe(
        Stream.filter((e) => e.type === "turn.terminal"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* test.disconnect;
      yield* Fiber.join(terminal);
      const next = { ...snapshot, resourceRevision: "newer" };
      yield* test.start(next);
      yield* test.firstPromptRelease;
      yield* Fiber.join(first);
      assert.deepEqual(
        yield* test.runtime.getAppliedInstructions!({ providerThread: test.providerThread }),
        next,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "OpenCode 2 clears the previous receipt for a continuation without native injection",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      yield* test.start(snapshot);
      const terminal = yield* test.runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* test.disconnect;
      yield* Fiber.join(terminal);
      const before = test.calls.length;
      yield* test.start(snapshot, true);
      assert.isUndefined(
        yield* test.runtime.getAppliedInstructions!({ providerThread: test.providerThread }),
      );
      assert.isFalse(
        test.calls
          .slice(before)
          .some((call) => call.path.includes("/instructions/") || call.path.endsWith("/prompt")),
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("OpenCode 2 external Stop settles an admitted unsent turn on confirmed native idle", () =>
  Effect.gen(function* () {
    const test = yield* fixture({ interrupted: false, running: false });
    const first = yield* test.start(snapshot, false, "/custom").pipe(Effect.forkScoped);
    yield* test.commandEntered;
    const active = yield* test.runtime.events.pipe(
      Stream.filter(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      ),
      Stream.runHead,
    );
    if (active._tag !== "Some" || active.value.type !== "provider_turn.updated")
      throw new Error("Missing turn");
    yield* test.runtime.interruptTurn({
      providerThread: test.providerThread,
      providerTurnId: active.value.providerTurn.id,
      requestRuntimeRestart: true,
    });
    yield* test.commandRelease;
    yield* Fiber.join(first);
    assert.equal(test.calls.filter((call) => call.path.endsWith("/prompt")).length, 0);
    // Confirmed idle Stop must let the next turn start; no native execution can emit an end for the cancelled unsent turn.
    yield* test.start(snapshot);
    assert.equal(test.calls.filter((call) => call.path.endsWith("/prompt")).length, 1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([
  { terminalAfterSuccessor: false, interrupted: true },
  { terminalAfterSuccessor: true, interrupted: true },
  { terminalAfterSuccessor: false, interrupted: false },
  { terminalAfterSuccessor: true, interrupted: false },
])(
  "a stopped unsent turn's terminal cannot finish its successor, %o",
  ({ terminalAfterSuccessor, interrupted }) =>
    Effect.gen(function* () {
      const test = yield* fixture({ interrupted });
      const first = yield* test.start(snapshot, false, "/custom").pipe(Effect.forkScoped);
      yield* test.commandEntered;
      // A native background/report execution can run while this prompt is still preparing.
      yield* test.publish(
        decodeNativeEvent({
          id: "evt_start",
          type: "session.execution.started",
          created: 1,
          durable: { aggregateID: "ses_root", seq: 1, version: 1 },
          data: { sessionID: "ses_root" },
        }),
      );
      const active = yield* test.runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        ),
        Stream.runHead,
      );
      if (active._tag !== "Some" || active.value.type !== "provider_turn.updated")
        throw new Error("Missing active turn");
      yield* test.runtime.interruptTurn({
        providerThread: test.providerThread,
        providerTurnId: active.value.providerTurn.id,
        requestRuntimeRestart: true,
      });
      yield* test.commandRelease;
      yield* Fiber.join(first);
      const stoppedEnd = decodeNativeEvent({
        id: "evt_end",
        type: "session.execution.interrupted",
        created: 2,
        durable: { aggregateID: "ses_root", seq: 2, version: 1 },
        data: { sessionID: "ses_root", reason: "user" },
      });
      if (!terminalAfterSuccessor) yield* test.publish(stoppedEnd);
      yield* test.start(snapshot);
      assert.equal(test.calls.filter((c) => c.path.endsWith("/prompt")).length, 1);
      if (terminalAfterSuccessor) yield* test.publish(stoppedEnd);
      const third = yield* test.start(snapshot).pipe(Effect.exit);
      assert.isTrue(
        Exit.isFailure(third),
        "successor must remain active until its own native execution ends",
      );
      assert.equal(test.calls.filter((c) => c.path.endsWith("/prompt")).length, 1);
      yield* test.publish(
        decodeNativeEvent({
          id: "evt_successor_start",
          type: "session.execution.started",
          created: 3,
          durable: { aggregateID: "ses_root", seq: 3, version: 1 },
          data: { sessionID: "ses_root" },
        }),
      );
      yield* test.publish(
        decodeNativeEvent({
          id: "evt_successor_end",
          type: "session.execution.succeeded",
          created: 4,
          durable: { aggregateID: "ses_root", seq: 4, version: 1 },
          data: { sessionID: "ses_root" },
        }),
      );
      yield* test.start(snapshot);
      assert.equal(test.calls.filter((c) => c.path.endsWith("/prompt")).length, 2);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([true, false])(
  "OpenCode 2 background Stop fences a delayed terminal before a new local turn, interrupted=%s",
  (interrupted) =>
    Effect.gen(function* () {
      const test = yield* fixture({ interrupted });
      yield* test.publish(
        decodeNativeEvent({
          id: "evt_background_start",
          type: "session.execution.started",
          created: 1,
          durable: { aggregateID: "ses_root", seq: 1, version: 1 },
          data: { sessionID: "ses_root" },
        }),
      );
      yield* test.runtime.interruptTurn({
        providerThread: test.providerThread,
        providerTurnId: ProviderTurnId.make("settled-turn"),
        requestRuntimeRestart: true,
      });
      yield* test.start(snapshot);
      yield* test.publish(
        decodeNativeEvent({
          id: "evt_background_end",
          type: "session.execution.interrupted",
          created: 2,
          durable: { aggregateID: "ses_root", seq: 2, version: 1 },
          data: { sessionID: "ses_root", reason: "user" },
        }),
      );
      const next = yield* test.start(snapshot).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(next));
      assert.equal(test.calls.filter((call) => call.path.endsWith("/prompt")).length, 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each(["connected", "failed", "rejected", "external", "replaced"] as const)(
  "OpenCode 2 catalog delivery uses native MCP config acknowledgement: %s",
  (mode) =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const threadId = ThreadId.make("opencode-thread");
      const config = {
        environmentId: EnvironmentId.make("environment"),
        threadId,
        providerSessionId: "mcp-catalog",
        providerInstanceId: ProviderInstanceId.make("opencode-test"),
        nativeRuntimeId: "native-runtime-catalog",
        endpoint: "http://t3.test/mcp",
        catalogEndpoint: "http://t3.test/mcp/catalog/mcp-catalog",
        authorizationHeader: "Bearer test-catalog-only",
        browserToolsAvailable: false,
      };
      yield* sessions.set(config);
      const test = yield* fixture({
        external: mode === "external",
        catalogStatus: mode === "failed" ? "failed" : "connected",
        rejectCatalog: mode === "rejected",
        beforeCatalogResponse:
          mode === "replaced"
            ? sessions.set({ ...config, nativeRuntimeId: "replacement-runtime" })
            : Effect.void,
      });
      assert.isUndefined(yield* sessions.readCatalogEndpointReceipt(threadId));
      yield* test.start();
      const writes = test.calls.filter(
        (call) => call.method === "PUT" && call.path.startsWith("/api/experimental/mcp/"),
      );
      assert.strictEqual(
        yield* sessions.readCatalogEndpointReceipt(threadId),
        mode === "connected" ? config : undefined,
      );
      assert.deepEqual(
        writes.map((call) => call.body),
        mode === "external"
          ? []
          : [
              {
                config: {
                  type: "remote",
                  url: config.endpoint,
                  headers: { Authorization: config.authorizationHeader },
                  oauth: false,
                },
              },
              {
                config: {
                  type: "remote",
                  url: config.catalogEndpoint,
                  headers: { Authorization: config.authorizationHeader },
                  oauth: false,
                },
              },
            ],
      );
      if (mode !== "external") assert.equal(writes[1]!.path, `${writes[0]!.path}_catalog`);
      const instructions = test.calls.find((call) => call.path.includes("/instructions/"));
      assert.isDefined(instructions);
      assert.notInclude(JSON.stringify(instructions!.body), config.authorizationHeader);
      assert.notInclude(JSON.stringify(instructions!.body), config.catalogEndpoint);
      assert.equal(test.calls.filter((call) => call.path.endsWith("/prompt")).length, 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each(["confirmed", "status-failed", "put-uncertain", "new-thread"] as const)(
  "OpenCode 2 does not acknowledge a changed catalog revision through a cached native connection: %s",
  (initial) =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const threadId = ThreadId.make("opencode-thread");
      const config = {
        environmentId: EnvironmentId.make("environment"),
        threadId,
        providerSessionId: "mcp-catalog",
        providerInstanceId: ProviderInstanceId.make("opencode-test"),
        nativeRuntimeId: "native-runtime-catalog",
        catalogRevision: 1,
        endpoint: "http://t3.test/mcp",
        catalogEndpoint: "http://t3.test/mcp/catalog/mcp-catalog",
        authorizationHeader: "Bearer test-catalog-only",
        browserToolsAvailable: false,
      };
      yield* sessions.set(config);
      const test = yield* fixture({
        external: false,
        failFirstCatalogStatus: initial === "status-failed",
        failFirstCatalogPut: initial === "put-uncertain",
        freshNativeThread: initial === "new-thread",
      });
      yield* test.start();
      assert.strictEqual(
        yield* sessions.readCatalogEndpointReceipt(threadId),
        initial === "confirmed" || initial === "new-thread" ? config : undefined,
      );
      yield* test.publish(
        decodeNativeEvent({
          id: "evt_catalog_started",
          type: "session.execution.started",
          created: 1,
          durable: { aggregateID: "ses_root", seq: 1, version: 1 },
          data: { sessionID: "ses_root" },
        }),
      );
      yield* test.publish(
        decodeNativeEvent({
          id: "evt_catalog_end",
          type: "session.execution.succeeded",
          created: 2,
          durable: { aggregateID: "ses_root", seq: 2, version: 1 },
          data: { sessionID: "ses_root" },
        }),
      );
      yield* sessions.set({ ...config, catalogRevision: 2 });
      if (initial === "new-thread") yield* test.replaceThread;
      yield* test.start();
      assert.notEqual((yield* sessions.readCatalogEndpointReceipt(threadId))?.catalogRevision, 2);
      assert.equal(test.calls.filter((call) => call.path.endsWith("/prompt")).length, 2);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each(["endpoint", "credential"] as const)(
  "OpenCode 2 keeps cached catalog history across failed config rollback: %s",
  (transition) =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const threadId = ThreadId.make("opencode-thread");
      const config = {
        environmentId: EnvironmentId.make("environment"),
        threadId,
        providerSessionId: "mcp-catalog",
        providerInstanceId: ProviderInstanceId.make("opencode-test"),
        nativeRuntimeId: "native-runtime-catalog",
        catalogRevision: 1,
        endpoint: "http://t3.test/mcp",
        catalogEndpoint: "http://t3.test/mcp/catalog/mcp-catalog",
        authorizationHeader: "Bearer test-catalog-only",
        browserToolsAvailable: false,
      };
      yield* sessions.set(config);
      const test = yield* fixture({
        external: false,
        failedTransition: true,
      });
      yield* test.start();
      assert.strictEqual(yield* sessions.readCatalogEndpointReceipt(threadId), config);
      yield* test.publish(
        decodeNativeEvent({
          id: "evt_catalog_started",
          type: "session.execution.started",
          created: 1,
          durable: { aggregateID: "ses_root", seq: 1, version: 1 },
          data: { sessionID: "ses_root" },
        }),
      );
      yield* test.publish(
        decodeNativeEvent({
          id: "evt_catalog_end",
          type: "session.execution.succeeded",
          created: 2,
          durable: { aggregateID: "ses_root", seq: 2, version: 1 },
          data: { sessionID: "ses_root" },
        }),
      );
      yield* sessions.set({
        ...config,
        catalogRevision: 2,
        ...(transition === "endpoint"
          ? { catalogEndpoint: config.catalogEndpoint + "-candidate" }
          : { authorizationHeader: config.authorizationHeader + "-candidate" }),
      });
      yield* test.start();
      yield* test.publish(
        decodeNativeEvent({
          id: "evt_candidate_started",
          type: "session.execution.started",
          created: 3,
          durable: { aggregateID: "ses_root", seq: 3, version: 1 },
          data: { sessionID: "ses_root" },
        }),
      );
      yield* test.publish(
        decodeNativeEvent({
          id: "evt_candidate_ended",
          type: "session.execution.succeeded",
          created: 4,
          durable: { aggregateID: "ses_root", seq: 4, version: 1 },
          data: { sessionID: "ses_root" },
        }),
      );
      yield* sessions.set({ ...config, catalogRevision: 2 });

      yield* test.start();
      const nativeCatalogs = [...test.nativeConfigurations].filter(([name]) =>
        name.endsWith("_catalog"),
      );
      assert.equal(nativeCatalogs.length, 1);
      assert.equal(nativeCatalogs[0]![1].connections, 1);
      assert.include(nativeCatalogs[0]![1].config, config.catalogEndpoint);
      assert.notInclude(nativeCatalogs[0]![1].config, "-candidate");
      assert.notEqual((yield* sessions.readCatalogEndpointReceipt(threadId))?.catalogRevision, 2);
      assert.equal(test.calls.filter((call) => call.path.endsWith("/prompt")).length, 3);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
