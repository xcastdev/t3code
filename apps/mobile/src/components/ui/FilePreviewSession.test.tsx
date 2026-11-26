import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  AssetWorkspaceAssetNotFoundError,
  EnvironmentId,
  SOURCE_CONTROL_MEDIA_ASSET,
  ThreadId,
} from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  refreshAssetUrl:
    vi.fn<(environmentId: string, resource: { url: string }) => Promise<string | null>>(),
  alert: vi.fn(),
  download: vi.fn(),
  initializeVerifiedRoutes: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  supportsVerifiedRoutes: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  native: {
    presentFiles: vi.fn(),
    presentFile: vi.fn(),
    updateFile: vi.fn(),
    dismissFile: vi.fn(),
    isFilePreviewFinished: () => false,
  },
  previews: [] as unknown[],
  mounts: 0,
  presentationFinished: false,
}));

vi.mock("../../state/assets", () => ({ refreshAssetUrl: harness.refreshAssetUrl }));
vi.mock("../../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("../../lib/attachmentDownload", () => ({
  downloadAndShareAttachment: vi.fn(),
  downloadAttachmentForPreview: harness.download,
  nativeViewerErrorMessage: () => "",
  shareLocalAttachment: vi.fn(),
}));
vi.mock("../../connection/verified-route", () => ({
  initializeVerifiedRoutes: harness.initializeVerifiedRoutes,
  supportsVerifiedRoutes: harness.supportsVerifiedRoutes,
  verificationRequiredFor: (url: string) => url.startsWith("https://pinned.test/"),
}));
vi.mock("../../lib/previewPresentation", () => ({ usePreviewPresentation: () => {} }));
vi.mock("./Dialog", () => ({ alert: harness.alert }));
vi.mock("expo", () => ({ requireNativeModule: () => harness.native }));

import type { FilePreviewItem, FilePreviewViewerProps } from "./FilePreviewModal.types";
import { FilePreviewSession } from "./FilePreviewSession";
import { FilePreviewModal } from "./FilePreviewModal";

function Viewer(props: FilePreviewViewerProps) {
  useState(() => harness.mounts++);
  harness.previews.push(props.source);
  const { onPresent } = props;
  // Stands in for the native presentation starting.
  useEffect(() => onPresent?.(() => harness.presentationFinished), [onPresent]);
  return null;
}

const environmentId = EnvironmentId.make("environment");
const image = (url: string): FilePreviewItem => ({
  kind: "image",
  environmentId,
  resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: "/repo", url },
});

async function openGallery(
  selected: FilePreviewItem,
  gallery: readonly FilePreviewItem[],
  progressiveGallery: boolean,
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.previews.length = 0;
  harness.mounts = 0;
  harness.alert.mockClear();
  const root = createRoot(document.createElement("div"));
  const onRequestClose = vi.fn();
  await act(async () =>
    root.render(
      <FilePreviewSession
        source={{ ...selected, gallery }}
        onRequestClose={onRequestClose}
        progressiveGallery={progressiveGallery}
        Viewer={Viewer}
      />,
    ),
  );
  return { onRequestClose, [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
}

it.each([true, false])(
  "keeps the gallery stable while a sibling is still resolving (progressive: %s)",
  async (progressiveGallery) => {
    const slow = Promise.withResolvers<string>();
    harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) =>
      resource.url.endsWith("slow.png") ? slow.promise : "https://signed.test/a.png",
    );
    const selected = image("https://github.com/a.png");
    await using _preview = await openGallery(
      selected,
      [image("https://github.com/slow.png"), selected],
      progressiveGallery,
    );

    if (progressiveGallery) {
      expect(harness.previews.at(-1)).toMatchObject({
        kind: "image",
        selectedIndex: 1,
        images: [
          expect.not.objectContaining({ uri: expect.anything() }),
          { uri: "https://signed.test/a.png" },
        ],
      });
    } else {
      expect(harness.previews).toEqual([]);
    }
    await act(async () => slow.resolve("https://signed.test/slow.png"));
    expect(harness.previews.at(-1)).toMatchObject({
      selectedIndex: 1,
      images: [{ uri: "https://signed.test/slow.png" }, { uri: "https://signed.test/a.png" }],
    });
    expect(harness.mounts).toBe(1);
  },
);

