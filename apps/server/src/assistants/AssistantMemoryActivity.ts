import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
export class AssistantMemoryActivity extends Context.Service<
  AssistantMemoryActivity,
  {
    readonly wake: Effect.Effect<void>;
    readonly subscribe: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("t3/assistants/AssistantMemoryActivity") {}
export const layer = Layer.effect(
  AssistantMemoryActivity,
  Effect.gen(function* () {
    const hints = yield* PubSub.sliding<void>(1);
    return AssistantMemoryActivity.of({
      wake: PubSub.publish(hints, undefined).pipe(Effect.asVoid),
      subscribe: Effect.map(PubSub.subscribe(hints), Stream.fromSubscription),
    });
  }),
);
