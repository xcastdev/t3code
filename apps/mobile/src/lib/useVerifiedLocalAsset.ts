import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { verificationRequiredFor } from "../connection/verified-route";
import type { AttachmentPreviewFile } from "./attachmentDownload";

type LocalAsset =
  | { readonly status: "loading" | "failed" }
  | {
      readonly status: "ready";
      readonly uri: string;
    };

export async function downloadVerifiedLocalAsset(
  url: string,
  signal: AbortSignal,
): Promise<AttachmentPreviewFile | null> {
  const remote = new URL(url);
  const fragment = remote.hash;
  remote.hash = "";
  const name = remote.pathname.split("/").at(-1) || "attachment";
  const { downloadAttachmentForPreview } = await import("./attachmentDownload");
  const file = await downloadAttachmentForPreview({
    url: remote.toString(),
    attachment: { name, mimeType: "application/octet-stream" },
    signal,
    requireVerified: true,
  });
  if (file === null) return null;
  if (signal.aborted) {
    file.dispose();
    return null;
  }
  try {
    return { ...file, uri: new URL(file.uri).href + fragment };
  } catch (error) {
    file.dispose();
    throw error;
  }
}

const idle = Atom.make<LocalAsset>({ status: "loading" });
const localAsset = Atom.family((url: string) =>
  Atom.make((get): LocalAsset => {
    const controller = new AbortController();
    let file: AttachmentPreviewFile | null = null;
    get.addFinalizer(() => {
      controller.abort();
      file?.dispose();
    });
    void downloadVerifiedLocalAsset(url, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) {
          result?.dispose();
        } else if (result === null) {
          get.setSelf({ status: "failed" });
        } else {
          file = result;
          get.setSelf({ status: "ready", uri: result.uri });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) get.setSelf({ status: "failed" });
      });
    return { status: "loading" };
  }).pipe(Atom.setIdleTTL(15_000)),
);

export function useVerifiedLocalAsset(url: string | null): LocalAsset {
  const requiresVerification = url !== null && verificationRequiredFor(url);
  const local = useAtomValue(requiresVerification ? localAsset(url) : idle);
  return !requiresVerification && url !== null ? { status: "ready", uri: url } : local;
}
