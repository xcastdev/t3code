import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScopes,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as Publication from "./ProjectWorkHumanPublicationRequest.ts";
import * as Merge from "./ProjectWorkManagedMerge.ts";
import * as Journal from "./ProjectWorkPublicationJournal.ts";
import {
  at,
  principal,
  input,
  dependencies,
  operation,
  outcome,
  confirmation,
} from "./ProjectWorkPublication.testkit.ts";
const authLayer = Authorization.layer.pipe(
  Layer.provideMerge(AuthSessions.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);
const seedSession = Effect.fn("PublicationPermissionsTest.seedSession")(function* (
  scopes: AuthEnvironmentScopes,
) {
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const subject = principal.actor.id;
  if (subject === undefined) throw new Error("The human session fixture requires a subject.");
  yield* sessions.create({
    sessionId: AuthSessionId.make("session"),
    subject,
    scopes,
    method: "browser-session-cookie",
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "unknown",
      os: null,
      browser: null,
    },
    issuedAt: DateTime.makeUnsafe(at),
    expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
  });
});
const grantCases = [
  { kind: "publication", grant: "operate-only" },
  { kind: "publication", grant: "source-control-only" },
  { kind: "publication", grant: "both" },
  { kind: "merge", grant: "operate-only" },
  { kind: "merge", grant: "source-control-only" },
  { kind: "merge", grant: "both" },
] as const;
it.effect.each(grantCases)(
  "$kind requires both live orchestration and source-control scopes: $grant",
  ({ kind, grant }) => {
    let writes = 0;
    const scopes: AuthEnvironmentScopes =
      grant === "both"
        ? [AuthOrchestrationOperateScope, AuthSourceControlWriteScope]
        : [grant === "operate-only" ? AuthOrchestrationOperateScope : AuthSourceControlWriteScope];
    return Effect.gen(function* () {
      yield* seedSession(scopes);
      const authorization = yield* Authorization.ProjectTeamAuthorization;
      const domainLayer = Layer.mergeAll(Publication.layer, Merge.layer).pipe(
        Layer.provide(
          dependencies({
            authorization,
            host: {
              create: (selected, assertHuman) =>
                assertHuman.pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      writes++;
                      return outcome(selected);
                    }),
                  ),
                ),
              supportsExactMerge: () => Effect.succeed(true),
              mergeExact: (_selected, assertHuman) =>
                assertHuman.pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      writes++;
                      return confirmation;
                    }),
                  ),
                ),
            },
          }),
        ),
        Layer.provideMerge(Journal.layer),
      );
      yield* Effect.gen(function* () {
        if (kind === "merge") {
          const journal = yield* Journal.ProjectWorkPublicationJournal;
          const published = operation();
          yield* journal.retain(published);
          yield* journal.claim(published);
          yield* journal.save({
            ...published,
            stage: "confirmed",
            publication: outcome(published),
          });
          yield* journal.retain(operation("merge"));
        }
        const result = yield* (
          kind === "publication"
            ? (yield* Publication.ProjectWorkHumanPublicationRequest).execute(input, principal)
            : (yield* Merge.ProjectWorkManagedMerge).execute(
                { operationId: "merge", publicationOperationId: "publish", gateId: "gate" },
                principal,
              )
        ).pipe(Effect.result);
        assert.equal(result._tag, grant === "both" ? "Success" : "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "authorization");
        if (result._tag === "Success") assert.equal(result.success.stage, "confirmed");
        assert.equal(writes, grant === "both" ? 1 : 0);
      }).pipe(Effect.provide(domainLayer));
    }).pipe(Effect.provide(authLayer));
  },
);
it.effect.each(["publication", "merge"] as const)(
  "%s rechecks the live combined grant at the retained native write boundary",
  (kind) => {
    let writes = 0;
    return Effect.gen(function* () {
      yield* seedSession([AuthOrchestrationOperateScope, AuthSourceControlWriteScope]);
      const authorization = yield* Authorization.ProjectTeamAuthorization;
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const revoke = sessions.revoke({
        sessionId: AuthSessionId.make("session"),
        revokedAt: DateTime.makeUnsafe(at),
      });
      const domainLayer = Layer.mergeAll(Publication.layer, Merge.layer).pipe(
        Layer.provide(
          dependencies({
            authorization,
            host: {
              create: (selected, assertHuman) =>
                revoke.pipe(
                  Effect.mapError(
                    (cause) => new Journal.PublicationError({ reason: "authorization", cause }),
                  ),
                  Effect.andThen(assertHuman),
                  Effect.andThen(
                    Effect.sync(() => {
                      writes++;
                      return outcome(selected);
                    }),
                  ),
                ),
              supportsExactMerge: () => Effect.succeed(true),
              mergeExact: (_selected, assertHuman) =>
                revoke.pipe(
                  Effect.mapError(
                    (cause) => new Journal.PublicationError({ reason: "authorization", cause }),
                  ),
                  Effect.andThen(assertHuman),
                  Effect.andThen(
                    Effect.sync(() => {
                      writes++;
                      return confirmation;
                    }),
                  ),
                ),
            },
          }),
        ),
        Layer.provideMerge(Journal.layer),
      );
      yield* Effect.gen(function* () {
        if (kind === "merge") {
          const journal = yield* Journal.ProjectWorkPublicationJournal;
          const published = operation();
          yield* journal.retain(published);
          yield* journal.claim(published);
          yield* journal.save({
            ...published,
            stage: "confirmed",
            publication: outcome(published),
          });
          yield* journal.retain(operation("merge"));
        }
        const result = yield* kind === "publication"
          ? (yield* Publication.ProjectWorkHumanPublicationRequest).execute(input, principal)
          : (yield* Merge.ProjectWorkManagedMerge).execute(
              { operationId: "merge", publicationOperationId: "publish", gateId: "gate" },
              principal,
            );
        assert.equal(result.stage, "uncertain");
        assert.equal(writes, 0);
      }).pipe(Effect.provide(domainLayer));
    }).pipe(Effect.provide(authLayer));
  },
);
