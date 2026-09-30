import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAdministrativeScopes } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PersistenceErrors from "../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

/** Pinned so dev-mode cookie tests can assert the port-scoped name. */
const TEST_SERVER_PORT = 13_773;
const isPairingCredentialIssueError = Schema.is(PairingGrantStore.PairingCredentialIssueError);
const isPersistenceSqlError = Schema.is(PersistenceErrors.PersistenceSqlError);

const makeServerConfigLayer = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
        // Keep the test server deterministic even when the default test layer
        // changes its development port.
        port: TEST_SERVER_PORT,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-server-test-" })));

const makeEnvironmentAuthLayer = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.identityLayer),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

const makeCookieRequest = (
  cookieName: string,
  sessionToken: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {
      [cookieName]: sessionToken,
    },
    headers: {},
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const makeBearerRequest = (
  token: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {},
    headers: {
      authorization: `Bearer ${token}`,
    },
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

it.layer(NodeServices.layer)("EnvironmentAuth.layer", (it) => {
  it.effect("binds protected project-work approvals to a human and consumes them once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runForkMigrations(12);
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project-approval', 'Approval project', '/workspace/approval', '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const grant = yield* serverAuth.issueProjectWorkApproval({
        projectId: "project-approval",
        taskId: "task-approval",
        specRevision: 4,
        payloadFingerprint: "payload-approval",
        agentId: "agent:mcp:provider:session",
        approvedBy: { kind: "user", id: "user:reviewer", displayName: "Reviewer" },
      });
      const consumed = yield* serverAuth.consumeProjectWorkApproval({
        token: grant.token,
        projectId: "project-approval",
        taskId: "task-approval",
        specRevision: 4,
        payloadFingerprint: "payload-approval",
        agentId: "agent:mcp:provider:session",
      });
      const replay = yield* serverAuth
        .consumeProjectWorkApproval({
          token: grant.token,
          projectId: "project-approval",
          taskId: "task-approval",
          specRevision: 4,
          payloadFingerprint: "payload-approval",
          agentId: "agent:mcp:provider:session",
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catch(() => Effect.succeed("failed" as const)),
        );
      const agentIssue = yield* serverAuth
        .issueProjectWorkApproval({
          projectId: "project-approval",
          taskId: "task-approval",
          specRevision: 4,
          payloadFingerprint: "payload-approval",
          agentId: "agent:mcp:provider:session",
          approvedBy: { kind: "agent", id: "agent:mcp:provider:session" },
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catch(() => Effect.succeed("failed" as const)),
        );

      expect(consumed.approvalId).toBe(grant.approval.approvalId);
      expect(consumed.attribution.actor).toMatchObject({
        kind: "human",
        id: "user:reviewer",
      });
      expect(replay).toBe("failed");
      expect(agentIssue).toBe("failed");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("uses the reusable dev cookie without overriding a normal scoped cookie", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
      const pairing = yield* serverAuth.issuePairingCredential({ scopes: ["orchestration:read"] });
      const scopedExchange = yield* serverAuth.createBrowserSession(
        pairing.credential,
        requestMetadata,
      );
      const request = {
        cookies: {
          [sessions.cookieName]: scopedExchange.sessionToken,
          [devExchange.cookieName ?? "missing"]: devExchange.sessionToken,
        },
        headers: {},
      } as unknown as Parameters<
        EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
      >[0];

      const authenticated = yield* serverAuth.authenticateHttpRequest(request);
      expect(devExchange.cookieName).toMatch(/^t3_dev_session_/);
      expect(devExchange.expireNormalCookie).toBe(true);
      expect(authenticated.scopes).toEqual(["orchestration:read"]);
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthLayer({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("does not fall back to the dev cookie after a normal cookie is rejected", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
      const pairing = yield* serverAuth.issuePairingCredential({ scopes: ["orchestration:read"] });
      const scopedExchange = yield* serverAuth.createBrowserSession(
        pairing.credential,
        requestMetadata,
      );
      const scoped = yield* sessions.verify(scopedExchange.sessionToken);
      yield* sessions.revoke(scoped.sessionId);
      const request = {
        cookies: {
          [sessions.cookieName]: scopedExchange.sessionToken,
          [devExchange.cookieName ?? "missing"]: devExchange.sessionToken,
        },
        headers: {},
      } as unknown as Parameters<
        EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
      >[0];

      const error = yield* Effect.flip(serverAuth.authenticateHttpRequest(request));
      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthLayer({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("does not use the dev cookie when Authorization is invalid or empty", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
      for (const authorization of ["Bearer invalid", ""] as const) {
        const request = {
          cookies: { [devExchange.cookieName ?? "missing"]: devExchange.sessionToken },
          headers: { authorization },
        } as unknown as Parameters<
          EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
        >[0];
        const error = yield* Effect.flip(serverAuth.authenticateHttpRequest(request));
        expect(EnvironmentAuth.isServerAuthCredentialError(error)).toBe(true);
      }
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthLayer({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("exchanges the reusable dev token for a local scoped OAuth session", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        token,
        ["orchestration:read"],
        requestMetadata,
      );

      expect(exchanged.access_token).not.toBe(token);
      expect(exchanged.scope).toBe("orchestration:read");
      const dpop = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        token,
        ["orchestration:read"],
        requestMetadata,
        { proofKeyThumbprint: "test-proof-key" },
      );
      expect(dpop.access_token).not.toBe(token);
      expect(dpop.access_token).not.toBe(exchanged.access_token);
      expect(dpop.token_type).toBe("DPoP");
      expect(dpop.scope).toBe("orchestration:read");

      const secondBearer = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        token,
        ["orchestration:read"],
        requestMetadata,
      );
      const firstSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(exchanged.access_token),
      );
      const secondSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(secondBearer.access_token),
      );
      expect(firstSession.subject).toBe("reusable-dev-token-child");
      expect(secondSession.subject).toBe("reusable-dev-token-child");
      expect((yield* sessions.verify(token)).subject).toBe("reusable-dev-token");
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthLayer({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("uses a one-time startup credential after local dev token revocation", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const initial = yield* serverAuth.issueStartupPairingCredential();
      const seeded = yield* sessions.verify(token);

      yield* sessions.revoke(seeded.sessionId);
      const recovery = yield* serverAuth.issueStartupPairingCredential();

      expect(initial.credential).toBe(token);
      expect(recovery.credential).not.toBe(token);
      expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe("SessionTokenRevokedError");
      expect(
        (yield* serverAuth.createBrowserSession(recovery.credential, requestMetadata)).response,
      ).toMatchObject({ authenticated: true, scopes: AuthAdministrativeScopes });
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthLayer({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("keeps the pairing issue error as the immediate recovery failure", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const seeded = yield* sessions.verify(token);

      yield* sessions.revoke(seeded.sessionId);
      yield* sql`
        CREATE TRIGGER reject_startup_pairing_link
        BEFORE INSERT ON auth_pairing_links
        BEGIN
          SELECT RAISE(ABORT, 'startup pairing insert rejected');
        END
      `;

      const error = yield* Effect.flip(serverAuth.issueStartupPairingCredential());

      expect(error._tag).toBe("ServerAuthPairingLinkCreationError");
      expect(isPairingCredentialIssueError(error.cause)).toBe(true);
      if (isPairingCredentialIssueError(error.cause)) {
        expect(isPersistenceSqlError(error.cause.cause)).toBe(true);
      }
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthLayer({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("classifies invalid bootstrap credential failures for the HTTP boundary", () =>
    Effect.sync(() => {
      const error = EnvironmentAuth.toBootstrapExchangeError(
        new PairingGrantStore.UnknownBootstrapCredentialError({}),
      );

      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }),
  );

  it.effect("maps unexpected bootstrap failures to 500", () =>
    Effect.sync(() => {
      const cause = new PairingGrantStore.BootstrapCredentialConsumeError({
        cause: new Error("sqlite is unavailable"),
      });
      const error = EnvironmentAuth.toBootstrapExchangeError(cause);

      expect(error._tag).toBe("ServerAuthBootstrapCredentialValidationError");
      expect(error.message).toBe("Failed to validate bootstrap credential.");
      if (error._tag === "ServerAuthBootstrapCredentialValidationError") {
        expect(error.cause).toBe(cause);
      }
    }),
  );

  it.effect("issues standard pairing credentials by default", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;

      const pairingCredential = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(
        pairingCredential.credential,
        requestMetadata,
      );
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(sessions.cookieName, exchanged.sessionToken),
      );

      expect(verified.sessionId.length).toBeGreaterThan(0);
      expect(verified.scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
      ]);
      expect(verified.subject).toBe("one-time-token");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("prefers a bearer token over a stale legacy cookie", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const bearer = yield* serverAuth.issueSession();
      const verified = yield* serverAuth.authenticateHttpRequest({
        cookies: { [sessions.legacyCookieName ?? "t3_session"]: "stale" },
        headers: { authorization: `Bearer ${bearer.token}` },
      } as never);

      expect(verified.sessionId).toBe(bearer.sessionId);
    }).pipe(Effect.provide(makeEnvironmentAuthLayer({ mode: "web", host: "192.168.1.50" }))),
  );

  it.effect("does not exchange ordinary pairing grants for administrative access tokens", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential();

      const error = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(
          pairingCredential.credential,
          ["orchestration:read", "access:write"],
          requestMetadata,
        )
        .pipe(Effect.flip);

      expect(error._tag).toBe("ServerAuthScopeNotGrantedError");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("inherits a constrained pairing grant when token exchange omits scope", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: ["orchestration:read"],
      });

      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairingCredential.credential,
        undefined,
        requestMetadata,
      );

      expect(token.scope).toBe("orchestration:read");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("rotates desktop bearer sessions without accumulating authorized clients", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* serverAuth.createBrowserSession(
        "desktop-bootstrap-token",
        requestMetadata,
      );
      const browserSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(sessions.cookieName, browser.sessionToken),
      );
      const staleSessions = yield* Effect.forEach([1, 2, 3], () =>
        sessions.issue({ subject: "desktop-bootstrap", method: "bearer-access-token" }),
      );
      const pairing = yield* serverAuth.issuePairingCredential();
      const paired = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairing.credential,
        undefined,
        { ...requestMetadata, label: "T3 Code Desktop" },
      );
      const first = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
      );
      const firstSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(first.access_token),
      );
      const second = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
      );

      const active = yield* serverAuth.listSessions();
      const firstError = yield* serverAuth
        .authenticateHttpRequest(makeBearerRequest(first.access_token))
        .pipe(Effect.flip);
      const secondSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(second.access_token),
      );

      expect(active).toHaveLength(3);
      expect(active.map((entry) => entry.sessionId)).toContain(browserSession.sessionId);
      expect(active.map((entry) => entry.sessionId)).toContain(secondSession.sessionId);
      expect(active.map((entry) => entry.sessionId)).not.toContain(firstSession.sessionId);
      expect(firstError._tag).toBe("ServerAuthInvalidCredentialError");
      for (const stale of staleSessions) {
        const error = yield* sessions.verify(stale.token).pipe(Effect.flip);
        expect(error._tag).toBe("SessionTokenRevokedError");
      }
      const pairedSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(paired.access_token),
      );
      expect(pairedSession.subject).toBe("one-time-token");
      expect(active.map((entry) => entry.sessionId)).toContain(pairedSession.sessionId);
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthLayer({
          desktopBootstrapToken: "desktop-bootstrap-token",
        }),
      ),
    ),
  );

  it.effect("keeps user-issued administrative pairing links manageable", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: AuthAdministrativeScopes,
      });
      const listedPairingLinks = yield* serverAuth.listPairingLinks();

      expect(
        listedPairingLinks.find((pairingLink) => pairingLink.id === pairingCredential.id)?.subject,
      ).toBe("one-time-token");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("issues startup pairing URLs that bootstrap administrative sessions", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;

      const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
      const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      expect(token).toBeTruthy();
      expect(
        listedPairingLinks.some(
          (pairingLink) => pairingLink.subject === "administrative-bootstrap",
        ),
      ).toBe(false);

      const exchanged = yield* serverAuth.createBrowserSession(token ?? "", requestMetadata);
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(sessions.cookieName, exchanged.sessionToken),
      );

      expect(verified.scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
      expect(verified.subject).toBe("administrative-bootstrap");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect(
    "lists pairing links and revokes other sessions while keeping the administrative session",
    () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;

        const administrativeExchange = yield* serverAuth.createBrowserSession(
          "desktop-bootstrap-token",
          requestMetadata,
        );
        const administrativeSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(sessions.cookieName, administrativeExchange.sessionToken),
        );
        const pairingCredential = yield* serverAuth.issuePairingCredential({
          label: "Julius iPhone",
        });
        const listedPairingLinks = yield* serverAuth.listPairingLinks();
        const clientExchange = yield* serverAuth.createBrowserSession(
          pairingCredential.credential,
          {
            ...requestMetadata,
            deviceType: "mobile",
            os: "iOS",
            browser: "Safari",
            ipAddress: "192.168.1.88",
          },
        );
        const clientSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(sessions.cookieName, clientExchange.sessionToken),
        );
        const clientsBeforeRevoke = yield* serverAuth.listClientSessions(
          administrativeSession.sessionId,
        );
        const revokedCount = yield* serverAuth.revokeOtherClientSessions(
          administrativeSession.sessionId,
        );
        const clientsAfterRevoke = yield* serverAuth.listClientSessions(
          administrativeSession.sessionId,
        );

        expect(listedPairingLinks.map((entry) => entry.id)).toContain(pairingCredential.id);
        expect(listedPairingLinks.find((entry) => entry.id === pairingCredential.id)?.label).toBe(
          "Julius iPhone",
        );
        expect(clientsBeforeRevoke).toHaveLength(2);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === administrativeSession.sessionId)
            ?.current,
        ).toBe(true);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.current,
        ).toBe(false);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
            .label,
        ).toBe("Julius iPhone");
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
            .deviceType,
        ).toBe("mobile");
        expect(revokedCount).toBe(1);
        expect(clientsAfterRevoke).toHaveLength(1);
        expect(clientsAfterRevoke[0]?.sessionId).toBe(administrativeSession.sessionId);
      }).pipe(
        Effect.provide(
          makeEnvironmentAuthLayer({
            desktopBootstrapToken: "desktop-bootstrap-token",
          }),
        ),
      ),
  );
});

