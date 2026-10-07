import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  ProjectId,
  type GitRunStackedActionInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { makeProjectWorkHumanPublicationRequest } from "./ProjectWorkHumanPublicationRequest.ts";

const now = 1_800_000_000_000;
const projectId = ProjectId.make("publication-request-project");
const input: GitRunStackedActionInput = {
  cwd: "/controlled/worktree",
  action: "create_pr",
  actionId: "human-action",
  precondition: { expectedHeadCommit: "b".repeat(40), expectedIndexTree: "c".repeat(40) },
};
const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(now);
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* AuthSessions.make;
  const session = {
    sessionId: AuthSessionId.make("publication-session"),
    subject: "user:maintainer",
    identity: { kind: "user" as const, id: "user:maintainer" },
    scopes: [AuthOrchestrationOperateScope],
    method: "browser-session-cookie" as const,
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
  const make = (request: GitRunStackedActionInput = input) =>
    makeProjectWorkHumanPublicationRequest(session, request).pipe(
      Effect.provideService(AuthSessions.AuthSessionRepository, repository),
    );
  return { sql, repository, session, make };
});
const database = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("publication permission captures original human and request before waiting", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture;
      const submitted = { ...input };
      const prepared = f.make(submitted);
      submitted.actionId = "replacement-action";
      f.session.identity.id = "user:replacement";
      const request = yield* prepared;
      expect((yield* request.assertCurrent(projectId, input)).actor).toEqual({
        kind: "human",
        id: "user:maintainer",
      });
      expect(yield* request.assertCurrent(projectId, submitted).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "authorization-denied" },
      });
    }),
  ),
);

for (const change of ["revoked", "expired", "scope", "subject", "method", "deleted"] as const) {
  it.effect(`publication permission rechecks retained session ${change}`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = yield* f.make();
        yield* request.assertCurrent(projectId, input);
        if (change === "revoked")
          yield* f.sql`UPDATE auth_sessions SET revoked_at=${DateTime.formatIso(DateTime.makeUnsafe(now))} WHERE session_id=${f.session.sessionId}`;
        if (change === "expired")
          yield* f.sql`UPDATE auth_sessions SET expires_at=${DateTime.formatIso(DateTime.makeUnsafe(now))} WHERE session_id=${f.session.sessionId}`;
        if (change === "scope")
          yield* f.sql`UPDATE auth_sessions SET scopes='[]' WHERE session_id=${f.session.sessionId}`;
        if (change === "subject")
          yield* f.sql`UPDATE auth_sessions SET subject='user:other' WHERE session_id=${f.session.sessionId}`;
        if (change === "method")
          yield* f.sql`UPDATE auth_sessions SET method='bearer-access-token' WHERE session_id=${f.session.sessionId}`;
        if (change === "deleted")
          yield* f.sql`DELETE FROM auth_sessions WHERE session_id=${f.session.sessionId}`;
        expect(yield* request.assertCurrent(projectId, input).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "authorization-denied" },
        });
      }),
    ),
  );
}

it.effect(
  "publication permission rejects a retained legacy subject that now derives an agent",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.session.subject = "legacy-maintainer";
        f.session.identity.id = "user:legacy-maintainer";
        yield* f.sql`UPDATE auth_sessions SET subject=${f.session.subject} WHERE session_id=${f.session.sessionId}`;
        const request = yield* f.make();
        yield* request.assertCurrent(projectId, input);
        yield* f.sql`UPDATE auth_sessions SET client_device_type='bot' WHERE session_id=${f.session.sessionId}`;
        expect(yield* request.assertCurrent(projectId, input).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "authorization-denied" },
        });
      }),
    ),
);

it.effect(
  "publication permission propagates storage failure instead of granting human access",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = yield* f.make();
        yield* f.sql`DROP TABLE auth_sessions`;
        expect(yield* request.assertCurrent(projectId, input).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "persistence" },
        });
      }),
    ),
);
