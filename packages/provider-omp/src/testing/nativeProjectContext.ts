// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { createControlServer } from "../server/controlChannel.ts";
import { startNativeRuntime } from "../server/runtimeMain.ts";
import { importNative } from "../server/runtimeLauncher.ts";

export async function proveProjectContext(root: string) {
  const cwd = await NodeFSP.mkdtemp(NodePath.join(process.cwd(), "project-context-"));
  try {
    await NodeFSP.mkdir(NodePath.join(cwd, ".cursor", "rules"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(cwd, "AGENTS.md"), "T3_PROJECT_AGENTS_SENTINEL");
    await NodeFSP.writeFile(
      NodePath.join(cwd, ".cursor", "rules", "project.mdc"),
      "---\nalwaysApply: true\n---\nT3_PROJECT_RULE_SENTINEL\n",
    );
    for (const { helper, lspEnabled } of [
      { helper: false, lspEnabled: true },
      { helper: true, lspEnabled: true },
      { helper: false, lspEnabled: false },
    ]) {
      const configFile = NodePath.join(cwd, `settings-${helper}-${lspEnabled}.yml`);
      await NodeFSP.writeFile(
        configFile,
        `lsp:\n  enabled: ${lspEnabled}\n  shared: false\nasync:\n  enabled: true\ntask:\n  maxRecursionDepth: 3\n`,
      );
      const control = await createControlServer(
        () => {},
        () => {},
      );
      let runtime: Awaited<ReturnType<typeof startNativeRuntime>> | undefined;
      try {
        runtime = await startNativeRuntime(root, {
          cwd,
          mode: "approval-required",
          environment: "project-context-proof",
          project: cwd,
          providerSession: `project-context-${helper}`,
          credentialPath: control.credentialPath,
          instructions: "T3_ROLE_INSTRUCTION_SENTINEL",
          configFiles: [configFile],
          helper,
        });
        const prompt = runtime.result.session.systemPrompt.join("\n");
        NodeAssert.ok(prompt.includes("T3_ROLE_INSTRUCTION_SENTINEL"));
        NodeAssert.equal(
          prompt.includes("T3_PROJECT_AGENTS_SENTINEL"),
          !helper,
          `helper=${helper} must ${helper ? "exclude" : "include"} project AGENTS.md`,
        );
        NodeAssert.equal(
          prompt.includes("T3_PROJECT_RULE_SENTINEL"),
          !helper,
          `helper=${helper} must ${helper ? "exclude" : "include"} project rules`,
        );
        NodeAssert.equal(
          Boolean(runtime.result.session.getToolByName("lsp")),
          !helper && lspEnabled,
          `helper=${helper}, lsp.enabled=${lspEnabled} must respect native LSP availability`,
        );
        const { lookup } = await importNative(root, "config/registry");
        NodeAssert.equal(lookup("async.enabled").get(runtime.boundary.settings), false);
        NodeAssert.equal(lookup("task.maxRecursionDepth").get(runtime.boundary.settings), 0);
      } finally {
        await runtime?.close();
        await control.close();
      }
    }
  } finally {
    await NodeFSP.rm(cwd, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify({ nativeProjectContext: "PASS", inference: 0 }) + "\n");
}
