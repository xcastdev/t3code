import { describe, expect, it } from "vite-plus/test";

import { parseDesktopAttachedBackendEndpoints } from "./DesktopAttachedBackendEndpoints.ts";

describe("DesktopAttachedBackendEndpoints", () => {
  it.each([
    ["http://localhost:3773/", "ws://localhost:3773/"],
    ["http://127.0.0.1:3773/", "ws://127.0.0.1:3773/"],
    ["http://127.255.255.254:3773/", "ws://127.255.255.254:3773/"],
    ["http://[::1]:3773/", "ws://[::1]:3773/"],
    ["http://LOCALHOST:3773/", "ws://localhost:3773/"],
  ])("accepts the loopback endpoint pair %s and %s", (httpBaseUrl, wsBaseUrl) => {
    expect(parseDesktopAttachedBackendEndpoints(httpBaseUrl, wsBaseUrl)).toEqual({
      httpBaseUrl: new URL(httpBaseUrl).toString(),
      wsBaseUrl: new URL(wsBaseUrl).toString(),
    });
  });

  it.each([
    ["https://localhost:3773/", "wss://localhost:3773/"],
    ["http://example.test:3773/", "ws://example.test:3773/"],
    ["http://127.0.0.1:3773/user", "ws://127.0.0.1:3773/"],
    ["http://127.0.0.1:3773/?token=secret", "ws://127.0.0.1:3773/"],
    ["http://127.0.0.1:3773/?", "ws://127.0.0.1:3773/"],
    ["http://127.0.0.1:3773/#token=secret", "ws://127.0.0.1:3773/"],
    ["http://127.0.0.1:3773/", "ws://127.0.0.1:3773/#"],
    ["http://user:password@127.0.0.1:3773/", "ws://127.0.0.1:3773/"],
    ["http://127.0.0.1:3773/", "ws://127.0.0.2:3773/"],
    ["http://127.0.0.1:3773/", "ws://127.0.0.1:3774/"],
    ["http://127.0.0.1:3773/", "ws://127.0.0.1:3773/socket"],
    [" http://127.0.0.1:3773/", "ws://127.0.0.1:3773/"],
    ["not a url", "ws://127.0.0.1:3773/"],
  ])("rejects an unsafe endpoint pair %s and %s", (httpBaseUrl, wsBaseUrl) => {
    expect(parseDesktopAttachedBackendEndpoints(httpBaseUrl, wsBaseUrl)).toBeNull();
  });
});
