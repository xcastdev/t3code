// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous hashing keeps page matching bounded without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import type { ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

// Other providers may never consume these references.
const MAX_KEPT_HTML_RENDERS = 64;

// Antigravity truncates long HTML arguments to a marked tail of at most 8,000 characters.
const BOUNDED_TEXT_MARKER = "[Earlier output truncated]\n\n";
const KEPT_HTML_END_LENGTH = 8_000;

interface KeptHtmlRender {
  readonly title: string;
  readonly height: number;
  readonly htmlLength: number;
  readonly htmlHash: string;
  readonly htmlEnd: string;
  readonly reference: HtmlRenderReference;
}

const hashHtml = (html: string) => NodeCrypto.createHash("sha256").update(html).digest("hex");

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly beginCatalogEndpointInstallation: (config: McpProviderSessionConfig) => Effect.Effect<{
      readonly acknowledge: Effect.Effect<void>;
      readonly invalidate: Effect.Effect<void>;
    }>;
    readonly onCatalogEndpointAcknowledged: (
      listener: (config: McpProviderSessionConfig) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
    readonly acknowledgeCatalogEndpoint: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly readCatalogEndpointReceipt: (
      threadId: ThreadId,
    ) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly replaceIfCurrent: (
      expected: {
        readonly threadId: ThreadId;
        readonly providerSessionId: string;
        readonly nativeRuntimeId?: string;
      },
      replacement?: McpProviderSessionConfig,
    ) => Effect.Effect<boolean>;
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    readonly recordHtmlRender: (
      threadId: ThreadId,
      input: { readonly html: string; readonly title: string; readonly height: number },
      reference: HtmlRenderReference,
    ) => Effect.Effect<void>;
    // A reported attachment consumes that exact page; otherwise only unique input matches count.
    readonly takeHtmlRender: (
      threadId: ThreadId,
      input: { readonly html?: unknown; readonly title?: unknown; readonly height?: unknown },
      reported?: HtmlRenderReference,
    ) => Effect.Effect<HtmlRenderReference | undefined>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

const matchingPageIndex = (
  kept: ReadonlyArray<KeptHtmlRender>,
  input: { readonly html?: unknown; readonly title?: unknown; readonly height?: unknown },
): number => {
  const html = input.html;
  if (typeof html !== "string" || html.length === 0) {
    return -1;
  }
  const height =
    typeof input.height === "string" && input.height.trim() !== ""
      ? Number(input.height)
      : input.height;
  const htmlHash = hashHtml(html);
  const tail = html.startsWith(BOUNDED_TEXT_MARKER)
    ? html.slice(BOUNDED_TEXT_MARKER.length)
    : undefined;
  const matches = kept.flatMap((page, index) =>
    page.title === input.title &&
    page.height === height &&
    (page.htmlHash === htmlHash ||
      (tail !== undefined &&
        tail.length > 0 &&
        tail.length < page.htmlLength &&
        page.htmlEnd.endsWith(tail)))
      ? [index]
      : [],
  );
  return matches.length === 1 ? matches[0]! : -1;
};

const make = Effect.gen(function* () {
  const catalogInstallations = new Map<ThreadId, symbol>();
  const catalogListeners = new Set<(config: McpProviderSessionConfig) => Effect.Effect<void>>();
  const catalogReceipts = new Map<ThreadId, McpProviderSessionConfig>();
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const htmlRenders = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptHtmlRender>>());
  const acknowledgeCatalogEndpoint = Effect.fn("McpProviderSessions.acknowledgeCatalogEndpoint")(
    function* (config: McpProviderSessionConfig) {
      const accepted = yield* Ref.modify(sessions, (current) => {
        const actual = current.get(config.threadId);
        const matches = Boolean(
          config.catalogEndpoint &&
          config.nativeRuntimeId &&
          actual?.providerSessionId === config.providerSessionId &&
          actual.nativeRuntimeId === config.nativeRuntimeId &&
          actual.catalogEndpoint === config.catalogEndpoint &&
          actual.catalogRevision === config.catalogRevision,
        );
        if (matches) catalogReceipts.set(config.threadId, config);
        return [matches, current] as const;
      });
      if (accepted) for (const listener of catalogListeners) yield* listener(config);
    },
  );
  return McpProviderSessions.of({
    beginCatalogEndpointInstallation: (config) =>
      Effect.sync(() => {
        const current = Ref.getUnsafe(sessions);
        const actual = current.get(config.threadId);
        if (
          !actual ||
          actual.providerSessionId !== config.providerSessionId ||
          actual.nativeRuntimeId !== config.nativeRuntimeId ||
          actual.catalogEndpoint !== config.catalogEndpoint ||
          actual.catalogRevision !== config.catalogRevision
        )
          return { acknowledge: Effect.void, invalidate: Effect.void };
        const generation = Symbol();
        catalogInstallations.set(config.threadId, generation);
        catalogReceipts.delete(config.threadId);
        return {
          acknowledge: Effect.suspend(() =>
            catalogInstallations.get(config.threadId) === generation
              ? acknowledgeCatalogEndpoint(config)
              : Effect.void,
          ),
          invalidate: Effect.sync(() => {
            if (catalogInstallations.get(config.threadId) === generation) {
              catalogInstallations.delete(config.threadId);
              catalogReceipts.delete(config.threadId);
            }
          }),
        };
      }),
    onCatalogEndpointAcknowledged: (listener) =>
      Effect.sync(() => {
        catalogListeners.add(listener);
        return () => {
          catalogListeners.delete(listener);
        };
      }),
    acknowledgeCatalogEndpoint,
    replaceIfCurrent: (expected, replacement) =>
      Ref.modify(sessions, (current) => {
        const actual = current.get(expected.threadId);
        if (
          !actual ||
          actual.providerSessionId !== expected.providerSessionId ||
          (expected.nativeRuntimeId !== undefined &&
            actual.nativeRuntimeId !== expected.nativeRuntimeId)
        )
          return [false, current] as const;
        const next = new Map(current);
        if (replacement) next.set(expected.threadId, replacement);
        else next.delete(expected.threadId);
        if (
          !replacement ||
          actual.providerSessionId !== replacement.providerSessionId ||
          actual.nativeRuntimeId !== replacement.nativeRuntimeId ||
          actual.catalogEndpoint !== replacement.catalogEndpoint
        ) {
          catalogReceipts.delete(expected.threadId);
          catalogInstallations.delete(expected.threadId);
        }
        return [true, next] as const;
      }).pipe(
        Effect.tap((swapped) =>
          swapped
            ? Ref.update(htmlRenders, (current) => {
                const actual = Ref.getUnsafe(sessions).get(expected.threadId);
                if (
                  actual?.providerSessionId !== replacement?.providerSessionId ||
                  actual?.nativeRuntimeId !== replacement?.nativeRuntimeId
                )
                  return current;
                const next = new Map(current);
                next.delete(expected.threadId);
                return next;
              })
            : Effect.void,
        ),
      ),
    readCatalogEndpointReceipt: (threadId) => Effect.sync(() => catalogReceipts.get(threadId)),
    set: Effect.fn("McpProviderSessions.set")(function* (config) {
      const current = yield* Ref.get(sessions);
      const previous = current.get(config.threadId);
      if (
        previous?.providerSessionId !== config.providerSessionId ||
        previous?.nativeRuntimeId !== config.nativeRuntimeId ||
        previous?.catalogEndpoint !== config.catalogEndpoint
      ) {
        catalogReceipts.delete(config.threadId);
        catalogInstallations.delete(config.threadId);
      }
      if (current.get(config.threadId)?.providerSessionId !== config.providerSessionId) {
        yield* Ref.update(htmlRenders, (kept) => {
          const next = new Map(kept);
          next.delete(config.threadId);
          return next;
        });
      }
      yield* Ref.update(sessions, (current) => new Map(current).set(config.threadId, config));
    }),
    read: (threadId) => Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId))),
    clear: (threadId) =>
      Effect.sync(() => {
        catalogReceipts.delete(threadId);
        catalogInstallations.delete(threadId);
      }).pipe(
        Effect.andThen(
          Ref.update(sessions, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          }).pipe(
            Effect.andThen(
              Ref.update(htmlRenders, (current) => {
                const next = new Map(current);
                next.delete(threadId);
                return next;
              }),
            ),
          ),
        ),
      ),
    recordHtmlRender: (threadId, input, reference) =>
      Ref.update(htmlRenders, (current) =>
        new Map(current).set(
          threadId,
          [
            ...(current.get(threadId) ?? []),
            {
              title: input.title,
              height: input.height,
              htmlLength: input.html.length,
              htmlHash: hashHtml(input.html),
              // Copy the tail so its backing storage cannot retain the entire HTML string.
              htmlEnd: Buffer.from(input.html.slice(-KEPT_HTML_END_LENGTH), "utf16le").toString(
                "utf16le",
              ),
              reference,
            },
          ].slice(-MAX_KEPT_HTML_RENDERS),
        ),
      ),
    takeHtmlRender: (threadId, input, reported) =>
      Ref.modify(htmlRenders, (current) => {
        const kept = current.get(threadId) ?? [];
        const index =
          reported === undefined
            ? matchingPageIndex(kept, input)
            : kept.findIndex((page) => page.reference.attachmentId === reported.attachmentId);
        if (index === -1) {
          return [undefined, current];
        }
        const rest = kept.filter((_, keptIndex) => keptIndex !== index);
        const next = new Map(current);
        if (rest.length === 0) {
          next.delete(threadId);
        } else {
          next.set(threadId, rest);
        }
        return [kept[index]!.reference, next];
      }),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
