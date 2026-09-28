// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  query,
  type HookCallback,
  type Options as ClaudeQueryOptions,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  ClaudeSettings,
  OpenCodeSettings,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import type { CodexSessionRuntimeShape } from "./CodexSessionRuntime.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import { makeOpenCodeAdapter } from "./OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";

const nativeProofEnabled = process.env.T3_NATIVE_SUBAGENT_PROOF === "1";
const claudeProvider = ProviderDriverKind.make("claudeAgent");
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

class NativeClaudeAdapter extends Context.Service<NativeClaudeAdapter, ClaudeAdapterShape>()(
  "t3/provider/Layers/SubagentNativeHandoff.native.test/NativeClaudeAdapter",
) {}

class NativeCodexRuntime extends Context.Service<NativeCodexRuntime, CodexSessionRuntimeShape>()(
  "t3/provider/Layers/SubagentNativeHandoff.native.test/NativeCodexRuntime",
) {}

class NativeOpenCodeAdapter extends Context.Service<NativeOpenCodeAdapter, OpenCodeAdapterShape>()(
  "t3/provider/Layers/SubagentNativeHandoff.native.test/NativeOpenCodeAdapter",
) {}

interface CapturedParentContext {
  readonly agentId: string | null;
  readonly hookEvent: string;
  readonly text: string;
  readonly sequence: number;
}

interface CapturedHookCall {
  readonly agentId: string | null;
  readonly hookEvent: string;
  readonly additionalContext?: string;
  readonly sequence: number;
}

interface CapturedNativeTrace {
  readonly sequence: number;
  readonly kind: string;
  readonly detail: Readonly<Record<string, string | null>>;
}

interface ClaudeNativeProbeResult {
  readonly providerVersion: string;
  readonly nativeRequestId: string;
  readonly childAgentKey: string;
  readonly siblingAgentKey: string;
  readonly decision: "accept" | "decline";
  readonly parentContexts: ReadonlyArray<CapturedParentContext>;
  readonly trace: ReadonlyArray<CapturedNativeTrace>;
  readonly finalAnswer: string;
  readonly targetFileExists: boolean;
}

const encodeNativeProofJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const CodexAuditEntrySchema = Schema.Struct({
  sequence: Schema.Finite,
  wallTimeUnixMs: Schema.optional(Schema.Finite),
  direction: Schema.Literals(["client", "server"]),
  kind: Schema.String,
  threadId: Schema.optional(Schema.String),
  parentThreadId: Schema.optional(Schema.String),
  childThreadId: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
type CodexAuditEntry = typeof CodexAuditEntrySchema.Type;
const decodeCodexAuditEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(CodexAuditEntrySchema),
);

interface CodexNativeProbeResult {
  readonly providerVersion: string;
  readonly rootThreadId: string;
  readonly childThreadId: string;
  readonly siblingThreadId: string;
  readonly nativeRequestId: string;
  readonly handoffStatus: string;
  readonly scenario: "approval-accept" | "approval-deny" | "question";
  readonly requestId: string;
  readonly parentInferenceSequence: number;
  readonly parentInferenceAfterInjection: boolean;
  readonly parentInferenceHasSelectedRequest: boolean;
  readonly parentInferenceHasExactAnswer: boolean;
  readonly siblingInferenceHasSelectedRequest: boolean;
  readonly finalAnswerInferenceSequence: number;
  readonly finalAnswerResponseSequence: number;
}

interface OpenCodeNativeProbeResult {
  readonly providerVersion: string;
  readonly rootSessionId: string;
  readonly childSessionId: string;
  readonly siblingSessionId: string;
  readonly nativeRequestId: string;
  readonly handoffStatus: string;
  readonly scenario: "approval-accept" | "approval-deny" | "question";
  readonly parentContext: string;
  readonly finalAnswer: string;
}

interface OpenCodeAuditEntry {
  readonly sequence: number;
  readonly sessionId: string;
  readonly context: ReadonlyArray<string>;
  readonly atNs: string;
  readonly truncated: boolean;
  readonly phase: "transform" | "system-push";
}

function codexAuditWrapperSource(binaryPath: string, auditPath: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const binaryPath = ${JSON.stringify(binaryPath)};
const auditPath = ${JSON.stringify(auditPath)};
const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: ["pipe", "pipe", "ignore"],
  env: process.env,
});
let sequence = 0;
let rootThreadId;
let stdinBuffer = "";
let stdoutBuffer = "";
const pendingThreadStarts = new Set();
const pendingInjections = new Map();
const pendingNativeRequests = new Map();
function record(entry) {
  fs.appendFileSync(auditPath, JSON.stringify({ sequence: ++sequence, wallTimeUnixMs: Date.now(), ...entry }) + "\\n");
}
function parseFrames(direction, chunk) {
  let buffer = direction === "client" ? stdinBuffer + chunk : stdoutBuffer + chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  if (direction === "client") stdinBuffer = buffer;
  else stdoutBuffer = buffer;
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (direction === "client") {
      if (message.method === "thread/start") pendingThreadStarts.add(String(message.id));
      if (message.method === "thread/inject_items") {
        const content = JSON.stringify(message.params?.items ?? []);
        pendingInjections.set(String(message.id), String(message.params?.threadId ?? ""));
        record({ direction, kind: "parent-injection-request", method: message.method, requestId: String(message.id), threadId: String(message.params?.threadId ?? ""), content });
      }
      const settledRequestId = message.id === undefined ? undefined : String(message.id);
      if (!message.method && settledRequestId && pendingNativeRequests.has(settledRequestId)) {
        const nativeRequest = pendingNativeRequests.get(settledRequestId);
        pendingNativeRequests.delete(settledRequestId);
        record({ direction, kind: "native-child-request-settled", method: nativeRequest.method, requestId: settledRequestId, threadId: nativeRequest.threadId, status: message.error ? "rejected" : "accepted" });
      }
      continue;
    }
    const id = message.id === undefined ? undefined : String(message.id);
    if (id && pendingThreadStarts.has(id)) {
      pendingThreadStarts.delete(id);
      rootThreadId = message.result?.thread?.id;
      record({ direction, kind: "root-thread-ready", threadId: rootThreadId });
    }
    if (id && pendingInjections.has(id)) {
      const threadId = pendingInjections.get(id);
      pendingInjections.delete(id);
      record({ direction, kind: message.error ? "parent-injection-rejected" : "parent-injection-accepted", method: "thread/inject_items", requestId: id, threadId });
    }
    const method = message.method;
    const params = message.params;
    if (typeof method !== "string" || !params || typeof params !== "object") continue;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (method === "thread/started" && params.thread && typeof params.thread === "object") {
      const childThread = params.thread;
      const sourceParentThreadId = childThread.source?.subAgent?.thread_spawn?.parent_thread_id;
      if (typeof childThread.id === "string") {
        const parentThreadId = typeof sourceParentThreadId === "string"
          ? sourceParentThreadId
          : typeof childThread.parentThreadId === "string"
            ? childThread.parentThreadId
            : undefined;
        if (childThread.id !== rootThreadId) {
          record({ direction, kind: "child-thread-started", method, threadId: childThread.id, parentThreadId });
        }
      }
    }
    if ((method === "item/started" || method === "item/completed") && params.item?.type === "collabAgentToolCall" && Array.isArray(params.item.receiverThreadIds)) {
      const parentThreadId = typeof params.threadId === "string" ? params.threadId : undefined;
      if (parentThreadId) {
        for (const childThreadId of params.item.receiverThreadIds) {
          if (typeof childThreadId === "string") {
            record({ direction, kind: "parent-thread-child", method, threadId: parentThreadId, childThreadId });
          }
        }
      }
    }
    if ((method === "item/started" || method === "item/completed") && params.item?.type === "subAgentActivity") {
      const parentThreadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const childThreadId = typeof params.item.agentThreadId === "string" ? params.item.agentThreadId : undefined;
      if (parentThreadId && childThreadId && parentThreadId !== childThreadId) {
        record({ direction, kind: "parent-thread-child", method, threadId: parentThreadId, childThreadId });
      }
    }
    if (id && ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"].includes(method)) {
      pendingNativeRequests.set(id, { method, threadId });
      const requestContent = method === "mcpServer/elicitation/request"
        ? Object.keys(params.requestedSchema?.properties ?? {}).join(",")
        : typeof params.itemId === "string"
          ? params.itemId
          : typeof params.serverName === "string"
            ? params.serverName
            : undefined;
      record({ direction, kind: "native-child-request", method, requestId: id, threadId, content: requestContent });
    }
    if (threadId !== rootThreadId) continue;
    if (method === "turn/started" || method === "turn/completed") {
      record({ direction, kind: method, method, threadId, status: typeof params.turn?.status === "string" ? params.turn.status : undefined });
    } else if (method === "item/completed" && params.item?.type === "agentMessage") {
      record({ direction, kind: "root-assistant-item", method, threadId, content: String(params.item.text ?? "") });
    }
  }
}
process.stdin.on("data", (chunk) => { child.stdin.write(chunk); parseFrames("client", chunk.toString("utf8")); });
child.stdout.on("data", (chunk) => { process.stdout.write(chunk); parseFrames("server", chunk.toString("utf8")); });
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;
}

function codexQuestionMcpServerSource(auditPath: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const auditPath = ${JSON.stringify(auditPath)};
const expectedAnswer = "EXACT_NATIVE_ANSWER_7193";
let input = "";
let pendingToolCallId;
const elicitationId = "native-child-question-1";
function record(kind, detail = {}) {
  fs.appendFileSync(auditPath, JSON.stringify({ kind, ...detail }) + "\\n");
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}
function handle(message) {
  if (typeof message.method === "string") {
    record("incoming", { method: message.method, paramsKeys: Object.keys(message.params ?? {}) });
  }
  if (message.method === "initialize") {
    record("initialized");
    send({ id: message.id, result: {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false }, elicitation: { form: {} } },
      serverInfo: { name: "t3-disposable-native-question", version: "1.0.0" },
    }});
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "ping") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    send({ id: message.id, result: { tools: [{
      name: "ask_deployment_token",
      description: "Ask the caller for the deployment token using MCP form elicitation and return the exact answer.",
      inputSchema: { type: "object", properties: {} },
    }] }});
    return;
  }
  if (message.method === "tools/call" && message.params?.name === "ask_deployment_token") {
    pendingToolCallId = message.id;
    record("tool-called");
    send({ id: elicitationId, method: "elicitation/create", params: {
      mode: "form",
      message: "Which deployment token should the child use?",
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
    }});
    return;
  }
  if (message.id === elicitationId && pendingToolCallId !== undefined) {
    const result = message.result;
    const token = result?.content?.deployment_token;
    const answeredExactly = result?.action === "accept" && token === expectedAnswer;
    record("elicitation-response", { action: result?.action ?? "missing", answeredExactly });
    send({ id: pendingToolCallId, result: {
      content: [{ type: "text", text: answeredExactly ? token : "The user did not provide a token." }],
      isError: !answeredExactly,
    }});
    pendingToolCallId = undefined;
    return;
  }
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const lines = input.split("\\n");
  input = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch { record("invalid-message"); }
  }
});
process.stdin.on("end", () => process.exit(0));
`;
}

function openCodeNativeAuditPluginSource(auditPath: string): string {
  return `import { appendFileSync } from "node:fs";

const auditPath = ${JSON.stringify(auditPath)};
let sequence = 0;
const maxEntries = 256;
const maxContextBytes = 1024 * 1024;
function capture(sessionID, system, phase) {
  if (sequence >= maxEntries) return;
  const context = system.filter((entry) => typeof entry === "string");
  const truncated = Buffer.byteLength(JSON.stringify(context), "utf8") > maxContextBytes;
  appendFileSync(auditPath, JSON.stringify({
    sequence: ++sequence,
    sessionID,
    context: truncated ? [] : context,
    truncated,
    phase,
    atNs: BigInt(Math.floor((performance.timeOrigin + performance.now()) * 1000)).toString(),
  }) + "\\n");
}

