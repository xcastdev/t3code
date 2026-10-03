import { expect, it } from "@effect/vitest";
import { ProjectWorkFoundationCommitCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  at,
  attribution,
  projectId,
  seed,
  scoped,
} from "../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "../projectWork/ProjectWorkRepository.ts";
import { ProjectWorkPolicyError } from "../projectWork/ProjectWorkPolicy.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
} from "../projectWork/ProjectTeamDispatchJournal.ts";
import { makeProjectManagedSetupAssetLifetime } from "./ProjectManagedSetupAssetLifetime.ts";
import { makeProjectManagedSetupJournal } from "./ProjectManagedSetupJournal.ts";
import {
  type ProjectManagedSetupReceipt,
  type ProjectManagedSetupSelection,
} from "./ProjectManagedSetup.ts";
import type { PiManagedProcessAllocation } from "../provider/pi/PiManagedProcess.ts";

const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.gen(function* () {
  const repository = yield* ProjectWorkRepository;
  const sql = yield* SqlClient.SqlClient;
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  // The real fixture commits approvals and the execution grant; intercept only its final claim.
  const result = yield* seed("implementer", "reserved", {
    roleTools: ["pi.read", "pi.write"],
    toolIds: ["pi.read", "pi.write"],
    issueCredential: false,
  }).pipe(
    Effect.provideService(ProjectWorkRepository, {
      ...repository,
      execute: (command) => {
        if (
          command.type === "project-work.foundation.commit" &&
          command.transition?.kind === "claim"
        ) {
          pending = command;
          return Effect.fail(
            new ProjectWorkPolicyError("invalid-state", "Fixture retains the uncommitted claim"),
          );
        }
        return repository.execute(command);
      },
    }),
    Effect.result,
  );
  expect(result._tag).toBe("Failure");
  if (!pending || pending.transition?.kind !== "claim")
    return yield* Effect.die("Fixture did not capture its claim");
  yield* repository.execute(
    yield* decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "configure-limits",
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      attribution,
      committedAt: at,
      records: [
        {
          kind: "limits",
          projectId,
          recordId: "limits",
          revision: 0,
          generation: 0,
          updatedAt: at,
          status: "configured",
          environmentModelCalls: 4,
          projectWritableWorkers: 1,
          modelCalls: 2,
          delegationDepth: 2,
          repairAllowance: 2,
          model: "test",
          tokenLimit: 2000,
          durationLimitMs: 2000,
        },
      ],
    }),
  );
  yield* TestClock.setTime(Date.parse(at) + 1);
  const claim = {
    ...pending,
    expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
    transition: {
      ...pending.transition,
      binding: {
        ...pending.transition.binding,
        branch: "refs/heads/assigned",
        worktree: "/workspace-assigned",
      },
    },
  };
  const request: ProjectTeamDispatchRequest = {
    dispatchId: "dispatch-intent",
    claim,
    git: {
      effectId: "dispatch-intent",
      runId: "binding",
      generation: 0,
      primaryRoot: "/workspace",
      commonGitDirectory: "/workspace/.git",
      worktreePath: "/workspace-assigned",
      branchRef: "refs/heads/assigned",
      baseRef: "refs/heads/main",
      baseOid: "a".repeat(40),
      ownershipToken: "owner",
      policyHash: "b".repeat(64),
    },
    setupId: "setup",
    initializeOperationId: "initialize",
    assignmentOperationId: "assignment",
    assignment: "Implement the approved task",
  };
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
  });
  return { sql, repository, request, journal };
});

