import { describe, expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DesktopLaunchIntent from "./DesktopLaunchIntent.ts";

import {
  buildDesktopAttachUrl,
  claimDesktopLaunchIntent,
  capturePreReadyDesktopLaunchIntent,
  clearDesktopLaunchIntent,
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

  it("shares pre-ready captures with a layer created before the event", () => {
    const pairingUrl = "http://127.0.0.1:3773/#token=owner-token";
    const context = Effect.runSync(Effect.scoped(Layer.build(DesktopLaunchIntent.layer)));
    const launchIntent = Context.get(context, DesktopLaunchIntent.DesktopLaunchIntent);

    // Keep this test isolated from argv-derived state and prove the module slot
    // remains live after the service layer has already been constructed.
    Effect.runSync(launchIntent.consume);
    expect(capturePreReadyDesktopLaunchIntent(buildDesktopAttachUrl(pairingUrl))).toBe(true);

    expect(Effect.runSync(launchIntent.consume)).toEqual(Option.some(pairingUrl));
    expect(Effect.runSync(launchIntent.consume)).toEqual(Option.none());
  });

  it("claims a pre-ready intent synchronously before a later bootstrap consume", () => {
    const pairingUrl = "http://127.0.0.1:3773/#token=owner-token";
    const context = Effect.runSync(Effect.scoped(Layer.build(DesktopLaunchIntent.layer)));
    const launchIntent = Context.get(context, DesktopLaunchIntent.DesktopLaunchIntent);

    Effect.runSync(launchIntent.consume);
    expect(capturePreReadyDesktopLaunchIntent(buildDesktopAttachUrl(pairingUrl))).toBe(true);
    expect(claimDesktopLaunchIntent(pairingUrl)).toBe(true);
    expect(Effect.runSync(launchIntent.consume)).toEqual(Option.none());
    expect(claimDesktopLaunchIntent(pairingUrl)).toBe(false);
    clearDesktopLaunchIntent();
  });

  it("keeps the latest valid intent without letting invalid captures overwrite it", () => {
    const firstPairingUrl = "http://127.0.0.1:3773/#token=first";
    const latestPairingUrl = "http://127.0.0.1:4773/#token=latest";
    const context = Effect.runSync(Effect.scoped(Layer.build(DesktopLaunchIntent.layer)));
    const launchIntent = Context.get(context, DesktopLaunchIntent.DesktopLaunchIntent);

    Effect.runSync(launchIntent.consume);
    expect(capturePreReadyDesktopLaunchIntent(buildDesktopAttachUrl(firstPairingUrl))).toBe(true);
    expect(capturePreReadyDesktopLaunchIntent("t3code://clerk-callback?code=oauth-code")).toBe(
      false,
    );
    expect(capturePreReadyDesktopLaunchIntent(buildDesktopAttachUrl(latestPairingUrl))).toBe(true);

    expect(Effect.runSync(launchIntent.consume)).toEqual(Option.some(latestPairingUrl));
  });
});
