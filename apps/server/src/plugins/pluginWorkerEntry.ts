// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - `t3 plugin-worker` fast path runs before any Effect runtime loads.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

/**
 * Loads a packed plugin backend, which then serves the worker protocol on stdin/stdout.
 * `createRequire` rather than `import()`, because the Node SEA cannot resolve file URLs.
 */
export function run(args: ReadonlyArray<string>): void {
  const entryPath = args[0];
  if (
    args.length !== 1 ||
    entryPath === undefined ||
    !NodePath.isAbsolute(entryPath) ||
    !entryPath.endsWith(".cjs")
  ) {
    console.error("Usage: t3 plugin-worker <absolute path to a .cjs backend entry>");
    process.exitCode = 2;
    return;
  }
  NodeModule.createRequire(import.meta.url)(entryPath);
}
