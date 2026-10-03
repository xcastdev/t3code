import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import migration24 from "../../persistence/Migrations/fork/024_ProjectTeamPiOperations.ts";
import { makePiModelCatalogue, PiModelCatalogue } from "./PiModelCatalogue.ts";

const source = "https://api.commandcode.ai/provider/v1/models";
const now = 1790812800000;
const at = "2026-10-01T00:00:00.000Z";
const day = 24 * 60 * 60 * 1000;
const entry = {
  id: "inclusionai/ling-3.1-flash:free",
  owned_by: "command-code",
  context_length: 262144,
  supported_endpoints: ["/chat/completions"],
};
const catalogue = { source, fetchedAt: at, selectedEntry: entry };
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const response = (value: unknown = { object: "list", data: [entry] }) =>
  new Response(json(value), { headers: { "content-type": "application/json" } });
const memory = <A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));
const setup = Effect.gen(function* () {
  yield* TestClock.setTime(now);
  const sql = yield* SqlClient.SqlClient;
  yield* migration24;
  const seed = (value: unknown = catalogue, fetchedAt = at) =>
    sql`INSERT INTO project_team_pi_catalogue VALUES(${source}, ${fetchedAt}, ${json(value)})`;
  const rows = sql`SELECT source, fetched_at, payload_json FROM project_team_pi_catalogue`;
  return { sql, seed, rows };
});
const make = (supply: () => Response = response) => {
  const calls: string[] = [];
  const client = HttpClient.make((request) => {
    calls.push(`${request.method} ${request.url}`);
    return Effect.succeed(HttpClientResponse.fromWeb(request, supply()));
  });
  return {
    calls,
    service: makePiModelCatalogue.pipe(Effect.provideService(HttpClient.HttpClient, client)),
  };
};

it.effect(
  "construction and readFresh are cache-only; explicit refresh commits a frozen route",
  () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup;
        const h = make();
        const service = yield* h.service;
        expect(yield* service.readFresh).toBeUndefined();
        expect(h.calls).toEqual([]);
        const result = yield* service.refresh;
        expect(result).toEqual(catalogue);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.selectedEntry)).toBe(true);
        expect(Object.isFrozen(result.selectedEntry.supported_endpoints)).toBe(true);
        expect(yield* f.rows).toEqual([{ source, fetched_at: at, payload_json: json(catalogue) }]);
        expect(yield* service.readFresh).toEqual(catalogue);
        expect(h.calls).toEqual([`GET ${source}`]);
      }),
    ),
);

it.effect(
  "the native fetch layer receives only the fixed anonymous GET and denies redirect following",
  () =>
    memory(
      Effect.gen(function* () {
        yield* setup;
        const calls: Array<{ url: string; options: RequestInit | undefined }> = [];
        const fetch: typeof globalThis.fetch = async (input, options) => {
          calls.push({ url: String(input), options });
          return response();
        };
        const service = yield* PiModelCatalogue.pipe(
          Effect.provide(
            PiModelCatalogue.layer.pipe(
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
            ),
          ),
        );
        expect(yield* service.readFresh).toBeUndefined();
        expect(calls).toEqual([]);
        yield* service.refresh;
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(source);
        expect(calls[0]?.options).toMatchObject({
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
        });
        expect(new Headers(calls[0]?.options?.headers).get("authorization")).toBeNull();
        expect(calls[0]?.options?.signal?.aborted).toBe(true);
      }),
    ),
);

it.effect(
  "valid optional metadata and output limits do not grant authority or fabricate cost",
  () =>
    memory(
      Effect.gen(function* () {
        yield* setup;
        const h = make(() =>
          response({
            object: "list",
            data: [
              {
                ...entry,
                max_output_tokens: 4096,
                object: "model",
                name: "Ling",
                created: 1,
                tools: ["merge"],
              },
              { id: "other" },
            ],
          }),
        );
        const service = yield* h.service;
        const result = yield* service.refresh;
        expect(result.selectedEntry).toEqual({ ...entry, max_output_tokens: 4096 });
        expect(json(result)).not.toContain("merge");
      }),
    ),
);

