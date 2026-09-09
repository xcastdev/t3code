import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  DesktopAttachPairingUrlError,
  resolveDesktopAttachPairingTarget,
} from "./DesktopAttachedBackend.ts";

describe("DesktopAttachedBackend", () => {
  it.effect("accepts only loopback HTTP pairing URLs and normalizes their targets", () =>
    Effect.gen(function* () {
      const target = yield* resolveDesktopAttachPairingTarget(
        "http://127.0.0.9:4100/pair#token=owner-token",
      );
      assert.equal(target.credential, "owner-token");
      assert.equal(target.httpBaseUrl, "http://127.0.0.9:4100/");
      assert.equal(target.wsBaseUrl, "ws://127.0.0.9:4100/");
    }),
  );

  it.effect("rejects remote, secure, and ambiguous pairing links", () =>
    Effect.gen(function* () {
      for (const pairingUrl of [
        "http://192.168.1.5:4100/pair#token=owner-token",
        "https://127.0.0.1:4100/pair#token=owner-token",
        "http://127.0.0.1:4100/pair?token=one#token=two",
        "http://127.0.0.1:4100/pair#token=owner-token&scope=all",
      ]) {
        const error = yield* resolveDesktopAttachPairingTarget(pairingUrl).pipe(Effect.flip);
        assert.instanceOf(error, DesktopAttachPairingUrlError);
        assert.notInclude(error.message, "owner-token");
      }
    }),
  );
});
