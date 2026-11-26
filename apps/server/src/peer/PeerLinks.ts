import {
  AuthMcpClientAccess,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  EnvironmentHttpApi,
  EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  MCP_PEER_LINK_SOFTWARE_ID,
  mcpClientScopes,
  type PeerLink,
  type PeerLinkCreateInput,
  PeerLinkError,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerEnrollment from "./PeerEnrollment.ts";
import * as PeerRelayDirectory from "./PeerRelayDirectory.ts";

const PeerHttpApi = HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mcpOAuth)
  .annotateMerge(EnvironmentHttpApi.annotations);

/** The redirect registered for a link. Nothing ever listens there: the code comes back in the response. */
const LINK_REDIRECT_URI = "http://127.0.0.1/t3code-peer-link";
/**
 * How long an MCP handshake or relay probe may take before a route counts as unreachable.
 */
export const probeTimeout = (origin: string) =>
  isLocalLoopbackHost(new URL(origin).hostname) ? Duration.seconds(3) : Duration.seconds(10);
/** How long a listing waits on a link's addresses. */
const LIST_PROBE_TIMEOUT = Duration.seconds(3);
const DIRECT_PROBE_TIMEOUT = Duration.seconds(2);

/** Node's TLS verification code in a failed request's cause chain, if any. */
export const certificateErrorCode = (error: unknown) => {
  let current = error;
  for (let depth = 0; depth < 6 && Predicate.isObject(current); depth++) {
    if (
      Predicate.hasProperty(current, "code") &&
      typeof current.code === "string" &&
      /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|INVALID_(CA|PURPOSE)|PATH_LENGTH_EXCEEDED|HOSTNAME_MISMATCH/.test(
        current.code,
      )
    )
      return current.code;
    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }
  return undefined;
};

interface PeerRoute {
  readonly url: string;
  readonly transport?: {
    readonly canonicalOrigin: string;
    readonly relay?: true;
    readonly httpClient: HttpClient.HttpClient;
  };
}

const isRelayRoute = (route: PeerRoute) => route.transport?.relay === true;

const routeProbeTimeout = (route: PeerRoute) =>
  isRelayRoute(route) ? probeTimeout(route.url) : DIRECT_PROBE_TIMEOUT;

type Enrollment = Effect.Success<typeof PeerEnrollment.load>[number];

/** A usable link: where to reach the peer and the token to send there. */
export interface ResolvedPeerLink extends PeerRoute {
  readonly link: PeerLink;
  readonly token: string;
}

const CanonicalCredential = Schema.fromJsonString(
  Schema.Struct({ canonicalOrigin: Schema.String, token: Schema.String }),
);
const encodeCanonicalCredential = Schema.encodeEffect(CanonicalCredential);
const decodeCanonicalCredential = Schema.decodeUnknownEffect(CanonicalCredential);

export const LINKED_ENVIRONMENTS_OFF =
  "Linked environments is off on this machine. Turn it on in Settings → Labs.";

/**
 * Links from this environment to others. Linking signs this environment in to
 * the peer's `/mcp` as an outside agent with a pairing code from the peer, the
 * same MCP OAuth flow an outside agent uses, without a browser. The peer's
 * session token is kept in the server secret store; the table keeps the rest.
 */
export class PeerLinks extends Context.Service<
  PeerLinks,
  {
    /** Whether the Linked environments beta (Settings → Labs) is on here. */
    readonly enabled: Effect.Effect<boolean>;
    readonly lookup: typeof PeerRelayDirectory.lookup;
    readonly link: (input: PeerLinkCreateInput) => Effect.Effect<PeerLink, PeerLinkError>;
    readonly list: Effect.Effect<ReadonlyArray<PeerLinkSummary>, PeerLinkError>;
    /** The stored link, without asking the peer whether it answers. */
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PeerLink>, PeerLinkError>;
    /** Forgets the link here. The peer still lists the session until it is revoked there. */
    readonly unlink: (environmentId: EnvironmentId) => Effect.Effect<boolean, PeerLinkError>;
    /** An address that answers as the linked peer, with its token, ready to call. */
    readonly resolve: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ResolvedPeerLink, PeerLinkError>;
    /** Records the outcome of a call, so listing shows whether the peer answered last time. */
    readonly recordOutcome: (
      environmentId: EnvironmentId,
      outcome: { readonly error: string | null },
    ) => Effect.Effect<void>;
  }
