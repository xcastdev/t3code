// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeOmpProviderSession } from "../server/session.ts";
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-omp-native-history-"));
const bun =
  process.env.T3_OMP_PROOF_BUN ?? "/home/user/.local/share/mise/installs/bun/1.4.4/bin/bun";
const native = await NodeFSP.realpath(
  NodeURL.fileURLToPath(new URL("../../node_modules/@oh-my-pi/pi-coding-agent", import.meta.url)),
);
try {
  for (const directory of ["home", "cwd", "target", "agent", "tmp"])
    await NodeFSP.mkdir(NodePath.join(root, directory));
  const env = {
    HOME: NodePath.join(root, "home"),
    PI_CODING_AGENT_DIR: NodePath.join(root, "agent"),
    TMPDIR: NodePath.join(root, "tmp"),
    PATH: NodePath.dirname(bun) + ":/usr/bin:/bin",
    LANG: "C.UTF-8",
  };
  const run = (mode: string, file?: string) =>
    JSON.parse(
      NodeChildProcess.execFileSync(
        bun,
        [
          "--no-env-file",
          "--preload",
          NodeURL.fileURLToPath(new URL("../server/runtimeLoader.ts", import.meta.url)),
          NodeURL.fileURLToPath(new URL("./nativeHistoryChild.ts", import.meta.url)),
          native,
          mode,
          root,
          ...(file ? [file] : []),
        ],
        { env, cwd: NodePath.join(root, "cwd"), encoding: "utf8" },
      ),
    );
  await NodeFSP.writeFile(
    NodePath.join(root, "agent", "models.yml"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-responses",
          auth: "none",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 128,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const fixture = run("prepare");
  const config = {
    cwd: NodePath.join(root, "cwd"),
    agentDir: NodePath.join(root, "agent"),
    sessionDir: NodePath.join(root, "sessions"),
    mode: "approval-required",
    environment: "history-proof",
    project: "history-proof",
  };
  const options = {
    binaryPath: NodePath.join(native, "dist/cli.js"),
    bunPath: bun,
    launchArgs: "",
    env,
    cacheDir: NodePath.join(root, "cache"),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const traced = ChildProcessSpawner.make((command) =>
        spawner.spawn(command).pipe(
          Effect.map((handle) => ({
            ...handle,
            stderr: handle.stderr.pipe(
              Stream.tap((bytes) =>
                Effect.sync(() => {
                  process.stderr.write(bytes);
                }),
              ),
            ),
          })),
        ),
      );
      return yield* Effect.gen(function* () {
        const parent = yield* makeOmpProviderSession({
          ...options,
          config: { ...config, sessionFile: fixture.file },
        });
        const state = yield* parent.request({ type: "get_state" });
        NodeAssert.match(stringify(state), /Retained native todo/);
        NodeAssert.equal((state as { sessionId: string }).sessionId, fixture.sessionId);
        yield* parent.request({ type: "set_session_name", name: "Owned fixture" });
        const before = yield* parent.request({ type: "get_entries" });
        const lease = yield* parent.request({
          type: "get_session_lease",
          sessionIds: [fixture.sessionId],
        });
        NodeAssert.deepEqual((lease as { held: string[] }).held, [fixture.sessionId]);
        const filesBefore = yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(root, "sessions")),
        );
        const invalid = yield* makeOmpProviderSession({
          ...options,
          config: {
            ...config,
            cwd: NodePath.join(root, "target"),
            forkSource: fixture.file,
            forkEntry: "missing-entry",
          },
        }).pipe(Effect.scoped, Effect.exit);
        NodeAssert.equal(invalid._tag, "Failure");
        NodeAssert.deepEqual(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(root, "sessions"))),
          filesBefore,
          "invalid branch must not materialize a fork",
        );
        const fork = yield* makeOmpProviderSession({
          ...options,
          config: {
            ...config,
            cwd: NodePath.join(root, "target"),
            forkSource: fixture.file,
            forkEntry: fixture.entry,
          },
        });
        const forkState = yield* fork.request({ type: "get_state" });
        NodeAssert.match(stringify(forkState), /Retained native todo/);
        const branch = yield* fork.request({ type: "get_entries" });
        NodeAssert.match(stringify(branch), /artifact:\/\/plot.txt/);
        NodeAssert.match(stringify(branch), /unknown|interrupted|fork/i);
        NodeAssert.match(stringify(branch), /"toolCallId":"b"/);
        NodeAssert.deepEqual(yield* parent.request({ type: "get_entries" }), before);
        NodeAssert.deepEqual(
          yield* parent.request({ type: "get_session_lease", sessionIds: [fixture.sessionId] }),
          lease,
        );
        yield* fork.terminate;
        const inspected = run("inspect", (forkState as { sessionFile: string }).sessionFile);
        NodeAssert.equal(inspected.cwd, NodePath.join(root, "target"));
        NodeAssert.equal(inspected.artifact, "retained artifact");
        yield* parent.terminate;
        const resumed = yield* makeOmpProviderSession({
          ...options,
          config: { ...config, sessionFile: fixture.file, forkEntry: fixture.entry },
        });
        const rolled = yield* resumed.request({ type: "get_entries" });
        NodeAssert.match(stringify(rolled), /t3_owned_branch/);
        yield* resumed.request({ type: "set_todos", phases: [] });
        NodeAssert.deepEqual(
          ((yield* resumed.request({ type: "get_state" })) as { todoPhases: unknown[] }).todoPhases,
          [],
        );
        yield* resumed.terminate;
        const cleared = yield* makeOmpProviderSession({
          ...options,
          config: { ...config, sessionFile: fixture.file },
        });
        NodeAssert.deepEqual(
          ((yield* cleared.request({ type: "get_state" })) as { todoPhases: unknown[] }).todoPhases,
          [],
        );
        yield* cleared.terminate;
        process.stdout.write(
          stringify({
            nativeHistory: "PASS",
            partialBatch: true,
            artifact: true,
            parentLeasePreserved: true,
            parentBranchUnchanged: true,
            destinationCwd: true,
            rollback: true,
            todoResumeForkClear: true,
            invalidBranchNoArtifacts: true,
            inference: 0,
          }) + "\n",
        );
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, traced));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
} finally {
  await NodeFSP.rm(root, { recursive: true, force: true });
}
