// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { makeManagedTextResourceRepository } from "./ManagedTextResourceRepository.ts";

const withRepository = async (
  run: (input: { stateDir: string; projectRoot: string }) => Promise<void>,
) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-managed-text-test-"));
  const stateDir = NodePath.join(root, "state");
  const projectRoot = NodePath.join(root, "project");
  await NodeFSP.mkdir(projectRoot);
  try {
    await run({ stateDir, projectRoot });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

describe("ManagedTextResourceRepository", () => {
  it("persists environment content and rejects stale updates and reads", async () => {
    await withRepository(async ({ stateDir }) => {
      const repository = makeManagedTextResourceRepository(stateDir);
      const expectedCatalogRevision = await repository.getCatalogRevision();
      const created = await repository.createEnvironment({
        kind: "command",
        key: "review",
        name: "Review",
        body: "Review $ARGUMENTS",
        expectedCatalogRevision,
      });
      assert.equal((await repository.listEnvironment())[0]?.id, created.id);
      assert.equal(
        (await repository.getContent({ id: created.id, revision: created.revision })).body,
        "Review $ARGUMENTS",
      );

      const updated = await repository.updateEnvironment({
        id: created.id,
        expectedRevision: created.revision,
        name: "Review",
        body: "Review this",
      });
      await expect(
        repository.getContent({ id: created.id, revision: created.revision }),
      ).rejects.toThrow(/revision_conflict/);
      await expect(
        repository.updateEnvironment({
          id: created.id,
          expectedRevision: created.revision,
          name: "Stale",
          body: "stale",
        }),
      ).rejects.toThrow(/revision_conflict/);
      assert.equal(
        (await repository.getContent({ id: created.id, revision: updated.revision })).body,
        "Review this",
      );
      const audit = await NodeFSP.readFile(
        NodePath.join(stateDir, "managed-text-resources", "audit.jsonl"),
        "utf8",
      );
      assert.isTrue(audit.includes('"action":"update","scope":"environment"'));
      assert.isFalse(audit.includes("Review this"));
    });
  });

  it("disables and restores environment definitions without losing their body", async () => {
    await withRepository(async ({ stateDir }) => {
      const repository = makeManagedTextResourceRepository(stateDir);
      const created = await repository.createEnvironment({
        kind: "command",
        key: "review",
        body: "Review $ARGUMENTS",
      });
      const definitionPath = NodePath.join(
        stateDir,
        "managed-text-resources",
        "commands",
        "review.json",
      );
      assert.isFalse((await NodeFSP.readFile(definitionPath, "utf8")).includes('"state"'));

      const disabled = await repository.setEnvironmentEnabled({
        kind: "command",
        id: created.id,
        expectedRevision: created.revision,
        enabled: false,
      });
      assert.equal(disabled.state, "disabled");
      assert.isTrue(
        (await NodeFSP.readFile(definitionPath, "utf8")).includes('"state":"disabled"'),
      );
      assert.equal(disabled.id, created.id);
      assert.equal(disabled.body, created.body);
      assert.notEqual(disabled.revision, created.revision);
      assert.equal(
        (
          await repository.getContent({
            kind: "command",
            id: created.id,
            revision: disabled.revision,
          })
        ).body,
        created.body,
      );

      await expect(
        repository.setEnvironmentEnabled({
          kind: "command",
          id: created.id,
          expectedRevision: created.revision,
          enabled: true,
        }),
      ).rejects.toThrow(/revision_conflict/);

      const restored = await repository.setEnvironmentEnabled({
        kind: "command",
        id: created.id,
        expectedRevision: disabled.revision,
        enabled: true,
      });
      assert.equal(restored.state, "active");
      assert.equal(restored.id, created.id);
      assert.equal(restored.body, created.body);
      assert.notEqual(restored.revision, disabled.revision);
      assert.notEqual(restored.revision, created.revision);
      assert.isTrue((await NodeFSP.readFile(definitionPath, "utf8")).includes('"state":"active"'));
      await expect(
        repository.setEnvironmentEnabled({
          kind: "command",
          id: created.id,
          expectedRevision: created.revision,
          enabled: false,
        }),
      ).rejects.toThrow(/revision_conflict/);

      const audit = await NodeFSP.readFile(
        NodePath.join(stateDir, "managed-text-resources", "audit.jsonl"),
        "utf8",
      );
      assert.isTrue(audit.includes('"action":"set-disabled","scope":"environment"'));
      assert.isTrue(audit.includes('"action":"set-enabled","scope":"environment"'));
      assert.isFalse(audit.includes(created.body));
    });
  });

  it("stores project override and disable entries without writing provider files", async () => {
    await withRepository(async ({ stateDir, projectRoot }) => {
      const repository = makeManagedTextResourceRepository(stateDir);
      const firstCatalogRevision = await repository.getCatalogRevision({ projectRoot });
      const override = await repository.setProjectOverride({
        projectRoot,
        kind: "snippet",
        key: "reply",
        name: "Reply",
        body: "Thanks for the report.",
        expectedCatalogRevision: firstCatalogRevision,
      });
      assert.equal((await repository.listProject(projectRoot))[0]?.id, override.id);
      const secondCatalogRevision = await repository.getCatalogRevision({ projectRoot });
      const disabled = await repository.setProjectDisabled({
        projectRoot,
        kind: "snippet",
        key: "reply",
        expectedCatalogRevision: secondCatalogRevision,
      });
      assert.equal(disabled.state, "disabled");
      assert.isFalse((await repository.listProject(projectRoot))[0]?.body !== undefined);
      const thirdCatalogRevision = await repository.getCatalogRevision({ projectRoot });
      await repository.deleteProjectState({
        projectRoot,
        kind: "snippet",
        key: "reply",
        expectedCatalogRevision: thirdCatalogRevision,
      });
      assert.lengthOf(await repository.listProject(projectRoot), 0);
      await expect(NodeFSP.access(NodePath.join(projectRoot, ".codex"))).rejects.toThrow();
    });
  });

  it("reports a malformed project entry with its recoverable key", async () => {
    await withRepository(async ({ stateDir, projectRoot }) => {
      const repository = makeManagedTextResourceRepository(stateDir);
      const folder = NodePath.join(projectRoot, ".t3code", "snippets");
      await NodeFSP.mkdir(folder, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(folder, "reply.json"), "{not json");
      const entries = await repository.listProject(projectRoot);
      assert.equal(entries[0]?.key, "reply");
      assert.equal(entries[0]?.state, "invalid");
    });
  });

  it("bumps the catalog revision for external edits and rejects a stale project mutation", async () => {
    await withRepository(async ({ stateDir, projectRoot }) => {
      const repository = makeManagedTextResourceRepository(stateDir);
      const listedRevision = await repository.getCatalogRevision({ projectRoot });
      const folder = NodePath.join(projectRoot, ".t3code", "commands");
      await NodeFSP.mkdir(folder, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(folder, "deploy.json"),
        JSON.stringify({ kind: "command", key: "deploy", id: "external-entry", body: "ship it" }),
      );

      await expect(
        repository.setProjectDisabled({
          projectRoot,
          kind: "command",
          key: "deploy",
          expectedCatalogRevision: listedRevision,
        }),
      ).rejects.toThrow(/revision_conflict/);
      assert.equal((await repository.listProject(projectRoot))[0]?.key, "deploy");
    });
  });

  it("persists thread enablement and rejects a stale catalog revision", async () => {
    await withRepository(async ({ stateDir, projectRoot }) => {
      const repository = makeManagedTextResourceRepository(stateDir);
      const threadId = "thread-123";
      const expectedCatalogRevision = await repository.getCatalogRevision({
        projectRoot,
        threadId,
      });
      const enabled = await repository.setThreadEnabled({
        threadId,
        projectRoot,
        kind: "command",
        key: "review",
        enabled: true,
        expectedCatalogRevision,
      });
      assert.isTrue(enabled.enabled);
      assert.equal((await repository.listThread(threadId))[0]?.revision, enabled.revision);

      await expect(
        repository.resetThread({
          threadId,
          projectRoot,
          kind: "command",
          key: "review",
          expectedCatalogRevision,
        }),
      ).rejects.toThrow(/revision_conflict/);

      const restarted = makeManagedTextResourceRepository(stateDir);
      assert.isTrue((await restarted.listThread(threadId))[0]?.enabled);
    });
  });
});
