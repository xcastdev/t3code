import { describe, expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";
import * as DesktopLaunchIntent from "./DesktopLaunchIntent.ts";

import {
  buildDesktopAttachUrl,
  captureDesktopSecondInstanceLaunchIntent,
  capturePreReadyDesktopLaunchIntent,
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

  it("captures a second-instance attachment without consuming OAuth or ordinary argv", () => {
    const pairingUrl = "http://localhost:3773/#token=owner-token";
    const attachUrl = buildDesktopAttachUrl(pairingUrl);
    const context = Effect.runSync(Effect.scoped(Layer.build(DesktopLaunchIntent.layer)));
    const launchIntent = Context.get(context, DesktopLaunchIntent.DesktopLaunchIntent);

    expect(
      captureDesktopSecondInstanceLaunchIntent([
        "/desktop",
        "t3code://clerk-callback?code=oauth-code",
        attachUrl,
        "--ordinary-flag",
      ]),
    ).toBe(true);
    expect(Effect.runSync(launchIntent.consume)).toEqual(Option.some(pairingUrl));

    expect(
      captureDesktopSecondInstanceLaunchIntent([
        "/desktop",
        "t3code://clerk-callback?code=oauth-code",
        "--ordinary-flag",
      ]),
    ).toBe(false);
    expect(Effect.runSync(launchIntent.consume)).toEqual(Option.none());
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

  it("claims a pre-ready intent synchronously for startup selection", () => {
    const pairingUrl = "http://127.0.0.1:3773/#token=owner-token";
    const context = Effect.runSync(Effect.scoped(Layer.build(DesktopLaunchIntent.layer)));
    const launchIntent = Context.get(context, DesktopLaunchIntent.DesktopLaunchIntent);

    Effect.runSync(launchIntent.consume);
    expect(capturePreReadyDesktopLaunchIntent(buildDesktopAttachUrl(pairingUrl))).toBe(true);
    const selection = Effect.runSync(launchIntent.claimForStartup);
    expect(selection.pairingUrl).toBe(pairingUrl);
    expect(Effect.runSync(launchIntent.completeStartupSelection(selection.selectionId))).toEqual({
      _tag: "Bootstrapping",
      selectionId: selection.selectionId,
    });
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
    expect(Effect.runSync(launchIntent.completeStartupSelection(claim.selectionId))).toEqual({
      _tag: "Bootstrapping",
      selectionId: claim.selectionId,
    });
    expect(Effect.runSync(launchIntent.beginManagedStartup(claim.selectionId))).toEqual({
      _tag: "StartManaged",
      selectionId: claim.selectionId,
    });
    Effect.runSync(launchIntent.activateRuntime);
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
    const superseded = Effect.runSync(launchIntent.completeStartupSelection(claim.selectionId));
    expect(superseded).toEqual({
      _tag: "Superseded",
      pairingUrl: latestPairingUrl,
      selectionId: claim.selectionId + 1,
    });
    expect(Effect.runSync(launchIntent.completeStartupSelection(claim.selectionId))).toEqual({
      _tag: "Aborted",
    });
    expect(Effect.runSync(launchIntent.completeStartupSelection(claim.selectionId + 1))).toEqual({
      _tag: "Bootstrapping",
      selectionId: claim.selectionId + 1,
    });
    expect(Effect.runSync(launchIntent.beginManagedStartup(claim.selectionId + 1))).toEqual({
      _tag: "StartManaged",
      selectionId: claim.selectionId + 1,
    });
  });

  it("holds post-selection URLs until runtime activation and dispatches them once", () => {
    const pairingUrl = "http://127.0.0.1:3773/#token=owner-token";
    const runtimeAttach = vi.fn();
    const context = Effect.runSync(Effect.scoped(Layer.build(DesktopLaunchIntent.layer)));
    const launchIntent = Context.get(context, DesktopLaunchIntent.DesktopLaunchIntent);
    const claim = Effect.runSync(launchIntent.claimForStartup);
    expect(Effect.runSync(launchIntent.completeStartupSelection(claim.selectionId))).toEqual({
      _tag: "Bootstrapping",
      selectionId: claim.selectionId,
    });
    expect(Effect.runSync(launchIntent.beginManagedStartup(claim.selectionId))).toEqual({
      _tag: "StartManaged",
      selectionId: claim.selectionId,
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

  it("rejects a managed or attached start when a replacement arrives before the final gate", () => {
    const replacementPairingUrl = "http://127.0.0.1:4773/#token=replacement";
    const context = Effect.runSync(Effect.scoped(Layer.build(DesktopLaunchIntent.layer)));
    const launchIntent = Context.get(context, DesktopLaunchIntent.DesktopLaunchIntent);
    const selection = Effect.runSync(launchIntent.claimForStartup);

    expect(Effect.runSync(launchIntent.completeStartupSelection(selection.selectionId))).toEqual({
      _tag: "Bootstrapping",
      selectionId: selection.selectionId,
    });
    expect(
      DesktopLaunchIntent.routeDesktopLaunchIntent(buildDesktopAttachUrl(replacementPairingUrl))
        ._tag,
    ).toBe("Pending");
    expect(Effect.runSync(launchIntent.beginManagedStartup(selection.selectionId))).toEqual({
      _tag: "Superseded",
      selectionId: selection.selectionId + 1,
      pairingUrl: replacementPairingUrl,
    });
    expect(Effect.runSync(launchIntent.beginAttachedStartup(selection.selectionId))).toEqual({
      _tag: "Aborted",
    });

    expect(
      Effect.runSync(launchIntent.completeStartupSelection(selection.selectionId + 1)),
    ).toEqual({
      _tag: "Bootstrapping",
      selectionId: selection.selectionId + 1,
    });
    expect(Effect.runSync(launchIntent.beginAttachedStartup(selection.selectionId + 1))).toEqual({
      _tag: "StartAttached",
      selectionId: selection.selectionId + 1,
    });
    Effect.runSync(launchIntent.activateRuntime);
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
    expect(captureDesktopSecondInstanceLaunchIntent([buildDesktopAttachUrl(pairingUrl)])).toBe(
      true,
    );
    expect(Effect.runSync(launchIntent.completeStartupSelection(claim.selectionId))).toEqual({
      _tag: "Aborted",
    });
    expect(Effect.runSync(launchIntent.consume)).toEqual(Option.none());
  });
});
