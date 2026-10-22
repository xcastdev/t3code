// @effect-diagnostics nodeBuiltinImport:off -- Test-only native execution requires disposable realpath claims.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { FixtureNativeDenied } from "./upgradeFixtureNative.ts";
import {
  assertDisposablePath,
  assertPreparedUpgradeSnapshot,
  type UpgradeSnapshot,
} from "./prepareUpgradeSnapshot.ts";
import { upgradeFixtureRoots } from "./upgradeFixtureRoots.ts";

const exact = (args: ReadonlyArray<string>, expected: ReadonlyArray<string>) =>
  args.length === expected.length && args.every((arg, index) => arg === expected[index]);

export const controlledScmPaths = ["p21-staged.txt", "p21-unstaged.txt"] as const;
export const controlledScmCommitMessage = "P21 staged fixture";

/** Raw argv is closed by default, including Git's command/config injection options. */
export function controlledGitArguments(input: ReadonlyArray<string>, cwd: string): boolean {
  let args = input;
  const config = new Set([
    "core.fsmonitor=false",
    "core.untrackedCache=false",
    "core.quotepath=false",
    "sparse.expectFilesOutsideOfPatterns=false",
    "core.splitIndex=false",
    "splitIndex.sharedIndexExpire=never",
    "core.fsync=objects,reference",
    "core.fsyncMethod=fsync",
  ]);
  while (args[0] === "-c" && args[1] && config.has(args[1])) args = args.slice(2);
  if (args[0] === "-c" && args[1]?.startsWith("core.hooksPath=")) {
    const hooks = args[1].slice("core.hooksPath=".length);
    if (
      NodePath.dirname(hooks) !== NodePath.join(cwd, ".git") ||
      !/^t3-commit-[a-zA-Z0-9]+$/.test(NodePath.basename(hooks))
    )
      return false;
    args = args.slice(2);
  }
  const authoredPaths = (paths: ReadonlyArray<string>) =>
    paths.length > 0 &&
    paths.length <= controlledScmPaths.length &&
    paths.every((path) => controlledScmPaths.some((authored) => authored === path));
  const sha = (value: string | undefined) =>
    value !== undefined && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  if (args[0] === "add" && args[1] === "--" && authoredPaths(args.slice(2))) return true;
  if (args[0] === "reset" && sha(args[1]) && args[2] === "--" && authoredPaths(args.slice(3)))
    return true;
  if (
    args[0] === "commit-tree" &&
    sha(args[1]) &&
    args.length === 4 &&
    args[2] === "-p" &&
    sha(args[3])
  )
    return true;
  if (
    args[0] === "update-ref" &&
    args.length === 6 &&
    exact(args.slice(1, 4), ["-m", "commit: staged changes", "refs/heads/main"]) &&
    sha(args[4]) &&
    sha(args[5])
  )
    return true;
  if (
    args[0] === "log" &&
    args.length === 9 &&
    exact(args.slice(0, 6), ["log", "--branches", "--remotes", "--tags", "HEAD", "--topo-order"]) &&
    /^--skip=\d{1,5}$/.test(args[6]!) &&
    /^--max-count=(?:[1-9]\d?|10[01])$/.test(args[7]!) &&
    args[8] === "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00"
  )
    return true;
  if (
    args[0] === "show" &&
    exact(args.slice(0, 8), [
      "show",
      "--format=",
      "--first-parent",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ]) &&
    sha(args[8]) &&
    args[9] === "--" &&
    (args.length === 10 || (args.length === 11 && authoredPaths(args.slice(10))))
  )
    return true;
  const checkpointRef = (value: string | undefined) =>
    value !== undefined &&
    /^refs\/t3\/orchestration-v2\/checkpoints\/[a-zA-Z0-9_/-]+$/.test(value) &&
    !value.includes("..");
  const oid = (value: string | undefined) => value !== undefined && /^[a-f0-9]{40,64}$/.test(value);
  if (
    args[0] === "rev-parse" &&
    exact(args.slice(0, 3), ["rev-parse", "--verify", "--quiet"]) &&
    args.length === 4 &&
    (args[3] === "HEAD^{commit}" ||
      (args[3]?.endsWith("^{commit}") && checkpointRef(args[3].slice(0, -9))))
  )
    return true;
  if (args[0] === "update-ref" && args.length === 3 && checkpointRef(args[1]) && oid(args[2]))
    return true;
  if (args[0] === "commit-tree" && oid(args[1])) {
    const rest = args.slice(2);
    return (
      (rest.length === 4 &&
        exact(rest.slice(0, 3), ["-p", "HEAD", "-m"]) &&
        checkpointRef(rest[3]?.replace(/^t3 checkpoint ref=/, ""))) ||
      (rest.length === 2 &&
        rest[0] === "-m" &&
        checkpointRef(rest[1]?.replace(/^t3 checkpoint ref=/, "")))
    );
  }
  return [
    ["symbolic-ref", "-q", "HEAD"],
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    ["config", "--bool", "--get", "commit.gpgSign"],
    [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ],
    ...["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].map(
      (marker) => ["rev-parse", "--path-format=absolute", "--git-path", marker],
    ),
    ["rev-parse", "--is-inside-work-tree"],
    ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    ["config", "--bool", "core.sparseCheckout"],
    ["read-tree", "--reset", "HEAD"],
    ["read-tree", "--empty"],
    ["ls-files", "--full-name", "--sparse", "-v", "-z"],
    ["check-ignore", "-q", "."],
    ["check-ignore", "--no-index", "-z", "--stdin"],
    ["read-tree", "HEAD"],
    ["add", "-A", "--", "."],
    ["write-tree"],
    ["--version"],
    ["init", "--initial-branch=main", "--template="],
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--git-common-dir"],
    ["rev-parse", "--absolute-git-dir"],
    ["rev-parse", "--verify", "HEAD^{commit}"],
    ["rev-parse", "--verify", "HEAD"],
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    ["add", "--force", "--", ".t3-assistant-owner"],
    ["commit", "--message", "Initialize assistant workspace"],
    ["config", "--local", "user.name", "T3 Assistant"],
    ["config", "--local", "user.email", "assistant@localhost"],
    ["config", "--local", "commit.gpgsign", "false"],
    ["config", "--local", "core.hooksPath", NodePath.join(cwd, ".git", "t3-no-hooks")],
  ].some((candidate) => exact(args, candidate));
}

