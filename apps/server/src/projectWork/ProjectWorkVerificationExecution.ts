// @effect-diagnostics-next-line nodeBuiltinImport:off -- Bounded filesystem snapshots validate reviewed source without spawning processes inside SQL.
import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  type ProjectVerificationJobManifest,
} from "@t3tools/contracts";
import { verificationSha256 } from "./ProjectWorkVerificationExecutable.ts";
import * as Effect from "effect/Effect";
import { ProcessRunner } from "../processRunner.ts";
import { verificationError } from "./ProjectWorkVerificationError.ts";

const fs = process.getBuiltinModule("fs");
const path = process.getBuiltinModule("path");
/** Git observations are separate from SQL; authority is checked again at the commit boundary. */
export const assertVerificationTarget = Effect.fn("ProjectWorkVerification.assertTarget")(
  function* (target: ProjectVerificationJobManifest["target"]) {
    const runner = yield* ProcessRunner;
    yield* Effect.tryPromise({
      try: async () => {
        if (
          (await fs.promises.realpath(target.worktree)) !== target.worktree ||
          (await fs.promises.realpath(target.repository)) !== target.repository
        )
          throw verificationError("changed-target");
      },
      catch: () => verificationError("changed-target"),
    });
    const git = Effect.fn("ProjectWorkVerification.git")(
      function* (args: ReadonlyArray<string>) {
        const result = yield* runner.run({
          command: "git",
          args: [
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.trustctime=true",
            "-c",
            "core.ignoreStat=false",
            "-c",
            "core.hooksPath=/dev/null",
            ...args,
          ],
          cwd: target.worktree,
          env: {
            PATH: process.env.PATH,
            LANG: "C",
            LC_ALL: "C",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_NO_REPLACE_OBJECTS: "1",
          },
          extendEnv: false,
          maxOutputBytes: 65_536,
          outputMode: "error",
        });
        if (
          result.code !== 0 ||
          result.timedOut ||
          result.stdoutTruncated ||
          result.stderrTruncated ||
          result.stdoutInvalidUtf8
        )
          return yield* verificationError("changed-target");
        return result.stdout.trim();
      },
      Effect.mapError(() => verificationError("changed-target")),
    );
    const head = yield* git(["rev-parse", "HEAD"]);
    const tree = yield* git(["rev-parse", "HEAD^{tree}"]);
    const branch = yield* git(["symbolic-ref", "HEAD"]);
    const root = yield* git(["rev-parse", "--show-toplevel"]);
    const common = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const commonRoot = yield* Effect.tryPromise({
      try: () => fs.promises.realpath(common),
      catch: () => verificationError("changed-target"),
    });
    const repositoryGit = yield* Effect.tryPromise({
      try: () => fs.promises.realpath(`${target.repository}/.git`),
      catch: () => verificationError("changed-target"),
    });
    const flagged = yield* git(["ls-files", "-v", "-z"]);
    if (flagged.split("\0").some((entry) => entry !== "" && !entry.startsWith("H ")))
      return yield* verificationError("changed-target");
    const dirty = yield* git([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    if (
      head !== target.headSha ||
      head !== target.testedCommit ||
      tree !== target.testedTree ||
      branch !== target.branchRef ||
      root !== target.worktree ||
      commonRoot !== repositoryGit ||
      dirty !== ""
    )
      return yield* verificationError("changed-target");
  },
);

interface PhysicalEntry {
  readonly path: string;
  readonly sha256: string | null;
  readonly identity: ReadonlyArray<string> | null;
}
const physicalIdentity = (stat: import("node:fs").BigIntStats) =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
const maxPhysicalFiles = 8192;
const maxPhysicalBytes = 536_870_912;
const maxPhysicalFileBytes = 268_435_456;
const readPhysicalEntries = async (
  files: ReadonlyArray<{
    readonly path: string;
    readonly blob?: string;
    readonly optional?: boolean;
  }>,
): Promise<ReadonlyArray<PhysicalEntry>> => {
  if (files.length > maxPhysicalFiles) throw verificationError("changed-target");
  let total = 0;
  const result: Array<PhysicalEntry> = [];
  for (const file of files) {
    let handle: import("node:fs/promises").FileHandle;
    try {
      handle = await fs.promises.open(
        file.path,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    } catch (cause) {
      if (
        file.optional &&
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ENOENT"
      ) {
        result.push({ path: file.path, sha256: null, identity: null });
        continue;
      }
      throw cause;
    }
    try {
      const before = await handle.stat({ bigint: true });
      total += Number(before.size);
      if (
        !before.isFile() ||
        before.size > BigInt(maxPhysicalFileBytes) ||
        total > maxPhysicalBytes
      )
        throw verificationError("changed-target");
      const sha256 = NodeCrypto.createHash("sha256");
      const blob = NodeCrypto.createHash("sha1").update(`blob ${before.size}\0`);
      const buffer = Buffer.alloc(65536);
      let offset = 0;
      while (offset < Number(before.size)) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, Number(before.size) - offset),
          offset,
        );
        if (bytesRead === 0) throw verificationError("changed-target");
        sha256.update(buffer.subarray(0, bytesRead));
        blob.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const current = await fs.promises.lstat(file.path, { bigint: true });
      if (
        canonicalProjectWorkPayload(physicalIdentity(before)) !==
          canonicalProjectWorkPayload(physicalIdentity(after)) ||
        canonicalProjectWorkPayload(physicalIdentity(before)) !==
          canonicalProjectWorkPayload(physicalIdentity(current)) ||
        (file.blob !== undefined && blob.digest("hex") !== file.blob)
      )
        throw verificationError("changed-target");
      result.push({
        path: file.path,
        sha256: sha256.digest("hex"),
        identity: physicalIdentity(before),
      });
    } finally {
      await handle.close();
    }
  }
  return result;
};

/** Git resolves a finite source set outside SQL; the returned check reads only those exact files. */
export const captureVerificationPhysicalValidation = Effect.fn(
  "ProjectWorkVerification.capturePhysicalValidation",
)(function* (
  target: ProjectVerificationJobManifest["target"],
  runtimeFiles: ReadonlyArray<string>,
  approvedExecutable: ProjectVerificationJobManifest["executable"],
) {
  const runner = yield* ProcessRunner;
  const git = Effect.fn("ProjectWorkVerification.physicalGit")(
    function* (args: ReadonlyArray<string>) {
      const output = yield* runner.run({
        command: "git",
        args: ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", ...args],
        cwd: target.worktree,
        env: {
          PATH: process.env.PATH,
          LANG: "C",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
        extendEnv: false,
        timeout: 10000,
        maxOutputBytes: 1_048_576,
        outputMode: "error",
      });
      if (
        output.code !== 0 ||
        output.timedOut ||
        output.stdoutTruncated ||
        output.stdoutInvalidUtf8
      )
        return yield* verificationError("changed-target");
      return output.stdout;
    },
    Effect.mapError(() => verificationError("changed-target")),
  );
  const stage = yield* git(["ls-files", "--stage", "-z"]);
  const files: Array<{ path: string; blob?: string; optional?: boolean }> = [];
  for (const entry of stage.split("\0")) {
    if (entry === "") continue;
    const match = /^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/su.exec(entry);
    if (match === null) return yield* verificationError("changed-target");
    const name = match[3];
    if (name === undefined || name.startsWith("/") || name.split("/").includes(".."))
      return yield* verificationError("changed-target");
    const blob = match[2];
    if (blob === undefined) return yield* verificationError("changed-target");
    files.push({ path: `${target.worktree}/${name}`, blob });
  }
  for (const file of runtimeFiles)
    if (!files.some((entry) => entry.path === file)) files.push({ path: file });
  for (const name of [
    "HEAD",
    "index",
    target.branchRef,
    "packed-refs",
    "config",
    "config.worktree",
  ]) {
    const file = (yield* git(["rev-parse", "--path-format=absolute", "--git-path", name])).trim();
    files.push({ path: file, optional: true });
  }
  const directories = new Set<string>([target.worktree]);
  for (const file of files) {
    let parent = path.dirname(file.path);
    while (parent.startsWith(`${target.worktree}${path.sep}`)) {
      directories.add(parent);
      parent = path.dirname(parent);
    }
  }
  const snapshot = async () => {
    const entries = await readPhysicalEntries(files);
    const runtimeEntries = [...runtimeFiles].sort().map((target) => {
      const entry = entries.find((entry) => entry.path === target);
      if (entry === undefined || entry.sha256 === null || entry.identity === null)
        throw verificationError("changed-executable");
      return { target, identity: entry.identity, sha256: entry.sha256 };
    });
    const executable = runtimeEntries.find((entry) => entry.target === approvedExecutable.target);
    if (
      executable?.sha256 !== approvedExecutable.sha256 ||
      verificationSha256(canonicalProjectWorkPayload(runtimeEntries)) !==
        approvedExecutable.runtimeClosureSha256
    )
      throw verificationError("changed-executable");
    if (directories.size > maxPhysicalFiles) throw verificationError("changed-target");
    const directoryEntries = [];
    let nameCount = 0;
    for (const directory of directories) {
      const stat = await fs.promises.lstat(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw verificationError("changed-target");
      const names = await fs.promises.readdir(directory);
      nameCount += names.length;
      if (names.length > maxPhysicalFiles || nameCount > 65536)
        throw verificationError("changed-target");
      directoryEntries.push({
        path: directory,
        identity: physicalIdentity(stat),
        names: names.sort(),
      });
    }
    return { entries, directoryEntries };
  };
  const before = yield* Effect.tryPromise({
    try: snapshot,
    catch: () => verificationError("changed-target"),
  });
  yield* assertVerificationTarget(target);
  return Effect.tryPromise({
    try: async () => {
      const after = await snapshot();
      if (canonicalProjectWorkPayload(before) !== canonicalProjectWorkPayload(after))
        throw verificationError("changed-target");
    },
    catch: () => verificationError("changed-target"),
  });
});