export const T3NativeContextAudit = async () => ({
  "experimental.chat.system.transform": async (input, output) => {
    if (typeof input.sessionID !== "string" || !Array.isArray(output.system)) return;
    const system = output.system;
    const originalPush = system.push.bind(system);
    system.push = (...entries) => {
      const result = originalPush(...entries);
      capture(input.sessionID, system, "system-push");
      return result;
    };
    capture(input.sessionID, system, "transform");
  },
});
`;
}

interface OpenCodeNativeConnectionCapture {
  readonly connections: Array<{
    readonly url: string;
    readonly external: boolean;
    readonly requestedServerUrl?: string | null;
    readonly version: string;
  }>;
}

function openCodeRuntimeCaptureLayer(capture: OpenCodeNativeConnectionCapture) {
  return Layer.effect(
    OpenCodeRuntime,
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      return {
        ...runtime,
        connectToOpenCodeServer: (input) =>
          runtime.connectToOpenCodeServer(input).pipe(
            Effect.tap((connection) =>
              Effect.sync(() =>
                capture.connections.push({
                  url: connection.url,
                  external: connection.external,
                  ...(input.serverUrl !== undefined ? { requestedServerUrl: input.serverUrl } : {}),
                  version: connection.version,
                }),
              ),
            ),
          ),
      } satisfies OpenCodeRuntimeShape;
    }),
  ).pipe(Layer.provideMerge(OpenCodeRuntimeLive));
}

function readOpenCodeAudit(path: string): Array<OpenCodeAuditEntry> {
  if (!NodeFS.existsSync(path)) return [];
  return NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const value = recordLike(JSON.parse(line));
        const context = Array.isArray(value?.context)
          ? value.context.filter((entry): entry is string => typeof entry === "string")
          : undefined;
        if (
          typeof value?.sessionID !== "string" ||
          typeof value.sequence !== "number" ||
          !Number.isInteger(value.sequence) ||
          !context ||
          typeof value.atNs !== "string" ||
          !/^\d+$/.test(value.atNs)
        ) {
          return [];
        }
        return [
          {
            sequence: value.sequence,
            sessionId: value.sessionID,
            context,
            atNs: value.atNs,
            truncated: value.truncated === true,
            phase: value.phase === "system-push" ? "system-push" : "transform",
          },
        ];
      } catch {
        return [];
      }
    });
}

function nativeProofEpochMicros(): string {
  return BigInt(
    Math.floor((globalThis.performance.timeOrigin + globalThis.performance.now()) * 1000),
  ).toString();
}

function openCodePermissionHistoryBlock(system: ReadonlyArray<string>): string {
  return system
    .flatMap(
      (text) =>
        text.match(/<t3_code_permission_history>[\s\S]*?<\/t3_code_permission_history>/g) ?? [],
    )
    .join("\n");
}

function runOpenCodeNativeProbe(scenario: OpenCodeNativeProbeResult["scenario"]) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-child-opencode-"));
  const workspace = NodePath.join(root, "workspace");
  const outsideWorkspace = NodePath.join(root, "outside-workspace");
  const targetFile = NodePath.join(outsideWorkspace, `approval-${scenario}.txt`);
  const auditPath = NodePath.join(root, "opencode-context-audit.jsonl");
  const auditPluginPath = NodePath.join(root, "opencode-context-audit.mjs");
  NodeFS.mkdirSync(workspace, { recursive: true });
  NodeFS.mkdirSync(outsideWorkspace, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(workspace, "independent-child.txt"),
    "INDEPENDENT_SIBLING_CONTEXT",
    "utf8",
  );
  NodeFS.writeFileSync(auditPath, "", "utf8");
  NodeFS.writeFileSync(auditPluginPath, openCodeNativeAuditPluginSource(auditPath), "utf8");

  const instanceId = ProviderInstanceId.make("native-opencode-proof");
  const threadId = ThreadId.make(`native-opencode-${scenario}-${NodePath.basename(root)}`);
  const modelSelection = createModelSelection(
    instanceId,
    process.env.T3_NATIVE_OPENCODE_MODEL ?? "openai/gpt-6-luna",
  );
  const settings = decodeOpenCodeSettings({
    binaryPath: process.env.T3_NATIVE_OPENCODE_BINARY ?? "opencode",
    serverUrl: "",
  });
  const connectionCapture: OpenCodeNativeConnectionCapture = { connections: [] };
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      plugin: [auditPluginPath],
      agent: {
        "native-proof": {
          mode: "subagent",
          description: "Temporary native handoff proof agent",
          tools: { bash: true, question: true },
          permission: { bash: "ask", external_directory: "ask", question: "allow" },
        },
      },
    }),
  };
  const layer = Layer.effect(
    NativeOpenCodeAdapter,
    makeOpenCodeAdapter(settings, { instanceId, environment }),
  ).pipe(
    Layer.provideMerge(openCodeRuntimeCaptureLayer(connectionCapture)),
    Layer.provideMerge(ServerConfig.layerTest(workspace, root)),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const adapter = yield* NativeOpenCodeAdapter;
    let sessionStarted = false;
    return yield* Effect.gen(function* () {
      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: instanceId,
        threadId,
        cwd: workspace,
        runtimeMode: "approval-required",
        modelSelection,
      });
      sessionStarted = true;
      const cursor = recordLike(session.resumeCursor);
      const rootSessionId = typeof cursor?.sessionId === "string" ? cursor.sessionId : undefined;
      if (!rootSessionId) {
        return yield* Effect.fail("Native proof failed at stage=root-session-identity (OpenCode).");
      }

      const proofReady = yield* Deferred.make<void>();
      const childByAgentKey = new Map<
        string,
        {
          readonly sessionId: string;
          readonly parentSessionId?: string;
          readonly agentTitle?: string;
          running: boolean;
          readyAfterRunning: boolean;
        }
      >();
      const observedChildState = new Map<
        string,
        { running: boolean; readyAfterRunning: boolean }
      >();
      const childAssistantText = new Map<string, Array<string>>();
      const rootAssistantText: Array<string> = [];
      const trace: Array<{
        readonly stage: string;
        readonly agentKey?: string;
        readonly detail?: string;
      }> = [];
      let selectedAgentKey: string | undefined;
      let selectedSessionId: string | undefined;
      let siblingAgentKey: string | undefined;
      let siblingSessionId: string | undefined;
      let publicRequestId: string | undefined;
      let nativeRequestId: string | undefined;
      let handoffStatus: string | undefined;
      let decisionIssuedAtNs: string | undefined;
      let decisionResolved = false;
      let exactQuestionAnswerResolved = false;
      let unexpectedRequest = false;
      let rootTaskSpawnCount = 0;
      let selectedTaskSpawned = false;
      let siblingTaskSpawned = false;
      let rootTurnCompleted = false;
      let rootFinalAnswerAtNs: string | undefined;
      let stage = "native-child-request";
      const approvalResponses: Array<{
        readonly role: "selected-write" | "selected-read" | "sibling-read";
        readonly agentKey: string;
        readonly sessionId: string;
        readonly nativeRequestId: string;
      }> = [];

      const getSessionIdFromNativeEvent = (event: ProviderRuntimeEvent): string | undefined => {
        const rawEvent = recordLike(event.raw?.payload);
        const properties = recordLike(rawEvent?.properties);
        const info = recordLike(properties?.info);
        const sessionId = info?.id ?? properties?.sessionID;
        return typeof sessionId === "string" ? sessionId : undefined;
      };
      const getParentIdFromNativeEvent = (event: ProviderRuntimeEvent): string | undefined => {
        const rawEvent = recordLike(event.raw?.payload);
        const properties = recordLike(rawEvent?.properties);
        const info = recordLike(properties?.info);
        return typeof info?.parentID === "string" ? info.parentID : undefined;
      };
      const getNativeEventJson = (event: ProviderRuntimeEvent) =>
        JSON.stringify(event.raw?.payload ?? {});
      const answerFromQuestion = (event: ProviderRuntimeEvent) => {
        const payload = recordLike(event.payload);
        const questions = Array.isArray(payload?.questions) ? payload.questions : [];
        const questionIds = questions.flatMap((question) => {
          const id = recordLike(question)?.id;
          return typeof id === "string" ? [id] : [];
        });
        return questionIds.length > 0
          ? Object.fromEntries(questionIds.map((id) => [id, "EXACT_NATIVE_ANSWER_7193"]))
          : undefined;
      };
      const selectedContextFor = (entries: ReadonlyArray<OpenCodeAuditEntry>) => {
        const requestId = nativeRequestId;
        const childSessionId = selectedSessionId;
        if (!requestId || !childSessionId) return undefined;
        const action =
          scenario === "approval-accept"
            ? "allow once"
            : scenario === "approval-deny"
              ? "deny"
              : "EXACT_NATIVE_ANSWER_7193";
        return entries.find((entry) => {
          if (entry.sessionId !== rootSessionId || entry.truncated) return false;
          const handoffBlock = openCodePermissionHistoryBlock(entry.context);
          return (
            handoffBlock.includes(requestId) &&
            handoffBlock.includes(childSessionId) &&
            handoffBlock.toLowerCase().includes(action.toLowerCase())
          );
        });
      };

      const maybeComplete = Effect.suspend(() => {
        if (selectedAgentKey && siblingAgentKey === undefined) {
          const discoveredSibling = [...childByAgentKey.entries()].find(
            ([agentKey]) => agentKey !== selectedAgentKey,
          );
          if (discoveredSibling) {
            siblingAgentKey = discoveredSibling[0];
            siblingSessionId = discoveredSibling[1].sessionId;
          }
        }
        const childrenTerminal =
          childByAgentKey.size >= 2 &&
          [...childByAgentKey.values()].every((child) => child.running && child.readyAfterRunning);
        const answer = rootAssistantText.join("\n");
        if (rootTurnCompleted && answer.trim().length > 0 && childrenTerminal) {
          return Deferred.succeed(proofReady, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      });

      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const eventPayload = recordLike(event.payload);
            const eventData = recordLike(eventPayload?.data);
            const toolState = recordLike(eventData?.state);
            trace.push({
              stage: event.type,
              ...(event.agentKey ? { agentKey: String(event.agentKey) } : {}),
              ...(event.type === "session.state.changed"
                ? { detail: event.payload.state }
                : event.type === "turn.completed"
                  ? { detail: event.payload.state }
                  : event.type === "item.started" ||
                      event.type === "item.updated" ||
                      event.type === "item.completed"
                    ? {
                        detail: `itemType=${typeof eventPayload?.itemType === "string" ? eventPayload.itemType : "unknown"};tool=${typeof eventData?.tool === "string" ? eventData.tool : "none"};status=${typeof toolState?.status === "string" ? toolState.status : typeof eventPayload?.status === "string" ? eventPayload.status : "unknown"};target=${(typeof eventData?.command === "string" && eventData.command.includes(targetFile)) || (typeof eventPayload?.detail === "string" && eventPayload.detail.includes(targetFile))}`,
                      }
                    : event.type === "runtime.error"
                      ? {
                          detail:
                            typeof eventPayload?.class === "string"
                              ? eventPayload.class
                              : "runtime-error",
                        }
                      : undefined),
            });
            if (event.type === "session.started" && event.agentKey !== undefined) {
              const sessionId = getSessionIdFromNativeEvent(event);
              const parentSessionId = getParentIdFromNativeEvent(event);
              if (sessionId) {
                const prior = observedChildState.get(String(event.agentKey)) ?? {
                  running: false,
                  readyAfterRunning: false,
                };
                childByAgentKey.set(String(event.agentKey), {
                  sessionId,
                  ...(parentSessionId ? { parentSessionId } : {}),
                  ...(event.agentTitle ? { agentTitle: event.agentTitle } : {}),
                  ...prior,
                });
                const normalizedTitle = event.agentTitle?.toLowerCase() ?? "";
                const taskRole = normalizedTitle.includes("selected action child")
                  ? "selected"
                  : normalizedTitle.includes("independent sibling reader")
                    ? "sibling"
                    : "unknown";
                if (taskRole === "selected") {
                  selectedAgentKey = String(event.agentKey);
                  selectedSessionId = sessionId;
                } else if (taskRole === "sibling") {
                  siblingAgentKey = String(event.agentKey);
                  siblingSessionId = sessionId;
                }
                trace.push({
                  stage: "child-session-started",
                  agentKey: String(event.agentKey),
                  detail: `${sessionId} parent=${parentSessionId ?? "missing"} role=${taskRole}`,
                });
              }
            }

            if (event.type === "session.state.changed" && event.agentKey !== undefined) {
              const agentKey = String(event.agentKey);
              const state = event.payload.state;
              const prior = childByAgentKey.get(agentKey) ??
                observedChildState.get(agentKey) ?? {
                  running: false,
                  readyAfterRunning: false,
                };
              if (state === "running") prior.running = true;
              if (state === "ready" && prior.running) prior.readyAfterRunning = true;
              observedChildState.set(agentKey, prior);
              const child = childByAgentKey.get(agentKey);
              if (child) {
                child.running = prior.running;
                child.readyAfterRunning = prior.readyAfterRunning;
              }
            }

            if (
              event.type === "request.opened" &&
              event.agentKey === undefined &&
              event.threadId === threadId
            ) {
              const rawJson = getNativeEventJson(event);
              const detail = typeof event.payload.detail === "string" ? event.payload.detail : "";
              const nativeEvent = recordLike(event.raw?.payload);
              const nativeProperties = recordLike(nativeEvent?.properties);
              const permission =
                typeof nativeProperties?.permission === "string"
                  ? nativeProperties.permission
                  : undefined;
              const requestArgs = recordLike(event.payload.args);
              const subagentType =
                typeof requestArgs?.subagent_type === "string"
                  ? requestArgs.subagent_type
                  : undefined;
              const description =
                typeof requestArgs?.description === "string" ? requestArgs.description : undefined;
              const taskRole =
                description === "Selected action child"
                  ? "selected"
                  : description === "Independent sibling reader"
                    ? "sibling"
                    : "unknown";
              const isExpectedTaskSpawn =
                permission === "task" &&
                subagentType === "native-proof" &&
                taskRole !== "unknown" &&
                (taskRole === "selected" ? !selectedTaskSpawned : !siblingTaskSpawned);
              trace.push({
                stage: isExpectedTaskSpawn ? "root-task-spawn" : "root-permission-request",
                detail: `permission=${permission ?? "unknown"};subagentType=${subagentType ?? "unknown"};role=${taskRole};target=${rawJson.includes(targetFile) || detail.includes(targetFile)};siblingRead=${rawJson.includes("independent-child.txt") && /\bcat\b/.test(rawJson)}`,
              });
              if (isExpectedTaskSpawn) {
                rootTaskSpawnCount += 1;
                if (taskRole === "selected") selectedTaskSpawned = true;
                else siblingTaskSpawned = true;
                stage = "native-task-spawn";
              } else {
                unexpectedRequest = true;
                stage = "unexpected-root-request";
              }
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                isExpectedTaskSpawn ? "accept" : "decline",
              );
            }

            if (event.type === "request.opened" && event.agentKey !== undefined) {
              const nativeJson = getNativeEventJson(event);
              const requestDetail =
                typeof event.payload.detail === "string" ? event.payload.detail : "";
              const requestSessionId = getSessionIdFromNativeEvent(event);
              const requestId = event.nativeRequestId ? String(event.nativeRequestId) : undefined;
              const nativeEvent = recordLike(event.raw?.payload);
              const nativeProperties = recordLike(nativeEvent?.properties);
              const permission =
                typeof nativeProperties?.permission === "string"
                  ? nativeProperties.permission
                  : undefined;
              const targetsWrite =
                scenario !== "question" &&
                (nativeJson.includes(targetFile) || requestDetail.includes(targetFile));
              const isSiblingRead =
                (nativeJson.includes("independent-child.txt") ||
                  requestDetail.includes("independent-child.txt")) &&
                /\bcat\b/.test(`${nativeJson}\n${requestDetail}`);
              const isSelectedRead =
                selectedAgentKey === String(event.agentKey) &&
                (nativeJson.includes(targetFile) || requestDetail.includes(targetFile)) &&
                /\b(?:cat|head|tail|sed)\b/.test(`${nativeJson}\n${requestDetail}`);
              if (
                targetsWrite &&
                (selectedAgentKey === undefined || selectedAgentKey === String(event.agentKey)) &&
                requestId &&
                requestSessionId
              ) {
                stage = "native-approval-settlement";
                selectedAgentKey = String(event.agentKey);
                selectedSessionId = requestSessionId;
                publicRequestId = event.requestId ? String(event.requestId) : undefined;
                nativeRequestId = requestId;
                decisionIssuedAtNs = nativeProofEpochMicros();
                const response = yield* adapter.respondToRequest(
                  threadId,
                  ApprovalRequestId.make(String(event.requestId)),
                  scenario === "approval-accept" ? "accept" : "decline",
                );
                handoffStatus = response?.handoffStatus;
                if (!response || response.nativeRequestId !== nativeRequestId) {
                  unexpectedRequest = true;
                }
                decisionResolved = response?.nativeStatus === "responded";
                if (response?.nativeRequestId) {
                  approvalResponses.push({
                    role: "selected-write",
                    agentKey: selectedAgentKey,
                    sessionId: selectedSessionId,
                    nativeRequestId: response.nativeRequestId,
                  });
                }
                stage = "parent-model-context";
              } else if (isSiblingRead && requestId && requestSessionId) {
                const response = yield* adapter.respondToRequest(
                  threadId,
                  ApprovalRequestId.make(String(event.requestId)),
                  "accept",
                );
                const agentKey = String(event.agentKey);
                if (response?.nativeRequestId === requestId) {
                  approvalResponses.push({
                    role: "sibling-read",
                    agentKey,
                    sessionId: requestSessionId,
                    nativeRequestId: requestId,
                  });
                  siblingAgentKey = agentKey;
                  siblingSessionId = requestSessionId;
                } else {
                  unexpectedRequest = true;
                }
              } else if (isSelectedRead && requestId && requestSessionId) {
                const response = yield* adapter.respondToRequest(
                  threadId,
                  ApprovalRequestId.make(String(event.requestId)),
                  "accept",
                );
                if (response?.nativeRequestId) {
                  approvalResponses.push({
                    role: "selected-read",
                    agentKey: String(event.agentKey),
                    sessionId: requestSessionId,
                    nativeRequestId: response.nativeRequestId,
                  });
                }
              } else {
                unexpectedRequest = true;
                trace.push({
                  stage: "unexpected-permission-request",
                  agentKey: String(event.agentKey),
                  detail: `request=${requestId ?? "missing"};permission=${permission ?? "unknown"};target=${nativeJson.includes(targetFile) || requestDetail.includes(targetFile)};siblingRead=${isSiblingRead}`,
                });
                yield* adapter.respondToRequest(
                  threadId,
                  ApprovalRequestId.make(String(event.requestId)),
                  "decline",
                );
              }
            }

            if (event.type === "user-input.requested" && event.agentKey !== undefined) {
              const requestId = event.nativeRequestId ? String(event.nativeRequestId) : undefined;
              const requestSessionId = getSessionIdFromNativeEvent(event);
              const answers = answerFromQuestion(event);
              if (
                scenario === "question" &&
                (selectedAgentKey === undefined || selectedAgentKey === String(event.agentKey)) &&
                publicRequestId === undefined &&
                requestId &&
                requestSessionId &&
                answers
              ) {
                stage = "native-question-settlement";
                selectedAgentKey = String(event.agentKey);
                selectedSessionId = requestSessionId;
                publicRequestId = event.requestId ? String(event.requestId) : undefined;
                nativeRequestId = requestId;
                decisionIssuedAtNs = nativeProofEpochMicros();
                const resolveUserInput = adapter.resolveUserInput;
                if (!resolveUserInput || !event.requestId) {
                  unexpectedRequest = true;
                  return;
                }
                const response = yield* resolveUserInput(
                  threadId,
                  ApprovalRequestId.make(String(event.requestId)),
                  {
                    type: "answered",
                    answers,
                  },
                );
                handoffStatus = response.handoffStatus;
                decisionResolved = response.nativeStatus === "answered";
                if (
                  response.nativeRequestId !== nativeRequestId ||
                  response.agentKey !== event.agentKey
                ) {
                  unexpectedRequest = true;
                }
                stage = "parent-model-context";
              } else {
                unexpectedRequest = true;
              }
            }

            if (event.type === "request.resolved" && event.agentKey !== undefined) {
              if (
                String(event.agentKey) === selectedAgentKey &&
                String(event.requestId) === publicRequestId
              ) {
                decisionResolved = true;
              }
            }
            if (event.type === "user-input.resolved" && event.agentKey !== undefined) {
              if (
                String(event.agentKey) === selectedAgentKey &&
                String(event.requestId) === publicRequestId
              ) {
                const answers = recordLike(event.payload.answers);
                exactQuestionAnswerResolved = Object.values(answers ?? {}).includes(
                  "EXACT_NATIVE_ANSWER_7193",
                );
                decisionResolved = exactQuestionAnswerResolved;
              }
            }

            if (
              event.type === "item.completed" &&
              event.payload.itemType === "assistant_message" &&
              typeof event.payload.detail === "string"
            ) {
              if (event.agentKey === undefined && event.threadId === threadId) {
                rootAssistantText.push(event.payload.detail);
                rootFinalAnswerAtNs = nativeProofEpochMicros();
              } else if (event.agentKey !== undefined) {
                const agentKey = String(event.agentKey);
                const items = childAssistantText.get(agentKey) ?? [];
                items.push(event.payload.detail);
                childAssistantText.set(agentKey, items);
                trace.push({
                  stage: "child-answer-summary",
                  agentKey,
                  detail: `target=${event.payload.detail.includes(targetFile)};writeOutcome=${event.payload.detail.includes(`APPROVAL_${scenario === "approval-accept" ? "ACCEPT" : "DENY"}`)};siblingMarker=${event.payload.detail.includes("INDEPENDENT_SIBLING_CONTEXT")}`,
                });
              }
            }
            if (
              event.type === "turn.completed" &&
              event.threadId === threadId &&
              event.payload.state === "completed"
            ) {
              rootTurnCompleted = true;
              stage = "root-turn-completed";
            }
            yield* maybeComplete;
          }),
        ),
        Effect.forkScoped,
      );

      yield* adapter.sendTurn({
        threadId,
        modelSelection,
        attachments: [],
        input: [
          "Your first actions must be two separate calls to OpenCode's native `task` tool. Do not use shell from the parent session. Set `subagent_type` to `native-proof` in both calls.",
          scenario === "question"
            ? 'First call description must be "Selected action child" and its prompt must tell the child to use the native question tool to ask exactly: "Which deployment token should be used?" Then include the answer verbatim in its report.'
            : `First call description must be "Selected action child" and its prompt must tell the child to use the native bash tool to run exactly: printf '%s' 'APPROVAL_${scenario === "approval-accept" ? "ACCEPT" : "DENY"}' > '${targetFile}'. It must wait for the permission decision and report whether the command completed.`,
          `Second call description must be "Independent sibling reader" and its prompt must tell the child to use the native bash tool to run exactly: cat '${NodePath.join(workspace, "independent-child.txt")}'. It must return the stdout exactly and must not access the action path.`,
          "Start the two sibling subagents and wait for both to finish. Then report the action child's result and repeat the independent sibling marker exactly.",
        ].join("\n"),
      });
      const completed = yield* Deferred.await(proofReady).pipe(Effect.timeoutOption("180 seconds"));
      if (completed._tag === "None") {
        const summary = [...childByAgentKey.entries()].map(([agentKey, child]) => ({
          agentKey,
          sessionId: child.sessionId,
          parentSessionId: child.parentSessionId ?? null,
          running: child.running,
          readyAfterRunning: child.readyAfterRunning,
        }));
        return yield* Effect.fail(
          `Native proof failed at stage=${stage} (OpenCode ${scenario}); request=${publicRequestId ?? "missing"}; nativeRequest=${nativeRequestId ?? "missing"}; handoff=${handoffStatus ?? "missing"}; decisionResolved=${decisionResolved}; contextSessions=${readOpenCodeAudit(
            auditPath,
          )
            .map((entry) => entry.sessionId)
            .join(
              ",",
            )}; children=${encodeNativeProofJson(summary)}; trace=${encodeNativeProofJson(trace)}.`,
        );
      }

      const children = [...childByAgentKey.entries()];
      const selected = selectedAgentKey ? childByAgentKey.get(selectedAgentKey) : undefined;
      const sibling = siblingAgentKey ? childByAgentKey.get(siblingAgentKey) : undefined;
      const audit = readOpenCodeAudit(auditPath);
      const parentContext = selectedContextFor(audit);
      const siblingAudit = siblingSessionId
        ? audit.filter((entry) => entry.sessionId === siblingSessionId)
        : [];
      const parentContextText = parentContext
        ? openCodePermissionHistoryBlock(parentContext.context)
        : "";
      const finalAnswer = rootAssistantText.join("\n");
      const expectedTargetContents = scenario === "approval-accept" ? "APPROVAL_ACCEPT" : undefined;
      const targetFileContents = NodeFS.existsSync(targetFile)
        ? NodeFS.readFileSync(targetFile, "utf8")
        : undefined;
      const selectedChildAnswer = selectedAgentKey
        ? (childAssistantText.get(selectedAgentKey) ?? []).join("\n")
        : "";
      const decisionMarker =
        scenario === "approval-accept"
          ? "allow once"
          : scenario === "approval-deny"
            ? "deny"
            : "EXACT_NATIVE_ANSWER_7193";
      const contextAtNs = parentContext ? BigInt(parentContext.atNs) : undefined;
      const responseIssuedAtNs = decisionIssuedAtNs ? BigInt(decisionIssuedAtNs) : undefined;
      const finalAnswerAtNs = rootFinalAnswerAtNs ? BigInt(rootFinalAnswerAtNs) : undefined;
      const auditSummary = audit.map((entry) => {
        const role =
          entry.sessionId === rootSessionId
            ? "parent"
            : entry.sessionId === selectedSessionId
              ? "selected-child"
              : entry.sessionId === siblingSessionId
                ? "sibling"
                : "other";
        const atNs = BigInt(entry.atNs);
        const handoffBlock = openCodePermissionHistoryBlock(entry.context);
        return `${entry.sequence ?? "?"}:${role}:${entry.phase}:marker=${handoffBlock.length > 0};request=${handoffBlock.includes(nativeRequestId ?? "")};child=${handoffBlock.includes(selectedSessionId ?? "")};decision=${handoffBlock.toLowerCase().includes(decisionMarker.toLowerCase())};truncated=${entry.truncated};afterDecision=${responseIssuedAtNs !== undefined && atNs > responseIssuedAtNs};beforeAnswer=${finalAnswerAtNs !== undefined && atNs < finalAnswerAtNs}`;
      });
      const correctConnection = connectionCapture.connections.some((connection) => {
        try {
          const url = new URL(connection.url);
          return (
            !connection.external &&
            url.hostname === "127.0.0.1" &&
            url.port.length > 0 &&
            connection.requestedServerUrl === ""
          );
        } catch {
          return false;
        }
      });
      const selectedNativeRequest = approvalResponses.find(
        (entry) => entry.role === "selected-write",
      );
      const siblingNativeRequest = approvalResponses.find((entry) => entry.role === "sibling-read");
      const proofFailures = [
        !correctConnection && "managed-loopback-server",
        children.length < 2 && "two-native-children",
        rootTaskSpawnCount !== 2 && "two-native-task-spawns",
        !selectedTaskSpawned && "selected-task-spawn",
        !siblingTaskSpawned && "sibling-task-spawn",
        !selectedAgentKey && "selected-child-correlation",
        !selectedSessionId && "selected-native-session-id",
        selected?.sessionId !== selectedSessionId && "selected-child-session-correlation",
        selected?.parentSessionId !== rootSessionId && "selected-child-immediate-parent",
        !siblingAgentKey && "sibling-child-correlation",
        !siblingSessionId && "sibling-native-session-id",
        sibling?.parentSessionId !== rootSessionId && "sibling-immediate-parent",
        !nativeRequestId && "native-request-id",
        !decisionResolved && "native-request-settlement",
        handoffStatus !== "recorded" && "handoff-not-recorded",
        !parentContext && "parent-next-model-context",
        parentContext?.truncated && "parent-system-context-truncated",
        !contextAtNs || !responseIssuedAtNs || contextAtNs <= responseIssuedAtNs
          ? "context-not-after-user-decision"
          : undefined,
        !contextAtNs || !finalAnswerAtNs || contextAtNs >= finalAnswerAtNs
          ? "context-not-before-parent-answer"
          : undefined,
        siblingAudit.length === 0 && "sibling-model-boundary-not-observed",
        siblingAudit.some((entry) => {
          const handoffBlock = openCodePermissionHistoryBlock(entry.context);
          return (
            handoffBlock.includes(nativeRequestId ?? "") ||
            handoffBlock.includes(selectedSessionId ?? "") ||
            (scenario === "question" && handoffBlock.includes("EXACT_NATIVE_ANSWER_7193"))
          );
        }) && "selected-context-leaked-to-sibling",
        unexpectedRequest && "unexpected-native-request",
        scenario !== "question" && !selectedNativeRequest && "selected-native-item-correlation",
        scenario !== "question" && !siblingNativeRequest && "sibling-native-item-correlation",
        scenario !== "question" &&
          selectedNativeRequest !== undefined &&
          siblingNativeRequest !== undefined &&
          selectedNativeRequest.nativeRequestId === siblingNativeRequest.nativeRequestId &&
          "selected-and-sibling-native-items-not-distinct",
        scenario === "question" && !exactQuestionAnswerResolved && "exact-question-resolution",
        scenario === "question" &&
          !selectedChildAnswer.includes("EXACT_NATIVE_ANSWER_7193") &&
          "exact-child-answer",
        !finalAnswer.includes("INDEPENDENT_SIBLING_CONTEXT") && "sibling-marker-in-final-answer",
        scenario === "question" &&
          !finalAnswer.includes("EXACT_NATIVE_ANSWER_7193") &&
          "question-answer-in-parent-final-answer",
        scenario === "approval-accept" &&
          targetFileContents !== expectedTargetContents &&
          "approved-file-outcome",
        scenario === "approval-deny" && targetFileContents !== undefined && "denied-file-outcome",
        !rootTurnCompleted && "root-turn-not-completed",
      ].filter((failure): failure is string => typeof failure === "string");
      if (
        proofFailures.length > 0 ||
        !nativeRequestId ||
        !selectedSessionId ||
        !siblingSessionId ||
        !handoffStatus ||
        !parentContext
      ) {
        return yield* Effect.fail(
          `Native proof failed at stage=${proofFailures[0] ?? stage} (OpenCode ${scenario}); failures=${proofFailures.join(",")}; request=${publicRequestId ?? "missing"}; nativeRequest=${nativeRequestId ?? "missing"}; handoff=${handoffStatus ?? "missing"}; parent=${rootSessionId}; selected=${selectedSessionId ?? "missing"}; sibling=${siblingSessionId ?? "missing"}; audit=${auditSummary.join(",")}; parentAnswerMarkers=sibling:${finalAnswer.includes("INDEPENDENT_SIBLING_CONTEXT")};accept:${finalAnswer.includes("APPROVAL_ACCEPT")};deny:${finalAnswer.includes("APPROVAL_DENY")};question:${finalAnswer.includes("EXACT_NATIVE_ANSWER_7193")};selectedChildAnswerLength=${selectedChildAnswer.length}.`,
        );
      }

      const result: OpenCodeNativeProbeResult = {
        providerVersion: NodeChildProcess.execFileSync(
          process.env.T3_NATIVE_OPENCODE_BINARY ?? "opencode",
          ["--version"],
          { encoding: "utf8" },
        ).trim(),
        rootSessionId,
        childSessionId: selectedSessionId,
        siblingSessionId,
        nativeRequestId,
        handoffStatus,
        scenario,
        parentContext: parentContextText,
        finalAnswer,
      };
      yield* Effect.logInfo("OpenCode native subagent proof", { proof: result });
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (sessionStarted) {
            yield* adapter.stopSession(threadId).pipe(Effect.ignoreCause);
          }
        }),
      ),
    );
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
}

function recordLike(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function matchingStringPaths(value: unknown, needle: string, limit = 12): Array<string> {
  const matches: Array<string> = [];
  const visit = (current: unknown, path: string, depth: number): void => {
    if (matches.length >= limit || depth > 12) return;
    if (typeof current === "string") {
      if (current.includes(needle)) matches.push(path);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    const object = recordLike(current);
    if (!object) return;
    for (const [key, child] of Object.entries(object)) {
      visit(child, path.length === 0 ? key : `${path}.${key}`, depth + 1);
      if (matches.length >= limit) return;
    }
  };
  if (needle.length > 0) visit(value, "", 0);
  return matches;
}

function readCodexAudit(path: string): Array<CodexAuditEntry> {
  if (!NodeFS.existsSync(path)) return [];
  return NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [decodeCodexAuditEntry(line)];
      } catch {
        return [];
      }
    });
}

interface CodexInferenceTraceEntry {
  readonly sequence: number;
  readonly wallTimeUnixMs: number;
  readonly threadId: string;
  readonly inferenceCallId: string;
  readonly request: unknown;
  readonly response?: unknown;
  readonly responseSequence?: number;
  readonly responseWallTimeUnixMs?: number;
}

function readCodexInferenceRequests(traceRoot: string): Array<CodexInferenceTraceEntry> {
  if (!NodeFS.existsSync(traceRoot)) return [];
  const results: Array<CodexInferenceTraceEntry> = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 4 || results.length >= 512) return;
    let entries: Array<NodeFS.Dirent>;
    try {
      entries = NodeFS.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= 512) return;
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.name !== "trace.jsonl") continue;
      let lines: Array<string>;
      try {
        lines = NodeFS.readFileSync(path, "utf8").split("\n");
      } catch {
        continue;
      }
      const bundleRoot = NodePath.dirname(path);
      const entriesByCallId = new Map<string, number>();
      for (const line of lines) {
        if (!line.trim() || results.length >= 512) continue;
        try {
          const event = recordLike(JSON.parse(line));
          const payload = recordLike(event?.payload);
          if (!payload) continue;
          const threadId =
            typeof payload.thread_id === "string"
              ? payload.thread_id
              : typeof event?.thread_id === "string"
                ? event.thread_id
                : undefined;
          const sequence = typeof event?.seq === "number" ? event.seq : undefined;
          const wallTimeUnixMs =
            typeof event?.wall_time_unix_ms === "number" ? event.wall_time_unix_ms : undefined;
          const inferenceCallId =
            typeof payload.inference_call_id === "string" ? payload.inference_call_id : undefined;
          const loadPayload = (key: string): unknown => {
            const reference = recordLike(payload[key]);
            const relativePath = reference?.path;
            if (typeof relativePath !== "string" || NodePath.isAbsolute(relativePath)) {
              return undefined;
            }
            const payloadPath = NodePath.resolve(bundleRoot, relativePath);
            if (!payloadPath.startsWith(`${bundleRoot}${NodePath.sep}`)) return undefined;
            return JSON.parse(NodeFS.readFileSync(payloadPath, "utf8"));
          };
          if (payload.type === "inference_started") {
            if (
              !threadId ||
              sequence === undefined ||
              wallTimeUnixMs === undefined ||
              !inferenceCallId
            ) {
              continue;
            }
            const request = loadPayload("request_payload");
            if (request === undefined) continue;
            entriesByCallId.set(inferenceCallId, results.length);
            results.push({ sequence, wallTimeUnixMs, threadId, inferenceCallId, request });
            continue;
          }
          if (
            payload.type === "inference_completed" &&
            sequence !== undefined &&
            wallTimeUnixMs !== undefined &&
            inferenceCallId
          ) {
            const index = entriesByCallId.get(inferenceCallId);
            if (index === undefined) continue;
            const response = loadPayload("response_payload");
            if (response === undefined) continue;
            const started = results[index];
            if (!started) continue;
            results[index] = {
              ...started,
              response,
              responseSequence: sequence,
              responseWallTimeUnixMs: wallTimeUnixMs,
            };
          }
        } catch {
          // Incomplete or malformed trace records cannot prove model context.
        }
      }
    }
  };
  visit(traceRoot, 0);
  return results.sort((left, right) => left.sequence - right.sequence);
}

function codexInputText(request: unknown): Array<string> {
  const record = recordLike(request);
  if (!Array.isArray(record?.input)) return [];
  return record.input.flatMap((item) => {
    const message = recordLike(item);
    if (!Array.isArray(message?.content)) return [];
    return message.content.flatMap((contentItem) => {
      const content = recordLike(contentItem);
      return typeof content?.text === "string" ? [content.text] : [];
    });
  });
}

function readCodexQuestionAudit(path: string): Array<Record<string, unknown>> {
  if (!NodeFS.existsSync(path)) return [];
  return NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        const record = recordLike(value);
        return record ? [record] : [];
      } catch {
        return [];
      }
    });
}

function runCodexNativeProbe(scenario: CodexNativeProbeResult["scenario"]) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-child-codex-"));
  const workspace = NodePath.join(root, "workspace");
  const outsideWorkspace = NodePath.join(root, "outside-workspace");
  const targetFile = NodePath.join(outsideWorkspace, `approval-${scenario}.txt`);
  const auditPath = NodePath.join(root, "codex-audit.jsonl");
  const wrapperPath = NodePath.join(root, "codex-audit-wrapper.cjs");
  const mcpServerPath = NodePath.join(root, "codex-question-mcp-server.cjs");
  const mcpAuditPath = NodePath.join(root, "codex-question-mcp-audit.jsonl");
  const rolloutTraceRoot = NodePath.join(root, "codex-rollout-trace");
  NodeFS.mkdirSync(workspace, { recursive: true });
  NodeFS.mkdirSync(outsideWorkspace, { recursive: true });
  NodeFS.mkdirSync(rolloutTraceRoot, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(workspace, "independent-child.txt"),
    "INDEPENDENT_SIBLING_CONTEXT",
    "utf8",
  );
  NodeFS.writeFileSync(wrapperPath, codexAuditWrapperSource("codex", auditPath), {
    mode: 0o700,
  });
  if (scenario === "question") {
    NodeFS.writeFileSync(mcpServerPath, codexQuestionMcpServerSource(mcpAuditPath), {
      mode: 0o700,
    });
  }

  const threadId = ThreadId.make(`native-codex-${scenario}-${NodePath.basename(root)}`);
  const codexThreadId = (session: { readonly resumeCursor?: unknown }) => {
    const cursor = recordLike(session.resumeCursor);
    return typeof cursor?.threadId === "string" ? cursor.threadId : undefined;
  };
  const layer = Layer.effect(
    NativeCodexRuntime,
    makeCodexSessionRuntime({
      threadId,
      binaryPath: wrapperPath,
      cwd: workspace,
      runtimeMode: scenario === "question" ? "auto-accept-edits" : "approval-required",
      environment: {
        ...process.env,
        CODEX_ROLLOUT_TRACE_ROOT: rolloutTraceRoot,
      },
      ...(scenario === "question"
        ? {
            appServerArgs: [
              "-c",
              `mcp_servers.native_question.command=${JSON.stringify(process.execPath)}`,
              "-c",
              `mcp_servers.native_question.args=${JSON.stringify([mcpServerPath])}`,
            ],
          }
        : {}),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

  return Effect.gen(function* () {
    const runtime = yield* NativeCodexRuntime;
    return yield* Effect.gen(function* () {
      const session = yield* runtime.start();
      const rootThreadId = codexThreadId(session);
      if (!rootThreadId) {
        return yield* Effect.fail("Native proof failed at stage=root-thread-identity (Codex).");
      }

      const proofReady = yield* Deferred.make<void>();
      const childByThreadId = new Map<
        string,
        { readonly agentKey: string; readonly parentThreadId?: string }
      >();
      const terminalChildThreadIds = new Set<string>();
      const events: Array<ProviderEvent> = [];
      const approvalRequests: Array<{
        readonly role: "selected-write" | "selected-followup" | "sibling-read";
        readonly threadId: string;
        readonly agentKey: string;
        readonly providerRequestId: string;
      }> = [];
      let requestAgentKey: string | undefined;
      let requestId: string | undefined;
      let nativeRequestId: string | undefined;
      let nativeRequestThreadId: string | undefined;
      let handoffStatus: string | undefined;
      let unexpectedNativeRequest = false;
      let questionAnswerObserved = false;
      let rootFinalAnswer = "";
      let rootTurnCompleted = false;
      let stage = "native-child-request";

      const maybeComplete = Effect.suspend(() => {
        const allChildrenTerminal =
          childByThreadId.size >= 2 &&
          [...childByThreadId.keys()].every((childThreadId) =>
            terminalChildThreadIds.has(childThreadId),
          );
        if (rootFinalAnswer.trim().length > 0 && rootTurnCompleted && allChildrenTerminal) {
          return Deferred.succeed(proofReady, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      });

      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            const payload = recordLike(event.payload);
            if (event.method === "collabAgent/started" || event.method === "collabAgent/activity") {
              const childThreadId =
                typeof payload?.agentThreadId === "string" ? payload.agentThreadId : undefined;
              const agentKey = typeof payload?.agentKey === "string" ? payload.agentKey : undefined;
              if (childThreadId && agentKey) {
                const parentThreadId =
                  typeof payload?.parentThreadId === "string" ? payload.parentThreadId : undefined;
                childByThreadId.set(childThreadId, {
                  agentKey,
                  ...(parentThreadId ? { parentThreadId } : {}),
                });
              }
            }
            if (
              event.method === "collabAgent/turnCompleted" ||
              event.method === "collabAgent/closed"
            ) {
              const childThreadId =
                typeof payload?.agentThreadId === "string" ? payload.agentThreadId : undefined;
              if (childThreadId) terminalChildThreadIds.add(childThreadId);
            }

            if (
              event.kind === "request" &&
              event.agentKey !== undefined &&
              event.requestId !== undefined &&
              (event.method === "item/commandExecution/requestApproval" ||
                event.method === "item/fileChange/requestApproval") &&
              scenario !== "question"
            ) {
              const nativePayload = recordLike(event.payload);
              const commandText = encodeNativeProofJson(nativePayload ?? {});
              const childThreadId =
                typeof nativePayload?.threadId === "string" ? nativePayload.threadId : undefined;
              const targetsSelectedWrite = commandText.includes(targetFile);
              const isExpectedSiblingRead =
                commandText.includes("independent-child.txt") && /\bcat\b/.test(commandText);
              const isExpectedSelectedRead =
                requestId !== undefined &&
                nativeRequestThreadId === childThreadId &&
                targetsSelectedWrite &&
                /\b(?:cat|head|tail|sed)\b/.test(commandText);
              if (targetsSelectedWrite && requestId === undefined) {
                stage = "native-approval-settlement";
                requestId = String(event.requestId);
                requestAgentKey = String(event.agentKey);
                nativeRequestThreadId = childThreadId;
                const response = yield* runtime.respondToRequest(
                  event.requestId,
                  scenario === "approval-accept" ? "accept" : "decline",
                );
                nativeRequestId = response.nativeRequestId;
                if (childThreadId && response.nativeRequestId) {
                  approvalRequests.push({
                    role: "selected-write",
                    threadId: childThreadId,
                    agentKey: String(event.agentKey),
                    providerRequestId: response.nativeRequestId,
                  });
                }
                handoffStatus = response.handoffStatus;
                stage = "parent-model-context";
              } else if (isExpectedSiblingRead || isExpectedSelectedRead) {
                // The read-only sibling runs under a disposable read-only
                // sandbox. Allow only its exact marker read so it can finish
                // and demonstrate that the selected child's context is not
                // delivered into the sibling thread.
                const response = yield* runtime.respondToRequest(event.requestId, "accept");
                if (childThreadId && response.nativeRequestId) {
                  approvalRequests.push({
                    role: isExpectedSiblingRead ? "sibling-read" : "selected-followup",
                    threadId: childThreadId,
                    agentKey: String(event.agentKey),
                    providerRequestId: response.nativeRequestId,
                  });
                }
              } else {
                unexpectedNativeRequest = true;
                stage = "unexpected-native-request";
                yield* runtime.respondToRequest(event.requestId, "decline");
              }
            }

            if (
              event.kind === "request" &&
              event.method === "mcpServer/elicitation/request" &&
              event.requestKind === "mcp-elicitation" &&
              event.agentKey !== undefined &&
              event.requestId !== undefined &&
              scenario === "question"
            ) {
              const requestPayload = recordLike(event.payload);
              const requestedSchema = recordLike(requestPayload?.requestedSchema);
              const properties = recordLike(requestedSchema?.properties);
              if (
                requestPayload?.serverName === "native_question" &&
                Object.keys(properties ?? {}).length === 0
              ) {
                // Codex may ask whether the disposable MCP server's empty
                // elicitation should be accepted before the child calls its
                // declared form tool. This approval is separate from the
                // free-text question that the proof must resolve below.
                stage = "disposable-mcp-approval";
                yield* runtime.respondToRequest(event.requestId, "accept");
              } else {
                unexpectedNativeRequest = true;
                stage = "unexpected-mcp-elicitation-approval";
                yield* runtime.respondToRequest(event.requestId, "decline");
              }
            }

            if (
              event.kind === "request" &&
              (event.method === "item/tool/requestUserInput" ||
                event.method === "mcpServer/elicitation/request") &&
              event.requestKind !== "mcp-elicitation" &&
              event.agentKey !== undefined &&
              event.requestId !== undefined &&
              scenario === "question" &&
              requestId === undefined
            ) {
              stage = "native-question-settlement";
              requestId = String(event.requestId);
              requestAgentKey = String(event.agentKey);
              nativeRequestThreadId =
                typeof payload?.threadId === "string" ? payload.threadId : undefined;
              const questions = Array.isArray(payload?.questions) ? payload.questions : [];
              const nativeParams = recordLike(payload?.params);
              const requestedSchema =
                recordLike(payload?.requestedSchema) ?? recordLike(nativeParams?.requestedSchema);
              const schemaProperties = requestedSchema?.properties;
              const schemaPropertyMap =
                schemaProperties instanceof Map ? [...schemaProperties.keys()] : [];
              const schemaPropertyRecord = recordLike(schemaProperties);
              const questionIds =
                event.method === "mcpServer/elicitation/request"
                  ? schemaPropertyMap.length > 0
                    ? schemaPropertyMap.filter((id): id is string => typeof id === "string")
                    : Object.keys(schemaPropertyRecord ?? {})
                  : questions.flatMap((question) => {
                      const id = recordLike(question)?.id;
                      return typeof id === "string" ? [id] : [];
                    });
              if (questionIds.length === 0) {
                stage = `question-identity-missing(method=${event.method};payloadKeys=${Object.keys(payload ?? {}).join("|")};schemaKeys=${Object.keys(requestedSchema ?? {}).join("|")};propertiesType=${Array.isArray(schemaProperties) ? "array" : typeof schemaProperties};propertiesKeys=${Object.keys(schemaPropertyRecord ?? {}).join("|")};mapKeys=${schemaPropertyMap.join("|")};propertiesJson=${encodeNativeProofJson(schemaProperties)})`;
                yield* Deferred.succeed(proofReady, undefined);
                return;
              }
              const response = yield* runtime.resolveUserInput(event.requestId, {
                type: "answered",
                answers: Object.fromEntries(
                  questionIds.map((id) => [id, "EXACT_NATIVE_ANSWER_7193"]),
                ),
              });
              nativeRequestId = response.nativeRequestId;
              handoffStatus = response.handoffStatus;
              stage = "parent-model-context";
            }

            if (event.method === "item/tool/requestUserInput/answered") {
              const resolution = recordLike(payload?.resolution);
              const answers = recordLike(resolution?.answers);
              questionAnswerObserved =
                answers !== undefined &&
                Object.values(answers).includes("EXACT_NATIVE_ANSWER_7193");
            }

            if (
              event.kind === "notification" &&
              event.agentKey === undefined &&
              event.method === "item/completed" &&
              payload?.item !== undefined
            ) {
              const item = recordLike(payload.item);
              if (item?.type === "agentMessage" && typeof item.text === "string") {
                rootFinalAnswer = item.text;
                stage = "root-final-answer";
              }
            }
            if (event.method === "turn/completed" && event.agentKey === undefined) {
              const turn = recordLike(payload?.turn);
              rootTurnCompleted = turn?.status === "completed";
            }
            yield* maybeComplete;
          }),
        ),
        Effect.forkScoped,
      );

      yield* runtime.sendTurn({
        input: [
          "Start two sibling subagents and wait until both have finished.",
          scenario === "question"
            ? "The question child must call the ask_deployment_token tool from the native_question MCP server. It asks which deployment token to use and returns the exact user's answer. The child must report that exact answer. Do not answer that question yourself and do not use request_user_input."
            : `The approval child must use the shell tool to write exactly APPROVAL_${scenario === "approval-accept" ? "ACCEPT" : "DENY"} to ${targetFile}. Do not write that path yourself.`,
          "The independent sibling must run only `cat independent-child.txt`, include its output in its result, and must not touch the outside-workspace path.",
          "After both children finish, report the action child's outcome and repeat the independent sibling marker.",
        ].join("\n"),
        interactionMode: "default",
      });
      const completion = yield* Deferred.await(proofReady).pipe(
        Effect.timeoutOption("180 seconds"),
      );
      if (completion._tag === "None") {
        const timeoutAudit = readCodexAudit(auditPath);
        const timeoutRequestId = requestId;
        const timeoutInjectionRequest = timeoutRequestId
          ? timeoutAudit.find(
              (entry) =>
                entry.kind === "parent-injection-request" &&
                entry.content?.includes(`request ${timeoutRequestId}`),
            )
          : undefined;
        const timeoutInjectionAck = timeoutInjectionRequest
          ? timeoutAudit.find(
              (entry) =>
                entry.kind === "parent-injection-accepted" &&
                entry.requestId === timeoutInjectionRequest.requestId,
            )
          : undefined;
        const timeoutInferenceSummary = readCodexInferenceRequests(rolloutTraceRoot)
          .filter(
            (entry) =>
              entry.threadId === rootThreadId &&
              (timeoutInjectionAck?.wallTimeUnixMs === undefined ||
                entry.wallTimeUnixMs > timeoutInjectionAck.wallTimeUnixMs),
          )
          .slice(0, 8)
          .map((entry) => {
            const texts = codexInputText(entry.request);
            return {
              sequence: entry.sequence,
              wallTimeUnixMs: entry.wallTimeUnixMs,
              hasSelectedRequestId:
                timeoutRequestId !== undefined &&
                texts.some((text) => text.includes(timeoutRequestId)),
              hasExactResolution: texts.some((text) =>
                scenario === "question"
                  ? text.includes("EXACT_NATIVE_ANSWER_7193")
                  : text.includes(
                      `The T3 user chose "${scenario === "approval-accept" ? "accept" : "decline"}" for child`,
                    ),
              ),
              responseSequence: entry.responseSequence ?? null,
              responseIncludesFinalAnswer:
                typeof entry.response === "object" &&
                entry.response !== null &&
                rootFinalAnswer.length > 0 &&
                matchingStringPaths(entry.response, rootFinalAnswer).length > 0,
            };
          });
        const timedOutChildren = [...childByThreadId.entries()].map(([agentThreadId, child]) => ({
          agentThreadId,
          agentKey: child.agentKey,
          terminal: terminalChildThreadIds.has(agentThreadId),
        }));
        return yield* Effect.fail(
          `Native proof failed at stage=${stage} (Codex ${scenario}); rootTurnCompleted=${rootTurnCompleted}; rootFinalAnswerLength=${rootFinalAnswer.length}; injectionAckWallTimeUnixMs=${timeoutInjectionAck?.wallTimeUnixMs ?? "missing"}; rootInferencesAfterInjection=${encodeNativeProofJson(timeoutInferenceSummary)}; children=${encodeNativeProofJson(timedOutChildren)}; eventMethods=${[
            ...new Set(events.map((event) => `${event.method}${event.agentKey ? "@child" : ""}`)),
          ].join(",")}.`,
        );
      }
      if (scenario === "question" && requestId === undefined) {
        return yield* Effect.fail(
          `Native proof failed at stage=${stage} (Codex question); mcpAudit=${encodeNativeProofJson(readCodexQuestionAudit(mcpAuditPath))}.`,
        );
      }
      if (scenario === "question" && stage.startsWith("question-identity-missing")) {
        return yield* Effect.fail(
          `Native proof failed at stage=${stage} (Codex question); mcpAudit=${encodeNativeProofJson(readCodexQuestionAudit(mcpAuditPath))}.`,
        );
      }

      const childEntries = [...childByThreadId.entries()];
      const requestedChild = childEntries.find(
        ([childThreadId, child]) =>
          child.agentKey === requestAgentKey &&
          (nativeRequestThreadId === undefined || childThreadId === nativeRequestThreadId),
      );
      const sibling = childEntries.find(([, child]) => child.agentKey !== requestAgentKey);
      const audit = readCodexAudit(auditPath);
      const selectedApproval = approvalRequests.find((entry) => entry.role === "selected-write");
      const siblingApproval = approvalRequests.find((entry) => entry.role === "sibling-read");
      const acceptedInjections = audit.filter(
        (entry) =>
          entry.kind === "parent-injection-accepted" && entry.method === "thread/inject_items",
      );
      const nativeMethod =
        scenario === "question"
          ? "mcpServer/elicitation/request"
          : "item/commandExecution/requestApproval";
      const nativeRequest = audit.find(
        (entry) =>
          entry.kind === "native-child-request" &&
          (nativeRequestId === undefined ||
            (scenario === "question"
              ? entry.requestId === nativeRequestId
              : entry.content === nativeRequestId)) &&
          (nativeRequestThreadId === undefined || entry.threadId === nativeRequestThreadId) &&
          (entry.method === nativeMethod ||
            (scenario !== "question" && entry.method === "item/fileChange/requestApproval")),
      );
      const nativeSettlement = audit.find(
        (entry) =>
          entry.kind === "native-child-request-settled" &&
          (nativeRequest === undefined || entry.requestId === nativeRequest.requestId) &&
          (entry.method === nativeMethod ||
            (scenario !== "question" && entry.method === "item/fileChange/requestApproval")),
      );
      const siblingNativeRequest = siblingApproval
        ? audit.find(
            (entry) =>
              entry.kind === "native-child-request" &&
              entry.method === "item/commandExecution/requestApproval" &&
              entry.threadId === siblingApproval.threadId &&
              entry.content === siblingApproval.providerRequestId,
          )
        : undefined;
      const siblingNativeSettlement = siblingNativeRequest
        ? audit.find(
            (entry) =>
              entry.kind === "native-child-request-settled" &&
              entry.method === siblingNativeRequest.method &&
              entry.requestId === siblingNativeRequest.requestId &&
              entry.status === "accepted",
          )
        : undefined;
      const injectionRequest = audit.find(
        (entry) =>
          entry.kind === "parent-injection-request" &&
          entry.content?.includes(`request ${requestId}`),
      );
      const injection = injectionRequest
        ? acceptedInjections.find((entry) => entry.requestId === injectionRequest.requestId)
        : undefined;
      const nativeParent = nativeRequestThreadId
        ? audit.find(
            (entry) =>
              entry.kind === "parent-thread-child" && entry.childThreadId === nativeRequestThreadId,
          )
        : undefined;
      const rootAnswer = audit.find(
        (entry) =>
          entry.kind === "root-assistant-item" &&
          entry.threadId === rootThreadId &&
          entry.content === rootFinalAnswer,
      );
      const inferenceRequests = readCodexInferenceRequests(rolloutTraceRoot);
      const selectedRequestId = requestId;
      const inputTexts = (entry: (typeof inferenceRequests)[number]) =>
        codexInputText(entry.request);
      const injectionAcceptedAt = injection?.wallTimeUnixMs;
      const parentInference =
        injectionAcceptedAt !== undefined
          ? inferenceRequests.find(
              (entry) =>
                entry.threadId === rootThreadId && entry.wallTimeUnixMs > injectionAcceptedAt,
            )
          : undefined;
      const expectedHandoffText =
        scenario === "question"
          ? `T3 recorded the user's answer to child request ${requestId ?? ""}:`
          : `The T3 user chose "${scenario === "approval-accept" ? "accept" : "decline"}" for child`;
      const parentModelInputTexts = parentInference ? inputTexts(parentInference) : [];
      const parentInferenceHasSelectedRequestId =
        selectedRequestId !== undefined &&
        parentModelInputTexts.some((text) => text.includes(selectedRequestId));
      const parentInferenceHasExactAnswer =
        parentInference !== undefined &&
        parentModelInputTexts.some((text) => text.includes(expectedHandoffText)) &&
        (scenario !== "question" ||
          parentModelInputTexts.some((text) => text.includes("EXACT_NATIVE_ANSWER_7193")));
      const siblingInferenceRequests = sibling
        ? inferenceRequests.filter((entry) => entry.threadId === sibling[0])
        : [];
      const siblingInferenceHasSelectedRequest =
        selectedRequestId !== undefined &&
        siblingInferenceRequests.some((entry) =>
          inputTexts(entry).some((text) => text.includes(selectedRequestId)),
        );
      const finalAnswerInference = inferenceRequests.find(
        (entry) =>
          entry.threadId === rootThreadId &&
          entry.response !== undefined &&
          matchingStringPaths(entry.response, rootFinalAnswer).length > 0,
      );
      const parentInferenceAfterInjection =
        parentInference !== undefined &&
        injectionAcceptedAt !== undefined &&
        parentInference.wallTimeUnixMs > injectionAcceptedAt;
      const finalAnswerAfterParentInference =
        parentInference !== undefined &&
        finalAnswerInference !== undefined &&
        finalAnswerInference.sequence >= parentInference.sequence &&
        (finalAnswerInference.responseSequence ?? 0) > parentInference.sequence;
      const parentRequestRecord = recordLike(parentInference?.request);
      const parentInputItems = Array.isArray(parentRequestRecord?.input)
        ? parentRequestRecord.input
        : [];
      const parentInferenceShape = {
        requestKeys: Object.keys(parentRequestRecord ?? {}),
        inputItemKinds: parentInputItems.map((item) => {
          const record = recordLike(item);
          return `${typeof record?.type === "string" ? record.type : "?"}:${typeof record?.role === "string" ? record.role : "?"}`;
        }),
        requestIdPaths: requestId ? matchingStringPaths(parentInference?.request, requestId) : [],
        handoffPhrasePaths: matchingStringPaths(parentInference?.request, "T3 user chose"),
        exactHandoffPaths: matchingStringPaths(parentInference?.request, expectedHandoffText),
        questionAnswerPaths: matchingStringPaths(
          parentInference?.request,
          "EXACT_NATIVE_ANSWER_7193",
        ),
        parentInferenceAfterInjection,
        finalAnswerInferenceSequence: finalAnswerInference?.sequence ?? null,
        finalAnswerResponseSequence: finalAnswerInference?.responseSequence ?? null,
        finalAnswerAfterParentInference,
      };
      const proofFailures = [
        !requestId && "public-request-id",
        !nativeRequestId && "native-request-id",
        !requestedChild && "selected-child-correlation",
        !sibling && "sibling-correlation",
        childEntries.length < 2 && "two-children",
        !nativeRequest && "native-request-correlation",
        scenario !== "question" && !selectedApproval && "selected-native-item-correlation",
        scenario !== "question" && !siblingApproval && "sibling-native-request-observed",
        scenario !== "question" && !siblingNativeRequest && "sibling-native-item-correlation",
        scenario !== "question" && !siblingNativeSettlement && "sibling-native-settlement",
        scenario !== "question" &&
          selectedApproval !== undefined &&
          siblingApproval !== undefined &&
          selectedApproval.providerRequestId === siblingApproval.providerRequestId &&
          "selected-and-sibling-native-items-not-distinct",
        !nativeSettlement && "native-settlement-correlation",
        nativeSettlement?.status !== "accepted" && "native-settlement-status",
        scenario === "question"
          ? nativeRequest?.requestId !== nativeRequestId && "native-json-rpc-id"
          : nativeRequest?.content !== nativeRequestId && "native-item-id",
        unexpectedNativeRequest && "unexpected-native-request",
        acceptedInjections.length < 1 && "accepted-injection",
        !injection && "selected-request-injection",
        !nativeParent?.threadId && "native-immediate-parent",
        !parentInference && "model-facing-parent-inference",
        !parentInferenceHasSelectedRequestId && "model-facing-selected-request-id",
        !parentInferenceHasExactAnswer && "model-facing-exact-handoff-content",
        !parentInferenceAfterInjection && "parent-inference-after-injection",
        !finalAnswerInference && "model-facing-final-answer-response",
        !finalAnswerAfterParentInference && "final-answer-after-parent-inference",
        siblingInferenceRequests.length === 0 && "sibling-model-inference",
        siblingInferenceHasSelectedRequest && "selected-handoff-leaked-to-sibling",
        injection !== undefined &&
          nativeParent?.threadId !== undefined &&
          injection.threadId !== nativeParent.threadId &&
          "injection-wrong-parent",
        injection !== undefined &&
          requestedChild !== undefined &&
          injection.threadId === requestedChild[0] &&
          "injection-targets-child",
        injection !== undefined &&
          sibling !== undefined &&
          injection.threadId === sibling[0] &&
          "injection-targets-sibling",
        injection !== undefined &&
          nativeSettlement !== undefined &&
          injection.sequence >= nativeSettlement.sequence &&
          "injection-after-settlement",
        injection !== undefined &&
          rootAnswer !== undefined &&
          injection.sequence >= rootAnswer.sequence &&
          "injection-after-final-answer",
        handoffStatus !== "recorded" && "handoff-not-recorded",
      ].filter((failure): failure is string => typeof failure === "string");
      if (
        !requestId ||
        !nativeRequestId ||
        !requestedChild ||
        !sibling ||
        childEntries.length < 2 ||
        !nativeRequest ||
        (scenario !== "question" && !selectedApproval) ||
        (scenario !== "question" && !siblingApproval) ||
        (scenario !== "question" && !siblingNativeRequest) ||
        (scenario !== "question" && !siblingNativeSettlement) ||
        (scenario !== "question" &&
          selectedApproval !== undefined &&
          siblingApproval !== undefined &&
          selectedApproval.providerRequestId === siblingApproval.providerRequestId) ||
        !nativeSettlement ||
        nativeSettlement.status !== "accepted" ||
        (scenario === "question"
          ? nativeRequest.requestId !== nativeRequestId
          : nativeRequest.content !== nativeRequestId) ||
        unexpectedNativeRequest ||
        acceptedInjections.length < 1 ||
        !injection ||
        !nativeParent?.threadId ||
        !parentInference ||
        !parentInferenceHasSelectedRequestId ||
        !parentInferenceHasExactAnswer ||
        !parentInferenceAfterInjection ||
        !finalAnswerInference ||
        !finalAnswerAfterParentInference ||
        siblingInferenceRequests.length === 0 ||
        siblingInferenceHasSelectedRequest ||
        injection.threadId !== nativeParent.threadId ||
        injection.threadId === requestedChild[0] ||
        injection.threadId === sibling[0] ||
        injection.sequence >= (nativeSettlement?.sequence ?? Number.MAX_SAFE_INTEGER) ||
        injection.sequence >= (rootAnswer?.sequence ?? Number.MAX_SAFE_INTEGER) ||
        handoffStatus !== "recorded"
      ) {
        return yield* Effect.fail(
          `Native proof failed at stage=${!requestId ? stage : "immediate-parent-model-context"} (Codex ${scenario}); failures=${proofFailures.join(",")}; requestId=${requestId ?? "missing"}; nativeRequestId=${nativeRequestId ?? "missing"}; requestThread=${nativeRequestThreadId ?? "missing"}; selected=${requestedChild?.[0] ?? "missing"}; sibling=${sibling?.[0] ?? "missing"}; actualParent=${nativeParent?.threadId ?? "missing"}; injectionParent=${injection?.threadId ?? "missing"}; handoff=${handoffStatus ?? "missing"}; parentInferenceSequence=${parentInference?.sequence ?? "missing"}; siblingInferenceCount=${siblingInferenceRequests.length}; parentInferenceShape=${encodeNativeProofJson(parentInferenceShape)}; children=${encodeNativeProofJson(childEntries)}; audit=${encodeNativeProofJson(audit)}.`,
        );
      }
      if (scenario === "question" && !questionAnswerObserved) {
        return yield* Effect.fail(
          "Native proof failed at stage=exact-native-question-answer (Codex question).",
        );
      }
      const questionAudit = readCodexQuestionAudit(mcpAuditPath);
      if (
        scenario === "question" &&
        (!questionAudit.some((entry) => entry.kind === "tool-called") ||
          !questionAudit.some(
            (entry) =>
              entry.kind === "elicitation-response" &&
              entry.action === "accept" &&
              entry.answeredExactly === true,
          ))
      ) {
        return yield* Effect.fail(
          `Native proof failed at stage=mcp-native-answer (Codex question); mcpAudit=${encodeNativeProofJson(questionAudit)}.`,
        );
      }
      if (
        !rootFinalAnswer.includes("INDEPENDENT_SIBLING_CONTEXT") ||
        (scenario === "question" && !rootFinalAnswer.includes("EXACT_NATIVE_ANSWER_7193"))
      ) {
        return yield* Effect.fail(
          `Native proof failed at stage=parent-final-answer (Codex ${scenario}); final answer did not report the child result and sibling marker.`,
        );
      }
      const targetFileExists = NodeFS.existsSync(targetFile);
      if (scenario !== "question" && targetFileExists !== (scenario === "approval-accept")) {
        return yield* Effect.fail(
          `Native proof failed at stage=approval-outcome (Codex ${scenario}).`,
        );
      }
      const providerVersion = NodeChildProcess.execFileSync("codex", ["--version"], {
        encoding: "utf8",
      }).trim();
      const result: CodexNativeProbeResult = {
        providerVersion,
        rootThreadId,
        childThreadId: requestedChild[0],
        siblingThreadId: sibling[0],
        nativeRequestId,
        handoffStatus: handoffStatus ?? "unavailable",
        scenario,
        requestId: requestId ?? "missing",
        parentInferenceSequence: parentInference?.sequence ?? -1,
        parentInferenceAfterInjection,
        parentInferenceHasSelectedRequest: parentInferenceHasSelectedRequestId,
        parentInferenceHasExactAnswer,
        siblingInferenceHasSelectedRequest,
        finalAnswerInferenceSequence: finalAnswerInference?.sequence ?? -1,
        finalAnswerResponseSequence: finalAnswerInference?.responseSequence ?? -1,
      };
      process.stdout.write(
        `[codex native model-context proof] ${encodeNativeProofJson({
          scenario,
          providerVersion,
          rootThreadId,
          selectedChildThreadId: requestedChild[0],
          siblingThreadId: sibling[0],
          requestId: requestId ?? "missing",
          nativeRequestId,
          handoffStatus: result.handoffStatus,
          injectionAckWallTimeUnixMs: injection?.wallTimeUnixMs ?? null,
          parentInferenceSequence: result.parentInferenceSequence,
          parentInferenceWallTimeUnixMs: parentInference?.wallTimeUnixMs ?? null,
          parentInferenceAfterInjection,
          parentInputHasSelectedRequestId: parentInferenceHasSelectedRequestId,
          parentInputHasExactResolution: parentInferenceHasExactAnswer,
          siblingInputHasSelectedRequestId: siblingInferenceHasSelectedRequest,
          finalAnswerInferenceSequence: result.finalAnswerInferenceSequence,
          finalAnswerResponseSequence: result.finalAnswerResponseSequence,
          finalResponseAfterParentInput: finalAnswerAfterParentInference,
        })}\n`,
      );
      yield* Effect.logInfo("Codex native subagent proof", { proof: result });
    }).pipe(Effect.ensuring(runtime.close));
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
}

