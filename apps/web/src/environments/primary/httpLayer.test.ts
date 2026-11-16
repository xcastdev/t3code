import { type DesktopBridge, EnvironmentId } from "@t3tools/contracts";
import { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime/rpc";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import { HttpClient } from "effect/http";

import { __resetDesktopPrimaryAuthForTests } from "./desktopAuth";
import * as PrimaryEnvironmentHttpLayer from "./httpLayer";
import { __resetDesktopPrimaryAttachmentForTests } from "./target";

function createSignal<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("primary environment HTTP layer", { concurrent: false }, () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    __resetDesktopPrimaryAttachmentForTests();
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
  });

  it.effect("uses cookie credentials for browser primary environments", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "http://127.0.0.1:3773/settings",
          origin: "http://127.0.0.1:3773",
        },
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://127.0.0.1:3773/api/auth/session");

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).toBe("include");
      expect(request.headers.get("authorization")).toBeNull();
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });

  it.effect.each([
    { destination: "the attached server", baseUrl: "http://127.0.0.1:4773", allowed: true },
    { destination: "another origin", baseUrl: "http://127.0.0.1:4774", allowed: false },
  ])("checks the resolved API URL before authorizing $destination", ({ baseUrl, allowed }) => {
    const attached = {
      httpBaseUrl: "http://127.0.0.1:4773",
      wsBaseUrl: "ws://127.0.0.1:4773",
      environmentId: EnvironmentId.make("environment-attached"),
      attachmentRevision: "revision-1",
    };
    const getBearer = vi.fn(async () => "attached-bearer");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        authenticated: true,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["bearer-access-token"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { origin: "t3code://app" },
      desktopBridge: {
        getLocalEnvironmentEnabled: () => true,
        getLocalEnvironmentBootstraps: () => [
          { id: "primary", label: "Attached", ownership: "attached", ...attached },
        ],
        getLocalEnvironmentBearerToken: getBearer,
      },
    });
    return Effect.gen(function* () {
      const client = yield* makeEnvironmentHttpApiClient(baseUrl);
      const result = yield* client.auth.session({ headers: {} }).pipe(Effect.exit);
      if (!allowed) {
        if (!Exit.isFailure(result))
          return yield* Effect.die("Expected destination mismatch refusal");
        expect(Cause.squash(result.cause)).toMatchObject({
          _tag: "DesktopAttachedCredentialTargetMismatchError",
        });
        expect(getBearer).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        return;
      }
      const session = yield* result;
      expect(session.authenticated).toBe(true);
      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.url).toBe(`${baseUrl}/api/auth/session`);
      expect(request.headers.get("authorization")).toBe("Bearer attached-bearer");
      expect(request.credentials).toBe("omit");
      expect(getBearer).toHaveBeenCalledWith(attached);
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });

  it.effect("uses bearer auth without cookies for desktop-managed primaries", () => {
    const requested = createSignal<void>();
    const bearerToken = createSignal<string>();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "t3code://app" },
        desktopBridge: {
          getLocalEnvironmentEnabled: () => true,
          getLocalEnvironmentBootstraps: () => [
            {
              id: "primary",
              label: "Local environment",
              httpBaseUrl: "http://127.0.0.1:3773",
              wsBaseUrl: "ws://127.0.0.1:3773",
              bootstrapToken: "desktop-bootstrap-token",
            },
          ],
          getLocalEnvironmentBearerToken: () => {
            requested.resolve(undefined);
            return bearerToken.promise;
          },
        } as unknown as DesktopBridge,
      },
    });

    return Effect.gen(function* () {
      const requestFiber = yield* HttpClient.get(
        "http://127.0.0.1:3773/api/connect/link-state",
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => requested.promise);
      expect(fetchMock).not.toHaveBeenCalled();
      bearerToken.resolve("desktop-bearer-token");
      yield* Fiber.join(requestFiber);

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });
});
