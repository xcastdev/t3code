// @effect-diagnostics nodeBuiltinImport:off
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { describe, it } from "vite-plus/test";

import {
  buildClaudeManagedSkillSessionOptions,
  managedClaudeSkillInvocationNames,
} from "./ClaudeManagedSkills.ts";
import { planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

interface IsolatedClaudeRuntime {
  readonly root: string;
  readonly home: string;
  readonly configDir: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

interface ClaudeProcessTracker {
  readonly spawnClaudeCodeProcess: NonNullable<Options["spawnClaudeCodeProcess"]>;
  readonly hasExited: () => boolean;
  readonly waitForExit: () => Promise<void>;
}

function createClaudeProcessTracker(label: string): ClaudeProcessTracker {
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  let processExit: Promise<void> | undefined;
  let exited = false;

  const spawnClaudeCodeProcess: NonNullable<Options["spawnClaudeCodeProcess"]> = (options) => {
    NodeAssert.equal(child, undefined, `Claude query ${label} spawned more than one process`);

    const spawnedChild = NodeChildProcess.spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child = spawnedChild;

    // The SDK's custom-spawn path does not install its local stderr reader.
    // Drain stderr so pipe backpressure cannot keep the real CLI alive.
    spawnedChild.stderr.resume();

    const processSpawned = new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        spawnedChild.off("error", onSpawnError);
        resolve();
      };
      const onSpawnError = (error: Error) => {
        spawnedChild.off("spawn", onSpawn);
        reject(error);
      };
      spawnedChild.once("spawn", onSpawn);
      spawnedChild.once("error", onSpawnError);
    });
    const rawExit = new Promise<void>((resolve) => {
      spawnedChild.once("exit", () => {
        exited = true;
        resolve();
      });
    });
    processExit = processSpawned.then(() => rawExit);
    // Retain rejection for waitForExit(), but mark it handled immediately so
    // an asynchronous spawn failure cannot become an unhandled rejection.
    processExit.catch(() => {});
    return spawnedChild;
  };

  return {
    spawnClaudeCodeProcess,
    hasExited: () => exited,
    waitForExit: async () => {
      NodeAssert.ok(child, `Claude query ${label} never invoked the SDK spawn hook`);
      NodeAssert.ok(processExit, `Claude query ${label} has no retained exit signal`);
      await processExit;
    },
  };
}

async function createIsolatedClaudeRuntime(label: string): Promise<IsolatedClaudeRuntime> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), `t3-claude-skills-${label}-`));
  try {
    const home = NodePath.join(root, "home");
    const configDir = NodePath.join(root, "claude-config");
    const cwd = NodePath.join(root, "workspace");
    const xdgConfigHome = NodePath.join(root, "xdg-config");
    const secureStorageDir = NodePath.join(root, "secure-storage");
    const tempDir = NodePath.join(root, "tmp");
    const nativeSkillDir = NodePath.join(configDir, "skills/deploy");
    await Promise.all([
      NodeFSP.mkdir(home, { recursive: true }),
      NodeFSP.mkdir(cwd, { recursive: true }),
      NodeFSP.mkdir(xdgConfigHome, { recursive: true }),
      NodeFSP.mkdir(secureStorageDir, { recursive: true }),
      NodeFSP.mkdir(tempDir, { recursive: true }),
      NodeFSP.mkdir(nativeSkillDir, { recursive: true }),
    ]);
    await NodeFSP.copyFile(
      NodePath.join(import.meta.dirname, "../testFixtures/claudeNativeSkill/deploy/SKILL.md"),
      NodePath.join(nativeSkillDir, "SKILL.md"),
    );

    const env: NodeJS.ProcessEnv = {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...(process.env.COMSPEC === undefined ? {} : { COMSPEC: process.env.COMSPEC }),
      ...(process.env.PATHEXT === undefined ? {} : { PATHEXT: process.env.PATHEXT }),
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorageDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      TMPDIR: tempDir,
      TMP: tempDir,
      TEMP: tempDir,
    };

    return { root, home, configDir, cwd, env };
  } catch (error) {
    await NodeFSP.rm(root, { recursive: true, force: true });
    throw error;
  }
}

