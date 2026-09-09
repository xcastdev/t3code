import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { assert, describe, it } from "@effect/vitest";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import type { DesktopPrimaryBackendState } from "@t3tools/contracts";

import * as DesktopApp from "./DesktopApp.ts";
import * as DesktopAttachedBackend from "../backend/DesktopAttachedBackend.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLaunchIntent from "./DesktopLaunchIntent.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const pairingUrl = "http://127.0.0.1:3773/pair#token=owner-token";
const primaryEnvironmentId = PRIMARY_LOCAL_ENVIRONMENT_ID as Extract<
  DesktopPrimaryBackendState,
  { readonly mode: "attached" }
>["environmentId"];
type TestAttachFailure = { readonly _tag: "TestAttachFailure" };

type RecoveryInput = {
  readonly attachedBackend: DesktopAttachedBackend.DesktopAttachedBackend["Service"];
  readonly dialog: ElectronDialog.ElectronDialog["Service"];
  readonly lifecycle: DesktopLifecycle.DesktopLifecycle["Service"];
  readonly shutdown: DesktopShutdown.DesktopShutdown["Service"];
  readonly electronApp: ElectronApp.ElectronApp["Service"];
  readonly state: DesktopState.DesktopState["Service"];
};

type RecoveryHarness = RecoveryInput & {
  readonly input: RecoveryInput;
  readonly attach: ReturnType<typeof vi.fn>;
  readonly probe: ReturnType<typeof vi.fn>;
  readonly useManagedBackend: ReturnType<typeof vi.fn>;
  readonly relaunch: ReturnType<typeof vi.fn>;
  readonly shutdownRequest: ReturnType<typeof vi.fn>;
  readonly quit: ReturnType<typeof vi.fn>;
  readonly dialogCalls: unknown[];
  readonly quitting: Ref.Ref<boolean>;
};

function makeHarness(responses: number[] = []): Effect.Effect<RecoveryHarness> {
  return Effect.gen(function* () {
    const attach = vi.fn<(url: string) => Effect.Effect<unknown, TestAttachFailure>>();
    const probe = vi.fn<() => Effect.Effect<unknown, TestAttachFailure>>();
    const useManagedBackend = vi.fn<() => Effect.Effect<void>>();
    const relaunch = vi.fn<(reason: string) => Effect.Effect<void>>();
    const shutdownRequest = vi.fn(() => Effect.void);
    const quit = vi.fn(() => Effect.void);
    const dialogCalls: unknown[] = [];
    const quitting = yield* Ref.make(false);
    useManagedBackend.mockReturnValue(Effect.void);
    relaunch.mockImplementation(() => Effect.void);

    const input: RecoveryInput = {
      attachedBackend: {
        attach,
        probe: Effect.suspend(() => probe()),
        useManagedBackend: Effect.sync(() => useManagedBackend()),
      } as unknown as DesktopAttachedBackend.DesktopAttachedBackend["Service"],
      dialog: {
        showMessageBox: (options: unknown) =>
          Effect.sync(() => {
            dialogCalls.push(options);
            return { response: responses.shift() ?? 2, checkboxChecked: false };
          }),
      } as unknown as ElectronDialog.ElectronDialog["Service"],
      lifecycle: {
        relaunch: (reason: string) => relaunch(reason),
      } as unknown as DesktopLifecycle.DesktopLifecycle["Service"],
      shutdown: {
        request: Effect.sync(() => shutdownRequest()),
      } as unknown as DesktopShutdown.DesktopShutdown["Service"],
      electronApp: {
        quit: Effect.sync(() => quit()),
      } as unknown as ElectronApp.ElectronApp["Service"],
      state: { quitting } as unknown as DesktopState.DesktopState["Service"],
    };

    return {
      input,
      ...input,
      attach,
      probe,
      useManagedBackend,
      relaunch,
      shutdownRequest,
      quit,
      dialogCalls,
      quitting,
    };
  });
}

