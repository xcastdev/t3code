import { DesktopPrimaryBackendStateSchema } from "@t3tools/contracts";
import * as DesktopAttachedBackend from "../../backend/DesktopAttachedBackend.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

export const getLocalEnvironmentEnabled = makeSyncIpcMethod({
  channel: IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.localEnvironment.getEnabled")(function* () {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    return (yield* appSettings.get).localEnvironmentEnabled;
  }),
});

export const setLocalEnvironmentEnabled = makeIpcMethod({
  channel: IpcChannels.SET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.localEnvironment.setEnabled")(function* (enabled) {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const change = yield* appSettings.setLocalEnvironmentEnabled(enabled);
    if (change.changed) {
      yield* lifecycle.relaunch(`localEnvironmentEnabled=${enabled}`);
    }
  }),
});

export const getPrimaryBackendState = makeIpcMethod({
  channel: IpcChannels.GET_PRIMARY_BACKEND_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopPrimaryBackendStateSchema,
  handler: Effect.fn("desktop.ipc.localEnvironment.getPrimaryBackendState")(function* () {
    return yield* (yield* DesktopAttachedBackend.DesktopAttachedBackend).getState;
  }),
});
export const attachPrimaryBackend = makeIpcMethod({
  channel: IpcChannels.ATTACH_PRIMARY_BACKEND_CHANNEL,
  payload: Schema.String,
  result: DesktopPrimaryBackendStateSchema,
  handler: Effect.fn("desktop.ipc.localEnvironment.attachPrimaryBackend")(function* (pairingUrl) {
    const attached = yield* DesktopAttachedBackend.DesktopAttachedBackend;
    const state = yield* attached.attach(pairingUrl);
    yield* (yield* DesktopLifecycle.DesktopLifecycle).relaunch("primaryBackend=attached");
    return state;
  }),
});
export const refreshPrimaryBackendCredential = makeIpcMethod({
  channel: IpcChannels.REFRESH_PRIMARY_BACKEND_CREDENTIAL_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.localEnvironment.refreshPrimaryBackendCredential")(
    function* (credential) {
      yield* (yield* DesktopAttachedBackend.DesktopAttachedBackend).refreshCredential(credential);
    },
  ),
});
export const useManagedPrimaryBackend = makeIpcMethod({
  channel: IpcChannels.USE_MANAGED_PRIMARY_BACKEND_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.localEnvironment.useManagedPrimaryBackend")(function* () {
    yield* (yield* DesktopAttachedBackend.DesktopAttachedBackend).useManagedBackend;
    yield* (yield* DesktopLifecycle.DesktopLifecycle).relaunch("primaryBackend=managed");
  }),
});
