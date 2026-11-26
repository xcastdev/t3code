import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROJECT_FAVICON_MAX_DATA_URL_LENGTH } from "@t3tools/client-runtime/project-favicon-cache";
import { EnvironmentId } from "@t3tools/contracts";

const native = vi.hoisted(() => ({
  load: vi.fn(async (_url: string, options: { maxWidth: number; maxHeight: number }) => ({
    width: options.maxWidth,
    height: options.maxHeight,
    release: vi.fn(),
  })),
  write: vi.fn(async () => {}),
  path: vi.fn(async () => "/cache/thumbnail"),
  read: vi.fn(),
  remove: vi.fn(),
}));
const secureValues = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => secureValues.get(key) ?? null,
}));
vi.mock("expo-image", () => ({
  Image: {
    loadAsync: native.load,
    writeToCacheAsync: native.write,
    getCachePathAsync: native.path,
  },
}));
vi.mock("../native/verifiedNetwork", () => ({
  fetchRoute: async () => {
    throw new Error("Pinned route unavailable");
  },
}));
vi.mock("expo-file-system", () => ({
  File: class {
    size = 24_000;
    base64 = native.read;
    delete = native.remove;
  },
}));

import {
  downscaleProjectFavicon,
  projectFaviconDatabaseCache,
} from "./projectFaviconDatabaseCache";

const png = "iVBORw0KGgoAAAAA";
const image = {
  url: "https://remote/icon.png",
  mimeType: "image/png",
  bytes: new Uint8Array([1, 2]),
};

beforeEach(() => {
  vi.clearAllMocks();
  native.read.mockReset().mockResolvedValue(png);
  native.load.mockReset().mockImplementation(async (_url, { maxWidth }) => ({
    width: maxWidth,
    height: maxWidth,
    release: vi.fn(),
  }));
});

describe("mobile project icon thumbnails", () => {
  it("does not fall back to the signed URL after a required issuer loses its enrollment", async () => {
    const url = "https://favicon-required.example.test/api/assets/signed/icon.png";
    secureValues.set(
      "t3code.verified-route-policy.v1",
      JSON.stringify({ [new URL(url).origin]: "verified" }),
    );
    await expect(
      projectFaviconDatabaseCache.resolve(
        {
          environmentId: EnvironmentId.make("favicon-required"),
          cwd: "/fixture",
          faviconPath: "icon.png",
        },
        url,
        new AbortController().signal,
      ),
    ).resolves.toBeNull();
    expect(native.load).not.toHaveBeenCalled();
  });

  it("reduces an oversized encoding and deletes temporary thumbnail files", async () => {
    native.read.mockResolvedValueOnce(
      `iVBORw0KGgo${"a".repeat(PROJECT_FAVICON_MAX_DATA_URL_LENGTH)}`,
    );
    const thumbnail = await downscaleProjectFavicon(image, new AbortController().signal);
    expect(thumbnail).toBe(`data:image/png;base64,${png}`);
    expect(native.load.mock.calls.map(([, options]) => options.maxWidth)).toEqual([96, 48]);
    expect(native.remove).toHaveBeenCalledTimes(2);
    for (const call of native.load.mock.results)
      expect((await call.value).release).toHaveBeenCalledOnce();
  });

  it("releases a decoded image when its request was canceled", async () => {
    const controller = new AbortController();
    const release = vi.fn();
    native.load.mockImplementationOnce(async () => {
      controller.abort();
      return { width: 96, height: 96, release };
    });
    await expect(downscaleProjectFavicon(image, controller.signal)).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce();
    expect(native.write).not.toHaveBeenCalled();
  });

  it("rejects an image the native decoder did not downsize", async () => {
    const release = vi.fn();
    native.load.mockResolvedValueOnce({ width: 4000, height: 3000, release });
    await expect(downscaleProjectFavicon(image, new AbortController().signal)).rejects.toThrow(
      "not resized",
    );
    expect(native.write).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
