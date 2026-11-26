import { dialog, type BrowserWindow, type IpcMain, type Session, type WebContents } from "electron";
import type { DesktopRelayMediaKind } from "@t3tools/contracts";
import * as IpcChannels from "../ipc/channels.ts";
import { installDesktopRelayMedia, type DesktopRelayOwner } from "./DesktopRelayMedia.ts";
import { serveDesktopRelayPort } from "./DesktopRelayPort.ts";
import { saveDesktopRelayMedia } from "./DesktopRelaySave.ts";
import type { DesktopRelayTransport } from "./DesktopRelayTransport.ts";

type Sender = { readonly sender: { readonly id: number }; readonly senderFrame?: unknown };
const unavailable = () => new Error("Desktop relay transport unavailable.");

export function installDesktopRelayIpc(
  ipc: IpcMain,
  network: Session,
  applicationUrl: string,
  getMainWindow: () => BrowserWindow | undefined,
  transport: DesktopRelayTransport,
) {
  const allowed = new URL(applicationUrl);
  const owners = new Map<WebContents, DesktopRelayOwner>();
  const active = new Map<DesktopRelayOwner, number>();
  const media =
    transport.origins.length > 0 ? installDesktopRelayMedia(network, transport) : undefined;

  function ownerFor(event: Sender): DesktopRelayOwner | undefined {
    const window = getMainWindow();
    if (window === undefined || window.isDestroyed()) return undefined;
    const contents = window.webContents;
    if (contents !== event.sender || contents.isDestroyed() || contents.session !== network)
      return undefined;
    const frame = contents.mainFrame;
    if (event.senderFrame !== frame) return undefined;
    const url = URL.parse(frame.url);
    if (
      url === null ||
      url.protocol !== allowed.protocol ||
      url.host !== allowed.host ||
      url.username ||
      url.password
    )
      return undefined;
    const registered = owners.get(contents);
    if (registered?.frame === frame) return registered;
    const controller = new AbortController();
    const owner = { contents, frame, signal: controller.signal };
    const dispose = () => {
      if (owners.get(contents) === owner) owners.delete(contents);
      contents.off("did-start-navigation", onNavigation);
      contents.off("render-process-gone", dispose);
      contents.off("destroyed", dispose);
      controller.abort();
    };
    const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) dispose();
    };
    contents.on("did-start-navigation", onNavigation);
    contents.once("render-process-gone", dispose);
    contents.once("destroyed", dispose);
    owner.signal.addEventListener("abort", () => active.delete(owner), { once: true });
    owners.set(contents, owner);
    abortOwners.signal.addEventListener("abort", dispose, { once: true, signal: owner.signal });
    return owner;
  }

  const abortOwners = new AbortController();
  let saving = false;
  ipc.on(IpcChannels.RELAY_TRANSPORT_ORIGINS_CHANNEL, (event) => {
    event.returnValue = ownerFor(event) === undefined ? [] : transport.origins;
  });
  ipc.on(IpcChannels.RELAY_TRANSPORT_OPEN_CHANNEL, (event, input: unknown) => {
    const owner = ownerFor(event);
    const [port, ...extra] = event.ports;
    const count = owner === undefined ? 0 : (active.get(owner) ?? 0);
    if (owner === undefined || port === undefined || extra.length > 0 || count >= 24) {
      for (const rejected of event.ports) {
        rejected.postMessage({ type: "error", outcomeUnknown: false }, []);
        rejected.close();
      }
      return;
    }
    active.set(owner, count + 1);
    serveDesktopRelayPort(port, transport, owner.signal, input, () => {
      const remaining = (active.get(owner) ?? 1) - 1;
      if (remaining === 0) active.delete(owner);
      else active.set(owner, remaining);
    });
  });
  ipc.handle(IpcChannels.RELAY_MEDIA_CREATE_CHANNEL, (event, url: unknown, kind: unknown) => {
    const owner = ownerFor(event);
    if (
      owner === undefined ||
      media === undefined ||
      typeof url !== "string" ||
      (kind !== "audio" && kind !== "video")
    ) {
      throw unavailable();
    }
    return media.create(owner, url, kind satisfies DesktopRelayMediaKind);
  });
  ipc.handle(IpcChannels.RELAY_MEDIA_DISPOSE_CHANNEL, (event, url: unknown) => {
    const owner = ownerFor(event);
    if (owner !== undefined && typeof url === "string") media?.dispose(owner, url);
  });
  ipc.handle(
    IpcChannels.RELAY_MEDIA_SAVE_CHANNEL,
    async (event, url: unknown, suggestedName: unknown) => {
      const owner = ownerFor(event);
      const window = getMainWindow();
      if (
        saving ||
        owner === undefined ||
        window === undefined ||
        window.webContents !== owner.contents ||
        typeof url !== "string" ||
        typeof suggestedName !== "string"
      ) {
        throw new Error("Could not save relay media.");
      }
      saving = true;
      try {
        await saveDesktopRelayMedia(transport, owner.signal, url, suggestedName, async (name) => {
          const result = await dialog.showSaveDialog(window, {
            defaultPath: name,
            properties: ["showOverwriteConfirmation"],
          });
          return result.canceled ? undefined : result.filePath;
        });
      } catch {
        throw new Error("Could not save relay media.");
      } finally {
        saving = false;
      }
    },
  );
  return {
    ownerFor,
    close() {
      abortOwners.abort();
      media?.close();
      ipc.removeAllListeners(IpcChannels.RELAY_TRANSPORT_ORIGINS_CHANNEL);
      ipc.removeAllListeners(IpcChannels.RELAY_TRANSPORT_OPEN_CHANNEL);
      ipc.removeHandler(IpcChannels.RELAY_MEDIA_CREATE_CHANNEL);
      ipc.removeHandler(IpcChannels.RELAY_MEDIA_DISPOSE_CHANNEL);
      ipc.removeHandler(IpcChannels.RELAY_MEDIA_SAVE_CHANNEL);
    },
  };
}