type RecoveryError =
  | DesktopAttachedBackend.DesktopAttachedBackendError
  | ElectronDialog.ElectronDialogShowMessageBoxError;

function runRecovery<A>(
  effect: Effect.Effect<A, RecoveryError, DesktopLifecycle.DesktopLifecycleRuntimeServices>,
  input: RecoveryInput,
) {
  return effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          {} as DesktopEnvironment.DesktopEnvironment["Service"],
        ),
        Layer.succeed(DesktopShutdown.DesktopShutdown, input.shutdown),
        Layer.succeed(DesktopState.DesktopState, input.state),
        Layer.succeed(DesktopWindow.DesktopWindow, {} as DesktopWindow.DesktopWindow["Service"]),
        Layer.succeed(ElectronApp.ElectronApp, input.electronApp),
        Layer.succeed(ElectronTheme.ElectronTheme, {} as ElectronTheme.ElectronTheme["Service"]),
      ),
    ),
  );
}

describe("DesktopApp attached startup recovery", () => {
  it.effect(
    "offers fallback when the pending launch attachment fails without probing or starting managed",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness([1]);
        const managedStart = vi.fn();
        harness.attach.mockReturnValue(Effect.fail({ _tag: "TestAttachFailure" }));

        const canContinue = yield* runRecovery(
          DesktopApp.awaitAttachedBackend({ ...harness.input, pairingUrl }),
          harness.input,
        );
        if (canContinue) managedStart();

        assert.isFalse(canContinue);
        assert.equal(harness.attach.mock.calls.length, 1);
        assert.equal(harness.probe.mock.calls.length, 0);
        assert.equal(harness.useManagedBackend.mock.calls.length, 1);
        assert.deepEqual(harness.relaunch.mock.calls, [["attached-backend-recovery"]]);
        assert.equal(managedStart.mock.calls.length, 0);
        assert.deepEqual(harness.dialogCalls[0], {
          type: "warning",
          title: "Attached backend unavailable",
          message: "T3 Code could not connect to the attached primary backend.",
          detail:
            "Check that the T3 server is running, then choose Retry, Use desktop backend, or Quit.",
          buttons: ["Retry", "Use desktop backend", "Quit"],
          defaultId: 0,
          cancelId: 2,
        });
      }),
  );

  it.effect("retries a failed pending attachment and probes once after attach succeeds", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([0]);
      harness.attach
        .mockReturnValueOnce(Effect.fail({ _tag: "TestAttachFailure" }))
        .mockReturnValueOnce(Effect.succeed({ mode: "attached" as const }));
      harness.probe.mockReturnValue(Effect.succeed({}));

      const canContinue = yield* runRecovery(
        DesktopApp.awaitAttachedBackend({ ...harness.input, pairingUrl }),
        harness.input,
      );

      assert.isTrue(canContinue);
      assert.equal(harness.attach.mock.calls.length, 2);
      assert.equal(harness.probe.mock.calls.length, 1);
    }),
  );

  it.effect("probes exactly once after a successful pending attachment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.attach.mockReturnValue(Effect.succeed({ mode: "attached" as const }));
      harness.probe.mockReturnValue(Effect.succeed({}));

      const canContinue = yield* runRecovery(
        DesktopApp.awaitAttachedBackend({ ...harness.input, pairingUrl }),
        harness.input,
      );

      assert.isTrue(canContinue);
      assert.equal(harness.attach.mock.calls.length, 1);
      assert.equal(harness.probe.mock.calls.length, 1);
    }),
  );

  it.effect("retries probe only after a pending attachment succeeds", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([0]);
      harness.attach.mockReturnValue(Effect.succeed({ mode: "attached" as const }));
      harness.probe
        .mockReturnValueOnce(Effect.fail({ _tag: "TestAttachFailure" }))
        .mockReturnValueOnce(Effect.succeed({}));

      const canContinue = yield* runRecovery(
        DesktopApp.awaitAttachedBackend({ ...harness.input, pairingUrl }),
        harness.input,
      );

      assert.isTrue(canContinue);
      assert.equal(harness.attach.mock.calls.length, 1);
      assert.equal(harness.probe.mock.calls.length, 2);
    }),
  );

  it.effect("uses probe-only recovery for stored attachment state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.attach.mockImplementation(() => Effect.die("stored state must not attach"));
      harness.probe.mockReturnValue(Effect.succeed({}));

      const canContinue = yield* runRecovery(
        DesktopApp.awaitAttachedBackend(harness.input),
        harness.input,
      );

      assert.isTrue(canContinue);
      assert.equal(harness.attach.mock.calls.length, 0);
      assert.equal(harness.probe.mock.calls.length, 1);
    }),
  );

  it.effect("quits after a failed pending attachment without starting managed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([2]);
      const managedStart = vi.fn();
      harness.attach.mockReturnValue(Effect.fail({ _tag: "TestAttachFailure" }));

      const canContinue = yield* runRecovery(
        DesktopApp.awaitAttachedBackend({ ...harness.input, pairingUrl }),
        harness.input,
      );
      if (canContinue) managedStart();

      assert.isFalse(canContinue);
      assert.equal(harness.probe.mock.calls.length, 0);
      assert.equal(harness.useManagedBackend.mock.calls.length, 0);
      assert.equal(harness.relaunch.mock.calls.length, 0);
      assert.equal(harness.shutdownRequest.mock.calls.length, 1);
      assert.equal(harness.quit.mock.calls.length, 1);
      assert.isTrue(yield* Ref.get(harness.quitting));
      assert.equal(managedStart.mock.calls.length, 0);
    }),
  );

  it.effect("selects attached startup after one pending attach and one probe", () =>
    Effect.gen(function* () {
      const pairingUrl = "http://127.0.0.1:3773/pair#token=owner-token";
      const operations = {
        portScan: 0,
        exposureConfigure: 0,
        primaryStart: 0,
        wslReconcile: 0,
      };
      let state: DesktopPrimaryBackendState = { mode: "managed" };
      const attachedState = {
        mode: "attached" as const,
        httpBaseUrl: "http://127.0.0.1:3773/",
        environmentId: primaryEnvironmentId,
        label: "Workstation",
        bearerExpiresAt: "2026-10-08T12:00:00.000Z",
      } satisfies Extract<DesktopPrimaryBackendState, { readonly mode: "attached" }>;
      const attach = vi.fn(() =>
        Effect.sync(() => {
          state = attachedState;
        }),
      );
      const probe = vi.fn(() => Effect.succeed({}));
      const attachedBackend = {
        getState: Effect.sync(() => state),
        attach,
        probe: Effect.suspend(() => probe()),
        useManagedBackend: Effect.void,
      } as unknown as DesktopAttachedBackend.DesktopAttachedBackend["Service"];
      const launchIntent = DesktopLaunchIntent.DesktopLaunchIntent.of({
        capture: () => Effect.succeed(false),
        captureArgv: () => Effect.succeed(false),
        consume: Effect.succeed(Option.some(pairingUrl)),
      });
      const harness = yield* makeHarness();
      const selection = yield* runRecovery(
        DesktopApp.selectDesktopPrimaryBackend({
          ...harness.input,
          attachedBackend,
          launchIntent,
        }),
        harness.input,
      );
      if (selection._tag === "Managed") {
        operations.portScan += 1;
        operations.exposureConfigure += 1;
        operations.primaryStart += 1;
        operations.wslReconcile += 1;
      }

      assert.deepEqual(selection, {
        _tag: "Attached",
        state: attachedState,
      });
      assert.equal(attach.mock.calls.length, 1);
      assert.equal(probe.mock.calls.length, 1);
      assert.deepEqual(operations, {
        portScan: 0,
        exposureConfigure: 0,
        primaryStart: 0,
        wslReconcile: 0,
      });
    }),
  );

  it.effect("selects stored attached startup with probe-only recovery", () =>
    Effect.gen(function* () {
      const operations = {
        portScan: 0,
        exposureConfigure: 0,
        primaryStart: 0,
        wslReconcile: 0,
      };
      const storedState = {
        mode: "attached" as const,
        httpBaseUrl: "http://127.0.0.1:3773/",
        environmentId: primaryEnvironmentId,
        label: "Workstation",
        bearerExpiresAt: "2026-10-08T12:00:00.000Z",
      };
      const harness = yield* makeHarness();
      const attach = vi.fn(() => Effect.die("stored attachment must not attach"));
      const probe = vi.fn(() => Effect.succeed({}));
      const attachedBackend = {
        getState: Effect.succeed(storedState),
        attach,
        probe: Effect.suspend(() => probe()),
        useManagedBackend: Effect.void,
      } as unknown as DesktopAttachedBackend.DesktopAttachedBackend["Service"];
      const launchIntent = DesktopLaunchIntent.DesktopLaunchIntent.of({
        capture: () => Effect.succeed(false),
        captureArgv: () => Effect.succeed(false),
        consume: Effect.succeed(Option.none()),
      });

      const selection = yield* runRecovery(
        DesktopApp.selectDesktopPrimaryBackend({
          ...harness.input,
          attachedBackend,
          launchIntent,
        }),
        harness.input,
      );
      if (selection._tag === "Managed") {
        operations.portScan += 1;
        operations.exposureConfigure += 1;
        operations.primaryStart += 1;
        operations.wslReconcile += 1;
      }

      assert.deepEqual(selection, { _tag: "Attached", state: storedState });
      assert.equal(attach.mock.calls.length, 0);
      assert.equal(probe.mock.calls.length, 1);
      assert.deepEqual(operations, {
        portScan: 0,
        exposureConfigure: 0,
        primaryStart: 0,
        wslReconcile: 0,
      });
    }),
  );

  it.effect("aborts attached startup after probe failure without falling back to managed", () =>
    Effect.gen(function* () {
      const operations = {
        portScan: 0,
        exposureConfigure: 0,
        primaryStart: 0,
        wslReconcile: 0,
      };
      const storedState = {
        mode: "attached" as const,
        httpBaseUrl: "http://127.0.0.1:3773/",
        environmentId: primaryEnvironmentId,
        label: "Workstation",
        bearerExpiresAt: "2026-10-08T12:00:00.000Z",
      };
      const harness = yield* makeHarness([2]);
      const probe = vi.fn(() => Effect.fail({ _tag: "TestAttachFailure" }));
      const attachedBackend = {
        getState: Effect.succeed(storedState),
        attach: vi.fn(() => Effect.die("stored attachment must not attach")),
        probe: Effect.suspend(() => probe()),
        useManagedBackend: Effect.void,
      } as unknown as DesktopAttachedBackend.DesktopAttachedBackend["Service"];
      const launchIntent = DesktopLaunchIntent.DesktopLaunchIntent.of({
        capture: () => Effect.succeed(false),
        captureArgv: () => Effect.succeed(false),
        consume: Effect.succeed(Option.none()),
      });

      const selection = yield* runRecovery(
        DesktopApp.selectDesktopPrimaryBackend({
          ...harness.input,
          attachedBackend,
          launchIntent,
        }),
        harness.input,
      );
      if (selection._tag === "Managed") {
        operations.portScan += 1;
        operations.exposureConfigure += 1;
        operations.primaryStart += 1;
        operations.wslReconcile += 1;
      }

      assert.deepEqual(selection, { _tag: "Aborted" });
      assert.equal(probe.mock.calls.length, 1);
      assert.deepEqual(operations, {
        portScan: 0,
        exposureConfigure: 0,
        primaryStart: 0,
        wslReconcile: 0,
      });
    }),
  );
});
