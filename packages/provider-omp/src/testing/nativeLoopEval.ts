// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import { constrainNativeSettings, importNative } from "../server/runtimeLauncher.ts";
import { registerApprovalUI } from "../server/runtimePolicyHooks.ts";

// Agent-loop dispatch hands tools a ToolCallContext carrying an AbortSignal and a
// function; direct `tool.execute` proofs never pass it. A scripted stream drives the
// real loop so native eval sees exactly what a provider turn delivers.
export async function proveLoopEval(root: string, python: string) {
  const { Settings } = await importNative(root, "config/settings");
  const { SessionManager } = await importNative(root, "session/session-manager");
  const { createAgentSession } = await importNative(root, "sdk");
  const { initializeExtensions } = await importNative(root, "modes/runtime-init");
  const { disposeAllKernelSessions } = await importNative(root, "eval/py/executor");
  const { disposePyToolBridge } = await importNative(root, "eval/py/tool-bridge");
  const { AuthStorage, SqliteAuthCredentialStore } = await importNative(
    root,
    "session/auth-storage",
  );
  const { ModelRegistry } = await importNative(root, "config/model-registry");
  const bunModule = "bun:sqlite";
  const { Database } = await import(bunModule);
  const { AssistantMessageEventStream } = await import(
    `${root}/../pi-ai/src/utils/event-stream.ts`
  );
  const results: Array<{
    mode: string;
    approvals: number;
    call: string;
    isError: boolean;
    text: string;
  }> = [];
  let streamed = 0;
  for (const mode of ["approval-required", "full-access"]) {
    const manager = SessionManager.inMemory(process.cwd());
    const authority = Settings.isolated({ "python.interpreter": python });
    const boundary = await constrainNativeSettings(root, authority, mode, {
      providerSession: "loop-eval",
      environment: "e",
      project: "p",
      session: manager.getSessionId(),
      cwd: process.cwd(),
      agentDir: authority.getAgentDir(),
      generation: 1,
    });
    const db = new Database(":memory:");
    const authStorage = new AuthStorage(new SqliteAuthCredentialStore(db));
    const modelRegistry = new ModelRegistry(authStorage, `${process.cwd()}/missing-models.json`, {
      settings: boundary.settings,
    });
    const model = modelRegistry.getAll()[0];
    NodeAssert.ok(model, "bundled catalog model missing");
    authStorage.keys.setRuntime(model.provider, "scripted-no-network");
    const result = await createAgentSession({
      cwd: process.cwd(),
      agentDir: authority.getAgentDir(),
      settings: boundary.settings,
      sessionManager: manager,
      model,
      authStorage,
      modelRegistry,
      disableExtensionDiscovery: true,
      extensions: [],
      skills: [],
      rules: [],
      contextFiles: [],
      promptTemplates: [],
      preloadedCustomToolPaths: [],
      slashCommands: [],
      toolNames: ["eval"],
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      skipPythonPreflight: true,
      autoApprove: false,
      deferRetryFallbackValidation: true,
      getApiKey: async () => "scripted-no-network",
    });
    const calls = [
      {
        id: "loop-eval-1",
        arguments: { language: "py", code: "x = 21\nprint(sum([3, 5, 8, 13]))" },
      },
      { id: "loop-eval-2", arguments: { language: "py", code: "print(x * 2)" } },
      {
        id: "loop-eval-reset",
        arguments: { language: "py", code: "print('reset-ok')", reset: true },
      },
    ];
    let turn = 0;
    result.session.agent.streamFn = () => {
      streamed++;
      const stream = new AssistantMessageEventStream();
      const call = calls[turn++];
      const message = {
        role: "assistant",
        content: call
          ? [{ type: "toolCall", id: call.id, name: "eval", arguments: call.arguments }]
          : [{ type: "text", text: "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: call ? "toolUse" : "stop",
        timestamp: turn,
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    };
    let approvals = 0;
    const approve = async () => {
      approvals++;
      return "once";
    };
    const ui = new Proxy({ approve } as { approve?: typeof approve }, {
      get: (target, key) =>
        key in target ? target[key as "approve"] : typeof key === "string" ? () => {} : undefined,
    });
    registerApprovalUI(boundary.epoch, ui);
    result.setToolUIContext(ui, true);
    boundary.epoch.open();
    try {
      await initializeExtensions(result.session, {
        mode: "rpc",
        uiContext: ui,
        reportRuntimeError: (error: unknown) => {
          throw error;
        },
      });
      await result.session.prompt("run the scripted eval calls");
      for (const message of result.session.messages as Array<{
        role: string;
        toolCallId?: string;
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      }>)
        if (message.role === "toolResult")
          results.push({
            mode,
            approvals,
            call: message.toolCallId!,
            isError: message.isError === true,
            text: (message.content ?? []).map((part) => part.text ?? "").join(""),
          });
    } finally {
      await result.session.dispose();
      await disposeAllKernelSessions();
      await disposePyToolBridge();
      boundary.dispose();
      authority.cancelPendingSaves();
      db.close();
    }
  }
  const failures = results.filter((entry) => entry.isError);
  NodeAssert.deepEqual(failures, [], `agent-loop native eval failed: ${JSON.stringify(failures)}`);
  NodeAssert.deepEqual(
    results.map((entry) => entry.text.trim()),
    ["29", "42", "reset-ok", "29", "42", "reset-ok"],
  );
  NodeAssert.deepEqual(
    results.map((entry) => entry.approvals),
    [3, 3, 3, 0, 0, 0],
    "supervised eval must still prompt for each call; full access must not",
  );
  process.stdout.write(
    JSON.stringify({ nativeLoopEval: "PASS", calls: results.length, streamed, inference: 0 }) +
      "\n",
  );
}
