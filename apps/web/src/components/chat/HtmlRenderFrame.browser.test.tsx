import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  grant: vi.fn<() => { url: string; learnedRoute?: true }>(),
  hosted: vi.fn<(url: string) => boolean>(),
  verify: vi.fn<typeof import("~/browser/readVerifiedPreviewAsset").verifyPreviewIssuer>(),
  read: vi.fn<typeof import("~/browser/readVerifiedPreviewAsset").readVerifiedPreviewAsset>(),
  save: vi.fn(),
  prepare:
    vi.fn<typeof import("~/browser/readVerifiedPreviewAsset").prepareVerifiedPreviewSource>(),
}));
vi.mock(import("~/browser/readVerifiedPreviewAsset"), async (importOriginal) => ({
  ...(await importOriginal()),
  prepareVerifiedPreviewSource: mocks.prepare,
  verifyPreviewIssuer: mocks.verify,
  readVerifiedPreviewAsset: mocks.read,
}));
vi.mock(import("~/connection/hostedRelayAdmission"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostedAdmissionRequired: mocks.hosted,
}));
vi.mock(import("~/lib/saveBlob"), () => ({ saveBlob: mocks.save }));
vi.mock(import("../files/HostedAssetDocument"), () => ({
  HostedAssetDocument: ({ title }: { readonly title: string }) => <canvas aria-label={title} />,
}));
vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    ...mocks.grant(),
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));
vi.mock(import("~/assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetGrantRefresh: () => async () => ({ ...mocks.grant(), learnedRoute: false }),
}));

import { HtmlRenderFrame } from "./HtmlRenderFrame";

describe("HtmlRenderFrame", () => {
  it("checks the learned issuer before mounting the inline viewer or its full-screen copy", async () => {
    const environmentId = EnvironmentId.make("environment");
    const url = "https://issuer.test/api/assets/signed.token/report.html";
    mocks.hosted.mockReturnValue(false);
    mocks.grant.mockReturnValue({ url, learnedRoute: true });
    mocks.prepare.mockResolvedValueOnce(url);
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={environmentId}
        htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
        threadRef={undefined}
      />,
    );

    await expect
      .element(screen.getByTitle("Report"))
      .toHaveAttribute("referrerpolicy", "no-referrer");
    expect(mocks.prepare).toHaveBeenCalledWith(
      environmentId,
      url,
      expect.objectContaining({ html: true }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
    const expanded = screen.getByRole("dialog").getByTitle("Report");
    await expect.element(expanded).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect
      .element(expanded)
      .toHaveAttribute("csp", expect.stringContaining("https://issuer.test/api/assets/"));
  });

  it("uses the destination stream inline and fullscreen and downloads the signed original", async () => {
    const environmentId = EnvironmentId.make("environment");
    const url = "https://relay.test/api/assets/signed.token/report.html";
    const original = new Blob(["<p>Report</p>"], { type: "text/html" });
    mocks.hosted.mockImplementation((value) => value === url);
    mocks.grant.mockReturnValue({ url, learnedRoute: true });
    mocks.verify.mockResolvedValue(new URL(url));
    mocks.read.mockResolvedValueOnce(original);
    mocks.save.mockClear();

    await using screen = await render(
      <HtmlRenderFrame
        environmentId={environmentId}
        htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
        threadRef={undefined}
      />,
    );
    await expect.element(screen.getByLabelText("Report")).toBeInTheDocument();
    expect(document.querySelector(`iframe[src="${url}"]`)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
    const dialog = screen.getByRole("dialog");
    await expect.element(dialog.getByLabelText("Report")).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Download original" }));
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledWith(original, "Report.html"));
    expect(mocks.verify).toHaveBeenCalledWith(environmentId, url);
    expect(mocks.read).toHaveBeenCalledWith(environmentId, url);
  });

  it("reports leaving full screen when it unmounts while expanded", async () => {
    mocks.hosted.mockReturnValue(false);
    mocks.grant.mockReturnValue({ url: "about:blank" });
    const onFullscreenChange = vi.fn();
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
        threadRef={undefined}
        onFullscreenChange={onFullscreenChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    expect(onFullscreenChange).toHaveBeenLastCalledWith(true);

    await screen.unmount();
    expect(onFullscreenChange).toHaveBeenLastCalledWith(false);
  });
});
