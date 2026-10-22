// @effect-diagnostics nodeBuiltinImport:off -- Explicit test-only native commands use sterile environment and captured children.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { isTrustedUpgradeFixtureCommand } from "./upgradeFixtureCommands.ts";
import { upgradeFixtureRoots } from "./upgradeFixtureRoots.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  assertDisposablePath,
  assertPreparedUpgradeSnapshot,
  type UpgradeSnapshot,
} from "./prepareUpgradeSnapshot.ts";

export class FixtureNativeDenied extends Schema.TaggedError<FixtureNativeDenied>()(
  "FixtureNativeDenied",
  { operation: Schema.String },
) {}

export class UpgradeFixtureNative extends Context.Service<
  UpgradeFixtureNative,
  {
    readonly mode: "preservation" | "controlled-fixture";
    readonly attempts: Effect.Effect<ReadonlyArray<string>>;
    readonly run: (input: {
      readonly projectId: string;
      readonly command: "initialize-git" | "git-status" | "node-version";
    }) => Effect.Effect<string, FixtureNativeDenied>;
    readonly terminal: (projectId: string) => Effect.Effect<string, FixtureNativeDenied>;
    readonly endpoint: Effect.Effect<
      { readonly origin: string; readonly token: string },
      FixtureNativeDenied
    >;
  }
>()("t3/testUtils/upgradeFixtureNative") {}

