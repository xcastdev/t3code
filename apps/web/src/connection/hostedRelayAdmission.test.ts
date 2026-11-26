import type { ConnectionCatalogEntry, NetworkStatus } from "@t3tools/client-runtime/connection";
import {
  AuthStandardClientScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const appOrigin = "https://app.example.test";
const binding = {
  environmentId: EnvironmentId.make("hosted-environment"),
  httpsOrigin: "https://relay.example.test:8443",
  transportRole: "relay",
} as const;
const secondBinding = { ...binding, httpsOrigin: "https://other-alias.example.test" };
const direct = "https://direct.example.test";
const signed = `${binding.httpsOrigin}/api/assets/signature/files/report?proof=a%2Fb+Z`;
const handle = "a".repeat(43);
const ticket = "t".repeat(43);
const now = 1_800_000_000_000;

function setupHostedApp() {
  vi.resetModules();
  vi.useFakeTimers({ now });
  vi.stubEnv("VITE_HOSTED_APP_URL", appOrigin);
  vi.stubEnv(
    "VITE_VERIFIED_BROWSER_ROUTE",
    JSON.stringify([
      binding,
      secondBinding,
      { ...binding, httpsOrigin: direct, transportRole: "direct" },
    ]),
  );
  const appWindow = Object.assign(new EventTarget(), {
    location: { origin: appOrigin, href: appOrigin + "/" },
  });
  Object.assign(appWindow, { top: appWindow });
  vi.stubGlobal("window", appWindow);
  return {
    appWindow,
    [Symbol.dispose]() {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    },
  };
}

async function withHostedApp(
  run: (api: typeof import("./hostedRelayAdmission"), appWindow: EventTarget) => Promise<void>,
) {
  using app = setupHostedApp();
  await run(await import("./hostedRelayAdmission"), app.appWindow);
}

describe("hosted relay admission", () => {
  it("scopes the handle to the exact installed relay and preserves signed requests", () =>
    withHostedApp(async (api) => {
      using fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response());
      expect(api.hostedAdmissionRequired(signed)).toBe(true);
      expect(api.hostedAdmissionRequired(direct)).toBe(false);
      await expect(api.fetchHostedRelayResource(signed)).rejects.toThrow("admission");
      await expect(
        api.admitHostedRelay({ ...binding, httpsOrigin: direct }, ticket),
      ).rejects.toThrow();
      await expect(
        api.admitHostedRelay({ ...binding, environmentId: EnvironmentId.make("other") }, ticket),
      ).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();

      fetch.mockResolvedValueOnce(
        Response.json({ session: handle, expiresAt: now + 10_000 }, { status: 201 }),
      );
      await api.admitHostedRelay(binding, ticket);
      expect(fetch).toHaveBeenLastCalledWith(
        `${binding.httpsOrigin}/.well-known/t3/relay-browser/hosted-session`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ticket }),
          credentials: "omit",
          redirect: "error",
        }),
      );

      const request = new Request(signed, { headers: { Range: "bytes=1-9" } });
      await api.fetchHostedRelayResource(request, { credentials: "include", redirect: "follow" });
      const [sent, init] = fetch.mock.lastCall!;
      expect(sent).toBe(request);
      expect(init).toMatchObject({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      expect(new Headers(init?.headers).get("X-T3-Relay-Session")).toBe(handle);
      expect(new Headers(init?.headers).get("range")).toBe("bytes=1-9");

      await api.fetchHostedRelayResource(`${direct}/api/assets/other`);
      expect(fetch).toHaveBeenLastCalledWith(`${direct}/api/assets/other`, undefined);
    }));

  it("redeems a ticket from the trusted pairing entry before invoking destination pairing", () =>
    withHostedApp(async () => {
      const { submitEnrolledHostedRelayPairing, listHostedRelayPairingBindings } =
        await import("./hostedRelayAdmission");
      const redeemed = Promise.withResolvers<Response>();
      using fetch = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(redeemed.promise);
      const pair = vi.fn(async () => "paired");
      expect(listHostedRelayPairingBindings().map(({ httpsOrigin }) => httpsOrigin)).toEqual([
        binding.httpsOrigin,
        secondBinding.httpsOrigin,
      ]);
      const pairing = submitEnrolledHostedRelayPairing(binding, ticket, "destination-code", pair);
      expect(fetch).toHaveBeenCalledOnce();
      expect(pair).not.toHaveBeenCalled();
      redeemed.resolve(
        Response.json({ session: handle, expiresAt: now + 10_000 }, { status: 201 }),
      );
      await expect(pairing).resolves.toBe("paired");
      expect(pair).toHaveBeenCalledExactlyOnceWith({
        host: binding.httpsOrigin,
        expectedEnvironmentId: binding.environmentId,
        verificationRequired: true,
        pairingCode: "destination-code",
      });

      pair.mockClear();
      vi.stubGlobal("window", { location: { origin: appOrigin, href: appOrigin + "/" }, top: {} });
      expect(listHostedRelayPairingBindings()).toEqual([]);
      await expect(
        submitEnrolledHostedRelayPairing(binding, ticket, "destination-code", pair),
      ).rejects.toThrow("admission");
      expect(fetch).toHaveBeenCalledOnce();
      expect(pair).not.toHaveBeenCalled();
    }));

  it("materializes an admitted PDF for the local document reader", () =>
    withHostedApp(async (api) => {
      const { admittedAssetSource } = await import("~/assets/admittedAssetSource");
      const { readBoundedDocument } = await import("~/components/files/readBoundedDocument");
      const url = `${binding.httpsOrigin}/api/assets/signed.grant/report.pdf`;
      const pdf = "%PDF-1.7";
      const expiresAt = now + 10_000;
      using fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(Response.json({ session: handle, expiresAt }, { status: 201 }))
        .mockResolvedValueOnce(
          new Response(pdf, { headers: { "Content-Type": "application/pdf" } }),
        );
      await api.admitHostedRelay(binding, ticket);

      const registry = AtomRegistry.make();
      try {
        const source = admittedAssetSource(binding.environmentId, url, "static", expiresAt);
        const local = await new Promise<string>((resolve, reject) => {
          registry.subscribe(
            source,
            (result) => {
              if (result._tag === "Success") resolve(result.value);
              if (result._tag === "Failure") reject(new Error("Unable to materialize the PDF."));
            },
            { immediate: true },
          );
        });
        expect(local).toMatch(/^blob:/);
        const [issued, init] = fetch.mock.calls[1]!;
        expect(issued).toBe(url);
        expect(new Headers(init?.headers).get("X-T3-Relay-Session")).toBe(handle);
        const bytes = await readBoundedDocument(local, new AbortController().signal, 1024);
        expect(new TextDecoder().decode(bytes)).toBe(pdf);
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(fetch.mock.lastCall?.[0]).toBe(local);
      } finally {
        registry.dispose();
        api.clearHostedRelayAdmission();
      }
    }));

  it("clears tab credentials on pagehide even when renewing before the runtime starts", () =>
    withHostedApp(async (api, appWindow) => {
      using fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          Response.json({ session: handle, expiresAt: now + 10_000 }, { status: 201 }),
        );
      const pair = vi.fn(async () => "paired");
      await expect(
        api.submitEnrolledHostedRelayPairing(binding, ticket, "", pair),
      ).resolves.toBeUndefined();
      expect(pair).not.toHaveBeenCalled();
      const lifetime = api.assertHostedRelayAdmission(binding);
      appWindow.dispatchEvent(new Event("pagehide"));
      expect(lifetime?.aborted).toBe(true);
      await expect(api.fetchHostedRelayResource(signed)).rejects.toThrow("admission");
      expect(fetch).toHaveBeenCalledOnce();
    }));

  it("offers a scoped session synchronously and blocks sockets and fetch when it expires", () =>
    withHostedApp(async (api) => {
      using fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          Response.json({ session: handle, expiresAt: now + 10_000 }, { status: 201 }),
        );
      const socket = { close: vi.fn(), addEventListener: vi.fn() };
      const construct = vi.fn(function () {
        return socket;
      });
      vi.stubGlobal("WebSocket", construct);
      const url = `wss://relay.example.test:8443/ws?wsTicket=separate`;
      expect(() => api.openHostedRelaySocket(url)).toThrow("admission");
      await api.admitHostedRelay(binding, ticket);
      expect(() => api.openHostedRelaySocket(url + "&wsTicket=duplicate")).toThrow("admission");
      expect(() => api.assertHostedStreamTarget(url, binding.environmentId, "/wrong")).toThrow(
        "admission",
      );
      expect(api.openHostedRelaySocket(url, ["application"])).toBe(socket);
      expect(construct).toHaveBeenCalledExactlyOnceWith(url, [
        "application",
        "t3-relay.v1",
        `t3-relay.${handle}`,
      ]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(socket.close).toHaveBeenCalledOnce();
      expect(() => api.openHostedRelaySocket(url)).toThrow("admission");
      await expect(api.fetchHostedRelayResource(signed)).rejects.toThrow("admission");
      expect(fetch).toHaveBeenCalledOnce();
    }));

  it("requires the approved app origin and preserves the environment-served request policy", () =>
    withHostedApp(async (api) => {
      using fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
      vi.stubGlobal("window", { location: { origin: "https://unapproved.example.test" } });
      await expect(api.admitHostedRelay(binding, ticket)).rejects.toThrow("admission");
      await expect(api.fetchHostedRelayResource(signed)).rejects.toThrow("admission");
      expect(fetch).not.toHaveBeenCalled();

      vi.stubGlobal("window", { location: { origin: binding.httpsOrigin } });
      expect(api.hostedAdmissionRequired(signed)).toBe(false);
      await api.fetchHostedRelayResource(signed, { credentials: "include" });
      expect(fetch).toHaveBeenCalledExactlyOnceWith(signed, { credentials: "include" });
    }));

  it("aborts requests on only the removed alias and blocks new requests there", () =>
    withHostedApp(async (api) => {
      using fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () =>
          Response.json({ session: handle, expiresAt: now + 10_000 }, { status: 201 }),
        );
      await api.admitHostedRelay(binding, ticket);
      await api.admitHostedRelay(secondBinding, ticket);
      fetch.mockImplementationOnce(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const request = expect(api.fetchHostedRelayResource(signed)).rejects.toThrow("admission");
      api.clearHostedRelayAdmission(binding.environmentId, binding.httpsOrigin);
      await request;
      await expect(api.fetchHostedRelayResource(signed)).rejects.toThrow("admission");
      expect(fetch).toHaveBeenCalledTimes(3);
      await api.fetchHostedRelayResource(secondBinding.httpsOrigin);
      expect(fetch).toHaveBeenCalledTimes(4);
    }));

  it("drops only the rejected admission and leaves an unmarked 401 to the caller", () =>
    withHostedApp(async (api) => {
      const redeemed = () =>
        Response.json({ session: handle, expiresAt: now + 10_000 }, { status: 201 });
      using fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(redeemed())
        .mockResolvedValueOnce(redeemed());
      await api.admitHostedRelay(binding, ticket);
      await api.admitHostedRelay(secondBinding, ticket);
      const lifetime = api.assertHostedRelayAdmission(binding);
      const otherLifetime = api.assertHostedRelayAdmission(secondBinding);
      fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
      expect((await api.fetchHostedRelayResource(signed)).status).toBe(401);
      expect(lifetime?.aborted).toBe(false);

      fetch.mockResolvedValueOnce(
        new Response(null, { status: 401, headers: { "T3-Relay-Admission": "session-required" } }),
      );
      await expect(api.fetchHostedRelayResource(signed)).rejects.toThrow("new operator ticket");
      await expect(api.fetchHostedRelayResource(signed)).rejects.toThrow("new operator ticket");
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(lifetime?.aborted).toBe(true);
      expect(otherLifetime?.aborted).toBe(false);
      expect(api.assertHostedRelayAdmission(secondBinding)).toBe(otherLifetime);
      expect(api.hostedAdmissionRequired(direct)).toBe(false);
    }));

  it.effect.each(["descriptor", "socket ticket"])(
    "blocks an explicitly paired route on %s rejection and reuses its destination credential after renewal",
    (rejectedRequest) =>
      Effect.gen(function* () {
        using _app = setupHostedApp();
        const [api, connection, authorization, runtime, platform] = yield* Effect.promise(() =>
          Promise.all([
            import("./hostedRelayAdmission"),
            import("@t3tools/client-runtime/connection"),
            import("@t3tools/client-runtime/authorization"),
            import("../lib/runtime"),
            import("./platform"),
          ]),
        );
        const {
          AVAILABLE_CONNECTION_STATE,
          ConnectionOnboarding,
          ConnectionResolver,
          CredentialStore,
          EnvironmentRegistry,
          presentConnectionDiagnosis,
          presentConnectionState,
        } = connection;
        const dependencies = platform.layer.pipe(Layer.provideMerge(runtime.layer));
        const remote = authorization.RemoteEnvironmentAuthorization.layer.pipe(
          Layer.provideMerge(dependencies),
        );
        const descriptor = {
          environmentId: binding.environmentId,
          label: "Paired environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: { repositoryIdentity: true },
        };
        const renewedHandle = "b".repeat(43);
        const redeemed = (session = handle) =>
          Response.json({ session, expiresAt: now + 10_000 }, { status: 201 });
        const issued = () =>
          Response.json({
            ticket: "destination-socket-ticket",
            expiresAt: new Date(now).toISOString(),
          });
        using fetch = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(redeemed())
          .mockResolvedValueOnce(Response.json(descriptor))
          .mockResolvedValueOnce(
            Response.json({
              access_token: "destination-bearer",
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "Bearer",
              expires_in: 3600,
              scope: AuthStandardClientScopes.join(" "),
            }),
          );
        const input = yield* Effect.promise(() =>
          api.submitEnrolledHostedRelayPairing(
            binding,
            ticket,
            "destination-code",
            async (input) => input,
          ),
        );
        if (input === undefined) throw new Error("Expected a destination pairing request");
        const registry = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
          entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map(),
          ),
          networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        });
        const registration = yield* ConnectionOnboarding.preparePairingRegistration(input).pipe(
          Effect.provide(Layer.merge(dependencies, registry)),
        );
        expect(registration.profile.verificationRequired).toBe(true);

        const entry = {
          target: registration.target,
          profile: Option.some(registration.profile),
          enabled: true,
        };
        const credential = CredentialStore.make({
          get: () => Effect.succeedSome(registration.credential),
          put: () => Effect.die("Unexpected credential write"),
          remove: () => Effect.die("Unexpected credential removal"),
        });
        const resolverLayer = ConnectionResolver.layer.pipe(
          Layer.provide(Layer.succeed(CredentialStore.ConnectionCredentialStore, credential)),
          Layer.provide(remote),
        );
        yield* Effect.gen(function* () {
          const resolver = yield* ConnectionResolver.ConnectionResolver;
          const prepare = resolver.prepare(entry);
          fetch.mockResolvedValueOnce(Response.json(descriptor)).mockResolvedValueOnce(issued());
          expect((yield* prepare).socketUrl).toContain("wsTicket=destination-socket-ticket");
          if (rejectedRequest === "socket ticket") {
            fetch.mockResolvedValueOnce(Response.json(descriptor));
          }
          fetch.mockResolvedValueOnce(
            new Response(null, {
              status: 401,
              headers: { "T3-Relay-Admission": "session-required" },
            }),
          );
          const rejected = yield* prepare.pipe(Effect.flip);
          const reconnect = yield* prepare.pipe(Effect.flip);
          expect(fetch).toHaveBeenCalledTimes(rejectedRequest === "descriptor" ? 6 : 7);
          for (const failure of [rejected, reconnect]) {
            const state = {
              ...AVAILABLE_CONNECTION_STATE,
              phase: "blocked",
              lastFailure: failure,
            } as const;
            const diagnosis = presentConnectionDiagnosis({
              hostLabel: descriptor.label,
              state,
              via: "direct",
            });
            expect(presentConnectionState(state).hostedRelayAdmissionRequired).toBe(true);
            expect(failure).toMatchObject({
              _tag: "ConnectionBlockedError",
              hop: "relay",
              failureCause: "hosted_relay_admission_required",
            });
            expect(diagnosis).toMatchObject({ action: "renew-relay-access", moreInfoUrl: null });
          }
          fetch
            .mockResolvedValueOnce(redeemed(renewedHandle))
            .mockResolvedValueOnce(Response.json(descriptor))
            .mockResolvedValueOnce(issued());
          yield* Effect.promise(() =>
            api.submitEnrolledHostedRelayPairing(binding, "n".repeat(43), "", () => {
              throw new Error("Renewal tried to pair the destination");
            }),
          );
          expect((yield* prepare).socketUrl).toContain("wsTicket=destination-socket-ticket");
          expect(
            fetch.mock.calls
              .map(([url]) => new URL(String(url)).pathname)
              .filter((path) => path === "/oauth/token"),
          ).toHaveLength(1);
          const headers = new Headers(fetch.mock.lastCall?.[1]?.headers);
          expect(headers.get("Authorization")).toBe("Bearer destination-bearer");
          expect(headers.get("X-T3-Relay-Session")).toBe(renewedHandle);
        }).pipe(Effect.provide(resolverLayer));
      }),
  );

  it.each([true, false])(
    "checks a failed browser upgrade for definitive admission rejection (%s)",
    (rejected) =>
      withHostedApp(async (api) => {
        const probe = Promise.withResolvers<void>();
        using fetch = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(
            Response.json({ session: handle, expiresAt: now + 10_000 }, { status: 201 }),
          )
          .mockImplementationOnce(async () => {
            const response = new Response(new ReadableStream({ cancel: () => probe.resolve() }), {
              status: 401,
              headers: rejected ? { "T3-Relay-Admission": "session-required" } : {},
            });
            return response;
          });
        await api.admitHostedRelay(binding, ticket);
        const admission = api.assertHostedRelayAdmission(binding);
        const socket = Object.assign(new EventTarget(), { close: vi.fn(), readyState: 0 });
        const construct = vi.fn(function () {
          return socket;
        });
        vi.stubGlobal("WebSocket", construct);
        const { openEnvironmentSocket } = await import("./environmentTransport");
        openEnvironmentSocket("wss://relay.example.test:8443/ws?wsTicket=separate");
        socket.dispatchEvent(new Event("error"));
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.lastCall?.[0]).toBe(binding.httpsOrigin + "/.well-known/t3/environment");
        expect(new Headers(fetch.mock.lastCall?.[1]?.headers).has("Authorization")).toBe(false);
        await probe.promise;
        expect(admission?.aborted).toBe(rejected);
        expect(construct).toHaveBeenCalledOnce();
      }),
  );

  it("uses admitted screenshot capture with the original Device ticket", () =>
    withHostedApp(async (api) => {
      using fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          Response.json({ session: handle, expiresAt: now + 10_000 }, { status: 201 }),
        );
      await api.admitHostedRelay(binding, ticket);
      const { captureWebDeviceScreenshot } = await import("../components/device/deviceHubApi");
      const cancel = vi.fn();
      fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 401 }));
      await expect(
        captureWebDeviceScreenshot(
          {
            access: {
              environmentId: binding.environmentId,
              httpBase: binding.httpsOrigin + "/api/device-hub",
              wsBase: "wss://relay.example.test:8443/api/device-hub",
              query: { wsTicket: "separate+/ticket" },
              credentials: false,
            },
            platform: "ios",
            deviceId: "sim",
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ status: 401 });
      const [url, init] = fetch.mock.lastCall!;
      expect(url).toBe(
        binding.httpsOrigin +
          "/api/device-hub/vendor/serve-sim/api/screenshot?device=sim&wsTicket=separate%2B%2Fticket",
      );
      expect(init?.method).toBe("POST");
      expect(cancel).toHaveBeenCalledOnce();
      expect(new Headers(init?.headers).get("x-t3-relay-session")).toBe(handle);
    }));

  it("reads admitted Device event streams without EventSource and cancels on disposal", () =>
    withHostedApp(async (api) => {
      using fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          Response.json({ session: handle, expiresAt: now + 10_000 }, { status: 201 }),
        );
      await api.admitHostedRelay(binding, ticket);
      const { subscribeDeviceForeground, subscribeDeviceEventLog } =
        await import("../components/device/deviceHubApi");
      const raw = vi.fn(function () {
        throw new Error("Native EventSource used");
      });
      vi.stubGlobal("EventSource", raw);
      const target = {
        access: {
          environmentId: binding.environmentId,
          httpBase: binding.httpsOrigin + "/api/device-hub",
          wsBase: "wss://relay.example.test:8443/api/device-hub",
          query: { wsTicket: "separate+/ticket" },
          credentials: false,
        },
        platform: "ios",
        deviceId: "sim",
      } as const;
      const feed = (chunks: string[]) => {
        const cancelled = Promise.withResolvers<void>();
        const body = new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          },
          cancel: () => cancelled.resolve(),
        });
        fetch.mockResolvedValueOnce(
          new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
        );
        return cancelled.promise;
      };
      const foregroundCancelled = feed([
        ": comment\r",
        '\ndata: {"bundleId":\r\ndata: "com.example.app"}\r',
        "\n\r\n",
      ]);
      const foreground = Promise.withResolvers<unknown>();
      const stopForeground = subscribeDeviceForeground(target, foreground.resolve);
      const logCancelled = feed([
        'event: debug\ndata: {"events":[]}\n\ndata: {"events":[{"id":7}]}\n\n',
      ]);
      const eventLog = Promise.withResolvers<unknown>();
      const stopLog = subscribeDeviceEventLog(target, (entries, reset) =>
        eventLog.resolve({ entries, reset }),
      );
      expect(await foreground.promise).toEqual({ id: "com.example.app" });
      expect(await eventLog.promise).toEqual({
        entries: [{ id: 7, timestamp: "", kind: "", summary: "" }],
        reset: true,
      });
      stopForeground();
      stopLog();
      await Promise.all([foregroundCancelled, logCancelled]);
      expect(raw).not.toHaveBeenCalled();
      expect(fetch.mock.calls.slice(1).map(([url]) => url)).toEqual([
        binding.httpsOrigin +
          "/api/device-hub/vendor/serve-sim/appstate?device=sim&wsTicket=separate%2B%2Fticket",
        binding.httpsOrigin +
          "/api/device-hub/vendor/serve-sim/api/event-log/events?device=sim&limit=100&wsTicket=separate%2B%2Fticket",
      ]);
      for (const [, init] of fetch.mock.calls.slice(1)) {
        expect(new Headers(init?.headers).get("x-t3-relay-session")).toBe(handle);
        expect(init?.signal?.aborted).toBe(true);
      }
    }));

  it("clears pending admission on environment removal", () =>
    withHostedApp(async (api) => {
      let respond!: (response: Response) => void;
      using _fetch = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(
        new Promise((resolve) => {
          respond = resolve;
        }),
      );
      const pending = api.admitHostedRelay(binding, ticket);
      api.clearHostedRelayAdmission(binding.environmentId);
      respond(Response.json({ session: handle, expiresAt: now + 10_000 }, { status: 201 }));
      await expect(pending).rejects.toThrow("admission");
      await expect(api.fetchHostedRelayResource(signed)).rejects.toThrow("admission");
    }));

  it("retires a media owner's admission lifetime before the same tab admits again", () =>
    withHostedApp(async (api) => {
      using _fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () =>
          Response.json({ session: handle, expiresAt: now + 10_000 }, { status: 201 }),
        );
      await api.admitHostedRelay(binding, ticket);
      const lifetime = api.assertHostedRelayAdmission(binding);
      expect(lifetime).toBeInstanceOf(AbortSignal);
      expect(lifetime?.aborted).toBe(false);
      api.clearHostedRelayAdmission(binding.environmentId);
      expect(lifetime?.aborted).toBe(true);
      await api.admitHostedRelay(binding, ticket);
      expect(api.assertHostedRelayAdmission(binding)?.aborted).toBe(false);
      expect(lifetime?.aborted).toBe(true);
    }));
});
