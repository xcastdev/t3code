import type { EnvironmentId } from "@t3tools/contracts";
import {
  SelfHostedRelayDirectoryPublication,
  type SelfHostedRelayDirectoryDiscovery,
} from "@t3tools/contracts/selfHostedRelayDirectory";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { RelayAccessDeniedError, RelayInputError, RelayRuntime } from "./RelayRuntime.ts";

const maxActivePublishers = 256;

export class RelayDirectoryPublisherLimitError extends Schema.TaggedError<
  RelayDirectoryPublisherLimitError,
  { readonly brand: unique symbol }
>()("RelayDirectoryPublisherLimitError", {
  reason: Schema.Literals(["environment-busy", "capacity"]),
}) {}

export class RelayDirectoryPublisherClosedError extends Schema.TaggedError<
  RelayDirectoryPublisherClosedError,
  { readonly brand: unique symbol }
>()("RelayDirectoryPublisherClosedError", {}) {}

type RuntimeError = Effect.Error<ReturnType<RelayRuntime["Service"]["authorizeLive"]>>;
type AddressHints = SelfHostedRelayDirectoryPublication["addressHints"];

interface PublisherLease {
  readonly signal: AbortSignal;
  readonly replace: (
    input: unknown,
  ) => Effect.Effect<
    void,
    RelayInputError | RelayAccessDeniedError | RelayDirectoryPublisherClosedError
  >;
}

export class RelayDirectory extends Context.Service<
  RelayDirectory,
  {
    readonly openPublisher: (
      credential: string,
      input: unknown,
    ) => Effect.Effect<
      PublisherLease,
      RuntimeError | RelayDirectoryPublisherLimitError | RelayDirectoryPublisherClosedError,
      Scope.Scope
    >;
    readonly discover: (
      credential: string,
      environmentId?: EnvironmentId,
    ) => Effect.Effect<SelfHostedRelayDirectoryDiscovery, RuntimeError>;
  }
>()("@t3tools/relay-core/RelayDirectory") {}

const decodePublication = Schema.decodeUnknownEffect(SelfHostedRelayDirectoryPublication, {
  onExcessProperty: "error",
});

const make = Effect.gen(function* () {
  const runtime = yield* RelayRuntime;
  const publishers = new Map<EnvironmentId, { hints: AddressHints }>();

  const openPublisher = Effect.fn("RelayDirectory.openPublisher")(function* (
    credential: string,
    input: unknown,
  ) {
    const { environmentId, addressHints } = yield* decodePublication(input).pipe(
      Effect.mapError(() => new RelayInputError()),
    );
    const parent = yield* Scope.Scope;
    const acquire = Effect.gen(function* () {
      const signal = yield* runtime.authorizeLive(credential, {
        kind: "environment.publish",
        environmentId,
      });
      const publisher = { hints: addressHints };

      const remove = () => {
        if (publishers.get(environmentId) === publisher) {
          publishers.delete(environmentId);
        }
        publisher.hints = [];
      };

      yield* Effect.acquireRelease(
        Effect.gen(function* () {
          if (signal.aborted) return yield* new RelayDirectoryPublisherClosedError();
          if (publishers.has(environmentId)) {
            return yield* new RelayDirectoryPublisherLimitError({ reason: "environment-busy" });
          }
          if (publishers.size >= maxActivePublishers) {
            return yield* new RelayDirectoryPublisherLimitError({ reason: "capacity" });
          }
          publishers.set(environmentId, publisher);
          signal.addEventListener("abort", remove, { once: true });
        }),
        () =>
          Effect.sync(() => {
            signal.removeEventListener("abort", remove);
            remove();
          }),
      );

      const replace = Effect.fn("RelayDirectory.replacePublication")(function* (input: unknown) {
        const next = yield* decodePublication(input).pipe(
          Effect.mapError(() => new RelayInputError()),
        );
        if (signal.aborted || publishers.get(environmentId) !== publisher) {
          return yield* new RelayDirectoryPublisherClosedError();
        }
        if (next.environmentId !== environmentId) return yield* new RelayAccessDeniedError();
        publisher.hints = next.addressHints;
      });
      return { signal, replace };
    });
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(parent);
        return yield* restore(acquire.pipe(Scope.provide(scope))).pipe(
          // Release P3's live authorization immediately if directory admission fails.
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
        );
      }),
    );
  });

  const discover = Effect.fn("RelayDirectory.discover")(function* (
    credential: string,
    environmentId?: EnvironmentId,
  ) {
    // Later publications cannot enter a read whose authorization has already completed.
    const hints = new Map(
      [...publishers].map(([id, publisher]) => [id, publisher.hints.map((hint) => ({ ...hint }))]),
    );
    const environments = yield* runtime.discoverEnvironments(credential, environmentId);
    return {
      version: 1,
      environments: environments.map((environment) => ({
        ...environment,
        addressHints: hints.get(environment.environmentId) ?? [],
      })),
    } satisfies SelfHostedRelayDirectoryDiscovery;
  });

  return RelayDirectory.of({ openPublisher, discover });
});

export const layer = Layer.effect(RelayDirectory, make);