const controlledIndexPath = (cwd: string, index: string) =>
  NodePath.isAbsolute(index) &&
  ((NodePath.dirname(index) === NodePath.join(cwd, ".git") &&
    /^t3-checkpoint-index-[a-f0-9-]{36}$/.test(NodePath.basename(index))) ||
    /^\.git\/t3-(?:index|commit)-[a-zA-Z0-9]+\/index$/.test(NodePath.relative(cwd, index))) &&
  assertDisposablePath(cwd, index) === index;

export function layerControlledProcessRunner(snapshot: UpgradeSnapshot) {
  return Layer.effectContext(
    Effect.gen(function* () {
      assertPreparedUpgradeSnapshot(snapshot);
      const roots = upgradeFixtureRoots(snapshot);
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      const gitConfigurations = new Map<string, string>();
      const home = assertDisposablePath(
        snapshot.fixtureRoot,
        NodePath.join(snapshot.fixtureRoot, "sterile-home"),
      );
      NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
      const configEntries = [
        ["core.hooksPath", "/dev/null"],
        ["core.fsmonitor", "false"],
        ["protocol.allow", "never"],
        ["commit.gpgsign", "false"],
        ["user.name", "T3 Fixture"],
        ["user.email", "fixture@localhost"],
      ];
      const env = {
        PATH: "/usr/bin:/bin",
        HOME: home,
        LANG: "C",
        TERM: "dumb",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: String(configEntries.length),
        ...Object.fromEntries(
          configEntries.flatMap(([key, value], index) => [
            [`GIT_CONFIG_KEY_${index}`, key],
            [`GIT_CONFIG_VALUE_${index}`, value],
          ]),
        ),
      };
      const spawn: typeof native.spawn = (command) =>
        Effect.suspend(() => {
          if (
            command._tag !== "StandardCommand" ||
            command.options.shell ||
            command.command !== "git" ||
            typeof command.options.cwd !== "string"
          )
            return Effect.die(new FixtureNativeDenied({ operation: "controlled.spawn" }));
          const cwd = command.options.cwd;
          assertPreparedUpgradeSnapshot(snapshot);
          // Only Git's fixed version probe may execute outside a claimed project.
          if (
            !(
              cwd === NodePath.join(snapshot.fixtureRoot, "runtime") &&
              exact(command.args, ["--version"])
            )
          ) {
            if (
              !NodePath.isAbsolute(cwd) ||
              roots.mapOwnedPath(cwd) !== cwd ||
              NodeFS.realpathSync(cwd) !== cwd
            )
              return Effect.die(new FixtureNativeDenied({ operation: "controlled.cwd" }));
          }
          for (const argument of command.args) {
            if (!argument.startsWith("core.hooksPath=")) continue;
            const hooks = argument.slice("core.hooksPath=".length);
            if (
              NodePath.dirname(hooks) !== NodePath.join(cwd, ".git") ||
              !/^t3-commit-[a-zA-Z0-9]+$/.test(NodePath.basename(hooks)) ||
              NodeFS.readdirSync(hooks).some((name) => name !== "index" && name !== "index.lock")
            )
              return Effect.die(new FixtureNativeDenied({ operation: "controlled.hooks" }));
          }
          const selectedIndex = command.options.env?.GIT_INDEX_FILE;
          if (
            selectedIndex !== undefined &&
            (typeof selectedIndex !== "string" || !controlledIndexPath(cwd, selectedIndex))
          )
            return Effect.die(new FixtureNativeDenied({ operation: "controlled.index" }));
          if (!controlledGitArguments(command.args, cwd))
            return Effect.die(new FixtureNativeDenied({ operation: "controlled.argv" }));
          const dotGit = NodePath.join(cwd, ".git");
          if (NodeFS.existsSync(dotGit)) {
            // Git indirection can escape an otherwise legitimate working directory.
            if (!NodeFS.lstatSync(dotGit).isDirectory() || NodeFS.realpathSync(dotGit) !== dotGit)
              return Effect.die(new FixtureNativeDenied({ operation: "controlled.gitdir" }));
            const visit = (directory: string): void => {
              for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
                const target = NodePath.join(directory, entry.name);
                if (entry.isSymbolicLink() || assertDisposablePath(dotGit, target) !== target)
                  throw new FixtureNativeDenied({ operation: "controlled.gitmetadata" });
                if (entry.isDirectory()) visit(target);
              }
            };
            visit(dotGit);
            const configFile = NodePath.join(dotGit, "config");
            if (
              !gitConfigurations.has(cwd) ||
              !NodeFS.existsSync(configFile) ||
              NodeFS.readFileSync(configFile, "utf8") !== gitConfigurations.get(cwd)
            )
              return Effect.die(new FixtureNativeDenied({ operation: "controlled.gitconfig" }));
            for (const name of ["commondir", "gitdir", "objects/info/alternates", "worktrees"])
              if (NodeFS.existsSync(NodePath.join(dotGit, name)))
                return Effect.die(
                  new FixtureNativeDenied({ operation: "controlled.gitindirection" }),
                );
          }
          // The platform's scoped child handle owns termination; no PID matching is used.
          return native
            .spawn(
              ChildProcess.make("git", command.args, {
                ...command.options,
                env: {
                  ...env,
                  ...(typeof command.options.env?.GIT_INDEX_FILE === "string"
                    ? { GIT_INDEX_FILE: command.options.env.GIT_INDEX_FILE }
                    : {}),
                },
                extendEnv: false,
              }),
            )
            .pipe(
              Effect.map(
                (child) =>
                  new Proxy(child, {
                    get(target, key, receiver) {
                      if (key === "exitCode")
                        return target.exitCode.pipe(
                          Effect.tap((code) =>
                            Effect.sync(() => {
                              if (
                                code === 0 &&
                                (command.args[0] === "init" || command.args[0] === "config")
                              ) {
                                const configFile = NodePath.join(cwd, ".git", "config");
                                if (NodeFS.existsSync(configFile))
                                  gitConfigurations.set(
                                    cwd,
                                    NodeFS.readFileSync(configFile, "utf8"),
                                  );
                              }
                            }),
                          ),
                        );
                      return Reflect.get(target, key, receiver);
                    },
                  }),
              ),
            );
        });
      const safe = new Proxy(native, {
        get(target, key, receiver) {
          return key === "spawn" ? spawn : Reflect.get(target, key, receiver);
        },
      });
      const runner = yield* ProcessRunner.make().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, safe),
      );
      const controlledRunner = ProcessRunner.ProcessRunner.of({
        ...runner,
        run: Effect.fn("ControlledProcessRunner.run")(function* (input) {
          const logicalArgs =
            input.args[0] === "-C" && input.args[1] === input.cwd
              ? input.args.slice(2)
              : input.args;
          if (
            input.stdin !== undefined &&
            !(
              input.stdin === `${controlledScmCommitMessage}\n` && logicalArgs[0] === "commit-tree"
            ) &&
            !(
              input.stdin === ".\0" &&
              exact(input.args.slice(-4), ["check-ignore", "--no-index", "-z", "--stdin"])
            )
          )
            return yield* Effect.die(new FixtureNativeDenied({ operation: "controlled.input" }));
          const routed = input.args[0] === "-C" && input.args[1] === input.cwd;
          if (input.spawnCwd !== undefined && !routed)
            return yield* Effect.die(new FixtureNativeDenied({ operation: "controlled.spawnCwd" }));
          const index = input.env?.GIT_INDEX_FILE;
          if (
            index !== undefined &&
            (!input.cwd || typeof index !== "string" || !controlledIndexPath(input.cwd, index))
          )
            return yield* Effect.die(new FixtureNativeDenied({ operation: "controlled.index" }));
          // Production VCS routes Git with -C. Execute inside the same validated owned root.
          const result = yield* runner.run({
            ...input,
            args: routed ? input.args.slice(2) : input.args,
            spawnCwd: undefined,
            env: {
              ...env,
              GIT_LITERAL_PATHSPECS: "1",
              ...(typeof index === "string" ? { GIT_INDEX_FILE: index } : {}),
            },
            extendEnv: false,
          });
          const args = routed ? input.args.slice(2) : input.args;
          if (result.code === 0 && input.cwd && (args[0] === "init" || args[0] === "config")) {
            const configFile = NodePath.join(input.cwd, ".git", "config");
            if (NodeFS.existsSync(configFile))
              gitConfigurations.set(input.cwd, NodeFS.readFileSync(configFile, "utf8"));
          }
          return result;
        }),
      });
      return Context.make(ProcessRunner.ProcessRunner, controlledRunner).pipe(
        Context.add(ChildProcessSpawner.ChildProcessSpawner, safe),
      );
    }),
  );
}