it.each([true, false])(
  "hands the viewer only local files for a verified gallery (progressive: %s)",
  async (progressiveGallery) => {
    const slow = Promise.withResolvers<{ uri: string; dispose: () => void }>();
    harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) =>
      resource.url.endsWith("slow.png")
        ? "https://pinned.test/slow.png?ticket=slow"
        : "https://pinned.test/a.png?ticket=selected",
    );
    harness.download.mockImplementation(async ({ url }: { url: string }) => {
      if (url.includes("/slow.png")) return slow.promise;
      return {
        uri: url.includes("/a.png") ? "file:///cache/a.png" : "file:///cache/bare.png",
        dispose: vi.fn(),
      };
    });
    const selected = {
      ...image("https://github.com/a.png"),
      name: "Selected.png",
      mimeType: "image/png",
      srcFragment: "#view",
      sourceIdentifier: "thumbnail",
    };
    const bare: FilePreviewItem = {
      kind: "image",
      uri: "https://pinned.test/bare.png?ticket=bare#page",
    };
    await using _preview = await openGallery(
      selected,
      [image("https://github.com/slow.png"), selected, bare],
      progressiveGallery,
    );
    expect(JSON.stringify(harness.previews)).not.toContain("pinned.test");
    if (progressiveGallery) {
      expect(harness.previews.at(-1)).toMatchObject({
        selectedIndex: 1,
        images: [
          expect.not.objectContaining({ uri: expect.anything() }),
          {
            uri: "file:///cache/a.png#view",
            name: "Selected.png",
            mimeType: "image/png",
            sourceIdentifier: "thumbnail",
          },
          { uri: "file:///cache/bare.png#page" },
        ],
      });
    } else {
      expect(harness.previews).toEqual([]);
    }
    await act(async () => slow.resolve({ uri: "file:///cache/slow.png", dispose: vi.fn() }));
    expect(harness.previews.at(-1)).toMatchObject({
      images: [
        { uri: "file:///cache/slow.png" },
        { uri: "file:///cache/a.png#view" },
        { uri: "file:///cache/bare.png#page" },
      ],
    });
    expect(harness.mounts).toBe(1);
    expect(harness.download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://pinned.test/a.png?ticket=selected",
        attachment: { name: "Selected.png", mimeType: "image/png" },
        requireVerified: true,
      }),
    );
  },
);

it.each(["wrong pin", "missing enrollment", "missing native capability"])(
  "fails closed for a verified document with %s",
  async (message) => {
    harness.download.mockReset().mockRejectedValue(new Error(message));
    if (message === "missing native capability") {
      harness.supportsVerifiedRoutes.mockResolvedValueOnce(false);
    }
    const selected: FilePreviewItem = {
      kind: "document",
      uri: "https://pinned.test/report.docx?ticket=document",
    };
    await using preview = await openGallery(selected, [], false);
    expect(harness.previews).toEqual([]);
    expect(preview.onRequestClose).toHaveBeenCalledOnce();
    if (message === "missing native capability") expect(harness.download).not.toHaveBeenCalled();
  },
);

it("withholds an unclassified bare URL when cold enrollment loading fails", async () => {
  harness.initializeVerifiedRoutes.mockRejectedValueOnce(new Error("SecureStore unavailable"));
  await using preview = await openGallery(
    { kind: "image", uri: "https://not-loaded.test/image.png?ticket=secret" },
    [],
    false,
  );
  expect(harness.previews).toEqual([]);
  expect(preview.onRequestClose).toHaveBeenCalledOnce();
});

it("passes an explicit direct document URL through to the viewer", async () => {
  harness.download.mockClear();
  const uri = "https://direct.test/report.pdf?ticket=direct#page=2";
  await using _preview = await openGallery({ kind: "pdf", uri }, [], false);
  expect(harness.previews.at(-1)).toMatchObject({ kind: "pdf", uri });
  expect(harness.download).not.toHaveBeenCalled();
});