function wrapClaudeHooks(
  hooks: ClaudeQueryOptions["hooks"],
  parentContexts: Array<CapturedParentContext>,
  hookCalls: Array<CapturedHookCall>,
  trace: Array<CapturedNativeTrace>,
  nextSequence: () => number,
) {
  const currentHooks = hooks ?? {};
  type HookMatchers = NonNullable<NonNullable<ClaudeQueryOptions["hooks"]>["PostToolBatch"]>;
  const wrap = (entries: HookMatchers): HookMatchers =>
    entries.map((entry) => ({
      ...entry,
      hooks: entry.hooks.map(
        (hook) =>
          (async (...args: Parameters<typeof hook>) => {
            const result = await hook(...args);
            const output =
              result && "hookSpecificOutput" in result ? result.hookSpecificOutput : undefined;
            const additionalContext =
              output && typeof output === "object" && "additionalContext" in output
                ? output.additionalContext
                : undefined;
            const hookInput = args[0];
            const capturedHook: CapturedHookCall = {
              agentId: typeof hookInput.agent_id === "string" ? hookInput.agent_id : null,
              hookEvent: hookInput.hook_event_name,
              sequence: nextSequence(),
              ...(typeof additionalContext === "string" ? { additionalContext } : {}),
            };
            hookCalls.push(capturedHook);
            trace.push({
              sequence: capturedHook.sequence,
              kind: "hook",
              detail: {
                event: capturedHook.hookEvent,
                agentId: capturedHook.agentId,
                deliveredContext: typeof additionalContext === "string" ? "yes" : "no",
              },
            });
            if (typeof additionalContext === "string") {
              parentContexts.push({
                agentId: capturedHook.agentId,
                hookEvent: hookInput.hook_event_name,
                text: additionalContext,
                sequence: capturedHook.sequence,
              });
            }
            return result;
          }) satisfies HookCallback,
      ),
    }));
  const postToolBatch = currentHooks.PostToolBatch;
  const userPromptSubmit = currentHooks.UserPromptSubmit;
  const stop = currentHooks.Stop;
  const subagentStop = currentHooks.SubagentStop;

  return {
    ...currentHooks,
    ...(postToolBatch ? { PostToolBatch: wrap(postToolBatch) } : {}),
    ...(userPromptSubmit ? { UserPromptSubmit: wrap(userPromptSubmit) } : {}),
    ...(stop ? { Stop: wrap(stop) } : {}),
    ...(subagentStop ? { SubagentStop: wrap(subagentStop) } : {}),
  };
}