>()("t3/peer/PeerLinks") {}

interface PeerLinkRow {
  readonly environment_id: string;
  readonly secret_name: string;
  readonly label: string;
  readonly urls_json: string;
  readonly access: string;
  readonly linked_at: string;
  readonly expires_at: string;
  readonly last_reached_at: string | null;
  readonly last_error: string | null;
  readonly fenced: number;
}

const decodeUrls = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeUrls = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeAccess = Schema.decodeUnknownEffect(AuthMcpClientAccess);

/** Fails with a fixed storage error that keeps its cause; the log gets the details. */
const failStorage = (cause: unknown) =>
  Effect.logWarning("Peer link storage failed", cause).pipe(
    Effect.andThen(
      Effect.fail(
        new PeerLinkError({
          reason: "storage",
          message:
            "Linked environments could not be read or saved here. The server log has details.",
          cause,
        }),
      ),
    ),
  );

/**
 * The base URL a peer is reached at, normalised to its origin. The pairing
 * code and then the link's token travel to it, so plain http is accepted only
 * where the network already encrypts: this machine, or a Tailscale address.
 */
const peerOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return Effect.fail(
      new PeerLinkError({
        reason: "unreachable",
        message: `${url} is not an http or https address.`,
      }),
    );
  }
  if (
    parsed.protocol === "http:" &&
    !isLocalLoopbackHost(parsed.hostname) &&
    !isTailnetHost(parsed.hostname)
  ) {
    return Effect.fail(
      new PeerLinkError({
        reason: "unreachable",
        message: `${url} is plain http, which would send the link's credentials unencrypted. Use its https address, or its Tailscale address.`,
      }),
    );
  }
  return Effect.succeed(parsed.origin);
};

/** The system error under a failed connection, such as ECONNREFUSED or ENOTFOUND. */
const connectionCode = (cause: unknown) =>
  [cause, Predicate.hasProperty(cause, "cause") ? cause.cause : undefined]
    .map((error) => (Predicate.hasProperty(error, "code") ? error.code : undefined))
    .find(Predicate.isString);

/** Why `origin` did not answer as T3 Code, short enough for a toast. Never echoes a body. */
const probeFailure = (
  origin: string,
  error: HttpClientError.HttpClientError | Schema.SchemaError | Cause.TimeoutError,
  timeout: Duration.Duration,
) => {
  const unreachable = (message: string) => new PeerLinkError({ reason: "unreachable", message });
  const certificate = certificateErrorCode(error);
  if (certificate !== undefined) {
    return unreachable(`${origin} presented a certificate this machine rejected (${certificate}).`);
  }
  if (Cause.isTimeoutError(error)) {
    return unreachable(`${origin} did not answer within ${Duration.toSeconds(timeout)} seconds.`);
  }
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError") {
    const code = connectionCode(error.reason.cause);
    return unreachable(
      code === undefined ? `${origin} did not answer.` : `${origin} did not answer (${code}).`,
    );
  }
  return new PeerLinkError({
    reason: "not_a_t3_environment",
    message: `${origin} answered, but not as a T3 Code environment this version understands.`,
  });
};

/** Whether a host is this machine's own loopback. Tests serve their peers there, so they narrow it. */
export const LoopbackHost = Context.Reference<(host: string) => boolean>(
  "t3/peer/PeerLinks/LoopbackHost",
  { defaultValue: () => isLocalLoopbackHost },
);

/** Whether a peer holds a linked agent to its limits and keeps its work within its link. */
const linkLimitsHold = (peer: { readonly capabilities: ExecutionEnvironmentCapabilities }) =>
  peer.capabilities.mcpModeLimitHeader === true && peer.capabilities.linkFence === true;

