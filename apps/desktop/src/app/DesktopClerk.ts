import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as DesktopAttachedBackend from "../backend/DesktopAttachedBackend.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import {
  findDesktopLaunchIntentInArgv,
  parseDesktopLaunchIntent,
  registerDesktopRuntimeLaunchIntentHandler,
  routeDesktopLaunchIntent,
} from "./DesktopLaunchIntent.ts";

declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;

type DesktopClerkEventHandlerServices =
  | ElectronWindow.ElectronWindow
  | ElectronDialog.ElectronDialog
  | DesktopAttachedBackend.DesktopAttachedBackend
  | DesktopLifecycle.DesktopLifecycle
  | DesktopLifecycle.DesktopLifecycleRuntimeServices;

export class DesktopClerkBridgeInitializationError extends Schema.TaggedErrorClass<DesktopClerkBridgeInitializationError>()(
  "DesktopClerkBridgeInitializationError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerkBridgeCleanupError extends Schema.TaggedErrorClass<DesktopClerkBridgeCleanupError>()(
  "DesktopClerkBridgeCleanupError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clean up the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerk extends Context.Service<
  DesktopClerk,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      ElectronApp.ElectronApp | DesktopClerkEventHandlerServices | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopClerk") {}

export function resolveDesktopClerkFrontendApiHostname(
  publishableKey: string | undefined,
): string | undefined {
  const normalizedKey = publishableKey?.trim();
  if (!normalizedKey) return undefined;

  try {
    return clerkFrontendApiHostnameFromPublishableKey(normalizedKey);
  } catch {
    return undefined;
  }
}

export const desktopClerkFrontendApiHostname = resolveDesktopClerkFrontendApiHostname(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);

const ATTACHED_BACKEND_ATTACH_FAILURE_DIALOG = {
  type: "warning" as const,
  title: "Could not attach to T3 server",
  message: "T3 Code could not attach to the requested primary backend.",
  detail: "Open the desktop app and try again with a new owner pairing URL.",
  buttons: ["OK"],
};

export function createDesktopClerkBridge(stateDir: string, isDevelopment: boolean) {
  return createClerkBridge({
    storage: storage({ path: stateDir }),
    passkeys: true,
    renderer: {
      scheme: ElectronProtocol.getDesktopScheme(isDevelopment),
      host: ElectronProtocol.DESKTOP_HOST,
    },
  });
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;

  // Electron scopes the single-instance lock to the userData directory and
  // creates that directory when the lock is acquired. The SDK bridge takes
  // the lock at creation, so userData must already point at the real
  // directory here — under the default productName-derived path, acquiring
  // the lock would create "T3 Code (Alpha)" and make the legacy-install
  // detection in resolveUserDataPath match on fresh installs.
  const userDataPath = yield* DesktopAppIdentity.resolveUserDataPath;
  yield* electronApp.setPath("userData", userDataPath);

  const bridge = yield* Effect.acquireRelease(
    Effect.try({
      try: () => createDesktopClerkBridge(environment.stateDir, environment.isDevelopment),
      catch: (cause) =>
        new DesktopClerkBridgeInitializationError({
          stateDir: environment.stateDir,
          isDevelopment: environment.isDevelopment,
          cause,
        }),
    }),
    (bridge) =>
      Effect.try({
        try: () => bridge.cleanup(),
        catch: (cause) =>
          new DesktopClerkBridgeCleanupError({
            stateDir: environment.stateDir,
            isDevelopment: environment.isDevelopment,
            cause,
          }),
      }).pipe(Effect.orDie),
  );

  return DesktopClerk.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const electronDialog = yield* ElectronDialog.ElectronDialog;
      const context = yield* Effect.context<DesktopClerkEventHandlerServices>();
      const runPromise = Effect.runPromiseWith(context);

      // The SDK bridge holds Electron's single-instance lock (acquired at
      // bridge creation) so OAuth deep-link callbacks on Windows/Linux are
      // forwarded to the running app. In a secondary instance the bridge has
      // already begun quitting the app; app.quit() is asynchronous, so stop
      // bootstrap here before whenReady can fire.
      if (!bridge.isPrimaryInstance) {
        yield* electronApp.quit;
        return yield* Effect.interrupt;
      }

      const handleAttachIntent = (pairingUrl: string) => {
        void runPromise(
          Effect.gen(function* () {
            const attachedBackend = yield* DesktopAttachedBackend.DesktopAttachedBackend;
            const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
            const attach = yield* Effect.exit(attachedBackend.attach(pairingUrl));
            if (attach._tag === "Success") {
              yield* lifecycle.relaunch("primary-backend-attached");
              return;
            }

            const mainWindow = yield* electronWindow.currentMainOrFirst.pipe(
              Effect.catchCause(() => Effect.succeed(Option.none())),
            );
            if (Option.isSome(mainWindow)) {
              yield* electronWindow
                .reveal(mainWindow.value)
                .pipe(Effect.catchCause(() => Effect.void));
            }
            yield* electronDialog
              .showMessageBox(ATTACHED_BACKEND_ATTACH_FAILURE_DIALOG)
              .pipe(Effect.catchCause(() => Effect.void));
          }).pipe(Effect.catchCause(() => Effect.void)),
        );
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => registerDesktopRuntimeLaunchIntentHandler(handleAttachIntent)),
        (unregister) => Effect.sync(unregister),
      );

      yield* electronApp.on<[unknown, unknown]>("second-instance", (_event, rawArgv) => {
        const argv = Array.isArray(rawArgv)
          ? rawArgv.filter((arg): arg is string => typeof arg === "string")
          : [];
        const pairingUrl = findDesktopLaunchIntentInArgv(argv);
        if (pairingUrl !== null) {
          const rawAttachUrl = argv.find((arg) => parseDesktopLaunchIntent(arg) === pairingUrl);
          if (rawAttachUrl !== undefined) routeDesktopLaunchIntent(rawAttachUrl);
          return;
        }
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) {
              yield* electronWindow.reveal(mainWindow.value);
            }
          }),
        );
      });

      yield* electronApp.on<[unknown, string]>("open-url", (event, url) => {
        if (parseDesktopLaunchIntent(url) === null) return;
        (event as { preventDefault?: () => void }).preventDefault?.();
        routeDesktopLaunchIntent(url);
      });
    }).pipe(Effect.withSpan("desktop.clerk.configure")),
  });
});

export const layer = Layer.effect(DesktopClerk, make);