function runClaudeNativeProbe(decision: "accept" | "decline") {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-child-claude-"));
  const workspace = NodePath.join(root, "workspace");
  const siblingDirectory = NodePath.join(root, "outside-workspace");
  const targetFile = NodePath.join(siblingDirectory, `approval-${decision}.txt`);
  NodeFS.mkdirSync(workspace, { recursive: true });
  NodeFS.mkdirSync(siblingDirectory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(workspace, "independent-child.txt"),
    "INDEPENDENT_SIBLING_CONTEXT",
    "utf8",
  );

  const parentContexts: Array<CapturedParentContext> = [];
  const hookCalls: Array<CapturedHookCall> = [];
  const trace: Array<CapturedNativeTrace> = [];
  let sequence = 0;
  const nextSequence = () => ++sequence;
  let nativeRequestId: string | undefined;
  let childAgentKey: string | undefined;
  let finalAnswer = "";
  let finalAnswerSequence: number | undefined;
  const threadId = ThreadId.make(`native-claude-${decision}-${NodePath.basename(root)}`);
  const settings = decodeClaudeSettings({
    binaryPath: "claude",
    launchArgs: "--model haiku --max-budget-usd 0.50",
  });
  const layer = Layer.effect(
    NativeClaudeAdapter,
    makeClaudeAdapter(settings, {
      createQuery: ({ prompt, options }) =>
        (() => {
          const originalCanUseTool = options.canUseTool;
          const nativeQuery = query({
            prompt,
            options: {
              ...options,
              ...(originalCanUseTool
                ? {
                    canUseTool: async (toolName, toolInput, callbackOptions) => {
                      const callbackSequence = nextSequence();
                      trace.push({
                        sequence: callbackSequence,
                        kind: "canUseTool.request",
                        detail: {
                          toolName,
                          agentId: callbackOptions.agentID ?? null,
                          toolUseId: callbackOptions.toolUseID ?? null,
                          requestId: callbackOptions.requestId ?? null,
                        },
                      });
                      const result = await originalCanUseTool(toolName, toolInput, callbackOptions);
                      trace.push({
                        sequence: nextSequence(),
                        kind: "canUseTool.settled",
                        detail: {
                          toolName,
                          agentId: callbackOptions.agentID ?? null,
                          toolUseId: callbackOptions.toolUseID ?? null,
                          behavior:
                            result && typeof result === "object" && "behavior" in result
                              ? String(result.behavior)
                              : "unknown",
                        },
                      });
                      return result;
                    },
                  }
                : {}),
              hooks: wrapClaudeHooks(options.hooks, parentContexts, hookCalls, trace, nextSequence),
            },
          });
          return new Proxy(nativeQuery, {
            get(target, property, receiver) {
              if (property === Symbol.asyncIterator) {
                return () =>
                  (async function* () {
                    for await (const message of target) {
                      const messageType = String(Reflect.get(message, "type"));
                      if (messageType === "task_started") {
                        trace.push({
                          sequence: nextSequence(),
                          kind: "task_started",
                          detail: {
                            taskId: (Reflect.get(message, "task_id") as string | undefined) ?? null,
                            toolUseId:
                              (Reflect.get(message, "tool_use_id") as string | undefined) ?? null,
                            agentId:
                              typeof Reflect.get(message, "agent_id") === "string"
                                ? String(Reflect.get(message, "agent_id"))
                                : null,
                            description:
                              (Reflect.get(message, "description") as string | undefined) ?? null,
                          },
                        });
                      } else if (messageType === "assistant") {
                        trace.push({
                          sequence: nextSequence(),
                          kind: "assistant.message",
                          detail: {
                            agentId:
                              typeof Reflect.get(message, "agent_id") === "string"
                                ? String(Reflect.get(message, "agent_id"))
                                : null,
                            parentAgentId:
                              typeof Reflect.get(message, "parent_agent_id") === "string"
                                ? String(Reflect.get(message, "parent_agent_id"))
                                : null,
                          },
                        });
                      } else if (messageType === "result") {
                        const resultText = Reflect.get(message, "result");
                        trace.push({
                          sequence: nextSequence(),
                          kind: "native.result",
                          detail: {
                            subtype: String(Reflect.get(message, "subtype")),
                            status: Reflect.get(message, "is_error") ? "error" : "success",
                            turns: String(Reflect.get(message, "num_turns")),
                            resultCharacters:
                              typeof resultText === "string"
                                ? String(resultText.length)
                                : "unknown",
                          },
                        });
                      } else if (
                        messageType === "system" &&
                        Reflect.get(message, "subtype") === "task_notification"
                      ) {
                        trace.push({
                          sequence: nextSequence(),
                          kind: "native.task_notification",
                          detail: {
                            taskId: (Reflect.get(message, "task_id") as string | undefined) ?? null,
                            status: (Reflect.get(message, "status") as string | undefined) ?? null,
                          },
                        });
                      }
                      yield message;
                    }
                  })();
              }
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        })(),
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(workspace, root)),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const adapter = yield* NativeClaudeAdapter;
    const session = yield* adapter.startSession({
      threadId,
      provider: claudeProvider,
      cwd: workspace,
      runtimeMode: "auto-accept-edits",
    });
    yield* Effect.gen(function* () {
      const proofReady = yield* Deferred.make<void>();
      const events = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const startedTaskIds = new Set<string>();
      const terminalTaskIds = new Set<string>();
      let finalAnswerAfterContext = false;
      let completedTurnAfterContext = false;
      const maybeCompleteProof = Effect.suspend(() => {
        const allExpectedTasksTerminal =
          startedTaskIds.size >= 2 &&
          [...startedTaskIds].every((taskId) => terminalTaskIds.has(taskId));
        if (finalAnswerAfterContext && completedTurnAfterContext && allExpectedTasksTerminal) {
          return Deferred.succeed(proofReady, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      });
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* Ref.update(events, (current) => [...current, event]);
            if (event.type === "task.started") {
              startedTaskIds.add(String(event.payload.taskId));
              trace.push({
                sequence: nextSequence(),
                kind: "runtime.task.started",
                detail: {
                  taskId: String(event.payload.taskId),
                  agentKey: String(event.payload.agentKey),
                  parentAgentKey: event.payload.parentAgentKey
                    ? String(event.payload.parentAgentKey)
                    : null,
                  toolUseId: event.payload.toolUseId ?? null,
                },
              });
            }
            if (event.type === "task.completed") {
              terminalTaskIds.add(String(event.payload.taskId));
            }
            if (event.type === "request.opened" && event.agentKey !== undefined) {
              childAgentKey = String(event.agentKey);
              const rawPayload = event.raw?.payload;
              nativeRequestId =
                typeof rawPayload === "object" &&
                rawPayload !== null &&
                "providerRequestId" in rawPayload &&
                typeof rawPayload.providerRequestId === "string"
                  ? rawPayload.providerRequestId
                  : undefined;
              trace.push({
                sequence: nextSequence(),
                kind: "runtime.request.opened",
                detail: {
                  requestId: String(event.requestId),
                  agentKey: String(event.agentKey),
                  providerRequestId: nativeRequestId ?? null,
                },
              });
              childAgentKey ??= String(event.agentKey);
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                decision,
              );
            }
            if (
              event.threadId === threadId &&
              event.type === "item.completed" &&
              event.agentKey === undefined &&
              event.payload.itemType === "assistant_message" &&
              typeof event.payload.detail === "string"
            ) {
              finalAnswer = event.payload.detail;
              trace.push({
                sequence: (finalAnswerSequence = nextSequence()),
                kind: "runtime.root.item.completed",
                detail: {
                  itemType:
                    "itemType" in event.payload && typeof event.payload.itemType === "string"
                      ? event.payload.itemType
                      : null,
                },
              });
              const expectedChoice = decision === "accept" ? "allow" : "deny";
              finalAnswerAfterContext = parentContexts.some(
                (entry) =>
                  entry.agentId === null &&
                  entry.text.toLowerCase().includes(`chose to ${expectedChoice}`) &&
                  entry.sequence < (finalAnswerSequence ?? Number.MIN_SAFE_INTEGER),
              );
            }
            if (event.threadId === threadId && event.type === "turn.completed") {
              completedTurnAfterContext =
                event.payload.state === "completed" && finalAnswerAfterContext;
              yield* maybeCompleteProof;
            }
            if (event.threadId === threadId && event.type === "task.completed") {
              yield* maybeCompleteProof;
            }
          }),
        ),
        Effect.forkScoped,
      );

      yield* adapter.sendTurn({
        threadId,
        input: [
          "Start two sibling subagents and wait for both.",
          `The approval child must use the Bash tool to write exactly APPROVAL_${decision.toUpperCase()} to ${targetFile}. Do not write that path yourself.`,
          "The independent sibling must only read independent-child.txt and include its contents in its result; it must not touch the outside-workspace path.",
          "After both children finish, report the approval child's outcome and repeat the independent sibling marker.",
        ].join("\n"),
        attachments: [],
      });
      const completion = yield* Deferred.await(proofReady).pipe(
        Effect.timeoutOption("180 seconds"),
      );
      if (completion._tag === "None") {
        const observed = yield* Ref.get(events);
        return yield* Effect.fail(
          `Native proof failed at stage=${nativeRequestId === undefined ? "native-child-request" : "final-answer"} (decision=${decision}); observed events=${
            observed
              .map((event) => `${event.type}${event.agentKey ? `@${event.agentKey}` : ""}`)
              .join(",") || "none"
          }; provider trace=${encodeNativeProofJson(trace)}.`,
        );
      }
      const observed = yield* Ref.get(events);
      const approval = observed.find(
        (event) => event.type === "request.opened" && event.agentKey !== undefined,
      );
      if (approval?.type !== "request.opened" || approval.agentKey === undefined) {
        yield* Effect.logInfo("Claude native child-request probe", {
          runtimeEvents: observed.map((event) => event.type),
          trace: encodeNativeProofJson(trace),
          targetFileExists: NodeFS.existsSync(targetFile),
          finalAnswerPresent: finalAnswer.trim().length > 0,
        });
        return yield* Effect.fail(
          `Native proof failed at stage=native-child-request (decision=${decision}).`,
        );
      }
      const requestPayload = approval.raw?.payload;
      if (nativeRequestId === undefined && typeof requestPayload === "object" && requestPayload) {
        nativeRequestId =
          "providerRequestId" in requestPayload &&
          typeof requestPayload.providerRequestId === "string"
            ? requestPayload.providerRequestId
            : undefined;
      }
      if (!nativeRequestId) {
        return yield* Effect.fail(
          `Native proof failed at stage=native-request-id (decision=${decision}).`,
        );
      }
      const expectedChoice = decision === "accept" ? "allow" : "deny";
      const deliveredContext = parentContexts.find(
        (entry) =>
          entry.agentId === null &&
          entry.sequence >
            (trace.find((entry) => entry.kind === "canUseTool.settled")?.sequence ??
              Number.MAX_SAFE_INTEGER) &&
          entry.text.toLowerCase().includes(`chose to ${expectedChoice}`),
      );
      if (!deliveredContext) {
        const observed = yield* Ref.get(events);
        yield* Effect.logInfo("Claude native approval context probe", {
          hookCalls,
          trace: encodeNativeProofJson(trace),
          childTasks: observed.flatMap((event) =>
            event.type === "task.started"
              ? [{ agentKey: event.payload.agentKey, taskId: event.payload.taskId }]
              : [],
          ),
          targetFileExists: NodeFS.existsSync(targetFile),
          finalAnswer: finalAnswer.slice(0, 300),
        });
        return yield* Effect.fail(
          `Native proof failed at stage=next-parent-context (decision=${decision}).`,
        );
      }
      const targetFileExists = NodeFS.existsSync(targetFile);
      if (targetFileExists !== (decision === "accept")) {
        return yield* Effect.fail(
          `Native proof failed at stage=approval-outcome (decision=${decision}).`,
        );
      }
      if (!finalAnswer.trim()) {
        return yield* Effect.fail(
          `Native proof failed at stage=final-answer (decision=${decision}).`,
        );
      }
      const taskStarts = observed.flatMap((event) =>
        event.type === "task.started" ? [event.payload] : [],
      );
      const requestedTask = taskStarts.find(
        (task) => String(task.agentKey) === String(approval.agentKey),
      );
      const siblingTask = taskStarts.find(
        (task) => String(task.agentKey) !== String(approval.agentKey),
      );
      if (
        !childAgentKey ||
        String(approval.agentKey) !== childAgentKey ||
        !requestedTask ||
        !siblingTask ||
        taskStarts.length < 2
      ) {
        return yield* Effect.fail(
          `Native proof failed at stage=child-sibling-identity (decision=${decision}).`,
        );
      }
      if (
        parentContexts.some(
          (entry) => entry.agentId !== null && entry.text.includes(nativeRequestId ?? ""),
        ) ||
        finalAnswerSequence === undefined ||
        deliveredContext.sequence >= finalAnswerSequence
      ) {
        yield* Effect.logInfo("Claude native approval boundary probe", {
          deliveredContext,
          finalAnswerSequence,
          siblingContexts: parentContexts.filter((entry) => entry.agentId !== null),
          trace: encodeNativeProofJson(trace),
          finalAnswer: finalAnswer.slice(0, 300),
        });
        return yield* Effect.fail(
          `Native proof failed at stage=parent-boundary-isolation (decision=${decision}).`,
        );
      }
      const result: ClaudeNativeProbeResult = {
        providerVersion: NodeChildProcess.execFileSync("claude", ["--version"], {
          encoding: "utf8",
        }).trim(),
        nativeRequestId,
        childAgentKey,
        siblingAgentKey: String(siblingTask.agentKey),
        decision,
        parentContexts,
        trace,
        finalAnswer,
        targetFileExists,
      };
      yield* Effect.logInfo("Native subagent proof", { proof: result });
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* adapter.stopSession(session.threadId).pipe(Effect.ignoreCause);
        }),
      ),
    );
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
}

