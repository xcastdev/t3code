// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ManagedSkillContent, ManagedSkillKey } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DEFAULT_SKILL_PACKAGE_LIMITS,
  parsePortableSkillDocument,
  portableSkillFrontmatterExtensions,
  SKILL_BODY_FILE,
} from "./SkillPackage.ts";

export class NativeSkillImportError extends Schema.TaggedError<NativeSkillImportError>()(
  "NativeSkillImportError",
  {
    code: Schema.Literals(["invalid_native_skill", "unsafe_native_package", "limit_exceeded"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const isNativeSkillImportError = Schema.is(NativeSkillImportError);

export interface NativeSkillImportPackage {
  readonly content: ManagedSkillContent;
  readonly files: ReadonlyArray<{ readonly relativePath: string; readonly bytes: Uint8Array }>;
}

const fail = (code: NativeSkillImportError["code"], detail: string, cause?: unknown) =>
  new NativeSkillImportError({ code, detail, ...(cause === undefined ? {} : { cause }) });

const sameFile = (left: NodeFS.BigIntStats, right: NodeFS.BigIntStats) =>
  left.isFile() &&
  right.isFile() &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs;

export const readNativeSkillForImport = Effect.fn("readNativeSkillForImport")(function* (input: {
  readonly nativePath: string;
  readonly key: ManagedSkillKey;
}): Effect.fn.Return<NativeSkillImportPackage, NativeSkillImportError> {
  return yield* Effect.tryPromise({
    try: async () => {
      const selected = NodePath.resolve(input.nativePath);
      const selectedInfo = await NodeFSP.lstat(selected, { bigint: true });
      if (
        selectedInfo.isSymbolicLink() ||
        (!selectedInfo.isFile() && !selectedInfo.isDirectory())
      ) {
        throw fail(
          "unsafe_native_package",
          "The native skill path is not a regular file or directory.",
        );
      }
      const root = selectedInfo.isDirectory() ? selected : NodePath.dirname(selected);
      if (NodePath.resolve(await NodeFSP.realpath(root)) !== root) {
        throw fail("unsafe_native_package", "The native skill root is redirected.");
      }

      const discovered: Array<{
        readonly relativePath: string;
        readonly absolutePath: string;
        readonly info: NodeFS.BigIntStats;
      }> = [];
      const queue = [{ absolutePath: root, depth: 0 }];
      let entries = 0;
      let totalBytes = 0n;
      while (queue.length > 0) {
        const directory = queue.shift();
        if (!directory) break;
        for (const entry of await NodeFSP.readdir(directory.absolutePath, {
          withFileTypes: true,
        })) {
          entries += 1;
          if (entries > DEFAULT_SKILL_PACKAGE_LIMITS.maxEntries) {
            throw fail("limit_exceeded", "The native package contains too many entries.");
          }
          const absolutePath = NodePath.join(directory.absolutePath, entry.name);
          const relativePath = NodePath.relative(root, absolutePath).split(NodePath.sep).join("/");
          const info = await NodeFSP.lstat(absolutePath, { bigint: true });
          if (info.isSymbolicLink()) {
            throw fail(
              "unsafe_native_package",
              `Symbolic link '${relativePath}' is not importable.`,
            );
          }
          if (info.isDirectory()) {
            if (directory.depth + 1 > DEFAULT_SKILL_PACKAGE_LIMITS.maxDepth) {
              throw fail("limit_exceeded", "The native package is nested too deeply.");
            }
            queue.push({ absolutePath, depth: directory.depth + 1 });
            continue;
          }
          if (!info.isFile()) {
            throw fail("unsafe_native_package", `Unsupported entry '${relativePath}'.`);
          }
          if (discovered.length >= DEFAULT_SKILL_PACKAGE_LIMITS.maxFiles) {
            throw fail("limit_exceeded", "The native package contains too many files.");
          }
          totalBytes += info.size;
          if (totalBytes > BigInt(DEFAULT_SKILL_PACKAGE_LIMITS.maxBytes)) {
            throw fail("limit_exceeded", "The native package is too large.");
          }
          discovered.push({ relativePath, absolutePath, info });
        }
      }

      const files: Array<{ readonly relativePath: string; readonly bytes: Uint8Array }> = [];
      for (const file of discovered.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
        const handle = await NodeFSP.open(
          file.absolutePath,
          NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
        );
        try {
          const before = await handle.stat({ bigint: true });
          if (!sameFile(file.info, before)) throw new Error("native file changed before import");
          const bytes = new Uint8Array(Number(before.size));
          let offset = 0;
          while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (read.bytesRead === 0) throw new Error("native file was truncated");
            offset += read.bytesRead;
          }
          const after = await handle.stat({ bigint: true });
          if (!sameFile(before, after)) throw new Error("native file changed during import");
          files.push({ relativePath: file.relativePath, bytes });
        } finally {
          await handle.close();
        }
      }

      const skill = files.find((file) => file.relativePath === SKILL_BODY_FILE);
      if (!skill) throw fail("invalid_native_skill", "The native package has no SKILL.md.");
      const parsed = parsePortableSkillDocument(new TextDecoder().decode(skill.bytes));
      const assets = files.filter(
        (file) => file.relativePath !== SKILL_BODY_FILE && file.relativePath !== "t3-skill.json",
      );
      return {
        content: {
          key: input.key,
          name: parsed.frontmatter.description,
          body: parsed.body,
          ...(Object.keys(portableSkillFrontmatterExtensions(parsed.frontmatter)).length === 0
            ? {}
            : { frontmatter: portableSkillFrontmatterExtensions(parsed.frontmatter) }),
          ...(assets.length === 0 ? {} : { assetPaths: assets.map((file) => file.relativePath) }),
        },
        files: assets,
      };
    },
    catch: (cause) =>
      isNativeSkillImportError(cause)
        ? cause
        : fail("invalid_native_skill", "The native package could not be imported.", cause),
  });
});
