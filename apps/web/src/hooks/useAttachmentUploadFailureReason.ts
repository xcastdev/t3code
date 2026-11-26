import { useGT } from "gt-react";
import type { AttachmentUploadState } from "../lib/attachmentUploadState";

export function useAttachmentUploadFailureReason() {
  const gt = useGT();
  return (upload: Extract<AttachmentUploadState, { status: "failed" }>) => {
    switch (upload.failure) {
      case "relay-retired":
        return gt("Upload outcome unknown because the relay route was retired.");
      case "outcome-unknown":
        return gt("The server did not confirm whether the upload finished.");
      default:
        return upload.reason;
    }
  };
}
