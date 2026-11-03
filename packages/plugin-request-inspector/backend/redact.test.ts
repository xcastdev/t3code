import { describe, expect, it } from "vite-plus/test";

import { REDACTED_VALUE, redactHeaders } from "./redact.ts";

describe("redactHeaders", () => {
  it("redact removes authorization, cookie, set-cookie and proxy-authorization unless requested", () => {
    const headers: Array<[string, string]> = [
      ["Authorization", "Bearer secret"],
      ["Cookie", "session=1"],
      ["X-Trace", "abc"],
      ["set-cookie", "a=1"],
      ["Set-Cookie", "b=2"],
      ["PROXY-AUTHORIZATION", "Basic eA=="],
    ];
    expect(redactHeaders(headers, false)).toEqual([
      ["Authorization", REDACTED_VALUE],
      ["Cookie", REDACTED_VALUE],
      ["X-Trace", "abc"],
      ["set-cookie", REDACTED_VALUE],
      ["Set-Cookie", REDACTED_VALUE],
      ["PROXY-AUTHORIZATION", REDACTED_VALUE],
    ]);
    expect(redactHeaders(headers, true)).toEqual(headers);
  });
});
