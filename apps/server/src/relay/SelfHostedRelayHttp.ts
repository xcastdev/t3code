import {
  SelfHostedRelayDeviceEntitlement,
  SelfHostedRelayDeviceRegistration,
  SelfHostedRelayEnrolledEnvironment,
  SelfHostedRelayEnrollEnvironmentInput,
  SelfHostedRelayIssuePairingInput,
  SelfHostedRelayPairingCredential,
  SelfHostedRelayRegisterDeviceInput,
  SelfHostedRelayRevokeDeviceInput,
  SelfHostedRelayRevokeEnvironmentInput,
  SelfHostedRelayRevokePairingInput,
  SelfHostedRelayRevokeSessionInput,
  SelfHostedRelayRuntimeStatus,
  SelfHostedRelaySessionCredential,
  SelfHostedRelaySetDeviceEntitlementInput,
} from "@t3tools/contracts/selfHostedRelay";
import {
  SELF_HOSTED_RELAY_HOOK_POLICY_PATH,
  SelfHostedRelayHookPolicyResult,
  SelfHostedRelayHookPolicyV1,
  SelfHostedRelayHookTarget,
} from "@t3tools/contracts/selfHostedRelayHooks";
import { RelayRuntime } from "@t3tools/relay-core/RelayRuntime";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type * as HttpBody from "effect/http/HttpBody";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const prefix = "/api/self-hosted-relay/v1";
const maxJsonBytes = 64 * 1024;
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const strict = { onExcessProperty: "error" } as const;

const invalid = "invalid_request";
type RouteError =
  | typeof invalid
  | Effect.Error<ReturnType<RelayRuntime["Service"]["status"]>>
  | HttpBody.HttpBodyError;

export const errorResponse = (status: number, error: string, responseHeaders = headers) =>
  HttpServerResponse.jsonUnsafe(
    { version: 1, error },
    {
      status,
      headers:
        status === 401 ? { ...responseHeaders, "www-authenticate": "Bearer" } : responseHeaders,
    },
  );

const toResponse = (error: RouteError, responseHeaders: typeof headers) => {
  const respond = (status: number, code: string) => errorResponse(status, code, responseHeaders);
  if (error === invalid) return respond(400, invalid);
  switch (error._tag) {
    case "RelayAuthenticationError":
      return respond(401, "invalid_credential");
    case "RelayAccessDeniedError":
      return respond(403, "access_denied");
    case "RelayInputError":
      return respond(400, invalid);
    case "RelayRuntimeStateError":
      return error.reason === "unavailable"
        ? respond(503, "relay_unavailable")
        : respond(409, "relay_state_conflict");
    case "RelayStorageError":
      return respond(503, "relay_unavailable");
    case "HttpBodyError":
      return respond(500, "internal_error");
  }
};

const readJson = Effect.fn("SelfHostedRelayHttp.readJson")(function* <A>(
  schema: Schema.ConstraintDecoder<A>,
): Effect.fn.Return<A, typeof invalid, HttpServerRequest.HttpServerRequest> {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== "application/json" ||
    Number(request.headers["content-length"] ?? 0) > maxJsonBytes
  ) {
    return yield* Effect.fail<typeof invalid>(invalid);
  }
  return yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(maxJsonBytes)),
    Effect.flatMap(Schema.decodeUnknownEffect(schema, strict)),
    Effect.mapError((): typeof invalid => invalid),
  );
});

const readPath = <A>(schema: Schema.ConstraintDecoder<A>) =>
  HttpRouter.params.pipe(
    Effect.flatMap((params) => Schema.decodeEffect(schema, strict)({ version: 1, ...params })),
    Effect.mapError((): typeof invalid => invalid),
  );

const json =
  <A>(schema: Schema.ConstraintCodec<A, unknown, unknown, never>) =>
  (value: A) =>
    HttpServerResponse.schemaJson(schema)(value, { headers });

const noContent = HttpServerResponse.empty({ status: 204, headers });
const hookPolicyPath = SELF_HOSTED_RELAY_HOOK_POLICY_PATH.slice(prefix.length);
const versionedHookTarget = Schema.Struct({
  version: Schema.Literal(1),
  ...SelfHostedRelayHookTarget.fields,
});

export const authenticatedRoute = <R>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  handle: (
    credential: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, RouteError, R>,
  responseHeaders = headers,
) =>
  HttpRouter.add(
    method,
    `${prefix}${path}`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // A loopback listener can still receive browser requests for a rebound DNS name.
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(request.headers.host ?? "")) {
        return errorResponse(400, invalid, responseHeaders);
      }
      const credential = /^Bearer ([^\s,]{1,512})$/i.exec(request.headers.authorization ?? "")?.[1];
      if (credential === undefined)
        return errorResponse(401, "invalid_credential", responseHeaders);
      return yield* handle(credential).pipe(
        Effect.catch((error) => Effect.succeed(toResponse(error, responseHeaders))),
        Effect.catchDefect(() =>
          Effect.succeed(errorResponse(500, "internal_error", responseHeaders)),
        ),
      );
    }),
  );

