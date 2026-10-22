// @effect-diagnostics-next-line nodeBuiltinImport:off -- Verification fingerprints host-owned files without a provider runtime dependency.
import * as NodeCrypto from "node:crypto";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { verificationError } from "./ProjectWorkVerificationError.ts";

const fs = process.getBuiltinModule("fs");
const path = process.getBuiltinModule("path");
export const verificationSha256 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const identity = (stat: import("node:fs").BigIntStats) =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);

/** The host supplies the complete runtime closure; a client selection never does. */
export const captureVerificationExecutable = Effect.fn("ProjectWorkVerification.captureExecutable")(
  function* (executable: string, runtimeFiles: ReadonlyArray<string>) {
    return yield* Effect.tryPromise({
      try: async () => {
        const files = [...runtimeFiles].sort();
        if (
          files.length === 0 ||
          files.length > 128 ||
          new Set(files).size !== files.length ||
          !files.includes(executable)
        )
          throw verificationError("changed-executable");
        let total = 0;
        const entries = [];
        for (const file of files) {
          if (
            !path.isAbsolute(file) ||
            file.length > 4096 ||
            (await fs.promises.realpath(file)) !== file
          )
            throw verificationError("changed-executable");
          const handle = await fs.promises.open(
            file,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
          );
          try {
            const before = await handle.stat({ bigint: true });
            total += Number(before.size);
            if (
              !before.isFile() ||
              before.size > 268_435_456n ||
              total > 536_870_912 ||
              (file === executable && (before.mode & 0o111n) === 0n)
            )
              throw verificationError("changed-executable");
            const digest = NodeCrypto.createHash("sha256");
            const buffer = Buffer.alloc(65_536);
            let offset = 0;
            let first = "";
            while (offset < Number(before.size)) {
              const { bytesRead } = await handle.read(
                buffer,
                0,
                Math.min(buffer.length, Number(before.size) - offset),
                offset,
              );
              if (bytesRead === 0) throw verificationError("changed-executable");
              if (offset === 0)
                first = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
              digest.update(buffer.subarray(0, bytesRead));
              offset += bytesRead;
            }
            if (file === executable && first.startsWith("#!")) {
              const interpreter = first.slice(2).trim().split(/\s+/u)[0];
              if (
                !interpreter ||
                !path.isAbsolute(interpreter) ||
                !files.includes(interpreter) ||
                interpreter.endsWith("/env")
              )
                throw verificationError("changed-executable");
            }
            const after = await handle.stat({ bigint: true });
            const current = await fs.promises.lstat(file, { bigint: true });
            if (
              canonicalProjectWorkPayload(identity(before)) !==
                canonicalProjectWorkPayload(identity(after)) ||
              canonicalProjectWorkPayload(identity(before)) !==
                canonicalProjectWorkPayload(identity(current)) ||
              (await fs.promises.realpath(file)) !== file
            )
              throw verificationError("changed-executable");
            entries.push({
              target: file,
              identity: identity(before),
              sha256: digest.digest("hex"),
            });
          } finally {
            await handle.close();
          }
        }
        const entry = entries.find((entry) => entry.target === executable);
        if (!entry) throw verificationError("changed-executable");
        return {
          target: executable,
          sha256: entry.sha256,
          runtimeClosureSha256: verificationSha256(canonicalProjectWorkPayload(entries)),
        };
      },
      catch: () => verificationError("changed-executable"),
    });
  },
);

/** Captures finite command assets; the committed target tree binds the script's project dependencies. */
export const supportedVerificationRuntimeFiles = Effect.fn(
  "ProjectWorkVerification.supportedRuntimeFiles",
)(function* (
  command: import("@t3tools/contracts").ProjectVerificationCommandSelection,
  worktree: string,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const files = new Set<string>();
      const inspect = async (target: string, depth: number): Promise<string> => {
        if (
          depth > 2 ||
          !path.isAbsolute(target) ||
          (await fs.promises.realpath(target)) !== target
        )
          throw verificationError("changed-executable");
        const handle = await fs.promises.open(
          target,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || (stat.mode & 0o111) === 0)
            throw verificationError("changed-executable");
          const prefix = Buffer.alloc(4096);
          const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
          const bytes = prefix.subarray(0, bytesRead);
          files.add(target);
          if (bytes.subarray(0, 2).toString() === "#!") {
            const line = bytes.toString("utf8").split("\n", 1)[0]?.slice(2).trim() ?? "";
            if (!path.isAbsolute(line) || /\s/u.test(line) || line.endsWith("/env"))
              throw verificationError("changed-executable");
            return inspect(line, depth + 1);
          }
          const magic = bytes.subarray(0, 4).toString("hex");
          if (
            magic !== "7f454c46" &&
            !["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(
              magic,
            ) &&
            bytes.subarray(0, 2).toString() !== "MZ"
          )
            throw verificationError("changed-executable");
          return target;
        } finally {
          await handle.close();
        }
      };
      const interpreter = await inspect(command.executable, 0);
      const name = path.basename(interpreter).replace(/\.exe$/u, "");
      if (
        /^(?:node|nodejs|python(?:\d+(?:\.\d+)?)?|bash|dash|sh|zsh|ruby|perl)$/u.test(name) &&
        interpreter === command.executable
      ) {
        const entry = command.argv[0];
        if (!entry || entry.startsWith("-") || entry.includes("\0"))
          throw verificationError("changed-executable");
        const target = path.resolve(worktree, entry);
        const resolved = await fs.promises.realpath(target);
        const relative = path.relative(worktree, resolved);
        if (
          resolved !== target ||
          relative.startsWith(`..${path.sep}`) ||
          relative === ".." ||
          path.isAbsolute(relative)
        )
          throw verificationError("changed-executable");
        files.add(resolved);
      }
      for (const config of [
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
        "tsconfig.json",
        "pyproject.toml",
        "uv.lock",
        "poetry.lock",
        "requirements.txt",
      ]) {
        const target = path.join(worktree, config);
        try {
          const stat = await fs.promises.lstat(target);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw verificationError("changed-executable");
          files.add(target);
        } catch (cause) {
          if (
            !(
              typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "ENOENT"
            )
          )
            throw cause;
        }
      }
      return [...files].sort();
    },
    catch: () => verificationError("changed-executable"),
  });
});
