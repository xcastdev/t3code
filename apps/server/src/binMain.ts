import { enableCliCompileCache } from "./cliCompileCache.ts";

// Recognize the CLI's built-in globals without loading the command graph.
function relayCommandIndex(args: ReadonlyArray<string>): number {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "relay") return index;
    const [flag] = arg.split("=", 1);
    if (flag === "--log-level" || flag === "--completions") {
      if (arg === flag) {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("-")) break;
        index++;
      }
    } else if (/^(?:--(?:no-)?(?:help|version|wizard)|-[hv]+)$/.test(flag ?? "")) {
      if (arg === flag && /^(?:true|false|yes|no|on|off|[01yn])$/.test(args[index + 1] ?? "")) {
        index++;
      }
    } else {
      break;
    }
  }
  return -1;
}

// Packaged builds load this graph with require(esm): top-level await anywhere in it breaks them.
// ACP agents spawn `acp-mcp-bridge` per session and `acp-mcp-call` per tool call, so those fast
// paths dispatch before the full CLI module graph (seconds of evaluation) loads.
export async function runCliCommand() {
  const args = process.argv.slice(2);
  const command = args[0];
  const relayIndex = relayCommandIndex(args);
  // Install the socket guard before importing code that can open outbound connections.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  if (command === "__document-text") {
    const { extractDocumentText } = await import("./provider/documentTextWorker.ts");
    try {
      process.stdout.write(await extractDocumentText(process.argv[3]!, process.argv[4]!));
    } catch (error) {
      if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
        throw error;
      }
      // Exit 2 identifies document rejections; OS and process failures remain retryable.
      process.exitCode = 2;
    }
  } else if (command === "__managed-chatgpt-token") {
    const { runManagedChatGptTokenCli } = await import("./cli/managedChatGptToken.ts");
    await runManagedChatGptTokenCli(process.argv.slice(3));
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else if (command === "plugin-worker") {
    (await import("./plugins/pluginWorkerEntry.ts")).run(process.argv.slice(3));
  } else if (command === "__speech-worker") {
    const mode = process.argv[3];
    if (mode !== "discover" && mode !== "model") throw new Error("Unknown speech worker mode.");
    const { runNativeSpeechWorker } = await import("./speech/native.ts");
    await runNativeSpeechWorker(mode, process.argv[4]);
  } else if (relayIndex !== -1) {
    enableCliCompileCache();
    const { runRelayCli } = await import("./cli/relay.ts");
    runRelayCli([...args.slice(0, relayIndex), ...args.slice(relayIndex + 1)]);
  } else {
    enableCliCompileCache();
    // Windows desktop launches without stdin; attach before reading, except on fast paths using pipes.
    const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
    attachConsoleStdin();
    const importStart = performance.now();
    const { runCli } = await import("./binCli.ts");
    if (process.env.T3CODE_STARTUP_PROFILE_DIR) {
      performance.measure("server.import.binCli", { start: importStart });
    }
    runCli();
  }
}
