// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { importNative } from "../server/runtimeLauncher.ts";
const { SessionManager } = await importNative(process.argv[2]!, "session/session-manager");
const mode = process.argv[3]!;
const root = process.argv[4]!;
if (mode === "prepare") {
  const manager = SessionManager.create(
    NodePath.join(root, "cwd"),
    NodePath.join(root, "sessions"),
  );
  await manager.ensureOnDisk();
  manager.appendMessage({ role: "user", content: "Fixture partial tool batch", timestamp: 1 });
  manager.appendCustomEntry("user_todo_edit", {
    phases: [
      { name: "Persisted", tasks: [{ content: "Retained native todo", status: "in_progress" }] },
    ],
  });
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
    ],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  });
  const entry = manager.appendMessage({
    role: "toolResult",
    toolCallId: "a",
    toolName: "read",
    content: [
      { type: "text", text: "artifact://plot.txt" },
      { type: "image", mimeType: "image/png", data: "YQ==" },
    ],
    isError: false,
    timestamp: 3,
  });
  manager.appendCustomEntry("future-native-entry", { opaque: true });
  await manager.flush();
  const artifacts = manager.getArtifactsDir();
  await NodeFSP.mkdir(artifacts, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(artifacts, "plot.txt"), "retained artifact");
  const result = { file: manager.getSessionFile(), sessionId: manager.getSessionId(), entry };
  await manager.close();
  process.stdout.write(JSON.stringify(result) + "\n");
} else {
  const manager = await SessionManager.open(process.argv[5]!, undefined, undefined, {
    throwIfMissing: true,
    suppressBreadcrumb: true,
  });
  const artifacts = manager.getArtifactsDir();
  const result = {
    cwd: manager.getCwd(),
    artifact: await NodeFSP.readFile(NodePath.join(artifacts, "plot.txt"), "utf8"),
    entries: manager.getBranch(),
  };
  await manager.close();
  process.stdout.write(JSON.stringify(result) + "\n");
}
