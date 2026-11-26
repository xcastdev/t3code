import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  RelayConnectionTarget,
  SshConnectionTarget,
  type PreparedConnection,
} from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";

const sshTarget = (connectionId: string) =>
  new SshConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Test environment",
    connectionId,
  });

const ENTRY: ConnectionCatalogEntry = {
  target: sshTarget("ssh-first"),
  profile: Option.none(),
  enabled: true,
  alternateRoutes: [{ target: sshTarget("ssh-second"), profile: Option.none() }],
};

describe("ConnectionDriver", () => {
  it.effect("reports preparing before each route it prepares", () =>
    Effect.gen(function* () {
      const stages = yield* Ref.make<ReadonlyArray<string>>([]);
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ConnectionResolver.ConnectionResolver)({
              prepare: (entry) =>
                Effect.succeed({
                  environmentId: entry.target.environmentId,
                  label: entry.target.label,
                  httpBaseUrl: "http://127.0.0.1:1",
                  socketUrl: "ws://127.0.0.1:1/ws",
                  httpAuthorization: null,
                  target: entry.target,
                } satisfies PreparedConnection),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({
              connect: () =>
                Effect.fail(
                  new ConnectionTransientError({ reason: "transport", detail: "Socket closed." }),
                ),
            }),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({}),
            // SSH routes have no HTTP check, so the driver never sends a request.
            FetchHttpClient.layer,
          ),
        ),
      );

      yield* driver
        .connect(ENTRY, (progress) => Ref.update(stages, (all) => [...all, progress.stage]))
        .pipe(Effect.scoped, Effect.flip);

      expect(yield* Ref.get(stages)).toEqual([
        "preparing",
        "preparing",
        "opening",
        "preparing",
        "opening",
      ]);
    }),
  );
});

it.effect("re-prepares a saved route after reconnect while the relay is unavailable", () =>
  Effect.gen(function* () {
    const expected = {
      environmentId: EnvironmentId.make("environment-1"),
      label: "Test environment",
    };
    const httpBaseUrl = "https://cached.example.test";
    const wsBaseUrl = "wss://cached.example.test";
    const direct = {
      target: new BearerConnectionTarget({ ...expected, connectionId: "cached" }),
      profile: Option.some(
        new BearerConnectionProfile({
          ...expected,
          connectionId: "cached",
          httpBaseUrl,
          wsBaseUrl,
        }),
      ),
    };
    const entry: ConnectionCatalogEntry = {
      ...direct,
      enabled: true,
      alternateRoutes: [{ target: new RelayConnectionTarget(expected), profile: Option.none() }],
    };
    const freshKey = yield* Ref.make(true);
    const opened = yield* Ref.make<ReadonlyArray<string>>([]);
    const descriptorReads: Array<{ url: string; cache: RequestCache | undefined }> = [];
    const http = FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, async (url, init) => {
          descriptorReads.push({ url: String(url), cache: init?.cache });
          // The wrong key can advertise the same public ID.
          return Response.json({
            ...expected,
            serverVersion: "0.0.0-test",
            platform: { os: "linux", arch: "x64" },
            capabilities: { repositoryIdentity: true },
          });
        }),
      ),
    );
    const driver = yield* ConnectionDriver.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          http,
          Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({
            rememberCheckedDescriptor: () => Effect.void,
          }),
          Layer.mock(ConnectionResolver.ConnectionResolver)({
            prepare: ({ target }) =>
              Effect.gen(function* () {
                if (target._tag === "RelayConnectionTarget") {
                  return yield* new ConnectionTransientError({
                    reason: "relay-unavailable",
                    detail: "Fixture relay offline",
                  });
                }
                if (!(yield* Ref.get(freshKey))) {
                  return yield* new ConnectionBlockedError({
                    reason: "configuration",
                    detail: "Fixture TLS key mismatch",
                  });
                }
                return {
                  ...expected,
                  target,
                  httpBaseUrl,
                  socketUrl: wsBaseUrl + "/ws",
                  httpAuthorization: { _tag: "Bearer", token: "saved session" },
                } satisfies PreparedConnection;
              }),
          }),
          Layer.mock(RpcSession.RpcSessionFactory)({
            connect: ({ socketUrl }) =>
              Ref.update(opened, (urls) => [...urls, socketUrl]).pipe(
                Effect.andThen(
                  new ConnectionTransientError({
                    reason: "transport",
                    detail: "Fixture closed the established route",
                  }),
                ),
              ),
          }),
        ),
      ),
    );

    // Preparing is the injectable boundary. The loopback TLS proof exercises the actual pin.
    const connect = driver.connect(entry, () => Effect.void).pipe(Effect.scoped, Effect.flip);
    expect((yield* connect).reason).toBe("transport");
    expect(yield* Ref.get(opened)).toEqual([wsBaseUrl + "/ws"]);
    yield* Ref.set(freshKey, false);
    expect((yield* connect).reason).toBe("relay-unavailable");
    expect(yield* Ref.get(opened)).toEqual([wsBaseUrl + "/ws"]);
    expect(descriptorReads).toEqual(
      Array.from({ length: 2 }, () => ({
        url: httpBaseUrl + "/.well-known/t3/environment",
        cache: "no-store",
      })),
    );
  }),
);
