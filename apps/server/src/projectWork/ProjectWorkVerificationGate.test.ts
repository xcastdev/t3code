import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  ProjectTeamWriteIntent,
  ThreadId,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import {
  ProjectWorkVerificationRequest,
  makeProjectWorkVerificationRequest,
} from "./ProjectWorkVerificationRequest.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectTeamAuthorization } from "./ProjectTeamAuthorization.ts";
import {
  ProjectWorkVerificationApproval,
  ProjectWorkVerificationGateError,
} from "./ProjectWorkVerificationGate.ts";
import { at } from "./ProjectTeamAuthorization.testFixtures.ts";
import { scoped } from "./ProjectTeamAuthorization.testFixtures.ts";
import { verificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import { makeProjectWorkVerificationGate } from "./ProjectWorkVerificationGate.ts";

const options = { environmentId: "environment", maximumEnvironmentModelCalls: 4 };
it.effect("checks the actual prepared job inside the caller's command transaction", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const sql = yield* SqlClient.SqlClient;
      const gates = yield* makeProjectWorkVerificationGate(options);
      yield* sql.withTransaction(gates.assertCurrent(f.state, f.prepared, f.selection));
      expect(yield* f.jobs.readPrepared(f.selection.jobId)).toEqual(f.prepared);
    }),
  ),
);

it.effect("denies stale task, binding, criterion and project versions", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const gates = yield* makeProjectWorkVerificationGate(options);
      const project = { ...f.state, revision: f.state.revision + 1 };
      const task = {
        ...f.state,
        tasks: f.state.tasks.map((row) =>
          row.taskId === f.selection.taskId ? { ...row, revision: row.revision + 1 } : row,
        ),
      };
      const binding = {
        ...f.state,
        foundationRecords: (f.state.foundationRecords ?? []).map((row) =>
          row.kind === "run-binding" ? { ...row, revision: row.revision + 1 } : row,
        ),
      };
      const criterion = {
        ...f.state,
        criteria: f.state.criteria.map((row) => ({ ...row, revision: row.revision + 1 })),
      };
      for (const state of [project, task, binding, criterion]) {
        const result = yield* gates
          .assertCurrent(state, f.prepared, f.selection)
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
    }),
  ),
);

