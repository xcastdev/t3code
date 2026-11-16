// @effect-diagnostics nodeBuiltinImport:off
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { OmpSettings } from "../settings.ts";
import { resolveOmpLaunchArgs, buildOmpRpcLaunch, resolveInstalledOmp } from "./launch.ts";
import { applyRuntimeLaunchArgs } from "./runtimeMain.ts";

const decodeSettings = Schema.decodeSync(OmpSettings);
it("resolves static package-manager shim targets without executing the shim", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-shim-"));
  try {
    const root = NodePath.join(dir, "node_modules/@oh-my-pi/pi-coding-agent");
    const bin = NodePath.join(dir, "node_modules/.bin");
    NodeFS.mkdirSync(NodePath.join(root, "dist"), { recursive: true });
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(
      NodePath.join(root, "package.json"),
      JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }),
    );
    NodeFS.writeFileSync(NodePath.join(root, "dist/cli.js"), "", { mode: 0o700 });
    const expectedRoot = NodeFS.realpathSync(root);
    const marker = NodePath.join(dir, "executed");
    const shim = NodePath.join(bin, "omp");
    for (const source of [
      `#!/bin/sh\ntouch '${marker}'\n# cmd-shim-target=../@oh-my-pi/pi-coding-agent/dist/cli.js\n`,
      '#!/bin/sh\nexec bun "$basedir/../@oh-my-pi/pi-coding-agent/dist/cli.js" "$@"\n',
      '@echo off\r\nbun "%dp0%\\..\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" %*\r\n',
      '& "bun" "$basedir/../@oh-my-pi/pi-coding-agent/dist/cli.js" $args\n',
    ]) {
      NodeFS.writeFileSync(shim, source, { mode: 0o700 });
      expect(resolveInstalledOmp("omp", { PATH: bin })).toBe(expectedRoot);
      expect(NodeFS.existsSync(marker)).toBe(false);
    }
    NodeFS.writeFileSync(
      shim + ".cmd",
      '@echo off\r\nbun "%dp0%\\..\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" %*\r\n',
    );
    NodeFS.rmSync(shim);
    expect(resolveInstalledOmp("omp", { Path: bin, PATHEXT: ".CMD" }, "win32")).toBe(expectedRoot);
    NodeFS.writeFileSync(shim, '#!/bin/sh\nexec bun "$basedir/$TARGET/dist/cli.js" "$@"\n', {
      mode: 0o700,
    });
    expect(() => resolveInstalledOmp(shim, {})).toThrow("Unsupported OMP command shim");
    NodeFS.writeFileSync(
      shim,
      "# cmd-shim-target=../@oh-my-pi/pi-coding-agent/dist/cli.js\n# cmd-shim-target=../other/dist/cli.js\n",
    );
    expect(() => resolveInstalledOmp(shim, {})).toThrow("Unsupported OMP command shim");
    NodeFS.writeFileSync(NodePath.join(root, "package.json"), JSON.stringify({ name: "other" }));
    NodeFS.writeFileSync(shim, "# cmd-shim-target=../@oh-my-pi/pi-coding-agent/dist/cli.js\n");
    expect(() => resolveInstalledOmp(shim, {})).toThrow("Unsupported OMP executable layout");
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

it("defaults disabled and preserves native profile/provider/model options without admitting policy or runtime controls", () => {
  expect(decodeSettings({})).toMatchObject({
    enabled: false,
    binaryPath: "omp",
    launchArgs: "",
  });
  const parsed = resolveOmpLaunchArgs(
    '--profile=work --provider anthropic --model="model name" --config "policy file.yml" --agent-dir /agent',
  );
  expect(parsed).toEqual({
    ok: true,
    args: [
      "--profile",
      "work",
      "--provider",
      "anthropic",
      "--model",
      "model name",
      "--config",
      "policy file.yml",
      "--agent-dir",
      "/agent",
    ],
  });
  expect(
    applyRuntimeLaunchArgs({ agentDir: "/default" }, parsed.ok ? parsed.args : []),
  ).toMatchObject({
    agentDir: "/agent",
    profile: "work",
    provider: "anthropic",
    model: "model name",
    configFiles: ["policy file.yml"],
  });
  for (const args of [
    "--mode=rpc",
    "--mode rpc",
    "-c",
    "-p hi",
    "-e x",
    "--session=x",
    "--fork=x",
    "--resume",
    "--approval-mode=yolo",
    "--yolo",
    "--auto-approve",
    "--extension=x",
    "--preload=x",
    "--eval=x",
    "--bun",
    "--runtime-config=x",
    "-- --model x",
    "prompt",
    "@file",
    "--model",
    "--model=",
    "--profile=../escape",
    '--model "unfinished',
  ])
    expect(resolveOmpLaunchArgs(args).ok, args).toBe(false);
});

