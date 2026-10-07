import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GitCommandError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeCrypto from "node:crypto";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as Managed from "./ManagedGitExecution.ts";
import * as Workflow from "./GitWorkflowService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Registry from "../vcs/VcsDriverRegistry.ts";
import * as Manager from "./GitManager.ts";
import { ServerConfig } from "../config.ts";

const nativeFs = process.getBuiltinModule("fs");
const nativePath = process.getBuiltinModule("path");
const capturedGitPids: number[] = [];
const trackedServices = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) =>
      delegate.spawn(command).pipe(
        Effect.tap((child) =>
          Effect.sync(() => {
            capturedGitPids.push(Number(child.pid));
          }),
        ),
      ),
    );
  }),
).pipe(Layer.provideMerge(NodeServices.layer));
const nativeGit = Effect.fn("ManagedGitExecution.test.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("/usr/bin/git", ["-C", cwd, ...args], {
          env: {
            PATH: "/usr/bin:/bin",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            LC_ALL: "C",
          },
          extendEnv: false,
          shell: false,
          stdin: "ignore",
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: 262144 }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: 8192 }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      expect(Number(code), stderr.text).toBe(0);
      return stdout.text.trim();
    }),
  );
});
const fixture = Effect.fn("ManagedGitExecution.test.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-git-" });
  const primary = path.join(root, "primary");
  yield* fs.makeDirectory(primary);
  yield* nativeGit(primary, ["init", "--initial-branch=main"]);
  yield* nativeGit(primary, ["config", "user.name", "Managed test"]);
  yield* nativeGit(primary, ["config", "user.email", "managed@test.invalid"]);
  yield* fs.writeFileString(path.join(primary, "file.txt"), "base\n");
  yield* nativeGit(primary, ["add", "file.txt"]);
  yield* nativeGit(primary, ["commit", "-m", "base"]);
  const oid = yield* nativeGit(primary, ["rev-parse", "HEAD"]);
  const assignment: Managed.ManagedGitAssignment = {
    effectId: "effect-1",
    runId: "run-1",
    generation: 1,
    primaryRoot: primary,
    commonGitDirectory: path.join(primary, ".git"),
    worktreePath: path.join(root, "assigned-1"),
    branchRef: "refs/heads/assigned-1",
    baseRef: "refs/heads/main",
    baseOid: oid,
    ownershipToken: "owner-1",
    policyHash: "policy-1",
  };
  const input = (a = assignment) => ({
    cwd: a.primaryRoot,
    path: a.worktreePath,
    refName: a.baseRef,
    newRefName: a.branchRef.slice(11),
  });
  return { fs, path, root, primary, oid, assignment, input };
});
const real = Git.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-git-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(trackedServices),
);
const workflowLayer = (
  git: Git.GitVcsDriver["Service"],
  resolve: Registry.VcsDriverRegistry["Service"]["resolve"],
) =>
  Workflow.layer.pipe(
    Layer.provide(Layer.mock(Registry.VcsDriverRegistry)({ resolve })),
    Layer.provide(Layer.succeed(Git.GitVcsDriver, git)),
    Layer.provide(Layer.mock(Manager.GitManager)({})),
  );
const unavailable = (cwd: string) =>
  new GitCommandError({
    operation: "test.authority",
    command: "git",
    cwd,
    detail: "Authority revoked",
  });

