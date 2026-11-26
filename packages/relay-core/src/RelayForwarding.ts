// @effect-diagnostics nodeBuiltinImport:off -- The forwarding service owns Node's tunnel and exchange lifetimes.
import * as NodeEvents from "node:events";
import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { RelayAccessDeniedError, RelayInputError, RelayRuntime } from "./RelayRuntime.ts";
import {
  makeStaticRelayEdge,
  validRelayTunnelHookRequest,
  type RelayHostedForwardingPolicy,
  type RelayTunnelHookRequest,
  type RelayTunnelHookResponse,
} from "./RelayTunnelTransport.ts";

type Edge = ReturnType<typeof makeStaticRelayEdge>;
type EdgeOptions = Parameters<typeof makeStaticRelayEdge>[0];
type RuntimeError = Effect.Error<ReturnType<RelayRuntime["Service"]["authorizeLive"]>>;

export interface RelayForwardingBinding {
  readonly environmentId: EnvironmentId;
  readonly publicOrigin: string;
  readonly canonicalOrigin: string;
  readonly hostedClientOrigins?: ReadonlyArray<string>;
  readonly environmentFingerprint: string;
  readonly tunnelTls: EdgeOptions["tunnelTls"];
  readonly listen: { readonly host: string; readonly port: number };
  readonly admission?: EdgeOptions["admission"];
}

export type RelayForwardingExchange = {
  readonly request: NodeHttp.IncomingMessage;
  readonly signal?: AbortSignal;
  readonly hosted?: RelayHostedForwardingPolicy;
} & (
  | { readonly kind: "http" | "checkContinue"; readonly response: NodeHttp.ServerResponse }
  | { readonly kind: "upgrade"; readonly socket: NodeStream.Duplex; readonly head: Buffer }
);

interface PublisherLease {
  readonly signal: AbortSignal;
  readonly address: NodeNet.AddressInfo;
  readonly ready: Effect.Effect<void, RelayForwardingUnavailableError>;
}

export class RelayForwardingUnavailableError extends Schema.TaggedError<
  RelayForwardingUnavailableError,
  { readonly brand: unique symbol }
>()("RelayForwardingUnavailableError", {
  reason: Schema.Literals(["publisher-active", "publisher-offline", "closed", "listener"]),
}) {}

export class RelayForwarding extends Context.Service<
  RelayForwarding,
  {
    readonly openPublisher: (
      credential: string,
      environmentId: EnvironmentId,
    ) => Effect.Effect<PublisherLease, RuntimeError | RelayForwardingUnavailableError, Scope.Scope>;
    readonly forward: (
      credential: string,
      environmentId: EnvironmentId,
      exchange: RelayForwardingExchange,
    ) => Effect.Effect<void, RuntimeError | RelayForwardingUnavailableError>;
    readonly deliverHook: (
      environmentId: EnvironmentId,
      request: RelayTunnelHookRequest,
      signal?: AbortSignal,
    ) => Effect.Effect<RelayTunnelHookResponse, RelayInputError | RelayForwardingUnavailableError>;
  }
>()("@t3tools/relay-core/RelayForwarding") {}

const runExchange = Effect.fnUntraced(function* (
  edge: Edge,
  signal: AbortSignal,
  exchange: RelayForwardingExchange,
) {
  // RelayForwarding.forward owns the span for the entire exchange.
  yield* Effect.callback<void>((resume) => {
    const { request } = exchange;
    const downstream = exchange.kind === "upgrade" ? exchange.socket : exchange.response;
    if (downstream.destroyed || request.socket.destroyed) return resume(Effect.void);
    if (signal.aborted) {
      downstream.destroy();
      return resume(Effect.void);
    }

    const abort = NodeEvents.EventEmitter.addAbortListener(signal, () => {
      downstream.destroy();
      finish();
    });
    const finish = () => {
      cleanup();
      resume(Effect.void);
    };
    const cleanup = () => {
      abort[Symbol.dispose]();
      downstream.off("close", finish);
      downstream.off("finish", finish);
    };
    downstream.once("close", finish);
    if (exchange.kind === "upgrade") {
      edge.upgrade(request, exchange.socket, exchange.head, exchange.hosted);
    } else {
      downstream.once("finish", finish);
      if (exchange.kind === "checkContinue")
        edge.checkContinue(request, exchange.response, exchange.hosted);
      else edge.request(request, exchange.response, exchange.hosted);
    }
    return Effect.sync(() => {
      cleanup();
      downstream.destroy();
    });
  });
});

