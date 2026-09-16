import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, WS_METHODS, type GitActionRequest } from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { EnvironmentCacheStore } from "@t3tools/client-runtime/platform";
import { type RpcSession, type WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { sourceControlWorkspaceRevisionAtom } from "@t3tools/client-runtime/state/sourceControlWorkspace";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { createSourceControlWorkspaceWebAdapter } from "./sourceControl.ts";

import { runSourceControlWorkspaceAdapter } from "./sourceControlActions.ts";

describe("source control workspace adapters", () => {
  it.effect(
    "uses negotiated config for real discovery/comparison/amend commands and shared mutation policy",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const environmentId = EnvironmentId.make("web-adapter");
          const calls: string[] = [];
          const actions: GitActionRequest[] = [];
          const client = {
            [WS_METHODS.gitDiscoverRepositories]: () =>
              Effect.sync(() => {
                calls.push("discover");
                return { projectRoot: "/repo", repositories: [], truncated: false };
              }),
            [WS_METHODS.gitCompareRepositoryFile]: () =>
              Effect.sync(() => {
                calls.push("compare");
                return {};
              }),
            [WS_METHODS.gitRunAction]: (input: GitActionRequest) =>
              Effect.sync(() => {
                actions.push(input);
                return { action: input.action, completed: [input.action] };
              }),
          } as unknown as WsRpcProtocolClient;
          const supervisor = EnvironmentSupervisor.of({
            target: new PrimaryConnectionTarget({
              environmentId,
              label: "test",
              httpBaseUrl: "http://test",
              wsBaseUrl: "ws://test",
            }),
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected",
              generation: 1,
            }),
            session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
              Option.some({
                client,
                initialConfig: Effect.never,
                subscribeServerConfig: client.subscribeServerConfig,
                ready: Effect.void,
                probe: Effect.void,
                closed: Effect.never,
              }),
            ),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          });
          const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor, supervisor);
          const removed: string[] = [];
          const runtime = Atom.runtime(
            Layer.merge(
              Layer.succeed(EnvironmentRegistry, { run } as EnvironmentRegistry["Service"]),
              Layer.succeed(
                EnvironmentCacheStore,
                EnvironmentCacheStore.of({
                  loadShell: () => Effect.succeed(Option.none()),
                  saveShell: () => Effect.void,
                  loadThread: () => Effect.succeed(Option.none()),
                  saveThread: () => Effect.void,
                  removeThread: () => Effect.void,
                  loadServerConfig: () => Effect.succeed(Option.none()),
                  saveServerConfig: () => Effect.void,
                  loadVcsRefs: () => Effect.succeed(Option.none()),
                  saveVcsRefs: () => Effect.void,
                  removeVcsRefs: (_id, cwd) =>
                    Effect.sync(() => {
                      removed.push(cwd);
                    }),
                  clearVcsRefs: () => Effect.void,
                  clear: () => Effect.void,
                }),
              ),
            ),
          );
          const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
            Effect.sync(() => value.dispose()),
          );
          const config = Atom.make<{
            environment: { capabilities: { sourceControlWorkspace?: boolean } };
          } | null>(null);
          const adapter = createSourceControlWorkspaceWebAdapter(runtime, () => config);
          const amend = { cwd: "/repo/", action: "amend", confirm: false } as const;
          for (const capabilities of [undefined, {}, { sourceControlWorkspace: false }]) {
            registry.set(
              config,
              capabilities === undefined ? null : { environment: { capabilities } },
            );
            const results = yield* Effect.promise(() =>
              Promise.all([
                adapter.discoverRepositories.run(registry, {
                  environmentId,
                  input: { cwd: "/repo" },
                }),
                adapter.compareRepositoryFile.run(registry, {
                  environmentId,
                  input: { cwd: "/repo", comparison: "working-tree", oldPath: "a", newPath: "a" },
                }),
                adapter.runAction.run(registry, {
                  environmentId,
                  input: { ...amend, confirm: true },
                }),
              ]),
            );
            for (const result of results)
              expect(
                result._tag === "Failure" && Cause.squash<unknown>(result.cause),
              ).toMatchObject({
                _tag: "SourceControlWorkspaceUnavailableError",
              });
          }
          expect(calls).toEqual([]);
          expect(actions).toEqual([]);
          registry.set(config, { environment: { capabilities: { sourceControlWorkspace: true } } });
          const first = yield* Effect.promise(() =>
            adapter.runAction.run(registry, { environmentId, input: amend }),
          );
          expect(AsyncResult.isFailure(first) && Cause.squash(first.cause)).toMatchObject({
            status: "confirmation-required",
          });
          yield* Effect.promise(() =>
            adapter.discoverRepositories.run(registry, { environmentId, input: { cwd: "/repo" } }),
          );
          const approved = yield* Effect.promise(() =>
            adapter.runAction.run(registry, { environmentId, input: { ...amend, confirm: true } }),
          );
          expect(AsyncResult.isSuccess(approved)).toBe(true);
          expect(calls).toEqual(["discover"]);
          expect(actions).toEqual([{ ...amend, cwd: "/repo", confirm: true }]);
          expect(removed).toEqual(["/repo"]);
          expect(
            registry.get(
              sourceControlWorkspaceRevisionAtom({ environmentId, repositoryRoot: "/repo" }),
            ),
          ).toBe(1);
          expect(
            registry.get(
              sourceControlWorkspaceRevisionAtom({ environmentId, repositoryRoot: "/other" }),
            ),
          ).toBe(0);
        }),
      ),
  );
  it("does not invoke an additive workspace RPC before capability negotiation", async () => {
    let calls = 0;

    const result = await runSourceControlWorkspaceAdapter(
      undefined,
      async () => {
        calls += 1;
        return "rpc-result";
      },
      () => "source-control-workspace-not-advertised",
    );

    expect(result).toBe("source-control-workspace-not-advertised");
    expect(calls).toBe(0);
  });

  it("invokes an additive workspace RPC only after negotiation", async () => {
    let calls = 0;

    const result = await runSourceControlWorkspaceAdapter(
      { sourceControlWorkspace: true },
      async () => {
        calls += 1;
        return "rpc-result";
      },
      () => "source-control-workspace-not-advertised",
    );

    expect(result).toBe("rpc-result");
    expect(calls).toBe(1);
  });
});
