// @effect-diagnostics nodeBuiltinImport:off -- The fixture owns a real incomplete HTTP connection.
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import { fetch } from "undici";

import * as SelfHostedRelayApplication from "./SelfHostedRelayApplication.ts";

it.live("closes incomplete HTTP connections when the relay layer shuts down", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-socket-" });
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    let origin: string | undefined;
    const logger = Logger.make(({ message }) => {
      origin ??= /Self-hosted relay listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(
        String(message),
      )?.[1];
    });
    yield* Layer.buildWithScope(
      SelfHostedRelayApplication.layer({ homeDirectory, port: 0 }).pipe(
        Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
      ),
      scope,
    );
    assert.isDefined(origin);
    const url = new URL(origin!);
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => NodeNet.createConnection({ host: url.hostname, port: Number(url.port) })),
      (client) => Effect.sync(() => client.destroy()),
    );
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.once("connect", () =>
            socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n", (error) =>
              error ? reject(error) : resolve(),
            ),
          );
        }),
    );
    yield* Effect.promise(async (signal) => {
      const response = await fetch(`${origin}/api/self-hosted-relay/v1/status`, { signal });
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    });
    yield* Scope.close(scope, Exit.void);
    yield* Effect.promise(() => closed);
    assert.isTrue(socket.destroyed);
  }).pipe(Effect.provide(NodeServices.layer)),
);
