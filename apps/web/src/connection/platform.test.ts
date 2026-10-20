import {
  AuthStandardClientScopes,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { __resetDesktopPrimaryAuthForTests } from "../environments/primary/desktopAuth";

import {
  platformConnectionSourceLayer,
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  primaryRegistrationToRetainAfterTopologyRead,
  provisionDesktopSshEnvironment,
  readPrimaryEnvironmentTargetResult,
  secondaryRegistrationsToRetainAfterTopologyRead,
  secondaryBearerExpiresAtEpochMs,
  secondaryBearerRefreshAtEpochMs,
} from "./platform.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

function makeBridge(
  calls: string[],
  options?: { readonly failDescriptor?: boolean },
): DesktopBridge {
  return {
    ensureSshEnvironment: async (target: DesktopSshEnvironmentTarget) => {
      calls.push("ensure");
      return {
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: "pairing-token",
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options?.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
        },
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      return {
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: AuthStandardClientScopes.join(" "),
      };
    },
  } as unknown as DesktopBridge;
}

describe("desktop SSH pairing", () => {
  it.effect("fetches the descriptor before consuming the one-time credential", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const provisioned = yield* provisionDesktopSshEnvironment(makeBridge(calls), TARGET);

      expect(provisioned.environmentId).toBe(EnvironmentId.make("environment-ssh"));
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );

  it.effect("does not consume the credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { failDescriptor: true }),
        TARGET,
      ).pipe(Effect.flip);

      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("refreshes a secondary bearer before it expires", () => {
    const issuedAtEpochMs = 10_000;
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, 60);
    const expiresAtEpochMs = secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, 60);
    const cached = {
      expiresAtEpochMs,
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(65_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 64_999)).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 65_000)).toBe(false);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 69_999),
    ).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 70_000),
    ).toBe(false);
  });

  it("does not cache credentials whose lifetime is shorter than the refresh skew", () => {
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(10_000, 3);
    const cached = {
      expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(10_000, 3),
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(10_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 10_000)).toBe(false);
  });

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");

    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });

  it("treats a successful primary absence as authoritative removal", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Success",
        target: null,
      }),
    ).toBeUndefined();
  });
});

describe("platform discovery with managed local backends disabled", () => {
  const attached: DesktopEnvironmentBootstrap = {
    id: PRIMARY_LOCAL_ENVIRONMENT_ID,
    label: "Attached environment",
    runningDistro: null,
    httpBaseUrl: "http://127.0.0.1:4321/",
    wsBaseUrl: "ws://127.0.0.1:4321/",
    ownership: "attached",
  };
  // Effect's HTTP layer can retain the fetch reference across test runtimes.
  // Reset one transport mock so each case observes its own requests.
  const fetch = vi.fn<typeof globalThis.fetch>();
  function descriptorRequest() {
    const call = fetch.mock.calls[0];
    if (call === undefined) {
      throw new Error("Expected a descriptor request.");
    }
    return new Request(...call);
  }
  function installHost(initial: DesktopEnvironmentBootstrap[]) {
    let bootstraps = initial;
    const bearer = vi.fn().mockResolvedValue("attached-bearer");
    vi.stubGlobal("window", {
      location: new URL("http://127.0.0.1:9000/work"),
      desktopBridge: {
        getLocalEnvironmentEnabled: () => false,
        getLocalEnvironmentBootstraps: () => bootstraps,
        getLocalEnvironmentBearerToken: bearer,
      },
    });
    fetch.mockReset().mockImplementation(async () =>
      Response.json({
        environmentId: "environment-attached",
        label: "Attached environment",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    return {
      fetch,
      bearer,
      setBootstraps: (next: DesktopEnvironmentBootstrap[]) => {
        bootstraps = next;
      },
    };
  }
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.effect("discovers the attached primary with its bearer and removes it after detach", () => {
    const host = installHost([
      attached,
      { ...attached, id: "wsl:Ubuntu", ownership: "managed", bootstrapToken: "unused" },
    ]);
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const registrations = yield* Stream.runCollect(source.registrations.pipe(Stream.take(1)));
      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toHaveLength(1);
      expect(registrations[0]?.[0]?.target).toMatchObject({
        _tag: "PrimaryConnectionTarget",
        environmentId: "environment-attached",
        httpBaseUrl: attached.httpBaseUrl,
        wsBaseUrl: attached.wsBaseUrl,
      });
      expect(host.fetch).toHaveBeenCalledTimes(1);
      const request = descriptorRequest();
      expect(request.url).toBe("http://127.0.0.1:4321/.well-known/t3/environment");
      expect(request.headers.get("authorization")).toBe("Bearer attached-bearer");
      host.setBootstraps([{ ...attached, ownership: "managed" }]);
      const detached = yield* Stream.runCollect(source.registrations.pipe(Stream.take(1)));
      expect(detached).toEqual([[]]);
      expect(host.fetch).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(platformConnectionSourceLayer));
  });

  it.effect("emits no registrations or requests without an attached primary", () => {
    const host = installHost([{ ...attached, ownership: "managed" }]);
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      expect(yield* Stream.runCollect(source.registrations.pipe(Stream.take(1)))).toEqual([[]]);
      expect(host.fetch).not.toHaveBeenCalled();
      expect(host.bearer).not.toHaveBeenCalled();
    }).pipe(Effect.provide(platformConnectionSourceLayer));
  });

  for (const unavailable of [
    { httpBaseUrl: null, wsBaseUrl: null },
    { httpBaseUrl: "/relative", wsBaseUrl: attached.wsBaseUrl },
    { httpBaseUrl: attached.httpBaseUrl, wsBaseUrl: "file:///socket" },
  ]) {
    it.effect(
      `drops the cached attached primary without fallback for ${JSON.stringify(unavailable)}`,
      () => {
        const host = installHost([attached]);
        vi.stubEnv("VITE_HTTP_URL", "https://fallback.example.test");
        return Effect.gen(function* () {
          const source = yield* PlatformConnectionSource;
          expect(yield* Stream.runCollect(source.registrations.pipe(Stream.take(1)))).toHaveLength(
            1,
          );
          expect(host.fetch).toHaveBeenCalledTimes(1);
          host.setBootstraps([{ ...attached, ...unavailable }]);
          expect(yield* Stream.runCollect(source.registrations.pipe(Stream.take(1)))).toEqual([[]]);
          expect(host.fetch).toHaveBeenCalledTimes(1);
        }).pipe(Effect.provide(platformConnectionSourceLayer));
      },
    );
  }

  it.effect("does not fall back when the attached environment cannot be reached", () => {
    const host = installHost([attached]);
    host.fetch.mockRejectedValue(new TypeError("backend unavailable"));
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      expect(yield* Stream.runCollect(source.registrations.pipe(Stream.take(1)))).toEqual([[]]);
      expect(host.fetch).toHaveBeenCalledTimes(1);
      const request = descriptorRequest();
      expect(request.url).toBe("http://127.0.0.1:4321/.well-known/t3/environment");
    }).pipe(Effect.provide(platformConnectionSourceLayer));
  });

  it.effect("keeps hosted static web discovery empty", () => {
    const host = installHost([attached]);
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      expect(yield* Stream.runCollect(source.registrations)).toEqual([]);
      expect(host.fetch).not.toHaveBeenCalled();
    }).pipe(Effect.provide(platformConnectionSourceLayer));
  });
});
