/**
 * Runtime-level collab regression: boots the REAL CodexSessionRuntime against
 * a scripted mock app-server peer that replays the captured multi-agent wire
 * sequence (codexMultiAgentWire.json) plus the shapes the capture alone can't
 * script (receiver-turn bookkeeping via collabAgentToolCall, child terminal
 * lifecycle, approval pass-through). This is the layer the pure routing-table
 * test can't reach: ordering between the legacy receiver-turn suppressor and
 * v2 interception, registration state, and synthetic event emission.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  RuntimeAgentKey,
  type ProviderApprovalDecision,
  type ProviderEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const ROOT = wireFixture.rootThreadId;
const [CHILD_A, CHILD_B] = wireFixture.childThreadIds as [string, string];
const MEMORY = "memory-consolidation-thread";
const decodeMcpElicitationResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.Unknown,
    }),
  ),
);
const decodeCodexApprovalResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.Struct({ decision: Schema.String }),
    }),
  ),
);
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * The captured sequence, extended with the shapes the live capture didn't
 * include: a collabAgentToolCall with receiverThreadIds (feeds the legacy
 * receiver-turn map, so ordering vs. v2 interception is exercised), child
 * terminal lifecycle, and a serverRequest/resolved addressed to a child
 * (must pass through to the parent path, not vanish).
 */
function buildScript() {
  const captured = wireFixture.notifications;
  const extras = [
    {
      method: "item/completed",
      params: {
        threadId: ROOT,
        item: {
          type: "collabAgentToolCall",
          id: "call_fixture_wait",
          tool: "wait",
          status: "completed",
          senderThreadId: ROOT,
          receiverThreadIds: [CHILD_A, CHILD_B],
        },
      },
    },
    // Child terminal lifecycle AFTER the receiver map knows the children —
    // pre-fix, the legacy suppressor dropped these before interception saw
    // them, so no synthetic agent events were emitted.
    {
      method: "turn/completed",
      params: {
        threadId: CHILD_A,
        turn: { id: `${CHILD_A}-turn-1`, status: "completed", items: [] },
      },
    },
    { method: "thread/closed", params: { threadId: CHILD_B } },
    // Parent-owned traffic addressed to a child conversation: must reach the
    // parent path (approval correlation cleanup), not be swallowed.
    { method: "serverRequest/resolved", params: { threadId: CHILD_A, requestId: "req-1" } },
  ];
  return {
    rootThreadId: ROOT,
    notifications: [...captured.filter((entry) => entry.method !== "turn/completed"), ...extras],
  };
}

function capturedStartedActivity(childId = CHILD_A) {
  const captured = wireFixture.notifications.find((entry) => {
    const item = (entry.params as { item?: { type?: string; kind?: string } }).item;
    return item?.type === "subAgentActivity" && item.kind === "started";
  });
  assert.isDefined(captured);
  return {
    ...captured,
    params: {
      ...captured.params,
      item: {
        ...captured.params.item,
        agentThreadId: childId,
        agentPath: "/root/model-check",
      },
    },
  };
}

function capturedSpawnedThread(childId = CHILD_A, parentThreadId = ROOT) {
  const captured = wireFixture.notifications.find((entry) => entry.method === "thread/started");
  assert.isDefined(captured);
  return {
    ...captured,
    params: {
      thread: {
        ...captured.params.thread,
        id: childId,
        sessionId: childId,
        parentThreadId,
        agentNickname: "model-check",
        agentRole: "verifier",
        source: {
          subAgent: {
            thread_spawn: {
              agent_nickname: "model-check",
              agent_path: "/root/model-check",
              agent_role: "verifier",
              depth: 1,
              parent_thread_id: parentThreadId,
            },
          },
        },
      },
    },
  };
}

function childSettings(threadId: string, model: string, effort: string) {
  return {
    method: "thread/settings/updated",
    params: {
      threadId,
      threadSettings: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        collaborationMode: { mode: "default", settings: { model } },
        cwd: "/workspace/repo",
        effort,
        model,
        modelProvider: "openai",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    },
  };
}

