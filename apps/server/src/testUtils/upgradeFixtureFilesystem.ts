// @effect-diagnostics nodeBuiltinImport:off -- Canonical path checks precede every test filesystem operation.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Predicate from "effect/Predicate";
import { upgradeFixtureRoots } from "./upgradeFixtureRoots.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import {
  assertDisposablePath,
  assertPreparedUpgradeSnapshot,
  type UpgradeSnapshot,
} from "./prepareUpgradeSnapshot.ts";

export function mapUpgradeFixturePath(
  snapshot: UpgradeSnapshot,
  value: string,
  mode: "preservation" | "controlled-fixture" = "preservation",
): string {
  assertPreparedUpgradeSnapshot(snapshot);
  if (!NodePath.isAbsolute(value)) throw new Error("Fixture filesystem paths must be absolute");
  // A copied workspace can be an ancestor of the disposable fixture. It must not redirect
  // already-owned paths; the registry still rejects unclaimed paths inside that fixture.
  if (
    mode === "controlled-fixture" &&
    (value === snapshot.fixtureRoot || value.startsWith(`${snapshot.fixtureRoot}${NodePath.sep}`))
  )
    return upgradeFixtureRoots(snapshot).mapOwnedPath(value);
  const source = [...snapshot.projects]
    .sort((a, b) => b.sourceRoot.length - a.sourceRoot.length)
    .find(
      (project) =>
        value === project.sourceRoot || value.startsWith(`${project.sourceRoot}${NodePath.sep}`),
    );
  const mapped = source
    ? NodePath.join(source.sandboxRoot, NodePath.relative(source.sourceRoot, value))
    : value;
  if (mode === "controlled-fixture") return upgradeFixtureRoots(snapshot).mapOwnedPath(mapped);
  const root = snapshot.projects.find(
    (project) =>
      mapped === project.sandboxRoot || mapped.startsWith(`${project.sandboxRoot}${NodePath.sep}`),
  )?.sandboxRoot;
  if (!root) throw new Error("Filesystem action is outside disposable project clones");
  if (mapped === root) return assertDisposablePath(snapshot.fixtureRoot, root);
  return assertDisposablePath(root, mapped);
}