const bindingAdmission = (binding: RelayForwardingBinding) => {
  try {
    return binding.admission?.() ?? "active";
  } catch {
    return "unknown";
  }
};

const make = Effect.fn("RelayForwarding.make")(function* (
  bindings: ReadonlyArray<RelayForwardingBinding>,
) {
  const runtime = yield* RelayRuntime;
  const byEnvironment = new Map(bindings.map((binding) => [binding.environmentId, binding]));
  if (
    byEnvironment.size !== bindings.length ||
    new Set(bindings.map(({ publicOrigin }) => publicOrigin)).size !== bindings.length ||
    new Set(bindings.map(({ canonicalOrigin }) => canonicalOrigin)).size !== bindings.length ||
    new Set(bindings.map(({ environmentFingerprint }) => environmentFingerprint.toUpperCase()))
      .size !== bindings.length
  ) {
    return yield* new RelayInputError();
  }

  const publishers = new Map<
    EnvironmentId,
    { readonly edge: Edge; readonly signal: AbortSignal }
  >();
  const listeners = new Set<() => Promise<void>>();
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closed = true;
      await Promise.all([...listeners].map((stop) => stop()));
    }),
  );

  const openPublisher = Effect.fn("RelayForwarding.openPublisher")(function* (
    credential: string,
    environmentId: EnvironmentId,
  ) {
    const parent = yield* Scope.Scope;
    const acquire = Effect.gen(function* () {
      const grant = yield* runtime.authorizeLive(credential, {
        kind: "environment.tunnel",
        environmentId,
      });
      const binding = byEnvironment.get(environmentId);
      if (!binding) return yield* new RelayAccessDeniedError();
      if (bindingAdmission(binding) !== "active")
        return yield* new RelayForwardingUnavailableError({ reason: "closed" });

      const lease = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          if (closed || grant.aborted) {
            return yield* new RelayForwardingUnavailableError({ reason: "closed" });
          }
          if (publishers.has(environmentId)) {
            return yield* new RelayForwardingUnavailableError({ reason: "publisher-active" });
          }
          const edge = yield* Effect.try({
            try: () =>
              makeStaticRelayEdge({
                publicOrigin: binding.publicOrigin,
                canonicalOrigin: binding.canonicalOrigin,
                environmentFingerprint: binding.environmentFingerprint,
                tunnelTls: binding.tunnelTls,
                admission: () => bindingAdmission(binding),
              }),
            catch: () => new RelayForwardingUnavailableError({ reason: "listener" }),
          });
          // @effect-diagnostics-next-line abortControllerInEffect:off -- Grant revocation must synchronously withdraw TCP admission.
          const controller = new AbortController();
          const entry = { edge, signal: controller.signal };
          const stopped = Promise.withResolvers<void>();
          const stop = () => {
            if (!entry.signal.aborted) {
              publishers.delete(environmentId);
              controller.abort();
              grantAbort[Symbol.dispose]();
              edge.revoke();
              edge.tunnelServer.close(() => {
                edge.tunnelServer.off("error", stop);
                listeners.delete(stop);
                stopped.resolve();
              });
            }
            return stopped.promise;
          };
          const grantAbort = NodeEvents.EventEmitter.addAbortListener(grant, stop);
          edge.tunnelServer.on("error", stop);
          publishers.set(environmentId, entry);
          listeners.add(stop);
          return { ...entry, stop };
        }),
        ({ stop }) => Effect.promise(stop),
      );

      if (lease.signal.aborted) {
        return yield* new RelayForwardingUnavailableError({ reason: "closed" });
      }
      const server = lease.edge.tunnelServer;
      const address = yield* Effect.tryPromise({
        try: async (signal) => {
          const closing = AbortSignal.any([lease.signal, signal]);
          closing.throwIfAborted();
          server.listen({ host: binding.listen.host, port: binding.listen.port });
          await NodeEvents.EventEmitter.once(server, "listening", { signal: closing });
          const bound = server.address();
          if (bound === null || typeof bound === "string") throw new Error("Expected TCP address");
          return bound;
        },
        catch: () => new RelayForwardingUnavailableError({ reason: "listener" }),
      });

      const ready = Effect.callback<void, RelayForwardingUnavailableError>((resume) => {
        const fail = () =>
          resume(Effect.fail(new RelayForwardingUnavailableError({ reason: "closed" })));
        if (lease.signal.aborted) return fail();
        const abort = NodeEvents.EventEmitter.addAbortListener(lease.signal, fail);
        const cleanup = () => abort[Symbol.dispose]();
        void lease.edge.ready.then(() => {
          cleanup();
          if (lease.signal.aborted) fail();
          else resume(Effect.void);
        });
        return Effect.sync(cleanup);
      });
      return { signal: lease.signal, address, ready };
    });
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(parent);
        return yield* restore(acquire.pipe(Scope.provide(scope))).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
        );
      }),
    );
  });

  const forward = Effect.fn("RelayForwarding.forward")(function* (
    credential: string,
    environmentId: EnvironmentId,
    exchange: RelayForwardingExchange,
  ) {
    const downstream = exchange.kind === "upgrade" ? exchange.socket : exchange.response;
    const attempt = Effect.gen(function* () {
      const grant = yield* runtime.authorizeLive(credential, { kind: "forward", environmentId });
      const publisher = publishers.get(environmentId);
      const binding = byEnvironment.get(environmentId);
      if (
        !binding ||
        (exchange.hosted !== undefined &&
          !binding.hostedClientOrigins?.includes(exchange.hosted.clientOrigin))
      )
        return yield* new RelayAccessDeniedError();
      if (bindingAdmission(binding) !== "active")
        return yield* new RelayForwardingUnavailableError({ reason: "closed" });
      if (!publisher)
        return yield* new RelayForwardingUnavailableError({ reason: "publisher-offline" });
      const signal = AbortSignal.any([
        grant,
        publisher.signal,
        ...(exchange.signal ? [exchange.signal] : []),
      ]);
      yield* runExchange(publisher.edge, signal, exchange);
    });
    const run = Effect.gen(function* () {
      if (exchange.signal === undefined) return yield* attempt;
      const cancelled = yield* Deferred.make<void>();
      yield* Effect.acquireDisposable(
        Effect.sync(() =>
          NodeEvents.EventEmitter.addAbortListener(exchange.signal!, () => {
            downstream.destroy();
            Deferred.doneUnsafe(cancelled, Effect.void);
          }),
        ),
      );
      if (exchange.signal.aborted) {
        downstream.destroy();
        return;
      }
      yield* Effect.raceFirst(attempt, Deferred.await(cancelled)).pipe(
        Effect.catch((error) => (exchange.signal?.aborted ? Effect.void : Effect.fail(error))),
      );
    });
    yield* run.pipe(Effect.onInterrupt(() => Effect.sync(() => downstream.destroy())));
  }, Effect.scoped);

  const deliverHook = Effect.fn("RelayForwarding.deliverHook")(function* (
    environmentId: EnvironmentId,
    request: RelayTunnelHookRequest,
    policySignal?: AbortSignal,
  ) {
    if (!validRelayTunnelHookRequest(request)) return yield* new RelayInputError();
    const binding = byEnvironment.get(environmentId);
    if (!binding || bindingAdmission(binding) !== "active" || policySignal?.aborted) {
      return yield* new RelayForwardingUnavailableError({ reason: "closed" });
    }
    const publisher = publishers.get(environmentId);
    if (!publisher)
      return yield* new RelayForwardingUnavailableError({ reason: "publisher-offline" });
    const reply = yield* Effect.promise((signal) =>
      publisher.edge.deliverHook(
        request,
        AbortSignal.any([publisher.signal, signal, ...(policySignal ? [policySignal] : [])]),
      ),
    ).pipe(Effect.timeoutOption("10 seconds"));
    if (reply._tag === "None" || reply.value === undefined) {
      return yield* new RelayForwardingUnavailableError({ reason: "closed" });
    }
    return reply.value;
  });

  return RelayForwarding.of({ openPublisher, forward, deliverHook });
});

export const layer = (bindings: ReadonlyArray<RelayForwardingBinding>) =>
  Layer.effect(RelayForwarding, make(bindings));
