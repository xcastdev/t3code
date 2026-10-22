import type { AssistantGetInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export class AssistantEventBus extends Context.Service<
  AssistantEventBus,
  {
    readonly publish: (scope: AssistantGetInput) => Effect.Effect<void>;
    readonly subscribe: Effect.Effect<Stream.Stream<AssistantGetInput>, never, Scope.Scope>;
  }
>()("t3/assistants/AssistantEventBus") {}

const make = Effect.gen(function* () {
  // Every hint invalidates the bounded page, so dropping intermediate IDs is safe.
  const bus = yield* PubSub.sliding<AssistantGetInput>(1);
  return AssistantEventBus.of({
    publish: Effect.fn("AssistantEventBus.publish")((scope: AssistantGetInput) =>
      PubSub.publish(bus, scope).pipe(Effect.asVoid),
    ),
    subscribe: PubSub.subscribe(bus).pipe(Effect.map(Stream.fromSubscription)),
  });
});
export const layer = Layer.effect(AssistantEventBus, make);
