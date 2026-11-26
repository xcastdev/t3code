import type { SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import { SelfHostedRelayDirectoryDiscovery } from "@t3tools/contracts/selfHostedRelayDirectory";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import { Connectivity } from "../connection/connectivity.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  accountError,
  prepareAccount,
  SelfHostedRelayAccountStore,
  type SelfHostedRelayAccountRecord,
  type ConfigureSelfHostedRelayAccount,
  type SelfHostedRelayAccount,
  type SelfHostedRelayAccountError,
  type StoredSelfHostedRelayAccount,
} from "./account.ts";

const DIRECTORY_PATH = "/api/self-hosted-relay/v1/directory";
export const MAX_DIRECTORY_BYTES = 1024 * 1024;
const REFRESH_INTERVAL = "30 seconds";
const REQUEST_TIMEOUT = "10 seconds";
const EMPTY_SNAPSHOT = { version: 1, environments: [] } as const;
const sourceFor = (relayId: SelfHostedRelayId) => ({
  relayId,
  key: "self-hosted-relay-account",
});

export class SelfHostedRelayManagementFetch extends Context.Reference<typeof fetch | undefined>(
  "@t3tools/client-runtime/selfHostedRelay/discovery/SelfHostedRelayManagementFetch",
  { defaultValue: () => undefined },
) {}

const decodeDirectory = Schema.decodeEffect(
  Schema.fromJsonString(SelfHostedRelayDirectoryDiscovery),
);

type Dispatch = (
  url: string,
  options: RequestInit,
) => Effect.Effect<{ response: Promise<Response | null> } | null, SelfHostedRelayAccountError>;

