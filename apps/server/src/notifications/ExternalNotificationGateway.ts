import {
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  authScopeRequiredResponse,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sessions from "../persistence/AuthSessions.ts";
import * as Dispatcher from "./ExternalNotificationDispatcher.ts";

export class ExternalNotificationGateway extends Context.Service<
  ExternalNotificationGateway,
  {
    readonly test: (
      input: { readonly destinationId: string },
      sessionId: AuthSessionId,
    ) => Effect.Effect<Dispatcher.ExternalNotificationTestResult, EnvironmentAuthorizationError>;
  }
>()("t3/notifications/ExternalNotificationGateway") {}

const authorizationError = new EnvironmentAuthorizationError({
  ...authScopeRequiredResponse(AuthSettingsWriteScope),
  message: "Testing external notifications requires settings:write.",
});
const make = Effect.gen(function* () {
  const sessions = yield* Sessions.AuthSessionRepository;
  const dispatcher = yield* Dispatcher.ExternalNotificationDispatcher;
  return ExternalNotificationGateway.of({
    test: Effect.fn("ExternalNotificationGateway.test")(function* (
      input: { readonly destinationId: string },
      sessionId: AuthSessionId,
    ) {
      const session = yield* sessions
        .getById({ sessionId })
        .pipe(Effect.mapError(() => authorizationError));
      const now = yield* DateTime.now;
      if (
        Option.isNone(session) ||
        session.value.revokedAt !== null ||
        session.value.expiresAt.epochMilliseconds <= now.epochMilliseconds ||
        !session.value.scopes.includes(AuthSettingsWriteScope)
      )
        return yield* authorizationError;
      return yield* dispatcher.test(input.destinationId);
    }),
  });
});

export const layer = Layer.effect(ExternalNotificationGateway, make);
