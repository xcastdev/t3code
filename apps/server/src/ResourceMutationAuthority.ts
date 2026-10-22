import { assertOrdinaryAssistantDestination } from "./assistants/AssistantGuards.ts";
import {
  AuthSettingsWriteScope,
  type AuthSessionId,
  type AuthEnvironmentScope,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as AuthSessions from "./persistence/AuthSessions.ts";
import * as Projects from "./orchestration-v2/ProjectStore.ts";
import * as Projections from "./orchestration-v2/ProjectionStore.ts";
import { rpcAuthorizationError } from "./auth/RpcAuthorization.ts";

export interface ResourceMutationScope {
  readonly sessionId: AuthSessionId;
  readonly requiredScope?: AuthEnvironmentScope;
  readonly projectId?: ProjectId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly threadId?: ThreadId;
  readonly workspaceRoot?: string;
}

export class ResourceMutationAuthorityError extends Schema.TaggedError<ResourceMutationAuthorityError>()(
  "ResourceMutationAuthorityError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const assertOrdinary = (input: Parameters<typeof assertOrdinaryAssistantDestination>[0]) =>
    assertOrdinaryAssistantDestination(input).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const projects = yield* Projects.ProjectStoreV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const authorize = Effect.fn("ResourceMutationAuthority.authorize")(
    function* (scope: ResourceMutationScope) {
      const requiredScope = scope.requiredScope ?? AuthSettingsWriteScope;
      const session = yield* sessions.getById({ sessionId: scope.sessionId });
      const now = yield* DateTime.now;
      if (
        Option.isNone(session) ||
        session.value.revokedAt !== null ||
        session.value.expiresAt.epochMilliseconds <= now.epochMilliseconds ||
        !session.value.scopes.includes(requiredScope)
      )
        return yield* rpcAuthorizationError(requiredScope);
      let projectId = scope.projectId;
      let threadWorktree: string | null = null;
      if (scope.threadId !== undefined) {
        const thread = yield* projections.getThreadShell(scope.threadId);
        if (
          thread === null ||
          thread.deletedAt !== null ||
          (projectId !== undefined && thread.projectId !== projectId) ||
          (scope.providerInstanceId !== undefined &&
            thread.providerInstanceId !== scope.providerInstanceId)
        )
          return yield* new ResourceMutationAuthorityError({
            message: "The resource thread scope changed.",
          });
        projectId = thread.projectId;
        threadWorktree = thread.worktreePath;
      }
      yield* assertOrdinary({
        ...(projectId === undefined ? {} : { projectId }),
        ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
      });
      if (projectId !== undefined) {
        const project = yield* projects.get(projectId);
        if (
          Option.isNone(project) ||
          project.value.deletedAt !== null ||
          (scope.workspaceRoot !== undefined &&
            (threadWorktree ?? project.value.workspaceRoot) !== scope.workspaceRoot)
        )
          return yield* new ResourceMutationAuthorityError({
            message: "The resource project scope changed.",
          });
      } else if (scope.workspaceRoot !== undefined)
        return yield* new ResourceMutationAuthorityError({
          message: "A resource workspace needs a stored project scope.",
        });
    },
    Effect.mapError((cause) =>
      cause._tag === "EnvironmentAuthorizationError" ||
      cause._tag === "ResourceMutationAuthorityError"
        ? cause
        : new ResourceMutationAuthorityError({
            message: "Resource authority could not be verified.",
            cause,
          }),
    ),
  );
  const transact = Effect.fn("ResourceMutationAuthority.transact")(function* <A, E, R>(
    scope: ResourceMutationScope,
    action: Effect.Effect<A, E, R>,
  ) {
    return yield* sql.withTransaction(authorize(scope).pipe(Effect.andThen(action)));
  });
  const commit = (scope: ResourceMutationScope, action: () => void) =>
    transact(
      scope,
      Effect.try({
        try: action,
        catch: (cause) =>
          new ResourceMutationAuthorityError({ message: "The resource commit failed.", cause }),
      }),
    );
  return { commit, transact };
});
export class ResourceMutationAuthority extends Context.Service<
  ResourceMutationAuthority,
  Effect.Success<typeof make>
>()("t3/ResourceMutationAuthority") {}
export const layer = Layer.effect(ResourceMutationAuthority, make);
