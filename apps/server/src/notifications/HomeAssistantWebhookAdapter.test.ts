import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Adapter from "./HomeAssistantWebhookAdapter.ts";
const payload = { schemaVersion: 1, test: true, kind: "test", title: "Test" } as const;
it.effect("posts a bounded JSON payload and redacts HTTP failures", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.method);
        return HttpClientResponse.fromWeb(
          request,
          new Response("secret-response", { status: 503 }),
        );
      }),
    );
    const adapter = yield* Adapter.HomeAssistantWebhookAdapter.pipe(
      Effect.provide(Adapter.layer),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    const result = yield* Effect.flip(adapter.send("https://home.test/webhook/SECRET", payload));
    expect(result.reason).toBe("http-status");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("secret-response");
    expect(requests).toEqual(["POST"]);
  }),
);
it.effect("rejects malformed and credential-bearing URLs before HTTP", () =>
  Effect.gen(function* () {
    let sends = 0;
    const client = HttpClient.make(() => {
      sends++;
      return Effect.die("unexpected");
    });
    const adapter = yield* Adapter.HomeAssistantWebhookAdapter.pipe(
      Effect.provide(Adapter.layer),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    for (const url of ["garbage", "file:///tmp/secret", "https://user:secret@host.test/webhook"]) {
      expect((yield* Effect.flip(adapter.send(url, payload))).reason).toBe("malformed-url");
    }
    expect(sends).toBe(0);
  }),
);

it.effect("times out an ambiguous request without replay or credential leakage", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let sends = 0;
    const client = HttpClient.make(() =>
      Effect.gen(function* () {
        sends++;
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    );
    const adapter = yield* Adapter.HomeAssistantWebhookAdapter.pipe(
      Effect.provide(Adapter.layer),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    const fiber = yield* Effect.flip(
      adapter.send("https://home.test/webhook/SECRET", payload),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("10 seconds");
    const error = yield* Fiber.join(fiber);
    expect(error.reason).toBe("timeout");
    expect(JSON.stringify(error)).not.toContain("SECRET");
    expect(sends).toBe(1);
  }),
);
