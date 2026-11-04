/** Downloads a blob through an anchor; Electron routes it through its download handler. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Browsers may start downloading after the click's task; defer revocation.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
