import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { makeProjectWorkVerificationRequest } from "./ProjectWorkVerificationRequest.ts";

const now = 1_800_000_000_000;
const projectId = ProjectId.make("verification-project");
const principal = { actor: { kind: "human", id: "user:verification-human" } } as const;
const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(now);
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* AuthSessions.make;
  const session = {
    sessionId: AuthSessionId.make("verification-session"),
    subject: "user:verification-human",
    method: "browser-session-cookie" as const,
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    identity: { kind: "user" as const, id: String(principal.actor.id) },
    expiresAt: DateTime.makeUnsafe(now + 1000),
  };
  yield* repository.create({
    ...session,
    issuedAt: DateTime.makeUnsafe(now - 1000),
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "unknown",
      os: null,
      browser: null,
    },
  });
  return { sql, repository, session };
});
const database = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  body.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

for (const purpose of ["read", "write"] as const) {
  it.effect(
    `a legacy ${purpose} request loses human permission when its retained metadata derives an agent`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* fixture;
          const session = {
            ...f.session,
            subject: "legacy-verification-human",
            identity: { kind: "user" as const, id: "user:legacy-verification-human" },
          };
          const legacyPrincipal = { actor: { kind: "human" as const, id: session.identity.id } };
          yield* f.sql`UPDATE auth_sessions SET subject=${session.subject} WHERE session_id=${session.sessionId}`;
          const request = yield* makeProjectWorkVerificationRequest(
            session,
            projectId,
            purpose,
          ).pipe(Effect.provideService(AuthSessions.AuthSessionRepository, f.repository));
          yield* request.assertCurrent(legacyPrincipal, projectId, purpose);
          yield* f.sql`UPDATE auth_sessions SET client_device_type='bot' WHERE session_id=${session.sessionId}`;
          expect(
            yield* request.assertCurrent(legacyPrincipal, projectId, purpose).pipe(Effect.result),
          ).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ProjectWorkVerificationRequestError" },
          });
          yield* f.sql`UPDATE auth_sessions SET client_device_type='unknown' WHERE session_id=${session.sessionId}`;
          yield* request.assertCurrent(legacyPrincipal, projectId, purpose);
        }),
      ),
  );
  it.effect(
    `an explicit user ${purpose} request remains human after bot metadata and label changes`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* fixture;
          const request = yield* makeProjectWorkVerificationRequest(
            f.session,
            projectId,
            purpose,
          ).pipe(Effect.provideService(AuthSessions.AuthSessionRepository, f.repository));
          yield* request.assertCurrent(principal, projectId, purpose);
          yield* f.sql`UPDATE auth_sessions SET client_device_type='bot',client_label='New client label' WHERE session_id=${f.session.sessionId}`;
          yield* request.assertCurrent(principal, projectId, purpose);
        }),
      ),
  );
}

it.effect("a request rechecks actual SQL revocation after its initial human permission", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture;
      const request = yield* makeProjectWorkVerificationRequest(f.session, projectId, "write").pipe(
        Effect.provideService(AuthSessions.AuthSessionRepository, f.repository),
      );
      yield* request.assertCurrent(principal, projectId, "write");
      yield* f.repository.revoke({
        sessionId: f.session.sessionId,
        revokedAt: DateTime.makeUnsafe(now),
      });
      expect(
        yield* request.assertCurrent(principal, projectId, "write").pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ProjectWorkVerificationRequestError" },
      });
    }),
  ),
);

