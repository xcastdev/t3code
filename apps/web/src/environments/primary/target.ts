import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopAttachedBackendTarget,
  type DesktopEnvironmentBootstrap,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";

const PrimaryEnvironmentTargetSource = Schema.Literals([
  "configured",
  "window-origin",
  "desktop-managed",
  "desktop-attached",
]);
type PrimaryEnvironmentTargetSource = typeof PrimaryEnvironmentTargetSource.Type;

const PrimaryEnvironmentUrlKind = Schema.Literals([
  "http-base-url",
  "websocket-base-url",
  "development-server-url",
  "window-location-url",
]);
type PrimaryEnvironmentUrlKind = typeof PrimaryEnvironmentUrlKind.Type;

export class PrimaryEnvironmentUrlInvalidError extends Schema.TaggedError<PrimaryEnvironmentUrlInvalidError>()(
  "PrimaryEnvironmentUrlInvalidError",
  {
    source: PrimaryEnvironmentTargetSource,
    urlKind: PrimaryEnvironmentUrlKind,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not parse ${this.urlKind} for the ${this.source} primary environment target.`;
  }
}

export class PrimaryEnvironmentProtocolUnsupportedError extends Schema.TaggedError<PrimaryEnvironmentProtocolUnsupportedError>()(
  "PrimaryEnvironmentProtocolUnsupportedError",
  {
    source: PrimaryEnvironmentTargetSource,
    protocol: Schema.String,
  },
) {
  override get message(): string {
    return `The ${this.source} primary environment target uses unsupported protocol ${this.protocol}.`;
  }
}

export class DesktopEnvironmentBootstrapIncompleteError extends Schema.TaggedError<DesktopEnvironmentBootstrapIncompleteError>()(
  "DesktopEnvironmentBootstrapIncompleteError",
  {
    hasHttpBaseUrl: Schema.Boolean,
    hasWsBaseUrl: Schema.Boolean,
  },
) {
  override get message(): string {
    const missing = [
      ...(this.hasHttpBaseUrl ? [] : ["httpBaseUrl"]),
      ...(this.hasWsBaseUrl ? [] : ["wsBaseUrl"]),
    ];
    return `Desktop bootstrap is missing ${missing.join(" and ")} for the local environment.`;
  }
}

export class DesktopAttachedBootstrapIncompleteError extends Schema.TaggedError<DesktopAttachedBootstrapIncompleteError>()(
  "DesktopAttachedBootstrapIncompleteError",
  {},
) {
  override get message(): string {
    return "The attached T3 Code server is missing its identity. Open Settings → Connections to refresh or detach it.";
  }
}

export class DesktopAttachmentUnavailableError extends Schema.TaggedError<DesktopAttachmentUnavailableError>()(
  "DesktopAttachmentUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The saved attached server can't be used: ${this.reason}. Attach it again or switch back to the bundled server.`;
  }
}

export class PrimaryEnvironmentDisabledError extends Schema.TaggedError<PrimaryEnvironmentDisabledError>()(
  "PrimaryEnvironmentDisabledError",
  {},
) {
  override get message(): string {
    return "The local environment is disabled.";
  }
}

export interface PrimaryEnvironmentTarget {
  readonly source: PrimaryEnvironmentTargetSource;
  readonly target: {
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
  };
  /**
   * The desktop attachment this target was read from. Every credential request for an
   * attached server carries it, so the main process can refuse a token minted for a
   * different endpoint, identity or attachment revision.
   */
  readonly attached?: DesktopAttachedBackendTarget;
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

function getDesktopLocalEnvironmentBootstrap(): DesktopEnvironmentBootstrap | null {
  const bootstraps = window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [];
  return bootstraps.find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID) ?? null;
}

function parseTargetUrl(input: {
  readonly rawValue: string;
  readonly baseUrl?: string;
  readonly source: PrimaryEnvironmentTargetSource;
  readonly urlKind: PrimaryEnvironmentUrlKind;
}): URL {
  try {
    return input.baseUrl === undefined
      ? new URL(input.rawValue)
      : new URL(input.rawValue, input.baseUrl);
  } catch (cause) {
    throw new PrimaryEnvironmentUrlInvalidError({
      source: input.source,
      urlKind: input.urlKind,
      cause,
    });
  }
}

function normalizeBaseUrl(
  rawValue: string,
  source: PrimaryEnvironmentTargetSource,
  urlKind: PrimaryEnvironmentUrlKind,
): string {
  return parseTargetUrl({
    rawValue,
    baseUrl: window.location.origin,
    source,
    urlKind,
  }).toString();
}

