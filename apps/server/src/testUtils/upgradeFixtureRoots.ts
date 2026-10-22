// @effect-diagnostics nodeBuiltinImport:off -- This test-only registry admits only canonical disposable roots.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  assertDisposablePath,
  assertPreparedUpgradeSnapshot,
  type UpgradeSnapshot,
} from "./prepareUpgradeSnapshot.ts";

/** Claims live in memory so a copied database cannot grant itself native filesystem access. */
export function createUpgradeFixtureRoots(input: {
  readonly fixtureRoot: string;
  readonly projects: ReadonlyArray<{
    readonly projectId: string;
    readonly sandboxRoot: string;
  }>;
}) {
  const fixtureRoot = NodeFS.realpathSync(input.fixtureRoot);
  const projects = new Map(
    input.projects.map((project) => [
      project.projectId,
      assertDisposablePath(fixtureRoot, project.sandboxRoot),
    ]),
  );
  const assistantBase = assertDisposablePath(
    fixtureRoot,
    NodePath.join(fixtureRoot, "runtime", "assistants"),
  );
  const claims = new Map<string, string>();
  const assertAssistantBase = () => {
    const checked = assertDisposablePath(fixtureRoot, assistantBase);
    if (checked !== assistantBase) throw new Error("Assistant base was replaced by a symlink");
    return checked;
  };
  const rootFor = (projectId: string) => {
    const root = projects.get(projectId);
    if (!root) throw new Error("Project has no registered fixture root");
    const checked = assertDisposablePath(fixtureRoot, root);
    if (checked !== root) throw new Error("Fixture project root was replaced by a symlink");
    return checked;
  };
  return {
    assistantBase,
    rootFor,
    /** The launcher calls this before provisioning, never from copied project metadata. */
    claimAssistant: (assistantId: string) => {
      if (!/^assistant-[a-f0-9]{64}$/.test(assistantId))
        throw new Error("Invalid fixture assistant identity");
      const base = assertAssistantBase();
      NodeFS.mkdirSync(base, { recursive: true, mode: 0o700 });
      const root = NodePath.join(base, assistantId);
      if (assertDisposablePath(base, root) !== root)
        throw new Error("Assistant root was replaced by a symlink");
      claims.set(assistantId, root);
      return root;
    },
    registerAssistantProject: (assistantId: string, projectId: string, workspaceRoot: string) => {
      assertAssistantBase();
      const root = claims.get(assistantId);
      if (!root || workspaceRoot !== root || assertDisposablePath(assistantBase, root) !== root)
        throw new Error("Assistant project has no fixture claim");
      if (!projectId || (projects.has(projectId) && projects.get(projectId) !== root))
        throw new Error("Fixture project identity is already owned");
      if ([...projects].some(([id, existing]) => id !== projectId && existing === root))
        throw new Error("Fixture root is already owned by another project");
      projects.set(projectId, root);
    },
    mapOwnedPath: (value: string) => {
      if (!NodePath.isAbsolute(value)) throw new Error("Expected an absolute fixture path");
      const root = [...projects.keys()]
        .map(rootFor)
        .find(
          (candidate) => value === candidate || value.startsWith(`${candidate}${NodePath.sep}`),
        );
      if (root) return value === root ? root : assertDisposablePath(root, value);
      assertAssistantBase();
      if (value === assistantBase) return assistantBase;
      for (const [assistantId, claimed] of claims) {
        if (value === NodePath.join(assistantBase, `${assistantId}.claim`)) {
          const checked = assertDisposablePath(assistantBase, value);
          if (checked !== value) throw new Error("Assistant claim cannot be a symlink");
          return checked;
        }
        if (value === claimed || value.startsWith(`${claimed}${NodePath.sep}`)) {
          if (assertDisposablePath(assistantBase, claimed) !== claimed)
            throw new Error("Assistant root was replaced by a symlink");
          const checked = assertDisposablePath(assistantBase, value);
          if (checked !== claimed && !checked.startsWith(`${claimed}${NodePath.sep}`))
            throw new Error("Assistant path escapes its claim");
          return checked;
        }
      }
      throw new Error("Filesystem action has no fixture root claim");
    },
  };
}

export type UpgradeFixtureRoots = ReturnType<typeof createUpgradeFixtureRoots>;

const snapshotRoots = new WeakMap<UpgradeSnapshot, UpgradeFixtureRoots>();

export function upgradeFixtureRoots(snapshot: UpgradeSnapshot): UpgradeFixtureRoots {
  assertPreparedUpgradeSnapshot(snapshot);
  let roots = snapshotRoots.get(snapshot);
  if (!roots) {
    roots = createUpgradeFixtureRoots(snapshot);
    snapshotRoots.set(snapshot, roots);
  }
  return roots;
}
