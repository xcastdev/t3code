import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  EnvironmentId,
  ProjectTeamWriteIntent,
  ProjectWorkReadIntent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import { at, scoped } from "./ProjectTeamAuthorization.testFixtures.ts";
import { verificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import { ProjectWorkGateway, ProjectWorkGatewayLive } from "./ProjectWorkGateway.ts";
import { ProjectWorkSearchLive } from "./ProjectWorkSearch.ts";
import { ProjectWorkBriefingLive } from "./ProjectWorkBriefing.ts";
import { ProjectWorkNarrativeLive } from "./ProjectWorkNarrative.ts";
import { ProjectWorkVerification } from "./ProjectWorkVerification.ts";
import {
  ProjectWorkVerificationRequest,
  makeProjectWorkVerificationRequest,
} from "./ProjectWorkVerificationRequest.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";

const decodeWrite = Schema.decodeUnknownEffect(ProjectTeamWriteIntent);
const decodeRead = Schema.decodeUnknownEffect(ProjectWorkReadIntent);
const fixture = Effect.gen(function* () {
  const f = yield* verificationFixture;
  const principal = { actor: { kind: "human" as const, id: "user:maintainer" } };
  const source = { kind: "web" as const, id: "browser" };
  const sessions = yield* AuthSessions.make;
  const now = Date.parse(at) + 1;
  const session = {
    sessionId: AuthSessionId.make("verification-browser"),
    subject: principal.actor.id,
    identity: { kind: "user" as const, id: principal.actor.id },
    method: "browser-session-cookie" as const,
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    expiresAt: DateTime.makeUnsafe(now + 60_000),
  };
  yield* sessions.create({
    ...session,
    issuedAt: DateTime.makeUnsafe(now),
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "unknown",
      os: null,
      browser: null,
    },
  });
  let captures = 0;
  let revokeAfterCapture = false;
  let hostAvailable = true;
  const root = ProjectWorkVerification.of({
    environmentId: EnvironmentId.make("environment"),
    readPrepared: (jobId) =>
      hostAvailable ? f.jobs.readPrepared(jobId) : Effect.die("Verification host unavailable"),
    prepare: (selection, caller) =>
      Effect.gen(function* () {
        if (!hostAvailable) return yield* Effect.die("Verification host unavailable");
        captures++;
        const receipt = yield* f.preparation.prepare(selection, caller);
        if (revokeAfterCapture)
          yield* f.sql`UPDATE auth_sessions SET revoked_at=${at} WHERE session_id=${session.sessionId}`;
        return receipt;
      }),
  });
  const dependencies = Layer.mergeAll(
    ProjectWorkSearchLive,
    ProjectWorkNarrativeLive,
    ProjectWorkBriefingLive,
    ServerSettings.layerTest({ projectWorkEnabled: true }),
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
    Layer.succeed(ProjectWorkVerification, root),
  );
  const gateway = yield* ProjectWorkGateway.pipe(
    Effect.provide(ProjectWorkGatewayLive.pipe(Layer.provide(dependencies))),
  );
  const request = (purpose: "read" | "write") =>
    makeProjectWorkVerificationRequest(session, f.selection.projectId, purpose).pipe(
      Effect.provideService(AuthSessions.AuthSessionRepository, sessions),
    );
  const input = yield* decodeWrite({
    ...f.selection,
    type: "project-team.verification.propose",
    commandId: "gateway-verification",
  });
  const preview = yield* decodeRead({
    operation: "verification-job",
    projectId: f.selection.projectId,
    taskId: f.selection.taskId,
    verificationJobId: f.selection.jobId,
  });
  return {
    ...f,
    gateway,
    principal,
    source,
    request,
    input,
    preview,
    captures: () => captures,
    session,
    revokeAfterCapture: () => {
      revokeAfterCapture = true;
    },
    disableHost: () => {
      hostAvailable = false;
    },
  };
});

for (const permission of ["missing", "revoked", "expired", "read-only", "current"] as const) {
  it.effect(`verification rejection checks ${permission} human permission without its host`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = yield* f.request("write");
        yield* f.gateway
          .write(f.input, f.principal.actor, f.source, f.principal)
          .pipe(Effect.provideService(ProjectWorkVerificationRequest, request));
        const state = yield* readCurrentState(f.sql, f.selection.projectId);
        const gate = state.foundationRecords?.find(
          (row) => row.kind === "gate" && row.verificationJobId === f.selection.jobId,
        );
        if (gate?.kind !== "gate") return yield* Effect.die("Missing verification gate");
        const input = yield* decodeWrite({
          type: "project-team.gate.respond",
          commandId: "gateway-reject",
          projectId: f.selection.projectId,
          taskId: f.selection.taskId,
          expectedRevision: state.revision,
          expectedTaskRevision: f.selection.expectedTaskRevision,
          specRevision: f.selection.specRevision,
          planRevision: f.selection.planRevision,
          gateId: gate.recordId,
          expectedGateRevision: gate.revision,
          response: "rejected",
        });
        f.disableHost();
        if (permission === "revoked")
          yield* f.sql`UPDATE auth_sessions SET revoked_at=${at} WHERE session_id=${f.session.sessionId}`;
        if (permission === "expired")
          yield* f.sql`UPDATE auth_sessions SET expires_at=${at} WHERE session_id=${f.session.sessionId}`;
        const supplied = permission === "read-only" ? yield* f.request("read") : request;
        const raw = f.gateway.write(input, f.principal.actor, f.source, f.principal);
        const reject =
          permission === "missing"
            ? raw
            : raw.pipe(Effect.provideService(ProjectWorkVerificationRequest, supplied));
        const result = yield* reject.pipe(Effect.result);
        const after = yield* readCurrentState(f.sql, f.selection.projectId);
        const receipts =
          yield* f.sql`SELECT command_id FROM project_work_command_receipts WHERE command_id=${input.commandId}`;
        expect(f.captures()).toBe(1);
        if (permission !== "current") {
          expect(result._tag).toBe("Failure");
          expect(after).toEqual(state);
          expect(receipts).toEqual([]);
          return;
        }
        expect(result._tag).toBe("Success");
        expect(after.foundationRecords?.find((row) => row.recordId === gate.recordId)?.status).toBe(
          "rejected",
        );
        expect(receipts).toHaveLength(1);
        yield* reject;
        expect(yield* readCurrentState(f.sql, f.selection.projectId)).toEqual(after);
        yield* f.sql`UPDATE auth_sessions SET revoked_at=${at} WHERE session_id=${f.session.sessionId}`;
        expect((yield* reject.pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* readCurrentState(f.sql, f.selection.projectId)).toEqual(after);
        expect(
          yield* f.sql`SELECT command_id FROM project_work_command_receipts WHERE command_id=${input.commandId}`,
        ).toEqual(receipts);
      }),
    ),
  );
}

