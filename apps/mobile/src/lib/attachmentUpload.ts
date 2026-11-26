import { issuedMobileTransferUrl } from "./verifiedAssetUrl";
import { requestVerifiedRoute } from "../native/verifiedNetwork";
import {
  isAssetAttachmentNotFoundFailure,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
} from "@t3tools/client-runtime/state/attachments";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ChatFileAttachment,
  ChatImageAttachment,
  EnvironmentId,
  UploadChatImageAttachment,
} from "@t3tools/contracts";
import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../state/atom-registry";
import { assetEnvironment } from "../state/assets";
import { attachmentEnvironment } from "../state/attachments";
import { environmentSession, readEnvironmentScope } from "../state/session";
import { resolveOwnedComposerAttachmentFileUri } from "./composerAttachmentFiles";
import { retainComposerAttachmentFileForPreview } from "./composerAttachmentPreviewRetention";
import {
  isComposerImageAttachment,
  isFileBackedComposerAttachment,
  type DraftComposerAttachment,
  type DraftComposerImageAttachment,
} from "./composerImages";
import { imageMimeType } from "@t3tools/shared/image";
import { uuidv4 } from "./uuid";
import {
  attachmentUploadError,
  type AttachmentUploadError,
} from "@t3tools/client-runtime/state/attachment-uploads";

export type UploadedMobileAttachment =
  | UploadChatImageAttachment
  | ChatImageAttachment
  | ChatFileAttachment;

export function withUploadedMobileAttachmentReferences(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly uploadedAttachments: ReadonlyArray<UploadedMobileAttachment>;
}): ReadonlyArray<DraftComposerAttachment> {
  return input.attachments.map((attachment, index) => {
    const uploaded = input.uploadedAttachments[index];
    // Files-picked images upload as images; compare wire types to retain uploaded ids and avoid re-uploading.
    const uploadedAs = isComposerImageAttachment(attachment) ? "image" : attachment.type;
    if (
      !uploaded ||
      !("id" in uploaded) ||
      uploadedAs !== uploaded.type ||
      (attachment.uploadedAttachmentId === uploaded.id &&
        attachment.uploadEnvironmentId === input.environmentId)
    ) {
      return attachment;
    }
    return {
      ...attachment,
      uploadedAttachmentId: uploaded.id,
      uploadEnvironmentId: input.environmentId,
    };
  });
}

export async function releasePendingAttachmentUploads(
  environmentId: EnvironmentId,
  attachmentIds: ReadonlyArray<string>,
): Promise<void> {
  const deleteOnce = async (attachmentId: string): Promise<boolean> => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      throw new Error("This connection cannot delete pending attachments.");
    }
    const result = await runAtomCommand(
      appAtomRegistry,
      attachmentEnvironment.remove,
      { environmentId, input: { attachmentId } },
      { reportFailure: false, reportDefect: false },
    );
    return (
      result._tag === "Success" ||
      isAssetAttachmentNotFoundFailure(squashAtomCommandFailure(result))
    );
  };

  const failedAttachmentIds: string[] = [];
  for (const attachmentId of attachmentIds) {
    if (!(await deleteOnce(attachmentId)) && !(await deleteOnce(attachmentId))) {
      failedAttachmentIds.push(attachmentId);
    }
  }
  if (failedAttachmentIds.length > 0) {
    throw new Error(
      `Could not delete ${failedAttachmentIds.length} pending attachment upload(s): ${failedAttachmentIds.join(", ")}.`,
    );
  }
}

export interface PreparedTurnAttachments {
  readonly status: "ready";
  readonly attachments: ReadonlyArray<UploadedMobileAttachment>;
  readonly draftAttachments: ReadonlyArray<DraftComposerAttachment>;
  readonly pendingAttachmentIds: ReadonlyArray<string>;
}

export type PrepareTurnAttachmentsResult =
  | PreparedTurnAttachments
  | { readonly status: "abandoned" };

/** Promote Files-picked images consistently in headers, payloads and references or ChatImageAttachment rejects them. */
function composerAttachmentWireMimeType(attachment: DraftComposerAttachment): string {
  if (!isComposerImageAttachment(attachment)) return attachment.mimeType;
  return supportedImageWireMimeType(attachment);
}

function supportedImageWireMimeType(
  attachment: DraftComposerAttachment,
): (typeof PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES)[number] {
  const inferred = imageMimeType(attachment);
  const mimeType = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
    (type) => type === attachment.mimeType.toLowerCase() || type === inferred,
  );
  if (!mimeType) throw new Error(`Unsupported image type for '${attachment.name}'.`);
  return mimeType;
}

