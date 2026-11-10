// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { constrainNativeSettings, importNative } from "../server/runtimeLauncher.ts";
import { registerNativeSession, registerApprovalUI } from "../server/runtimePolicyHooks.ts";

export async function proveTransitions(root: string, python: string) {
  const { Settings } = await importNative(root, "config/settings");
  const { SessionManager } = await importNative(root, "session/session-manager");
  const { createAgentSession } = await importNative(root, "sdk");
  const { initializeExtensions } = await importNative(root, "modes/runtime-init");
  let inference = 0;
  let count = 0;
  for (const action of [
    "new",
    "fork",
    "switch",
    "move",
    "resume",
    "manager-cwd",
    "profile",
    "helper-generation",
  ]) {
    const authority = await Settings.loadReadOnly({
      cwd: process.cwd(),
      agentDir: NodePath.join(process.env.HOME!, `profile-${action}`),
      overrides: { "python.interpreter": python },
    });
    const manager = SessionManager.inMemory(process.cwd());
    const boundary = await constrainNativeSettings(root, authority, "approval-required", {
      providerSession: `transition-${action}`,
      environment: "e",
      project: "p",
      session: manager.getSessionId(),
      cwd: process.cwd(),
      agentDir: authority.getAgentDir(),
      generation: ++count,
    });
    const result = await createAgentSession({
      cwd: process.cwd(),
      agentDir: authority.getAgentDir(),
      settings: boundary.settings,
      sessionManager: manager,
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
    const opened = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<"once">();
    const ui = {
      approve: () => {
        opened.resolve();
        return answer.promise;
      },
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
    };
    registerApprovalUI(boundary.epoch, ui);
    registerNativeSession(boundary.epoch, result.session);
    boundary.epoch.open();
    result.setToolUIContext(ui, true);
    await initializeExtensions(result.session, { mode: "rpc", uiContext: ui });
    const path = NodePath.join(process.cwd(), `transition-${action}.txt`);
    const running = result.session
      .getToolByName("write")
      .execute(`pending-${action}`, { path: NodePath.basename(path), content: "MUST NOT EXECUTE" });
    const outcome = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    await Promise.race([
      opened.promise,
      outcome.then((error: unknown) => {
        throw error ?? new Error("tool completed before approval");
      }),
    ]);
    let transition: Promise<unknown>;
    switch (action) {
      case "new":
        transition = result.session.newSession();
        break;
      case "fork":
        transition = result.session.fork();
        break;
      case "switch":
        transition = result.session.switchSession(
          NodePath.join(process.cwd(), "missing-session.jsonl"),
        );
        break;
      case "move":
        transition = result.session.moveSession(NodePath.join(process.cwd(), "destination"));
        break;
      case "resume":
        transition = result.session.resume();
        break;
      case "manager-cwd":
        manager.setCwdWithoutRelocation(process.cwd());
        transition = Promise.resolve();
        break;
      case "profile":
        transition = boundary.settings.reloadForCwd(process.cwd());
        break;
      default:
        boundary.epoch.invalidate("helper-generation scope replaced");
        transition = Promise.resolve();
    }
    const transitioned = transition.then(
      () => undefined,
      (error: unknown) => error,
    );
    NodeAssert.equal(
      boundary.epoch.signal.aborted,
      true,
      `${action} invalidates before its first await`,
    );
    answer.resolve("once");
    NodeAssert.ok(await outcome, `${action} must reject stale native approval`);
    NodeAssert.equal(NodeFS.existsSync(path), false, `${action} wrote through old approval`);
    await transitioned;
    await result.session.dispose();
    boundary.dispose();
    authority.cancelPendingSaves();
  }
  NodeAssert.equal(inference, 0);
  process.stdout.write(
    JSON.stringify({ nativeSessionTransitions: "PASS", count, inference }) + "\n",
  );
}
