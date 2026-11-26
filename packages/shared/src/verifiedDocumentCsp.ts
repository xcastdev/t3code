export const VERIFIED_DOCUMENT_ASSET_PATH = "/api/assets/";

export function verifiedDocumentCsp(src: string): string {
  const assets = `${new URL(src).origin}${VERIFIED_DOCUMENT_ASSET_PATH}`;
  // The asset handler authenticates every token, including independent signed references.
  return [
    `default-src ${assets}`,
    `script-src ${assets} 'unsafe-inline'`,
    `style-src ${assets} 'unsafe-inline'`,
    `img-src ${assets} data: blob:`,
    `media-src ${assets} data: blob:`,
    `font-src ${assets} data:`,
    `frame-src ${assets} blob:`,
    `form-action ${assets}`,
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}