function uploadedReference(
  attachment: DraftComposerAttachment,
  id: string,
): ChatImageAttachment | ChatFileAttachment {
  const fields = {
    id,
    name: attachment.name,
    mimeType: composerAttachmentWireMimeType(attachment),
    sizeBytes: attachment.sizeBytes,
  };
  return isComposerImageAttachment(attachment)
    ? { type: "image", ...fields }
    : {
        type: "file",
        ...fields,
        ...(attachment.source ? { source: attachment.source } : {}),
      };
}

function attachmentUploadInput(attachment: DraftComposerAttachment) {
  const fields = { name: attachment.name, sizeBytes: attachment.sizeBytes };
  return isComposerImageAttachment(attachment)
    ? { ...fields, mimeType: supportedImageWireMimeType(attachment) }
    : { type: "file" as const, ...fields, mimeType: attachment.mimeType };
}

async function toUploadChatImageAttachments(
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): Promise<ReadonlyArray<UploadChatImageAttachment>> {
  return Promise.all(
    attachments.map(async (attachment) => ({
      type: attachment.type,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataUrl: await composerImageAttachmentDataUrl(attachment),
    })),
  );
}

async function composerImageAttachmentDataUrl(
  attachment: DraftComposerImageAttachment,
): Promise<string> {
  if (attachment.dataUrl !== undefined) {
    return attachment.dataUrl;
  }
  if (!isFileBackedComposerAttachment(attachment)) {
    throw new Error(`'${attachment.name}' is no longer available. Attach the image again.`);
  }
  const release = retainComposerAttachmentFileForPreview(attachment);
  try {
    const { File, Paths } = await import("expo-file-system");
    const uri =
      resolveOwnedComposerAttachmentFileUri(attachment.fileUri, Paths.document.uri) ??
      attachment.fileUri;
    const base64 = await new File(uri).base64();
    return `data:${attachment.mimeType};base64,${base64}`;
  } finally {
    release();
  }
}

