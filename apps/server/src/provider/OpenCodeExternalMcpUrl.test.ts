import { describe, expect, it } from "vite-plus/test";

import {
  OpenCodeExternalMcpUrlError,
  rebaseExternalMcpUrl,
  validateExternalMcpBaseUrl,
  validateExternalOpenCodeUrl,
} from "./OpenCodeExternalMcpUrl.ts";

describe("validateExternalOpenCodeUrl", () => {
  it.each([
    "https://opencode.example.test",
    "https://opencode.example.test/api",
    "http://localhost:4096",
    "http://127.42.1.9:4096",
    "http://[::1]:4096",
  ])("accepts %s", (value) => {
    expect(validateExternalOpenCodeUrl(value)).toBe(new URL(value).toString());
  });

  it.each([
    "opencode.example.test",
    "ftp://opencode.example.test",
    "http://opencode.example.test:4096",
    "https://user:password@opencode.example.test",
    "https://opencode.example.test/#fragment",
  ])("rejects unsafe server URL %s", (value) => {
    expect(() => validateExternalOpenCodeUrl(value)).toThrow(OpenCodeExternalMcpUrlError);
  });
});

describe("validateExternalMcpBaseUrl", () => {
  it("accepts an HTTPS origin and canonicalizes it", () => {
    expect(validateExternalMcpBaseUrl(" https://t3.example.test/ ")).toBe(
      "https://t3.example.test",
    );
  });

  it("accepts an empty origin for same-machine loopback OpenCode", () => {
    expect(validateExternalMcpBaseUrl("  ")).toBe("");
  });

  it.each([
    "https://t3.example.test/mcp",
    "https://t3.example.test/?tenant=one",
    "http://t3.example.test",
    "https://user:password@t3.example.test",
    "https://t3.example.test/#fragment",
  ])("rejects invalid public origin %s", (value) => {
    expect(() => validateExternalMcpBaseUrl(value)).toThrow(OpenCodeExternalMcpUrlError);
  });
});

describe("rebaseExternalMcpUrl", () => {
  it("preserves the issued MCP endpoint path and query", () => {
    expect(
      rebaseExternalMcpUrl({
        issuedEndpoint: "http://127.0.0.1:4310/mcp/session?token=abc",
        externalMcpBaseUrl: "https://t3.example.test",
        serverUrl: "https://opencode.example.test",
      }),
    ).toBe("https://t3.example.test/mcp/session?token=abc");
  });

  it("rebases a non-loopback HTTP endpoint before validating final transport", () => {
    expect(
      rebaseExternalMcpUrl({
        issuedEndpoint: "http://100.64.0.2:4310/mcp/session?token=abc%2Fdef",
        externalMcpBaseUrl: "https://t3.example.test",
        serverUrl: "https://opencode.example.test",
      }),
    ).toBe("https://t3.example.test/mcp/session?token=abc%2Fdef");
  });

  it("rejects a non-loopback HTTP endpoint when it is transmitted directly", () => {
    expect(() =>
      rebaseExternalMcpUrl({
        issuedEndpoint: "http://100.64.0.2:4310/mcp/session",
        externalMcpBaseUrl: "",
        serverUrl: "https://opencode.example.test",
      }),
    ).toThrow(/HTTP is allowed only/);
  });

  it("rejects a loopback issued endpoint when OpenCode is remote and no origin is set", () => {
    expect(() =>
      rebaseExternalMcpUrl({
        issuedEndpoint: "http://127.0.0.1:4310/mcp",
        externalMcpBaseUrl: "",
        serverUrl: "https://opencode.example.test",
      }),
    ).toThrow(/Set T3 MCP public origin/);
  });

  it("keeps a loopback endpoint for loopback OpenCode", () => {
    expect(
      rebaseExternalMcpUrl({
        issuedEndpoint: "http://localhost:4310/mcp",
        externalMcpBaseUrl: "",
        serverUrl: "http://127.0.0.1:4096",
      }),
    ).toBe("http://localhost:4310/mcp");
  });
});