for (const [name, entries] of [
  ["missing free route", [{ ...entry, id: "inclusionai/ling-3.1-flash" }]],
  ["duplicate free route", [entry, entry]],
  ["wrong owner", [{ ...entry, owned_by: "openai" }]],
  ["zero context", [{ ...entry, context_length: 0 }]],
  ["fractional context", [{ ...entry, context_length: 1.2 }]],
  ["string context", [{ ...entry, context_length: "262144" }]],
  ["missing endpoint", [{ ...entry, supported_endpoints: ["/responses"] }]],
  ["string endpoints", [{ ...entry, supported_endpoints: "/chat/completions" }]],
  ["zero output", [{ ...entry, max_output_tokens: 0 }]],
  ["output exceeds context", [{ ...entry, max_output_tokens: 262145 }]],
] as const) {
  it.effect(`rejects ${name} and retains the last committed cache`, () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.seed();
        const before = yield* f.rows;
        const h = make(() => response({ object: "list", data: entries }));
        const service = yield* h.service;
        expect((yield* service.refresh.pipe(Effect.flip)).reason).toBe("model");
        expect(yield* f.rows).toEqual(before);
        expect(yield* service.readFresh).toEqual(catalogue);
      }),
    ),
  );
}

for (const [name, supply, reason] of [
  [
    "redirect",
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.invalid/models" },
      }),
    "response",
  ],
  [
    "success with location",
    () => new Response("{}", { headers: { location: source, "content-type": "application/json" } }),
    "response",
  ],
  [
    "wrong content type",
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    "response",
  ],
  ["http failure", () => new Response("unavailable", { status: 503 }), "response"],
  [
    "malformed JSON",
    () => new Response("{", { headers: { "content-type": "application/json" } }),
    "payload",
  ],
  ["malformed list", () => response({ object: "list", data: "models" }), "payload"],
  [
    "oversized streamed bytes",
    () => new Response("x".repeat(262145), { headers: { "content-type": "application/json" } }),
    "payload",
  ],
  [
    "oversized advertised bytes",
    () =>
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "262145" },
      }),
    "payload",
  ],
  [
    "invalid UTF8",
    () => new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }),
    "payload",
  ],
] as const) {
  it.effect(`rejects ${name} without replacing the cache`, () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.seed();
        const before = yield* f.rows;
        const service = yield* make(supply).service;
        expect((yield* service.refresh.pipe(Effect.flip)).reason).toBe(reason);
        expect(yield* f.rows).toEqual(before);
      }),
    ),
  );
}

it.effect("future and 24-hour stale cache deny availability without fetching", () =>
  memory(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.seed();
      const h = make();
      const service = yield* h.service;
      yield* TestClock.setTime(now - 1);
      expect(yield* service.readFresh).toBeUndefined();
      yield* TestClock.setTime(now + day - 1);
      expect(yield* service.readFresh).toEqual(catalogue);
      yield* TestClock.setTime(now + day);
      expect(yield* service.readFresh).toBeUndefined();
      expect(h.calls).toEqual([]);
    }),
  ),
);

it.effect("corrupt cache timestamp, source and selected metadata fail closed", () =>
  memory(
    Effect.gen(function* () {
      const f = yield* setup;
      const h = make();
      const service = yield* h.service;
      for (const value of [
        { ...catalogue, source: "https://elsewhere.invalid/models" },
        { ...catalogue, fetchedAt: "2026-02-30T00:00:00.000Z" },
        { ...catalogue, selectedEntry: { ...entry, context_length: -1 } },
      ]) {
        yield* f.seed(value);
        expect((yield* service.readFresh.pipe(Effect.flip)).reason).toBe("storage");
        yield* f.sql`DELETE FROM project_team_pi_catalogue`;
      }
      yield* f.seed(catalogue, "2026-10-01T00:00:00.001Z");
      expect((yield* service.readFresh.pipe(Effect.flip)).reason).toBe("storage");
      expect(h.calls).toEqual([]);
    }),
  ),
);

