import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { requiresAdmittedAsset } from "~/assets/admittedAssetSource";
import { resolveAssetUrl } from "~/assets/assetUrls";
import { isPreviewAvailableFor, previewRuntimeFor } from "~/browser/previewRuntime";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  rememberPreviewUrl,
  setActivePreviewTab,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import {
  rightPanelHostRef,
  selectSelectedRightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";

import { resolveBrowserDefaults } from "./browserDefaults";
import { isRelayDocumentPath } from "./filePreviewOpenMode";
import {
  prepareVerifiedPreviewSource,
  readVerifiedPreviewAsset,
  verifyPreviewIssuer,
} from "./readVerifiedPreviewAsset";

export class BrowserPreviewUnavailableError extends Schema.TaggedError<BrowserPreviewUnavailableError>()(
  "BrowserPreviewUnavailableError",
  { message: Schema.String },
) {}

export class BrowserSettingsReadError extends Schema.TaggedError<BrowserSettingsReadError>()(
  "BrowserSettingsReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Saved browser settings could not be loaded.";
  }
}

export const isBrowserSettingsReadError = Schema.is(BrowserSettingsReadError);

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

export async function openUrlInPreview<E>(
  input: {
    readonly threadRef: ScopedThreadRef;
    readonly openPreview: OpenPreviewMutation<E>;
    readonly profileId?: PreviewOpenInput["profileId"];
    readonly background?: boolean;
  } & (
    | { readonly url: string; readonly verifiedAssetUrl?: never }
    | { readonly url?: never; readonly verifiedAssetUrl: string }
  ),
): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  // Read before any await: a side chat pane that unmounts meanwhile drops its host mapping.
  const threadRef = rightPanelHostRef(input.threadRef);
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserSettingsReadError({ cause }),
  );
  if (isBrowserSettingsReadError(defaults)) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const runtime =
    input.verifiedAssetUrl === undefined ? previewRuntimeFor(threadRef.environmentId) : "server";
  const previousActiveTabId = readThreadPreviewState(threadRef).activeTabId;
  // The server changes the active tab, not panel selection; selection changes come from the user.
  const selectedSurface = () =>
    selectSelectedRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id ??
    null;
  const surfaceBeforeOpen = selectedSurface();
  const result = await input.openPreview({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      ...(input.verifiedAssetUrl === undefined
        ? { url: input.url }
        : { verifiedAssetUrl: input.verifiedAssetUrl }),
      viewport: defaults.viewport,
      profileId: input.profileId ?? defaults.profileId,
      ...(runtime === undefined
        ? {}
        : { runtime, zoomFactor: defaults.zoomFactor, colorScheme: defaults.appearance }),
    },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    if (input.url !== undefined) rememberPreviewUrl(threadRef, input.url);
    if (input.background) {
      updatePreviewServerSnapshot(threadRef, snapshot);
      // Restore focus unless the user picked a tab while opening this one.
      if (
        previousActiveTabId &&
        readThreadPreviewState(threadRef).activeTabId === snapshot.tabId &&
        selectedSurface() === surfaceBeforeOpen
      ) {
        setActivePreviewTab(threadRef, previousActiveTabId);
      }
      return;
    }
    applyPreviewServerSnapshot(threadRef, snapshot);
    useRightPanelStore.getState().openBrowser(threadRef, snapshot.tabId);
  });
}

export async function openFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly requireAdmittedDocument?: boolean;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<
    AtomCommandResult<AssetCreateUrlResult & { readonly learnedRoute?: true }, AssetError>
  >;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<
  AtomCommandResult<
    void,
    AssetError | PreviewError | BrowserPreviewUnavailableError | BrowserSettingsReadError
  >
> {
  const hostRef = rightPanelHostRef(input.threadRef);
  const insideWorkspace =
    mediaFileReference(input.filePath, input.workspaceRoot).relativePath !== undefined;
  const resource = {
    _tag: insideWorkspace ? "workspace-file" : "media-file",
    threadId: input.threadRef.threadId,
    path: input.filePath,
  } as const;
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: { resource },
  });
  if (assetResult._tag === "Failure") {
    return AsyncResult.failure(assetResult.cause);
  }
  const issued = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  const kind = filePreviewKind({ name: input.filePath });
  const admitted = issued !== null && requiresAdmittedAsset(issued);
  const admittedDocument = admitted && isRelayDocumentPath(input.filePath);
  if (input.requireAdmittedDocument && !admittedDocument) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The environment did not issue a preview URL for the admitted route.",
        }),
      ),
    );
  }
  if (admitted && (kind === "audio" || kind === "video")) {
    useRightPanelStore.getState().openLocalFilePreview(hostRef, input.filePath, {
      environmentId: input.threadRef.environmentId,
      resource,
    });
    return AsyncResult.success(undefined);
  }
  if (assetResult.value.learnedRoute || admitted) {
    try {
      const environmentId = input.threadRef.environmentId;
      const issuedUrl = issued ?? assetResult.value.relativeUrl;
      const issuer = URL.parse(issuedUrl)?.origin;
      if (admittedDocument) {
        await verifyPreviewIssuer(environmentId, issuedUrl);
        useRightPanelStore.getState().openLocalFilePreview(hostRef, input.filePath, issuedUrl);
        return AsyncResult.success(undefined);
      }
      if (
        (kind === "html" || kind === "audio" || kind === "video" || kind === "image") &&
        hostRef.environmentId === environmentId &&
        previewRuntimeFor(environmentId) === "server" &&
        issuer === readThreadPreviewState(hostRef).verifiedAssetOrigin
      ) {
        await verifyPreviewIssuer(environmentId, issuedUrl);
        return openUrlInPreview<PreviewError | BrowserPreviewUnavailableError>({
          threadRef: hostRef,
          verifiedAssetUrl: issuedUrl,
          openPreview: async (request) => {
            const result = await input.openPreview(request);
            if (result._tag === "Failure" || result.value.verifiedAsset) return result;
            return AsyncResult.failure(
              Cause.fail(
                new BrowserPreviewUnavailableError({
                  message: "The server browser did not accept the verified preview.",
                }),
              ),
            );
          },
        });
      }
      const source =
        kind === "html" || kind === "pdf" || kind === "audio" || kind === "video"
          ? await prepareVerifiedPreviewSource(environmentId, issuedUrl, { html: kind === "html" })
          : await readVerifiedPreviewAsset(environmentId, issuedUrl);
      useRightPanelStore.getState().openLocalFilePreview(hostRef, input.filePath, source);
      return AsyncResult.success(undefined);
    } catch (error) {
      return AsyncResult.failure(
        Cause.fail(
          new BrowserPreviewUnavailableError({
            message:
              error instanceof Error ? error.message : "Unable to read the verified preview.",
          }),
        ),
      );
    }
  }
  if (!isPreviewAvailableFor(input.threadRef.environmentId)) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (assetUrl === null) {
    return AsyncResult.failure(
      Cause.die(new Error("The environment returned an invalid asset URL.")),
    );
  }
  return openUrlInPreview({
    threadRef: hostRef,
    url: assetUrl,
    openPreview: input.openPreview,
  });
}
