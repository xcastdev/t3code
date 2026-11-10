// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ownedPolicyManifest } from "../server/runtimeOptions.ts";
import { buildOmpRpcLaunch } from "../server/launch.ts";
import { OmpProtocolDecoder } from "../server/protocol.ts";
import { createControlServer } from "../server/controlChannel.ts";

export async function proveMaterialized(
  root: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  python: string,
) {
  const cache = NodePath.join(cwd, "cache");
  const stage = NodePath.join(cwd, "bundled");
  await NodeFSP.mkdir(stage, { recursive: true });
  const entry = NodePath.join(stage, "factory.mjs");
  const build = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--no-env-file",
      "build",
      "--target=node",
      `--outfile=${entry}`,
      NodeURL.fileURLToPath(new URL("./bundledAssetFactory.ts", import.meta.url)),
    ],
    { cwd, env, encoding: "utf8" },
  );
  NodeAssert.equal(build.status, 0, build.stdout + build.stderr);
  const denySource = NodePath.join(stage, "deny-source.mjs");
  const providerSource = NodeURL.fileURLToPath(new URL("../", import.meta.url));
  await NodeFSP.writeFile(
    denySource,
    `import fs from "node:fs";import {syncBuiltinESMExports} from "node:module";import {fileURLToPath} from "node:url";
const prefix=${JSON.stringify(providerSource)};
const check=path=>{if(String(path instanceof URL ? fileURLToPath(path):path).startsWith(prefix))throw Error("provider source-tree fallback forbidden");};
const read=fs.promises.readFile;fs.promises.readFile=function(path,...args){check(path);return read.call(this,path,...args)};
const readSync=fs.readFileSync;fs.readFileSync=function(path,...args){check(path);return readSync.call(this,path,...args)};syncBuiltinESMExports();
`,
  );
  const materialize = () => {
    const result = NodeChildProcess.spawnSync("node", ["--import", denySource, entry, cache], {
      cwd: stage,
      env,
      encoding: "utf8",
    });
    NodeAssert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout) as { loader: string; launcher: string };
  };
  const assets = materialize();
  const duplicate = materialize();
  NodeAssert.deepEqual(assets, duplicate);
  let ready = false;
  let nativeReady = false;
  let admitted = false;
  let negotiated = false;
  let deltaOnly = false;
  const begin = () => {
    if (ready && nativeReady && !admitted) {
      admitted = true;
      child.stdin.write(
        JSON.stringify({ type: "negotiate_protocol", protocolVersion: 2, id: "negotiate" }) + "\n",
      );
    }
  };
  const server = await createControlServer(
    (frame) => {
      if (frame.type === "ready") {
        ready = true;
        begin();
      }
    },
    () => {},
  );
  const bootstrapDir = NodePath.join(stage, "bootstrap");
  await NodeFSP.mkdir(bootstrapDir);
  const runtimeConfigPath = NodePath.join(bootstrapDir, "runtime-config.json");
  const overlay = NodePath.join(cwd, "explicit-config.yml");
  await NodeFSP.writeFile(
    overlay,
    `python:\n  interpreter: ${JSON.stringify(python)}\nasync:\n  enabled: true\ntools:\n  approvalMode: yolo\n`,
  );
  await NodeFSP.writeFile(
    runtimeConfigPath,
    JSON.stringify({
      policyManifest: ownedPolicyManifest,
      instructions: "T3 native scoped instruction proof",
      cwd,
      agentDir: env.PI_CODING_AGENT_DIR,
      mode: "approval-required",
      environment: "e",
      project: "p",
      providerSession: "materialized",
      credentialPath: server.credentialPath,
    }),
    { mode: 0o600 },
  );
  const launch = buildOmpRpcLaunch({
    binaryPath: NodePath.join(root, "dist/cli.js"),
    bunPath: process.execPath,
    launchArgs: `--config ${JSON.stringify(overlay)}`,
    env: { ...env, T3_MCP_BEARER: "MUST_CLEAR", NODE_OPTIONS: "MUST_CLEAR" },
    assets,
    runtimeConfigPath,
  });
  NodeAssert.equal(launch.env.T3_MCP_BEARER, undefined);
  NodeAssert.equal(launch.env.NODE_OPTIONS, undefined);
  const networkBoundary = NodePath.join(stage, "network-boundary.ts");
  await NodeFSP.copyFile(new URL("./nativeNetworkBoundary.ts", import.meta.url), networkBoundary);
  const hostileBunfigs = [
    NodePath.join(cwd, "bunfig.toml"),
    NodePath.join(env.HOME!, ".bunfig.toml"),
  ];
  const hostile = NodePath.join(stage, "hostile-preload.ts");
  await NodeFSP.writeFile(hostile, 'throw new Error("inherited Bun preload executed");');
  for (const path of hostileBunfigs)
    await NodeFSP.writeFile(path, `preload = [${JSON.stringify(hostile)}]\n`);
  const configBefore = await NodeFSP.readFile(overlay, "utf8");
  const child = NodeChildProcess.spawn(
    launch.command,
    [
      "--no-env-file",
      "--preload",
      networkBoundary,
      "--preload",
      denySource,
      ...launch.args.slice(1),
    ],
    { cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const decoder = new OmpProtocolDecoder();
  let state = false;
  let transportFailure: unknown;
  child.stdout.on("data", (bytes: Uint8Array) => {
    try {
      for (const frame of decoder.push(bytes)) {
        if (frame.type === "ready") {
          nativeReady = true;
          begin();
        }
        if (frame.type === "response" && frame.id === "negotiate") {
          NodeAssert.equal(frame.success, true);
          NodeAssert.deepEqual(frame.data, { protocolVersion: 2 });
          decoder.enableV2();
          negotiated = true;
          child.stdin.write(
            JSON.stringify({
              type: "set_event_filter",
              events: null,
              messageUpdates: "delta",
              id: "filter",
            }) + "\n",
          );
        }
        if (frame.type === "response" && frame.id === "filter") {
          NodeAssert.equal(frame.success, true);
          NodeAssert.equal((frame.data as { messageUpdates: string }).messageUpdates, "delta");
          deltaOnly = true;
          child.stdin.write(JSON.stringify({ type: "get_state", id: "state" }) + "\n");
        }
        if (frame.type === "response" && frame.id === "state") {
          NodeAssert.equal(frame.success, true);
          NodeAssert.ok(JSON.stringify(frame.data).includes("T3 native scoped instruction proof"));
          state = true;
          child.stdin.end();
        }
      }
    } catch (error) {
      transportFailure = error;
      child.kill();
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    NodeAssert.ifError(transportFailure);
    decoder.end();
    NodeAssert.equal(code, 0);
    NodeAssert.ok(ready);
    NodeAssert.ok(state);
    NodeAssert.ok(negotiated && deltaOnly);
    NodeAssert.equal(
      await NodeFSP.readFile(overlay, "utf8"),
      configBefore,
      "ordinary native config must remain unchanged",
    );
    process.stdout.write(
      JSON.stringify({
        materializedSdkLauncher: "PASS",
        immutableAssets: true,
        bundledNodeFactory: true,
        sourceTreeFallback: false,
        nativeState: true,
        guardHandshake: true,
        bunConfigIsolated: true,
        nativeConfigUnchanged: true,
        protocolVersion: 2,
        deltaOnly: true,
        scopedInstructions: true,
      }) + "\n",
    );
  } finally {
    if (child.exitCode === null) child.kill();
    await server.close();
    for (const path of hostileBunfigs) await NodeFSP.rm(path, { force: true });
  }
}
