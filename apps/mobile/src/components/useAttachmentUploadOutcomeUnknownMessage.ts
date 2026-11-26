import { useGT } from "gt-react-native";

export function useAttachmentUploadOutcomeUnknownMessage() {
  const gt = useGT();
  return (filename: string) =>
    gt("Couldn’t confirm the upload for {filename}. Remove the attachment to continue.", {
      filename,
    });
}