it.effect("denies a changed original implementer identity even at the selected revision", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const gates = yield* makeProjectWorkVerificationGate(options);
      const state = {
        ...f.state,
        foundationRecords: (f.state.foundationRecords ?? []).map((row) =>
          row.kind === "run-binding"
            ? { ...row, threadId: ThreadId.make("substituted-thread") }
            : row,
        ),
      };
      expect(
        (yield* gates.assertCurrent(state, f.prepared, f.selection).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);

for (const mutation of [
  "job-owner",
  "manifest",
  "workspace-assignment",
  "dispatch-stage",
] as const) {
  it.effect(`denies altered retained ${mutation}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* verificationFixture;
        const sql = yield* SqlClient.SqlClient;
        const gates = yield* makeProjectWorkVerificationGate(options);
        // Corruption controls bypass only this disposable fixture's immutable-row triggers.
        if (mutation === "job-owner" || mutation === "manifest")
          yield* sql`DROP TRIGGER project_work_verification_jobs_immutable`;
        if (mutation === "workspace-assignment")
          yield* sql`DROP TRIGGER project_team_workspace_receipt_immutable`;
        if (mutation === "job-owner")
          yield* sql`UPDATE project_work_verification_jobs SET task_id='different-task' WHERE job_id=${f.selection.jobId}`;
        if (mutation === "manifest")
          yield* sql`UPDATE project_work_verification_jobs SET manifest_json='{}' WHERE job_id=${f.selection.jobId}`;
        if (mutation === "workspace-assignment")
          yield* sql`UPDATE project_team_workspace_receipt SET assignment_json='{}' WHERE dispatch_id=${f.prepared.manifest.dispatchId}`;
        if (mutation === "dispatch-stage")
          yield* sql`UPDATE project_team_dispatch SET stage='reserved' WHERE dispatch_id=${f.prepared.manifest.dispatchId}`;
        expect(
          (yield* gates.assertCurrent(f.state, f.prepared, f.selection).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
  );
}

const decodeIntent = Schema.decodeUnknownEffect(ProjectTeamWriteIntent);
it.effect("requires the private preparation before recording a pending verification gate", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const authorization = yield* ProjectTeamAuthorization;
      const gates = yield* makeProjectWorkVerificationGate(options);
      const input = yield* decodeIntent({
        ...f.selection,
        type: "project-team.verification.propose",
        commandId: "propose-verification",
      });
      const attribution = {
        actor: f.principal.actor,
        source: { kind: "web" as const, id: "browser" },
        recordedAt: at,
      };
      expect(
        (yield* authorization.intent(f.principal, input, attribution, false).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      const trusted = ProjectWorkVerificationApproval.of({
        selection: f.selection,
        receipt: f.prepared,
        assertCurrent: (state, duplicate) =>
          gates
            .assertCurrent(state, f.prepared, f.selection, duplicate)
            .pipe(
              Effect.mapError(
                () => new ProjectWorkVerificationGateError({ reason: "Fixture target changed" }),
              ),
            ),
      });
      const command = yield* authorization
        .intent(f.principal, input, attribution, false)
        .pipe(Effect.provideService(ProjectWorkVerificationApproval, trusted));
      expect(command.type).toBe("project-work.foundation.commit");
      yield* f.repository.execute(command);
      const rows =
        yield* f.sql`SELECT payload_json FROM project_work_events WHERE command_id='propose-verification'`;
      expect(rows.length).toBe(1);
      expect(String(rows[0]!.payload_json)).toContain(f.prepared.sha256);
      expect(String(rows[0]!.payload_json)).toContain('"status":"pending"');
      expect(String(rows[0]!.payload_json)).not.toContain(
        canonicalProjectWorkPayload(f.prepared.manifest),
      );
    }),
  ),
);

for (const response of ["approved", "rejected"] as const) {
  it.effect(
    `verification ${response} ${response === "approved" ? "requires the exact prepared target" : "remains possible without host authority"}`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* verificationFixture;
          const authorization = yield* ProjectTeamAuthorization;
          const gates = yield* makeProjectWorkVerificationGate(options);
          const principal = { actor: { kind: "human" as const, id: "user:maintainer" } };
          const sessions = yield* AuthSessions.make;
          const session = {
            sessionId: AuthSessionId.make("verification-gate-human"),
            subject: principal.actor.id,
            identity: { kind: "user" as const, id: principal.actor.id },
            method: "browser-session-cookie" as const,
            scopes: [AuthOrchestrationOperateScope],
            expiresAt: DateTime.makeUnsafe(Date.parse(at) + 60_000),
          };
          yield* sessions.create({
            ...session,
            issuedAt: DateTime.makeUnsafe(Date.parse(at)),
            client: {
              label: null,
              ipAddress: null,
              userAgent: null,
              deviceType: "unknown",
              os: null,
              browser: null,
            },
          });
          const request = yield* makeProjectWorkVerificationRequest(
            session,
            f.selection.projectId,
            "write",
          ).pipe(Effect.provideService(AuthSessions.AuthSessionRepository, sessions));
          const attribution = {
            actor: principal.actor,
            source: { kind: "web" as const, id: "browser" },
            recordedAt: at,
          };
          const trust = (selection: typeof f.selection) =>
            ProjectWorkVerificationApproval.of({
              selection,
              receipt: f.prepared,
              assertCurrent: (state, duplicate) =>
                gates
                  .assertCurrent(state, f.prepared, selection, duplicate)
                  .pipe(
                    Effect.mapError(
                      () =>
                        new ProjectWorkVerificationGateError({ reason: "Fixture target changed" }),
                    ),
                  ),
            });
          const proposal = yield* decodeIntent({
            ...f.selection,
            type: "project-team.verification.propose",
            commandId: "propose-verification",
          });
          const pending = yield* authorization
            .intent(principal, proposal, attribution, false)
            .pipe(Effect.provideService(ProjectWorkVerificationApproval, trust(f.selection)));
          yield* f.repository.execute(pending);
          const state = yield* readCurrentState(f.sql, f.selection.projectId);
          const gate = state.foundationRecords?.find(
            (row) => row.kind === "gate" && row.verificationJobId === f.selection.jobId,
          );
          if (gate?.kind !== "gate")
            return yield* Effect.die("Fixture did not record verification gate");
          const selection = { ...f.selection, expectedRevision: state.revision };
          const input = yield* decodeIntent({
            type: "project-team.gate.respond",
            commandId: "respond-verification",
            projectId: f.selection.projectId,
            taskId: f.selection.taskId,
            expectedRevision: state.revision,
            expectedTaskRevision: f.selection.expectedTaskRevision,
            specRevision: f.selection.specRevision,
            planRevision: f.selection.planRevision,
            gateId: gate.recordId,
            expectedGateRevision: gate.revision,
            response,
          });
          if (response === "approved")
            expect(
              (yield* authorization
                .intent(principal, input, attribution, false)
                .pipe(
                  Effect.provideService(ProjectWorkVerificationRequest, request),
                  Effect.result,
                ))._tag,
            ).toBe("Failure");
          const command = yield* response === "approved"
            ? authorization
                .intent(principal, input, attribution, false)
                .pipe(
                  Effect.provideService(ProjectWorkVerificationApproval, trust(selection)),
                  Effect.provideService(ProjectWorkVerificationRequest, request),
                )
            : authorization
                .intent(principal, input, attribution, false)
                .pipe(Effect.provideService(ProjectWorkVerificationRequest, request));
          yield* f.repository.execute(command);
          const updated = (yield* readCurrentState(
            f.sql,
            f.selection.projectId,
          )).foundationRecords?.find((row) => row.recordId === gate.recordId);
          expect(updated?.status).toBe(response);
          if (updated?.kind === "gate") {
            expect(updated.verificationJobId).toBe(f.selection.jobId);
            expect(updated.contentHash).toBe(f.prepared.sha256);
          }
        }),
      ),
  );
}