for (const purpose of ["read", "write"] as const) {
  for (const change of [
    "removed",
    "scopes",
    "subject",
    "method",
    "expired",
    "invalid expiry",
    "invalid scopes",
    "storage failure",
  ] as const) {
    it.effect(`a ${purpose} request fails closed after current SQL ${change}`, () =>
      database(
        Effect.gen(function* () {
          const f = yield* fixture;
          const request = yield* makeProjectWorkVerificationRequest(
            f.session,
            projectId,
            purpose,
          ).pipe(Effect.provideService(AuthSessions.AuthSessionRepository, f.repository));
          yield* request.assertCurrent(principal, projectId, purpose);
          switch (change) {
            case "removed":
              yield* f.sql`DELETE FROM auth_sessions WHERE session_id=${f.session.sessionId}`;
              break;
            case "scopes":
              yield* f.sql`UPDATE auth_sessions SET scopes=${purpose === "read" ? '["orchestration:operate"]' : '["orchestration:read"]'} WHERE session_id=${f.session.sessionId}`;
              break;
            case "subject":
              yield* f.sql`UPDATE auth_sessions SET subject='user:replacement' WHERE session_id=${f.session.sessionId}`;
              break;
            case "method":
              yield* f.sql`UPDATE auth_sessions SET method='bearer-access-token' WHERE session_id=${f.session.sessionId}`;
              break;
            case "expired":
              yield* f.sql`UPDATE auth_sessions SET expires_at=${DateTime.formatIso(DateTime.makeUnsafe(now))} WHERE session_id=${f.session.sessionId}`;
              break;
            case "invalid expiry":
              yield* f.sql`UPDATE auth_sessions SET expires_at='invalid' WHERE session_id=${f.session.sessionId}`;
              break;
            case "invalid scopes":
              yield* f.sql`UPDATE auth_sessions SET scopes='invalid' WHERE session_id=${f.session.sessionId}`;
              break;
            case "storage failure":
              yield* f.sql`DROP TABLE auth_sessions`;
              break;
          }
          expect(
            yield* request.assertCurrent(principal, projectId, purpose).pipe(Effect.result),
          ).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ProjectWorkVerificationRequestError" },
          });
        }),
      ),
    );
  }
  it.effect(`a ${purpose} request requires both the original and current purpose scope`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture;
        const session = {
          ...f.session,
          scopes: f.session.scopes.filter(
            (scope) =>
              scope !==
              (purpose === "read" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope),
          ),
        };
        const constructing = makeProjectWorkVerificationRequest(session, projectId, purpose);
        session.scopes = [...f.session.scopes];
        const request = yield* constructing.pipe(
          Effect.provideService(AuthSessions.AuthSessionRepository, f.repository),
        );
        expect(
          yield* request.assertCurrent(principal, projectId, purpose).pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProjectWorkVerificationRequestError" },
        });
      }),
    ),
  );
  it.effect(`a ${purpose} request uses the current Effect clock and denies exact expiry`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = yield* makeProjectWorkVerificationRequest(
          f.session,
          projectId,
          purpose,
        ).pipe(Effect.provideService(AuthSessions.AuthSessionRepository, f.repository));
        yield* request.assertCurrent(principal, projectId, purpose);
        yield* TestClock.setTime(now + 1000);
        expect(
          yield* request.assertCurrent(principal, projectId, purpose).pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProjectWorkVerificationRequestError" },
        });
      }),
    ),
  );
}

it.effect("captures the original session synchronously without retaining its mutable fields", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture;
      const originalId = f.session.sessionId;
      const originalDateTime = f.session.expiresAt;
      const constructing = makeProjectWorkVerificationRequest(f.session, projectId, "write");
      f.session.sessionId = AuthSessionId.make("replacement-session");
      f.session.subject = "agent:replacement";
      f.session.scopes.length = 0;
      f.session.identity.id = "replacement-identity";
      const request = yield* constructing.pipe(
        Effect.provideService(AuthSessions.AuthSessionRepository, f.repository),
      );
      expect(f.session.expiresAt).toBe(originalDateTime);
      expect(DateTime.toEpochMillis(originalDateTime)).toBe(now + 1000);
      yield* request.assertCurrent(principal, projectId, "write");
      expect(
        yield* request
          .assertCurrent(
            { actor: { kind: "human", id: "replacement-identity" } },
            projectId,
            "write",
          )
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      yield* f.repository.revoke({ sessionId: originalId, revokedAt: DateTime.makeUnsafe(now) });
      expect(
        yield* request.assertCurrent(principal, projectId, "write").pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
    }),
  ),
);

