// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ManagedSkillKey, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { parse as parseYaml } from "yaml";

import type { SkillMaterializationServiceShape } from "../../skills/SkillMaterializationService.ts";
import {
  CODEX_CANONICAL_EXTENSION_PATH,
  CODEX_MATERIALIZED_EXTENSION_PATH,
  mapCodexOpenAiExtensions,
  materializeCodexManagedSkills,
} from "./CodexSkillMaterializer.ts";

const promise = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);
const readDigest = (filePath: string) =>
  promise(async () =>
    NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(filePath))
      .digest("hex"),
  );
const exists = (filePath: string) =>
  promise(async () => {
    try {
      await NodeFSP.lstat(filePath);
      return true;
    } catch {
      return false;
    }
  });

describe("CodexSkillMaterializer", () => {
  it.effect("maps the canonical extension to agents/openai.yaml without rewriting it", () =>
    Effect.gen(function* () {
      const root = yield* promise(() =>
        NodeFSP.mkdtemp(NodePath.join("/tmp", "t3-codex-extension-")),
      );
      const skillPath = NodePath.join(root, "deploy");
      const sourcePath = NodePath.join(skillPath, CODEX_CANONICAL_EXTENSION_PATH);
      const bytes = Buffer.from(
        "interface:\n  display_name: Deploy\n  short_description: Ship safely\n  default_prompt: Run the release checklist\n",
      );
      yield* promise(() => NodeFSP.mkdir(NodePath.dirname(sourcePath), { recursive: true }));
      yield* promise(() => NodeFSP.writeFile(sourcePath, bytes));
      const before = yield* readDigest(sourcePath);

      yield* mapCodexOpenAiExtensions(new Map([[ManagedSkillKey.make("deploy"), skillPath]]));

      assert.deepEqual(
        yield* promise(() =>
          NodeFSP.readFile(NodePath.join(skillPath, CODEX_MATERIALIZED_EXTENSION_PATH)),
        ),
        bytes,
      );
      assert.equal(yield* readDigest(sourcePath), before);
      assert.deepEqual(
        parseYaml(
          yield* promise(() =>
            NodeFSP.readFile(NodePath.join(skillPath, CODEX_MATERIALIZED_EXTENSION_PATH), "utf8"),
          ),
        ),
        {
          interface: {
            display_name: "Deploy",
            short_description: "Ship safely",
            default_prompt: "Run the release checklist",
          },
        },
      );
    }),
  );

  it.effect("preserves skills without a Codex extension", () =>
    Effect.gen(function* () {
      const root = yield* promise(() =>
        NodeFSP.mkdtemp(NodePath.join("/tmp", "t3-codex-no-extension-")),
      );
      const skillPath = NodePath.join(root, "review");
      yield* promise(() => NodeFSP.mkdir(skillPath, { recursive: true }));
      yield* mapCodexOpenAiExtensions(new Map([[ManagedSkillKey.make("review"), skillPath]]));
      assert.isFalse(yield* exists(NodePath.join(skillPath, CODEX_MATERIALIZED_EXTENSION_PATH)));
    }),
  );

  it.effect("rejects malformed or unsupported Codex extensions", () =>
    Effect.gen(function* () {
      const root = yield* promise(() =>
        NodeFSP.mkdtemp(NodePath.join("/tmp", "t3-codex-invalid-")),
      );
      for (const [name, contents] of [
        ["malformed", "interface: ["],
        ["wrong-shape", "interface:\n  display_name: 42\n"],
        ["unknown-field", "policy:\n  allow_implicit_invocation: true\n"],
      ] as const) {
        const skillPath = NodePath.join(root, name);
        const sourcePath = NodePath.join(skillPath, CODEX_CANONICAL_EXTENSION_PATH);
        yield* promise(() => NodeFSP.mkdir(NodePath.dirname(sourcePath), { recursive: true }));
        yield* promise(() => NodeFSP.writeFile(sourcePath, contents));
        const error = yield* mapCodexOpenAiExtensions(
          new Map([[ManagedSkillKey.make(name), skillPath]]),
        ).pipe(Effect.flip);
        assert.equal(error.code, "codex_extension_invalid");
        assert.isFalse(yield* exists(NodePath.join(skillPath, CODEX_MATERIALIZED_EXTENSION_PATH)));
      }
    }),
  );

  it.effect("refuses a pre-existing destination, including a symlink", () =>
    Effect.gen(function* () {
      const root = yield* promise(() =>
        NodeFSP.mkdtemp(NodePath.join("/tmp", "t3-codex-collision-")),
      );
      for (const kind of ["file", "symlink"] as const) {
        const skillPath = NodePath.join(root, kind);
        const sourcePath = NodePath.join(skillPath, CODEX_CANONICAL_EXTENSION_PATH);
        const destinationPath = NodePath.join(skillPath, CODEX_MATERIALIZED_EXTENSION_PATH);
        yield* promise(() => NodeFSP.mkdir(NodePath.dirname(sourcePath), { recursive: true }));
        yield* promise(() => NodeFSP.mkdir(NodePath.dirname(destinationPath), { recursive: true }));
        yield* promise(() => NodeFSP.writeFile(sourcePath, "interface:\n  display_name: Deploy\n"));
        if (kind === "file") {
          yield* promise(() => NodeFSP.writeFile(destinationPath, "owned by caller\n"));
        } else {
          yield* promise(() => NodeFSP.symlink("../../outside", destinationPath));
        }

        const error = yield* mapCodexOpenAiExtensions(
          new Map([[ManagedSkillKey.make(kind), skillPath]]),
        ).pipe(Effect.flip);
        assert.equal(error.code, "codex_extension_collision");
        if (kind === "file") {
          assert.equal(
            yield* promise(() => NodeFSP.readFile(destinationPath, "utf8")),
            "owned by caller\n",
          );
        } else {
          assert.isTrue((yield* promise(() => NodeFSP.lstat(destinationPath))).isSymbolicLink());
        }
      }
    }),
  );

  it.effect("cleans a generic materialization when Codex extension preparation fails", () =>
    Effect.gen(function* () {
      const root = yield* promise(() =>
        NodeFSP.mkdtemp(NodePath.join("/tmp", "t3-codex-cleanup-")),
      );
      const skillPath = NodePath.join(root, "deploy");
      const sourcePath = NodePath.join(skillPath, CODEX_CANONICAL_EXTENSION_PATH);
      yield* promise(() => NodeFSP.mkdir(NodePath.dirname(sourcePath), { recursive: true }));
      yield* promise(() => NodeFSP.writeFile(sourcePath, "interface:\n  display_name: 42\n"));
      let disposed = false;
      const materialization: SkillMaterializationServiceShape = {
        materialize: () =>
          Effect.succeed({
            root,
            skillPaths: new Map([[ManagedSkillKey.make("deploy"), skillPath]]),
          }),
        dispose: () => Effect.sync(() => void (disposed = true)),
        disposeSession: () => Effect.void,
      };
      const error = yield* materializeCodexManagedSkills({
        materialization,
        materializationInput: {
          sessionId: "session-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
          desiredRevision: 1,
          packages: [],
        },
      }).pipe(Effect.flip);
      assert.equal(error.code, "codex_extension_invalid");
      assert.isTrue(disposed);
    }),
  );
});
