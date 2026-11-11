// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { parseRuntimeArgs, validateRuntimeConfig } from "./runtimeOptions.ts";
import { runtimeAssetSources } from "./runtimeAssets.generated.ts";

export function resolveOmpLaunchArgs(
  value: string,
): { ok: true; args: string[] } | { ok: false; message: string } {
  try {
    let quote: string | undefined;
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (c === "\\" && quote !== "'") {
        i++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = undefined;
      } else if (c === "'" || c === '"') quote = c;
    }
    if (quote || value.includes("\0")) throw new Error("Unterminated OMP argument quote");
    return { ok: true, args: parseRuntimeArgs(tokenizeCliArgs(value)).args };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}
function resolveOmpShimTarget(executable: string) {
  if (NodeFS.statSync(executable).size > 128 * 1024)
    throw new Error("Unsupported OMP command shim");
  const source = NodeFS.readFileSync(executable, "utf8");
  const targets = new Set(
    [
      ...Array.from(source.matchAll(/^# cmd-shim-target=([^\r\n]+)\r?$/gm), (match) => match[1]!),
      ...Array.from(
        source.matchAll(
          /["'](?:\$basedir(?:_abs|_win)?|%dp0%|%~dp0)[/\\]([^"'`$%\r\n]+[/\\]dist[/\\]cli\.js)["']/g,
        ),
        (match) => match[1]!,
      ),
    ].map((target) => target.replaceAll("\\", "/")),
  );
  const [target] = targets;
  if (
    targets.size !== 1 ||
    !target ||
    /[\0`$%]/.test(target) ||
    NodePath.isAbsolute(target) ||
    !target.endsWith("/dist/cli.js")
  )
    throw new Error("Unsupported OMP command shim");
  return NodeFS.realpathSync(NodePath.resolve(NodePath.dirname(executable), target));
}
export function resolveInstalledOmp(
  binary: string,
  env: NodeJS.ProcessEnv,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Bun loads these helpers and cannot import HostProcess's node:sea dependency.
  platform: NodeJS.Platform = NodeOS.platform(),
) {
  const pathKey =
    platform === "win32" ? Object.keys(env).find((key) => key.toUpperCase() === "PATH") : "PATH";
  const extensions =
    platform === "win32" && !NodePath.extname(binary)
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase())]
      : [""];
  const candidates =
    binary.includes("/") || binary.includes("\\")
      ? extensions.map((ext) => NodePath.resolve(binary + ext))
      : (pathKey ? (env[pathKey] ?? "") : "")
          .split(platform === "win32" ? ";" : ":")
          .flatMap((dir) =>
            extensions.map((ext) => NodePath.join(dir.replace(/^"(.*)"$/, "$1"), binary + ext)),
          );
  const executable = candidates.find((path) => NodeFS.existsSync(path));
  if (!executable) throw new Error(`OMP executable not found: ${binary}`);
  if (!binary.trim() || /[\0\r\n]/.test(binary)) throw new Error("Invalid OMP executable");
  try {
    if (platform !== "win32") NodeFS.accessSync(executable, NodeFS.constants.X_OK);
    if (!NodeFS.statSync(executable).isFile()) throw new Error();
  } catch {
    throw new Error("OMP path is not executable");
  }
  const resolved = NodeFS.realpathSync(executable);
  const real = resolved.endsWith(NodePath.join("dist", "cli.js"))
    ? resolved
    : resolveOmpShimTarget(resolved);
  const root = NodePath.dirname(NodePath.dirname(real));
  const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"));
  if (
    manifest.name !== "@oh-my-pi/pi-coding-agent" ||
    real !== NodePath.join(root, "dist", "cli.js")
  )
    throw new Error("Unsupported OMP executable layout; use a source-bearing npm installation");
  return root;
}
class OmpAssetError extends Schema.TaggedError<OmpAssetError>()("OmpAssetError", {
  cause: Schema.Defect(),
}) {}
export const materializeOmpRuntimeAssets = Effect.fn("Omp.materializeRuntimeAssets")(function* (
  cacheDir: string,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const files = Object.entries(runtimeAssetSources);
      const digest = NodeCrypto.createHash("sha256")
        .update(files.map(([name, source]) => name + "\0" + source).join("\0"))
        .digest("hex");
      const dir = NodePath.resolve(cacheDir, `omp-policy-${digest}`);
      await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
      for (const [name, source] of files) {
        const path = NodePath.join(dir, name);
        try {
          await NodeFSP.writeFile(path, source, { flag: "wx", mode: 0o400 });
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "EEXIST" ||
            (await NodeFSP.readFile(path, "utf8")) !== source
          )
            throw error;
        }
      }
      return {
        loader: NodePath.join(dir, "preload.ts"),
        launcher: NodePath.join(dir, "launcher.ts"),
      };
    },
    catch: (cause) => new OmpAssetError({ cause }),
  });
});
export function buildOmpRpcLaunch(input: {
  binaryPath?: string;
  bunPath?: string;
  launchArgs: string;
  env: NodeJS.ProcessEnv;
  assets: { loader: string; launcher: string };
  runtimeConfigPath: string;
}) {
  const parsed = resolveOmpLaunchArgs(input.launchArgs);
  if (!parsed.ok) throw new Error(parsed.message);
  if (!NodePath.isAbsolute(input.runtimeConfigPath))
    throw new Error("OMP runtime config path must be absolute");
  validateRuntimeConfig(JSON.parse(NodeFS.readFileSync(input.runtimeConfigPath, "utf8")));
  const assetDir = NodePath.dirname(input.assets.loader);
  if (
    input.assets.loader !== NodePath.join(assetDir, "preload.ts") ||
    input.assets.launcher !== NodePath.join(assetDir, "launcher.ts")
  )
    throw new Error("OMP required asset paths changed");
  for (const [name, source] of Object.entries(runtimeAssetSources)) {
    const path = NodePath.join(assetDir, name);
    if (NodeFS.realpathSync(path) !== path || NodeFS.readFileSync(path, "utf8") !== source)
      throw new Error(`OMP runtime asset mismatch: ${name}`);
  }
  const root = resolveInstalledOmp(input.binaryPath ?? "omp", input.env);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(input.env).filter(([name]) => {
      const key = name.toUpperCase();
      return (
        !key.startsWith("T3_") &&
        !key.startsWith("T3CODE_") &&
        !key.startsWith("BUN_") &&
        !key.startsWith("DYLD_") &&
        !["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_AUDIT", "PI_COMPILED"].includes(key)
      );
    }),
  );
  const launchEnv: NodeJS.ProcessEnv = { ...env, T3_OMP_RUNTIME_CONFIG: input.runtimeConfigPath };
  return {
    command: input.bunPath ?? "bun",
    args: [
      "--no-env-file",
      `--config=${NodePath.join(assetDir, "bunfig.toml")}`,
      "--preload",
      input.assets.loader,
      input.assets.launcher,
      root,
      ...parsed.args,
    ],
    env: launchEnv,
  };
}
