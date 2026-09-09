import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  WS_METHODS,
  WsMcpCatalogGlobalStateListRpc,
  WsMcpCatalogGlobalCreateRpc,
  WsMcpCatalogProjectListRpc,
  WsMcpCatalogProjectStateListRpc,
  WsMcpCatalogProjectCreateRpc,
  WsMcpCatalogSessionCreateRpc,
  WsProjectMcpCreateRpc,
  WsProjectMcpRemoveRpc,
  WsProjectMcpOAuthBeginRpc,
  WsProjectMcpOAuthContinueRpc,
  WsProjectMcpOAuthDisconnectRpc,
  WsProjectMcpUpdateRpc,
  WsSubscribeServerConfigRpc,
} from "./rpc.ts";

const decodeSubscribeServerConfig = Schema.decodeUnknownSync(
  WsSubscribeServerConfigRpc.payloadSchema,
);
const decodeOAuthBeginPayload = Schema.decodeUnknownSync(WsProjectMcpOAuthBeginRpc.payloadSchema);
const decodeOAuthBeginSuccess = Schema.decodeUnknownSync(WsProjectMcpOAuthBeginRpc.successSchema);
const decodeOAuthContinueSuccess = Schema.decodeUnknownSync(
  WsProjectMcpOAuthContinueRpc.successSchema,
);
const decodeOAuthDisconnectSuccess = Schema.decodeUnknownSync(
  WsProjectMcpOAuthDisconnectRpc.successSchema,
);
const decodeCreateError = Schema.decodeUnknownSync(WsProjectMcpCreateRpc.errorSchema);
const decodeUpdateError = Schema.decodeUnknownSync(WsProjectMcpUpdateRpc.errorSchema);
const decodeRemoveError = Schema.decodeUnknownSync(WsProjectMcpRemoveRpc.errorSchema);

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeUnknownExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = decodeSubscribeServerConfig({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = decodeSubscribeServerConfig({});
    expect(decoded).toEqual({});
  });
});

describe("project MCP OAuth RPC contracts", () => {
  it("publishes begin and disconnect methods without accepting a client redirect URL", () => {
    expect(WS_METHODS).toMatchObject({
      projectMcpOauthBegin: "projectMcp.oauth.begin",
      projectMcpOauthDisconnect: "projectMcp.oauth.disconnect",
    });

    expect(
      decodeOAuthBeginPayload({
        projectId: "project-1",
        id: "mcp-1",
      }),
    ).toEqual({ projectId: "project-1", id: "mcp-1" });
    expect(() =>
      decodeOAuthBeginPayload({
        projectId: "project-1",
        id: "mcp-1",
        redirectUrl: "https://attacker.example/callback",
      }),
    ).toThrow();
    expect(
      decodeOAuthBeginSuccess({
        authorizationUrl: "https://issuer.example/authorize?state=opaque",
        expiresAt: "2026-09-04T12:00:00.000Z",
      }),
    ).toEqual({
      authorizationUrl: "https://issuer.example/authorize?state=opaque",
      expiresAt: "2026-09-04T12:00:00.000Z",
    });
    expect(
      decodeOAuthDisconnectSuccess({
        id: "mcp-1",
        name: "OAuth docs",
        url: "https://example.com/mcp",
        enabled: true,
        providerInstanceIds: [],
        oauthStatus: "not-connected",
      }),
    ).toMatchObject({ oauthStatus: "not-connected" });
  });

  it("keeps begin and continue success URLs bounded at the shared contract limit", () => {
    const prefix = "https://issuer.example.test/authorize?padding=";
    const authorizationUrlAtLimit = `${prefix}${"x".repeat(4_096 - prefix.length)}`;
    const authorizationUrlOverLimit = `${authorizationUrlAtLimit}x`;
    const expiresAt = "2026-09-08T00:00:00.000Z";
    const successAtLimit = { authorizationUrl: authorizationUrlAtLimit, expiresAt };
    const successOverLimit = { authorizationUrl: authorizationUrlOverLimit, expiresAt };

    expect(decodeOAuthBeginSuccess(successAtLimit)).toEqual(successAtLimit);
    expect(decodeOAuthContinueSuccess(successAtLimit)).toEqual(successAtLimit);
    expect(() => decodeOAuthBeginSuccess(successOverLimit)).toThrow();
    expect(() => decodeOAuthContinueSuccess(successOverLimit)).toThrow();
  });

  it("accepts committed cleanup-pending mutation errors", () => {
    const error = {
      _tag: "ProjectMcpCatalogCommittedCleanupPendingError",
      id: "mcp-1",
      operation: "update",
      sequence: 42,
    };
    expect(decodeCreateError({ ...error, operation: "create" })._tag).toBe(
      "ProjectMcpCatalogCommittedCleanupPendingError",
    );
    expect(decodeUpdateError(error)).toMatchObject(error);
    expect(decodeRemoveError({ ...error, operation: "remove" })).toMatchObject({
      ...error,
      operation: "remove",
    });
    expect(() => decodeUpdateError({ ...error, operation: "other" })).toThrow();
    expect(() => decodeUpdateError({ ...error, sequence: 0 })).toThrow();
  });
});

