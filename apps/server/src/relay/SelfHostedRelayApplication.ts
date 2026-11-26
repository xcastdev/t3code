// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node's HTTP server is the listener boundary.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as RelayDirectory from "@t3tools/relay-core/RelayDirectory";
import * as RelayForwarding from "@t3tools/relay-core/RelayForwarding";
import * as RelayHookIngress from "@t3tools/relay-core/RelayHookIngress";
import * as RelayHookStore from "@t3tools/relay-core/RelayHookStore";
import {
  RelayRuntime,
  RelayStorageError,
  relayRuntimeLayer,
} from "@t3tools/relay-core/RelayRuntime";
import * as Clock from "effect/Clock";
import type * as Digest from "effect/crypto/Digest";
import type * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Queue from "effect/Queue";

import { openRelayHomeOriginRegistry } from "./RelayOriginRegistry.ts";
import * as SelfHostedRelayBrowserAdmission from "./SelfHostedRelayBrowserAdmission.ts";
import * as SelfHostedRelayHookDelivery from "./SelfHostedRelayHookDelivery.ts";
import * as SelfHostedRelayHookIngress from "./SelfHostedRelayHookIngress.ts";
import * as SelfHostedRelayIngress from "./SelfHostedRelayIngress.ts";
import * as SelfHostedRelayPublisherHttp from "./SelfHostedRelayPublisherHttp.ts";
import {
  loadSelfHostedRelayForwardingConfig,
  SelfHostedRelayConfigError,
  type SelfHostedRelayForwardingConfig,
} from "./SelfHostedRelayForwardingConfig.ts";
import * as SelfHostedRelayDirectoryHttp from "./SelfHostedRelayDirectoryHttp.ts";
import * as SelfHostedRelayHttp from "./SelfHostedRelayHttp.ts";

const host = "127.0.0.1";

const layerRoutes = (onHookPolicyChanged?: Effect.Effect<void>) =>
  HttpRouter.serve(
    Layer.merge(SelfHostedRelayHttp.layer(onHookPolicyChanged), SelfHostedRelayDirectoryHttp.layer),
    {
      disableLogger: true,
      disableListenLog: true,
      routerConfig: { maxParamLength: 1200 },
    },
  ).pipe(Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true)));

const reportListening = Effect.gen(function* () {
  const relay = yield* RelayRuntime;
  const { address } = yield* HttpServer.HttpServer;
  const { relayId, state } = yield* relay.localStatus();
  const origin = `http://${NetAddress.formatSocketAddress(address)}`;
  yield* Effect.logInfo(`Self-hosted relay listening at ${origin}`).pipe(
    Effect.annotateLogs({ relayId, state }),
  );
});

const managementLayer = (port: number, onHookPolicyChanged?: Effect.Effect<void>) =>
  Layer.effectDiscard(reportListening).pipe(
    Layer.provide(layerRoutes(onHookPolicyChanged)),
    Layer.provide(
      Layer.unwrap(
        Effect.acquireRelease(
          Effect.sync(() => NodeHttp.createServer({ requestTimeout: 15_000 })),
          (server) => Effect.sync(() => server.closeAllConnections()),
        ).pipe(
          Effect.map((server) =>
            NodeHttpServer.layerServer(() => server, {
              host,
              port,
              gracefulShutdownTimeout: 1_000,
            }),
          ),
        ),
      ),
    ),
  );