function swapBaseUrlProtocol(
  rawValue: string,
  nextProtocol: "http:" | "https:" | "ws:" | "wss:",
  urlKind: PrimaryEnvironmentUrlKind,
): string {
  const url = parseTargetUrl({
    rawValue,
    baseUrl: window.location.origin,
    source: "configured",
    urlKind,
  });
  url.protocol = nextProtocol;
  return url.toString();
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function resolveHttpRequestBaseUrl(primaryTarget: PrimaryEnvironmentTarget): string {
  const httpBaseUrl = primaryTarget.target.httpBaseUrl;
  const configuredDevServerUrl = import.meta.env.VITE_DEV_SERVER_URL?.trim();
  // The dev proxy forwards to the desktop-managed backend, never to an attached server.
  if (!configuredDevServerUrl || primaryTarget.source === "desktop-attached") {
    return httpBaseUrl;
  }

  const currentUrl = parseTargetUrl({
    rawValue: window.location.href,
    source: "window-origin",
    urlKind: "window-location-url",
  });
  const targetUrl = parseTargetUrl({
    rawValue: httpBaseUrl,
    source: primaryTarget.source,
    urlKind: "http-base-url",
  });
  const devServerUrl = parseTargetUrl({
    rawValue: configuredDevServerUrl,
    baseUrl: currentUrl.origin,
    source: "configured",
    urlKind: "development-server-url",
  });

  const isCurrentOriginDevServer =
    (currentUrl.protocol === "http:" || currentUrl.protocol === "https:") &&
    currentUrl.origin === devServerUrl.origin;

  if (
    !isCurrentOriginDevServer ||
    currentUrl.origin === targetUrl.origin ||
    !isLoopbackHostname(currentUrl.hostname) ||
    !isLoopbackHostname(targetUrl.hostname)
  ) {
    return httpBaseUrl;
  }

  return currentUrl.origin;
}

function resolveConfiguredPrimaryTarget(): PrimaryEnvironmentTarget | null {
  const configuredHttpBaseUrl = import.meta.env.VITE_HTTP_URL?.trim() || undefined;
  const configuredWsBaseUrl = import.meta.env.VITE_WS_URL?.trim() || undefined;

  if (!configuredHttpBaseUrl && !configuredWsBaseUrl) {
    return null;
  }

  // Scheme checks run on the raw configured string, while the URL parser
  // folds schemes to lowercase ("WSS://host" parses fine). Without the
  // case folding an uppercase scheme would be classified as plaintext and
  // swapped to http/ws, silently downgrading TLS.
  const resolvedHttpBaseUrl =
    configuredHttpBaseUrl ??
    (configuredWsBaseUrl?.toLowerCase().startsWith("wss:")
      ? swapBaseUrlProtocol(configuredWsBaseUrl, "https:", "websocket-base-url")
      : swapBaseUrlProtocol(configuredWsBaseUrl!, "http:", "websocket-base-url"));
  const resolvedWsBaseUrl =
    configuredWsBaseUrl ??
    (configuredHttpBaseUrl?.toLowerCase().startsWith("https:")
      ? swapBaseUrlProtocol(configuredHttpBaseUrl, "wss:", "http-base-url")
      : swapBaseUrlProtocol(configuredHttpBaseUrl!, "ws:", "http-base-url"));

  return {
    source: "configured",
    target: {
      httpBaseUrl: normalizeBaseUrl(resolvedHttpBaseUrl, "configured", "http-base-url"),
      wsBaseUrl: normalizeBaseUrl(resolvedWsBaseUrl, "configured", "websocket-base-url"),
    },
  };
}

function resolveWindowOriginPrimaryTarget(): PrimaryEnvironmentTarget {
  const url = parseTargetUrl({
    rawValue: window.location.origin,
    source: "window-origin",
    urlKind: "http-base-url",
  });
  const httpBaseUrl = url.toString();
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    throw new PrimaryEnvironmentProtocolUnsupportedError({
      source: "window-origin",
      protocol: url.protocol,
    });
  }
  return {
    source: "window-origin",
    target: {
      httpBaseUrl,
      wsBaseUrl: url.toString(),
    },
  };
}

let unavailableAttachment: DesktopAttachmentUnavailableError | null = null;
let attachmentCheck: Promise<void> | null = null;

