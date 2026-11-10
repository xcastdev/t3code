// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import { importNative } from "../server/runtimeLauncher.ts";
import { fixedOmpPolicy } from "../server/policy.ts";

export async function proveHelpers(root: string, python: string) {
  const { Settings } = await importNative(root, "config/settings");
  const { EvalTool } = await importNative(root, "tools/eval");
  const { callSessionTool } = await importNative(root, "eval/js/tool-bridge");
  const { disposeAllVmContexts } = await importNative(root, "eval/js/context-manager");
  const { disposeAllKernelSessions } = await importNative(root, "eval/py/executor");
  const { disposePyToolBridge } = await importNative(root, "eval/py/tool-bridge");
  const { releaseCompletionHandles, getCompletionHandle } = await importNative(
    root,
    "eval/completion-bridge",
  );
  const { releaseJudgmentBatches, getJudgmentBatch } = await importNative(
    root,
    "eval/judgment-batch-bridge",
  );
  const bunTestModule = "bun:test";
  const { spyOn } = await import(bunTestModule);
  const completionModule = await importNative(root, "eval/completion-bridge");
  const batchModule = await importNative(root, "eval/judgment-batch-bridge");
  const retainedHandles = spyOn(completionModule, "retainCompletionHandle");
  const batchAllocations = spyOn(batchModule, "JudgmentBatch");
  const batchDispatch = spyOn(batchModule, "runEvalJudgmentBatch");
  let inference = 0;
  let ordinary = 0;
  let backgroundAllocations = 0;
  const owner = "native-helper-proof";
  const settings = Settings.isolated({
    ...fixedOmpPolicy,
    "python.interpreter": python,
    "tools.approvalMode": "always-ask",
    "retry.enabled": false,
  });
  const model = {
    id: "proof",
    name: "proof",
    provider: "t3proof",
    api: "openai-responses",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 1024,
  };
  for (const role of ["default", "smol", "judge"]) settings.setModelRole(role, "t3proof/proof");
  const session = {
    cwd: process.cwd(),
    settings,
    hasUI: false,
    enableLsp: false,
    enableIrc: false,
    asyncJobManager: {
      atCapacity: false,
      register: () => {
        backgroundAllocations++;
        throw new Error("Native background allocation forbidden");
      },
    },
    getSessionFile: () => null,
    getSessionSpawns: () => null,
    getEvalSessionId: () => owner,
    getEvalKernelOwnerId: () => owner,
    getAgentId: () => owner,
    getActiveModelString: () => "t3proof/proof",
    getToolForEvalBridge: (name: string) =>
      name === "read"
        ? {
            name: "read",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
            execute: async () => {
              ordinary++;
              return {
                content: [
                  { type: "text", text: "ordinary-tool-ok" },
                  {
                    type: "image",
                    mimeType: "image/png",
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=",
                  },
                ],
                details: { proof: "structured-native" },
              };
            },
          }
        : undefined,
    modelRegistry: {
      getAvailable: () => [model],
      getAll: () => [model],
      find: () => model,
      getApiKey: async () => {
        inference++;
        throw new Error("Inference forbidden");
      },
      resolver: () => async () => {
        inference++;
        throw new Error("Inference forbidden");
      },
    },
  };
  const { smokeTestJsEvalWorker } = await importNative(root, "eval/js/context-manager");
  await smokeTestJsEvalWorker();
  const { resolveBuiltinToolPlan } = await importNative(root, "tools/index");
  const inventory = await resolveBuiltinToolPlan(session);
  NodeAssert.equal(inventory.isAllowed("task"), false);
  NodeAssert.equal(inventory.names.includes("task"), false);
  const tool = new EvalTool(session);
  const rows: string[] = [];
  try {
    for (const language of ["js", "py"]) {
      const updates: unknown[] = [];
      const control = await tool.execute(
        `control-${language}`,
        {
          language,
          code:
            language === "js"
              ? "globalThis.kept=41; globalThis.savedCompletion=completion; print(kept+1); log('native log'); phase('Native phase');"
              : "kept=41\nsaved_completion=completion\nprint(kept+1)\nlog('native log')\nphase('Native phase')",
          timeout: 10,
        },
        undefined,
        (update: unknown) => updates.push(update),
      );
      NodeAssert.match(JSON.stringify(control), /42/);
      NodeAssert.match(JSON.stringify(control), /Native phase/);
      NodeAssert.match(JSON.stringify(control), /native log/);
      NodeAssert.equal(
        control.details.statusEvents.find((event: { op: string }) => event.op === "phase")?.title,
        "Native phase",
      );
      NodeAssert.equal(
        control.details.statusEvents.find((event: { op: string }) => event.op === "log")?.message,
        "native log",
      );
      NodeAssert.ok(
        updates.some((update) => JSON.stringify(update).includes("42")),
        "native partial output update",
      );
      NodeAssert.ok(updates.length > 0, "native output must stream");
      const programs =
        language === "js"
          ? [
              "await completion('proof')",
              "await savedCompletion('proof')",
              "await judge('proof',{q:{type:'bool',instructions:'proof'}})",
              "await judgeBatch(['proof'],{q:{type:'bool',instructions:'proof'}})",
              "await judgeBatch.attach('old-batch')",
              "await agent('proof')",
              "await workpool()",
              "await tool.__completion__({prompt:'raw'})",
            ]
          : [
              "completion('proof')",
              "saved_completion('proof')",
              "await judge('proof',{'q':{'type':'bool','instructions':'proof'}})",
              "judge_batch(['proof'],{'q':{'type':'bool','instructions':'proof'}})",
              "judge_batch.attach('old-batch')",
              "agent('proof')",
              "workpool()",
              "await tool.__completion__({'prompt':'raw'})",
            ];
      for (const [i, code] of programs.entries()) {
        const result = JSON.stringify(
          await tool.execute(`blocked-${language}-${i}`, { language, code, timeout: 10 }),
        );
        NodeAssert.match(
          result,
          /T3_NATIVE_HELPER_DISABLED|maximum|not allowed|AttributeError: __completion__/,
          `${language}: ${code}: ${result}`,
        );
        rows.push(`${language}:${i}`);
      }
      const retained = await tool.execute(`retained-${language}`, {
        language,
        code:
          language === "js"
            ? "print(kept+1); print(await tool.read({path:'proof'})); print([{answer:42}]);"
            : "print(kept+1)\nprint(await tool.read({'path':'proof'}))\nprint([{'answer':42}])",
        timeout: 10,
      });
      NodeAssert.match(JSON.stringify(retained), /42/);
      NodeAssert.match(JSON.stringify(retained), /ordinary-tool-ok/);
      NodeAssert.ok(retained.content.some((block: { type: string }) => block.type === "image"));
      NodeAssert.match(JSON.stringify(retained), /structured-native/);
      NodeAssert.ok(
        retained.details.cells.some((cell: { views?: unknown[] }) => (cell.views?.length ?? 0) > 0),
        `${language} native structured views`,
      );
      const reset = await tool.execute(`reset-${language}`, {
        language,
        code: language === "js" ? "await completion('proof')" : "completion('proof')",
        reset: true,
        timeout: 10,
      });
      NodeAssert.match(JSON.stringify(reset), /T3_NATIVE_HELPER_DISABLED/);
    }
    for (const name of [
      "__completion__",
      "__judge__",
      "__judge_batch__",
      "__agent__",
      "__workpool__",
    ]) {
      for (const op of ["create", "attach", "status", "close"])
        await NodeAssert.rejects(
          callSessionTool(name, { op, id: "old-batch" }, { session }),
          /T3_NATIVE_HELPER_DISABLED/,
        );
    }
    NodeAssert.equal(getCompletionHandle("old-batch"), undefined);
    NodeAssert.equal(getJudgmentBatch("old-batch", session), undefined);
    const { BashTool } = await importNative(root, "tools/bash");
    const bash = new BashTool(session);
    await NodeAssert.rejects(
      bash.execute("no-async", { command: "printf forbidden", async: true }),
      /Async bash execution is disabled/,
    );
    await NodeAssert.rejects(
      bash.execute("no-services", { command: "printf forbidden", name: "managed" }),
      /Service launch is disabled/,
    );
    const foreground = await bash.execute("foreground", { command: "printf native-foreground" });
    NodeAssert.match(JSON.stringify(foreground), /native-foreground/);
    NodeAssert.equal(backgroundAllocations, 0);
    NodeAssert.equal(retainedHandles.mock.calls.length, 0, "no host completion handle allocation");
    NodeAssert.equal(batchAllocations.mock.calls.length, 0, "no host judgment batch allocation");
    NodeAssert.equal(batchDispatch.mock.calls.length, 0, "no batch attachment or control dispatch");
    NodeAssert.equal(inference, 0);
    NodeAssert.equal(ordinary, 2);
    process.stdout.write(
      JSON.stringify({
        helpers: "PASS",
        nativeRuntimes: ["js", "py"],
        retained: true,
        reset: true,
        streaming: true,
        images: true,
        structuredViews: true,
        hostHandleAllocations: retainedHandles.mock.calls.length,
        hostBatchAllocations: batchAllocations.mock.calls.length,
        blocked: rows.length + 20,
        inference,
      }) + "\n",
    );
  } finally {
    retainedHandles.mockRestore();
    batchAllocations.mockRestore();
    batchDispatch.mockRestore();
    releaseCompletionHandles(owner);
    releaseJudgmentBatches(owner);
    await disposeAllVmContexts();
    await disposeAllKernelSessions();
    await disposePyToolBridge();
    settings.cancelPendingSaves();
  }
}