describe("scoped MCP catalog global state RPC", () => {
  it("publishes a compatibility-safe state response with the revision", () => {
    expect(WS_METHODS.mcpCatalogGlobalStateList).toBe("mcpCatalog.global.state.list");
    expect(
      Schema.decodeUnknownSync(WsMcpCatalogGlobalStateListRpc.successSchema)({
        definitions: [],
        globalRevision: 7,
      }),
    ).toEqual({ definitions: [], globalRevision: 7 });
  });
});

describe("scoped MCP catalog payload identities", () => {
  const definition = {
    name: "Docs",
    transport: {
      type: "streamable-http" as const,
      url: "https://docs.example.test/mcp",
      headers: [],
      authorization: { type: "none" as const },
    },
    enabled: true,
    providerInstanceIds: ["codex"],
  };

  it("rejects a contradictory global scope", () => {
    const decode = Schema.decodeUnknownSync(WsMcpCatalogGlobalCreateRpc.payloadSchema);
    expect(() =>
      decode({
        scope: "project",
        scopeId: "project-1",
        expectedRevision: 0,
        definition,
      }),
    ).toThrow();
    expect(
      decode({
        scope: "global",
        scopeId: "environment-1",
        expectedRevision: 0,
        definition,
      }),
    ).toMatchObject({ scope: "global", scopeId: "environment-1" });
  });

  it("rejects a project create with a non-project scope", () => {
    const decode = Schema.decodeUnknownSync(WsMcpCatalogProjectCreateRpc.payloadSchema);
    expect(() =>
      decode({
        scope: "global",
        scopeId: "environment-1",
        expectedRevision: 0,
        definition,
      }),
    ).toThrow();
  });

  it("requires a provider for effective project lists", () => {
    const decode = Schema.decodeUnknownSync(WsMcpCatalogProjectListRpc.payloadSchema);
    expect(() => decode({ scope: "project", scopeId: "project-1" })).toThrow();
    expect(
      decode({ scope: "project", scopeId: "project-1", providerInstanceId: "codex" }),
    ).toMatchObject({ providerInstanceId: "codex" });
  });

  it("keeps raw project state provider-independent", () => {
    const decode = Schema.decodeUnknownSync(WsMcpCatalogProjectStateListRpc.payloadSchema);
    expect(decode({ scope: "project", scopeId: "project-1" })).toEqual({
      scope: "project",
      scopeId: "project-1",
    });
    expect(decode({ scope: "project", scopeId: "project-1", providerInstanceId: "codex" })).toEqual(
      { scope: "project", scopeId: "project-1" },
    );
  });

  it("requires session scope id to match the session identity", () => {
    const decode = Schema.decodeUnknownSync(WsMcpCatalogSessionCreateRpc.payloadSchema);
    expect(() =>
      decode({
        scope: "session",
        scopeId: "session-other",
        threadId: "thread-1",
        mcpCatalogSessionId: "session-1",
        expectedRevision: 0,
        definition,
      }),
    ).toThrow();
    expect(
      decode({
        scope: "session",
        scopeId: "session-1",
        threadId: "thread-1",
        mcpCatalogSessionId: "session-1",
        expectedRevision: 0,
        definition,
      }),
    ).toMatchObject({ scopeId: "session-1", mcpCatalogSessionId: "session-1" });
  });
});