const route = <R>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  handle: (
    relay: RelayRuntime["Service"],
    credential: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, RouteError, R>,
) =>
  authenticatedRoute(method, path, (credential) =>
    Effect.flatMap(RelayRuntime, (relay) => handle(relay, credential)),
  );

export const layer = (onHookPolicyChanged: Effect.Effect<void> = Effect.void) =>
  Layer.mergeAll(
    route("GET", "/status", (relay, credential) =>
      relay.status(credential).pipe(Effect.flatMap(json(SelfHostedRelayRuntimeStatus))),
    ),
    route("POST", "/pairings", (relay, credential) =>
      readJson(SelfHostedRelayIssuePairingInput).pipe(
        Effect.flatMap((input) => relay.issuePairing(credential, input)),
        Effect.flatMap(json(SelfHostedRelayPairingCredential)),
      ),
    ),
    route("POST", "/pairings/redeem", (relay, pairingCredential) =>
      relay
        .redeemPairing(pairingCredential)
        .pipe(Effect.flatMap(json(SelfHostedRelaySessionCredential))),
    ),
    route("DELETE", "/pairings/:pairingId", (relay, credential) =>
      readPath(SelfHostedRelayRevokePairingInput).pipe(
        Effect.flatMap(({ pairingId }) => relay.revokePairing(credential, pairingId)),
        Effect.as(noContent),
      ),
    ),
    route("DELETE", "/sessions/:sessionId", (relay, credential) =>
      readPath(SelfHostedRelayRevokeSessionInput).pipe(
        Effect.flatMap(({ sessionId }) => relay.revokeSession(credential, sessionId)),
        Effect.as(noContent),
      ),
    ),
    route("GET", "/environments", (relay, credential) =>
      relay
        .discoverEnvironments(credential)
        .pipe(Effect.flatMap(json(Schema.Array(SelfHostedRelayEnrolledEnvironment)))),
    ),
    route("POST", "/environments", (relay, credential) =>
      readJson(SelfHostedRelayEnrollEnvironmentInput).pipe(
        Effect.flatMap((input) => relay.enrollEnvironment(credential, input)),
        Effect.flatMap(json(SelfHostedRelayEnrolledEnvironment)),
      ),
    ),
    route("DELETE", "/environments/:environmentId", (relay, credential) =>
      readPath(SelfHostedRelayRevokeEnvironmentInput).pipe(
        Effect.flatMap(({ environmentId }) => relay.revokeEnvironment(credential, environmentId)),
        Effect.as(noContent),
      ),
    ),
    route("GET", hookPolicyPath, (relay, credential) =>
      readPath(versionedHookTarget).pipe(
        Effect.flatMap(({ environmentId, hookId }) =>
          relay.getHookPolicy(credential, { environmentId, hookId }),
        ),
        Effect.flatMap((policy) =>
          json(SelfHostedRelayHookPolicyResult)(policy === null ? null : { version: 1, ...policy }),
        ),
      ),
    ),
    route("PUT", hookPolicyPath, (relay, credential) =>
      Effect.gen(function* () {
        const { environmentId, hookId } = yield* readPath(versionedHookTarget);
        const input = yield* readJson(SelfHostedRelayHookPolicyV1);
        if (input.environmentId !== environmentId || input.hookId !== hookId) {
          return yield* Effect.fail<typeof invalid>(invalid);
        }
        const { enabled, holdEnabled } = input;
        const policy = yield* relay.setHookPolicy(credential, {
          environmentId,
          hookId,
          enabled,
          holdEnabled,
        });
        yield* onHookPolicyChanged;
        return yield* json(SelfHostedRelayHookPolicyV1)({ version: 1, ...policy });
      }),
    ),
    route("GET", "/devices/:deviceId", (relay, credential) =>
      readPath(SelfHostedRelayRevokeDeviceInput).pipe(
        Effect.flatMap(({ deviceId }) => relay.getDeviceRegistration(credential, deviceId)),
        Effect.flatMap(json(SelfHostedRelayDeviceRegistration)),
      ),
    ),
    route("POST", "/devices", (relay, credential) =>
      readJson(SelfHostedRelayRegisterDeviceInput).pipe(
        Effect.flatMap((input) => relay.registerDevice(credential, input)),
        Effect.flatMap(json(SelfHostedRelayDeviceRegistration)),
      ),
    ),
    route("POST", "/devices/entitlements", (relay, credential) =>
      readJson(SelfHostedRelaySetDeviceEntitlementInput).pipe(
        Effect.flatMap((input) => relay.setDeviceEntitlement(credential, input)),
        Effect.flatMap(json(SelfHostedRelayDeviceEntitlement)),
      ),
    ),
    route("DELETE", "/devices/:deviceId", (relay, credential) =>
      readPath(SelfHostedRelayRevokeDeviceInput).pipe(
        Effect.flatMap(({ deviceId }) => relay.revokeDevice(credential, deviceId)),
        Effect.as(noContent),
      ),
    ),
    HttpRouter.add("*", "/*", errorResponse(404, "not_found")),
  );
