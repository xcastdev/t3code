import { SelfHostedRelayEnrolledEnvironment } from "@t3tools/contracts/selfHostedRelay";
import { SelfHostedRelayDirectoryDiscovery } from "@t3tools/contracts/selfHostedRelayDirectory";
import { RelayDirectory } from "@t3tools/relay-core/RelayDirectory";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Pull from "effect/Pull";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { authenticatedRoute, errorResponse } from "./SelfHostedRelayHttp.ts";

const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const publisherHeaders = { ...headers, connection: "close" };
const mediaType = "application/x-ndjson";
const maxFrameBytes = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const parsedDirectoryQuery = HttpRouter.schemaParams(
  Schema.Struct({
    environmentId: Schema.optionalKey(SelfHostedRelayEnrolledEnvironment.fields.environmentId),
  }),
  { onExcessProperty: "error" },
);

const directoryQuery = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  yield* Effect.try({
    try: () => decodeURIComponent(request.url.split("?", 2)[1] ?? ""),
    catch: () => "invalid_request" as const,
  });
  return yield* parsedDirectoryQuery;
});

const readFrames = Effect.fn("SelfHostedRelayDirectoryHttp.readFrames")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const pull = (yield* Stream.toPull(request.stream)).pipe(
    Pull.catchDone(() => Effect.succeed([] as const)),
    Effect.mapError(() => "invalid_request" as const),
  );
  const buffer = new Uint8Array(maxFrameBytes);
  let chunks: readonly Uint8Array[] = [];
  let index = 0;
  let offset = 0;
  let length = 0;

  // The stream has a single reader and traces the request at its boundary.
  const next = Effect.fnUntraced(function* () {
    for (;;) {
      if (index === chunks.length) {
        chunks = yield* pull;
        index = 0;
        offset = 0;
        if (chunks.length === 0) {
          if (length === 0) return undefined;
          return yield* Effect.fail("invalid_request" as const);
        }
      }
      const chunk = chunks[index]!;
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const bytes = chunk.subarray(offset, end);
      if (length + bytes.length > maxFrameBytes) {
        return yield* Effect.fail("frame_too_large" as const);
      }
      buffer.set(bytes, length);
      length += bytes.length;

      if (newline === -1 || end + 1 === chunk.length) {
        index++;
        offset = 0;
      } else {
        offset = end + 1;
      }
      if (newline !== -1) {
        const data = buffer.subarray(0, length);
        length = 0;
        const value = yield* Effect.try({
          try: () => decoder.decode(data),
          catch: () => "invalid_request" as const,
        }).pipe(
          Effect.flatMap(parseJson),
          Effect.mapError(() => "invalid_request" as const),
        );
        return { value };
      }
    }
  });

  return next().pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail("publisher_timeout" as const),
    }),
  );
});

const waitForAbort = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const abort = () => resume(Effect.void);
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

const publisherError = (status: number, error: string) =>
  errorResponse(status, error, publisherHeaders);

const openPublisher = Effect.fn("SelfHostedRelayDirectoryHttp.openPublisher")(
  function* (credential: string) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== mediaType) {
      return publisherError(415, "unsupported_media_type");
    }
    const directory = yield* RelayDirectory;
    const scope = yield* Scope.fork(yield* Scope.Scope);
    const read = yield* Scope.provide(readFrames(request), scope);
    const first = yield* read;
    if (first === undefined) return publisherError(400, "invalid_request");
    const lease = yield* Scope.provide(directory.openPublisher(credential, first.value), scope);

    const updates = Effect.gen(function* () {
      while (!lease.signal.aborted) {
        const frame = yield* read;
        if (frame === undefined) return;
        yield* lease.replace(frame.value);
      }
    }).pipe(
      Effect.catch((error) => {
        if (typeof error === "string") return Effect.succeed(error);
        switch (error._tag) {
          case "RelayAccessDeniedError":
            return Effect.succeed("access_denied");
          case "RelayInputError":
            return Effect.succeed("invalid_request");
          case "RelayDirectoryPublisherClosedError":
            return Effect.void;
        }
      }),
      Effect.catchDefect(() => Effect.succeed("internal_error")),
      Effect.raceFirst(waitForAbort(lease.signal)),
      Effect.ensuring(Scope.close(scope, Exit.void)),
    );

    const body = Stream.suspend(() =>
      lease.signal.aborted
        ? Stream.empty
        : Stream.make(encoder.encode('{"version":1,"status":"accepted"}\n')).pipe(
            Stream.concat(
              Stream.fromEffect(updates).pipe(
                Stream.flatMap((error) =>
                  error === undefined
                    ? Stream.empty
                    : Stream.make(encoder.encode(JSON.stringify({ version: 1, error }) + "\n")),
                ),
              ),
            ),
          ),
    );
    return HttpServerResponse.stream(body, { contentType: mediaType, headers: publisherHeaders });
  },
  Effect.interruptible,
  Effect.catchTags({
    RelayDirectoryPublisherLimitError: ({ reason }) =>
      Effect.succeed(
        reason === "environment-busy"
          ? publisherError(409, "environment_busy")
          : publisherError(503, "publisher_capacity"),
      ),
    RelayDirectoryPublisherClosedError: () =>
      Effect.succeed(publisherError(409, "publisher_closed")),
  }),
  Effect.catchIf(
    (error) => typeof error === "string",
    (error) =>
      Effect.succeed(
        publisherError(
          error === "frame_too_large" ? 413 : error === "publisher_timeout" ? 408 : 400,
          error,
        ),
      ),
  ),
);

export const layer = Layer.mergeAll(
  authenticatedRoute(
    "GET",
    "/directory",
    (credential) =>
      Effect.gen(function* () {
        const directory = yield* RelayDirectory;
        const { environmentId } = yield* directoryQuery.pipe(
          Effect.mapError(() => "invalid_request" as const),
        );
        const result = yield* directory.discover(credential, environmentId);
        return yield* HttpServerResponse.schemaJson(SelfHostedRelayDirectoryDiscovery)(result, {
          headers,
        });
      }),
    headers,
  ),
  authenticatedRoute("POST", "/directory/publisher", openPublisher, publisherHeaders),
);
