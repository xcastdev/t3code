import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GitCommandError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
