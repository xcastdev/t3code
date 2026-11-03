// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The inspector backend packs to one builtin-only CommonJS file with no Effect runtime.
import {
  materializeAsset,
  type OperationContext,
  type PluginBackendDefinition,
  type PluginWorkerStatus,
  reportStatus,
  type TopicEmitter,
} from "@t3tools/plugin-sdk/backend";

import { decodeBody, type DraftStore, makeBodyReader, makeDraftStore } from "./bodies.ts";
import {
  MITMDUMP_HINT,
  makeMitm,
  type MitmProcess,
  type MitmSpawner,
  MitmStartError,
} from "./mitm.ts";
import { requestOrigin } from "./origin.ts";
import { redactHeaders } from "./redact.ts";
import { MISSING_DETAILS, mustBeDetail, REPLAY_INPUT_DETAILS } from "./refusals.ts";
import {
  type InspectorTimer,
  makeReplayService,
  REPLAY_LIMITS,
  type ReplayBodyEdit,
  type ReplayEdits,
  type ReplayService,
  replayStatusItem,
  realTimer,
} from "./replay.ts";
import {
  type BodyMeta,
  type BodySide,
  type CaptureRecord,
  type HeaderPair,
  type InspectorStore,
  InspectorRefusal,
  openInspectorStore,
  type RequestRecord,
  type RequestSummary,
  type SearchFilter,
  STORE_LIMITS,
  type StorageStep,
  type StoreChange,
} from "./store.ts";

const MiB = 1024 * 1024;

export const INSPECTOR_DEFAULTS = {
  listenHost: "127.0.0.1",
  listenPort: 8080,
  maxBodyBytes: 1 * MiB,
  maxDiskBytes: 512 * MiB,
  maxRequestsPerCapture: 50_000,
} as const;

const MIN_DISK_BYTES = 64 * MiB;
const MAX_BODY_BYTES = 16 * MiB;
const HEADER_VALUE_CHARS = 8 * 1024;
const HEADER_SIDE_CHARS = 32 * 1024;
const DEFAULT_PREVIEW_BYTES = 8192;
const MAX_PREVIEW_BYTES = 32768;
const DETAIL_PATH_CHARS = 8192;
const MAX_LISTED_CAPTURES = 500;
const REFERENCE_DETAIL_CHARS = 4000;
// The SDK caps a result or snapshot at PLUGIN_LIMITS.maxPayloadBytes; leave room for its envelope.
const PAYLOAD_BYTES = 224 * 1024;

export interface InspectorConfig {
  readonly listenHost: string;
  readonly listenPort: number;
  readonly maxBodyBytes: number;
  readonly maxDiskBytes: number;
  readonly maxRequestsPerCapture: number;
}

const numberSetting = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? Math.min(Math.max(value, min), max)
    : fallback;

export function readInspectorConfig(config: Readonly<Record<string, unknown>>): InspectorConfig {
  return {
    listenHost:
      typeof config.listenHost === "string" && config.listenHost.trim() !== ""
        ? config.listenHost.trim()
        : INSPECTOR_DEFAULTS.listenHost,
    listenPort: numberSetting(config.listenPort, INSPECTOR_DEFAULTS.listenPort, 1, 65535),
    maxBodyBytes: numberSetting(
      config.maxBodyBytes,
      INSPECTOR_DEFAULTS.maxBodyBytes,
      0,
      MAX_BODY_BYTES,
    ),
    maxDiskBytes: numberSetting(
      config.maxDiskBytes,
      INSPECTOR_DEFAULTS.maxDiskBytes,
      MIN_DISK_BYTES,
      Number.MAX_SAFE_INTEGER,
    ),
    maxRequestsPerCapture: numberSetting(
      config.maxRequestsPerCapture,
      INSPECTOR_DEFAULTS.maxRequestsPerCapture,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export interface InspectorDeps {
  readonly addonSource: string;
  readonly spawner?: MitmSpawner;
  /** PATH searched for mitmdump. Defaults to the worker's PATH. */
  readonly searchPath?: string;
  readonly timer?: InspectorTimer;
  readonly now?: () => number;
  readonly materialize?: (name: string, contents: string) => Promise<string>;
  readonly reportStatus?: (state: PluginWorkerStatus, detail?: string) => void;
  readonly maxReplayHistory?: number;
  readonly onStorageStep?: (step: StorageStep) => void;
  /** Overrides config values, for tests that need a budget below the 64 MiB setting floor. */
  readonly configOverrides?: Partial<InspectorConfig>;
}

interface CaptureEntry {
  readonly process: MitmProcess;
  readonly captureId: number;
  readonly finished: Promise<void>;
}

interface Session {
  readonly store: InspectorStore;
  readonly drafts: DraftStore;
  readonly readBody: ReturnType<typeof makeBodyReader>;
  readonly replay: ReplayService;
  readonly mitm: ReturnType<typeof makeMitm>;
  readonly config: InspectorConfig;
  readonly log: (message: string) => void;
}

type Input = Readonly<Record<string, unknown>>;

const objectInput = (input: unknown): Input =>
  typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Input) : {};

const invalid = (message: string) => new InspectorRefusal("invalid-input", message);

const optionalString = (input: Input, key: string): string | undefined => {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(mustBeDetail(key, "a string"));
  return value;
};

const optionalInteger = (input: Input, key: string): number | undefined => {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalid(mustBeDetail(key, "an integer"));
  }
  return value;
};

const ID_PATTERN = /^[1-9]\d{0,15}$/;

const parseId = (value: unknown, what: "request" | "capture"): number => {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !ID_PATTERN.test(text)) {
    throw new InspectorRefusal("not-found", MISSING_DETAILS[what]);
  }
  return Number(text);
};