function readRecordedRequests() {
  return NodeFS.readFileSync(`${scriptPath}.requests`, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

function readRecordedApprovalInjections() {
  return NodeFS.readFileSync(`${scriptPath}.injections`, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.collab-script.json");
// Windows cannot run the shebang wrapper; the .cmd sibling does the same job.
const peerPath = NodePath.join(
  import.meta.dirname,
  `../testFixtures/codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
);

describe("CodexSessionRuntime collab integration", () => {
  it.effect("keeps child assistant deltas and final text on the registered child identity", () =>
    Effect.gen(function* () {
      const childTurnId = `${CHILD_A}-turn-1`;
      const script = {
        rootThreadId: ROOT,
        notifications: [
          capturedSpawnedThread(CHILD_A),
          {
            method: "item/agentMessage/delta",
            params: {
              threadId: CHILD_A,
              turnId: childTurnId,
              itemId: "child-message-1",
              delta: "Child answer",
            },
          },
          {
            method: "item/reasoning/textDelta",
            params: {
              threadId: CHILD_A,
              turnId: childTurnId,
              itemId: "child-reasoning-1",
              contentIndex: 0,
              delta: "The child considered the evidence.",
            },
          },
          {
            method: "item/completed",
            params: {
              threadId: CHILD_A,
              turnId: childTurnId,
              completedAtMs: 1_778_000_000_000,
              item: {
                type: "reasoning",
                id: "child-reasoning-1",
                content: ["The child considered the evidence."],
              },
            },
          },
          {
            method: "item/completed",
            params: {
              threadId: CHILD_A,
              turnId: childTurnId,
              completedAtMs: 1_778_000_000_000,
              item: {
                type: "agentMessage",
                id: "child-message-1",
                text: "Child answer",
                phase: "final_answer",
              },
            },
          },
          {
            method: "turn/completed",
            params: {
              threadId: ROOT,
              turn: { id: `${ROOT}-turn-1`, status: "completed", items: [] },
            },
          },
        ],
        childResumeSnapshots: {
          [CHILD_A]: { model: "child-model", notifications: [] },
        },
      };
      NodeFS.writeFileSync(scriptPath, encodeUnknownJsonString(script), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-child-transcript"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "start child transcript" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const childDelta = events.find((event) => event.method === "collabAgent/messageDelta");
      const childReasoningDelta = events.find(
        (event) => event.method === "collabAgent/reasoningDelta",
      );
      const childCompletion = events.find(
        (event) =>
          event.method === "collabAgent/item" &&
          (event.payload as { lifecycle?: string; item?: { type?: string } }).lifecycle ===
            "item/completed" &&
          (event.payload as { item?: { type?: string } }).item?.type === "agentMessage",
      );
      const childReasoningCompletion = events.find(
        (event) =>
          event.method === "collabAgent/item" &&
          (event.payload as { lifecycle?: string; item?: { type?: string } }).lifecycle ===
            "item/completed" &&
          (event.payload as { item?: { type?: string } }).item?.type === "reasoning",
      );
      assert.isDefined(childDelta);
      assert.isDefined(childReasoningDelta);
      assert.isDefined(childCompletion);
      assert.isDefined(childReasoningCompletion);
      assert.equal(childDelta?.itemId, "child-message-1");
      assert.equal(childDelta?.textDelta, "Child answer");
      assert.equal(
        childDelta?.agentKey,
        (childDelta?.payload as { agentKey?: string } | undefined)?.agentKey,
      );
      assert.equal(childReasoningDelta?.itemId, "child-reasoning-1");
      assert.equal(childReasoningDelta?.textDelta, "The child considered the evidence.");
      assert.equal(childReasoningDelta?.agentKey, childDelta?.agentKey);
      assert.equal(childCompletion?.itemId, "child-message-1");
      assert.equal(childCompletion?.agentKey, childDelta?.agentKey);
      assert.equal(childReasoningCompletion?.itemId, "child-reasoning-1");
      assert.equal(childReasoningCompletion?.agentKey, childDelta?.agentKey);
      const completionPayload = childCompletion?.payload as
        | {
            agentThreadId?: string;
            lifecycle?: string;
            item?: { type?: string; id?: string; text?: string };
          }
        | undefined;
      assert.equal(completionPayload?.agentThreadId, CHILD_A);
      assert.equal(completionPayload?.lifecycle, "item/completed");
      assert.equal(completionPayload?.item?.type, "agentMessage");
      assert.equal(completionPayload?.item?.id, "child-message-1");
      assert.equal(completionPayload?.item?.text, "Child answer");
      assert.isFalse(
        events.some(
          (event) =>
            event.method === "item/agentMessage/delta" ||
            event.method === "item/reasoning/textDelta",
        ),
      );
      assert.isTrue(events.some((event) => event.method === "turn/completed"));

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("selected child Stop interrupts one Codex child and waits for its terminal turn", () =>
    Effect.gen(function* () {
      const childTurnA = `${CHILD_A}-selected-stop-turn`;
      const childTurnB = `${CHILD_B}-sibling-turn`;
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        interruptCompletionFor: CHILD_A,
        notifications: [
          capturedSpawnedThread(CHILD_A),
          capturedSpawnedThread(CHILD_B),
          {
            method: "turn/started",
            params: {
              threadId: CHILD_A,
              turn: {
                id: childTurnA,
                items: [],
                itemsView: "notLoaded",
                status: "inProgress",
                error: null,
                startedAt: 1_778_000_000,
                completedAt: null,
                durationMs: null,
              },
            },
          },
          {
            method: "turn/started",
            params: {
              threadId: CHILD_B,
              turn: {
                id: childTurnB,
                items: [],
                itemsView: "notLoaded",
                status: "inProgress",
                error: null,
                startedAt: 1_778_000_000,
                completedAt: null,
                durationMs: null,
              },
            },
          },
        ],
      };
      NodeFS.writeFileSync(scriptPath, encodeUnknownJsonString(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-selected-stop"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const childStarted = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/turnStarted" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "start two child turns" });
      const childEvent = Array.from(yield* Fiber.join(childStarted))[0];
      assert.isDefined(childEvent);
      const agentKey = (childEvent?.payload as { agentKey?: string } | undefined)?.agentKey;
      assert.isString(agentKey);
      if (typeof agentKey !== "string") return;

      assert.deepEqual(yield* runtime.getAgentActionCapabilities(RuntimeAgentKey.make(agentKey)), {
        message: "unsupported",
        answerRequests: "unsupported",
        stop: "supported",
      });
      const results = yield* Effect.all(
        [
          runtime.stopAgent(RuntimeAgentKey.make(agentKey)),
          runtime.stopAgent(RuntimeAgentKey.make(agentKey)),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results, ["completed", "completed"]);
      const interrupts = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { threadId?: string; turnId?: string });
      assert.deepEqual(interrupts, [{ threadId: CHILD_A, turnId: childTurnA }]);
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("looks up child model metadata once after activity registration", () =>
    Effect.gen(function* () {
      const script = {
        rootThreadId: ROOT,
        recordRequests: true,
        notifications: [
          capturedStartedActivity(),
          capturedStartedActivity(),
          {
            ...capturedStartedActivity(CHILD_B),
            params: {
              ...capturedStartedActivity(CHILD_B).params,
              item: { ...capturedStartedActivity(CHILD_B).params.item, kind: "interacted" },
            },
          },
          { method: "thread/closed", params: { threadId: CHILD_B } },
          capturedSpawnedThread(ROOT),
        ],
        childResumeSnapshots: {
          [CHILD_A]: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-model-activity"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const metadataFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/metadataUpdated" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      const session = yield* runtime.start();
      assert.equal(session.model, "gpt-5.6-sol");
      yield* runtime.sendTurn({ input: "start one child" });
      const metadataEvents = Array.from(yield* Fiber.join(metadataFiber));
      assert.deepInclude(metadataEvents[0]?.payload, {
        agentThreadId: CHILD_A,
        model: "gpt-5.6-luna",
        effort: "low",
      });
      assert.deepEqual(readRecordedRequests(), [
        {
          method: "thread/resume",
          params: { threadId: CHILD_A, excludeTurns: true },
        },
      ]);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("maps nested child parent thread ids to opaque parent agent keys", () =>
    Effect.gen(function* () {
      const script = {
        rootThreadId: ROOT,
        notifications: [capturedSpawnedThread(CHILD_A), capturedSpawnedThread(CHILD_B, CHILD_A)],
        childResumeSnapshots: {
          [CHILD_A]: { model: "child-model", notifications: [] },
          [CHILD_B]: { model: "nested-model", notifications: [] },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-nested-linkage"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const eventsFiber = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === "collabAgent/started"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "start nested children" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const parent = events.find(
        (event) => (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      const nested = events.find(
        (event) => (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
      );
      const parentPayload = parent?.payload as
        | { agentKey?: string; parentThreadId?: string }
        | undefined;
      const nestedPayload = nested?.payload as
        | { agentKey?: string; parentAgentKey?: string; parentThreadId?: string }
        | undefined;
      assert.isString(parentPayload?.agentKey);
      assert.equal(nestedPayload?.parentAgentKey, parentPayload?.agentKey);
      assert.notEqual(parentPayload?.agentKey, CHILD_A);
      assert.equal(parentPayload?.parentThreadId, undefined);
      assert.equal(nestedPayload?.parentThreadId, undefined);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps child settings and reroutes newer than the resume snapshot", () =>
    Effect.gen(function* () {
      const statusChanged = wireFixture.notifications.find(
        (entry) =>
          entry.method === "thread/status/changed" &&
          (entry.params as { threadId?: string }).threadId === CHILD_A,
      );
      assert.isDefined(statusChanged);
      const script = {
        rootThreadId: ROOT,
        recordRequests: true,
        notifications: [
          childSettings(CHILD_A, "child-before", "medium"),
          capturedSpawnedThread(),
          childSettings(CHILD_A, "child-after", "high"),
          {
            method: "model/rerouted",
            params: {
              threadId: CHILD_A,
              turnId: `${CHILD_A}-turn`,
              fromModel: "child-after",
              toModel: "child-rerouted",
              reason: "highRiskCyberActivity",
            },
          },
          {
            method: "model/rerouted",
            params: {
              threadId: ROOT,
              turnId: `${ROOT}-turn`,
              fromModel: "gpt-5.6-sol",
              toModel: "root-rerouted",
              reason: "highRiskCyberActivity",
            },
          },
        ],
        childResumeSnapshots: {
          [CHILD_A]: {
            model: "stale-snapshot",
            reasoningEffort: "low",
            notifications: [statusChanged],
          },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-model-spawn"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.method === "collabAgent/statusChanged" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "start one spawned child" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const started = events.find((event) => event.method === "collabAgent/started");
      assert.deepInclude(started?.payload, {
        agentThreadId: CHILD_A,
        model: "child-before",
        effort: "medium",
      });
      const startedPayload = started?.payload as { agentKey?: unknown } | undefined;
      assert.equal(typeof startedPayload?.agentKey, "string");
      assert.notEqual(startedPayload?.agentKey, CHILD_A);
      const childStatus = events.find((event) => event.method === "collabAgent/statusChanged");
      assert.deepInclude(childStatus?.payload, {
        agentThreadId: CHILD_A,
        model: "child-rerouted",
        effort: "high",
      });
      assert.isTrue(
        events.some(
          (event) =>
            event.method === "model/rerouted" &&
            (event.payload as { threadId?: string }).threadId === ROOT,
        ),
        "the root reroute must stay on the parent path",
      );
      assert.isFalse(
        events.some(
          (event) =>
            (event.method === "thread/settings/updated" || event.method === "model/rerouted") &&
            (event.payload as { threadId?: string }).threadId === CHILD_A,
        ),
        "child metadata notifications must not leak to the parent path",
      );
      assert.equal(readRecordedRequests().length, 1);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not delay the parent turn when the child lookup fails", () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );
      for (const [name, childSnapshot] of [
        ["hang", { hang: true }],
        ["error", { error: "child unavailable" }],
      ] as const) {
        yield* Effect.gen(function* () {
          const marker = `lookup-${name}`;
          const script = {
            rootThreadId: ROOT,
            recordRequests: true,
            resumeRequestMarker: marker,
            notifications: [capturedStartedActivity()],
            childResumeSnapshots: { [CHILD_A]: childSnapshot },
          };
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });

          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make(`thread-collab-model-${name}`),
            binaryPath: peerPath,
            cwd: NodeOS.tmpdir(),
            runtimeMode: "full-access",
            environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
          });
          const eventsFiber = yield* runtime.events.pipe(
            Stream.takeUntil(
              (event) =>
                event.method === "serverRequest/resolved" &&
                (event.payload as { requestId?: string }).requestId === marker,
            ),
            Stream.runCollect,
            Effect.forkScoped,
          );

          yield* runtime.start();
          yield* runtime.sendTurn({ input: "finish without child metadata" });
          const events = Array.from(yield* Fiber.join(eventsFiber));
          assert.isTrue(events.some((event) => event.method === "turn/completed"));
          assert.equal(readRecordedRequests().length, 1);

          yield* runtime.close;
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }).pipe(Effect.scoped);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replays the captured fan-out into synthetic agent events without child leaks", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildScript()), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-integration"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const methods = events.map((event) => event.method);

      // Children registered from subAgentActivity become synthetic agent
      // lifecycle — including terminal rows that arrive AFTER the receiver
      // map knows them (the ordering this test exists to pin).
      assert.include(methods, "collabAgent/activity");
      assert.include(methods, "collabAgent/turnCompleted");
      assert.include(methods, "collabAgent/closed");

      const childTurnCompleted = events.find(
        (event) =>
          event.method === "collabAgent/turnCompleted" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.isDefined(childTurnCompleted, "child A's turn completion becomes an agent event");

      const childClosed = events.find(
        (event) =>
          event.method === "collabAgent/closed" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
      );
      assert.isDefined(childClosed, "child B's close becomes an agent event");

      // Parent-owned resolution passes through — not swallowed, not
      // re-labelled as an agent event.
      assert.include(methods, "serverRequest/resolved");

      // The root's own subAgentActivity about "/root" must NOT register the
      // root as a child: the parent turn completion still flows.
      assert.include(methods, "turn/completed");

      // No raw child conversation methods leak onto the parent stream.
      const leaked = events.filter((event) => {
        const payload = event.payload as { threadId?: string } | undefined;
        const addressedToChild = payload?.threadId === CHILD_A || payload?.threadId === CHILD_B;
        return addressedToChild && (event.method?.startsWith("thread/") ?? false);
      });
      assert.deepEqual(
        leaked.map((event) => event.method),
        [],
        "child thread/* lifecycle must not appear as parent events",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // it.live: the runtime talks to a real child process; under it.effect's
  // TestClock the internal timers freeze and the join never completes.
  it.live("Stop interrupts every live child regardless of registration timing", () =>
    Effect.gen(function* () {
      // Ordering + liveness torture for stop-everything: child A's
      // turn/started arrives BEFORE anything registers it (foreign
      // suppression path must record the live turn); child B's arrives after
      // registration; child A's interrupt HANGS (RPC never settles — worse
      // than rejecting) and the bounded deadline must still deliver B's and
      // the parent's interrupts. The turn stays open so children are live
      // when Stop fires.
      // Build from REAL captured rows (hand-written shapes fail notification
      // schema validation and are silently dropped): reorder so child A's
      // turn/started precedes its registration, and drop terminal rows so
      // children stay live when Stop fires.
      const byIndex = wireFixture.notifications;
      const isTurnStarted = (entry: (typeof byIndex)[number], child: string) =>
        entry.method === "turn/started" &&
        (entry.params as { threadId?: string }).threadId === child;
      const isRegistration = (entry: (typeof byIndex)[number], child: string) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === child;
      };
      const turnStartedA = byIndex.find((entry) => isTurnStarted(entry, CHILD_A));
      const turnStartedB = byIndex.find((entry) => isTurnStarted(entry, CHILD_B));
      const registrationA = byIndex.find((entry) => isRegistration(entry, CHILD_A));
      const registrationB = byIndex.find((entry) => isRegistration(entry, CHILD_B));
      const rootThreadStarted = byIndex.find((entry) => entry.method === "thread/started");
      assert.isDefined(turnStartedA);
      assert.isDefined(turnStartedB);
      assert.isDefined(registrationA);
      assert.isDefined(registrationB);
      assert.isDefined(rootThreadStarted);
      const memoryThreadStarted = {
        ...rootThreadStarted,
        params: {
          thread: {
            ...rootThreadStarted.params.thread,
            id: MEMORY,
            sessionId: MEMORY,
            source: "unknown",
            threadSource: "memory_consolidation",
          },
        },
      };
      const memoryTurnStarted = {
        ...turnStartedA,
        params: {
          ...turnStartedA.params,
          threadId: MEMORY,
          turn: { ...turnStartedA.params.turn, id: "memory-consolidation-turn" },
        },
      };
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        hangInterruptFor: CHILD_A,
        notifications: [
          turnStartedA,
          registrationA,
          memoryThreadStarted,
          memoryTurnStarted,
          registrationB,
          turnStartedB,
        ],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-stop"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      // Wait for both children's turnStarted signals to be processed before
      // stopping (B via the registered-child path; A only produces live-turn
      // bookkeeping, so key on B's synthetic event).
      const childBStartedFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/turnStarted" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out and hang" });
      const childBStarted = yield* Fiber.join(childBStartedFiber).pipe(
        Effect.timeoutOption("15 seconds"),
      );
      assert.isTrue(childBStarted._tag === "Some", "child B turnStarted never arrived");

      // Stop everything. A's interrupt hangs forever — the bounded child
      // deadline must expire and the parent interrupt must still be sent.
      yield* runtime.interruptTurn();

      const parseInterruptLine = (line: string) => JSON.parse(line) as { threadId?: string };
      const interrupted = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseInterruptLine);
      const interruptedThreads = new Set(interrupted.map((entry) => entry.threadId));
      assert.isTrue(
        interruptedThreads.has(CHILD_A),
        "pre-registration child A must still receive the interrupt RPC",
      );
      assert.isTrue(interruptedThreads.has(CHILD_B), "registered child B must be interrupted");
      assert.isTrue(
        interruptedThreads.has(MEMORY),
        "memory consolidation must be interrupted without appearing in chat",
      );
      assert.isTrue(interruptedThreads.has(ROOT), "parent turn must be interrupted last");

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("Stop targets the active turn when Codex has accepted a queued follow-up", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const queuedTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        onlyFirstTurnStarts: true,
        turnIds: [activeTurnId, queuedTurnId],
        expectedActiveTurnId: activeTurnId,
        notifications: [],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-queued-stop"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      yield* runtime.sendTurn({ input: "queued follow-up" });
      yield* runtime.interruptTurn();

      const interrupts = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { threadId?: string; turnId?: string });
      assert.deepEqual(interrupts.at(-1), {
        threadId: ROOT,
        turnId: activeTurnId,
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  const elicitationCases = [
    {
      decision: "accept",
      response: { action: "accept", content: { approval: "once" } },
    },
    {
      decision: "acceptForSession",
      response: {
        action: "accept",
        _meta: { persist: "session" },
        content: { approval: "session" },
      },
    },
    {
      decision: "acceptAlways",
      response: {
        action: "accept",
        _meta: { persist: "always" },
        content: { approval: "always" },
      },
    },
    { decision: "decline", response: { action: "decline" } },
    { decision: "cancel", response: { action: "cancel" } },
  ] satisfies ReadonlyArray<{
    readonly decision: ProviderApprovalDecision;
    readonly response: Record<string, unknown>;
  }>;

  for (const { decision, response } of elicitationCases) {
    it.live(`returns the MCP elicitation ${decision} response to Codex`, () =>
      Effect.gen(function* () {
        const scriptedRequest = {
          id: 7001,
          method: "mcpServer/elicitation/request",
          params: {
            mode: "form",
            message: "Allow ChatGPT to use Safari?",
            serverName: "computer-use",
            threadId: ROOT,
            turnId: wireFixture.responses.turnStart.turn.id,
            _meta: { app_name: "Safari", persist: ["session", "always"] },
            requestedSchema: {
              type: "object",
              properties: {
                approval: {
                  type: "string",
                  enum: ["once", "session", "always"],
                },
              },
              required: ["approval"],
            },
          },
        };
        const script = {
          rootThreadId: ROOT,
          holdTurnOpen: true,
          completeTurnOnServerResponse: true,
          notifications: [],
          serverRequests: [scriptedRequest],
        };
        const responsesPath = `${scriptPath}.responses`;
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
        NodeFS.rmSync(responsesPath, { force: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeFS.rmSync(scriptPath, { force: true });
            NodeFS.rmSync(responsesPath, { force: true });
          }),
        );

        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-codex-mcp-elicitation"),
          binaryPath: peerPath,
          cwd: NodeOS.tmpdir(),
          runtimeMode: "auto",
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const approvalRequested = yield* Deferred.make<ProviderEvent>();
        const turnCompleted = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            event.method === "mcpServer/elicitation/request"
              ? Deferred.succeed(approvalRequested, event).pipe(Effect.asVoid)
              : event.method === "turn/completed"
                ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
                : Effect.void,
          ),
          Effect.forkScoped,
        );

        yield* runtime.start();
        yield* runtime.sendTurn({ input: "Open Safari" });
        const approval = yield* Deferred.await(approvalRequested);
        assert.equal(approval.requestKind, "mcp-elicitation");
        assert.isDefined(approval.requestId);
        if (approval.requestId === undefined) return;

        yield* runtime.respondToRequest(approval.requestId, decision);
        yield* Deferred.await(turnCompleted);

        const recordedResponse = yield* decodeMcpElicitationResponse(
          NodeFS.readFileSync(responsesPath, "utf8"),
        );
        assert.equal(recordedResponse.id, scriptedRequest.id);
        assert.deepEqual(recordedResponse.result, response);

        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.live("answers a child free-text MCP elicitation and hands the exact value to its parent", () =>
    Effect.gen(function* () {
      const scriptedRequest = {
        id: 7004,
        method: "mcpServer/elicitation/request",
        params: {
          mode: "form",
          message: "Which deployment token should the child use?",
          serverName: "native-question",
          threadId: CHILD_A,
          turnId: wireFixture.responses.turnStart.turn.id,
          requestedSchema: {
            type: "object",
            properties: {
              deployment_token: {
                type: "string",
                title: "Deployment token",
                description: "Enter the exact token value.",
              },
            },
            required: ["deployment_token"],
          },
        },
      };
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        completeTurnOnServerResponse: true,
        notifications: [capturedSpawnedThread(), capturedStartedActivity()],
        serverRequests: [scriptedRequest],
      };
      const responsesPath = `${scriptPath}.responses`;
      const injectionsPath = `${scriptPath}.injections`;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(responsesPath, { force: true });
      NodeFS.writeFileSync(injectionsPath, "", "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(responsesPath, { force: true });
          NodeFS.rmSync(injectionsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-child-mcp-question"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "auto",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const questionRequested = yield* Deferred.make<ProviderEvent>();
      const turnCompleted = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          event.method === "mcpServer/elicitation/request" &&
          (event.payload as { threadId?: string }).threadId === CHILD_A
            ? Deferred.succeed(questionRequested, event).pipe(Effect.asVoid)
            : event.method === "turn/completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        ),
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Have the child ask for its deployment token." });
      const question = yield* Deferred.await(questionRequested);
      assert.equal(typeof question.agentKey, "string");
      assert.isDefined(question.requestId);
      if (question.requestId === undefined) return;

      const result = yield* runtime.resolveUserInput(question.requestId, {
        type: "answered",
        answers: { deployment_token: "" },
      });
      assert.equal(result.nativeStatus, "answered");
      assert.equal(result.handoffStatus, "recorded");
      assert.equal(result.nativeRequestId, "7004");
      assert.equal(result.agentKey, question.agentKey);
      yield* Deferred.await(turnCompleted);

      const responseLine = NodeFS.readFileSync(responsesPath, "utf8").trim().split(/\r?\n/).at(-1);
      if (responseLine === undefined) throw new Error("MCP elicitation response was not recorded");
      const recordedResponse = yield* decodeMcpElicitationResponse(responseLine);
      assert.equal(recordedResponse.id, scriptedRequest.id);
      assert.deepEqual(recordedResponse.result, {
        action: "accept",
        content: { deployment_token: "" },
      });

      const [injection] = readRecordedApprovalInjections();
      assert.isDefined(injection, "the child answer was not injected into its parent");
      assert.equal(injection.params.threadId, ROOT);
      assert.match(encodeUnknownJsonString(injection.params.items), /deployment_token/);
      assert.match(encodeUnknownJsonString(injection.params.items), /does not claim.*succeeded/);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("settles a child MCP question when parent-history injection is interrupted", () =>
    Effect.gen(function* () {
      const scriptedRequest = {
        id: 7005,
        method: "mcpServer/elicitation/request",
        params: {
          mode: "form",
          message: "Which deployment token should the child use?",
          serverName: "native-question",
          threadId: CHILD_A,
          turnId: wireFixture.responses.turnStart.turn.id,
          requestedSchema: {
            type: "object",
            properties: { deployment_token: { type: "string" } },
            required: ["deployment_token"],
          },
        },
      };
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        completeTurnOnServerResponse: true,
        hangInjectFor: ROOT,
        notifications: [capturedSpawnedThread(), capturedStartedActivity()],
        serverRequests: [scriptedRequest],
      };
      const responsesPath = `${scriptPath}.responses`;
      const injectionsPath = `${scriptPath}.injections`;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(responsesPath, { force: true });
      NodeFS.writeFileSync(injectionsPath, "", "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(responsesPath, { force: true });
          NodeFS.rmSync(injectionsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-interrupted-child-question"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "auto",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const questionRequested = yield* Deferred.make<ProviderEvent>();
      const turnCompleted = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          event.method === "mcpServer/elicitation/request" &&
          (event.payload as { threadId?: string }).threadId === CHILD_A
            ? Deferred.succeed(questionRequested, event).pipe(Effect.asVoid)
            : event.method === "turn/completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        ),
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Have the child ask for its deployment token." });
      const question = yield* Deferred.await(questionRequested);
      assert.isDefined(question.requestId);
      if (question.requestId === undefined) return;

      let stopWaitingForInjection = () => {};
      const injectionStarted = new Promise<void>((resolve) => {
        const watcher = NodeFS.watch(injectionsPath, () => {
          if (NodeFS.readFileSync(injectionsPath, "utf8").trim().length === 0) return;
          watcher.close();
          resolve();
        });
        stopWaitingForInjection = () => watcher.close();
      });
      yield* Effect.addFinalizer(() => Effect.sync(stopWaitingForInjection));
      const responseFiber = yield* runtime
        .resolveUserInput(question.requestId, {
          type: "answered",
          answers: { deployment_token: "EXACT_DEPLOYMENT_TOKEN" },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => injectionStarted);
      yield* Fiber.interrupt(responseFiber);

      const completed = yield* Deferred.await(turnCompleted).pipe(Effect.timeoutOption("1 second"));
      if (completed._tag !== "Some") {
        throw new Error("native question was not answered after injection cancellation");
      }
      const responseLine = NodeFS.readFileSync(responsesPath, "utf8").trim().split(/\r?\n/).at(-1);
      if (responseLine === undefined) throw new Error("MCP elicitation response was not recorded");
      const recordedResponse = yield* decodeMcpElicitationResponse(responseLine);
      assert.deepEqual(recordedResponse.result, {
        action: "accept",
        content: { deployment_token: "EXACT_DEPLOYMENT_TOKEN" },
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("answers a child Codex approval with its native callback identity", () =>
    Effect.gen(function* () {
      const nativeApprovalId = "native-approval-callback-7002";
      const scriptedRequest = {
        id: 7002,
        method: "item/commandExecution/requestApproval",
        params: {
          approvalId: nativeApprovalId,
          itemId: "native-command-item-7002",
          command: "open Safari",
          cwd: "/tmp",
          startedAtMs: 1_778_000_001_000,
          threadId: CHILD_A,
          turnId: wireFixture.responses.turnStart.turn.id,
        },
      };
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        completeTurnOnServerResponse: true,
        notifications: [capturedSpawnedThread(), capturedStartedActivity()],
        serverRequests: [scriptedRequest],
      };
      const responsesPath = `${scriptPath}.responses`;
      const injectionsPath = `${scriptPath}.injections`;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(responsesPath, { force: true });
      NodeFS.writeFileSync(injectionsPath, "", "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(responsesPath, { force: true });
          NodeFS.rmSync(injectionsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-child-approval"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "auto",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const approvalRequested = yield* Deferred.make<ProviderEvent>();
      const childStarted = yield* Deferred.make<ProviderEvent>();
      const turnCompleted = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          event.method === "item/commandExecution/requestApproval"
            ? Deferred.succeed(approvalRequested, event).pipe(Effect.asVoid)
            : event.method === "collabAgent/started" &&
                (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A
              ? Deferred.succeed(childStarted, event).pipe(Effect.asVoid)
              : event.method === "turn/completed"
                ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
                : Effect.void,
        ),
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Have the child request approval" });
      const approval = yield* Deferred.await(approvalRequested);
      assert.equal(approval.requestKind, "command");
      assert.equal(typeof approval.agentKey, "string");
      assert.notEqual(approval.agentKey, CHILD_A);
      assert.equal(approval.agentTitle, "Subagent");
      const child = yield* Deferred.await(childStarted);
      assert.equal((child.payload as { agentKey?: string }).agentKey, approval.agentKey);
      assert.equal((child.payload as { nickname?: string }).nickname, "model-check");
      assert.isDefined(approval.requestId);
      if (approval.requestId === undefined) return;

      const approvalResult = yield* runtime.respondToRequest(approval.requestId, "accept");
      assert.equal(approvalResult.nativeStatus, "responded");
      assert.equal(approvalResult.handoffStatus, "recorded");
      assert.equal(approvalResult.requestId, approval.requestId);
      assert.equal(approvalResult.nativeRequestId, nativeApprovalId);
      assert.equal(approvalResult.agentKey, approval.agentKey);
      assert.isString(approvalResult.sessionGeneration);
      yield* Deferred.await(turnCompleted);
      const [injection] = readRecordedApprovalInjections();
      assert.isDefined(injection, "the child approval choice was not injected into its parent");
      assert.equal(injection.method, "thread/inject_items");
      assert.equal(injection.params.threadId, ROOT);
      const items = injection.params.items as Array<{
        type?: string;
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
      assert.equal(items[0]?.type, "message");
      assert.equal(items[0]?.role, "developer");
      assert.match(items[0]?.content?.[0]?.text ?? "", /user chose.*accept/i);
      assert.match(items[0]?.content?.[0]?.text ?? "", /does not establish.*ran or succeeded/i);
      const recordedResponseLines = NodeFS.readFileSync(responsesPath, "utf8")
        .trim()
        .split(/\r?\n/);
      const recordedResponseLine = recordedResponseLines.at(-1);
      if (recordedResponseLine === undefined)
        throw new Error("Codex approval response was not recorded");
      const recordedResponse = yield* decodeCodexApprovalResponse(recordedResponseLine);
      assert.equal(recordedResponse.id, scriptedRequest.id);
      assert.deepEqual(recordedResponse.result, { decision: "accept" });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("answers nested Codex approval when immediate-parent injection is unsupported", () =>
    Effect.gen(function* () {
      const scriptedRequest = {
        id: 7003,
        method: "mcpServer/elicitation/request",
        params: {
          mode: "form",
          message: "Allow the nested child to use Safari?",
          serverName: "computer-use",
          threadId: CHILD_B,
          turnId: wireFixture.responses.turnStart.turn.id,
          _meta: { app_name: "Safari" },
          requestedSchema: {
            type: "object",
            properties: { approval: { type: "string", enum: ["once"] } },
            required: ["approval"],
          },
        },
      };
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        completeTurnOnServerResponse: true,
        rejectInjectFor: CHILD_A,
        notifications: [
          capturedSpawnedThread(CHILD_A, ROOT),
          capturedSpawnedThread(CHILD_B, CHILD_A),
        ],
        serverRequests: [scriptedRequest],
      };
      const responsesPath = `${scriptPath}.responses`;
      const injectionsPath = `${scriptPath}.injections`;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(responsesPath, { force: true });
      NodeFS.writeFileSync(injectionsPath, "", "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(responsesPath, { force: true });
          NodeFS.rmSync(injectionsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-nested-child-approval"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "auto",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const approvalRequested = yield* Deferred.make<ProviderEvent>();
      const turnCompleted = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          event.method === "mcpServer/elicitation/request" &&
          (event.payload as { threadId?: string }).threadId === CHILD_B
            ? Deferred.succeed(approvalRequested, event).pipe(Effect.asVoid)
            : event.method === "turn/completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        ),
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Have a nested child request approval" });
      const approval = yield* Deferred.await(approvalRequested);
      assert.equal(typeof approval.agentKey, "string");
      assert.isDefined(approval.requestId);
      if (approval.requestId === undefined) return;

      const approvalResult = yield* runtime.respondToRequest(approval.requestId, "decline");
      assert.equal(approvalResult.nativeStatus, "responded");
      assert.equal(approvalResult.handoffStatus, "unavailable");
      assert.equal(approvalResult.agentKey, approval.agentKey);
      yield* Deferred.await(turnCompleted);
      const [injection] = readRecordedApprovalInjections();
      assert.isDefined(injection, "the nested decision should attempt the immediate parent");
      assert.equal(injection.params.threadId, CHILD_A);
      const recordedResponse = yield* decodeMcpElicitationResponse(
        NodeFS.readFileSync(responsesPath, "utf8"),
      );
      assert.equal(recordedResponse.id, scriptedRequest.id);
      assert.deepEqual(recordedResponse.result, { action: "decline" });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("settles native child approval if parent-history injection is interrupted", () =>
    Effect.gen(function* () {
      const scriptedRequest = {
        id: 7004,
        method: "mcpServer/elicitation/request",
        params: {
          mode: "form",
          message: "Allow the child to use Safari?",
          serverName: "computer-use",
          threadId: CHILD_A,
          turnId: wireFixture.responses.turnStart.turn.id,
          _meta: { app_name: "Safari" },
          requestedSchema: {
            type: "object",
            properties: { approval: { type: "string", enum: ["once"] } },
            required: ["approval"],
          },
        },
      };
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        completeTurnOnServerResponse: true,
        hangInjectFor: ROOT,
        notifications: [capturedSpawnedThread(), capturedStartedActivity()],
        serverRequests: [scriptedRequest],
      };
      const responsesPath = `${scriptPath}.responses`;
      const injectionsPath = `${scriptPath}.injections`;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(responsesPath, { force: true });
      NodeFS.writeFileSync(injectionsPath, "", "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(responsesPath, { force: true });
          NodeFS.rmSync(injectionsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-interrupted-child-approval"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "auto",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const approvalRequested = yield* Deferred.make<ProviderEvent>();
      const turnCompleted = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          event.method === "mcpServer/elicitation/request" &&
          (event.payload as { threadId?: string }).threadId === CHILD_A
            ? Deferred.succeed(approvalRequested, event).pipe(Effect.asVoid)
            : event.method === "turn/completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        ),
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Have a child request approval" });
      const approval = yield* Deferred.await(approvalRequested);
      assert.isDefined(approval.requestId);
      if (approval.requestId === undefined) return;

      let stopWaitingForInjection = () => {};
      const injectionStarted = new Promise<void>((resolve) => {
        const watcher = NodeFS.watch(injectionsPath, () => {
          if (NodeFS.readFileSync(injectionsPath, "utf8").trim().length === 0) return;
          watcher.close();
          resolve();
        });
        stopWaitingForInjection = () => watcher.close();
      });
      yield* Effect.addFinalizer(() => Effect.sync(stopWaitingForInjection));
      const responseFiber = yield* runtime
        .respondToRequest(approval.requestId, "accept")
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => injectionStarted);
      yield* Fiber.interrupt(responseFiber);

      const completed = yield* Deferred.await(turnCompleted).pipe(Effect.timeoutOption("1 second"));
      if (completed._tag !== "Some") {
        throw new Error("native approval was not answered after injection cancellation");
      }
      const recordedResponse = yield* decodeMcpElicitationResponse(
        NodeFS.readFileSync(responsesPath, "utf8"),
      );
      assert.deepEqual(recordedResponse.result, {
        action: "accept",
        content: { approval: "once" },
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
