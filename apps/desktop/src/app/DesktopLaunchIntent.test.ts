import { describe, expect, it } from "vite-plus/test";

import {
  buildDesktopAttachUrl,
  findDesktopLaunchIntentInArgv,
  parseDesktopLaunchIntent,
  stripDesktopLaunchIntentsFromArgv,
} from "./DesktopLaunchIntent.ts";

describe("DesktopLaunchIntent", () => {
  it("round-trips a loopback pairing URL and rejects lookalike intents", () => {
    const pairingUrl = "http://127.0.0.1:3773/#token=owner-token";
    const launchUrl = buildDesktopAttachUrl(pairingUrl);
    expect(parseDesktopLaunchIntent(launchUrl)).toBe(pairingUrl);
    expect(
      parseDesktopLaunchIntent("t3code://other?pairingUrl=" + encodeURIComponent(pairingUrl)),
    ).toBeNull();
    expect(
      parseDesktopLaunchIntent(
        "t3code://attach-primary?pairingUrl=" + encodeURIComponent(pairingUrl) + "&extra=1",
      ),
    ).toBeNull();
  });

  it("finds the intent among second-instance argv", () => {
    const pairingUrl = "http://localhost:3773/#token=owner-token";
    expect(
      findDesktopLaunchIntentInArgv([
        "/Applications/T3 Code.app",
        buildDesktopAttachUrl(pairingUrl),
      ]),
    ).toBe(pairingUrl);
  });

  it("strips every attach intent while preserving ordinary and OAuth arguments", () => {
    const pairingUrl = "http://localhost:3773/#token=owner-token";
    const attachUrl = buildDesktopAttachUrl(pairingUrl);
    const oauthUrl = "t3code://clerk-callback?code=oauth-code";

    expect(
      stripDesktopLaunchIntentsFromArgv([
        "--hidden-window",
        attachUrl,
        "--another-flag",
        attachUrl,
        oauthUrl,
      ]),
    ).toEqual(["--hidden-window", "--another-flag", oauthUrl]);
  });
});
