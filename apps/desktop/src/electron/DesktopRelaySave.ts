// @effect-diagnostics nodeBuiltinImport:off -- Stage the native download beside the destination and publish it with one rename.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import {
  openRelayMediaDownload,
  RELAY_MEDIA_DOWNLOAD_MS,
  RELAY_MEDIA_RANGE_BYTES,
} from "@t3tools/shared/relayMediaDownload";
import { isRelayMediaTarget, parseRelayHttp } from "./DesktopRelayPolicy.ts";
import type { DesktopRelayTransport } from "./DesktopRelayTransport.ts";

const maxBytes = 16 * 1024 ** 3;
const failure = () => new Error("Could not save relay media.");

function safeSaveName(suggestedName: string) {
  const name =
    Array.from(suggestedName)
      .slice(0, 160)
      .join("")
      .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
      .trim()
      .replace(/[. ]+$/, "") || "download";
  return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) ? "_" + name : name;
}

export async function saveDesktopRelayMedia(
  transport: DesktopRelayTransport,
  ownerSignal: AbortSignal,
  url: string,
  suggestedName: string,
  pickDestination: (name: string) => Promise<string | undefined>,
): Promise<void> {
  const request = parseRelayHttp({ url, method: "GET", headers: [], body: false });
  if (
    ownerSignal.aborted ||
    request === null ||
    !isRelayMediaTarget(url) ||
    transport.getBinding(request.origin)?.transportRole !== "relay" ||
    suggestedName.length > 1_024
  )
    throw failure();

  const destination = await pickDestination(safeSaveName(suggestedName));
  if (destination === undefined) return;
  if (!NodePath.isAbsolute(destination)) throw failure();
  const cleanup = new AbortController();
  const signal = AbortSignal.any([
    ownerSignal,
    cleanup.signal,
    AbortSignal.timeout(RELAY_MEDIA_DOWNLOAD_MS),
  ]);
  signal.throwIfAborted();
  let staging: string | undefined;
  let body: ReadableStream<Uint8Array> | undefined;
  try {
    const download = await openRelayMediaDownload(
      async (headers, rangeSignal) => {
        const reply = await transport.request(
          { ...request, headers: { ...headers } },
          rangeSignal,
          undefined,
          undefined,
          RELAY_MEDIA_RANGE_BYTES,
        );
        return {
          ...reply,
          headers: new Headers(reply.headers.map(([key, value]) => [key, value])),
        };
      },
      { signal, maxBytes },
    );
    body = download.body;
    signal.throwIfAborted();
    staging = await NodeFS.promises.mkdtemp(
      NodePath.join(NodePath.dirname(destination), ".t3-save-"),
    );
    const partial = NodePath.join(staging, "download");
    await NodeStreamPromises.pipeline(
      body,
      NodeFS.createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    signal.throwIfAborted();
    await NodeFS.promises.rename(partial, destination);
  } finally {
    cleanup.abort();
    await body?.cancel().catch(() => {});
    if (staging !== undefined) await NodeFS.promises.rm(staging, { recursive: true, force: true });
  }
}
