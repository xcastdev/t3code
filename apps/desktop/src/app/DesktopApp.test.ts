import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as DesktopAttachedBackend from "../backend/DesktopAttachedBackend.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { awaitAttachedBackend, listenForAttachedPrimaryLaunchIntents } from "./DesktopApp.ts";
import { buildDesktopAttachUrl, captureDesktopLaunchIntent } from "./DesktopLaunchIntent.ts";

class TestAttachedFailure extends Schema.TaggedError<TestAttachedFailure>()(
  "TestAttachedFailure",
  {},
) {}

const runtimeLayer = Layer.mergeAll(
  DesktopShutdown.layer,
  DesktopState.layer,
  Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of(
      {} as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
  ),
  Layer.succeed(
    DesktopWindow.DesktopWindow,
    DesktopWindow.DesktopWindow.of({} as DesktopWindow.DesktopWindow["Service"]),
  ),
  Layer.succeed(
    ElectronApp.ElectronApp,
    ElectronApp.ElectronApp.of({} as ElectronApp.ElectronApp["Service"]),
  ),
  Layer.succeed(
    ElectronTheme.ElectronTheme,
    ElectronTheme.ElectronTheme.of({} as ElectronTheme.ElectronTheme["Service"]),
  ),
);

function makeRecoveryHarness(response: number) {
  return Effect.gen(function* () {
    const quitting = yield* Ref.make(false);
    const probe = vi.fn<() => Effect.Effect<void, TestAttachedFailure>>(() =>
      Effect.fail(new TestAttachedFailure()),
    );
    const useManagedBackend = vi.fn(() => Effect.void);
    const relaunch = vi.fn<(reason: string) => void>();
    const quit = vi.fn(() => Effect.void);
    const shutdown = vi.fn(() => Effect.void);
    return {
      probe,
      useManagedBackend,
      relaunch,
      quit,
      shutdown,
      input: {
        attachedBackend: {
          attach: () => Effect.void,
          getState: Effect.succeed({ mode: "managed" as const }),
          getBearerToken: Effect.succeed("unused"),
          probe: Effect.suspend(() => probe()),
          refreshCredential: () => Effect.void,
          useManagedBackend: Effect.suspend(() => useManagedBackend()),
        } as unknown as DesktopAttachedBackend.DesktopAttachedBackend["Service"],
        dialog: {
          showMessageBox: () => Effect.succeed({ response, checkboxChecked: false }),
        } as unknown as ElectronDialog.ElectronDialog["Service"],
        lifecycle: {
          relaunch: (reason: string) => Effect.sync(() => relaunch(reason)),
        } as unknown as DesktopLifecycle.DesktopLifecycle["Service"],
        shutdown: {
          request: Effect.suspend(() => shutdown()),
        } as unknown as DesktopShutdown.DesktopShutdown["Service"],
        electronApp: {
          quit: Effect.suspend(() => quit()),
        } as unknown as ElectronApp.ElectronApp["Service"],
        state: { quitting } as unknown as DesktopState.DesktopState["Service"],
      },
    };
  });
}

describe("DesktopApp attached startup recovery", () => {
  it.effect("retries a failed attached probe without starting a managed process", () =>
    Effect.gen(function* () {
      const harness = yield* makeRecoveryHarness(0);
      harness.probe
        .mockReturnValueOnce(Effect.fail(new TestAttachedFailure()))
        .mockReturnValueOnce(Effect.void);

      assert.isTrue(yield* awaitAttachedBackend(harness.input).pipe(Effect.provide(runtimeLayer)));
      assert.equal(harness.probe.mock.calls.length, 2);
      assert.equal(harness.useManagedBackend.mock.calls.length, 0);
      assert.equal(harness.relaunch.mock.calls.length, 0);
    }),
  );

  it.effect("uses explicit managed fallback after a failed probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeRecoveryHarness(1);

      assert.isFalse(yield* awaitAttachedBackend(harness.input).pipe(Effect.provide(runtimeLayer)));
      assert.equal(harness.probe.mock.calls.length, 1);
      assert.equal(harness.useManagedBackend.mock.calls.length, 1);
      assert.deepEqual(harness.relaunch.mock.calls, [["attached-backend-recovery"]]);
      assert.equal(harness.shutdown.mock.calls.length, 0);
      assert.equal(harness.quit.mock.calls.length, 0);
    }),
  );
});

describe("DesktopApp attached primary launch intents", () => {
  it.effect("activates an attached primary when a link arrives after bootstrap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pairingUrl = "http://127.0.0.1:3773/pair?token=owner";
        const attached = yield* Ref.make<readonly string[]>([]);
        const transition = yield* Deferred.make<"relaunch" | "window-ready">();
        const quitting = yield* Ref.make(false);

        yield* listenForAttachedPrimaryLaunchIntents({
          attachedBackend: {
            attach: (url: string) =>
              Ref.update(attached, (urls) => [...urls, url]).pipe(
                Effect.as({ mode: "attached" as const }),
              ),
            getState: Effect.succeed({
              mode: "attached" as const,
              httpBaseUrl: "http://127.0.0.1:3773",
              environmentId: "attached-environment",
              label: "Attached primary",
              bearerExpiresAt: "2026-01-01T00:00:00.000Z",
            }),
            getBearerToken: Effect.succeed("unused"),
            probe: Effect.void,
            refreshCredential: () => Effect.void,
            useManagedBackend: Effect.void,
          } as unknown as DesktopAttachedBackend.DesktopAttachedBackend["Service"],
          dialog: {} as ElectronDialog.ElectronDialog["Service"],
          lifecycle: {
            relaunch: (reason: string) =>
              reason === "primary-backend-attached"
                ? Deferred.succeed(transition, "relaunch").pipe(Effect.asVoid)
                : Effect.die(`Unexpected relaunch reason: ${reason}`),
          } as unknown as DesktopLifecycle.DesktopLifecycle["Service"],
          shutdown: {} as DesktopShutdown.DesktopShutdown["Service"],
          electronApp: {} as ElectronApp.ElectronApp["Service"],
          state: { quitting } as unknown as DesktopState.DesktopState["Service"],
          desktopWindow: {
            handleBackendReady: (url: URL) =>
              url.origin === "http://127.0.0.1:3773"
                ? Deferred.succeed(transition, "window-ready").pipe(Effect.asVoid)
                : Effect.die("Unexpected attached backend URL"),
          } as unknown as DesktopWindow.DesktopWindow["Service"],
        });

        assert.isTrue(captureDesktopLaunchIntent(buildDesktopAttachUrl(pairingUrl)));
        assert.equal(yield* Deferred.await(transition), "relaunch");
        assert.deepEqual(yield* Ref.get(attached), [pairingUrl]);
      }),
    ).pipe(Effect.provide(runtimeLayer)),
  );
});
