import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as NetService from "@t3tools/shared/Net";
import * as Crypto from "effect/Crypto";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopRemoteUpdates from "../updates/DesktopRemoteUpdates.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopAttachedBackend from "../backend/DesktopAttachedBackend.ts";
import { consumeDesktopLaunchIntent, subscribeDesktopLaunchIntent } from "./DesktopLaunchIntent.ts";

const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;
const DESKTOP_BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

const makeDesktopRunId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
);

export class DesktopBackendPortUnavailableError extends Schema.TaggedError<DesktopBackendPortUnavailableError>()(
  "DesktopBackendPortUnavailableError",
  {
    startPort: Schema.Int,
    maxPort: Schema.Int,
    hosts: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No desktop backend port is available on hosts ${this.hosts.join(", ")} between ${this.startPort} and ${this.maxPort}.`;
  }
}

export class DesktopDevelopmentBackendPortRequiredError extends Schema.TaggedError<DesktopDevelopmentBackendPortRequiredError>()(
  "DesktopDevelopmentBackendPortRequiredError",
  {},
) {
  override get message(): string {
    return "T3CODE_PORT is required in desktop development.";
  }
}

const { logInfo: logBootstrapInfo, logWarning: logBootstrapWarning } =
  DesktopObservability.makeComponentLogger("desktop-bootstrap");

const { logInfo: logStartupInfo, logError: logStartupError } =
  DesktopObservability.makeComponentLogger("desktop-startup");

const resolveDesktopBackendPort = Effect.fn("resolveDesktopBackendPort")(function* (
  configuredPort: Option.Option<number>,
) {
  if (Option.isSome(configuredPort)) {
    return {
      port: configuredPort.value,
      selectedByScan: false,
    } as const;
  }

  const net = yield* NetService.NetService;
  for (let port = DEFAULT_DESKTOP_BACKEND_PORT; port <= MAX_TCP_PORT; port += 1) {
    let availableOnEveryHost = true;

    for (const host of DESKTOP_BACKEND_PORT_PROBE_HOSTS) {
      if (!(yield* net.canListenOnHost(port, host))) {
        availableOnEveryHost = false;
        break;
      }
    }

    if (availableOnEveryHost) {
      return {
        port,
        selectedByScan: true,
      } as const;
    }
  }

  return yield* new DesktopBackendPortUnavailableError({
    startPort: DEFAULT_DESKTOP_BACKEND_PORT,
    maxPort: MAX_TCP_PORT,
    hosts: DESKTOP_BACKEND_PORT_PROBE_HOSTS,
  });
});

const handleFatalStartupError = Effect.fn("desktop.startup.handleFatalStartupError")(function* (
  stage: string,
  error: unknown,
): Effect.fn.Return<
  void,
  never,
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
> {
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const state = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const message = error instanceof Error ? error.message : String(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  yield* logStartupError("fatal startup error", {
    stage,
    message,
    ...(detail.length > 0 ? { detail } : {}),
  });
  const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
  if (!wasQuitting) {
    yield* electronDialog.showErrorBox(
      "T3 Code failed to start",
      `Stage: ${stage}\n${message}${detail}`,
    );
  }
  yield* shutdown.request;
  yield* electronApp.quit;
});

const fatalStartupCause = <E>(stage: string, cause: Cause.Cause<E>) =>
  handleFatalStartupError(stage, Cause.pretty(cause)).pipe(Effect.andThen(Effect.failCause(cause)));

export const stopAllPoolInstances = Effect.fn("desktop.app.stopAllPoolInstances")(
  function* (): Effect.fn.Return<void, never, DesktopBackendPool.DesktopBackendPool> {
    // Stop every backend in the pool with a timeout to guarantee the quit
    // path makes progress even if a backend hangs during teardown.
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const instances = yield* pool.list;
    yield* Effect.forEach(
      instances,
      (instance) => instance.stop({ timeout: Duration.seconds(5) }),
      { concurrency: "unbounded" },
    );
  },
);

const ATTACHED_BACKEND_RECOVERY_DIALOG = {
  type: "warning" as const,
  title: "Attached backend unavailable",
  message: "T3 Code could not connect to the attached primary backend.",
  detail: "Check that the T3 server is running, then choose Retry, Use desktop backend, or Quit.",
  buttons: ["Retry", "Use desktop backend", "Quit"],
  defaultId: 0,
  cancelId: 2,
};

/**
 * An attached server stays independently owned. Recovery can only retry its
 * credential/probe, switch the selection back to managed, or quit; it never
 * starts, stops, or otherwise supervises the attached server process.
 */
export const awaitAttachedBackend = Effect.fn("desktop.startup.awaitAttachedBackend")(
  function* (input: {
    readonly attachedBackend: DesktopAttachedBackend.DesktopAttachedBackend["Service"];
    readonly dialog: ElectronDialog.ElectronDialog["Service"];
    readonly lifecycle: DesktopLifecycle.DesktopLifecycle["Service"];
    readonly shutdown: DesktopShutdown.DesktopShutdown["Service"];
    readonly electronApp: ElectronApp.ElectronApp["Service"];
    readonly state: DesktopState.DesktopState["Service"];
    readonly pairingUrl?: string;
  }) {
    let pendingPairingUrl = input.pairingUrl;
    while (true) {
      const result = yield* Effect.exit(
        pendingPairingUrl === undefined
          ? input.attachedBackend.probe
          : input.attachedBackend
              .attach(pendingPairingUrl)
              .pipe(Effect.andThen(input.attachedBackend.probe)),
      );
      pendingPairingUrl = undefined;
      if (result._tag === "Success") return true;

      const response = yield* input.dialog.showMessageBox(ATTACHED_BACKEND_RECOVERY_DIALOG);
      if (response.response === 0) continue;
      if (response.response === 1) {
        yield* input.attachedBackend.useManagedBackend;
        yield* input.lifecycle.relaunch("attached-backend-recovery");
        return false;
      }
      yield* Ref.set(input.state.quitting, true);
      yield* input.shutdown.request;
      yield* input.electronApp.quit;
      return false;
    }
  },
);

type AttachedPrimaryRuntime = {
  readonly attachedBackend: DesktopAttachedBackend.DesktopAttachedBackend["Service"];
  readonly dialog: ElectronDialog.ElectronDialog["Service"];
  readonly lifecycle: DesktopLifecycle.DesktopLifecycle["Service"];
  readonly shutdown: DesktopShutdown.DesktopShutdown["Service"];
  readonly electronApp: ElectronApp.ElectronApp["Service"];
  readonly state: DesktopState.DesktopState["Service"];
  readonly desktopWindow: DesktopWindow.DesktopWindow["Service"];
};

const activateAttachedPrimary = Effect.fn("desktop.attachedPrimary.activate")(function* (
  input: AttachedPrimaryRuntime & {
    readonly pairingUrl?: string;
    readonly relaunchOnSuccess?: boolean;
  },
) {
  const attachedReady = yield* awaitAttachedBackend(input);
  if (!attachedReady) return;
  const attachedState = yield* input.attachedBackend.getState;
  if (attachedState.mode !== "attached") {
    return yield* new DesktopAttachedBackend.DesktopAttachedCredentialUnavailableError();
  }
  if (yield* Ref.get(input.state.quitting)) return;
  if (input.relaunchOnSuccess) {
    yield* input.lifecycle.relaunch("primary-backend-attached");
    return;
  }
  yield* input.desktopWindow.handleBackendReady(new URL(attachedState.httpBaseUrl));
});

/**
 * Processes post-start attach-primary URLs through the same serialized
 * attach/probe/recovery path as bootstrap. The subscription and worker are
 * scoped to the application lifetime, so neither survives shutdown.
 */
export const listenForAttachedPrimaryLaunchIntents = Effect.fn(
  "desktop.attachedPrimary.listenForLaunchIntents",
)(function* (input: AttachedPrimaryRuntime) {
  const intents = yield* Queue.unbounded<string>();
  const unsubscribe = subscribeDesktopLaunchIntent((pairingUrl) => {
    Effect.runSyncWith(Context.empty())(Queue.offer(intents, pairingUrl));
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  yield* Effect.forkScoped(
    Queue.take(intents).pipe(
      Effect.flatMap((pairingUrl) =>
        activateAttachedPrimary({ ...input, pairingUrl, relaunchOnSuccess: true }),
      ),
      Effect.forever,
    ),
  );
});

const bootstrap = Effect.gen(function* () {
  const state = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const attachedBackend = yield* DesktopAttachedBackend.DesktopAttachedBackend;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const electronApp = yield* ElectronApp.ElectronApp;
  const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
  const appActivation = yield* DesktopAppActivation.DesktopAppActivation;
  yield* logBootstrapInfo("bootstrap start");

  const settings = yield* desktopSettings.get;
  // The renderer is served from the bundled client (or Vite in development)
  // rather than through the local backend, so the window can open without one.
  const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
  yield* electronProtocol.registerDesktopProtocol({
    scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
    ...(environment.isDevelopment
      ? { targetOrigin: Option.getOrThrow(environment.devServerUrl) }
      : { assetDirectory: environment.clientAssetsDir }),
    clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
  });
  yield* installDesktopIpcHandlers();
  yield* logBootstrapInfo("bootstrap ipc handlers registered");

  yield* snapShot.initialize;

  // Attached backends are reached through the desktop's sole primary slot.
  // Do not start or stop a child process in this mode; the CLI server remains
  // independently owned when Electron exits.
  const launchPairingUrl = consumeDesktopLaunchIntent();
  const attachedPrimaryBackend = yield* attachedBackend.getState;
  if (launchPairingUrl !== null || attachedPrimaryBackend.mode !== "managed") {
    yield* activateAttachedPrimary({
      attachedBackend,
      dialog: electronDialog,
      lifecycle,
      shutdown,
      electronApp,
      state,
      desktopWindow,
      ...(launchPairingUrl === null ? {} : { pairingUrl: launchPairingUrl }),
    });
    return;
  }

  if (!settings.localEnvironmentEnabled) {
    yield* logBootstrapInfo("bootstrap skipping local environment (disabled in settings)");
    if (!(yield* Ref.get(state.quitting))) {
      yield* desktopWindow.createMainIfBackendReady;
    }
    return;
  }

  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const primaryBackend = yield* pool.primary;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const wslBackend = yield* DesktopWslBackend.DesktopWslBackend;

  if (environment.isDevelopment && Option.isNone(environment.configuredBackendPort)) {
    return yield* new DesktopDevelopmentBackendPortRequiredError();
  }

  const backendPortSelection = yield* resolveDesktopBackendPort(environment.configuredBackendPort);
  const backendPort = backendPortSelection.port;
  yield* logBootstrapInfo(
    backendPortSelection.selectedByScan
      ? "selected backend port via sequential scan"
      : "using configured backend port",
    {
      port: backendPort,
      ...(backendPortSelection.selectedByScan ? { startPort: DEFAULT_DESKTOP_BACKEND_PORT } : {}),
    },
  );

  if (settings.serverExposureMode !== environment.defaultDesktopSettings.serverExposureMode) {
    yield* logBootstrapInfo("bootstrap restoring persisted server exposure mode", {
      mode: settings.serverExposureMode,
    });
  }
  const serverExposureState = yield* serverExposure.configureFromSettings({
    port: backendPort,
  });
  const backendConfig = yield* serverExposure.backendConfig;
  yield* logBootstrapInfo("bootstrap resolved backend endpoint", {
    baseUrl: backendConfig.httpBaseUrl.href,
  });
  if (serverExposureState.endpointUrl) {
    yield* logBootstrapInfo("bootstrap enabled network access", {
      endpointUrl: serverExposureState.endpointUrl,
    });
  } else if (
    settings.serverExposureMode === "network-accessible" &&
    serverExposureState.mode === "local-only"
  ) {
    yield* logBootstrapWarning(
      "bootstrap fell back to local-only because no advertised network host was available",
    );
  }

  if (!(yield* Ref.get(state.quitting))) {
    // The main window waits for the primary backend. In wsl-only mode that is
    // the WSL backend, which can be slow to cold-boot — show a "Connecting to
    // WSL" splash immediately so the app feels responsive instead of presenting
    // no window until WSL is ready. (Dual mode opens fast off the Windows
    // primary, so no splash there.)
    if (settings.wslOnly === true && settings.wslBackendEnabled === true) {
      yield* desktopWindow.showConnectingSplash;
    }
    yield* primaryBackend.start;
    yield* logBootstrapInfo("bootstrap backend start requested");
    yield* appActivation.start.pipe(
      Effect.tap(() => logBootstrapInfo("desktop app control socket ready")),
      Effect.catch((error) => logStartupError("desktop app control socket unavailable", { error })),
    );
    // Bring up the WSL backend if the user previously enabled it. The
    // primary is already starting; reconcile fires off the WSL register
    // in parallel rather than blocking primary readiness on a possibly
    // slow first wsl.exe spawn.
    yield* Effect.forkScoped(wslBackend.reconcile);
  }
}).pipe(Effect.withSpan("desktop.bootstrap"));

const startup = Effect.gen(function* () {
  const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
  const electronApp = yield* ElectronApp.ElectronApp;
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  const linuxUrlHandler = yield* DesktopLinuxUrlHandler.DesktopLinuxUrlHandler;
  const clerk = yield* DesktopClerk.DesktopClerk;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const preReadyElectronOptions = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const state = yield* DesktopState.DesktopState;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const attachedBackend = yield* DesktopAttachedBackend.DesktopAttachedBackend;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const shutdown = yield* DesktopShutdown.DesktopShutdown;

  yield* shellEnvironment.installIntoProcess;
  const hasCommandLinePasswordStore =
    preReadyElectronOptions.linuxPasswordStoreCommandLine !== null;
  const linuxElectronOptions =
    environment.platform === "linux" && !hasCommandLinePasswordStore
      ? DesktopPreReadyPlatform.resolveEarlyLinuxElectronOptionsFromProcess()
      : preReadyElectronOptions.linux;
  if (linuxElectronOptions !== null && !hasCommandLinePasswordStore) {
    if (
      linuxElectronOptions.passwordStore !== null ||
      preReadyElectronOptions.linux?.passwordStore !== null
    ) {
      yield* electronApp.removeCommandLineSwitch("password-store");
    }
    if (linuxElectronOptions.passwordStore !== null) {
      yield* electronApp.appendCommandLineSwitch(
        "password-store",
        linuxElectronOptions.passwordStore,
      );
    }
  }
  const userDataPath = yield* appIdentity.resolveUserDataPath;
  yield* electronApp.setPath("userData", userDataPath);
  yield* logStartupInfo("runtime logging configured", {
    logDir: environment.logDir,
  });
  yield* desktopSettings.load;

  if (linuxElectronOptions !== null) {
    yield* logStartupInfo("linux password store configured", {
      passwordStore: hasCommandLinePasswordStore
        ? "command-line"
        : (linuxElectronOptions.passwordStore ?? "electron-default"),
      xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP ?? null,
      xdgSessionDesktop: process.env.XDG_SESSION_DESKTOP ?? null,
    });
  }

  yield* appIdentity.configure;
  yield* lifecycle.register;
  yield* clerk.configure;

  yield* electronApp.whenReady.pipe(
    Effect.withSpan("desktop.electron.whenReady"),
    Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
  );
  yield* logStartupInfo("app ready");
  if (environment.platform === "linux") {
    const selectedBackend = yield* safeStorage.selectedStorageBackend;
    yield* logStartupInfo("safe storage ready", {
      backend: Option.getOrElse(selectedBackend, () => "unknown"),
    });
  }
  yield* appIdentity.configure;
  yield* applicationMenu.configure;
  yield* updates.configure;
  yield* DesktopRemoteUpdates.listen;
  yield* linuxUrlHandler.register;
  yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
  if (!(yield* Ref.get(state.quitting))) {
    yield* listenForAttachedPrimaryLaunchIntents({
      attachedBackend,
      dialog: electronDialog,
      lifecycle,
      shutdown,
      electronApp,
      state,
      desktopWindow,
    });
  }
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
  Effect.gen(function* () {
    const runId = yield* makeDesktopRunId;
    yield* Effect.annotateLogsScoped({ scope: "desktop", runId });
    yield* Effect.annotateCurrentSpan({ scope: "desktop", runId });

    const shutdown = yield* DesktopShutdown.DesktopShutdown;

    yield* Effect.addFinalizer(() =>
      // Stop every backend in the pool, not just the primary. The
      // electronApp.quit() path can race ahead of the layer-scope
      // cascade, so leaving the WSL instance for its parent scope
      // finalizer means it gets hard-killed by the OS instead of
      // receiving SIGTERM + grace.
      stopAllPoolInstances().pipe(Effect.ensuring(shutdown.markComplete)),
    );

    yield* startup;
    yield* shutdown.awaitRequest;
  }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