it("keeps files from initial and progressive native handoffs until dismissal", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const slow = Promise.withResolvers<{ uri: string; dispose: () => void }>();
  const selected = { kind: "image", uri: "file:///selected.png" } as const;
  const bare = { kind: "image", uri: "https://pinned.test/bare.png" } as const;
  const neighbor = image("https://github.com/slow.png");
  const disposeBare = vi.fn();
  const disposeSlow = vi.fn();
  const disposeDocument = vi.fn();
  harness.refreshAssetUrl.mockResolvedValue("https://pinned.test/slow.png");
  harness.download.mockImplementation(async ({ url }: { url: string }) => {
    if (url.endsWith("/slow.png")) return slow.promise;
    if (url.endsWith("/document.pdf"))
      return { uri: "file:///cache/document.pdf", dispose: disposeDocument };
    return { uri: "file:///cache/bare.png", dispose: disposeBare };
  });
  harness.native.presentFiles.mockReset().mockReturnValue(first.promise);
  harness.native.presentFile.mockReset().mockReturnValue(second.promise);
  harness.native.updateFile.mockResolvedValue(undefined);
  harness.native.dismissFile.mockResolvedValue(undefined);
  const root = createRoot(document.createElement("div"));
  await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
  const onRequestClose = vi.fn();
  const render = (source: Parameters<typeof FilePreviewModal>[0]["source"]) =>
    act(async () =>
      root.render(<FilePreviewModal source={source} onRequestClose={onRequestClose} />),
    );

  await render({ ...selected, gallery: [bare, selected, neighbor] });
  expect(harness.native.presentFiles).toHaveBeenCalledWith(
    [null, "file:///selected.png", null],
    expect.any(Array),
    1,
    expect.any(Array),
    expect.any(String),
  );
  await act(async () => slow.resolve({ uri: "file:///cache/slow.png", dispose: disposeSlow }));
  expect(harness.native.updateFile).toHaveBeenCalledWith(
    expect.any(String),
    0,
    "file:///cache/bare.png",
  );
  expect(harness.native.updateFile).toHaveBeenCalledWith(
    expect.any(String),
    2,
    "file:///cache/slow.png",
  );

  await render({ kind: "pdf", uri: "https://pinned.test/document.pdf", name: "document" });
  expect(harness.download).toHaveBeenCalledWith(
    expect.objectContaining({ attachment: { name: "document.pdf", mimeType: "application/pdf" } }),
  );
  expect(harness.native.presentFile).toHaveBeenCalledWith(
    "file:///cache/document.pdf",
    "document",
    "",
    expect.any(String),
  );
  expect(disposeBare).not.toHaveBeenCalled();
  expect(disposeSlow).not.toHaveBeenCalled();
  await act(async () => first.resolve());
  expect(disposeBare).toHaveBeenCalledOnce();
  expect(disposeSlow).toHaveBeenCalledOnce();
  expect(onRequestClose).not.toHaveBeenCalled();

  await render(null);
  expect(disposeDocument).not.toHaveBeenCalled();
  await act(async () => second.resolve());
  expect(disposeDocument).toHaveBeenCalledOnce();
  expect(onRequestClose).not.toHaveBeenCalled();
});

it("cancels pending verified downloads on close and source change", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const pending: AbortSignal[] = [];
  harness.download.mockImplementation(({ signal }: { signal: AbortSignal }) => {
    pending.push(signal);
    return new Promise(() => {});
  });
  const root = createRoot(document.createElement("div"));
  await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
  const render = (uri: string | null) =>
    act(async () =>
      root.render(
        <FilePreviewSession
          source={uri === null ? null : { kind: "document", uri }}
          onRequestClose={() => {}}
          progressiveGallery={false}
          Viewer={Viewer}
        />,
      ),
    );
  await render("https://pinned.test/a.pdf");
  await render("https://pinned.test/b.pdf");
  expect(pending.map((signal) => signal.aborted)).toEqual([true, false]);
  await render(null);
  expect(pending.map((signal) => signal.aborted)).toEqual([true, true]);
});

it.each([true, false])(
  "handles a failed sibling without leaving a pending page (progressive: %s)",
  async (progressiveGallery) => {
    harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => {
      if (resource.url.endsWith("missing.png")) throw new Error("not found");
      return `https://signed.test/${resource.url.split("/").pop()}`;
    });
    const selected = image("https://github.com/a.png");
    await using preview = await openGallery(
      selected,
      [selected, image("https://github.com/missing.png"), image("https://github.com/c.png")],
      progressiveGallery,
    );

    if (!progressiveGallery) {
      expect(preview.onRequestClose).toHaveBeenCalledOnce();
      expect(harness.alert).toHaveBeenCalledOnce();
      expect(harness.previews).toEqual([]);
      return;
    }

    expect(preview.onRequestClose).not.toHaveBeenCalled();
    expect(harness.alert).not.toHaveBeenCalled();
    expect(harness.previews.at(-1)).toMatchObject({
      selectedIndex: 0,
      images: [
        { uri: "https://signed.test/a.png" },
        { failed: true },
        { uri: "https://signed.test/c.png" },
      ],
    });
  },
);