export function layerFixtureNative(
  snapshot: UpgradeSnapshot,
  mode: "preservation" | "controlled-fixture",
) {
  return Layer.effect(
    UpgradeFixtureNative,
    Effect.gen(function* () {
      assertPreparedUpgradeSnapshot(snapshot);
      const attempts: string[] = [];
      const capturedPids: number[] = [];
      const terminals = new Set<{ readonly kill: () => void }>();
      const servers = new Set<NodeHttp.Server>();
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          for (const terminal of terminals) terminal.kill();
          await Promise.all(
            [...servers].map(
              (server) => new Promise<void>((resolve) => server.close(() => resolve())),
            ),
          );
        }),
      );
      const home = NodePath.join(snapshot.fixtureRoot, "sterile-home");
      NodeFS.mkdirSync(assertDisposablePath(snapshot.fixtureRoot, home), {
        recursive: true,
        mode: 0o700,
      });
      const env = {
        PATH: "/usr/bin:/bin",
        HOME: home,
        TERM: "dumb",
        LANG: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      };
      const rootFor = (projectId: string) => {
        assertPreparedUpgradeSnapshot(snapshot);
        return upgradeFixtureRoots(snapshot).rootFor(projectId);
      };
      const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"] = (command) =>
        Effect.suspend(() => {
          if (
            mode !== "controlled-fixture" ||
            command._tag !== "StandardCommand" ||
            command.options.shell ||
            !isTrustedUpgradeFixtureCommand(command.command, command.args) ||
            typeof command.options.cwd !== "string" ||
            !snapshot.projects.some((project) => rootFor(project.projectId) === command.options.cwd)
          )
            return Effect.die(new FixtureNativeDenied({ operation: "process.spawn" }));
          // ProcessRunner owns scoped cancellation and drain. Override extendEnv at its spawn
          // boundary so ambient provider credentials, Git overrides and shell startup variables never enter.
          return nativeSpawner
            .spawn(
              ChildProcess.make(command.command, command.args, {
                ...command.options,
                env,
                extendEnv: false,
              }),
            )
            .pipe(
              Effect.tap((child) =>
                Effect.sync(() => {
                  capturedPids.push(child.pid);
                }),
              ),
            );
        });
      const safeSpawner = new Proxy(nativeSpawner, {
        get(target, key, receiver) {
          return key === "spawn" ? spawn : Reflect.get(target, key, receiver);
        },
      });
      const runner = yield* ProcessRunner.make().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, safeSpawner),
      );
      const exec = Effect.fn("UpgradeFixtureNative.exec")(function* (
        cwd: string,
        command: string,
        args: ReadonlyArray<string>,
      ) {
        const output = yield* runner.run({ command, args, cwd, env, maxOutputBytes: 65536 });
        if (output.code !== 0) return yield* new FixtureNativeDenied({ operation: "process.exit" });
        return output.stdout;
      });
      const gitConfig = new Map<string, string>();
      const validateGitMetadata = (cwd: string, initializing = false) => {
        const gitDirectory = NodePath.join(cwd, ".git");
        if (!NodeFS.existsSync(gitDirectory)) {
          if (initializing) return;
          throw new Error("Git repository is not fixture owned");
        }
        if (!NodeFS.lstatSync(gitDirectory).isDirectory())
          throw new Error("Fixture Git metadata must be a directory");
        const visit = (directory: string) => {
          for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
            const path = NodePath.join(directory, entry.name);
            assertDisposablePath(cwd, path);
            if (
              entry.isSymbolicLink() ||
              ["commondir", "gitdir", "alternates", "worktrees"].includes(entry.name)
            )
              throw new Error("Foreign Git metadata is forbidden");
            if (entry.isDirectory()) visit(path);
          }
        };
        visit(gitDirectory);
        const config = NodePath.join(gitDirectory, "config");
        if (gitConfig.has(cwd)) {
          if (
            !NodeFS.existsSync(config) ||
            NodeFS.readFileSync(config, "utf8") !== gitConfig.get(cwd)
          )
            throw new Error("Fixture Git configuration changed");
        } else if (
          !initializing ||
          NodeFS.existsSync(config) ||
          NodeFS.readdirSync(gitDirectory).some((name) => name !== "hooks")
        )
          throw new Error("Git metadata was not created by this fixture");
      };
      const rememberGitConfig = (cwd: string) => {
        gitConfig.set(cwd, NodeFS.readFileSync(NodePath.join(cwd, ".git", "config"), "utf8"));
      };
      const guardedEffect = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
        Effect.suspend((): Effect.Effect<A, E | FixtureNativeDenied> => {
          attempts.push(operation);
          assertPreparedUpgradeSnapshot(snapshot);
          if (mode !== "controlled-fixture")
            return Effect.fail(new FixtureNativeDenied({ operation }));
          return effect;
        }).pipe(Effect.catchCause(() => Effect.fail(new FixtureNativeDenied({ operation }))));
      const guarded = <A>(operation: string, run: () => Promise<A>) =>
        Effect.tryPromise({
          try: async () => {
            attempts.push(operation);
            if (mode !== "controlled-fixture") throw new Error("Native effects are disabled");
            assertPreparedUpgradeSnapshot(snapshot);
            return await run();
          },
          catch: () => new FixtureNativeDenied({ operation }),
        });
      return UpgradeFixtureNative.of({
        mode,
        attempts: Effect.sync(() => [...attempts]),
        run: (input) =>
          guardedEffect(
            input.command,
            Effect.gen(function* () {
              const cwd = rootFor(input.projectId);
              const git = Effect.fn("UpgradeFixtureNative.git")(function* (
                args: ReadonlyArray<string>,
                initializing = false,
              ) {
                validateGitMetadata(cwd, initializing);
                const output = yield* exec(cwd, "/usr/bin/git", [
                  "-c",
                  "core.hooksPath=/dev/null",
                  "-c",
                  "core.fsmonitor=false",
                  ...args,
                ]);
                rememberGitConfig(cwd);
                return output;
              });
              switch (input.command) {
                case "node-version":
                  return yield* exec(cwd, process.execPath, ["--version"]);
                case "git-status":
                  return yield* git(["status", "--porcelain"]);
                case "initialize-git":
                  yield* git(["init"], true);
                  yield* git(["config", "user.name", "T3 Fixture"]);
                  yield* git(["config", "user.email", "fixture@localhost"]);
                  yield* git(["add", "--", "fixture.txt"]);
                  return yield* git(["commit", "--no-gpg-sign", "-m", "Fixture baseline"]);
              }
            }),
          ),
        terminal: (projectId) =>
          guarded("terminal", async () => {
            const cwd = rootFor(projectId);
            const pty = await import("node-pty");
            return await new Promise<string>((resolve, reject) => {
              const terminal = pty.spawn("/bin/bash", ["--noprofile", "--norc"], {
                cwd,
                env,
                name: "dumb",
                cols: 80,
                rows: 24,
              });
              terminals.add(terminal);
              let output = "";
              const data = terminal.onData((chunk) => {
                output = (output + chunk).slice(-65536);
              });
              terminal.onExit(({ exitCode }) => {
                data.dispose();
                terminals.delete(terminal);
                if (exitCode === 0) resolve(output);
                else reject(new Error("Fixture PTY failed"));
              });
              terminal.write("printf 'fixture-terminal\\n'; exit\n");
            });
          }),
        endpoint: guarded("loopback-endpoint", async () => {
          const token = NodeCrypto.randomBytes(32).toString("hex");
          const server = NodeHttp.createServer((request, response) => {
            if (request.headers.authorization !== `Bearer ${token}`) {
              response.writeHead(401).end();
              return;
            }
            if (request.url !== "/health" || request.method !== "GET") {
              response.writeHead(404).end();
              return;
            }
            response.writeHead(200, { "content-type": "application/json" }).end('{"fixture":true}');
          });
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          });
          servers.add(server);
          const address = server.address();
          if (address === null || typeof address === "string")
            throw new Error("Missing loopback address");
          return { origin: `http://127.0.0.1:${address.port}`, token };
        }),
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
}
