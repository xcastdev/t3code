import { describe, expect, it } from "vite-plus/test";

import { decodePluginRelayMessage } from "./pluginRelay";

const SECRET = "relay-secret";
const request = { jsonrpc: "2.0", id: 1, method: "t3/initialize", params: { apiVersion: "1.0" } };

describe("decodePluginRelayMessage", () => {
  it("drops relayed messages without the secret", () => {
    expect(decodePluginRelayMessage(JSON.stringify({ message: request }), SECRET)).toBeNull();
    expect(
      decodePluginRelayMessage(JSON.stringify({ secret: "guess", message: request }), SECRET),
    ).toBeNull();
    expect(decodePluginRelayMessage(JSON.stringify(request), SECRET)).toBeNull();
    expect(decodePluginRelayMessage("not json", SECRET)).toBeNull();
    expect(
      decodePluginRelayMessage(JSON.stringify({ secret: SECRET, navigated: true }), "other"),
    ).toBeNull();
  });

  it("passes the outer page's messages, activation and navigation through", () => {
    expect(
      decodePluginRelayMessage(
        JSON.stringify({ secret: SECRET, active: true, message: request }),
        SECRET,
      ),
    ).toEqual({ kind: "message", message: request, active: true });
    expect(
      decodePluginRelayMessage(JSON.stringify({ secret: SECRET, message: request }), SECRET),
    ).toEqual({ kind: "message", message: request, active: false });
    expect(
      decodePluginRelayMessage(JSON.stringify({ secret: SECRET, navigated: true }), SECRET),
    ).toEqual({ kind: "navigated" });
  });
});