it("closes the preview when the selected image cannot be resolved", async () => {
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => {
    if (resource.url.endsWith("missing.png")) throw new Error("not found");
    return `https://signed.test/${resource.url.split("/").pop()}`;
  });
  const selected = image("https://github.com/missing.png");
  await using preview = await openGallery(
    selected,
    [image("https://github.com/a.png"), selected],
    true,
  );

  expect(preview.onRequestClose).toHaveBeenCalledOnce();
  expect(harness.alert).toHaveBeenCalledOnce();
});

it("names the checked path when the server cannot find the file", async () => {
  const resource = {
    _tag: "media-file" as const,
    threadId: ThreadId.make("thread"),
    path: "v2/extended/duo-color-3-extended-FINAL.png",
  };
  const checkedPath = "/repo/v2/extended/duo-color-3-extended-FINAL.png";
  harness.refreshAssetUrl.mockRejectedValue(
    new AssetWorkspaceAssetNotFoundError({ resource, checkedPath }),
  );
  const selected: FilePreviewItem = { kind: "image", environmentId, resource };
  await using preview = await openGallery(selected, [selected], false);

  expect(preview.onRequestClose).toHaveBeenCalledOnce();
  expect(harness.alert).toHaveBeenCalledWith(
    "Could not open preview",
    expect.stringContaining(checkedPath),
  );
  expect(harness.alert.mock.calls[0]?.[1]).not.toMatch(/reconnect/i);
});

it.each([
  // Handed to native but not yet started there, or still on screen.
  ["image", false, 1],
  ["image", true, 2],
  // A PDF is still resolving here, so its viewer never presented and a re-render must not restart it.
  ["pdf", true, 1],
] as const)(
  "a re-tap of the open %s restarts the preview only once its native viewer closed (closed: %s)",
  async (kind, finished, starts) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    harness.presentationFinished = finished;
    harness.mounts = 0;
    harness.refreshAssetUrl.mockReset();
    if (kind === "image") harness.refreshAssetUrl.mockResolvedValue("https://signed.test/a.png");
    else harness.refreshAssetUrl.mockReturnValue(new Promise(() => {}));
    const selected: FilePreviewItem = { ...image("https://github.com/a.png"), kind };
    const root = createRoot(document.createElement("div"));
    await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
    const render = () =>
      act(async () =>
        root.render(
          <FilePreviewSession
            source={{ ...selected, gallery: [selected] }}
            onRequestClose={() => {}}
            progressiveGallery
            Viewer={Viewer}
          />,
        ),
      );
    await render();
    await render();
    expect(harness.refreshAssetUrl).toHaveBeenCalledTimes(starts);
  },
);

it("does not carry a presented viewer over to a different item that is still resolving", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.presentationFinished = true;
  harness.refreshAssetUrl.mockReset();
  harness.refreshAssetUrl.mockImplementation((_environmentId, resource) =>
    resource.url.endsWith("a.png")
      ? Promise.resolve("https://signed.test/a.png")
      : new Promise(() => {}),
  );
  const shown = image("https://github.com/a.png");
  const resolving: FilePreviewItem = { ...image("https://github.com/b.pdf"), kind: "pdf" };
  const root = createRoot(document.createElement("div"));
  await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
  const render = (item: FilePreviewItem) =>
    act(async () =>
      root.render(
        <FilePreviewSession
          source={{ ...item, gallery: [item] }}
          onRequestClose={() => {}}
          progressiveGallery
          Viewer={Viewer}
        />,
      ),
    );
  await render(shown);
  await render(resolving);
  await render(resolving);
  expect(
    harness.refreshAssetUrl.mock.calls.filter(([, r]) => r.url.endsWith("b.pdf")),
  ).toHaveLength(1);
});
