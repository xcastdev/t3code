import { expect, it } from "@effect/vitest";
import { ProjectWorkFoundationCommitCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
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
import { makeProjectManagedSetupJournal } from "./ProjectManagedSetupJournal.ts";
import type {
  ProjectManagedSetupReceipt,
  ProjectManagedSetupSelection,
} from "./ProjectManagedSetup.ts";
import type { PiManagedProcessAllocation } from "../provider/pi/PiManagedProcess.ts";

const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);

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
      runtimeFiles: [{ source: "/usr/bin/bash", target: "/usr/bin/bash" }],
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
      runtimeFiles: [{ source: "/usr/bin/bash", target: "/usr/bin/bash", dev: 3, ino: 4 }],
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
  return { ...f, input, journal, selection, allocation, owner, receipt };
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

it.effect(
  "freezes script selection before allocation and retains one activation winner across journal reconstruction",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* allocated;
        const alternate = {
          ...f.allocation,
          nonce: "87654321-1234-4123-8123-123456789012",
          unit: "t3-pi-managed-87654321-1234-4123-8123-123456789012.service",
        };
        expect(
          (yield* f.journal.freezeAllocation(f.input, f.selection, alternate)).allocation,
        ).toEqual(f.allocation);
        const other = yield* makeProjectManagedSetupJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          validateSelection: () => Effect.void,
        });
        const winners = yield* Effect.all(
          [
            f.journal.claimActivation(f.input, f.selection, f.allocation),
            other.claimActivation(f.input, f.selection, f.allocation),
          ],
          { concurrency: 2 },
        );
        expect(winners.sort()).toEqual(["already-claimed", "claimed"]);
        expect((yield* other.read(f.input))?.allocation).toEqual(f.allocation);
      }),
    ),
);

it.effect(
  "persists native started identity and exact complete receipt, never a different completion",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* captured;
        yield* f.journal.persistReceipt(f.input, f.receipt);
        yield* f.journal.persistReceipt(f.input, f.receipt);
        expect((yield* f.journal.read(f.input))?.receipt).toEqual(f.receipt);
        expect(
          (yield* f.journal
            .persistReceipt(f.input, {
              ...f.receipt,
              stdout: { text: "other", bytes: 5, truncated: false, invalidUtf8: false },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.sql`SELECT status,started_pid FROM project_team_setup_process`).toEqual([
          { status: "completed", started_pid: 124 },
        ]);
      }),
    ),
);

it.effect("records skipped setup without allocation or native ownership", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.journal.freezeSelection(f.input, { kind: "none" });
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
      yield* f.journal.persistReceipt(f.input, receipt);
      expect((yield* f.journal.read(f.input))?.receipt).toEqual(receipt);
      expect(
        yield* f.sql`SELECT unit,allocation_json,owner_json FROM project_team_setup_process`,
      ).toEqual([{ unit: null, allocation_json: null, owner_json: null }]);
    }),
  ),
);

for (const key of [
  "dispatchId",
  "bindingId",
  "generation",
  "threadId",
  "worktreePath",
  "deadlineAtMs",
] as const)
  it.effect(`rejects changed full assignment field ${key} before writing`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* allocated;
        const changed = {
          ...f.input,
          [key]:
            typeof f.input[key] === "number"
              ? Number(f.input[key]) + 1
              : String(f.input[key]) + "-changed",
        };
        expect((yield* f.journal.read(changed).pipe(Effect.result))._tag).toBe("Failure");
        expect(
          (yield* f.journal.claimActivation(changed, f.selection, f.allocation).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect((yield* f.journal.read(f.input))?.activation).toBe("unlaunched");
      }),
    ),
  );

for (const revoked of ["binding", "deadline", "writer"])
  it.effect(
    `retains cleanup ownership after ${revoked} revocation and denies successful completion`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* captured;
          if (revoked === "binding")
            yield* f.sql`DELETE FROM project_team_run_binding WHERE record_id='binding'`;
          if (revoked === "deadline") yield* TestClock.setTime(f.input.deadlineAtMs);
          if (revoked === "writer")
            yield* f.sql`UPDATE project_team_reservation SET status='released'`;
          expect(
            (yield* f.journal.persistReceipt(f.input, f.receipt).pipe(Effect.result))._tag,
          ).toBe("Failure");
          const failed = { ...f.receipt, outcome: "canceled" as const, reason: "revoked" };
          yield* f.journal.persistReceipt(f.input, failed);
          expect((yield* f.journal.read(f.input))?.receipt).toEqual(failed);
          expect((yield* f.journal.read(f.input))?.owner).toEqual(f.owner);
        }),
      ),
  );

it.effect("a stale preclaim loser cannot quarantine the winning native owner", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* allocated;
      const old = (yield* f.journal.read(f.input))!;
      const { uncertain: _uncertain, ...expected } = old;
      yield* f.journal.claimActivation(f.input, f.selection, f.allocation);
      yield* f.journal.persistOwner(f.input, f.allocation, f.owner);
      expect(
        (yield* f.journal
          .markUncertain(f.input, {
            expected,
            selection: f.selection,
            allocation: f.allocation,
            owner: null,
            drain: null,
            reconciliation: null,
            reason: "loser",
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* f.journal.read(f.input))?.uncertain).toBe(false);
    }),
  ),
);

