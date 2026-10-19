import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolver } from "./project/RepositoryIdentityResolver.ts";
import { TerminalManager } from "./terminal/Manager.ts";
import * as ServerSettings from "./serverSettings.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { HostProcessArguments, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import { PiProductionRuntimeLayerLive, GitWorkflowLayerLive } from "./server.ts";
import * as ServerConfig from "./config.ts";
import { ProviderInstanceRegistryMutableLayer } from "./provider/Layers/ProviderInstanceRegistryLive.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { makePiDriver } from "./provider/Drivers/PiDriver.ts";
import { makePiAdapter } from "./provider/Layers/PiAdapter.ts";
import { PiManagedRuntime } from "./provider/pi/PiManagedRuntime.ts";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { GitRepositoryPermits } from "./git/GitRepositoryPermits.ts";
import * as SkillMaterializationService from "./skills/SkillMaterializationService.ts";
import * as ManagedSkillRepository from "./skills/ManagedSkillRepository.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";

for (const platform of ["linux", "win32"] as const)
  it.effect(
    `acquires the production Pi and complete Git workflow chain on ${platform} before server readiness`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped();
          let productionPermits: GitRepositoryPermits["Service"] | undefined;
          const production = PiProductionRuntimeLayerLive.pipe(
            Layer.tap((services) =>
              Effect.sync(() => {
                productionPermits = Context.get(services, GitRepositoryPermits);
              }),
            ),
          );
          const registry = ProviderInstanceRegistryMutableLayer({
            drivers: [makePiDriver({ makeAdapter: makePiAdapter })],
            configMap: {
              [ProviderInstanceId.make("piAgent")]: {
                driver: ProviderDriverKind.make("piAgent"),
                enabled: false,
                config: {},
              },
            },
          }).pipe(Layer.provideMerge(production));
          const graph = GitWorkflowLayerLive.pipe(
            Layer.provideMerge(ProviderRegistryLive),
            Layer.provideMerge(registry),
            Layer.provideMerge(SkillMaterializationService.layer),
            Layer.provideMerge(ManagedSkillRepository.layer),
            Layer.provide(VcsProcess.layer),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(EnvironmentAuth)({}),
                Layer.mock(ProjectionSnapshotQuery)({}),
                Layer.mock(RepositoryIdentityResolver)({}),
                Layer.mock(TerminalManager)({}),
                ServerSettings.layerTest(),
              ),
            ),
            Layer.provide(ServerConfig.layerTest(root, { prefix: "pi-startup-graph-" })),
          );
          const acquired = yield* Layer.build(graph);
          expect(Context.get(acquired, PiManagedRuntime)).toBeDefined();
          const instances = Context.get(acquired, ProviderInstanceRegistry);
          const selected = yield* instances.getInstance(ProviderInstanceId.make("piAgent"));
          if (platform === "linux") expect(selected).toBeDefined();
          else {
            expect(selected).toBeUndefined();
            expect((yield* instances.listUnavailable).length).toBe(1);
            const runtime = Context.get(acquired, PiManagedRuntime);
            const denied = yield* runtime
              .forInstance({
                instanceId: ProviderInstanceId.make("piAgent"),
                enabled: true,
                configuration: {},
              })
              .pipe(Effect.result);
            expect(denied._tag).toBe("Failure");
            if (denied._tag === "Failure") expect(denied.failure.code).toBe("unavailable");
          }
          const workflow = Context.get(acquired, GitWorkflowService);
          const permits = Context.get(acquired, GitRepositoryPermits);
          expect(permits).toBe(productionPermits);
          yield* Effect.sync(() =>
            process
              .getBuiltinModule("child_process")
              .execFileSync("/usr/bin/git", ["init", "-q", root + "/repository"], {
                stdio: "ignore",
              }),
          );
          const semaphore = yield* permits.getMutationSemaphore(
            "git\0" + root + "/repository/.git",
          );
          yield* workflow.withRepositoryPermit(
            "startup.shared",
            root + "/repository",
            Effect.gen(function* () {
              expect(Option.isNone(yield* semaphore.withPermitsIfAvailable(1)(Effect.void))).toBe(
                true,
              );
            }),
          );
        }),
      ).pipe(
        Effect.provideService(HostProcessPlatform, platform),
        Effect.provideService(HostProcessArguments, [
          process.execPath,
          new URL("./server.ts", import.meta.url).pathname,
        ]),
        Effect.provide(NodeServices.layer),
      ),
  );
