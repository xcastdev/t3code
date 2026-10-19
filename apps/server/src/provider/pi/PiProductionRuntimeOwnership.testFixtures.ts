import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "@effect/vitest";
import { ProjectWorkCommand, ProjectWorkFoundationCommitCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as GitRepositoryPermits from "../../git/GitRepositoryPermits.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  at,
  attribution,
  gatewayRuntime,
  projectId,
  seed,
} from "../../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import {
  ProjectWorkRepository,
  readCurrentState,
} from "../../projectWork/ProjectWorkRepository.ts";
import { ProjectWorkPolicyError } from "../../projectWork/ProjectWorkPolicy.ts";
import { makeProjectTeamDispatchJournal } from "../../projectWork/ProjectTeamDispatchJournal.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

export const model = "inclusionai/ling-3.1-flash:free";
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const commandJson = Schema.fromJsonString(ProjectWorkCommand);
const encodeCommand = Schema.encodeEffect(commandJson);
const decodeCommand = Schema.decodeEffect(commandJson);

// Reuse the existing human approval fixture. Only its final claim is captured;
// the real dispatch journal commits that claim and reserves the original budget.
export const ownershipAssignment = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  // The user systemd manager has a different /tmp namespace from the test runner.
  const scratchRoot = process.getBuiltinModule("os").homedir() + "/.cache/t3-pi-ownership";
  yield* fs.makeDirectory(scratchRoot, { recursive: true, mode: 0o700 });
  const scratch = yield* fs.makeTempDirectoryScoped({ directory: scratchRoot, prefix: "case-" });
  const main = scratch + "/main";
  const worktree = scratch + "/assigned";
  const agentDirectory = scratch + "/agent";
  yield* fs.makeDirectory(agentDirectory);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make("/usr/bin/git", args));
        const [stdout, stderr, code] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: 8192 }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: 8192 }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        expect(stderr.text).toBe("");
        expect(Number(code)).toBe(0);
        return stdout.text.trim();
      }),
    );
  yield* git(["init", "-q", "-b", "main", main]);
  yield* fs.writeFileString(main + "/primary.txt", "primary bytes\n");
  yield* git(["-C", main, "add", "primary.txt"]);
  yield* git([
    "-C",
    main,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "initial",
  ]);
  const baseOid = yield* git(["-C", main, "rev-parse", "HEAD"]);
  yield* git(["-C", main, "worktree", "add", "-qb", "assigned", worktree]);
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const fixtureAt = DateTime.formatIso(yield* DateTime.now);
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  const fixtureRepository = {
    ...repository,
    execute: (supplied: ProjectWorkCommand) =>
      encodeCommand(supplied).pipe(
        Effect.flatMap((text) =>
          decodeCommand(text.replaceAll('"' + at + '"', '"' + fixtureAt + '"')),
        ),
        Effect.flatMap((command) => {
          if (command.type !== "project-work.foundation.commit") return repository.execute(command);
          if (command.transition?.kind === "claim") {
            pending = command;
            return Effect.fail(
              new ProjectWorkPolicyError("invalid-state", "Capture fixture claim"),
            );
          }
          return repository.execute({
            ...command,
            records: command.records.map((record) =>
              record.kind === "role-revision" ? { ...record, model } : record,
            ),
          });
        }),
      ),
  };
  yield* seed("implementer", "reserved", {
    nativeSessionId: null,
    roleTools: [],
    toolIds: [],
    issueCredential: false,
  }).pipe(Effect.provideService(ProjectWorkRepository, fixtureRepository), Effect.result);
  if (pending?.transition?.kind !== "claim") return yield* Effect.die("Missing fixture claim");
  const state = yield* readCurrentState(sql, projectId);
  const role = state.foundationRecords?.find((record) => record.kind === "role-revision");
  if (role?.kind !== "role-revision") return yield* Effect.die("Missing frozen role");
  expect(state.foundationRecords?.filter((record) => record.kind === "member")).toHaveLength(1);
  yield* repository.execute(
    yield* decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "ownership-limits",
      expectedRevision: state.revision,
      attribution,
      committedAt: at,
      records: [
        {
          kind: "limits",
          projectId,
          recordId: "ownership-limits",
          revision: 0,
          generation: 0,
          updatedAt: at,
          status: "configured",
          environmentModelCalls: 4,
          projectWritableWorkers: 2,
          modelCalls: 2,
          delegationDepth: 2,
          repairAllowance: 2,
          model,
          tokenLimit: 64000,
          durationLimitMs: 300000,
        },
      ],
    }),
  );
  const binding = {
    ...pending.transition.binding,
    worktree,
    branch: "refs/heads/assigned",
    model,
    configuration: {
      ...pending.transition.binding.configuration,
      runtimeVersion: "0.99.1",
      instructionsHash: NodeCrypto.createHash("sha256").update(role.instructions).digest("hex"),
      maxTokens: 64000,
      maxDurationMs: 300000,
    },
  };
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
  });
  const request = {
    dispatchId: "ownership-root",
    claim: {
      ...pending,
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      transition: { ...pending.transition, binding },
    },
    git: {
      effectId: "ownership-root",
      runId: binding.recordId,
      generation: binding.generation,
      primaryRoot: main,
      commonGitDirectory: main + "/.git",
      worktreePath: worktree,
      branchRef: binding.branch,
      baseRef: "refs/heads/main",
      baseOid,
      ownershipToken: "ownership-root-owner",
      policyHash: "b".repeat(64),
    },
    setupId: "ownership-root-setup",
    initializeOperationId: "ownership-root-initialize",
    assignmentOperationId: "ownership-root-assignment",
    assignment: "Implement only the approved scope",
  };
  const reserved = yield* journal.reserve(request);
  const snapshot = yield* journal.claimEffect(reserved.fence);
  return { fs, sql, scratch, main, worktree, agentDirectory, request, snapshot, binding };
});

const permits = GitRepositoryPermits.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
);
export const ownershipRuntime = permits.pipe(
  Layer.provideMerge(gatewayRuntime),
  Layer.provideMerge(NodeServices.layer),
);