const setup = Effect.gen(function* () {
  const f = yield* fixture;
  const snapshot = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
  const binding = snapshot.intent.compiledClaim.transition;
  if (binding?.kind !== "claim") return yield* Effect.die("Missing exact binding");
  yield* f.sql`UPDATE project_team_dispatch SET stage='workspace-ready',revision=2`;
  const input = {
    setupId: "setup",
    dispatchId: f.request.dispatchId,
    bindingId: "binding",
    generation: 0,
    threadId: binding.binding.threadId,
    worktreePath: f.request.git.worktreePath,
    deadlineAtMs: snapshot.intent.limits.deadlineAtMs,
  };
  const journal = yield* makeProjectManagedSetupJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    // SQL controls only; production validates actual script/current physical workspace.
    validateSelection: () => Effect.void,
  });
  const selection: ProjectManagedSetupSelection = {
    kind: "script",
    scriptId: "script",
    scriptRevision: "script-v1",
    cwd: input.worktreePath,
    launch: {
      workspaceRoot: input.worktreePath,
      workspaceAccess: "readwrite",
      protectedRoots: ["/protected"],
      runtimeFiles: [{ source: "/stage/bash", target: "/usr/bin/bash" }],
      argv: ["/usr/bin/bash", "-lc", "true"],
      memoryBytes: 16777216,
      runtimeSeconds: 2,
    },
  };
  const nonce = "12345678-1234-4123-8123-123456789012";
  const allocation: PiManagedProcessAllocation = {
    version: 1,
    unit: `t3-pi-managed-${nonce}.service`,
    nonce,
    policy: {
      memoryBytes: selection.launch.memoryBytes,
      runtimeSeconds: selection.launch.runtimeSeconds,
    },
    launch: {
      ...selection.launch,
      workspace: { path: input.worktreePath, dev: 1, ino: 2 },
      protectedWorkspaceEntries: [],
      runtimeFiles: [{ source: "/stage/bash", target: "/usr/bin/bash", dev: 3, ino: 4 }],
    },
  };
  const owner = {
    type: "owner" as const,
    unit: allocation.unit,
    nonce,
    invocation: "a".repeat(32),
    cgroup: "/sys/fs/cgroup/user.slice/" + allocation.unit,
    pid: 123,
    memoryBytes: 16777216,
    swapBytes: 0,
    oomGroup: 1,
  };
  const receipt: ProjectManagedSetupReceipt = {
    outcome: "succeeded",
    selection,
    allocation,
    owner,
    drain: {
      unit: owner.unit,
      invocation: owner.invocation,
      cgroup: owner.cgroup,
      memoryBytes: owner.memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
      ownerPid: owner.pid,
      launcherPid: 125,
      childPid: 124,
      childExitCode: 0,
      kernel: "populated 0\nfrozen 0",
    },
    reconciliation: null,
    stdout: { text: "", bytes: 0, truncated: false, invalidUtf8: false },
    stderr: { text: "", bytes: 0, truncated: false, invalidUtf8: false },
    reason: null,
  };
  // Native owner/drain values are controlled SQL fixtures, not physical proof.
  return {
    ...f,
    input,
    journal,
    selection,
    allocation,
    owner,
    receipt,
    dispatchIntent: snapshot.intent,
  };
});
const allocated = Effect.gen(function* () {
  const f = yield* setup;
  yield* f.journal.freezeSelection(f.input, f.selection);
  yield* f.journal.freezeAllocation(f.input, f.selection, f.allocation);
  return f;
});
const captured = Effect.gen(function* () {
  const f = yield* allocated;
  expect(yield* f.journal.claimActivation(f.input, f.selection, f.allocation)).toBe("claimed");
  yield* f.journal.persistOwner(f.input, f.allocation, f.owner);
  yield* f.journal.persistStarted(f.input, f.allocation, f.owner, 124);
  return f;
});

const stage = {
  directory: "/stage",
  files: [
    { source: "/stage/bash", target: "/usr/bin/bash", dev: 3, ino: 4 },
    { source: "/stage/worker", target: "/worker.mjs", dev: 3, ino: 5 },
  ],
};
const lifetime = makeProjectManagedSetupAssetLifetime({ environmentId: "environment" });

it.effect(
  "retains a selection before allocation, and each live owned stage until an exact drain receipt",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const assets = yield* lifetime;
        expect(yield* assets.canRelease(stage)).toBe(true);
        yield* f.journal.freezeSelection(f.input, f.selection);
        expect(yield* assets.canRelease(stage)).toBe(false);
        yield* f.journal.freezeAllocation(f.input, f.selection, f.allocation);
        expect(yield* assets.canRelease(stage)).toBe(false);
        yield* f.journal.claimActivation(f.input, f.selection, f.allocation);
        expect(yield* assets.canRelease(stage)).toBe(false);
        yield* f.journal.persistOwner(f.input, f.allocation, f.owner);
        yield* f.journal.persistStarted(f.input, f.allocation, f.owner, 124);
        expect(yield* assets.canRelease(stage)).toBe(false);
        yield* f.journal.persistReceipt(f.input, f.receipt);
        expect(yield* assets.canRelease(stage)).toBe(true);
      }),
    ),
);

