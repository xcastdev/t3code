import { it as effectIt } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";

const issuer = "https://issuer.test:8443";
const environmentId = EnvironmentId.make("enrolled-environment");

it.each([
  { scenario: "matching", origin: issuer, requestedEnvironment: environmentId, refuses: true },
  {
    scenario: "hosted relay without admission",
    origin: issuer,
    requestedEnvironment: environmentId,
    refuses: true,
  },
  {
    scenario: "environment-served relay uses its cookie",
    origin: issuer,
    requestedEnvironment: environmentId,
  },
  { scenario: "no ingress guarantee", origin: issuer, requestedEnvironment: environmentId },
  {
    scenario: "no browser CSP support",
    origin: issuer,
    requestedEnvironment: environmentId,
    refuses: true,
  },
  {
    scenario: "wrong port",
    origin: "https://issuer.test",
    requestedEnvironment: environmentId,
    refuses: true,
  },
  {
    scenario: "wrong environment",
    origin: issuer,
    requestedEnvironment: EnvironmentId.make("other"),
    refuses: true,
  },
])(
  "uses the browser viewer only for the exact enrolled ingress ($scenario)",
  async ({ scenario, origin, requestedEnvironment, refuses }) => {
    vi.resetModules();
    const hosted = scenario === "hosted relay without admission";
    const environmentServed = scenario === "environment-served relay uses its cookie";
    vi.stubGlobal("window", {
      location: { origin: environmentServed ? issuer : "https://hosted.example.test" },
    });
    vi.stubGlobal("document", {
      createElement: () => (scenario === "no browser CSP support" ? {} : { csp: "" }),
    });
    vi.stubEnv(
      "VITE_VERIFIED_BROWSER_ROUTE",
      JSON.stringify({
        httpsOrigin: issuer,
        environmentId,
        ...(hosted || environmentServed ? { transportRole: "relay" } : {}),
        ...(refuses ? { viewerRedirects: "refused" } : {}),
      }),
    );
    using fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("<p>report</p>", { headers: { "content-type": "text/html" } }),
      );
    try {
      const { prepareVerifiedPreviewSource } = await import("./readVerifiedPreviewAsset");
      const url = `${origin}/api/assets/signature/files/report.html`;
      const source = prepareVerifiedPreviewSource(requestedEnvironment, url, { html: true });
      if (scenario === "matching") {
        await expect(source).resolves.toBe(url);
        expect(fetch).not.toHaveBeenCalled();
      } else if (scenario === "no ingress guarantee" || scenario === "no browser CSP support") {
        await expect(source).resolves.toBeInstanceOf(Blob);
        expect(fetch).toHaveBeenCalledExactlyOnceWith(
          url,
          expect.objectContaining({ redirect: "error", credentials: "omit" }),
        );
      } else if (environmentServed) {
        await expect(source).resolves.toBeInstanceOf(Blob);
        expect(fetch).toHaveBeenCalledExactlyOnceWith(
          url,
          expect.objectContaining({ credentials: "same-origin", redirect: "error" }),
        );
      } else if (hosted) {
        await expect(source).rejects.toThrow("Unable to read");
        expect(fetch).not.toHaveBeenCalled();
      } else {
        await expect(source).rejects.toThrow(
          "The preview issuer does not match the installed route policy.",
        );
        expect(fetch).not.toHaveBeenCalled();
      }
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
);

effectIt.effect("reads operator transport roles independently for two public HTTPS origins", () =>
  Effect.gen(function* () {
    vi.resetModules();
    vi.stubGlobal("window", {});
    const direct = "https://direct.example.test";
    vi.stubEnv(
      "VITE_VERIFIED_BROWSER_ROUTE",
      JSON.stringify([
        { environmentId, httpsOrigin: issuer, transportRole: "relay" },
        { environmentId, httpsOrigin: direct, transportRole: "direct" },
      ]),
    );
    try {
      const { verifiedRoutePolicy } = yield* Effect.promise(
        () => import("~/connection/verifiedRoute"),
      );
      expect(yield* verifiedRoutePolicy.readEnrollment(issuer)).toEqual({
        environmentId,
        httpsOrigin: issuer,
        transportRole: "relay",
      });
      expect(yield* verifiedRoutePolicy.readEnrollment(direct)).toEqual({
        environmentId,
        httpsOrigin: direct,
        transportRole: "direct",
      });
      expect(yield* verifiedRoutePolicy.readEnrollment("https://issuer.test")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }),
);
