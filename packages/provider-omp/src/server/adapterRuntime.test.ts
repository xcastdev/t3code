import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderSessionId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  NodeId,
  CheckpointId,
  RunId,
  RunAttemptId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Host from "@t3tools/provider-testing/TestProviderHost";
import * as Ids from "@t3tools/provider-core/server/IdAllocator";
import * as Catalogs from "@t3tools/provider-core/server/McpProviderSessions";
import * as SecretInputs from "@t3tools/provider-core/server/ProviderSecretInputs";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ControlEnvelope } from "./controlChannel.ts";
import { OmpRpcError, type OmpRpcRecord } from "./rpc.ts";
import { makeOmpAdapterV2 } from "./adapter.ts";
import type { OmpSessionOptions } from "./session.ts";
const services = Layer.mergeAll(
  NodeServices.layer,
  Ids.layer,
  Catalogs.layer,
  SecretInputs.layer,
  Host.layer().pipe(Layer.provide(NodeServices.layer)),
);
it.effect.each(["normal", "dead transport", "stop transport", "history unavailable"] as const)(
  "%s: native adapter flushes terminal ownership and projects native lifecycle nodes",
  (scenario) =>
    Effect.gen(function* () {
      const incoming = yield* Queue.unbounded<OmpRpcRecord, OmpRpcError>();
      const controls = yield* Queue.unbounded<ControlEnvelope, OmpRpcError>();
      const sent = yield* Queue.unbounded<OmpRpcRecord>();
      let todoPhases: unknown[] = [
        { name: "Build", tasks: [{ content: "Native task", status: "pending" }] },
      ];
      const denied = yield* Deferred.make<void>();
      let launches = 0;
      let dead = false,
        historyUnavailable = false;
      const failedRequest = yield* Deferred.make<void>();
      const terminated = yield* Deferred.make<void>();
      const streamFailed = yield* Deferred.make<unknown>();
      const eventQueues = [incoming];
      const sentRecords: OmpRpcRecord[] = [];
      let nativeEntries: unknown[] = [];
      let nativeLeaf: string | null = null;
      const connect = Effect.fn("Fixture.connect")(function* (options: OmpSessionOptions) {
        launches++;
        if (options.config.forkEntry !== undefined) nativeLeaf = options.config.forkEntry;
        const currentEvents =
          launches === 1 ? incoming : yield* Queue.unbounded<OmpRpcRecord, OmpRpcError>();
        if (launches > 1) eventQueues.push(currentEvents);
        const currentControls =
          launches === 1 ? controls : yield* Queue.unbounded<ControlEnvelope, OmpRpcError>();
        const state = {
          sessionId: "native",
          model: { id: "base", provider: "p" },
          sessionFile: options.config.sessionDir + "/native.jsonl",
          isSettled: true,
          systemPrompt: [options.config.instructions],
          get todoPhases() {
            return todoPhases;
          },
        };
        return {
          send: (r: OmpRpcRecord) =>
            Effect.sync(() => {
              sentRecords.push(r);
            }).pipe(Effect.andThen(Queue.offer(sent, r)), Effect.asVoid),
          request: (r: OmpRpcRecord) =>
            dead || (historyUnavailable && r.type === "get_entries")
              ? Deferred.succeed(failedRequest, undefined).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new OmpRpcError({
                        operation: r.type,
                        detail: "Fixture connection unavailable",
                      }),
                    ),
                  ),
                )
              : r.type === "abort_and_restore_queue"
                ? Effect.gen(function* () {
                    expect(yield* Deferred.isDone(denied)).toBe(true);
                    return { steering: ["cancelled"], followUp: [] };
                  })
                : Effect.succeed(
                    (
                      {
                        get_state: state,
                        get_entries: { entries: nativeEntries, leafId: nativeLeaf },
                        get_available_models: {
                          models: [{ id: "base", provider: "p", name: "Base" }],
                        },
                        get_available_thinking_levels: { levels: ["off"] },
                        get_available_commands: {
                          commands: [
                            { name: "compact", source: "builtin" },
                            { name: "dump", source: "builtin" },
                          ],
                        },
                      } as Record<string, unknown>
                    )[r.type] ?? {},
                  ),
          events: currentEvents,
          controls: currentControls,
          sendControl: (frame: ControlEnvelope) =>
            frame.type === "approval_answer" && frame.answer === "deny"
              ? Deferred.succeed(denied, undefined).pipe(Effect.asVoid)
              : Effect.void,
          providerSession: "private",
          policyEpoch: "epoch",
          exited: Effect.never,
          terminate: Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
          shutdown: () => Effect.void,
          diagnostics: () => ({ stderrBytes: 0 }),
        };
      });
      const instanceId = ProviderInstanceId.make("omp-test");
      const threadId = ThreadId.make("t");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = {
        cwd: "/workspace",
        runtimeMode: "approval-required",
        interactionMode: "default",
      } as const;
      const adapter = yield* makeOmpAdapterV2(
        {
          instanceId,
          settings: { enabled: false, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
        },
        connect,
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("s"),
        modelSelection,
        runtimePolicy,
      });
      const delivered = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const all: ProviderAdapterV2Event[] = [];
      yield* runtime.events.pipe(
        Stream.runForEach((e) =>
          Effect.sync(() => all.push(e)).pipe(Effect.andThen(Queue.offer(delivered, e))),
        ),
        Effect.catch((cause) => Deferred.succeed(streamFailed, cause).pipe(Effect.asVoid)),
        Effect.forkScoped,
      );
      const take = Effect.fn("Fixture.take")(function* (
        predicate: (e: ProviderAdapterV2Event) => boolean,
      ) {
        for (;;) {
          const event = yield* Queue.take(delivered);
          if (predicate(event)) return event;
        }
      });
      const now = yield* DateTime.now;
      const pendingThreadId = ProviderThreadId.make("pending-thread");
      const pendingThread: OrchestrationV2ProviderThread = {
        id: pendingThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: ProviderSessionId.make("old-session"),
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: null,
        goal: null,
        createdAt: now,
        updatedAt: now,
      };
      if (scenario === "normal")
        for (const mismatch of [
          { driver: ProviderDriverKind.make("pi") },
          { providerInstanceId: ProviderInstanceId.make("other-instance") },
          { appThreadId: ThreadId.make("other-thread") },
          {
            nativeThreadRef: {
              driver: adapter.driver,
              nativeId: "other-native",
              strength: "strong" as const,
            },
          },
        ]) {
          const error = yield* runtime
            .ensureThread({
              threadId,
              modelSelection,
              runtimePolicy,
              existingProviderThread: { ...pendingThread, ...mismatch },
            })
            .pipe(Effect.flip);
          expect(error.message).toContain("identity mismatch");
        }
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
        existingProviderThread: pendingThread,
      });
      expect(providerThread.id).toBe(pendingThreadId);
      expect(providerThread.providerSessionId).toBe(ProviderSessionId.make("s"));
      expect(providerThread.nativeThreadRef?.nativeId).toMatch(/native\.jsonl$/);
      const appThread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("p"),
        title: "Test",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        createdBy: "user",
        creationSource: "web",
      };
      yield* runtime.startTurn({
        appThread,
        threadId,
        runId: RunId.make("r"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("a"),
        rootNodeId: NodeId.make("n"),
        providerThread,
        message: {
          messageId: MessageId.make("u"),
          text: "Hello",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection,
        runtimePolicy,
      });
      const prompt = yield* Queue.take(sent);
      const inputs = yield* SecretInputs.ProviderSecretInputs;
      const openSecret = Effect.fn("Fixture.openSecret")(function* (id: string) {
        yield* Queue.offer(incoming, {
          type: "extension_ui_request",
          id,
          method: "input",
          secret: true,
          title: "Private value",
          placeholder: "token",
        });
        const card = yield* take(
          (e) =>
            e.type === "turn_item.updated" &&
            e.turnItem.type === "secret_request" &&
            e.turnItem.nativeItemRef?.nativeId === "secret:" + id,
        );
        if (card.type !== "turn_item.updated" || card.turnItem.type !== "secret_request")
          throw new Error("Missing secret card");
        expect(card.turnItem).toMatchObject({ secretStatus: "pending", runId: "r", nodeId: "n" });
        const live = yield* inputs.lookup(threadId, card.turnItem.id);
        return { card: card.turnItem, receiver: Option.getOrThrow(live) };
      });
      const secretOutcome = (turnItemId: string) =>
        take(
          (e) =>
            e.type === "turn_item.updated" &&
            e.turnItem.id === turnItemId &&
            e.turnItem.type === "secret_request" &&
            e.turnItem.secretStatus !== "pending",
        );
      const save = { type: "save", secret: Redacted.make("hunter2") } as const;
      if (scenario !== "normal") {
        const pendingSecret = yield* openSecret("terminal-secret");
        dead = scenario !== "history unavailable";
        historyUnavailable = !dead;
        if (scenario === "stop transport") {
          const running = all.find(
            (e) => e.type === "provider_turn.updated" && e.providerTurn.status === "running",
          );
          if (running?.type !== "provider_turn.updated") throw new Error("Missing turn");
          expect(
            (yield* runtime
              .interruptTurn({ providerThread, providerTurnId: running.providerTurn.id })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure");
        } else if (dead)
          yield* Queue.fail(
            incoming,
            new OmpRpcError({ operation: "read", detail: "Logical child exited" }),
          );
        else
          yield* Queue.offer(incoming, {
            type: "prompt_result",
            id: prompt.id,
            status: "completed",
            sessionSettled: true,
          });
        yield* Effect.raceFirst(Deferred.await(failedRequest), Deferred.await(terminated));
        const next = yield* runtime
          .startTurn({
            appThread,
            threadId,
            runId: RunId.make("after-failure"),
            runOrdinal: 2,
            providerTurnOrdinal: 2,
            attemptId: RunAttemptId.make("after-failure"),
            rootNodeId: NodeId.make("after-failure"),
            providerThread,
            message: {
              messageId: MessageId.make("after-failure"),
              text: "After failure",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(next) ? Cause.pretty(next.cause) : "").not.toContain(
          "Previous OMP turn is active",
        );
        const terminal = yield* take((e) => e.type === "turn.terminal" && e.runOrdinal === 1);
        expect(terminal).toMatchObject({ status: dead ? "failed" : "completed" });
        const cancelled = all.findIndex(
          (e) =>
            e.type === "turn_item.updated" &&
            e.turnItem.id === pendingSecret.card.id &&
            e.turnItem.type === "secret_request" &&
            e.turnItem.secretStatus === "cancelled",
        );
        expect(cancelled).toBeGreaterThanOrEqual(0);
        expect(cancelled).toBeLessThan(all.indexOf(terminal));
        expect(Option.isNone(yield* inputs.lookup(threadId, pendingSecret.card.id))).toBe(true);
        expect(yield* pendingSecret.receiver.deliver(save)).toBe(false);
        if (dead) {
          expect(Exit.isFailure(next) ? Cause.pretty(next.cause) : "").toContain(
            "transport is unavailable",
          );
          yield* Deferred.await(streamFailed);
          yield* Deferred.await(terminated);
          expect(
            all.some(
              (e) => e.type === "provider_session.updated" && e.providerSession.status === "error",
            ),
          ).toBe(true);
        } else expect(next._tag).toBe("Success");
        return;
      }
      yield* Queue.offer(incoming, {
        type: "message_start",
        messageId: "msg-1",
        message: { role: "assistant" },
      });
      yield* Queue.offer(incoming, {
        type: "message_update",
        messageId: "msg-1",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Draft" },
      });
      yield* Queue.offer(incoming, {
        type: "message_end",
        messageId: "msg-1",
        message: { role: "assistant", content: [{ type: "text", text: "Final text" }] },
      });
      yield* Queue.offer(incoming, { type: "agent_end" });
      yield* Queue.offer(incoming, {
        type: "auto_compaction_start",
        reason: "threshold",
        action: "snapcompact",
      });
      yield* Queue.offer(incoming, {
        type: "auto_compaction_end",
        action: "snapcompact",
        aborted: false,
        result: { summary: "native summary", tokensBefore: 100 },
      });
      yield* Queue.offer(incoming, {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 100,
        errorMessage: "private native error",
      });
      yield* Queue.offer(incoming, { type: "auto_retry_end", success: true, attempt: 1 });

      yield* Queue.offer(incoming, {
        type: "extension_ui_request",
        id: "notify",
        method: "notify",
        message: "yield control",
      });

      const saved = yield* openSecret("secret");
      expect(saved.receiver.owner).toEqual({
        threadId,
        turnItemId: saved.card.id,
        runId: "r",
        runAttemptId: "a",
        nodeId: "n",
        providerThreadId: providerThread.id,
        providerSessionId: "s",
      });
      expect(yield* saved.receiver.deliver(save)).toBe(true);
      expect(yield* Queue.take(sent)).toEqual({
        type: "extension_ui_response",
        id: "secret",
        value: "hunter2",
      });
      expect(yield* secretOutcome(saved.card.id)).toMatchObject({
        turnItem: { secretStatus: "saved", status: "completed" },
      });
      expect(yield* saved.receiver.deliver(save)).toBe(false);
      expect(Option.isNone(yield* inputs.lookup(threadId, saved.card.id))).toBe(true);
      const declined = yield* openSecret("secret-decline");
      expect(yield* declined.receiver.deliver({ type: "decline" })).toBe(true);
      expect(yield* Queue.take(sent)).toEqual({
        type: "extension_ui_response",
        id: "secret-decline",
        cancelled: true,
      });
      expect(yield* secretOutcome(declined.card.id)).toMatchObject({
        turnItem: { secretStatus: "declined", status: "cancelled" },
      });
      const withdrawn = yield* openSecret("secret-withdrawn");
      yield* Queue.offer(incoming, {
        type: "extension_ui_request",
        id: "cancel-secret",
        method: "cancel",
        targetId: "secret-withdrawn",
      });
      expect(yield* secretOutcome(withdrawn.card.id)).toMatchObject({
        turnItem: { secretStatus: "cancelled" },
      });
      expect(yield* withdrawn.receiver.deliver(save)).toBe(false);
      yield* Queue.offer(incoming, {
        type: "extension_ui_request",
        id: "q",
        method: "select",
        title: "Pick",
        options: ["B", "A"],
      });
      const ask = yield* take((e) => e.type === "runtime_request.updated");
      if (ask.type !== "runtime_request.updated") throw new Error("Missing question");
      expect(all.some((e) => e.type === "turn.terminal")).toBe(false);
      expect(
        all.some(
          (e) =>
            e.type === "turn_item.updated" &&
            e.turnItem.type === "compaction" &&
            e.turnItem.status === "completed",
        ),
      ).toBe(true);
      expect(
        all.some(
          (e) =>
            e.type === "turn_item.updated" &&
            e.turnItem.type === "error" &&
            e.turnItem.retry?.attempt === 1,
        ),
      ).toBe(true);
      const beforeTodo = all.find(
        (e) => e.type === "turn_item.updated" && e.turnItem.type === "todo_list",
      );
      expect(beforeTodo).toMatchObject({
        turnItem: { steps: [{ text: "Native task", status: "pending" }] },
      });
      todoPhases = [];
      yield* Queue.offer(incoming, { type: "todo_auto_clear" });
      const cleared = yield* take(
        (e) =>
          e.type === "turn_item.updated" &&
          e.turnItem.type === "todo_list" &&
          e.turnItem.steps.length === 0,
      );
      if (
        beforeTodo?.type !== "turn_item.updated" ||
        beforeTodo.turnItem.type !== "todo_list" ||
        cleared.type !== "turn_item.updated" ||
        cleared.turnItem.type !== "todo_list"
      )
        throw new Error("Missing native todo projection");
      expect(cleared.turnItem.planId).toBe(beforeTodo.turnItem.planId);

      expect(
        all.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "system_notice"),
      ).toBe(true);
      expect(
        all.some((e) => e.type === "node.updated" && e.node.id === ask.runtimeRequest.nodeId),
      ).toBe(true);
      yield* runtime.respondToRuntimeRequest({
        requestId: ask.runtimeRequest.id,
        answers: { q: "A" },
      });
      expect(yield* Queue.take(sent)).toEqual({
        type: "extension_ui_response",
        id: "q",
        value: "A",
      });
      yield* Queue.offer(incoming, {
        type: "extension_ui_request",
        id: "expiry",
        method: "input",
        title: "Expires",
        timeout: 10,
      });
      const expiring = yield* take(
        (e) =>
          e.type === "runtime_request.updated" &&
          e.runtimeRequest.nativeRequestRef?.nativeId === "expiry",
      );
      yield* TestClock.adjust("10 millis");
      yield* take(
        (e) => e.type === "runtime_request.updated" && e.runtimeRequest.status === "expired",
      );
      expect(yield* Queue.take(sent)).toEqual({
        type: "extension_ui_response",
        id: "expiry",
        cancelled: true,
        timedOut: true,
      });
      if (expiring.type !== "runtime_request.updated") throw new Error("Missing expiry request");
      expect(
        (yield* runtime
          .respondToRuntimeRequest({
            requestId: expiring.runtimeRequest.id,
            answers: { expiry: "late" },
          })
          .pipe(Effect.flip))._tag,
      ).toBe("ProviderAdapterProtocolError");
      const terminalSecret = yield* openSecret("turn-end-secret");
      yield* Queue.offer(incoming, {
        type: "prompt_result",
        id: prompt.id,
        status: "completed",
        sessionSettled: true,
      });
      const terminal = yield* take((e) => e.type === "turn.terminal");
      const cancelled = all.findIndex(
        (e) =>
          e.type === "turn_item.updated" &&
          e.turnItem.id === terminalSecret.card.id &&
          e.turnItem.type === "secret_request" &&
          e.turnItem.secretStatus === "cancelled",
      );
      expect(cancelled).toBeGreaterThanOrEqual(0);
      expect(cancelled).toBeLessThan(all.indexOf(terminal));
      expect(all.filter((e) => e.type === "message.updated").at(-1)).toMatchObject({
        message: { text: "Final text", streaming: false },
      });
      expect(all.filter((e) => e.type === "turn.terminal")).toHaveLength(1);
      yield* runtime.startTurn({
        appThread,
        threadId,
        runId: RunId.make("r2"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("a2"),
        rootNodeId: NodeId.make("n2"),
        providerThread,
        message: {
          messageId: MessageId.make("u2"),
          text: "Next",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection,
        runtimePolicy,
      });
      yield* Queue.take(sent);
      const started = yield* take(
        (e) =>
          e.type === "provider_turn.updated" &&
          e.providerTurn.ordinal === 2 &&
          e.providerTurn.status === "running",
      );
      yield* Queue.offer(incoming, {
        type: "tool_execution_start",
        toolCallId: "pending-eval",
        toolName: "eval",
        args: { language: "javascript", code: "1" },
      });
      yield* take(
        (e) =>
          e.type === "turn_item.updated" &&
          e.turnItem.type === "dynamic_tool" &&
          e.turnItem.toolName === "eval",
      );
      yield* Queue.offer(controls, {
        v: 1,
        type: "approval_request",
        providerSession: "private",
        epoch: "epoch",
        id: "permission",
        payload: {
          prompt: { full: "Tool permission", compact: "Permission" },
          origin: { nativeCallId: "call" },
        },
      });
      const approval = yield* take(
        (e) =>
          e.type === "runtime_request.updated" &&
          e.runtimeRequest.nativeRequestRef?.nativeId === "permission",
      );
      if (started.type !== "provider_turn.updated" || approval.type !== "runtime_request.updated")
        throw new Error("Missing owned turn/approval");
      yield* Queue.offer(incoming, {
        type: "extension_ui_request",
        id: "stop-secret",
        method: "input",
        secret: true,
        title: "Private value",
      });
      const stopCard = yield* take(
        (e) => e.type === "turn_item.updated" && e.turnItem.type === "secret_request",
      );
      if (stopCard.type !== "turn_item.updated") throw new Error("Missing secret card");
      const stopReceiver = Option.getOrThrow(yield* inputs.lookup(threadId, stopCard.turnItem.id));
      expect(stopReceiver.owner).toMatchObject({ runId: "r2", runAttemptId: "a2", nodeId: "n2" });
      const stop = yield* runtime
        .interruptTurn({ providerThread, providerTurnId: started.providerTurn.id })
        .pipe(Effect.forkChild);
      yield* Fiber.join(stop);
      expect(yield* Queue.take(sent)).toEqual({
        type: "extension_ui_response",
        id: "stop-secret",
        cancelled: true,
      });
      expect(yield* stopReceiver.deliver(save)).toBe(false);
      expect(Option.isNone(yield* inputs.lookup(threadId, stopCard.turnItem.id))).toBe(true);
      expect(yield* secretOutcome(stopCard.turnItem.id)).toMatchObject({
        turnItem: { secretStatus: "cancelled" },
      });
      expect(JSON.stringify(all)).not.toContain("hunter2");
      yield* Deferred.await(denied);
      expect(launches).toBe(2);
      yield* take((e) => e.type === "turn.terminal" && e.runOrdinal === 2);
      expect(
        all
          .filter((e) => e.type === "turn_item.updated" && e.turnItem.type === "dynamic_tool")
          .at(-1),
      ).toMatchObject({
        turnItem: { status: "interrupted", output: { t3OmpEval: { status: "cancelled" } } },
      });
      expect(
        (yield* runtime
          .respondToRuntimeRequest({ requestId: approval.runtimeRequest.id, decision: "accept" })
          .pipe(Effect.flip))._tag,
      ).toBe("ProviderAdapterProtocolError");
      yield* Queue.fail(
        incoming,
        new OmpRpcError({ operation: "read", detail: "Retired generation exited" }),
      );
      const continuation = {
        appThread,
        threadId,
        runId: RunId.make("r3"),
        runOrdinal: 3,
        providerTurnOrdinal: 3,
        attemptId: RunAttemptId.make("a3"),
        rootNodeId: NodeId.make("n3"),
        providerThread,
        message: {
          messageId: MessageId.make("completion-1"),
          text: "PTY completed",
          attachments: [],
          createdBy: "agent" as const,
          creationSource: "provider" as const,
        },
        modelSelection,
        runtimePolicy,
      };
      yield* runtime.startTurn(continuation);
      const continued = yield* Queue.take(sent);

      yield* Queue.offer(eventQueues[1]!, {
        type: "prompt_result",
        id: continued.id,
        status: "completed",
        sessionSettled: true,
      });
      yield* take((e) => e.type === "turn.terminal" && e.runOrdinal === 3);

      const beforeDuplicate = sentRecords.length;
      yield* runtime.startTurn({
        ...continuation,
        runOrdinal: 4,
        providerTurnOrdinal: 4,
        attemptId: RunAttemptId.make("a4"),
      });
      expect(sentRecords.length).toBe(beforeDuplicate);
      yield* take((e) => e.type === "turn.terminal" && e.runOrdinal === 4);
      const queued = {
        ...continuation,
        runOrdinal: 5,
        providerTurnOrdinal: 5,
        attemptId: RunAttemptId.make("a5"),
        message: { ...continuation.message, messageId: MessageId.make("completion-2") },
      };
      yield* runtime.startTurn(queued);
      yield* Queue.take(sent);
      const owner = yield* take(
        (e) =>
          e.type === "provider_turn.updated" &&
          e.providerTurn.ordinal === 5 &&
          e.providerTurn.status === "running",
      );
      expect(
        (yield* runtime
          .steerTurn({
            ...queued,
            providerTurnId: started.providerTurn.id,
            message: { ...queued.message, messageId: MessageId.make("stale-completion") },
          })
          .pipe(Effect.flip))._tag,
      ).toBe("ProviderAdapterProtocolError");
      const beforeSteer = sentRecords.length;
      yield* runtime.steerTurn({
        ...queued,
        providerTurnId:
          owner.type === "provider_turn.updated" ? owner.providerTurn.id : started.providerTurn.id,
      });
      expect(sentRecords.length).toBe(beforeSteer);
      if (owner.type !== "provider_turn.updated") throw new Error("Missing continuation owner");
      yield* runtime.interruptTurn({ providerThread, providerTurnId: owner.providerTurn.id });
      yield* take((e) => e.type === "turn.terminal" && e.runOrdinal === 5);
      expect(launches).toBe(3);
      const beforeReplay = sentRecords.length;
      yield* runtime.startTurn({
        ...queued,
        runOrdinal: 6,
        providerTurnOrdinal: 6,
        attemptId: RunAttemptId.make("a6"),
      });
      expect(sentRecords.length).toBe(beforeReplay);
      yield* take((e) => e.type === "turn.terminal" && e.runOrdinal === 6);
      yield* runtime.startTurn({
        ...queued,
        runOrdinal: 7,
        providerTurnOrdinal: 7,
        attemptId: RunAttemptId.make("dump"),
        message: {
          ...queued.message,
          messageId: MessageId.make("dump"),
          text: "/dump all",
          createdBy: "user",
          creationSource: "web",
        },
      });
      const dump = yield* Queue.take(sent);
      yield* Queue.offer(eventQueues[2]!, {
        type: "command_output",
        text: "Transcript archive: /tmp/omp-dump.zip",
      });
      yield* Queue.offer(eventQueues[2]!, {
        type: "response",
        command: "prompt",
        id: dump.id,
        success: true,
        data: { agentInvoked: false },
      });
      yield* take((e) => e.type === "turn.terminal" && e.runOrdinal === 7);
      expect(
        all.some(
          (e) =>
            e.type === "turn_item.updated" &&
            e.turnItem.type === "dynamic_tool" &&
            e.turnItem.toolName === "omp_command_output" &&
            e.turnItem.output === "Transcript archive: /tmp/omp-dump.zip",
        ),
      ).toBe(true);
      nativeEntries = [
        {
          id: "inherited",
          parentId: null,
          type: "message",
          message: { role: "user", content: "Inherited parent context", timestamp: 1 },
        },
        {
          id: "child",
          parentId: "inherited",
          type: "message",
          message: { role: "user", content: "First child turn", timestamp: 2 },
        },
      ];
      nativeLeaf = "child";
      const rolled = yield* runtime.rollbackThread({
        providerThread: {
          ...providerThread,
          forkedFrom: { providerThreadId: providerThread.id },
          nativeMetadata: { itemIdentityVersion: 2, forkHeadMessageId: "inherited" },
          nativeConversationHeadRef: {
            driver: runtime.driver,
            nativeId: "child",
            strength: "strong",
          },
        },
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("start"),
          appRunOrdinal: 0,
        },
        providerThreadTurns: [],
      });
      expect(rolled.messages?.map((message) => message.text)).toEqual(["Inherited parent context"]);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("answers T3's read-only host tools itself and prompts for every other approval", () =>
  Effect.gen(function* () {
    const readOnly = new Set(["task_status"]);
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18" }
          : {
              tools: ["task_status", "delegate_task"].map((name) => ({
                name,
                description: name,
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: readOnly.has(name) },
              })),
            };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    });
    const instanceId = ProviderInstanceId.make("omp-test");
    const threadId = ThreadId.make("t");
    const catalogs = yield* Catalogs.McpProviderSessions;
    yield* catalogs.set({
      environmentId: EnvironmentId.make("env"),
      threadId,
      providerSessionId: "s",
      providerInstanceId: instanceId,
      endpoint: "https://fixture.test/mcp",
      authorizationHeader: "Bearer fixture",
      browserToolsAvailable: false,
    });
    const controls = yield* Queue.unbounded<ControlEnvelope, OmpRpcError>();
    const answers = yield* Queue.unbounded<ControlEnvelope>();
    const events = yield* Queue.unbounded<OmpRpcRecord, OmpRpcError>();
    const adapter = yield* makeOmpAdapterV2(
      {
        instanceId,
        settings: { enabled: false, binaryPath: "omp", launchArgs: "", customModels: [] },
        environment: {},
      },
      (options: OmpSessionOptions) =>
        Effect.succeed({
          send: () => Effect.void,
          request: (r: OmpRpcRecord) =>
            Effect.succeed(
              (
                {
                  get_state: {
                    sessionId: "native",
                    model: { id: "base", provider: "p" },
                    sessionFile: options.config.sessionDir + "/native.jsonl",
                    isSettled: true,
                    systemPrompt: [options.config.instructions],
                  },
                  get_entries: { entries: [], leafId: null },
                  get_available_models: { models: [{ id: "base", provider: "p", name: "Base" }] },
                  get_available_thinking_levels: { levels: ["off"] },
                  get_available_commands: { commands: [] },
                } as Record<string, unknown>
              )[r.type] ?? {},
            ),
          events,
          controls,
          sendControl: (frame: ControlEnvelope) => Queue.offer(answers, frame).pipe(Effect.asVoid),
          providerSession: "private",
          policyEpoch: "epoch",
          exited: Effect.never,
          terminate: Effect.void,
          shutdown: () => Effect.void,
          diagnostics: () => ({ stderrBytes: 0 }),
        }),
    );
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("s"),
      modelSelection: { instanceId, model: "default" },
      runtimePolicy: {
        cwd: "/workspace",
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    });
    const published = yield* Queue.unbounded<string>();
    yield* runtime.events.pipe(
      Stream.runForEach((e) =>
        e.type === "runtime_request.updated"
          ? Queue.offer(published, e.runtimeRequest.nativeRequestRef?.nativeId ?? "")
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    const approvalRequest = (id: string, tool: string) =>
      Queue.offer(controls, {
        v: 1,
        type: "approval_request",
        providerSession: "private",
        epoch: "epoch",
        id,
        payload: {
          prompt: { full: "Tool permission", compact: "Permission" },
          origin: { nativeCallId: id, tool },
        },
      });
    yield* approvalRequest("read-only", "task_status");
    expect(yield* Queue.take(answers)).toMatchObject({
      type: "approval_answer",
      id: "read-only",
      answer: "once",
    });
    yield* approvalRequest("mutating", "delegate_task");
    yield* approvalRequest("native", "bash");
    expect([yield* Queue.take(published), yield* Queue.take(published)]).toEqual([
      "mutating",
      "native",
    ]);
    expect(yield* Queue.size(answers)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(services)),
);