const parseEdits = (value: unknown): ReplayEdits | undefined => {
  if (value === undefined) return undefined;
  const edits = objectInput(value);
  const method = optionalString(edits, "method");
  const url = optionalString(edits, "url");
  let headers: Array<readonly [string, string]> | undefined;
  if (edits.headers !== undefined) {
    if (!Array.isArray(edits.headers)) throw invalid(REPLAY_INPUT_DETAILS.headersShape);
    headers = edits.headers.map((pair: unknown) => {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        typeof pair[1] !== "string"
      ) {
        throw invalid(REPLAY_INPUT_DETAILS.headerPairs);
      }
      return [pair[0], pair[1]] as const;
    });
  }
  let body: ReplayBodyEdit | undefined;
  if (edits.body !== undefined) {
    const raw = objectInput(edits.body);
    if (raw.kind === "inline" && typeof raw.base64 === "string") {
      body = { kind: "inline", base64: raw.base64 };
    } else if (raw.kind === "draft" && typeof raw.draftId === "string") {
      body = { kind: "draft", draftId: raw.draftId };
    } else {
      throw invalid(REPLAY_INPUT_DETAILS.bodyShape);
    }
  }
  return {
    ...(method === undefined ? {} : { method }),
    ...(url === undefined ? {} : { url }),
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
};

const replayInput = (input: Input) => {
  const edits = parseEdits(input.edits);
  return {
    requestId: parseId(input.requestId, "request"),
    ...(edits === undefined ? {} : { edits }),
  };
};

export const summaryView = (summary: RequestSummary) => ({
  ...summary,
  id: String(summary.id),
  captureId: String(summary.captureId),
});

export const captureView = (capture: CaptureRecord) => ({
  ...capture,
  id: String(capture.id),
});

const headerText = (pairs: ReadonlyArray<HeaderPair>) =>
  pairs.map(
    ([name, value]) =>
      [Buffer.from(name).toString("latin1"), Buffer.from(value).toString("latin1")] as const,
  );

/** Ordered headers with each value cut at 8 KiB and the side cut at 32 KiB. */
export function shapeHeaders(
  pairs: ReadonlyArray<HeaderPair>,
  includeSensitive: boolean,
  sideChars = HEADER_SIDE_CHARS,
) {
  const headers: Array<[string, string]> = [];
  let truncated = false;
  let used = 0;
  for (const [name, value] of redactHeaders(headerText(pairs), includeSensitive)) {
    let text = value;
    if (text.length > HEADER_VALUE_CHARS) {
      text = text.slice(0, HEADER_VALUE_CHARS);
      truncated = true;
    }
    if (used + name.length + text.length > sideChars) {
      truncated = true;
      break;
    }
    used += name.length + text.length;
    headers.push([name, text]);
  }
  return { headers, headersTruncated: truncated };
}