it.effect(
  "retains uncertainty only against the complete claimed snapshot and cannot launch again",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* allocated;
        yield* f.journal.claimActivation(f.input, f.selection, f.allocation);
        const old = (yield* f.journal.read(f.input))!;
        const { uncertain: _uncertain, ...expected } = old;
        yield* f.journal.markUncertain(f.input, {
          expected,
          selection: f.selection,
          allocation: f.allocation,
          owner: null,
          drain: null,
          reconciliation: null,
          reason: "lost owner",
        });
        expect((yield* f.journal.read(f.input))?.uncertain).toBe(true);
        expect(yield* f.journal.claimActivation(f.input, f.selection, f.allocation)).toBe(
          "already-claimed",
        );
        expect(
          yield* f.sql`SELECT status FROM project_team_reservation WHERE status='held'`,
        ).not.toHaveLength(0);
      }),
    ),
);

it.effect(
  "retains the exact captured native owner when its first persistence response failed",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* allocated;
        yield* f.journal.claimActivation(f.input, f.selection, f.allocation);
        const old = (yield* f.journal.read(f.input))!;
        const { uncertain: _uncertain, ...expected } = old;
        yield* f.journal.markUncertain(f.input, {
          expected,
          selection: f.selection,
          allocation: f.allocation,
          owner: f.owner,
          drain: null,
          reconciliation: null,
          reason: "owner write did not commit",
        });
        const retained = yield* f.journal.read(f.input);
        expect(retained?.uncertain).toBe(true);
        expect(retained?.owner).toEqual(f.owner);
        expect(retained?.activation).toBe("owned");
      }),
    ),
);

for (const phase of ["selection", "allocation", "activation", "completion"] as const)
  for (const expiry of ["deadline", "lease"] as const)
    it.effect(`rolls back ${phase} when ${expiry} expires after the durable write`, () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* phase === "completion"
            ? captured
            : phase === "activation"
              ? allocated
              : setup;
          if (phase === "allocation") yield* f.journal.freezeSelection(f.input, f.selection);
          const expires = expiry === "deadline" ? f.input.deadlineAtMs : Date.parse(at) + 50;
          if (expiry === "lease")
            yield* f.sql`UPDATE project_work_attempts SET leased_until=${DateTime.formatIso(DateTime.makeUnsafe(expires))}`;
          const before = yield* f.sql`SELECT * FROM project_team_setup_process`;
          let expired = false;
          const observingSql = Object.assign(
            (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
              const statement = f.sql(strings, ...values);
              const text = strings.join("");
              if (
                (text.includes("INSERT INTO project_team_setup_process") ||
                  text.includes("UPDATE project_team_setup_process")) &&
                !expired
              )
                return statement.pipe(
                  Effect.tap(() => {
                    expired = true;
                    return TestClock.setTime(expires);
                  }),
                );
              return statement;
            },
            f.sql,
          );
          const journal = yield* makeProjectManagedSetupJournal({
            environmentId: "environment",
            maximumEnvironmentModelCalls: 4,
            validateSelection: () => Effect.void,
          }).pipe(Effect.provideService(SqlClient.SqlClient, observingSql));
          const result = yield* Effect.gen(function* () {
            if (phase === "selection") yield* journal.freezeSelection(f.input, f.selection);
            else if (phase === "allocation")
              yield* journal.freezeAllocation(f.input, f.selection, f.allocation);
            else if (phase === "activation")
              yield* journal.claimActivation(f.input, f.selection, f.allocation);
            else yield* journal.persistReceipt(f.input, f.receipt);
          }).pipe(Effect.result);
          expect(expired).toBe(true);
          expect(result._tag).toBe("Failure");
          expect(yield* f.sql`SELECT * FROM project_team_setup_process`).toEqual(before);
        }),
      ),
    );

for (const change of ["command", "protected-root", "runtime-source"] as const)
  it.effect(`rejects an allocation with a substituted ${change} before activation`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.journal.freezeSelection(f.input, f.selection);
        const launch =
          change === "command"
            ? { ...f.allocation.launch, argv: ["/usr/bin/bash", "-lc", "other-command"] }
            : change === "protected-root"
              ? { ...f.allocation.launch, protectedRoots: ["/other-protected"] }
              : {
                  ...f.allocation.launch,
                  runtimeFiles: [
                    { ...f.allocation.launch.runtimeFiles[0]!, source: "/other/bash" },
                  ],
                };
        const result = yield* f.journal
          .freezeAllocation(f.input, f.selection, { ...f.allocation, launch })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect((yield* f.journal.read(f.input))?.allocation).toBeNull();
        expect((yield* f.journal.read(f.input))?.activation).toBe("unlaunched");
      }),
    ),
  );
