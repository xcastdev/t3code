import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom, AsyncResult } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";

import {
  composerFileNeedsReattach,
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../composerDraftStore";

const mocks = vi.hoisted(() => ({
  connectionStateAtom: vi.fn(),
  createAssetUrl: vi.fn(),
  createUploadUrl: Symbol("create-upload-url"),
  executeAtomQuery: vi.fn(),
  removeUpload: Symbol("remove-upload"),
  runAtomCommand: vi.fn(),
  readEnvironmentScope: vi.fn(),
  readPreparedConnection: vi.fn(),
  isOperatorBoundBrowserRoute: vi.fn(() => false),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.executeAtomQuery,
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});

vi.mock("../connection/catalog", () => ({
  environmentCatalog: { stateAtom: mocks.connectionStateAtom },
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

vi.mock("../connection/verifiedRoute", async () => {
  const Effect = await import("effect/Effect");
  return {
    isOperatorBoundBrowserRoute: mocks.isOperatorBoundBrowserRoute,
    readOperatorBrowserBinding: () => null,
    verifiedRoutePolicy: { readEnrollment: () => Effect.succeed(null) },
  };
});

vi.mock("../state/session", () => ({
  readEnvironmentScope: mocks.readEnvironmentScope,
  readPreparedConnection: mocks.readPreparedConnection,
}));

import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  refreshExpiredAttachmentUploads,
  releaseAttachmentUpload,
  releaseDraftAttachment,
  releaseDraftAttachments,
  releasePersistedAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "./attachmentUploadQueue";

type ProgressListener = (event: {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
}) => void;

class TestXmlHttpRequest {
  static requests: TestXmlHttpRequest[] = [];

  status = 0;
  aborted = false;
  timeout = 0;
  method: string | null = null;
  url: string | null = null;
  readonly headers = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  progressListener: ProgressListener | null = null;

  readonly upload = {
    addEventListener: (_event: string, listener: ProgressListener) => {
      this.progressListener = listener;
    },
  };

  constructor() {
    TestXmlHttpRequest.requests.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }

  send(): void {}

  abort(): void {
    this.aborted = true;
    this.listeners.get("abort")?.();
  }

  progress(loaded: number, total: number): void {
    this.progressListener?.({ lengthComputable: true, loaded, total });
  }

  complete(status = 204): void {
    this.status = status;
    this.listeners.get("load")?.();
  }

  disconnect(): void {
    this.listeners.get("error")?.();
  }
}

const firstEnvironment = EnvironmentId.make("environment-1");
const secondEnvironment = EnvironmentId.make("environment-2");

function makeImage(id: string): ComposerImageAttachment {
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

function makeFile(id: string): ComposerFileAttachment {
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.pdf`, {
    type: "application/pdf",
  });
  return {
    type: "file",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
}

const connectionStates = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make(AsyncResult.success({ phase: "connected" })),
);

function setConnected(environmentId: EnvironmentId, connected: boolean) {
  appAtomRegistry.set(
    connectionStates(environmentId),
    AsyncResult.success({ phase: connected ? "connected" : "backoff" }),
  );
}

describe("attachmentUploadQueue", () => {
  beforeEach(() => {
    mocks.connectionStateAtom.mockImplementation(connectionStates);
    setConnected(firstEnvironment, true);
    setConnected(secondEnvironment, true);
    TestXmlHttpRequest.requests = [];
    mocks.createAssetUrl.mockReset();
    mocks.createAssetUrl.mockImplementation((target: unknown) => target);
    mocks.executeAtomQuery.mockReset();
    mocks.executeAtomQuery.mockResolvedValue({ _tag: "Success", value: {} });
    mocks.runAtomCommand.mockReset();
    mocks.readEnvironmentScope.mockReset().mockReturnValue(true);
    mocks.readPreparedConnection.mockReset();
    mocks.readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://environment.test/" });
    mocks.runAtomCommand.mockImplementation(
      async (
        _registry: unknown,
        command: unknown,
        target: {
          readonly environmentId: EnvironmentId;
          readonly input: { readonly name?: string };
        },
      ) => {
        if (command === mocks.createUploadUrl) {
          const attachmentId = `pending-${target.environmentId}-${target.input.name}`;
          return {
            _tag: "Success",
            value: {
              attachmentId,
              relativeUrl: `/api/attachments/upload/${attachmentId}`,
              expiresAt: 1,
            },
          };
        }
        return { _tag: "Success", value: undefined };
      },
    );
    vi.stubGlobal("XMLHttpRequest", TestXmlHttpRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
    );
  });

  afterEach(() => {
    for (const imageId of Object.keys(useAttachmentUploadStore.getState().uploadsByImageId)) {
      releaseAttachmentUpload(imageId);
    }
    vi.unstubAllGlobals();
  });

  it("aborts a pending HTTPS upload on explicit retirement with no connected socket", async () => {
    vi.useFakeTimers();
    const admission = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(null, { status: 204, headers: { "T3-Relay-Admission": "active" } }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 410, headers: { "T3-Relay-Admission": "retired" } }),
      );
    vi.stubGlobal("fetch", admission);
    try {
      setConnected(firstEnvironment, false);
      mocks.runAtomCommand.mockResolvedValueOnce({
        _tag: "Success",
        value: {
          attachmentId: "pending-retired-upload",
          relativeUrl: "/api/attachments/upload/pending-retired-upload?sig=upload-only",
          expiresAt: 1,
        },
      });
      const image = makeImage("relay-retired-upload");
      startAttachmentUpload({ environmentId: firstEnvironment, image });
      await vi.advanceTimersByTimeAsync(0);
      const request = TestXmlHttpRequest.requests[0]!;
      expect(request.url).toBe(
        "https://environment.test/api/attachments/upload/pending-retired-upload?sig=upload-only",
      );
      request.progress(1, 3);
      expect(admission).toHaveBeenCalledWith(
        "https://environment.test/.well-known/t3/relay-admission",
        {
          method: "HEAD",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal: expect.any(AbortSignal),
        },
      );
      expect(readAttachmentUpload(image.id)).toMatchObject({ status: "uploading" });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(admission).toHaveBeenCalledTimes(3);
      await awaitAttachmentUploads([image.id]);
      expect(request.aborted).toBe(true);
      expect(readAttachmentUpload(image.id)).toMatchObject({
        status: "failed",
        failure: "relay-retired",
        reason: "Upload outcome unknown because the relay route was retired.",
      });

      setConnected(firstEnvironment, true);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(TestXmlHttpRequest.requests).toEqual([request]);
      expect(admission).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uploads to the issuing origin with redirect refusal after a route change", async () => {
    mocks.isOperatorBoundBrowserRoute.mockReturnValueOnce(true);
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", request);
    const issuedUrl = "https://issuing.example.test/api/attachments/upload/pending-proof";
    mocks.runAtomCommand.mockResolvedValueOnce({
      _tag: "Success",
      value: { attachmentId: "pending-proof", relativeUrl: issuedUrl, expiresAt: 1 },
    });
    mocks.readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://replacement.test/" });

    const image = makeImage("relay-proof-upload");
    startAttachmentUpload({ environmentId: firstEnvironment, image });
    await awaitAttachmentUploads([image.id]);

    expect(TestXmlHttpRequest.requests).toEqual([]);
    expect(request).toHaveBeenCalledWith(
      issuedUrl,
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        redirect: "error",
      }),
    );
    expect(readAttachmentUpload(image.id)).toMatchObject({
      status: "ready",
      attachmentId: "pending-proof",
    });
  });

  it("refuses an unbound issuer for a verified upload before any transfer", async () => {
    using _xhr = vi.spyOn(TestXmlHttpRequest.prototype, "send").mockImplementation(function (
      this: TestXmlHttpRequest,
    ) {
      this.complete();
    });
    const response = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", response);
    mocks.runAtomCommand.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        attachmentId: "pending-verified",
        relativeUrl: "https://unbound.test/api/attachments/upload/proof",
        expiresAt: 1,
        verificationRequired: true,
      },
    });

    const image = makeImage("verified-upload");
    startAttachmentUpload({ environmentId: firstEnvironment, image });
    await awaitAttachmentUploads([image.id]);

    expect(TestXmlHttpRequest.requests).toEqual([]);
    expect(response).not.toHaveBeenCalled();
    expect(readAttachmentUpload(image.id)).toMatchObject({ status: "failed" });
  });

  it.each([
    ["http", true, true],
    ["network", true, true],
    ["network", false, true],
    ["network", false, false],
  ] as const)(
    "does not retry after a %s failure (retired: %s, previously confirmed: %s)",
    async (failure, retired, confirmed) => {
      vi.useFakeTimers();
      const admission = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          confirmed
            ? new Response(null, { status: 204, headers: { "T3-Relay-Admission": "active" } })
            : new Response(null, { status: 503 }),
        )
        .mockResolvedValueOnce(
          retired
            ? new Response(null, { status: 410, headers: { "T3-Relay-Admission": "retired" } })
            : new Response(null, { status: 503 }),
        );
      vi.stubGlobal("fetch", admission);
      try {
        const image = makeImage("interrupted-relay-upload");
        startAttachmentUpload({ environmentId: firstEnvironment, image });
        await vi.advanceTimersByTimeAsync(0);
        const request = TestXmlHttpRequest.requests[0]!;
        setConnected(firstEnvironment, false);
        if (failure === "http") request.complete(410);
        else request.disconnect();
        setConnected(firstEnvironment, true);
        await vi.advanceTimersByTimeAsync(0);
        expect(readAttachmentUpload(image.id)).toMatchObject({
          status: "failed",
          failure: retired ? "relay-retired" : "outcome-unknown",
        });
        expect(TestXmlHttpRequest.requests).toEqual([request]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("leaves an HTTPS upload alone if the origin does not advertise relay admission", async () => {
    vi.useFakeTimers();
    const admission = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 410 }));
    vi.stubGlobal("fetch", admission);
    try {
      const image = makeImage("direct-upload");
      startAttachmentUpload({ environmentId: firstEnvironment, image });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(admission).toHaveBeenCalledTimes(1);
      expect(readAttachmentUpload(image.id)).toMatchObject({ status: "uploading" });
      const settled = awaitAttachmentUploads([image.id]);
      TestXmlHttpRequest.requests[0]!.complete();
      await settled;
      expect(readAttachmentUpload(image.id)).toMatchObject({ status: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues the upload through inconclusive admission responses and stops checking on completion", async () => {
    vi.useFakeTimers();
    const admission = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 204, headers: { "T3-Relay-Admission": "active" } }),
      )
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
      .mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal("fetch", admission);
    try {
      const image = makeImage("relay-active-upload");
      startAttachmentUpload({ environmentId: firstEnvironment, image });
      await vi.advanceTimersByTimeAsync(0);
      const request = TestXmlHttpRequest.requests[0]!;
      setConnected(firstEnvironment, false);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(admission).toHaveBeenCalledTimes(4);
      expect(request.aborted).toBe(false);
      expect(readAttachmentUpload(image.id)).toMatchObject({ status: "uploading" });

      const probeSignal = admission.mock.calls[3]![1]?.signal;
      const settled = awaitAttachmentUploads([image.id]);
      request.complete();
      await settled;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(probeSignal?.aborted).toBe(true);
      expect(admission).toHaveBeenCalledTimes(4);
      expect(readAttachmentUpload(image.id)).toMatchObject({ status: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuploads an expired image while retaining other ready images", async () => {
    const images = [makeImage("first"), makeImage("second")].map((image) => ({
      ...image,
      name: "image.png",
    }));
    let minted = 0;
    mocks.runAtomCommand.mockImplementation(async (_registry, command) => {
      if (command !== mocks.createUploadUrl) return { _tag: "Success", value: undefined };
      const attachmentId = `pending-test-${++minted}`;
      return {
        _tag: "Success",
        value: {
          attachmentId,
          relativeUrl: `/api/attachments/upload/${attachmentId}`,
          expiresAt: 1,
        },
      };
    });
    for (const image of images) startAttachmentUpload({ environmentId: firstEnvironment, image });
    await Promise.resolve();
    const initial = awaitAttachmentUploads(images.map((image) => image.id));
    TestXmlHttpRequest.requests.forEach((request) => request.complete());
    await initial;
    mocks.executeAtomQuery.mockImplementation(
      async (_registry, target: { input: { resource: { attachmentId: string } } }) =>
        target.input.resource.attachmentId === "pending-test-1"
          ? { _tag: "Failure", error: { _tag: "AssetAttachmentNotFoundError" } }
          : { _tag: "Success", value: {} },
    );
    const refreshing = refreshExpiredAttachmentUploads({ environmentId: firstEnvironment, images });
    await vi.waitFor(() => expect(TestXmlHttpRequest.requests).toHaveLength(3));
    TestXmlHttpRequest.requests[2]!.complete();
    await refreshing;
    expect(
      getUploadedAttachments({ environmentId: firstEnvironment, images })?.map((image) => image.id),
    ).toEqual(["pending-test-3", "pending-test-2"]);
    expect(TestXmlHttpRequest.requests).toHaveLength(3);
  });

  it("reuploads local file bytes after its persisted upload is known to be missing", async () => {
    const file = {
      ...makeFile("expired-saved-file"),
      uploadedAttachmentId: "pending-expired",
      uploadEnvironmentId: firstEnvironment,
    };
    useAttachmentUploadStore.setState({
      uploadsByImageId: {
        [file.id]: {
          status: "ready",
          environmentId: firstEnvironment,
          attachmentId: "pending-expired",
        },
      },
    });
    mocks.executeAtomQuery
      .mockResolvedValueOnce({
        _tag: "Failure",
        error: { _tag: "AssetAttachmentNotFoundError" },
      })
      .mockResolvedValue({ _tag: "Failure", error: new Error("Connection interrupted") });
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    const runCommand = mocks.runAtomCommand.getMockImplementation()!;
    mocks.runAtomCommand.mockImplementation(async (...args) => {
      const result = await runCommand(...args);
      if (args[1] === mocks.createUploadUrl) uploadStarted();
      return result;
    });
    const refresh = refreshExpiredAttachmentUploads({
      environmentId: firstEnvironment,
      images: [file],
    });
    expect(await Promise.race([started.then(() => "upload"), refresh.then(() => "settled")])).toBe(
      "upload",
    );
    expect(TestXmlHttpRequest.requests).toHaveLength(1);
    TestXmlHttpRequest.requests[0]!.complete();
    await refresh;
    expect(mocks.executeAtomQuery).toHaveBeenCalledTimes(1);
    expect(
      getUploadedAttachments({ environmentId: firstEnvironment, images: [file] }),
    ).toMatchObject([{ id: "pending-environment-1-expired-saved-file.pdf" }]);
  });

  it.each([false, true])(
    "retains cleanup identity after verification fails (retry: %s)",
    async (retry) => {
      const image = makeImage("connection-failure");
      useAttachmentUploadStore.setState({
        uploadsByImageId: {
          [image.id]: {
            status: "ready",
            environmentId: firstEnvironment,
            attachmentId: "pending-original",
          },
        },
      });
      mocks.executeAtomQuery.mockRejectedValueOnce(new Error("offline"));
      await refreshExpiredAttachmentUploads({ environmentId: firstEnvironment, images: [image] });
      expect(readAttachmentUpload(image.id)).toMatchObject({ status: "failed" });
      expect(
        getUploadedAttachments({ environmentId: firstEnvironment, images: [image] }),
      ).toBeNull();
      expect(TestXmlHttpRequest.requests).toHaveLength(0);
      if (retry) retryAttachmentUpload({ environmentId: firstEnvironment, image });
      releaseAttachmentUpload(image.id);
      expect(readAttachmentUpload(image.id)).toBeUndefined();
      expect(mocks.runAtomCommand).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        mocks.removeUpload,
        { environmentId: firstEnvironment, input: { attachmentId: "pending-original" } },
        expect.anything(),
      );
    },
  );

  it("reuploads local bytes for a connection without read permission", async () => {
    const image = makeImage("operate-only");
    useAttachmentUploadStore.setState({
      uploadsByImageId: {
        [image.id]: {
          status: "ready",
          environmentId: firstEnvironment,
          attachmentId: "pending-original",
        },
      },
    });
    mocks.readEnvironmentScope.mockImplementation(
      (_environmentId, scope) => scope !== "orchestration:read",
    );
    const refresh = refreshExpiredAttachmentUploads({
      environmentId: firstEnvironment,
      images: [image],
    });
    await vi.waitFor(() => expect(TestXmlHttpRequest.requests).toHaveLength(1));
    TestXmlHttpRequest.requests[0]!.complete();
    await refresh;
    expect(readAttachmentUpload(image.id)).toMatchObject({
      status: "ready",
      attachmentId: "pending-environment-1-operate-only.png",
    });
    expect(mocks.executeAtomQuery).not.toHaveBeenCalled();
  });

  it("does not resurrect an image removed while its upload is being checked", async () => {
    const image = makeImage("removed-during-verification");
    useAttachmentUploadStore.setState({
      uploadsByImageId: {
        [image.id]: {
          status: "ready",
          environmentId: firstEnvironment,
          attachmentId: "pending-original",
        },
      },
    });
    let finish!: (value: unknown) => void;
    mocks.executeAtomQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const refresh = refreshExpiredAttachmentUploads({
      environmentId: firstEnvironment,
      images: [image],
    });
    releaseAttachmentUpload(image.id);
    finish({ _tag: "Failure", error: { _tag: "AssetAttachmentNotFoundError" } });
    await refresh;
    expect(readAttachmentUpload(image.id)).toBeUndefined();
    expect(TestXmlHttpRequest.requests).toHaveLength(0);
  });

  it("keeps an attachment local until its own environment grants write access", async () => {
    const image = makeImage("permission-gain");
    mocks.readEnvironmentScope.mockImplementation(
      (environmentId) => environmentId === firstEnvironment,
    );

    startAttachmentUpload({ environmentId: secondEnvironment, image });
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();
    expect(TestXmlHttpRequest.requests).toHaveLength(0);
    expect(readAttachmentUpload(image.id)).toBeUndefined();
    expect(image.file).not.toBeNull();

    mocks.readEnvironmentScope.mockReturnValue(true);
    startAttachmentUpload({ environmentId: secondEnvironment, image });
    await Promise.resolve();
    const settled = awaitAttachmentUploads([image.id]);
    TestXmlHttpRequest.requests[0]!.complete();
    await settled;

    expect(readAttachmentUpload(image.id)).toMatchObject({
      status: "ready",
      environmentId: secondEnvironment,
    });
  });

  it("does not transfer bytes or retry when access is revoked while minting an upload", async () => {
    const image = makeImage("revoke-before-bytes");
    let finishMint: (() => void) | undefined;
    mocks.runAtomCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishMint = () =>
            resolve({
              _tag: "Success",
              value: {
                attachmentId: "pending-revoked",
                relativeUrl: "/api/attachments/upload/pending-revoked",
                expiresAt: 1,
              },
            });
        }),
    );
    startAttachmentUpload({ environmentId: firstEnvironment, image });
    const settled = awaitAttachmentUploads([image.id]);
    mocks.readEnvironmentScope.mockReturnValue(false);
    finishMint!();
    await settled;

    expect(TestXmlHttpRequest.requests).toHaveLength(0);
    expect(readAttachmentUpload(image.id)).toMatchObject({
      status: "failed",
      reason: "This connection cannot upload attachments.",
      attachmentId: "pending-revoked",
    });
    retryAttachmentUpload({ environmentId: firstEnvironment, image });
    expect(readAttachmentUpload(image.id)?.status).toBe("failed");
    releaseAttachmentUpload(image.id);
    expect(readAttachmentUpload(image.id)).toBeUndefined();
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
  });

  it("does not delete a persisted upload using another environment's grant", () => {
    mocks.readEnvironmentScope.mockImplementation(
      (environmentId) => environmentId === firstEnvironment,
    );
    releasePersistedAttachmentUpload({
      id: "local-file",
      environmentId: secondEnvironment,
      attachmentId: "persisted-file",
    });
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();

    mocks.readEnvironmentScope.mockReturnValue(true);
    releasePersistedAttachmentUpload({
      id: "local-file",
      environmentId: secondEnvironment,
      attachmentId: "persisted-file",
    });
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      { environmentId: secondEnvironment, input: { attachmentId: "persisted-file" } },
      expect.anything(),
    );
  });

  it("uploads images immediately and sends attachment references", async () => {
    const image = {
      ...makeImage("image-1"),
      source: {
        kind: "snap-shot" as const,
        capturedAt: "2026-08-24T11:00:00.000Z",
        appName: "Terminal",
        windowTitle: "Tests",
      },
    };
    startAttachmentUpload({ environmentId: firstEnvironment, image });
    await Promise.resolve();

    const request = TestXmlHttpRequest.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://environment.test/api/attachments/upload/pending-environment-1-image-1.png",
    );
    request.progress(1, 3);
    expect(readAttachmentUpload(image.id)).toMatchObject({ status: "uploading", progress: 1 / 3 });

    const settled = awaitAttachmentUploads([image.id]);
    request.complete();
    await settled;

    expect(getUploadedAttachments({ environmentId: firstEnvironment, images: [image] })).toEqual([
      {
        type: "image",
        id: "pending-environment-1-image-1.png",
        name: "image-1.png",
        mimeType: "image/png",
        sizeBytes: 3,
        source: {
          kind: "snap-shot",
          capturedAt: "2026-08-24T11:00:00.000Z",
          appName: "Terminal",
          windowTitle: "Tests",
        },
      },
    ]);

    releaseDraftAttachments([image]);
    expect(readAttachmentUpload(image.id)).toBeUndefined();
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId: firstEnvironment,
        input: { attachmentId: "pending-environment-1-image-1.png" },
      },
      expect.anything(),
    );
  });

  it("persists a background completion's ids to the draft with no composer mounted", async () => {
    const draftId = DraftId.make("draft-background-upload");
    const file = makeFile("background");
    const draftStore = useComposerDraftStore.getState();
    draftStore.addFiles(draftId, [file]);
    try {
      startAttachmentUpload({
        environmentId: firstEnvironment,
        image: file,
        draftTarget: draftId,
      });
      await Promise.resolve();

      const settled = awaitAttachmentUploads([file.id]);
      TestXmlHttpRequest.requests[0]!.complete();
      await settled;

      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toMatchObject([
        {
          id: file.id,
          uploadedAttachmentId: "pending-environment-1-background.pdf",
          uploadEnvironmentId: firstEnvironment,
        },
      ]);
    } finally {
      useComposerDraftStore.getState().clearComposerContent(draftId);
    }
  });

  it("stamps a file that lands in a draft after its upload finished", async () => {
    const draftId = DraftId.make("draft-restored-upload");
    const file = makeFile("restored");
    try {
      startAttachmentUpload({ environmentId: firstEnvironment, image: file, draftTarget: draftId });
      await Promise.resolve();
      const settled = awaitAttachmentUploads([file.id]);
      TestXmlHttpRequest.requests[0]!.complete();
      await settled;

      useComposerDraftStore.getState().addFiles(draftId, [file]);
      startAttachmentUpload({ environmentId: firstEnvironment, image: file, draftTarget: draftId });

      expect(TestXmlHttpRequest.requests).toHaveLength(1);
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toMatchObject([
        {
          id: file.id,
          uploadedAttachmentId: "pending-environment-1-restored.pdf",
          uploadEnvironmentId: firstEnvironment,
        },
      ]);
    } finally {
      useComposerDraftStore.getState().clearComposerContent(draftId);
    }
  });

  it("turns an expired persisted file into a marker that a re-pick can replace", async () => {
    const draftId = DraftId.make("draft-expired-upload");
    const file: ComposerFileAttachment = {
      ...makeFile("expired"),
      file: null,
      uploadedAttachmentId: "pending-expired-pdf",
      uploadEnvironmentId: firstEnvironment,
    };
    mocks.executeAtomQuery.mockResolvedValueOnce({
      _tag: "Failure",
      error: { _tag: "AssetAttachmentNotFoundError" },
    });
    useComposerDraftStore.getState().addFiles(draftId, [file]);

    try {
      startAttachmentUpload({
        environmentId: firstEnvironment,
        image: file,
        draftTarget: draftId,
      });
      await awaitAttachmentUploads([file.id]);

      const marker = useComposerDraftStore.getState().getComposerDraft(draftId)?.files[0];
      expect(readAttachmentUpload(file.id)).toBeUndefined();
      expect(marker?.uploadedAttachmentId).toBeUndefined();
      expect(marker?.uploadEnvironmentId).toBeUndefined();
      expect(marker && composerFileNeedsReattach(marker)).toBe(true);

      const replacementBytes = new File([new Uint8Array([1, 2, 3])], file.name, {
        type: file.mimeType,
      });
      const replacement: ComposerFileAttachment = {
        type: "file",
        id: "expired-repicked",
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        file: replacementBytes,
      };
      useComposerDraftStore.getState().addFiles(draftId, [replacement]);
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toMatchObject([
        { id: replacement.id, file: replacementBytes },
      ]);

      startAttachmentUpload({
        environmentId: firstEnvironment,
        image: replacement,
        draftTarget: draftId,
      });
      await Promise.resolve();
      const settled = awaitAttachmentUploads([replacement.id]);
      TestXmlHttpRequest.requests[0]!.complete();
      await settled;

      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toMatchObject([
        {
          id: replacement.id,
          uploadedAttachmentId: "pending-environment-1-expired.pdf",
          uploadEnvironmentId: firstEnvironment,
        },
      ]);
      const removeCalls = mocks.runAtomCommand.mock.calls.filter(
        ([, command]) => command === mocks.removeUpload,
      );
      expect(removeCalls).toEqual([]);
    } finally {
      useComposerDraftStore.getState().clearComposerContent(draftId);
    }
  });

  it("removes a persisted upload when its draft is discarded during verification", async () => {
    const file: ComposerFileAttachment = {
      ...makeFile("checking"),
      file: null,
      uploadedAttachmentId: "pending-checking-pdf",
      uploadEnvironmentId: firstEnvironment,
    };
    let resolveVerification: (result: {
      readonly _tag: "Success";
      readonly value: object;
    }) => void = () => {};
    mocks.executeAtomQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveVerification = resolve;
      }),
    );

    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    releaseDraftAttachment(file);
    resolveVerification({ _tag: "Success", value: {} });

    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId: firstEnvironment,
        input: { attachmentId: "pending-checking-pdf" },
      },
      expect.anything(),
    );
  });

  it("keeps the persisted upload when retrying after a transient verification failure", async () => {
    const draftId = DraftId.make("draft-transient-verification");
    const file: ComposerFileAttachment = {
      ...makeFile("flaky"),
      file: null,
      uploadedAttachmentId: "pending-flaky-pdf",
      uploadEnvironmentId: firstEnvironment,
    };
    mocks.executeAtomQuery.mockResolvedValueOnce({
      _tag: "Failure",
      error: new Error("socket closed"),
    });
    useComposerDraftStore.getState().addFiles(draftId, [file]);

    try {
      startAttachmentUpload({
        environmentId: firstEnvironment,
        image: file,
        draftTarget: draftId,
      });
      await awaitAttachmentUploads([file.id]);
      expect(readAttachmentUpload(file.id)).toMatchObject({
        status: "failed",
        reason: "Uploaded file could not be verified. Retry when the server reconnects.",
      });
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toMatchObject([
        {
          uploadedAttachmentId: "pending-flaky-pdf",
          uploadEnvironmentId: firstEnvironment,
        },
      ]);

      retryAttachmentUpload({
        environmentId: firstEnvironment,
        image: file,
        draftTarget: draftId,
      });
      await awaitAttachmentUploads([file.id]);

      expect(readAttachmentUpload(file.id)).toEqual({
        status: "ready",
        environmentId: firstEnvironment,
        attachmentId: "pending-flaky-pdf",
      });
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toMatchObject([
        {
          uploadedAttachmentId: "pending-flaky-pdf",
          uploadEnvironmentId: firstEnvironment,
        },
      ]);
      const removeCalls = mocks.runAtomCommand.mock.calls.filter(
        ([, command]) => command === mocks.removeUpload,
      );
      expect(removeCalls).toEqual([]);
    } finally {
      useComposerDraftStore.getState().clearComposerContent(draftId);
    }
  });

  it("routes a live persisted upload through the queue release exactly once", async () => {
    const file: ComposerFileAttachment = {
      ...makeFile("live"),
      file: null,
      uploadedAttachmentId: "pending-live-pdf",
      uploadEnvironmentId: firstEnvironment,
    };
    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    await awaitAttachmentUploads([file.id]);
    expect(readAttachmentUpload(file.id)).toMatchObject({ status: "ready" });

    releaseDraftAttachment(file);

    expect(readAttachmentUpload(file.id)).toBeUndefined();
    const removeCalls = mocks.runAtomCommand.mock.calls.filter(
      ([, command]) => command === mocks.removeUpload,
    );
    expect(removeCalls).toEqual([
      [
        expect.anything(),
        mocks.removeUpload,
        {
          environmentId: firstEnvironment,
          input: { attachmentId: "pending-live-pdf" },
        },
        expect.anything(),
      ],
    ]);
  });

  it("releases an upload URL that resolves after its image was removed", async () => {
    const image = makeImage("image-cancelled");
    const minted = {
      _tag: "Success" as const,
      value: {
        attachmentId: "pending-environment-1-image-cancelled.png",
        relativeUrl: "/api/attachments/upload/cancelled",
        expiresAt: 1,
      },
    };
    let resolveMint: (result: typeof minted) => void = () => {};
    const pendingMint = new Promise<typeof minted>((resolve) => {
      resolveMint = resolve;
    });
    let resolveDelete: () => void = () => {};
    const deleted = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    mocks.runAtomCommand.mockImplementation((_registry: unknown, command: unknown) => {
      if (command === mocks.createUploadUrl) {
        return pendingMint;
      }
      resolveDelete();
      return Promise.resolve({ _tag: "Success", value: undefined });
    });

    startAttachmentUpload({ environmentId: firstEnvironment, image });
    releaseAttachmentUpload(image.id);
    resolveMint(minted);
    await deleted;

    expect(TestXmlHttpRequest.requests).toEqual([]);
    expect(readAttachmentUpload(image.id)).toBeUndefined();
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId: firstEnvironment,
        input: { attachmentId: minted.value.attachmentId },
      },
      expect.anything(),
    );
  });

  it.each(["image", "file"] as const)(
    "restores the previous environment after a replacement upload fails: %s",
    async (kind) => {
      const draftId = DraftId.make("draft-environment-roundtrip");
      const store = useComposerDraftStore.getState();
      const image = kind === "image" ? makeImage("image-move") : makeFile("file-move");
      const moveDraftTo = (environmentId: EnvironmentId) => {
        store.setProjectDraftThreadId(
          { environmentId, projectId: ProjectId.make("project") },
          draftId,
        );
        startAttachmentUpload({ environmentId, image, draftTarget: draftId });
      };
      try {
        if (image.type === "file") store.addFiles(draftId, [image]);
        moveDraftTo(firstEnvironment);
        await Promise.resolve();
        let settled = awaitAttachmentUploads([image.id]);
        TestXmlHttpRequest.requests[0]!.complete();
        await settled;

        moveDraftTo(secondEnvironment);
        await Promise.resolve();
        settled = awaitAttachmentUploads([image.id]);
        TestXmlHttpRequest.requests[1]!.complete(500);
        await settled;

        moveDraftTo(firstEnvironment);
        const attachmentId = `pending-environment-1-${image.name}`;
        expect(readAttachmentUpload(image.id)).toMatchObject({
          status: "ready",
          environmentId: firstEnvironment,
          attachmentId,
        });
        if (image.type === "file") {
          expect(store.getComposerDraft(draftId)?.files).toMatchObject([
            {
              id: image.id,
              uploadedAttachmentId: attachmentId,
              uploadEnvironmentId: firstEnvironment,
            },
          ]);
        }
      } finally {
        store.clearDraftThread(draftId);
      }
    },
  );

  it("does not let stalled uploads block another environment", async () => {
    const images = ["image-a", "image-b", "image-c", "image-d"].map(makeImage);
    for (const image of images) {
      startAttachmentUpload({ environmentId: firstEnvironment, image });
    }
    const otherEnvironmentImage = makeImage("image-other");
    startAttachmentUpload({ environmentId: secondEnvironment, image: otherEnvironmentImage });
    await Promise.resolve();

    expect(TestXmlHttpRequest.requests).toHaveLength(4);
    const otherRequest = TestXmlHttpRequest.requests.find((request) =>
      request.url?.includes("environment-2"),
    );
    expect(otherRequest).toBeDefined();

    for (const request of TestXmlHttpRequest.requests) {
      request.complete();
    }
    await Promise.all([
      ...images.slice(0, 3).map((image) => awaitAttachmentUploads([image.id])),
      awaitAttachmentUploads([otherEnvironmentImage.id]),
    ]);
    await Promise.resolve();
    TestXmlHttpRequest.requests[4]!.complete();
    await awaitAttachmentUploads([images[3]!.id]);
  });
});