describe("Ordinary Git common metadata identity", () => {
  for (const entry of [
    {
      name: "drive-qualified",
      resolve: nativePath.win32.resolve,
      cwd: "C:/repo/linked",
      common: "C:/repo/.git",
      expected: "C:\\repo\\.git",
    },
    {
      name: "UNC",
      resolve: nativePath.win32.resolve,
      cwd: "C:/repo/linked",
      common: "\\\\server\\share\\repo\\.git",
      expected: "\\\\server\\share\\repo\\.git",
    },
    {
      name: "relative Windows",
      resolve: nativePath.win32.resolve,
      cwd: "C:/repo/linked",
      common: "../.git",
      expected: "C:\\repo\\.git",
    },
    {
      name: "absolute POSIX",
      resolve: nativePath.posix.resolve,
      cwd: "/repo/linked",
      common: "/repo/.git",
      expected: "/repo/.git",
    },
    {
      name: "relative POSIX",
      resolve: nativePath.posix.resolve,
      cwd: "/repo/linked",
      common: "../.git",
      expected: "/repo/.git",
    },
  ]) {
    it.effect(
      `resolves ${entry.name} common paths with the host resolver before canonicalization`,
      () =>
        Effect.gen(function* () {
          // Emulate host path semantics only; no Windows filesystem or child is used.
          const resolver = vi.spyOn(nativePath, "resolve").mockImplementation(entry.resolve);
          const canonicalize = vi.spyOn(nativeFs, "realpathSync").mockReturnValue(entry.expected);
          try {
            expect(yield* Managed.canonicalGitMutationKey(entry.common, entry.cwd)).toBe(
              `git\0${entry.expected}`,
            );
            expect(canonicalize).toHaveBeenCalledExactlyOnceWith(entry.expected);
          } finally {
            canonicalize.mockRestore();
            resolver.mockRestore();
          }
        }),
    );
  }

  it.effect(
    "canonicalizes absolute and relative common paths from an ordinary registered linked worktree",
    () =>
      Effect.gen(function* () {
        const firstPid = capturedGitPids.length;
        const f = yield* fixture();
        const linked = f.path.join(f.root, "ordinary-linked");
        yield* nativeGit(f.primary, ["worktree", "add", "-b", "ordinary-linked", linked, f.oid]);
        const primaryCommon = yield* nativeGit(f.primary, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        const linkedCommon = yield* nativeGit(linked, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        const key = yield* Managed.canonicalGitMutationKey(primaryCommon, f.primary);
        expect(yield* Managed.canonicalGitMutationKey(linkedCommon, linked)).toBe(key);
        expect(
          yield* Managed.canonicalGitMutationKey(f.path.relative(linked, linkedCommon), linked),
        ).toBe(key);
        expect(key).toBe(`git\0${nativeFs.realpathSync(f.path.join(f.primary, ".git"))}`);
        const pids = capturedGitPids.slice(firstPid);
        expect(pids.length).toBeGreaterThan(0);
        for (const pid of pids) expect(nativeFs.existsSync(`/proc/${pid}`)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(trackedServices)),
  );
});

describe("Managed Git execution", () => {
  it.effect(
    "creates two actual registered worktrees from the exact base without ordinary discovery",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const git = yield* Git.GitVcsDriver;
        const receipts: Managed.ManagedWorkspaceReceipt[] = [];
        const second = {
          ...f.assignment,
          effectId: "effect-2",
          runId: "run-2",
          ownershipToken: "owner-2",
          branchRef: "refs/heads/assigned-2",
          worktreePath: f.path.join(f.root, "assigned-2"),
        };
        for (const a of [f.assignment, second]) {
          const context = yield* Managed.make({
            assignment: a,
            revalidate: Effect.void,
            persistWorkspace: (receipt) =>
              Effect.sync(() => {
                receipts.push(receipt);
              }),
          });
          const workflow = yield* Effect.service(Workflow.GitWorkflowService).pipe(
            Effect.provide(
              workflowLayer(git, () => Effect.die("Managed path used ordinary discovery")),
            ),
          );
          expect(yield* workflow.createWorktree(f.input(a), { managed: context })).toEqual({
            worktree: { path: a.worktreePath, refName: a.branchRef.slice(11) },
          });
          expect(yield* nativeGit(a.worktreePath, ["rev-parse", "HEAD"])).toBe(f.oid);
          expect(yield* nativeGit(a.worktreePath, ["symbolic-ref", "HEAD"])).toBe(a.branchRef);
        }
        expect(receipts).toHaveLength(2);
        expect(receipts[0]?.common).toEqual(receipts[1]?.common);
        expect(receipts[0]?.worktree.ino).not.toBe(receipts[1]?.worktree.ino);
        expect(receipts[0]?.initialHeadOid).toBe(f.oid);
        yield* Effect.logInfo({ managedWorkspaceReceipts: receipts });
        expect(yield* nativeGit(f.primary, ["worktree", "list", "--porcelain"])).toContain(
          second.worktreePath,
        );
      }).pipe(Effect.provide(real)),
  );

  it.effect("adopts only the exact durable receipt and permits later owned commits", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let receipt: Managed.ManagedWorkspaceReceipt | undefined;
      const context = yield* Managed.make({
        assignment: f.assignment,
        revalidate: Effect.void,
        persistWorkspace: (value) =>
          Effect.sync(() => {
            receipt = value;
          }),
      });
      yield* Managed.createManagedWorktree(context, f.input());
      if (!receipt) return yield* Effect.die("Receipt missing");
      yield* f.fs.writeFileString(
        f.path.join(f.assignment.worktreePath, "file.txt"),
        "worker commit\n",
      );
      yield* nativeGit(f.assignment.worktreePath, ["add", "file.txt"]);
      yield* nativeGit(f.assignment.worktreePath, ["commit", "-m", "worker"]);
      const tip = yield* nativeGit(f.assignment.worktreePath, ["rev-parse", "HEAD"]);
      const config = yield* f.fs.readFileString(
        f.path.join(f.assignment.commonGitDirectory, "config"),
      );
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const observed: string[][] = [];
      const spy = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) observed.push([...command.args]);
        return delegate.spawn(command);
      });
      const adopted = yield* Managed.make({
        assignment: f.assignment,
        priorReceipt: receipt,
        revalidate: Effect.void,
        persistWorkspace: (current) =>
          Effect.sync(() => {
            expect(current).toEqual(receipt);
          }),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spy));
      yield* Managed.createManagedWorktree(adopted, f.input());
      expect(observed.some((args) => args.includes("add"))).toBe(false);
      expect(yield* nativeGit(f.assignment.worktreePath, ["rev-parse", "HEAD"])).toBe(tip);
      expect(
        yield* f.fs.readFileString(f.path.join(f.assignment.commonGitDirectory, "config")),
      ).toBe(config);
    }).pipe(Effect.provide(trackedServices)),
  );

  it.effect(
    "rejects a moved approved local base without creating the assigned path or branch",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(f.path.join(f.primary, "file.txt"), "moved\n");
        yield* nativeGit(f.primary, ["commit", "-am", "moved"]);
        const context = yield* Managed.make({
          assignment: f.assignment,
          revalidate: Effect.void,
          persistWorkspace: () => Effect.die("Unexpected receipt"),
        });
        const result = yield* Managed.createManagedWorktree(context, f.input()).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(yield* f.fs.exists(f.assignment.worktreePath)).toBe(false);
        expect(yield* nativeGit(f.primary, ["branch", "--list", "assigned-1"])).toBe("");
      }).pipe(Effect.provide(trackedServices)),
  );

  for (const kind of ["foreign-path", "foreign-branch", "lost-receipt", "lost-callback"] as const) {
    it.effect(`retains ${kind} untouched and blocks adoption`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        if (kind === "foreign-path") {
          yield* f.fs.makeDirectory(f.assignment.worktreePath);
          yield* f.fs.writeFileString(f.path.join(f.assignment.worktreePath, "marker"), "foreign");
        }
        if (kind === "foreign-branch") yield* nativeGit(f.primary, ["branch", "assigned-1"]);
        const context = yield* Managed.make({
          assignment: f.assignment,
          revalidate: Effect.void,
          persistWorkspace: () =>
            kind === "lost-callback" ? Effect.fail(unavailable(f.primary)) : Effect.void,
        });
        if (kind === "lost-receipt") yield* Managed.createManagedWorktree(context, f.input());
        if (kind === "lost-callback")
          expect(
            (yield* Managed.createManagedWorktree(context, f.input()).pipe(Effect.result))._tag,
          ).toBe("Failure");
        const before = yield* nativeGit(f.primary, ["worktree", "list", "--porcelain"]);
        expect(
          (yield* Managed.createManagedWorktree(context, f.input()).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* nativeGit(f.primary, ["worktree", "list", "--porcelain"])).toBe(before);
        if (kind === "foreign-path")
          expect(yield* f.fs.readFileString(f.path.join(f.assignment.worktreePath, "marker"))).toBe(
            "foreign",
          );
      }).pipe(Effect.provide(trackedServices)),
    );
  }

  for (const [key, value] of [
    ["include.path", "../evil-config"],
    ["includeIf.gitdir:*.path", "../evil-config"],
    ["core.fsmonitor", "marker-helper"],
    ["core.hooksPath", "marker-hooks"],
    ["credential.helper", "marker-helper"],
    ["filter.marker.smudge", "marker-helper"],
    ["filter.marker.process", "marker-helper"],
    ["diff.marker.textconv", "marker-helper"],
    ["diff.marker.command", "marker-helper"],
    ["commit.gpgSign", "true"],
    ["extensions.worktreeConfig", "true"],
    ["extensions.partialClone", "origin"],
    ["remote.origin.promisor", "true"],
    ["core.worktree", "../foreign"],
    ["core.alternateRefsCommand", "marker-helper"],
  ]) {
    it.effect(`rejects unsupported ${key} without a mutation or helper execution`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const marker = f.path.join(f.root, "forbidden");
        yield* f.fs.writeFileString(
          f.path.join(f.primary, "marker-helper"),
          `#!/bin/sh\nprintf forbidden > '${marker}'\n`,
        );
        yield* f.fs.chmod(f.path.join(f.primary, "marker-helper"), 0o755);
        const helper = f.path.join(f.primary, "marker-helper");
        let configured = value!;
        if (configured === "marker-helper") configured = helper;
        if (configured === "../evil-config") {
          configured = f.path.join(f.root, "evil-config");
          yield* f.fs.writeFileString(configured, `[filter "marker"]\n\tsmudge = ${helper}\n`);
        }
        if (configured === "marker-hooks") {
          configured = f.path.join(f.root, "marker-hooks");
          yield* f.fs.makeDirectory(configured);
          yield* f.fs.writeFileString(
            f.path.join(configured, "post-checkout"),
            `#!/bin/sh\nprintf forbidden > '${marker}'\n`,
          );
          yield* f.fs.chmod(f.path.join(configured, "post-checkout"), 0o755);
        }
        yield* nativeGit(f.primary, ["config", key!, configured]);
        const configPath = f.path.join(f.assignment.commonGitDirectory, "config");
        const before = yield* f.fs.readFileString(configPath);
        const context = yield* Managed.make({
          assignment: f.assignment,
          revalidate: Effect.void,
          persistWorkspace: () => Effect.die("Unexpected receipt"),
        });
        expect(
          (yield* Managed.createManagedWorktree(context, f.input()).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.fs.exists(f.assignment.worktreePath)).toBe(false);
        expect(yield* f.fs.exists(marker)).toBe(false);
        expect(yield* f.fs.readFileString(configPath)).toBe(before);
      }).pipe(Effect.provide(trackedServices)),
    );
  }

  it.effect(
    "suppresses actual default checkout hooks and recursive submodules, clearing hostile ambient environment",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const marker = f.path.join(f.root, "forbidden");
        const hook = f.path.join(f.assignment.commonGitDirectory, "hooks", "post-checkout");
        yield* f.fs.writeFileString(hook, `#!/bin/sh\nprintf forbidden > '${marker}'\n`);
        yield* f.fs.chmod(hook, 0o755);
        yield* f.fs.writeFileString(
          f.path.join(f.primary, ".gitmodules"),
          '[submodule "missing"]\n\tpath = missing\n\turl = ext::marker-helper\n',
        );
        yield* f.fs.writeFileString(
          f.path.join(f.primary, ".gitattributes"),
          "file.txt filter=marker diff=marker\n",
        );
        yield* nativeGit(f.primary, ["add", ".gitmodules", ".gitattributes"]);
        yield* nativeGit(f.primary, ["commit", "-m", "attributes and submodules"]);
        const a = { ...f.assignment, baseOid: yield* nativeGit(f.primary, ["rev-parse", "HEAD"]) };
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pids: number[] = [];
        const spy = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command)) {
              expect(command.command).toBe("/usr/bin/git");
              expect(command.options.extendEnv).toBe(false);
              expect(command.options.shell).toBe(false);
              expect(command.options.env).not.toHaveProperty("HOME");
              expect(command.options.env).not.toHaveProperty("LD_PRELOAD");
              expect(command.args).not.toContain("fetch");
              expect(command.args).not.toContain("submodule");
              expect(command.options.env).toHaveProperty("GIT_NO_LAZY_FETCH", "1");
            }
            const child = yield* delegate.spawn(command);
            pids.push(Number(child.pid));
            return child;
          }),
        );
        const context = yield* Managed.make({
          assignment: a,
          revalidate: Effect.void,
          persistWorkspace: () => Effect.void,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spy));
        yield* Managed.createManagedWorktree(context, f.input(a));
        expect(yield* f.fs.exists(marker)).toBe(false);
        expect(yield* f.fs.exists(f.path.join(a.worktreePath, "missing", ".git"))).toBe(false);
        for (const pid of pids) expect(nativeFs.existsSync(`/proc/${pid}`)).toBe(false);
      }).pipe(Effect.provide(trackedServices)),
  );

  it.effect(
    "revocation while queued uses the same common permit as an ordinary linked-worktree mutation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* nativeGit(f.primary, [
          "worktree",
          "add",
          "-b",
          "other",
          f.path.join(f.root, "other"),
          f.oid,
        ]);
        const git = yield* Git.GitVcsDriver;
        const driver = yield* Git.makeVcsDriver;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const preparing = yield* Deferred.make<void>();
        let revoked = false;
        let checks = 0;
        const context = yield* Managed.make({
          assignment: f.assignment,
          revalidate: Effect.suspend(() => {
            checks++;
            return revoked
              ? Effect.fail(unavailable(f.primary))
              : Deferred.succeed(preparing, undefined).pipe(Effect.asVoid);
          }),
          persistWorkspace: () => Effect.die("Unexpected receipt"),
        });
        const registry = Registry.VcsDriverRegistry.of({
          get: () => Effect.succeed(driver),
          detect: () => Effect.succeed(null),
          resolve: ({ cwd }) =>
            driver
              .detectRepository(cwd)
              .pipe(
                Effect.flatMap((repository) =>
                  repository
                    ? Effect.succeed({ kind: "git" as const, repository, driver })
                    : Effect.die("Repository missing"),
                ),
              ),
        });
        yield* Effect.gen(function* () {
          const service = yield* Workflow.GitWorkflowService;
          const held = yield* service
            .withRepositoryPermit(
              "test",
              f.path.join(f.root, "other"),
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const queued = yield* service
            .createWorktree(f.input(), { managed: context })
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(preparing);
          revoked = true;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(held);
          expect((yield* Fiber.join(queued))._tag).toBe("Failure");
          expect(checks).toBeGreaterThanOrEqual(2);
          expect(yield* f.fs.exists(f.assignment.worktreePath)).toBe(false);
        }).pipe(
          Effect.provide(
            Workflow.layer.pipe(
              Layer.provide(Layer.succeed(Registry.VcsDriverRegistry, registry)),
              Layer.provide(Layer.succeed(Git.GitVcsDriver, git)),
              Layer.provide(Layer.mock(Manager.GitManager)({})),
            ),
          ),
        );
      }).pipe(Effect.provide(real)),
  );

  for (const kind of ["pointer", "config", "ownership", "branch", "directory"] as const) {
    it.effect(`blocks ${kind} substitution against a persisted receipt without repair`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const receipts: Managed.ManagedWorkspaceReceipt[] = [];
        const context = yield* Managed.make({
          assignment: f.assignment,
          revalidate: Effect.void,
          persistWorkspace: (receipt) =>
            Effect.sync(() => {
              receipts.push(receipt);
            }),
        });
        yield* Managed.createManagedWorktree(context, f.input());
        const prior = receipts[0];
        if (!prior) return yield* Effect.die("Receipt missing");
        const pointer = f.path.join(f.assignment.worktreePath, ".git");
        const owner = f.path.join(prior.gitDirectory.path, "t3-managed-owner");
        const config = f.path.join(f.assignment.commonGitDirectory, "config");
        let observed: string;
        if (kind === "pointer") {
          observed = pointer;
          yield* f.fs.writeFileString(pointer, `gitdir: ${f.assignment.commonGitDirectory}\n`);
        } else if (kind === "config") {
          observed = config;
          yield* nativeGit(f.primary, ["config", "user.name", "Changed configuration"]);
        } else if (kind === "ownership") {
          observed = owner;
          yield* f.fs.writeFileString(owner, "foreign-owner");
        } else if (kind === "branch") {
          observed = f.path.join(prior.gitDirectory.path, "HEAD");
          yield* f.fs.writeFileString(observed, "ref: refs/heads/main\n");
        } else {
          const saved = f.assignment.worktreePath + "-saved";
          yield* f.fs.rename(f.assignment.worktreePath, saved);
          yield* f.fs.makeDirectory(f.assignment.worktreePath);
          yield* f.fs.copyFile(f.path.join(saved, ".git"), pointer);
          observed = pointer;
        }
        const before = yield* f.fs.readFileString(observed);
        const adopted = yield* Managed.make({
          assignment: f.assignment,
          priorReceipt: prior,
          revalidate: Effect.void,
          persistWorkspace: () => Effect.die("Unexpected adoption"),
        });
        expect(
          (yield* Managed.createManagedWorktree(adopted, f.input()).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.fs.readFileString(observed)).toBe(before);
      }).pipe(Effect.provide(trackedServices)),
    );
  }

  it.effect("denies a commondir in assigned common metadata before any managed Git child", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const entry = f.path.join(f.assignment.commonGitDirectory, "commondir");
      yield* f.fs.writeFileString(entry, "unsupported\n");
      let spawned = false;
      const spawner = ChildProcessSpawner.make(() => {
        spawned = true;
        return Effect.die("Managed Git must not start for redirected common metadata");
      });
      const context = yield* Managed.make({
        assignment: f.assignment,
        revalidate: Effect.void,
        persistWorkspace: () => Effect.die("Unexpected receipt"),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      expect(
        (yield* Managed.prepareManagedGitExecution(context, f.input()).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* Managed.createManagedWorktree(context, f.input()).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(spawned).toBe(false);
      expect(yield* f.fs.readFileString(entry)).toBe("unsupported\n");
      expect(yield* f.fs.exists(f.assignment.worktreePath)).toBe(false);
    }).pipe(Effect.provide(trackedServices)),
  );

  for (const layout of [
    "alternates",
    "http-alternates",
    "promisor",
    "worktree-config",
    "config-symlink",
    "dangling-path",
    "stale-registration",
    "logs-redirect",
  ] as const) {
    it.effect(`rejects unsupported ${layout} layout without creating its branch`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const common = f.assignment.commonGitDirectory;
        if (layout === "alternates" || layout === "http-alternates")
          yield* f.fs.writeFileString(
            f.path.join(common, "objects", "info", layout),
            f.primary + "\n",
          );
        if (layout === "promisor")
          yield* f.fs.writeFileString(
            f.path.join(common, "objects", "pack", "marker.promisor"),
            "",
          );
        if (layout === "worktree-config")
          yield* f.fs.writeFileString(
            f.path.join(common, "config.worktree"),
            "[core]\nfsmonitor = marker\n",
          );
        if (layout === "config-symlink") {
          const saved = f.path.join(f.root, "saved-config");
          yield* f.fs.rename(f.path.join(common, "config"), saved);
          yield* f.fs.symlink(saved, f.path.join(common, "config"));
        }
        if (layout === "dangling-path")
          yield* f.fs.symlink(f.path.join(f.root, "missing"), f.assignment.worktreePath);
        if (layout === "stale-registration") {
          yield* nativeGit(f.primary, [
            "worktree",
            "add",
            "-b",
            "foreign",
            f.assignment.worktreePath,
            f.oid,
          ]);
          yield* f.fs.remove(f.assignment.worktreePath, { recursive: true });
        }
        if (layout === "logs-redirect") {
          const foreign = f.path.join(f.root, "foreign-logs");
          yield* f.fs.makeDirectory(foreign);
          yield* f.fs.rename(
            f.path.join(common, "logs", "refs", "heads"),
            f.path.join(common, "saved-head-logs"),
          );
          yield* f.fs.symlink(foreign, f.path.join(common, "logs", "refs", "heads"));
        }
        const context = yield* Managed.make({
          assignment: f.assignment,
          revalidate: Effect.void,
          persistWorkspace: () => Effect.die("Unexpected receipt"),
        });
        expect(
          (yield* Managed.createManagedWorktree(context, f.input()).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* nativeGit(f.primary, ["branch", "--list", "assigned-1"])).toBe("");
      }).pipe(Effect.provide(trackedServices)),
    );
  }

  for (const check of [2, 3, 4, 5, 6]) {
    it.effect(`retains the correct state when authority is revoked at check ${check}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let count = 0;
        let persisted = false;
        const context = yield* Managed.make({
          assignment: f.assignment,
          revalidate: Effect.suspend(() =>
            ++count === check ? Effect.fail(unavailable(f.primary)) : Effect.void,
          ),
          persistWorkspace: () =>
            Effect.sync(() => {
              persisted = true;
            }),
        });
        expect(
          (yield* Managed.createManagedWorktree(context, f.input()).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(count).toBe(check);
        expect(yield* f.fs.exists(f.assignment.worktreePath)).toBe(check >= 4);
        expect(persisted).toBe(check === 6);
        if (check >= 4) {
          const retry = yield* Managed.make({
            assignment: f.assignment,
            revalidate: Effect.void,
            persistWorkspace: () => Effect.die("Unexpected retry adoption"),
          });
          expect(
            (yield* Managed.createManagedWorktree(retry, f.input()).pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
      }).pipe(Effect.provide(trackedServices)),
    );
  }

  it.effect(
    "holds ordinary linked-worktree mutation until managed receipt persistence finishes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const git = yield* Git.GitVcsDriver;
        const driver = yield* Git.makeVcsDriver;
        const other = f.path.join(f.root, "other");
        yield* nativeGit(f.primary, ["worktree", "add", "-b", "other", other, f.oid]);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const resolving = yield* Deferred.make<void>();
        const context = yield* Managed.make({
          assignment: f.assignment,
          revalidate: Effect.void,
          persistWorkspace: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        });
        const resolve: Registry.VcsDriverRegistry["Service"]["resolve"] = ({ cwd }) =>
          driver.detectRepository(cwd).pipe(
            Effect.flatMap((repository) =>
              repository
                ? Effect.succeed({ kind: "git" as const, repository, driver })
                : Effect.die("Missing repository"),
            ),
            Effect.tap(() => Deferred.succeed(resolving, undefined)),
          );
        let ordinaryEntered = false;
        const observedDriver = {
          ...git,
          renameBranch: (input: Parameters<typeof git.renameBranch>[0]) =>
            Effect.sync(() => {
              ordinaryEntered = true;
            }).pipe(Effect.andThen(git.renameBranch(input))),
        };
        yield* Effect.gen(function* () {
          const workflow = yield* Workflow.GitWorkflowService;
          const managed = yield* workflow
            .createWorktree(f.input(), { managed: context })
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const ordinary = yield* workflow
            .renameBranch({ cwd: other, oldBranch: "other", newBranch: "renamed-other" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(resolving);
          yield* Effect.yieldNow;
          expect(ordinaryEntered).toBe(false);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(managed);
          yield* Fiber.join(ordinary);
          expect(ordinaryEntered).toBe(true);
          expect(yield* nativeGit(other, ["branch", "--show-current"])).toBe("renamed-other");
        }).pipe(Effect.provide(workflowLayer(observedDriver, resolve)));
      }).pipe(Effect.provide(real)),
  );

  it.effect(
    "rejects mismatched assigned input and mutated assignment values before Git discovery",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const a = { ...f.assignment };
        const context = yield* Managed.make({
          assignment: a,
          revalidate: Effect.void,
          persistWorkspace: () => Effect.die("Unexpected receipt"),
        });
        a.worktreePath = f.path.join(f.root, "different");
        expect(
          (yield* Managed.createManagedWorktree(context, f.input(a)).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* Managed.createManagedWorktree(context, { ...f.input(), cwd: f.root }).pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Managed.createManagedWorktree(context, {
            ...f.input(),
            newRefName: "foreign",
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.fs.exists(f.assignment.worktreePath)).toBe(false);
        expect(yield* f.fs.exists(a.worktreePath)).toBe(false);
      }).pipe(Effect.provide(trackedServices)),
  );

  it.effect("is explicitly unavailable on unsupported hosts", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(
        (yield* Managed.make({
          assignment: f.assignment,
          revalidate: Effect.void,
          persistWorkspace: () => Effect.void,
        }).pipe(Effect.provideService(HostProcessPlatform, "darwin"), Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(trackedServices)),
  );
  it.effect("joins every captured native Git child before releasing fixtures", () =>
    Effect.gen(function* () {
      expect(capturedGitPids.length).toBeGreaterThan(200);
      for (const pid of capturedGitPids) expect(nativeFs.existsSync(`/proc/${pid}`)).toBe(false);
      yield* Effect.logInfo({ capturedGitPids, drained: true });
    }),
  );
});

const encodeVerificationOwner = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      effectId: Schema.String,
      runId: Schema.String,
      generation: Schema.Int,
      primaryRoot: Schema.String,
      commonGitDirectory: Schema.String,
      worktreePath: Schema.String,
      branchRef: Schema.String,
      baseRef: Schema.String,
      baseOid: Schema.String,
      ownershipToken: Schema.String,
      policyHash: Schema.String,
    }),
  ),
);

// Actual temporary ownership metadata; Git answers are injected, not native Git proof.
const verificationFixture = Effect.fn("ManagedGitExecution.test.verificationFixture")(function* () {
  const filesystem = yield* FileSystem.FileSystem;
  const directory = yield* filesystem.makeTempDirectoryScoped({
    prefix: "t3-verification-target-",
  });
  const primary = nativePath.join(directory, "primary");
  const common = nativePath.join(primary, ".git");
  const assigned = nativePath.join(directory, "assigned");
  const metadata = nativePath.join(common, "worktrees", "assigned");
  for (const entry of [
    primary,
    common,
    assigned,
    metadata,
    nativePath.join(common, "objects"),
    nativePath.join(common, "refs", "heads"),
  ])
    yield* filesystem.makeDirectory(entry, { recursive: true });
  const base = "1".repeat(40);
  const head = "2".repeat(40);
  const tree = "3".repeat(40);
  const assignment: Managed.ManagedGitAssignment = {
    effectId: "verification-effect",
    runId: "settled-run",
    generation: 1,
    primaryRoot: primary,
    commonGitDirectory: common,
    worktreePath: assigned,
    branchRef: "refs/heads/assigned",
    baseRef: "refs/heads/main",
    baseOid: base,
    ownershipToken: "retained-owner",
    policyHash: "policy",
  };
  const config = nativePath.join(common, "config");
  const entries = [
    [config, "[core]\nrepositoryformatversion = 0\nbare = false\n"],
    [nativePath.join(assigned, ".git"), `gitdir: ${metadata}\n`],
    [nativePath.join(metadata, "gitdir"), `${assigned}/.git\n`],
    [nativePath.join(metadata, "commondir"), "../..\n"],
    [nativePath.join(metadata, "HEAD"), `ref: ${assignment.branchRef}\n`],
    [nativePath.join(metadata, "t3-managed-owner"), encodeVerificationOwner(assignment)],
  ] as const;
  for (const [entry, text] of entries) yield* filesystem.writeFileString(entry, text);
  yield* filesystem.writeFileString(nativePath.join(common, assignment.baseRef), base + "\n");
  yield* filesystem.writeFileString(nativePath.join(common, assignment.branchRef), head + "\n");
  const sha = (bytes: string) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const inode = (entry: string) => {
    const stat = nativeFs.statSync(entry, { bigint: true });
    return { path: entry, dev: String(stat.dev), ino: String(stat.ino) };
  };
  const fingerprint = entries.map(([entry, text]) => {
    const stat = inode(entry);
    return `${entry}\0${stat.dev}\0${stat.ino}\0${sha(text)}`;
  });
  const receipt: Managed.ManagedWorkspaceReceipt = {
    assignment,
    primary: inode(primary),
    common: inode(common),
    worktree: inode(assigned),
    gitDirectory: inode(metadata),
    initialHeadOid: base,
    pointerAndConfigurationHash: sha(
      ["absent", fingerprint[0], "absent", ...fingerprint.slice(1), "absent"].join("\n"),
    ),
  };
  const commands: ChildProcess.StandardCommand[] = [];
  const answers = {
    base,
    head,
    worktreeHead: head,
    tree,
    beforeRead: (_command: ChildProcess.StandardCommand) => {},
    registration: null as string | null,
    status: "",
    indexCode: 0,
    trackedCode: 0,
    unmerged: "",
    untracked: "",
    tracked: "H file.txt\0",
    config: "core.repositoryformatversion\n0\0core.bare\nfalse\0",
    mergeCode: 0,
    ancestorCode: 0,
    combinedHead: "4".repeat(40),
    combinedTree: "5".repeat(40),
  };
  const spawner = ChildProcessSpawner.make((input) => {
    if (!ChildProcess.isStandardCommand(input)) throw Error("No pipeline accepted");
    commands.push(input);
    answers.beforeRead(input);
    let stdout = "";
    let code = 0;
    if (input.args.includes("config")) stdout = answers.config;
    else if (input.args.includes("rev-parse")) {
      const ref = input.args.at(-1);
      stdout =
        (ref === `${assignment.baseRef}^{commit}`
          ? answers.base
          : ref === "HEAD^{tree}"
            ? answers.tree
            : ref === "HEAD^{commit}"
              ? answers.worktreeHead
              : answers.head) + "\n";
    } else if (input.args.includes("worktree"))
      stdout =
        answers.registration ??
        `worktree ${assigned}\0HEAD ${answers.head}\0branch ${assignment.branchRef}\0\0`;
    else if (input.args.includes("status")) stdout = answers.status;
    else if (input.args.includes("diff"))
      code = input.args.includes("--cached") ? answers.indexCode : answers.trackedCode;
    else if (input.args.includes("ls-files"))
      stdout = input.args.includes("--unmerged")
        ? answers.unmerged
        : input.args.includes("--others")
          ? answers.untracked
          : answers.tracked;
    else if (input.args.includes("merge-base")) code = answers.ancestorCode;
    else if (input.args.includes("merge")) {
      code = answers.mergeCode;
      if (code === 0) {
        answers.head = answers.combinedHead;
        answers.worktreeHead = answers.combinedHead;
        answers.tree = answers.combinedTree;
      }
    } else throw Error("Unexpected injected command");
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return {
    filesystem,
    directory,
    assignment,
    receipt,
    config,
    assigned,
    metadata,
    base,
    head,
    tree,
    commands,
    answers,
    spawner,
  };
});

describe("Managed verification target capture (synthetic Git)", () => {
  it.effect("requires a retained receipt and does not call persistence or any Git command", () =>
    Effect.gen(function* () {
      const fixture = yield* verificationFixture();
      let persisted = false;
      let used = false;
      const context = yield* Managed.make({
        assignment: fixture.assignment,
        revalidate: Effect.void,
        persistWorkspace: () =>
          Effect.sync(() => {
            persisted = true;
          }),
      }).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixture.spawner),
      );
      const result = yield* Managed.withManagedVerificationTarget(context, () =>
        Effect.sync(() => {
          used = true;
        }),
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(persisted).toBe(false);
      expect(used).toBe(false);
      expect(fixture.commands).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const verificationContext = Effect.fn("ManagedGitExecution.test.verificationContext")(function* (
  fixture: Effect.Success<ReturnType<typeof verificationFixture>>,
  revalidate: Effect.Effect<void, GitCommandError> = Effect.void,
  receipt: Managed.ManagedWorkspaceReceipt = fixture.receipt,
) {
  return yield* Managed.make({
    assignment: fixture.assignment,
    priorReceipt: receipt,
    revalidate,
    persistWorkspace: () => Effect.die("Verification must not persist workspace ownership"),
  }).pipe(
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixture.spawner),
  );
});

describe("Managed verification target capture (synthetic Git)", () => {
  it.effect(
    "captures one exact clean committed assigned target without granting execution or changing ownership",
    () =>
      Effect.gen(function* () {
        const fixture = yield* verificationFixture();
        let authorityReads = 0;
        const context = yield* verificationContext(
          fixture,
          Effect.sync(() => {
            authorityReads += 1;
          }),
        );
        const result = yield* Managed.withManagedVerificationTarget(context, (target) =>
          Effect.sync(() => {
            expect(target).toEqual({
              receipt: fixture.receipt,
              cwd: fixture.assigned,
              baseSha: fixture.base,
              headSha: fixture.head,
              testedCommit: fixture.head,
              testedTree: fixture.tree,
            });
            expect(Object.isFrozen(target)).toBe(true);
            expect(Object.isFrozen(target.receipt)).toBe(true);
            expect(Object.isFrozen(target.receipt.assignment)).toBe(true);
            expect(Object.isFrozen(target.receipt.worktree)).toBe(true);
            expect(target.receipt).not.toBe(fixture.receipt);
            expect(Reflect.set(target, "headSha", "4".repeat(40))).toBe(false);
            expect(Reflect.set(target.receipt.assignment, "ownershipToken", "foreign")).toBe(false);
            return "persisted selection";
          }),
        );
        expect(result).toBe("persisted selection");
        expect(authorityReads).toBeGreaterThanOrEqual(4);
        expect(fixture.commands.length).toBeGreaterThan(0);
        for (const command of fixture.commands) {
          expect(command.command).toBe("/usr/bin/git");
          expect(command.options).toMatchObject({
            cwd: "/",
            shell: false,
            extendEnv: false,
            stdin: "ignore",
            env: {
              GIT_NO_LAZY_FETCH: "1",
              GIT_NO_REPLACE_OBJECTS: "1",
              GIT_OPTIONAL_LOCKS: "0",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          });
          expect(command.args).not.toContain("add");
          expect(command.args).not.toContain("write-tree");
          expect(command.args).not.toContain("fetch");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const verificationFds = (directory: string) =>
  nativeFs.readdirSync("/proc/self/fd").filter((entry) => {
    try {
      return nativeFs.readlinkSync(`/proc/self/fd/${entry}`) === directory;
    } catch {
      return false;
    }
  });
const noVerificationUse = Effect.fn("ManagedGitExecution.test.noVerificationUse")(function* (
  fixture: Effect.Success<ReturnType<typeof verificationFixture>>,
  context: Managed.ManagedGitExecution,
) {
  let used = false;
  const result = yield* Managed.withManagedVerificationTarget(context, () =>
    Effect.sync(() => {
      used = true;
    }),
  ).pipe(Effect.result);
  expect(result._tag).toBe("Failure");
  expect(used).toBe(false);
  expect(verificationFds(fixture.assigned)).toEqual([]);
  expect(verificationFds(fixture.metadata)).toEqual([]);
});

describe("Managed verification target capture (synthetic Git)", () => {
  for (const state of [
    "staged",
    "tracked",
    "conflict",
    "untracked",
    "ignored input",
    "skip-worktree",
    "assume-unchanged",
    "incomplete index output",
    "truncated output",
  ] as const) {
    it.effect(`rejects ${state} even if other injected cleanliness answers say clean`, () =>
      Effect.gen(function* () {
        const fixture = yield* verificationFixture();
        const context = yield* verificationContext(fixture);
        switch (state) {
          case "staged":
            fixture.answers.indexCode = 1;
            break;
          case "tracked":
            fixture.answers.trackedCode = 1;
            break;
          case "conflict":
            fixture.answers.unmerged = "100644 object 1\tconflicted.txt\0";
            break;
          case "untracked":
            fixture.answers.untracked = "untracked.txt\0";
            break;
          case "ignored input":
            fixture.answers.untracked = "node_modules/dependency/index.js\0";
            break;
          case "skip-worktree":
            fixture.answers.tracked = "S hidden.txt\0";
            break;
          case "assume-unchanged":
            fixture.answers.tracked = "h hidden.txt\0";
            break;
          case "incomplete index output":
            fixture.answers.tracked = "H incomplete.txt";
            break;
          case "truncated output":
            fixture.answers.status = "x".repeat(262145);
            break;
        }
        yield* noVerificationUse(fixture, context);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
  for (const state of [
    "moved base",
    "worktree HEAD mismatch",
    "missing base",
    "malformed tree",
    "duplicate registration",
    "wrong registered commit",
    "unsupported configuration",
  ] as const) {
    it.effect(`rejects ${state} before callback persistence`, () =>
      Effect.gen(function* () {
        const fixture = yield* verificationFixture();
        const context = yield* verificationContext(fixture);
        switch (state) {
          case "moved base":
            fixture.answers.base = "4".repeat(40);
            break;
          case "worktree HEAD mismatch":
            fixture.answers.worktreeHead = "4".repeat(40);
            break;
          case "missing base":
            fixture.answers.base = "";
            break;
          case "malformed tree":
            fixture.answers.tree = "not-a-tree";
            break;
          case "duplicate registration":
            fixture.answers.registration = `worktree ${fixture.assigned}\0HEAD ${fixture.head}\0branch ${fixture.assignment.branchRef}\0\0worktree ${fixture.assigned}\0HEAD ${fixture.head}\0branch ${fixture.assignment.branchRef}\0\0`;
            break;
          case "wrong registered commit":
            fixture.answers.registration = `worktree ${fixture.assigned}\0HEAD ${fixture.base}\0branch ${fixture.assignment.branchRef}\0\0`;
            break;
          case "unsupported configuration":
            fixture.answers.config += "include.path\n/foreign/config\0";
            break;
        }
        yield* noVerificationUse(fixture, context);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
  for (const state of [
    "missing marker",
    "foreign marker",
    "pointer redirection",
    "worktree replacement",
    "config replacement",
    "common pointer",
    "worktree configuration",
    "ref ancestor redirect",
  ] as const) {
    it.effect(`rejects actual temporary ${state} ownership changes before callback`, () =>
      Effect.gen(function* () {
        const fixture = yield* verificationFixture();
        const context = yield* verificationContext(fixture);
        switch (state) {
          case "missing marker":
            nativeFs.unlinkSync(nativePath.join(fixture.metadata, "t3-managed-owner"));
            break;
          case "foreign marker":
            nativeFs.writeFileSync(
              nativePath.join(fixture.metadata, "t3-managed-owner"),
              "foreign",
            );
            break;
          case "pointer redirection":
            nativeFs.writeFileSync(nativePath.join(fixture.assigned, ".git"), "gitdir: /foreign\n");
            break;
          case "worktree replacement":
            nativeFs.renameSync(fixture.assigned, fixture.assigned + "-original");
            nativeFs.mkdirSync(fixture.assigned);
            nativeFs.writeFileSync(
              nativePath.join(fixture.assigned, ".git"),
              `gitdir: ${fixture.metadata}\n`,
            );
            break;
          case "config replacement":
            nativeFs.renameSync(fixture.config, fixture.config + "-original");
            nativeFs.writeFileSync(
              fixture.config,
              "[core]\nrepositoryformatversion = 0\nbare = false\n",
            );
            break;
          case "common pointer":
            nativeFs.writeFileSync(
              nativePath.join(fixture.assignment.commonGitDirectory, "commondir"),
              "/foreign\n",
            );
            break;
          case "worktree configuration":
            nativeFs.writeFileSync(
              nativePath.join(fixture.metadata, "config.worktree"),
              "[core]\nbare=false\n",
            );
            break;
          case "ref ancestor redirect": {
            const heads = nativePath.join(fixture.assignment.commonGitDirectory, "refs", "heads");
            nativeFs.renameSync(heads, heads + "-original");
            nativeFs.symlinkSync(heads + "-original", heads);
            break;
          }
        }
        yield* noVerificationUse(fixture, context);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
  it.effect("rejects a mismatched retained identity without rediscovering or adopting it", () =>
    Effect.gen(function* () {
      const fixture = yield* verificationFixture();
      const context = yield* verificationContext(fixture, Effect.void, {
        ...fixture.receipt,
        worktree: { ...fixture.receipt.worktree, ino: "foreign-inode" },
      });
      yield* noVerificationUse(fixture, context);
      expect(fixture.commands).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("does not treat settled ownership as current authority", () =>
    Effect.gen(function* () {
      const fixture = yield* verificationFixture();
      const context = yield* verificationContext(
        fixture,
        Effect.fail(unavailable(fixture.assigned)),
      );
      yield* noVerificationUse(fixture, context);
      expect(fixture.commands).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "revalidates current authority after the captured read before calling persistence",
    () =>
      Effect.gen(function* () {
        const fixture = yield* verificationFixture();
        let count = 0;
        const context = yield* verificationContext(
          fixture,
          Effect.suspend(() =>
            ++count > 1 ? Effect.fail(unavailable(fixture.assigned)) : Effect.void,
          ),
        );
        yield* noVerificationUse(fixture, context);
        expect(fixture.commands.length).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  for (const state of [
    "base",
    "head",
    "tree",
    "dirty",
    "physical worktree",
    "marker",
    "authority",
  ] as const) {
    it.effect(
      `holds ownership handles through persistence and rejects ${state} changes afterward`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* verificationFixture();
          let allowed = true;
          let used = false;
          const context = yield* verificationContext(
            fixture,
            Effect.suspend(() =>
              allowed ? Effect.void : Effect.fail(unavailable(fixture.assigned)),
            ),
          );
          const result = yield* Managed.withManagedVerificationTarget(context, () =>
            Effect.sync(() => {
              used = true;
              expect(verificationFds(fixture.assigned).length).toBeGreaterThan(0);
              expect(verificationFds(fixture.metadata).length).toBeGreaterThan(0);
              switch (state) {
                case "base":
                  fixture.answers.base = "4".repeat(40);
                  break;
                case "head":
                  fixture.answers.head = fixture.answers.worktreeHead = "4".repeat(40);
                  break;
                case "tree":
                  fixture.answers.tree = "4".repeat(40);
                  break;
                case "dirty":
                  fixture.answers.status = " M file.txt\0";
                  break;
                case "physical worktree":
                  nativeFs.renameSync(fixture.assigned, fixture.assigned + "-moved");
                  nativeFs.mkdirSync(fixture.assigned);
                  break;
                case "marker":
                  nativeFs.writeFileSync(
                    nativePath.join(fixture.metadata, "t3-managed-owner"),
                    "foreign",
                  );
                  break;
                case "authority":
                  allowed = false;
                  break;
              }
              return "cannot report successful persistence";
            }),
          ).pipe(Effect.result);
          expect(used).toBe(true);
          expect(result._tag).toBe("Failure");
          expect(verificationFds(fixture.assigned)).toEqual([]);
          expect(verificationFds(fixture.metadata)).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
  it.effect(
    "rechecks commit and tree refs around the clean read before granting the callback",
    () =>
      Effect.gen(function* () {
        const fixture = yield* verificationFixture();
        const context = yield* verificationContext(fixture);
        fixture.answers.beforeRead = (command) => {
          if (command.args.includes("status"))
            fixture.answers.head = fixture.answers.worktreeHead = "4".repeat(40);
        };
        yield* noVerificationUse(fixture, context);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "preserves a callback failure while still rechecking and releasing retained handles",
    () =>
      Effect.gen(function* () {
        const fixture = yield* verificationFixture();
        let reads = 0;
        const context = yield* verificationContext(
          fixture,
          Effect.sync(() => {
            reads += 1;
          }),
        );
        const failure = new Error("Selection persistence failed");
        const result = yield* Managed.withManagedVerificationTarget(context, () =>
          Effect.fail(failure),
        ).pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure });
        expect(reads).toBeGreaterThanOrEqual(4);
        expect(verificationFds(fixture.assigned)).toEqual([]);
        expect(verificationFds(fixture.metadata)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Managed verification target capture (synthetic Git)", () => {
  it.effect(
    "rejects ambiguous assigned registration fields rather than accepting any matching HEAD",
    () =>
      Effect.gen(function* () {
        const fixture = yield* verificationFixture();
        const context = yield* verificationContext(fixture);
        fixture.answers.registration = `worktree ${fixture.assigned}\0HEAD ${fixture.head}\0HEAD ${fixture.base}\0branch ${fixture.assignment.branchRef}\0\0`;
        yield* noVerificationUse(fixture, context);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Managed verification target capture (synthetic Git)", () => {
  for (const window of ["entry", "exit"] as const) {
    for (const change of ["base", "head", "untracked", "unchanged"] as const) {
      it.effect(`rescans ${change} after the held ${window} authority check`, () =>
        Effect.gen(function* () {
          const fixture = yield* verificationFixture();
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let authorityReads = 0;
          let used = false;
          const context = yield* verificationContext(
            fixture,
            Effect.suspend(() => {
              authorityReads += 1;
              return authorityReads === (window === "entry" ? 2 : 4)
                ? Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void;
            }),
          );
          const fiber = yield* Managed.withManagedVerificationTarget(context, (target) =>
            Effect.sync(() => {
              used = true;
              expect(target.headSha).toBe(fixture.head);
              return "persisted";
            }),
          ).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(held);
          yield* Effect.sync(() => {
            expect(used).toBe(window === "exit");
            expect(verificationFds(fixture.assigned).length).toBeGreaterThan(0);
            expect(verificationFds(fixture.metadata).length).toBeGreaterThan(0);
            switch (change) {
              case "base":
                nativeFs.writeFileSync(
                  nativePath.join(
                    fixture.assignment.commonGitDirectory,
                    fixture.assignment.baseRef,
                  ),
                  "4".repeat(40) + "\n",
                );
                fixture.answers.base = "4".repeat(40);
                break;
              case "head":
                nativeFs.writeFileSync(
                  nativePath.join(
                    fixture.assignment.commonGitDirectory,
                    fixture.assignment.branchRef,
                  ),
                  "4".repeat(40) + "\n",
                );
                fixture.answers.head = fixture.answers.worktreeHead = "4".repeat(40);
                break;
              case "untracked":
                nativeFs.writeFileSync(nativePath.join(fixture.assigned, "generated.txt"), "input");
                fixture.answers.status = "?? generated.txt\0";
                fixture.answers.untracked = "generated.txt\0";
                break;
              case "unchanged":
                break;
            }
          }).pipe(Effect.onExit(() => Deferred.succeed(release, undefined)));
          const result = yield* Fiber.join(fiber);
          expect(result._tag).toBe(change === "unchanged" ? "Success" : "Failure");
          expect(used).toBe(window === "exit" || change === "unchanged");
          expect(verificationFds(fixture.assigned)).toEqual([]);
          expect(verificationFds(fixture.metadata)).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    }
  }
  it.effect("releases handles when a callback throws synchronously", () =>
    Effect.gen(function* () {
      const fixture = yield* verificationFixture();
      let authorityReads = 0;
      const context = yield* verificationContext(
        fixture,
        Effect.sync(() => {
          authorityReads += 1;
        }),
      );
      const failure = new Error("Synchronous persistence defect");
      const result = yield* Managed.withManagedVerificationTarget(
        context,
        (): Effect.Effect<never> => {
          throw failure;
        },
      ).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      expect(authorityReads).toBe(4);
      expect(verificationFds(fixture.assigned)).toEqual([]);
      expect(verificationFds(fixture.metadata)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("releases handles when the held entry authority check is interrupted", () =>
    Effect.gen(function* () {
      const fixture = yield* verificationFixture();
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let authorityReads = 0;
      let used = false;
      const context = yield* verificationContext(
        fixture,
        Effect.suspend(() => {
          authorityReads += 1;
          return authorityReads === 2
            ? Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void;
        }),
      );
      const fiber = yield* Managed.withManagedVerificationTarget(context, () =>
        Effect.sync(() => {
          used = true;
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      expect(verificationFds(fixture.assigned).length).toBeGreaterThan(0);
      yield* Fiber.interrupt(fiber);
      expect(used).toBe(false);
      expect(verificationFds(fixture.assigned)).toEqual([]);
      expect(verificationFds(fixture.metadata)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "rechecks and releases the captured ownership scope when persistence is interrupted",
    () =>
      Effect.gen(function* () {
        const fixture = yield* verificationFixture();
        let reads = 0;
        const context = yield* verificationContext(
          fixture,
          Effect.sync(() => {
            reads += 1;
          }),
        );
        const started = yield* Deferred.make<void>();
        const waiting = yield* Deferred.make<void>();
        const fiber = yield* Managed.withManagedVerificationTarget(context, () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(waiting))),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        expect(verificationFds(fixture.assigned).length).toBeGreaterThan(0);
        yield* Fiber.interrupt(fiber);
        expect(reads).toBeGreaterThanOrEqual(4);
        expect(verificationFds(fixture.assigned)).toEqual([]);
        expect(verificationFds(fixture.metadata)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

it.effect(
  "managed integration combines only fixed approved commits and holds capture through persistence",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* verificationFixture();
        f.answers.head = f.base;
        f.answers.worktreeHead = f.base;
        const context = yield* Managed.make({
          assignment: f.assignment,
          priorReceipt: f.receipt,
          revalidate: Effect.void,
          persistWorkspace: () => Effect.die("Cannot replace ownership"),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.spawner));
        const result = yield* Managed.withManagedIntegrationTarget(
          context,
          { baseSha: f.base, sourceHeads: ["6".repeat(40), "7".repeat(40)] },
          (target) => Effect.succeed({ head: target.headSha, tree: target.testedTree }),
        );
        expect(result).toEqual({ head: "4".repeat(40), tree: "5".repeat(40) });
        const merges = f.commands.filter((command) => command.args.includes("merge"));
        expect(merges).toHaveLength(1);
        expect(merges[0]?.args.slice(-3)).toEqual(["--", "6".repeat(40), "7".repeat(40)]);
        expect(
          f.commands.every(
            (command) =>
              command.command === "/usr/bin/git" &&
              !command.args.includes("push") &&
              !command.args.includes("fetch"),
          ),
        ).toBe(true);
        expect(
          (yield* Managed.withManagedIntegrationTarget(
            context,
            { baseSha: f.base, sourceHeads: ["6".repeat(40)] },
            () => Effect.void,
          ).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(f.commands.filter((command) => command.args.includes("merge"))).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.provideService(HostProcessPlatform, "linux")),
);

for (const failure of ["conflict", "ancestry", "dirty persistence"] as const) {
  it.effect(`managed integration denies ${failure} without a second combination`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* verificationFixture();
        f.answers.head = f.base;
        f.answers.worktreeHead = f.base;
        if (failure === "conflict") f.answers.mergeCode = 1;
        if (failure === "ancestry") f.answers.ancestorCode = 1;
        const context = yield* Managed.make({
          assignment: f.assignment,
          priorReceipt: f.receipt,
          revalidate: Effect.void,
          persistWorkspace: () => Effect.die("Ownership is immutable"),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.spawner));
        let persisted = false;
        const result = yield* Managed.withManagedIntegrationTarget(
          context,
          { baseSha: f.base, sourceHeads: ["6".repeat(40), "7".repeat(40)] },
          () =>
            Effect.sync(() => {
              persisted = true;
              if (failure === "dirty persistence") f.answers.untracked = "unknown-input\0";
            }),
        ).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(persisted).toBe(failure === "dirty persistence");
        expect(f.commands.filter((command) => command.args.includes("merge"))).toHaveLength(1);
        expect(
          f.commands.every(
            (command) =>
              !command.args.includes("reset") &&
              !command.args.includes("push") &&
              !command.args.includes("fetch"),
          ),
        ).toBe(true);
        expect(verificationFds(f.assigned)).toEqual([]);
        expect(verificationFds(f.metadata)).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.provideService(HostProcessPlatform, "linux")),
  );
}
it.effect("managed integration rejects a source commit that is not in the tested descendant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture();
      const context = yield* Managed.make({
        assignment: f.assignment,
        priorReceipt: f.receipt,
        revalidate: Effect.void,
        persistWorkspace: () => Effect.die("Read cannot write"),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.spawner));
      expect(
        yield* Managed.withManagedVerificationAncestry(
          context,
          { requiredHeads: ["6".repeat(40), "7".repeat(40)] },
          (target) => Effect.succeed(target.headSha),
        ),
      ).toBe(f.answers.head);
      f.answers.ancestorCode = 1;
      let escaped = false;
      expect(
        (yield* Managed.withManagedVerificationAncestry(
          context,
          { requiredHeads: ["6".repeat(40)] },
          () =>
            Effect.sync(() => {
              escaped = true;
            }),
        ).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(escaped).toBe(false);
      expect(f.commands.some((command) => command.args.includes("merge"))).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provideService(HostProcessPlatform, "linux")),
);
