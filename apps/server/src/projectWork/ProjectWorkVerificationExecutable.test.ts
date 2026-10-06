import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { PiProductionRuntimeAssets } from "../provider/pi/PiProductionRuntime.ts";
import { withProjectWorkVerificationExecutable } from "./ProjectWorkVerificationExecutable.ts";

const NodeFS = process.getBuiltinModule("fs");
const NodePath = process.getBuiltinModule("path");

const isolated = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.scoped(body).pipe(Effect.provideService(HostProcessPlatform, "linux"));

const digest = (bytes: string) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const fixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-verification-executable-")),
    ),
    (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );
  const executable = NodePath.join(directory, "executable");
  const dependency = NodePath.join(directory, "dependency");
  yield* Effect.sync(() => {
    NodeFS.writeFileSync(executable, "test executable bytes", { mode: 0o700 });
    NodeFS.writeFileSync(dependency, "test dependency bytes", { mode: 0o600 });
  });
  let activeLoans = 0;
  const files = [
    { source: executable, target: "/runtime/test" },
    { source: dependency, target: "/runtime/dependency" },
  ];
  const assets: PiProductionRuntimeAssets = {
    runtimeFiles: files,
    revalidate: Effect.void,
    borrow: (operation) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          activeLoans++;
        }),
        () => operation,
        () =>
          Effect.sync(() => {
            activeLoans--;
          }),
      ),
  };
  return { directory, executable, dependency, files, assets, activeLoans: () => activeLoans };
});

it.effect("captures actual bytes and holds the published asset loan through the consumer", () =>
  isolated(
    Effect.gen(function* () {
      const f = yield* fixture;
      const captured = yield* withProjectWorkVerificationExecutable(
        f.assets,
        "/runtime/test",
        (capture) =>
          Effect.sync(() => {
            expect(f.activeLoans()).toBe(1);
            expect(capture.executableTarget).toBe("/runtime/test");
            expect(capture.sha256).toBe(digest("test executable bytes"));
            expect(capture.runtimeClosureSha256).toMatch(/^[a-f0-9]{64}$/);
            return capture;
          }),
      );
      expect(f.activeLoans()).toBe(0);
      const reversed = { ...f.assets, runtimeFiles: f.files.toReversed() };
      const again = yield* withProjectWorkVerificationExecutable(
        reversed,
        "/runtime/test",
        Effect.succeed,
      );
      expect(again).toEqual(captured);
      yield* Effect.sync(() => NodeFS.writeFileSync(f.dependency, "different dependency"));
      const changed = yield* withProjectWorkVerificationExecutable(
        f.assets,
        "/runtime/test",
        Effect.succeed,
      );
      expect(changed.sha256).toBe(captured.sha256);
      expect(changed.runtimeClosureSha256).not.toBe(captured.runtimeClosureSha256);
    }),
  ),
);

it.effect("rejects missing or ambiguous executable targets before calling the consumer", () =>
  isolated(
    Effect.gen(function* () {
      const f = yield* fixture;
      let calls = 0;
      const use = () =>
        Effect.sync(() => {
          calls++;
        });
      const missing = yield* withProjectWorkVerificationExecutable(
        f.assets,
        "/runtime/missing",
        use,
      ).pipe(Effect.result);
      const duplicate = yield* withProjectWorkVerificationExecutable(
        { ...f.assets, runtimeFiles: [...f.files, f.files[0]!] },
        "/runtime/test",
        use,
      ).pipe(Effect.result);
      expect(missing._tag).toBe("Failure");
      expect(duplicate._tag).toBe("Failure");
      expect(calls).toBe(0);
      expect(f.activeLoans()).toBe(0);
    }),
  ),
);

it.effect("rejects redirected or non-executable selected source files", () =>
  isolated(
    Effect.gen(function* () {
      const f = yield* fixture;
      const link = NodePath.join(f.directory, "redirect");
      yield* Effect.sync(() => NodeFS.symlinkSync(f.executable, link));
      const redirected = { ...f.assets, runtimeFiles: [{ source: link, target: "/runtime/test" }] };
      expect(
        (yield* withProjectWorkVerificationExecutable(
          redirected,
          "/runtime/test",
          Effect.succeed,
        ).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* Effect.sync(() => NodeFS.chmodSync(f.executable, 0o600));
      expect(
        (yield* withProjectWorkVerificationExecutable(
          f.assets,
          "/runtime/test",
          Effect.succeed,
        ).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(f.activeLoans()).toBe(0);
    }),
  ),
);

it.effect("rejects a runtime closure changed while the consumer is using its capture", () =>
  isolated(
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* withProjectWorkVerificationExecutable(f.assets, "/runtime/test", () =>
        Effect.sync(() => {
          NodeFS.writeFileSync(f.dependency, "changed during consumer");
        }),
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(f.activeLoans()).toBe(0);
    }),
  ),
);

it.effect("releases the loan when an interrupted consumer has drained", () =>
  isolated(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const hold = yield* Deferred.make<void>();
      const fiber = yield* withProjectWorkVerificationExecutable(f.assets, "/runtime/test", () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(hold))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(f.activeLoans()).toBe(1);
      yield* Fiber.interrupt(fiber);
      expect(f.activeLoans()).toBe(0);
    }),
  ),
);

it.effect("rejects oversized physical files and oversized closures before the consumer", () =>
  isolated(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.sync(() => NodeFS.truncateSync(f.executable, 256 * 1024 * 1024 + 1));
      let calls = 0;
      const use = () =>
        Effect.sync(() => {
          calls++;
        });
      expect(
        (yield* withProjectWorkVerificationExecutable(f.assets, "/runtime/test", use).pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      const tooMany = {
        ...f.assets,
        runtimeFiles: Array.from({ length: 257 }, (_, index) => ({
          source: f.dependency,
          target: "/runtime/" + index,
        })),
      };
      expect(
        (yield* withProjectWorkVerificationExecutable(tooMany, "/runtime/0", use).pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(calls).toBe(0);
      expect(f.activeLoans()).toBe(0);
    }),
  ),
);

it.effect("keeps unsupported hosts unavailable without calling the consumer", () =>
  isolated(
    Effect.gen(function* () {
      const f = yield* fixture;
      let called = false;
      const result = yield* withProjectWorkVerificationExecutable(f.assets, "/runtime/test", () =>
        Effect.sync(() => {
          called = true;
        }),
      ).pipe(Effect.provideService(HostProcessPlatform, "win32"), Effect.result);
      expect(result._tag).toBe("Failure");
      expect(called).toBe(false);
      expect(f.activeLoans()).toBe(0);
    }),
  ),
);

it.effect("preserves consumer failures while releasing the asset loan", () =>
  isolated(
    Effect.gen(function* () {
      const f = yield* fixture;
      const observed = yield* withProjectWorkVerificationExecutable(f.assets, "/runtime/test", () =>
        Effect.fail("consumer failed"),
      ).pipe(Effect.catch((error) => Effect.succeed(error)));
      expect(observed).toBe("consumer failed");
      expect(f.activeLoans()).toBe(0);
    }),
  ),
);
