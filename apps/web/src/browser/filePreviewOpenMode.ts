import { environmentRelayAdmissionRequired } from "~/connection/environmentTransport";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export const isRelayDocumentPath = (path: string): boolean => /\.(?:html?|svg)$/i.test(path);

export function isAdmittedPreviewDocument(path: string, url: string | undefined): boolean {
  return url !== undefined && isRelayDocumentPath(path) && environmentRelayAdmissionRequired(url);
}

export function filePreviewOpenMode(input: {
  readonly path: string;
  readonly httpBaseUrl: string | undefined;
  readonly canReadFiles: boolean;
  readonly canOperatePreview: boolean;
  readonly previewAvailable: boolean;
}) {
  if (!input.canReadFiles || input.httpBaseUrl === undefined) return null;
  if (isAdmittedPreviewDocument(input.path, input.httpBaseUrl)) return "admitted-document";
  return input.canOperatePreview && input.previewAvailable && isBrowserPreviewFile(input.path)
    ? "browser"
    : null;
}
