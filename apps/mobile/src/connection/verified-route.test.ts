import { describe, expect, it, vi } from "vite-plus/test";
import { requireOptionalNativeModule } from "expo";

import {
  isEnrollmentOnlyPairing,
  readVerifiedPairing,
  supportsVerifiedRoutes,
} from "./verified-route";

vi.mock("expo", () => ({ requireOptionalNativeModule: vi.fn(), Platform: { OS: "ios" } }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

const pin = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const pairing = (origin: string, params: string) => `${origin}/pair#token=one-time&${params}`;

describe("verified pairing", () => {
  it("binds the exact HTTPS origin, environment and TLS leaf pin from the approved link", () => {
    expect(
      readVerifiedPairing(
        pairing("https://example.com:8443", `environmentId=env&leafSpkiSha256=${pin}`),
      ),
    ).toEqual({
      httpsOrigin: "https://example.com:8443",
      environmentId: "env",
      leafSpkiSha256: pin,
    });
  });

  it.each([
    pairing("http://example.com", `environmentId=env&leafSpkiSha256=${pin}`),
    pairing("https://user@example.com", `environmentId=env&leafSpkiSha256=${pin}`),
    pairing("https://example.com", `leafSpkiSha256=${pin}`),
    pairing("https://example.com", "environmentId=env&leafSpkiSha256=malformed"),
    pairing("https://example.com", `environmentId=env&leafSpkiSha256=${pin}&environmentId=other`),
  ])("fails closed on malformed enrollment", (url) => {
    expect(() => readVerifiedPairing(url)).toThrow();
  });

  it("accepts a tokenless enrollment link without allowing mixed pairing modes", () => {
    const url = `https://relay.example.com/#environmentId=env&leafSpkiSha256=${pin}&enroll=1`;
    expect(isEnrollmentOnlyPairing(url)).toBe(true);
    expect(readVerifiedPairing(url)?.environmentId).toBe("env");
    expect(() => readVerifiedPairing(`${url}&token=one-time`)).toThrow();
  });

  it("preserves ordinary explicit direct pairing", () => {
    expect(readVerifiedPairing("http://192.168.1.1:3773/pair#token=once")).toBeNull();
  });
});

it("requires native support for pinned HTTP and WSS", async () => {
  vi.mocked(requireOptionalNativeModule)
    .mockReturnValueOnce(null)
    .mockReturnValueOnce({ connectVerified: vi.fn(), startVerifiedRequest: vi.fn() })
    .mockReturnValueOnce({
      connectVerified: vi.fn(),
      startVerifiedRequest: vi.fn(),
      cancelVerifiedRequest: vi.fn(),
    });
  await expect(supportsVerifiedRoutes()).resolves.toBe(false);
  await expect(supportsVerifiedRoutes()).resolves.toBe(false);
  await expect(supportsVerifiedRoutes()).resolves.toBe(true);
});
