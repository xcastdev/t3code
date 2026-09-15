import { describe, expect, it } from "vite-plus/test";

import {
  buildDesktopAttachUrl,
  captureDesktopLaunchIntent,
  consumeDesktopLaunchIntent,
  parseDesktopLaunchIntent,
} from "./DesktopLaunchIntent.ts";

describe("DesktopLaunchIntent", () => {
  it("round-trips only the desktop attach route", () => {
    const pairingUrl = "http://127.0.0.1:4773/pair#token=owner";
    const attachUrl = buildDesktopAttachUrl(pairingUrl);
    expect(parseDesktopLaunchIntent(attachUrl)).toBe(pairingUrl);
    expect(parseDesktopLaunchIntent("t3code://other?pairingUrl=http://127.0.0.1/")).toBeNull();
    expect(parseDesktopLaunchIntent("t3code://attach-primary?unexpected=1")).toBeNull();
  });

  it("captures a pre-ready attachment once", () => {
    const pairingUrl = "http://127.0.0.1:4773/pair#token=owner";
    expect(captureDesktopLaunchIntent(buildDesktopAttachUrl(pairingUrl))).toBe(true);
    expect(consumeDesktopLaunchIntent()).toBe(pairingUrl);
    expect(consumeDesktopLaunchIntent()).toBeNull();
  });
});
