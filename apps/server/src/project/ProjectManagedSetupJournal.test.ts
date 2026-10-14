import { expect, it } from "@effect/vitest";
import {
  ProjectWorkFoundationCommitCommand,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import { makeProjectTaskResources } from "../projectWork/ProjectTaskResources.ts";
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
import {
  makeProjectManagedSetup,
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
  return {
    ...f,
    input,
    journal,
    selection,
    allocation,
    owner,
    receipt,
    taskDeadline: snapshot.intent.limits.rootDeadlineAtMs,
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

for (const outcome of ["failed", "canceled"] as const)
  it.effect(`rejects ${outcome} cleanup contradicting the recorded child`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* captured;
        yield* TestClock.setTime(f.input.deadlineAtMs);
        const bad = {
          ...f.receipt,
          outcome,
          reason: "cleanup",
          drain: { ...f.receipt.drain!, childPid: 999 },
        };
        expect((yield* f.journal.persistReceipt(f.input, bad).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect((yield* f.journal.read(f.input))?.receipt).toBeNull();
        expect((yield* f.journal.readOwnership(f.input))?.startedPid).toBe(124);
        expect(
          yield* f.sql`SELECT status FROM project_team_reservation WHERE status='held'`,
        ).not.toHaveLength(0);
      }),
    ),
  );

for (const variant of [
  "different-child",
  "missing-start",
  "failed-status",
  "captured-status",
] as const)
  it.effect(`refuses retained success and execution replay with ${variant}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* variant === "missing-start" ? allocated : captured;
        if (variant === "missing-start") {
          yield* f.journal.claimActivation(f.input, f.selection, f.allocation);
          yield* f.journal.persistOwner(f.input, f.allocation, f.owner);
        }
        const receipt =
          variant === "different-child"
            ? { ...f.receipt, drain: { ...f.receipt.drain!, childPid: 999 } }
            : f.receipt;
        const status =
          variant === "failed-status"
            ? "failed"
            : variant === "captured-status"
              ? "captured"
              : "completed";
        yield* f.sql`UPDATE project_team_setup_process SET receipt_json=${encodeJson(receipt)}, drain_json=${encodeJson(receipt.drain)}, status=${status}`;
        expect((yield* f.journal.read(f.input).pipe(Effect.result))._tag).toBe("Failure");
        let acquired = 0;
        const managed = makeProjectManagedSetup({
          ...f.journal,
          resolveSelection: () => Effect.die("Replay must not select again"),
          preallocate: () => Effect.die("Replay must not allocate again"),
          acquire: () =>
            Effect.sync(() => {
              acquired++;
              throw new Error("Replay must not acquire");
            }),
          reconcileProcess: () => Effect.die("Contradiction must not trigger a physical effect"),
        });
        expect((yield* managed.execute(f.input).pipe(Effect.result))._tag).toBe("Failure");
        expect(acquired).toBe(0);
        expect(
          (yield* f.sql`SELECT receipt_json FROM project_team_setup_process`)[0]?.receipt_json,
        ).toBe(encodeJson(receipt));
      }),
    ),
  );

for (const outcome of ["failed", "canceled"] as const)
  for (const knowledge of ["matching", "unknown-start", "unknown-child", "reconciled"] as const)
    it.effect(`retains ${outcome} ${knowledge} cleanup after expiry`, () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* knowledge === "unknown-start" ? allocated : captured;
          if (knowledge === "unknown-start") {
            yield* f.journal.claimActivation(f.input, f.selection, f.allocation);
            yield* f.journal.persistOwner(f.input, f.allocation, f.owner);
          }
          yield* TestClock.setTime(f.input.deadlineAtMs);
          const receipt: ProjectManagedSetupReceipt = {
            ...f.receipt,
            outcome,
            reason: "Script result was not retained",
            drain:
              knowledge === "reconciled"
                ? null
                : {
                    ...f.receipt.drain!,
                    ...(knowledge === "unknown-child"
                      ? { childPid: null, childExitCode: null }
                      : {}),
                  },
            reconciliation:
              knowledge === "reconciled"
                ? {
                    state: "drained",
                    unit: f.owner.unit,
                    invocation: f.owner.invocation,
                    cgroup: f.owner.cgroup,
                    kernel: "removed",
                  }
                : null,
            stdout: null,
            stderr: null,
          };
          yield* f.journal.persistReceipt(f.input, receipt);
          const value = yield* f.journal.readOwnership(f.input);
          expect(value?.retained.receipt).toEqual(receipt);
          expect(value?.startedPid).toBe(knowledge === "unknown-start" ? null : 124);
          expect(
            yield* f.sql`SELECT status FROM project_team_reservation WHERE status='held'`,
          ).not.toHaveLength(0);
        }),
      ),
    );

it.effect("valid successful replay reuses the exact durable receipt without acquiring", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* captured;
      yield* f.journal.persistReceipt(f.input, f.receipt);
      const managed = makeProjectManagedSetup({
        ...f.journal,
        resolveSelection: () => Effect.die("Replay must not select"),
        preallocate: () => Effect.die("Replay must not allocate"),
        acquire: () => Effect.die("Replay must not acquire"),
        reconcileProcess: () => Effect.die("Replay must not reconcile"),
      });
      expect(yield* managed.execute(f.input)).toEqual(f.receipt);
      expect((yield* f.journal.readOwnership(f.input))?.startedPid).toBe(124);
    }),
  ),
);

it.effect("an exact receipt remains cleanup knowledge after explicit uncertainty", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* captured;
      yield* f.journal.persistReceipt(f.input, f.receipt);
      const retained = yield* f.journal.read(f.input);
      if (!retained) return yield* Effect.die("Missing retained receipt");
      const { uncertain: _uncertain, ...expected } = retained;
      yield* f.journal.markUncertain(f.input, {
        expected,
        selection: f.selection,
        allocation: f.allocation,
        owner: f.owner,
        drain: f.receipt.drain,
        reconciliation: null,
        reason: "current physical cleanup unproved",
      });
      expect((yield* f.journal.read(f.input))?.receipt).toEqual(f.receipt);
      expect((yield* f.journal.read(f.input))?.uncertain).toBe(true);
    }),
  ),
);

it.effect(
  "task resources consume exact approved setup and retain capacity through canceled uncertain drain",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* allocated;
        yield* f.journal.claimActivation(f.input, f.selection, f.allocation);
        expect(
          yield* f.sql`SELECT task_id,memory_bytes,deadline_at_ms FROM project_task_resource_budget`,
        ).toEqual([
          {
            task_id:
              f.request.claim.transition?.kind === "claim"
                ? f.request.claim.transition.binding.taskId
                : "missing",
            memory_bytes: 2147483648,
            deadline_at_ms: f.taskDeadline,
          },
        ]);
        yield* TestClock.setTime(f.input.deadlineAtMs + 1);
        yield* f.journal.persistOwner(f.input, f.allocation, f.owner);
        expect(
          (yield* f.journal.validateCurrent(f.input, f.selection, "start").pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(
          (yield* f.journal
            .persistDrain(f.input, f.allocation, { ...f.receipt.drain!, kernel: "populated 1" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: 16777216 }]);
        yield* f.journal.persistDrain(f.input, f.allocation, f.receipt.drain!);
        expect(yield* f.sql`SELECT drain_json FROM project_task_resource_child`).toEqual([
          { drain_json: canonicalProjectWorkPayload(f.receipt.drain) },
        ]);
        expect(
          (yield* f.journal.claimActivation(f.input, f.selection, f.allocation).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect(
  "task resources reject foreign setup authority and aggregate overlapping verification",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* allocated;
        expect(
          (yield* f.journal
            .claimActivation({ ...f.input, bindingId: "foreign" }, f.selection, f.allocation)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* f.journal.claimActivation(f.input, f.selection, f.allocation);
        const snapshot = yield* f.journal.read(f.input);
        expect(snapshot?.activation).toBe("claimed");
        const resources = yield* makeProjectTaskResources("environment");
        const nonce = "87654321-1234-4123-8123-123456789012";
        const allocation = {
          ...f.allocation,
          unit: `t3-pi-managed-${nonce}.service`,
          nonce,
          policy: { ...f.allocation.policy, memoryBytes: 2147483648 },
          launch: { ...f.allocation.launch, memoryBytes: 2147483648 },
        };
        const task =
          f.request.claim.transition?.kind === "claim"
            ? f.request.claim.transition.binding.taskId
            : "missing";
        // A retained controlled verification authority isolates the aggregate SQL gate.
        yield* f.sql`INSERT INTO project_work_verification_execution(environment_id,job_id,project_id,task_id,attempt_id,manifest_hash,gate_id,gate_revision,intent_json,intent_hash,allocation_hash,deadline_at_ms,phase,revision)
      VALUES('environment','verification',${projectId},${task},'verification',${"a".repeat(64)},'gate',0,${canonicalProjectWorkPayload({ allocation })},${"a".repeat(64)},${"a".repeat(64)},${f.input.deadlineAtMs},'claimed',0)`;
        expect(
          (yield* f.sql
            .withTransaction(resources.verification("verification", allocation).reserve)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: 16777216 }]);
      }),
    ),
);

it.effect(
  "task resource cleanup rescues capture COMMIT failure atomically after expiry and revocation",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* allocated;
        yield* f.journal.claimActivation(f.input, f.selection, f.allocation);
        const before = yield* f.journal.read(f.input);
        if (!before) return yield* Effect.die("Missing original setup claim");
        const { uncertain: _uncertain, ...expected } = before;
        yield* f.sql`CREATE TABLE capture_parent(id INTEGER PRIMARY KEY)`;
        yield* f.sql`CREATE TABLE capture_child(parent_id INTEGER REFERENCES capture_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* f.sql`CREATE TRIGGER fail_capture_commit AFTER UPDATE OF owner_json ON project_team_setup_process
        WHEN OLD.owner_json IS NULL AND NEW.owner_json IS NOT NULL
        BEGIN INSERT INTO capture_child VALUES(999); END`;
        expect(
          (yield* f.journal.persistOwner(f.input, f.allocation, f.owner).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(
          yield* f.sql`SELECT owner_json,uncertainty_json FROM project_team_setup_process`,
        ).toEqual([{ owner_json: null, uncertainty_json: null }]);
        expect(yield* f.sql`SELECT owner_json,drain_json FROM project_task_resource_child`).toEqual(
          [{ owner_json: null, drain_json: null }],
        );
        const knowledge = {
          expected,
          selection: f.selection,
          allocation: f.allocation,
          owner: f.owner,
          drain: null,
          reconciliation: null,
          reason: "Original capture COMMIT failed after observing the physical owner",
        };
        // The same deferred FK also forces adoption to roll back both journals at COMMIT.
        expect((yield* f.journal.markUncertain(f.input, knowledge).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        expect(
          yield* f.sql`SELECT owner_json,uncertainty_json FROM project_team_setup_process`,
        ).toEqual([{ owner_json: null, uncertainty_json: null }]);
        expect(yield* f.sql`SELECT owner_json,drain_json FROM project_task_resource_child`).toEqual(
          [{ owner_json: null, drain_json: null }],
        );
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: 16777216 }]);
        yield* f.sql`DROP TRIGGER fail_capture_commit`;
        yield* TestClock.setTime(f.input.deadlineAtMs + 1);
        yield* f.sql`DELETE FROM project_team_run_binding WHERE record_id='binding'`;
        yield* f.journal.markUncertain(f.input, knowledge);
        expect((yield* f.journal.readOwnership(f.input))?.retained.owner).toEqual(f.owner);
        expect(yield* f.sql`SELECT owner_json FROM project_task_resource_child`).toEqual([
          { owner_json: canonicalProjectWorkPayload(f.owner) },
        ]);
        expect(
          (yield* f.journal.validateCurrent(f.input, f.selection, "start").pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect((yield* f.journal.persistReceipt(f.input, f.receipt).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const cleanup: ProjectManagedSetupReceipt = {
          ...f.receipt,
          outcome: "failed",
          reason: "Original owner reconciled without repeating setup",
          drain: null,
          reconciliation: {
            state: "drained",
            unit: f.owner.unit,
            invocation: f.owner.invocation,
            cgroup: f.owner.cgroup,
            kernel: "removed",
          },
          stdout: null,
          stderr: null,
        };
        yield* f.journal.persistReceipt(f.input, cleanup);
        expect(
          yield* f.sql`SELECT COUNT(*) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: 0 }]);
        expect((yield* f.journal.read(f.input))?.receipt).toEqual(cleanup);
        expect(
          yield* f.sql`SELECT deadline_at_ms,memory_bytes FROM project_task_resource_budget`,
        ).toEqual([{ deadline_at_ms: f.taskDeadline, memory_bytes: 2147483648 }]);
      }),
    ),
);

it.effect(
  "task resource cleanup adopts an older retained uncertainty owner only with its matched receipt",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* allocated;
        yield* f.journal.claimActivation(f.input, f.selection, f.allocation);
        const before = yield* f.journal.read(f.input);
        if (!before) return yield* Effect.die("Missing original setup claim");
        const { uncertain: _uncertain, ...expected } = before;
        // Exact prior journal representation: rescued owner, reservation still uncaptured.
        const knowledge = {
          expected,
          selection: f.selection,
          allocation: f.allocation,
          owner: f.owner,
          drain: null,
          reconciliation: null,
          reason: "Retained older uncertainty record",
        };
        yield* f.sql`UPDATE project_team_setup_process SET owner_json=${canonicalProjectWorkPayload(f.owner)},
        uncertainty_json=${canonicalProjectWorkPayload(knowledge)},activation='owned',status='uncertain'`;
        const journal = yield* makeProjectManagedSetupJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          validateSelection: () => Effect.void,
        });
        yield* TestClock.setTime(f.input.deadlineAtMs + 1);
        const cleanup: ProjectManagedSetupReceipt = {
          ...f.receipt,
          outcome: "canceled",
          reason: "Older retained owner drained without repeating setup",
          drain: null,
          reconciliation: {
            state: "drained",
            unit: f.owner.unit,
            invocation: f.owner.invocation,
            cgroup: f.owner.cgroup,
            kernel: "removed",
          },
          stdout: null,
          stderr: null,
        };
        for (const changed of [
          { ...cleanup, owner: { ...f.owner, nonce: "87654321-1234-4123-8123-123456789012" } },
          {
            ...cleanup,
            reconciliation: { ...cleanup.reconciliation!, invocation: "b".repeat(32) },
          },
          { ...cleanup, reconciliation: { ...cleanup.reconciliation!, unit: "foreign.service" } },
          {
            ...cleanup,
            reconciliation: { ...cleanup.reconciliation!, cgroup: "/sys/fs/cgroup/foreign" },
          },
        ]) {
          expect((yield* journal.persistReceipt(f.input, changed).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect(
            yield* f.sql`SELECT owner_json,drain_json FROM project_task_resource_child`,
          ).toEqual([{ owner_json: null, drain_json: null }]);
        }
        expect(
          (yield* journal
            .persistReceipt({ ...f.input, bindingId: "foreign" }, cleanup)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* journal.validateCurrent(f.input, f.selection, "start").pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* journal.persistReceipt(f.input, cleanup);
        expect(yield* f.sql`SELECT owner_json,drain_json FROM project_task_resource_child`).toEqual(
          [
            {
              owner_json: canonicalProjectWorkPayload(f.owner),
              drain_json: canonicalProjectWorkPayload(cleanup.reconciliation),
            },
          ],
        );
        yield* journal.persistReceipt(f.input, cleanup);
        const resources = yield* makeProjectTaskResources("environment");
        expect(
          (yield* f.sql
            .withTransaction(
              resources
                .setup(f.input.setupId, f.allocation)
                .capture({ ...f.owner, invocation: "b".repeat(32) }),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.sql`SELECT drain_json FROM project_task_resource_child`).toEqual([
          { drain_json: canonicalProjectWorkPayload(cleanup.reconciliation) },
        ]);
      }),
    ),
);

it.effect(
  "task resource cleanup preserves the first live drain when completion adopts its same owner",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* captured;
        yield* f.journal.persistDrain(f.input, f.allocation, f.receipt.drain!);
        yield* f.journal.persistReceipt(f.input, f.receipt);
        expect((yield* f.journal.read(f.input))?.receipt).toEqual(f.receipt);
        expect(yield* f.sql`SELECT drain_json FROM project_task_resource_child`).toEqual([
          { drain_json: canonicalProjectWorkPayload(f.receipt.drain) },
        ]);
      }),
    ),
);

for (const missingInput of [false, true])
  it.effect(
    `legacy native cleanup preserves captured setup history ${missingInput ? "without original input" : "without a resource grant"}`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* missingInput ? setup : allocated;
          // Reconstruct the migrated pre-027 row at insertion; original identities stay immutable.
          if (missingInput)
            yield* f.sql`INSERT INTO project_team_setup_process(setup_id,dispatch_id,unit,selection_json,allocation_json,status,input_json,activation)
        VALUES(${f.input.setupId},${f.input.dispatchId},${f.allocation.unit},${canonicalProjectWorkPayload(f.selection)},${canonicalProjectWorkPayload(f.allocation)},'allocated',NULL,'unlaunched')`;
          yield* f.sql`UPDATE project_team_setup_process SET status='captured',activation='owned',owner_json=${canonicalProjectWorkPayload(f.owner)} WHERE setup_id=${f.input.setupId}`;
          expect((yield* f.journal.readOwnership(f.input))?.retained.owner).toEqual(f.owner);
          for (const foreign of [
            { ...f.input, bindingId: "foreign" },
            { ...f.input, threadId: "foreign" },
            { ...f.input, worktreePath: "/foreign" },
            { ...f.input, generation: 1 },
            { ...f.input, deadlineAtMs: f.input.deadlineAtMs + 1 },
          ]) {
            expect((yield* f.journal.readOwnership(foreign).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
          }
          if (missingInput) {
            expect(
              (yield* f.journal
                .claimActivation(f.input, f.selection, f.allocation)
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect((yield* f.journal.read(f.input).pipe(Effect.result))._tag).toBe("Failure");
            expect(
              (yield* f.journal
                .persistStarted(f.input, f.allocation, f.owner, 124)
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect(
              (yield* f.journal.persistReceipt(f.input, f.receipt).pipe(Effect.result))._tag,
            ).toBe("Failure");
          }
          yield* TestClock.setTime(f.input.deadlineAtMs + 1);
          expect(
            (yield* f.journal.validateCurrent(f.input, f.selection, "start").pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          expect(
            (yield* f.journal
              .claimActivation(f.input, f.selection, f.allocation)
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          const cleanup: ProjectManagedSetupReceipt = {
            ...f.receipt,
            outcome: "failed",
            reason: "Historical owner drained without repeating setup",
            drain: null,
            reconciliation: {
              state: "drained",
              unit: f.owner.unit,
              invocation: f.owner.invocation,
              cgroup: f.owner.cgroup,
              kernel: "removed",
            },
            stdout: null,
            stderr: null,
          };
          expect(
            (yield* f.journal
              .persistReceipt(f.input, {
                ...cleanup,
                reconciliation: { ...cleanup.reconciliation!, invocation: "b".repeat(32) },
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* f.journal.persistDrain(f.input, f.allocation, f.receipt.drain!);
          yield* f.journal.persistReceipt(f.input, cleanup);
          expect((yield* f.journal.readOwnership(f.input))?.retained.receipt).toEqual(cleanup);
          expect(yield* f.sql`SELECT task_id FROM project_task_resource_budget`).toEqual([]);
          expect(yield* f.sql`SELECT unit FROM project_task_resource_child`).toEqual([]);
        }),
      ),
  );

it.effect(
  "legacy native cleanup denies missing ownership and a conflicting present resource child",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* allocated;
        const resources = yield* makeProjectTaskResources("environment");
        expect(
          (yield* f.sql
            .withTransaction(
              resources.setup(f.input.setupId, f.allocation).cleanupDrain(f.receipt.drain!),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* f.sql`UPDATE project_team_setup_process SET status='captured',activation='owned',owner_json=${canonicalProjectWorkPayload(f.owner)} WHERE setup_id=${f.input.setupId}`;
        const foreign = yield* makeProjectTaskResources("foreign-environment");
        expect(
          (yield* f.sql
            .withTransaction(
              foreign.setup(f.input.setupId, f.allocation).cleanupDrain(f.receipt.drain!),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(resources.setup(f.input.setupId, f.allocation).capture(f.owner))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        // A present child in another task cannot be mistaken for legacy absence.
        yield* f.sql`INSERT INTO project_task_resource_budget VALUES('environment',${projectId},'foreign-task',${f.taskDeadline},2147483648)`;
        yield* f.sql`INSERT INTO project_task_resource_child(unit,nonce,environment_id,project_id,task_id,authority_kind,authority_id,allocation_json,memory_bytes,deadline_at_ms)
        VALUES(${f.allocation.unit},${f.allocation.nonce},'environment',${projectId},'foreign-task','setup','foreign-setup',${canonicalProjectWorkPayload(f.allocation)},${f.owner.memoryBytes},${f.input.deadlineAtMs})`;
        const cleanup = { ...f.receipt, outcome: "failed" as const, reason: "Historical cleanup" };
        expect((yield* f.journal.persistReceipt(f.input, cleanup).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect((yield* f.journal.read(f.input))?.receipt).toBe(null);
        expect(
          yield* f.sql`SELECT task_id,owner_json,drain_json FROM project_task_resource_child`,
        ).toEqual([{ task_id: "foreign-task", owner_json: null, drain_json: null }]);
      }),
    ),
);

it.effect(
  "reconciliation cleans an input-less legacy setup without selecting or restarting it",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.sql`INSERT INTO project_team_setup_process(setup_id,dispatch_id,unit,selection_json,allocation_json,status,input_json,activation,owner_json)
    VALUES(${f.input.setupId},${f.input.dispatchId},${f.allocation.unit},${canonicalProjectWorkPayload(f.selection)},${canonicalProjectWorkPayload(f.allocation)},'captured',NULL,'owned',${canonicalProjectWorkPayload(f.owner)})`;
        yield* TestClock.setTime(f.input.deadlineAtMs + 1);
        let reconciled = 0;
        const managed = makeProjectManagedSetup({
          ...f.journal,
          read: (input) =>
            f.journal.readOwnership(input).pipe(Effect.map((value) => value?.retained ?? null)),
          resolveSelection: () => Effect.die("Legacy cleanup must not select"),
          preallocate: () => Effect.die("Legacy cleanup must not allocate"),
          acquire: () => Effect.die("Legacy cleanup must not acquire"),
          reconcileProcess: (retained, options) =>
            Effect.sync(() => {
              expect(retained).toEqual({
                allocation: f.allocation,
                activation: "owned",
                owner: f.owner,
              });
              expect(options).toEqual({ stop: true });
              reconciled++;
              return {
                state: "drained" as const,
                unit: f.owner.unit,
                invocation: f.owner.invocation,
                cgroup: f.owner.cgroup,
                kernel: "removed",
              };
            }),
        });
        const receipt = yield* managed.reconcile(f.input);
        expect(receipt).toMatchObject({
          outcome: "failed",
          owner: f.owner,
          reconciliation: { state: "drained", kernel: "removed" },
        });
        expect(reconciled).toBe(1);
        expect((yield* f.journal.readOwnership(f.input))?.retained.receipt).toEqual(receipt);
        // Workspace returns this retained cleanup receipt before invoking recovery again.
        expect((yield* f.journal.readOwnership(f.input))?.retained.receipt).toEqual(receipt);
        expect(reconciled).toBe(1);
        expect(yield* f.sql`SELECT unit FROM project_task_resource_child`).toEqual([]);
        expect(
          (yield* f.journal.claimActivation(f.input, f.selection, f.allocation).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      }),
    ),
);
