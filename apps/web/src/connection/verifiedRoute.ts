import { VerifiedRouteBindingSchema } from "@t3tools/contracts";
import { VerifiedRoutePolicy } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const browserBindingSchema = Schema.Struct({
  ...VerifiedRouteBindingSchema.fields,
  viewerRedirects: Schema.optional(Schema.Literal("refused")),
});
const decodeBrowserBindings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([browserBindingSchema, Schema.Array(browserBindingSchema)])),
);

function loadBrowserBindings() {
  const decoded = decodeBrowserBindings(import.meta.env.VITE_VERIFIED_BROWSER_ROUTE);
  if (decoded._tag === "None") return new Map<string, typeof browserBindingSchema.Type>();
  const bindings = "httpsOrigin" in decoded.value ? [decoded.value] : decoded.value;
  const byOrigin = new Map<string, typeof browserBindingSchema.Type>();
  for (const binding of bindings) {
    if (byOrigin.has(binding.httpsOrigin) || binding.leafSpkiSha256 !== undefined) {
      return new Map<string, typeof browserBindingSchema.Type>();
    }
    byOrigin.set(binding.httpsOrigin, {
      ...binding,
      transportRole: binding.transportRole ?? "direct",
    });
  }
  return byOrigin;
}

const browserBindings = loadBrowserBindings();

export function listOperatorBrowserBindings() {
  return typeof window !== "undefined" && window.desktopBridge === undefined
    ? Array.from(browserBindings.values())
    : [];
}

export function readOperatorBrowserBinding(origin: string) {
  return typeof window !== "undefined" && window.desktopBridge === undefined
    ? (browserBindings.get(origin) ?? null)
    : null;
}

export function isOperatorBoundBrowserRoute(url: URL): boolean {
  return (
    typeof window !== "undefined" &&
    window.desktopBridge === undefined &&
    browserBindings.has(url.origin)
  );
}

// Native browser loaders follow redirects. The ingress must refuse them and accept the viewer CSP on signed HTML.
export function supportsOperatorBoundBrowserViewer(url: URL): boolean {
  return (
    isOperatorBoundBrowserRoute(url) &&
    browserBindings.get(url.origin)?.viewerRedirects === "refused"
  );
}

export const verifiedRoutePolicy = VerifiedRoutePolicy.of({
  readEnrollment: Effect.fn("VerifiedRoutePolicy.readEnrollment")(function* (httpsOrigin) {
    if (typeof window === "undefined") return null;
    const bridge = window.desktopBridge;
    if (bridge !== undefined) {
      return yield* Effect.promise(async () => {
        try {
          const binding = await bridge.getVerifiedRouteBinding?.(httpsOrigin);
          return binding?.httpsOrigin === httpsOrigin ? binding : null;
        } catch {
          return null;
        }
      });
    }
    return readOperatorBrowserBinding(httpsOrigin);
  }),
  enforce: Effect.fn("VerifiedRoutePolicy.enforce")((enrollment) =>
    Effect.sync(() =>
      window.desktopBridge !== undefined
        ? enrollment.leafSpkiSha256 !== undefined
        : browserBindings.has(enrollment.httpsOrigin),
    ),
  ),
});
