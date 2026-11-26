import { parseUrl } from "@t3tools/shared/url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { VerifiedRouteBinding } from "@t3tools/contracts";
import type { ConnectionRoute } from "./catalog.ts";
import { ConnectionBlockedError } from "./model.ts";

export class VerifiedRoutePolicy extends Context.Reference<{
  /** Reads operator enrollment and transport role from outside the discovery and route caches. */
  readonly readEnrollment: (httpsOrigin: string) => Effect.Effect<VerifiedRouteBinding | null>;
  /** True only when the platform enforces this binding on its request and upgrade paths. */
  readonly enforce: (enrollment: VerifiedRouteBinding) => Effect.Effect<boolean>;
  readonly requireAdmission?: (
    enrollment: VerifiedRouteBinding,
  ) => Effect.Effect<void, ConnectionBlockedError>;
}>("@t3tools/client-runtime/connection/VerifiedRoutePolicy", {
  defaultValue: () => ({
    readEnrollment: () => Effect.succeed(null),
    enforce: () => Effect.succeed(false),
  }),
}) {}

export const verifyRoute = Effect.fn("ConnectionResolver.requireVerifiedRoute")(function* (
  environmentId: string,
  endpoint: { readonly httpBaseUrl: string; readonly wsBaseUrl: string },
  required: boolean,
) {
  const http = parseUrl(endpoint.httpBaseUrl);
  const socket = parseUrl(endpoint.wsBaseUrl);
  const policy = yield* VerifiedRoutePolicy;
  const enrollment = http?.protocol === "https:" ? yield* policy.readEnrollment(http.origin) : null;
  if (!required && enrollment === null) return null;
  if (
    http?.protocol === "https:" &&
    !http.username &&
    !http.password &&
    !http.hostname.endsWith(".") &&
    socket?.protocol === "wss:" &&
    !socket.username &&
    !socket.password &&
    socket.host === http.host &&
    enrollment?.httpsOrigin === http.origin &&
    enrollment.environmentId === environmentId &&
    (yield* policy.enforce(enrollment))
  ) {
    return enrollment;
  }
  return yield* new ConnectionBlockedError({
    reason: "configuration",
    detail: "This route requires a matching enrollment and a verified transport.",
  });
});

export const requireVerifiedRoute = (
  environmentId: string,
  endpoint: { readonly httpBaseUrl: string; readonly wsBaseUrl: string },
) => verifyRoute(environmentId, endpoint, true);

export const requireRouteAdmission = Effect.fn("ConnectionResolver.requireRouteAdmission")(
  function* (enrollment: VerifiedRouteBinding | null) {
    if (enrollment?.transportRole !== "relay") return;
    const policy = yield* VerifiedRoutePolicy;
    yield* policy.requireAdmission?.(enrollment) ?? Effect.void;
  },
);

export const preferOperatorDirectRoutes = Effect.fn("ConnectionRoutes.preferOperatorDirectRoutes")(
  function* (routes: ReadonlyArray<ConnectionRoute>) {
    const profiles = routes.map(({ profile }) => Option.getOrNull(profile));
    if (profiles.filter((profile) => profile?._tag === "BearerConnectionProfile").length < 2) {
      return routes;
    }
    const roles = yield* Effect.forEach(
      profiles,
      (profile, index) =>
        profile?._tag === "BearerConnectionProfile" && profile.httpBaseUrl.startsWith("https:")
          ? verifyRoute(routes[index]!.target.environmentId, profile, false).pipe(
              Effect.map((binding) => binding?.transportRole),
              Effect.orElseSucceed(() => undefined),
            )
          : Effect.undefined,
      { concurrency: "unbounded" },
    );
    const relayIndex = roles.indexOf("relay");
    if (relayIndex === -1) return routes;
    const direct = routes.filter((_, index) => index > relayIndex && roles[index] === "direct");
    if (direct.length === 0) return routes;
    return [
      ...routes.slice(0, relayIndex),
      ...direct,
      ...routes.slice(relayIndex).filter((_, index) => roles[index + relayIndex] !== "direct"),
    ];
  },
);
