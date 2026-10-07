import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  ProjectId,
  type PullRequestActionInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Sessions from "../persistence/AuthSessions.ts";
import { makeProjectWorkHumanMergeRequest } from "./ProjectWorkHumanMergeRequest.ts";
const now = 1800000000000;
const projectId = ProjectId.make("human-merge-project");
const input: PullRequestActionInput = {
  projectId,
  host: "github.com",
  repository: "owner/project",
  number: 42,
  action: "merge",
  mergeMethod: "squash",
};
const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(now);
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* Sessions.make;
  const session = {
    sessionId: AuthSessionId.make("merge-human-session"),
    subject: "user:maintainer",
    identity: { kind: "user" as const, id: "user:maintainer" },
    scopes: [AuthOrchestrationOperateScope],
    method: "browser-session-cookie" as const,
    expiresAt: DateTime.makeUnsafe(now + 1000),
  };
  yield* sessions.create({
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
  const make = (request: PullRequestActionInput = input) =>
    makeProjectWorkHumanMergeRequest(session, request).pipe(
      Effect.provideService(Sessions.AuthSessionRepository, sessions),
    );
  return { sql, sessions, session, make };
});
const database = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));
it.effect(
  "human merge permission captures the original principal and exact method before waiting",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture;
        const submitted = { ...input };
        const prepared = f.make(submitted);
        submitted.mergeMethod = "rebase";
        f.session.identity.id = "user:replacement";
        const permission = yield* prepared;
        expect((yield* permission.assertCurrent(projectId, input)).actor).toEqual({
          kind: "human",
          id: "user:maintainer",
        });
        expect(
          yield* permission.assertCurrent(projectId, submitted).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "authorization-denied" } });
      }),
    ),
);
for (const change of ["revoked", "expired", "scope", "subject", "method", "deleted"] as const) {
  it.effect(`human merge permission rejects retained session ${change}`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture;
        const permission = yield* f.make();
        yield* permission.assertCurrent(projectId, input);
        if (change === "revoked")
          yield* f.sql`UPDATE auth_sessions SET revoked_at=${DateTime.formatIso(DateTime.makeUnsafe(now))} WHERE session_id=${f.session.sessionId}`;
        if (change === "expired") yield* TestClock.adjust(1000);
        if (change === "scope")
          yield* f.sql`UPDATE auth_sessions SET scopes='[]' WHERE session_id=${f.session.sessionId}`;
        if (change === "subject")
          yield* f.sql`UPDATE auth_sessions SET subject='agent:reclassified' WHERE session_id=${f.session.sessionId}`;
        if (change === "method")
          yield* f.sql`UPDATE auth_sessions SET method='bearer-access-token' WHERE session_id=${f.session.sessionId}`;
        if (change === "deleted")
          yield* f.sql`DELETE FROM auth_sessions WHERE session_id=${f.session.sessionId}`;
        expect((yield* permission.assertCurrent(projectId, input).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      }),
    ),
  );
}
it.effect(
  "human merge permission refuses automatic or stacked consent and unavailable session storage",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const changed of [
          { ...input, action: "enable-auto-merge" as const },
          {
            ...input,
            stackNumber: 4,
            expectedStackHeads: [{ number: 42, headSha: "b".repeat(40) }],
          },
        ]) {
          const permission = yield* f.make(changed);
          expect(
            (yield* permission.assertCurrent(projectId, changed).pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        const permission = yield* f.make();
        yield* f.sql`DROP TABLE auth_sessions`;
        expect(yield* permission.assertCurrent(projectId, input).pipe(Effect.result)).toMatchObject(
          { _tag: "Failure", failure: { reason: "persistence" } },
        );
      }),
    ),
);

it.effect("human merge permission denies managed or agent identities and a different project", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture;
      const human = yield* f.make();
      expect(
        (yield* human.assertCurrent(ProjectId.make("other-project"), input).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      const agent = yield* makeProjectWorkHumanMergeRequest(
        {
          ...f.session,
          subject: "agent:maintainer",
          identity: { kind: "agent", id: "agent:maintainer" },
        },
        input,
      ).pipe(Effect.provideService(Sessions.AuthSessionRepository, f.sessions));
      expect((yield* agent.assertCurrent(projectId, input).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }),
  ),
);