const startHooks = Effect.fn("SelfHostedRelayApplication.startHooks")(function* (
  config: NonNullable<SelfHostedRelayForwardingConfig["hookIngress"]>,
  bindings: readonly RelayForwarding.RelayForwardingBinding[],
) {
  const relay = yield* RelayRuntime;
  const forwarding = yield* RelayForwarding.RelayForwarding;
  const crypto = yield* Effect.context<Digest.Digest | Signature.Signature>();
  const byEnvironment = new Map(bindings.map((binding) => [binding.environmentId, binding]));
  const wakeups = yield* Queue.sliding<void>(1);
  const notify = Queue.offer(wakeups, undefined).pipe(Effect.asVoid);
  const hookServices = yield* Layer.build(
    RelayHookIngress.layer({
      resolvePolicy: (target) => {
        const binding = byEnvironment.get(target.environmentId);
        if (!binding || SelfHostedRelayIngress.originAdmission(binding) !== "active") {
          return Effect.succeed(null);
        }
        return relay.authorizeHook(target).pipe(
          Effect.catchTags({
            RelayAccessDeniedError: () => Effect.succeed(null),
            RelayAuthenticationError: () => Effect.succeed(null),
            RelayInputError: () => Effect.succeed(null),
            RelayRuntimeStateError: (cause) =>
              Effect.fail(new RelayStorageError({ reason: "io", cause })),
          }),
        );
      },
      deliver: (delivery, signal) =>
        SelfHostedRelayHookDelivery.deliver(config.signingKey, delivery, signal).pipe(
          Effect.provideService(RelayForwarding.RelayForwarding, forwarding),
          Effect.provideContext(crypto),
        ),
    }).pipe(Layer.provide(RelayHookStore.layer)),
  );
  const ingress = yield* RelayHookIngress.RelayHookIngress.pipe(
    Effect.provideContext(hookServices),
  );
  const waitForWork = Queue.take(wakeups);
  const sweep = Effect.gen(function* () {
    const next = yield* ingress.dispatchDue().pipe(
      Effect.catchTags({
        RelayStorageError: ({ reason }) =>
          Effect.logWarning("Held webhook dispatch unavailable", { reason }).pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.map((now) => now + 10_000),
          ),
      }),
    );
    if (next === null) return yield* waitForWork;
    const now = yield* Clock.currentTimeMillis;
    yield* waitForWork.pipe(Effect.timeoutOption(Math.max(1, next - now)));
  });
  yield* Effect.forkScoped(Effect.forever(sweep));
  yield* SelfHostedRelayHookIngress.start(config, notify).pipe(Effect.provideContext(hookServices));
  return notify;
}, Effect.provide(NodeCrypto.layer));

export const layer = (options: {
  readonly homeDirectory: string;
  readonly port: number;
  readonly forwardingConfigPath?: string;
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      let registry: ReturnType<typeof openRelayHomeOriginRegistry>;
      const runtime = yield* Layer.build(
        relayRuntimeLayer({
          homeDirectory: options.homeDirectory,
          beforeEnvironmentRevoke: (environmentId) =>
            Effect.try({
              try: () => registry?.retireEnvironment(environmentId),
              catch: (cause) => new RelayStorageError({ reason: "io", cause }),
            }),
        }),
      );
      // The runtime holds the home lock until after the authority and all listeners close.
      registry = yield* Effect.acquireRelease(
        Effect.try({
          try: () => openRelayHomeOriginRegistry(options.homeDirectory),
          catch: (cause) => new RelayStorageError({ reason: "io", cause }),
        }),
        (authority) => Effect.sync(() => authority?.[Symbol.dispose]()),
      );
      let notifyHooks: Effect.Effect<void> | undefined;
      if (options.forwardingConfigPath !== undefined) {
        const config = yield* loadSelfHostedRelayForwardingConfig(options.forwardingConfigPath);
        if (registry === undefined) return yield* new SelfHostedRelayConfigError();
        const authority = registry;
        const hookOrigin = config.hookIngress?.origin;
        if (hookOrigin !== undefined) {
          yield* Effect.try({
            try: () => {
              if (authority.lookup(hookOrigin).status !== "unknown") {
                throw new SelfHostedRelayConfigError();
              }
            },
            catch: () => new SelfHostedRelayConfigError(),
          });
        }
        const bindings = yield* Effect.try({
          try: () =>
            config.bindings.map((binding) => {
              const admission = () => {
                const record = authority.lookup(binding.publicOrigin);
                return record.status !== "unknown" && record.environmentId === binding.environmentId
                  ? record.status
                  : "unknown";
              };
              if (admission() === "unknown") throw new SelfHostedRelayConfigError();
              return { ...binding, admission };
            }),
          catch: () => new SelfHostedRelayConfigError(),
        });
        const forwarding = yield* Layer.build(RelayForwarding.layer(bindings)).pipe(
          Effect.provideContext(runtime),
        );
        if (config.hookIngress !== undefined) {
          notifyHooks = yield* startHooks(config.hookIngress, bindings).pipe(
            Effect.provideContext(forwarding),
            Effect.provideContext(runtime),
          );
        }
        yield* SelfHostedRelayPublisherHttp.start(config.control, bindings, notifyHooks).pipe(
          Effect.provideContext(forwarding),
        );
        const browserAdmission = yield* Layer.build(SelfHostedRelayBrowserAdmission.layer).pipe(
          Effect.provideContext(runtime),
        );
        yield* SelfHostedRelayIngress.start(config.ingress, bindings).pipe(
          Effect.provideContext(forwarding),
          Effect.provideContext(browserAdmission),
        );
      }
      return managementLayer(options.port, notifyHooks).pipe(
        Layer.provide(RelayDirectory.layer.pipe(Layer.provideMerge(Layer.succeedContext(runtime)))),
      );
    }),
  );
