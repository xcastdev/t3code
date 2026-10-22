// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import { vi } from "vite-plus/test";
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

it("preserves an external edit made after staging instead of replacing it", async () => {
  await withRepository(async ({ stateDir }) => {
    const repository = makeManagedTextResourceRepository(stateDir);
    const created = await repository.createEnvironment({
      kind: "command",
      key: "review",
      body: "Original",
    });
    const path = NodePath.join(stateDir, "managed-text-resources", "commands", "review.json");
    await expect(
      repository.updateEnvironment({
        id: created.id,
        expectedRevision: created.revision,
        body: "Replacement",
        commitGuard: async (commit) => {
          await NodeFSP.writeFile(path, "user edit");
          commit();
        },
      }),
    ).rejects.toThrow(/revision_conflict/);
    expect(await NodeFSP.readFile(path, "utf8")).toBe("user edit");
    expect(
      (await NodeFSP.readdir(NodePath.dirname(path))).filter((name) => name.includes(".tmp-")),
    ).toEqual([]);
  });
});

it("keeps command and snippet identities separate through delete and recreate", async () => {
  await withRepository(async ({ stateDir }) => {
    const repository = makeManagedTextResourceRepository(stateDir);
    const command = await repository.createEnvironment({
      kind: "command",
      key: "review",
      body: "Command",
    });
    const snippet = await repository.createEnvironment({
      kind: "snippet",
      key: "review",
      body: "Snippet",
    });
    await expect(
      repository.updateEnvironment({
        kind: "snippet",
        id: command.id,
        expectedRevision: command.revision,
        body: "Wrong kind",
      }),
    ).rejects.toThrow(/not_found/);
    await repository.deleteEnvironment({ id: command.id, expectedRevision: command.revision });
    const recreated = await repository.createEnvironment({
      kind: "command",
      key: "review",
      body: "Recreated",
    });
    expect(recreated.id).not.toBe(command.id);
    expect(
      (await repository.getContent({ kind: "snippet", id: snippet.id, revision: snippet.revision }))
        .body,
    ).toBe("Snippet");
    await expect(
      repository.getContent({ id: command.id, revision: command.revision }),
    ).rejects.toThrow(/not_found/);
  });
});

it.each(["override", "disable", "delete"] as const)(
  "rejects %s when an external edit follows the CAS fingerprint",
  async (operation) => {
    await withRepository(async ({ stateDir, projectRoot }) => {
      const repository = makeManagedTextResourceRepository(stateDir);
      await repository.setProjectOverride({
        projectRoot,
        kind: "command",
        key: "review",
        body: "Original",
      });
      const snapshot = await repository.readCatalog({ projectRoot });
      const target = NodePath.join(projectRoot, ".t3code", "commands", "review.json");
      const original = JSON.parse(await NodeFSP.readFile(target, "utf8"));
      const replacement = JSON.stringify({ ...original, body: "User edit after fingerprint" });
      const readFile = NodeFSP.readFile;
      let injected = false;
      using _bindings = { [Symbol.dispose]: () => NodeModule.syncBuiltinESMExports() };
      using _read = vi.spyOn(NodeFS.promises, "readFile").mockImplementation(async (...args) => {
        const value = await readFile(...args);
        if (
          !injected &&
          args[0] === NodePath.join(stateDir, "managed-text-resources", "catalog-state.json")
        ) {
          injected = true;
          await NodeFSP.writeFile(target, replacement);
        }
        return value;
      });
      NodeModule.syncBuiltinESMExports();
      const input = {
        projectRoot,
        kind: "command" as const,
        key: "review",
        expectedCatalogRevision: snapshot.catalogRevision,
      };
      const result =
        operation === "override"
          ? repository.setProjectOverride({ ...input, body: "Stale replacement" })
          : operation === "disable"
            ? repository.setProjectDisabled(input)
            : repository.deleteProjectState(input);
      await expect(result).rejects.toThrow(/revision_conflict/);
      expect(injected).toBe(true);
      expect(await NodeFSP.readFile(target, "utf8")).toBe(replacement);
    });
  },
);

