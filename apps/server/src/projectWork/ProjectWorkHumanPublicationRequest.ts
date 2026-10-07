import {
  AuthOrchestrationOperateScope,
  GitRunStackedActionInput,
  canonicalProjectWorkPayload,
  type ProjectId,
  type ProjectWorkAttribution,
  type ProjectWorkPublicationOutcome,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { authIdentityForSession, type AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import { PublicationError, ProjectWorkPullRequests } from "./ProjectWorkPullRequests.ts";
import {
  ProjectWorkPublicationAuthorization,
  type HostCapturedPublicationTarget,
} from "./ProjectWorkPublicationAuthorization.ts";

const decodeInput = Schema.decodeUnknownSync(GitRunStackedActionInput, {
  onExcessProperty: "error",
});
const denied = () => new PublicationError({ reason: "authorization-denied" });

export class ProjectWorkHumanPublicationRequest extends Context.Service<
  ProjectWorkHumanPublicationRequest,
  {
    readonly assertCurrent: (
      projectId: ProjectId,
      input: GitRunStackedActionInput,
    ) => Effect.Effect<ProjectWorkAttribution, PublicationError>;
  }
>()("t3/projectWork/ProjectWorkHumanPublicationRequest") {}

/** Captures the actual RPC request before it can wait; it is never serialized to clients. */
export const makeProjectWorkHumanPublicationRequest = (
  session: AuthenticatedSession,
  input: GitRunStackedActionInput,
) => {
  const captured = {
    sessionId: session.sessionId,
    subject: session.subject,
    method: session.method,
    identityKind: session.identity.kind,
    identityId: session.identity.id,
    scopes: [...session.scopes],
    managed: session.managed !== undefined,
  };
  let original: GitRunStackedActionInput | undefined;
  try {
    original = decodeInput(structuredClone(input));
    if (canonicalProjectWorkPayload(original) !== canonicalProjectWorkPayload(input))
      original = undefined;
  } catch {}
  return Effect.gen(function* () {
    const repository = yield* AuthSessionRepository;
    const assert = Effect.fn("ProjectWorkHumanPublicationRequest.assertCurrent")(function* (
      projectId: ProjectId,
      submitted: GitRunStackedActionInput | undefined,
    ) {
      if (
        !original ||
        !submitted ||
        original.action !== "create_pr" ||
        canonicalProjectWorkPayload(original) !== canonicalProjectWorkPayload(submitted) ||
        !projectId.trim() ||
        captured.identityKind !== "user" ||
        captured.managed ||
        captured.subject.startsWith("agent:") ||
        !captured.scopes.includes(AuthOrchestrationOperateScope)
      )
        return yield* denied();
      const retained = yield* repository
        .getById({ sessionId: captured.sessionId })
        .pipe(Effect.mapError((cause) => new PublicationError({ reason: "persistence", cause })));
      if (Option.isNone(retained)) return yield* denied();
      const row = retained.value;
      const now = yield* Clock.currentTimeMillis;
      const expiresAt = DateTime.toEpochMillis(row.expiresAt);
      if (
        row.sessionId !== captured.sessionId ||
        row.subject !== captured.subject ||
        row.method !== captured.method ||
        row.revokedAt !== null ||
        !row.scopes.includes(AuthOrchestrationOperateScope) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now
      )
        return yield* denied();
      const identity = authIdentityForSession({
        subject: row.subject,
        client: { deviceType: row.client.deviceType },
      });
      if (identity.kind !== "user" || identity.id !== captured.identityId) return yield* denied();
      return {
        actor: { kind: "human" as const, id: captured.identityId },
        source: { kind: "web" as const, id: `project-work.create-pr:${captured.sessionId}` },
        recordedAt: DateTime.formatIso(yield* DateTime.now),
      };
    });
    return ProjectWorkHumanPublicationRequest.of({
      assertCurrent(projectId, supplied) {
        let submitted: GitRunStackedActionInput | undefined;
        try {
          submitted = decodeInput(structuredClone(supplied));
          if (canonicalProjectWorkPayload(submitted) !== canonicalProjectWorkPayload(supplied))
            submitted = undefined;
        } catch {}
        return assert(projectId, submitted);
      },
    });
  });
};

export class ProjectWorkHumanPublication extends Context.Service<
  ProjectWorkHumanPublication,
  {
    readonly create: (
      input: GitRunStackedActionInput,
      target: HostCapturedPublicationTarget,
      permission: ProjectWorkHumanPublicationRequest["Service"],
    ) => Effect.Effect<ProjectWorkPublicationOutcome, PublicationError>;
  }
>()("t3/projectWork/ProjectWorkHumanPublicationRequest/ProjectWorkHumanPublication") {}

export const makeProjectWorkHumanPublication = Effect.gen(function* () {
  const authorization = yield* ProjectWorkPublicationAuthorization;
  const publication = yield* ProjectWorkPullRequests;
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  return ProjectWorkHumanPublication.of({
    create(input, target, permission) {
      const prepared = authorization
        .prepareInTransaction({ input, target, permission })
        .pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectWorkRepository, repository),
        );
      return Effect.gen(function* () {
        const suppliedSql = yield* Effect.serviceOption(SqlClient.SqlClient);
        const suppliedRepository = yield* Effect.serviceOption(ProjectWorkRepository);
        if (
          (Option.isSome(suppliedSql) && suppliedSql.value !== sql) ||
          (Option.isSome(suppliedRepository) && suppliedRepository.value !== repository)
        )
          return yield* denied();
        const receipt = yield* publication.enqueuePrepared(prepared);
        return yield* publication.dispatch(receipt.operationId);
      });
    },
  });
});