/**
 * An unusable saved attachment leaves the desktop with no primary bootstrap, which reads
 * the same as a managed backend that is still starting. Only the main process knows which
 * it is, so the async entry points ask once before anything falls back to the page origin.
 * Attaching and detaching relaunch the app, so the answer holds for this page.
 */
export function verifyDesktopPrimaryAttachment(): Promise<void> {
  attachmentCheck ??= (async () => {
    const bridge = window.desktopBridge;
    if (bridge === undefined || isLocalEnvironmentDisabled()) return;
    if (getDesktopLocalEnvironmentBootstrap() !== null) return;
    const state = await bridge.getPrimaryBackendState();
    if (state.mode === "invalid-attached") {
      unavailableAttachment = new DesktopAttachmentUnavailableError({ reason: state.reason });
    }
  })().catch((cause: unknown) => {
    attachmentCheck = null;
    throw cause;
  });
  return attachmentCheck.then(() => {
    if (unavailableAttachment !== null) throw unavailableAttachment;
  });
}

export function __resetDesktopPrimaryAttachmentForTests(): void {
  unavailableAttachment = null;
  attachmentCheck = null;
}

function resolveDesktopPrimaryTarget(): PrimaryEnvironmentTarget | null {
  if (unavailableAttachment !== null) throw unavailableAttachment;
  const desktopBootstrap = getDesktopLocalEnvironmentBootstrap();
  if (!desktopBootstrap) {
    return null;
  }
  if (!desktopBootstrap.httpBaseUrl && !desktopBootstrap.wsBaseUrl) {
    return null;
  }
  if (!desktopBootstrap.httpBaseUrl || !desktopBootstrap.wsBaseUrl) {
    throw new DesktopEnvironmentBootstrapIncompleteError({
      hasHttpBaseUrl: Boolean(desktopBootstrap.httpBaseUrl),
      hasWsBaseUrl: Boolean(desktopBootstrap.wsBaseUrl),
    });
  }

  if (desktopBootstrap.ownership === "attached") {
    if (!desktopBootstrap.environmentId || !desktopBootstrap.attachmentRevision) {
      throw new DesktopAttachedBootstrapIncompleteError();
    }
    const httpBaseUrl = normalizeBaseUrl(
      desktopBootstrap.httpBaseUrl,
      "desktop-attached",
      "http-base-url",
    );
    const wsBaseUrl = normalizeBaseUrl(
      desktopBootstrap.wsBaseUrl,
      "desktop-attached",
      "websocket-base-url",
    );
    return {
      source: "desktop-attached",
      target: { httpBaseUrl, wsBaseUrl },
      // The main process compares these verbatim, so they stay exactly as the bridge sent them.
      attached: {
        httpBaseUrl: desktopBootstrap.httpBaseUrl,
        wsBaseUrl: desktopBootstrap.wsBaseUrl,
        environmentId: desktopBootstrap.environmentId,
        attachmentRevision: desktopBootstrap.attachmentRevision,
      },
    };
  }

  return {
    source: "desktop-managed",
    target: {
      httpBaseUrl: normalizeBaseUrl(
        desktopBootstrap.httpBaseUrl,
        "desktop-managed",
        "http-base-url",
      ),
      wsBaseUrl: normalizeBaseUrl(
        desktopBootstrap.wsBaseUrl,
        "desktop-managed",
        "websocket-base-url",
      ),
    },
  };
}

export function resolvePrimaryEnvironmentHttpUrl(
  pathname: string,
  searchParams?: Record<string, string>,
): string {
  const primaryTarget = readPrimaryEnvironmentTarget();
  if (!primaryTarget) {
    throw new PrimaryEnvironmentDisabledError();
  }

  const url = parseTargetUrl({
    rawValue: resolveHttpRequestBaseUrl(primaryTarget),
    source: primaryTarget.source,
    urlKind: "http-base-url",
  });
  url.pathname = pathname;
  if (searchParams) {
    url.search = new URLSearchParams(searchParams).toString();
  }
  return url.toString();
}

// Null only when the desktop app runs with its local environment disabled;
// every other host has a primary (falling back to the page origin).
export function readPrimaryEnvironmentTarget(): PrimaryEnvironmentTarget | null {
  if (isLocalEnvironmentDisabled()) {
    return null;
  }
  return (
    resolveDesktopPrimaryTarget() ??
    resolveConfiguredPrimaryTarget() ??
    resolveWindowOriginPrimaryTarget()
  );
}
