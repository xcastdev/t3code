import {
  ConnectionBlockedError,
  ConnectionOnboarding,
  connectionRoutes,
  EnvironmentRegistry,
  isLearned,
  pairedBearerRoute,
  routeHttpBaseUrl,
} from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { installVerifiedRoute } from "../native/verifiedNetwork";
import { connectionAtomRuntime } from "./runtime";
import {
  initializeVerifiedRoutes,
  isEnrollmentOnlyPairing,
  readVerifiedRouteEnrollment,
  readVerifiedPairing,
  routeOrigin,
  verificationRequiredFor,
  verifiedRouteFor,
} from "./verified-route";

const verificationError = (cause: unknown) =>
  new ConnectionBlockedError({
    reason: "configuration",
    detail: cause instanceof Error ? cause.message : "Could not load verified environment routes.",
  });

const decodeEnvironmentId = Schema.decodeEffect(EnvironmentId);
const onboardingScheduler = createAtomCommandScheduler();

export const connectPairingUrl = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-pairing-url",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    // The same link used for another machine needs its own expected-machine check.
    key: (input: { readonly pairingUrl: string; readonly expectedEnvironmentId?: EnvironmentId }) =>
      JSON.stringify([input.pairingUrl, input.expectedEnvironmentId ?? null]),
  },
  execute: Effect.fn("mobile.connection.registerPairing")(function* (input: {
    readonly pairingUrl: string;
    readonly expectedEnvironmentId?: EnvironmentId;
  }) {
    const route = yield* Effect.tryPromise({
      try: async () => {
        const supplied = readVerifiedPairing(input.pairingUrl);
        const enrollmentOnly = supplied !== null && isEnrollmentOnlyPairing(input.pairingUrl);
        const address = enrollmentOnly
          ? supplied.httpsOrigin
          : resolveRemotePairingTarget(input).httpBaseUrl;
        return {
          supplied,
          existing: (await readVerifiedRouteEnrollment(address)) ?? undefined,
          enrollmentOnly,
          verificationRequired: verificationRequiredFor(address),
        };
      },
      catch: verificationError,
    });
    const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
    const binding = route.supplied ?? route.existing;
    if (binding === undefined) {
      if (route.verificationRequired) {
        return yield* verificationError(new Error("Use a verified pairing link for this address."));
      }
      return yield* onboarding.registerPairing(input);
    }
    const expectedEnvironmentId = yield* decodeEnvironmentId(binding.environmentId).pipe(
      Effect.mapError(verificationError),
    );
    if (
      input.expectedEnvironmentId !== undefined &&
      input.expectedEnvironmentId !== expectedEnvironmentId
    ) {
      return yield* verificationError(
        new Error("The verified pairing link belongs to a different environment."),
      );
    }
    if (route.supplied !== null) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const entries = yield* SubscriptionRef.get(registry.entries);
      if (route.enrollmentOnly && !entries.has(expectedEnvironmentId)) {
        return yield* verificationError(
          new Error("Pair with this environment before enrolling another route."),
        );
      }
      const addressAlreadyConfigured = Array.from(entries.values()).some((entry) =>
        connectionRoutes(entry).some((candidate) => {
          if (isLearned(candidate)) return false;
          const address = routeHttpBaseUrl(candidate);
          const profile = Option.getOrNull(candidate.profile);
          return (
            address !== null &&
            routeOrigin(address) === binding.httpsOrigin &&
            !(
              profile?._tag === "BearerConnectionProfile" &&
              profile.verificationRequired &&
              profile.environmentId === expectedEnvironmentId
            )
          );
        }),
      );
      if (route.existing === undefined && addressAlreadyConfigured) {
        return yield* verificationError(
          new Error("Remove the saved route before enrolling this address."),
        );
      }
      const installed = yield* Effect.tryPromise({
        try: () => installVerifiedRoute(binding),
        catch: verificationError,
      });
      if (!installed) {
        return yield* verificationError(
          new Error("Update the mobile app to connect to this verified environment."),
        );
      }
      if (route.enrollmentOnly) {
        yield* registry.retryNow(expectedEnvironmentId);
        return expectedEnvironmentId;
      }
    }
    return yield* onboarding.registerPairing({
      ...input,
      expectedEnvironmentId,
      verificationRequired: true,
    });
  }),
});

export const updateBearerConnection = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:update-bearer",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
  },
  execute: Effect.fn("mobile.connection.updateBearer")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly httpBaseUrl: string;
  }) {
    yield* Effect.tryPromise({ try: initializeVerifiedRoutes, catch: verificationError });
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const saved = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
    const selected = saved && pairedBearerRoute(saved);
    const address = selected && routeHttpBaseUrl(selected);
    const previous = address ? verifiedRouteFor(address) : undefined;
    const next = verifiedRouteFor(input.httpBaseUrl);
    if (previous !== next && (previous !== undefined || next !== undefined)) {
      return yield* verificationError(
        new Error("Pair at the new address before changing a verified environment route."),
      );
    }
    const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
    return yield* onboarding.updateBearer(input);
  }),
});
