import type { Session, WebRequestFilter } from "electron";
import { describe, expect, it } from "vite-plus/test";

import { installVerifiedRoute, parseVerifiedRouteEnrollments } from "./VerifiedRoute.ts";

describe("verified desktop route", () => {
  const origin = "https://relay.example.com:8443";
  const input = { origin, spkiSha256: Buffer.alloc(32, 1).toString("base64") };

  it("fails startup on malformed explicit enrollment", () => {
    expect(parseVerifiedRouteEnrollments(undefined)).toEqual([]);
    for (const options of [
      { ...input, origin: origin + "/" },
      { ...input, origin: "http://relay.example.com:8443" },
      { ...input, origin: "https://relay.example.com.:8443" },
      { ...input, spkiSha256: "invalid" },
      { ...input, environmentId: " " },
      { ...input, transportRole: "relay" },
      { ...input, environmentId: "environment", transportRole: "public" },
      [input, input],
      [
        input,
        {
          ...input,
          origin: "https://relay.example.com",
          spkiSha256: Buffer.alloc(32, 2).toString("base64"),
        },
      ],
    ]) {
      expect(() => parseVerifiedRouteEnrollments(JSON.stringify(options))).toThrow();
    }
  });

  it("keeps legacy pin configuration and accepts an operator-bound environment", () => {
    expect(parseVerifiedRouteEnrollments(JSON.stringify(input))[0]).not.toHaveProperty(
      "environmentId",
    );
    expect(
      parseVerifiedRouteEnrollments(JSON.stringify({ ...input, environmentId: "environment" }))[0],
    ).toMatchObject({ ...input, environmentId: "environment" });
  });

  it("blocks redirects from the enrolled route and rejects alternate authorities on its host", () => {
    type BeforeRequest = NonNullable<Parameters<Session["webRequest"]["onBeforeRequest"]>[0]>;
    type HeadersReceived = NonNullable<Parameters<Session["webRequest"]["onHeadersReceived"]>[0]>;
    let beforeRequest: BeforeRequest | null = null;
    let headersReceived: HeadersReceived | null = null;
    const network = {
      setCertificateVerifyProc: () => {},
      webRequest: {
        onBeforeRequest: (listener: BeforeRequest | WebRequestFilter | null) => {
          if (typeof listener === "function") beforeRequest = listener;
        },
        onHeadersReceived: (listener: HeadersReceived | WebRequestFilter | null) => {
          if (typeof listener === "function") headersReceived = listener;
        },
      },
    };
    installVerifiedRoute(
      network,
      parseVerifiedRouteEnrollments(
        JSON.stringify([
          { ...input, environmentId: "environment", transportRole: "relay" },
          { ...input, origin: "https://direct.example.com:8443", environmentId: "environment" },
        ]),
      ),
    );
    const request = (url: string, method = "GET") => {
      let result;
      beforeRequest!({ url, method } as Parameters<BeforeRequest>[0], (response) => {
        result = response;
      });
      return result;
    };
    const response = (
      url: string,
      statusCode: number,
      details?: Partial<Parameters<HeadersReceived>[0]>,
    ) => {
      let result;
      headersReceived!(
        { url, statusCode, ...details } as Parameters<HeadersReceived>[0],
        (response) => {
          result = response;
        },
      );
      return result;
    };
    expect(request("http://relay.example.com:8443/upload")).toEqual({ cancel: true });
    expect(request("https://relay.example.com/upload")).toEqual({ cancel: true });
    expect(request("wss://relay.example.com.:8443/ws")).toEqual({ cancel: true });
    expect(request("wss://relay.example.com:8443/ws")).toEqual({ cancel: true });
    expect(request(origin + "/.well-known/t3/relay-admission", "HEAD")).toEqual({ cancel: false });
    expect(request(origin + "/.well-known/t3/relay-admission?anything=1", "HEAD")).toEqual({
      cancel: true,
    });
    expect(request("http://direct.example.com/media")).toEqual({ cancel: true });
    expect(request("https://direct.example.com:8443/media")).toEqual({ cancel: false });
    expect(request("http://other.example.com/media")).toEqual({ cancel: false });
    expect(response(origin + "/upload", 307)).toEqual({ cancel: true });
    expect(response(origin + "/media", 304)).toEqual({ cancel: false });
    expect(response("https://direct.example.com:8443/media", 307)).toEqual({ cancel: true });
    expect(response("https://other.example.com/media", 307)).toEqual({ cancel: false });
    const document = {
      resourceType: "subFrame",
      initiatorOrigin: "t3code://app",
      responseHeaders: {
        "Content-Type": ["text/html; charset=utf-8"],
        "Content-Security-Policy": ["sandbox allow-scripts"],
      },
    } as const satisfies Partial<Parameters<HeadersReceived>[0]>;
    expect(
      response(origin + "/api/assets/claims.signature/view.html", 200, document),
    ).toMatchObject({
      cancel: false,
      responseHeaders: {
        "Allow-CSP-From": ["t3code://app"],
        "Content-Security-Policy": ["sandbox allow-scripts"],
      },
    });
    expect(response(origin + "/api/session", 200, document)).toEqual({ cancel: false });
    expect(
      response(origin + "/api/assets/claims.signature/view.html", 200, {
        ...document,
        initiatorOrigin: "https://outside.test",
      }),
    ).toEqual({ cancel: false });
  });
});
