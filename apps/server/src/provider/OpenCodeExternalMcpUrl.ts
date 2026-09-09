export class OpenCodeExternalMcpUrlError extends Error {
  readonly _tag = "OpenCodeExternalMcpUrlError" as const;
  readonly kind: "server" | "mcp-base" | "mcp-endpoint";
  readonly value: string;
  readonly reason: string;

  constructor(
    kind: "server" | "mcp-base" | "mcp-endpoint",
    value: string,
    reason: string,
    options?: { readonly cause?: unknown },
  ) {
    super(reason, options);
    this.name = "OpenCodeExternalMcpUrlError";
    this.kind = kind;
    this.value = value;
    this.reason = reason;
  }
}

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const ipv4 = normalized.split(".");
  return (
    ipv4.length === 4 &&
    ipv4[0] === "127" &&
    ipv4.slice(1).every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
  );
};

const parseAbsoluteUrl = (value: string, kind: OpenCodeExternalMcpUrlError["kind"]): URL => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new OpenCodeExternalMcpUrlError(kind, value, "The URL must not be empty.");
  }
  try {
    return new URL(trimmed);
  } catch (cause) {
    throw new OpenCodeExternalMcpUrlError(kind, value, "The URL must be absolute.", { cause });
  }
};

const assertNoCredentialsOrFragment = (
  url: URL,
  kind: OpenCodeExternalMcpUrlError["kind"],
  value: string,
): void => {
  if (url.username || url.password) {
    throw new OpenCodeExternalMcpUrlError(
      kind,
      value,
      "Credentials are not allowed in an external MCP URL.",
    );
  }
  if (url.hash) {
    throw new OpenCodeExternalMcpUrlError(
      kind,
      value,
      "Fragments are not allowed in an external MCP URL.",
    );
  }
};

const assertSafeTransport = (
  url: URL,
  kind: OpenCodeExternalMcpUrlError["kind"],
  value: string,
): void => {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OpenCodeExternalMcpUrlError(
      kind,
      value,
      "Use HTTPS, or use HTTP with a loopback host.",
    );
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new OpenCodeExternalMcpUrlError(
      kind,
      value,
      "HTTP is allowed only for localhost, 127.0.0.0/8, or ::1.",
    );
  }
};

export const validateExternalOpenCodeUrl = (value: string): string => {
  const url = parseAbsoluteUrl(value, "server");
  assertNoCredentialsOrFragment(url, "server", value);
  assertSafeTransport(url, "server", value);
  return url.toString();
};

export const validateExternalMcpBaseUrl = (value: string): string => {
  if (value.trim().length === 0) return "";
  const url = parseAbsoluteUrl(value, "mcp-base");
  assertNoCredentialsOrFragment(url, "mcp-base", value);
  if (url.search) {
    throw new OpenCodeExternalMcpUrlError(
      "mcp-base",
      value,
      "The T3 MCP public origin must not include a query string.",
    );
  }
  if (url.pathname !== "/") {
    throw new OpenCodeExternalMcpUrlError(
      "mcp-base",
      value,
      "The T3 MCP public origin must contain the root path '/'.",
    );
  }
  assertSafeTransport(url, "mcp-base", value);
  return url.origin;
};

const validateIssuedEndpoint = (value: string | URL): URL => {
  const raw = typeof value === "string" ? value : value.toString();
  const url = parseAbsoluteUrl(raw, "mcp-endpoint");
  assertNoCredentialsOrFragment(url, "mcp-endpoint", raw);
  assertSafeTransport(url, "mcp-endpoint", raw);
  return url;
};

export interface RebaseExternalMcpUrlInput {
  readonly issuedEndpoint: string | URL;
  readonly externalMcpBaseUrl: string;
  readonly serverUrl: string;
}

export function rebaseExternalMcpUrl(input: RebaseExternalMcpUrlInput): string;
export function rebaseExternalMcpUrl(
  issuedEndpoint: string | URL,
  externalMcpBaseUrl: string,
  serverUrl: string,
): string;
export function rebaseExternalMcpUrl(
  inputOrEndpoint: RebaseExternalMcpUrlInput | string | URL,
  externalMcpBaseUrl?: string,
  serverUrl?: string,
): string {
  const input: RebaseExternalMcpUrlInput =
    typeof inputOrEndpoint === "object" && !(inputOrEndpoint instanceof URL)
      ? inputOrEndpoint
      : {
          issuedEndpoint: inputOrEndpoint,
          externalMcpBaseUrl: externalMcpBaseUrl ?? "",
          serverUrl: serverUrl ?? "",
        };
  const issued = validateIssuedEndpoint(input.issuedEndpoint);
  const base = validateExternalMcpBaseUrl(input.externalMcpBaseUrl);
  const externalServerUrl = validateExternalOpenCodeUrl(input.serverUrl);
  const finalUrl =
    base.length === 0 ? issued : new URL(`${base}${issued.pathname}${issued.search}`);

  if (base.length === 0 && isLoopbackHostname(issued.hostname)) {
    const externalServer = new URL(externalServerUrl);
    if (!isLoopbackHostname(externalServer.hostname)) {
      throw new OpenCodeExternalMcpUrlError(
        "mcp-endpoint",
        issued.toString(),
        "OpenCode is remote but the issued T3 MCP endpoint is loopback. Set T3 MCP public origin.",
      );
    }
  }

  assertNoCredentialsOrFragment(finalUrl, "mcp-endpoint", finalUrl.toString());
  assertSafeTransport(finalUrl, "mcp-endpoint", finalUrl.toString());
  return finalUrl.toString();
}

export const isExternalOpenCodeLoopbackHost = isLoopbackHostname;