it.effect("an offline explicit refresh retains a fresh cache and never retries", () =>
  memory(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.seed();
      let requests = 0;
      const service = yield* makePiModelCatalogue.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests++;
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause: "synthetic offline" }),
              }),
            );
          }),
        ),
      );
      expect((yield* service.refresh.pipe(Effect.flip)).reason).toBe("transport");
      expect(requests).toBe(1);
      expect(yield* service.readFresh).toEqual(catalogue);
    }),
  ),
);

it.effect("the whole refresh deadline includes a stalled response body and preserves cache", () =>
  memory(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.seed();
      const entered = yield* Deferred.make<void>();
      const client = HttpClient.make((request) =>
        Effect.succeed(
          new Proxy(HttpClientResponse.fromWeb(request, response()), {
            get(target, key, receiver) {
              return key === "stream"
                ? Stream.fromEffect(
                    Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                  )
                : Reflect.get(target, key, receiver);
            },
          }),
        ),
      );
      const service = yield* makePiModelCatalogue.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const pending = yield* service.refresh.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(10000);
      expect((yield* Fiber.join(pending)).reason).toBe("deadline");
      expect(yield* service.readFresh).toEqual(catalogue);
    }),
  ),
);

it.effect(
  "caller-owned and foreign transactions deny construction, reads and refresh before GET",
  () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup;
        const h = make();
        const service = yield* h.service;
        expect((yield* f.sql.withTransaction(h.service).pipe(Effect.flip)).reason).toBe(
          "transaction",
        );
        expect((yield* f.sql.withTransaction(service.readFresh).pipe(Effect.flip)).reason).toBe(
          "transaction",
        );
        expect((yield* f.sql.withTransaction(service.refresh).pipe(Effect.flip)).reason).toBe(
          "transaction",
        );
        yield* Effect.gen(function* () {
          const foreign = yield* SqlClient.SqlClient;
          expect(foreign.transactionService.key).not.toBe(f.sql.transactionService.key);
          expect((yield* foreign.withTransaction(service.refresh).pipe(Effect.flip)).reason).toBe(
            "transaction",
          );
        }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layerMemory())));
        expect(h.calls).toEqual([]);
      }),
    ),
);

for (const timing of ["read", "write"] as const) {
  it.effect(`checks Clock after the actual ${timing} SQL receipt`, () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.seed();
        const before = yield* f.rows;
        let receipts = 0;
        const wrapped = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            const text = statement.compile()[0];
            return text.includes(
              timing === "read"
                ? "SELECT source, fetched_at"
                : "INSERT INTO project_team_pi_catalogue",
            )
              ? statement.pipe(
                  Effect.tap(() => {
                    receipts++;
                    return TestClock.setTime(now - 1);
                  }),
                )
              : statement;
          },
        });
        const service = yield* make().service.pipe(
          Effect.provideService(SqlClient.SqlClient, wrapped),
        );
        if (timing === "read") expect(yield* service.readFresh).toBeUndefined();
        else expect((yield* service.refresh.pipe(Effect.flip)).reason).toBe("stale");
        expect(receipts).toBe(1);
        expect(yield* f.rows).toEqual(before);
      }),
    ),
  );
}

it.effect("a failed native SQL transaction cannot acknowledge or replace the predecessor", () =>
  memory(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.seed();
      const before = yield* f.rows;
      yield* f.sql`CREATE TRIGGER refuse_pi_catalogue BEFORE UPDATE ON project_team_pi_catalogue BEGIN SELECT RAISE(ABORT, 'fixture'); END`;
      const service = yield* make().service;
      expect((yield* service.refresh.pipe(Effect.flip)).reason).toBe("storage");
      expect(yield* f.rows).toEqual(before);
    }),
  ),
);

it.effect(
  "the native SQL receipt commits before refresh acknowledges and independent reads observe it",
  () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup;
        let commits = 0;
        const wrapped = new Proxy(f.sql, {
          get(target, key, receiver) {
            return key === "withTransaction"
              ? <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                  target.withTransaction(effect).pipe(
                    Effect.tap(() =>
                      Effect.gen(function* () {
                        expect(yield* f.rows).toEqual([
                          { source, fetched_at: at, payload_json: json(catalogue) },
                        ]);
                        expect((yield* Effect.serviceOption(f.sql.transactionService))._tag).toBe(
                          "None",
                        );
                        commits++;
                      }),
                    ),
                  )
              : Reflect.get(target, key, receiver);
          },
        });
        const service = yield* make().service.pipe(
          Effect.provideService(SqlClient.SqlClient, wrapped),
        );
        expect(yield* service.refresh).toEqual(catalogue);
        expect(commits).toBe(1);
      }),
    ),
);

