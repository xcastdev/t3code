/**
 * The user's answer goes straight to the server's secret store under a
 * one-use SecretRef; orchestration only records the request and its status.
 * A tool that needs the value takes the ref and consumes it, so the value
 * never reaches the transcript, projections, clients, or model context.
 */
import {
  CommandId,
  SecretRef,
  SecretRequestError,
  type ProjectId,
  type AuthSessionId,
  type McpCatalogSecretPrepareInput,
  type RunId,
  type RunAttemptId,
  type NodeId,
  type ProviderThreadId,
  type ProviderSessionId,
  type SecretRequestAnswerInput,
  type ThreadId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as RunAdmission from "../orchestration-v2/RunAdmission.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const SECRET_REF_PREFIX = "secret-ref:";
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;

const refFor = (salt: string, threadId: ThreadId, turnItemId: string) =>
  SecretRef.make(
    `${SECRET_REF_PREFIX}${NodeCrypto.createHmac("sha256", salt)
      .update(`${threadId}\u0000${turnItemId}`)
      .digest("hex")
      .slice(0, 32)}`,
  );

const CatalogBinding = Schema.Struct({
  authSessionId: Schema.String,
  scope: Schema.Literals(["global", "project", "session"]),
  scopeId: Schema.String,
  expectedRevision: Schema.Number,
  logicalServerId: Schema.String,
});
export type CatalogSecretBinding = typeof CatalogBinding.Type;
const CATALOG_REF_TTL_MS = 5 * 60 * 1000;
const StoredSecret = Schema.fromJsonString(
  Schema.Struct({
    projectId: Schema.optional(Schema.String),
    catalogBinding: Schema.optional(CatalogBinding),
    value: Schema.String,
    savedAt: Schema.Number,
  }),
);
const encodeStored = Schema.encodeEffect(StoredSecret);
const decodeStored = Schema.decodeUnknownOption(StoredSecret);

export interface SecretRequestExecution {
  readonly runId: RunId;
  readonly runAttemptId: RunAttemptId;
  readonly nodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
}

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
      readonly execution?: SecretRequestExecution;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    readonly prepareCatalog: (
      input: McpCatalogSecretPrepareInput & { readonly authSessionId: AuthSessionId },
    ) => Effect.Effect<SecretRef, SecretRequestError>;
    readonly consume: (input: {
      readonly ref: SecretRef;
      readonly projectId?: ProjectId;
      readonly catalogBinding?: CatalogSecretBinding;
    }) => Effect.Effect<string, SecretRequestError>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const admission = yield* RunAdmission.RunAdmission;
  const fileSystem = yield* FileSystem.FileSystem;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  const salt = Buffer.from(
    yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie),
  ).toString("hex");

  const answer: SecretRequests["Service"]["answer"] = Effect.fn("SecretRequests.answer")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "secret_request.answer": input.answer.type,
      });
      const records = yield* threadManagement
        .getThreadRecords(input.threadId, ["runs", "turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
        return yield* new SecretRequestError({ reason: "not_found" });
      }
      if (item.secretStatus !== "pending") {
        return yield* new SecretRequestError({ reason: "already_answered" });
      }
      const run = records.runs.find((candidate) => candidate.id === item.runId);
      if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
      // Store first: the card only says saved once the value is kept. Create,
      // not set: a second answer racing this one must not replace the value.
      // A value already there on a card still pending is an earlier save whose
      // record failed and could not be cleaned up; recording it finishes that save.
      if (input.answer.type === "save") {
        const encoded = yield* encodeStored({
          projectId: records.thread.projectId,
          value: input.answer.secret,
          savedAt: yield* Clock.currentTimeMillis,
        }).pipe(Effect.orDie);
        yield* store
          .create(
            storeName(refFor(salt, input.threadId, item.id)),
            new TextEncoder().encode(encoded),
          )
          .pipe(
            Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void),
            Effect.mapError(
              (error) => new SecretRequestError({ reason: "store_failed", cause: error }),
            ),
          );
      }
      const secretStatus = input.answer.type === "save" ? "saved" : "declined";
      yield* threadManagement
        .dispatch({
          type: "secret_request.record",
          commandId: CommandId.make(`secret-request:${item.id}:${secretStatus}`),
          threadId: input.threadId,
          runId: item.runId,
          nodeId: item.nodeId,
          turnItemId: item.id,
          label: item.label,
          reason: item.reason,
          ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
          secretStatus,
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
          // The card still says pending, so the user can save again; the value
          // stored above would make that retry look already answered.
          Effect.tapError(() =>
            input.answer.type === "save"
              ? removeLogged(storeName(refFor(salt, input.threadId, item.id)))
              : Effect.void,
          ),
        );
      if (input.answer.type !== "save") return;
      // A request is answered once: if the agent's wait closed the card between
      // the checks above and this record, the record changed nothing. Nobody
      // will receive the ref, so the value is deleted rather than left to expire.
      const recorded = yield* threadManagement
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
        );
      const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
      if (card?.type === "secret_request" && card.secretStatus !== "saved") {
        yield* removeLogged(storeName(refFor(salt, input.threadId, item.id)));
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
    },
  );

  const savedRef: SecretRequests["Service"]["savedRef"] = Effect.fn("SecretRequests.savedRef")(
    function* (input) {
      const ref = refFor(salt, input.threadId, input.turnItemId);
      const stored = yield* store.get(storeName(ref)).pipe(Effect.orElseSucceed(Option.none));
      if (Option.isNone(stored)) return Option.none();
      const execution = input.execution;
      if (execution !== undefined) {
        const records = yield* threadManagement
          .getThreadRecords(
            input.threadId,
            ["runs", "turnItems", "providerThreads", "providerSessions"],
            { turnItemTypes: ["secret_request"], messageRoles: [] },
          )
          .pipe(Effect.option);
        if (Option.isNone(records)) return Option.none();
        const item = records.value.turnItems.find((item) => item.id === input.turnItemId);
        const run = records.value.runs.find((run) => run.id === execution.runId);
        const providerThread = records.value.providerThreads.find(
          (thread) => thread.id === execution.providerThreadId,
        );
        const session = records.value.providerSessions.find(
          (session) => session.id === execution.providerSessionId,
        );
        if (
          item?.type !== "secret_request" ||
          item.secretStatus !== "saved" ||
          item.runId !== execution.runId ||
          item.nodeId !== execution.nodeId ||
          run === undefined ||
          ThreadManagementService.isTerminalRunStatus(run.status) ||
          run.rootNodeId !== execution.nodeId ||
          run.activeAttemptId !== execution.runAttemptId ||
          run.providerThreadId !== execution.providerThreadId ||
          providerThread?.providerSessionId !== execution.providerSessionId ||
          session === undefined ||
          session.status === "stopped" ||
          session.status === "error"
        )
          return Option.none();
      }
      // The final authority read follows all storage reads. An old request cannot
      // borrow a replacement run or attempt's admission to release its ref.
      const decision = yield* admission
        .check({
          threadId: input.threadId,
          ...(execution === undefined
            ? {}
            : {
                runId: execution.runId,
                originSessionId: execution.providerSessionId,
                nativeTarget: {
                  runAttemptId: execution.runAttemptId,
                  providerThreadId: execution.providerThreadId,
                  providerSessionId: execution.providerSessionId,
                  nodeId: execution.nodeId,
                },
              }),
          operation: "continue",
          now: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.orElseSucceed(() => ({ _tag: "denied" }) as const));
      if (decision._tag === "denied" || decision._tag === "expired") return Option.none();
      if (
        decision._tag === "admitted" &&
        (execution === undefined ||
          decision.owner.runId !== execution.runId ||
          decision.owner.runAttemptId !== execution.runAttemptId)
      )
        return Option.none();
      return Option.some(ref);
    },
  );

  const removeLogged = (name: string) =>
    store.remove(name).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a secret request value", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  // get and remove are separate store calls; one consumer at a time keeps two
  // concurrent calls from both reading a ref before either deletes it.
  const consumeLock = yield* Semaphore.make(1);
  const consume: SecretRequests["Service"]["consume"] = (input) =>
    consumeRef(input).pipe(
      consumeLock.withPermits(1),
      Effect.tap(() => Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "used" })),
      Effect.tapError(() =>
        Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "rejected" }),
      ),
      Effect.withSpan("SecretRequests.consume"),
    );

  const prepareCatalog: SecretRequests["Service"]["prepareCatalog"] = Effect.fn(
    "SecretRequests.prepareCatalog",
  )(function* (input) {
    const ref = SecretRef.make(`${SECRET_REF_PREFIX}${NodeCrypto.randomBytes(16).toString("hex")}`);
    const encoded = yield* encodeStored({
      catalogBinding: {
        authSessionId: input.authSessionId,
        scope: input.scope,
        scopeId: input.scopeId,
        expectedRevision: input.expectedRevision,
        logicalServerId: input.logicalServerId,
      },
      value: Redacted.value(input.secret),
      savedAt: yield* Clock.currentTimeMillis,
    }).pipe(Effect.orDie);
    yield* store
      .create(storeName(ref), new TextEncoder().encode(encoded))
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })));
    return ref;
  });

  const consumeRef = Effect.fn("SecretRequests.consumeRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId?: ProjectId;
    readonly catalogBinding?: CatalogSecretBinding;
  }) {
    if (!REF_PATTERN.test(input.ref))
      return yield* new SecretRequestError({ reason: "invalid_ref" });
    const stored = yield* store
      .get(storeName(input.ref))
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "read_failed", cause })));
    const decoded = Option.flatMap(stored, (bytes) =>
      decodeStored(new TextDecoder().decode(bytes)),
    );
    if (Option.isNone(decoded)) return yield* new SecretRequestError({ reason: "ref_unavailable" });
    const binding = decoded.value.catalogBinding;
    const expected = input.catalogBinding;
    const matches =
      binding === undefined
        ? input.projectId !== undefined && decoded.value.projectId === input.projectId
        : expected !== undefined &&
          binding.authSessionId === expected.authSessionId &&
          binding.scope === expected.scope &&
          binding.scopeId === expected.scopeId &&
          binding.expectedRevision === expected.expectedRevision &&
          binding.logicalServerId === expected.logicalServerId;
    if (!matches) {
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    }
    if (
      (yield* Clock.currentTimeMillis) - decoded.value.savedAt >
      (binding === undefined ? SECRET_REF_TTL_MS : CATALOG_REF_TTL_MS)
    ) {
      yield* removeLogged(storeName(input.ref));
      return yield* new SecretRequestError({ reason: "ref_expired" });
    }
    // One use: the value moves into whatever consumed it. If it cannot be
    // deleted, it is not handed out, so a ref is never used twice.
    if (!(yield* removeLogged(storeName(input.ref)))) {
      return yield* new SecretRequestError({ reason: "consume_failed" });
    }
    return decoded.value.value;
  });

  const sweepExpired = Effect.gen(function* () {
    if (store.directory === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const names = (yield* fileSystem.readDirectory(store.directory)).flatMap((file) => {
      const match = STORE_NAME_PATTERN.exec(file);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    let removed = 0;
    for (const name of names) {
      const stored = yield* store.get(name).pipe(Effect.orElseSucceed(Option.none));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (
        Option.isSome(decoded) &&
        now - decoded.value.savedAt <=
          (decoded.value.catalogBinding === undefined ? SECRET_REF_TTL_MS : CATALOG_REF_TTL_MS)
      )
        continue;
      if (yield* removeLogged(name)) removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret refs", cause)),
    Effect.withSpan("SecretRequests.sweepExpired"),
  );
  yield* sweepExpired;
  yield* sweepExpired.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );

  return SecretRequests.of({ answer, savedRef, consume, prepareCatalog });
});

export const layer = Layer.effect(SecretRequests, make);
