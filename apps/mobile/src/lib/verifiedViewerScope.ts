import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";

export function viewerEndpoint(
  access: DeviceHubAccess,
  rawUrl: string,
  transport: "http" | "ws",
): URL | null {
  try {
    const base = new URL(transport === "http" ? access.httpBase : access.wsBase);
    const url = new URL(rawUrl);
    if (
      access.credentials ||
      url.protocol !== (transport === "http" ? "https:" : "wss:") ||
      url.host !== base.host ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith(base.pathname + "/")
    )
      return null;
    for (const [name, expected] of Object.entries(access.query)) {
      const values = url.searchParams.getAll(name);
      if (values.length !== 1 || values[0] !== expected) return null;
    }
    return url;
  } catch {
    return null;
  }
}

export const verifiedViewerCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">`;
