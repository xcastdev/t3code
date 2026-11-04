import { describe, expect, it } from "vite-plus/test";

import { isSensitiveHeader, redactHeaderValue } from "./sensitiveHeaders.ts";

describe("isSensitiveHeader", () => {
  it.each([
    "Authorization",
    "Cookie",
    "X-Api-Key",
    "PRIVATE-TOKEN",
    "JOB-TOKEN",
    "X-Vault-Token",
    "apikey",
    "X-Access-Token",
    "X-XSRF-Token",
    "X-CSRFToken",
    "Ocp-Apim-Subscription-Key",
    "X-Shopify-Access-Token",
    "X-Goog-Api-Key",
    "api_key",
    "X-Client-Secret",
    "X-Session-Id",
    "X-Hub-Signature-256",
    "X-Password",
    "X-Amz-Access-Key",
    "X-RapidAPI-Key",
    "DD-Application-Key",
    "x-functions-key",
    "X-Master-Key",
    "X-Admin-Key",
    "X-Private-Key",
    "X-License-Key",
    "X-Client-Key",
    "Cf-Access-Jwt-Assertion",
    "X-Goog-Iap-Jwt-Assertion",
    "X-Amzn-Oidc-Data",
    "Authentication",
    "X-Honeycomb-Team",
    "X-Vercel-Protection-Bypass",
    "X-Sessionid",
    "X-Auth-Request-Access-Token",
  ])("redacts %s", (name) => {
    expect(isSensitiveHeader(name)).toBe(true);
  });

  it.each([
    "x-request-id",
    "Content-Type",
    "Accept",
    ":authority",
    "WWW-Authenticate",
    "x-ratelimit-remaining-tokens",
    "Sec-WebSocket-Key",
    "X-Amz-Content-Sha256",
    "Content-Security-Policy",
    "X-Note",
    "X-Idempotency-Key",
    "Idempotency-Key",
    "X-Cache-Key",
    "Public-Key-Pins",
    "Keep-Alive",
    "Access-Control-Allow-Credentials",
    "Access-Control-Allow-Headers",
    "X-Session-Timeout",
    "X-Session-Affinity",
    "Signature-Input",
    "Accept-Signature",
    "X-Token-Count",
    "X-Next-Page-Token",
    "X-Continuation-Token",
    "X-Auth-Request-Email",
    "X-Auth-Request-User",
    "Mcp-Session-Id",
  ])("keeps %s", (name) => {
    expect(isSensitiveHeader(name)).toBe(false);
  });
});

describe("redactHeaderValue", () => {
  it.each([
    ["sid=SECRET; Path=/; HttpOnly", "sid=[redacted]; Path=/; HttpOnly"],
    [
      "a=1; Path=/, b=SECRET; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure",
      "a=[redacted]; Path=/, b=[redacted]; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure",
    ],
    ["a=1, b=2,c=3", "a=[redacted], b=[redacted], c=[redacted]"],
  ])("hides every folded Set-Cookie value in %s", (value, expected) => {
    expect(redactHeaderValue("Set-Cookie", value)).toBe(expected);
  });
});
