import { DesktopPrimaryBackendStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAttachedBackend from "../../backend/DesktopAttachedBackend.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getPrimaryBackendState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_PRIMARY_BACKEND_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopPrimaryBackendStateSchema,
  handler: Effect.fn("desktop.ipc.primaryBackend.getState")(function* () {
    const attachedBackend = yield* DesktopAttachedBackend.DesktopAttachedBackend;
    return yield* attachedBackend.getState;
  }),
});

export const attachPrimaryBackend = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ATTACH_PRIMARY_BACKEND_CHANNEL,
  payload: Schema.String,
  result: DesktopPrimaryBackendStateSchema,
  handler: Effect.fn("desktop.ipc.primaryBackend.attach")(function* (pairingUrl) {
    const attachedBackend = yield* DesktopAttachedBackend.DesktopAttachedBackend;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const state = yield* attachedBackend.attach(pairingUrl);
    yield* lifecycle.relaunch("primary-backend-attached");
    return state;
  }),
});

export const refreshAttachedPrimaryCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REFRESH_ATTACHED_PRIMARY_CREDENTIAL_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.primaryBackend.refreshCredential")(function* (credential) {
    const attachedBackend = yield* DesktopAttachedBackend.DesktopAttachedBackend;
    yield* attachedBackend.refreshCredential(credential);
  }),
});

export const useManagedPrimaryBackend = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.USE_MANAGED_PRIMARY_BACKEND_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.primaryBackend.useManaged")(function* () {
    const attachedBackend = yield* DesktopAttachedBackend.DesktopAttachedBackend;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* attachedBackend.useManagedBackend;
    yield* lifecycle.relaunch("primary-backend-managed");
  }),
});
