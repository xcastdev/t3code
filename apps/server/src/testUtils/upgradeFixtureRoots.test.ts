// @effect-diagnostics nodeBuiltinImport:off -- Tests own these temporary directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { createUpgradeFixtureRoots } from "./upgradeFixtureRoots.ts";

it("requires an explicit assistant claim and rejects project identity/root theft", () => {
  const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fixture-roots-"));
  try {
    const clone = NodePath.join(fixtureRoot, "clone");
    NodeFS.mkdirSync(clone);
    const roots = createUpgradeFixtureRoots({
      fixtureRoot,
      projects: [{ projectId: "original", sandboxRoot: clone }],
    });
    const assistantId = `assistant-${"a".repeat(64)}`;
    const root = NodePath.join(roots.assistantBase, assistantId);
    expect(() => roots.registerAssistantProject(assistantId, "new", root)).toThrow();
    expect(() => roots.mapOwnedPath(root)).toThrow();
    expect(() => roots.claimAssistant("../outside")).toThrow();
    expect(roots.claimAssistant(assistantId)).toBe(root);
    expect(roots.mapOwnedPath(`${root}.claim`)).toBe(`${root}.claim`);
    expect(roots.mapOwnedPath(NodePath.join(root, "README.md"))).toBe(
      NodePath.join(root, "README.md"),
    );
    expect(() => roots.registerAssistantProject(assistantId, "original", root)).toThrow();
    roots.registerAssistantProject(assistantId, "new", root);
    expect(roots.rootFor("new")).toBe(root);
    expect(() => roots.registerAssistantProject(assistantId, "another", root)).toThrow();
    expect(() => roots.mapOwnedPath(NodePath.resolve(root, "..", "foreign"))).toThrow();
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it("rechecks symlink replacement for assistant claims and existing project roots", () => {
  const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fixture-symlink-"));
  const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fixture-outside-"));
  try {
    const clone = NodePath.join(fixtureRoot, "clone");
    NodeFS.mkdirSync(clone);
    const roots = createUpgradeFixtureRoots({
      fixtureRoot,
      projects: [{ projectId: "original", sandboxRoot: clone }],
    });
    const assistantId = `assistant-${"b".repeat(64)}`;
    const assistantRoot = roots.claimAssistant(assistantId);
    NodeFS.mkdirSync(roots.assistantBase, { recursive: true });
    NodeFS.symlinkSync(outside, assistantRoot);
    expect(() => roots.mapOwnedPath(NodePath.join(assistantRoot, "secret"))).toThrow();
    expect(() => roots.registerAssistantProject(assistantId, "new", assistantRoot)).toThrow();
    NodeFS.rmSync(clone, { recursive: true });
    NodeFS.symlinkSync(outside, clone);
    expect(() => roots.rootFor("original")).toThrow();
    NodeFS.rmSync(roots.assistantBase, { recursive: true });
    NodeFS.symlinkSync(outside, roots.assistantBase);
    expect(() => roots.claimAssistant(`assistant-${"c".repeat(64)}`)).toThrow();
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
    NodeFS.rmSync(outside, { recursive: true, force: true });
  }
});
