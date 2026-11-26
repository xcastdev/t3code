import { readMjpegFrames } from "@t3tools/client-runtime/device/stream";

export { readMjpegFrames };

export function attachPinnedMjpegImage(image: HTMLImageElement) {
  let active: AbortController | undefined;
  let currentUrl: string | undefined;
  const stop = () => {
    active?.abort();
    active = undefined;
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = undefined;
  };
  // The shared viewer assigns the multipart URL to this image and observes its load event.
  Object.defineProperty(image, "src", {
    set(url: string) {
      stop();
      const controller = new AbortController();
      active = controller;
      void (async () => {
        const reply = await fetch(url, { signal: controller.signal });
        if (!reply.ok || !reply.body) throw new Error("Device video refused");
        for await (const frame of readMjpegFrames(reply.body)) {
          if (controller.signal.aborted) break;
          const next = URL.createObjectURL(new Blob([frame], { type: "image/jpeg" }));
          image.setAttribute("src", next);
          if (currentUrl) URL.revokeObjectURL(currentUrl);
          currentUrl = next;
        }
      })().then(
        () => {
          if (!controller.signal.aborted) image.dispatchEvent(new Event("error"));
        },
        () => {
          if (!controller.signal.aborted) image.dispatchEvent(new Event("error"));
        },
      );
    },
  });
  return stop;
}
