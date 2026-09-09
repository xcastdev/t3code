import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { createClerkBridgeMock, storageAdapter, storageMock } = vi.hoisted(() => ({
  createClerkBridgeMock: vi.fn(),
  storageAdapter: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  storageMock: vi.fn(),
}));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));

import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as DesktopAttachedBackend from "../backend/DesktopAttachedBackend.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLaunchIntent from "./DesktopLaunchIntent.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const makeDesktopClerkLayer = (isDevelopment = true, events: string[] = []) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment,
    appDataDirectory: "/tmp/app-data",
    userDataDirName: isDevelopment ? "t3code-dev" : "t3code",
    legacyUserDataDirName: isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)",
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopClerk.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
      ),
    ),
  );
};

const makeDesktopClerkEventContextLayer = (
  electronDialog: ElectronDialog.ElectronDialog["Service"] = {} as ElectronDialog.ElectronDialog["Service"],
  launchIntent: Layer.Layer<DesktopLaunchIntent.DesktopLaunchIntent> = DesktopLaunchIntent.layer,
) =>
  Layer.mergeAll(
    Layer.succeed(
      DesktopEnvironment.DesktopEnvironment,
      {} as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
    DesktopShutdown.layer,
    DesktopState.layer,
    Layer.succeed(DesktopWindow.DesktopWindow, {} as DesktopWindow.DesktopWindow["Service"]),
    Layer.succeed(ElectronTheme.ElectronTheme, {} as ElectronTheme.ElectronTheme["Service"]),
    Layer.succeed(ElectronDialog.ElectronDialog, electronDialog),
    launchIntent,
  );

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
    DesktopLaunchIntent.resetDesktopLaunchIntentCoordinator();
  });

  const markStartupRunning = () => {
    const selection = DesktopLaunchIntent.claimDesktopStartupSelection();
    assert.equal(
      DesktopLaunchIntent.completeDesktopStartupSelection(selection.selectionId)._tag,
      "Bootstrapping",
    );
    assert.equal(
      DesktopLaunchIntent.beginDesktopManagedStartup(selection.selectionId)._tag,
      "StartManaged",
    );
    DesktopLaunchIntent.activateDesktopRuntimeLaunchIntents();
  };

  it("derives the Clerk Frontend API hostname used by the desktop CSP", () => {
    const publishableKey = `pk_test_${btoa("clerk.t3.codes$")}`;

    assert.equal(
      DesktopClerk.resolveDesktopClerkFrontendApiHostname(publishableKey),
      "clerk.t3.codes",
    );
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname(""), undefined);
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname("invalid"), undefined);
  });

  it.effect("acquires and releases the SDK bridge with the layer", () => {
    const cleanup = vi.fn();
    const events: string[] = [];
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementation(() => {
      events.push("createClerkBridge");
      return { cleanup, isPrimaryInstance: true };
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(makeDesktopClerkLayer(true, events)));

      assert.deepEqual(createClerkBridgeMock.mock.calls, [
        [
          {
            storage: storageAdapter,
            passkeys: true,
            renderer: { scheme: "t3code-dev", host: "app" },
          },
        ],
      ]);
      assert.equal(cleanup.mock.calls.length, 1);
      // The bridge acquires Electron's single-instance lock at creation, and
      // the lock both lives in and creates the userData directory — so the
      // real path must be set before the bridge exists.
      assert.deepEqual(events, ["setPath:userData:/tmp/app-data/t3code-dev", "createClerkBridge"]);
      storageMock.mockClear();
      createClerkBridgeMock.mockClear();
    });
  });

  it.effect("preserves bridge initialization failures", () => {
    const cause = new Error("bridge initialization failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementationOnce(() => {
      throw cause;
    });

    return Effect.gen(function* () {
      const error = yield* Effect.scoped(Layer.build(makeDesktopClerkLayer())).pipe(Effect.flip);

      assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeInitializationError);
      assert.equal(error.stateDir, "/tmp/t3-state");
      assert.equal(error.isDevelopment, true);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        'Failed to initialize the desktop Clerk bridge for state directory "/tmp/t3-state" (development: true).',
      );
    });
  });

  it.effect("preserves bridge cleanup failures", () => {
    const cause = new Error("bridge cleanup failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({
      cleanup: () => {
        throw cause;
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(makeDesktopClerkLayer(false))));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeCleanupError);
        assert.equal(error.stateDir, "/tmp/t3-state");
        assert.equal(error.isDevelopment, false);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          'Failed to clean up the desktop Clerk bridge for state directory "/tmp/t3-state" (development: false).',
        );
      }
    });
  });

  it.effect("registers the second-instance handler in the primary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(quit.mock.calls.length, 0);
      assert.deepEqual(registeredEvents, ["second-instance", "open-url"]);
    }).pipe(
      Effect.provide(Layer.mergeAll(makeDesktopClerkLayer(), makeDesktopClerkEventContextLayer())),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(
        DesktopAttachedBackend.DesktopAttachedBackend,
        {} as DesktopAttachedBackend.DesktopAttachedBackend["Service"],
      ),
      Effect.provideService(
        DesktopLifecycle.DesktopLifecycle,
        {} as DesktopLifecycle.DesktopLifecycle["Service"],
      ),
    );
  });

  it.effect("quits and interrupts startup in a secondary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: false });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.equal(quit.mock.calls.length, 1);
      assert.deepEqual(registeredEvents, []);
    }).pipe(
      Effect.provide(Layer.mergeAll(makeDesktopClerkLayer(), makeDesktopClerkEventContextLayer())),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(
        DesktopAttachedBackend.DesktopAttachedBackend,
        {} as DesktopAttachedBackend.DesktopAttachedBackend["Service"],
      ),
      Effect.provideService(
        DesktopLifecycle.DesktopLifecycle,
        {} as DesktopLifecycle.DesktopLifecycle["Service"],
      ),
    );
  });

  it.effect("attaches in the existing process before requesting a sanitized relaunch", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    markStartupRunning();
    const events: string[] = [];
    const handlers = new Map<string, (...args: Array<unknown>) => void>();
    const relaunchComplete = Effect.runSync(Deferred.make<void>());
    const pairingUrl = "http://127.0.0.1:3773/pair#token=owner-token";
    const attachUrl = `t3code://attach-primary?pairingUrl=${encodeURIComponent(pairingUrl)}`;
    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: Array<unknown>) => void) =>
        Effect.sync(() => {
          handlers.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      currentMainOrFirst: Effect.succeed(Option.none()),
      reveal: () => Effect.void,
    } as unknown as ElectronWindow.ElectronWindow["Service"];
    const attachedBackend = {
      attach: (value: string) =>
        Effect.sync(() => {
          events.push(`attach:${value}`);
        }).pipe(Effect.as({ mode: "attached" as const })),
    } as unknown as DesktopAttachedBackend.DesktopAttachedBackend["Service"];
    const lifecycle = {
      relaunch: (reason: string) =>
        Effect.gen(function* () {
          events.push(`relaunch:${reason}`);
          yield* Deferred.succeed(relaunchComplete, undefined);
        }),
    } as unknown as DesktopLifecycle.DesktopLifecycle["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* clerk.configure;
          DesktopLaunchIntent.captureDesktopSecondInstanceLaunchIntent(["/desktop", attachUrl]);
          handlers.get("second-instance")?.({}, ["/desktop", attachUrl]);
          yield* Deferred.await(relaunchComplete);

          assert.deepEqual(events, [`attach:${pairingUrl}`, "relaunch:primary-backend-attached"]);
        }),
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(makeDesktopClerkLayer(), makeDesktopClerkEventContextLayer())),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopAttachedBackend.DesktopAttachedBackend, attachedBackend),
      Effect.provideService(DesktopLifecycle.DesktopLifecycle, lifecycle),
    );
  });

  it.effect("does not relaunch after a failed existing-instance attach", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    markStartupRunning();
    const relaunch = vi.fn();
    const attachAttempted = Effect.runSync(Deferred.make<void>());
    const attach = vi.fn(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(attachAttempted, undefined);
        return yield* Effect.fail({ _tag: "OwnerTokenRejected" as const });
      }),
    );
    const handlers = new Map<string, (...args: Array<unknown>) => void>();
    const pairingUrl = "http://127.0.0.1:3773/pair#token=owner-token";
    const attachUrl = `t3code://attach-primary?pairingUrl=${encodeURIComponent(pairingUrl)}`;
    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: Array<unknown>) => void) =>
        Effect.sync(() => {
          handlers.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];
    const attachedBackend = {
      attach,
    } as unknown as DesktopAttachedBackend.DesktopAttachedBackend["Service"];
    const lifecycle = {
      relaunch: (reason: string) =>
        Effect.sync(() => {
          relaunch(reason);
        }),
    } as unknown as DesktopLifecycle.DesktopLifecycle["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* clerk.configure;
          DesktopLaunchIntent.captureDesktopSecondInstanceLaunchIntent(["/desktop", attachUrl]);
          handlers.get("second-instance")?.({}, ["/desktop", attachUrl]);
          yield* Deferred.await(attachAttempted);

          assert.equal(attach.mock.calls.length, 1);
          assert.equal(relaunch.mock.calls.length, 0);
        }),
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(makeDesktopClerkLayer(), makeDesktopClerkEventContextLayer())),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopAttachedBackend.DesktopAttachedBackend, attachedBackend),
      Effect.provideService(DesktopLifecycle.DesktopLifecycle, lifecycle),
    );
  });

  it.effect(
    "reveals the current window and shows a static warning after second-instance attach fails",
    () => {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
      markStartupRunning();
      const handlers = new Map<string, (...args: Array<unknown>) => void>();
      const warningShown = Effect.runSync(Deferred.make<void>());
      const pairingUrl = "http://127.0.0.1:3773/pair#token=owner-token";
      const attachUrl = `t3code://attach-primary?pairingUrl=${encodeURIComponent(pairingUrl)}`;
      const attachAttempted = vi.fn();
      const reveal = vi.fn(() => Effect.void);
      const relaunch = vi.fn(() => Effect.die("unexpected relaunch"));
      let warningOptions: unknown;
      const electronApp = {
        quit: Effect.void,
        on: (eventName: string, listener: (...args: Array<unknown>) => void) =>
          Effect.sync(() => {
            handlers.set(eventName, listener);
          }),
      } as unknown as ElectronApp.ElectronApp["Service"];
      const electronWindow = {
        currentMainOrFirst: Effect.succeed(Option.some({})),
        reveal,
      } as unknown as ElectronWindow.ElectronWindow["Service"];
      const attachedBackend = {
        attach: vi.fn(() =>
          Effect.sync(() => {
            attachAttempted();
          }).pipe(Effect.andThen(Effect.fail({ _tag: "TestAttachFailure" }))),
        ),
      } as unknown as DesktopAttachedBackend.DesktopAttachedBackend["Service"];
      const lifecycle = { relaunch } as unknown as DesktopLifecycle.DesktopLifecycle["Service"];
      const dialog = {
        showMessageBox: (options: unknown) =>
          Effect.gen(function* () {
            warningOptions = options;
            yield* Deferred.succeed(warningShown, undefined);
            return { response: 0, checkboxChecked: false };
          }),
      } as unknown as ElectronDialog.ElectronDialog["Service"];

      return Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* clerk.configure;
            DesktopLaunchIntent.captureDesktopSecondInstanceLaunchIntent(["/desktop", attachUrl]);
            handlers.get("second-instance")?.({}, ["/desktop", attachUrl]);
            yield* Deferred.await(warningShown);

            assert.equal(attachAttempted.mock.calls.length, 1);
            assert.equal(reveal.mock.calls.length, 1);
            assert.equal(relaunch.mock.calls.length, 0);
            assert.deepEqual(warningOptions, {
              type: "warning",
              title: "Could not attach to T3 server",
              message: "T3 Code could not attach to the requested primary backend.",
              detail: "Open the desktop app and try again with a new owner pairing URL.",
              buttons: ["OK"],
            });
          }),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(makeDesktopClerkLayer(), makeDesktopClerkEventContextLayer(dialog)),
        ),
        Effect.provideService(ElectronApp.ElectronApp, electronApp),
        Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
        Effect.provideService(DesktopAttachedBackend.DesktopAttachedBackend, attachedBackend),
        Effect.provideService(DesktopLifecycle.DesktopLifecycle, lifecycle),
      );
    },
  );

  it.effect("uses the same warning recovery for a failed macOS open-url attach", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    markStartupRunning();
    const handlers = new Map<string, (...args: Array<unknown>) => void>();
    const warningShown = Effect.runSync(Deferred.make<void>());
    const pairingUrl = "http://127.0.0.1:3773/pair#token=owner-token";
    const attachUrl = `t3code://attach-primary?pairingUrl=${encodeURIComponent(pairingUrl)}`;
    const reveal = vi.fn(() => Effect.void);
    const attach = vi.fn(() => Effect.fail({ _tag: "TestAttachFailure" }));
    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: Array<unknown>) => void) =>
        Effect.sync(() => {
          handlers.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      currentMainOrFirst: Effect.succeed(Option.some({})),
      reveal,
    } as unknown as ElectronWindow.ElectronWindow["Service"];
    const attachedBackend = {
      attach,
    } as unknown as DesktopAttachedBackend.DesktopAttachedBackend["Service"];
    const lifecycle = {
      relaunch: vi.fn(() => Effect.die("unexpected relaunch")),
    } as unknown as DesktopLifecycle.DesktopLifecycle["Service"];
    const dialog = {
      showMessageBox: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(warningShown, undefined);
          return { response: 0, checkboxChecked: false };
        }),
    } as unknown as ElectronDialog.ElectronDialog["Service"];
    const preventDefault = vi.fn();

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* clerk.configure;
          assert.isTrue(DesktopLaunchIntent.capturePreReadyDesktopLaunchIntent(attachUrl));
          DesktopLaunchIntent.capturePreReadyDesktopLaunchIntent(attachUrl);
          handlers.get("open-url")?.({ preventDefault }, attachUrl);
          yield* Deferred.await(warningShown);

          assert.equal(attach.mock.calls.length, 1);
          assert.equal(reveal.mock.calls.length, 1);
          assert.equal(preventDefault.mock.calls.length, 0);
        }),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(makeDesktopClerkLayer(), makeDesktopClerkEventContextLayer(dialog)),
      ),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopAttachedBackend.DesktopAttachedBackend, attachedBackend),
      Effect.provideService(DesktopLifecycle.DesktopLifecycle, lifecycle),
    );
  });

  it.effect("captures a pre-config second-instance intent before Clerk can observe it", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const handlers = new Map<string, (...args: Array<unknown>) => void>();
    const pairingUrl = "http://127.0.0.1:3773/pair#token=owner-token";
    const attachUrl = `t3code://attach-primary?pairingUrl=${encodeURIComponent(pairingUrl)}`;
    const prebuiltContext = Effect.runSync(Effect.scoped(Layer.build(DesktopLaunchIntent.layer)));
    const launchIntent = Context.get(prebuiltContext, DesktopLaunchIntent.DesktopLaunchIntent);
    assert.isTrue(
      DesktopLaunchIntent.captureDesktopSecondInstanceLaunchIntent(["/desktop", attachUrl]),
    );

    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: Array<unknown>) => void) =>
        Effect.sync(() => {
          handlers.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];
    const attach = vi.fn(() => Effect.die("unexpected runtime attach"));
    const attachedBackend = {
      attach,
    } as unknown as DesktopAttachedBackend.DesktopAttachedBackend["Service"];
    const lifecycle = {
      relaunch: () => Effect.void,
    } as unknown as DesktopLifecycle.DesktopLifecycle["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* Effect.scoped(clerk.configure);
      handlers.get("second-instance")?.({}, ["/desktop", attachUrl]);

      assert.equal(attach.mock.calls.length, 0);
      const selection = yield* launchIntent.claimForStartup;
      assert.equal(selection.pairingUrl, pairingUrl);
      assert.isTrue(Option.isNone(yield* launchIntent.consume));
      assert.equal(
        (yield* launchIntent.completeStartupSelection(selection.selectionId))._tag,
        "Bootstrapping",
      );
      assert.equal(
        (yield* launchIntent.beginManagedStartup(selection.selectionId))._tag,
        "StartManaged",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeDesktopClerkLayer(),
          makeDesktopClerkEventContextLayer(
            undefined,
            Layer.succeed(DesktopLaunchIntent.DesktopLaunchIntent, launchIntent),
          ),
        ),
      ),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopAttachedBackend.DesktopAttachedBackend, attachedBackend),
      Effect.provideService(DesktopLifecycle.DesktopLifecycle, lifecycle),
    );
  });

  it.effect("reveals for ordinary second instances and leaves OAuth URLs untouched", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const handlers = new Map<string, (...args: Array<unknown>) => void>();
    const revealed = Effect.runSync(Deferred.make<void>());
    const attach = vi.fn(() => Effect.die("unexpected attach"));
    const relaunch = vi.fn(() => Effect.die("unexpected relaunch"));
    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: Array<unknown>) => void) =>
        Effect.sync(() => {
          handlers.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      currentMainOrFirst: Effect.succeed(Option.some("main-window")),
      reveal: () => Deferred.succeed(revealed, undefined).pipe(Effect.asVoid),
    } as unknown as ElectronWindow.ElectronWindow["Service"];
    const attachedBackend = {
      attach,
    } as unknown as DesktopAttachedBackend.DesktopAttachedBackend["Service"];
    const lifecycle = { relaunch } as unknown as DesktopLifecycle.DesktopLifecycle["Service"];
    const preventDefault = vi.fn();

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* Effect.scoped(clerk.configure);
      handlers.get("second-instance")?.({}, ["/desktop", "--ordinary"]);
      yield* Deferred.await(revealed);
      handlers.get("open-url")?.({ preventDefault }, "https://accounts.example.test/oauth");

      assert.equal(attach.mock.calls.length, 0);
      assert.equal(relaunch.mock.calls.length, 0);
      assert.equal(preventDefault.mock.calls.length, 0);
    }).pipe(
      Effect.provide(Layer.mergeAll(makeDesktopClerkLayer(), makeDesktopClerkEventContextLayer())),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopAttachedBackend.DesktopAttachedBackend, attachedBackend),
      Effect.provideService(DesktopLifecycle.DesktopLifecycle, lifecycle),
    );
  });

  it.each([
    { isDevelopment: true, scheme: "t3code-dev" },
    { isDevelopment: false, scheme: "t3code" },
  ])("configures the SDK with the $scheme renderer origin", ({ isDevelopment, scheme }) => {
    const bridge = { cleanup: vi.fn(), isPrimaryInstance: true };
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue(bridge);

    assert.equal(DesktopClerk.createDesktopClerkBridge("/tmp/t3-state", isDevelopment), bridge);
    assert.deepEqual(storageMock.mock.calls, [[{ path: "/tmp/t3-state" }]]);
    assert.deepEqual(createClerkBridgeMock.mock.calls, [
      [
        {
          storage: storageAdapter,
          passkeys: true,
          renderer: { scheme, host: "app" },
        },
      ],
    ]);
    storageMock.mockClear();
    createClerkBridgeMock.mockClear();
  });
});