it("rejects non-executable package lookalikes and clears runtime injection environment without mutating the caller", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-launch-"));
  try {
    NodeFS.mkdirSync(NodePath.join(dir, "dist"));
    NodeFS.writeFileSync(NodePath.join(dir, "dist/cli.js"), "");
    NodeFS.writeFileSync(
      NodePath.join(dir, "package.json"),
      JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }),
    );
    expect(() => resolveInstalledOmp(NodePath.join(dir, "dist/cli.js"), {})).toThrow(/executable/);
    const env = {
      PATH: HostProcess.Environment.defaultValue().PATH,
      NODE_OPTIONS: "--import hostile",
      BUN_OPTIONS: "--preload hostile",
      BUN_PRELOAD: "hostile",
      BUN_INSPECT: "1",
      T3CODE_TOKEN: "secret",
      PI_CODING_AGENT_DIR: "/explicit",
      ANTHROPIC_API_KEY: "provider-key",
      OMP_PROFILE: "work",
    };
    // Assets and manifest are mandatory even when executable resolution succeeds.
    expect(() =>
      buildOmpRpcLaunch({
        binaryPath: process.execPath,
        launchArgs: "",
        env,
        assets: { loader: "/missing", launcher: "/missing" },
        runtimeConfigPath: "/missing",
      }),
    ).toThrow();
    expect(env.NODE_OPTIONS).toBe("--import hostile");
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

it.effect(
  "verifies immutable launch assets/manifest and scopes provider credentials while removing inherited preloads",
  () =>
    Effect.gen(function* () {
      const { materializeOmpRuntimeAssets } = yield* Effect.promise(() => import("./launch.ts"));
      const { ownedPolicyManifest } = yield* Effect.promise(() => import("./runtimeOptions.ts"));
      const url = yield* Effect.promise(() => import("node:url"));
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-assets-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      const assets = yield* materializeOmpRuntimeAssets(dir);
      const configPath = NodePath.join(dir, "runtime.json");
      const config = {
        cwd: dir,
        mode: "full-access",
        environment: "e",
        project: "p",
        providerSession: "s",
        credentialPath: NodePath.join(dir, "credential"),
        policyManifest: ownedPolicyManifest,
      };
      NodeFS.writeFileSync(configPath, JSON.stringify(config));
      const root = NodePath.dirname(
        NodePath.dirname(url.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"))),
      );
      const env = {
        PATH: (yield* HostProcess.Environment).PATH,
        NODE_OPTIONS: "--import x",
        BUN_OPTIONS: "--preload x",
        BUN_PRELOAD: "x",
        BUN_INSPECT: "1",
        T3CODE_TOKEN: "secret",
        PI_CODING_AGENT_DIR: "/explicit",
        TEST_PROVIDER_KEY: "provider-key",
      };
      const input = {
        binaryPath: NodePath.join(root, "dist/cli.js"),
        launchArgs: "--profile=work --provider=x --model=y",
        env,
        assets,
        runtimeConfigPath: configPath,
      };
      const launch = buildOmpRpcLaunch(input);
      expect(launch.env).toEqual({
        PATH: env.PATH,
        PI_CODING_AGENT_DIR: "/explicit",
        TEST_PROVIDER_KEY: "provider-key",
        T3_OMP_RUNTIME_CONFIG: configPath,
      });
      expect(launch.args).toContain(
        `--config=${NodePath.join(NodePath.dirname(assets.loader), "bunfig.toml")}`,
      );
      expect(env.NODE_OPTIONS).toBe("--import x");
      expect(launch.command).toBe("bun");
      expect(
        applyRuntimeLaunchArgs(
          config,
          resolveOmpLaunchArgs(input.launchArgs).ok ? ["--model", "y"] : [],
        ).mode,
      ).toBe("full-access");
      NodeFS.writeFileSync(
        configPath,
        JSON.stringify({
          ...config,
          policyManifest: { ...ownedPolicyManifest, autoApprove: true },
        }),
      );
      expect(() => buildOmpRpcLaunch(input)).toThrow(/manifest/);
      NodeFS.writeFileSync(configPath, JSON.stringify(config));
      NodeFS.chmodSync(assets.loader, 0o600);
      NodeFS.writeFileSync(assets.loader, "import 'hostile';");
      expect(() => buildOmpRpcLaunch(input)).toThrow(/asset/);
    }).pipe(Effect.scoped),
);