async function uploadFileBytes(
  environmentId: EnvironmentId,
  attachment: DraftComposerAttachment,
  url: string,
  signal: AbortSignal,
  verificationRequired: true | undefined,
  setPossiblyDispatched: (dispatched: boolean) => void,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const { File, Paths, UploadType } = await import("expo-file-system");
  if (signal.aborted) throw new Error("Upload cancelled.");
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
    throw new Error("This connection cannot upload attachments.");
  }
  const fileUri = attachment.fileUri;
  const inlineDataUrl = attachment.type === "image" ? attachment.dataUrl : undefined;
  if (fileUri === undefined && inlineDataUrl === undefined) {
    throw new Error(`'${attachment.name}' is no longer available. Attach the image again.`);
  }
  const file =
    fileUri === undefined
      ? new File(Paths.cache, `t3-upload-${uuidv4()}`)
      : new File(resolveOwnedComposerAttachmentFileUri(fileUri, Paths.document.uri) ?? fileUri);
  try {
    if (fileUri === undefined && inlineDataUrl !== undefined) {
      file.create();
      await file.write(inlineDataUrl.slice(inlineDataUrl.indexOf(",") + 1), {
        encoding: "base64",
      });
    }
    const headers = { "Content-Type": composerAttachmentWireMimeType(attachment) };
    signal.throwIfAborted();
    // The bridge can dispatch before it settles this promise.
    setPossiblyDispatched(true);
    const verified = await requestVerifiedRoute(url, {
      method: "POST",
      headers,
      signal,
      uploadFile: file.uri,
      ...(verificationRequired ? { requireVerified: true } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
    if (verified === null) {
      setPossiblyDispatched(false);
      signal.throwIfAborted();
      if (verificationRequired) throw new Error("The upload route could not be verified.");
      setPossiblyDispatched(true);
    }
    const result =
      verified ??
      (await file.upload(url, {
        httpMethod: "POST",
        uploadType: UploadType.BINARY_CONTENT,
        headers,
        signal,
        ...(onProgress
          ? {
              // Native events carry Int64 counts, which expo-modules-jsi delivers as BigInt despite the `number` type.
              onProgress: ({ bytesSent, totalBytes }) => {
                const total = Number(totalBytes);
                if (total > 0) onProgress(Number(bytesSent) / total);
              },
            }
          : {}),
      }));
    if (result.status < 200 || result.status >= 300) {
      if (result.status !== 410 && result.status < 500) {
        setPossiblyDispatched(false);
      }
      throw new Error(`Upload failed for '${attachment.name}' (${result.status}).`);
    }
  } finally {
    if (fileUri === undefined && file.exists) file.delete();
  }
}

function requireUploadAccess(environmentId: EnvironmentId): void {
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
    throw new Error("This connection cannot upload attachments.");
  }
}

export function mobileAttachmentUploadOutcomeUnknown(attachment: DraftComposerAttachment) {
  return attachmentUploadError(
    new Error(
      `Upload outcome unknown for '${attachment.name}'. Remove the attachment to continue.`,
    ),
  );
}

/** Uploads one attachment, reusing a saved id the server still has. */
export const uploadComposerAttachment = Effect.fn("uploadComposerAttachment")(function* (
  environmentId: EnvironmentId,
  attachment: DraftComposerAttachment,
  onProgress?: (progress: number) => void,
  onOutcomeUnknown?: (error: AttachmentUploadError | null) => void | Promise<void>,
  persistMintedId?: (attachmentId: string) => Promise<void>,
) {
  yield* Effect.try({
    try: () => requireUploadAccess(environmentId),
    catch: attachmentUploadError,
  });
  if (
    attachment.uploadEnvironmentId === environmentId &&
    attachment.uploadedAttachmentId !== undefined
  ) {
    const verification = yield* verifyPersistedAttachmentUpload({
      registry: appAtomRegistry,
      createAssetUrl: assetEnvironment.createUrl,
      environmentId,
      attachmentId: attachment.uploadedAttachmentId,
    });
    if (verification.status === "failed") {
      return yield* attachmentUploadError(verification.error);
    }
    if (verification.status === "verified") return attachment.uploadedAttachmentId;
  }
  yield* Effect.try({
    try: () => requireUploadAccess(environmentId),
    catch: attachmentUploadError,
  });
  if (
    Option.isNone(
      appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
    )
  ) {
    return yield* attachmentUploadError(new Error("The environment is not connected."));
  }
  let possiblyDispatched = false;
  let preparing = false;
  let reconciled = false;
  const verifyUpload = (attachmentId: string) =>
    verifyPersistedAttachmentUpload({
      registry: appAtomRegistry,
      createAssetUrl: assetEnvironment.createUrl,
      environmentId,
      attachmentId,
    });
  const removePending = (attachmentId: string) =>
    Effect.tryPromise({
      try: () => releasePendingAttachmentUploads(environmentId, [attachmentId]),
      catch: attachmentUploadError,
    }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning(
          "[attachments] could not delete abandoned pending upload",
          error.cause,
        ).pipe(Effect.as(false)),
      ),
    );
  const cleanupUnsent = Effect.fn("Attachments.cleanupUnsentUpload")(function* (
    attachmentId: string,
  ) {
    const removed = yield* removePending(attachmentId);
    if (preparing && removed && (yield* verifyUpload(attachmentId)).status === "missing") {
      yield* Effect.promise(async () => onOutcomeUnknown?.(null));
    }
  });
  const reconcile = Effect.fn("Attachments.reconcileNativeUpload")(function* (
    attachmentId: string,
  ) {
    reconciled = true;
    const unknown = mobileAttachmentUploadOutcomeUnknown(attachment);
    yield* Effect.promise(async () => onOutcomeUnknown?.(unknown));
    const verify = verifyUpload(attachmentId);
    // Delete does not revoke the signed URL or wait for the POST. Observe publication first.
    const before = yield* verify;
    const removed = yield* removePending(attachmentId);
    if (before.status === "verified" && removed && (yield* verify).status === "missing") {
      yield* Effect.promise(async () => onOutcomeUnknown?.(null));
      return null;
    }
    return unknown;
  });
  const result = yield* runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    upload: attachmentUploadInput(attachment),
    resolveUploadUrl: (issuedUrl) =>
      readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
        ? issuedMobileTransferUrl(environmentId, issuedUrl)
        : null,
    onInterrupted: (attachmentId) =>
      reconciled
        ? Effect.void
        : possiblyDispatched
          ? reconcile(attachmentId).pipe(Effect.asVoid)
          : preparing
            ? cleanupUnsent(attachmentId)
            : undefined,
    transport: Effect.fn("Attachments.transferNativeUpload")(
      function* (url, verificationRequired, attachmentId) {
        if (persistMintedId) {
          preparing = true;
          // Interruption must wait for the write so cleanup cannot get ahead of it.
          yield* Effect.tryPromise({
            try: () => persistMintedId(attachmentId),
            catch: attachmentUploadError,
          }).pipe(Effect.uninterruptible);
        }
        yield* Effect.tryPromise({
          try: (signal) =>
            uploadFileBytes(
              environmentId,
              attachment,
              url,
              signal,
              verificationRequired,
              (dispatched) => {
                possiblyDispatched = dispatched;
              },
              onProgress,
            ),
          catch: attachmentUploadError,
        }).pipe(
          Effect.catch((error) =>
            possiblyDispatched
              ? Effect.uninterruptible(
                  reconcile(attachmentId).pipe(
                    Effect.flatMap((unknown) => Effect.fail(unknown ?? error)),
                  ),
                )
              : Effect.fail(error),
          ),
        );
      },
    ),
  });
  if (result.status === "uploaded") return result.attachmentId;
  if (!reconciled && result.attachmentId !== null) {
    yield* cleanupUnsent(result.attachmentId).pipe(Effect.uninterruptible);
  }
  return yield* attachmentUploadError(
    result.step === "resolve-url" &&
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      ? new Error("This connection cannot upload attachments.")
      : result.error instanceof Error
        ? result.error
        : new Error(`Upload failed for '${attachment.name}'.`),
  );
});

