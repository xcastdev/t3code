import * as NodeCrypto from "node:crypto";
import {
  GitCommandError,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Assignment = Schema.Struct({
  effectId: Text,
  runId: Text,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  primaryRoot: Text,
  commonGitDirectory: Text,
  worktreePath: Text,
  branchRef: Text,
  baseRef: Text,
  baseOid: Text,
  ownershipToken: Text,
  policyHash: Text,
});
const Identity = Schema.Struct({ path: Text, dev: Text, ino: Text });
const Receipt = Schema.Struct({
  assignment: Assignment,
  primary: Identity,
  worktree: Identity,
  common: Identity,
  gitDirectory: Identity,
  initialHeadOid: Text,
  pointerAndConfigurationHash: Text,
});
export type ManagedGitAssignment = typeof Assignment.Type;
export type ManagedWorkspaceReceipt = typeof Receipt.Type;
const encodeAssignment = Schema.encodeSync(Schema.fromJsonString(Assignment));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(Receipt));
const decodeAssignment = Schema.decodeUnknownEffect(Assignment);
const decodeReceipt = Schema.decodeUnknownEffect(Receipt);
const brand = Symbol("ManagedGitExecution");
/** A private, server-created execution context. Each use still requires fresh Root authority. */
export interface ManagedGitExecution {
  readonly [brand]: true;
}
interface Execution {
  readonly assignment: ManagedGitAssignment;
  readonly prepare: (input: VcsCreateWorktreeInput) => Effect.Effect<string, GitCommandError>;
  readonly create: (
    input: VcsCreateWorktreeInput,
  ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
}
const executions = new WeakMap<ManagedGitExecution, Execution>();
const fs = process.getBuiltinModule("fs");
const directoryFlags =
  fs.constants.O_RDONLY |
  fs.constants.O_DIRECTORY |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;
const fileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const ownerFile = "t3-managed-owner";
const digest = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const identity = (path: string, stat: import("node:fs").BigIntStats) => ({
  path,
  dev: String(stat.dev),
  ino: String(stat.ino),
});
const sameStat = (a: import("node:fs").BigIntStats, b: import("node:fs").BigIntStats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.mode === b.mode &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;
const hardened = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "credential.helper=",
  "core.askPass=",
  "core.pager=",
  "diff.external=",
  "core.attributesFile=/dev/null",
  "core.excludesFile=/dev/null",
  "core.sshCommand=/usr/bin/false",
  "protocol.allow=never",
  "submodule.recurse=false",
  "fetch.recurseSubmodules=false",
  "push.recurseSubmodules=no",
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  "maintenance.auto=false",
  "gc.auto=0",
  "core.untrackedCache=false",
].flatMap((setting) => ["-c", setting]);
const environment = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "",
  PAGER: "",
  GIT_ATTR_NOSYSTEM: "1",
};

