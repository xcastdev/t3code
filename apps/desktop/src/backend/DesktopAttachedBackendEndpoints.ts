export interface DesktopAttachedBackendEndpoints {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

const canonicalHostname = (url: URL): string => url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

const isLoopbackHostname = (hostname: string): boolean => {
  if (hostname === "localhost" || hostname === "::1") return true;

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.slice(1).every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255)
  );
};

const isRootUrl = (url: URL): boolean =>
  url.username.length === 0 &&
  url.password.length === 0 &&
  url.pathname === "/" &&
  url.search.length === 0 &&
  url.hash.length === 0;

const hasQueryOrFragment = (value: string): boolean => value.includes("?") || value.includes("#");

export function parseDesktopAttachedBackendEndpoints(
  httpBaseUrl: string,
  wsBaseUrl: string,
): DesktopAttachedBackendEndpoints | null {
  try {
    if (httpBaseUrl !== httpBaseUrl.trim() || wsBaseUrl !== wsBaseUrl.trim()) return null;
    const http = new URL(httpBaseUrl);
    const ws = new URL(wsBaseUrl);
    const httpHostname = canonicalHostname(http);
    const wsHostname = canonicalHostname(ws);

    if (
      http.protocol !== "http:" ||
      ws.protocol !== "ws:" ||
      !isRootUrl(http) ||
      !isRootUrl(ws) ||
      hasQueryOrFragment(httpBaseUrl) ||
      hasQueryOrFragment(wsBaseUrl) ||
      !isLoopbackHostname(httpHostname) ||
      httpHostname !== wsHostname ||
      http.port !== ws.port
    ) {
      return null;
    }

    return {
      httpBaseUrl: http.toString(),
      wsBaseUrl: ws.toString(),
    };
  } catch {
    return null;
  }
}