/**
 * Turns a message's attachments into wire references. `uploadAttachment` is the shared upload
 * registry, so a send joins an upload the composer already started; interrupting this stops
 * waiting without cancelling that shared upload. persistUploadedReferences runs only for new
 * uploaded ids; save them to their owner so crash retries reuse bytes.
 */
export const prepareTurnAttachments = Effect.fn("prepareTurnAttachments")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly supportsImageUploads?: boolean;
  readonly uploadAttachment: (
    attachment: DraftComposerAttachment,
  ) => Effect.Effect<string, AttachmentUploadError>;
  readonly persistUploadedReferences?: (
    draftAttachments: ReadonlyArray<DraftComposerAttachment>,
  ) => Effect.Effect<"persisted" | "abandon">;
}) {
  const { environmentId } = input;
  const inlineImages = (attachments: ReadonlyArray<DraftComposerAttachment>) =>
    Effect.tryPromise({
      try: () =>
        toUploadChatImageAttachments(
          attachments.filter(
            (attachment): attachment is DraftComposerImageAttachment => attachment.type === "image",
          ),
        ),
      catch: attachmentUploadError,
    });
  const files = input.attachments.filter((attachment) => attachment.type === "file");
  if (input.attachments.length === 0 || (files.length === 0 && !input.supportsImageUploads)) {
    const imageAttachments = yield* inlineImages(input.attachments);
    return {
      status: "ready",
      attachments: imageAttachments,
      draftAttachments: input.attachments,
      pendingAttachmentIds: [],
    } satisfies PreparedTurnAttachments as PrepareTurnAttachmentsResult;
  }

  yield* Effect.try({
    try: () => requireUploadAccess(environmentId),
    catch: attachmentUploadError,
  });
  const uploadedAttachments: UploadedMobileAttachment[] = [];
  const pendingAttachmentIds: string[] = [];
  for (const attachment of input.attachments) {
    if (attachment.type === "image" && !input.supportsImageUploads) {
      uploadedAttachments.push(...(yield* inlineImages([attachment])));
      continue;
    }
    const uploadedId = yield* input.uploadAttachment(attachment);
    pendingAttachmentIds.push(uploadedId);
    uploadedAttachments.push(uploadedReference(attachment, uploadedId));
  }

  const draftAttachments = withUploadedMobileAttachmentReferences({
    environmentId,
    attachments: input.attachments,
    uploadedAttachments,
  });
  const referencesChanged = draftAttachments.some(
    (attachment, index) => attachment !== input.attachments[index],
  );
  if (
    referencesChanged &&
    input.persistUploadedReferences &&
    (yield* input.persistUploadedReferences(draftAttachments)) === "abandon"
  ) {
    return { status: "abandoned" } as PrepareTurnAttachmentsResult;
  }
  return {
    status: "ready",
    attachments: uploadedAttachments,
    draftAttachments,
    pendingAttachmentIds,
  } satisfies PreparedTurnAttachments as PrepareTurnAttachmentsResult;
});
