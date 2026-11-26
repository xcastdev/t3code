import type { PreviewAssetWidgetConnection } from "@t3tools/client-runtime/preview/server-browser-stream";

export function listenToWidgetFrame(
  frame: HTMLIFrameElement,
  connection: PreviewAssetWidgetConnection,
  isActivated: () => boolean,
) {
  const target = frame.contentWindow;
  const receive = (event: MessageEvent) => {
    if (target !== null && event.source === target && event.origin === "null") {
      connection.receive(event.data, isActivated());
    }
  };
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
}
