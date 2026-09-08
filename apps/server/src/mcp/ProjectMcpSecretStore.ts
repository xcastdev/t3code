import {
  McpServerId,
  ProjectMcpCredentialId,
  type ProjectMcpCredentialDraft,
  type ProjectMcpCredentialId as ProjectMcpCredentialIdType,
  type ProjectMcpCredentialRef,
  type ProjectMcpTransport,
  type ProjectMcpTransportDraft,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const MANIFEST_SECRET_NAME = "project-mcp-secret-manifest";
const JOURNAL_SECRET_NAME = "project-mcp-secret-journal";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const credentialSecretName = (id: ProjectMcpCredentialIdType) =>
  `project-mcp-credential-${id}`;

const ProjectMcpSecretStoreErrorFields = {
  operation: Schema.String,
  cause: Schema.Defect(),
};

export class ProjectMcpSecretStoreError extends Schema.TaggedErrorClass<ProjectMcpSecretStoreError>()(
  "ProjectMcpSecretStoreError",
  ProjectMcpSecretStoreErrorFields,
) {
  override get message(): string {
    return `Could not ${this.operation} project MCP secrets.`;
  }
}

export class ProjectMcpSecretCleanupError extends Schema.TaggedErrorClass<ProjectMcpSecretCleanupError>()(
  "ProjectMcpSecretCleanupError",
  {
    serverId: McpServerId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not clean up secrets for MCP server '${this.serverId}'.`;
  }
}

export class ProjectMcpSecretOwnershipError extends Schema.TaggedErrorClass<ProjectMcpSecretOwnershipError>()(
  "ProjectMcpSecretOwnershipError",
  {
    serverId: McpServerId,
    credentialId: ProjectMcpCredentialId,
  },
) {
  override get message(): string {
    return `Credential '${this.credentialId}' is not owned by MCP server '${this.serverId}'.`;
  }
}

export class ProjectMcpSecretUnavailableError extends Schema.TaggedErrorClass<ProjectMcpSecretUnavailableError>()(
  "ProjectMcpSecretUnavailableError",
  {
    serverId: McpServerId,
    credentialId: ProjectMcpCredentialId,
  },
) {
  override get message(): string {
    return `Credential '${this.credentialId}' is unavailable for MCP server '${this.serverId}'.`;
  }
}

export class ProjectMcpSecretDraftError extends Schema.TaggedErrorClass<ProjectMcpSecretDraftError>()(
  "ProjectMcpSecretDraftError",
  { message: Schema.String },
) {}

export const ProjectMcpSecretError = Schema.Union([
  ProjectMcpSecretStoreError,
  ProjectMcpSecretCleanupError,
  ProjectMcpSecretOwnershipError,
  ProjectMcpSecretUnavailableError,
  ProjectMcpSecretDraftError,
]);
export type ProjectMcpSecretError = typeof ProjectMcpSecretError.Type;

const ServerSecrets = Schema.Struct({
  credentials: Schema.Array(ProjectMcpCredentialId),
  retired: Schema.Array(ProjectMcpCredentialId),
  auxiliary: Schema.Array(ProjectMcpCredentialId),
  removed: Schema.optional(Schema.Boolean),
});
type ServerSecrets = typeof ServerSecrets.Type;

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  servers: Schema.Record(Schema.String, ServerSecrets),
});
type Manifest = typeof Manifest.Type;

const JournalOperation = Schema.Struct({
  state: Schema.Literal("prepared"),
  kind: Schema.Literals(["catalog", "auxiliary"]),
  serverId: McpServerId,
  preparedCredentialIds: Schema.Array(ProjectMcpCredentialId),
  nextCredentialIds: Schema.Array(ProjectMcpCredentialId),
  replacedCredentialIds: Schema.Array(ProjectMcpCredentialId),
});
type JournalOperation = typeof JournalOperation.Type;

const Journal = Schema.Struct({
  version: Schema.Literal(1),
  operations: Schema.Record(Schema.String, JournalOperation),
});
type Journal = typeof Journal.Type;

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const decodeJournal = Schema.decodeUnknownEffect(Schema.fromJsonString(Journal));
const encodeManifest = Schema.encodeUnknownEffect(Schema.fromJsonString(Manifest));
const encodeJournal = Schema.encodeUnknownEffect(Schema.fromJsonString(Journal));

const emptyManifest = (): Manifest => ({ version: 1, servers: {} });
const emptyJournal = (): Journal => ({ version: 1, operations: {} });
const noServerSecrets = (): ServerSecrets => ({ credentials: [], retired: [], auxiliary: [] });
const unique = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)];

const credentialIds = (
  transport: ProjectMcpTransport,
): ReadonlyArray<ProjectMcpCredentialIdType> => {
  if (transport.type === "stdio") return transport.env.map(({ credential }) => credential.id);
  return [
    ...transport.headers.map(({ credential }) => credential.id),
    ...(transport.authorization.type === "oauth" &&
    transport.authorization.registration.type === "pre-registered" &&
    transport.authorization.registration.clientSecret !== undefined
      ? [transport.authorization.registration.clientSecret.id]
      : []),
  ];
};

export const credentialIdsForTransport = credentialIds;

const hasCredential = (
  server: ServerSecrets | undefined,
  id: ProjectMcpCredentialIdType,
): boolean =>
  server !== undefined &&
  [...server.credentials, ...server.retired, ...server.auxiliary].includes(id);

const hasActiveCredential = (
  server: ServerSecrets | undefined,
  id: ProjectMcpCredentialIdType,
): boolean => server?.credentials.includes(id) ?? false;

const removeIds = <A>(values: ReadonlyArray<A>, removed: ReadonlyArray<A>): ReadonlyArray<A> => {
  const removedSet = new Set(removed);
  return values.filter((value) => !removedSet.has(value));
};

const serverSecretsWith = (
  manifest: Manifest,
  serverId: McpServerId,
  server: ServerSecrets,
): Manifest => ({
  ...manifest,
  servers: { ...manifest.servers, [serverId]: server },
});

const withoutServer = (manifest: Manifest, serverId: McpServerId): Manifest => {
  const { [serverId]: _removed, ...servers } = manifest.servers;
  return { ...manifest, servers };
};

export interface PreparedProjectMcpSecrets {
  readonly transport: ProjectMcpTransport;
  readonly commit: Effect.Effect<void, ProjectMcpSecretError>;
  readonly rollback: Effect.Effect<void, ProjectMcpSecretError>;
}

export interface ProjectMcpSecretLease {
  readonly resolve: (
    credentialId: ProjectMcpCredentialIdType,
  ) => Effect.Effect<string, ProjectMcpSecretError>;
}

export interface ProjectMcpSecretStoreShape {
  readonly prepareCreate: (
    serverId: McpServerId,
    transport: ProjectMcpTransportDraft,
  ) => Effect.Effect<PreparedProjectMcpSecrets, ProjectMcpSecretError>;
  readonly prepareUpdate: (
    serverId: McpServerId,
    previous: ProjectMcpTransport,
    transport: ProjectMcpTransportDraft,
  ) => Effect.Effect<PreparedProjectMcpSecrets, ProjectMcpSecretError>;
  readonly retireTransport: (
    serverId: McpServerId,
    transport: ProjectMcpTransport,
  ) => Effect.Effect<void, ProjectMcpSecretError>;
  readonly createAuxiliarySecret: (
    serverId: McpServerId,
    value: string,
  ) => Effect.Effect<ProjectMcpCredentialIdType, ProjectMcpSecretError>;
  readonly listAuxiliarySecrets: (
    serverId: McpServerId,
  ) => Effect.Effect<ReadonlyArray<ProjectMcpCredentialIdType>, ProjectMcpSecretError>;
  /** Returns server IDs present in the encrypted manifest without exposing secret values. */
  readonly listServerIds: () => Effect.Effect<ReadonlyArray<McpServerId>, ProjectMcpSecretError>;
  readonly removeAuxiliarySecret: (
    serverId: McpServerId,
    credentialId: ProjectMcpCredentialIdType,
  ) => Effect.Effect<void, ProjectMcpSecretError>;
  readonly removeServer: (serverId: McpServerId) => Effect.Effect<void, ProjectMcpSecretError>;
  readonly resolve: (
    serverId: McpServerId,
    credentialId: ProjectMcpCredentialIdType,
  ) => Effect.Effect<string, ProjectMcpSecretError>;
  readonly acquireLease: (
    serverId: McpServerId,
    credentialIds: ReadonlyArray<ProjectMcpCredentialIdType>,
  ) => Effect.Effect<ProjectMcpSecretLease, ProjectMcpSecretError, Scope.Scope>;
  readonly reconcile: (
    catalog: ReadonlyArray<{
      readonly id: McpServerId;
      readonly transport?: ProjectMcpTransport | undefined;
    }>,
  ) => Effect.Effect<void, ProjectMcpSecretError>;
}

export class ProjectMcpSecretStore extends Context.Service<
  ProjectMcpSecretStore,
  ProjectMcpSecretStoreShape
>()("t3/mcp/ProjectMcpSecretStore") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  const readJson = <A>(
    name: string,
    decode: (input: string) => Effect.Effect<A, Schema.SchemaError>,
    fallback: () => A,
  ): Effect.Effect<A, ProjectMcpSecretStoreError> =>
    secretStore.get(name).pipe(
      Effect.mapError(
        (cause) => new ProjectMcpSecretStoreError({ operation: `read ${name}`, cause }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(fallback()),
          onSome: (bytes) =>
            decode(textDecoder.decode(bytes)).pipe(
              Effect.mapError(
                (cause) => new ProjectMcpSecretStoreError({ operation: `decode ${name}`, cause }),
              ),
            ),
        }),
      ),
    );

  const writeJson = <A>(
    name: string,
    value: A,
    encode: (input: A) => Effect.Effect<string, Schema.SchemaError>,
  ): Effect.Effect<void, ProjectMcpSecretStoreError> =>
    encode(value).pipe(
      Effect.mapError(
        (cause) => new ProjectMcpSecretStoreError({ operation: `encode ${name}`, cause }),
      ),
      Effect.flatMap((json) => secretStore.set(name, textEncoder.encode(json))),
      Effect.mapError(
        (cause) => new ProjectMcpSecretStoreError({ operation: `write ${name}`, cause }),
      ),
    );

  const manifests = yield* Ref.make(
    yield* readJson(MANIFEST_SECRET_NAME, decodeManifest, emptyManifest),
  );
  const journals = yield* Ref.make(
    yield* readJson(JOURNAL_SECRET_NAME, decodeJournal, emptyJournal),
  );
  const leases = yield* Ref.make(new Map<ProjectMcpCredentialIdType, number>());
  const mutex = yield* Semaphore.make(1);

  const persistManifest = (manifest: Manifest) =>
    writeJson(MANIFEST_SECRET_NAME, manifest, encodeManifest).pipe(
      Effect.tap(() => Ref.set(manifests, manifest)),
    );
  const persistJournal = (journal: Journal) =>
    writeJson(JOURNAL_SECRET_NAME, journal, encodeJournal).pipe(
      Effect.tap(() => Ref.set(journals, journal)),
    );

  const removeCredential = (id: ProjectMcpCredentialIdType) =>
    secretStore
      .remove(credentialSecretName(id))
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectMcpSecretStoreError({ operation: `remove credential ${id}`, cause }),
        ),
      );

  const newCredentialId = crypto.randomUUIDv4.pipe(
    Effect.map(ProjectMcpCredentialId.make),
    Effect.mapError(
      (cause) => new ProjectMcpSecretStoreError({ operation: "generate credential ID", cause }),
    ),
  );

  const newOperationId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) => new ProjectMcpSecretStoreError({ operation: "generate operation ID", cause }),
    ),
  );

  const resolveValue = (
    serverId: McpServerId,
    credentialId: ProjectMcpCredentialIdType,
  ): Effect.Effect<string, ProjectMcpSecretError> =>
    secretStore.get(credentialSecretName(credentialId)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectMcpSecretStoreError({ operation: `read credential ${credentialId}`, cause }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new ProjectMcpSecretUnavailableError({ serverId, credentialId })),
          onSome: (value) => Effect.succeed(textDecoder.decode(value)),
        }),
      ),
    );

  const cleanupRetired = Effect.fn("ProjectMcpSecretStore.cleanupRetired")(function* (
    serverId: McpServerId,
  ): Effect.fn.Return<void, ProjectMcpSecretError> {
    const manifest = yield* Ref.get(manifests);
    const server = manifest.servers[serverId];
    if (server === undefined) return;
    const leaseCounts = yield* Ref.get(leases);
    const deletable = server.retired.filter((id) => (leaseCounts.get(id) ?? 0) === 0);
    if (
      deletable.length === 0 &&
      (server.removed !== true ||
        server.credentials.length > 0 ||
        server.retired.length > 0 ||
        server.auxiliary.length > 0)
    )
      return;
    yield* Effect.forEach(deletable, removeCredential, { discard: true }).pipe(
      Effect.mapError((cause) => new ProjectMcpSecretCleanupError({ serverId, cause })),
    );
    const current = yield* Ref.get(manifests);
    const currentServer = current.servers[serverId];
    if (currentServer === undefined) return;
    const updated = {
      ...currentServer,
      retired: removeIds(currentServer.retired, deletable),
    } satisfies ServerSecrets;
    yield* persistManifest(
      updated.removed === true &&
        updated.credentials.length === 0 &&
        updated.retired.length === 0 &&
        updated.auxiliary.length === 0
        ? withoutServer(current, serverId)
        : serverSecretsWith(current, serverId, updated),
    ).pipe(Effect.mapError((cause) => new ProjectMcpSecretCleanupError({ serverId, cause })));
  });

  const rollbackOperation = Effect.fn("ProjectMcpSecretStore.rollbackOperation")(function* (
    operationId: string,
  ): Effect.fn.Return<void, ProjectMcpSecretError> {
    const journal = yield* Ref.get(journals);
    const operation = journal.operations[operationId];
    if (operation === undefined) return;
    yield* Effect.forEach(operation.preparedCredentialIds, removeCredential, { discard: true });
    const { [operationId]: _removed, ...operations } = (yield* Ref.get(journals)).operations;
    yield* persistJournal({ version: 1, operations });
  });

  const commitOperation = Effect.fn("ProjectMcpSecretStore.commitOperation")(function* (
    operationId: string,
  ): Effect.fn.Return<void, ProjectMcpSecretError> {
    const journal = yield* Ref.get(journals);
    const operation = journal.operations[operationId];
    if (operation === undefined) return;
    const manifest = yield* Ref.get(manifests);
    const server = manifest.servers[operation.serverId] ?? noServerSecrets();
    const next = {
      removed: false,
      credentials:
        operation.kind === "catalog" ? unique(operation.nextCredentialIds) : server.credentials,
      retired:
        operation.kind === "catalog"
          ? unique([...server.retired, ...operation.replacedCredentialIds])
          : server.retired,
      auxiliary:
        operation.kind === "auxiliary"
          ? unique([...server.auxiliary, ...operation.preparedCredentialIds])
          : server.auxiliary,
    } satisfies ServerSecrets;
    yield* persistManifest(serverSecretsWith(manifest, operation.serverId, next));
    yield* cleanupRetired(operation.serverId);
    const { [operationId]: _removed, ...operations } = (yield* Ref.get(journals)).operations;
    yield* persistJournal({ version: 1, operations });
  });

  const prepareCredential = Effect.fn("ProjectMcpSecretStore.prepareCredential")(function* (
    serverId: McpServerId,
    credential: ProjectMcpCredentialDraft,
    create: boolean,
  ): Effect.fn.Return<
    {
      readonly ref: ProjectMcpCredentialRef;
      readonly created?: { readonly id: ProjectMcpCredentialIdType; readonly value: string };
    },
    ProjectMcpSecretError
  > {
    if (!create && credential.id !== undefined && credential.value === undefined) {
      const manifest = yield* Ref.get(manifests);
      if (!hasActiveCredential(manifest.servers[serverId], credential.id)) {
        return yield* new ProjectMcpSecretOwnershipError({ serverId, credentialId: credential.id });
      }
      return { ref: { id: credential.id, name: credential.name } };
    }
    if (!create && credential.id !== undefined) {
      const manifest = yield* Ref.get(manifests);
      if (!hasActiveCredential(manifest.servers[serverId], credential.id)) {
        return yield* new ProjectMcpSecretOwnershipError({ serverId, credentialId: credential.id });
      }
    }
    if (credential.value === undefined) {
      return yield* new ProjectMcpSecretDraftError({
        message: "A new project MCP credential requires a value.",
      });
    }
    const id = yield* newCredentialId;
    return {
      ref: { id, name: credential.name },
      created: { id, value: credential.value },
    };
  });

  const prepareTransport = Effect.fn("ProjectMcpSecretStore.prepareTransport")(function* (
    serverId: McpServerId,
    draft: ProjectMcpTransportDraft,
    create: boolean,
  ): Effect.fn.Return<
    {
      readonly transport: ProjectMcpTransport;
      readonly created: ReadonlyArray<{
        readonly id: ProjectMcpCredentialIdType;
        readonly value: string;
      }>;
    },
    ProjectMcpSecretError
  > {
    if (draft.type === "stdio") {
      const preparedEnv = yield* Effect.forEach(draft.env, ({ name, credential }) =>
        prepareCredential(serverId, credential, create).pipe(
          Effect.map((prepared) => ({ name, prepared })),
        ),
      );
      return {
        transport: {
          type: "stdio",
          command: draft.command,
          args: draft.args,
          ...(draft.cwd === undefined ? {} : { cwd: draft.cwd }),
          env: preparedEnv.map(({ name, prepared }) => ({ name, credential: prepared.ref })),
        },
        created: preparedEnv.flatMap(({ prepared }) =>
          prepared.created ? [prepared.created] : [],
        ),
      };
    }
    const preparedHeaders = yield* Effect.forEach(draft.headers, ({ name, credential }) =>
      prepareCredential(serverId, credential, create).pipe(
        Effect.map((prepared) => ({ name, prepared })),
      ),
    );
    if (
      draft.authorization.type === "oauth" &&
      draft.authorization.registration.type === "pre-registered" &&
      draft.authorization.registration.clientSecret !== undefined
    ) {
      const clientSecret = yield* prepareCredential(
        serverId,
        draft.authorization.registration.clientSecret,
        create,
      );
      return {
        transport: {
          type: draft.type,
          url: draft.url,
          headers: preparedHeaders.map(({ name, prepared }) => ({
            name,
            credential: prepared.ref,
          })),
          authorization: {
            type: "oauth",
            registration: {
              type: "pre-registered",
              clientId: draft.authorization.registration.clientId,
              clientSecret: clientSecret.ref,
            },
          },
        },
        created: [
          ...preparedHeaders.flatMap(({ prepared }) =>
            prepared.created ? [prepared.created] : [],
          ),
          ...(clientSecret.created ? [clientSecret.created] : []),
        ],
      };
    }
    return {
      transport: {
        type: draft.type,
        url: draft.url,
        headers: preparedHeaders.map(({ name, prepared }) => ({ name, credential: prepared.ref })),
        authorization:
          draft.authorization.type === "none"
            ? { type: "none" }
            : draft.authorization.registration.type === "automatic"
              ? { type: "oauth", registration: { type: "automatic" } }
              : {
                  type: "oauth",
                  registration: {
                    type: "pre-registered",
                    clientId: draft.authorization.registration.clientId,
                  },
                },
      },
      created: preparedHeaders.flatMap(({ prepared }) =>
        prepared.created ? [prepared.created] : [],
      ),
    };
  });

  const prepare = (
    serverId: McpServerId,
    previous: ProjectMcpTransport | undefined,
    draft: ProjectMcpTransportDraft,
  ): Effect.Effect<PreparedProjectMcpSecrets, ProjectMcpSecretError> =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const preparedTransport = yield* prepareTransport(serverId, draft, previous === undefined);
        const operationId = yield* newOperationId;
        const nextCredentialIds = credentialIds(preparedTransport.transport);
        const previousCredentialIds = previous === undefined ? [] : credentialIds(previous);
        const operation = {
          state: "prepared" as const,
          kind: "catalog" as const,
          serverId,
          preparedCredentialIds: preparedTransport.created.map(({ id }) => id),
          nextCredentialIds,
          replacedCredentialIds: previousCredentialIds.filter(
            (id) => !nextCredentialIds.includes(id),
          ),
        } satisfies JournalOperation;
        const journal = yield* Ref.get(journals);
        yield* persistJournal({
          ...journal,
          operations: { ...journal.operations, [operationId]: operation },
        });
        yield* Effect.forEach(
          preparedTransport.created,
          ({ id, value }) =>
            secretStore
              .create(credentialSecretName(id), textEncoder.encode(value))
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProjectMcpSecretStoreError({ operation: `create credential ${id}`, cause }),
                ),
              ),
          { discard: true },
        ).pipe(Effect.tapError(() => rollbackOperation(operationId).pipe(Effect.ignore)));
        return {
          transport: preparedTransport.transport,
          commit: mutex.withPermits(1)(commitOperation(operationId)),
          rollback: mutex.withPermits(1)(rollbackOperation(operationId)),
        } satisfies PreparedProjectMcpSecrets;
      }),
    );

  const prepareCreate: ProjectMcpSecretStoreShape["prepareCreate"] = (serverId, transport) =>
    prepare(serverId, undefined, transport);
  const prepareUpdate: ProjectMcpSecretStoreShape["prepareUpdate"] = (
    serverId,
    previous,
    transport,
  ) => prepare(serverId, previous, transport);

  const retireTransport: ProjectMcpSecretStoreShape["retireTransport"] = (serverId, transport) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const manifest = yield* Ref.get(manifests);
        const server = manifest.servers[serverId];
        if (server === undefined) return;
        const retiring = credentialIds(transport).filter((id) => hasCredential(server, id));
        yield* persistManifest(
          serverSecretsWith(manifest, serverId, {
            ...server,
            credentials: removeIds(server.credentials, retiring),
            retired: unique([...server.retired, ...retiring]),
            auxiliary: server.auxiliary,
          }),
        );
        yield* cleanupRetired(serverId);
      }),
    );

  const createAuxiliarySecret: ProjectMcpSecretStoreShape["createAuxiliarySecret"] = (
    serverId,
    value,
  ) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const manifest = yield* Ref.get(manifests);
        if (
          manifest.servers[serverId] === undefined ||
          manifest.servers[serverId].removed === true
        ) {
          return yield* new ProjectMcpSecretDraftError({
            message: `Cannot add an auxiliary secret to unknown MCP server '${serverId}'.`,
          });
        }
        const credentialId = yield* newCredentialId;
        const operationId = yield* newOperationId;
        const journal = yield* Ref.get(journals);
        yield* persistJournal({
          ...journal,
          operations: {
            ...journal.operations,
            [operationId]: {
              state: "prepared",
              kind: "auxiliary",
              serverId,
              preparedCredentialIds: [credentialId],
              nextCredentialIds: [],
              replacedCredentialIds: [],
            },
          },
        });
        yield* secretStore
          .create(credentialSecretName(credentialId), textEncoder.encode(value))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProjectMcpSecretStoreError({
                  operation: `create auxiliary credential ${credentialId}`,
                  cause,
                }),
            ),
            Effect.tapError(() => rollbackOperation(operationId).pipe(Effect.ignore)),
          );
        yield* commitOperation(operationId);
        return credentialId;
      }),
    );

  const removeServer: ProjectMcpSecretStoreShape["removeServer"] = (serverId) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const manifest = yield* Ref.get(manifests);
        const server = manifest.servers[serverId];
        if (server === undefined) return;
        yield* persistManifest(
          serverSecretsWith(manifest, serverId, {
            removed: true,
            credentials: [],
            retired: unique([...server.credentials, ...server.retired, ...server.auxiliary]),
            auxiliary: [],
          }),
        );
        yield* cleanupRetired(serverId);
      }),
    );

  const listAuxiliarySecrets: ProjectMcpSecretStoreShape["listAuxiliarySecrets"] = (serverId) =>
    Ref.get(manifests).pipe(Effect.map((manifest) => manifest.servers[serverId]?.auxiliary ?? []));

  const listServerIds: ProjectMcpSecretStoreShape["listServerIds"] = () =>
    Ref.get(manifests).pipe(
      Effect.map((manifest) => Object.keys(manifest.servers).map((id) => McpServerId.make(id))),
    );

  const removeAuxiliarySecret: ProjectMcpSecretStoreShape["removeAuxiliarySecret"] = (
    serverId,
    credentialId,
  ) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const manifest = yield* Ref.get(manifests);
        const server = manifest.servers[serverId];
        if (
          server === undefined ||
          (!server.auxiliary.includes(credentialId) && !server.retired.includes(credentialId))
        ) {
          return yield* new ProjectMcpSecretOwnershipError({ serverId, credentialId });
        }
        if (server.auxiliary.includes(credentialId)) {
          // Keep a durable retirement record until deletion succeeds. A failed
          // delete can then be retried by this call or by reconciliation.
          yield* persistManifest(
            serverSecretsWith(manifest, serverId, {
              ...server,
              credentials: server.credentials,
              retired: unique([...server.retired, credentialId]),
              auxiliary: removeIds(server.auxiliary, [credentialId]),
            }),
          );
        }
        yield* cleanupRetired(serverId);
      }),
    );

  const resolve: ProjectMcpSecretStoreShape["resolve"] = (serverId, credentialId) =>
    Effect.gen(function* () {
      const manifest = yield* Ref.get(manifests);
      if (
        !hasActiveCredential(manifest.servers[serverId], credentialId) &&
        !(manifest.servers[serverId]?.auxiliary.includes(credentialId) ?? false)
      ) {
        return yield* new ProjectMcpSecretOwnershipError({ serverId, credentialId });
      }
      return yield* resolveValue(serverId, credentialId);
    });

  const releaseLease = (
    serverId: McpServerId,
    credentialIds: ReadonlyArray<ProjectMcpCredentialIdType>,
  ) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* Ref.update(leases, (current) => {
          const next = new Map(current);
          for (const credentialId of credentialIds) {
            const remaining = (next.get(credentialId) ?? 1) - 1;
            if (remaining <= 0) next.delete(credentialId);
            else next.set(credentialId, remaining);
          }
          return next;
        });
        yield* cleanupRetired(serverId);
      }),
    );

  const acquireLease: ProjectMcpSecretStoreShape["acquireLease"] = (serverId, requestedIds) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const credentialIds = unique(requestedIds);
        const manifest = yield* Ref.get(manifests);
        const server = manifest.servers[serverId];
        for (const credentialId of credentialIds) {
          if (!hasActiveCredential(server, credentialId)) {
            return yield* new ProjectMcpSecretOwnershipError({ serverId, credentialId });
          }
        }
        yield* Ref.update(leases, (current) => {
          const next = new Map(current);
          for (const credentialId of credentialIds) {
            next.set(credentialId, (next.get(credentialId) ?? 0) + 1);
          }
          return next;
        });
        yield* Effect.addFinalizer(() =>
          releaseLease(serverId, credentialIds).pipe(
            Effect.tapError((error) => Effect.logError(error.message)),
            Effect.ignore,
          ),
        );
        return {
          resolve: (credentialId) =>
            credentialIds.includes(credentialId)
              ? resolveValue(serverId, credentialId)
              : Effect.fail(new ProjectMcpSecretOwnershipError({ serverId, credentialId })),
        } satisfies ProjectMcpSecretLease;
      }),
    );

  const reconcile: ProjectMcpSecretStoreShape["reconcile"] = (catalog) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const currentByServer = new Map(catalog.map((server) => [server.id, server] as const));
        for (const [operationId, operation] of Object.entries(
          (yield* Ref.get(journals)).operations,
        )) {
          const current = currentByServer.get(operation.serverId);
          const currentIds =
            current?.transport === undefined ? [] : credentialIds(current.transport);
          if (
            operation.kind === "auxiliary"
              ? current !== undefined
              : operation.nextCredentialIds.every((id) => currentIds.includes(id)) &&
                operation.replacedCredentialIds.every((id) => !currentIds.includes(id))
          ) {
            yield* commitOperation(operationId);
          } else {
            yield* rollbackOperation(operationId);
          }
        }
        for (const [serverId, server] of Object.entries((yield* Ref.get(manifests)).servers)) {
          const typedServerId = McpServerId.make(serverId);
          const current = currentByServer.get(typedServerId);
          const currentIds =
            current?.transport === undefined ? [] : credentialIds(current.transport);
          const retired = unique([
            ...server.retired,
            ...server.credentials.filter((id) => !currentIds.includes(id)),
            ...(current === undefined ? server.auxiliary : []),
          ]);
          const next = {
            removed: current === undefined,
            credentials: currentIds.filter((id) => hasCredential(server, id)),
            retired,
            auxiliary: current === undefined ? [] : server.auxiliary,
          } satisfies ServerSecrets;
          yield* persistManifest(serverSecretsWith(yield* Ref.get(manifests), typedServerId, next));
          yield* cleanupRetired(typedServerId);
        }
      }),
    );

  return ProjectMcpSecretStore.of({
    prepareCreate,
    prepareUpdate,
    retireTransport,
    createAuxiliarySecret,
    listAuxiliarySecrets,
    listServerIds,
    removeAuxiliarySecret,
    removeServer,
    resolve,
    acquireLease,
    reconcile,
  });
});

export const layer = Layer.effect(ProjectMcpSecretStore, make);