it.each(["create", "update", "delete", "project-override"] as const)(
  "compensates %s when authority fails after publication",
  async (operation) => {
    await withRepository(async ({ stateDir, projectRoot }) => {
      const changes: unknown[] = [];
      const repository = makeManagedTextResourceRepository(stateDir, {
        onChange: (change) => changes.push(change),
      });
      const initial = await repository.createEnvironment({
        kind: "command",
        key: "review",
        body: "Original",
      });
      if (operation === "project-override")
        await repository.setProjectOverride({
          projectRoot,
          kind: "command",
          key: "review",
          body: "Project original",
        });
      const before = await repository.readCatalog({ projectRoot });
      const changeCount = changes.length;
      const auditPath = NodePath.join(stateDir, "managed-text-resources", "audit.jsonl");
      const audit = await NodeFSP.readFile(auditPath, "utf8");
      const commitGuard = async (commit: () => void) => {
        commit();
        throw new Error("SQL commit rejected");
      };
      const mutation =
        operation === "create"
          ? repository.createEnvironment({
              kind: "snippet",
              key: "new",
              body: "Created",
              commitGuard,
            })
          : operation === "update"
            ? repository.updateEnvironment({
                id: initial.id,
                expectedRevision: initial.revision,
                body: "Replacement",
                commitGuard,
              })
            : operation === "delete"
              ? repository.deleteEnvironment({
                  id: initial.id,
                  expectedRevision: initial.revision,
                  commitGuard,
                })
              : repository.setProjectOverride({
                  projectRoot,
                  kind: "command",
                  key: "review",
                  body: "Project replacement",
                  expectedCatalogRevision: before.catalogRevision,
                  commitGuard,
                });
      await expect(mutation).rejects.toThrow("SQL commit rejected");
      expect(await repository.readCatalog({ projectRoot })).toEqual(before);
      expect(changes.length).toBe(changeCount);
      expect(await NodeFSP.readFile(auditPath, "utf8")).toBe(audit);
    });
  },
);

it("preserves a newer external edit and retains original bytes when compensation conflicts", async () => {
  await withRepository(async ({ stateDir }) => {
    const repository = makeManagedTextResourceRepository(stateDir);
    const original = await repository.createEnvironment({
      kind: "command",
      key: "review",
      body: "Original",
    });
    const target = NodePath.join(stateDir, "managed-text-resources", "commands", "review.json");
    const originalBytes = await NodeFSP.readFile(target, "utf8");
    await expect(
      repository.updateEnvironment({
        id: original.id,
        expectedRevision: original.revision,
        body: "Replacement",
        commitGuard: async (commit) => {
          commit();
          await NodeFSP.writeFile(target, "New external edit");
          throw new Error("SQL commit rejected");
        },
      }),
    ).rejects.toThrow(/recovery|compensat/i);
    expect(await NodeFSP.readFile(target, "utf8")).toBe("New external edit");
    await expect(makeManagedTextResourceRepository(stateDir).readCatalog()).rejects.toThrow(
      /needs recovery/,
    );
    const recoveryFiles = (await NodeFSP.readdir(NodePath.dirname(target))).filter((name) =>
      name.includes(".recovery-"),
    );
    expect(recoveryFiles).toHaveLength(1);
    expect(
      await NodeFSP.readFile(NodePath.join(NodePath.dirname(target), recoveryFiles[0]!), "utf8"),
    ).toBe(originalBytes);
  });
});

