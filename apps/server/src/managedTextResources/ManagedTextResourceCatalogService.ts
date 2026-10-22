import type {
  ManagedTextResourceCatalogListResult,
  ManagedTextResourceChanged,
  ManagedTextResourceContentGetResult,
  ManagedTextResourceEnvironmentCreateInput,
  ManagedTextResourceEnvironmentDeleteInput,
  ManagedTextResourceEnvironmentSetEnabledInput,
  ManagedTextResourceEnvironmentUpdateInput,
  ManagedTextResourceMutationAction,
  ManagedTextResourceMutationResult,
  ManagedTextResourceProjectDeleteStateInput,
  ManagedTextResourceProjectSetDisabledInput,
  ManagedTextResourceProjectSetOverrideInput,
  ManagedTextResourceRpcError,
  ManagedTextResourceThreadResetInput,
  ManagedTextResourceThreadSetEnabledInput,
} from "@t3tools/contracts";
import {
  ManagedTextResourceCatalogListResult as ManagedTextResourceCatalogListResultSchema,
  ManagedTextResourceChanged as ManagedTextResourceChangedSchema,
  ManagedTextResourceContentGetResult as ManagedTextResourceContentGetResultSchema,
  ManagedTextResourceMutationResult as ManagedTextResourceMutationResultSchema,
  ManagedTextResourceRpcError as ManagedTextResourceRpcErrorSchema,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { managedTextResourceChangeAffectsScope } from "./ManagedTextResourceRpc.ts";
import {
  makeManagedTextResourceRepository,
  ManagedTextResourceRepositoryError,
  type ManagedTextResourceCommitGuard,
  type ManagedTextResourceEntry,
  type ManagedTextResourceKind,
  type ManagedTextResourceRepositoryChange,
  type ManagedTextResourceThreadEntry,
} from "./ManagedTextResourceRepository.ts";
import {
  resolveManagedTextResources,
  type ManagedTextResourceCandidate,
  type ManagedTextResourceOverlay,
} from "./ManagedTextResourceResolver.ts";

export interface ManagedTextResourceScope {
  readonly environmentId: string;
  readonly projectId?: string;
  readonly projectRoot?: string;
  readonly threadId?: string;
}

export interface ManagedTextResourceMutationAuthorization {
  readonly commit?: (commit: () => void) => Effect.Effect<void, ManagedTextResourceRpcError>;
}

export class ManagedTextResourceCatalogService extends Context.Service<
  ManagedTextResourceCatalogService,
  {
    readonly changes: Stream.Stream<ManagedTextResourceChanged>;
    readonly subscribe: (
      scope: ManagedTextResourceScope,
    ) => Stream.Stream<ManagedTextResourceChanged, ManagedTextResourceRpcError>;
    readonly list: (
      scope: ManagedTextResourceScope,
    ) => Effect.Effect<ManagedTextResourceCatalogListResult, ManagedTextResourceRpcError>;
    readonly content: (
      input: ManagedTextResourceScope & {
        readonly kind: ManagedTextResourceKind;
        readonly id: string;
        readonly expectedRevision: string;
      },
    ) => Effect.Effect<ManagedTextResourceContentGetResult, ManagedTextResourceRpcError>;
    readonly createEnvironment: (
      input: ManagedTextResourceEnvironmentCreateInput & ManagedTextResourceMutationAuthorization,
    ) => Effect.Effect<ManagedTextResourceMutationResult, ManagedTextResourceRpcError>;
    readonly updateEnvironment: (
      input: ManagedTextResourceEnvironmentUpdateInput & ManagedTextResourceMutationAuthorization,
    ) => Effect.Effect<ManagedTextResourceMutationResult, ManagedTextResourceRpcError>;
    readonly deleteEnvironment: (
      input: ManagedTextResourceEnvironmentDeleteInput & ManagedTextResourceMutationAuthorization,
    ) => Effect.Effect<ManagedTextResourceMutationResult, ManagedTextResourceRpcError>;
    readonly setEnvironmentEnabled: (
      input: ManagedTextResourceEnvironmentSetEnabledInput &
        ManagedTextResourceMutationAuthorization,
    ) => Effect.Effect<ManagedTextResourceMutationResult, ManagedTextResourceRpcError>;
    readonly setProjectOverride: (
      input: ManagedTextResourceProjectSetOverrideInput &
        ManagedTextResourceMutationAuthorization & {
          readonly environmentId: string;
          readonly projectRoot: string;
        },
    ) => Effect.Effect<ManagedTextResourceMutationResult, ManagedTextResourceRpcError>;
    readonly setProjectDisabled: (
      input: ManagedTextResourceProjectSetDisabledInput &
        ManagedTextResourceMutationAuthorization & {
          readonly environmentId: string;
          readonly projectRoot: string;
        },
    ) => Effect.Effect<ManagedTextResourceMutationResult, ManagedTextResourceRpcError>;
    readonly deleteProjectState: (
      input: ManagedTextResourceProjectDeleteStateInput &
        ManagedTextResourceMutationAuthorization & {
          readonly environmentId: string;
          readonly projectRoot: string;
        },
    ) => Effect.Effect<ManagedTextResourceMutationResult, ManagedTextResourceRpcError>;
    readonly setThreadEnabled: (
      input: ManagedTextResourceThreadSetEnabledInput &
        ManagedTextResourceScope &
        ManagedTextResourceMutationAuthorization,
    ) => Effect.Effect<ManagedTextResourceMutationResult, ManagedTextResourceRpcError>;
    readonly resetThread: (
      input: ManagedTextResourceThreadResetInput &
        ManagedTextResourceScope &
        ManagedTextResourceMutationAuthorization,
    ) => Effect.Effect<ManagedTextResourceMutationResult, ManagedTextResourceRpcError>;
  }
>()("t3/managedTextResources/ManagedTextResourceCatalogService") {}

const decodeCatalogList = Schema.decodeUnknownSync(ManagedTextResourceCatalogListResultSchema);
const decodeContent = Schema.decodeUnknownSync(ManagedTextResourceContentGetResultSchema);
const decodeMutation = Schema.decodeUnknownSync(ManagedTextResourceMutationResultSchema);
const decodeChanged = Schema.decodeUnknownSync(ManagedTextResourceChangedSchema);

const fail = (code: ManagedTextResourceRpcError["code"], message: string) =>
  new ManagedTextResourceRpcErrorSchema({ code, message });

const mapRepositoryError = (cause: unknown): ManagedTextResourceRpcError => {
  if (!(cause instanceof ManagedTextResourceRepositoryError)) {
    return fail("invalid-override", "The managed text resource operation failed.");
  }
  switch (cause.code) {
    case "not_found":
      return fail("not-found", cause.message.slice(0, 1_000));
    case "revision_conflict":
      return fail("revision-conflict", cause.message.slice(0, 1_000));
    case "already_exists":
      return fail("already-exists", cause.message.slice(0, 1_000));
    case "invalid_content":
      return fail("invalid-content", cause.message.slice(0, 1_000));
    case "invalid_override":
    case "mutation_failed":
      return fail("invalid-override", cause.message.slice(0, 1_000));
  }
};

const candidatesFor = (
  entries: ReadonlyArray<ManagedTextResourceEntry>,
  scope: "environment" | "project",
  scopeId: string,
): ReadonlyArray<ManagedTextResourceCandidate> =>
  entries.map((entry) => ({
    id: entry.id ?? `${entry.state}:${entry.kind}:${entry.key}`,
    scope,
    scopeId,
    kind: entry.kind,
    key: entry.key,
    name: entry.name ?? entry.key,
    revision: entry.revision,
    state: entry.state,
  }));

const overlaysFor = (
  entries: ReadonlyArray<ManagedTextResourceThreadEntry>,
): ReadonlyArray<ManagedTextResourceOverlay> =>
  entries.map(({ kind, key, enabled }) => ({ kind, key, enabled }));

const catalogSummaries = (
  snapshot: {
    readonly environment: ReadonlyArray<ManagedTextResourceEntry>;
    readonly project: ReadonlyArray<ManagedTextResourceEntry>;
    readonly thread: ReadonlyArray<ManagedTextResourceThreadEntry>;
  },
  scope: ManagedTextResourceScope,
) => {
  const environmentCandidates = candidatesFor(
    snapshot.environment,
    "environment",
    scope.environmentId,
  );
  const projectCandidates = candidatesFor(
    snapshot.project,
    "project",
    scope.projectId ?? scope.projectRoot ?? "project",
  );
  const resolved = resolveManagedTextResources({
    environment: environmentCandidates,
    project: projectCandidates,
    thread: overlaysFor(snapshot.thread),
  });
  const entries = [...resolved.values()]
    .sort((left, right) => `${left.kind}:${left.key}`.localeCompare(`${right.kind}:${right.key}`))
    .map((resource) => {
      const projectEntry = snapshot.project.find(
        (entry) => entry.kind === resource.kind && entry.key === resource.key,
      );
      const environmentEntry = snapshot.environment.find(
        (entry) => entry.kind === resource.kind && entry.key === resource.key,
      );
      const displayEntry = resource.winner ?? projectEntry ?? environmentEntry;
      if (displayEntry === undefined) return undefined;
      const source =
        resource.winner?.scope ?? (projectEntry === undefined ? "environment" : "project");
      const scopeId =
        source === "project"
          ? (scope.projectId ?? scope.projectRoot ?? "project")
          : scope.environmentId;
      return {
        kind: resource.kind,
        ...(resource.winner?.id === undefined ? {} : { id: resource.winner.id }),
        key: resource.key,
        ...((resource.winner?.name ?? displayEntry.name)
          ? { name: resource.winner?.name ?? displayEntry.name }
          : {}),
        scope: source,
        scopeId,
        ...(environmentEntry?.state === "active" || environmentEntry?.state === "disabled"
          ? { environmentState: environmentEntry.state }
          : {}),
        projectState: resource.projectState,
        revision: displayEntry.revision,
        effective: resource.effective,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .slice(0, 512);
  const threadOverlays =
    scope.threadId === undefined
      ? undefined
      : snapshot.thread.slice(0, 512).map((entry) => ({
          threadId: entry.threadId,
          kind: entry.kind,
          key: entry.key,
          enabled: entry.enabled,
          revision: entry.revision,
        }));
  return { entries, ...(threadOverlays === undefined ? {} : { threadOverlays }) };
};

const findResolved = (
  snapshot: {
    readonly environment: ReadonlyArray<ManagedTextResourceEntry>;
    readonly project: ReadonlyArray<ManagedTextResourceEntry>;
    readonly thread: ReadonlyArray<ManagedTextResourceThreadEntry>;
  },
  scope: ManagedTextResourceScope,
  kind: ManagedTextResourceKind,
  key: string,
) => {
  const resolved = resolveManagedTextResources({
    environment: candidatesFor(snapshot.environment, "environment", scope.environmentId),
    project: candidatesFor(
      snapshot.project,
      "project",
      scope.projectId ?? scope.projectRoot ?? "project",
    ),
    thread: overlaysFor(snapshot.thread),
  });
  return resolved.get(`${kind}:${key}`);
};

const findResolvedById = (
  snapshot: {
    readonly environment: ReadonlyArray<ManagedTextResourceEntry>;
    readonly project: ReadonlyArray<ManagedTextResourceEntry>;
    readonly thread: ReadonlyArray<ManagedTextResourceThreadEntry>;
  },
  scope: ManagedTextResourceScope,
  kind: ManagedTextResourceKind,
  id: string,
) => {
  const candidate = [...snapshot.project, ...snapshot.environment].find(
    (entry) => entry.kind === kind && entry.id === id,
  );
  return candidate === undefined ? undefined : findResolved(snapshot, scope, kind, candidate.key);
};

const mutationResult = (input: {
  readonly catalogRevision: number;
  readonly kind: ManagedTextResourceKind;
  readonly key: string;
  readonly summaries: ReadonlyArray<unknown>;
  readonly action: ManagedTextResourceMutationAction;
  readonly scope: "environment" | "project" | "thread";
  readonly scopeId: string;
  readonly id?: string;
  readonly revision?: string;
}) =>
  decodeMutation({
    catalogRevision: input.catalogRevision,
    changedKeys: [{ kind: input.kind, key: input.key }],
    summaries: input.summaries,
    audit: {
      action: input.action,
      scope: input.scope,
      scopeId: input.scopeId,
      kind: input.kind,
      key: input.key,
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.revision === undefined ? {} : { revision: input.revision }),
    },
  });

const isManagedTextResourceRpcError = Schema.is(ManagedTextResourceRpcErrorSchema);

const mapEffectError = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isManagedTextResourceRpcError(cause) ? cause : mapRepositoryError(cause),
    ),
  );

// Resume the Effect fiber at the staged filesystem commit, so authorization can
// stay in Effect and hold its SQL transaction through the synchronous rename.
const mutate = <A>(
  authorization: ManagedTextResourceMutationAuthorization,
  operation: (guard: ManagedTextResourceCommitGuard | undefined) => Promise<A>,
): Effect.Effect<A, ManagedTextResourceRpcError> => {
  if (!authorization.commit)
    return Effect.tryPromise({ try: () => operation(undefined), catch: mapRepositoryError });
  const authorize = authorization.commit;
  return Effect.callback((resume, signal) => {
    let resumed = false;
    const result = operation(
      (commit) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("Mutation interrupted."));
            return;
          }
          resumed = true;
          let commitFailure: unknown;
          const publish = () => {
            try {
              commit();
            } catch (cause) {
              commitFailure = cause;
              throw cause;
            }
          };
          resume(
            authorize(publish).pipe(
              Effect.mapError((cause) =>
                commitFailure === undefined ? cause : mapRepositoryError(commitFailure),
              ),
              Effect.onError(() =>
                Effect.sync(() => reject(new Error("Mutation authorization failed."))),
              ),
              Effect.matchEffect({
                onFailure: (authorizationFailure) =>
                  Effect.tryPromise({
                    try: () => result,
                    catch: (cause) =>
                      cause instanceof ManagedTextResourceRepositoryError
                        ? mapRepositoryError(cause)
                        : authorizationFailure,
                  }),
                onSuccess: () => {
                  resolve();
                  return Effect.tryPromise({ try: () => result, catch: mapRepositoryError });
                },
              }),
            ),
          );
        }),
    );
    result.catch((cause: unknown) => {
      if (!resumed) resume(Effect.fail(mapRepositoryError(cause)));
    });
  });
};