export const layerFixtureFilesystem = (
  snapshot: UpgradeSnapshot,
  mode: "preservation" | "controlled-fixture" = "preservation",
  options: { readonly ownedStateRoots?: ReadonlyArray<string> } = {},
) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The complete platform interface stays behind one default-deny path mapper. New methods
      // cannot silently inherit unrestricted Node filesystem access from the test composition.
      const singlePath = new Set([
        "access",
        "chmod",
        "chown",
        "exists",
        "lstat",
        "makeDirectory",
        "open",
        "readDirectory",
        "readFile",
        "readFileString",
        "readLink",
        "realPath",
        "remove",
        "stat",
        "truncate",
        "utimes",
        "writeFile",
        "writeFileString",
        "watch",
        "stream",
        "sink",
      ]);
      const twoPaths = new Set(["copy", "copyFile", "link", "rename", "symlink"]);
      return new Proxy(fs, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          if (typeof key !== "string" || !Predicate.isFunction(value)) return value;
          return (...args: unknown[]) => {
            const invoke = () => {
              if (key === "makeTempDirectory" || key === "makeTempDirectoryScoped") {
                const options = args[0];
                if (
                  mode !== "controlled-fixture" ||
                  typeof options !== "object" ||
                  options === null ||
                  !("directory" in options) ||
                  !("prefix" in options) ||
                  typeof options.directory !== "string" ||
                  (options.prefix !== "t3-index-" && options.prefix !== "t3-commit-")
                )
                  throw new Error(
                    "Fixture temporary directories require an explicit owned Git root and prefix",
                  );
                const directory = mapUpgradeFixturePath(snapshot, options.directory, mode);
                if (NodePath.basename(directory) !== ".git")
                  throw new Error("Fixture temporary directories belong under owned Git metadata");
                const acquire = fs.makeTempDirectory({ directory, prefix: options.prefix });
                return key === "makeTempDirectory"
                  ? acquire
                  : Effect.acquireRelease(acquire, (path) =>
                      Effect.suspend(() =>
                        fs.remove(mapUpgradeFixturePath(snapshot, path, mode), { recursive: true }),
                      ).pipe(Effect.ignore),
                    );
              }
              const indexes = twoPaths.has(key) ? [0, 1] : singlePath.has(key) ? [0] : undefined;
              if (!indexes) throw new Error("Unsupported fixture filesystem operation");
              const mapped = [...args];
              for (const index of indexes) {
                const input = args[index];
                if (typeof input !== "string")
                  throw new Error("Unsupported fixture filesystem path");
                const stateRoot =
                  mode === "controlled-fixture"
                    ? options.ownedStateRoots?.find(
                        (root) => input === root || input.startsWith(`${root}${NodePath.sep}`),
                      )
                    : undefined;
                if (stateRoot === undefined) {
                  try {
                    mapped[index] = mapUpgradeFixturePath(snapshot, input, mode);
                  } catch {
                    const relative = NodePath.relative(snapshot.fixtureRoot, input);
                    const target =
                      relative.startsWith("..") || NodePath.isAbsolute(relative)
                        ? "outside fixture"
                        : relative;
                    throw new Error(`Fixture filesystem denies ${key} at ${target}`);
                  }
                } else {
                  assertPreparedUpgradeSnapshot(snapshot);
                  if (assertDisposablePath(snapshot.fixtureRoot, stateRoot) !== stateRoot)
                    throw new Error("Fixture state root cannot be a symlink");
                  const checked = assertDisposablePath(snapshot.fixtureRoot, input);
                  if (checked !== stateRoot && !checked.startsWith(`${stateRoot}${NodePath.sep}`))
                    throw new Error("Fixture state path escapes its owned root");
                  mapped[index] = checked;
                }
              }
              return Reflect.apply(value, target, mapped);
            };
            if (["watch", "stream"].includes(key))
              return Stream.unwrap(
                Effect.sync(() => {
                  const stream: unknown = invoke();
                  if (!Stream.isStream(stream)) throw new Error("Unsupported filesystem stream");
                  return stream;
                }),
              );
            if (key === "sink") throw new Error("Fixture filesystem sinks are not installed");
            return Effect.suspend(() => {
              const effect: unknown = invoke();
              if (!Effect.isEffect(effect)) throw new Error("Unsupported filesystem effect");
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Proxy preserves each FileSystem method's typed platform errors and Scope requirements.
              return effect;
            });
          };
        },
      });
    }),
  );

export function layerFixtureWorkspace(
  snapshot: UpgradeSnapshot,
  mode: "preservation" | "controlled-fixture" = "preservation",
) {
  const mapPath = (path: string) => mapUpgradeFixturePath(snapshot, path, mode);
  const known = Layer.succeed(
    KnownWorkspaces.KnownWorkspaces,
    KnownWorkspaces.KnownWorkspaces.of({
      contains: (path) =>
        Effect.sync(() => {
          try {
            mapPath(path);
            return true;
          } catch {
            return false;
          }
        }),
      assertContains: (path) =>
        Effect.try({
          try: () => {
            mapPath(path);
          },
          catch: () => new KnownWorkspaces.UnknownWorkspaceError({ cwd: path }),
        }),
    }),
  );
  const implementation = WorkspaceFileSystem.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkspacePaths.layer,
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        known,
      ),
    ),
  );
  return Layer.effect(
    WorkspaceFileSystem.WorkspaceFileSystem,
    Effect.gen(function* () {
      const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      return WorkspaceFileSystem.WorkspaceFileSystem.of({
        getMetadata: (input) =>
          files.getMetadata({
            ...input,
            paths: input.paths.map((path) => mapPath(path)),
          }),
        readFile: (input) =>
          Effect.suspend(() =>
            files.readFile({
              ...input,
              cwd: mapPath(input.cwd),
              relativePath: NodePath.relative(
                mapPath(input.cwd),
                mapPath(
                  NodePath.isAbsolute(input.relativePath)
                    ? input.relativePath
                    : NodePath.resolve(mapPath(input.cwd), input.relativePath),
                ),
              ),
            }),
          ),
        writeFile: (input) =>
          Effect.suspend(() =>
            files.writeFile({
              ...input,
              cwd: mapPath(input.cwd),
              relativePath: NodePath.relative(
                mapPath(input.cwd),
                mapPath(NodePath.resolve(mapPath(input.cwd), input.relativePath)),
              ),
            }),
          ),
      });
    }),
  ).pipe(Layer.provide(implementation));
}