const TEXT_TYPE =
  /^\s*(?:text\/|application\/(?:json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson)|[^;]*\+(?:json|xml))/i;

const looksLikeText = (bytes: Buffer) => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
};

/** Cuts at most 3 trailing bytes so a preview never ends inside a UTF-8 sequence. */
const utf8Prefix = (bytes: Buffer, limit: number) => {
  let end = Math.min(limit, bytes.byteLength);
  if (end < bytes.byteLength) {
    let back = 0;
    while (back < 3 && end - back > 0 && ((bytes[end - back] ?? 0) & 0xc0) === 0x80) back += 1;
    end -= back;
  }
  return bytes.subarray(0, end);
};

function readBodyView(
  store: InspectorStore,
  requestId: number,
  side: BodySide,
  meta: BodyMeta,
  withPreview: boolean,
) {
  const base = {
    capturedBytes: meta.capturedBytes,
    ...(meta.declaredBytes === undefined ? {} : { declaredBytes: meta.declaredBytes }),
    truncated: meta.truncated,
    ...(meta.contentEncoding === undefined ? {} : { contentEncoding: meta.contentEncoding }),
  };
  const typed = meta.contentType === undefined ? undefined : TEXT_TYPE.test(meta.contentType);
  const raw =
    withPreview || typed === undefined ? store.readBody(requestId, side)?.bytes : undefined;
  if (raw === undefined) return { base: { ...base, isText: typed ?? false } };
  let decoded: Buffer | undefined;
  try {
    decoded = decodeBody(raw, meta.contentEncoding);
  } catch {
    decoded = undefined;
  }
  const isText = typed ?? (decoded !== undefined && looksLikeText(decoded.subarray(0, 4096)));
  if (!withPreview) return { base: { ...base, isText } };
  return {
    base: { ...base, isText },
    source: decoded ?? raw,
    decoded: decoded !== undefined,
    asText: isText && decoded !== undefined,
  };
}

const renderBodyView = (body: ReturnType<typeof readBodyView>, previewBytes: number) => {
  if (body.source === undefined) return body.base;
  const slice = body.asText
    ? utf8Prefix(body.source, previewBytes)
    : body.source.subarray(0, previewBytes);
  return {
    ...body.base,
    preview: {
      decoded: body.decoded,
      ...(body.asText ? { text: slice.toString("utf8") } : { base64: slice.toString("base64") }),
      bytes: slice.byteLength,
      totalBytes: body.source.byteLength,
      complete: slice.byteLength === body.source.byteLength,
    },
  };
};

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * Shrinks previews, then headers, then the path until the JSON fits `budgetBytes`:
 * escaping can grow control bytes in text sixfold.
 */
export function requestDetail(
  store: InspectorStore,
  record: RequestRecord,
  options: {
    readonly previewBytes: number;
    readonly bodies: "none" | "request" | "response" | "both";
    readonly includeSensitiveHeaders: boolean;
  },
  budgetBytes = PAYLOAD_BYTES,
) {
  const { summary } = record;
  const body = (side: BodySide, meta: BodyMeta | undefined) =>
    meta === undefined
      ? undefined
      : readBodyView(
          store,
          summary.id,
          side,
          meta,
          options.bodies === "both" || options.bodies === side,
        );
  const requestBody = body("request", record.requestBody);
  const responseBody = body("response", record.response?.body);
  const render = (previewBytes: number, headerChars: number, pathChars: number) => {
    const pathCut = record.path.length > pathChars;
    return {
      id: String(summary.id),
      captureId: String(summary.captureId),
      startedAt: summary.startedAt,
      flowType: summary.flowType,
      method: summary.method,
      scheme: summary.scheme,
      host: summary.host,
      port: summary.port,
      authority: record.authority,
      path: pathCut ? record.path.slice(0, pathChars) : record.path,
      ...(pathCut ? { pathTruncated: true } : {}),
      httpVersion: record.httpVersion,
      ...(summary.replayOf === undefined ? {} : { replayOf: summary.replayOf }),
      ...(summary.error === undefined ? {} : { error: summary.error }),
      request: {
        ...shapeHeaders(record.requestHeaders, options.includeSensitiveHeaders, headerChars),
        ...(requestBody === undefined ? {} : { body: renderBodyView(requestBody, previewBytes) }),
      },
      ...(record.response === undefined
        ? {}
        : {
            response: {
              status: record.response.status,
              ...(record.response.reason === undefined ? {} : { reason: record.response.reason }),
              httpVersion: record.response.httpVersion,
              ...shapeHeaders(
                record.response.headers,
                options.includeSensitiveHeaders,
                headerChars,
              ),
              ...(responseBody === undefined
                ? {}
                : { body: renderBodyView(responseBody, previewBytes) }),
            },
          }),
    };
  };
  let previewBytes = options.previewBytes;
  let headerChars = HEADER_SIDE_CHARS;
  let pathChars = DETAIL_PATH_CHARS;
  for (;;) {
    const detail = render(previewBytes, headerChars, pathChars);
    if (jsonBytes(detail) <= budgetBytes) return detail;
    if (previewBytes > 0) previewBytes = Math.floor(previewBytes / 2);
    else if (headerChars > 0) headerChars = Math.floor(headerChars / 2);
    else if (pathChars > STORE_LIMITS.summaryPathChars) pathChars = STORE_LIMITS.summaryPathChars;
    else return detail;
  }
}

