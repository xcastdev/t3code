import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveDesktopAttachPairingTarget } from "./DesktopAttachedBackend.ts";

describe("DesktopAttachedBackend pairing target", () => {
  it.effect("accepts a loopback owner link and strips the credential from endpoints", () =>
    Effect.gen(function* () {
      const target = yield* resolveDesktopAttachPairingTarget(
        "http://127.0.0.1:4773/pair#token=owner-credential",
      );
      assert.equal(target.httpBaseUrl, "http://127.0.0.1:4773/");
      assert.equal(target.wsBaseUrl, "ws://127.0.0.1:4773/");
      assert.equal(target.credential, "owner-credential");
    }),
  );

  it.effect("rejects remote URLs, userinfo, and unknown parameters", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://example.test:4773/pair#token=owner",
        "http://user:pass@127.0.0.1:4773/pair#token=owner",
        "http://127.0.0.1:4773/pair?unexpected=true#token=owner",
      ]) {
        const exit = yield* Effect.exit(resolveDesktopAttachPairingTarget(url));
        assert.equal(exit._tag, "Failure");
        if (exit._tag === "Failure") {
          assert.isTrue(exit.cause.toString().includes("DesktopAttachPairingUrlError"));
        }
      }
    }),
  );
});
