// @effect-diagnostics globalDate:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import type { PluginSubscriptionEvent } from "@t3tools/contracts";
import { T3PluginError, type T3PluginClient } from "@t3tools/plugin-sdk/ui";

import { REPLAY_DETAILS, replayRefusalOutcome } from "../../backend/refusals.ts";
import { isRecord, messageOf } from "../dom.ts";
import {
  createReplayTracker,
  type GetReplayResult,
  parseReplayStatus,
  type ReplayStatus,
  type ReplayTracker,
  type TrackedReplay,
} from "../replayTracker.ts";
import {
  createEmitter,
  type Emitter,
  jsonBytes,
  type Persistence,
  type ReplayEntryInput,
  sliceBytes,
} from "./state.ts";

export type SubmitOutcome = "maybe-sent" | "not-sent" | "unconfirmed";

/** One Send, kept across reloads. A refused Send has an outcome and no replay id. */
export interface HistoryEntry {
  readonly key: string;
  readonly label: string;
  readonly requestId: string;
  readonly at: number;
  readonly replayId?: string;
  readonly outcome?: "maybe-sent" | "not-sent";
  readonly text?: string;
}

/** Field edits a Replayer tab keeps across reloads. Bodies stay in backend drafts. */
export interface TabEdits {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: string;
}

/** A Replayer tab. Its id is its source request id, so a request has at most one tab. */
export interface ReplayerTab {
  readonly requestId: string;
  readonly label: string;
  readonly edits: TabEdits;
}

export interface ReplayerTabs {
  readonly list: () => ReadonlyArray<ReplayerTab>;
  readonly active: () => string | null;
  /** Opens a tab for the request, or focuses the one it has. */
  readonly open: (requestId: string) => void;
  readonly focus: (requestId: string) => void;
  readonly close: (requestId: string) => void;
  readonly update: (requestId: string, patch: { label?: string; edits?: TabEdits }) => void;
  readonly changed: Emitter<void>;
}

/** Looked-up status of a replay nobody is tracking, or `gone` when the inspector dropped it. */
export type LookedUp = ReplayStatus | "gone";

/** Replays the panel tracks across reloads, their history, and the Replayer's tabs. */
export interface ReplayModel {
  readonly tracker: ReplayTracker<ReplayEntryInput>;
  readonly history: () => ReadonlyArray<HistoryEntry>;
  readonly statusOf: (replayId: string) => LookedUp | undefined;
  /** Fetches the status of a replay once, for history restored after a reload. */
  readonly lookup: (replayId: string) => void;
  readonly note: (key: string) => { outcome: SubmitOutcome; text: string } | undefined;
  readonly inFlight: (key: string) => boolean;
  /** Tracks, saves, then submits one Send. Resolves false when nothing was submitted. */
  readonly send: (key: string, input: ReplayEntryInput) => Promise<"sent" | "full" | "not-kept">;
  /** Submits a tracked Send again with its key, so it cannot send twice. */
  readonly submit: (key: string) => Promise<void>;
  /** Feeds `proxies` events, which carry replay status items. */
  readonly handleEvent: (event: PluginSubscriptionEvent) => void;
  readonly changed: Emitter<void>;
  readonly tabs: ReplayerTabs;
}

export const MAX_REPLAYER_TABS = 20;
const MAX_HISTORY = 50;
const MAX_HISTORY_TEXT = 600;
/** Larger edits stay in memory only, so 20 tabs fit comfortably in panel state. */
const MAX_SAVED_TAB_EDIT_CHARS = 4096;
const MAX_CONCURRENT_LOOKUPS = 2;

const classifyRefusal = (error: unknown): SubmitOutcome => {
  if (!(error instanceof T3PluginError) || error.reason !== "operation-failed") {
    return error instanceof T3PluginError &&
      (error.reason === "too-large" ||
        error.reason === "unknown-operation" ||
        error.reason === "capability-denied" ||
        error.reason === "operation-mutates")
      ? "not-sent"
      : "unconfirmed";
  }
  return replayRefusalOutcome(messageOf(error));
};

/** An accepted replay is only ever polled by id, so its edits are not kept. */
const savedReplay = (entry: TrackedReplay<ReplayEntryInput>): TrackedReplay<ReplayEntryInput> => {
  if (entry.replayId === undefined || entry.input.request.edits === undefined) return entry;
  const { requestId, idempotencyKey } = entry.input.request;
  return { ...entry, input: { label: entry.input.label, request: { requestId, idempotencyKey } } };
};

const readSavedReplays = (value: unknown): ReadonlyArray<TrackedReplay<ReplayEntryInput>> =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is TrackedReplay<ReplayEntryInput> =>
          isRecord(entry) &&
          typeof entry.key === "string" &&
          (entry.replayId === undefined || typeof entry.replayId === "string") &&
          isRecord(entry.input) &&
          typeof entry.input.label === "string" &&
          isRecord(entry.input.request) &&
          entry.input.request.idempotencyKey === entry.key,
      )
    : [];

const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);