describe.skipIf(!nativeProofEnabled)("native subagent handoff proof", () => {
  it.live("Claude approval records parent context before the final answer", () =>
    runClaudeNativeProbe("accept"),
  );
  it.live("Claude denial records parent context before the final answer", () =>
    runClaudeNativeProbe("decline"),
  );
  it.live(
    "Codex approval records immediate-parent context before the final answer",
    () => runCodexNativeProbe("approval-accept"),
    { timeout: 210_000 },
  );
  it.live(
    "Codex denial records immediate-parent context before the final answer",
    () => runCodexNativeProbe("approval-deny"),
    { timeout: 210_000 },
  );
  it.live(
    "Codex question records the exact answer and immediate-parent context",
    () => runCodexNativeProbe("question"),
    { timeout: 210_000 },
  );
  it.live(
    "OpenCode approval records immediate-parent context before the final answer",
    () => runOpenCodeNativeProbe("approval-accept"),
    { timeout: 210_000 },
  );
  it.live(
    "OpenCode denial records immediate-parent context before the final answer",
    () => runOpenCodeNativeProbe("approval-deny"),
    { timeout: 210_000 },
  );
  it.live(
    "OpenCode question records the exact answer and immediate-parent context",
    () => runOpenCodeNativeProbe("question"),
    { timeout: 210_000 },
  );
});
