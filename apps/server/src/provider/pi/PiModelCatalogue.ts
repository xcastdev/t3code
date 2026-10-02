import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const source = "https://api.commandcode.ai/provider/v1/models";
const model = "inclusionai/ling-3.1-flash:free";
const maxBytes = 262144;
const maxAgeMs = 24 * 60 * 60 * 1000;
const deadlineMs = 10000;
const Positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value;
  }),
);
const SelectedEntry = Schema.Struct({
  id: Schema.Literal(model),
  owned_by: Schema.Literal("command-code"),
  context_length: Positive,
  supported_endpoints: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
    Schema.isMaxLength(32),
    Schema.makeFilter((endpoints) => endpoints.includes("/chat/completions")),
  ),
  max_output_tokens: Schema.optional(Positive),
}).check(
  Schema.makeFilter(
    (entry) =>
      entry.max_output_tokens === undefined || entry.max_output_tokens <= entry.context_length,
  ),
);
const Catalogue = Schema.Struct({
  source: Schema.Literal(source),
  fetchedAt: Timestamp,
  selectedEntry: SelectedEntry,
});
const Remote = Schema.Struct({
  object: Schema.Literal("list"),
  data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).check(Schema.isMaxLength(2048)),
});
const Row = Schema.Struct({
  source: Schema.Literal(source),
  fetchedAt: Timestamp,
  bytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxBytes })),
  payload: Schema.String.check(Schema.isMaxLength(maxBytes)),
});
const decodeRemote = Schema.decodeUnknownEffect(Schema.fromJsonString(Remote));
const decodeSelected = Schema.decodeUnknownEffect(SelectedEntry);
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row).check(Schema.isMaxLength(1)));
const decodeCatalogue = Schema.decodeUnknownEffect(Schema.fromJsonString(Catalogue), {
  onExcessProperty: "error",
});
const encodeCatalogue = Schema.encodeEffect(Schema.fromJsonString(Catalogue));

export type PiCatalogue = typeof Catalogue.Type;

export class PiModelCatalogueError extends Schema.TaggedError<PiModelCatalogueError>()(
  "PiModelCatalogueError",
  {
    reason: Schema.Literals([
      "transaction",
      "storage",
      "transport",
      "response",
      "payload",
      "model",
      "stale",
      "deadline",
    ]),
  },
) {
  override get message() {
    return `Pi model catalogue is unavailable (${this.reason}).`;
  }
}
const fail = (reason: PiModelCatalogueError["reason"]) => new PiModelCatalogueError({ reason });

export class PiModelCatalogue extends Context.Service<
  PiModelCatalogue,
  {
    readonly readFresh: Effect.Effect<PiCatalogue | undefined, PiModelCatalogueError>;
    readonly refresh: Effect.Effect<PiCatalogue, PiModelCatalogueError>;
  }
>()("t3/provider/pi/PiModelCatalogue") {
  static readonly layer = Layer.effect(
    PiModelCatalogue,
    Effect.suspend(() => makePiModelCatalogue),
  );
}

// Reject foreign SQL transactions too: a receipt from a nested transaction is not a commit.
const outsideTransaction = Effect.contextWith((context: Context.Context<never>) =>
  Array.from(context.mapUnsafe.keys()).some((key) =>
    key.startsWith("effect/sql/SqlClient/TransactionConnection/"),
  )
    ? Effect.fail(fail("transaction"))
    : Effect.void,
);
const immutable = (catalogue: PiCatalogue): PiCatalogue =>
  Object.freeze({
    source: catalogue.source,
    fetchedAt: catalogue.fetchedAt,
    selectedEntry: Object.freeze({
      ...catalogue.selectedEntry,
      supported_endpoints: Object.freeze([...catalogue.selectedEntry.supported_endpoints]),
    }),
  });
const fresh = (fetchedAt: string, now: number) => {
  const parsed = DateTime.make(fetchedAt);
  if (Option.isNone(parsed)) return false;
  const at = DateTime.toEpochMillis(parsed.value);
  return Number.isSafeInteger(now) && now >= at && now - at < maxAgeMs;
};

