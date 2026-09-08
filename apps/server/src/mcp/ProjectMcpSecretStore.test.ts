import {
  McpServerId,
  type ProjectMcpCredentialId,
  ProjectMcpEnvironmentVariableName,
  ProjectMcpHeaderName,
  type ProjectMcpTransport,
  type ProjectMcpTransportDraft,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectMcpSecretStore from "./ProjectMcpSecretStore.ts";

const serverA = McpServerId.make("mcp-secret-server-a");
const serverB = McpServerId.make("mcp-secret-server-b");

const httpDraft = (value: string): ProjectMcpTransportDraft => ({
  type: "streamable-http",
  url: "https://mcp.example.test/rpc",
  headers: [
    {
      name: ProjectMcpHeaderName.make("X-Api-Key"),
      credential: { name: "primary key", value },
    },
  ],
  authorization: { type: "none" },
});

const stdioDraft = (value: string): ProjectMcpTransportDraft => ({
  type: "stdio",
  command: "node",
  args: ["server.mjs"],
  env: [
    {
      name: ProjectMcpEnvironmentVariableName.make("TOKEN"),
      credential: { name: "session token", value },
    },
  ],
});

const credentialId = (transport: ProjectMcpTransport): ProjectMcpCredentialId => {
  if (transport.type === "stdio") return transport.env[0]!.credential.id;
  return transport.headers[0]!.credential.id;
};

const makeSecretLayer = (config: ServerConfig.ServerConfig["Service"]) =>
  ProjectMcpSecretStore.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, config)),
    Layer.provideMerge(NodeServices.layer),
  );

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("ProjectMcpSecretStore", (it) => {
  it.effect("stores create values under generated credential IDs and exposes only references", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        const secretFiles = yield* ServerSecretStore.ServerSecretStore;

        const prepared = yield* secrets.prepareCreate(serverA, stdioDraft("stdio-sentinel"));
        const id = credentialId(prepared.transport);

        assert.match(
          id,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        assert.deepEqual(prepared.transport, {
          type: "stdio",
          command: "node",
          args: ["server.mjs"],
          env: [
            {
              name: ProjectMcpEnvironmentVariableName.make("TOKEN"),
              credential: { id, name: "session token" },
            },
          ],
        });
        assert.notInclude(encodeUnknownJson(prepared.transport), "stdio-sentinel");
        assert.deepEqual(
          Array.from(
            Option.getOrThrow(
              yield* secretFiles.get(ProjectMcpSecretStore.credentialSecretName(id)),
            ),
          ),
          Array.from(new TextEncoder().encode("stdio-sentinel")),
        );

        yield* prepared.commit;
        assert.equal(yield* secrets.resolve(serverA, id), "stdio-sentinel");
        assert.deepEqual(yield* secrets.listServerIds(), [serverA]);
        assert.include(config.secretsDir, "secrets");
      }).pipe(Effect.provide(makeSecretLayer(config)));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-secret-store-test-" }),
      ),
    ),
  );

  it.effect("retains a rotated value for an existing lease until the lease closes", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        const secretFiles = yield* ServerSecretStore.ServerSecretStore;
        const first = yield* secrets.prepareCreate(serverA, httpDraft("first-sentinel"));
        yield* first.commit;
        const firstId = credentialId(first.transport);

        const rotated = yield* Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* secrets.acquireLease(serverA, [firstId]);
            const prepared = yield* secrets.prepareUpdate(serverA, first.transport, {
              type: "streamable-http",
              url: "https://mcp.example.test/rpc",
              headers: [
                {
                  name: ProjectMcpHeaderName.make("X-Api-Key"),
                  credential: { id: firstId, name: "primary key", value: "second-sentinel" },
                },
              ],
              authorization: { type: "none" },
            });
            yield* prepared.commit;
            const newLeaseError = yield* secrets.acquireLease(serverA, [firstId]).pipe(Effect.flip);
            assert.instanceOf(newLeaseError, ProjectMcpSecretStore.ProjectMcpSecretOwnershipError);
            return {
              id: credentialId(prepared.transport),
              leaseValue: yield* lease.resolve(firstId),
            };
          }),
        );

        assert.notEqual(rotated.id, firstId);
        assert.equal(rotated.leaseValue, "first-sentinel");
        assert.equal(yield* secrets.resolve(serverA, rotated.id), "second-sentinel");
        assert.isTrue(
          Option.isNone(
            yield* secretFiles.get(ProjectMcpSecretStore.credentialSecretName(firstId)),
          ),
        );
        assert.equal(config.secretsDir.endsWith("secrets"), true);
      }).pipe(Effect.provide(makeSecretLayer(config)));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-secret-store-test-" }),
      ),
    ),
  );

  it.effect("rolls back a prepared replacement and leaves its active value usable", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        const secretFiles = yield* ServerSecretStore.ServerSecretStore;
        const first = yield* secrets.prepareCreate(
          serverA,
          httpDraft("rollback-original-sentinel"),
        );
        yield* first.commit;
        const firstId = credentialId(first.transport);
        const replacement = yield* secrets.prepareUpdate(
          serverA,
          first.transport,
          httpDraft("rollback-replacement-sentinel"),
        );
        const replacementId = credentialId(replacement.transport);

        yield* replacement.rollback;

        assert.equal(yield* secrets.resolve(serverA, firstId), "rollback-original-sentinel");
        assert.isTrue(
          Option.isNone(
            yield* secretFiles.get(ProjectMcpSecretStore.credentialSecretName(replacementId)),
          ),
        );
      }).pipe(Effect.provide(makeSecretLayer(config)));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-secret-store-test-" }),
      ),
    ),
  );

  it.effect(
    "preserves an owned credential when an update omits its value and rejects foreign IDs",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        yield* Effect.gen(function* () {
          const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
          const first = yield* secrets.prepareCreate(serverA, httpDraft("owned-sentinel"));
          const second = yield* secrets.prepareCreate(serverB, stdioDraft("foreign-sentinel"));
          yield* first.commit;
          yield* second.commit;
          const ownedId = credentialId(first.transport);
          const foreignId = credentialId(second.transport);

          const retained = yield* secrets.prepareUpdate(serverA, first.transport, {
            type: "streamable-http",
            url: "https://mcp.example.test/rpc",
            headers: [
              {
                name: ProjectMcpHeaderName.make("X-Api-Key"),
                credential: { id: ownedId, name: "renamed display label" },
              },
            ],
            authorization: { type: "none" },
          });
          yield* retained.commit;

          assert.equal(credentialId(retained.transport), ownedId);
          assert.equal(yield* secrets.resolve(serverA, ownedId), "owned-sentinel");
          const error = yield* Effect.flip(
            secrets.prepareUpdate(serverA, retained.transport, {
              type: "streamable-http",
              url: "https://mcp.example.test/rpc",
              headers: [
                {
                  name: ProjectMcpHeaderName.make("X-Api-Key"),
                  credential: { id: foreignId, name: "foreign value" },
                },
              ],
              authorization: { type: "none" },
            }),
          );
          assert.instanceOf(error, ProjectMcpSecretStore.ProjectMcpSecretOwnershipError);
        }).pipe(Effect.provide(makeSecretLayer(config)));
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-secret-store-test-" }),
        ),
      ),
  );

  it.effect("retires all server-owned credentials and deletes them after their final lease", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        const secretFiles = yield* ServerSecretStore.ServerSecretStore;
        const prepared = yield* secrets.prepareCreate(serverA, {
          type: "streamable-http",
          url: "https://mcp.example.test/rpc",
          headers: [
            {
              name: ProjectMcpHeaderName.make("X-Api-Key"),
              credential: { name: "header key", value: "header-remove-sentinel" },
            },
          ],
          authorization: {
            type: "oauth",
            registration: {
              type: "pre-registered",
              clientId: "client-id",
              clientSecret: { name: "client secret", value: "oauth-remove-sentinel" },
            },
          },
        });
        yield* prepared.commit;
        const stdio = yield* secrets.prepareCreate(
          serverB,
          stdioDraft("environment-remove-sentinel"),
        );
        yield* stdio.commit;
        const headerId = credentialId(prepared.transport);
        const environmentId = credentialId(stdio.transport);
        const clientSecretId =
          prepared.transport.type === "streamable-http" &&
          prepared.transport.authorization.type === "oauth" &&
          prepared.transport.authorization.registration.type === "pre-registered"
            ? prepared.transport.authorization.registration.clientSecret?.id
            : undefined;
        const pendingAuthorizationId = yield* secrets.createAuxiliarySecret(
          serverA,
          "pending-authorization-sentinel",
        );

        const retainedHeader = yield* Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* secrets.acquireLease(serverA, [headerId]);
            yield* secrets.removeServer(serverA);
            assert.isTrue(
              Option.isNone(
                yield* secretFiles.get(ProjectMcpSecretStore.credentialSecretName(clientSecretId!)),
              ),
            );
            assert.isTrue(
              Option.isNone(
                yield* secretFiles.get(
                  ProjectMcpSecretStore.credentialSecretName(pendingAuthorizationId),
                ),
              ),
            );
            return yield* lease.resolve(headerId);
          }),
        );
        assert.equal(retainedHeader, "header-remove-sentinel");
        assert.isTrue(
          Option.isNone(
            yield* secretFiles.get(ProjectMcpSecretStore.credentialSecretName(headerId)),
          ),
        );
        yield* secrets.removeServer(serverB);
        assert.isTrue(
          Option.isNone(
            yield* secretFiles.get(ProjectMcpSecretStore.credentialSecretName(environmentId)),
          ),
        );
      }).pipe(Effect.provide(makeSecretLayer(config)));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-secret-store-test-" }),
      ),
    ),
  );

  it.effect("recovers prepared values according to the durable catalog after a restart", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const firstLayer = Layer.fresh(makeSecretLayer(config));
      const secondLayer = Layer.fresh(makeSecretLayer(config));

      const prepared = yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        return yield* secrets.prepareCreate(serverA, httpDraft("prepared-sentinel"));
      }).pipe(Effect.provide(firstLayer));
      const preparedId = credentialId(prepared.transport);

      const afterRollback = yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        const secretFiles = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.reconcile([]);
        return yield* secretFiles.get(ProjectMcpSecretStore.credentialSecretName(preparedId));
      }).pipe(Effect.provide(secondLayer));
      assert.isTrue(Option.isNone(afterRollback));

      const committed = yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        return yield* secrets.prepareCreate(serverA, httpDraft("committed-sentinel"));
      }).pipe(Effect.provide(Layer.fresh(makeSecretLayer(config))));
      const committedId = credentialId(committed.transport);

      const afterCommit = yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        yield* secrets.reconcile([{ id: serverA, transport: committed.transport }]);
        return yield* secrets.resolve(serverA, committedId);
      }).pipe(Effect.provide(Layer.fresh(makeSecretLayer(config))));
      assert.equal(afterCommit, "committed-sentinel");

      const replacing = yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        return yield* secrets.prepareUpdate(
          serverA,
          committed.transport,
          httpDraft("replaced-sentinel"),
        );
      }).pipe(Effect.provide(Layer.fresh(makeSecretLayer(config))));
      const replacingId = credentialId(replacing.transport);
      const recoveredReplacement = yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        const secretFiles = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.reconcile([{ id: serverA, transport: replacing.transport }]);
        return {
          current: yield* secrets.resolve(serverA, replacingId),
          previous: yield* secretFiles.get(ProjectMcpSecretStore.credentialSecretName(committedId)),
        };
      }).pipe(Effect.provide(Layer.fresh(makeSecretLayer(config))));
      assert.equal(recoveredReplacement.current, "replaced-sentinel");
      assert.isTrue(Option.isNone(recoveredReplacement.previous));

      const removalDraft: ProjectMcpTransportDraft = {
        type: "streamable-http",
        url: "https://mcp.example.test/rpc",
        headers: [],
        authorization: { type: "none" },
      };
      yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        return yield* secrets.prepareUpdate(serverA, replacing.transport, removalDraft);
      }).pipe(Effect.provide(Layer.fresh(makeSecretLayer(config))));
      const afterRemovalRollback = yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        yield* secrets.reconcile([{ id: serverA, transport: replacing.transport }]);
        return yield* secrets.resolve(serverA, replacingId);
      }).pipe(Effect.provide(Layer.fresh(makeSecretLayer(config))));
      assert.equal(afterRemovalRollback, "replaced-sentinel");

      const removedAfterDispatch = yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        return yield* secrets.prepareUpdate(serverA, replacing.transport, removalDraft);
      }).pipe(Effect.provide(Layer.fresh(makeSecretLayer(config))));
      const afterRemovalCommit = yield* Effect.gen(function* () {
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        const secretFiles = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.reconcile([{ id: serverA, transport: removedAfterDispatch.transport }]);
        return yield* secretFiles.get(ProjectMcpSecretStore.credentialSecretName(replacingId));
      }).pipe(Effect.provide(Layer.fresh(makeSecretLayer(config))));
      assert.isTrue(Option.isNone(afterRemovalCommit));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-secret-store-restart-" }),
      ),
    ),
  );
});
