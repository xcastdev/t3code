// @effect-diagnostics nodeBuiltinImport:off -- All terminal paths are under the disposable fixture.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePlatformPath from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TerminalManager from "../terminal/Manager.ts";
import { makeSqlPersistence } from "../terminal/ProjectTerminalStore.ts";
import { type UpgradeSnapshot } from "./prepareUpgradeSnapshot.ts";
import { layerFixtureFilesystem } from "./upgradeFixtureFilesystem.ts";
import { layerControlledProcessRunner, layerControlledPty } from "./upgradeControlledNative.ts";

/** Actual terminal state/streams with only the authored PTY command admitted at the adapter. */
export function layerControlledTerminal(snapshot: UpgradeSnapshot) {
  const logsDir = NodePath.join(snapshot.fixtureRoot, "terminal-logs");
  const home = NodePath.join(snapshot.fixtureRoot, "sterile-home");
  const env = { PATH: "/usr/bin:/bin", HOME: home, TERM: "dumb", LANG: "C" };
  const guardedFilesystem = layerFixtureFilesystem(snapshot, "controlled-fixture", {
    ownedStateRoots: [logsDir, home],
  }).pipe(Layer.provide(NodeServices.layer));
  const filesystem = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return new Proxy(fs, {
        get(target, key, receiver) {
          // The supplied empty process table never uses Manager's fallback ps probe.
          if (key === "exists")
            return (path: string) =>
              path === "/bin/ps" || path === "/usr/bin/ps"
                ? Effect.succeed(false)
                : fs.exists(path);
          return Reflect.get(target, key, receiver);
        },
      });
    }),
  ).pipe(Layer.provide(guardedFilesystem));
  const native = layerControlledProcessRunner(snapshot).pipe(Layer.provide(NodeServices.layer));
  const platform = Layer.mergeAll(
    filesystem,
    NodePlatformPath.layer,
    Layer.succeed(HostProcess.HomeDirectory, home),
    Layer.succeed(HostProcess.Environment, env),
  );
  const dependencies = Layer.mergeAll(
    native,
    layerControlledPty(snapshot).pipe(Layer.provide(platform)),
  ).pipe(Layer.provideMerge(platform));
  return Layer.effect(
    TerminalManager.TerminalManager,
    Effect.gen(function* () {
      const ptyAdapter = yield* PtyAdapter.PtyAdapter;
      const projectPersistence = yield* makeSqlPersistence();
      return yield* TerminalManager.makeWithOptions({
        logsDir,
        ptyAdapter,
        projectPersistence,
        env,
        shellResolver: () => "/bin/bash",
        processTable: Effect.succeed([]),
      });
    }),
  ).pipe(Layer.provide(dependencies));
}
