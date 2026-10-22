// @effect-diagnostics nodeBuiltinImport:off -- Only the prepared disposable fixture receives launch material.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  assertDisposablePath,
  assertPreparedUpgradeSnapshot,
  type UpgradeSnapshot,
} from "./prepareUpgradeSnapshot.ts";
import { upgradeValidationRuntime } from "./upgradeValidationRuntime.ts";
import { upgradeFixtureRoots } from "./upgradeFixtureRoots.ts";

export interface ControlledUpgradeApplication {
  readonly origin: string;
  /** Issued by the production auth service with fresh fixture-owned session storage. */
  readonly pairingUrl: string;
  readonly close: () => Promise<void>;
  readonly issuePairingUrl?: () => Promise<string>;
}

/** The production route builder is injected; this helper never substitutes a health-only server. */
export async function launchControlledUpgradeFixture(input: {
  readonly snapshot: UpgradeSnapshot;
  readonly staticDir?: string;
  readonly buildApplication?: (input: {
    readonly runtime: ReturnType<typeof upgradeValidationRuntime>;
    readonly roots: ReturnType<typeof upgradeFixtureRoots>;
    readonly baseDir: string;
    readonly host: "127.0.0.1";
    readonly port: 0;
  }) => Promise<ControlledUpgradeApplication>;
}) {
  const { snapshot } = input;
  assertPreparedUpgradeSnapshot(snapshot);
  const baseDir = assertDisposablePath(
    snapshot.fixtureRoot,
    NodePath.join(snapshot.fixtureRoot, "runtime"),
  );
  const manifestPath = assertDisposablePath(
    snapshot.fixtureRoot,
    NodePath.join(snapshot.fixtureRoot, "controlled-launch.json"),
  );
  if (NodeFS.existsSync(manifestPath)) throw new Error("Fixture already has a launch manifest");
  const buildApplication =
    input.buildApplication ??
    (async () => {
      const { buildControlledUpgradeApplication } = await import("./controlledUpgradeApp.ts");
      return await buildControlledUpgradeApplication(
        snapshot,
        input.staticDir === undefined ? {} : { staticDir: input.staticDir },
      );
    });
  const application = await buildApplication({
    runtime: upgradeValidationRuntime(snapshot, { mode: "controlled-fixture" }),
    roots: upgradeFixtureRoots(snapshot),
    baseDir,
    host: "127.0.0.1",
    port: 0,
  });
  try {
    assertPreparedUpgradeSnapshot(snapshot);
    const origin = new URL(application.origin);
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      !origin.port ||
      origin.port === "0" ||
      origin.origin !== application.origin
    )
      throw new Error("Fixture application must bind an ephemeral loopback origin");
    const pairing = new URL(application.pairingUrl);
    if (pairing.origin !== origin.origin || pairing.username || pairing.password)
      throw new Error("Fixture pairing must use the owned application origin");
    NodeFS.writeFileSync(
      manifestPath,
      JSON.stringify({
        origin: application.origin,
        baseDir,
        pairingUrl: application.pairingUrl,
        mode: "controlled-fixture",
      }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    await application.close();
    throw error;
  }
  const pairingManifests = new Set([manifestPath]);
  let closed = false;
  const issuePairingManifest = async (label: string) => {
    if (closed || !application.issuePairingUrl || !/^[a-z0-9-]{1,40}$/.test(label))
      throw new Error("Fresh fixture pairing is unavailable");
    assertPreparedUpgradeSnapshot(snapshot);
    const path = assertDisposablePath(
      snapshot.fixtureRoot,
      NodePath.join(snapshot.fixtureRoot, `controlled-pair-${label}.json`),
    );
    const pairingUrl = await application.issuePairingUrl();
    assertPreparedUpgradeSnapshot(snapshot);
    assertDisposablePath(snapshot.fixtureRoot, path);
    if (new URL(pairingUrl).origin !== application.origin)
      throw new Error("Fixture pairing origin mismatch");
    NodeFS.writeFileSync(
      path,
      JSON.stringify({ origin: application.origin, baseDir, pairingUrl }),
      { flag: "wx", mode: 0o600 },
    );
    pairingManifests.add(path);
    return path;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await application.close();
    } finally {
      assertPreparedUpgradeSnapshot(snapshot);
      for (const path of pairingManifests)
        NodeFS.rmSync(assertDisposablePath(snapshot.fixtureRoot, path), { force: true });
    }
  };
  return {
    origin: application.origin,
    manifestPath,
    issuePairingManifest,
    close,
    [Symbol.asyncDispose]: close,
  };
}