for (const outcome of ["failed", "canceled"] as const)
  for (const proof of ["drain", "reconciled", "absent"] as const)
    it.effect(`releases ${outcome} after exact ${proof} even after authority revocation`, () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* proof === "absent" ? allocated : captured;
          const assets = yield* lifetime;
          yield* f.sql`DELETE FROM project_team_run_binding WHERE record_id='binding'`;
          yield* TestClock.setTime(f.input.deadlineAtMs);
          const receipt: ProjectManagedSetupReceipt = {
            ...f.receipt,
            outcome,
            owner: proof === "absent" ? null : f.owner,
            drain: proof === "drain" ? f.receipt.drain : null,
            reconciliation:
              proof === "drain"
                ? null
                : proof === "absent"
                  ? {
                      state: "absent",
                      unit: f.allocation.unit,
                      invocation: null,
                      cgroup: null,
                      kernel: "not-created",
                    }
                  : {
                      state: "drained",
                      unit: f.owner.unit,
                      invocation: f.owner.invocation,
                      cgroup: f.owner.cgroup,
                      kernel: "removed",
                    },
            stdout: null,
            stderr: null,
            reason: "revoked",
          };
          yield* f.journal.persistReceipt(f.input, receipt);
          expect(yield* assets.canRelease(stage)).toBe(true);
        }),
      ),
    );

it.effect("a validated skipped-none receipt has no stage ownership", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.journal.freezeSelection(f.input, { kind: "none" });
      yield* f.journal.persistReceipt(f.input, {
        outcome: "skipped",
        selection: { kind: "none" },
        allocation: null,
        owner: null,
        drain: null,
        reconciliation: null,
        stdout: null,
        stderr: null,
        reason: null,
      });
      expect(yield* (yield* lifetime).canRelease(stage)).toBe(true);
    }),
  ),
);

for (const variant of [
  "fake-status",
  "fake-drain",
  "child",
  "receipt-status",
  "legacy",
  "bad-closure",
  "missing-receipt",
  "dispatch-owner",
  "uncertain",
] as const)
  it.effect(`retains ${variant} instead of inferring cleanup from lifecycle labels`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* variant === "legacy" || variant === "bad-closure" ? setup : captured;
        const assets = yield* lifetime;
        if (variant === "legacy" || variant === "bad-closure") {
          yield* f.sql`INSERT INTO project_team_setup_process
        (setup_id,dispatch_id,selection_json,input_json,activation,status)
        VALUES ('setup','dispatch-intent',${encodeJson(variant === "bad-closure" ? { kind: "script", launch: {} } : f.selection)},${variant === "legacy" ? null : encodeJson(f.input)},'unlaunched','selected')`;
        } else if (variant === "fake-status") {
          yield* f.sql`UPDATE project_team_setup_process SET status='completed',drain_json='{}'`;
        } else if (
          variant === "fake-drain" ||
          variant === "child" ||
          variant === "receipt-status"
        ) {
          const receipt = {
            ...f.receipt,
            drain: {
              ...f.receipt.drain!,
              ...(variant === "fake-drain"
                ? { kernel: "populated 1" }
                : variant === "child"
                  ? { childPid: 999 }
                  : {}),
            },
          };
          yield* f.sql`UPDATE project_team_setup_process SET status=${variant === "receipt-status" ? "failed" : "completed"},receipt_json=${encodeJson(receipt)},drain_json=${encodeJson(receipt.drain)}`;
        } else if (variant === "dispatch-owner") {
          yield* f.journal.persistReceipt(f.input, f.receipt);
          const saved = (yield* f.sql`SELECT * FROM project_team_setup_process`)[0]!;
          // Recreate malformed imported history without disabling immutable triggers or constraints.
          yield* f.sql`DELETE FROM project_team_setup_process`;
          yield* f.sql`INSERT INTO project_team_setup_process ${f.sql.insert({
            ...saved,
            input_json: encodeJson({ ...f.input, threadId: "foreign-thread" }),
          })}`;
        } else if (variant === "uncertain") {
          yield* f.journal.persistReceipt(f.input, f.receipt);
          const retained = (yield* f.journal.read(f.input))!;
          const { uncertain: _uncertain, ...expected } = retained;
          yield* f.journal.markUncertain(f.input, {
            expected,
            selection: f.selection,
            allocation: f.allocation,
            owner: f.owner,
            drain: null,
            reconciliation: null,
            reason: "current physical drain is unproved",
          });
        }
        expect(yield* assets.canRelease(stage)).toBe(false);
      }),
    ),
  );