/** Production VCS translates errors and uses the same guarded runner as folder validation. */
export const layerControlledVcsProcess = Layer.effect(VcsProcess.VcsProcess, VcsProcess.make);

export const controlledTerminalInput = "printf 'p21-fixture-terminal\\n'\r";

/** A real terminal with one authored input; copied setup scripts never enter its shell. */
export function layerControlledPty(snapshot: UpgradeSnapshot) {
  return Layer.effect(
    PtyAdapter.PtyAdapter,
    Effect.gen(function* () {
      const native = yield* PtyAdapter.PtyAdapter;
      const roots = upgradeFixtureRoots(snapshot);
      const home = assertDisposablePath(
        snapshot.fixtureRoot,
        NodePath.join(snapshot.fixtureRoot, "sterile-home"),
      );
      NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
      const owned = new Set<PtyAdapter.PtyProcess>();
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          owned,
          (child) =>
            child.signalOwned && child.awaitOwnedExit
              ? child
                  .signalOwned("SIGKILL")
                  .pipe(Effect.andThen(child.awaitOwnedExit), Effect.ignore)
              : Effect.sync(() => child.kill()),
          { discard: true },
        ),
      );
      return PtyAdapter.PtyAdapter.of({
        spawn: Effect.fn("ControlledPty.spawn")(function* (input) {
          assertPreparedUpgradeSnapshot(snapshot);
          if (
            !NodePath.isAbsolute(input.cwd) ||
            roots.mapOwnedPath(input.cwd) !== input.cwd ||
            NodeFS.realpathSync(input.cwd) !== input.cwd
          )
            return yield* new PtyAdapter.PtySpawnError({
              adapter: "controlled-fixture",
              cause: "Unclaimed fixture terminal root",
            });
          const child = yield* native.spawn({
            ...input,
            shell: "/bin/bash",
            args: ["--noprofile", "--norc"],
            env: {
              PATH: "/usr/bin:/bin",
              HOME: home,
              LANG: "C",
              TERM: "xterm-256color",
              PS1: "fixture> ",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
            },
          });
          owned.add(child);
          let pendingInput = "";
          const body = controlledTerminalInput.slice(0, -1);
          const acceptedInputs = [
            controlledTerminalInput,
            `${body}\n`,
            `\u001b[200~${body}\u001b[201~\r`,
            `\u001b[200~${body}\u001b[201~\n`,
          ];
          const write = (data: string) => {
            if (data === "\u0003" || data === "\u0004") {
              pendingInput = "";
              child.write(data);
              return;
            }
            if (data === "\u007f") {
              pendingInput = pendingInput.slice(0, -1);
              return;
            }
            const next = pendingInput + data;
            if (!acceptedInputs.some((input) => input.startsWith(next))) {
              pendingInput = "";
              throw new FixtureNativeDenied({ operation: "controlled.terminalInput" });
            }
            pendingInput = next;
            // Native shells receive only the complete authored constant, regardless of paste/typing chunks.
            if (acceptedInputs.includes(next)) {
              pendingInput = "";
              child.write(controlledTerminalInput);
            }
          };
          return new Proxy(child, {
            get(target, key, receiver) {
              if (key === "write") return write;
              const value = Reflect.get(target, key, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }),
      });
    }),
  ).pipe(Layer.provide(NodePtyAdapter.layer));
}
