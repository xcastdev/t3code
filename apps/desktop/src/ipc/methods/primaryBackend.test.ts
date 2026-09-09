import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopAttachedBackend from "../../backend/DesktopAttachedBackend.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import {
  attachPrimaryBackend,
  getPrimaryBackendState,
  refreshAttachedPrimaryCredential,
  useManagedPrimaryBackend,
} from "./primaryBackend.ts";

const attachedState = {
  mode: "attached" as const,
  httpBaseUrl: "http://127.0.0.1:4773/",
  environmentId: Schema.decodeUnknownSync(EnvironmentId)("environment-1"),
  label: "Workstation",
  bearerExpiresAt: "2026-10-08T12:00:00.000Z",
};

describe("primary backend IPC", () => {
  it.effect("returns redacted state and relaunches after mode changes", () =>
    Effect.gen(function* () {
      const relaunchReasons: Array<string> = [];
      const attachedBackend = DesktopAttachedBackend.DesktopAttachedBackend.of({
        getState: Effect.succeed(attachedState),
        attach: () => Effect.succeed(attachedState),
        refreshCredential: () => Effect.void,
        getBearerToken: Effect.succeed("decrypted-bearer"),
        probe: Effect.succeed({} as never),
        useManagedBackend: Effect.void,
      });
      const lifecycle = {
        relaunch: (reason: string) =>
          Effect.sync(() => {
            relaunchReasons.push(reason);
          }),
      } as unknown as DesktopLifecycle.DesktopLifecycle["Service"];
      const runtimeLayer = Layer.mergeAll(
        DesktopShutdown.layer,
        DesktopState.layer,
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of(
            {} as DesktopEnvironment.DesktopEnvironment["Service"],
          ),
        ),
        Layer.succeed(
          DesktopWindow.DesktopWindow,
          DesktopWindow.DesktopWindow.of({} as DesktopWindow.DesktopWindow["Service"]),
        ),
        Layer.succeed(
          ElectronApp.ElectronApp,
          ElectronApp.ElectronApp.of({} as ElectronApp.ElectronApp["Service"]),
        ),
        Layer.succeed(
          ElectronTheme.ElectronTheme,
          ElectronTheme.ElectronTheme.of({} as ElectronTheme.ElectronTheme["Service"]),
        ),
      );
      const layer = Layer.mergeAll(
        Layer.succeed(DesktopAttachedBackend.DesktopAttachedBackend, attachedBackend),
        Layer.succeed(DesktopLifecycle.DesktopLifecycle, lifecycle),
        runtimeLayer,
      );

      assert.deepEqual(
        yield* getPrimaryBackendState.handler(undefined).pipe(Effect.provide(layer)),
        attachedState,
      );
      assert.deepEqual(
        yield* attachPrimaryBackend
          .handler("http://127.0.0.1:4773/pair#token=owner")
          .pipe(Effect.provide(layer)),
        attachedState,
      );
      yield* useManagedPrimaryBackend.handler(undefined).pipe(Effect.provide(layer));
      assert.deepEqual(relaunchReasons, ["primary-backend-attached", "primary-backend-managed"]);
    }),
  );

  it.effect("refreshes once without relaunching and preserves typed failures", () =>
    Effect.gen(function* () {
      const refreshCredential = vi.fn(
        (
          _credential: string,
        ): Effect.Effect<void, DesktopAttachedBackend.DesktopAttachedBackendError> =>
          Effect.fail(
            new DesktopAttachedBackend.DesktopAttachAdministrativeScopeError({
              missingScopes: ["access:write"],
            }),
          ),
      );
      const attachedBackend = DesktopAttachedBackend.DesktopAttachedBackend.of({
        getState: Effect.succeed(attachedState),
        attach: () => Effect.succeed(attachedState),
        refreshCredential,
        getBearerToken: Effect.succeed("decrypted-bearer"),
        probe: Effect.succeed({} as never),
        useManagedBackend: Effect.void,
      });
      const result = yield* Effect.exit(
        refreshAttachedPrimaryCredential
          .handler("replacement-owner-token")
          .pipe(
            Effect.provideService(DesktopAttachedBackend.DesktopAttachedBackend, attachedBackend),
          ),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        const failure = Cause.findErrorOption(result.cause);
        assert.isTrue(Option.isSome(failure));
        if (Option.isSome(failure)) {
          assert.instanceOf(
            failure.value,
            DesktopAttachedBackend.DesktopAttachAdministrativeScopeError,
          );
        }
      }
      assert.deepEqual(refreshCredential.mock.calls, [["replacement-owner-token"]]);
    }),
  );
});