const readHistory = (value: unknown): Array<HistoryEntry> =>
  (Array.isArray(value) ? value : []).flatMap((entry): Array<HistoryEntry> => {
    if (
      !isRecord(entry) ||
      typeof entry.key !== "string" ||
      typeof entry.label !== "string" ||
      typeof entry.requestId !== "string" ||
      typeof entry.at !== "number"
    ) {
      return [];
    }
    const replayId = optionalString(entry.replayId);
    const text = optionalString(entry.text);
    const outcome =
      entry.outcome === "maybe-sent" || entry.outcome === "not-sent" ? entry.outcome : undefined;
    return [
      {
        key: entry.key,
        label: entry.label,
        requestId: entry.requestId,
        at: entry.at,
        ...(replayId === undefined ? {} : { replayId }),
        ...(outcome === undefined ? {} : { outcome }),
        ...(text === undefined ? {} : { text }),
      },
    ];
  });

const readEdits = (value: unknown): TabEdits => {
  if (!isRecord(value)) return {};
  const method = optionalString(value.method);
  const url = optionalString(value.url);
  const headers = optionalString(value.headers);
  return {
    ...(method === undefined ? {} : { method }),
    ...(url === undefined ? {} : { url }),
    ...(headers === undefined ? {} : { headers }),
  };
};

const readTabs = (value: unknown): { tabs: Array<ReplayerTab>; active: string | null } => {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return { tabs: [], active: null };
  const tabs: Array<ReplayerTab> = [];
  for (const tab of value.tabs) {
    if (!isRecord(tab) || typeof tab.requestId !== "string" || typeof tab.label !== "string")
      continue;
    if (tabs.some((held) => held.requestId === tab.requestId)) continue;
    tabs.push({ requestId: tab.requestId, label: tab.label, edits: readEdits(tab.edits) });
  }
  tabs.length = Math.min(tabs.length, MAX_REPLAYER_TABS);
  const active =
    typeof value.active === "string" && tabs.some((tab) => tab.requestId === value.active)
      ? value.active
      : (tabs[0]?.requestId ?? null);
  return { tabs, active };
};

/** Drops the longest edits until the rest fit the saved budget. */
const savedEdits = (edits: TabEdits): TabEdits => {
  const kept: { method?: string; url?: string; headers?: string } = { ...edits };
  const size = () =>
    (kept.method?.length ?? 0) + (kept.url?.length ?? 0) + (kept.headers?.length ?? 0);
  if (size() > MAX_SAVED_TAB_EDIT_CHARS) delete kept.headers;
  if (size() > MAX_SAVED_TAB_EDIT_CHARS) delete kept.url;
  return kept;
};

const createTabs = (persistence: Persistence): ReplayerTabs => {
  const restored = readTabs(persistence.restored.replayer);
  let tabs = restored.tabs;
  let active = restored.active;
  const changed = createEmitter();
  persistence.register("replayer", (maxBytes) => {
    const saved = tabs.map((tab) => ({ ...tab, edits: savedEdits(tab.edits) }));
    // Over budget, tabs lose their edits largest first; the tabs themselves stay.
    const bySize = saved
      .map((tab, index) => ({ index, size: jsonBytes(tab.edits) }))
      .toSorted((a, b) => b.size - a.size);
    for (const { index } of bySize) {
      if (jsonBytes({ active, tabs: saved }) <= maxBytes) break;
      const tab = saved[index];
      if (tab !== undefined) saved[index] = { ...tab, edits: {} };
    }
    return { active, tabs: saved };
  });
  const commit = (save: "soon" | "now") => {
    if (save === "now") void persistence.now();
    else persistence.soon();
    changed.emit();
  };
  return {
    list: () => tabs,
    active: () => active,
    open: (requestId) => {
      if (!tabs.some((tab) => tab.requestId === requestId)) {
        tabs = [...tabs, { requestId, label: `Request ${requestId}`, edits: {} }].slice(
          -MAX_REPLAYER_TABS,
        );
      }
      active = requestId;
      commit("now");
    },
    focus: (requestId) => {
      if (active === requestId || !tabs.some((tab) => tab.requestId === requestId)) return;
      active = requestId;
      commit("soon");
    },
    close: (requestId) => {
      const index = tabs.findIndex((tab) => tab.requestId === requestId);
      if (index === -1) return;
      tabs = tabs.filter((tab) => tab.requestId !== requestId);
      if (active === requestId) active = (tabs[index] ?? tabs[index - 1])?.requestId ?? null;
      commit("now");
    },
    update: (requestId, patch) => {
      tabs = tabs.map((tab) => (tab.requestId === requestId ? { ...tab, ...patch } : tab));
      commit("soon");
    },
    changed,
  };
};