it.each(["create", "update", "delete", "project-override"] as const)(
  "compensates %s when final catalog publication fails",
  async (operation) => {
    await withRepository(async ({ stateDir, projectRoot }) => {
      const changes: unknown[] = [];
      const repository = makeManagedTextResourceRepository(stateDir, {
        onChange: (change) => changes.push(change),
      });
      const original = await repository.createEnvironment({
        kind: "command",
        key: "review",
        body: "Original",
      });
      if (operation === "project-override")
        await repository.setProjectOverride({
          projectRoot,
          kind: "command",
          key: "review",
          body: "Project original",
        });
      const before = await repository.readCatalog({ projectRoot });
      const changeCount = changes.length;
      const auditPath = NodePath.join(stateDir, "managed-text-resources", "audit.jsonl");
      const beforeAudit = await NodeFSP.readFile(auditPath);
      let published = false;
      let injected = false;
      const rename = NodeFSP.rename;
      using _bindings = { [Symbol.dispose]: () => NodeModule.syncBuiltinESMExports() };
      using _rename = vi.spyOn(NodeFS.promises, "rename").mockImplementation(async (...args) => {
        if (
          published &&
          !injected &&
          args[1] === NodePath.join(stateDir, "managed-text-resources", "catalog-state.json")
        ) {
          injected = true;
          throw new Error("Catalog rename EIO");
        }
        return rename(...args);
      });
      NodeModule.syncBuiltinESMExports();
      const commitGuard = async (commit: () => void) => {
        commit();
        published = true;
      };
      const mutation =
        operation === "create"
          ? repository.createEnvironment({
              kind: "snippet",
              key: "new",
              body: "Created",
              commitGuard,
            })
          : operation === "update"
            ? repository.updateEnvironment({
                id: original.id,
                expectedRevision: original.revision,
                body: "Replacement",
                commitGuard,
              })
            : operation === "delete"
              ? repository.deleteEnvironment({
                  id: original.id,
                  expectedRevision: original.revision,
                  commitGuard,
                })
              : repository.setProjectOverride({
                  projectRoot,
                  kind: "command",
                  key: "review",
                  body: "Replacement",
                  expectedCatalogRevision: before.catalogRevision,
                  commitGuard,
                });
      await expect(mutation).rejects.toThrow("Catalog rename EIO");
      expect(injected).toBe(true);
      expect(await repository.readCatalog({ projectRoot })).toEqual(before);
      expect(await NodeFSP.readFile(auditPath)).toEqual(beforeAudit);
      expect(changes.length).toBe(changeCount);
      expect(
        (await NodeFSP.readdir(NodePath.join(stateDir, "managed-text-resources"))).filter(
          (name) => name.includes("recovery-") || name === "pending-mutation.json",
        ),
      ).toEqual([]);
    });
  },
);

it("restores source and catalog when audit persistence fails", async () => {
  await withRepository(async ({ stateDir }) => {
    const repository = makeManagedTextResourceRepository(stateDir);
    const original = await repository.createEnvironment({
      kind: "command",
      key: "review",
      body: "Original",
    });
    const before = await repository.readCatalog();
    const auditPath = NodePath.join(stateDir, "managed-text-resources", "audit.jsonl");
    const audit = await NodeFSP.readFile(auditPath);
    const open = NodeFSP.open;
    let injected = false;
    using _bindings = { [Symbol.dispose]: () => NodeModule.syncBuiltinESMExports() };
    using _open = vi.spyOn(NodeFS.promises, "open").mockImplementation(async (...args) => {
      if (args[0] === auditPath && !injected) {
        injected = true;
        throw new Error("Audit open EIO");
      }
      return open(...args);
    });
    NodeModule.syncBuiltinESMExports();
    await expect(
      repository.updateEnvironment({
        id: original.id,
        expectedRevision: original.revision,
        body: "Replacement",
      }),
    ).rejects.toThrow("Audit open EIO");
    expect(injected).toBe(true);
    expect(await repository.readCatalog()).toEqual(before);
    expect(await NodeFSP.readFile(auditPath)).toEqual(audit);
  });
});