for (const variant of ["source-alias", "target", "inode", "noncanonical", "duplicate"] as const)
  it.effect(`retains a contradictory ${variant} runtime identity after a valid drain`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* captured;
        yield* f.journal.persistReceipt(f.input, f.receipt);
        const assets = yield* lifetime;
        const files = stage.files.map((f, index) =>
          index !== 0
            ? f
            : {
                ...f,
                ...(variant === "source-alias"
                  ? { source: "/stage/alias" }
                  : variant === "target"
                    ? { target: "/other" }
                    : variant === "inode"
                      ? { ino: 99 }
                      : variant === "noncanonical"
                        ? { source: "/stage/./bash" }
                        : {}),
              },
        );
        expect(
          yield* assets.canRelease({
            ...stage,
            files: variant === "duplicate" ? [...files, files[0]!] : files,
          }),
        ).toBe(false);
      }),
    ),
  );

// Copy legal retained history, including each committed binding and budget FK parent.
// These fixtures never admit another worker or claim forward authority.
const addUnrelatedRows = Effect.fn("assetLifetimeTest.addUnrelatedRows")(function* (
  f: Effect.Success<typeof setup>,
  count: number,
  foreign = false,
  borrowed = false,
  offset = 0,
) {
  const source = (yield* f.sql`SELECT * FROM project_team_dispatch`)[0]!;
  const bindingRow =
    (yield* f.sql`SELECT * FROM project_team_run_binding WHERE record_id='binding'`)[0]!;
  const transition = f.dispatchIntent.compiledClaim.transition;
  if (transition?.kind !== "claim") return yield* Effect.die("Missing retained claim");
  const environmentId = foreign ? "foreign-environment" : "environment";
  if (foreign)
    yield* f.sql`INSERT INTO project_team_model_budget
    SELECT ${environmentId},project_id,root_task_id,maximum_tokens,deadline_at_ms FROM project_team_model_budget`;
  for (let index = 0; index < count; index++) {
    const id = "history-" + (index + offset);
    const binding = {
      ...transition.binding,
      environmentId,
      recordId: id,
      attemptId: id,
      worktree: "/workspace-" + id,
      branch: "refs/heads/" + id,
    };
    const compiledClaim = {
      ...f.dispatchIntent.compiledClaim,
      transition: { ...transition, binding },
    };
    const intent = {
      ...f.dispatchIntent,
      compiledClaim,
      request: {
        ...f.dispatchIntent.request,
        dispatchId: id,
        setupId: id,
        claim: compiledClaim,
        git: {
          ...f.dispatchIntent.request.git,
          runId: id,
          worktreePath: binding.worktree,
          branchRef: binding.branch,
        },
      },
    };
    yield* f.sql`INSERT INTO project_team_run_binding ${f.sql.insert({
      ...bindingRow,
      record_id: id,
      attempt_id: id,
      payload_json: encodeJson(binding),
    })}`;
    yield* f.sql`INSERT INTO project_team_dispatch ${f.sql.insert({
      ...source,
      environment_id: environmentId,
      dispatch_id: id,
      binding_id: id,
      attempt_id: id,
      worktree: binding.worktree,
      branch: binding.branch,
      intent_json: encodeJson(intent),
    })}`;
    if (borrowed) {
      const nonce = "12345678-1234-4123-8123-" + (index + offset).toString(16).padStart(12, "0");
      const unit = "t3-pi-managed-" + nonce + ".service";
      const selection: ProjectManagedSetupSelection = {
        ...f.selection,
        cwd: binding.worktree,
        launch: { ...f.selection.launch, workspaceRoot: binding.worktree },
      };
      const allocation = {
        ...f.allocation,
        nonce,
        unit,
        launch: {
          ...f.allocation.launch,
          workspaceRoot: binding.worktree,
          workspace: { ...f.allocation.launch.workspace, path: binding.worktree },
        },
      };
      const owner = { ...f.owner, nonce, unit, cgroup: "/sys/fs/cgroup/user.slice/" + unit };
      const receipt = {
        ...f.receipt,
        selection,
        allocation,
        owner,
        drain: { ...f.receipt.drain!, unit, cgroup: owner.cgroup },
      };
      yield* f.sql`INSERT INTO project_team_setup_process ${f.sql.insert({
        setup_id: id,
        dispatch_id: id,
        unit,
        selection_json: encodeJson(selection),
        allocation_json: encodeJson(allocation),
        owner_json: encodeJson(owner),
        drain_json: encodeJson(receipt.drain),
        receipt_json: encodeJson(receipt),
        input_json: encodeJson({
          ...f.input,
          setupId: id,
          dispatchId: id,
          bindingId: id,
          worktreePath: binding.worktree,
        }),
        activation: "owned",
        status: "completed",
        started_pid: 124,
      })}`;
      continue;
    }
    const receipt: ProjectManagedSetupReceipt = {
      outcome: "skipped",
      selection: { kind: "none" },
      allocation: null,
      owner: null,
      drain: null,
      reconciliation: null,
      stdout: null,
      stderr: null,
      reason: null,
    };
    yield* f.sql`INSERT INTO project_team_setup_process
      (setup_id,dispatch_id,selection_json,input_json,activation,status,receipt_json)
      VALUES (${id},${id},${encodeJson(receipt.selection)},${encodeJson({
        ...f.input,
        setupId: id,
        dispatchId: id,
        bindingId: id,
        worktreePath: binding.worktree,
      })},'unlaunched','no-script',${encodeJson(receipt)})`;
  }
});