export const createReplayModel = (
  client: T3PluginClient,
  persistence: Persistence,
): ReplayModel => {
  const messages = new Map<string, { outcome: SubmitOutcome; text: string }>();
  const inFlight = new Set<string>();
  const looked = new Map<string, LookedUp>();
  const lookupQueue: Array<string> = [];
  let lookupsRunning = 0;
  const changed = createEmitter();
  let history = readHistory(persistence.restored.replayHistory);

  const getReplay = async (replayId: string): Promise<GetReplayResult> => {
    try {
      const result = parseReplayStatus(await client.call("get_replay", { replayId, waitMs: 0 }));
      if (result === undefined) throw new Error("Malformed get_replay result.");
      return { found: true, replay: result };
    } catch (error) {
      if (error instanceof T3PluginError && messageOf(error) === REPLAY_DETAILS.replayMissing) {
        return { found: false };
      }
      throw error;
    }
  };

  const tracker = createReplayTracker<ReplayEntryInput>({
    initial: readSavedReplays(persistence.restored.replays),
    getReplay,
    onTrackedChange: () => {
      void persistence.now();
      changed.emit();
    },
    onStatusChange: () => changed.emit(),
  });
  persistence.register("replays", () => tracker.tracked().map(savedReplay));
  persistence.register("replayHistory", (maxBytes) => {
    let kept = history;
    while (kept.length > 0 && jsonBytes(kept) > maxBytes) kept = kept.slice(0, -1);
    return kept;
  });

  const record = (key: string, patch: Partial<HistoryEntry> & Omit<HistoryEntry, "key">) => {
    const held = history.find((entry) => entry.key === key);
    const text = patch.text?.slice(0, MAX_HISTORY_TEXT);
    const next: HistoryEntry = {
      ...held,
      ...patch,
      key,
      ...(text === undefined ? {} : { text }),
    };
    history =
      held === undefined
        ? [next, ...history].slice(0, MAX_HISTORY)
        : history.map((entry) => (entry === held ? next : entry));
  };

  // State saved before history existed: list its tracked Sends so they stay visible.
  for (const entry of tracker.tracked()) {
    if (history.some((item) => item.key === entry.key)) continue;
    record(entry.key, {
      label: entry.input.label,
      requestId: entry.input.request.requestId,
      at: Date.now(),
      ...(entry.replayId === undefined ? {} : { replayId: entry.replayId }),
    });
  }

  const pumpLookups = () => {
    while (lookupsRunning < MAX_CONCURRENT_LOOKUPS && lookupQueue.length > 0) {
      const replayId = lookupQueue.shift();
      if (replayId === undefined) continue;
      lookupsRunning += 1;
      void getReplay(replayId)
        .then(
          (result) => {
            looked.set(replayId, result.found ? result.replay : "gone");
            changed.emit();
          },
          // A failed lookup is retried the next time the entry is shown.
          () => looked.delete(replayId),
        )
        .finally(() => {
          lookupsRunning -= 1;
          pumpLookups();
        });
    }
  };

  const statusOf = (replayId: string): LookedUp | undefined => {
    const live = tracker.status(replayId);
    const found = looked.get(replayId);
    if (live === undefined) return found;
    return found === undefined || found === "gone" || found.seq < live.seq ? live : found;
  };

  const submit = async (key: string) => {
    if (inFlight.has(key)) return;
    const entry = tracker.tracked().find((item) => item.key === key);
    if (entry === undefined) return;
    const base = {
      label: entry.input.label,
      requestId: entry.input.request.requestId,
      at: history.find((item) => item.key === key)?.at ?? Date.now(),
    };
    inFlight.add(key);
    messages.delete(key);
    changed.emit();
    try {
      const result = await client.call("replay_request", entry.input.request);
      if (!isRecord(result) || typeof result.replayId !== "string")
        throw new Error("The inspector gave no replay id.");
      record(key, { ...base, replayId: result.replayId });
      tracker.accepted(key, result.replayId);
    } catch (error) {
      const outcome = classifyRefusal(error);
      const text = messageOf(error);
      if (outcome === "unconfirmed") {
        messages.set(key, {
          outcome,
          text: `${text} Retry reuses the same key, so it cannot send twice.`,
        });
      } else {
        record(key, {
          ...base,
          outcome,
          text: outcome === "maybe-sent" ? `${text} The earlier replay may have been sent.` : text,
        });
        tracker.forget(key);
      }
    } finally {
      inFlight.delete(key);
      persistence.soon();
      changed.emit();
    }
  };

  const send: ReplayModel["send"] = async (key, input) => {
    if (!tracker.begin(key, input)) return "full";
    record(key, { label: input.label, requestId: input.request.requestId, at: Date.now() });
    const fits = jsonBytes(tracker.tracked().map(savedReplay)) <= sliceBytes("replays");
    const kept = fits && (await persistence.now());
    if (!kept) {
      tracker.forget(key);
      history = history.filter((entry) => entry.key !== key);
      changed.emit();
      return "not-kept";
    }
    await submit(key);
    return "sent";
  };

  return {
    tracker,
    history: () => history,
    statusOf,
    lookup: (replayId) => {
      if (tracker.status(replayId) !== undefined || looked.has(replayId)) return;
      if (lookupQueue.includes(replayId)) return;
      lookupQueue.push(replayId);
      queueMicrotask(pumpLookups);
    },
    note: (key) => messages.get(key),
    inFlight: (key) => inFlight.has(key),
    send,
    submit,
    handleEvent: tracker.handleEvent,
    changed,
    tabs: createTabs(persistence),
  };
};
