import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { readVerifiedPreviewAsset } from "~/browser/readVerifiedPreviewAsset";
import { admittedAssetSource } from "./admittedAssetSource";

vi.mock("~/browser/readVerifiedPreviewAsset", () => ({
  readVerifiedPreviewAsset: vi.fn(),
}));

it("shares admitted static bytes and revokes the object URL when their last reader is disposed", async () => {
  const environmentId = EnvironmentId.make("fixture");
  const signed = "https://alias.test/api/assets/fixture/image.png?exact=%2F#view";
  const blob = new Blob(["image bytes"], { type: "image/png" });
  vi.mocked(readVerifiedPreviewAsset).mockResolvedValueOnce(blob);
  using createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:local");
  using revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const registry = AtomRegistry.make();
  try {
    const source = admittedAssetSource(environmentId, signed, "static", 123);
    expect(admittedAssetSource(environmentId, signed, "static", 123)).toBe(source);
    expect(admittedAssetSource(environmentId, signed, "static", 123, 1)).not.toBe(source);
    const settled = await new Promise((resolve) => {
      registry.subscribe(
        source,
        (result) => {
          if (result._tag !== "Initial") resolve(result);
        },
        { immediate: true },
      );
    });
    expect(settled).toMatchObject({ _tag: "Success", value: "blob:local#view" });
    expect(readVerifiedPreviewAsset).toHaveBeenCalledWith(
      environmentId,
      signed,
      expect.any(AbortSignal),
    );
    expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(blob);
  } finally {
    registry.dispose();
  }
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local");
});
