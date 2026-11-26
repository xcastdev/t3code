import { EnvironmentId, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  canOperate: true,
  documentUri: "file:///documents",
  createAssetUrl: vi.fn(),
  createUploadUrl: Symbol("create-upload-url"),
  executeAtomQuery: vi.fn(),
  removeUpload: Symbol("remove-upload"),
  preparedConnection: Symbol("prepared-connection"),
  runAtomCommand: vi.fn(),
  readAtom: vi.fn(),
  upload: vi.fn(),
  verifiedUpload: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  readBase64: vi.fn(),
}));

vi.mock("expo-secure-store", () => ({ getItemAsync: async () => null }));
vi.mock("../native/verifiedNetwork", () => ({
  requestVerifiedRoute: mocks.verifiedUpload,
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => Symbol("rpc-command"),
  executeAtomQuery: mocks.executeAtomQuery,
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../state/atom-registry", () => ({
  appAtomRegistry: { get: mocks.readAtom },
}));

vi.mock("./composerAttachmentPreviewRetention", () => ({
  retainComposerAttachmentFileForPreview: () => () => {},
}));

vi.mock("../state/assets", () => ({
  assetEnvironment: { createUrl: mocks.createAssetUrl },
}));

vi.mock("../state/attachments", () => ({
  attachmentEnvironment: {
    createUploadUrl: mocks.createUploadUrl,
    remove: mocks.removeUpload,
  },
}));

vi.mock("../state/session", () => ({
  readEnvironmentScope: () => mocks.canOperate,
  environmentSession: {
    preparedConnectionValueAtom: () => mocks.preparedConnection,
  },
}));

// Cuts the expo-crypto -> react-native import chain out of the test graph.
vi.mock("./uuid", () => ({
  uuidv4: () => "uuid",
  randomHex: () => "0000",
}));

vi.mock("expo-file-system", () => ({
  File: class {
    readonly uri: string;
    exists = true;
    constructor(uri: string, name?: string) {
      this.uri = name ? `${uri}/${name}` : uri;
    }
    create() {}
    write(bytes: string, options: unknown) {
      return mocks.writeFile(this.uri, bytes, options);
    }
    delete() {
      mocks.deleteFile(this.uri);
    }

    async base64() {
      return mocks.readBase64(this.uri);
    }

    upload(url: string, options: unknown) {
      return mocks.upload(this.uri, url, options);
    }
  },
  Paths: {
    cache: "file:///cache",
    get document() {
      return { uri: mocks.documentUri };
    },
  },
  UploadType: { BINARY_CONTENT: 0 },
}));

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import {
  prepareTurnAttachments as prepareWithUploads,
  releasePendingAttachmentUploads,
  uploadComposerAttachment,
  withUploadedMobileAttachmentReferences,
} from "./attachmentUpload";

/** Uploads each attachment directly, as the shared registry does for one holder. */
function prepare(
  input: Omit<Parameters<typeof prepareWithUploads>[0], "uploadAttachment"> & {
    readonly onUploadProgress?: (attachmentId: string, progress: number) => void;
  },
) {
  return prepareWithUploads({
    ...input,
    uploadAttachment: (attachment) =>
      uploadComposerAttachment(
        input.environmentId,
        attachment,
        input.onUploadProgress
          ? (progress) => input.onUploadProgress?.(attachment.id, progress)
          : undefined,
      ),
  });
}
import type { DraftComposerAttachment } from "./composerImages";

const environmentId = EnvironmentId.make("environment-1");
const MINTED_ID = "pending-00000000-0000-4000-8000-000000000001-pdf";

const image = {
  id: "image-1",
  type: "image",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 3,
  dataUrl: "data:image/png;base64,YWJj",
  previewUri: "file:///images/screenshot.png",
} as const satisfies DraftComposerAttachment;

