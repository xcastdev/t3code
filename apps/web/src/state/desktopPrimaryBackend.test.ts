import { describe, expect, it } from "vite-plus/test";

import { desktopPrimaryCredentialExpiry } from "./desktopPrimaryBackend";

describe("desktopPrimaryCredentialExpiry", () => {
  const now = Date.parse("2026-10-21T12:00:00.000Z");

  it("flags an expired attached credential so Settings can ask for a refresh", () => {
    expect(desktopPrimaryCredentialExpiry("2026-10-21T11:59:59.000Z", now).kind).toBe("expired");
    expect(desktopPrimaryCredentialExpiry("2026-10-21T12:00:00.000Z", now).kind).toBe("expired");
    expect(desktopPrimaryCredentialExpiry("2026-10-22T12:00:00.000Z", now).kind).toBe("valid");
  });

  it("does not invent an expiry it cannot parse", () => {
    expect(desktopPrimaryCredentialExpiry("not a date", now)).toEqual({ kind: "unknown" });
  });
});