export const makeWith = Effect.fn("ManagedTextResourceCatalogService.makeWith")(
  (stateDir: string) =>
    Effect.sync(() => {
      const scopedChanges = new Map<
        Queue.Queue<ManagedTextResourceChanged>,
        ManagedTextResourceScope | undefined
      >();
      const makeSubscription = Effect.fn("ManagedTextResourceCatalogService.subscribeQueue")(
        function* (scope?: ManagedTextResourceScope) {
          const queue = yield* Queue.sliding<ManagedTextResourceChanged>(1);
          scopedChanges.set(queue, scope);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              scopedChanges.delete(queue);
              Queue.shutdownUnsafe(queue);
            }),
          );
          return queue;
        },
      );
      const repository = makeManagedTextResourceRepository(stateDir, {
        onChange: (change: ManagedTextResourceRepositoryChange) => {
          const event = decodeChanged({
            ...change,
            changedKeys: change.changedKeys.slice(0, 128),
          });
          // These are catalog invalidations, so a newer full-scope refresh subsumes
          // earlier keys. Give each scope its own slot before coalescing events.
          for (const [subscription, scope] of scopedChanges) {
            if (scope === undefined || managedTextResourceChangeAffectsScope(scope, event))
              Queue.offerUnsafe(subscription, {
                ...event,
                scope: "environment",
                scopeId: scope?.environmentId ?? "environment",
                changedKeys: [],
              });
          }
        },
      });

      const readCatalog = (scope: ManagedTextResourceScope) =>
        Effect.tryPromise({
          try: () =>
            repository.readCatalog({
              environmentId: scope.environmentId,
              ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
              ...(scope.projectRoot === undefined ? {} : { projectRoot: scope.projectRoot }),
              ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
            }),
          catch: mapRepositoryError,
        });

      const list = (scope: ManagedTextResourceScope) =>
        readCatalog(scope).pipe(
          Effect.map((snapshot) =>
            decodeCatalogList({
              catalogRevision: snapshot.catalogRevision,
              ...catalogSummaries(snapshot, scope),
            }),
          ),
        );

      const makeService: ManagedTextResourceCatalogService["Service"] = {
        changes: Stream.unwrap(makeSubscription().pipe(Effect.map(Stream.fromQueue))),
        subscribe: (scope) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const subscription = yield* makeSubscription(scope);
              const snapshot = yield* readCatalog(scope);
              const initialChange = decodeChanged({
                scope: "environment",
                scopeId: scope.environmentId,
                catalogRevision: snapshot.catalogRevision,
                changedKeys: [],
              });
              return Stream.concat(Stream.make(initialChange), Stream.fromQueue(subscription));
            }),
          ),
        list,
        content: (input) => {
          const getContent = () =>
            mapEffectError(
              Effect.tryPromise({
                try: () =>
                  repository.getContent({
                    kind: input.kind,
                    id: input.id,
                    revision: input.expectedRevision,
                    ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
                  }),
                catch: mapRepositoryError,
              }).pipe(Effect.map((content) => decodeContent(content))),
            );
          if (
            input.projectRoot === undefined &&
            input.projectId === undefined &&
            input.threadId === undefined
          ) {
            return getContent();
          }
          return mapEffectError(
            readCatalog(input).pipe(
              Effect.flatMap((snapshot) => {
                const resolved = findResolvedById(snapshot, input, input.kind, input.id);
                return resolved?.winner?.id === input.id && resolved.effective
                  ? getContent()
                  : Effect.fail(
                      fail(
                        "invalid-override",
                        "This managed text resource is not effective in the requested scope.",
                      ),
                    );
              }),
            ),
          );
        },
        createEnvironment: (input) =>
          mapEffectError(
            mutate(input, (commitGuard) =>
              repository.createEnvironment({
                commitGuard,
                environmentId: input.environmentId,
                kind: input.kind,
                key: input.key,
                ...(input.name === undefined ? {} : { name: input.name }),
                body: input.body,
                expectedCatalogRevision: input.expectedCatalogRevision,
              }),
            ).pipe(
              Effect.flatMap((created) =>
                list({ environmentId: input.environmentId }).pipe(
                  Effect.map((catalog) =>
                    mutationResult({
                      catalogRevision: created.catalogRevision,
                      kind: input.kind,
                      key: input.key,
                      summaries: catalog.entries.filter(
                        (entry) => entry.kind === input.kind && entry.key === input.key,
                      ),
                      action: "create",
                      scope: "environment",
                      scopeId: input.environmentId,
                      ...(created.id === undefined ? {} : { id: created.id }),
                      revision: created.revision,
                    }),
                  ),
                ),
              ),
            ),
          ),
        updateEnvironment: (input) =>
          mapEffectError(
            mutate(input, (commitGuard) =>
              repository.updateEnvironment({
                commitGuard,
                environmentId: input.environmentId,
                id: input.id,
                kind: input.kind,
                expectedRevision: input.expectedRevision,
                ...(input.name === undefined ? {} : { name: input.name }),
                body: input.body,
              }),
            ).pipe(
              Effect.flatMap((updated) =>
                list({ environmentId: input.environmentId }).pipe(
                  Effect.map((catalog) =>
                    mutationResult({
                      catalogRevision: updated.catalogRevision,
                      kind: updated.kind,
                      key: updated.key,
                      summaries: catalog.entries.filter(
                        (entry) => entry.kind === updated.kind && entry.key === updated.key,
                      ),
                      action: "update",
                      scope: "environment",
                      scopeId: input.environmentId,
                      ...(updated.id === undefined ? {} : { id: updated.id }),
                      revision: updated.revision,
                    }),
                  ),
                ),
              ),
            ),
          ),
        setEnvironmentEnabled: (input) =>
          mapEffectError(
            mutate(input, (commitGuard) =>
              repository.setEnvironmentEnabled({
                commitGuard,
                environmentId: input.environmentId,
                kind: input.kind,
                id: input.id,
                expectedRevision: input.expectedRevision,
                enabled: input.enabled,
              }),
            ).pipe(
              Effect.flatMap((changed) =>
                list({ environmentId: input.environmentId }).pipe(
                  Effect.map((catalog) =>
                    mutationResult({
                      catalogRevision: changed.catalogRevision,
                      kind: changed.kind,
                      key: changed.key,
                      summaries: catalog.entries.filter(
                        (entry) => entry.kind === changed.kind && entry.key === changed.key,
                      ),
                      action: input.enabled ? "set-enabled" : "set-disabled",
                      scope: "environment",
                      scopeId: input.environmentId,
                      ...(changed.id === undefined ? {} : { id: changed.id }),
                      revision: changed.revision,
                    }),
                  ),
                ),
              ),
            ),
          ),
        deleteEnvironment: (input) =>
          mapEffectError(
            mutate(input, (commitGuard) =>
              repository.deleteEnvironment({
                commitGuard,
                environmentId: input.environmentId,
                kind: input.kind,
                id: input.id,
                expectedRevision: input.expectedRevision,
              }),
            ).pipe(
              Effect.map((deleted) =>
                mutationResult({
                  catalogRevision: deleted.catalogRevision,
                  kind: deleted.kind,
                  key: deleted.key,
                  summaries: [],
                  action: "delete",
                  scope: "environment",
                  scopeId: input.environmentId,
                  ...(input.id === undefined ? {} : { id: input.id }),
                  revision: deleted.revision,
                }),
              ),
            ),
          ),
        setProjectOverride: (input) =>
          mapEffectError(
            mutate(input, (commitGuard) =>
              repository.setProjectOverride({
                commitGuard,
                projectRoot: input.projectRoot,
                projectId: input.projectId,
                kind: input.kind,
                key: input.key,
                ...(input.name === undefined ? {} : { name: input.name }),
                body: input.body,
                expectedCatalogRevision: input.expectedCatalogRevision,
              }),
            ).pipe(
              Effect.flatMap((updated) =>
                list({
                  environmentId: input.environmentId,
                  projectId: input.projectId,
                  projectRoot: input.projectRoot,
                }).pipe(
                  Effect.map((catalog) =>
                    mutationResult({
                      catalogRevision: updated.catalogRevision,
                      kind: input.kind,
                      key: input.key,
                      summaries: catalog.entries.filter(
                        (entry) => entry.kind === input.kind && entry.key === input.key,
                      ),
                      action: "set-override",
                      scope: "project",
                      scopeId: input.projectId,
                      id: updated.id,
                      revision: updated.revision,
                    }),
                  ),
                ),
              ),
            ),
          ),
        setProjectDisabled: (input) =>
          mapEffectError(
            mutate(input, (commitGuard) =>
              repository.setProjectDisabled({
                commitGuard,
                projectRoot: input.projectRoot,
                projectId: input.projectId,
                kind: input.kind,
                key: input.key,
                expectedCatalogRevision: input.expectedCatalogRevision,
              }),
            ).pipe(
              Effect.flatMap((disabled) =>
                list({
                  environmentId: input.environmentId,
                  projectId: input.projectId,
                  projectRoot: input.projectRoot,
                }).pipe(
                  Effect.map((catalog) =>
                    mutationResult({
                      catalogRevision: disabled.catalogRevision,
                      kind: input.kind,
                      key: input.key,
                      summaries: catalog.entries.filter(
                        (entry) => entry.kind === input.kind && entry.key === input.key,
                      ),
                      action: "set-disabled",
                      scope: "project",
                      scopeId: input.projectId,
                      revision: disabled.revision,
                    }),
                  ),
                ),
              ),
            ),
          ),
        deleteProjectState: (input) =>
          mapEffectError(
            mutate(input, (commitGuard) =>
              repository.deleteProjectState({
                commitGuard,
                projectRoot: input.projectRoot,
                projectId: input.projectId,
                kind: input.kind,
                key: input.key,
                expectedCatalogRevision: input.expectedCatalogRevision,
              }),
            ).pipe(
              Effect.flatMap((deleted) =>
                list({
                  environmentId: input.environmentId,
                  projectId: input.projectId,
                  projectRoot: input.projectRoot,
                }).pipe(
                  Effect.map((catalog) =>
                    mutationResult({
                      catalogRevision: deleted.catalogRevision,
                      kind: input.kind,
                      key: input.key,
                      summaries: catalog.entries.filter(
                        (entry) => entry.kind === input.kind && entry.key === input.key,
                      ),
                      action: "delete-state",
                      scope: "project",
                      scopeId: input.projectId,
                      ...(deleted.id === undefined ? {} : { id: deleted.id }),
                      revision: deleted.revision,
                    }),
                  ),
                ),
              ),
            ),
          ),
        setThreadEnabled: (input) =>
          mapEffectError(
            readCatalog(input).pipe(
              Effect.flatMap((snapshot) => {
                const resolved = findResolved(snapshot, input, input.kind, input.key);
                return resolved?.winner?.state !== "active"
                  ? Effect.fail(
                      fail(
                        "invalid-override",
                        `The ${input.kind} '${input.key}' is not available in this thread's catalog.`,
                      ),
                    )
                  : mutate(input, (commitGuard) =>
                      repository.setThreadEnabled({
                        commitGuard,
                        threadId: input.threadId,
                        ...(input.projectRoot === undefined
                          ? {}
                          : { projectRoot: input.projectRoot }),
                        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
                        kind: input.kind,
                        key: input.key,
                        enabled: input.enabled,
                        expectedCatalogRevision: input.expectedCatalogRevision,
                      }),
                    ).pipe(
                      Effect.flatMap((changed) =>
                        list(input).pipe(
                          Effect.map((catalog) =>
                            mutationResult({
                              catalogRevision: changed.catalogRevision,
                              kind: input.kind,
                              key: input.key,
                              summaries: catalog.entries.filter(
                                (entry) => entry.kind === input.kind && entry.key === input.key,
                              ),
                              action: "set-enabled",
                              scope: "thread",
                              scopeId: input.threadId,
                              revision: changed.revision,
                            }),
                          ),
                        ),
                      ),
                    );
              }),
            ),
          ),
        resetThread: (input) =>
          mapEffectError(
            mutate(input, (commitGuard) =>
              repository.resetThread({
                commitGuard,
                threadId: input.threadId,
                ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
                ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
                kind: input.kind,
                key: input.key,
                expectedCatalogRevision: input.expectedCatalogRevision,
              }),
            ).pipe(
              Effect.flatMap((reset) =>
                list(input).pipe(
                  Effect.map((catalog) =>
                    mutationResult({
                      catalogRevision: reset.catalogRevision,
                      kind: input.kind,
                      key: input.key,
                      summaries: catalog.entries.filter(
                        (entry) => entry.kind === input.kind && entry.key === input.key,
                      ),
                      action: "reset",
                      scope: "thread",
                      scopeId: input.threadId,
                      ...(reset.revision === undefined ? {} : { revision: reset.revision }),
                    }),
                  ),
                ),
              ),
            ),
          ),
      };

      return {
        ...makeService,
        list: Effect.fn("ManagedTextResourceCatalogService.list")(makeService.list),
        content: Effect.fn("ManagedTextResourceCatalogService.content")(makeService.content),
        createEnvironment: Effect.fn("ManagedTextResourceCatalogService.createEnvironment")(
          makeService.createEnvironment,
        ),
        updateEnvironment: Effect.fn("ManagedTextResourceCatalogService.updateEnvironment")(
          makeService.updateEnvironment,
        ),
        deleteEnvironment: Effect.fn("ManagedTextResourceCatalogService.deleteEnvironment")(
          makeService.deleteEnvironment,
        ),
        setEnvironmentEnabled: Effect.fn("ManagedTextResourceCatalogService.setEnvironmentEnabled")(
          makeService.setEnvironmentEnabled,
        ),
        setProjectOverride: Effect.fn("ManagedTextResourceCatalogService.setProjectOverride")(
          makeService.setProjectOverride,
        ),
        setProjectDisabled: Effect.fn("ManagedTextResourceCatalogService.setProjectDisabled")(
          makeService.setProjectDisabled,
        ),
        deleteProjectState: Effect.fn("ManagedTextResourceCatalogService.deleteProjectState")(
          makeService.deleteProjectState,
        ),
        setThreadEnabled: Effect.fn("ManagedTextResourceCatalogService.setThreadEnabled")(
          makeService.setThreadEnabled,
        ),
        resetThread: Effect.fn("ManagedTextResourceCatalogService.resetThread")(
          makeService.resetThread,
        ),
      };
    }),
);

export const layer = Layer.effect(
  ManagedTextResourceCatalogService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* makeWith(config.stateDir);
  }),
);
