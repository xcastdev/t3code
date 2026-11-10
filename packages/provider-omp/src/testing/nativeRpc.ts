// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import {
  importNative,
  constrainNativeSettings,
  acknowledgeRuntime,
} from "../server/runtimeLauncher.ts";
import { ApprovalBroker, connectControl } from "../server/controlChannel.ts";
import { requiredGuards } from "../server/compatibility.ts";
import { currentAuthorization, registerApprovalUI } from "../server/runtimePolicyHooks.ts";

export async function proveRpc(
  root: string,
  credentialPath: string,
  python: string,
  missingHooks = false,
  networkCount = () => 0,
): Promise<void> {
  const bunModule = "bun:sqlite";
  const { Database } = await import(bunModule);
  const { Settings } = await importNative(root, "config/settings");
  const { SessionManager } = await importNative(root, "session/session-manager");
  const { AuthStorage, SqliteAuthCredentialStore } = await importNative(
    root,
    "session/auth-storage",
  );
  const { ModelRegistry } = await importNative(root, "config/model-registry");
  const { createAgentSession } = await importNative(root, "sdk");
  const { runRpcMode } = await importNative(root, "modes/rpc/rpc-mode");
  const { initializeExtensions } = await importNative(root, "modes/runtime-init");
  const manager = SessionManager.inMemory(process.cwd());
  const authority = Settings.isolated({ "python.interpreter": python });
  const boundary = await constrainNativeSettings(root, authority, "approval-required", {
    providerSession: "rpc-proof",
    environment: "e",
    project: "p",
    session: manager.getSessionId(),
    cwd: process.cwd(),
    agentDir: authority.getAgentDir(),
    generation: 1,
  });
  let inference = 0;
  const db = new Database(":memory:");
  const authStorage = new AuthStorage(new SqliteAuthCredentialStore(db));
  const registry = new ModelRegistry(authStorage, `${process.cwd()}/missing-models.json`, {
    settings: boundary.settings,
  });
  const result = await createAgentSession({
    cwd: process.cwd(),
    agentDir: authority.getAgentDir(),
    settings: boundary.settings,
    sessionManager: manager,
    authStorage,
    modelRegistry: registry,
    disableExtensionDiscovery: true,
    extensions: [],
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    preloadedCustomToolPaths: [],
    slashCommands: [],
    toolNames: ["read", "write", "eval"],
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    autoApprove: false,
    deferRetryFallbackValidation: true,
    getApiKey: async () => {
      inference++;
      throw new Error("Inference forbidden");
    },
  });
  NodeAssert.equal(result.session.settings, boundary.settings);
  if (missingHooks) {
    try {
      NodeAssert.throws(() => acknowledgeRuntime(), /Missing OMP guard acknowledgement/);
    } finally {
      await result.session.dispose();
      boundary.dispose();
      db.close();
      authority.cancelPendingSaves();
    }
    process.stdout.write(
      JSON.stringify({ missingHooks: "PASS", inference, blockedCatalogFetches: networkCount() }) +
        "\n",
    );
    return;
  }
  acknowledgeRuntime();
  let broker: ApprovalBroker;
  const credential = JSON.parse(await NodeFSP.readFile(credentialPath, "utf8"));
  const channel = await connectControl(
    credential,
    (frame) => broker.answer(frame),
    () => {
      boundary.epoch.invalidate("disconnected");
      broker.close();
    },
  );
  broker = new ApprovalBroker("rpc-proof", boundary.epoch.id, (frame) => channel.send(frame));
  const approve = (prompt: { full: string; compact: string }) => {
    const authorization = currentAuthorization();
    return broker.request(prompt, { nativeCallId: authorization.nativeCallId });
  };
  async function exercise(ui: { select: (title: string, choices: string[]) => Promise<string> }) {
    try {
      await initializeExtensions(result.session, { mode: "rpc", uiContext: ui });
      const question = ui.select("Allow tool: write", ["Approve", "Deny"]);
      const a = result.session
        .getToolByName("write")
        .execute("first", { path: "rpc-a.txt", content: "first" });
      const b = result.session
        .getToolByName("write")
        .execute("second", { path: "rpc-b.txt", content: "second" });
      await Promise.all([a, b]);
      await question;
      NodeAssert.equal(await NodeFSP.readFile("rpc-a.txt", "utf8"), "first");
      NodeAssert.equal(await NodeFSP.readFile("rpc-b.txt", "utf8"), "second");
      const nested = await result.session.getToolByName("eval").execute("native-eval", {
        language: "js",
        code: "await tool.write({path:'rpc-nested.txt',content:'nested'}); print('sdk-native-eval');",
        timeout: 10,
      });
      NodeAssert.match(JSON.stringify(nested), /sdk-native-eval/);
      NodeAssert.equal(await NodeFSP.readFile("rpc-nested.txt", "utf8"), "nested");
      NodeAssert.equal(inference, 0);
      process.stderr.write(
        JSON.stringify({
          nativeRpcCounters: { inference, blockedCatalogFetches: networkCount() },
        }) + "\n",
      );
      channel.send({
        v: 1,
        type: "ready",
        providerSession: "rpc-proof",
        epoch: boundary.epoch.id,
        id: "proof-complete",
        payload: {
          recipe: "omp-18.16.0-bun-1.4.4",
          guards: requiredGuards,
          mode: "approval-required",
        },
      });
    } catch (error) {
      process.stderr.write(String(error) + "\n");
      process.exitCode = 1;
      channel.send({
        v: 1,
        type: "cancel",
        providerSession: "rpc-proof",
        epoch: boundary.epoch.id,
        id: "proof-failed",
        payload: { reason: String(error) },
      });
    }
  }
  return runRpcMode(result.session, {
    setToolUIContext: (
      ui: {
        approve?: typeof approve;
        select: (title: string, choices: string[]) => Promise<string>;
      },
      hasUI: boolean,
    ) => {
      ui.approve = approve;
      registerApprovalUI(boundary.epoch, ui);
      result.setToolUIContext(ui, hasUI);
      boundary.epoch.open();
      void exercise(ui);
    },
  });
}
