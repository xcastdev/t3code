import { expect, it } from "@effect/vitest";
import type { ExternalNotificationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { sendExternalNotification } from "./webhook.ts";

const event = {
  environmentId: "env-1",
  environmentName: "",
  occurrenceId: "occurrence-1",
  eventType: "work-attention",
  timestamp: "2026-11-18T12:00:00.000Z",
  title: "Review résumé",
  projectId: "project-1",
  taskId: "task-1",
  reason: "needs-review",
} satisfies ExternalNotificationEvent;

const destination = {
  id: "webhook",
  name: "Webhook",
  enabled: true,
  events: ["work-attention"],
  webhookUrl: "http://home.lan/webhook/secret",
} as const;

it.effect("signs the exact generic payload while retaining the Home Assistant fields", () =>
  Effect.gen(function* () {
    const calls: Request[] = [];
    const send = (kind: "generic-webhook" | "home-assistant", sample: ExternalNotificationEvent) =>
      sendExternalNotification({ ...destination, kind, signingKey: "key" }, sample).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, (url, init) => {
          calls.push(new Request(url, init));
          return Promise.resolve(new Response(null, { status: 204 }));
        }),
      );

    yield* send("generic-webhook", event);
    yield* send("home-assistant", { ...event, environmentName: "Renamed" });
    const [generic, home] = calls;
    if (!generic || !home) throw new Error("Expected two webhook deliveries");
    const body = yield* Effect.promise(() => generic.arrayBuffer());
    const signature = generic.headers.get("X-T3-Signature");
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("key"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
    const digest = Uint8Array.fromHex(signature!.slice("sha256=".length));
    expect(yield* Effect.promise(() => crypto.subtle.verify("HMAC", key, digest, body))).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
      ...event,
      environmentName: "env-1",
      schemaVersion: 1,
      kind: "work-attention",
      test: false,
    });
    expect(home.headers.has("X-T3-Signature")).toBe(false);
    expect(yield* Effect.promise(() => home.json())).toEqual({
      environmentId: "env-1",
      environmentName: "Renamed",
      schemaVersion: 1,
      kind: "work-attention",
      test: false,
      title: event.title,
      projectId: event.projectId,
      taskId: event.taskId,
    });
    expect(calls.map((request) => request.redirect)).toEqual(["manual", "manual"]);
  }),
);

it.effect("rejects unsafe URLs and reports redirects without leaking credentials", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const send = (webhookUrl: string) =>
      sendExternalNotification({ ...destination, kind: "home-assistant", webhookUrl }, event).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, (url) => {
          calls.push(String(url));
          return Promise.resolve(
            new Response("response-secret", {
              status: 307,
              headers: { location: "https://elsewhere.test/leak" },
            }),
          );
        }),
        Effect.flip,
      );

    for (const invalid of [
      "file:///tmp/webhook",
      "https://user:pass@host.test/",
      "https://host.test/#",
    ]) {
      expect((yield* send(invalid)).reason).toBe("malformed-url");
    }
    expect(calls).toEqual([]);

    const failure = yield* send(destination.webhookUrl);
    expect(failure.reason).toBe("http-status");
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(calls).toEqual([destination.webhookUrl]);
  }),
);

it.effect("distinguishes deadlines before and after the request reaches a connection", () =>
  Effect.gen(function* () {
    for (const started of [false, true]) {
      const ready = Promise.withResolvers<void>();
      const result = yield* sendExternalNotification(
        { ...destination, kind: "home-assistant" },
        event,
        () => started,
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, () => {
          ready.resolve();
          return new Promise(() => undefined);
        }),
        Effect.flip,
        Effect.forkScoped,
      );
      yield* Effect.promise(() => ready.promise);
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(result);
      expect(error.reason).toBe("timeout");
      expect(error.knownFailure).toBe(started ? undefined : true);
    }
  }),
);
