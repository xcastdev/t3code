// @effect-diagnostics nodeBuiltinImport:off - The transport test observes requests on a real socket.
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as NodeDns from "node:dns";
import type * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttp from "node:http";
import { vi } from "vite-plus/test";
import * as Transport from "./ExternalNotificationTransport.ts";

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeDnsPromises>();
  return {
    ...actual,
    lookup: (host: string, options: NodeDns.LookupAllOptions) =>
      host === "receiver.example.com" || host === "receiver.lan"
        ? Promise.resolve([{ address: "127.0.0.1", family: 4 }])
        : host === "receiver.invalid"
          ? Promise.reject(new Error("Fixture DNS failure"))
          : actual.lookup(host, options),
  };
});

it.live("checks the connected address and does not follow redirects from private receivers", () =>
  Effect.gen(function* () {
    const paths: Array<string | undefined> = [];
    const server = yield* Effect.acquireRelease(
      Effect.callback<NodeHttp.Server, Error>((resume) => {
        const listener = NodeHttp.createServer((request, response) => {
          paths.push(request.url);
          if (request.url === "/disconnect") {
            request.socket.destroy();
            return;
          }
          if (request.url === "/redirect") response.writeHead(307, { location: "/unexpected" });
          else response.writeHead(204);
          response.end();
        });
        listener.once("error", (error) => resume(Effect.fail(error)));
        listener.listen(0, "127.0.0.1", () => resume(Effect.succeed(listener)));
      }),
      (listener) =>
        Effect.callback<void>((resume) => {
          listener.close(() => resume(Effect.void));
          listener.closeAllConnections();
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.die(new Error("Expected TCP listener"));
    }
    const transport = yield* Transport.ExternalNotificationTransport;
    const send = (host: string, path: string, sender = transport) =>
      sender.send(
        {
          id: "generic",
          name: "Webhook",
          kind: "generic-webhook",
          enabled: true,
          events: ["completion"],
          webhookUrl: `http://${host}:${address.port}${path}`,
        },
        {
          environmentId: "env",
          environmentName: "Test",
          eventType: "test",
          occurrenceId: "transport-test",
          timestamp: "2026-11-18T12:00:00.000Z",
          title: "Test",
        },
      );

    yield* send("127.0.0.1", "/literal");
    yield* send("receiver.lan", "/lan");
    const blocked = yield* Effect.flip(send("receiver.example.com", "/public-name"));
    expect(blocked.reason).toBe("transport");
    expect(blocked.knownFailure).toBe(true);
    const unresolved = yield* Effect.flip(send("receiver.invalid", "/unresolved"));
    expect(unresolved.knownFailure).toBe(true);

    const localOrigin = `http://receiver.example.com:${address.port}`;
    const trusted = Layer.fresh(Transport.layer).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { T3CODE_EXTERNAL_NOTIFICATION_PRIVATE_ORIGINS: localOrigin },
          }),
        ),
      ),
    );
    yield* Transport.ExternalNotificationTransport.use((sender) =>
      send("receiver.example.com", "/split-dns", sender),
    ).pipe(Effect.provide(trusted));
    expect((yield* Effect.flip(send("127.0.0.1", "/redirect"))).reason).toBe("http-status");
    const disconnected = yield* Effect.flip(send("127.0.0.1", "/disconnect"));
    expect(disconnected.reason).toBe("transport");
    expect(disconnected.knownFailure).toBeUndefined();
    expect(paths).toEqual(["/literal", "/lan", "/split-dns", "/redirect", "/disconnect"]);
  }).pipe(Effect.scoped, Effect.provide(Transport.layer)),
);