/** Parent-owned SQL and transport are mandatory; construction and reads never fetch. */
export const makePiModelCatalogue = Effect.gen(function* () {
  yield* outsideTransaction;
  const sql = yield* SqlClient.SqlClient;
  const client = yield* HttpClient.HttpClient;
  const clock = yield* Clock.Clock;
  const readFresh = Effect.gen(function* () {
    yield* outsideTransaction;
    // Measure before returning text so corrupt storage cannot allocate an unbounded payload.
    const rows = yield* sql`
      SELECT source, fetched_at AS "fetchedAt", length(CAST(payload_json AS BLOB)) AS bytes,
        CASE WHEN length(CAST(payload_json AS BLOB)) <= ${maxBytes} THEN payload_json ELSE NULL END AS payload
      FROM project_team_pi_catalogue WHERE source = ${source} LIMIT 2
    `.pipe(Effect.mapError(() => fail("storage")));
    const decoded = yield* decodeRows(rows).pipe(Effect.mapError(() => fail("storage")));
    const row = decoded[0];
    if (row === undefined) return undefined;
    const catalogue = yield* decodeCatalogue(row.payload).pipe(
      Effect.mapError(() => fail("storage")),
    );
    if (catalogue.fetchedAt !== row.fetchedAt) return yield* fail("storage");
    // Sample after the SQL receipt and decode, in the same evaluation as publication.
    return yield* Effect.sync(() =>
      fresh(catalogue.fetchedAt, clock.currentTimeMillisUnsafe())
        ? immutable(catalogue)
        : undefined,
    );
  });
  const refresh = Effect.gen(function* () {
    yield* outsideTransaction;
    const startedAt = clock.currentTimeMillisUnsafe();
    const deadline = Effect.suspend(() => {
      const now = clock.currentTimeMillisUnsafe();
      return now >= startedAt && now - startedAt < deadlineMs
        ? Effect.void
        : Effect.fail(fail("deadline"));
    });
    const response = yield* HttpClient.withScope(client)
      .execute(
        HttpClientRequest.get(source).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
        }),
        Effect.mapError(() => fail("transport")),
      );
    if (
      response.status !== 200 ||
      response.headers["location"] !== undefined ||
      !/^application\/json(?:\s*;|$)/iu.test(response.headers["content-type"] ?? "")
    )
      return yield* fail("response");
    const contentLength = response.headers["content-length"];
    if (
      contentLength !== undefined &&
      (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBytes)
    )
      return yield* fail("payload");
    const buffer = new Uint8Array(maxBytes);
    const length = yield* Stream.runFoldEffect(
      response.stream,
      () => 0,
      (offset, chunk) => {
        if (offset + chunk.byteLength > maxBytes) return Effect.fail(fail("payload"));
        return Effect.sync(() => {
          buffer.set(chunk, offset);
          return offset + chunk.byteLength;
        });
      },
    ).pipe(
      Effect.mapError((error) =>
        error._tag === "PiModelCatalogueError" ? error : fail("transport"),
      ),
    );
    const body = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
      catch: () => fail("payload"),
    });
    const remote = yield* decodeRemote(body).pipe(Effect.mapError(() => fail("payload")));
    const selected = remote.data.filter((entry) => entry.id === model);
    if (selected.length !== 1) return yield* fail("model");
    const entry = yield* decodeSelected(selected[0]).pipe(Effect.mapError(() => fail("model")));
    yield* deadline;
    const catalogue = immutable({
      source,
      fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())),
      selectedEntry: entry,
    });
    const payload = yield* encodeCatalogue(catalogue).pipe(Effect.mapError(() => fail("payload")));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
        INSERT INTO project_team_pi_catalogue(source, fetched_at, payload_json) VALUES(${source}, ${catalogue.fetchedAt}, ${payload})
        ON CONFLICT(source) DO UPDATE SET fetched_at = excluded.fetched_at, payload_json = excluded.payload_json
      `;
          // A held final SQL receipt can outlive the selected metadata; reject before commit.
          yield* Effect.suspend(() =>
            fresh(catalogue.fetchedAt, clock.currentTimeMillisUnsafe())
              ? Effect.void
              : Effect.fail(fail("stale")),
          );
          yield* deadline;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "PiModelCatalogueError" ? error : fail("storage"),
        ),
      );
    return yield* Effect.suspend(() => {
      const now = clock.currentTimeMillisUnsafe();
      if (!fresh(catalogue.fetchedAt, now)) return Effect.fail(fail("stale"));
      return now >= startedAt && now - startedAt < deadlineMs
        ? Effect.succeed(catalogue)
        : Effect.fail(fail("deadline"));
    });
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.fail(fail("deadline")) }),
  );
  return PiModelCatalogue.of({ readFresh, refresh });
});
