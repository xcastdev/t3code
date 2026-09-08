import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  WS_METHODS,
  WsProjectMcpOAuthBeginRpc,
  WsProjectMcpOAuthDisconnectRpc,
  WsSubscribeServerConfigRpc,
} from "./rpc.ts";

const decodeSubscribeServerConfig = Schema.decodeUnknownSync(
  WsSubscribeServerConfigRpc.payloadSchema,
);
const decodeOAuthBeginPayload = Schema.decodeUnknownSync(WsProjectMcpOAuthBeginRpc.payloadSchema);
const decodeOAuthBeginSuccess = Schema.decodeUnknownSync(WsProjectMcpOAuthBeginRpc.successSchema);
const decodeOAuthDisconnectSuccess = Schema.decodeUnknownSync(
  WsProjectMcpOAuthDisconnectRpc.successSchema,
);

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
});
