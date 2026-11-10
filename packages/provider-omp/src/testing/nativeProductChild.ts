// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeAssert from "node:assert/strict";
import { startNativeRuntime } from "../server/runtimeMain.ts";
import { validateRuntimeConfig } from "../server/runtimeOptions.ts";
const config = validateRuntimeConfig(JSON.parse(await NodeFSP.readFile(process.argv[3]!, "utf8")));
let blockedNetwork = 0;
globalThis.fetch = async () => {
  blockedNetwork++;
  throw new Error("Native proof forbids external network");
};
const runtime = await startNativeRuntime(process.argv[2]!, config);
const installed = Promise.withResolvers<void>();
const session = runtime.result.session;
const refresh = session.refreshRpcHostTools.bind(session);
session.refreshRpcHostTools = async (tools: unknown[]) => {
  await refresh(tools);
  installed.resolve();
};
const loop = runtime.run();
try {
  await installed.promise;
  const tool = session.getToolByName("t3_scoped");
  NodeAssert.ok(tool);
  const first = await tool.execute("native-direct", { value: "allowed" });
  NodeAssert.match(JSON.stringify(first), /image\/png/);
  const listing = await session
    .getToolByName("read")
    .execute("mounted-inventory", { path: "xd://" });
  NodeAssert.match(JSON.stringify(listing), /t3_scoped/);
  const mounted = await session.getToolByName("write").execute("native-mounted", {
    path: "xd://t3_scoped",
    content: JSON.stringify({ value: "mounted" }),
  });
  NodeAssert.match(JSON.stringify(mounted), /mounted/);
  const evaluated = await session.getToolByName("eval").execute("native-eval-host", {
    language: "js",
    code: "const answer=await tool.t3_scoped({value:'eval'}); print(JSON.stringify(answer));",
    timeout: 10,
  });
  NodeAssert.match(JSON.stringify(evaluated), /eval/);
  const pending = await tool.execute("native-revoked", { value: "pending" }).then(
    (value: unknown) => value,
    (error: unknown) => String(error),
  );
  NodeAssert.match(JSON.stringify(pending), /authorization|catalog/i);
  const stale = await tool.execute("native-stale", { value: "stale" }).then(
    (value: unknown) => value,
    (error: unknown) => String(error),
  );
  NodeAssert.match(JSON.stringify(stale), /unavailable/i);
  process.stdout.write(
    JSON.stringify({
      type: "t3_product_proof",
      nativeHostTools: true,
      mountedInventory: true,
      mountedExecution: true,
      nativeEvalBridge: true,
      revoked: true,
      staleRefused: true,
      inference: 0,
      blockedNetwork,
    }) + "\n",
  );
  await loop;
} finally {
  await runtime.close();
}