const make = Effect.gen(function* () {
  const directory = yield* PeerRelayDirectory.PeerRelayDirectory.pipe(
    Effect.provide(PeerRelayDirectory.layer),
  );
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const isOwnLoopback = yield* LoopbackHost;
  const enrollments = yield* PeerEnrollment.load;
  const probeBudgets = new Map<EnvironmentId, { semaphore: Semaphore.Semaphore; users: number }>();
  const discoveryProbeBudget = Semaphore.makeUnsafe(2);
  const withProbePermit = <A, E, R>(environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const budget = probeBudgets.get(environmentId) ?? {
          semaphore: Semaphore.makeUnsafe(2),
          users: 0,
        };
        probeBudgets.set(environmentId, budget);
        budget.users++;
        return budget;
      }),
      (budget) => budget.semaphore.withPermit(effect),
      (budget) =>
        Effect.sync(() => {
          budget.users--;
          if (budget.users === 0) probeBudgets.delete(environmentId);
        }),
    );

  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );

  /** A fresh name for one link's token; the row records it. */
  const newSecretName = random.randomBytes(16).pipe(
    Effect.map((bytes) => `peer-link-${Hex.encode(bytes)}`),
    Effect.orDie,
  );

  // Only the origin `peerOrigin` checked may receive a pairing code or token:
  // a redirect could forward them anywhere, including plain http.
  const peerHttpClient = HttpClient.transform(httpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

  const enrollmentAt = (url: string) =>
    enrollments.find(
      (entry) => entry.canonicalOrigin === url || entry.routes.some((route) => route.url === url),
    );

  const routeAt = (url: string): PeerRoute =>
    enrollmentAt(url)?.routes.find((route) => route.url === url) ?? { url };

  const clientFor = (route: PeerRoute) =>
    HttpApiClient.make(PeerHttpApi, {
      baseUrl: route.transport?.canonicalOrigin ?? route.url,
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, route.transport?.httpClient ?? peerHttpClient),
    );

  /** The environment answering at `origin`, or why nothing there answers as T3 Code. */
  const probe = (route: PeerRoute, retries = 1) => {
    const timeout = routeProbeTimeout(route);
    return clientFor(route).pipe(
      Effect.flatMap((client) => client.metadata.descriptor()),
      // A brief network drop must not list a live peer as down; the timeout still bounds both tries.
      Effect.retry({
        times: retries,
        schedule: Schedule.spaced("1 second"),
        while: (error) => certificateErrorCode(error) === undefined,
      }),
      Effect.timeout(timeout),
      // No cause: a decode error can carry the response body to the client.
      Effect.mapError((error) => probeFailure(route.url, error, timeout)),
    );
  };

  /** Whether `url` answers as `environmentId`, counting any failure as no. */
  const answersAs = Effect.fn("PeerLinks.answersAs")(function* (
    route: PeerRoute,
    environmentId: EnvironmentId,
    retries?: number,
  ) {
    const found = yield* probe(route, retries).pipe(Effect.option);
    return Option.filter(found, (peer) => peer.environmentId === environmentId);
  });

  const toLink = Effect.fn("PeerLinks.toLink")(function* (row: PeerLinkRow) {
    return {
      environmentId: EnvironmentId.make(row.environment_id),
      label: row.label,
      urls: yield* decodeUrls(row.urls_json),
      access: yield* decodeAccess(row.access),
      linkedAt: DateTime.makeUnsafe(row.linked_at),
      // Its token predates link fencing, so the peer would not fence its work:
      // like an expired link, only a new pairing code brings it back.
      expiresAt: DateTime.makeUnsafe(row.fenced === 1 ? row.expires_at : row.linked_at),
      lastReachedAt: row.last_reached_at === null ? null : DateTime.makeUnsafe(row.last_reached_at),
      lastError: row.last_error,
    } satisfies PeerLink;
  }, Effect.catch(failStorage));

  const readRows = sql<PeerLinkRow>`
    SELECT * FROM peer_environment_links ORDER BY label, environment_id
  `.pipe(NodeSqliteClient.readOnly, Effect.catch(failStorage));

  const readRow = (environmentId: EnvironmentId) =>
    sql<PeerLinkRow>`
      SELECT * FROM peer_environment_links WHERE environment_id = ${environmentId}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.catch(failStorage),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const enrolledRoutes = (
    enrollment: Enrollment,
    approved: PeerRoute,
  ): ReadonlyArray<PeerRoute> => {
    const candidates = [
      // Only the approved address may use the ordinary direct transport.
      ...(enrollment.routes.some((route) => route.url === approved.url) ||
      (approved.url === enrollment.canonicalOrigin && approved.transport === undefined)
        ? [approved]
        : []),
      ...enrollment.routes.filter((route) => route.url !== approved.url),
    ];
    const rank = (route: PeerRoute) =>
      isRelayRoute(route) ? 2 : route.url === enrollment.canonicalOrigin ? 0 : 1;
    return candidates.sort((left, right) => rank(left) - rank(right));
  };

  const matchesResource = Effect.fn("PeerLinks.matchesResource")(function* (
    client: Effect.Success<ReturnType<typeof clientFor>>,
    canonicalOrigin: string,
  ) {
    const resource = yield* client.mcpOAuth.mcpProtectedResource();
    return (
      resource.resource === `${canonicalOrigin}/mcp` &&
      resource.authorization_servers.length === 1 &&
      resource.authorization_servers[0] === canonicalOrigin
    );
  });

  const findEnrolledRoute = Effect.fn("PeerLinks.findEnrolledRoute")(function* (
    enrollment: Enrollment,
    approved: PeerRoute,
    purpose: "oauth" | "mcp",
  ) {
    const { canonicalOrigin, environmentId } = enrollment;
    return yield* Effect.findFirstFilter(enrolledRoutes(enrollment, approved), (route) =>
      Effect.gen(function* () {
        const peer = yield* answersAs(route, environmentId, 0);
        if (Option.isNone(peer) || !linkLimitsHold(peer.value)) return Result.fail(undefined);
        const client = yield* clientFor(route);
        if (!(yield* matchesResource(client, canonicalOrigin))) return Result.fail(undefined);
        if (purpose === "oauth") {
          const metadata = yield* client.mcpOAuth.authorizationServer();
          if (
            metadata.issuer !== canonicalOrigin ||
            !metadata.authorization_response_iss_parameter_supported ||
            metadata.authorization_endpoint !== `${canonicalOrigin}/oauth/mcp/authorize` ||
            metadata.registration_endpoint !== `${canonicalOrigin}/oauth/mcp/register` ||
            metadata.token_endpoint !== `${canonicalOrigin}/oauth/mcp/token`
          ) {
            return Result.fail(undefined);
          }
        }
        return Result.succeed({ route, peer: peer.value });
      }).pipe(
        Effect.timeout(routeProbeTimeout(route)),
        Effect.orElseSucceed(() => Result.fail(undefined)),
        (effect) => withProbePermit(environmentId, effect),
      ),
    );
  });

  /** Signs in to the peer's `/mcp` with a pairing code: register, decide, exchange. */
  const signIn = Effect.fn("PeerLinks.signIn")(
    function* (
      approved: PeerRoute,
      input: PeerLinkCreateInput,
      clientName: string,
      enrollment: Enrollment | undefined,
    ) {
      const origin = enrollment?.canonicalOrigin ?? approved.url;
      const selectRoute =
        enrollment === undefined
          ? Effect.succeed(approved)
          : findEnrolledRoute(enrollment, approved, "oauth").pipe(
              Effect.flatMap((selected) =>
                Option.isSome(selected)
                  ? Effect.succeed(selected.value.route)
                  : Effect.fail(
                      new PeerLinkError({
                        reason: "unreachable",
                        message:
                          "No enrolled route answered for the linked environment's canonical OAuth identity.",
                      }),
                    ),
              ),
            );
      const client = yield* clientFor(yield* selectRoute);
      // Only the peer's own refusals are rejections. A dropped connection or
      // an answer this version cannot read is classified below.
      const registered = yield* client.mcpOAuth
        .register({
          payload: {
            client_name: clientName,
            redirect_uris: [LINK_REDIRECT_URI],
            software_id: MCP_PEER_LINK_SOFTWARE_ID,
          },
        })
        .pipe(
          // A plain Schema.Error has no tag to catch by.
          Effect.catchIf(Schema.is(AuthMcpRegistrationError), (error) =>
            Effect.fail(
              new PeerLinkError({
                reason: "pairing_rejected",
                message: `The peer refused to register this environment: ${error.message}`,
              }),
            ),
          ),
        );
      const verifier = Base64Url.encode(yield* random.randomBytes(32));
      const challenge = Base64Url.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)).pipe(Effect.orDie),
      );
      const state = Base64Url.encode(yield* random.randomBytes(16));
      const resource = `${origin}/mcp`;
      const decisionClient =
        enrollment === undefined ? client : yield* clientFor(yield* selectRoute);
      const decided = yield* decisionClient.mcpOAuth
        .decision({
          headers: {},
          payload: {
            authorization: {
              response_type: "code",
              client_id: registered.client_id,
              redirect_uri: LINK_REDIRECT_URI,
              code_challenge: challenge,
              code_challenge_method: "S256",
              state: Redacted.make(state),
              resource,
            },
            decision: { _tag: "pairing-code", access: input.access, code: input.pairingCode },
          },
        })
        .pipe(
          Effect.catchTags({
            AuthMcpApprovalError: (error) =>
              Effect.fail(
                new PeerLinkError({ reason: "pairing_rejected", message: error.message }),
              ),
          }),
        );
      const redirect = URL.parse(decided.redirectTo);
      if (redirect === null) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${origin} answered the sign-in with an address this version cannot read. Update both environments.`,
        });
      }
      const code = redirect.searchParams.get("code");
      if (code === null || redirect.searchParams.get("state") !== state) {
        return yield* new PeerLinkError({
          reason: "pairing_rejected",
          message:
            redirect.searchParams.get("error_description") ??
            "The peer did not approve the link. Check the pairing code and try again.",
        });
      }
      if (
        enrollment !== undefined &&
        (redirect.origin + redirect.pathname !== LINK_REDIRECT_URI ||
          redirect.searchParams.get("iss") !== origin)
      ) {
        return yield* new PeerLinkError({
          reason: "pairing_rejected",
          message: "The peer's approval did not match its enrolled OAuth issuer or redirect.",
        });
      }
      // Select a route before dispatch. A failed credential-bearing request is never replayed.
      const tokenClient = enrollment === undefined ? client : yield* clientFor(yield* selectRoute);
      const issued = yield* tokenClient.mcpOAuth
        .token({
          payload: {
            grant_type: "authorization_code",
            code: Redacted.make(code),
            redirect_uri: LINK_REDIRECT_URI,
            client_id: registered.client_id,
            code_verifier: Redacted.make(verifier),
            resource,
          },
        })
        .pipe(
          Effect.catchIf(Schema.is(AuthMcpTokenError), (error) =>
            Effect.fail(
              new PeerLinkError({
                reason: "pairing_rejected",
                message: `The peer refused the sign-in: ${error.message}`,
              }),
            ),
          ),
        );
      if (enrollment !== undefined) {
        const scopes = new Set(issued.scope.split(" "));
        const expected = mcpClientScopes(input.access);
        if (scopes.size !== expected.length || !expected.every((scope) => scopes.has(scope))) {
          return yield* new PeerLinkError({
            reason: "pairing_rejected",
            message: "The peer issued a credential with unexpected permissions.",
          });
        }
      }
      return issued;
    },
    (effect, { url: origin }) =>
      effect.pipe(
        // Endpoint errors are mapped above; what is left is the transport or an
        // answer this version cannot decode.
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new PeerLinkError({
                reason: "incompatible",
                message: `${origin} answered in a shape this version does not understand. Update both environments.`,
                cause,
              }),
            ),
          HttpClientError: (cause) =>
            Effect.fail(
              new PeerLinkError({
                reason: "unreachable",
                message: `${origin} stopped answering while linking.`,
                cause,
              }),
            ),
        }),
      ),
  );

  /**
   * The selected address must answer as the named environment. Other matching
   * addresses can be saved without receiving the pairing code.
   */
  const answeringAs = Effect.fn("PeerLinks.answeringAs")(function* (
    urls: ReadonlyArray<string>,
    environmentId: EnvironmentId,
    name: string,
  ) {
    const checked = yield* Effect.forEach(
      urls,
      (url) =>
        Effect.gen(function* () {
          const origin = yield* peerOrigin(url);
          // Loopback is this machine, where anything may answer as the one picked.
          if (isOwnLoopback(new URL(origin).hostname)) {
            return yield* new PeerLinkError({
              reason: "unreachable",
              message: `${origin} is this machine, not ${name}.`,
            });
          }
          const descriptor = yield* withProbePermit(environmentId, probe(routeAt(origin)));
          if (descriptor.environmentId !== environmentId) {
            return yield* new PeerLinkError({
              reason: "unreachable",
              message: `${origin} answered as another environment, ${descriptor.label}.`,
            });
          }
          return { origin, descriptor };
        }).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    const matching = checked.flatMap((result) =>
      Result.isSuccess(result) ? [result.success] : [],
    );
    const first = checked[0];
    if (first === undefined || Result.isFailure(first)) {
      const reasons = checked.flatMap((result) =>
        Result.isFailure(result) ? [result.failure.message] : [],
      );
      return yield* new PeerLinkError({
        reason: "unreachable",
        message: `This environment could not reach ${name}: ${reasons.join(" ")}`,
      });
    }
    // Each address is kept once, even when two spellings share an origin.
    const origins = [...new Set(matching.map((found) => found.origin))];
    return { primary: first.success.origin, peer: first.success.descriptor, origins };
  });

  /** The peer at `url`, with every address checked for credentials first. */
  const answeringAt = Effect.fn("PeerLinks.answeringAt")(function* (urls: ReadonlyArray<string>) {
    const origins = yield* Effect.forEach(urls, peerOrigin);
    const primary = origins[0]!;
    const enrollment = enrollmentAt(primary);
    const descriptor = probe(routeAt(primary));
    const peer = yield* enrollment === undefined
      ? discoveryProbeBudget.withPermit(descriptor)
      : withProbePermit(enrollment.environmentId, descriptor);
    return { primary, peer, origins };
  });

  const link: PeerLinks["Service"]["link"] = Effect.fn("PeerLinks.link")(function* (input) {
    if (!(yield* enabled)) {
      return yield* new PeerLinkError({ reason: "disabled", message: LINKED_ENVIRONMENTS_OFF });
    }
    if (input.expectedEnvironmentId !== undefined && input.addressConfirmed !== true) {
      return yield* new PeerLinkError({
        reason: "pairing_rejected",
        message: "Select the address to approve before linking this environment.",
      });
    }
    const urls = [input.url, ...(input.alternateUrls ?? [])];
    const { primary, peer, origins } =
      input.expectedEnvironmentId === undefined
        ? yield* answeringAt(urls)
        : yield* answeringAs(
            urls,
            input.expectedEnvironmentId,
            input.expectedLabel ?? input.expectedEnvironmentId,
          );
    // Anything can answer as a linked machine, so an address alone renews its
    // link only where the link already reaches it, and never moves it.
    if (input.expectedEnvironmentId === undefined) {
      const row = yield* readRow(peer.environmentId);
      const existing = Option.isSome(row) ? yield* toLink(row.value) : undefined;
      if (
        existing !== undefined &&
        DateTime.isGreaterThan(existing.expiresAt, yield* DateTime.now) &&
        !existing.urls.includes(primary)
      ) {
        return yield* new PeerLinkError({
          reason: "pairing_rejected",
          message: `${primary} answers as ${existing.label}, which is already linked at another address. If ${existing.label} moved, forget that link first.`,
        });
      }
    }
    const enrollment = enrollmentAt(primary);
    if (enrollment !== undefined && enrollment.environmentId !== peer.environmentId) {
      return yield* new PeerLinkError({
        reason: "pairing_rejected",
        message: "The selected address did not answer as its enrolled environment.",
      });
    }
    const self = yield* environment.getDescriptor;
    if (peer.environmentId === self.environmentId) {
      return yield* new PeerLinkError({
        reason: "self",
        message: "That address is this environment.",
      });
    }
    if (!linkLimitsHold(peer)) {
      return yield* new PeerLinkError({
        reason: "incompatible",
        message: `${peer.label} runs a T3 Code version that cannot keep a linked agent's limits. Update it, then link again.`,
      });
    }
    const issued = yield* signIn(routeAt(primary), input, `T3 Code · ${self.label}`, enrollment);
    const now = yield* DateTime.now;
    const linked: PeerLink = {
      environmentId: peer.environmentId,
      label: peer.label,
      urls: origins,
      access: input.access,
      linkedAt: now,
      expiresAt: DateTime.add(now, { seconds: issued.expires_in }),
      lastReachedAt: now,
      lastError: null,
    };
    // The token goes under a name of its own before the row points at it,
    // so the row and its token are replaced together.
    const secretName = yield* newSecretName;
    const credential =
      enrollment === undefined
        ? issued.access_token
        : yield* encodeCanonicalCredential({
            canonicalOrigin: enrollment.canonicalOrigin,
            token: issued.access_token,
          }).pipe(Effect.catch(failStorage));
    yield* secrets
      .set(secretName, new TextEncoder().encode(credential))
      .pipe(Effect.catch(failStorage));
    // A token no row names could never be removed.
    const previous = yield* Effect.gen(function* () {
      const urlsJson = yield* encodeUrls(origins).pipe(Effect.catch(failStorage));
      const previous = yield* readRow(peer.environmentId);
      yield* sql`
        INSERT INTO peer_environment_links (
          environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
          last_reached_at, last_error, fenced
        ) VALUES (
          ${linked.environmentId}, ${secretName}, ${linked.label}, ${urlsJson}, ${linked.access},
          ${DateTime.formatIso(linked.linkedAt)}, ${DateTime.formatIso(linked.expiresAt)},
          ${DateTime.formatIso(now)}, NULL, 1
        )
        ON CONFLICT (environment_id) DO UPDATE SET
          secret_name = excluded.secret_name,
          fenced = excluded.fenced,
          label = excluded.label,
          urls_json = excluded.urls_json,
          access = excluded.access,
          linked_at = excluded.linked_at,
          expires_at = excluded.expires_at,
          last_reached_at = excluded.last_reached_at,
          last_error = NULL
      `.pipe(Effect.catch(failStorage));
      return previous;
    }).pipe(Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)));
    // Linking again replaces the old token. A racing link may leave its own
    // behind; it is unused either way.
    if (Option.isSome(previous) && previous.value.secret_name !== secretName) {
      yield* secrets.remove(previous.value.secret_name).pipe(Effect.ignore);
    }
    return linked;
  });

  /** A peer's label follows its machine name, so the link takes the one its own address answers with. */
  const withLabel = (link: PeerLink, label: string) =>
    label === link.label
      ? Effect.succeed(link)
      : sql`
          UPDATE peer_environment_links SET label = ${label}
          WHERE environment_id = ${link.environmentId}
        `.pipe(Effect.ignoreCause({ log: true }), Effect.as({ ...link, label }));

  const readCredential = Effect.fn("PeerLinks.readCredential")(function* (secretName: string) {
    const stored = yield* secrets.get(secretName).pipe(Effect.catch(failStorage));
    if (Option.isNone(stored)) return undefined;
    const token = new TextDecoder().decode(stored.value);
    return token.startsWith("{")
      ? yield* decodeCanonicalCredential(token).pipe(Effect.catch(failStorage))
      : { token, canonicalOrigin: undefined };
  });

  const reach = Effect.fn("PeerLinks.reach")(function* (
    link: PeerLink,
    canonicalOrigin: string | undefined,
  ) {
    const approvedUrl = link.urls[0];
    if (approvedUrl === undefined) return Option.none();
    const approved = routeAt(approvedUrl);
    const entryAtApproved = enrollmentAt(approvedUrl);
    const enrollment = enrollments.find(
      (entry) =>
        entry.environmentId === link.environmentId && entry.canonicalOrigin === canonicalOrigin,
    );
    if (enrollment === undefined) {
      // Older credentials stay on the address approved for them.
      if (
        canonicalOrigin !== undefined ||
        (entryAtApproved !== undefined &&
          (entryAtApproved.canonicalOrigin !== approvedUrl ||
            entryAtApproved.environmentId !== link.environmentId))
      ) {
        return Option.none();
      }
      const peer = yield* withProbePermit(
        link.environmentId,
        answersAs(approved, link.environmentId),
      );
      return Option.map(peer, (peer) => ({ route: approved, peer }));
    }
    return yield* findEnrolledRoute(enrollment, approved, "mcp");
  });

  const statusOf = Effect.fn("PeerLinks.statusOf")(function* (row: PeerLinkRow, now: DateTime.Utc) {
    const link = yield* toLink(row);
    if (DateTime.isLessThanOrEqualTo(link.expiresAt, now))
      return { ...link, status: "expired" } as const;
    const credential = yield* readCredential(row.secret_name).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (credential === undefined) return { ...link, status: "unreachable" } as const;
    const answered = yield* reach(link, credential.canonicalOrigin).pipe(
      Effect.timeoutOrElse({ duration: LIST_PROBE_TIMEOUT, orElse: () => Effect.succeedNone }),
    );
    if (Option.isNone(answered)) return { ...link, status: "unreachable" } as const;
    return { ...(yield* withLabel(link, answered.value.peer.label)), status: "reachable" } as const;
  });

  const list: PeerLinks["Service"]["list"] = Effect.gen(function* () {
    const rows = yield* readRows;
    const now = yield* DateTime.now;
    return yield* Effect.forEach(rows, (row) => statusOf(row, now), { concurrency: "unbounded" });
  });

  const get: PeerLinks["Service"]["get"] = (environmentId) =>
    readRow(environmentId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (row) => Effect.asSome(toLink(row)),
        }),
      ),
    );

  const unlink: PeerLinks["Service"]["unlink"] = Effect.fn("PeerLinks.unlink")(
    function* (environmentId) {
      const deleted = yield* sql<{ secret_name: string }>`
        DELETE FROM peer_environment_links WHERE environment_id = ${environmentId}
        RETURNING secret_name
      `.pipe(Effect.catch(failStorage));
      for (const row of deleted) {
        yield* secrets.remove(row.secret_name).pipe(Effect.catch(failStorage));
      }
      return deleted.length > 0;
    },
  );

  const resolve: PeerLinks["Service"]["resolve"] = Effect.fn("PeerLinks.resolve")(
    function* (environmentId) {
      const notLinked = new PeerLinkError({
        reason: "unknown_link",
        message: `This environment is not linked to ${environmentId}. t3_environment_links lists the linked ones.`,
      });
      const row = yield* readRow(environmentId);
      if (Option.isNone(row)) return yield* notLinked;
      const link = yield* toLink(row.value);
      if (DateTime.isLessThanOrEqualTo(link.expiresAt, yield* DateTime.now)) {
        return yield* new PeerLinkError({
          reason: "expired",
          message: `The link to ${link.label} expired. Link it again with a new pairing code from ${link.label}.`,
        });
      }
      const credential = yield* readCredential(row.value.secret_name);
      if (credential === undefined) {
        // An unlink between the two reads removes the row before its secret.
        if (Option.isNone(yield* readRow(environmentId))) return yield* notLinked;
        return yield* new PeerLinkError({
          reason: "unknown_link",
          message: `The link to ${link.label} lost its credential. Link it again.`,
        });
      }
      const approvedUrl = link.urls[0];
      const reached = yield* reach(link, credential.canonicalOrigin);
      if (Option.isNone(reached)) {
        return yield* new PeerLinkError({
          reason: "unreachable",
          message: `${link.label} did not answer${approvedUrl === undefined ? "" : ` at ${approvedUrl}`}.${link.urls.length > 1 ? " Link it again to approve an alternate address." : ""}`,
        });
      }
      const { route, peer } = reached.value;
      // A link made before the peer had to fence linked work, or a peer moved
      // back to such a version, would carry work past those limits.
      if (!linkLimitsHold(peer)) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${link.label} runs a T3 Code version that cannot keep a linked agent's limits. Update it, then link again.`,
        });
      }
      return {
        link: yield* withLabel(link, peer.label),
        ...route,
        token: credential.token,
      };
    },
  );

  const recordOutcome: PeerLinks["Service"]["recordOutcome"] = (environmentId, outcome) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        outcome.error === null
          ? sql`
              UPDATE peer_environment_links
              SET last_reached_at = ${DateTime.formatIso(now)}, last_error = NULL
              WHERE environment_id = ${environmentId}
            `
          : sql`
              UPDATE peer_environment_links SET last_error = ${outcome.error}
              WHERE environment_id = ${environmentId}
            `,
      ),
      Effect.asVoid,
      Effect.ignoreCause({ log: true }),
    );

  return PeerLinks.of({
    enabled,
    lookup: directory.lookup,
    link,
    list,
    get,
    unlink,
    resolve,
    recordOutcome,
  });
});

export const layer = Layer.effect(PeerLinks, make);
