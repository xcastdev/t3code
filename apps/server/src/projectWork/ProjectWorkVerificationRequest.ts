import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { authIdentityForSession, type AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import type { ProjectTeamPrincipal } from "./ProjectTeamAuthorization.ts";

export class ProjectWorkVerificationRequestError extends Schema.TaggedError<ProjectWorkVerificationRequestError>()(
  "ProjectWorkVerificationRequestError",
  { reason: Schema.String },
) {}

export class ProjectWorkVerificationRequest extends Context.Service<
  ProjectWorkVerificationRequest,
  {
    readonly assertCurrent: (
      principal: ProjectTeamPrincipal,
      projectId: ProjectId,
      purpose: "read" | "write",
    ) => Effect.Effect<void, ProjectWorkVerificationRequestError>;
  }
>()("t3/projectWork/ProjectWorkVerificationRequest") {}

export function makeProjectWorkVerificationRequest(
  authenticatedSession: AuthenticatedSession,
  projectId: ProjectId,
  purpose: "read" | "write",
) {
  // Capture the request before the factory Effect can wait for its repository.
  const captured = {
    sessionId: authenticatedSession.sessionId,
    subject: authenticatedSession.subject,
    method: authenticatedSession.method,
    identityKind: authenticatedSession.identity.kind,
    identityId: authenticatedSession.identity.id,
    scopes: [...authenticatedSession.scopes],
    managed: authenticatedSession.managed !== undefined,
    projectId,
    purpose,
  };
  return Effect.gen(function* () {
    const repository = yield* AuthSessionRepository;
    const check = Effect.fn("ProjectWorkVerificationRequest.assertCurrent")(function* (
      actorKind: string,
      actorId: string | undefined,
      managed: boolean,
      requestedProject: ProjectId,
      requestedPurpose: "read" | "write",
    ) {
      const deny = (reason: string) => new ProjectWorkVerificationRequestError({ reason });
      const scope =
        captured.purpose === "read" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope;
      if (
        captured.identityKind !== "user" ||
        (captured.purpose !== "read" && captured.purpose !== "write") ||
        captured.managed ||
        captured.subject.startsWith("agent:") ||
        actorKind !== "human" ||
        actorId !== captured.identityId ||
        managed ||
        requestedProject !== captured.projectId ||
        requestedPurpose !== captured.purpose ||
        !captured.scopes.includes(scope)
      )
        return yield* deny(
          "Verification permission does not match the authenticated human request",
        );
      const current = yield* repository
        .getById({ sessionId: captured.sessionId })
        .pipe(Effect.mapError(() => deny("Unable to read the current authenticated session")));
      const now = yield* Clock.currentTimeMillis;
      if (Option.isNone(current)) return yield* deny("Authenticated session is no longer retained");
      const row = current.value;
      const expiresAt = DateTime.toEpochMillis(row.expiresAt);
      if (
        row.sessionId !== captured.sessionId ||
        row.subject !== captured.subject ||
        row.method !== captured.method ||
        row.revokedAt !== null ||
        !row.scopes.includes(scope) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now
      )
        return yield* deny("Authenticated session permission is no longer current");
      const identity = yield* Effect.try({
        try: () =>
          authIdentityForSession({
            subject: row.subject,
            client: { deviceType: row.client.deviceType },
          }),
        catch: () => deny("Unable to derive the current authenticated session identity"),
      });
      if (identity.kind !== "user" || identity.id !== captured.identityId)
        return yield* deny("Authenticated session no longer has the captured human identity");
    });
    return ProjectWorkVerificationRequest.of({
      assertCurrent: (principal, requestedProject, requestedPurpose) =>
        check(
          principal.actor.kind,
          principal.actor.id,
          principal.managed !== undefined,
          requestedProject,
          requestedPurpose,
        ),
    });
  });
}