const fetchDirectory = Effect.fn("SelfHostedRelayDirectory.fetch")(
  function* (account: StoredSelfHostedRelayAccount, dispatch: Dispatch) {
    const url = account.metadata.managementOrigin + DIRECTORY_PATH;
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    );
    const sent = yield* dispatch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${Redacted.value(account.session).credential}`,
      },
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (sent === null) return null;
    const web = yield* Effect.promise(() => sent.response);
    const response = web && HttpClientResponse.fromWeb(HttpClientRequest.get(url), web);
    if (!response || web?.redirected || response.url !== url) {
      return yield* accountError("directory-unavailable");
    }
    if (response.status === 401) return yield* accountError("unauthorized");
    if (response.status === 403) return yield* accountError("forbidden");
    if (response.status !== 200) return yield* accountError("directory-unavailable");
    const mediaType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (
      mediaType !== "application/json" ||
      response.headers["content-range"] !== undefined ||
      Number(response.headers["content-length"]) > MAX_DIRECTORY_BYTES
    ) {
      return yield* accountError("invalid-directory");
    }

    let bytes = new Uint8Array(4096);
    let size = 0;
    yield* response.stream.pipe(
      Stream.mapError(() => accountError("directory-unavailable")),
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          const end = size + chunk.byteLength;
          if (end > MAX_DIRECTORY_BYTES) return accountError("invalid-directory");
          if (end > bytes.byteLength) {
            const grown = new Uint8Array(
              Math.min(MAX_DIRECTORY_BYTES, Math.max(end, bytes.byteLength * 2)),
            );
            grown.set(bytes);
            bytes = grown;
          }
          bytes.set(chunk, size);
          size = end;
          return Effect.void;
        }),
      ),
    );
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
      catch: () => accountError("invalid-directory"),
    });
    const snapshot = yield* decodeDirectory(text, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => accountError("invalid-directory")),
    );

    const environments = new Set<string>();
    for (const row of snapshot.environments) {
      if (row.relayId !== account.metadata.relayId || environments.has(row.environmentId)) {
        return yield* accountError("invalid-directory");
      }
      environments.add(row.environmentId);
    }
    return snapshot;
  },
  (effect) =>
    Effect.scoped(effect).pipe(
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => accountError("directory-unavailable"),
      }),
      Effect.catchDefect(() => accountError("directory-unavailable")),
      Effect.withTracerEnabled(false),
    ),
);

export type SelfHostedRelayRefresh = "refreshed" | "offline" | "unconfigured" | "superseded";

type RefreshRequest = Deferred.Deferred<SelfHostedRelayRefresh, SelfHostedRelayAccountError>;

interface DirectoryAccount {
  readonly revision: string | null;
  readonly account: StoredSelfHostedRelayAccount;
  readonly scope: Scope.Closeable;
  readonly request: (followUp?: boolean) => RefreshRequest;
}

type ApplyDirectory = (
  ...args: Parameters<typeof EnvironmentRegistry.applyRelayDirectorySnapshot>
) => Effect.Effect<
  void,
  Effect.Error<ReturnType<typeof EnvironmentRegistry.applyRelayDirectorySnapshot>>
>;

export class SelfHostedRelayDirectory extends Context.Service<
  SelfHostedRelayDirectory,
  {
    readonly account: Effect.Effect<SelfHostedRelayAccount | null>;
    readonly configure: (
      input: ConfigureSelfHostedRelayAccount,
    ) => Effect.Effect<void, SelfHostedRelayAccountError>;
    readonly clear: Effect.Effect<void, SelfHostedRelayAccountError>;
    readonly refresh: Effect.Effect<SelfHostedRelayRefresh, SelfHostedRelayAccountError>;
    readonly start: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/selfHostedRelay/discovery/SelfHostedRelayDirectory") {}

export const makeDirectory = Effect.fn("SelfHostedRelayDirectory.make")(function* (input: {
  readonly store: SelfHostedRelayAccountStore["Service"];
  readonly connectivity: Connectivity["Service"];
  readonly apply: ApplyDirectory;
}) {
  const { store, connectivity } = input;
  const managementFetch = yield* SelfHostedRelayManagementFetch;
  const owner = yield* Scope.Scope;
  let active: DirectoryAccount | null = null;
  let started = false;
  let knownRelay: SelfHostedRelayId | null = null;
  const closed = () => owner.state._tag === "Closed";
  yield* Scope.addFinalizer(
    owner,
    Effect.sync(() => {
      active = null;
    }),
  );

  const apply = (relayId: SelfHostedRelayId, snapshot: SelfHostedRelayDirectoryDiscovery) =>
    input.apply(sourceFor(relayId), snapshot).pipe(
      Effect.mapError(() => accountError("cache-unavailable")),
      Effect.catchDefect(() => accountError("cache-unavailable")),
    );

  const corrupt = Symbol("corrupt account");
  const read = store.read.pipe(
    Effect.catchIf(
      (error) => error.reason === "corrupt-storage",
      () => Effect.succeed(corrupt),
    ),
    Effect.tap((record) =>
      Effect.sync(() => {
        if (record !== corrupt && record !== null) {
          knownRelay = record.withdrawal ?? record.account?.metadata.relayId ?? null;
        }
      }),
    ),
  );

  const retire = Effect.fn("SelfHostedRelayDirectory.retire")(function* (lane: DirectoryAccount) {
    if (active === lane) active = null;
    yield* Scope.close(lane.scope, Exit.void);
  });

  const isCurrent = Effect.fn("SelfHostedRelayDirectory.isCurrent")(function* (
    lane: DirectoryAccount,
  ) {
    if (closed() || active !== lane) return false;
    const record = yield* read;
    return (
      record !== corrupt &&
      record !== null &&
      record.withdrawal === null &&
      record.account !== null &&
      record.revision === lane.revision
    );
  });

  const startAccount = Effect.fn("SelfHostedRelayDirectory.startAccount")(function* ({
    account,
    revision,
  }: SelfHostedRelayAccountRecord) {
    if (!account || closed()) return;
    knownRelay = account.metadata.relayId;
    const scope = yield* Scope.fork(owner);
    const queue = yield* Queue.unbounded<RefreshRequest>();
    let queued: RefreshRequest | undefined;
    let running: RefreshRequest | undefined;
    const lane: DirectoryAccount = {
      revision,
      account,
      scope,
      request: (followUp = false) => {
        if (running && !followUp) return running;
        if (!queued) {
          queued = Deferred.makeUnsafe();
          Queue.offerUnsafe(queue, queued);
        }
        return queued;
      },
    };
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        const superseded = Effect.succeed("superseded" as const);
        if (queued) Deferred.doneUnsafe(queued, superseded);
        if (running) Deferred.doneUnsafe(running, superseded);
      }),
    );
    active = lane;

    const dispatch: Dispatch = (url, options) =>
      store.exclusive(
        Effect.gen(function* () {
          if (!(yield* isCurrent(lane))) return null;
          if (options.signal?.aborted) return null;
          // Start the HTTP request inside the fence, then release it while the response is in flight.
          return yield* Effect.try({
            try: () => ({
              response: (managementFetch ?? globalThis.fetch)(url, options).catch(() => null),
            }),
            catch: () => accountError("directory-unavailable"),
          });
        }),
      );

    const run = Effect.gen(function* (): Effect.fn.Return<
      SelfHostedRelayRefresh,
      SelfHostedRelayAccountError
    > {
      if ((yield* connectivity.status) === "offline") {
        return (yield* store.exclusive(isCurrent(lane))) ? "offline" : "superseded";
      }
      const snapshot = yield* fetchDirectory(account, dispatch);
      if (!snapshot) return "superseded";
      return yield* store.exclusive(
        Effect.gen(function* () {
          if (!(yield* isCurrent(lane))) return "superseded" as const;
          yield* apply(account.metadata.relayId, snapshot);
          return "refreshed" as const;
        }).pipe(Effect.uninterruptible),
      );
    });
    const work = Effect.gen(function* () {
      const request = yield* Queue.take(queue);
      queued = undefined;
      running = request;
      const result = yield* Effect.exit(run);
      if (Exit.isFailure(result) && Exit.hasInterrupts(result)) {
        return yield* Effect.failCause(result.cause);
      }
      if (Exit.isSuccess(result) && result.value === "superseded") {
        yield* retire(lane);
        return yield* Effect.interrupt;
      }
      yield* Effect.gen(function* () {
        running = undefined;
        yield* Deferred.done(request, result);
      }).pipe(Effect.uninterruptible);
    }).pipe(Effect.forever, Effect.interruptible);

    const requestRefresh = Effect.sync(() => {
      if (active === lane) lane.request(true);
    });
    yield* work.pipe(Effect.forkIn(scope));
    yield* Stream.merge(
      connectivity.changes.pipe(
        Stream.changes,
        Stream.filter((status) => status === "online"),
      ),
      Stream.fromEffectRepeat(Effect.sleep(REFRESH_INTERVAL)),
    ).pipe(
      Stream.runForEach(() => requestRefresh),
      Effect.interruptible,
      Effect.forkIn(scope),
    );
    yield* requestRefresh;
  });

  const finish = Effect.fn("SelfHostedRelayDirectory.finish")(function* (
    record: Parameters<typeof store.write>[0],
  ) {
    if (record.withdrawal === null) return record;
    yield* apply(record.withdrawal, EMPTY_SNAPSHOT);
    const committed = { ...record, withdrawal: null };
    yield* store.write(committed).pipe(Effect.uninterruptible);
    return committed;
  });

  const change = Effect.fn("SelfHostedRelayDirectory.change")(
    function* (next: StoredSelfHostedRelayAccount | null) {
      if (closed()) return yield* accountError("storage-unavailable");
      yield* read;
      const record = {
        version: 2 as const,
        revision: yield* store.newRevision,
        account: next,
        withdrawal: knownRelay,
      };
      yield* store.write(record);
      if (active) yield* retire(active);
      const committed = yield* finish(record);
      knownRelay = committed.account?.metadata.relayId ?? null;
      yield* startAccount(committed);
    },
    (effect) => store.exclusive(effect.pipe(Effect.uninterruptible)),
  );

  return SelfHostedRelayDirectory.of({
    account: Effect.sync(() => (closed() || !active ? null : { ...active.account.metadata })),
    configure: Effect.fn("SelfHostedRelayDirectory.configure")((value) =>
      prepareAccount(value).pipe(Effect.flatMap(change)),
    ),
    clear: change(null),
    refresh: Effect.suspend(() =>
      closed() || !active
        ? Effect.succeed("unconfigured" as const)
        : Deferred.await(active.request()),
    ),
    start: Effect.gen(function* () {
      if (started || closed()) return;
      started = true;
      yield* store.changes.pipe(
        Stream.runForEach(() =>
          store
            .exclusive(
              Effect.gen(function* () {
                const lane = active;
                if (lane && !(yield* isCurrent(lane))) yield* retire(lane);
              }),
            )
            .pipe(Effect.ignore),
        ),
        Effect.forkIn(owner, { startImmediately: true }),
      );
      yield* store
        .exclusive(
          Effect.gen(function* () {
            if (active || closed()) return;
            const record = yield* read;
            if (record === corrupt || record === null) return;
            if (record.withdrawal === null) {
              yield* startAccount(record).pipe(Effect.uninterruptible);
            } else if (record.revision !== null) {
              const committed = yield* finish({ ...record, revision: record.revision });
              yield* startAccount(committed).pipe(Effect.uninterruptible);
            }
          }),
        )
        .pipe(Effect.ignore);
    }),
  });
});

export const layer = Layer.effect(
  SelfHostedRelayDirectory,
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    return yield* makeDirectory({
      store: yield* SelfHostedRelayAccountStore,
      connectivity: yield* Connectivity,
      apply: (...args) =>
        EnvironmentRegistry.applyRelayDirectorySnapshot(...args).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        ),
    });
  }),
);
