import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { useEnvironmentPresentation } from "../state/presentation";
import { useEnvironmentQuery } from "../state/query";
import { resolveMobileMarkdownMediaSource } from "../lib/markdownMediaSource";
import { requestVerifiedRoute } from "./verifiedNetwork";
import { issuedMobileAssetUrl } from "../lib/verifiedAssetUrl";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { MarkdownImageSourceResolver } from "./SelectableMarkdownText.types";
import { normalizeNativeMarkdownUrl } from "../lib/markdownLinks";
import { useCallback } from "react";
import * as Option from "effect/Option";

import { assetEnvironment } from "../state/assets";
import { environmentSession, usePreparedConnection } from "../state/session";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

async function resolveImageUri(uri: string): Promise<{ uri: string }> {
  const result = await requestVerifiedRoute(uri, {});
  if (result === null) return { uri };
  const mimeType = new Headers(result.headers).get("Content-Type")?.split(";", 1)[0]?.trim();
  if (
    result.status < 200 ||
    result.status >= 300 ||
    !mimeType ||
    !/^image\/[a-z\d.+-]+$/i.test(mimeType)
  ) {
    throw new Error("Could not load Markdown image");
  }
  return { uri: `data:${mimeType};base64,${result.bodyBase64}` };
}

export function useMarkdownImageSource(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly workspaceRoot: string | null;
  readonly captured?: boolean;
}): MarkdownImageSourceResolver {
  const { environmentId, threadId, workspaceRoot, captured } = props;
  const connection = usePreparedConnection(environmentId);
  const environment = useEnvironmentPresentation(environmentId);
  const connectionPhase = environment.presentation?.connection.phase;
  const session = useEnvironmentQuery(environmentSession.sessionStateAtom(environmentId));
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
  const httpBaseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  return useCallback(
    async (image) => {
      const media = resolveMobileMarkdownMediaSource(image.href, {
        threadId: threadId ?? undefined,
        workspaceRoot,
        imageEmbed: true,
      });
      if (media?.access === "direct") return resolveImageUri(normalizeNativeMarkdownUrl(media.uri));
      if (
        captured ||
        !fileAccess.canReadFiles ||
        media === null ||
        media.access === "unavailable" ||
        httpBaseUrl === null ||
        connectionPhase === "offline" ||
        connectionPhase === "error" ||
        connectionPhase === "unsupported" ||
        connectionPhase === "reconnecting"
      )
        throw new Error("Markdown image is unavailable");
      const result = await createUrl({ environmentId, input: { resource: media.resource } });
      if (result._tag !== "Success") throw new Error("Could not authorize Markdown image");
      const uri = issuedMobileAssetUrl(environmentId, result.value);
      if (uri === null) throw new Error("Markdown image URL is invalid");
      return resolveImageUri(uri);
    },
    [
      captured,
      fileAccess.canReadFiles,
      connectionPhase,
      createUrl,
      environmentId,
      httpBaseUrl,
      threadId,
      workspaceRoot,
    ],
  );
}