function streamingInput(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
            once: true,
          });
        }),
    }),
  };
}

async function supportedCommandNames(input: {
  readonly executablePath: string;
  readonly runtime: IsolatedClaudeRuntime;
  readonly options?: Pick<Options, "plugins" | "settings">;
}): Promise<ReadonlyArray<string>> {
  const inputAbort = new AbortController();
  const processTracker = createClaudeProcessTracker(NodePath.basename(input.runtime.root));
  const session = query({
    prompt: streamingInput(inputAbort.signal),
    options: {
      cwd: input.runtime.cwd,
      env: input.runtime.env,
      pathToClaudeCodeExecutable: input.executablePath,
      persistSession: false,
      settingSources: ["user"],
      skills: "all",
      ...input.options,
      spawnClaudeCodeProcess: processTracker.spawnClaudeCodeProcess,
    },
  });
  try {
    return (await session.supportedCommands()).map((command) => command.name);
  } finally {
    inputAbort.abort();
    session.close();
    try {
      await session.return();
    } finally {
      await processTracker.waitForExit();
    }
    NodeAssert.equal(processTracker.hasExited(), true);
  }
}

describe("Claude managed-skill delivery feasibility", () => {
  it(
    "loads the managed qualified skill and disables the colliding bare skill",
    { timeout: 30_000 },
    async () => {
      const executablePath = process.env.T3_CLAUDE_TEST_EXECUTABLE;
      NodeAssert.ok(executablePath, "T3_CLAUDE_TEST_EXECUTABLE must name the Claude executable");
      NodeAssert.ok(NodePath.isAbsolute(executablePath), "Claude test executable must be absolute");

      const baseline = await createIsolatedClaudeRuntime("baseline");
      let managed: IsolatedClaudeRuntime | undefined;
      try {
        managed = await createIsolatedClaudeRuntime("managed");
        const versionResult = await execFile(executablePath, ["--version"], {
          cwd: baseline.cwd,
          env: baseline.env,
        });
        const executableVersion = versionResult.stdout.trim();
        NodeAssert.ok(executableVersion.length > 0, "Claude executable version must be nonempty");

        const pluginPath = NodePath.join(
          import.meta.dirname,
          "../testFixtures/claudeManagedPlugin",
        );
        const manifest = JSON.parse(
          NodeFS.readFileSync(NodePath.join(pluginPath, ".claude-plugin/plugin.json"), "utf8"),
        ) as unknown;
        NodeAssert.deepStrictEqual(manifest, { name: "t3-managed", version: "0.0.0" });
        NodeAssert.match(
          NodeFS.readFileSync(NodePath.join(pluginPath, "skills/deploy/SKILL.md"), "utf8"),
          /^---\nname: deploy\n/m,
        );

        const baselineCommands = await supportedCommandNames({
          executablePath,
          runtime: baseline,
        });
        NodeAssert.ok(baselineCommands.includes("deploy"), baselineCommands.join(", "));

        const managedCommands = await supportedCommandNames({
          executablePath,
          runtime: managed,
          options: buildClaudeManagedSkillSessionOptions({
            pluginPath,
            collidingNativeKeys: ["deploy"],
          }),
        });
        NodeAssert.ok(managedCommands.includes("t3-managed:deploy"), managedCommands.join(", "));
        NodeAssert.equal(managedCommands.includes("deploy"), false, managedCommands.join(", "));

        NodeAssert.deepStrictEqual(
          planClaudeSkillDispatch(
            "!deploy",
            new Set(["deploy"]),
            managedClaudeSkillInvocationNames(["deploy"]),
          ),
          {
            leadingText: undefined,
            commandText: "/t3-managed:deploy",
            skillName: "deploy",
          },
        );
      } finally {
        await Promise.all([
          NodeFSP.rm(baseline.root, { recursive: true, force: true }),
          ...(managed === undefined
            ? []
            : [NodeFSP.rm(managed.root, { recursive: true, force: true })]),
        ]);
      }
    },
  );
});
