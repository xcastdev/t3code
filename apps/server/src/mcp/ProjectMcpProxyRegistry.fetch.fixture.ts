import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type { FetchLike } from "@modelcontextprotocol/client";

/** Runs SDK fetch callbacks in the test's existing Effect scope. */
export const makeScopedFetch = Effect.fn(function* <E>(
  handle: (request: Request) => Effect.Effect<Response, E>,
) {
  const queue = yield* Queue.unbounded<{
    request: Request;
    resolve: (response: Response) => void;
    reject: (error: unknown) => void;
  }>();
  yield* Effect.gen(function* () {
    while (true) {
      const pending = yield* Queue.take(queue);
      yield* handle(pending.request).pipe(
        Effect.match({ onSuccess: pending.resolve, onFailure: pending.reject }),
        Effect.forkScoped,
      );
    }
  }).pipe(Effect.forkScoped);
  return ((input, init) =>
    new Promise<Response>((resolve, reject) => {
      Queue.offerUnsafe(queue, { request: new Request(String(input), init), resolve, reject });
    })) satisfies FetchLike;
});