it.effect(
  "public proposal requires a retained human request and its exact retry does not recapture",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        expect(
          (yield* f.gateway
            .write(f.input, f.principal.actor, f.source, f.principal)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(f.captures()).toBe(0);
        const request = yield* f.request("write");
        const write = f.gateway
          .write(f.input, f.principal.actor, f.source, f.principal)
          .pipe(Effect.provideService(ProjectWorkVerificationRequest, request));
        yield* write;
        const first = yield* readCurrentState(f.sql, f.selection.projectId);
        yield* write;
        const replay = yield* readCurrentState(f.sql, f.selection.projectId);
        expect(replay.revision).toBe(first.revision);
        expect(f.captures()).toBe(1);
        const changed = yield* decodeWrite({
          ...f.input,
          command: { ...f.selection.command, argv: ["different"] },
        });
        expect(
          (yield* f.gateway
            .write(changed, f.principal.actor, f.source, f.principal)
            .pipe(Effect.provideService(ProjectWorkVerificationRequest, request), Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(f.captures()).toBe(1);
      }),
    ),
);

it.effect(
  "preview denies an orphan, shows the gate's exact job, and denies revoked permission",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const readRequest = yield* f.request("read");
        const read = f.gateway
          .read(f.preview, f.principal)
          .pipe(Effect.provideService(ProjectWorkVerificationRequest, readRequest));
        expect((yield* read.pipe(Effect.result))._tag).toBe("Failure");
        const writeRequest = yield* f.request("write");
        yield* f.gateway
          .write(f.input, f.principal.actor, f.source, f.principal)
          .pipe(Effect.provideService(ProjectWorkVerificationRequest, writeRequest));
        expect(yield* read).toEqual({ kind: "verification-job", ...f.prepared });
        yield* f.sql`UPDATE auth_sessions SET revoked_at=${at} WHERE session_id=${f.session.sessionId}`;
        expect((yield* read.pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* f.jobs.readPrepared(f.selection.jobId)).toEqual(f.prepared);
      }),
    ),
);

it.effect("late revocation after preparation cannot commit a pending approval", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const request = yield* f.request("write");
      f.revokeAfterCapture();
      const result = yield* f.gateway
        .write(f.input, f.principal.actor, f.source, f.principal)
        .pipe(Effect.provideService(ProjectWorkVerificationRequest, request), Effect.result);
      expect(result._tag).toBe("Failure");
      expect(f.captures()).toBe(1);
      const current = yield* readCurrentState(f.sql, f.selection.projectId);
      expect(
        (current.foundationRecords ?? []).filter(
          (row) => row.kind === "gate" && row.verificationJobId === f.selection.jobId,
        ),
      ).toEqual([]);
      expect(
        yield* f.sql`SELECT command_id FROM project_work_command_receipts WHERE command_id=${f.input.commandId}`,
      ).toEqual([]);
      expect(yield* f.jobs.readPrepared(f.selection.jobId)).toEqual(f.prepared);
    }),
  ),
);

it.effect("approval binds the exact pending job and its retry emits no second decision", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const request = yield* f.request("write");
      yield* f.gateway
        .write(f.input, f.principal.actor, f.source, f.principal)
        .pipe(Effect.provideService(ProjectWorkVerificationRequest, request));
      const state = yield* readCurrentState(f.sql, f.selection.projectId);
      const gate = state.foundationRecords?.find(
        (row) => row.kind === "gate" && row.verificationJobId === f.selection.jobId,
      );
      if (gate?.kind !== "gate") return yield* Effect.die("Missing verification approval gate");
      const input = yield* decodeWrite({
        type: "project-team.gate.respond",
        commandId: "gateway-approve",
        projectId: f.selection.projectId,
        taskId: f.selection.taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: f.selection.expectedTaskRevision,
        specRevision: f.selection.specRevision,
        planRevision: f.selection.planRevision,
        gateId: gate.recordId,
        expectedGateRevision: gate.revision,
        response: "approved",
      });
      const approve = f.gateway
        .write(input, f.principal.actor, f.source, f.principal)
        .pipe(Effect.provideService(ProjectWorkVerificationRequest, request));
      yield* approve;
      const first = yield* readCurrentState(f.sql, f.selection.projectId);
      yield* approve;
      const second = yield* readCurrentState(f.sql, f.selection.projectId);
      expect(second.revision).toBe(first.revision);
      expect(second.foundationRecords?.find((row) => row.recordId === gate.recordId)).toMatchObject(
        {
          kind: "gate",
          status: "approved",
          verificationJobId: f.selection.jobId,
          contentHash: f.prepared.sha256,
        },
      );
      expect(f.captures()).toBe(1);
    }),
  ),
);