for (const method of ["bearer-access-token", "dpop-access-token"] as const) {
  it.effect(`a current human ${method} request uses the same retained-session permission`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.sql`UPDATE auth_sessions SET method=${method} WHERE session_id=${f.session.sessionId}`;
        const request = yield* makeProjectWorkVerificationRequest(
          { ...f.session, method },
          projectId,
          "write",
        ).pipe(Effect.provideService(AuthSessions.AuthSessionRepository, f.repository));
        yield* request.assertCurrent(principal, projectId, "write");
      }),
    ),
  );
}

it.effect(
  "rejects replacement principals, projects and purposes without retargeting the request",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = yield* makeProjectWorkVerificationRequest(
          f.session,
          projectId,
          "read",
        ).pipe(Effect.provideService(AuthSessions.AuthSessionRepository, f.repository));
        for (const actor of [
          { kind: "human", id: "other-human" },
          { kind: "human" },
          { kind: "agent", id: principal.actor.id },
          { kind: "system", id: principal.actor.id },
          { kind: "adapter", id: principal.actor.id },
        ] as const)
          expect(
            yield* request.assertCurrent({ actor }, projectId, "read").pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" });
        expect(
          yield* request
            .assertCurrent(principal, ProjectId.make("other-project"), "read")
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        expect(
          yield* request.assertCurrent(principal, projectId, "write").pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        const mutablePrincipal = { actor: { kind: "human" as const, id: "other-human" } };
        const pending = request.assertCurrent(mutablePrincipal, projectId, "read");
        mutablePrincipal.actor.id = principal.actor.id;
        expect(yield* pending.pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
        yield* request.assertCurrent(principal, projectId, "read");
      }),
    ),
);

const managed = {
  projectId,
  bindingId: "managed-binding",
  generation: 1,
  providerInstanceId: ProviderInstanceId.make("pi"),
  threadId: ThreadId.make("managed-thread"),
};
it.effect(
  "managed credentials and managed or agent session subjects cannot claim human permission",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture;
        const sessions: AuthenticatedSession[] = [
          { ...f.session, identity: { kind: "agent", id: principal.actor.id } },
          { ...f.session, managed },
          { ...f.session, subject: "agent:project-team:invalid-reserved-credential" },
          { ...f.session, subject: "agent:legacy-agent" },
        ];
        for (const session of sessions) {
          const request = yield* makeProjectWorkVerificationRequest(
            session,
            projectId,
            "write",
          ).pipe(Effect.provideService(AuthSessions.AuthSessionRepository, f.repository));
          expect(
            yield* request.assertCurrent(principal, projectId, "write").pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" });
        }
        const request = yield* makeProjectWorkVerificationRequest(
          f.session,
          projectId,
          "write",
        ).pipe(Effect.provideService(AuthSessions.AuthSessionRepository, f.repository));
        expect(
          yield* request
            .assertCurrent({ ...principal, managed }, projectId, "write")
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        yield* request.assertCurrent(principal, projectId, "write");
      }),
    ),
);

it.effect("a request can revalidate inside its caller's atomic SQL transaction", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture;
      const request = yield* makeProjectWorkVerificationRequest(f.session, projectId, "write").pipe(
        Effect.provideService(AuthSessions.AuthSessionRepository, f.repository),
      );
      yield* f.sql.withTransaction(
        Effect.gen(function* () {
          yield* request.assertCurrent(principal, projectId, "write");
          yield* f.repository.revoke({
            sessionId: f.session.sessionId,
            revokedAt: DateTime.makeUnsafe(now),
          });
          expect(
            yield* request.assertCurrent(principal, projectId, "write").pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" });
        }),
      );
    }),
  ),
);