for (const foreign of [false, true])
  it.effect(
    `streams more than sixteen ${foreign ? "foreign" : "local"} unrelated rows before finding stage ownership`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          yield* addUnrelatedRows(f, 33, foreign);
          const assets = yield* lifetime;
          expect(yield* assets.canRelease(stage)).toBe(true);
          yield* f.journal.freezeSelection(f.input, f.selection);
          expect(yield* assets.canRelease(stage)).toBe(false);
          yield* f.journal.freezeAllocation(f.input, f.selection, f.allocation);
          yield* f.journal.claimActivation(f.input, f.selection, f.allocation);
          yield* f.journal.persistOwner(f.input, f.allocation, f.owner);
          yield* f.journal.persistStarted(f.input, f.allocation, f.owner, 124);
          yield* f.journal.persistReceipt(f.input, f.receipt);
          expect(yield* assets.canRelease(stage)).toBe(true);
          expect(yield* f.sql`PRAGMA foreign_key_check`).toEqual([]);
        }),
      ),
  );

it.effect("retains a source outside the stage that aliases an owned inode", () =>
  scoped(
    Effect.gen(function* () {
      const original = yield* setup;
      const selection: ProjectManagedSetupSelection = {
        ...original.selection,
        launch: {
          ...original.selection.launch,
          runtimeFiles: [{ source: "/outside/bash-alias", target: "/usr/bin/bash" }],
        },
      };
      const allocation = {
        ...original.allocation,
        launch: {
          ...original.allocation.launch,
          runtimeFiles: [
            { source: "/outside/bash-alias", target: "/usr/bin/bash", dev: 3, ino: 4 },
          ],
        },
      };
      yield* original.journal.freezeSelection(original.input, selection);
      yield* original.journal.freezeAllocation(original.input, selection, allocation);
      yield* original.journal.claimActivation(original.input, selection, allocation);
      yield* original.journal.persistOwner(original.input, allocation, original.owner);
      yield* original.journal.persistStarted(original.input, allocation, original.owner, 124);
      yield* original.journal.persistReceipt(original.input, {
        ...original.receipt,
        selection,
        allocation,
      });
      expect(yield* (yield* lifetime).canRelease(stage)).toBe(false);
    }),
  ),
);

it.effect(
  "retains contradictions introduced between the bounded snapshot and ownership validation",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* captured;
        yield* f.journal.persistReceipt(f.input, f.receipt);
        let changed = false;
        const observingSql = Object.assign(
          (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
            const statement = f.sql(strings, ...values);
            if (strings.join("").includes("SELECT setup.*"))
              return statement.pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (changed) return;
                    changed = true;
                    yield* f.sql`UPDATE project_team_setup_process SET status='uncertain',uncertainty_json='{}'`;
                  }),
                ),
              );
            return statement;
          },
          f.sql,
        );
        const assets = yield* lifetime.pipe(
          Effect.provideService(SqlClient.SqlClient, observingSql),
        );
        expect(yield* assets.canRelease(stage)).toBe(false);
        expect(changed).toBe(true);
      }),
    ),
);