const fileBackedImage = {
  id: "image-2",
  type: "image",
  name: "photo.png",
  mimeType: "image/png",
  sizeBytes: 3,
  fileUri: "file:///documents/t3-composer-attachments/photo.png",
  previewUri: "file:///documents/t3-composer-attachments/photo.png",
} as const satisfies DraftComposerAttachment;

const file = {
  id: "file-1",
  type: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 42,
  fileUri: "file:///documents/report.pdf",
} as const satisfies DraftComposerAttachment;

const documentPickedImage = {
  id: "file-2",
  type: "file",
  name: "photo.png",
  mimeType: "application/octet-stream",
  sizeBytes: 3,
  fileUri: "file:///documents/photo.png",
} as const satisfies DraftComposerAttachment;

function removeCallsFor(attachmentId: string): number {
  return mocks.runAtomCommand.mock.calls.filter(
    ([, command, target]) =>
      command === mocks.removeUpload &&
      (target as { input: { attachmentId: string } }).input.attachmentId === attachmentId,
  ).length;
}

describe("prepareTurnAttachments", () => {
  beforeEach(() => {
    mocks.canOperate = true;
    mocks.documentUri = "file:///documents";
    mocks.createAssetUrl.mockReset();
    mocks.createAssetUrl.mockImplementation((target: unknown) => target);
    mocks.executeAtomQuery.mockReset();
    mocks.executeAtomQuery.mockResolvedValue({ _tag: "Success", value: {} });
    mocks.runAtomCommand.mockReset();
    mocks.readAtom.mockReset();
    mocks.upload.mockReset();
    mocks.verifiedUpload.mockReset().mockResolvedValue(null);
    mocks.writeFile.mockReset();
    mocks.deleteFile.mockReset();
    mocks.readBase64.mockReset();
    mocks.readBase64.mockResolvedValue("YWJj");
    mocks.readAtom.mockReturnValue(Option.some({ httpBaseUrl: "https://environment.example/" }));
    mocks.runAtomCommand.mockImplementation(async (_registry: unknown, command: unknown) =>
      command === mocks.createUploadUrl
        ? {
            _tag: "Success",
            value: {
              attachmentId: MINTED_ID,
              relativeUrl: "https://environment.example/api/attachments/upload/signed",
              expiresAt: 1,
            },
          }
        : { _tag: "Success", value: undefined },
    );
    mocks.upload.mockResolvedValue({ status: 204, body: "", headers: {} });
  });

  it.effect("does not mint or transfer attachments without task operation access", () =>
    Effect.gen(function* () {
      mocks.canOperate = false;
      expect(
        (yield* Effect.flip(
          prepare({
            environmentId,
            attachments: [fileBackedImage],
            supportsImageUploads: true,
          }),
        )).message,
      ).toContain("cannot upload attachments");
      expect(mocks.runAtomCommand).not.toHaveBeenCalled();
      expect(mocks.upload).not.toHaveBeenCalled();
    }),
  );

  it.effect("rechecks access after a signed URL is minted before sending any bytes", () =>
    Effect.gen(function* () {
      mocks.runAtomCommand.mockImplementationOnce(async () => {
        mocks.canOperate = false;
        return {
          _tag: "Success",
          value: {
            attachmentId: MINTED_ID,
            relativeUrl: "https://environment.example/api/attachments/upload/signed",
            expiresAt: 1,
          },
        };
      });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(
          (yield* Effect.flip(
            prepare({
              environmentId,
              attachments: [fileBackedImage],
              supportsImageUploads: true,
            }),
          )).message,
        ).toContain("cannot upload attachments");
        expect(mocks.upload).not.toHaveBeenCalled();
        expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
      } finally {
        warning.mockRestore();
      }
    }),
  );

  it.effect("does not replace an expired upload when access was revoked during verification", () =>
    Effect.gen(function* () {
      mocks.executeAtomQuery.mockImplementationOnce(async () => {
        mocks.canOperate = false;
        return { _tag: "Failure", error: { _tag: "AssetAttachmentNotFoundError" } };
      });
      expect(
        (yield* Effect.flip(
          prepare({
            environmentId,
            attachments: [
              {
                ...fileBackedImage,
                uploadedAttachmentId: MINTED_ID,
                uploadEnvironmentId: environmentId,
              },
            ],
            supportsImageUploads: true,
          }),
        )).message,
      ).toContain("cannot upload attachments");
      expect(mocks.runAtomCommand).not.toHaveBeenCalled();
      expect(mocks.upload).not.toHaveBeenCalled();
    }),
  );

  it("rechecks deletion permission before retrying a failed cleanup", async () => {
    mocks.runAtomCommand.mockImplementationOnce(async () => {
      mocks.canOperate = false;
      return { _tag: "Failure", error: new Error("Retry cleanup") };
    });
    await expect(releasePendingAttachmentUploads(environmentId, [MINTED_ID])).rejects.toThrow(
      "cannot delete pending attachments",
    );
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
  });

  it.effect("inlines a file-backed image lazily when the server lacks image uploads", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare({
        environmentId,
        attachments: [fileBackedImage],
      });

      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") return;
      expect(prepared.attachments).toEqual([
        {
          type: "image",
          name: "photo.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl: "data:image/png;base64,YWJj",
        },
      ]);
      expect(mocks.readBase64).toHaveBeenCalledExactlyOnceWith(fileBackedImage.fileUri);
      expect(mocks.upload).not.toHaveBeenCalled();
    }),
  );

  // regression: #9713 read file-backed image drafts before enabling them
  it.effect("reads restored images from the current iOS document container for legacy sends", () =>
    Effect.gen(function* () {
      const fileName = "33333333-3333-4333-8333-333333333333-photo.png";
      mocks.documentUri =
        "file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents";
      const oldUri = `file:///var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/${fileName}`;
      const prepared = yield* prepare({
        environmentId,
        attachments: [{ ...fileBackedImage, fileUri: oldUri, previewUri: oldUri }],
      });
      expect(prepared.status).toBe("ready");
      expect(mocks.readBase64).toHaveBeenCalledExactlyOnceWith(
        `${mocks.documentUri}/t3-composer-attachments/${fileName}`,
      );
    }),
  );

  // regression: #9713 read file-backed image drafts before enabling them
  it.effect("rejects a legacy image without inline bytes or a file", () =>
    Effect.gen(function* () {
      const { fileUri: _, ...missingImage } = fileBackedImage;
      expect(
        (yield* Effect.flip(prepare({ environmentId, attachments: [missingImage] }))).message,
      ).toContain("'photo.png' is no longer available. Attach the image again.");
    }),
  );

  it.effect.each(["resolve", "reject"] as const)(
    "abandons a canceled legacy image read that later %ss",
    (outcome) =>
      Effect.gen(function* () {
        const readStarted = Promise.withResolvers<void>();
        const read = Promise.withResolvers<string>();
        mocks.readBase64.mockImplementation(() => {
          readStarted.resolve();
          return read.promise;
        });
        const preparing = yield* Effect.forkChild(
          prepare({ environmentId, attachments: [fileBackedImage] }),
        );
        yield* Effect.promise(() => readStarted.promise);
        yield* Fiber.interrupt(preparing);
        if (outcome === "resolve") read.resolve("YWJj");
        else read.reject(new Error("Native read failed after cancellation"));

        expect(Exit.hasInterrupts(yield* Fiber.await(preparing))).toBe(true);
      }),
  );

  // regression: #9713 read file-backed image drafts before enabling them
  it.effect("uploads a file-backed image from its owned copy without staging base64", () =>
    Effect.gen(function* () {
      mocks.upload.mockImplementation(
        async (
          _uri: string,
          _url: string,
          options: { onProgress?: (event: { bytesSent: unknown; totalBytes: unknown }) => void },
        ) => {
          // expo-modules-jsi delivers native Int64 progress counts as BigInt.
          options.onProgress?.({ bytesSent: BigInt(1), totalBytes: BigInt(4) });
          return { status: 204, body: "", headers: {} };
        },
      );
      const progress: Array<number> = [];
      const prepared = yield* prepare({
        environmentId,
        attachments: [fileBackedImage],
        supportsImageUploads: true,
        onUploadProgress: (_, value) => progress.push(value),
      });

      expect(progress).toEqual([0.25]);

      expect(mocks.upload).toHaveBeenCalledWith(
        fileBackedImage.fileUri,
        "https://environment.example/api/attachments/upload/signed",
        expect.objectContaining({ headers: { "Content-Type": "image/png" } }),
      );
      expect(mocks.readBase64).not.toHaveBeenCalled();
      expect(mocks.writeFile).not.toHaveBeenCalled();
      expect(mocks.deleteFile).not.toHaveBeenCalled();
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") return;
      expect(prepared.attachments).toEqual([
        {
          type: "image",
          id: MINTED_ID,
          name: "photo.png",
          mimeType: "image/png",
          sizeBytes: 3,
        },
      ]);
    }),
  );

  it.effect("sends a document-picked picture with the mime it was uploaded under", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare({
        environmentId,
        attachments: [documentPickedImage],
      });

      expect(mocks.upload).toHaveBeenCalledWith(
        "file:///documents/photo.png",
        "https://environment.example/api/attachments/upload/signed",
        expect.objectContaining({ headers: { "Content-Type": "image/png" } }),
      );
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") return;
      expect(prepared.attachments[0]).toEqual({
        type: "image",
        id: MINTED_ID,
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 3,
      });
    }),
  );

  it.effect("uploads an oversized document-picked image as a file", () =>
    Effect.gen(function* () {
      const largeImage = {
        ...documentPickedImage,
        mimeType: "image/png",
        sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
      };
      const prepared = yield* prepare({ environmentId, attachments: [largeImage] });

      expect(mocks.runAtomCommand).toHaveBeenCalledWith(
        expect.anything(),
        mocks.createUploadUrl,
        expect.objectContaining({
          input: {
            type: "file",
            name: largeImage.name,
            mimeType: "image/png",
            sizeBytes: largeImage.sizeBytes,
          },
        }),
        expect.anything(),
      );
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") return;
      expect(prepared.attachments).toEqual([
        {
          type: "file",
          id: MINTED_ID,
          name: largeImage.name,
          mimeType: "image/png",
          sizeBytes: largeImage.sizeBytes,
        },
      ]);
      expect(mocks.readBase64).not.toHaveBeenCalled();
    }),
  );

  it.effect("uploads generic file bytes directly and keeps mixed attachment order", () =>
    Effect.gen(function* () {
      const pastedFile = {
        ...file,
        source: { _tag: "pasted-text" as const },
      };
      const prepared = yield* prepare({
        environmentId,
        attachments: [pastedFile, image],
      });

      expect(mocks.upload).toHaveBeenCalledWith(
        "file:///documents/report.pdf",
        "https://environment.example/api/attachments/upload/signed",
        expect.objectContaining({
          httpMethod: "POST",
          uploadType: 0,
          headers: { "Content-Type": "application/pdf" },
        }),
      );
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") return;
      expect(prepared.attachments[0]).toEqual({
        type: "file",
        id: MINTED_ID,
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        source: { _tag: "pasted-text" },
      });
      expect(prepared.attachments[1]?.type).toBe("image");
      expect(prepared.pendingAttachmentIds).toEqual([MINTED_ID]);
      expect(prepared.draftAttachments[0]).toEqual({
        ...pastedFile,
        uploadedAttachmentId: MINTED_ID,
        uploadEnvironmentId: environmentId,
      });
    }),
  );

  it.effect("keeps the issuer when an environment reconnects during URL creation", () =>
    Effect.gen(function* () {
      mocks.readAtom.mockReturnValue(
        Option.some({ httpBaseUrl: "https://old-environment.example/" }),
      );
      mocks.runAtomCommand.mockImplementationOnce(async () => {
        mocks.readAtom.mockReturnValue(
          Option.some({ httpBaseUrl: "https://new-environment.example/" }),
        );
        return {
          _tag: "Success",
          value: {
            attachmentId: MINTED_ID,
            relativeUrl: "https://old-environment.example/api/attachments/upload/signed",
            expiresAt: 1,
          },
        };
      });
      yield* prepare({ environmentId, attachments: [file] });
      expect(mocks.upload).toHaveBeenCalledWith(
        file.fileUri,
        "https://old-environment.example/api/attachments/upload/signed",
        expect.anything(),
      );
    }),
  );

  it.effect("uploads a restored draft file from the current iOS document container", () =>
    Effect.gen(function* () {
      const fileName = "33333333-3333-4333-8333-333333333333-report%20%23.pdf";
      const restoredFile = {
        ...file,
        fileUri: `file:///private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/${fileName}`,
      };
      mocks.documentUri =
        "file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents";
      const currentUri = `${mocks.documentUri}/t3-composer-attachments/${fileName}`;
      mocks.upload.mockImplementation(async (uri: string) => {
        if (uri !== currentUri) {
          throw new Error("File does not exist in the previous application container.");
        }
        return { status: 204, body: "", headers: {} };
      });

      const prepared = yield* prepare({
        environmentId,
        attachments: [restoredFile],
      });

      expect(prepared.status).toBe("ready");
      expect(mocks.upload).toHaveBeenCalledWith(
        currentUri,
        "https://environment.example/api/attachments/upload/signed",
        expect.anything(),
      );
    }),
  );

  it("adds uploaded file references to durable drafts without changing images", () => {
    expect(
      withUploadedMobileAttachmentReferences({
        environmentId,
        attachments: [file, image],
        uploadedAttachments: [
          {
            type: "file",
            id: "pending-existing-pdf",
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
          },
          {
            type: "image",
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl: image.dataUrl,
          },
        ],
      }),
    ).toEqual([
      {
        ...file,
        uploadedAttachmentId: "pending-existing-pdf",
        uploadEnvironmentId: environmentId,
      },
      image,
    ]);
  });

  it.effect("reuses a pending file upload from a previous outbox attempt", () =>
    Effect.gen(function* () {
      const previouslyUploaded = {
        ...file,
        uploadedAttachmentId: "pending-existing-pdf",
        uploadEnvironmentId: environmentId,
      };

      const prepared = yield* prepare({
        environmentId,
        attachments: [previouslyUploaded, image],
      });

      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") return;
      expect(prepared.attachments).toEqual([
        {
          type: "file",
          id: "pending-existing-pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
        },
        {
          type: "image",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl: "data:image/png;base64,YWJj",
        },
      ]);
      expect(prepared.pendingAttachmentIds).toEqual(["pending-existing-pdf"]);
      expect(mocks.upload).not.toHaveBeenCalled();
      expect(mocks.runAtomCommand).not.toHaveBeenCalled();
    }),
  );

  it.effect("uploads a file again when its saved pending upload has expired", () =>
    Effect.gen(function* () {
      mocks.executeAtomQuery.mockResolvedValueOnce({
        _tag: "Failure",
        error: { _tag: "AssetAttachmentNotFoundError" },
      });
      const previouslyUploaded = {
        ...file,
        uploadedAttachmentId: "pending-expired-pdf",
        uploadEnvironmentId: environmentId,
      };

      const prepared = yield* prepare({
        environmentId,
        attachments: [previouslyUploaded],
      });

      expect(mocks.upload).toHaveBeenCalledOnce();
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") return;
      expect(prepared.pendingAttachmentIds).toEqual([MINTED_ID]);
    }),
  );

  it.effect("uploads image bytes over HTTP while retaining the durable offline image", () =>
    Effect.gen(function* () {
      const persisted = vi.fn(() => Effect.succeed("persisted" as const));
      const prepared = yield* prepare({
        environmentId,
        attachments: [image],
        supportsImageUploads: true,
        persistUploadedReferences: persisted,
      });
      expect(mocks.writeFile).toHaveBeenCalledWith("file:///cache/t3-upload-uuid", "YWJj", {
        encoding: "base64",
      });
      expect(mocks.upload).toHaveBeenCalledWith(
        "file:///cache/t3-upload-uuid",
        "https://environment.example/api/attachments/upload/signed",
        expect.objectContaining({ headers: { "Content-Type": "image/png" } }),
      );
      expect(mocks.deleteFile).toHaveBeenCalledExactlyOnceWith("file:///cache/t3-upload-uuid");
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") return;
      expect(prepared.attachments).toEqual([
        {
          type: "image",
          id: MINTED_ID,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
        },
      ]);
      expect(prepared.draftAttachments).toEqual([
        { ...image, uploadedAttachmentId: MINTED_ID, uploadEnvironmentId: environmentId },
      ]);
      expect(persisted).toHaveBeenCalledWith(prepared.draftAttachments);
    }),
  );

  it.effect("reuses an uploaded image and reuploads its local bytes after server expiry", () =>
    Effect.gen(function* () {
      const saved = {
        ...image,
        uploadedAttachmentId: "saved-image",
        uploadEnvironmentId: environmentId,
      };
      const reused = yield* prepare({
        environmentId,
        attachments: [saved],
        supportsImageUploads: true,
      });
      expect(reused.status === "ready" && reused.attachments[0]).toEqual({
        type: "image",
        id: "saved-image",
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
      });
      expect(mocks.upload).not.toHaveBeenCalled();
      mocks.executeAtomQuery.mockResolvedValueOnce({
        _tag: "Failure",
        error: { _tag: "AssetAttachmentNotFoundError" },
      });
      const restored = yield* prepare({
        environmentId,
        attachments: [saved],
        supportsImageUploads: true,
      });
      expect(restored.status === "ready" && restored.draftAttachments[0]).toEqual({
        ...saved,
        uploadedAttachmentId: MINTED_ID,
      });
      expect(mocks.writeFile).toHaveBeenCalledWith("file:///cache/t3-upload-uuid", "YWJj", {
        encoding: "base64",
      });
    }),
  );

  it.effect("does not reuse an image upload from another environment", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare({
        environmentId,
        attachments: [
          {
            ...image,
            uploadedAttachmentId: "other-image",
            uploadEnvironmentId: EnvironmentId.make("other"),
          },
        ],
        supportsImageUploads: true,
      });
      expect(mocks.executeAtomQuery).not.toHaveBeenCalled();
      expect(mocks.upload).toHaveBeenCalledOnce();
      expect(prepared.status === "ready" && prepared.draftAttachments[0]?.uploadEnvironmentId).toBe(
        environmentId,
      );
    }),
  );

  it.effect(
    "aborts an active transfer without dropping local bytes or stamping a partial upload",
    () =>
      Effect.gen(function* () {
        const started = Promise.withResolvers<void>();
        const persist = vi.fn(() => Effect.succeed("persisted" as const));
        mocks.upload.mockImplementation(
          (_uri: string, _url: string, options: { signal: AbortSignal }) =>
            new Promise((_, reject) => {
              options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
                once: true,
              });
              started.resolve();
            }),
        );
        const preparing = yield* Effect.forkChild(
          prepare({ environmentId, attachments: [file], persistUploadedReferences: persist }),
        );
        yield* Effect.promise(() => started.promise);
        yield* Fiber.interrupt(preparing);
        expect(Exit.hasInterrupts(yield* Fiber.await(preparing))).toBe(true);
        expect(persist).not.toHaveBeenCalled();
        expect(mocks.deleteFile).not.toHaveBeenCalled();
        expect(removeCallsFor(MINTED_ID)).toBe(1);
      }),
  );

  it.effect("removes pending uploads when the native HTTP request fails", () =>
    Effect.gen(function* () {
      mocks.upload.mockResolvedValue({ status: 400, body: "failed", headers: {} });

      expect(
        (yield* Effect.flip(prepare({ environmentId, attachments: [file] }))).message,
      ).toContain("Upload failed for 'report.pdf' (400).");
      expect(removeCallsFor(MINTED_ID)).toBe(1);
    }),
  );

  it.effect("cancels staging before calling either upload transport", () =>
    Effect.gen(function* () {
      const staging = Promise.withResolvers<void>();
      const staged = Promise.withResolvers<void>();
      const stagingFileDeleted = Promise.withResolvers<void>();
      mocks.writeFile.mockImplementation(() => {
        staging.resolve();
        return staged.promise;
      });
      mocks.deleteFile.mockImplementationOnce(() => stagingFileDeleted.resolve());
      const report = vi.fn();
      const upload = yield* Effect.forkChild(
        uploadComposerAttachment(environmentId, image, undefined, report),
      );
      yield* Effect.promise(() => staging.promise);
      yield* Fiber.interrupt(upload);
      staged.resolve();
      yield* Effect.promise(() => stagingFileDeleted.promise);
      expect(Exit.hasInterrupts(yield* Fiber.await(upload))).toBe(true);
      expect(report).not.toHaveBeenCalled();
      expect(removeCallsFor(MINTED_ID)).toBe(1);
      expect(mocks.verifiedUpload).not.toHaveBeenCalled();
      expect(mocks.upload).not.toHaveBeenCalled();
    }),
  );

  it.effect("requires verified transport even when the issued origin has no cached pin", () =>
    Effect.gen(function* () {
      mocks.runAtomCommand.mockImplementationOnce(async () => ({
        _tag: "Success",
        value: {
          attachmentId: MINTED_ID,
          relativeUrl: "https://environment.example/api/attachments/upload/signed",
          expiresAt: 1,
          verificationRequired: true,
        },
      }));

      expect((yield* Effect.flip(uploadComposerAttachment(environmentId, file))).message).toContain(
        "could not be verified",
      );
      expect(mocks.verifiedUpload).toHaveBeenCalledExactlyOnceWith(
        "https://environment.example/api/attachments/upload/signed",
        expect.objectContaining({ requireVerified: true }),
      );
      expect(mocks.upload).not.toHaveBeenCalled();
    }),
  );

  it.effect("reports unknown when a committed upload loses its response and cleanup fails", () =>
    Effect.gen(function* () {
      let published = false;
      mocks.verifiedUpload.mockImplementation(async () => {
        published = true;
        throw new Error("Response was lost.");
      });
      mocks.executeAtomQuery.mockImplementation(async () => {
        expect(published).toBe(true);
        return { _tag: "Success", value: {} };
      });
      const normalCommand = mocks.runAtomCommand.getMockImplementation()!;
      mocks.runAtomCommand.mockImplementation((...args) =>
        args[1] === mocks.removeUpload
          ? Promise.resolve({ _tag: "Failure", error: new Error("cleanup disconnected") })
          : normalCommand(...args),
      );

      const error = yield* Effect.flip(uploadComposerAttachment(environmentId, file));
      expect(error.message).toContain("Upload outcome unknown");
      expect(removeCallsFor(MINTED_ID)).toBeGreaterThan(0);
      expect(mocks.verifiedUpload).toHaveBeenCalledOnce();
      expect(mocks.upload).not.toHaveBeenCalled();
    }),
  );

  it.effect.each(["delete-failed", "delete-no-op", "published-after-delete", "removed"] as const)(
    "settles a cancelled verified upload with server state %s",
    (outcome) =>
      Effect.gen(function* () {
        const started = Promise.withResolvers<void>();
        const deleting = Promise.withResolvers<void>();
        const finishDelete = Promise.withResolvers<void>();
        let published = outcome !== "published-after-delete";
        let cancelled = false;
        const report = vi.fn();
        mocks.verifiedUpload.mockImplementation(
          (_url, { signal }: { signal: AbortSignal }) =>
            new Promise((_, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  cancelled = true;
                  reject(signal.reason);
                },
                { once: true },
              );
              started.resolve();
            }),
        );
        mocks.executeAtomQuery.mockImplementation(async () =>
          published
            ? { _tag: "Success", value: {} }
            : { _tag: "Failure", error: { _tag: "AssetAttachmentNotFoundError" } },
        );
        mocks.runAtomCommand.mockImplementationOnce(async () => ({
          _tag: "Success",
          value: {
            attachmentId: MINTED_ID,
            relativeUrl: "https://environment.example/api/attachments/upload/signed",
            expiresAt: 1,
          },
        }));
        const deleteUpload = async () => {
          deleting.resolve();
          await finishDelete.promise;
          if (outcome === "delete-failed") {
            return { _tag: "Failure", error: new Error("cleanup disconnected") };
          }
          if (outcome !== "delete-no-op") published = false;
          return { _tag: "Success", value: undefined };
        };
        mocks.runAtomCommand
          .mockImplementationOnce(deleteUpload)
          .mockImplementationOnce(deleteUpload);

        const upload = yield* Effect.forkChild(
          uploadComposerAttachment(environmentId, file, undefined, report),
        );
        yield* Effect.promise(() => started.promise);
        const interrupt = yield* Effect.forkChild(Fiber.interrupt(upload));
        yield* Effect.promise(() => deleting.promise);
        const exitWhileDeleting = upload.pollUnsafe();
        finishDelete.resolve();
        yield* Fiber.join(interrupt);
        if (outcome === "published-after-delete") published = true;
        expect(exitWhileDeleting).toBeUndefined();
        expect(cancelled).toBe(true);
        expect(Exit.hasInterrupts(yield* Fiber.await(upload))).toBe(true);
        expect(report.mock.calls[0]?.[0]).toMatchObject({
          message: expect.stringContaining("Upload outcome unknown"),
        });
        expect(report.mock.lastCall?.[0] === null).toBe(outcome === "removed");
        expect(published).toBe(outcome !== "removed");
        expect(mocks.verifiedUpload).toHaveBeenCalledOnce();
        expect(mocks.upload).not.toHaveBeenCalled();
      }),
  );

  it.effect("keeps a previously persisted upload when a later attachment fails", () =>
    Effect.gen(function* () {
      const previouslyUploaded = {
        ...file,
        id: "file-existing",
        uploadedAttachmentId: "pending-existing-pdf",
        uploadEnvironmentId: environmentId,
      };
      mocks.upload.mockResolvedValue({ status: 400, body: "failed", headers: {} });

      expect(
        (yield* Effect.flip(prepare({ environmentId, attachments: [previouslyUploaded, file] })))
          .message,
      ).toContain("Upload failed for 'report.pdf' (400).");

      expect(removeCallsFor("pending-existing-pdf")).toBe(0);
    }),
  );
});

describe("releasePendingAttachmentUploads", () => {
  beforeEach(() => {
    mocks.runAtomCommand.mockReset();
  });

  it("throws when a delete keeps failing so the caller sees the leak", async () => {
    mocks.runAtomCommand.mockResolvedValue({ _tag: "Failure", error: new Error("offline") });

    await expect(releasePendingAttachmentUploads(environmentId, ["pending-a"])).rejects.toThrow(
      "pending-a",
    );
  });

  it("treats an already-deleted pending upload as released", async () => {
    mocks.runAtomCommand.mockResolvedValue({
      _tag: "Failure",
      error: { _tag: "AssetAttachmentNotFoundError" },
    });

    await expect(
      releasePendingAttachmentUploads(environmentId, ["pending-a"]),
    ).resolves.toBeUndefined();
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
  });
});
