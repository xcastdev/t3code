import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Host from "@t3tools/provider-testing/TestProviderHost";
import * as Ids from "@t3tools/provider-core/server/IdAllocator";
import * as Catalogs from "@t3tools/provider-core/server/McpProviderSessions";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ProviderInstanceId } from "@t3tools/contracts";
import { OmpDriver } from "./driver.ts";
it.effect("default disabled provider snapshots and refreshes never launch native work", () =>
  Effect.gen(function* () {
    const config = OmpDriver.defaultConfig();
    expect(config.enabled).toBe(false);
    let launches = 0;
    const instance = yield* OmpDriver.create({
      instanceId: ProviderInstanceId.make("omp-test"),
      displayName: undefined,
      environment: [],
      enabled: false,
      config,
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            launches++;
            throw new Error("Disabled provider spawned");
          }),
        ),
      ),
    );
    expect(yield* instance.snapshot.getSnapshot).toMatchObject({
      enabled: false,
      status: "disabled",
      models: [],
    });
    expect(yield* instance.snapshot.refresh).toMatchObject({ status: "disabled" });
    expect(yield* instance.snapshotForCwd!("/workspace")).toMatchObject({
      status: "disabled",
      slashCommandsPending: false,
    });
    expect(launches).toBe(0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Ids.layer,
        Catalogs.layer,
        Host.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  ),
);
