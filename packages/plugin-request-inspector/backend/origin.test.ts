import { describe, expect, it } from "vite-plus/test";

import { requestOrigin } from "./origin.ts";

describe("requestOrigin", () => {
  it.each([
    [{ scheme: "http", host: "127.0.0.1", port: 18765 }, "127.0.0.1:18765"],
    [{ scheme: "http", host: "example.com", port: 80 }, "example.com"],
    [{ scheme: "https", host: "example.com", port: 443 }, "example.com"],
    [{ scheme: "https", host: "example.com", port: 80 }, "example.com:80"],
    [{ scheme: "http", host: "::1", port: 8080 }, "[::1]:8080"],
    [
      { scheme: "https", host: "example.com", port: 8443, authority: "example.com:8443" },
      "example.com:8443",
    ],
  ])("keeps a non-default port in %j", (target, expected) => {
    expect(requestOrigin(target)).toBe(expected);
  });
});
