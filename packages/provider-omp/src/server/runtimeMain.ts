// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { connectControl, ApprovalBroker } from "./controlChannel.ts";
import { importNative, constrainNativeSettings, acknowledgeRuntime } from "./runtimeLauncher.ts";
import {
  applyRuntimeLaunchArgs,
  validateRuntimeConfig,
  type RuntimeConfig,
} from "./runtimeOptions.ts";
export { applyRuntimeLaunchArgs } from "./runtimeOptions.ts";
import { requiredGuards } from "./compatibility.ts";
import {
  currentAuthorization,
  registerNativeSession,
  registerApprovalUI,
} from "./runtimePolicyHooks.ts";

export async function startNativeRuntime(root: string, config: RuntimeConfig) {
  const credential = JSON.parse(await NodeFSP.readFile(config.credentialPath, "utf8")) as {
    path: string;
    secret: string;
  };
  await NodeFSP.unlink(config.credentialPath);
  if (config.profile !== undefined) process.env.OMP_PROFILE = config.profile;
  const { Settings } = await importNative(root, "config/settings");
  const { SessionManager } = await importNative(root, "session/session-manager");
  const { createAgentSession } = await importNative(root, "sdk");
  const { runRpcMode } = await importNative(root, "modes/rpc/rpc-mode");
  if (config.forkEntry !== undefined && config.forkEntry !== null) {
    const source = config.forkSource ?? config.sessionFile;
    if (!source) throw new Error("Native branch requires an owned source");
    const { loadEntriesFromFile } = await importNative(root, "session/session-loader");
    const entries = await loadEntriesFromFile(source, undefined, { throwIfMissing: true });
    if (!entries.some((entry: { id?: string }) => entry.id === config.forkEntry))
      throw new Error("Native branch entry is absent");
  }
  const manager = config.helper
    ? SessionManager.inMemory(config.cwd)
    : config.forkSource
      ? await SessionManager.forkFrom(config.forkSource, config.cwd, config.sessionDir, undefined, {
          copyArtifacts: true,
          suppressBreadcrumb: true,
          repairInterruptedTail: true,
        })
      : config.sessionFile
        ? await SessionManager.open(config.sessionFile, config.sessionDir, undefined, {
            initialCwd: config.cwd,
            suppressBreadcrumb: true,
            throwIfMissing: true,
          })
        : config.sessionDir
          ? SessionManager.create(config.cwd, config.sessionDir)
          : SessionManager.inMemory(config.cwd);
  if (NodePath.resolve(manager.getCwd()) !== NodePath.resolve(config.cwd)) {
    await manager.close();
    throw new Error("Owned native session workspace mismatch");
  }
  if (config.forkEntry !== undefined) {
    manager.branchWithSummary(config.forkEntry, "", { kind: "t3_owned_branch" });
    const { createInterruptedToolResults } = await importNative(root, "session/exit-diagnostics");
    for (const message of createInterruptedToolResults(manager.getBranch(), "fork"))
      manager.appendMessage(message);
    await manager.flush();
  }
  if (config.sessionDir && !config.helper) await manager.ensureOnDisk();
  const authority = await Settings.loadReadOnly({
    cwd: config.cwd,
    ...(config.agentDir ? { agentDir: config.agentDir } : {}),
    ...(config.configFiles ? { configFiles: config.configFiles } : {}),
  });
  const boundary = await constrainNativeSettings(root, authority, config.mode, {
    providerSession: config.providerSession,
    environment: config.environment,
    project: config.project,
    session: manager.getSessionId(),
    cwd: config.cwd,
    agentDir: authority.getAgentDir(),
    generation: 1,
  });
  const invalidated = Promise.withResolvers<void>();
  let disposeSession = async () => {};
  let broker: ApprovalBroker | undefined;
  const channel = await connectControl(
    credential,
    (frame) => {
      if (frame.providerSession !== config.providerSession || frame.epoch !== boundary.epoch.id)
        return;
      if (frame.type === "approval_answer") broker?.answer(frame);
      if (frame.type === "invalidate" || frame.type === "cancel") {
        boundary.epoch.invalidate("host revoked runtime");
        broker?.close();
        void disposeSession();
      }
    },
    () => {
      boundary.epoch.invalidate("control disconnected");
      broker?.close();
      invalidated.resolve();
      void disposeSession();
    },
  );
  broker = new ApprovalBroker(config.providerSession, boundary.epoch.id, (frame) =>
    channel.send(frame),
  );
  boundary.epoch.signal.addEventListener(
    "abort",
    () => {
      broker?.close();
      channel.send({
        v: 1,
        type: "invalidate",
        providerSession: config.providerSession,
        epoch: boundary.epoch.id,
        id: NodeCrypto.randomUUID(),
        payload: { reason: String(boundary.epoch.signal.reason) },
      });
      invalidated.resolve();
      void disposeSession();
    },
    { once: true },
  );
  registerNativeSession(boundary.epoch, {
    settings: boundary.settings,
    cwd: config.cwd,
    sessionManager: manager,
  });
  const instructions = config.instructions;
  const result = await createAgentSession({
    cwd: config.cwd,
    agentDir: authority.getAgentDir(),
    settings: boundary.settings,
    sessionManager: manager,
    autoApprove: false,
    ...(config.model || config.provider
      ? {
          modelPattern: config.provider
            ? `${config.provider}/${config.model ?? "*"}`
            : config.model,
        }
      : {}),
    ...(instructions ? { systemPrompt: (blocks: string[]) => [...blocks, instructions] } : {}),
    disableExtensionDiscovery: true,
    extensions: [],
    enableMCP: !config.helper,
    ...(config.helper ? { tools: [], restrictToolNames: true } : {}),
    enableLsp: !config.helper,
    enableIrc: false,
    ...(config.helper ? { skills: [] } : {}),
    ...(config.helper ? { rules: [], contextFiles: [] } : {}),
    ...(config.helper ? { promptTemplates: [] } : {}),
    preloadedCustomToolPaths: [],
    ...(config.helper ? { slashCommands: [] } : {}),
    skipPythonPreflight: true,
    deferRetryFallbackValidation: true,
  });
  let disposal: Promise<void> | undefined;
  disposeSession = () => (disposal ??= result.session.dispose());
  registerNativeSession(boundary.epoch, result.session);
  if (boundary.epoch.signal.aborted) {
    await disposeSession();
    throw new Error("OMP startup policy invalidated");
  }
  acknowledgeRuntime();
  const approve = async (prompt: { full: string; compact: string }) => {
    const auth = currentAuthorization();
    if (auth.providerSession !== config.providerSession)
      throw new Error("OMP approval provider session mismatch");
    const answer = await broker!.request(prompt, {
      nativeCallId: auth.nativeCallId,
      ...(auth.tool ? { tool: auth.tool } : {}),
    });
    boundary.epoch.assert();
    return answer;
  };
  const run = () =>
    runRpcMode(result.session, {
      setToolUIContext: (ui: { approve?: typeof approve }, hasUI: boolean) => {
        ui.approve = approve;
        registerApprovalUI(boundary.epoch, ui);
        result.setToolUIContext(ui, hasUI);
        boundary.epoch.open();
        channel.send({
          v: 1,
          type: "ready",
          providerSession: config.providerSession,
          epoch: boundary.epoch.id,
          id: NodeCrypto.randomUUID(),
          payload: {
            recipe: "omp-18.16.0-bun-1.4.4",
            guards: requiredGuards,
            mode: boundary.mode.mode,
          },
        });
      },
    });
  return {
    invalidated: invalidated.promise,
    result,
    boundary,
    run,
    async close() {
      broker?.close();
      boundary.dispose();
      await disposeSession();
      channel.close();
      authority.cancelPendingSaves();
    },
  };
}

if (import.meta.main) {
  const configPath = process.env.T3_OMP_RUNTIME_CONFIG;
  if (!configPath) throw new Error("Missing session-scoped OMP launch configuration");
  const config = JSON.parse(await NodeFSP.readFile(configPath, "utf8"));
  const runtime = await startNativeRuntime(
    process.argv[2]!,
    validateRuntimeConfig(applyRuntimeLaunchArgs(config, process.argv.slice(3))),
  );
  try {
    await Promise.race([runtime.run(), runtime.invalidated]);
  } finally {
    await runtime.close();
    process.exit(0);
  }
}
