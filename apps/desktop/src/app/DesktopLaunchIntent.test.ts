import { describe, expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";
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
  beforeEach(() => {
    DesktopLaunchIntent.resetDesktopLaunchIntentCoordinator();
  });

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

  it("deduplicates the same open-url delivered through the early and Clerk listeners", () => {
    const pairingUrl = "http://127.0.0.1:3773/#token=owner-token";
    const launchUrl = buildDesktopAttachUrl(pairingUrl);

    expect(DesktopLaunchIntent.routeDesktopLaunchIntent(launchUrl)._tag).toBe("Pending");
    expect(DesktopLaunchIntent.routeDesktopLaunchIntent(launchUrl)._tag).toBe("Duplicate");

    const context = Effect.runSync(Effect.scoped(Layer.build(DesktopLaunchIntent.layer)));
    const launchIntent = Context.get(context, DesktopLaunchIntent.DesktopLaunchIntent);
    const claim = Effect.runSync(launchIntent.claimForStartup);
    expect(claim).toMatchObject({ pairingUrl });
    expect(Effect.runSync(launchIntent.commitStartupSelection(claim.selectionId))).toEqual({
      _tag: "Running",
    });
  });

  it("keeps startup selection synchronous while a newer second-instance URL supersedes the first", () => {
    const firstPairingUrl = "http://127.0.0.1:3773/#token=first";
    const latestPairingUrl = "http://127.0.0.1:4773/#token=latest";
    const context = Effect.runSync(Effect.scoped(Layer.build(DesktopLaunchIntent.layer)));
    const launchIntent = Context.get(context, DesktopLaunchIntent.DesktopLaunchIntent);

    expect(
      DesktopLaunchIntent.routeDesktopLaunchIntent(buildDesktopAttachUrl(firstPairingUrl))._tag,
    ).toBe("Pending");
    const claim = Effect.runSync(launchIntent.claimForStartup);
    expect(claim.pairingUrl).toBe(firstPairingUrl);

    expect(
      DesktopLaunchIntent.routeDesktopLaunchIntent(buildDesktopAttachUrl(latestPairingUrl))._tag,
    ).toBe("Pending");
    expect(Effect.runSync(launchIntent.commitStartupSelection(claim.selectionId))).toEqual({
      _tag: "Superseded",
      pairingUrl: latestPairingUrl,
      selectionId: claim.selectionId,
    });
    expect(Effect.runSync(launchIntent.commitStartupSelection(claim.selectionId))).toEqual({
      _tag: "Running",
    });
  });

  it("holds post-selection URLs until runtime activation and dispatches them once", () => {
    const pairingUrl = "http://127.0.0.1:3773/#token=owner-token";
    const runtimeAttach = vi.fn();
    const context = Effect.runSync(Effect.scoped(Layer.build(DesktopLaunchIntent.layer)));
    const launchIntent = Context.get(context, DesktopLaunchIntent.DesktopLaunchIntent);
    const claim = Effect.runSync(launchIntent.claimForStartup);
    expect(Effect.runSync(launchIntent.commitStartupSelection(claim.selectionId))).toEqual({
      _tag: "Running",
    });
    const unregister = DesktopLaunchIntent.registerDesktopRuntimeLaunchIntentHandler(runtimeAttach);

    const attachUrl = buildDesktopAttachUrl(pairingUrl);
    expect(DesktopLaunchIntent.routeDesktopLaunchIntent(attachUrl)._tag).toBe("Pending");
    expect(runtimeAttach.mock.calls).toEqual([]);
    Effect.runSync(launchIntent.activateRuntime);
    expect(runtimeAttach.mock.calls).toEqual([[pairingUrl]]);
    expect(DesktopLaunchIntent.routeDesktopLaunchIntent(attachUrl)._tag).toBe("Duplicate");
    expect(runtimeAttach.mock.calls).toEqual([[pairingUrl]]);
    expect(
      DesktopLaunchIntent.routeDesktopLaunchIntent("t3code://clerk-callback?code=oauth-code")._tag,
    ).toBe("Ignored");
    unregister();
  });

  it("aborts startup atomically so late URLs cannot be committed or drained", () => {
    const pairingUrl = "http://127.0.0.1:3773/#token=owner-token";
    const context = Effect.runSync(Effect.scoped(Layer.build(DesktopLaunchIntent.layer)));
    const launchIntent = Context.get(context, DesktopLaunchIntent.DesktopLaunchIntent);
    expect(
      DesktopLaunchIntent.routeDesktopLaunchIntent(buildDesktopAttachUrl(pairingUrl))._tag,
    ).toBe("Pending");
    const claim = Effect.runSync(launchIntent.claimForStartup);
    Effect.runSync(launchIntent.abortStartupSelection);
    expect(
      DesktopLaunchIntent.routeDesktopLaunchIntent(buildDesktopAttachUrl(pairingUrl))._tag,
    ).toBe("Ignored");
    expect(Effect.runSync(launchIntent.commitStartupSelection(claim.selectionId))).toEqual({
      _tag: "Aborted",
    });
    expect(Effect.runSync(launchIntent.consume)).toEqual(Option.none());
  });
});
