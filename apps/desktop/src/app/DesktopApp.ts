import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { DesktopPrimaryBackendState } from "@t3tools/contracts";

import * as NetService from "@t3tools/shared/Net";
import * as Crypto from "effect/Crypto";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
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
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopAttachedBackend from "../backend/DesktopAttachedBackend.ts";
import * as DesktopLaunchIntent from "./DesktopLaunchIntent.ts";

const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;
const DESKTOP_BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

const makeDesktopRunId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
);

export class DesktopBackendPortUnavailableError extends Schema.TaggedErrorClass<DesktopBackendPortUnavailableError>()(
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

export class DesktopDevelopmentBackendPortRequiredError extends Schema.TaggedErrorClass<DesktopDevelopmentBackendPortRequiredError>()(
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

const ATTACHED_BACKEND_RECOVERY_DIALOG = {
  type: "warning" as const,
  title: "Attached backend unavailable",
  message: "T3 Code could not connect to the attached primary backend.",
  detail: "Check that the T3 server is running, then choose Retry, Use desktop backend, or Quit.",
  buttons: ["Retry", "Use desktop backend", "Quit"],
  defaultId: 0,
  cancelId: 2,
};

const isAttachCredentialExchangeError = Schema.is(
  DesktopAttachedBackend.DesktopAttachCredentialExchangeError,
);
const isAttachAdministrativeScopeError = Schema.is(
  DesktopAttachedBackend.DesktopAttachAdministrativeScopeError,
);
const isAttachFreshPairingUrlRequiredError = Schema.is(
  DesktopAttachedBackend.DesktopAttachFreshPairingUrlRequiredError,
);

const attachedBackendRecoveryDialog = (error: unknown = undefined) => ({
  ...ATTACHED_BACKEND_RECOVERY_DIALOG,
  detail:
    isAttachCredentialExchangeError(error) ||
    isAttachAdministrativeScopeError(error) ||
    isAttachFreshPairingUrlRequiredError(error)
      ? "This owner pairing URL cannot be reused. Run `t3 pair --owner` for a fresh owner pairing URL, then open the new Desktop attach URL."
      : ATTACHED_BACKEND_RECOVERY_DIALOG.detail,
});

export const awaitAttachedBackend = Effect.fn("desktop.startup.awaitAttachedBackend")(
  function* (input: {
    readonly attachedBackend: DesktopAttachedBackend.DesktopAttachedBackend["Service"];
    readonly dialog: ElectronDialog.ElectronDialog["Service"];
    readonly lifecycle: DesktopLifecycle.DesktopLifecycle["Service"];
    readonly shutdown: DesktopShutdown.DesktopShutdown["Service"];
    readonly electronApp: ElectronApp.ElectronApp["Service"];
    readonly state: DesktopState.DesktopState["Service"];
    readonly pairingUrl?: string;
    readonly launchIntent?: DesktopLaunchIntent.DesktopLaunchIntent["Service"];
    readonly selectionId?: number;
    readonly onStartupSelectionSuperseded?: (
      selection: DesktopLaunchIntent.DesktopStartupSelection,
    ) => void;
  }) {
    let pendingPairingUrl = input.pairingUrl;
    let selectionId = input.selectionId;
    const takeReplacement = Effect.gen(function* () {
      if (input.launchIntent === undefined || selectionId === undefined) return false;
      const replacement = yield* input.launchIntent.claimPendingForStartup(selectionId);
      if (Option.isNone(replacement)) return false;
      if (replacement.value.pairingUrl === null) return false;
      pendingPairingUrl = replacement.value.pairingUrl;
      selectionId = replacement.value.selectionId;
      input.onStartupSelectionSuperseded?.(replacement.value);
      return true;
    });
    while (true) {
      if (yield* takeReplacement) continue;
      if (pendingPairingUrl !== undefined) {
        const attach = yield* Effect.exit(input.attachedBackend.attach(pendingPairingUrl));
        if (attach._tag === "Failure") {
          if (yield* takeReplacement) continue;
          const response = yield* input.dialog.showMessageBox(
            attachedBackendRecoveryDialog(
              Cause.findErrorOption(attach.cause).pipe(Option.getOrUndefined),
            ),
          );
          if (response.response === 0) continue;
          if (response.response === 1) {
            if (input.launchIntent !== undefined) yield* input.launchIntent.abortStartupSelection;
            yield* input.attachedBackend.useManagedBackend;
            yield* input.lifecycle.relaunch("attached-backend-recovery");
            return false;
          }
          if (input.launchIntent !== undefined) yield* input.launchIntent.abortStartupSelection;
          yield* Ref.set(input.state.quitting, true);
          yield* input.shutdown.request;
          yield* input.electronApp.quit;
          return false;
        }
        pendingPairingUrl = undefined;
      }

      const probe = yield* Effect.exit(input.attachedBackend.probe);
      if (probe._tag === "Success") {
        if (yield* takeReplacement) continue;
        return true;
      }

      if (yield* takeReplacement) continue;
      const response = yield* input.dialog.showMessageBox(ATTACHED_BACKEND_RECOVERY_DIALOG);
      if (response.response === 0) continue;
      if (response.response === 1) {
        if (input.launchIntent !== undefined) yield* input.launchIntent.abortStartupSelection;
        yield* input.attachedBackend.useManagedBackend;
        yield* input.lifecycle.relaunch("attached-backend-recovery");
        return false;
      }
      if (input.launchIntent !== undefined) yield* input.launchIntent.abortStartupSelection;
      yield* Ref.set(input.state.quitting, true);
      yield* input.shutdown.request;
      yield* input.electronApp.quit;
      return false;
    }
  },
);

type AttachedDesktopPrimaryBackendState = Extract<
  DesktopPrimaryBackendState,
  { readonly mode: "attached" }
>;

export type DesktopPrimaryBackendSelection =
  | {
      readonly _tag: "Attached";
      readonly selectionId: number;
      readonly state: AttachedDesktopPrimaryBackendState;
    }
  | { readonly _tag: "Managed"; readonly selectionId: number }
  | { readonly _tag: "Aborted" };

export const selectDesktopPrimaryBackend = Effect.fn("desktop.startup.selectDesktopPrimaryBackend")(
  function* (input: {
    readonly attachedBackend: DesktopAttachedBackend.DesktopAttachedBackend["Service"];
    readonly launchIntent: DesktopLaunchIntent.DesktopLaunchIntent["Service"];
    readonly dialog: ElectronDialog.ElectronDialog["Service"];
    readonly lifecycle: DesktopLifecycle.DesktopLifecycle["Service"];
    readonly shutdown: DesktopShutdown.DesktopShutdown["Service"];
    readonly electronApp: ElectronApp.ElectronApp["Service"];
    readonly state: DesktopState.DesktopState["Service"];
  }) {
    const startupSelection = yield* input.launchIntent.claimForStartup;
    const initialPrimaryBackendState = yield* input.attachedBackend.getState;
    let pendingPairingUrl = startupSelection.pairingUrl ?? undefined;
    let selectionId = startupSelection.selectionId;
    while (true) {
      const needsAttachedRecovery =
        pendingPairingUrl !== undefined ||
        initialPrimaryBackendState.mode === "invalid-attached" ||
        initialPrimaryBackendState.mode === "attached";

      if (needsAttachedRecovery) {
        const canContinue = yield* awaitAttachedBackend({
          attachedBackend: input.attachedBackend,
          dialog: input.dialog,
          lifecycle: input.lifecycle,
          shutdown: input.shutdown,
          electronApp: input.electronApp,
          state: input.state,
          ...(pendingPairingUrl === undefined ? {} : { pairingUrl: pendingPairingUrl }),
          launchIntent: input.launchIntent,
          selectionId,
          onStartupSelectionSuperseded: (selection) => {
            selectionId = selection.selectionId;
            pendingPairingUrl = selection.pairingUrl ?? undefined;
          },
        });
        if (!canContinue) return { _tag: "Aborted" as const };
      }

      const commit = yield* input.launchIntent.completeStartupSelection(selectionId);
      if (commit._tag === "Superseded") {
        selectionId = commit.selectionId;
        pendingPairingUrl = commit.pairingUrl;
        continue;
      }
      if (commit._tag === "Aborted") return { _tag: "Aborted" as const };

      const primaryBackendState = yield* input.attachedBackend.getState;
      return primaryBackendState.mode === "attached"
        ? { _tag: "Attached" as const, selectionId, state: primaryBackendState }
        : { _tag: "Managed" as const, selectionId };
    }
  },
);

const bootstrap = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const state = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const attachedBackend = yield* DesktopAttachedBackend.DesktopAttachedBackend;
  const launchIntent = yield* DesktopLaunchIntent.DesktopLaunchIntent;
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  const dialog = yield* ElectronDialog.ElectronDialog;
  yield* logBootstrapInfo("bootstrap start");
  while (true) {
    const primaryBackendSelection = yield* selectDesktopPrimaryBackend({
      attachedBackend,
      launchIntent,
      dialog,
      lifecycle,
      shutdown: yield* DesktopShutdown.DesktopShutdown,
      electronApp: yield* ElectronApp.ElectronApp,
      state,
    });
    if (primaryBackendSelection._tag === "Aborted") return;

    if (primaryBackendSelection._tag === "Attached") {
      const attachedState = primaryBackendSelection.state;
      const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
      const registration = {
        scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
        rendererSource:
          environment.isDevelopment && Option.isSome(environment.devServerUrl)
            ? { _tag: "Proxy" as const, origin: environment.devServerUrl.value }
            : { _tag: "Static" as const, directory: environment.bundledClientDir },
        backendOrigin: new URL(attachedState.httpBaseUrl),
        clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
      };
      const gate = yield* launchIntent.beginAttachedStartup(primaryBackendSelection.selectionId);
      if (gate._tag === "Superseded") continue;
      if (gate._tag === "Aborted") return;

      // The gate is deliberately adjacent to protocol registration. Electron
      // only permits one handler for this scheme, so an abandoned managed
      // selection must never register before an attached replacement wins.
      yield* electronProtocol.registerDesktopProtocol(registration);
      yield* installDesktopIpcHandlers();
      if (!(yield* Ref.get(state.quitting))) {
        yield* desktopWindow.handleBackendReady(new URL(attachedState.httpBaseUrl));
      }
      yield* launchIntent.activateRuntime;
      yield* logBootstrapInfo("bootstrap attached to existing backend", {
        baseUrl: attachedState.httpBaseUrl,
        environmentId: attachedState.environmentId,
      });
      return;
    }

    const settings = yield* desktopSettings.get;
    if (environment.isDevelopment && Option.isNone(environment.configuredBackendPort)) {
      return yield* new DesktopDevelopmentBackendPortRequiredError();
    }

    const backendPortSelection = yield* resolveDesktopBackendPort(
      environment.configuredBackendPort,
    );
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
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const serverExposureState = yield* serverExposure.configureFromSettings({ port: backendPort });
    const backendConfig = yield* serverExposure.backendConfig;
    const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
    const rendererTarget = environment.isDevelopment
      ? Option.getOrThrow(environment.devServerUrl)
      : backendConfig.httpBaseUrl;
    const registration = {
      scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
      targetOrigin: rendererTarget,
      backendOrigin: backendConfig.httpBaseUrl,
      clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
    };
    yield* logBootstrapInfo("bootstrap resolved backend endpoint", {
      baseUrl: backendConfig.httpBaseUrl.href,
    });
    if (serverExposureState.endpointUrl) {
      yield* logBootstrapInfo("bootstrap enabled network access", {
        endpointUrl: serverExposureState.endpointUrl,
      });
    } else if (settings.serverExposureMode === "network-accessible") {
      yield* logBootstrapWarning(
        "bootstrap fell back to local-only because no advertised network host was available",
      );
    }

    if (yield* Ref.get(state.quitting)) {
      yield* launchIntent.abortStartupSelection;
      return;
    }

    // Resolve the backend before the gate so the gate-to-start sequence has
    // no asynchronous work that could let an attachment change the mode.
    const primaryBackend = yield* pool.primary;
    if (settings.wslOnly === true && settings.wslBackendEnabled === true) {
      yield* desktopWindow.showConnectingSplash;
    }
    const gate = yield* launchIntent.beginManagedStartup(primaryBackendSelection.selectionId);
    if (gate._tag === "Superseded") continue;
    if (gate._tag === "Aborted") return;

    // Keep this call immediately after the managed gate. Attachments arriving
    // after the gate are intentionally queued for runtime handoff.
    yield* primaryBackend.start;
    yield* electronProtocol.registerDesktopProtocol(registration);
    yield* installDesktopIpcHandlers();
    yield* launchIntent.activateRuntime;
    yield* logBootstrapInfo("bootstrap backend start requested");
    // Bring up the WSL backend if the user previously enabled it. The
    // primary is already starting; reconcile fires off the WSL register
    // in parallel rather than blocking primary readiness on a possibly
    // slow first wsl.exe spawn.
    const wslBackend = yield* DesktopWslBackend.DesktopWslBackend;
    yield* Effect.forkScoped(wslBackend.reconcile);
    return;
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
  yield* logStartupInfo("runtime logging configured", { logDir: environment.logDir });
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
  yield* linuxUrlHandler.register;
  yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
  Effect.gen(function* () {
    const runId = yield* makeDesktopRunId;
    yield* Effect.annotateLogsScoped({ scope: "desktop", runId });
    yield* Effect.annotateCurrentSpan({ scope: "desktop", runId });

    const shutdown = yield* DesktopShutdown.DesktopShutdown;

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        // Stop every backend in the pool, not just the primary. The
        // electronApp.quit() path can race ahead of the layer-scope
        // cascade, so leaving the WSL instance for its parent scope
        // finalizer means it gets hard-killed by the OS instead of
        // receiving SIGTERM + grace. Stops run concurrently.
        const instances = yield* pool.list;
        yield* Effect.forEach(instances, (instance) => instance.stop(), {
          concurrency: "unbounded",
        });
      }).pipe(Effect.ensuring(shutdown.markComplete)),
    );

    yield* startup;
    yield* shutdown.awaitRequest;
  }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
