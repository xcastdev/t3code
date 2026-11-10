// @effect-diagnostics nodeBuiltinImport:off
import { registerApprovalUI } from "../server/runtimePolicyHooks.ts";
import { createPolicyEpoch } from "../server/policy.ts";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const root = process.argv[2]!;
let blockedFetches = 0;
globalThis.fetch = async () => {
  blockedFetches++;
  throw new Error("External network forbidden");
};
const native = (path: string) => import(NodeURL.pathToFileURL(`${root}/src/${path}.ts`).href);
if (process.argv.includes("--rpc-proof") || process.argv.includes("--missing-hooks")) {
  const { proveRpc } = await import("./nativeRpc.ts");
  await proveRpc(
    root,
    process.argv[process.argv.indexOf("--rpc-proof") + 1]!,
    process.argv[3]!,
    process.argv.includes("--missing-hooks"),
    () => blockedFetches,
  );
  process.exit(0);
}
if (process.argv.includes("--review-case")) {
  const selection = process.argv[process.argv.indexOf("--review-case") + 1];
  if (selection === "adapter") {
    const { proveAdapterRegressions } = await import("./nativeAdapterRegressions.ts");
    await proveAdapterRegressions(root);
  } else if (selection === "project-context") {
    const { proveProjectContext } = await import("./nativeProjectContext.ts");
    await proveProjectContext(root);
  } else {
    const { proveReviewRegressions } = await import("./nativeReviewRegressions.ts");
    await proveReviewRegressions(root, selection);
  }
  process.exit(0);
}
const { Settings } = await native("config/settings");
const { cfgToolsApproval } = await native("tools/settings");
const { WriteTool } = await native("tools/write");
const { ExtensionToolWrapper } = await native("extensibility/extensions/wrapper");
const settings = Settings.isolated({ "tools.approvalMode": "always-ask" });
const pending = Promise.withResolvers<void>();
const answer = Promise.withResolvers<"once" | "deny">();
const regressionUI = {
  approve: () => {
    pending.resolve();
    return answer.promise;
  },
};
const runner = {
  sessionSettings: settings,
  cwd: process.cwd(),
  sessionId: "native-regression",
  consumeLoopToolCall: () => false,
  consumeToolCallEmitted: () => false,
  hasHandlers: () => false,
  hasUI: () => true,
  hasSessionApproval: () => false,
  getUIContext: () => regressionUI,
  runScoped: (f: () => unknown) => f(),
};
const session = { settings, cwd: process.cwd(), getSessionFile: () => null };
const tool = new ExtensionToolWrapper(new WriteTool(session), runner);
if (!process.argv.includes("--unguarded")) {
  const epoch = createPolicyEpoch({
    settings,
    authority: settings,
    scope: {
      providerSession: "proof",
      environment: "proof",
      project: "proof",
      session: runner.sessionId,
      cwd: process.cwd(),
      agentDir: settings.getAgentDir(),
      generation: 1,
    },
    readPolicy: () => cfgToolsApproval.get(settings),
  });
  registerApprovalUI(epoch, regressionUI);
  epoch.open();
}
const path = `${process.cwd()}/stale-approval.txt`;
try {
  const execution = tool.execute("stale-native-write", { path, content: "MUST NOT BE WRITTEN" });
  const settled = execution.then(
    () => null,
    (error: unknown) => error,
  );
  await pending.promise;
  cfgToolsApproval.override(settings, { write: "deny" });
  answer.resolve("once");
  await settled;
  NodeAssert.equal(
    NodeFS.existsSync(path),
    false,
    "stale native approval executed underlying WriteTool after deny",
  );
  process.stdout.write(
    JSON.stringify({ nativePermissionRegression: "PASS", blockedFetches, inference: 0 }) + "\n",
  );
} finally {
  settings.cancelPendingSaves();
}

if (!process.argv.includes("--unguarded")) {
  const { proveReviewRegressions } = await import("./nativeReviewRegressions.ts");
  await proveReviewRegressions(root);
  const { proveAdapterRegressions } = await import("./nativeAdapterRegressions.ts");
  await proveAdapterRegressions(root);
  const { proveHelpers } = await import("./nativeHelpers.ts");
  await proveHelpers(root, process.argv[3]!);
  const { provePermissions } = await import("./nativePermissions.ts");
  await provePermissions(root);
  const { proveTransitions } = await import("./nativeTransitions.ts");
  await proveTransitions(root, process.argv[3]!);
  const { proveProjectContext } = await import("./nativeProjectContext.ts");
  await proveProjectContext(root);
}