it.effect(
  "a Clock jump after the actual commit denies acknowledgement and cached availability",
  () =>
    memory(
      Effect.gen(function* () {
        const f = yield* setup;
        const wrapped = new Proxy(f.sql, {
          get(target, key, receiver) {
            return key === "withTransaction"
              ? <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                  target.withTransaction(effect).pipe(Effect.tap(() => TestClock.setTime(now - 1)))
              : Reflect.get(target, key, receiver);
          },
        });
        const service = yield* make().service.pipe(
          Effect.provideService(SqlClient.SqlClient, wrapped),
        );
        expect((yield* service.refresh.pipe(Effect.flip)).reason).toBe("stale");
        // The commit is durable; freshness denial cannot promise a rollback after COMMIT.
        expect(yield* f.rows).toEqual([{ source, fetched_at: at, payload_json: json(catalogue) }]);
        expect(yield* service.readFresh).toBeUndefined();
      }),
    ),
);

it.effect("oversized physical cache is denied before SQL returns its payload", () =>
  memory(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.sql`PRAGMA ignore_check_constraints=ON`;
      yield* f.sql`INSERT INTO project_team_pi_catalogue VALUES(${source}, ${at}, ${"x".repeat(262145)})`;
      const h = make();
      const service = yield* h.service;
      expect((yield* service.readFresh.pipe(Effect.flip)).reason).toBe("storage");
      expect(h.calls).toEqual([]);
    }),
  ),
);

it.effect("committed catalogue survives native file-backed SQL restart without a fetch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-catalogue-" });
    const filename = path.join(directory, "state.sqlite");
    yield* Effect.gen(function* () {
      yield* setup;
      const service = yield* make().service;
      yield* service.refresh;
    }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename }))));
    yield* Effect.gen(function* () {
      const h = make();
      const service = yield* h.service;
      expect(yield* service.readFresh).toEqual(catalogue);
      expect(h.calls).toEqual([]);
    }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename }))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("the final SQL receipt remains inside the deadline and rolls back on timeout", () =>
  memory(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.seed();
      const before = yield* f.rows;
      const entered = yield* Deferred.make<void>();
      const wrapped = new Proxy(f.sql, {
        apply(target, _receiver, args) {
          const statement = target(args[0], ...args.slice(1));
          return statement.compile()[0].includes("INSERT INTO project_team_pi_catalogue")
            ? statement.pipe(
                Effect.tap(() =>
                  Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                ),
              )
            : statement;
        },
      });
      const service = yield* make().service.pipe(
        Effect.provideService(SqlClient.SqlClient, wrapped),
      );
      const pending = yield* service.refresh.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(10000);
      expect((yield* Fiber.join(pending)).reason).toBe("deadline");
      expect(yield* f.rows).toEqual(before);
    }),
  ),
);

it.effect("the actual final SQL receipt cannot outrun the deadline timer", () =>
  memory(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.seed();
      const before = yield* f.rows;
      const nativeClock = yield* Clock.Clock;
      let current = now;
      const wrapped = new Proxy(f.sql, {
        apply(target, _receiver, args) {
          const statement = target(args[0], ...args.slice(1));
          return statement.compile()[0].includes("INSERT INTO project_team_pi_catalogue")
            ? statement.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    current += 10000;
                  }),
                ),
              )
            : statement;
        },
      });
      // Advance wall time at the real write receipt without waking the timer scheduler.
      const service = yield* make().service.pipe(
        Effect.provideService(SqlClient.SqlClient, wrapped),
        Effect.provideService(Clock.Clock, {
          ...nativeClock,
          currentTimeMillisUnsafe: () => current,
        }),
      );
      expect((yield* service.refresh.pipe(Effect.flip)).reason).toBe("deadline");
      expect(yield* f.rows).toEqual(before);
    }),
  ),
);