import * as TeamAuthorization from "../projectWork/ProjectTeamAuthorization.ts";
import { ProjectWorkRepositoryLive } from "../projectWork/ProjectWorkRepository.ts";
import {
  seed as seedTeam,
  decodeRecord as decodeTeamRecord,
} from "../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import {
  authorizeRpcSession,
  guardRpcEffect,
  guardRpcStream,
  guardRpcStreamEffect,
} from "./RpcAuthorization.ts";
import { WS_METHODS, ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

const managedAuthLayer = Layer.mergeAll(EnvironmentAuth.layer, ProjectWorkRepositoryLive).pipe(
  Layer.provideMerge(TeamAuthorization.layer),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provideMerge(makeServerConfigLayer()),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
it.effect(
  "enforces current SQL credentials before managed RPC side effects and every stream payload",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const legacy = yield* auth.issueSession({
        identity: { kind: "agent", id: "agent:mcp:pi:authorization-thread" },
      });
      const legacySession = yield* auth.authenticateHttpRequest(makeBearerRequest(legacy.token));
      expect(legacySession.managed).toBeUndefined();
      const f = yield* seedTeam("implementer");
      expect(
        (yield* auth.authenticateHttpRequest(makeBearerRequest(legacy.token)).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(
        (yield* auth.issueSession({ subject: "agent:project-team:forged" }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(
        (yield* auth
          .createPairingLink({ subject: "agent:project-team:forged" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const issued = yield* auth.issueSession({ managed: f.principal.managed });
      const session = yield* auth.authenticateHttpRequest(makeBearerRequest(issued.token));
      expect(session.managed).toEqual(f.principal.managed);
      let effects = 0;
      for (const method of [
        WS_METHODS.terminalOpen,
        WS_METHODS.gitCommitIndex,
        WS_METHODS.gitRunStackedAction,
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        WS_METHODS.projectWorkRequestApproval,
      ]) {
        const result = yield* guardRpcEffect(
          authorizeRpcSession(method, session, auth),
          Effect.sync(() => effects++),
        ).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
      expect(effects).toBe(0);
      yield* guardRpcEffect(
        authorizeRpcSession(WS_METHODS.projectWorkRead, session, auth),
        Effect.sync(() => effects++),
      );
      expect(effects).toBe(1);
      const validation = authorizeRpcSession(WS_METHODS.projectWorkSubscribe, session, auth);
      const received: string[] = [];
      const values = Stream.fromIterable(["allowed", "must-not-leak"]).pipe(
        Stream.mapEffect((value) =>
          value === "allowed"
            ? Effect.succeed(value)
            : f
                .change(decodeTeamRecord({ ...f.binding, revision: 1, status: "revoked" }))
                .pipe(Effect.as(value)),
        ),
      );
      const result = yield* guardRpcStream(validation, values).pipe(
        Stream.runForEach((value) => Effect.sync(() => received.push(value))),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(received).toEqual(["allowed"]);
      let constructed = false;
      expect(
        (yield* guardRpcStreamEffect(
          validation,
          Effect.sync(() => {
            constructed = true;
            return Stream.make("secret");
          }),
        ).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(constructed).toBe(false);
      expect(
        (yield* auth.authenticateHttpRequest(makeBearerRequest(issued.token)).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${f.principal.managed.projectId}`;
      yield* f.sql`DELETE FROM project_work_events WHERE project_id=${f.principal.managed.projectId}`;
      yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${f.principal.managed.projectId}`;
      expect((yield* auth.validateCurrentSession!(legacySession).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* auth.validateCurrentSession!(session).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      const restartedAuth = yield* EnvironmentAuth.EnvironmentAuth.pipe(
        Effect.provide(
          EnvironmentAuth.layer.pipe(
            Layer.provide(Layer.fresh(TeamAuthorization.layer)),
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(ServerEnvironment.identityLayer),
            Layer.provide(makeServerConfigLayer()),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      expect(
        (yield* restartedAuth.validateCurrentSession!(legacySession).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(Layer.fresh(managedAuthLayer))),
);

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { HttpServer } from "effect/unstable/http";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  CommandId,
  ProjectWorkTaskId,
  ProjectWorkAttemptId,
  ProjectWorkCriterionId,
} from "@t3tools/contracts";
import { at } from "../projectWork/ProjectTeamAuthorization.testFixtures.ts";

for (const issuance of [
  "successful",
  "retired-role",
  "settled-binding",
  "ambiguous-bindings",
] as const)
  it.effect(`permanently withdraws old environment bearers on MCP-only ${issuance} issuance`, () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const config = yield* ServerConfig.ServerConfig;
      const legacy = yield* auth.issueSession({
        identity: { kind: "agent", id: "agent:mcp:pi:authorization-thread" },
      });
      const ordinary = yield* auth.issueSession({
        identity: { kind: "agent", id: "agent:ordinary" },
      });
      const held = yield* auth.authenticateHttpRequest(makeBearerRequest(legacy.token));
      const f = yield* seedTeam("implementer", "running", { issueCredential: false });
      const before =
        yield* f.sql`SELECT revoked_at AS revokedAt FROM auth_sessions WHERE session_id=${held.sessionId}`;
      expect(before[0]?.revokedAt).toBeNull();
      if (issuance === "retired-role")
        yield* f.change(decodeTeamRecord({ ...f.role, revision: 1, status: "retired" }));
      else if (issuance === "settled-binding")
        yield* f.change(decodeTeamRecord({ ...f.binding, revision: 1, status: "settled" }));
      else if (issuance === "ambiguous-bindings") {
        const otherTask = ProjectWorkTaskId.make("other-task");
        const otherAttempt = ProjectWorkAttemptId.make("other-attempt");
        const criterion = ProjectWorkCriterionId.make("other-criterion");
        yield* f.repo.execute({
          type: "project-work.task.create",
          projectId: f.principal.managed.projectId,
          taskId: otherTask,
          commandId: CommandId.make("other-create"),
          title: "Other task",
          createdAt: at,
        });
        yield* f.repo.execute({
          type: "project-work.criterion.upsert",
          projectId: f.principal.managed.projectId,
          taskId: otherTask,
          commandId: CommandId.make("other-criterion"),
          criterion: {
            criterionId: criterion,
            taskId: otherTask,
            description: "Other scope",
            required: false,
            status: "unsatisfied",
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: at,
          },
          updatedAt: at,
        });
        yield* f.repo.execute({
          type: "project-work.task.specify",
          projectId: f.principal.managed.projectId,
          taskId: otherTask,
          commandId: CommandId.make("other-spec"),
          specification: {
            objective: "Other scope",
            scopeIn: "Other",
            scopeOut: "Assigned task",
            criterionIds: [criterion],
            revision: 1,
            protected: false,
          },
          updatedAt: at,
        });
        yield* f.repo.execute({
          type: "project-work.task.ready",
          projectId: f.principal.managed.projectId,
          taskId: otherTask,
          commandId: CommandId.make("other-ready"),
          updatedAt: at,
        });
        yield* f.repo.execute({
          type: "project-work.task.claim",
          projectId: f.principal.managed.projectId,
          taskId: otherTask,
          commandId: CommandId.make("other-claim"),
          attemptId: otherAttempt,
          leaseToken: "other-lease",
          leasedUntil: "2030-01-01T00:00:00.000Z",
          claimedAt: at,
        });
        yield* f.change(
          decodeTeamRecord({
            ...f.binding,
            recordId: "other-binding",
            taskId: otherTask,
            attemptId: otherAttempt,
          }),
        );
      }
      const registry = yield* McpSessionRegistry.__testing.make({ now: () => 1000 }).pipe(
        Effect.provideService(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
            serve: () => Effect.void,
          }),
        ),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
      );
      for (const identity of [
        {
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId: ThreadId.make("authorization-thread"),
        },
        {
          providerInstanceId: ProviderInstanceId.make("pi"),
          threadId: ThreadId.make("ordinary-thread"),
        },
      ]) {
        const bearer = yield* auth.issueSession({
          identity: { kind: "agent", id: TeamAuthorization.managedActorId(identity) },
        });
        expect(
          (yield* registry.issue({ ...identity, managed: f.principal.managed }).pipe(Effect.exit))
            ._tag,
        ).toBe("Failure");
        expect(
          (yield* auth.authenticateHttpRequest(makeBearerRequest(bearer.token))).identity.id,
        ).toBe(TeamAuthorization.managedActorId(identity));
      }
      const managedMcp = yield* registry
        .issue({
          threadId: ThreadId.make("authorization-thread"),
          providerInstanceId: ProviderInstanceId.make("pi"),
        })
        .pipe(Effect.exit);
      expect(managedMcp._tag).toBe(issuance === "successful" ? "Success" : "Failure");
      const withdrawn =
        yield* f.sql`SELECT revoked_at AS revokedAt FROM auth_sessions WHERE session_id=${held.sessionId}`;
      expect(withdrawn[0]?.revokedAt).not.toBeNull();
      if (managedMcp._tag === "Success")
        expect(
          yield* registry.resolve(
            managedMcp.value.config.authorizationHeader.replace("Bearer ", ""),
          ),
        ).toBeDefined();
      expect(
        (yield* authorizeRpcSession(WS_METHODS.terminalOpen, held, auth).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${f.principal.managed.projectId}`;
      yield* f.sql`DELETE FROM project_work_events WHERE project_id=${f.principal.managed.projectId}`;
      yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${f.principal.managed.projectId}`;
      expect(
        (yield* authorizeRpcSession(WS_METHODS.terminalOpen, held, auth).pipe(Effect.result))._tag,
      ).toBe("Failure");
      const restarted = yield* EnvironmentAuth.EnvironmentAuth.pipe(
        Effect.provide(
          EnvironmentAuth.layer.pipe(
            Layer.provide(Layer.fresh(TeamAuthorization.layer)),
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(ServerEnvironment.identityLayer),
            Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      let effects = 0;
      const result = yield* guardRpcEffect(
        authorizeRpcSession(WS_METHODS.terminalOpen, held, restarted),
        Effect.sync(() => effects++),
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(effects).toBe(0);
      expect(
        (yield* restarted
          .authenticateHttpRequest(makeBearerRequest(legacy.token))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* restarted.authenticateHttpRequest(makeBearerRequest(ordinary.token))).identity.id,
      ).toBe("agent:ordinary");
      const revoked =
        yield* f.sql`SELECT revoked_at AS revokedAt FROM auth_sessions WHERE session_id=${held.sessionId}`;
      expect(revoked[0]?.revokedAt).not.toBeNull();
      yield* registry.revokeAll;
    }).pipe(Effect.provide(Layer.fresh(managedAuthLayer))),
  );

it.effect("preserves a valid managed environment bearer through repeated trusted issuance", () =>
  Effect.gen(function* () {
    const f = yield* seedTeam("implementer");
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const bearer = yield* auth.issueSession({ managed: f.principal.managed });
    for (let n = 0; n < 3; n++) {
      yield* f.auth.issueCredential(f.principal.managed);
      const session = yield* auth.authenticateHttpRequest(makeBearerRequest(bearer.token));
      yield* authorizeRpcSession(WS_METHODS.projectWorkRead, session, auth);
    }
  }).pipe(Effect.provide(Layer.fresh(managedAuthLayer))),
);

import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

for (const timing of ["before", "queued", "interrupted"] as const)
  it.effect(`keeps binding observation and withdrawal consistent for ${timing} issuance`, () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const config = yield* ServerConfig.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const legacy = yield* auth.issueSession({
        identity: { kind: "agent", id: "agent:mcp:pi:authorization-thread" },
      });
      const held = yield* auth.authenticateHttpRequest(makeBearerRequest(legacy.token));
      const preseed =
        timing === "queued"
          ? undefined
          : yield* seedTeam("implementer", "running", { issueCredential: false });
      const completed = yield* Deferred.make<{
        readonly inTransaction: boolean;
        readonly bindingCount: number;
      }>();
      const release = yield* Deferred.make<void>();
      const issuedAuthority = yield* Deferred.make<
        TeamAuthorization.ProjectTeamAuthority | undefined
      >();
      let intercepted = false;
      // Preserve SQL execution/results while holding the first binding observation or withdrawal receipt.
      const racingSql = new Proxy(sql, {
        apply(target, _receiver, args) {
          const statement = target(args[0], ...args.slice(1));
          if (!Array.isArray(args[0]) || !("raw" in args[0])) return statement;
          const bindingObservation = statement
            .compile()[0]
            .includes("SELECT DISTINCT project_id AS projectId FROM project_team_run_binding");
          if (
            !intercepted &&
            (statement.compile()[0].includes("UPDATE auth_sessions SET revoked_at=") ||
              (timing !== "interrupted" && bindingObservation))
          ) {
            intercepted = true;
            return statement.pipe(
              Effect.tap((observedRows) =>
                Effect.gen(function* () {
                  const transaction = yield* Effect.serviceOption(sql.transactionService);
                  const rows = bindingObservation
                    ? observedRows
                    : yield* sql`SELECT record_id FROM project_team_run_binding WHERE provider_instance_id='pi' AND thread_id='authorization-thread'`;
                  yield* Deferred.succeed(completed, {
                    inTransaction: transaction._tag === "Some",
                    bindingCount: rows.length,
                  });
                  yield* Deferred.await(release);
                }),
              ),
            );
          }
          return statement;
        },
      });
      const authorization = yield* TeamAuthorization.ProjectTeamAuthorization.pipe(
        Effect.provide(
          Layer.fresh(TeamAuthorization.layer).pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, racingSql)),
          ),
        ),
      );
      const registry = yield* McpSessionRegistry.__testing.make({ now: () => 1000 }).pipe(
        Effect.provideService(
          TeamAuthorization.ProjectTeamAuthorization,
          TeamAuthorization.ProjectTeamAuthorization.of({
            ...authorization,
            // Observe the actual returned authority without changing it.
            issueCredential: (identity) =>
              authorization
                .issueCredential(identity)
                .pipe(Effect.tap((authority) => Deferred.succeed(issuedAuthority, authority))),
          }),
        ),
        Effect.provideService(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
            serve: () => Effect.void,
          }),
        ),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
      );
      const request = {
        providerInstanceId: ProviderInstanceId.make("pi"),
        threadId: ThreadId.make("authorization-thread"),
      };
      const pending = yield* registry.issue(request).pipe(Effect.forkScoped);
      const receipt = yield* Deferred.await(completed);
      expect(receipt.bindingCount).toBe(timing === "queued" ? 0 : 1);
      if (timing === "interrupted") {
        yield* Fiber.interrupt(pending);
        expect((yield* Fiber.await(pending))._tag).toBe("Failure");
      } else if (timing === "queued") {
        const attempted = yield* Deferred.make<void>();
        const writerSql = new Proxy(sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            if (!Array.isArray(args[0]) || !("raw" in args[0])) return statement;
            Deferred.doneUnsafe(attempted, Effect.void);
            return statement;
          },
        });
        const writer = yield* seedTeam("implementer", "running", { issueCredential: false }).pipe(
          Effect.provideService(SqlClient.SqlClient, writerSql),
          Effect.forkScoped,
        );
        yield* Deferred.await(attempted);
        if (receipt.inTransaction) {
          // The real SQLite writer waits on the issuance transaction's owned connection.
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pending);
          expect(yield* Deferred.await(issuedAuthority)).toBeUndefined();
          yield* Fiber.join(writer);
        } else {
          // The unrepaired boundary permits the writer to finish before discovery resumes.
          yield* Fiber.join(writer);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pending);
          expect(yield* Deferred.await(issuedAuthority)).toBeUndefined();
        }
        const managed = yield* registry.issue(request);
        expect(
          (yield* registry.resolve(managed.config.authorizationHeader.replace("Bearer ", "")))
            ?.managed,
        ).toBeDefined();
      } else {
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pending);
        expect((yield* Deferred.await(issuedAuthority))?.credential).toEqual(
          preseed!.principal.managed,
        );
      }
      // These ordinary statements also prove interruption/release returned the SQL permit.
      const withdrawn =
        yield* sql`SELECT revoked_at AS revokedAt FROM auth_sessions WHERE session_id=${held.sessionId}`;
      yield* sql`DELETE FROM project_team_run_binding WHERE project_id='authorization-project'`;
      yield* sql`DELETE FROM project_work_events WHERE project_id='authorization-project'`;
      yield* sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id='authorization-project'`;
      const restarted = yield* EnvironmentAuth.EnvironmentAuth.pipe(
        Effect.provide(
          EnvironmentAuth.layer.pipe(
            Layer.provide(Layer.fresh(TeamAuthorization.layer)),
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(ServerEnvironment.identityLayer),
            Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      let effects = 0;
      const guarded = yield* guardRpcEffect(
        authorizeRpcSession(WS_METHODS.terminalOpen, held, restarted),
        Effect.sync(() => effects++),
      ).pipe(Effect.result);
      const bearer = yield* restarted
        .authenticateHttpRequest(makeBearerRequest(legacy.token))
        .pipe(Effect.result);
      expect({
        withdrawn: withdrawn[0]?.revokedAt !== null,
        guarded: guarded._tag,
        bearer: bearer._tag,
        effects,
      }).toEqual({
        withdrawn: true,
        guarded: "Failure",
        bearer: "Failure",
        effects: 0,
      });
      yield* registry.revokeAll;
    }).pipe(Effect.provide(Layer.fresh(managedAuthLayer))),
  );

it.effect(
  "cancels trusted issuance waiting for SQL ownership without retaining the connection",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const legacy = yield* auth.issueSession({
        identity: { kind: "agent", id: "agent:mcp:pi:authorization-thread" },
      });
      const held = yield* auth.authenticateHttpRequest(makeBearerRequest(legacy.token));
      const f = yield* seedTeam("implementer", "running", { issueCredential: false });
      const owned = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const requested = yield* Deferred.make<void>();
      const owner = yield* f.sql
        .withTransaction(
          Effect.gen(function* () {
            yield* Deferred.succeed(owned, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(owned);
      let observed = false;
      const waitingSql = new Proxy(f.sql, {
        apply(target, _receiver, args) {
          const statement = target(args[0], ...args.slice(1));
          if (!Array.isArray(args[0]) || !("raw" in args[0])) return statement;
          if (
            !observed &&
            statement
              .compile()[0]
              .includes("SELECT DISTINCT project_id AS projectId FROM project_team_run_binding")
          ) {
            observed = true;
            return Deferred.succeed(requested, undefined).pipe(Effect.andThen(statement));
          }
          return statement;
        },
      });
      const authorization = yield* TeamAuthorization.ProjectTeamAuthorization.pipe(
        Effect.provide(
          Layer.fresh(TeamAuthorization.layer).pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, waitingSql)),
          ),
        ),
      );
      const pending = yield* authorization
        .issueCredential(f.principal.managed)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(requested);
      // Cancellation must settle while the other real SQL owner still holds its permit.
      yield* Fiber.interrupt(pending);
      expect((yield* Fiber.await(pending))._tag).toBe("Failure");
      expect(yield* Deferred.isDone(release)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
      const untouched =
        yield* f.sql`SELECT revoked_at AS revokedAt FROM auth_sessions WHERE session_id=${held.sessionId}`;
      expect(untouched[0]?.revokedAt).toBeNull();
      expect(yield* authorization.issueCredential(f.principal.managed)).toBeDefined();
      const withdrawn =
        yield* f.sql`SELECT revoked_at AS revokedAt FROM auth_sessions WHERE session_id=${held.sessionId}`;
      expect(withdrawn[0]?.revokedAt).not.toBeNull();
      expect(
        (yield* authorizeRpcSession(WS_METHODS.terminalOpen, held, auth).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(Layer.fresh(managedAuthLayer))),
);