it.effect(
  "captures its SQL and path services instead of trusting replacements during cleanup",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* captured;
        const assets = yield* lifetime;
        const substituteSql = Object.assign(
          () => Effect.die("Cleanup must use captured SQL"),
          f.sql,
        );
        const path = yield* Path.Path;
        const substitutePath = { ...path, resolve: () => "/untrusted" };
        expect(
          yield* assets
            .canRelease(stage)
            .pipe(
              Effect.provideService(SqlClient.SqlClient, substituteSql),
              Effect.provideService(Path.Path, substitutePath),
            ),
        ).toBe(false);
        yield* f.journal.persistReceipt(f.input, f.receipt);
        expect(
          yield* assets
            .canRelease(stage)
            .pipe(
              Effect.provideService(SqlClient.SqlClient, substituteSql),
              Effect.provideService(Path.Path, substitutePath),
            ),
        ).toBe(true);
      }),
    ),
);

it.effect("retains an oversized immutable SQL scalar before attempting ownership JSON decode", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* setup;
      const id = "s".repeat(4097);
      yield* f.sql`INSERT INTO project_team_setup_process
    (setup_id,dispatch_id,selection_json,input_json,activation,status)
    VALUES (${id},'dispatch-intent',${encodeJson(f.selection)},${encodeJson({ ...f.input, setupId: id })},'unlaunched','selected')`;
      expect(yield* (yield* lifetime).canRelease(stage)).toBe(false);
    }),
  ),
);

it.effect(
  "an exact terminal receipt still proves cleanup after matching explicit uncertainty",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* captured;
        yield* f.journal.persistReceipt(f.input, f.receipt);
        const retained = (yield* f.journal.read(f.input))!;
        const { uncertain: _uncertain, ...expected } = retained;
        yield* f.journal.markUncertain(f.input, {
          expected,
          selection: f.selection,
          allocation: f.allocation,
          owner: f.owner,
          drain: f.receipt.drain,
          reconciliation: null,
          reason: "Delivery response was lost after durable cleanup",
        });
        expect(yield* (yield* lifetime).canRelease(stage)).toBe(true);
      }),
    ),
);

it.effect("a terminal receipt belonging to another environment cannot release this stage", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* captured;
      yield* f.journal.persistReceipt(f.input, f.receipt);
      const assets = yield* makeProjectManagedSetupAssetLifetime({
        environmentId: "foreign-environment",
      });
      expect(yield* assets.canRelease(stage)).toBe(false);
    }),
  ),
);

for (const field of ["bindingId", "generation", "worktreePath", "deadlineAtMs"] as const)
  it.effect(
    `compares original ${field} to immutable dispatch ownership before accepting an exact receipt`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* captured;
          yield* f.journal.persistReceipt(f.input, f.receipt);
          const saved = (yield* f.sql`SELECT * FROM project_team_setup_process`)[0]!;
          const forged = {
            ...f.input,
            [field]:
              typeof f.input[field] === "number"
                ? Number(f.input[field]) + 1
                : String(f.input[field]) + "-other",
          };
          yield* f.sql`DELETE FROM project_team_setup_process`;
          yield* f.sql`INSERT INTO project_team_setup_process ${f.sql.insert({ ...saved, input_json: encodeJson(forged) })}`;
          // The actual ownership reader alone accepts this forged original input; the immutable dispatch comparison rejects it.
          expect((yield* f.journal.readOwnership(forged))?.retained.receipt).toEqual(f.receipt);
          expect(yield* (yield* lifetime).canRelease(stage)).toBe(false);
        }),
      ),
  );

it.effect("bounds matching retained owners at 1024 while leaving unrelated history uncapped", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* captured;
      yield* f.journal.persistReceipt(f.input, f.receipt);
      yield* addUnrelatedRows(f, 1023, false, true);
      const assets = yield* lifetime;
      expect(yield* assets.canRelease(stage)).toBe(true);
      yield* addUnrelatedRows(f, 1, false, true, 1023);
      expect(yield* assets.canRelease(stage)).toBe(false);
      expect(yield* f.sql`PRAGMA foreign_key_check`).toEqual([]);
    }),
  ),
);
