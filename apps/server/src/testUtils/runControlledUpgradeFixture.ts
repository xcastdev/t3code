// @effect-diagnostics nodeBuiltinImport:off -- Opt-in entrypoint copies a readonly source into a private disposable root.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { prepareUpgradeSnapshot, assertDisposablePath } from "./prepareUpgradeSnapshot.ts";
import { launchControlledUpgradeFixture } from "./controlledUpgradeFixture.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    "source-db": { type: "string" },
    "disposable-root": { type: "string" },
    "client-assets": { type: "string" },
    "active-db": { type: "string", multiple: true },
  },
});
const sourceDb = values["source-db"];
const disposableRoot = values["disposable-root"];
if (
  !sourceDb ||
  !disposableRoot ||
  !NodePath.isAbsolute(sourceDb) ||
  !NodePath.isAbsolute(disposableRoot)
)
  throw new Error(
    "Pass the resolved configured --source-db and an absolute empty --disposable-root",
  );
const snapshot = await prepareUpgradeSnapshot({
  configured: { dbPath: sourceDb },
  disposableRoot,
  activeDatabasePaths: [sourceDb, ...(values["active-db"] ?? [])],
});
let staticDir: string | undefined;
if (values["client-assets"]) {
  const assets = NodeFS.realpathSync(values["client-assets"]);
  if (!NodeFS.statSync(NodePath.join(assets, "index.html")).isFile())
    throw new Error("Client assets must contain a built index.html");
  if (snapshot.projects.length === 0)
    throw new Error("Real-client fixtures require a source project");
  staticDir = assertDisposablePath(
    snapshot.fixtureRoot,
    NodePath.join(snapshot.fixtureRoot, "client-assets"),
  );
  NodeFS.cpSync(assets, staticDir, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
}
const launch = await launchControlledUpgradeFixture({
  snapshot,
  ...(staticDir ? { staticDir } : {}),
});
try {
  const androidManifest = await launch.issuePairingManifest("android");
  const secondClientManifest = await launch.issuePairingManifest("second-client");
  // Paths are safe to report. Pairing URLs and session material stay inside mode-0600 manifests.
  process.stdout.write(
    `${JSON.stringify({ origin: launch.origin, manifestPath: launch.manifestPath, androidManifest, secondClientManifest, fixtureRoot: snapshot.fixtureRoot })}\n`,
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await launch.close();
}