const parseFilter = (input: Input): SearchFilter => {
  const query = optionalString(input, "query");
  const method = optionalString(input, "method");
  const host = optionalString(input, "host");
  const status = optionalInteger(input, "status");
  const captureId =
    input.captureId === undefined || input.captureId === null
      ? undefined
      : parseId(input.captureId, "capture");
  return {
    ...(query === undefined || query === "" ? {} : { query }),
    ...(method === undefined || method === "" ? {} : { method }),
    ...(host === undefined || host === "" ? {} : { host }),
    ...(status === undefined ? {} : { status }),
    ...(captureId === undefined ? {} : { captureId }),
  };
};

const matchesFilter = (summary: RequestSummary, filter: SearchFilter) => {
  if (filter.captureId !== undefined && summary.captureId !== filter.captureId) return false;
  if (filter.method !== undefined && summary.method !== filter.method.toUpperCase()) return false;
  if (filter.host !== undefined && summary.host !== filter.host.toLowerCase()) return false;
  if (filter.status !== undefined && summary.status !== filter.status) return false;
  if (filter.query !== undefined) {
    const query = filter.query.toLowerCase();
    if (!summary.path.toLowerCase().includes(query) && !summary.host.includes(query)) return false;
  }
  return true;
};

/** Collects store changes and flushes them once per microtask. */
function coalesce<T>(flush: (items: Array<T>) => void) {
  let pending: Array<T> | undefined;
  return (item: T) => {
    if (pending !== undefined) {
      pending.push(item);
      return;
    }
    pending = [item];
    queueMicrotask(() => {
      const items = pending ?? [];
      pending = undefined;
      flush(items);
    });
  };
}

