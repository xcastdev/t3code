import { describe, expect, it } from "vite-plus/test";

import type { Detail } from "../app/state.ts";
import { snapshotText } from "./detail.ts";

describe("snapshotText", () => {
  it("redacts credential headers in what the panel sends to chat and keeps cookie names", () => {
    const detail: Detail = {
      id: "1",
      recordingId: "1",
      proxyId: "1",
      startedAt: 0,
      flowType: "http",
      method: "GET",
      scheme: "https",
      host: "api.example.com",
      port: 443,
      authority: "",
      path: "/me",
      httpVersion: "HTTP/1.1",
      request: {
        headers: [
          ["Authorization", "Bearer s3cret"],
          ["Cookie", "sid=c00kie; theme=dark"],
          ["X-Api-Key", "k3yval"],
          ["Accept", "application/json"],
        ],
        headersTruncated: false,
      },
      response: {
        status: 200,
        httpVersion: "HTTP/1.1",
        headers: [["Set-Cookie", "sid=n3w; Path=/; HttpOnly"]],
        headersTruncated: false,
      },
    };

    expect(snapshotText(detail)).toBe(
      [
        "GET https://api.example.com/me HTTP/1.1",
        "Authorization: [redacted]",
        "Cookie: sid=[redacted]; theme=[redacted]",
        "X-Api-Key: [redacted]",
        "Accept: application/json",
        "",
        "HTTP/1.1 200",
        "Set-Cookie: sid=[redacted]; Path=/; HttpOnly",
      ].join("\n"),
    );
  });
});
