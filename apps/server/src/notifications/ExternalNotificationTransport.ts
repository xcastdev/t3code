// @effect-diagnostics nodeBuiltinImport:off - Undici needs a Node DNS lookup for the socket.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import {
  sendExternalNotification,
  type ExternalNotificationError,
} from "@t3tools/external-notifications/webhook";
import {
  formatHostForUrl,
  isPrivateNetworkHost,
  isPublicFaviconHost,
  normalizeHostname,
} from "@t3tools/shared/hostClassification";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import type { Dispatcher } from "undici";
import { loadUndici } from "../outboundHttp.ts";

export class ExternalNotificationTransport extends Context.Service<
  ExternalNotificationTransport,
  {
    readonly send: (
      destination: Parameters<typeof sendExternalNotification>[0],
      event: Parameters<typeof sendExternalNotification>[1],
    ) => Effect.Effect<void, ExternalNotificationError>;
  }
>()("t3/notifications/ExternalNotificationTransport") {}

const blockedLocalAddresses = new NodeNet.BlockList();
blockedLocalAddresses.addSubnet("0.0.0.0", 8);
blockedLocalAddresses.addSubnet("169.254.0.0", 16);
blockedLocalAddresses.addSubnet("198.18.0.0", 15);
blockedLocalAddresses.addAddress("::", "ipv6");
blockedLocalAddresses.addSubnet("fe80::", 10, "ipv6");
blockedLocalAddresses.addAddress("fd00:ec2::254", "ipv6");

const allowsLocalAddress = (hostname: string) =>
  isPrivateNetworkHost(hostname) || /\.(lan|internal|home|localdomain)$/.test(hostname);

const isAllowedAddress = (allowPrivate: boolean, address: string, family: number) =>
  isPublicFaviconHost(address) ||
  (allowPrivate &&
    isPrivateNetworkHost(address) &&
    !blockedLocalAddresses.check(address, family === 6 ? "ipv6" : "ipv4"));

class WebhookConnectionRejected extends Schema.TaggedError<
  WebhookConnectionRejected,
  { readonly brand: unique symbol }
>()("WebhookConnectionRejected", {}) {}

const lookup =
  (allowPrivateOrigin: boolean): NodeNet.LookupFunction =>
  (host, options, callback) => {
    void NodeDnsPromises.lookup(host, { ...options, all: true }).then(
      (addresses) => {
        const allowPrivate = allowPrivateOrigin || allowsLocalAddress(normalizeHostname(host));
        const first = addresses[0];
        if (
          !first ||
          addresses.some(({ address, family }) => !isAllowedAddress(allowPrivate, address, family))
        ) {
          callback(new WebhookConnectionRejected(), "");
          return;
        }
        // Return the same addresses we checked to the socket so there is no second DNS lookup.
        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };

const makeAgent = (privateOrigins: ReadonlySet<string>) => {
  const { Agent, buildConnector } = loadUndici();
  const connect = buildConnector({ lookup: lookup(false), autoSelectFamily: true, allowH2: false });
  const connectPrivate = buildConnector({
    lookup: lookup(true),
    autoSelectFamily: true,
    allowH2: false,
  });
  return new Agent({
    connect: (options, callback) => {
      const host = normalizeHostname(options.hostname);
      const origin = URL.parse(
        `${options.protocol}//${formatHostForUrl(host)}${options.port ? `:${options.port}` : ""}`,
      );
      const allowPrivateOrigin = origin !== null && privateOrigins.has(origin.origin);
      const family = NodeNet.isIP(host);
      // Node skips the lookup hook for literal addresses.
      if (
        family &&
        !isAllowedAddress(allowPrivateOrigin || allowsLocalAddress(host), host, family)
      ) {
        callback(new WebhookConnectionRejected(), null);
        return;
      }
      (allowPrivateOrigin ? connectPrivate : connect)(options, callback);
    },
  });
};

export const layer = Layer.effect(
  ExternalNotificationTransport,
  Effect.gen(function* () {
    const configured = yield* Config.String("T3CODE_EXTERNAL_NOTIFICATION_PRIVATE_ORIGINS").pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
    const privateOrigins = new Set(configured.split(",").map((origin) => origin.trim()));
    const dispatcher = yield* Effect.acquireRelease(
      Effect.sync(() => makeAgent(privateOrigins)),
      (agent) => Effect.promise(() => agent.destroy()),
    );
    const { DecoratorHandler } = loadUndici();
    return ExternalNotificationTransport.of({
      send: Effect.fn("ExternalNotificationTransport.send")(function* (
        destination: Parameters<typeof sendExternalNotification>[0],
        event: Parameters<typeof sendExternalNotification>[1],
      ) {
        let started = false;
        const trackingDispatcher = dispatcher.compose(
          (dispatch) => (options, handler) =>
            dispatch(
              options,
              Object.assign(new DecoratorHandler(handler), {
                onRequestStart(controller, context) {
                  started = true;
                  handler.onRequestStart?.(controller, context);
                },
              } satisfies Dispatcher.DispatchHandler),
            ),
        );
        const client = yield* NodeHttpClient.makeUndici.pipe(
          Effect.provideService(NodeHttpClient.Dispatcher, trackingDispatcher),
        );
        return yield* sendExternalNotification(destination, event, () => started).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
      }),
    });
  }),
);
