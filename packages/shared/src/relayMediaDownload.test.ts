import { describe, expect, it } from "@effect/vitest";

import { boundRelayMediaRange, RELAY_MEDIA_RANGE_BYTES } from "./relayMediaDownload.ts";

describe("boundRelayMediaRange", () => {
  const window = RELAY_MEDIA_RANGE_BYTES;

  it.each([
    ["open-ended player range", "bytes=0-", `bytes=0-${window - 1}`],
    ["open-ended seek", "bytes=200000000-", `bytes=200000000-${200000000 + window - 1}`],
    ["oversized explicit range", "bytes=10-999999999", `bytes=10-${10 + window - 1}`],
    ["range that fits", "bytes=0-1", "bytes=0-1"],
    ["range exactly one window", `bytes=5-${5 + window - 1}`, `bytes=5-${5 + window - 1}`],
    ["suffix range", "bytes=-500", "bytes=-500"],
    ["multipart range", "bytes=0-1,4-5", "bytes=0-1,4-5"],
  ])("%s", (_name, input, expected) => {
    expect(boundRelayMediaRange(input)).toBe(expected);
  });

  it("leaves a request without a range unchanged", () => {
    expect(boundRelayMediaRange(null)).toBeNull();
  });
});
