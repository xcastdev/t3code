// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import type {
  ManagedSkillContent,
  ManagedSkillId,
  ManagedSkillKey,
  ManagedSkillManifest,
  SkillContentHash,
} from "@t3tools/contracts";

import {
  DEFAULT_SKILL_PACKAGE_LIMITS,
  hashSkillPackage,
  inspectSkillPackage,
  parsePortableSkillDocument,
  SkillPackageError,
  SKILL_BODY_FILE,
  writeSkillPackageContents,
} from "./SkillPackage.ts";

const manifest = (key: string, hash: string): ManagedSkillManifest => ({
  schemaVersion: 1,
  kind: "managed-skill",
  id: `id-${key}` as ManagedSkillId,
  key: key as ManagedSkillKey,
  scope: "global",
  revision: { revision: 1, hash: hash as SkillContentHash },
  origin: "created",
  ownership: "t3",
});
const managedContent = (key: string, name: string, body: string): ManagedSkillContent => ({
  key: key as ManagedSkillKey,
  name,
  body,
});

describe("SkillPackage", () => {
  it.layer(NodeServices.layer)("package hashing", (it) => {
    it.effect("is stable across enumeration order and changes with path or bytes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-hash-" });
        const left = path.join(root, "left");
        const right = path.join(root, "right");
        yield* fs.makeDirectory(path.join(left, "assets"), { recursive: true });
        yield* fs.makeDirectory(path.join(right, "assets"), { recursive: true });
        yield* fs.writeFileString(path.join(left, "z.txt"), "z");
        yield* fs.writeFileString(path.join(left, "assets", "a.txt"), "a");
        yield* fs.writeFileString(path.join(right, "assets", "a.txt"), "a");
        yield* fs.writeFileString(path.join(right, "z.txt"), "z");

        assert.equal(yield* hashSkillPackage(left), yield* hashSkillPackage(right));
        yield* fs.writeFileString(path.join(right, "z.txt"), "changed");
        assert.notEqual(yield* hashSkillPackage(left), yield* hashSkillPackage(right));
        yield* fs.rename(path.join(right, "z.txt"), path.join(right, "renamed.txt"));
        assert.notEqual(yield* hashSkillPackage(left), yield* hashSkillPackage(right));
      }),
    );
  });

  it.layer(NodeServices.layer)("package validation", (it) => {
    it.effect("rejects a symlinked package root before enumeration or descriptor open", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-linked-root-" });
        const target = NodePath.join(root, "target");
        const linked = NodePath.join(root, "linked-package");
        yield* writeSkillPackageContents({
          packagePath: target,
          manifest: manifest("linked-package", "pending"),
          content: managedContent("linked-package", "Linked", "outside"),
        });
        yield* Effect.promise(() => NodeFSP.symlink(target, linked, "dir"));
        let enumerated = 0;
        let opened = 0;
        const hooks = {
          onDirectoryEntry: () =>
            Effect.sync(() => {
              enumerated += 1;
            }),
          onDescriptorOpen: () =>
            Effect.sync(() => {
              opened += 1;
            }),
        };

        const inspection = yield* inspectSkillPackage({
          packagePath: linked,
          expectedKey: "linked-package",
          hooks,
        });
        const hashing = yield* hashSkillPackage(linked).pipe(Effect.result);

        assert.deepEqual(
          inspection.diagnostics.map((item) => item.code),
          ["symlink_not_allowed"],
        );
        assert.isTrue(Result.isFailure(hashing));
        if (Result.isFailure(hashing)) assert.instanceOf(hashing.failure, SkillPackageError);
        if (Result.isFailure(hashing)) assert.equal(hashing.failure.code, "symlink_not_allowed");
        assert.equal(enumerated, 0);
        assert.equal(opened, 0);
      }),
    );

    it.effect("round trips a valid portable package", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-valid-" });
        const packagePath = NodePath.join(root, "deploy");
        yield* writeSkillPackageContents({
          packagePath,
          manifest: manifest("deploy", "pending"),
          content: managedContent("deploy", "Deploy safely", "Run the release checklist."),
        });
        const hash = yield* hashSkillPackage(packagePath);
        yield* fs.writeFileString(
          NodePath.join(packagePath, "t3-skill.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify(manifest("deploy", hash)),
        );

        const result = yield* inspectSkillPackage({ packagePath, expectedKey: "deploy" });
        assert.equal(result.validity, "valid");
        assert.equal(result.manifest?.revision.hash, hash);
        assert.deepEqual(
          result.content,
          managedContent("deploy", "Deploy safely", "Run the release checklist."),
        );
      }),
    );

    it.effect("preserves provider frontmatter extensions with deterministic YAML", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-frontmatter-" });
        const packagePath = NodePath.join(root, "deploy");
        const content: ManagedSkillContent = {
          ...managedContent("deploy", "Deploy safely", "Run the release checklist."),
          frontmatter: {
            license: "MIT",
            "disable-model-invocation": true,
            "allowed-tools": ["Bash", "Read"],
            nested: { z: "last", a: "first" },
          },
        };
        yield* writeSkillPackageContents({
          packagePath,
          manifest: manifest("deploy", "pending"),
          content,
        });
        const document = yield* fs.readFileString(path.join(packagePath, "SKILL.md"));
        assert.include(document, "disable-model-invocation: true");
        assert.isBelow(document.indexOf("a: first"), document.indexOf("z: last"));
        const result = yield* inspectSkillPackage({ packagePath, expectedKey: "deploy" });
        assert.deepEqual(result.content?.frontmatter, content.frontmatter);
      }),
    );

    it.effect("rejects reserved and unserializable frontmatter extensions", () =>
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "t3-skill-frontmatter-invalid-",
        });
        const reserved = yield* writeSkillPackageContents({
          packagePath: NodePath.join(root, "reserved"),
          manifest: manifest("reserved", "pending"),
          content: {
            ...managedContent("reserved", "Reserved", "Body"),
            frontmatter: { name: "not-portable" },
          },
        }).pipe(Effect.result);
        assert.isTrue(Result.isFailure(reserved));
        const unsupported = yield* writeSkillPackageContents({
          packagePath: NodePath.join(root, "unsupported"),
          manifest: manifest("unsupported", "pending"),
          content: {
            ...managedContent("unsupported", "Unsupported", "Body"),
            frontmatter: { value: BigInt(1) as never },
          },
        }).pipe(Effect.result);
        assert.isTrue(Result.isFailure(unsupported));
      }),
    );

    it.effect("returns malformed manual packages as diagnostics without adopting an id", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-manual-" });
        yield* fs.writeFileString(
          NodePath.join(root, "SKILL.md"),
          "---\nname: wrong\ndescription: Manual\n---\nBody",
        );

        const result = yield* inspectSkillPackage({ packagePath: root, expectedKey: "manual" });
        assert.equal(result.validity, "invalid");
        assert.equal(result.manifest, undefined);
        assert.include(
          result.diagnostics.map((item) => item.code),
          "manifest_missing",
        );
        assert.include(
          result.diagnostics.map((item) => item.code),
          "frontmatter_key_mismatch",
        );
      }),
    );

    it.effect("rejects malformed frontmatter and manifest key mismatches", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-malformed-" });
        yield* fs.writeFileString(NodePath.join(root, "t3-skill.json"), "{broken");
        yield* fs.writeFileString(NodePath.join(root, "SKILL.md"), "---\nname: [\n---\nBody");
        const malformed = yield* inspectSkillPackage({ packagePath: root, expectedKey: "deploy" });
        assert.include(
          malformed.diagnostics.map((item) => item.code),
          "manifest_invalid",
        );
        assert.include(
          malformed.diagnostics.map((item) => item.code),
          "frontmatter_invalid",
        );

        yield* fs.writeFileString(
          NodePath.join(root, "t3-skill.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify(manifest("other", "x")),
        );
        const mismatch = yield* inspectSkillPackage({ packagePath: root, expectedKey: "deploy" });
        assert.include(
          mismatch.diagnostics.map((item) => item.code),
          "manifest_key_mismatch",
        );
        const unsafeKey = yield* inspectSkillPackage({
          packagePath: root,
          expectedKey: "Uppercase",
        });
        assert.include(
          unsafeKey.diagnostics.map((item) => item.code),
          "key_invalid",
        );
      }),
    );

    it.effect("rejects wrong known frontmatter types during parse and external inspection", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-known-frontmatter-" });
        const invalidFrontmatter = [
          "disable-model-invocation: 'true'",
          "allowed-tools: 42",
          "metadata: [not, a, mapping]",
        ];
        for (const extension of invalidFrontmatter) {
          const document = `---\nname: deploy\ndescription: Deploy\n${extension}\n---\nBody`;
          assert.throws(() => parsePortableSkillDocument(document));
        }

        const packagePath = NodePath.join(root, "deploy");
        yield* fs.makeDirectory(packagePath);
        yield* fs.writeFileString(
          NodePath.join(packagePath, SKILL_BODY_FILE),
          "---\nname: deploy\ndescription: Deploy\ndisable-model-invocation: 'true'\n---\nBody",
        );
        yield* fs.writeFileString(
          NodePath.join(packagePath, "t3-skill.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify(manifest("deploy", "pending")),
        );
        const inspection = yield* inspectSkillPackage({
          packagePath,
          expectedKey: "deploy",
        });
        assert.equal(inspection.validity, "invalid");
        assert.include(
          inspection.diagnostics.map((diagnostic) => diagnostic.code),
          "frontmatter_invalid",
        );
      }),
    );

    it.effect("rejects symlinks, unsafe paths, duplicate paths, and configured limits", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-limits-" });
        const packageRoot = NodePath.join(root, "package");
        const outside = NodePath.join(root, "outside-skill-file");
        yield* fs.makeDirectory(packageRoot);
        yield* fs.writeFileString(outside, "outside");
        yield* fs.symlink(outside, NodePath.join(packageRoot, "linked.txt"));
        const linked = yield* inspectSkillPackage({
          packagePath: packageRoot,
          expectedKey: "deploy",
        });
        assert.include(
          linked.diagnostics.map((item) => item.code),
          "symlink_not_allowed",
        );

        const unsafe = yield* writeSkillPackageContents({
          packagePath: NodePath.join(root, "unsafe"),
          manifest: manifest("deploy", "pending"),
          content: { ...managedContent("deploy", "Deploy", "Body"), assetPaths: ["../escape"] },
        }).pipe(Effect.flip);
        assert.instanceOf(unsafe, SkillPackageError);
        assert.equal(unsafe._tag, "SkillPackageError");
        assert.equal(unsafe.code, "unsafe_path");

        const duplicate = yield* writeSkillPackageContents({
          packagePath: NodePath.join(root, "duplicate"),
          manifest: manifest("deploy", "pending"),
          content: {
            ...managedContent("deploy", "Deploy", "Body"),
            assetPaths: ["a.txt", "a.txt"],
          },
        }).pipe(Effect.flip);
        assert.instanceOf(duplicate, SkillPackageError);
        assert.equal(duplicate.code, "duplicate_path");

        const limited = NodePath.join(root, "limited");
        yield* fs.makeDirectory(limited);
        yield* fs.writeFileString(NodePath.join(limited, "a"), "aa");
        yield* fs.writeFileString(NodePath.join(limited, "b"), "bb");
        const countResult = yield* inspectSkillPackage({
          packagePath: limited,
          expectedKey: "limited",
          limits: { ...DEFAULT_SKILL_PACKAGE_LIMITS, maxFiles: 1 },
        });
        assert.include(
          countResult.diagnostics.map((item) => item.code),
          "file_count_exceeded",
        );
        const byteResult = yield* inspectSkillPackage({
          packagePath: limited,
          expectedKey: "limited",
          limits: { ...DEFAULT_SKILL_PACKAGE_LIMITS, maxBytes: 3 },
        });
        assert.include(
          byteResult.diagnostics.map((item) => item.code),
          "byte_limit_exceeded",
        );
      }),
    );

    it.effect("enforces manifest, traversal, and depth budgets before content reads", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-inventory-" });
        const packageRoot = NodePath.join(root, "package");
        yield* fs.makeDirectory(packageRoot);
        yield* fs.writeFileString(NodePath.join(packageRoot, "t3-skill.json"), "x".repeat(20));

        const oversizedManifest = yield* inspectSkillPackage({
          packagePath: packageRoot,
          expectedKey: "package",
          limits: { ...DEFAULT_SKILL_PACKAGE_LIMITS, maxManifestBytes: 10 },
        });
        assert.include(
          oversizedManifest.diagnostics.map((item) => item.code),
          "manifest_size_exceeded",
        );

        yield* fs.remove(NodePath.join(packageRoot, "t3-skill.json"));
        for (const name of ["a", "b", "c"]) {
          yield* fs.makeDirectory(NodePath.join(packageRoot, name));
        }
        let entriesPulled = 0;
        let descriptorsOpened = 0;
        const tooWide = yield* inspectSkillPackage({
          packagePath: packageRoot,
          expectedKey: "package",
          limits: { ...DEFAULT_SKILL_PACKAGE_LIMITS, maxEntries: 2 },
          hooks: {
            onDirectoryEntry: () =>
              Effect.sync(() => {
                entriesPulled += 1;
              }),
            onDescriptorOpen: () =>
              Effect.sync(() => {
                descriptorsOpened += 1;
              }),
          },
        });
        assert.include(
          tooWide.diagnostics.map((item) => item.code),
          "traversal_limit_exceeded",
        );
        assert.equal(entriesPulled, 3);
        assert.equal(descriptorsOpened, 0);

        const deepRoot = NodePath.join(root, "deep");
        yield* fs.makeDirectory(NodePath.join(deepRoot, "one", "two"), { recursive: true });
        const tooDeep = yield* inspectSkillPackage({
          packagePath: deepRoot,
          expectedKey: "deep",
          limits: { ...DEFAULT_SKILL_PACKAGE_LIMITS, maxDepth: 1 },
        });
        assert.include(
          tooDeep.diagnostics.map((item) => item.code),
          "depth_limit_exceeded",
        );
      }),
    );

    it.effect("rejects wrong ownership, scope, and non-minimal disabled tombstones", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-policy-" });
        const packagePath = NodePath.join(root, "deploy");
        yield* writeSkillPackageContents({
          packagePath,
          manifest: { ...manifest("deploy", "pending"), ownership: "external" },
          content: managedContent("deploy", "Deploy", "body"),
        });
        const ownership = yield* inspectSkillPackage({
          packagePath,
          expectedKey: "deploy",
          expectedScope: "global",
        });
        assert.include(
          ownership.diagnostics.map((item) => item.code),
          "ownership_invalid",
        );

        yield* fs.remove(packagePath, { recursive: true });
        yield* writeSkillPackageContents({
          packagePath,
          manifest: { ...manifest("deploy", "pending"), scope: "project" },
          projectState: "disabled",
        });
        yield* fs.makeDirectory(NodePath.join(packagePath, "empty"));
        const tombstone = yield* inspectSkillPackage({
          packagePath,
          expectedKey: "deploy",
          expectedScope: "project",
        });
        assert.include(
          tombstone.diagnostics.map((item) => item.code),
          "tombstone_invalid",
        );

        const wrongScope = yield* inspectSkillPackage({
          packagePath,
          expectedKey: "deploy",
          expectedScope: "global",
        });
        assert.include(
          wrongScope.diagnostics.map((item) => item.code),
          "scope_invalid",
        );
      }),
    );

    it.effect("rejects a same-size replacement between inventory and descriptor open", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-swap-" });
        const packagePath = NodePath.join(root, "deploy");
        yield* fs.makeDirectory(packagePath);
        yield* fs.writeFileString(NodePath.join(packagePath, "asset.txt"), "old");
        let swapped = false;
        const inspection = yield* inspectSkillPackage({
          packagePath,
          expectedKey: "deploy",
          hooks: {
            beforeDescriptorOpen: (relativePath) =>
              relativePath === "asset.txt" && !swapped
                ? Effect.promise(async () => {
                    swapped = true;
                    const replacement = NodePath.join(packagePath, "replacement");
                    await NodeFSP.writeFile(replacement, "new");
                    await NodeFSP.rename(replacement, NodePath.join(packagePath, relativePath));
                  })
                : Effect.void,
          },
        });
        assert.include(
          inspection.diagnostics.map((item) => item.code),
          "file_changed_during_inspection",
        );
      }),
    );
  });
});