export function createInspectorBackend(deps: InspectorDeps): PluginBackendDefinition {
  const timer = deps.timer ?? realTimer;
  const now = deps.now ?? Date.now;
  const report = deps.reportStatus ?? reportStatus;
  let session: Session | undefined;
  let capture: CaptureEntry | undefined;
  let missingReported = false;
  let control: Promise<unknown> = Promise.resolve();

  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = control.then(fn);
    control = next.catch(() => undefined);
    return next;
  };

  const current = (): Session => {
    if (session === undefined) throw new Error("The inspector has not started.");
    return session;
  };

  const captureItem = (store: InspectorStore) => {
    const status = store.captureStatus();
    return {
      kind: "capture" as const,
      running: status.running === undefined ? null : captureView(status.running),
      droppedFlows: status.droppedFlows,
      storageBlocked: status.storageBlocked,
    };
  };

  const startFailure = (error: unknown): never => {
    if (error instanceof MitmStartError) {
      if (error.reason === "missing-prerequisite") {
        missingReported = true;
        report("missing-prerequisite", MITMDUMP_HINT);
      }
      throw new InspectorRefusal("conflict", error.message);
    }
    throw error;
  };

  const markRunning = () => {
    if (!missingReported) return;
    missingReported = false;
    report("running");
  };

  const withStartupDeadline = <T>(ready: Promise<T>, stop: () => Promise<void>) =>
    new Promise<T>((resolve, reject) => {
      const cancel = timer.after(REPLAY_LIMITS.startupMs, () => {
        void stop();
        reject(new MitmStartError("not-started", "mitmdump did not start within 10 s."));
      });
      ready.then(
        (value) => {
          cancel();
          resolve(value);
        },
        (error: unknown) => {
          cancel();
          reject(error);
        },
      );
    });

  const onCaptureClosed = async (entry: CaptureEntry) => {
    const { store, replay, log } = current();
    await replay.interruptChannel(entry.process);
    await store
      .exclusive((lane) => lane.stopCapture(entry.captureId, now()))
      .catch(() => log("Recording the capture stop failed."));
    if (capture === entry) capture = undefined;
  };

  const startCapture = () =>
    serialized(async () => {
      const { store, mitm, replay, config, log } = current();
      if (capture !== undefined || store.captureStatus().running !== undefined) {
        throw new InspectorRefusal("conflict", "A capture is already running.");
      }
      let resolveCaptureId: (id: number) => void = () => undefined;
      let rejectCaptureId: () => void = () => undefined;
      const captureId = new Promise<number>((resolve, reject) => {
        resolveCaptureId = resolve;
        rejectCaptureId = reject;
      });
      captureId.catch(() => undefined);
      const start = mitm.start(
        { kind: "capture", listenHost: config.listenHost, listenPort: config.listenPort },
        {
          onFlow: async (flow) => {
            const id = await captureId;
            const record = store.getCapture(id);
            if (record !== undefined && record.requestCount >= config.maxRequestsPerCapture) {
              await store.exclusive((lane) => lane.noteDroppedFlow());
              return;
            }
            try {
              await store.insertFlow({ ...flow, captureId: id });
            } catch {
              log("Storing a captured flow failed; it was dropped.");
              await store.exclusive((lane) => lane.noteDroppedFlow());
            }
          },
          onReplayResult: (result) => replay.onResult(result),
        },
      );
      const started = await withStartupDeadline(start.ready, start.stop).catch(startFailure);
      markRunning();
      let record: CaptureRecord;
      try {
        record = await store.exclusive((lane) =>
          lane.startCapture({
            listenHost: config.listenHost,
            listenPort: config.listenPort,
            startedAt: now(),
          }),
        );
      } catch (error) {
        rejectCaptureId();
        await started.stop();
        throw error;
      }
      resolveCaptureId(record.id);
      const entry: CaptureEntry = {
        process: started,
        captureId: record.id,
        finished: started.closed.then(() => onCaptureClosed(entry)),
      };
      capture = entry;
      return {
        captureId: String(record.id),
        listenHost: config.listenHost,
        listenPort: config.listenPort,
      };
    });

  const stopCapture = () =>
    serialized(async () => {
      const entry = capture;
      if (entry === undefined) return { captureId: null };
      await entry.process.stop();
      await entry.finished;
      return { captureId: String(entry.captureId) };
    });

  const subscribeRequests = (params: unknown, emit: TopicEmitter) => {
    const { store } = current();
    const raw = objectInput(params);
    const filter = parseFilter({ ...objectInput(raw.filter), captureId: raw.captureId });
    const page = store.search(filter, {
      limit: STORE_LIMITS.maxSearchLimit,
      maxBytes: PAYLOAD_BYTES,
    });
    emit.snapshot({
      items: page.items.map(summaryView),
      revision: page.revision,
      cursor: page.cursor,
    });
    const push = coalesce<StoreChange>((changes) => {
      const items = new Map<number, unknown>();
      for (const change of changes) {
        if (change.type === "request" && matchesFilter(change.summary, filter)) {
          items.set(change.summary.id, summaryView(change.summary));
        } else if (
          change.type === "request-removed" &&
          (filter.captureId === undefined || filter.captureId === change.captureId)
        ) {
          items.set(change.id, {
            kind: "request",
            id: String(change.id),
            seq: change.seq,
            removed: true,
          });
        }
      }
      if (items.size > 0) emit.batch([...items.values()], String(store.currentSeq()));
    });
    return store.onChange((change) => {
      if (change.type === "request" || change.type === "request-removed") push(change);
    });
  };

  const subscribeCaptureStatus = (_params: unknown, emit: TopicEmitter) => {
    const { store } = current();
    emit.snapshot({
      items: [captureItem(store)],
      revision: String(store.currentSeq()),
      cursor: null,
    });
    const push = coalesce<StoreChange>((changes) => {
      const items: Array<unknown> = [];
      const replays = new Map<string, unknown>();
      let captureChanged = false;
      for (const change of changes) {
        if (change.type === "replay") {
          replays.set(change.replay.replayId, replayStatusItem(change.replay));
        } else {
          captureChanged = true;
        }
      }
      if (captureChanged) items.push(captureItem(store));
      items.push(...replays.values());
      emit.batch(items, String(store.currentSeq()));
    });
    return store.onChange((change) => {
      if (
        change.type === "replay" ||
        change.type === "status" ||
        change.type === "capture" ||
        change.type === "capture-removed"
      ) {
        push(change);
      }
    });
  };

  const operations: PluginBackendDefinition["operations"] = {
    start_capture: async () => startCapture(),
    stop_capture: async () => stopCapture(),
    search_requests: async (input) => {
      const { store } = current();
      const raw = objectInput(input);
      const limit = optionalInteger(raw, "limit");
      const cursor = optionalString(raw, "cursor");
      const page = store.search(parseFilter(raw), {
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      return { items: page.items.map(summaryView), cursor: page.cursor, revision: page.revision };
    },
    get_request: async (input) => {
      const { store } = current();
      const raw = objectInput(input);
      const id = parseId(raw.requestId, "request");
      const record = store.getRequest(id);
      if (record === undefined) throw new InspectorRefusal("not-found", MISSING_DETAILS.request);
      const previewBytes = optionalInteger(raw, "previewBytes") ?? DEFAULT_PREVIEW_BYTES;
      if (previewBytes < 0 || previewBytes > MAX_PREVIEW_BYTES) {
        throw invalid(`previewBytes must be between 0 and ${MAX_PREVIEW_BYTES}.`);
      }
      const bodies = raw.bodies ?? "none";
      if (bodies !== "none" && bodies !== "request" && bodies !== "response" && bodies !== "both") {
        throw invalid('bodies must be "none", "request", "response" or "both".');
      }
      return requestDetail(store, record, {
        previewBytes,
        bodies,
        includeSensitiveHeaders: raw.includeSensitiveHeaders === true,
      });
    },
    read_body: async (input) => {
      const { readBody } = current();
      const raw = objectInput(input);
      const side = raw.side;
      if (side !== "request" && side !== "response") {
        throw invalid('side must be "request" or "response".');
      }
      return readBody({
        requestId: parseId(raw.requestId, "request"),
        side,
        offset: optionalInteger(raw, "offset") ?? -1,
        length: optionalInteger(raw, "length") ?? 0,
        decoded: raw.decoded === true,
      });
    },
    preview_replay: async (input) => current().replay.preview(replayInput(objectInput(input))),
    replay_request: async (input, ctx: OperationContext) => {
      const raw = objectInput(input);
      const idempotencyKey = optionalString(raw, "idempotencyKey");
      if (idempotencyKey === undefined || idempotencyKey === "") {
        throw invalid(REPLAY_INPUT_DETAILS.keyRequired);
      }
      return current().replay.accept({ ...replayInput(raw), idempotencyKey }, ctx.signal);
    },
    get_replay: async (input, ctx: OperationContext) => {
      const raw = objectInput(input);
      const replayId = optionalString(raw, "replayId");
      if (replayId === undefined) throw invalid("replayId is required.");
      const waitMs = optionalInteger(raw, "waitMs") ?? 0;
      if (waitMs < 0 || waitMs > REPLAY_LIMITS.maxWaitMs) {
        throw invalid(`waitMs must be between 0 and ${REPLAY_LIMITS.maxWaitMs}.`);
      }
      return current().replay.get(replayId, { waitMs, signal: ctx.signal });
    },
    body_draft_write: async (input) => {
      const raw = objectInput(input);
      const draftId = optionalString(raw, "draftId");
      const base64 = optionalString(raw, "base64");
      if (base64 === undefined) throw invalid("base64 is required.");
      return current().drafts.write({
        ...(draftId === undefined ? {} : { draftId }),
        offset: optionalInteger(raw, "offset") ?? -1,
        base64,
      });
    },
    delete_capture: async (input) => {
      const { store } = current();
      const captureId = parseId(objectInput(input).captureId, "capture");
      await store.exclusive((lane) => lane.deleteCapture(captureId));
      return { captureId: String(captureId) };
    },
    list_captures: async () => ({
      items: current().store.listCaptures().slice(0, MAX_LISTED_CAPTURES).map(captureView),
    }),
  };

  return {
    operations,
    topics: {
      capture_status: subscribeCaptureStatus,
      requests: subscribeRequests,
    },
    resolveReference: async (locator) => {
      const { store } = current();
      const id = parseId(locator.requestId, "request");
      const record = store.getRequest(id);
      if (record === undefined || String(record.summary.captureId) !== locator.captureId) {
        throw new InspectorRefusal("not-found", MISSING_DETAILS.request);
      }
      const { summary } = record;
      const lines = [
        `${summary.method} ${summary.scheme}://${requestOrigin({ ...summary, authority: record.authority })}${record.path}`,
        ...shapeHeaders(record.requestHeaders, false).headers.map(
          ([name, value]) => `${name}: ${value}`,
        ),
      ];
      if (record.response !== undefined) {
        lines.push(
          "",
          `${record.response.status}${record.response.reason ? ` ${record.response.reason}` : ""}`,
          ...shapeHeaders(record.response.headers, false).headers.map(
            ([name, value]) => `${name}: ${value}`,
          ),
        );
      } else if (summary.error !== undefined) {
        lines.push("", `Error: ${summary.error}`);
      }
      lines.push("", "Bodies are not included. Read them with get_request or read_body.");
      const detail = lines.join("\n");
      return {
        title: `${summary.method} ${summary.host}${summary.path}`.slice(0, 200),
        detail:
          detail.length > REFERENCE_DETAIL_CHARS
            ? `${detail.slice(0, REFERENCE_DETAIL_CHARS - 1)}…`
            : detail,
      };
    },
    onStart: async (ctx) => {
      const config = { ...readInspectorConfig(ctx.config), ...deps.configOverrides };
      const log = ctx.log;
      const store = openInspectorStore({
        dataDir: ctx.dataDir,
        maxDiskBytes: config.maxDiskBytes,
        maxBodyBytes: config.maxBodyBytes,
        log,
        ...(deps.onStorageStep === undefined ? {} : { onStorageStep: deps.onStorageStep }),
      });
      const drafts = makeDraftStore(store);
      const mitm = makeMitm({
        dataDir: ctx.dataDir,
        addonSource: deps.addonSource,
        maxBodyBytes: config.maxBodyBytes,
        materialize: deps.materialize ?? materializeAsset,
        timer,
        log,
        ...(deps.spawner === undefined ? {} : { spawner: deps.spawner }),
        ...(deps.searchPath === undefined ? {} : { searchPath: deps.searchPath }),
      });
      const transientHandlers = {
        onFlow: async () => undefined,
        onReplayResult: (result: Parameters<ReplayService["onResult"]>[0]) =>
          replay.onResult(result),
      };
      const replay: ReplayService = makeReplayService({
        store,
        drafts,
        timer,
        now,
        log,
        ...(deps.maxReplayHistory === undefined ? {} : { maxReplayHistory: deps.maxReplayHistory }),
        carriers: {
          capture: () => capture?.process,
          startTransient: () => {
            const start = mitm.start({ kind: "replay" }, transientHandlers);
            return {
              ready: start.ready.then(
                (started) => {
                  markRunning();
                  return started;
                },
                (error: unknown) => {
                  if (error instanceof MitmStartError && error.reason === "missing-prerequisite") {
                    missingReported = true;
                    report("missing-prerequisite", MITMDUMP_HINT);
                  }
                  log("The replay mitmdump did not start.");
                  throw error;
                },
              ),
              stop: start.stop,
            };
          },
        },
      });
      session = { store, drafts, readBody: makeBodyReader(store), replay, mitm, config, log };
      await replay.recover();
      await store.exclusive((lane) => {
        drafts.clear(lane);
        const running = store.captureStatus().running;
        if (running !== undefined) lane.stopCapture(running.id, now());
      });
    },
    onStop: async () => {
      const active = session;
      if (active === undefined) return;
      const entry = capture;
      if (entry !== undefined) {
        await entry.process.stop();
        await entry.finished;
      }
      await active.replay.stop();
      active.store.close();
      session = undefined;
    },
  };
}