it("retains a committed cleanup intent and permits truthful reads after cleanup fails", async () => {
  await withRepository(async ({ stateDir }) => {
    const repository = makeManagedTextResourceRepository(stateDir);
    const original = await repository.createEnvironment({
      kind: "command",
      key: "review",
      body: "Original",
    });
    const rmdir = NodeFSP.rmdir;
    using _bindings = { [Symbol.dispose]: () => NodeModule.syncBuiltinESMExports() };
    using _rmdir = vi.spyOn(NodeFS.promises, "rmdir").mockImplementation(async (...args) => {
      if (String(args[0]).includes("recovery-")) throw new Error("Cleanup EIO");
      return rmdir(...args);
    });
    NodeModule.syncBuiltinESMExports();
    await expect(
      repository.updateEnvironment({
        id: original.id,
        expectedRevision: original.revision,
        body: "Committed",
      }),
    ).rejects.toThrow(/committed.*cleanup/i);
    expect((await repository.readCatalog()).environment[0]?.body).toBe("Committed");
    const pending = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(stateDir, "managed-text-resources", "pending-mutation.json"),
        "utf8",
      ),
    );
    expect(pending.phase).toBe("committed");
    const restarted = makeManagedTextResourceRepository(stateDir);
    expect((await restarted.readCatalog()).environment[0]?.body).toBe("Committed");
    await expect(
      restarted.createEnvironment({ kind: "snippet", key: "restart-blocked", body: "Body" }),
    ).rejects.toThrow(/needs recovery/);
    await expect(
      repository.createEnvironment({ kind: "snippet", key: "blocked", body: "Body" }),
    ).rejects.toThrow(/needs recovery/);
  });
});

it.each(["override", "delete"] as const)(
  "preserves invalid UTF-8 source bytes after a rejected %s",
  async (operation) => {
    await withRepository(async ({ stateDir, projectRoot }) => {
      const repository = makeManagedTextResourceRepository(stateDir);
      const directory = NodePath.join(projectRoot, ".t3code", "commands");
      await NodeFSP.mkdir(directory, { recursive: true });
      const target = NodePath.join(directory, "review.json");
      const bytes = Buffer.from([0xff, 0x0a]);
      await NodeFSP.writeFile(target, bytes);
      const before = await repository.readCatalog({ projectRoot });
      const input = {
        projectRoot,
        kind: "command" as const,
        key: "review",
        expectedCatalogRevision: before.catalogRevision,
        commitGuard: async (commit: () => void) => {
          commit();
          throw new Error("SQL rejected");
        },
      };
      await expect(
        operation === "override"
          ? repository.setProjectOverride({ ...input, body: "Replacement" })
          : repository.deleteProjectState(input),
      ).rejects.toThrow("SQL rejected");
      expect(await NodeFSP.readFile(target)).toEqual(bytes);
      expect(await repository.readCatalog({ projectRoot })).toEqual(before);
    });
  },
);

it("truncates only its partial audit suffix and restores physical state across restart", async () => {
  await withRepository(async ({ stateDir }) => {
    const repository = makeManagedTextResourceRepository(stateDir);
    const original = await repository.createEnvironment({
      kind: "command",
      key: "review",
      body: "Original",
    });
    const before = await repository.readCatalog();
    const root = NodePath.join(stateDir, "managed-text-resources");
    const auditPath = NodePath.join(root, "audit.jsonl");
    const originalAudit = await NodeFSP.readFile(auditPath);
    const open = NodeFSP.open;
    let injected = false;
    using _bindings = { [Symbol.dispose]: () => NodeModule.syncBuiltinESMExports() };
    using _open = vi.spyOn(NodeFS.promises, "open").mockImplementation(async (...args) => {
      if (args[0] === auditPath && !injected) {
        injected = true;
        const pending = JSON.parse(
          await NodeFSP.readFile(NodePath.join(root, "pending-mutation.json"), "utf8"),
        );
        await NodeFSP.appendFile(auditPath, Buffer.from(pending.auditAppend).subarray(0, 7));
        throw new Error("Partial audit EIO");
      }
      return open(...args);
    });
    NodeModule.syncBuiltinESMExports();
    await expect(
      repository.updateEnvironment({
        id: original.id,
        expectedRevision: original.revision,
        body: "Replacement",
      }),
    ).rejects.toThrow("Partial audit EIO");
    expect(injected).toBe(true);
    expect(await NodeFSP.readFile(auditPath)).toEqual(originalAudit);
    expect(await makeManagedTextResourceRepository(stateDir).readCatalog()).toEqual(before);
    expect(
      (await NodeFSP.readdir(root)).filter(
        (name) => name.includes("recovery-") || name === "pending-mutation.json",
      ),
    ).toEqual([]);
  });
});
