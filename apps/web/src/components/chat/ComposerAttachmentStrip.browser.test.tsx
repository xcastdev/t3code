import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { DraftId } from "../../composerDraftStore";
import { useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import { ComposerAttachmentFileList } from "./ComposerAttachmentStrip";

it("shows a draft upload failure when the connection loses upload capability", async () => {
  const environmentId = EnvironmentId.make("environment");
  const file = new File(["test"], "attachment.txt", { type: "text/plain" });
  const previous = useAttachmentUploadStore.getState();
  using _upload = {
    [Symbol.dispose]: () => useAttachmentUploadStore.setState(previous),
  };
  useAttachmentUploadStore.setState({
    uploadsByImageId: {
      attachment: { status: "failed", environmentId, reason: "Upload rejected (410)" },
    },
  });
  await using screen = await render(
    <div className="dark">
      <ComposerAttachmentFileList
        files={[
          {
            id: "attachment",
            type: "file",
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            file,
          },
        ]}
        resolvedTheme="dark"
        supportsAttachmentUploads={false}
        maxFileAttachmentBytes={null}
        fileStagingLimit={null}
        environmentId={environmentId}
        attachmentDraftTarget={DraftId.make("draft")}
        canOperateThread={true}
        onPreviewFile={() => {}}
        onRemoveFile={() => {}}
      />
    </div>,
  );

  const retry = screen.getByRole("button", { name: "Retry upload for attachment.txt" });
  await expect.element(screen.getByText("Upload rejected (410)")).toBeVisible();
  await expect.element(retry).toBeVisible();
  await expect.element(retry).toBeDisabled();
});