const error = (cwd: string, detail: string, cause?: unknown) =>
  new GitCommandError({
    operation: "ManagedGitExecution",
    command: "/usr/bin/git",
    cwd,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
const getExecution = (
  context: ManagedGitExecution,
  cwd: string,
): Effect.Effect<Execution, GitCommandError> => {
  const execution = executions.get(context);
  return execution
    ? Effect.succeed(execution)
    : Effect.fail(error(cwd, "Invalid managed Git execution context."));
};
/** Called before ordinary registry discovery, then used with the workflow's existing common-directory semaphore. */
export const prepareManagedGitExecution = (
  context: ManagedGitExecution,
  input: VcsCreateWorktreeInput,
) => getExecution(context, input.cwd).pipe(Effect.flatMap((execution) => execution.prepare(input)));
/** The workflow must hold its common-directory permit for this entire effect, including receipt persistence. */
export const createManagedWorktree = (
  context: ManagedGitExecution,
  input: VcsCreateWorktreeInput,
) => getExecution(context, input.cwd).pipe(Effect.flatMap((execution) => execution.create(input)));

/** Canonical common metadata is also the permit key for ordinary linked-worktree mutations. */
export const canonicalGitMutationKey = (common: string, cwd: string) =>
  Effect.try({
    try: () => `git\0${fs.realpathSync(common.startsWith("/") ? common : `${cwd}/${common}`)}`,
    catch: (cause) =>
      error(cwd, "Cannot establish the repository's common metadata identity.", cause),
  });

/** Supports the same Linux host boundary as managed Pi; unsupported layouts remain visibly unavailable. */
export const make = Effect.fn("ManagedGitExecution.make")(function* (options: {
  readonly assignment: ManagedGitAssignment;
  readonly revalidate: Effect.Effect<void, GitCommandError>;
  readonly priorReceipt?: ManagedWorkspaceReceipt;
  readonly persistWorkspace: (
    receipt: ManagedWorkspaceReceipt,
  ) => Effect.Effect<void, GitCommandError>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const assignment = yield* decodeAssignment(options.assignment).pipe(
    Effect.mapError((cause) =>
      error(options.assignment.primaryRoot, "Invalid managed assignment.", cause),
    ),
  );
  const prior =
    options.priorReceipt === undefined
      ? undefined
      : yield* decodeReceipt(options.priorReceipt).pipe(
          Effect.mapError((cause) =>
            error(assignment.primaryRoot, "Invalid prior workspace receipt.", cause),
          ),
        );
  const a = Object.freeze({ ...assignment });
  const owner = encodeAssignment(a);
  const priorText = prior ? encodeReceipt(prior) : undefined;
  const deny = (detail: string) => error(a.primaryRoot, detail);
  if (platform !== "linux")
    return yield* deny("Managed Git execution is unavailable on this host.");
  const executablePath = yield* fileSystem
    .realPath("/usr/bin/git")
    .pipe(
      Effect.mapError((cause) =>
        error(a.primaryRoot, "Trusted Git executable is unavailable.", cause),
      ),
    );
  const executableIdentity = yield* Effect.try({
    try: () => {
      const stat = fs.lstatSync(executablePath, { bigint: true });
      if (
        executablePath !== "/usr/bin/git" ||
        !stat.isFile() ||
        stat.uid !== 0n ||
        (stat.mode & 0o022n) !== 0n
      )
        throw deny("Git executable is not a trusted host binary.");
      return stat;
    },
    catch: (cause) => error(a.primaryRoot, "Trusted Git executable is unavailable.", cause),
  });
  if (
    !/^[a-f0-9]{40}$/.test(a.baseOid) ||
    !a.branchRef.startsWith("refs/heads/") ||
    !a.baseRef.startsWith("refs/")
  )
    return yield* deny("Managed Git requires a local commit and explicit refs.");
  for (const value of [a.primaryRoot, a.commonGitDirectory, a.worktreePath]) {
    if (
      !path.isAbsolute(value) ||
      path.normalize(value) !== value ||
      value.includes("\0") ||
      value === "/"
    )
      return yield* deny("Managed Git requires canonical absolute paths.");
  }
  const inside = (root: string, candidate: string) =>
    candidate === root || candidate.startsWith(`${root}/`);
  if (
    inside(a.primaryRoot, a.worktreePath) ||
    inside(a.commonGitDirectory, a.worktreePath) ||
    inside(a.worktreePath, a.primaryRoot)
  )
    return yield* deny("Assigned worktree must be separate from primary and common metadata.");
  if (prior && encodeAssignment(prior.assignment) !== owner)
    return yield* deny("Prior receipt belongs to a different assignment.");

  const checkInput = (input: VcsCreateWorktreeInput) => {
    if (
      input.cwd !== a.primaryRoot ||
      input.path !== a.worktreePath ||
      input.refName !== a.baseRef ||
      input.newRefName !== a.branchRef.slice(11) ||
      (input.baseRefName !== undefined && input.baseRefName !== a.baseRef) ||
      input.precondition !== undefined
    )
      throw deny("Worktree input does not match the durable managed assignment.");
  };
  const snapshot = (worktree = false, owned = true) => {
    const handles = new Map<string, number>();
    const files: Array<{
      path: string;
      dev: string;
      ino: string;
      hash: string;
      text: string;
    } | null> = [];
    const checked: Array<{
      path: string;
      stat: import("node:fs").BigIntStats | null;
      hash?: string;
    }> = [];
    const fail = () => {
      throw deny("Managed Git metadata, configuration or pointers are unsupported or changed.");
    };
    const close = () => {
      for (const fd of [...handles.values()].toReversed()) fs.closeSync(fd);
    };
    const directory = (value: string): number => {
      const old = handles.get(value);
      if (old !== undefined) return old;
      if (handles.size >= 64 || !path.isAbsolute(value) || path.normalize(value) !== value)
        return fail();
      const parent = value === "/" ? undefined : directory(path.dirname(value));
      const entry = parent === undefined ? "/" : `/proc/self/fd/${parent}/${path.basename(value)}`;
      const before = fs.lstatSync(entry, { bigint: true });
      if (!before.isDirectory()) return fail();
      const fd = fs.openSync(entry, directoryFlags);
      handles.set(value, fd);
      const stat = fs.fstatSync(fd, { bigint: true });
      if (
        before.dev !== stat.dev ||
        before.ino !== stat.ino ||
        fs.realpathSync(value) !== value ||
        fs.realpathSync(`/proc/self/fd/${fd}`) !== value
      )
        return fail();
      return fd;
    };
    const read = (value: string, optional = false) => {
      const entry = `/proc/self/fd/${directory(path.dirname(value))}/${path.basename(value)}`;
      const before = fs.lstatSync(entry, { bigint: true, throwIfNoEntry: false });
      if (!before) {
        if (!optional) return fail();
        checked.push({ path: value, stat: null });
        files.push(null);
        return null;
      }
      if (!before.isFile() || before.nlink !== 1n || before.size > 65536n) return fail();
      const fd = fs.openSync(entry, fileFlags);
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!sameStat(before, stat)) return fail();
        const bytes = Buffer.alloc(65537);
        const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (
          BigInt(count) !== stat.size ||
          !sameStat(stat, fs.fstatSync(fd, { bigint: true })) ||
          !sameStat(stat, fs.lstatSync(entry, { bigint: true }))
        )
          return fail();
        const bytesRead = bytes.subarray(0, count);
        const hash = digest(bytesRead);
        const file = {
          ...identity(value, stat),
          hash,
          text: new TextDecoder("utf-8", { fatal: true }).decode(bytesRead),
        };
        checked.push({ path: value, stat, hash });
        files.push(file);
        return file;
      } finally {
        fs.closeSync(fd);
      }
    };
    try {
      const primary = identity(
        a.primaryRoot,
        fs.fstatSync(directory(a.primaryRoot), { bigint: true }),
      );
      const common = identity(
        a.commonGitDirectory,
        fs.fstatSync(directory(a.commonGitDirectory), { bigint: true }),
      );
      directory(path.dirname(a.worktreePath));
      const primaryEntry = path.join(a.primaryRoot, ".git");
      if (fs.lstatSync(primaryEntry).isDirectory()) {
        if (primaryEntry !== a.commonGitDirectory) return fail();
      } else {
        const pointer = read(primaryEntry);
        if (
          !pointer ||
          !pointer.text.startsWith("gitdir: ") ||
          path.resolve(a.primaryRoot, pointer.text.slice(8).trim()) !== a.commonGitDirectory
        )
          return fail();
      }
      const config = read(path.join(a.commonGitDirectory, "config"));
      if (!config) return fail();
      if (read(path.join(a.commonGitDirectory, "config.worktree"), true)) return fail();
      directory(path.join(a.commonGitDirectory, "objects"));
      const info = path.join(a.commonGitDirectory, "objects", "info");
      if (fs.lstatSync(info, { throwIfNoEntry: false })) {
        directory(info);
        if (
          read(path.join(info, "alternates"), true) ||
          read(path.join(info, "http-alternates"), true)
        )
          return fail();
      } else {
        checked.push({ path: info, stat: null });
      }
      const packedRefs = path.join(a.commonGitDirectory, "packed-refs");
      const packedStat = fs.lstatSync(packedRefs, { throwIfNoEntry: false });
      if (packedStat && (!packedStat.isFile() || packedStat.nlink !== 1)) return fail();
      const pack = path.join(a.commonGitDirectory, "objects", "pack");
      if (fs.lstatSync(pack, { throwIfNoEntry: false })) {
        directory(pack);
        const fd = fs.opendirSync(`/proc/self/fd/${directory(pack)}`);
        try {
          let count = 0;
          for (let entry = fd.readSync(); entry !== null; entry = fd.readSync()) {
            if (++count > 4096 || entry.name.endsWith(".promisor") || entry.isSymbolicLink())
              return fail();
          }
        } finally {
          fd.closeSync();
        }
      }
      for (const value of ["worktrees", "logs", "logs/refs", "logs/refs/heads"]) {
        const entry = path.join(a.commonGitDirectory, value);
        if (fs.lstatSync(entry, { throwIfNoEntry: false })) directory(entry);
      }
      directory(path.join(a.commonGitDirectory, "refs"));
      // Existing ref ancestors must be directories, never redirects into another repository.
      for (const ref of [a.branchRef, a.baseRef]) {
        const segments = ref.split("/");
        if (
          segments.some((segment) => !segment || segment === "." || segment === "..") ||
          /[\x00-\x20~^:?*\[\\]/.test(ref) ||
          ref.includes("@{") ||
          ref.includes("..") ||
          ref.endsWith(".lock")
        )
          return fail();
        let cursor = a.commonGitDirectory;
        for (const segment of segments.slice(0, -1)) {
          cursor = path.join(cursor, segment);
          if (fs.lstatSync(cursor, { throwIfNoEntry: false })) directory(cursor);
        }
        let logCursor = path.join(a.commonGitDirectory, "logs");
        for (const segment of segments.slice(0, -1)) {
          logCursor = path.join(logCursor, segment);
          if (fs.lstatSync(logCursor, { throwIfNoEntry: false })) directory(logCursor);
        }
        const logEntry = path.join(a.commonGitDirectory, "logs", ref);
        const logStat = fs.lstatSync(logEntry, { throwIfNoEntry: false });
        if (logStat && (!logStat.isFile() || logStat.nlink !== 1)) return fail();
        const entry = path.join(a.commonGitDirectory, ref);
        const refStat = fs.lstatSync(entry, { throwIfNoEntry: false });
        if (refStat && (!refStat.isFile() || refStat.nlink !== 1)) return fail();
      }
      let workspace: ManagedWorkspaceReceipt | undefined;
      let ownershipEntry: string | undefined;
      if (worktree) {
        const worktreeIdentity = identity(
          a.worktreePath,
          fs.fstatSync(directory(a.worktreePath), { bigint: true }),
        );
        const pointer = read(path.join(a.worktreePath, ".git"));
        if (!pointer || !pointer.text.startsWith("gitdir: ")) return fail();
        const gitDirectoryPath = path.resolve(a.worktreePath, pointer.text.slice(8).trim());
        if (
          !inside(path.join(a.commonGitDirectory, "worktrees"), gitDirectoryPath) ||
          path.dirname(gitDirectoryPath) !== path.join(a.commonGitDirectory, "worktrees")
        )
          return fail();
        const gitDirectory = identity(
          gitDirectoryPath,
          fs.fstatSync(directory(gitDirectoryPath), { bigint: true }),
        );
        const back = read(path.join(gitDirectoryPath, "gitdir"));
        const commonPointer = read(path.join(gitDirectoryPath, "commondir"));
        const head = read(path.join(gitDirectoryPath, "HEAD"));
        const ownership = read(path.join(gitDirectoryPath, ownerFile), !owned);
        ownershipEntry = `/proc/self/fd/${directory(gitDirectoryPath)}/${ownerFile}`;
        if (
          !back ||
          path.resolve(gitDirectoryPath, back.text.trim()) !== path.join(a.worktreePath, ".git") ||
          !commonPointer ||
          path.resolve(gitDirectoryPath, commonPointer.text.trim()) !== a.commonGitDirectory ||
          !head ||
          head.text.trim() !== `ref: ${a.branchRef}` ||
          (owned ? !ownership || ownership.text !== owner : ownership !== null) ||
          read(path.join(gitDirectoryPath, "config.worktree"), true)
        )
          return fail();
        workspace = {
          assignment: a,
          primary,
          common,
          worktree: worktreeIdentity,
          gitDirectory,
          initialHeadOid: a.baseOid,
          pointerAndConfigurationHash: digest(
            files
              .map((file) =>
                file ? `${file.path}\0${file.dev}\0${file.ino}\0${file.hash}` : "absent",
              )
              .join("\n"),
          ),
        };
      }
      const verify = () => {
        const packed = fs.lstatSync(packedRefs, { throwIfNoEntry: false });
        if (packed && (!packed.isFile() || packed.nlink !== 1)) fail();
        if (fs.lstatSync(pack, { throwIfNoEntry: false })) {
          const dir = fs.opendirSync(`/proc/self/fd/${directory(pack)}`);
          try {
            let count = 0;
            for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
              if (++count > 4096 || entry.name.endsWith(".promisor") || entry.isSymbolicLink())
                fail();
            }
          } finally {
            dir.closeSync();
          }
        }
        if (!sameStat(executableIdentity, fs.lstatSync(executablePath, { bigint: true }))) fail();
        for (const [value, fd] of handles) {
          const stat = fs.fstatSync(fd, { bigint: true });
          const current = fs.lstatSync(value, { bigint: true });
          if (
            stat.dev !== current.dev ||
            stat.ino !== current.ino ||
            fs.realpathSync(value) !== value ||
            fs.realpathSync(`/proc/self/fd/${fd}`) !== value
          )
            fail();
        }
        for (const entry of checked) {
          const current = fs.lstatSync(entry.path, { bigint: true, throwIfNoEntry: false });
          if (entry.stat === null) {
            if (current) fail();
            continue;
          }
          if (!current || !sameStat(current, entry.stat)) fail();
          const fd = fs.openSync(entry.path, fileFlags);
          try {
            const bytes = Buffer.alloc(65537);
            const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
            if (
              digest(bytes.subarray(0, count)) !== entry.hash ||
              !sameStat(fs.fstatSync(fd, { bigint: true }), entry.stat)
            )
              fail();
          } finally {
            fs.closeSync(fd);
          }
        }
      };
      return { primary, common, config, workspace, ownershipEntry, verify, close };
    } catch (cause) {
      close();
      throw cause;
    }
  };
  const acquireSnapshot = (worktree = false, owned = true) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => snapshot(worktree, owned),
        catch: (cause) => error(a.primaryRoot, "Cannot verify managed Git metadata.", cause),
      }),
      (value) => Effect.sync(value.close),
    );
  const verify = (value: ReturnType<typeof snapshot>) =>
    Effect.try({
      try: value.verify,
      catch: (cause) => error(a.primaryRoot, "Managed Git metadata changed.", cause),
    });
  const command = Effect.fn("ManagedGitExecution.command")(function* (
    args: ReadonlyArray<string>,
    state: ReturnType<typeof snapshot>,
    metadata = true,
  ) {
    yield* verify(state);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(
            "/usr/bin/git",
            [
              ...hardened,
              ...(metadata
                ? [`--git-dir=${a.commonGitDirectory}`, `--work-tree=${a.primaryRoot}`]
                : []),
              ...args,
            ],
            { cwd: "/", env: environment, extendEnv: false, shell: false, stdin: "ignore" },
          ),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: 262144 }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: 8192 }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (stdout.truncated || stderr.truncated || stdout.invalidUtf8 || stderr.invalidUtf8)
          return yield* deny("Managed Git command returned incomplete output.");
        yield* verify(state);
        return { stdout: stdout.text, code: Number(code) };
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "5 minutes",
        orElse: () =>
          Effect.fail(deny("Managed Git command timed out; partial creation must be reconciled.")),
      }),
      Effect.mapError((cause) =>
        error(
          a.primaryRoot,
          "Managed Git command failed; partial creation must be reconciled.",
          cause,
        ),
      ),
    );
  });
  const supportedConfiguration = Effect.fn("ManagedGitExecution.configuration")(function* (
    state: ReturnType<typeof snapshot>,
  ) {
    const result = yield* command(
      ["config", "--no-includes", "--null", "--list", "--file", state.config.path],
      state,
      false,
    );
    if (result.code !== 0) return yield* deny("Cannot parse managed repository configuration.");
    for (const record of result.stdout.split("\0").filter(Boolean)) {
      const split = record.indexOf("\n");
      const key = record.slice(0, split).toLowerCase();
      const value = record.slice(split + 1);
      if (
        split < 0 ||
        !/^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|safecrlf|eol)|user\.(?:name|email)|init\.defaultbranch|remote\.[^.]+\.(?:url|fetch)|branch\..+\.(?:remote|merge))$/.test(
          key,
        ) ||
        (key === "core.repositoryformatversion" && value !== "0") ||
        (key === "core.bare" && value !== "false")
      )
        return yield* deny(`Unsupported managed Git configuration: ${key || "invalid entry"}.`);
    }
  });
  const validate = Effect.fn("ManagedGitExecution.validate")(function* (
    input: VcsCreateWorktreeInput,
  ) {
    yield* Effect.try({
      try: () => checkInput(input),
      catch: (cause) => error(a.primaryRoot, "Managed worktree input rejected.", cause),
    });
    yield* options.revalidate;
    const state = yield* acquireSnapshot();
    yield* supportedConfiguration(state);
    return state;
  });
  const prepare = (input: VcsCreateWorktreeInput) =>
    Effect.scoped(validate(input).pipe(Effect.as(a.commonGitDirectory)));
  const create = Effect.fn("ManagedGitExecution.create")(function* (input: VcsCreateWorktreeInput) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const state = yield* validate(input);
        const base = yield* command(["rev-parse", "--verify", `${a.baseRef}^{commit}`], state);
        if (base.code !== 0 || base.stdout.trim() !== a.baseOid)
          return yield* deny("Approved local base ref moved or is unavailable.");
        const existingBranch = yield* command(
          ["show-ref", "--verify", "--quiet", a.branchRef],
          state,
        );
        const exists = yield* Effect.try({
          try: () => fs.lstatSync(a.worktreePath, { throwIfNoEntry: false }) !== undefined,
          catch: (cause) => error(a.primaryRoot, "Cannot inspect assigned worktree path.", cause),
        });
        if (prior) {
          if (!exists || existingBranch.code !== 0)
            return yield* deny(
              "Prior workspace registration is missing; manual reconciliation is required.",
            );
        } else {
          const registered = yield* command(["worktree", "list", "--porcelain", "-z"], state);
          if (
            registered.code !== 0 ||
            registered.stdout.split("\0").includes(`worktree ${a.worktreePath}`)
          )
            return yield* deny("Assigned path has an existing worktree registration.");
          if (exists || existingBranch.code !== 1)
            return yield* deny(
              "Assigned worktree path or branch already exists; manual reconciliation is required.",
            );
          yield* Effect.try({
            try: () => {
              if (
                fs.lstatSync(path.join(a.commonGitDirectory, "logs", a.branchRef), {
                  throwIfNoEntry: false,
                })
              )
                throw deny("Assigned branch has an existing reflog.");
            },
            catch: (cause) =>
              error(a.primaryRoot, "Assigned branch ownership is uncertain.", cause),
          });
          yield* options.revalidate;
          const checkedBase = yield* command(
            ["rev-parse", "--verify", `${a.baseRef}^{commit}`],
            state,
          );
          if (checkedBase.code !== 0 || checkedBase.stdout.trim() !== a.baseOid)
            return yield* deny("Approved local base ref moved before mutation.");
          yield* options.revalidate;
          const added = yield* command(
            [
              "worktree",
              "add",
              "--no-track",
              "-b",
              a.branchRef.slice(11),
              a.worktreePath,
              a.baseOid,
            ],
            state,
          );
          if (added.code !== 0)
            return yield* deny(
              "Managed worktree creation failed; partial state is retained for reconciliation.",
            );
          const unowned = yield* acquireSnapshot(true, false);
          yield* options.revalidate;
          yield* verify(unowned);
          yield* Effect.try({
            try: () => {
              if (!unowned.ownershipEntry)
                throw deny("Created worktree ownership path is missing.");
              const fd = fs.openSync(
                unowned.ownershipEntry,
                fs.constants.O_WRONLY |
                  fs.constants.O_CREAT |
                  fs.constants.O_EXCL |
                  fs.constants.O_NOFOLLOW,
                0o600,
              );
              try {
                fs.writeFileSync(fd, owner);
                fs.fsyncSync(fd);
              } finally {
                fs.closeSync(fd);
              }
            },
            catch: (cause) =>
              error(
                a.primaryRoot,
                "Managed ownership receipt could not be written; partial state is retained.",
                cause,
              ),
          });
        }
        const current = yield* acquireSnapshot(true);
        const receipt = current.workspace;
        if (!receipt) return yield* deny("Managed workspace receipt is missing.");
        if (prior && encodeReceipt(receipt) !== priorText)
          return yield* deny("Prior receipt does not match current workspace ownership.");
        const registration = yield* command(["worktree", "list", "--porcelain", "-z"], current);
        if (
          registration.code !== 0 ||
          !registration.stdout.split("\0\0").some((entry) => {
            const fields = entry.split("\0");
            return (
              fields.includes(`worktree ${a.worktreePath}`) &&
              fields.includes(`branch ${a.branchRef}`) &&
              (prior !== undefined || fields.includes(`HEAD ${a.baseOid}`))
            );
          })
        )
          return yield* deny("Assigned worktree is not registered at its approved branch/base.");
        yield* options.revalidate;
        yield* verify(current);
        yield* Effect.suspend(() => options.persistWorkspace(receipt));
        yield* options.revalidate;
        yield* verify(current);
        return { worktree: { path: a.worktreePath, refName: a.branchRef.slice(11) } };
      }),
    );
  });
  const context: ManagedGitExecution = Object.freeze({ [brand]: true as const });
  executions.set(context, { assignment: a, prepare, create });
  return context;
});
